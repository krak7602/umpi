import type { AuthOperationOptions, Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";
import type { Database } from "./store.js";

/** A DO has one live owner; the promise chain also serializes asynchronous OAuth refresh callbacks. */
export class DurableCredentials implements CredentialStore {
  private readonly locks = new Map<string, Promise<unknown>>();
  constructor(private readonly db: Database) {}

  async read(providerId: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
    options?.signal?.throwIfAborted();
    const row = this.db.all<{ data: string }>("SELECT data FROM umpi_credentials WHERE id=?", providerId)[0];
    return row ? JSON.parse(row.data) as Credential : undefined;
  }

  async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
    options?.signal?.throwIfAborted();
    return this.db.all<{ id: string; type: Credential["type"] }>("SELECT id,json_extract(data,'$.type') AS type FROM umpi_credentials ORDER BY id")
      .map(row => ({ providerId: row.id, type: row.type }));
  }

  private async locked<T>(providerId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(providerId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(work);
    this.locks.set(providerId, next);
    try { return await next; }
    finally { if (this.locks.get(providerId) === next) this.locks.delete(providerId); }
  }

  async modify(providerId: string, fn: (current: Credential | undefined) => Promise<Credential | undefined>, options?: AuthOperationOptions): Promise<Credential | undefined> {
    return this.locked(providerId, async () => {
      options?.signal?.throwIfAborted();
      const current = await this.read(providerId, options);
      const updated = await fn(current);
      // Persist a rotated token even if its initiating request was cancelled during refresh.
      if (updated !== undefined) this.db.all("INSERT INTO umpi_credentials VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data=excluded.data", providerId, JSON.stringify(updated));
      return updated ?? current;
    });
  }

  async delete(providerId: string, options?: AuthOperationOptions): Promise<void> {
    await this.locked(providerId, async () => {
      options?.signal?.throwIfAborted();
      this.db.all("DELETE FROM umpi_credentials WHERE id=?", providerId);
    });
  }
}
