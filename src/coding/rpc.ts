import { closeSync, constants, existsSync, lstatSync, mkdirSync, openSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { FileError, ExecutionError, StreamDecoder, err, ok, type BinaryReader, type DirReader, type FileWatcher, type Result, type ShellExecOptions, type TextLine, type TextLineReader, type WatchChange, type WatchTarget } from "@earendil-works/pi-durable/env";
import { parseCodingAssignment, type CodingAssignment } from "../shared/coding.js";
import { inspectCodingSnapshot } from "../shared/coding-source.js";
import { codingOperationPrefix, decodeCodingValue, emptyCodingProgress, encodeCodingValue, MAX_CODING_OUTPUT_BYTES, MAX_CODING_RPC_BYTES, MAX_CODING_RPC_DATA_BYTES, MAX_CODING_RPC_OPERATIONS, MAX_CODING_WINDOW_BYTES, parseCodingRpcRequest, parseCodingRpcState, type CodingRpcError, type CodingRpcHandle, type CodingRpcRequest, type CodingRpcState, type CodingWatchEvent, type CodingWatchPage } from "../shared/coding-rpc.js";
import { captureCodingSnapshot, compareCodingSnapshots } from "./workspace.js";
import { executeCodingShell } from "./shell.js";

const MAX_HANDLES = 64;
const MAX_JOURNAL_BYTES = 128 * 1024 * 1024;
const MAX_SESSION_OUTPUT_BYTES = 64 * 1024 * 1024;
interface StoredOperation { request: string; state: string }
interface ActiveOperation { controller: AbortController; completion: Promise<void>; state: CodingRpcState; outputBytes: number; sequence: number; storedStateBytes: number }
interface HandleEntry {
  description: CodingRpcHandle;
  resource: BinaryReader | TextLineReader | DirReader | FileWatcher;
  tail: Promise<void>;
  watchEvents: CodingWatchEvent[];
  watchSequence: number;
  watchBytes: number;
  watchClosed: boolean;
}
export interface CodingNodeSessionOptions {
  assignment: CodingAssignment;
  stateDirectory: string;
  /** Exact approved private-copy/cloud archive, validated against actual restored file bytes and modes. */
  baselineArchive?: Uint8Array;
}

/** Bounded LF cursor over one real opened file; no path-based reopening or unbounded readline buffer. */
class BoundedTextReader implements TextLineReader {
  private readonly decoder = new StreamDecoder();
  private offset = 0;
  private buffered = "";
  private ended = false;
  private closed = false;
  constructor(private readonly reader: BinaryReader) {}

  async readLine(context: Context): Promise<Result<TextLine | undefined, FileError>> {
    if (this.closed) return err(new FileError("invalid", "Text reader is closed"));
    while (true) {
      if (context.abortSignal?.aborted) return err(new FileError("aborted", "Text read aborted"));
      const newline = this.buffered.indexOf("\n");
      if (newline !== -1) {
        const text = this.buffered.slice(0, newline);
        this.buffered = this.buffered.slice(newline + 1);
        return ok({ text, terminated: true });
      }
      if (this.ended) {
        if (!this.buffered) return ok(undefined);
        const text = this.buffered;
        this.buffered = "";
        return ok({ text, terminated: false });
      }
      const data = await this.reader.read(this.offset, 64 * 1024, context);
      if (!data.ok) return data;
      if (context.abortSignal?.aborted) return err(new FileError("aborted", "Text read aborted"));
      this.offset += data.value.length;
      this.buffered += this.decoder.decode(data.value.length ? data.value : undefined);
      this.ended = data.value.length === 0;
      if (Buffer.byteLength(this.buffered) > MAX_CODING_RPC_DATA_BYTES) {
        await this.close(BACKGROUND_CONTEXT);
        return err(new FileError("invalid", "Text line exceeds the bounded transfer allowance"));
      }
    }
  }

  async close(context: Context): Promise<void> {
    this.closed = true;
    this.buffered = "";
    await this.reader.close(context);
  }
}

async function settlesWithin(work: Promise<unknown>, milliseconds: number): Promise<boolean> {
  const { promise, resolve } = Promise.withResolvers<boolean>();
  const timer = setTimeout(() => resolve(false), milliseconds);
  try { return await Promise.race([work.then(() => true), promise]); }
  finally { clearTimeout(timer); }
}

function privateDirectory(path: string): string {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 || (process.getuid && info.uid !== process.getuid())) throw new Error("Coding state directory must be private and owned by this user");
  return realpathSync(path);
}
function privateFile(path: string): void {
  const descriptor = openSync(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  closeSync(descriptor);
  const info = lstatSync(path);
  if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o077) !== 0 || (process.getuid && info.uid !== process.getuid())) throw new Error("Coding journal must be a private owned regular file");
}
function wireError(error: unknown): CodingRpcError {
  const source = error instanceof Error ? error : new Error("Coding operation failed");
  const result: CodingRpcError = { name: source instanceof FileError ? "FileError" : source instanceof ExecutionError ? "ExecutionError" : "Error", code: source instanceof FileError || source instanceof ExecutionError ? source.code : "unknown", message: source.message.slice(0, 4096) };
  if (source instanceof FileError && source.path !== undefined) result.path = source.path.slice(0, 4096);
  if (source instanceof ExecutionError && source.spillPath !== undefined) result.spillPath = source.spillPath.slice(0, 4096);
  return result;
}
function interrupted(state: CodingRpcState): CodingRpcState {
  return { ...state, status: "uncertain", result: { ok: false, error: { name: "Error", code: "uncertain", message: "Executor stopped after durable admission; the operation may have performed effects and will not be repeated" } } };
}

