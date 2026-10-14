import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, open, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { gzip } from "node:zlib";
import { MAX_CODING_ARCHIVE_BYTES, MAX_CODING_FILES, MAX_CODING_PATCH_BYTES, type CodingArtifacts } from "../shared/coding.js";
import { codingSourceExclusion, codingSourcePath, inspectCodingSnapshot, MAX_CODING_CONTENT_BYTES, MAX_CODING_DECODED_BYTES, type CodingSnapshotDocument, type CodingSnapshotManifest } from "../shared/coding-source.js";

export type { CodingSnapshotManifest } from "../shared/coding-source.js";
const compress = promisify(gzip);
const hash = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/** Ignore inherited Git config, credentials, attributes, helpers and preload variables. */
function gitEnvironment(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: "/nonexistent", LC_ALL: "C", TMPDIR: tmpdir(),
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_GLOBAL: "/dev/null", GIT_ATTR_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0",
    GIT_AUTHOR_NAME: "Coding snapshot", GIT_AUTHOR_EMAIL: "snapshot@invalid", GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
    GIT_COMMITTER_NAME: "Coding snapshot", GIT_COMMITTER_EMAIL: "snapshot@invalid", GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
  };
}

function git(cwd: string, args: string[], options: { input?: Uint8Array; limit?: number; allowFailure?: boolean } = {}): Promise<Buffer> {
  return new Promise((resolveResult, reject) => {
    const child = spawn("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "core.attributesFile=/dev/null", "-c", "core.autocrlf=false", "-c", "core.safecrlf=false", ...args], { cwd, env: gitEnvironment(), stdio: ["pipe", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let size = 0, failed = false;
    const timer = setTimeout(() => { failed = true; child.kill("SIGKILL"); }, 30_000);
    child.on("error", () => { failed = true; });
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > (options.limit ?? MAX_CODING_PATCH_BYTES)) { failed = true; child.kill("SIGKILL"); return; }
      chunks.push(chunk);
    });
    // Never include Git stderr: it can contain private source/configuration details.
    child.stderr.resume();
    child.stdin.on("error", () => { failed = true; });
    child.on("close", code => {
      clearTimeout(timer);
      if (failed || code !== 0 && !options.allowFailure) reject(new Error("Coding snapshot Git operation failed or exceeded its bound"));
      else resolveResult(code === 0 ? Buffer.concat(chunks, size) : Buffer.alloc(0));
    });
    child.stdin.end(options.input);
  });
}

async function safeFile(root: string, path: string, remaining: number): Promise<{ bytes: Buffer; mode: 0o100644 | 0o100755 } | null> {
  const parts = path.split("/");
  let parent = root;
  for (const part of parts.slice(0, -1)) {
    parent = join(parent, part);
    let stat;
    try { stat = await lstat(parent); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
    if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(parent) !== parent) throw new Error("Coding snapshot refuses symlink or unsafe parent directory");
  }
  const absolute = join(root, path);
  let stat;
  try { stat = await lstat(absolute); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o7000)) throw new Error("Coding snapshot requires regular, nonlinked files without special modes");
  if (stat.size > remaining) throw new Error("Coding source content size exceeds limit");
  const file = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = await file.stat();
    if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size !== stat.size || opened.mode !== stat.mode || opened.nlink !== 1 || await realpath(dirname(absolute)) !== dirname(absolute)) throw new Error("Coding source changed during capture");
    const bytes = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await file.read(bytes, offset, bytes.length - offset, offset);
      if (!result.bytesRead) throw new Error("Coding source changed during capture");
      offset += result.bytesRead;
    }
    const after = await file.stat();
    const current = await lstat(absolute);
    if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs || current.ino !== opened.ino || current.dev !== opened.dev || await realpath(dirname(absolute)) !== dirname(absolute)) throw new Error("Coding source changed during capture");
    return { bytes, mode: (opened.mode & 0o111) ? 0o100755 : 0o100644 };
  } finally { await file.close(); }
}

