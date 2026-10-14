import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { ExecutionError, FileError, err, ok, type BinaryReader, type DirReader, type ExecutionEnv, type ExecutionErrorCode, type FileErrorCode, type FileInfo, type FileWatcher, type LineScan, type Result, type ShellExecOptions, type ShellExecResult, type TextLine, type TextLineReader, type WatchChange, type WatchTarget } from "@earendil-works/pi-durable/env";
import type { CodingAssignment } from "../shared/coding.js";
import { codingOperationPrefix, decodeCodingValue, encodeCodingValue, parseCodingRpcState, type CodingRpcError, type CodingRpcHandle, type CodingRpcMethod, type CodingRpcRequest, type CodingRpcState, type CodingWatchPage } from "../shared/coding-rpc.js";

export interface CodingEnvironmentOptions {
  assignment: CodingAssignment;
  /** Stable real filesystem identity (executor identity on Mac, run identity in a container). */
  namespaceId: string;
  invocationId: string;
  invoke(request: CodingRpcRequest, context: Context): Promise<CodingRpcState>;
  inspect(operationId: string, context: Context): Promise<CodingRpcState>;
  cancel(operationId: string): Promise<void>;
}

const PATH_METHODS: Partial<Record<CodingRpcMethod, true>> = {
  absolutePath: true, readTextFile: true, openTextLineReader: true, readTextLines: true, readBinaryFile: true,
  openBinaryReader: true, writeFile: true, appendFile: true, truncateFile: true, flushFile: true, renameFile: true,
  fileInfo: true, listDir: true, openDirReader: true, canonicalPath: true, exists: true, createDir: true, remove: true,
};

function remoteError(error: CodingRpcError): FileError | ExecutionError {
  if (error.name === "ExecutionError") {
    const result = new ExecutionError(error.code as ExecutionErrorCode, error.message);
    if (error.spillPath !== undefined) result.spillPath = error.spillPath;
    return result;
  }
  return new FileError(error.name === "FileError" ? error.code as FileErrorCode : "unknown", error.message, error.path);
}

async function pause(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new Error("Coding invocation cancelled");
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const abort = () => { clearTimeout(timer); reject(new Error("Coding invocation cancelled")); };
  const timer = setTimeout(resolve, milliseconds);
  signal?.addEventListener("abort", abort, { once: true });
  try { await promise; } finally { signal?.removeEventListener("abort", abort); }
}

/** The returned environment owns only this invocation's operations and opened handles. */
export function createCodingEnvironment(options: CodingEnvironmentOptions, context: Context): ExecutionEnv {
  if (!/^[A-Za-z0-9_.-]{1,160}$/.test(options.invocationId) || !options.namespaceId) throw new Error("Invalid coding environment identity");
  return new CodingEnvironment(options, context);
}

class CodingEnvironment implements ExecutionEnv {
  readonly id: string;
  cwd: string;
  private sequence = 0;
  private readonly pending = new Set<string>();
  private readonly handles = new Set<{ close(context: Context): Promise<void> }>();
  private stopped = false;

  constructor(private readonly options: CodingEnvironmentOptions, private readonly context: Context) {
    this.id = options.namespaceId;
    this.cwd = options.assignment.cwd;
  }

