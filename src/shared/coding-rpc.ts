import type { JsonValue } from "@earendil-works/chord";
import { InputError } from "./protocol.js";

export type { JsonValue } from "@earendil-works/chord";

export const CODING_RPC_METHODS = [
  "absolutePath", "joinPath", "readTextFile", "openTextLineReader", "readTextLines", "readBinaryFile",
  "openBinaryReader", "writeFile", "appendFile", "truncateFile", "flushFile", "renameFile", "fileInfo",
  "listDir", "openDirReader", "watch", "canonicalPath", "exists", "createDir", "remove", "createTempDir",
  "createTempFile", "exec", "text.readLine", "binary.info", "binary.read", "binary.scanLines",
  "dir.next", "watch.next", "handle.close", "artifacts",
] as const;
export type CodingRpcMethod = typeof CODING_RPC_METHODS[number];
export const MAX_CODING_RPC_BYTES = 12 * 1024 * 1024;
export const MAX_CODING_RPC_DATA_BYTES = 4 * 1024 * 1024;
export const MAX_CODING_OUTPUT_BYTES = 128 * 1024;
export const MAX_CODING_WINDOW_BYTES = 64 * 1024;
export const MAX_CODING_RPC_OPERATIONS = 4096;

const ARGUMENT_COUNTS: Record<CodingRpcMethod, readonly [number, number]> = {
  absolutePath: [1, 1], joinPath: [1, 1], readTextFile: [1, 1], openTextLineReader: [1, 1],
  readTextLines: [1, 2], readBinaryFile: [1, 1], openBinaryReader: [1, 2], writeFile: [2, 2],
  appendFile: [2, 2], truncateFile: [2, 2], flushFile: [1, 1], renameFile: [2, 2], fileInfo: [1, 1],
  listDir: [1, 1], openDirReader: [1, 1], watch: [1, 1], canonicalPath: [1, 1], exists: [1, 1],
  createDir: [1, 2], remove: [1, 2], createTempDir: [0, 1], createTempFile: [0, 1], exec: [1, 2],
  "text.readLine": [1, 1], "binary.info": [1, 1], "binary.read": [3, 3], "binary.scanLines": [2, 2],
  "dir.next": [2, 2], "watch.next": [2, 2], "handle.close": [1, 1], artifacts: [0, 0],
};

/** IDs append `${invocationId}:${sequence}` to codingOperationPrefix; repeats carry identical arguments. */
export interface CodingRpcRequest {
  operationId: string;
  method: CodingRpcMethod;
  args: JsonValue[];
}
export interface CodingRpcError {
  name: "FileError" | "ExecutionError" | "Error";
  code: string;
  message: string;
  path?: string;
  spillPath?: string;
}
export type CodingRpcResult = { ok: true; value: JsonValue } | { ok: false; error: CodingRpcError };
export interface CodingOutputSkip { bytes: number; newlines: number; endsWithNewline: boolean }
export interface CodingOutputChunk { sequence: number; text: string; stream: "stdout" | "stderr" }
/** A cumulative snapshot, not a delta. Omitted counts describe the prefix removed before output[0]. */
export interface CodingRpcProgress {
  output: CodingOutputChunk[];
  omitted: CodingOutputSkip;
}
export interface CodingRpcState {
  operationId: string;
  status: "running" | "done" | "uncertain";
  progress: CodingRpcProgress;
  result?: CodingRpcResult;
}
export interface CodingRpcHandle { handleId: string; kind: "binary" | "text" | "dir" | "watch"; mode?: "native" | "polling" }
export type CodingWatchChange = { paths: string[] } | { overflow: true } | { error: CodingRpcError };
export interface CodingWatchEvent { sequence: number; change: CodingWatchChange }
export interface CodingWatchPage { events: CodingWatchEvent[]; next: number; overflow: boolean }

export function emptyCodingProgress(): CodingRpcProgress {
  return { output: [], omitted: { bytes: 0, newlines: 0, endsWithNewline: false } };
}

export function codingOperationPrefix(taskId: string, runId: string): string {
  return `${taskId.length}.${taskId}:${runId.length}.${runId}:`;
}

