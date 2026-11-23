import type { CloudMachineStart } from "./cloud-machines.js";

/**
 * A cloud machine's saved state, and the rules that keep it good. This is the logic of the `CloudMachine` Durable
 * Object without the Durable Object: storage, the container, R2, and the clock come in as parameters.
 *
 * Two rules hold:
 * 1. Only a home folder that is the whole saved state may be saved. A machine whose restore did not complete is
 *    stopped, its saved state stays as it was, and the next wake restores again.
 * 2. A save never writes over the current saved state. It writes a new object, checks it, and only then makes it
 *    current. The object before it is deleted after that.
 */

/** One saved state in R2. */
export interface SavedState { key: string; size: number; parts: number; savedAt: string; sha256?: string }
/** Whether the home folder in the container is the whole saved state. */
export interface HomeState { state: "restoring" | "complete" | "incomplete"; at: string; error?: string }
/** What a save reports. `lost`: the container was gone and nothing was saved since it last started. */
export interface SaveResult { size: number; key?: string; savedAt?: string; lost?: true }

/** The start of every error for a restore that did not complete; `CloudMachines` tells the owner about these. */
export const RESTORE_FAILED = "Saved state could not be restored";

export interface MachineStorage {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<unknown>;
  deleteAll(): Promise<unknown>;
}
export interface MachineContainer {
  running(): boolean;
  /** Starts the container and waits for its control port. */
  start(): Promise<void>;
  /** A request to the control port of the running container. It must not start a stopped container. */
  fetch(request: Request): Promise<Response>;
  /** Stops the container at once. */
  destroy(): Promise<void>;
}
/** The part of an R2 bucket this uses. */
export interface MachineBucket {
  get(key: string): Promise<{ body: unknown; size: number } | null>;
  head(key: string): Promise<{ size: number } | null>;
  put(key: string, value: Uint8Array, options?: { sha256?: string }): Promise<unknown>;
  delete(keys: string | string[]): Promise<unknown>;
  list(options: { prefix: string; cursor?: string }): Promise<{ objects: { key: string }[]; truncated: boolean; cursor?: string }>;
  createMultipartUpload(key: string): Promise<{
    uploadPart(partNumber: number, value: Uint8Array): Promise<{ partNumber: number; etag: string }>;
    complete(parts: { partNumber: number; etag: string }[]): Promise<{ size: number }>;
    abort(): Promise<unknown>;
  }>;
}
/** A running SHA-256 over the bytes of a save. */
export interface Digest { update(chunk: Uint8Array): void | Promise<void>; hex(): Promise<string> }

export interface MachineStateOptions {
  storage: MachineStorage;
  container: MachineContainer;
  bucket(): MachineBucket;
  now?(): number;
  /** Undefined when the runtime has no streaming digest; a save is then checked by size and upload receipts only. */
  digest?(): Digest | undefined;
  /** R2 needs every part but the last to be the same size, and at least 5 MB. */
  partBytes?: number;
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error)).slice(0, 200);

export class MachineState {
  private saving?: Promise<SaveResult>;
  constructor(private readonly options: MachineStateOptions) {}

  private iso(): string { return new Date((this.options.now ?? Date.now)()).toISOString(); }
  private folder(key: string): string { return key.slice(0, key.lastIndexOf("/") + 1); }

  /**
   * Starts the machine and T3 Code, restoring saved state first; returns Umpi's MCP token for this run. `place` is the
   * machine's first saved-state key: later saved states are new objects in the same folder. With `expect.saved`, a
   * machine with no saved state in storage does not start empty; it fails.
   */
  async wake(start: CloudMachineStart, place: string, expect: { saved?: boolean } = {}): Promise<{ token: string; restored: boolean }> {
    const { storage, container } = this.options;
    await storage.put("snapshotKey", place);
    if (container.running()) {
      // No record: the container was started before this record existed, when a start meant a complete restore.
      const home = await storage.get<HomeState>("home");
      // A home that is not the whole saved state must not run on. Stop it; this wake restores again.
      if (home && home.state !== "complete") await container.destroy();
    }
    const fresh = !container.running();
    const restored = fresh ? await this.startRestored(place, expect.saved === true) : false;
    try {
      const response = await container.fetch(new Request("http://machine/start", { method: "POST", body: JSON.stringify(start), headers: { "content-type": "application/json" } }));
      const body = await response.json() as { token?: string; error?: string };
      if (!response.ok || !body.token) throw new Error(body.error ?? `The machine did not start (${response.status})`);
      return { token: body.token, restored };
    } catch (error) {
      // Started by this wake, and nothing has run on it: stop it, so a machine that did not start does not stay on.
      if (fresh) await container.destroy().catch(() => undefined);
      throw error;
    }
  }