  private async call<T>(method: CodingRpcMethod, args: unknown[], context: Context, shell?: ShellExecOptions, cleanup = false): Promise<Result<T, FileError | ExecutionError>> {
    if (this.stopped && !cleanup) return err(new FileError("aborted", "Coding environment is closed"));
    const signals = cleanup ? [] : [this.context.abortSignal, context.abortSignal].filter((signal): signal is AbortSignal => signal !== undefined);
    const signal = signals.length ? AbortSignal.any(signals) : undefined;
    const scoped = signal ? withAbortSignal(signal, context) : context;
    if (signal?.aborted) return err(method === "exec" ? new ExecutionError("aborted", "Coding invocation cancelled") : new FileError("aborted", "Coding invocation cancelled"));
    const operationId = `${codingOperationPrefix(this.options.assignment.taskId, this.options.assignment.runId)}${this.options.invocationId}:${++this.sequence}`;
    let request: CodingRpcRequest;
    try { request = { operationId, method, args: args.map(encodeCodingValue) }; }
    catch (error) {
      const message = error instanceof Error ? error.message : "Invalid coding RPC arguments";
      return err(method === "exec" ? new ExecutionError("unknown", message) : new FileError("invalid", message));
    }
    let cancellation: Promise<void> | undefined;
    const cancel = () => { cancellation ??= this.options.cancel(operationId); void cancellation.catch(() => undefined); };
    let lastSequence = 0, accountedBytes = 0, accountedNewlines = 0;
    let callbackFailure: unknown;
    this.pending.add(operationId);
    signal?.addEventListener("abort", cancel, { once: true });
    try {
      let state = await this.options.invoke(request, scoped);
      while (true) {
        state = parseCodingRpcState(state);
        if (state.operationId !== operationId) throw new Error("Executor returned another operation's state");
        if (signal?.aborted || this.stopped && !cleanup) {
          // Cancellation can race ahead of admission; cancel the now-admitted operation as well.
          await this.options.cancel(operationId);
          throw new Error("Coding invocation cancelled");
        }
        const sampleStart = accountedBytes;
        if (shell?.onOutput) {
          const chunks = state.progress.output.filter(chunk => chunk.sequence > lastSequence);
          const skippedBytes = state.progress.omitted.bytes - accountedBytes;
          try {
            if (skippedBytes > 0) {
              if (!shell.window || chunks.length === 0) throw new Error("Executor omitted lossless command output");
              const text = chunks.map(chunk => chunk.text).join("");
              const bytes = new TextEncoder().encode(text).length;
              const newlines = text.split("\n").length - 1;
              if (bytes <= shell.window.maxBytes && newlines <= shell.window.maxLines) throw new Error("Executor omission overlaps the caller's retained output window");
              shell.onOutput(text, context, { stream: chunks[chunks.length - 1]!.stream, skipped: { bytes: skippedBytes, newlines: state.progress.omitted.newlines - accountedNewlines, endsWithNewline: state.progress.omitted.endsWithNewline } });
              accountedBytes = state.progress.omitted.bytes + bytes;
              accountedNewlines = state.progress.omitted.newlines + newlines;
            } else {
              for (const chunk of chunks) {
                shell.onOutput(chunk.text, context, { stream: chunk.stream });
                accountedBytes += new TextEncoder().encode(chunk.text).length;
                accountedNewlines += chunk.text.split("\n").length - 1;
              }
            }
          } catch (error) { callbackFailure = error; throw error; }
          if (chunks.length) lastSequence = chunks[chunks.length - 1]!.sequence;
        }
        if (state.status === "uncertain") throw new Error("Remote operation effects are uncertain; this operation will not be replayed");
        if (state.status === "done") {
          if (!state.result) throw new Error("Executor finished without a durable result");
          return state.result.ok ? ok(decodeCodingValue(state.result.value) as T) : err(remoteError(state.result.error));
        }
        await pause(Math.max(100, shell?.window?.minIntervalMs ?? 0, shell?.window ? (accountedBytes - sampleStart) / shell.window.bytesPerSecond * 1000 : 0), signal);
        state = await this.options.inspect(operationId, scoped);
      }
    } catch (error) {
      cancel();
      const message = error instanceof Error ? error.message : "Remote coding operation failed";
      if (method === "exec") return err(new ExecutionError(callbackFailure !== undefined ? "callback_error" : signal?.aborted ? "aborted" : "unknown", message));
      return err(new FileError(signal?.aborted ? "aborted" : "unknown", message));
    } finally {
      signal?.removeEventListener("abort", cancel);
      this.pending.delete(operationId);
      if (cancellation) await cancellation.catch(() => undefined);
    }
  }

  private async file<T>(method: CodingRpcMethod, args: unknown[], context: Context): Promise<Result<T, FileError>> {
    if (PATH_METHODS[method]) {
      args = [...args];
      for (const index of method === "renameFile" ? [0, 1] : [0]) {
        const path = args[index];
        if (typeof path === "string" && !path.startsWith("/") && path !== "~" && !path.startsWith("~/") && !path.startsWith("file://")) args[index] = `${this.cwd}/${path}`;
      }
    }
    return await this.call<T>(method, args, context) as Result<T, FileError>;
  }

