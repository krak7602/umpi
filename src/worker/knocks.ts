import {
  KNOCK_ATTEMPTS, KNOCK_CLAIM_MS, KNOCK_EXPIRY_MS, KNOCK_RETRY_MS, parseKnockPoll, parseKnockReport,
  type KnockAssignment, type KnockOutcome, type ReminderIntensity,
} from "../shared/knock.js";
import { StateError, type Database } from "./store.js";

type KnockStatus = "pending" | "claimed" | "done" | "snoozed" | "missed" | "expired";
interface Knock {
  id: string; reminderId: string; text: string; intensity: ReminderIntensity; status: KnockStatus;
  attempt: number; maxAttempts: number; nextAt: number; expiresAt: number; createdAt: number;
  claimedAt?: number; executorId?: string; outcome?: KnockOutcome; finishedAt?: number;
}
/** What the coordinator does with the reminder after the owner answered. */
export type KnockAnswer = { reminderId: string; action: "done" | "snooze" } | null;

/**
 * Knocks for due reminders, delivered by the Mac executor. A knock is claimed by a poll, and the executor reports
 * how the owner answered. A missed or "away" attempt is retried until the reminder's attempts are used.
 */
export class KnockStore {
  constructor(private readonly db: Database, private readonly now = () => Date.now()) {
    db.all("CREATE TABLE IF NOT EXISTS umpi_knocks (id TEXT PRIMARY KEY, status TEXT NOT NULL, next_at INTEGER NOT NULL, data TEXT NOT NULL)");
    db.all("CREATE INDEX IF NOT EXISTS umpi_open_knocks ON umpi_knocks(status, next_at)");
  }
  private write(knock: Knock): void {
    this.db.all("INSERT INTO umpi_knocks VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,next_at=excluded.next_at,data=excluded.data",
      knock.id, knock.status, knock.status === "claimed" ? knock.claimedAt! + KNOCK_CLAIM_MS : knock.nextAt, JSON.stringify(knock));
  }
  private open(): Knock[] {
    return this.db.all<{ data: string }>("SELECT data FROM umpi_knocks WHERE status IN ('pending','claimed') ORDER BY next_at").map(row => JSON.parse(row.data) as Knock);
  }
  get(id: string): Knock | undefined {
    const row = this.db.all<{ data: string }>("SELECT data FROM umpi_knocks WHERE id=?", id)[0];
    return row ? JSON.parse(row.data) as Knock : undefined;
  }

  /** Called in the transaction that fires the reminder. The ID is stable for that reminder version. */
  add(reminder: { id: string; version: number; text: string; intensity?: ReminderIntensity }): void {
    const now = this.now(), intensity = reminder.intensity ?? "knock";
    this.db.all("INSERT OR IGNORE INTO umpi_knocks VALUES (?,?,?,?)", `${reminder.id}:${reminder.version}`, "pending", now, JSON.stringify({
      id: `${reminder.id}:${reminder.version}`, reminderId: reminder.id, text: reminder.text, intensity, status: "pending",
      attempt: 1, maxAttempts: KNOCK_ATTEMPTS[intensity], nextAt: now, expiresAt: now + KNOCK_EXPIRY_MS, createdAt: now,
    } satisfies Knock));
  }

  /** Expires stale knocks and turns abandoned claims into missed attempts. */
  private settle(now: number): void {
    for (const knock of this.open()) {
      if (knock.status === "claimed" && knock.claimedAt! + KNOCK_CLAIM_MS <= now) this.retryOrMiss({ ...knock }, now);
      else if (knock.status === "pending" && knock.expiresAt <= now) this.write({ ...knock, status: "expired", finishedAt: now });
    }
  }
  private retryOrMiss(knock: Knock, now: number): void {
    if (knock.attempt < knock.maxAttempts && now + KNOCK_RETRY_MS < knock.expiresAt) {
      this.write({ ...knock, status: "pending", attempt: knock.attempt + 1, nextAt: now + KNOCK_RETRY_MS, claimedAt: undefined, executorId: undefined });
    } else this.write({ ...knock, status: "missed", finishedAt: now });
  }

  poll(value: unknown): { knocks: KnockAssignment[] } {
    const { executorId } = parseKnockPoll(value), now = this.now();
    return this.db.transaction(() => {
      this.settle(now);
      const due = this.open().filter(knock => knock.status === "pending" && knock.nextAt <= now).slice(0, 3);
      for (const knock of due) this.write({ ...knock, status: "claimed", claimedAt: now, executorId });
      return { knocks: due.map(knock => ({ id: knock.id, attempt: knock.attempt, text: knock.text, intensity: knock.intensity })) };
    });
  }

  report(value: unknown): KnockAnswer {
    const report = parseKnockReport(value), now = this.now();
    return this.db.transaction(() => {
      const knock = this.get(report.id);
      if (!knock) throw new StateError(404, "Unknown knock");
      // A late or repeated report for an attempt that is no longer current changes nothing.
      if (knock.status !== "claimed" || knock.attempt !== report.attempt || knock.executorId !== report.executorId) return null;
      if (report.outcome === "missed" || report.outcome === "away") { this.retryOrMiss({ ...knock, outcome: report.outcome }, now); return null; }
      this.write({ ...knock, status: report.outcome, outcome: report.outcome, finishedAt: now });
      return { reminderId: knock.reminderId, action: report.outcome === "done" ? "done" : "snooze" };
    });
  }

  /** Demand items for the executor wake: each changes when a knock needs the Mac again. */
  demand(now = this.now()): string[] {
    return this.open().filter(knock => knock.status === "pending" && knock.nextAt <= now).map(knock => `knock:${knock.id}:${knock.attempt}`);
  }
  /** When the coordinator should look again: a retry, or an abandoned claim. */
  nextDue(): number | undefined {
    return this.db.all<{ next: number | null }>("SELECT MIN(next_at) AS next FROM umpi_knocks WHERE status IN ('pending','claimed')")[0]?.next ?? undefined;
  }
  status(): object {
    const rows = this.db.all<{ status: string; count: number }>("SELECT status, COUNT(*) AS count FROM umpi_knocks GROUP BY status");
    return Object.fromEntries(rows.map(row => [row.status, row.count]));
  }
}
