import { InputError, boundedText, identifier, record, timestamp } from "./protocol.js";
import type { CodingRpcRequest, CodingRpcState } from "./coding-rpc.js";

export const MAX_CODING_TIMEOUT_MS = 3_600_000;
export const MAX_CODING_PROMPT = 16_384;
export const MAX_CODING_ARCHIVE_BYTES = 32 * 1024 * 1024;
export const MAX_CODING_PATCH_BYTES = 8 * 1024 * 1024;
export const MAX_CODING_FILES = 4_096;

export type CodingTarget = "mac" | "cloud";
export type CodingStatus = "pending_approval" | "queued" | "preparing" | "running" | "finishing" | "waiting_input" | "blocked" | "completed" | "cancel_requested" | "cancelled" | "failed" | "uncertain";
export type CodingOutcome = "completed" | "needs_input" | "blocked";

export interface CodingRequest {
  taskId: string;
  prompt: string;
  cwd: string;
  timeoutMs: number;
}

/** A source upload is a separate owner action, never a side effect of Mac approval. */
export interface CodingSource {
  sourceId: string;
  cwd: string;
  capturedAt: string;
  digest: string;
  bytes: number;
  fileCount: number;
  baseRevision: string | null;
}

/** Immutable authorization for one execution lifetime; corrections never extend its deadline. */
export interface CodingAssignment {
  taskId: string;
  runId: string;
  cwd: string;
  deadlineAt: string;
  /** Native continuation uses the previous owned copy, never a fresh overwrite from the original. */
  sourceRunId?: string;
}

export interface CodingChange {
  path: string;
  kind: "added" | "modified" | "deleted";
}

export interface CodingArtifacts {
  baseDigest: string;
  finalDigest: string;
  patchDigest: string;
  patch: string;
  changes: CodingChange[];
}

/** Execution evidence is recorded by the runner, not inferred from model prose. */
export interface CodingCommandEvidence {
  operationId: string;
  command: string | string[];
  exitCode: number | null;
  error: string | null;
}

export interface CodingResult {
  outcome: CodingOutcome;
  summary: string;
  verification: CodingCommandEvidence[];
  artifacts: Omit<CodingArtifacts, "patch">;
}

export interface CodingExecutorPoll {
  executorId: string;
  workspaces: string[];
  available: boolean;
  activeRunId: string | null;
}

export interface CodingExecutorPollResult {
  assignment: CodingAssignment | null;
  requests: CodingRpcRequest[];
  cancelOperationIds: string[];
  cancel: boolean;
}

export type CodingExecutorReport = {
  executorId: string;
  taskId: string;
  runId: string;
} & (
  | { type: "ready"; executionCwd: string }
  | { type: "operation"; state: CodingRpcState }
  | { type: "stopped"; uncertain: boolean; issue?: string; ownerConfirmedStopped?: true }
);

export function codingPath(value: unknown): string {
  const path = boundedText(value, 4_096, "coding workspace");
  if (!path.startsWith("/") || path === "/" || path.endsWith("/") || path.includes("//") || /[\u0000-\u001F\u007F]/.test(path) || path.split("/").some(part => part === "." || part === "..")) {
    throw new InputError("Coding workspaces require an exact canonical absolute directory");
  }
  return path;
}

export function parseCodingRequest(value: unknown): CodingRequest {
  const input = record(value);
  if (Object.keys(input).some(key => !["taskId", "prompt", "cwd", "timeoutMs"].includes(key))) throw new InputError("Unknown coding-task field");
  const timeoutMs = input.timeoutMs;
  if (typeof timeoutMs !== "number" || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > MAX_CODING_TIMEOUT_MS) throw new InputError("Coding timeout must be between one second and one hour");
  const prompt = boundedText(input.prompt, MAX_CODING_PROMPT, "coding task").trim();
  if (!prompt) throw new InputError("A coding task must state the requested work");
  return { taskId: identifier(input.taskId, "coding task"), prompt, cwd: codingPath(input.cwd), timeoutMs };
}

export function parseCodingAssignment(value: unknown): CodingAssignment {
  const input = record(value);
  if (Object.keys(input).some(key => !["taskId", "runId", "cwd", "deadlineAt", "sourceRunId"].includes(key))) throw new InputError("Unknown coding assignment field");
  return { taskId: identifier(input.taskId, "coding task"), runId: identifier(input.runId, "coding run"), cwd: codingPath(input.cwd), deadlineAt: timestamp(input.deadlineAt, "coding deadline"), ...(input.sourceRunId === undefined ? {} : { sourceRunId: identifier(input.sourceRunId, "coding source run") }) };
}

export function parseCodingExecutorPoll(value: unknown): CodingExecutorPoll {
  const input = record(value);
  if (!Array.isArray(input.workspaces) || input.workspaces.length < 1 || input.workspaces.length > 32 || typeof input.available !== "boolean") throw new InputError("Invalid coding executor availability");
  return { executorId: identifier(input.executorId, "executor"), workspaces: input.workspaces.map(codingPath), available: input.available, activeRunId: input.activeRunId === null ? null : identifier(input.activeRunId, "active coding run") };
}
