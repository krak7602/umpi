import { spawn } from "node:child_process";
import type { Dirent } from "node:fs";
import { lstat, unlink, readdir } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import {
  MAX_NOTE_BYTES, parseVaultApply, parseVaultScope, vaultDayPath, vaultNoteRevision,
  type VaultPlanningApply, type VaultPlanningResult, type VaultPlanningScope, type VaultPlanningSnapshot,
} from "../shared/vault-planning.js";
import { shiftPlanningDay } from "../shared/daily-planning.js";
import { atomicReplace, readSafeFile, safeDirectory, utf8, VaultServiceError, type SafeFile } from "./safety.js";
import { createWorkspaceArchive, restoreWorkspaceArchive, workspaceConfig, workspaceFiles, HEADLESS_VERSION } from "./archive.js";
import { SyncMetadata } from "./metadata.js";

const MAX_OUTPUT_BYTES = 256 * 1024;
const MAX_SYNC_MS = 120_000;
/** Only exact standalone stdout markers count. Never retain or expose private CLI output. */
export class SyncOutput {
  private partial = "";
  private size = 0;
  fullySynced = false;
  conflicted = false;
  exceeded = false;
  accept(bytes: Buffer, stdout: boolean): void {
    this.size += bytes.length;
    if (this.size > MAX_OUTPUT_BYTES) { this.exceeded = true; return; }
    if (!stdout) return;
    this.partial += bytes.toString("utf8");
    if (this.partial.length > MAX_OUTPUT_BYTES) { this.exceeded = true; return; }
    let end: number;
    while ((end = this.partial.indexOf("\n")) !== -1) {
      const line = this.partial.slice(0, end).replace(/\r$/, "");
      this.partial = this.partial.slice(end + 1);
      if (line === "Fully synced") this.fullySynced = true;
      if (line.startsWith("Conflicted copy stored ") || line.startsWith("Renaming conflicted file ")) this.conflicted = true;
    }
  }
}
export interface SyncReceipt { fullySynced: true; conflicted: boolean }
/** No shell, user arguments, inherited token env, interactive auth or continuous process. */
export async function runHeadlessSync(workspaceRoot: string, cliPath: string, timeoutMs = MAX_SYNC_MS): Promise<SyncReceipt> {
  if (process.platform !== "linux") throw new VaultServiceError("Headless service sync requires Linux with isolated XDG state", 503);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_SYNC_MS) throw new VaultServiceError("Invalid sync deadline", 400);
  const root = resolve(workspaceRoot);
  const cli = resolve(cliPath);
  const manifest = await readSafeFile(dirname(cli), "package.json", 64 * 1024);
  try {
    const pkg = JSON.parse(utf8(manifest!.bytes));
    if (pkg.name !== "obsidian-headless" || pkg.version !== HEADLESS_VERSION) throw new Error();
  } catch { throw new VaultServiceError("Pinned headless client is unavailable", 503); }
  await safeDirectory(join(root, "vault"));
  const capture = new SyncOutput();
  const { promise, resolve: resolveReceipt, reject } = Promise.withResolvers<SyncReceipt>();
  const child = spawn(process.execPath, [cli, "sync", "--path", join(root, "vault")], {
    cwd: join(root, "vault"), shell: false, stdio: ["ignore", "pipe", "pipe"],
    env: { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", HOME: root, XDG_CONFIG_HOME: join(root, "xdg"), LANG: "C.UTF-8" },
  });
  let aborted = false;
  const stop = () => { aborted = true; child.kill("SIGKILL"); };
  const timeout = setTimeout(stop, timeoutMs);
  child.stdout.on("data", (bytes: Buffer) => { capture.accept(bytes, true); if (capture.exceeded) stop(); });
  child.stderr.on("data", (bytes: Buffer) => { capture.accept(bytes, false); if (capture.exceeded) stop(); });
  child.once("error", () => { clearTimeout(timeout); reject(new VaultServiceError("Headless sync could not start", 503)); });
  child.once("close", (code, signal) => {
    clearTimeout(timeout);
    if (aborted || signal || code !== 0 || !capture.fullySynced || capture.exceeded) reject(new VaultServiceError("Headless sync was not confirmed", 503));
    else resolveReceipt({ fullySynced: true, conflicted: capture.conflicted });
  });
  return promise;
}
export interface VaultRuntimeOptions { stateRoot?: string; cliPath?: string; syncTimeoutMs?: number }
export class VaultRuntime {
  readonly workspaceRoot: string;
  private readonly cliPath: string;
  private readonly timeoutMs: number;
  private busy = false;
  private checkpointReady = false;
  constructor(options: VaultRuntimeOptions = {}) {
    this.workspaceRoot = join(resolve(options.stateRoot ?? process.env.UMPI_VAULT_STATE ?? "/state"), "workspace");
    this.cliPath = options.cliPath ?? process.env.UMPI_HEADLESS_CLI ?? "/opt/headless/node_modules/obsidian-headless/cli.js";
    this.timeoutMs = options.syncTimeoutMs ?? MAX_SYNC_MS;
  }
  async initialized(): Promise<boolean> {
    try { await safeDirectory(this.workspaceRoot); return (await lstat(this.workspaceRoot)).isDirectory(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw new VaultServiceError("Workspace is unsafe"); }
  }
  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    if (this.busy) throw new VaultServiceError("Workspace operation already in progress", 409);
    this.busy = true;
    try { return await operation(); }
    finally { this.busy = false; }
  }
  async restore(archive: Uint8Array): Promise<void> {
    return this.exclusive(async () => {
      await restoreWorkspaceArchive(this.workspaceRoot, archive);
      this.checkpointReady = false;
    });
  }
  private async prepare(): Promise<void> {
    if (!await this.initialized()) throw new VaultServiceError("Private headless setup is required", 503);
    if (await readSafeFile(this.workspaceRoot, ".unconfirmed", 1024)) throw new VaultServiceError("Workspace has an unconfirmed operation; restore the last checkpoint", 409);
    this.checkpointReady = false;
    await workspaceFiles(this.workspaceRoot);
    const auth = await readSafeFile(this.workspaceRoot, "xdg/obsidian-headless/auth_token", 64 * 1024);
    if (!auth?.bytes.length) throw new VaultServiceError("Private headless authentication is required", 503);
    const { config, path } = await workspaceConfig(this.workspaceRoot);
    if (config.conflictStrategy !== "conflict") {
      const before = await readSafeFile(this.workspaceRoot, path, 64 * 1024);
      await atomicReplace(this.workspaceRoot, path, before, Buffer.from(JSON.stringify({ ...config, conflictStrategy: "conflict" })), 64 * 1024);
    }
    await atomicReplace(this.workspaceRoot, ".unconfirmed", null, Buffer.from("operation in progress\n"), 1024);
  }
  private async sync(): Promise<SyncReceipt> {
    const receipt = await runHeadlessSync(this.workspaceRoot, this.cliPath, this.timeoutMs);
    // Re-scan after the child: remote files must not introduce unsafe paths/links.
    await workspaceFiles(this.workspaceRoot);
    return receipt;
  }
  private async confirmCheckpoint(): Promise<void> {
    const metadata = await SyncMetadata.open(this.workspaceRoot);
    try { if (!await metadata.confirmsWorkspace(this.workspaceRoot)) throw new VaultServiceError("Workspace metadata has unconfirmed files"); }
    finally { metadata.close(); }
    await unlink(join(this.workspaceRoot, ".unconfirmed"));
    this.checkpointReady = true;
  }
  async snapshot(day: string, rawScope: VaultPlanningScope): Promise<VaultPlanningSnapshot> {
    const scope = parseVaultScope(rawScope), targetPath = vaultDayPath(scope, day);
    return this.exclusive(async () => {
      await this.prepare();
      const receipt = await this.sync();
      if (receipt.conflicted) throw new VaultServiceError("Vault contains a new sync conflict");
      const metadata = await SyncMetadata.open(this.workspaceRoot);
      let total = 0;
      const readNote = async (path: string): Promise<string | null> => {
        const file = await readSafeFile(join(this.workspaceRoot, "vault"), path, MAX_NOTE_BYTES);
        if (!metadata.confirms(path, file?.bytes ?? null, file ? Number(file.stat.mtimeNs) / 1e6 : undefined)) throw new VaultServiceError("Selected note has no synchronized metadata");
        total += file?.bytes.length ?? 0;
        if (total > 1024 * 1024) throw new VaultServiceError("Planning inputs exceed their aggregate limit");
        return file ? utf8(file.bytes) : null;
      };
      let result: VaultPlanningSnapshot;
      try {
        const target = await readNote(targetPath), template = await readNote(scope.templatePath);
        if (template === null) throw new VaultServiceError("The current daily template is unavailable");
        const recent: VaultPlanningSnapshot["recent"] = [];
        const directory = join(this.workspaceRoot, "vault", scope.journalDirectory);
        let entries: Dirent[];
        try {
          await safeDirectory(directory);
          entries = await readdir(directory, { withFileTypes: true });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          entries = [];
        }
        const dates: string[] = [];
        for (const entry of entries) {
          if (!entry.isFile() || !/^\d{4}-\d{2}-\d{2}\.md$/.test(entry.name)) continue;
          const date = entry.name.slice(0, -3);
          try { shiftPlanningDay(date, 0); } catch { continue; }
          if (date < day) dates.push(date);
        }
        for (const date of dates.sort().reverse().slice(0, 3)) {
          const path = vaultDayPath(scope, date);
          const text = await readNote(path);
          if (text !== null) recent.push({ path, text });
        }
        result = { day, checkedAt: new Date().toISOString(), revision: vaultNoteRevision(target), target, template, recent };
      } finally { metadata.close(); }
      await this.confirmCheckpoint();
      return result;
    });
  }
  async apply(rawIntent: VaultPlanningApply, rawScope: VaultPlanningScope): Promise<VaultPlanningResult> {
    const intent = parseVaultApply(rawIntent), scope = parseVaultScope(rawScope);
    const path = vaultDayPath(scope, intent.day);
    return this.exclusive(async () => {
      let before: SafeFile | null = null;
      let revision = intent.beforeRevision;
      try {
        await this.prepare();
        const pulled = await this.sync();
        before = await readSafeFile(join(this.workspaceRoot, "vault"), path, MAX_NOTE_BYTES);
        const text = before ? utf8(before.bytes) : null;
        revision = vaultNoteRevision(text);
        if (pulled.conflicted) return { status: "conflict", revision, checkedAt: new Date().toISOString(), issue: "Sync preserved a conflicted copy; owner review is required" };
        const metadata = await SyncMetadata.open(this.workspaceRoot);
        try {
          if (!metadata.confirms(path, before?.bytes ?? null, before ? Number(before.stat.mtimeNs) / 1e6 : undefined)) throw new VaultServiceError("Daily note synchronization is not confirmed");
          if (text === intent.text) {
            await this.confirmCheckpoint();
            return { status: "synced", revision, checkedAt: new Date().toISOString() };
          }
        } finally { metadata.close(); }
        if (revision !== intent.beforeRevision) {
          await this.confirmCheckpoint();
          return { status: "conflict", revision, checkedAt: new Date().toISOString(), issue: "Daily note changed after planning; no replacement was made" };
        }
        // Expiry is checked after the pull, immediately before the only local write.
        if (!Number.isFinite(Date.parse(intent.expiresAt)) || Date.parse(intent.expiresAt) <= Date.now()) throw new VaultServiceError("Daily write authorization has expired");
        const priorConflicts = new Set((await workspaceFiles(this.workspaceRoot)).filter(p => p.includes(" (Conflicted copy")));
        await atomicReplace(join(this.workspaceRoot, "vault"), path, before, Buffer.from(intent.text), MAX_NOTE_BYTES, Date.parse(intent.expiresAt));
        const uploaded = await this.sync();
        const after = await readSafeFile(join(this.workspaceRoot, "vault"), path, MAX_NOTE_BYTES);
        revision = vaultNoteRevision(after ? utf8(after.bytes) : null);
        const newConflict = (await workspaceFiles(this.workspaceRoot)).some(p => p.includes(" (Conflicted copy") && !priorConflicts.has(p));
        if (uploaded.conflicted || newConflict || !after || utf8(after.bytes) !== intent.text) return { status: "conflict", revision, checkedAt: new Date().toISOString(), issue: "Remote content or a conflicted copy requires owner review" };
        const acknowledged = await SyncMetadata.open(this.workspaceRoot);
        try { if (!acknowledged.confirms(path, after.bytes, Number(after.stat.mtimeNs) / 1e6)) throw new VaultServiceError("Daily note upload is not acknowledged"); }
        finally { acknowledged.close(); }
        await this.confirmCheckpoint();
        return { status: "synced", revision, checkedAt: new Date().toISOString() };
      } catch {
        this.checkpointReady = false;
        return { status: "unconfirmed", revision, checkedAt: new Date().toISOString(), issue: "Sync or write authorization was not confirmed; retain this intent and restore the last checkpoint before recovery" };
      }
    });
  }
  async archive(): Promise<Buffer> {
    return this.exclusive(async () => {
      if (!this.checkpointReady) throw new VaultServiceError("A confirmed sync is required before checkpointing");
      return createWorkspaceArchive(this.workspaceRoot);
    });
  }
}
