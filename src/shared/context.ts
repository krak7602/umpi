import { InputError, boundedText, identifier, record, timestamp } from "./protocol.js";

/**
 * The Aside context lane: the Mac sends Aside's own 10-minute activity summaries, never raw events,
 * and answers owner-requested Aside memory searches. Everything here is bounded on both sides.
 */
export const MAX_MEMORY_QUERY = 300;
export const MAX_MEMORY_RESULTS = 8;
export const MAX_SUMMARY_BODY = 3_000;
export const MAX_SUMMARIES_PER_REPORT = 24;

export interface ActivitySummary {
  id: string; windowFrom: string; windowTo: string;
  title: string; description: string; body: string; apps: string[]; domains: string[];
}
export interface MemoryResult { path: string; title: string; excerpt: string; date: string | null; score: number | null }
export interface ContextRequest { id: string; query: string }
export interface ContextPoll { executorId: string }
export interface ContextPollResult { requests: ContextRequest[] }
export type ContextReport =
  | { executorId: string; kind: "summaries"; summaries: ActivitySummary[] }
  | { executorId: string; kind: "memory"; requestId: string; status: "ok"; results: MemoryResult[] }
  | { executorId: string; kind: "memory"; requestId: string; status: "error"; error: string };

function text(value: unknown, max: number, label: string, allowEmpty = true): string {
  if (typeof value !== "string") throw new InputError(`Invalid ${label}`);
  const result = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").trim().slice(0, max);
  if (!allowEmpty && !result) throw new InputError(`Invalid ${label}`);
  return result;
}
function names(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new InputError(`Invalid ${label}`);
  return [...new Set(value.filter(item => typeof item === "string").map(item => text(item, 120, label)).filter(Boolean))].slice(0, 16);
}

export function parseMemoryQuery(value: unknown): string {
  const query = text(value, MAX_MEMORY_QUERY + 1, "memory query", false);
  if (query.length > MAX_MEMORY_QUERY) throw new InputError(`A memory query is at most ${MAX_MEMORY_QUERY} characters`);
  return query;
}
export function parseActivitySummary(value: unknown): ActivitySummary {
  const input = record(value);
  const windowFrom = timestamp(input.windowFrom, "activity window start"), windowTo = timestamp(input.windowTo, "activity window end");
  if (Date.parse(windowTo) <= Date.parse(windowFrom)) throw new InputError("Invalid activity window");
  return {
    id: identifier(input.id, "activity summary ID"), windowFrom, windowTo,
    title: text(input.title, 200, "activity title"), description: text(input.description, 600, "activity description"),
    body: text(input.body, MAX_SUMMARY_BODY, "activity body"), apps: names(input.apps, "apps"), domains: names(input.domains, "domains"),
  };
}
export function parseMemoryResult(value: unknown): MemoryResult {
  const input = record(value);
  return {
    path: text(input.path, 200, "memory path", false), title: text(input.title ?? "", 200, "memory title"),
    excerpt: text(input.excerpt, 600, "memory excerpt"),
    date: typeof input.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(input.date) ? input.date : null,
    score: typeof input.score === "number" && Number.isFinite(input.score) ? Math.round(input.score * 1000) / 1000 : null,
  };
}
export function parseContextPoll(value: unknown): ContextPoll {
  const input = record(value);
  if (Object.keys(input).some(key => key !== "executorId")) throw new InputError("Unknown context poll field");
  return { executorId: identifier(input.executorId, "executor ID") };
}
export function parseContextPollResult(value: unknown): ContextPollResult {
  const input = record(value);
  if (!Array.isArray(input.requests) || input.requests.length > 8) throw new InputError("Invalid context requests");
  return { requests: input.requests.map(item => { const request = record(item); return { id: identifier(request.id, "context request ID"), query: parseMemoryQuery(request.query) }; }) };
}
export function parseContextReport(value: unknown): ContextReport {
  const input = record(value), executorId = identifier(input.executorId, "executor ID");
  if (input.kind === "summaries") {
    if (!Array.isArray(input.summaries) || input.summaries.length > MAX_SUMMARIES_PER_REPORT) throw new InputError("Invalid activity summaries");
    return { executorId, kind: "summaries", summaries: input.summaries.map(parseActivitySummary) };
  }
  if (input.kind !== "memory") throw new InputError("Unknown context report");
  const requestId = identifier(input.requestId, "context request ID");
  if (input.status === "ok") {
    if (!Array.isArray(input.results) || input.results.length > MAX_MEMORY_RESULTS) throw new InputError("Invalid memory results");
    return { executorId, kind: "memory", requestId, status: "ok", results: input.results.map(parseMemoryResult) };
  }
  if (input.status === "error") return { executorId, kind: "memory", requestId, status: "error", error: boundedText(input.error, 300, "memory error") };
  throw new InputError("Invalid memory report status");
}