/** Read without starting processes, reopening handles, admitting work, or changing a receipt. */
export function readCodingNodeStates(stateDirectory: string): CodingRpcState[] {
  const file = join(stateDirectory, "coding.sqlite");
  if (!existsSync(file)) return [];
  const info = lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) throw new Error("Unsafe coding journal");
  const database = new DatabaseSync(file, { readOnly: true });
  try {
    return (database.prepare("SELECT state FROM operations ORDER BY rowid").all() as { state: string }[]).map(row => {
      const state = parseCodingRpcState(JSON.parse(row.state));
      return state.status === "running" ? interrupted(state) : state;
    });
  } finally { database.close(); }
}

/** One immutable grant, one private durable journal, and live handles that never reopen by pathname. */
export class CodingNodeSession {
  readonly assignment: CodingAssignment;
  private readonly directory: string;
  private readonly database: DatabaseSync;
  private readonly lock: DatabaseSync;
  private readonly env: NodeExecutionEnv;
  private readonly active = new Map<string, ActiveOperation>();
  private readonly handles = new Map<string, HandleEntry>();
  private readonly temporary = new Set<string>();
  private deadlineTimer?: NodeJS.Timeout;
  private stopped = false;
  private closed = false;
  private closing?: Promise<void>;
  private uncertainValue = false;
  private outputBytes = 0;
  private storedBytes = 0;
  private count = 0;
  private readonly baseline: Uint8Array;

  private constructor(options: CodingNodeSessionOptions, directory: string, database: DatabaseSync, lock: DatabaseSync, baseline: Uint8Array) {
    this.assignment = Object.freeze({ ...options.assignment });
    this.directory = directory;
    this.database = database;
    this.lock = lock;
    this.baseline = baseline;
    this.env = new NodeExecutionEnv({ cwd: options.assignment.cwd });
    const rows = this.database.prepare("SELECT request, state FROM operations").iterate() as Iterable<StoredOperation>;
    for (const row of rows) {
      this.count++;
      let state = parseCodingRpcState(JSON.parse(row.state));
      if (state.status === "running") {
        state = parseCodingRpcState(interrupted(state));
        this.database.prepare("UPDATE operations SET state = ? WHERE operation_id = ?").run(JSON.stringify(state), state.operationId);
      }
      if (state.status === "uncertain") this.uncertainValue = true;
      this.storedBytes += Buffer.byteLength(row.request) + Buffer.byteLength(JSON.stringify(state));
    }
    this.uncertainValue ||= this.database.prepare("SELECT 1 FROM meta WHERE key = 'uncertain'").get() !== undefined;
    this.stopped = this.uncertainValue || this.database.prepare("SELECT 1 FROM meta WHERE key = 'stopped'").get() !== undefined;
    this.deadlineTimer = setTimeout(() => { void this.cancel().catch(() => { this.uncertainValue = true; }); }, Math.max(0, Date.parse(this.assignment.deadlineAt) - Date.now()));
    this.deadlineTimer.unref?.();
  }

