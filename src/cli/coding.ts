import { closeSync, fstatSync, readSync } from "node:fs";
import { open, realpath, unlink } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { captureCodingSnapshot } from "../coding/workspace.js";
import { privateDirectory, privateFile } from "../mac/config.js";
import { MAX_CODING_ARCHIVE_BYTES, MAX_CODING_PATCH_BYTES } from "../shared/coding.js";
import { codingSourceDigest, inspectCodingSnapshot, type CodingSnapshotManifest } from "../shared/coding-source.js";
import { coordinatorUrl } from "../shared/coordinator-url.js";
import { identifier } from "../shared/protocol.js";

const USAGE = `Usage:
  npm run coding -- snapshot --workspace ROOT --output PRIVATE.gz
  npm run coding -- upload --workspace ROOT --file PRIVATE.gz --source-id ID [--origin URL]
  npm run coding -- download --task ID [--run ID] --output PRIVATE.patch [--origin URL]

Origin is explicit --origin or UMPI_COORDINATOR_URL. Remote origins require HTTPS;
loopback HTTP is allowed for development. UMPI_CONTROL_TOKEN is environment-only.
Files and their directories must be owner-only and outside the repository/workspace.
Existing output files are never overwritten. Snapshot is local-only; upload is a
separate explicit owner action and does not approve cloud execution.
Only Git-selected working-tree files are captured, including safe untracked code.
Ignored files, credentials/private config, .git history and generated dependencies
are excluded. Symlinks/nonregular files are rejected. Metadata reports exclusions;
review the archive and selected scope before upload. Patches are never auto-applied.
Limits: 8 MiB selected file bytes, 12 MiB decoded archive, 32 MiB compressed
transport, 4096 selected entries, and 8 MiB review patch. Oversize input fails.
`;

export interface CodingCliOptions {
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  signal?: AbortSignal;
  stdout?: (text: string) => void;
}

function metadata(manifest: CodingSnapshotManifest, bytes: number): Record<string, unknown> {
  return {
    version: manifest.version, capturedAt: manifest.capturedAt, baseRevision: manifest.baseRevision,
    digest: manifest.digest, bytes, fileCount: manifest.fileCount,
    excludedPrivate: manifest.exclusions.filter(entry => entry.reason === "private").length,
    excludedGenerated: manifest.exclusions.filter(entry => entry.reason === "generated").length,
    scope: "git-selected-working-tree; ignored files omitted; no git history",
  };
}

async function newPrivateOutput(path: string, bytes: Uint8Array, workspace?: string): Promise<void> {
  const absolute = resolve(path);
  if (workspace) {
    const suffix = relative(workspace, absolute);
    if (!suffix || suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix)) throw new Error("Private coding artifacts must be outside the selected workspace");
  }
  const parent = privateDirectory(dirname(absolute));
  if (parent !== dirname(absolute)) throw new Error("Output directory must be canonical");
  const output = await open(absolute, "wx", 0o600);
  let persisted = false;
  try {
    await output.writeFile(bytes);
    await output.sync();
    const directory = await open(parent, "r");
    try { await directory.sync(); } finally { await directory.close(); }
    persisted = true;
  } finally {
    await output.close();
    if (!persisted) await unlink(absolute);
  }
}