  private async startRestored(place: string, mustExist: boolean): Promise<boolean> {
    const { storage, container } = this.options;
    await storage.put("home", { state: "restoring", at: this.iso() } satisfies HomeState);
    let restored = false;
    try {
      await container.start();
      const saved = await this.current(place);
      if (saved) { await this.restore(saved); restored = true; }
      else if (mustExist) throw new Error(`${RESTORE_FAILED}: it is not in storage`);
    } catch (error) {
      await container.destroy().catch(() => undefined);
      await storage.put("home", { state: "incomplete", at: this.iso(), error: message(error) } satisfies HomeState);
      throw error;
    }
    await storage.put("home", { state: "complete", at: this.iso() } satisfies HomeState);
    await storage.put("runStartedAt", this.iso());
    return restored;
  }

  /** The current saved state: the one this object made current, or the object earlier code wrote at `place`. */
  private async current(place: string): Promise<SavedState | undefined> {
    const current = await this.options.storage.get<SavedState>("saved");
    if (current) return current;
    const first = await this.options.bucket().head(place);
    return first ? { key: place, size: first.size, parts: 0, savedAt: "" } : undefined;
  }

  /** Unpacks one saved state into the container, and checks that all of it arrived and unpacked. */
  private async restore(saved: SavedState): Promise<void> {
    try {
      const object = await this.options.bucket().get(saved.key);
      if (!object) throw new Error("it is not in storage");
      if (object.size !== saved.size) throw new Error(`storage holds ${object.size} bytes of ${saved.size}`);
      const response = await this.options.container.fetch(new Request("http://machine/restore", { method: "POST", body: object.body as ReadableStream, duplex: "half" } as RequestInit));
      const text = await response.text();
      if (!response.ok) throw new Error(text);
      // The control server reports how much it received; an image from before that report says nothing.
      let report: { bytes?: unknown } = {};
      try { report = JSON.parse(text) as { bytes?: unknown }; } catch { /* no report */ }
      if (typeof report.bytes === "number" && report.bytes !== saved.size) throw new Error(`the machine received ${report.bytes} bytes of ${saved.size}`);
    } catch (error) {
      throw new Error(`${RESTORE_FAILED}: ${message(error)}`);
    }
  }

  /** Packs the machine's home into R2 as a new saved state, makes it current, and stops the machine. One save at a time. */
  save(): Promise<SaveResult> {
    return this.saving ??= this.saveOnce().finally(() => { this.saving = undefined; });
  }

  private async saveOnce(): Promise<SaveResult> {
    const { storage, container } = this.options, bucket = this.options.bucket();
    const previous = await storage.get<SavedState>("saved");
    if (!container.running()) {
      // Stopped already. A save made since it last started stands; otherwise what ran since then is gone.
      const started = await storage.get<string>("runStartedAt");
      return previous && started && previous.savedAt >= started ? { size: previous.size, key: previous.key, savedAt: previous.savedAt } : { size: 0, lost: true };
    }
    const home = await storage.get<HomeState>("home");
    if (home && home.state !== "complete") throw new Error("Its saved state was not restored in full, so its home is not saved over it");
    const place = await storage.get<string>("snapshotKey");
    if (!place) throw new Error("This machine has no place to save to");
    const response = await container.fetch(new Request("http://machine/snapshot", { method: "POST" }));
    const size = Number(response.headers.get("content-length"));
    if (!response.ok || !response.body || !Number.isSafeInteger(size) || size <= 0) throw new Error(`The machine's state could not be packed (${response.status})`);
    const stamp = this.iso(), key = `${this.folder(place)}state-${stamp.replace(/[-:.]/g, "")}-${crypto.randomUUID().slice(0, 8)}.tar.zst`;
    const saved = await this.upload(key, response.body as ReadableStream<Uint8Array>, size, response.headers.get("x-umpi-sha256") ?? undefined, stamp);
    // R2's own record of the object must agree before it becomes the saved state.
    const stored = await bucket.head(key);
    if (!stored || stored.size !== size) {
      await bucket.delete(key).catch(() => undefined);
      throw new Error(`The saved state in storage is ${stored?.size ?? 0} bytes of ${size}`);
    }
    await storage.put("saved", saved);
    // The state is safe in R2: stop the container outright, so a sleeping machine never keeps running.
    await container.destroy();
    // Older saved states go only now. A failure here leaves an extra object, which the next save removes.
    await this.sweep(this.folder(place), key).catch(() => undefined);
    return { size, key, savedAt: saved.savedAt };
  }