  static async open(input: CodingNodeSessionOptions): Promise<CodingNodeSession> {
    const assignment = parseCodingAssignment(input.assignment);
    if (realpathSync(assignment.cwd) !== assignment.cwd) throw new Error("Coding cwd must be canonical");
    const directory = privateDirectory(input.stateDirectory);
    if (directory === assignment.cwd || directory.startsWith(`${assignment.cwd}/`)) throw new Error("Private coding state must be outside the source workspace");
    privateFile(join(directory, "coding-lock.sqlite"));
    privateFile(join(directory, "coding.sqlite"));
    const lock = new DatabaseSync(join(directory, "coding-lock.sqlite"));
    let database: DatabaseSync | undefined;
    try {
      lock.exec("PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE");
      database = new DatabaseSync(join(directory, "coding.sqlite"));
      database.exec("PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL; CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value BLOB NOT NULL); CREATE TABLE IF NOT EXISTS operations (operation_id TEXT PRIMARY KEY, request TEXT NOT NULL, state TEXT NOT NULL)");
      const owner = database.prepare("SELECT value FROM meta WHERE key = 'assignment'").get() as { value: string } | undefined;
      if (owner && owner.value !== JSON.stringify(assignment)) throw new Error("Coding journal belongs to another immutable assignment");
      if (owner && !database.prepare("SELECT 1 FROM meta WHERE key = 'stopped'").get()) {
        database.prepare("INSERT OR REPLACE INTO meta VALUES ('uncertain', '1')").run();
      }
      database.prepare("INSERT OR IGNORE INTO meta VALUES ('assignment', ?)").run(JSON.stringify(assignment));
      let baseline = database.prepare("SELECT value FROM meta WHERE key = 'baseline'").get() as { value: Uint8Array } | undefined;
      if (baseline && input.baselineArchive && !Buffer.from(baseline.value).equals(input.baselineArchive)) throw new Error("Coding baseline cannot change for an existing run");
      if (!baseline) {
        if (database.prepare("SELECT 1 FROM operations LIMIT 1").get()) throw new Error("Coding baseline is missing from an existing run");
        if (Date.now() >= Date.parse(assignment.deadlineAt)) throw new Error("Coding deadline has elapsed before baseline capture");
        const captured = await captureCodingSnapshot(assignment.cwd);
        let bytes = captured.bytes;
        if (input.baselineArchive) {
          const approved = (await inspectCodingSnapshot(input.baselineArchive)).manifest;
          const actual = new Map(captured.manifest.files.map(file => [file.path, file]));
          if (actual.size !== approved.files.length || approved.files.some(file => {
            const present = actual.get(file.path);
            return !present || present.mode !== file.mode || present.bytes !== file.bytes || present.digest !== file.digest;
          })) throw new Error("Approved coding baseline does not match the actual workspace");
          bytes = input.baselineArchive;
        }
        database.prepare("INSERT INTO meta VALUES ('baseline', ?)").run(bytes);
        baseline = { value: bytes };
      }
      return new CodingNodeSession({ assignment, stateDirectory: directory }, directory, database, lock, baseline.value);
    } catch (error) { database?.close(); lock.close(); throw error; }
  }

  get uncertain(): boolean { return this.uncertainValue; }

  state(operationId: string): CodingRpcState | undefined {
    this.assertIdentity(operationId);
    const live = this.active.get(operationId)?.state;
    if (live) return structuredClone(live);
    if (this.closed) {
      const database = new DatabaseSync(join(this.directory, "coding.sqlite"), { readOnly: true });
      try {
        const row = database.prepare("SELECT state FROM operations WHERE operation_id = ?").get(operationId) as { state: string } | undefined;
        if (!row) return undefined;
        const state = parseCodingRpcState(JSON.parse(row.state));
        return state.status === "running" ? interrupted(state) : state;
      } finally { database.close(); }
    }
    const row = this.database.prepare("SELECT state FROM operations WHERE operation_id = ?").get(operationId) as { state: string } | undefined;
    return row ? parseCodingRpcState(JSON.parse(row.state)) : undefined;
  }

  states(): CodingRpcState[] {
    if (this.closed) return readCodingNodeStates(this.directory);
    return (this.database.prepare("SELECT state FROM operations ORDER BY rowid").all() as { state: string }[]).map(row => {
      const state = parseCodingRpcState(JSON.parse(row.state));
      return structuredClone(this.active.get(state.operationId)?.state ?? state);
    });
  }

  /** Validate an exact replay without admitting work or changing its stored receipt. */
  assertRequest(input: CodingRpcRequest): void {
    const request = parseCodingRpcRequest(input);
    this.assertIdentity(request.operationId);
    if (this.closed) throw new Error("Coding session is closed");
    const existing = this.database.prepare("SELECT request FROM operations WHERE operation_id = ?").get(request.operationId) as { request: string } | undefined;
    if (existing && existing.request !== JSON.stringify(request)) throw new Error("An operation identity cannot be reused for different arguments");
  }

  async submit(input: CodingRpcRequest): Promise<void> {
    const request = parseCodingRpcRequest(input);
    this.assertIdentity(request.operationId);
    if (this.closed) throw new Error("Coding session is closed");
    const encoded = JSON.stringify(request);
    const existing = this.database.prepare("SELECT request FROM operations WHERE operation_id = ?").get(request.operationId) as { request: string } | undefined;
    if (existing) {
      if (existing.request !== encoded) throw new Error("An operation identity cannot be reused for different arguments");
      return;
    }
    if (this.stopped || this.uncertain || Date.now() >= Date.parse(this.assignment.deadlineAt)) throw new Error("Coding run is stopped, expired, or uncertain");
    if (this.count >= MAX_CODING_RPC_OPERATIONS || this.active.size >= 8 || this.storedBytes + Buffer.byteLength(encoded) + (this.active.size + 1) * MAX_CODING_RPC_BYTES > MAX_JOURNAL_BYTES) {
      this.storeNeverAdmitted(request, encoded, "invalid", "Operation was not admitted: the bounded active-operation or journal allowance is exhausted");
      return;
    }
    const state = parseCodingRpcState({ operationId: request.operationId, status: "running", progress: emptyCodingProgress() });
    const receipt = JSON.stringify(state);
    // FULL synchronous admission is committed before any filesystem or shell effect starts.
    this.database.prepare("INSERT INTO operations VALUES (?, ?, ?)").run(request.operationId, encoded, receipt);
    this.count++;
    this.storedBytes += Buffer.byteLength(encoded) + Buffer.byteLength(receipt);
    const operation: ActiveOperation = { controller: new AbortController(), completion: Promise.resolve(), state, outputBytes: 0, sequence: 0, storedStateBytes: Buffer.byteLength(receipt) };
    this.active.set(request.operationId, operation);
    operation.completion = this.execute(request, operation);
  }

