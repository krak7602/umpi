import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { MAX_WORKSPACE_BYTES } from "../shared/vault-planning.js";
import { readSafeFile, portablePath, VaultServiceError } from "./safety.js";
import { workspaceConfig, workspaceFiles, resolveWorkspaceRoots } from "./archive.js";
import type { WorkspaceRoots } from "./archive.js";

interface FileMetadata {
  path: string; hash: string; synchash?: string; synctime?: number;
  size: number; mtime: number; folder: boolean; deleted?: boolean; uid?: number;
}
/** Internal 0.0.14 schema: local/server rows are JSON; hash and synchash are
 * SHA-256 hex of plaintext. Upload records synchash only AFTER awaited push.
 * cli.js kc accepts encryption versions 0, 2 and 3; Ar/Dr encrypt file bodies
 * with Yt: a 12-byte nonce plus AES-GCM ciphertext and its default 16-byte tag.
 * push bypasses encryption for empty files; handlePush stores the wire size.
 * A matching server row additionally confirms the server notification was stored.
 * This is acknowledged sync, not an independent second-device remote read-back.
 */
export class SyncMetadata {
  private constructor(private readonly db: DatabaseSync) {}
  static async open(root: string, sources?: WorkspaceRoots): Promise<SyncMetadata> {
    const roots = resolveWorkspaceRoots(root, sources);
    const { config } = await workspaceConfig(root, roots);
    if (config.encryptionVersion !== 0 && config.encryptionVersion !== 2 && config.encryptionVersion !== 3) throw new VaultServiceError("Sync encryption version is unsupported");
    const relative = `sync/${config.vaultId}/state.db`;
    if (!await readSafeFile(roots.configRoot, relative, MAX_WORKSPACE_BYTES)) throw new VaultServiceError("Sync metadata is missing");
    for (const suffix of ["-wal", "-shm", "-journal"]) await readSafeFile(roots.configRoot, relative + suffix, MAX_WORKSPACE_BYTES);
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(join(roots.configRoot, relative), { readOnly: true, allowExtension: false });
      const initial = db.prepare("SELECT value FROM meta WHERE key = 'initial'").get();
      const pending = db.prepare("SELECT COUNT(*) AS count FROM pending_files").get();
      if (initial?.value !== "false" || pending?.count !== 0) throw new Error();
      return new SyncMetadata(db);
    } catch { db?.close(); throw new VaultServiceError("Sync metadata is incomplete or unsupported"); }
  }
  close(): void { this.db.close(); }
  private file(table: "local_files" | "server_files", path: string): FileMetadata | null {
    const row = this.db.prepare(`SELECT data FROM ${table} WHERE path = ?`).get(path);
    if (!row) return null;
    try {
      const result = JSON.parse(String(row.data)) as FileMetadata;
      if (!result || result.path !== path || typeof result.folder !== "boolean" || typeof result.hash !== "string") throw new Error();
      return result;
    } catch { throw new VaultServiceError("Sync file metadata is unsupported"); }
  }
  confirms(path: string, bytes: Uint8Array | null, mtimeMs?: number): boolean {
    portablePath(path);
    const local = this.file("local_files", path), server = this.file("server_files", path);
    if (bytes === null) return local === null && (server === null || server.deleted === true);
    const hash = createHash("sha256").update(bytes).digest("hex");
    const wireSize = bytes.byteLength === 0 ? 0 : bytes.byteLength + 12 + 16;
    return !!local && !!server && !local.folder && !server.folder && !server.deleted &&
      local.hash === hash && local.synchash === hash && server.hash === hash &&
      local.size === bytes.byteLength && server.size === wireSize &&
      typeof server.uid === "number" && server.uid > 0 &&
      (mtimeMs === undefined || local.mtime === Math.round(mtimeMs));
  }
  async confirmsWorkspace(root: string, sources?: WorkspaceRoots): Promise<boolean> {
    const roots = resolveWorkspaceRoots(root, sources);
    const rows = this.db.prepare("SELECT path FROM local_files").all();
    if (rows.length > 10_000) return false;
    let bytes = 0;
    const paths = new Set((await workspaceFiles(root, roots)).filter(path => path.startsWith("vault/")).map(path => path.slice(6)));
    for (const row of rows) {
      const path = portablePath(row.path);
      const local = this.file("local_files", path);
      if (local?.folder) continue;
      if (!paths.delete(path)) return false;
      const file = await readSafeFile(roots.vaultRoot, path, MAX_WORKSPACE_BYTES - bytes);
      if (!file || !this.confirms(path, file.bytes, Number(file.stat.mtimeNs) / 1e6)) return false;
      bytes += file.bytes.length;
    }
    return paths.size === 0;
  }
}