  /**
   * Streams the packed state into R2 in equal parts, so any size fits in bounded memory; one object when it is small.
   * Checks the byte count against the announced size, and the SHA-256 against the machine's own when it sent one.
   */
  private async upload(key: string, body: ReadableStream<Uint8Array>, size: number, announced: string | undefined, savedAt: string): Promise<SavedState> {
    const PART = this.options.partBytes ?? 16 * 1024 * 1024, bucket = this.options.bucket();
    const reader = body.getReader(), digest = this.options.digest?.();
    const chunks: Uint8Array[] = [];
    let buffered = 0, total = 0;
    const take = (length: number): Uint8Array => {
      const out = new Uint8Array(length); let offset = 0;
      while (offset < length) {
        const chunk = chunks[0]!, room = length - offset;
        if (chunk.byteLength <= room) { out.set(chunk, offset); offset += chunk.byteLength; chunks.shift(); }
        else { out.set(chunk.subarray(0, room), offset); chunks[0] = chunk.subarray(room); offset += room; }
      }
      buffered -= length; return out;
    };
    let upload: Awaited<ReturnType<MachineBucket["createMultipartUpload"]>> | undefined;
    const parts: { partNumber: number; etag: string }[] = [];
    const send = async (length: number): Promise<void> => {
      upload ??= await bucket.createMultipartUpload(key);
      const part = await upload.uploadPart(parts.length + 1, take(length));
      if (!part.etag) throw new Error(`Storage gave no receipt for part ${parts.length + 1}`);
      parts.push({ partNumber: part.partNumber, etag: part.etag });
    };
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (value) { chunks.push(value); buffered += value.byteLength; total += value.byteLength; await digest?.update(value); }
        while (buffered >= PART) await send(PART);
        if (done) break;
      }
      if (total !== size) throw new Error(`The machine's state was cut short (${total} of ${size} bytes)`);
      const sha256 = digest ? await digest.hex() : undefined;
      if (sha256 && announced && sha256 !== announced.toLowerCase()) throw new Error("The machine's state changed on its way to storage");
      if (upload) {
        if (buffered > 0) await send(buffered);
        const object = await upload.complete(parts);
        if (object.size !== size) throw new Error(`Storage joined ${object.size} bytes of ${size}`);
      } else await bucket.put(key, take(buffered), sha256 ? { sha256 } : undefined);
      return { key, size, parts: Math.max(1, parts.length), savedAt, ...(sha256 ? { sha256 } : {}) };
    } catch (error) {
      await reader.cancel().catch(() => undefined);
      // An upload that is not completed leaves nothing; a completed one of the wrong size is removed.
      await upload?.abort().catch(() => undefined);
      await bucket.delete(key).catch(() => undefined);
      throw error;
    }
  }

  /** Deletes every object in the machine's folder except `keep`. */
  private async sweep(folder: string, keep?: string): Promise<void> {
    if (!folder) return;
    const bucket = this.options.bucket();
    let cursor: string | undefined;
    do {
      const page = await bucket.list({ prefix: folder, ...(cursor ? { cursor } : {}) });
      const keys = page.objects.map(object => object.key).filter(key => key !== keep);
      if (keys.length) await bucket.delete(keys);
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
  }

  /** Stops the machine without saving and deletes every saved state, before the machine is deleted. */
  async discard(): Promise<void> {
    const { storage, container } = this.options;
    if (container.running()) await container.destroy();
    const place = await storage.get<string>("snapshotKey");
    if (place) await this.sweep(this.folder(place));
    await storage.deleteAll();
  }

  /**
   * The safety net: nothing used or checked the machine for the container's `sleepAfter`. A complete home is saved.
   * A home that is not complete holds nothing to keep, so the machine stops and its saved state stays. When the save
   * fails, the machine keeps running with its work, and the caller runs this again after the next quiet period.
   */
  async expired(): Promise<"stopped" | "saved" | "discarded" | "kept"> {
    const { storage, container } = this.options;
    if (!container.running()) return "stopped";
    const home = await storage.get<HomeState>("home");
    if (home && home.state !== "complete") { await container.destroy(); return "discarded"; }
    try { await this.save(); return "saved"; }
    catch (error) { await storage.put("saveFailure", { at: this.iso(), error: message(error) }); return "kept"; }
  }

  /** For status: the current saved state, and whether the home is complete. */
  async report(): Promise<{ saved?: SavedState; home?: HomeState; saveFailure?: { at: string; error: string } }> {
    const { storage } = this.options;
    const [saved, home, saveFailure] = [await storage.get<SavedState>("saved"), await storage.get<HomeState>("home"), await storage.get<{ at: string; error: string }>("saveFailure")];
    return { ...(saved ? { saved } : {}), ...(home ? { home } : {}), ...(saveFailure ? { saveFailure } : {}) };
  }
}
