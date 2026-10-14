import type { R2Bucket } from "@cloudflare/workers-types";
import { MAX_CODING_ARCHIVE_BYTES, MAX_CODING_TIMEOUT_MS, parseCodingAssignment, type CodingAssignment } from "../shared/coding.js";
import { codingOperationPrefix, emptyCodingProgress, MAX_CODING_RPC_BYTES, MAX_CODING_RPC_OPERATIONS, parseCodingRpcRequest, parseCodingRpcState, type CodingRpcRequest, type CodingRpcState } from "../shared/coding-rpc.js";
import { codingSourceDigest } from "../shared/coding-source.js";
import { record } from "../shared/protocol.js";

export interface CodingCheckpoint { key: string; digest: string; bytes: number }
export interface CodingStopResult { stopped: boolean; uncertain: boolean }
export interface CodingCloudStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  list<T>(prefix: string): Promise<Map<string, T>>;
}
export interface CodingCloudOptions {
  storage: CodingCloudStorage;
  bucket: R2Bucket;
  startContainer(): Promise<void>;
  /** HTTP to an already-running container only. MUST NOT auto-start on loss. */
  request(path: string, init?: RequestInit): Promise<Response>;
  /** Resolve only after destruction or confirmed already-inactive state; never auto-start. */
  destroyContainer(): Promise<void>;
  scheduleDeadline(deadline: Date): Promise<void>;
}
interface Owner {
  assignment: CodingAssignment;
  sourceKey: string;
  sourceDigest: string;
  phase: "starting" | "running" | "frozen" | "stopping" | "stopped" | "uncertain";
  bootId?: string;
  uncertain: boolean;
  checkpoint?: CodingCheckpoint;
}
interface Operation { operationId: string; requestDigest: string; status: CodingRpcState["status"]; receipt?: CodingCheckpoint }
interface StopFence { stopped: boolean }

export class CodingCloudError extends Error {
  constructor(message: string, readonly status = 409) { super(message); this.name = "CodingCloudError"; }
}
function uncertainState(operationId: string): CodingRpcState {
  return { operationId, status: "uncertain", progress: emptyCodingProgress() };
}
async function bounded<T>(promise: Promise<T>, milliseconds = 20_000): Promise<T> {
  let rejectTimeout!: (error: Error) => void;
  const timeout = new Promise<never>((_, reject) => { rejectTimeout = reject; });
  const timer = setTimeout(() => rejectTimeout(new CodingCloudError("Coding container operation was not confirmed", 503)), milliseconds);
  try { return await Promise.race([promise, timeout]); }
  finally { clearTimeout(timer); }
}
/** Known-length consumption precedes the actual R2 PUT; no receipt is inferred from dispatch. */
export async function readCodingBody(body: { getReader(): { read(): Promise<{ done: boolean; value?: Uint8Array }>; cancel(): Promise<void> } } | null, length: number, maximum: number): Promise<Uint8Array<ArrayBuffer>> {
  if (!body || !Number.isSafeInteger(length) || length < 1 || length > maximum) throw new CodingCloudError("Invalid bounded coding payload", 413);
  const bytes = new Uint8Array(length), reader = body.getReader();
  let offset = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (!chunk.value || chunk.value.length > length - offset) throw new CodingCloudError("Coding payload exceeds its declared size", 413);
      bytes.set(chunk.value, offset); offset += chunk.value.length;
    }
    if (offset !== length) throw new CodingCloudError("Incomplete coding payload", 503);
    return bytes;
  } finally { await reader.cancel(); }
}
export async function persistCodingObject(bucket: R2Bucket, key: string, bytes: Uint8Array, contentType: string): Promise<CodingCheckpoint> {
  if (!(bytes.buffer instanceof ArrayBuffer)) throw new CodingCloudError("Coding retention requires an owned ArrayBuffer", 409);
  const digest = await codingSourceDigest(bytes);
  const receipt = await bucket.put(key, new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength), { sha256: digest, httpMetadata: { contentType }, customMetadata: { digest } });
  if (!receipt || receipt.key !== key || receipt.size !== bytes.length) throw new CodingCloudError("Coding archive did not return a matching R2 receipt", 503);
  return { key, digest, bytes: bytes.length };
}

