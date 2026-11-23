import { StateError, type Database } from "./store.js";

/**
 * Failures that code caught and carried on from: where, what kind, how often, and when first and last. Without this a
 * swallowed error leaves no trace. It never keeps an error's message or stack, which can hold the owner's private
 * text; the site name and the error's class are enough to find the code.
 */
export interface Fault { site: string; kind: string; count: number; firstAt: string; lastAt: string }

const KEEP_MS = 30 * 24 * 3_600_000;
const MAX_ROWS = 200;

/** The error's class, and for a state error its status. Text that is not a plain identifier is not kept. */
export function faultKind(error: unknown): string {
  if (error instanceof StateError) return `StateError:${error.status}`;
  const name = error instanceof Error ? error.name || error.constructor.name : typeof error;
  const code = (error as { code?: unknown } | null)?.code;
  const plain = (value: string) => /^[A-Za-z][A-Za-z0-9_.-]{0,47}$/.test(value);
  return `${plain(name) ? name : "Error"}${typeof code === "string" && plain(code) ? `:${code}` : ""}`;
}

export class FaultLedger {
  constructor(private readonly db: Database, private readonly now = () => Date.now()) {
    db.all("CREATE TABLE IF NOT EXISTS umpi_faults (site TEXT NOT NULL, kind TEXT NOT NULL, count INTEGER NOT NULL, first_at INTEGER NOT NULL, last_at INTEGER NOT NULL, PRIMARY KEY (site, kind))");
  }

  /** Never throws: recording a failure must not become one. */
  record(site: string, error: unknown): void {
    try {
      const at = this.now();
      this.db.all("INSERT INTO umpi_faults VALUES (?,?,1,?,?) ON CONFLICT(site, kind) DO UPDATE SET count=count+1, last_at=excluded.last_at", site.slice(0, 96), faultKind(error), at, at);
      this.db.all("DELETE FROM umpi_faults WHERE last_at < ?", at - KEEP_MS);
      this.db.all("DELETE FROM umpi_faults WHERE rowid NOT IN (SELECT rowid FROM umpi_faults ORDER BY last_at DESC LIMIT ?)", MAX_ROWS);
    } catch { /* The ledger is diagnostics; the caller's own handling stands. */ }
  }

  /** Newest first, for protected status. */
  recent(limit = 50): Fault[] {
    return this.db.all<{ site: string; kind: string; count: number; first_at: number; last_at: number }>("SELECT site, kind, count, first_at, last_at FROM umpi_faults ORDER BY last_at DESC LIMIT ?", limit)
      .map(row => ({ site: row.site, kind: row.kind, count: row.count, firstAt: new Date(row.first_at).toISOString(), lastAt: new Date(row.last_at).toISOString() }));
  }
}

/**
 * One subsystem's step of the coordinator's reconciliation. `needs` names earlier stages that must have succeeded for
 * it to be safe. `due` is when the subsystem next needs a run on its own; the list of stages is the one place that
 * says both what is driven and what can wake the coordinator.
 */
export interface Stage { name: string; needs?: string[]; run: () => unknown; due?: () => number | undefined | Promise<number | undefined> }

/**
 * Runs the stages in order. A stage that throws is reported and the next one still runs, so a fault in one subsystem
 * (mail, say) cannot hold back the others (deliveries, pushes). A stage whose `needs` failed is skipped. Returns the
 * names of the stages that failed or were skipped.
 */
export async function runStages(stages: Stage[], failed: (stage: string, error: unknown) => void): Promise<string[]> {
  const bad: string[] = [];
  for (const stage of stages) {
    if (stage.needs?.some(name => bad.includes(name))) { bad.push(stage.name); continue; }
    try { await stage.run(); }
    catch (error) { bad.push(stage.name); failed(stage.name, error); }
  }
  return bad;
}

/** How soon to reconcile again after a run with failed stages: quick at first, then slower, so a lasting fault is not a tight loop. */
export function retryDelay(consecutiveFailures: number): number {
  return consecutiveFailures <= 6 ? 10_000 : consecutiveFailures <= 30 ? 60_000 : 300_000;
}

/**
 * When to reconcile next: the earliest `due` of the stages that ran well, and `retryAt` when any failed. A failed
 * stage's own `due` is left out, since it is usually "now" and would turn its fault into a tight loop; the retry
 * covers it. Infinity means nothing needs a wake.
 */
export async function nextWake(stages: Stage[], bad: string[], retryAt: number, failed: (stage: string, error: unknown) => void): Promise<number> {
  let at = bad.length ? retryAt : Infinity;
  for (const stage of stages) {
    if (!stage.due || bad.includes(stage.name)) continue;
    try { at = Math.min(at, await stage.due() ?? Infinity); }
    catch (error) { failed(stage.name, error); at = Math.min(at, retryAt); }
  }
  return at;
}
