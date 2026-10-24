import { randomUUID } from "node:crypto";
import { parseContextPoll, parseContextReport, parseMemoryQuery, type ActivitySummary, type ContextRequest, type MemoryResult } from "../shared/context.js";
import { StateError, type Database } from "./store.js";

/** Activity summaries are kept for two weeks: enough for "what did I do" and follow-up, not a permanent log. */
export const ACTIVITY_RETENTION_MS = 14 * 86_400_000;
const REQUEST_RETENTION_MS = 60 * 60_000;
/** A lookup the Mac has not claimed within this time is not sent later; the tool has already answered. */
const REQUEST_CLAIM_MS = 30_000;

type RequestRecord = { id: string; query: string; createdAt: number; status: "pending" | "dispatched" | "done" | "error"; results?: MemoryResult[]; error?: string };
interface LaneMeta { executorId: string | null; lastPollAt: number | null; lastSummariesAt: number | null }

/** Aside context sent by the Mac lane: summaries (not raw activity) and owner-requested memory lookups. */
export class ActivityStore {
  constructor(private readonly db: Database) {
    for (const sql of [
      "CREATE TABLE IF NOT EXISTS umpi_activity (id TEXT PRIMARY KEY, window_to INTEGER NOT NULL, data TEXT NOT NULL)",
      "CREATE INDEX IF NOT EXISTS umpi_activity_window ON umpi_activity(window_to)",
      "CREATE TABLE IF NOT EXISTS umpi_context_requests (id TEXT PRIMARY KEY, status TEXT NOT NULL, created INTEGER NOT NULL, data TEXT NOT NULL)",
      "CREATE TABLE IF NOT EXISTS umpi_context_meta (id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL)",
    ]) db.all(sql);
  }
  private meta(): LaneMeta {
    const row = this.db.all<{ data: string }>("SELECT data FROM umpi_context_meta WHERE id=1")[0];
    return row ? JSON.parse(row.data) as LaneMeta : { executorId: null, lastPollAt: null, lastSummariesAt: null };
  }
  private saveMeta(meta: LaneMeta): void { this.db.all("INSERT INTO umpi_context_meta VALUES (1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data", JSON.stringify(meta)); }
  private request(id: string): RequestRecord | undefined {
    const row = this.db.all<{ data: string }>("SELECT data FROM umpi_context_requests WHERE id=?", id)[0];
    return row ? JSON.parse(row.data) as RequestRecord : undefined;
  }
  private saveRequest(request: RequestRecord): void {
    this.db.all("INSERT INTO umpi_context_requests VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,data=excluded.data", request.id, request.status, request.createdAt, JSON.stringify(request));
  }
  /** One Mac owns the lane; another executor ID cannot read lookups or write activity. */
  private claim(executorId: string, now: number): void {
    const meta = this.meta();
    if (meta.executorId && meta.executorId !== executorId && meta.lastPollAt !== null && now - meta.lastPollAt < 10 * 60_000) throw new StateError(409, "Another Mac owns the Aside context lane");
    this.saveMeta({ ...meta, executorId });
  }

  poll(value: unknown, now = Date.now()): { requests: ContextRequest[] } {
    const { executorId } = parseContextPoll(value);
    return this.db.transaction(() => {
      this.claim(executorId, now);
      this.saveMeta({ ...this.meta(), lastPollAt: now });
      this.db.all("DELETE FROM umpi_context_requests WHERE created < ?", now - REQUEST_RETENTION_MS);
      const pending = this.db.all<{ data: string }>("SELECT data FROM umpi_context_requests WHERE status='pending' AND created >= ? ORDER BY created LIMIT 4", now - REQUEST_CLAIM_MS)
        .map(row => JSON.parse(row.data) as RequestRecord);
      for (const request of pending) this.saveRequest({ ...request, status: "dispatched" });
      return { requests: pending.map(({ id, query }) => ({ id, query })) };
    });
  }
  report(value: unknown, now = Date.now()): { accepted: number } {
    const report = parseContextReport(value);
    return this.db.transaction(() => {
      this.claim(report.executorId, now);
      if (report.kind === "summaries") {
        for (const summary of report.summaries) {
          const windowTo = Date.parse(summary.windowTo);
          if (windowTo < now - ACTIVITY_RETENTION_MS) continue;
          this.db.all("INSERT INTO umpi_activity VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET window_to=excluded.window_to,data=excluded.data", summary.id, windowTo, JSON.stringify(summary));
        }
        this.db.all("DELETE FROM umpi_activity WHERE window_to < ?", now - ACTIVITY_RETENTION_MS);
        this.saveMeta({ ...this.meta(), lastSummariesAt: now });
        return { accepted: report.summaries.length };
      }
      const request = this.request(report.requestId);
      if (!request || request.status !== "dispatched") return { accepted: 0 };
      this.saveRequest(report.status === "ok" ? { ...request, status: "done", results: report.results } : { ...request, status: "error", error: report.error });
      return { accepted: 1 };
    });
  }

  requestMemory(query: unknown, now = Date.now()): string {
    const id = `memory-${randomUUID()}`;
    this.saveRequest({ id, query: parseMemoryQuery(query), createdAt: now, status: "pending" });
    return id;
  }
  memoryResult(id: string): RequestRecord | undefined { return this.request(id); }
  /** Lookups waiting for the Mac, newest first; older ones are no longer sent. */
  pendingRequestIds(now = Date.now()): string[] {
    return this.db.all<{ id: string }>("SELECT id FROM umpi_context_requests WHERE status='pending' AND created >= ? ORDER BY created DESC LIMIT 4", now - REQUEST_CLAIM_MS).map(row => row.id);
  }

  /** Summaries whose window ends inside [from, to), oldest first. */
  read(from: number, to: number, limit = 200): ActivitySummary[] {
    return this.db.all<{ data: string }>("SELECT data FROM umpi_activity WHERE window_to > ? AND window_to <= ? ORDER BY window_to LIMIT ?", from, to, limit)
      .map(row => JSON.parse(row.data) as ActivitySummary);
  }
  status(now = Date.now()): object {
    const meta = this.meta(), iso = (value: number | null) => value === null ? null : new Date(value).toISOString();
    const counts = this.db.all<{ count: number; first: number | null; last: number | null }>("SELECT count(*) AS count, min(window_to) AS first, max(window_to) AS last FROM umpi_activity")[0]!;
    return { macLastPollAt: iso(meta.lastPollAt), lastSummariesAt: iso(meta.lastSummariesAt), summaries: counts.count, from: iso(counts.first), to: iso(counts.last),
      laneActive: meta.lastPollAt !== null && now - meta.lastPollAt < 2 * 60_000 };
  }
}