/** Durable effect ownership, independent of the Cloudflare base class for consumer tests. */
export class CodingCloudRun {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly options: CodingCloudOptions) {}
  private serialize<T>(action: () => Promise<T>): Promise<T> {
    const result = this.queue.then(action, action);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }
  private async owner(): Promise<Owner> {
    const owner = await this.options.storage.get<Owner>("coding-owner");
    if (!owner) throw new CodingCloudError("Coding run has not been authorized");
    return owner;
  }
  private save(owner: Owner): Promise<void> { return this.options.storage.put("coding-owner", owner); }
  private operationKey(operationId: string): string { return `coding-operation:${operationId}`; }
  private headers(owner: Owner): Record<string, string> {
    return { "x-umpi-coding-task": owner.assignment.taskId, "x-umpi-coding-run": owner.assignment.runId, "x-umpi-coding-boot": owner.bootId ?? "" };
  }
  private async request(owner: Owner, path: string, init: RequestInit = {}): Promise<Response> {
    const response = await bounded(this.options.request(path, { ...init, headers: { ...this.headers(owner), ...init.headers }, signal: AbortSignal.timeout(20_000) }));
    if (!response.ok || response.headers.get("x-umpi-coding-boot") !== owner.bootId) {
      await response.body?.cancel();
      throw new CodingCloudError("Coding container ownership or operation is unconfirmed", 503);
    }
    return response;
  }
  private async json(response: Response, maximum = MAX_CODING_RPC_BYTES): Promise<unknown> {
    const bytes = await bounded(readCodingBody(response.body, Number(response.headers.get("content-length")), maximum));
    return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes));
  }
  private validateOperation(owner: Owner, operationId: string): void {
    if (typeof operationId !== "string" || !/^[A-Za-z0-9_.:-]{1,512}$/.test(operationId) || !operationId.startsWith(codingOperationPrefix(owner.assignment.taskId, owner.assignment.runId))) throw new CodingCloudError("Coding operation belongs to another run");
  }
  private async markUncertain(owner: Owner): Promise<void> {
    owner.uncertain = true;
    if (owner.phase !== "stopped") owner.phase = "uncertain";
    await this.save(owner);
  }
  private async confirmBoot(owner: Owner): Promise<void> {
    const ready = record(await this.json(await this.request(owner, "/ready"), 8192));
    if (ready.bootId !== owner.bootId || ready.initialized !== true || ready.taskId !== owner.assignment.taskId || ready.runId !== owner.assignment.runId || ready.uncertain !== false) throw new CodingCloudError("The approved coding process is no longer available");
  }
  activity(): Promise<void> {
    return this.serialize(async () => {
      const owner = await this.owner();
      if (owner.phase !== "running" || Date.now() >= Date.parse(owner.assignment.deadlineAt)) throw new CodingCloudError("Coding run is no longer active");
      try {
        await this.confirmBoot(owner);
        const response = await this.request(owner, "/activity");
        const receipt = record(await this.json(response, 8192));
        if (receipt.active !== true) throw new CodingCloudError("Coding activity was not confirmed");
      } catch (error) { await this.markUncertain(owner); throw error; }
    });
  }
  startRun(value: CodingAssignment, sourceKey: string): Promise<void> {
    return this.serialize(async () => {
      if (await this.options.storage.get<StopFence>("coding-stop-fence")) throw new CodingCloudError("Coding run cannot be restarted or replayed after stop");
      const assignment = parseCodingAssignment(value);
      const prefix = `coding/sources/${assignment.taskId}/`;
      const suffix = sourceKey.startsWith(prefix) ? sourceKey.slice(prefix.length) : "";
      const match = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}\/([a-f0-9]{64})\.gz$/.exec(suffix);
      if (!match) throw new CodingCloudError("Coding source is not owned by this task");
      const previous = await this.options.storage.get<Owner>("coding-owner");
      if (previous) {
        if (JSON.stringify(previous.assignment) !== JSON.stringify(assignment) || previous.sourceKey !== sourceKey) throw new CodingCloudError("Coding run ownership is immutable");
        if (previous.phase !== "running") throw new CodingCloudError("Coding run cannot be restarted or replayed");
        try { await this.confirmBoot(previous); } catch (error) { await this.markUncertain(previous); throw error; }
        return;
      }
      const remaining = Date.parse(assignment.deadlineAt) - Date.now();
      if (remaining <= 0 || remaining > MAX_CODING_TIMEOUT_MS) throw new CodingCloudError("Coding deadline is outside its approved bound");
      const source = await this.options.bucket.get(sourceKey);
      if (!source || source.customMetadata?.cwd !== assignment.cwd || source.customMetadata.digest !== match[1]) throw new CodingCloudError("Coding source approval does not match the workspace");
      const bytes = await readCodingBody(source.body, source.size, MAX_CODING_ARCHIVE_BYTES);
      if (await codingSourceDigest(bytes) !== match[1]) throw new CodingCloudError("Coding source digest does not match its approval");
      const owner: Owner = { assignment, sourceKey, sourceDigest: match[1]!, phase: "starting", uncertain: false };
      // Durable intent and hard-deadline alarm precede the first container start.
      await this.save(owner);
      try {
        await this.options.scheduleDeadline(new Date(assignment.deadlineAt));
        await bounded(this.options.startContainer(), 60_000);
        const readyResponse = await bounded(this.options.request("/ready", { signal: AbortSignal.timeout(20_000) }));
        if (!readyResponse.ok) throw new CodingCloudError("Coding container did not become ready", 503);
        const ready = record(await this.json(readyResponse, 8192));
        if (typeof ready.bootId !== "string" || !/^[a-f0-9-]{36}$/.test(ready.bootId) || ready.initialized !== false || ready.uncertain !== false) throw new CodingCloudError("Coding container is not fresh");
        owner.bootId = ready.bootId;
        await this.save(owner);
        const response = await this.request(owner, "/start", { method: "POST", headers: {
          "content-type": "application/gzip", "content-length": String(bytes.length),
          "x-umpi-coding-assignment": btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(assignment)))),
          "x-umpi-coding-source-digest": owner.sourceDigest,
        }, body: bytes });
        await response.body?.cancel();
        await this.confirmBoot(owner);
        owner.phase = "running";
        await this.save(owner);
      } catch (error) {
        await this.markUncertain(owner);
        await bounded(this.options.destroyContainer()).catch(() => {});
        throw error;
      } finally { bytes.fill(0); }
    });
  }
  invoke(value: CodingRpcRequest): Promise<CodingRpcState> {
    return this.serialize(async () => {
      const owner = await this.owner(), request = parseCodingRpcRequest(value);
      this.validateOperation(owner, request.operationId);
      const requestBytes = new TextEncoder().encode(JSON.stringify(request));
      const requestDigest = await codingSourceDigest(requestBytes);
      const existing = await this.options.storage.get<Operation>(this.operationKey(request.operationId));
      if (existing) {
        if (existing.requestDigest !== requestDigest) throw new CodingCloudError("Coding operation identity was reused with different arguments");
        return this.inspectOwned(owner, existing);
      }
      if (owner.phase !== "running" || owner.uncertain || Date.now() >= Date.parse(owner.assignment.deadlineAt)) throw new CodingCloudError("Coding run no longer admits operations");
      if ((await this.options.storage.list<Operation>("coding-operation:")).size >= MAX_CODING_RPC_OPERATIONS) throw new CodingCloudError("Coding run operation limit reached", 413);
      const operation: Operation = { operationId: request.operationId, requestDigest, status: "running" };
      // A crash after this write must inspect, never redispatch, even if no request reached Node.
      await this.options.storage.put(this.operationKey(request.operationId), operation);
      try {
        await this.confirmBoot(owner);
        const response = await this.request(owner, "/rpc", { method: "POST", headers: { "content-type": "application/json" }, body: requestBytes });
        return await this.retainState(owner, operation, parseCodingRpcState(await this.json(response)));
      } catch {
        await this.markUncertain(owner);
        return this.retainState(owner, operation, uncertainState(request.operationId));
      }
    });
  }
  private async retainState(owner: Owner, operation: Operation, state: CodingRpcState): Promise<CodingRpcState> {
    if (state.operationId !== operation.operationId) throw new CodingCloudError("Coding operation response identity mismatch");
    const bytes = new TextEncoder().encode(JSON.stringify(state));
    const digest = await codingSourceDigest(bytes), identity = await codingSourceDigest(new TextEncoder().encode(operation.operationId));
    const key = `coding/runs/${owner.assignment.taskId}/${owner.assignment.runId}/operations/${identity}/${digest}.json`;
    operation.receipt = await bounded(persistCodingObject(this.options.bucket, key, bytes, "application/json"));
    operation.status = state.status;
    await this.options.storage.put(this.operationKey(operation.operationId), operation);
    if (state.status === "uncertain") await this.markUncertain(owner);
    return state;
  }
  private async storedState(operation: Operation): Promise<CodingRpcState | undefined> {
    if (!operation.receipt) return undefined;
    const object = await this.options.bucket.get(operation.receipt.key);
    if (!object) throw new CodingCloudError("Retained coding output is unavailable", 503);
    const bytes = await readCodingBody(object.body, object.size, MAX_CODING_RPC_BYTES);
    if (await codingSourceDigest(bytes) !== operation.receipt.digest) throw new CodingCloudError("Retained coding output digest mismatch", 503);
    const state = parseCodingRpcState(JSON.parse(new TextDecoder().decode(bytes)));
    if (state.operationId !== operation.operationId) throw new CodingCloudError("Retained coding output identity mismatch", 503);
    return state;
  }
  private async inspectOwned(owner: Owner, operation: Operation): Promise<CodingRpcState> {
    if (operation.status !== "running") return await this.storedState(operation) ?? uncertainState(operation.operationId);
    try {
      if (owner.phase === "stopped" || owner.phase === "uncertain") throw new CodingCloudError("Coding process was lost");
      await this.confirmBoot(owner);
      const response = await this.request(owner, `/operations/${encodeURIComponent(operation.operationId)}`);
      return await this.retainState(owner, operation, parseCodingRpcState(await this.json(response)));
    } catch {
      await this.markUncertain(owner);
      const previous = await this.storedState(operation);
      return this.retainState(owner, operation, { ...uncertainState(operation.operationId), progress: previous?.progress ?? emptyCodingProgress() });
    }
  }
  inspect(operationId: string): Promise<CodingRpcState> {
    return this.serialize(async () => {
      const owner = await this.owner(); this.validateOperation(owner, operationId);
      const operation = await this.options.storage.get<Operation>(this.operationKey(operationId));
      if (!operation) throw new CodingCloudError("Unknown coding operation", 404);
      return this.inspectOwned(owner, operation);
    });
  }
  cancel(operationId?: string): Promise<void> {
    return this.serialize(async () => {
      const owner = await this.owner();
      if (operationId !== undefined) {
        this.validateOperation(owner, operationId);
      }
      if (owner.phase === "stopped") return;
      try {
        await this.confirmBoot(owner);
        const response = await this.request(owner, "/cancel", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(operationId === undefined ? {} : { operationId }) });
        await response.body?.cancel();
        if (operationId === undefined) { owner.phase = "frozen"; await this.save(owner); }
      } catch (error) { await this.markUncertain(owner); throw error; }
    });
  }
  private async checkpointOwned(owner: Owner): Promise<CodingCheckpoint> {
    if (owner.checkpoint) return owner.checkpoint;
    if (owner.phase === "stopped" || owner.phase === "uncertain") throw new CodingCloudError("Lost coding scratch cannot be reconstructed automatically");
    await this.confirmBoot(owner);
    const closed = await this.request(owner, "/cancel", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    await closed.body?.cancel();
    owner.phase = "frozen"; await this.save(owner);
    for (const operation of (await this.options.storage.list<Operation>("coding-operation:")).values()) {
      if (operation.status === "running") await this.inspectOwned(owner, operation);
      if (owner.uncertain) break;
    }
    if (owner.uncertain) throw new CodingCloudError("Coding work did not settle before checkpoint");
    const response = await this.request(owner, "/snapshot");
    const bytes = await bounded(readCodingBody(response.body, Number(response.headers.get("content-length")), MAX_CODING_ARCHIVE_BYTES));
    const digest = await codingSourceDigest(bytes);
    const key = `coding/runs/${owner.assignment.taskId}/${owner.assignment.runId}/checkpoints/${digest}.gz`;
    owner.checkpoint = await bounded(persistCodingObject(this.options.bucket, key, bytes, "application/gzip"));
    await this.save(owner);
    return owner.checkpoint;
  }
  checkpoint(): Promise<CodingCheckpoint> { return this.serialize(async () => this.checkpointOwned(await this.owner())); }
  stopRun(): Promise<CodingStopResult> {
    return this.serialize(async () => {
      const fence = await this.options.storage.get<StopFence>("coding-stop-fence");
      const owner = await this.options.storage.get<Owner>("coding-owner");
      if (fence?.stopped) return { stopped: true, uncertain: owner?.uncertain ?? false };
      // Fence even rejected admission: absence of an owner proves no start intent,
      // but only confirmed destruction proves the actor is safe to release.
      await this.options.storage.put<StopFence>("coding-stop-fence", { stopped: false });
      if (owner?.phase === "stopped") {
        await this.options.storage.put<StopFence>("coding-stop-fence", { stopped: true });
        return { stopped: true, uncertain: owner.uncertain };
      }
      if (owner) {
        try { await this.checkpointOwned(owner); }
        catch { owner.uncertain = true; }
        owner.phase = "stopping"; await this.save(owner);
      }
      try {
        await bounded(this.options.destroyContainer());
        if (owner) { owner.phase = "stopped"; await this.save(owner); }
        await this.options.storage.put<StopFence>("coding-stop-fence", { stopped: true });
        return { stopped: true, uncertain: owner?.uncertain ?? false };
      } catch {
        if (owner) await this.markUncertain(owner);
        return { stopped: false, uncertain: true };
      }
    });
  }
  /** Container process disappearance is evidence of loss, never permission to replay. */
  lost(): Promise<void> {
    return this.serialize(async () => {
      const owner = await this.options.storage.get<Owner>("coding-owner");
      if (owner && owner.phase !== "stopped" && owner.phase !== "stopping") await this.markUncertain(owner);
    });
  }
}