  private own<T extends object>(handleId: string, value: T, beforeClose?: () => Promise<void>): T & { close(context: Context): Promise<void> } {
    let closing: Promise<void> | undefined;
    const owned = Object.assign(value, { close: (_context: Context): Promise<void> => {
      closing ??= (async () => {
        try { await beforeClose?.(); }
        finally {
          const result = await this.call<void>("handle.close", [handleId], BACKGROUND_CONTEXT, undefined, true);
          this.handles.delete(owned);
          if (!result.ok) throw result.error;
        }
      })();
      return closing;
    } });
    this.handles.add(owned);
    return owned;
  }

  absolutePath(path: string, context: Context): Promise<Result<string, FileError>> { return this.file("absolutePath", [path], context); }
  joinPath(parts: string[], context: Context): Promise<Result<string, FileError>> { return this.file("joinPath", [parts], context); }
  readTextFile(path: string, context: Context): Promise<Result<string, FileError>> { return this.file("readTextFile", [path], context); }
  readTextLines(path: string, options: { maxLines?: number } | undefined, context: Context): Promise<Result<string[], FileError>> { return this.file("readTextLines", [path, options], context); }
  readBinaryFile(path: string, context: Context): Promise<Result<Uint8Array, FileError>> { return this.file("readBinaryFile", [path], context); }
  writeFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>> { return this.file("writeFile", [path, content], context); }
  appendFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>> { return this.file("appendFile", [path, content], context); }
  truncateFile(path: string, size: number, context: Context): Promise<Result<void, FileError>> { return this.file("truncateFile", [path, size], context); }
  flushFile(path: string, context: Context): Promise<Result<void, FileError>> { return this.file("flushFile", [path], context); }
  renameFile(sourcePath: string, destinationPath: string, context: Context): Promise<Result<void, FileError>> { return this.file("renameFile", [sourcePath, destinationPath], context); }
  fileInfo(path: string, context: Context): Promise<Result<FileInfo, FileError>> { return this.file("fileInfo", [path], context); }
  listDir(path: string, context: Context): Promise<Result<FileInfo[], FileError>> { return this.file("listDir", [path], context); }
  canonicalPath(path: string, context: Context): Promise<Result<string, FileError>> { return this.file("canonicalPath", [path], context); }
  exists(path: string, context: Context): Promise<Result<boolean, FileError>> { return this.file("exists", [path], context); }
  createDir(path: string, options: { recursive?: boolean } | undefined, context: Context): Promise<Result<void, FileError>> { return this.file("createDir", [path, options], context); }
  remove(path: string, options: { recursive?: boolean; force?: boolean } | undefined, context: Context): Promise<Result<void, FileError>> { return this.file("remove", [path, options], context); }
  createTempDir(prefix: string | undefined, context: Context): Promise<Result<string, FileError>> { return this.file("createTempDir", [prefix], context); }
  createTempFile(options: { prefix?: string; suffix?: string } | undefined, context: Context): Promise<Result<string, FileError>> { return this.file("createTempFile", [options], context); }

  async openTextLineReader(path: string, context: Context): Promise<Result<TextLineReader, FileError>> {
    const opened = await this.file<CodingRpcHandle>("openTextLineReader", [path], context);
    if (!opened.ok) return opened;
    const { handleId } = opened.value;
    return ok(this.own(handleId, { readLine: (context: Context) => this.file<TextLine | undefined>("text.readLine", [handleId], context) }));
  }

  async openBinaryReader(path: string, options: { noFollow?: boolean } | undefined, context: Context): Promise<Result<BinaryReader, FileError>> {
    const opened = await this.file<CodingRpcHandle>("openBinaryReader", [path, options], context);
    if (!opened.ok) return opened;
    const { handleId } = opened.value;
    return ok(this.own(handleId, {
      info: (context: Context) => this.file<FileInfo>("binary.info", [handleId], context),
      read: (offset: number, length: number, context: Context) => this.file<Uint8Array>("binary.read", [handleId, offset, length], context),
      scanLines: (options: { startLine: number; endLine?: number }, context: Context) => this.file<LineScan>("binary.scanLines", [handleId, options], context),
    }));
  }

