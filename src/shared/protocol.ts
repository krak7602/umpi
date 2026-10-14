export const MAX_JOB_OUTPUT = 32_768;
export const MAX_COMMAND_LENGTH = 16_384;
export const MAX_JOB_TIMEOUT_MS = 3_600_000;
const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

export type JobTerminalStatus = "succeeded" | "failed" | "cancelled" | "uncertain";
export type JobStatus = "pending_approval" | "queued" | "running" | JobTerminalStatus;

export interface MacJobAssignment {
  jobId: string;
  command: string;
  cwd: string;
  timeoutMs: number;
  createdAt: string;
}

export interface ExecutorPoll {
  executorId: string;
  workspaces: string[];
}

export interface ExecutorPollResult {
  job: MacJobAssignment | null;
  cancelJobIds: string[];
}

export interface JobCompletion {
  executorId: string;
  jobId: string;
  status: JobTerminalStatus;
  exitCode: number | null;
  output: string;
  truncated: boolean;
  finishedAt: string;
}

export class InputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InputError";
  }
}

export function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new InputError("Expected an object");
  }
  return value as Record<string, unknown>;
}

export function identifier(value: unknown, label = "identifier"): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value)) {
    throw new InputError(`Invalid ${label}`);
  }
  return value;
}

export function boundedText(value: unknown, limit: number, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > limit || value.includes("\0")) {
    throw new InputError(`Invalid ${label}`);
  }
  return value;
}

export function timestamp(value: unknown, label: string): string {
  const fields = typeof value === "string"
    ? /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.exec(value)
    : null;
  if (!fields || typeof value !== "string") {
    throw new InputError(`Invalid ${label}; use an ISO timestamp with an explicit offset`);
  }
  const year = Number(fields[1]);
  const month = Number(fields[2]);
  const day = Number(fields[3]);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const lastDay = month === 2 && leapYear ? 29 : (MONTH_DAYS[month - 1] ?? 0);
  if (day < 1 || day > lastDay || Number(fields[4]) > 23 || Number(fields[5]) > 59 || Number(fields[6]) > 59 || !Number.isFinite(Date.parse(value))) {
    throw new InputError(`Invalid ${label}; calendar date or time is out of range`);
  }
  return value;
}

export function parseAssignment(value: unknown): MacJobAssignment {
  const input = record(value);
  const timeout = input.timeoutMs;
  if (!Number.isInteger(timeout) || typeof timeout !== "number" || timeout < 1_000 || timeout > MAX_JOB_TIMEOUT_MS) {
    throw new InputError("Invalid job timeout");
  }
  return {
    jobId: identifier(input.jobId, "job ID"),
    command: boundedText(input.command, MAX_COMMAND_LENGTH, "command"),
    cwd: boundedText(input.cwd, 4_096, "working directory"),
    timeoutMs: timeout,
    createdAt: timestamp(input.createdAt, "creation time"),
  };
}

export function parsePoll(value: unknown): ExecutorPoll {
  const input = record(value);
  if (!Array.isArray(input.workspaces) || input.workspaces.length === 0 || input.workspaces.length > 32) {
    throw new InputError("Configure between one and 32 workspaces");
  }
  return {
    executorId: identifier(input.executorId, "executor ID"),
    workspaces: input.workspaces.map(path => boundedText(path, 4_096, "workspace")),
  };
}

export function parsePollResult(value: unknown): ExecutorPollResult {
  const input = record(value);
  if (!Array.isArray(input.cancelJobIds) || input.cancelJobIds.length > 100) {
    throw new InputError("Invalid cancellation list");
  }
  return {
    job: input.job === null ? null : parseAssignment(input.job),
    cancelJobIds: input.cancelJobIds.map(id => identifier(id, "job ID")),
  };
}

export function parseCompletion(value: unknown): JobCompletion {
  const input = record(value);
  if (typeof input.status !== "string" || !["succeeded", "failed", "cancelled", "uncertain"].includes(input.status)) {
    throw new InputError("Invalid terminal job status");
  }
  if (input.exitCode !== null && (typeof input.exitCode !== "number" || !Number.isInteger(input.exitCode))) {
    throw new InputError("Invalid exit code");
  }
  if (input.status === "succeeded" && input.exitCode !== 0) throw new InputError("Success requires exit code zero");
  if (input.status === "uncertain" && input.exitCode !== null) throw new InputError("Uncertain execution cannot claim an exit code");
  if (typeof input.output !== "string" || input.output.length > MAX_JOB_OUTPUT || typeof input.truncated !== "boolean") {
    throw new InputError("Invalid job output");
  }
  return {
    executorId: identifier(input.executorId, "executor ID"),
    jobId: identifier(input.jobId, "job ID"),
    status: input.status as JobTerminalStatus,
    exitCode: input.exitCode,
    output: input.output,
    truncated: input.truncated,
    finishedAt: timestamp(input.finishedAt, "completion time"),
  };
}