async function responseBytes(response: Response, limit: number): Promise<Uint8Array> {
  if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error(`Coding request was not accepted (HTTP ${response.status})`); }
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > limit)) { await response.body.cancel(); throw new Error("Coding response exceeds size limit"); }
  const reader = response.body.getReader();
  let length = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > limit) throw new Error("Coding response exceeds size limit");
      chunks.push(next.value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  if (declared !== null && Number(declared) !== length) throw new Error("Coding response was truncated");
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

/** No executor config/token reads. Source export is possible only through explicit upload. */
export async function runCodingCli(args: readonly string[], runtime: CodingCliOptions = {}): Promise<void> {
  const command = args[0];
  const stdout = runtime.stdout ?? (text => { process.stdout.write(text); });
  if (!command || ["help", "--help", "-h"].includes(command)) { stdout(USAGE); return; }
  if (!["snapshot", "upload", "download"].includes(command)) throw new Error("Use coding --help for supported commands");
  let values;
  try {
    ({ values } = parseArgs({ args: args.slice(1), options: {
      workspace: { type: "string" }, output: { type: "string" }, file: { type: "string" },
      "source-id": { type: "string" }, task: { type: "string" }, run: { type: "string" }, origin: { type: "string" }, help: { type: "boolean", short: "h" },
    } }));
  } catch { throw new Error("Invalid coding arguments; use coding --help. Never pass tokens as arguments"); }
  if (values.help) { stdout(USAGE); return; }
  if (command === "snapshot") {
    if (!values.workspace || !values.output || values.file || values["source-id"] || values.task || values.run || values.origin) throw new Error("Snapshot requires only --workspace and --output");
    const workspace = await realpath(values.workspace);
    if (workspace !== resolve(values.workspace)) throw new Error("Workspace must be canonical");
    const snapshot = await captureCodingSnapshot(workspace);
    await newPrivateOutput(values.output, snapshot.bytes, workspace);
    stdout(`${JSON.stringify(metadata(snapshot.manifest, snapshot.bytes.byteLength))}\n`);
    return;
  }
  const env = runtime.env ?? process.env;
  const origin = coordinatorUrl(values.origin ?? env.UMPI_COORDINATOR_URL ?? "");
  const token = env.UMPI_CONTROL_TOKEN;
  if (!token || token.length < 32 || token.length > 4096 || /\s/.test(token)) throw new Error("Set UMPI_CONTROL_TOKEN in the environment; it is never read from private config");
  const fetcher = runtime.fetch ?? fetch;
  const signal = AbortSignal.any([runtime.signal ?? new AbortController().signal, AbortSignal.timeout(60_000)]);
  if (command === "upload") {
    if (!values.workspace || !values.file || !values["source-id"] || values.output || values.task || values.run) throw new Error("Upload requires --workspace, --file and --source-id");
    const sourceId = identifier(values["source-id"], "coding source");
    const workspace = await realpath(values.workspace);
    if (workspace !== resolve(values.workspace)) throw new Error("Workspace must be canonical");
    const file = resolve(values.file);
    privateDirectory(dirname(file), false);
    const suffix = relative(workspace, file);
    if (!suffix || suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix)) throw new Error("Private coding archive must be outside the selected workspace");
    const fd = privateFile(file);
    let bytes: Uint8Array;
    try {
      const stat = fstatSync(fd);
      if (stat.size > MAX_CODING_ARCHIVE_BYTES) throw new Error("Coding source archive exceeds size limit");
      bytes = new Uint8Array(stat.size);
      let offset = 0;
      while (offset < bytes.length) {
        const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
        if (!count) throw new Error("Coding source archive changed during read");
        offset += count;
      }
      const after = fstatSync(fd);
      if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) throw new Error("Coding source archive changed during read");
    } finally { closeSync(fd); }
    const { manifest } = await inspectCodingSnapshot(bytes);
    const response = await fetcher(new URL(`/api/coding/sources/${encodeURIComponent(sourceId)}`, origin), {
      method: "POST", redirect: "error", signal,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/gzip", "content-length": String(bytes.byteLength), "x-umpi-coding-cwd": Buffer.from(workspace, "utf8").toString("base64url") },
      body: bytes as Uint8Array<ArrayBuffer>,
    });
    const stored = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await responseBytes(response, 16_384))) as { sourceId?: unknown; cwd?: unknown; capturedAt?: unknown; digest?: unknown; bytes?: unknown; fileCount?: unknown; baseRevision?: unknown };
    if (!stored || stored.sourceId !== sourceId || stored.cwd !== workspace || stored.capturedAt !== manifest.capturedAt || stored.digest !== manifest.digest || stored.bytes !== bytes.byteLength || stored.fileCount !== manifest.fileCount || stored.baseRevision !== manifest.baseRevision) throw new Error("Coding source receipt did not match the exact uploaded artifact");
    stdout(`${JSON.stringify({ sourceId, ...metadata(manifest, bytes.byteLength), uploaded: true })}\n`);
    return;
  }
  if (!values.task || !values.output || values.workspace || values.file || values["source-id"]) throw new Error("Download requires --task and --output");
  const taskId = identifier(values.task, "coding task");
  const runId = values.run === undefined ? undefined : identifier(values.run, "coding run");
  const route = `/api/coding/tasks/${encodeURIComponent(taskId)}/${runId ? `runs/${encodeURIComponent(runId)}/patch` : "patch"}`;
  const response = await fetcher(new URL(route, origin), { method: "GET", redirect: "error", signal, headers: { authorization: `Bearer ${token}` } });
  const bytes = await responseBytes(response, MAX_CODING_PATCH_BYTES);
  const digest = await codingSourceDigest(bytes);
  const expected = response.headers.get("x-umpi-coding-patch-digest");
  if (!expected || expected !== digest) throw new Error("Coding patch receipt did not match exact artifact digest");
  const baseDigest = response.headers.get("x-umpi-coding-base-digest");
  const finalDigest = response.headers.get("x-umpi-coding-final-digest");
  if (!baseDigest || !finalDigest || !/^[a-f0-9]{64}$/.test(baseDigest) || !/^[a-f0-9]{64}$/.test(finalDigest)) throw new Error("Coding patch receipt omitted its baseline/final identity");
  await newPrivateOutput(values.output, bytes);
  stdout(`${JSON.stringify({ taskId, ...(runId ? { runId } : {}), baseDigest, finalDigest, patchDigest: digest, bytes: bytes.byteLength })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runCodingCli(process.argv.slice(2)).catch(() => {
    // Do not echo source paths, provider response bodies, tokens or private configuration.
    process.stderr.write("Coding command failed; check arguments, private file permissions and coordinator status. Use coding --help.\n");
    process.exitCode = 1;
  });
}