  async openDirReader(path: string, context: Context): Promise<Result<DirReader, FileError>> {
    const opened = await this.file<CodingRpcHandle>("openDirReader", [path], context);
    if (!opened.ok) return opened;
    const { handleId } = opened.value;
    return ok(this.own(handleId, { next: (maxEntries: number, context: Context) => this.file<{ entries: FileInfo[]; done: boolean }>("dir.next", [handleId, maxEntries], context) }));
  }

  async watch(targets: readonly WatchTarget[], onChange: (change: WatchChange) => void, context: Context): Promise<Result<FileWatcher, FileError>> {
    const opened = await this.file<CodingRpcHandle>("watch", [targets.map(target => ({ ...target, path: target.path.startsWith("/") || target.path.startsWith("~") || target.path.startsWith("file://") ? target.path : `${this.cwd}/${target.path}` }))], context);
    if (!opened.ok) return opened;
    const { handleId, mode } = opened.value;
    if (mode !== "native" && mode !== "polling") return err(new FileError("unknown", "Executor omitted watcher mode"));
    const stop = new AbortController();
    const signals = [stop.signal, this.context.abortSignal, context.abortSignal].filter((signal): signal is AbortSignal => signal !== undefined);
    const signal = AbortSignal.any(signals);
    const pollContext = withAbortSignal(signal, context);
    let closed = false;
    let reportedError = false;
    let cursor = 0;
    let watcher: FileWatcher | undefined;
    const loop = (async () => {
      try {
        while (!closed && !signal.aborted) {
          const page = await this.file<CodingWatchPage>("watch.next", [handleId, cursor], pollContext);
          if (closed || signal.aborted) break;
          if (!page.ok) { reportedError = true; onChange({ error: page.error }); break; }
          if (page.value.overflow) onChange({ overflow: true });
          for (const event of page.value.events) {
            if (closed || signal.aborted) break;
            if ("error" in event.change) {
              reportedError = true;
              onChange({ error: remoteError(event.change.error) as FileError });
              return;
            }
            onChange(event.change);
          }
          cursor = page.value.next;
          await pause(250, signal);
        }
      } catch (error) {
        if (!closed && !signal.aborted && !reportedError) {
          reportedError = true;
          onChange({ error: new FileError("unknown", error instanceof Error ? error.message : "Remote watcher failed") });
        }
      } finally {
        if (!closed) {
          closed = true;
          const released = await this.call<void>("handle.close", [handleId], BACKGROUND_CONTEXT, undefined, true);
          if (watcher) this.handles.delete(watcher);
          if (!released.ok && !signal.aborted && !reportedError) onChange({ error: released.error as FileError });
        }
      }
    })();
    watcher = this.own(handleId, { mode }, async () => { closed = true; stop.abort(); await loop; });
    return ok(watcher);
  }

  async exec(command: string | readonly string[], options: ShellExecOptions | undefined, context: Context): Promise<Result<ShellExecResult, ExecutionError>> {
    const { onOutput: _onOutput, ...wireOptions } = options ?? {};
    const result = await this.call<ShellExecResult>("exec", [command, { ...wireOptions, cwd: wireOptions.cwd?.startsWith("/") ? wireOptions.cwd : `${this.cwd}/${wireOptions.cwd ?? "."}` }], context, options);
    if (!result.ok && !(result.error instanceof ExecutionError)) return err(new ExecutionError("unknown", result.error.message));
    return result as Result<ShellExecResult, ExecutionError>;
  }

  async cleanup(_context: Context): Promise<void> {
    this.stopped = true;
    const results = await Promise.allSettled([
      ...[...this.pending].map(operationId => this.options.cancel(operationId)),
      ...[...this.handles].map(handle => handle.close(BACKGROUND_CONTEXT)),
    ]);
    const failure = results.find(result => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
  }
}
