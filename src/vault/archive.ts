import { gzipSync, gunzipSync } from "node:zlib";
import { readdir, mkdir, open, utimes, rename, rm, lstat } from "node:fs/promises";
import { constants } from "node:fs";
import { join, dirname, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { MAX_WORKSPACE_BYTES } from "../shared/vault-planning.js";
import { VaultServiceError, portablePath, readSafeFile, safeDirectory, utf8 } from "./safety.js";

import { SyncMetadata } from "./metadata.js";
export const HEADLESS_VERSION = "0.0.14";
export const MAX_ARCHIVE_ENTRIES = 10_000;
export const MAX_ARCHIVE_JSON_BYTES = Math.ceil(MAX_WORKSPACE_BYTES * 4 / 3) + 4 * 1024 * 1024;
/** Private gzip JSON. Paths have ONLY xdg/obsidian-headless/ or vault/ prefixes.
 * A single config's vaultPath is portable '@umpi/vault'; restore remaps it.
 * Files retain mtime (CLI scan cache depends on it); modes become 0600/0700.
 * Entire stopped SQLite state (including any WAL/SHM), token and E2EE config
 * travel together. Never copy a running client or an unconfirmed local write.
 */
export interface WorkspaceArchive {
  version: 1;
  headlessVersion: typeof HEADLESS_VERSION;
  files: { path: string; data: string; mtimeMs: number }[];
}
/** Trusted owner-export roots only; the HTTP runtime never accepts these. */
export interface WorkspaceRoots { configRoot: string; vaultRoot: string }
export function resolveWorkspaceRoots(root: string, sources?: WorkspaceRoots): WorkspaceRoots {
  const configRoot = resolve(sources?.configRoot ?? join(root, "xdg/obsidian-headless"));
  const vaultRoot = resolve(sources?.vaultRoot ?? join(root, "vault"));
  if (configRoot === vaultRoot || configRoot.startsWith(vaultRoot + sep) || vaultRoot.startsWith(configRoot + sep)) throw new VaultServiceError("Client state and vault roots must be separate");
  return { configRoot, vaultRoot };
}
export interface WorkspaceConfig extends Record<string, unknown> {
  vaultId: string; vaultPath: string; encryptionKey: string; encryptionSalt: string;
  encryptionVersion: number; configDir?: string;
}
export function parseWorkspaceConfig(value: unknown): WorkspaceConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new VaultServiceError("Invalid headless configuration");
  const config = value as WorkspaceConfig;
  if (![config.vaultId, config.vaultPath, config.encryptionKey, config.encryptionSalt, config.host].every(v => typeof v === "string" && v.length > 0) ||
      !Number.isInteger(config.encryptionVersion) || !/^[a-zA-Z0-9_-]+$/.test(config.vaultId)) throw new VaultServiceError("Headless setup is incomplete");
  if (Object.values(config).some(v => typeof v === "string" && /[\u0000-\u001f\u007f]/u.test(v)) ||
      Object.values(config).some(v => Array.isArray(v) && v.some(item => typeof item === "string" && /[\u0000-\u001f\u007f]/u.test(item)))) throw new VaultServiceError("Invalid headless configuration text");
  if (config.configDir !== undefined && (typeof config.configDir !== "string" || portablePath(config.configDir).includes("/"))) throw new VaultServiceError("Invalid vault configuration directory");
  if (config.syncMode && config.syncMode !== "bidirectional") throw new VaultServiceError("Planning requires bidirectional sync");
  return config;
}
export async function workspaceConfig(root: string, sources?: WorkspaceRoots): Promise<{ config: WorkspaceConfig; path: string }> {
  const { configRoot, vaultRoot } = resolveWorkspaceRoots(root, sources);
  const directory = join(configRoot, "sync");
  await safeDirectory(directory);
  const entries = await readdir(directory, { withFileTypes: true });
  if (entries.length !== 1 || !entries[0]!.isDirectory()) throw new VaultServiceError("Exactly one headless vault must be configured");
  const path = `xdg/obsidian-headless/sync/${portablePath(entries[0]!.name)}/config.json`;
  const file = await readSafeFile(configRoot, `sync/${entries[0]!.name}/config.json`, 64 * 1024);
  if (!file) throw new VaultServiceError("Headless setup is incomplete");
  let config: WorkspaceConfig;
  try { config = parseWorkspaceConfig(JSON.parse(utf8(file.bytes))); }
  catch { throw new VaultServiceError("Headless setup is incomplete"); }
  if (config.vaultId !== entries[0]!.name || resolve(config.vaultPath) !== vaultRoot) throw new VaultServiceError("Headless vault path is not isolated");
  return { config, path };
}
export async function workspaceFiles(root: string, sources?: WorkspaceRoots): Promise<string[]> {
  const { configRoot, vaultRoot } = resolveWorkspaceRoots(root, sources);
  const result: string[] = [];
  let entries = 0;
  async function visit(directory: string, relative: string): Promise<void> {
    await safeDirectory(directory);
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (++entries > MAX_ARCHIVE_ENTRIES) throw new VaultServiceError("Workspace has too many entries");
      const path = portablePath(`${relative}/${entry.name}`);
      if (entry.name === ".sync.lock" || entry.name.startsWith(".umpi-write-")) throw new VaultServiceError("Workspace is not a stopped checkpoint");
      if (entry.isDirectory()) await visit(join(directory, entry.name), path);
      else if (entry.isFile()) result.push(path);
      else throw new VaultServiceError("Workspace links and special files are prohibited");
    }
  }
  await visit(configRoot, "xdg/obsidian-headless"); await visit(vaultRoot, "vault");
  return result.sort();
}
export async function createWorkspaceArchive(workspaceRoot: string, sources?: WorkspaceRoots): Promise<Buffer> {
  const root = resolve(workspaceRoot);
  const roots = resolveWorkspaceRoots(root, sources);
  if (await readSafeFile(root, ".unconfirmed", 1024)) throw new VaultServiceError("Unconfirmed workspace cannot be checkpointed");
  const { path: configPath } = await workspaceConfig(root, roots);
  const paths = await workspaceFiles(root, roots);
  if (!paths.includes("xdg/obsidian-headless/auth_token")) throw new VaultServiceError("Portable authentication state is missing");
  const metadata = await SyncMetadata.open(root, roots);
  try { if (!await metadata.confirmsWorkspace(root, roots)) throw new VaultServiceError("Unconfirmed workspace cannot be checkpointed"); }
  finally { metadata.close(); }
  const archive: WorkspaceArchive = { version: 1, headlessVersion: HEADLESS_VERSION, files: [] };
  let total = 0;
  for (const path of paths) {
    const file = path.startsWith("vault/")
      ? await readSafeFile(roots.vaultRoot, path.slice("vault/".length), MAX_WORKSPACE_BYTES - total)
      : await readSafeFile(roots.configRoot, path.slice("xdg/obsidian-headless/".length), MAX_WORKSPACE_BYTES - total);
    if (!file) throw new VaultServiceError("Workspace changed during checkpoint");
    let bytes = file.bytes;
    if (path === configPath) {
      const config = parseWorkspaceConfig(JSON.parse(utf8(bytes)));
      bytes = Buffer.from(JSON.stringify({ ...config, vaultPath: "@umpi/vault", conflictStrategy: "conflict" }));
    }
    total += bytes.length;
    if (total > MAX_WORKSPACE_BYTES) throw new VaultServiceError("Workspace exceeds archive limit");
    archive.files.push({ path, data: bytes.toString("base64"), mtimeMs: Number(file.stat.mtimeNs) / 1e6 });
  }
  const json = Buffer.from(JSON.stringify(archive));
  if (json.length > MAX_ARCHIVE_JSON_BYTES) throw new VaultServiceError("Workspace exceeds archive limit");
  const compressed = gzipSync(json);
  if (compressed.length > MAX_WORKSPACE_BYTES) throw new VaultServiceError("Workspace exceeds archive limit");
  return compressed;
}
export async function restoreWorkspaceArchive(workspaceRoot: string, compressed: Uint8Array): Promise<void> {
  if (compressed.byteLength > MAX_WORKSPACE_BYTES) throw new VaultServiceError("Archive exceeds size limit", 413);
  let value: unknown;
  try { value = JSON.parse(utf8(gunzipSync(compressed, { maxOutputLength: MAX_ARCHIVE_JSON_BYTES }))); }
  catch { throw new VaultServiceError("Invalid private workspace archive", 400); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new VaultServiceError("Invalid archive", 400);
  const archive = value as WorkspaceArchive;
  if (Object.keys(archive).some(k => !["version", "headlessVersion", "files"].includes(k)) || archive.version !== 1 || archive.headlessVersion !== HEADLESS_VERSION ||
      !Array.isArray(archive.files) || archive.files.length > MAX_ARCHIVE_ENTRIES) throw new VaultServiceError("Unsupported archive schema", 400);
  const files: { path: string; bytes: Buffer; mtimeMs: number }[] = [];
  const paths = new Set<string>(); let total = 0; let configCount = 0;
  let vaultId = "";
  const root = resolve(workspaceRoot);
  for (const file of archive.files) {
    if (!file || typeof file !== "object" || Object.keys(file).some(k => !["path", "data", "mtimeMs"].includes(k))) throw new VaultServiceError("Invalid archive entry", 400);
    const path = portablePath(file.path);
    if ((!path.startsWith("xdg/obsidian-headless/") && !path.startsWith("vault/")) || paths.has(path) || path.split("/").some(p => p === ".sync.lock" || p.startsWith(".umpi-write-")) ||
        typeof file.data !== "string" || !Number.isFinite(file.mtimeMs) || file.mtimeMs < 0 || file.mtimeMs > 8.64e15) throw new VaultServiceError("Invalid archive entry", 400);
    const bytes = Buffer.from(file.data, "base64");
    if (bytes.toString("base64") !== file.data) throw new VaultServiceError("Invalid archive encoding", 400);
    total += bytes.length;
    if (total > MAX_WORKSPACE_BYTES) throw new VaultServiceError("Archive exceeds size limit", 413);
    paths.add(path);
    if (/^xdg\/obsidian-headless\/sync\/[^/]+\/config\.json$/.test(path)) {
      let config: WorkspaceConfig;
      try { config = parseWorkspaceConfig(JSON.parse(utf8(bytes))); } catch { throw new VaultServiceError("Invalid archived headless configuration", 400); }
      if (config.vaultPath !== "@umpi/vault" || path !== `xdg/obsidian-headless/sync/${config.vaultId}/config.json`) throw new VaultServiceError("Archive requires a portable vault path", 400);
      configCount++;
      vaultId = config.vaultId;
      files.push({ path, bytes: Buffer.from(JSON.stringify({ ...config, vaultPath: join(root, "vault"), conflictStrategy: "conflict" })), mtimeMs: file.mtimeMs });
    } else files.push({ path, bytes, mtimeMs: file.mtimeMs });
  }
  if (configCount !== 1 || !paths.has("xdg/obsidian-headless/auth_token") || !paths.has(`xdg/obsidian-headless/sync/${vaultId}/state.db`)) throw new VaultServiceError("Archive is missing provisioned client state", 400);
  const directories = new Set<string>();
  for (const path of paths) {
    if (path.startsWith("xdg/obsidian-headless/sync/") && !path.startsWith(`xdg/obsidian-headless/sync/${vaultId}/`)) throw new VaultServiceError("Archive contains another headless vault", 400);
    const parts = path.split("/");
    while (parts.length > 1) {
      parts.pop();
      const directory = parts.join("/");
      if (paths.has(directory)) throw new VaultServiceError("Archive file shadows a directory", 400);
      directories.add(directory);
      if (directories.size + paths.size > MAX_ARCHIVE_ENTRIES) throw new VaultServiceError("Archive has too many entries", 400);
    }
  }
  await safeDirectory(dirname(root), true);
  try { await lstat(root); throw new VaultServiceError("Workspace is already initialized"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const stage = join(dirname(root), `.umpi-restore-${randomUUID()}`);
  await mkdir(stage, { mode: 0o700 });
  try {
    await safeDirectory(join(stage, "vault"), true);
    for (const file of files) {
      const path = join(stage, file.path);
      await safeDirectory(dirname(path), true);
      const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { await handle.writeFile(file.bytes); await handle.sync(); } finally { await handle.close(); }
      await utimes(path, file.mtimeMs / 1000, file.mtimeMs / 1000);
    }
    await rename(stage, root);
  } finally { await rm(stage, { recursive: true, force: true }); }
}
