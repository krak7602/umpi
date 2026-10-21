import { execFile } from "node:child_process";
import { closeSync, constants, existsSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  MAX_MEMORY_RESULTS, MAX_SUMMARIES_PER_REPORT, parseActivitySummary, parseMemoryResult,
  type ActivitySummary, type ContextPollResult, type ContextReport, type MemoryResult,
} from "../shared/context.js";

export const DEFAULT_ASIDE_LEDGER = join(homedir(), ".aside", "u", "0", "context-awareness", "ledger.db");
/** Summaries are written every 10 minutes; checking every 5 keeps them at most about 15 minutes behind. */
export const SUMMARY_PUSH_INTERVAL_MS = 5 * 60_000;

interface LedgerRow { id: string; window_from: number; window_to: number; updated_at: number; title: string; description: string; body: string | null; apps: string; domains: string }
const list = (value: string): string[] => { try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed : []; } catch { return []; } };

/**
 * Reads only Aside's completed 10-minute summaries, read-only. Raw events (keystrokes, clicks, OCR, page
 * snapshots) are in other tables and are never selected. `after` is the last sent `updated_at`.
 */
export function readActivitySummaries(path: string, after: number, limit = MAX_SUMMARIES_PER_REPORT): { summaries: ActivitySummary[]; cursor: number } {
  if (!existsSync(path)) return { summaries: [], cursor: after };
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const rows = db.prepare(`SELECT id, window_from, window_to, updated_at, title, description, body, apps, domains
      FROM context_awareness_summaries WHERE status='completed' AND updated_at > ? ORDER BY updated_at, id LIMIT ?`).all(after, limit) as unknown as LedgerRow[];
    const summaries: ActivitySummary[] = [];
    for (const row of rows) {
      try {
        summaries.push(parseActivitySummary({ id: row.id, windowFrom: new Date(row.window_from).toISOString(), windowTo: new Date(row.window_to).toISOString(),
          title: row.title, description: row.description, body: row.body ?? "", apps: list(row.apps), domains: list(row.domains) }));
      } catch { /* A malformed row is skipped, not sent. */ }
    }
    return { summaries, cursor: rows.length ? rows[rows.length - 1]!.updated_at : after };
  } finally { db.close(); }
}

export type MemorySearch = (query: string, signal?: AbortSignal) => Promise<MemoryResult[]>;
/** Runs Aside's read-only memory search with a fixed argument list; the query is one argument, never shell text. */
export function asideMemorySearch(command = existsSync(join(homedir(), ".local", "bin", "aside")) ? join(homedir(), ".local", "bin", "aside") : "aside"): MemorySearch {
  // Aside needs the normal user environment, but never the executor's own credentials.
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(UMPI_|TELEGRAM_)|TOKEN|SECRET|PASSWORD/i.test(name)));
  return (query, signal) => new Promise((resolve, reject) => {
    execFile(command, ["memory", "search", "--json", "-n", String(MAX_MEMORY_RESULTS), "--", query],
      { timeout: 15_000, maxBuffer: 1024 * 1024, signal, shell: false, env },
      (error, stdout) => {
        if (error) return reject(new Error("Aside memory search failed"));
        try {
          const parsed: unknown = JSON.parse(stdout);
          if (!Array.isArray(parsed)) throw new Error();
          resolve(parsed.slice(0, MAX_MEMORY_RESULTS).flatMap(item => { try { return [parseMemoryResult(item)]; } catch { return []; } }));
        } catch { reject(new Error("Aside memory search returned unreadable output")); }
      });
  });
}

interface LaneState { cursor: number; lastPushAt: number }
export interface ContextTransport {
  poll(signal?: AbortSignal): Promise<ContextPollResult>;
  report(report: ContextReport, signal?: AbortSignal): Promise<void>;
}

/** The opt-in Aside context lane. It keeps one cursor file; nothing else from Aside is stored. */
export class AsideContextLane {
  private readonly statePath: string;
  constructor(readonly executorId: string, stateDir: string, private readonly options: { ledgerPath?: string; search?: MemorySearch; now?: () => number } = {}) {
    this.statePath = join(stateDir, "aside-context.json");
  }
  private state(): LaneState {
    try { const value = JSON.parse(readFileSync(this.statePath, "utf8")) as LaneState; if (Number.isFinite(value.cursor) && Number.isFinite(value.lastPushAt)) return value; } catch { /* Start fresh. */ }
    return { cursor: 0, lastPushAt: 0 };
  }
  private save(state: LaneState): void {
    const temporary = `${this.statePath}.${randomUUID()}.tmp`;
    const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { writeFileSync(fd, JSON.stringify(state)); fsyncSync(fd); } finally { closeSync(fd); }
    try { renameSync(temporary, this.statePath); } catch (error) { try { unlinkSync(temporary); } catch { /* Already renamed. */ } throw error; }
  }
  private now(): number { return this.options.now?.() ?? Date.now(); }

  /** Answers pending lookups, then sends new summaries when due. Errors stay local; the next tick retries. */
  async tick(transport: ContextTransport, signal?: AbortSignal): Promise<void> {
    const { requests } = await transport.poll(signal);
    const search = this.options.search ?? asideMemorySearch();
    for (const request of requests.slice(0, 2)) {
      let report: ContextReport;
      try { report = { executorId: this.executorId, kind: "memory", requestId: request.id, status: "ok", results: await search(request.query, signal) }; }
      catch { report = { executorId: this.executorId, kind: "memory", requestId: request.id, status: "error", error: "Aside memory search failed on the Mac" }; }
      await transport.report(report, signal);
    }
    const state = this.state();
    if (this.now() - state.lastPushAt < SUMMARY_PUSH_INTERVAL_MS) return;
    const { summaries, cursor } = readActivitySummaries(this.options.ledgerPath ?? DEFAULT_ASIDE_LEDGER, state.cursor);
    if (summaries.length) await transport.report({ executorId: this.executorId, kind: "summaries", summaries }, signal);
    // The cursor advances only after the coordinator accepted the batch; a resend is an idempotent upsert.
    this.save({ cursor, lastPushAt: this.now() });
  }
}