  /** Reconcile a dispatched request that was cancelled before this executor received it. */
  async cancelRequest(input: CodingRpcRequest): Promise<void> {
    const request = parseCodingRpcRequest(input);
    this.assertIdentity(request.operationId);
    if (this.closed) throw new Error("Coding session is closed");
    const encoded = JSON.stringify(request);
    const existing = this.database.prepare("SELECT request FROM operations WHERE operation_id = ?").get(request.operationId) as { request: string } | undefined;
    if (existing) {
      if (existing.request !== encoded) throw new Error("An operation identity cannot be reused for different arguments");
      await this.cancel(request.operationId);
      return;
    }
    this.storeNeverAdmitted(request, encoded, "aborted", "Operation cancelled before admission; no operation effects were started");
  }

  private storeNeverAdmitted(request: CodingRpcRequest, encoded: string, code: string, message: string): void {
    const state = parseCodingRpcState({ operationId: request.operationId, status: "done", progress: emptyCodingProgress(), result: { ok: false, error: { name: request.method === "exec" ? "ExecutionError" : "FileError", code, message } } });
    const receipt = JSON.stringify(state);
    const bytes = Buffer.byteLength(encoded) + Buffer.byteLength(receipt);
    // Active operations retain their reserved full receipts even when an admission is refused.
    if (this.storedBytes + bytes + this.active.size * MAX_CODING_RPC_BYTES > MAX_JOURNAL_BYTES) throw new Error("Coding journal cannot durably record another refusal");
    this.database.prepare("INSERT INTO operations VALUES (?, ?, ?)").run(request.operationId, encoded, receipt);
    this.count++;
    this.storedBytes += bytes;
  }

  async cancel(operationId?: string): Promise<void> {
    if (operationId !== undefined) this.assertIdentity(operationId);
    else {
      this.stopped = true;
      if (!this.closed) this.database.prepare("INSERT OR IGNORE INTO meta VALUES ('stopped', '1')").run();
      clearTimeout(this.deadlineTimer);
    }
    const selected = operationId === undefined ? [...this.active.values()] : [this.active.get(operationId)].filter((value): value is ActiveOperation => value !== undefined);
    for (const operation of selected) operation.controller.abort();
    const finished = await settlesWithin(Promise.allSettled(selected.map(operation => operation.completion)), 2000);
    if (!finished) {
      for (const operation of selected) if (operation.state.status === "running") this.markUncertain(operation);
    }
    if (operationId === undefined) {
      const closed = await settlesWithin(this.closeHandles(), 1000);
      if (!closed) {
        this.uncertainValue = true;
        if (!this.closed) this.database.prepare("INSERT OR REPLACE INTO meta VALUES ('uncertain', '1')").run();
      }
      if (!this.uncertain) for (const path of this.temporary) rmSync(path, { recursive: true, force: true });
      this.temporary.clear();
    }
  }

  async close(): Promise<void> {
    this.closing ??= (async () => {
      try { await this.cancel(); }
      catch {
        this.uncertainValue = true;
        try { this.database.prepare("INSERT OR REPLACE INTO meta VALUES ('uncertain', '1')").run(); }
        catch { /* A broken journal retains start intent rather than inventing successful cleanup. */ }
      } finally {
        this.closed = true;
        try { this.database.close(); } finally { this.lock.close(); }
      }
    })();
    return this.closing;
  }

  /** Available after close: callers freeze the run before taking its terminal checkpoint. */
  async snapshot(): Promise<Uint8Array> {
    if (this.uncertain) throw new Error("Cannot certify a checkpoint while prior effects are uncertain");
    if ([...this.active.values()].some(operation => operation.state.status === "running")) throw new Error("Freeze active coding operations before taking a checkpoint");
    return (await captureCodingSnapshot(this.assignment.cwd)).bytes;
  }

  private assertIdentity(operationId: string): void {
    if (!operationId.startsWith(codingOperationPrefix(this.assignment.taskId, this.assignment.runId))) throw new Error("Coding operation does not belong to this task/run");
  }

