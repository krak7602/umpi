import { randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import * as fs from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import type { AuthOperationOptions, Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";
import { ASSISTANT_PROVIDERS, assertAssistantProvider, parseAssistantCredential } from "./credentials.js";

const MAX_FILE_BYTES = 1_048_576;
const REPOSITORY = fileURLToPath(new URL("../../", import.meta.url));

export class AuthStorageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthStorageError";
  }
}

function isCode(error: unknown, code: string): boolean {
  return error !== null && typeof error === "object" && "code" in error && error.code === code;
}

function isInside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (path !== ".." && !path.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(path));
}

function assertPrivate(stat: Stats, directory: boolean): void {
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile()) || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0 || (!directory && stat.nlink !== 1)) {
    throw new AuthStorageError("Auth state must be owner-only, owned by this user, and not a symlink or shared file");
  }
}

/**
 * Independent umpi state. Atomic per-provider files avoid cross-provider lost
 * updates; a filesystem lock covers the entire async refresh transaction.
 * Locks are never stolen on a timer: a paused refresh may still rotate a token.
 * After a killed writer, the owner must inspect the lock's PID before removing it.
 */
export class FileCredentialStore implements CredentialStore {
  readonly directory: string;

  constructor(directory = join(homedir(), ".config", "umpi", "auth")) {
    this.directory = resolve(directory);
    if (isInside(REPOSITORY, this.directory)) {
      throw new AuthStorageError("Auth state must be outside the repository");
    }
  }

  private async prepare(): Promise<void> {
    try {
      await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
      assertPrivate(await fs.lstat(this.directory), true);
      const canonical = await fs.realpath(this.directory);
      if (isInside(await fs.realpath(REPOSITORY), canonical)) {
        throw new AuthStorageError("Auth state must be outside the repository");
      }
    } catch (error) {
      if (error instanceof AuthStorageError) throw error;
      throw new AuthStorageError("Cannot open the private umpi auth directory");
    }
  }

  private async readJson(name: string): Promise<unknown | undefined> {
    let file: fs.FileHandle | undefined;
    try {
      file = await fs.open(join(this.directory, name), constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = await file.stat();
      assertPrivate(stat, false);
      if (stat.size > MAX_FILE_BYTES) throw new AuthStorageError("Auth state is oversized or corrupt; it was not changed");
      return JSON.parse(await file.readFile("utf8"));
    } catch (error) {
      if (isCode(error, "ENOENT")) return undefined;
      if (error instanceof AuthStorageError) throw error;
      throw new AuthStorageError("Cannot read auth state: invalid JSON, unsafe file, or storage failure; it was not changed");
    } finally {
      await file?.close();
    }
  }

  private async readCredential(providerId: string): Promise<Credential | undefined> {
    const data = await this.readJson(`${providerId}.json`);
    if (data === undefined) return undefined;
    try {
      if (!data || typeof data !== "object" || !("version" in data) || data.version !== 1 || !("credential" in data)) throw new Error();
      return parseAssistantCredential(providerId, data.credential);
    } catch {
      throw new AuthStorageError("Auth credential is corrupt or from an unsupported version; it was not changed");
    }
  }

  private async atomicWrite(name: string, value: unknown): Promise<void> {
    const target = join(this.directory, name);
    const temporary = join(this.directory, `.${name}.${randomUUID()}.tmp`);
    let file: fs.FileHandle | undefined;
    try {
      file = await fs.open(temporary, "wx", 0o600);
      await file.writeFile(`${JSON.stringify(value)}\n`, "utf8");
      await file.sync();
      await file.close();
      file = undefined;
      await fs.rename(temporary, target);
      const directory = await fs.open(dirname(target), constants.O_RDONLY);
      try { await directory.sync(); } finally { await directory.close(); }
    } catch {
      throw new AuthStorageError("Cannot persist auth state atomically; check owner-only storage and available space");
    } finally {
      await file?.close();
      await fs.unlink(temporary).catch(error => { if (!isCode(error, "ENOENT")) throw new AuthStorageError("Cannot remove temporary auth state"); });
    }
  }

  private async withLock<T>(name: string, operation: () => Promise<T>, options?: AuthOperationOptions): Promise<T> {
    options?.signal?.throwIfAborted();
    await this.prepare();
    const lock = join(this.directory, `${name}.lock`);
    const deadline = Date.now() + 30_000;
    while (true) {
      options?.signal?.throwIfAborted();
      try {
        await fs.mkdir(lock, { mode: 0o700 });
        break;
      } catch (error) {
        if (!isCode(error, "EEXIST")) throw new AuthStorageError("Cannot acquire the private auth lock");
        try {
          assertPrivate(await fs.lstat(lock), true);
        } catch (inspectionError) {
          if (isCode(inspectionError, "ENOENT")) continue;
          throw inspectionError;
        }
        if (Date.now() >= deadline) {
          throw new AuthStorageError("Auth state is locked. If its writer was killed, inspect the lock owner PID before removing the stale .lock directory");
        }
        await delay(50, undefined, { signal: options?.signal });
      }
    }
    try {
      await fs.writeFile(join(lock, "owner.json"), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), { flag: "wx", mode: 0o600 });
      options?.signal?.throwIfAborted();
      return await operation();
    } finally {
      await fs.unlink(join(lock, "owner.json")).catch(error => { if (!isCode(error, "ENOENT")) throw new AuthStorageError("Cannot release auth lock metadata"); });
      await fs.rmdir(lock);
    }
  }