/** Tagged values avoid lossy JSON coercion of binary data and successful void/EOF results. */
export function encodeCodingValue(value: unknown): JsonValue {
  if (value === undefined) return { $coding: "undefined" };
  if (value instanceof Uint8Array) {
    if (value.byteLength > MAX_CODING_RPC_DATA_BYTES) throw new Error("Coding binary response exceeds the transfer bound");
    let text = "";
    for (let i = 0; i < value.length; i += 8192) text += String.fromCharCode(...value.subarray(i, i + 8192));
    return { $coding: "bytes", base64: btoa(text) };
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(encodeCodingValue);
  if (typeof value === "object") {
    const result: Record<string, JsonValue> = {};
    for (const [key, item] of Object.entries(value)) {
      if (key === "$coding" || key === "__proto__" || key === "constructor" || key === "prototype") throw new Error("Reserved coding wire key");
      result[key] = encodeCodingValue(item);
    }
    return result;
  }
  throw new Error("Unsupported coding wire value");
}

export function decodeCodingValue(value: JsonValue): unknown {
  if (Array.isArray(value)) return value.map(decodeCodingValue);
  if (value !== null && typeof value === "object") {
    if (value.$coding === "undefined" && Object.keys(value).length === 1) return undefined;
    if (value.$coding === "bytes" && typeof value.base64 === "string" && Object.keys(value).length === 2) {
      if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.base64)) throw new InputError("Invalid coding binary encoding");
      const decoded = atob(value.base64);
      if (decoded.length > MAX_CODING_RPC_DATA_BYTES) throw new InputError("Coding binary argument exceeds the transfer bound");
      return Uint8Array.from(decoded, character => character.charCodeAt(0));
    }
    if ("$coding" in value) throw new InputError("Invalid coding wire tag");
    const decoded: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) decoded[key] = decodeCodingValue(item);
    return decoded;
  }
  return value;
}

function validateJson(value: unknown, depth = 0, count = { value: 0 }): asserts value is JsonValue {
  if (++count.value > 100_000 || depth > 24) throw new InputError("Coding JSON exceeds structural bounds");
  if (value === null || typeof value === "boolean" || typeof value === "string" || (typeof value === "number" && Number.isFinite(value))) return;
  if (Array.isArray(value)) { for (const item of value) validateJson(item, depth + 1, count); return; }
  if (typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) throw new InputError("Invalid coding JSON");
  for (const [key, item] of Object.entries(value)) {
    if (["__proto__", "constructor", "prototype"].includes(key)) throw new InputError("Reserved coding JSON key");
    validateJson(item, depth + 1, count);
  }
}

function boundedWire(value: unknown): asserts value is Record<string, JsonValue> {
  validateJson(value);
  if (!value || Array.isArray(value) || typeof value !== "object") throw new InputError("Expected coding RPC object");
  if (new TextEncoder().encode(JSON.stringify(value)).length > MAX_CODING_RPC_BYTES) throw new InputError("Coding RPC exceeds transfer bound");
}

export function parseCodingRpcRequest(value: unknown): CodingRpcRequest {
  boundedWire(value);
  if (Object.keys(value).some(key => !["operationId", "method", "args"].includes(key))) throw new InputError("Unknown coding RPC request field");
  if (typeof value.operationId !== "string" || !/^[A-Za-z0-9_.:-]{1,512}$/.test(value.operationId)) throw new InputError("Invalid coding operation identity");
  if (typeof value.method !== "string" || !(CODING_RPC_METHODS as readonly string[]).includes(value.method)) throw new InputError("Unknown coding RPC method");
  const [minimum, maximum] = ARGUMENT_COUNTS[value.method as CodingRpcMethod];
  if (!Array.isArray(value.args) || value.args.length < minimum || value.args.length > maximum) throw new InputError("Invalid coding RPC argument count");
  value.args.forEach(decodeCodingValue);
  return value as unknown as CodingRpcRequest;
}

export function parseCodingRpcState(value: unknown): CodingRpcState {
  boundedWire(value);
  if (Object.keys(value).some(key => !["operationId", "status", "progress", "result"].includes(key))) throw new InputError("Unknown coding RPC state field");
  if (typeof value.operationId !== "string" || !/^[A-Za-z0-9_.:-]{1,512}$/.test(value.operationId) || !["running", "done", "uncertain"].includes(String(value.status))) throw new InputError("Invalid coding RPC state");
  const state = value as unknown as CodingRpcState;
  const progress = state.progress;
  if (!progress || !Array.isArray(progress.output) || progress.output.length > 1024 || !progress.omitted) throw new InputError("Invalid coding progress");
  if (!Number.isSafeInteger(progress.omitted.bytes) || progress.omitted.bytes < 0 || !Number.isSafeInteger(progress.omitted.newlines) || progress.omitted.newlines < 0 || typeof progress.omitted.endsWithNewline !== "boolean") throw new InputError("Invalid coding output accounting");
  let size = 0, sequence = 0;
  for (const chunk of progress.output) {
    if (!Number.isSafeInteger(chunk.sequence) || chunk.sequence <= sequence || typeof chunk.text !== "string" || !["stdout", "stderr"].includes(chunk.stream)) throw new InputError("Invalid coding output chunk");
    sequence = chunk.sequence;
    size += new TextEncoder().encode(chunk.text).length;
  }
  if (size > MAX_CODING_OUTPUT_BYTES) throw new InputError("Coding output exceeds bound");
  if (state.result) {
    if (state.result.ok === true) decodeCodingValue(state.result.value);
    else if (state.result.ok !== false || !state.result.error || !["FileError", "ExecutionError", "Error"].includes(state.result.error.name) || typeof state.result.error.code !== "string" || typeof state.result.error.message !== "string") throw new InputError("Invalid coding result");
  }
  if (state.status === "done" && !state.result) throw new InputError("Finished coding operation has no result");
  if (state.status === "running" && state.result) throw new InputError("Running coding operation has a result");
  return state;
}