  private markUncertain(operation: ActiveOperation): void {
    this.uncertainValue = true;
    this.stopped = true;
    operation.state = parseCodingRpcState(interrupted(operation.state));
    try {
      const receipt = JSON.stringify(operation.state);
      if (!this.closed) this.database.prepare("UPDATE operations SET state = ? WHERE operation_id = ?").run(receipt, operation.state.operationId);
      this.storedBytes += Buffer.byteLength(receipt) - operation.storedStateBytes;
      operation.storedStateBytes = Buffer.byteLength(receipt);
    } finally {
      for (const active of this.active.values()) active.controller.abort();
    }
  }

  private async execute(request: CodingRpcRequest, operation: ActiveOperation): Promise<void> {
    try {
      const context = withAbortSignal(operation.controller.signal, BACKGROUND_CONTEXT);
      const result = await this.dispatch(request, operation, context);
      if (operation.state.status !== "running") return;
      if (operation.controller.signal.aborted && result.ok) throw request.method === "exec" ? new ExecutionError("aborted", "Command was interrupted; effects are not rolled back") : new FileError("aborted", "Operation was interrupted; effects are not rolled back");
      operation.state.result = result.ok ? { ok: true, value: encodeCodingValue(result.value) } : { ok: false, error: wireError(result.error) };
    } catch (error) {
      if (operation.state.status !== "running") return;
      operation.state.result = { ok: false, error: wireError(error) };
    } finally {
      if (operation.state.status === "running") {
        operation.state.status = "done";
        try {
          operation.state = parseCodingRpcState(operation.state);
        } catch {
          // The actual operation has finished; never truncate its value and claim success.
          operation.state.result = { ok: false, error: { name: request.method === "exec" ? "ExecutionError" : "FileError", code: "invalid", message: "Operation completed, but its full result cannot be represented within the bounded RPC receipt; effects are not rolled back" } };
          operation.state = parseCodingRpcState(operation.state);
        }
        const receipt = JSON.stringify(operation.state);
        try {
          if (!this.closed) this.database.prepare("UPDATE operations SET state = ? WHERE operation_id = ?").run(receipt, request.operationId);
          this.storedBytes += Buffer.byteLength(receipt) - operation.storedStateBytes;
          operation.storedStateBytes = Buffer.byteLength(receipt);
        } catch {
          this.uncertainValue = true;
          this.stopped = true;
          operation.state = interrupted(operation.state);
          for (const active of this.active.values()) active.controller.abort();
        }
      }
      // Keep a failed durable write visible in memory; no successful receipt is published for it.
      if (operation.state.status !== "uncertain") this.active.delete(request.operationId);
    }
  }

  private async handle(resource: HandleEntry["resource"], kind: CodingRpcHandle["kind"]): Promise<CodingRpcHandle> {
    if (this.handles.size >= MAX_HANDLES || this.stopped) {
      await resource.close(BACKGROUND_CONTEXT);
      throw new FileError("invalid", "Coding handle allowance exhausted or run stopped");
    }
    const description: CodingRpcHandle = { handleId: `${codingOperationPrefix(this.assignment.taskId, this.assignment.runId)}${randomUUID()}`, kind, ...(kind === "watch" ? { mode: (resource as FileWatcher).mode } : {}) };
    this.handles.set(description.handleId, { description, resource, tail: Promise.resolve(), watchEvents: [], watchSequence: 0, watchBytes: 0, watchClosed: false });
    return description;
  }

  private async withHandle<T>(id: string, kind: CodingRpcHandle["kind"] | undefined, use: (handle: HandleEntry) => Promise<T>): Promise<T> {
    const handle = this.handles.get(id);
    if (!handle || (kind !== undefined && handle.description.kind !== kind)) throw new FileError("invalid", "Handle is closed, lost after restart, or belongs to another run");
    const result = handle.tail.then(() => use(handle));
    handle.tail = result.then(() => undefined, () => undefined);
    return result;
  }

  private async closeHandles(): Promise<void> {
    await Promise.all([...this.handles.values()].map(async handle => {
      handle.watchClosed = true;
      await handle.tail;
      await handle.resource.close(BACKGROUND_CONTEXT);
      this.handles.delete(handle.description.handleId);
    }));
  }

  private temporaryPath(prefix = "tmp-", suffix = ""): string {
    if (this.temporary.size >= 128 || /[\/\\\0]/.test(prefix + suffix)) throw new FileError("invalid", "Invalid or excessive temporary paths");
    const path = join(this.directory, `${prefix}${randomUUID()}${suffix}`);
    this.temporary.add(path);
    return path;
  }