  async read(providerId: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
    assertAssistantProvider(providerId);
    options?.signal?.throwIfAborted();
    await this.prepare();
    const credential = await this.readCredential(providerId);
    options?.signal?.throwIfAborted();
    return credential;
  }

  async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
    const result: CredentialInfo[] = [];
    for (const providerId of ASSISTANT_PROVIDERS) {
      const credential = await this.read(providerId, options);
      if (credential) result.push({ providerId, type: credential.type });
    }
    return result;
  }

  async modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
    options?: AuthOperationOptions,
  ): Promise<Credential | undefined> {
    assertAssistantProvider(providerId);
    return this.withLock(providerId, async () => {
      const current = await this.readCredential(providerId);
      options?.signal?.throwIfAborted();
      // Once invoked, the callback may have rotated a remote token. Persist its
      // result even if its caller no longer wants to wait.
      const next = await fn(current === undefined ? undefined : structuredClone(current));
      if (next === undefined) return current;
      const credential = parseAssistantCredential(providerId, next);
      await this.atomicWrite(`${providerId}.json`, { version: 1, credential });
      return credential;
    }, options);
  }

  async delete(providerId: string, options?: AuthOperationOptions): Promise<void> {
    assertAssistantProvider(providerId);
    await this.withLock(providerId, async () => {
      // Do not silently remove corrupt or non-private state.
      await this.readCredential(providerId);
      options?.signal?.throwIfAborted();
      await fs.unlink(join(this.directory, `${providerId}.json`)).catch(error => {
        if (!isCode(error, "ENOENT")) throw new AuthStorageError("Cannot remove auth credential");
      });
      const directory = await fs.open(this.directory, constants.O_RDONLY);
      try { await directory.sync(); } finally { await directory.close(); }
    }, options);
  }

  async deviceId(options?: AuthOperationOptions): Promise<string> {
    return this.withLock("installation", async () => {
      const stored = await this.readJson("installation.json");
      if (stored !== undefined) {
        if (!stored || typeof stored !== "object" || !("version" in stored) || stored.version !== 1 || !("deviceId" in stored) || typeof stored.deviceId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(stored.deviceId)) {
          throw new AuthStorageError("Auth installation identity is corrupt; it was not changed");
        }
        return stored.deviceId;
      }
      const deviceId = randomUUID();
      await this.atomicWrite("installation.json", { version: 1, deviceId });
      return deviceId;
    }, options);
  }
}