/** Captures selected working-tree bytes; never modifies the owner's Git index or tree. */
export async function captureCodingSnapshot(cwd: string): Promise<{ bytes: Uint8Array; manifest: CodingSnapshotManifest }> {
  const root = await realpath(cwd);
  if (root !== resolve(cwd) || !(await lstat(root)).isDirectory()) throw new Error("Coding snapshot requires a canonical workspace directory");
  const listing = await git(root, ["ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", "."], { limit: 4 * 1024 * 1024 });
  const paths = new TextDecoder("utf-8", { fatal: true }).decode(listing).split("\0").filter(Boolean);
  const names = [...new Set(paths)].sort();
  if (names.length > MAX_CODING_FILES) throw new Error("Coding source selected-file count exceeds limit");
  const revision = (await git(root, ["rev-parse", "--verify", "HEAD"], { allowFailure: true, limit: 128 })).toString("ascii").trim();
  const document: CodingSnapshotDocument = { version: 1, capturedAt: new Date().toISOString(), baseRevision: revision || null, files: [], exclusions: [] };
  let total = 0;
  for (const name of names) {
    const path = codingSourcePath(name);
    const reason = codingSourceExclusion(path);
    if (reason) { document.exclusions.push({ path, reason }); continue; }
    const file = await safeFile(root, path, MAX_CODING_CONTENT_BYTES - total);
    if (!file) continue; // A tracked deletion is part of the actual working tree.
    total += file.bytes.length;
    document.files.push({ path, mode: file.mode, bytes: file.bytes.length, digest: hash(file.bytes), content: file.bytes.toString("base64") });
  }
  const encoded = Buffer.from(JSON.stringify(document));
  if (encoded.length > MAX_CODING_DECODED_BYTES) throw new Error("Coding source decoded size exceeds limit");
  const bytes = await compress(encoded);
  if (bytes.length > MAX_CODING_ARCHIVE_BYTES) throw new Error("Coding source compressed size exceeds limit");
  const { manifest } = await inspectCodingSnapshot(bytes);
  return { bytes, manifest };
}

/** Write blobs without filters/attributes or CRLF transformations, into our own index only. */
async function writeTree(root: string, document: CodingSnapshotDocument): Promise<string> {
  await git(root, ["read-tree", "--empty"]);
  const entries: string[] = [];
  for (const file of document.files) {
    const oid = (await git(root, ["hash-object", "--no-filters", "-w", "--stdin"], { input: Buffer.from(file.content, "base64"), limit: 128 })).toString("ascii").trim();
    entries.push(`${file.mode.toString(8)} ${oid}\t${file.path}\0`);
  }
  if (entries.length) await git(root, ["update-index", "-z", "--index-info"], { input: Buffer.from(entries.join("")) });
  return (await git(root, ["write-tree"], { limit: 128 })).toString("ascii").trim();
}

async function initialize(root: string, document: CodingSnapshotDocument): Promise<void> {
  await git(root, ["init", "--quiet", "--template=", "--initial-branch=main"]);
  await mkdir(join(root, ".git", "info"), { recursive: true, mode: 0o700 });
  await writeFile(join(root, ".git", "info", "attributes"), "* -text -filter -working-tree-encoding -ident\n", { mode: 0o600 });
  const tree = await writeTree(root, document);
  const commit = (await git(root, ["commit-tree", tree], { input: Buffer.from("Selected coding source baseline\n"), limit: 128 })).toString("ascii").trim();
  await git(root, ["update-ref", "HEAD", commit]);
}