  private output(operation: ActiveOperation, text: string, stream: "stdout" | "stderr", window: ShellExecOptions["window"]): void {
    // Split only at code-point boundaries; retention always exceeds an admitted caller's byte window.
    for (let offset = 0; offset < text.length;) {
      let end = Math.min(text.length, offset + 8192);
      if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]!)) end--;
      const part = text.slice(offset, end);
      offset = end;
      const bytes = Buffer.byteLength(part);
      if (!window && (operation.outputBytes + bytes > MAX_CODING_OUTPUT_BYTES || operation.state.progress.output.length >= 1024)) throw new Error("Lossless shell output exceeds the transport allowance; use an output window");
      if (window && operation.state.progress.output.length >= 1024 && operation.outputBytes + bytes - Buffer.byteLength(operation.state.progress.output[0]!.text) <= window.maxBytes) throw new Error("Output fragmentation exceeds the bounded transport allowance");
      operation.state.progress.output.push({ sequence: ++operation.sequence, text: part, stream });
      operation.outputBytes += bytes;
      while (operation.outputBytes > MAX_CODING_OUTPUT_BYTES || operation.state.progress.output.length > 1024) {
        const removed = operation.state.progress.output.shift()!;
        const count = Buffer.byteLength(removed.text);
        operation.outputBytes -= count;
        const omitted = operation.state.progress.omitted;
        omitted.bytes += count;
        omitted.newlines += removed.text.split("\n").length - 1;
        omitted.endsWithNewline = removed.text.endsWith("\n");
      }
    }
  }

  private async wholeFile(path: string, context: Context): Promise<Result<Uint8Array, FileError>> {
    const opened = await this.env.openBinaryReader(path, undefined, context);
    if (!opened.ok) return opened;
    try {
      const data = await opened.value.read(0, MAX_CODING_RPC_DATA_BYTES + 1, context);
      if (data.ok && data.value.length > MAX_CODING_RPC_DATA_BYTES) throw new FileError("invalid", "File exceeds bounded whole-file reads; use a binary reader", path);
      return data;
    } finally { await opened.value.close(BACKGROUND_CONTEXT); }
  }

  private async dispatch(request: CodingRpcRequest, operation: ActiveOperation, context: Context): Promise<Result<unknown, Error>> {
    const args = request.args.map(decodeCodingValue);
    const text = (index: number): string => {
      const value = args[index];
      if (typeof value !== "string" || value.includes("\0") || value.length > 4096) throw new FileError("invalid", "Expected a bounded path or handle");
      return value;
    };
    const number = (index: number, max = Number.MAX_SAFE_INTEGER): number => {
      const value = args[index];
      if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > max) throw new FileError("invalid", "Invalid bounded integer argument");
      return value;
    };
    const options = <T extends object>(index: number, keys: readonly string[]): T | undefined => {
      const value = args[index];
      if (value === undefined || value === null) return undefined;
      if (typeof value !== "object" || Array.isArray(value) || value instanceof Uint8Array || Object.keys(value).some(key => !keys.includes(key))) throw new FileError("invalid", "Invalid coding options");
      for (const [key, item] of Object.entries(value)) {
        if (["recursive", "force", "noFollow", "inheritEnv"].includes(key) && item !== undefined && typeof item !== "boolean") throw new FileError("invalid", "Invalid boolean coding option");
      }
      return value as T;
    };
    const content = (): string | Uint8Array => {
      const value = args[1];
      if (!(typeof value === "string" || value instanceof Uint8Array) || Buffer.byteLength(value) > MAX_CODING_RPC_DATA_BYTES) throw new FileError("invalid", "File write exceeds coding transfer bound");
      return value;
    };
    switch (request.method) {
      case "absolutePath": return this.env.absolutePath(text(0), context);
      case "joinPath": {
        if (!Array.isArray(args[0]) || args[0].length > 256 || args[0].some(value => typeof value !== "string" || value.length > 4096 || value.includes("\0"))) throw new FileError("invalid", "Invalid path components");
        return this.env.joinPath(args[0] as string[], context);
      }
      case "readBinaryFile": return this.wholeFile(text(0), context);
      case "readTextFile": {
        const data = await this.wholeFile(text(0), context);
        return data.ok ? ok(Buffer.from(data.value.buffer, data.value.byteOffset, data.value.byteLength).toString("utf8")) : data;
      }
      case "readTextLines": {
        const readOptions = options<{ maxLines?: number }>(1, ["maxLines"]);
        if (readOptions?.maxLines !== undefined && (!Number.isSafeInteger(readOptions.maxLines))) throw new FileError("invalid", "Invalid line count");
        if (readOptions?.maxLines !== undefined && readOptions.maxLines <= 0) return ok([]);
        const opened = await this.env.openBinaryReader(text(0), undefined, context);
        if (!opened.ok) return opened;
        const reader = new BoundedTextReader(opened.value);
        const lines: string[] = [];
        let bytes = 0;
        try {
          while (readOptions?.maxLines === undefined || lines.length < readOptions.maxLines) {
            const line = await reader.readLine(context);
            if (!line.ok) return line;
            if (line.value === undefined) break;
            bytes += Buffer.byteLength(line.value.text);
            if (bytes > MAX_CODING_RPC_DATA_BYTES || lines.length >= 100_000) throw new FileError("invalid", "Text lines exceed the bounded transfer allowance");
            lines.push(line.value.text);
          }
          return ok(lines);
        } finally { await reader.close(BACKGROUND_CONTEXT); }
      }
      case "openBinaryReader": {
        const opened = await this.env.openBinaryReader(text(0), options(1, ["noFollow"]), context);
        return opened.ok ? ok(await this.handle(opened.value, "binary")) : opened;
      }
      case "openTextLineReader": {
        const opened = await this.env.openBinaryReader(text(0), undefined, context);
        return opened.ok ? ok(await this.handle(new BoundedTextReader(opened.value), "text")) : opened;
      }
      case "openDirReader": {
        const opened = await this.env.openDirReader(text(0), context);
        return opened.ok ? ok(await this.handle(opened.value, "dir")) : opened;
      }
      case "writeFile": return this.env.writeFile(text(0), content(), context);
      case "appendFile": return this.env.appendFile(text(0), content(), context);
      case "truncateFile": return this.env.truncateFile(text(0), number(1), context);
      case "flushFile": return this.env.flushFile(text(0), context);
      case "renameFile": return this.env.renameFile(text(0), text(1), context);
      case "fileInfo": return this.env.fileInfo(text(0), context);
      case "listDir": {
        const opened = await this.env.openDirReader(text(0), context);
        if (!opened.ok) return opened;
        const entries = [];
        try {
          while (true) {
            const page = await opened.value.next(256, context);
            if (!page.ok) return page;
            entries.push(...page.value.entries);
            if (entries.length > 4096) throw new FileError("invalid", "Directory exceeds bounded listing; use a directory cursor");
            if (page.value.done) return ok(entries);
          }
        } finally { await opened.value.close(BACKGROUND_CONTEXT); }
      }
      case "canonicalPath": return this.env.canonicalPath(text(0), context);
      case "exists": return this.env.exists(text(0), context);
      case "createDir": return this.env.createDir(text(0), options(1, ["recursive"]), context);
      case "remove": return this.env.remove(text(0), options(1, ["recursive", "force"]), context);
      case "createTempDir": {
        const path = this.temporaryPath(args[0] === undefined ? undefined : text(0));
        mkdirSync(path, { mode: 0o700 });
        return ok(path);
      }
      case "createTempFile": {
        const temp = options<{ prefix?: string; suffix?: string }>(0, ["prefix", "suffix"]);
        if ((temp?.prefix !== undefined && typeof temp.prefix !== "string") || (temp?.suffix !== undefined && typeof temp.suffix !== "string")) throw new FileError("invalid", "Invalid temporary name");
        const path = this.temporaryPath(temp?.prefix, temp?.suffix);
        closeSync(openSync(path, "wx", 0o600));
        return ok(path);
      }
      case "text.readLine": return this.withHandle(text(0), "text", handle => (handle.resource as TextLineReader).readLine(context));
      case "binary.info": return this.withHandle(text(0), "binary", handle => (handle.resource as BinaryReader).info(context));
      case "binary.read": return this.withHandle(text(0), "binary", handle => (handle.resource as BinaryReader).read(number(1), number(2, MAX_CODING_RPC_DATA_BYTES), context));
      case "binary.scanLines": {
        const scan = options<{ startLine: number; endLine?: number }>(1, ["startLine", "endLine"]);
        if (!scan || !Number.isSafeInteger(scan.startLine) || scan.startLine < 0 || (scan.endLine !== undefined && (!Number.isSafeInteger(scan.endLine) || scan.endLine < scan.startLine))) throw new FileError("invalid", "Invalid line scan range");
        return this.withHandle(text(0), "binary", handle => (handle.resource as BinaryReader).scanLines(scan, context));
      }
      case "dir.next": return this.withHandle(text(0), "dir", handle => (handle.resource as DirReader).next(number(1, 4096), context));
      case "handle.close": {
        const id = text(0);
        if (!id.startsWith(codingOperationPrefix(this.assignment.taskId, this.assignment.runId))) throw new FileError("invalid", "Handle belongs to another run");
        if (!this.handles.has(id)) return ok(undefined);
        return this.withHandle(id, undefined, async handle => {
          handle.watchClosed = true;
          await handle.resource.close(BACKGROUND_CONTEXT);
          this.handles.delete(id);
          return ok(undefined);
        });
      }
      case "watch": {
        if (!Array.isArray(args[0]) || args[0].length > 64) throw new FileError("invalid", "Invalid watch targets");
        for (const target of args[0]) {
          if (!target || typeof target !== "object" || !("path" in target) || typeof target.path !== "string" || target.path.length > 4096 || target.path.includes("\0") || Object.keys(target).some(key => !["path", "recursive", "exclude"].includes(key))) throw new FileError("invalid", "Invalid watch target");
          if ("recursive" in target && target.recursive !== undefined && typeof target.recursive !== "boolean") throw new FileError("invalid", "Invalid recursive watch option");
          if ("exclude" in target && target.exclude !== undefined) {
            const excluded = target.exclude;
            if (!excluded || typeof excluded !== "object" || Array.isArray(excluded) || Object.keys(excluded).some(key => !["hidden", "names"].includes(key))) throw new FileError("invalid", "Invalid watch exclusions");
            if ("hidden" in excluded && excluded.hidden !== undefined && typeof excluded.hidden !== "boolean") throw new FileError("invalid", "Invalid hidden watch exclusion");
            if ("names" in excluded && excluded.names !== undefined && (!Array.isArray(excluded.names) || excluded.names.length > 256 || excluded.names.some((name: unknown) => typeof name !== "string" || name.length > 256))) throw new FileError("invalid", "Invalid named watch exclusions");
          }
        }
        let entry: HandleEntry | undefined;
        const early: WatchChange[] = [];
        const onChange = (change: WatchChange) => {
          if (!entry) { if (early.length < 128) early.push(change); else early.splice(0, early.length, { overflow: true }); return; }
          if (entry.watchClosed) return;
          const event: CodingWatchEvent = { sequence: ++entry.watchSequence, change: "error" in change ? { error: wireError(change.error) } : change };
          const size = Buffer.byteLength(JSON.stringify(event));
          if (size > 64 * 1024) event.change = { overflow: true };
          entry.watchEvents.push(event);
          entry.watchBytes += Buffer.byteLength(JSON.stringify(event));
          while (entry.watchEvents.length > 128 || entry.watchBytes > 64 * 1024) entry.watchBytes -= Buffer.byteLength(JSON.stringify(entry.watchEvents.shift()!));
        };
        const watched = await this.env.watch(args[0] as WatchTarget[], onChange, context);
        if (!watched.ok) return watched;
        const description = await this.handle(watched.value, "watch");
        entry = this.handles.get(description.handleId)!;
        for (const change of early) onChange(change);
        return ok(description);
      }
      case "watch.next": return this.withHandle(text(0), "watch", async handle => {
        const cursor = number(1);
        if (cursor > handle.watchSequence) throw new FileError("invalid", "Watch cursor exceeds recorded events");
        const page: CodingWatchPage = { events: handle.watchEvents.filter(event => event.sequence > cursor), next: handle.watchSequence, overflow: cursor < (handle.watchEvents[0]?.sequence ?? 1) - 1 };
        return ok(page);
      });
      case "exec": {
        if (!(typeof args[0] === "string" || (Array.isArray(args[0]) && args[0].every(arg => typeof arg === "string")))) throw new ExecutionError("spawn_error", "Invalid command arguments");
        const execOptions = options<ShellExecOptions>(1, ["cwd", "env", "inheritEnv", "timeout", "spill", "window"]) ?? {};
        if (execOptions.spill !== undefined && (!execOptions.spill || typeof execOptions.spill !== "object" || Array.isArray(execOptions.spill))) throw new ExecutionError("unknown", "Invalid shell spill options");
        if (execOptions.window !== undefined && (!execOptions.window || typeof execOptions.window !== "object" || Array.isArray(execOptions.window))) throw new ExecutionError("unknown", "Invalid shell output window");
        if (execOptions.cwd !== undefined && (typeof execOptions.cwd !== "string" || execOptions.cwd.includes("\0"))) throw new ExecutionError("spawn_error", "Invalid command cwd");
        if (execOptions.env !== undefined && (typeof execOptions.env !== "object" || Array.isArray(execOptions.env) || execOptions.env === null || Object.entries(execOptions.env).some(([key, value]) => !key || key.includes("=") || key.includes("\0") || typeof value !== "string" || value.includes("\0")))) throw new ExecutionError("spawn_error", "Invalid command environment");
        if (execOptions.window && (!Number.isFinite(execOptions.window.minIntervalMs) || execOptions.window.minIntervalMs < 0 || !Number.isFinite(execOptions.window.bytesPerSecond) || execOptions.window.bytesPerSecond <= 0)) throw new ExecutionError("unknown", "Invalid shell output sampling rate");
        if (execOptions.window && (!Number.isSafeInteger(execOptions.window.maxBytes) || execOptions.window.maxBytes < 0 || execOptions.window.maxBytes > MAX_CODING_WINDOW_BYTES || !Number.isSafeInteger(execOptions.window.maxLines) || execOptions.window.maxLines < 0)) throw new ExecutionError("unknown", "Invalid or oversized shell output window");
        return executeCodingShell({ cwd: this.assignment.cwd, deadlineAt: this.assignment.deadlineAt, command: args[0] as string | string[], options: { ...execOptions, onOutput: (output, _context, info) => this.output(operation, output, info.stream, execOptions.window) }, context, spillPath: () => this.temporaryPath("output-", ".log"), chargeOutput: bytes => {
          this.outputBytes += bytes;
          if (this.outputBytes > MAX_SESSION_OUTPUT_BYTES) throw new Error("Coding session output allowance exhausted");
        }, onUncertain: () => this.markUncertain(operation) });
      }
      case "artifacts": {
        if (this.active.size !== 1) throw new FileError("invalid", "Cannot collect artifacts while other coding operations run");
        return ok(await compareCodingSnapshots(this.baseline, (await captureCodingSnapshot(this.assignment.cwd)).bytes));
      }
    }
  }
}
