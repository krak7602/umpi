import { constants, type BigIntStats } from "node:fs";
import { lstat, realpath, open, mkdir, rename, unlink } from "node:fs/promises";
import { resolve, join, dirname, sep, parse } from "node:path";
import { randomUUID } from "node:crypto";

export class VaultServiceError extends Error {
  constructor(message: string, readonly status = 409) { super(message); this.name = "VaultServiceError"; }
}
export function portablePath(value: unknown): string {
  if (typeof value !== "string" || value.length > 1024 || /[\\:\u0000-\u001f\u007f]/u.test(value) ||
      value.split("/").some(part => !part || part === "." || part === ".." || part.trim() !== part)) {
    throw new VaultServiceError("Invalid workspace path", 400);
  }
  return value;
}
export function sameFile(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs && a.mode === b.mode;
}
/** Reject symlinks in every ancestor, including the configured workspace root. */
export async function safeDirectory(path: string, create = false): Promise<string> {
  const absolute = resolve(path);
  let current = parse(absolute).root;
  for (const part of absolute.slice(current.length).split(sep).filter(Boolean)) {
    current = join(current, part);
    if (create) { try { await mkdir(current, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; } }
    const stat = await lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new VaultServiceError("Workspace directories must not be links");
  }
  if (await realpath(absolute) !== absolute) throw new VaultServiceError("Workspace directory changed");
  return absolute;
}
export interface SafeFile { bytes: Buffer; stat: BigIntStats }
export async function readSafeFile(root: string, relative: string, limit: number): Promise<SafeFile | null> {
  portablePath(relative);
  const path = join(root, relative);
  try {
    await safeDirectory(dirname(path));
    const before = await lstat(path, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size > BigInt(limit)) throw new VaultServiceError("Workspace file is unsafe or too large");
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      if (!sameFile(before, await handle.stat({ bigint: true }))) throw new VaultServiceError("Workspace file changed");
      const buffer = Buffer.alloc(Number(before.size) + 1);
      let length = 0;
      while (length < buffer.length) {
        const next = await handle.read(buffer, length, buffer.length - length, length);
        if (!next.bytesRead) break;
        length += next.bytesRead;
      }
      if (length !== Number(before.size) || !sameFile(before, await handle.stat({ bigint: true })) ||
          !sameFile(before, await lstat(path, { bigint: true }))) throw new VaultServiceError("Workspace file changed");
      await safeDirectory(dirname(path));
      return { bytes: buffer.subarray(0, length), stat: before };
    } finally { await handle.close(); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    if (error instanceof VaultServiceError) throw error;
    throw new VaultServiceError("Cannot safely read workspace file");
  }
}
export function utf8(bytes: Uint8Array): string {
  try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw new VaultServiceError("Workspace text must be valid UTF-8"); }
}
export async function atomicReplace(root: string, relative: string, before: SafeFile | null, bytes: Uint8Array, limit: number, expiresAt?: number): Promise<void> {
  portablePath(relative);
  if (bytes.byteLength > limit) throw new VaultServiceError("Workspace file exceeds its limit");
  const path = join(root, relative);
  const directory = await safeDirectory(dirname(path), true);
  const identity = await lstat(directory, { bigint: true });
  const temporary = join(directory, `.umpi-write-${randomUUID()}`);
  let pending = true;
  try {
    const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    const current = await readSafeFile(root, relative, limit);
    if ((before === null) !== (current === null) || (before && current && (!sameFile(before.stat, current.stat) || !before.bytes.equals(current.bytes)))) {
      throw new VaultServiceError("Daily note changed before replacement");
    }
    const after = await lstat(directory, { bigint: true });
    if (identity.dev !== after.dev || identity.ino !== after.ino || await safeDirectory(directory) !== directory) throw new VaultServiceError("Workspace directory changed");
    if (expiresAt !== undefined && (!Number.isFinite(expiresAt) || expiresAt <= Date.now())) throw new VaultServiceError("Daily write authorization has expired");
    await rename(temporary, path); pending = false;
    const parent = await open(directory, constants.O_RDONLY);
    try { await parent.sync(); } finally { await parent.close(); }
  } finally {
    if (pending) await unlink(temporary).catch(() => {});
  }
}
