import type { Database, Reminder } from "./store.js";

/**
 * Knocks sent from the server, for reminders the phone did not confirm it had set. A phone sets knocks itself when it
 * syncs before the reminder is due, which also works offline; but iOS wakes a closed app only now and then, so a new
 * reminder can reach the phone too late. Then the server pushes the knock: the same Time Sensitive notification, sound,
 * and Done/Snooze/Later buttons, repeated three minutes apart until the reminder is answered.
 */
export interface KnockPush { id: string; reminderId: string; version: number; attempt: number; at: number; text: string; hint?: string; gentle: boolean }
export const KNOCK_PUSH_REPEAT_MS = 180_000;

export class KnockPushStore {
  constructor(private readonly db: Database, private readonly now = () => Date.now()) {
    db.all("CREATE TABLE IF NOT EXISTS umpi_knock_push (id TEXT PRIMARY KEY, at INTEGER NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL)");
  }
  /** Queues the knock and its repeats; a gentle reminder knocks once. */
  queue(reminder: Reminder): void {
    const gentle = reminder.intensity === "gentle", start = this.now();
    const hint = reminder.details?.split("\n").map(line => line.replace(/^\s*([-*+]|\d+\.)\s+/, "").trim()).find(Boolean);
    for (let attempt = 0; attempt < (gentle ? 1 : 3); attempt++) {
      const push: KnockPush = { id: `${reminder.id}:${reminder.version}:${attempt}`, reminderId: reminder.id, version: reminder.version, attempt,
        at: start + attempt * KNOCK_PUSH_REPEAT_MS, text: reminder.text, gentle, ...(hint ? { hint: hint.slice(0, 160) } : {}) };
      this.db.all("INSERT OR IGNORE INTO umpi_knock_push VALUES (?,?,?,?)", push.id, push.at, "pending", JSON.stringify(push));
    }
  }
  next(): KnockPush | undefined {
    const row = this.db.all<{ data: string }>("SELECT data FROM umpi_knock_push WHERE status='pending' AND at<=? ORDER BY at LIMIT 1", this.now())[0];
    return row ? JSON.parse(row.data) as KnockPush : undefined;
  }
  nextDue(): number | undefined { return this.db.all<{ at: number }>("SELECT at FROM umpi_knock_push WHERE status='pending' ORDER BY at LIMIT 1")[0]?.at; }
  finish(id: string, status: "sent" | "skipped" | "failed"): void { this.db.all("UPDATE umpi_knock_push SET status=? WHERE id=?", status, id); }
  status(): object {
    return Object.fromEntries(this.db.all<{ status: string; n: number }>("SELECT status, count(*) AS n FROM umpi_knock_push GROUP BY status").map(row => [row.status, row.n]));
  }
}
