import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, constants, fsyncSync, fstatSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { readdir, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { privateDirectory, privateFile } from "../mac/config.js";
import { coordinatorUrl } from "../shared/coordinator-url.js";
import { identifier, record } from "../shared/protocol.js";
import { DEFAULT_VAULT_SCOPE, MAX_WORKSPACE_BYTES, parseVaultScope, type VaultPlanningScope } from "../shared/vault-planning.js";
import { createWorkspaceArchive, workspaceConfig, HEADLESS_VERSION } from "../vault/archive.js";
import { SyncOutput } from "../vault/runtime.js";
import { atomicReplace, readSafeFile } from "../vault/safety.js";

const DEFAULT_ROOT = join(homedir(), ".config", "umpi", "headless");
const USAGE = `Usage:
  npm run vault -- login [--root PATH]
  npm run vault -- remotes [--root PATH]
  npm run vault -- setup --vault-id ID --source-vault PATH [--root PATH]
      [--journals RELATIVE_DIRECTORY] [--template RELATIVE_FILE] [--exclude-folder RELATIVE_DIRECTORY]
  npm run vault -- sync [--root PATH]
  npm run vault -- export --output PATH [--root PATH]
  npm run vault -- upload URL --archive PATH --expected-revision N
      [--journals RELATIVE_DIRECTORY] [--template RELATIVE_FILE]
  npm run vault -- status [URL] [--root PATH]

Login/setup run only in your private terminal; passwords/MFA never belong in arguments.
Default private root: ~/.config/umpi/headless. The desktop vault is never a sync target.
setup reads source-vault directory names only to exclude other existing top-level folders.
Exclusions are NOT permissions: root note formats and later-created folders may still sync.
The model receives only the approved dated notes/template; core context remains native.
sync is one-shot. export verifies stopped, acknowledged state and never replaces a file.
upload explicitly transfers the private login/key/workspace archive to the configured
private Cloudflare adapter and leaves daily preparation paused. It does not deploy or
provision a bucket. UMPI_CONTROL_TOKEN comes from the environment, never argv.
`;
export class VaultCliError extends Error {}

export interface VaultPaths { root: string; home: string; workspace: string; vaultRoot: string; configRoot: string }
function layout(value: string, create: boolean): VaultPaths {
  const root = create ? privateDirectory(value) : resolve(value);
  const home = join(root, "home"), workspace = join(root, "workspace"), vaultRoot = join(workspace, "vault");
  if (create) { privateDirectory(home); privateDirectory(workspace); privateDirectory(vaultRoot); }
  const configRoot = process.platform === "linux" ? join(workspace, "xdg", "obsidian-headless") : join(home, ".obsidian-headless");
  return { root, home, workspace, vaultRoot, configRoot };
}
function cliPath(): string {
  const require = createRequire(import.meta.url), manifest = require.resolve("obsidian-headless/package.json");
  const pkg = JSON.parse(readFileSync(manifest, "utf8"));
  if (pkg.version !== HEADLESS_VERSION) throw new VaultCliError("Install the repository's pinned Obsidian Headless client first");
  return join(dirname(manifest), "cli.js");
}
async function headless(paths: VaultPaths, args: string[], interactive: boolean, sync = false): Promise<void> {
  if (interactive && (!process.stdin.isTTY || !process.stdout.isTTY)) throw new VaultCliError("Run this command in your own private terminal; interactive account output is not captured");
  const capture = new SyncOutput();
  const { promise, resolve: finish, reject } = Promise.withResolvers<void>();
  const child = spawn(process.execPath, [cliPath(), ...args], {
    cwd: paths.vaultRoot, shell: false, stdio: interactive ? "inherit" : ["ignore", "pipe", "pipe"],
    env: { HOME: paths.home, XDG_CONFIG_HOME: join(paths.workspace, "xdg"), PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8" },
  });
  let interrupted = false;
  const stop = () => { interrupted = true; child.kill("SIGKILL"); };
  const timeout = setTimeout(stop, interactive ? 10 * 60_000 : 120_000);
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  const clean = () => { clearTimeout(timeout); process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop); };
  child.stdout?.on("data", (chunk: Buffer) => { capture.accept(chunk, true); if (capture.exceeded) stop(); });
  child.stderr?.on("data", (chunk: Buffer) => { capture.accept(chunk, false); if (capture.exceeded) stop(); });
  child.once("error", () => { clean(); reject(new VaultCliError("The pinned headless client could not start")); });
  child.once("close", (code, signal) => {
    clean();
    if (interrupted || signal || code !== 0 || (sync && (!capture.fullySynced || capture.conflicted))) {
      reject(new VaultCliError(sync ? "Headless sync was not confirmed; preserve the private workspace and inspect it before export" : "Headless setup did not complete; no cloud configuration was changed"));
    } else finish();
  });
  return promise;
}
function privateBytes(path: string, limit: number): Buffer<ArrayBuffer> {
  const absolute = resolve(path); privateDirectory(dirname(absolute), false);
  const fd = privateFile(absolute);
  try {
    if (fstatSync(fd).size > limit) throw new VaultCliError("Private input exceeds its size limit");
    return readFileSync(fd);
  } finally { closeSync(fd); }
}
export async function vaultLocalStatus(root = DEFAULT_ROOT): Promise<{ loginStored: boolean; configuredVaults: number }> {
  const paths = layout(root, false);
  let loginStored = false;
  try { loginStored = privateBytes(join(paths.configRoot, "auth_token"), 65_536).length > 0; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new VaultCliError("Cannot safely inspect the private headless login"); }
  let configuredVaults = 0;
  try {
    privateDirectory(join(paths.configRoot, "sync"), false);
    configuredVaults = (await readdir(join(paths.configRoot, "sync"), { withFileTypes: true })).filter(item => item.isDirectory()).length;
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new VaultCliError("Cannot safely inspect private headless configuration"); }
  return { loginStored, configuredVaults };
}
export async function vaultExclusions(sourceVault: string, scope: VaultPlanningScope, extra: string[] = []): Promise<string[]> {
  const root = await realpath(resolve(sourceVault));
  const retained = new Set([scope.journalDirectory.split("/")[0]!, ...(scope.templatePath.includes("/") ? [scope.templatePath.split("/")[0]!] : [])]);
  const names = (await readdir(root, { withFileTypes: true })).filter(item => item.isDirectory() && !retained.has(item.name)).map(item => item.name);
  const excluded = [...new Set([...names, ...extra])].sort();
  for (const path of excluded) {
    if (path.includes(",") || path.includes("\\") || path.includes(":") || /[\u0000-\u001f\u007f]/.test(path) || path.split("/").some(part => !part || part === "." || part === "..")) throw new VaultCliError("An exclusion cannot be safely represented by the headless CLI");
    if (scope.journalDirectory === path || scope.journalDirectory.startsWith(`${path}/`) || scope.templatePath.startsWith(`${path}/`)) throw new VaultCliError("An exclusion would hide an approved planning source");
  }
  return excluded;
}
async function control(origin: string, method: string, options: { archive?: Buffer<ArrayBuffer>; revision?: number; scope?: VaultPlanningScope } = {}): Promise<Record<string, unknown>> {
  const token = process.env.UMPI_CONTROL_TOKEN;
  if (!token || token.length < 32 || /\s/.test(token)) throw new VaultCliError("Configure UMPI_CONTROL_TOKEN in the private environment");
  const url = new URL("/api/planning/workspace", coordinatorUrl(origin).origin);
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (options.archive) {
    headers["content-type"] = "application/gzip";
    headers["x-umpi-expected-revision"] = String(options.revision);
    headers["x-umpi-vault-scope"] = Buffer.from(JSON.stringify(options.scope)).toString("base64url");
  }
  let response: Response;
  try { response = await fetch(url, { method, headers, body: options.archive, redirect: "manual", signal: AbortSignal.timeout(240_000) }); }
  catch { throw new VaultCliError("Workspace response was not received; inspect protected status before repeating an upload"); }
  if (!response.ok) throw new VaultCliError(`Workspace request was rejected (HTTP ${response.status}); inspect protected status and configuration`);
  const text = await response.text();
  if (text.length > 8_192) throw new VaultCliError("Workspace returned an unexpected status response");
  try { return record(JSON.parse(text)); }
  catch { throw new VaultCliError("Workspace status could not be read"); }
}
async function configuredDigest(paths: VaultPaths) {
  const { config } = await workspaceConfig(paths.workspace, { configRoot: paths.configRoot, vaultRoot: paths.vaultRoot });
  if (config.conflictStrategy !== "conflict" || (config.syncMode !== undefined && config.syncMode !== "bidirectional")) throw new VaultCliError("Complete the scoped bidirectional/conflict setup before syncing");
  if (!Array.isArray(config.allowTypes) || config.allowTypes.length !== 0) throw new VaultCliError("Attachment synchronization must be explicitly disabled before syncing");
  return createHash("sha256").update(privateBytes(join(paths.configRoot, "sync", config.vaultId, "config.json"), 65_536)).digest("hex");
}
async function requirePrepared(paths: VaultPaths): Promise<void> {
  let receipt;
  try { receipt = record(JSON.parse(privateBytes(join(paths.root, "setup.json"), 8_192).toString("utf8"))); }
  catch { throw new VaultCliError("Scoped setup did not complete; finish vault setup before syncing or exporting"); }
  if (receipt.version !== 1 || receipt.configHash !== await configuredDigest(paths)) throw new VaultCliError("Headless configuration changed after scoped setup; review it before syncing or exporting");
}
export async function runVaultCli(args: readonly string[]): Promise<void> {
  const { values, positionals } = parseArgs({ args: [...args], strict: true, allowPositionals: true, options: {
    root: { type: "string" }, "vault-id": { type: "string" }, "source-vault": { type: "string" },
    journals: { type: "string" }, template: { type: "string" }, "exclude-folder": { type: "string", multiple: true },
    output: { type: "string" }, archive: { type: "string" }, "expected-revision": { type: "string" }, help: { type: "boolean", short: "h" },
  } });
  const [command, origin] = positionals;
  if (values.help || !command || command === "help") { process.stdout.write(USAGE); return; }
  if (positionals.length > 2 || (origin && !["upload", "status"].includes(command))) throw new VaultCliError("Invalid vault command; use vault --help");
  const scope = parseVaultScope({ journalDirectory: values.journals ?? DEFAULT_VAULT_SCOPE.journalDirectory, templatePath: values.template ?? DEFAULT_VAULT_SCOPE.templatePath });
  if (command === "status") {
    if (origin) {
      const state = await control(origin, "GET");
      process.stdout.write(`${JSON.stringify({ configured: state.configured === true, revision: state.revision })}\n`);
    } else process.stdout.write(`${JSON.stringify(await vaultLocalStatus(values.root))}\n`);
    return;
  }
  if (command === "upload") {
    const revision = values["expected-revision"];
    if (!origin || !values.archive || revision === undefined || !/^\d+$/.test(revision) || !Number.isSafeInteger(Number(revision))) throw new VaultCliError("Upload requires URL, a private archive, and the current provisioning revision");
    const archive = privateBytes(values.archive, MAX_WORKSPACE_BYTES);
    if (archive[0] !== 0x1f || archive[1] !== 0x8b) throw new VaultCliError("The selected file is not a workspace gzip archive");
    const state = await control(origin, "PUT", { archive, revision: Number(revision), scope });
    process.stdout.write(`${JSON.stringify({ configured: state.configured === true, revision: state.revision, scheduling: "paused", syncVerified: false })}\n`); return;
  }
  if (!["login", "remotes", "setup", "sync", "export"].includes(command)) throw new VaultCliError("Unknown vault command; use vault --help");
  const paths = layout(values.root ?? DEFAULT_ROOT, true);
  if (command === "login") { await headless(paths, ["login"], true); return; }
  if (command === "remotes") { await headless(paths, ["sync-list-remote"], true); return; }
  if (command === "setup") {
    if (!values["vault-id"] || !values["source-vault"]) throw new VaultCliError("Setup requires an explicit remote vault ID and read-only source-vault directory inventory");
    const vaultId = identifier(values["vault-id"], "remote vault ID");
    const excluded = await vaultExclusions(values["source-vault"], scope, values["exclude-folder"]);
    try { privateBytes(join(paths.root, "setup.json"), 8_192); throw new VaultCliError("This private client is already configured; use a separate private root for a deliberate replacement"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const count = (await vaultLocalStatus(paths.root)).configuredVaults;
    if (count) {
      const { config } = await workspaceConfig(paths.workspace, { configRoot: paths.configRoot, vaultRoot: paths.vaultRoot });
      if (count !== 1 || config.vaultId !== vaultId) throw new VaultCliError("A different private vault configuration already exists; it was not replaced");
    } else await headless(paths, ["sync-setup", "--vault", vaultId, "--path", paths.vaultRoot, "--device-name", "Umpi"], true);
    await headless(paths, ["sync-config", "--path", paths.vaultRoot, "--mode", "bidirectional", "--conflict-strategy", "conflict", "--file-types", "", "--configs", "", "--excluded-folders", excluded.join(",")], false);
    // In 0.0.14 an empty CLI option deletes allowTypes and restores attachment
    // defaults. An explicit empty array is the supported filter representation.
    const { config } = await workspaceConfig(paths.workspace, { configRoot: paths.configRoot, vaultRoot: paths.vaultRoot });
    const relative = `sync/${config.vaultId}/config.json`;
    const before = await readSafeFile(paths.configRoot, relative, 65_536);
    if (!before) throw new VaultCliError("Private headless setup disappeared");
    await atomicReplace(paths.configRoot, relative, before, Buffer.from(JSON.stringify({ ...record(JSON.parse(before.bytes.toString("utf8"))), allowTypes: [] })), 65_536);
    const receipt = { version: 1, scope, configHash: await configuredDigest(paths) };
    const fd = openSync(join(paths.root, "setup.json"), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { writeFileSync(fd, JSON.stringify(receipt)); fsyncSync(fd); } finally { closeSync(fd); }
    process.stdout.write(`${JSON.stringify({ configured: true, excludedFolders: excluded.length, syncRun: false })}\n`); return;
  }
  await requirePrepared(paths);
  if (command === "sync") {
    await headless(paths, ["sync", "--path", paths.vaultRoot], false, true);
    process.stdout.write("One-shot sync completed. Export will additionally verify per-file acknowledgement metadata.\n"); return;
  }
  if (!values.output) throw new VaultCliError("Export requires a new private output path outside the repository");
  const archive = await createWorkspaceArchive(paths.workspace, { configRoot: paths.configRoot, vaultRoot: paths.vaultRoot });
  const output = resolve(values.output); privateDirectory(dirname(output));
  const fd = openSync(output, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, archive); fsyncSync(fd); } finally { closeSync(fd); }
  process.stdout.write(`${JSON.stringify({ exported: true, bytes: archive.length })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.umask(0o077);
  runVaultCli(process.argv.slice(2)).catch(error => {
    process.stderr.write(`${error instanceof VaultCliError ? error.message : "Private vault operation failed; inspect local setup without exposing credentials"}\n`);
    process.exitCode = 1;
  });
}