/** No output paths are touched until the complete gzip, schema, paths and hashes validate. */
export async function restoreCodingSnapshot(bytes: Uint8Array, cwd: string): Promise<CodingSnapshotManifest> {
  const { document, manifest } = await inspectCodingSnapshot(bytes);
  const destination = resolve(cwd);
  const parent = await realpath(dirname(destination));
  if (parent !== dirname(destination)) throw new Error("Coding restore requires canonical scratch parent");
  let existing = false;
  try {
    const stat = await lstat(destination);
    existing = true;
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o022) || (await readdir(destination)).length) throw new Error("Coding restore requires fresh owned empty scratch");
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const stage = await mkdtemp(join(parent, ".coding-restore-"));
  try {
    await chmod(stage, 0o700);
    for (const file of document.files) {
      const path = join(stage, file.path);
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const handle = await open(path, "wx", file.mode & 0o777);
      try { await handle.writeFile(Buffer.from(file.content, "base64")); await handle.chmod(file.mode & 0o777); } finally { await handle.close(); }
    }
    await initialize(stage, document);
    if (existing) {
      const stat = await lstat(destination);
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o022) || (await readdir(destination)).length) throw new Error("Coding restore scratch changed");
    }
    await rename(stage, destination);
    return manifest;
  } finally { await rm(stage, { recursive: true, force: true }); }
}

function isText(file: CodingSnapshotDocument["files"][number] | undefined): boolean {
  if (!file) return true;
  const bytes = Buffer.from(file.content, "base64");
  if (bytes.includes(0)) return false;
  try { new TextDecoder("utf-8", { fatal: true }).decode(bytes); return true; } catch { return false; }
}

/** Exact git-apply patch, including binary, executable mode, addition and deletion changes. */
export async function compareCodingSnapshots(before: Uint8Array, after: Uint8Array): Promise<CodingArtifacts> {
  const baseline = await inspectCodingSnapshot(before);
  const final = await inspectCodingSnapshot(after);
  const previous = new Map(baseline.document.files.map(file => [file.path, file]));
  const current = new Map(final.document.files.map(file => [file.path, file]));
  const paths = [...new Set([...previous.keys(), ...current.keys()])].sort();
  const changes: CodingArtifacts["changes"] = [];
  for (const path of paths) {
    const old = previous.get(path), next = current.get(path);
    if (old?.digest === next?.digest && old?.mode === next?.mode) continue;
    changes.push({ path, kind: !old ? "added" : !next ? "deleted" : "modified" });
  }
  if (!changes.length) return { baseDigest: baseline.manifest.digest, finalDigest: final.manifest.digest, patchDigest: hash(Buffer.alloc(0)), patch: "", changes };
  const scratch = await mkdtemp(join(tmpdir(), "umpi-coding-patch-"));
  try {
    await chmod(scratch, 0o700);
    await git(scratch, ["init", "--quiet", "--template=", "--initial-branch=main"]);
    const oldTree = await writeTree(scratch, baseline.document);
    const newTree = await writeTree(scratch, final.document);
    // Override source .gitattributes. Non-UTF8 content must use ASCII git binary patches.
    const attributes = ["* -diff", ...paths.filter(path => isText(previous.get(path)) && isText(current.get(path))).map(path => `${JSON.stringify(path.replace(/([*?[\]])/g, "\\$1"))} diff`)];
    await mkdir(join(scratch, ".git", "info"), { recursive: true, mode: 0o700 });
    await writeFile(join(scratch, ".git", "info", "attributes"), `${attributes.join("\n")}\n`, { mode: 0o600 });
    const patchBytes = await git(scratch, ["-c", "core.quotePath=true", "diff", "--binary", "--full-index", "--no-renames", "--no-ext-diff", "--no-textconv", "--no-color", "--src-prefix=a/", "--dst-prefix=b/", oldTree, newTree, "--"], { limit: MAX_CODING_PATCH_BYTES });
    const patch = new TextDecoder("utf-8", { fatal: true }).decode(patchBytes);
    return { baseDigest: baseline.manifest.digest, finalDigest: final.manifest.digest, patchDigest: hash(patchBytes), patch, changes };
  } finally { await rm(scratch, { recursive: true, force: true }); }
}
