import { planningDay, planningDayBounds, shiftPlanningDay } from "../shared/daily-planning.js";
import { InputError, record } from "../shared/protocol.js";
import type { ProactiveStore } from "./proactive-store.js";
import { readCalendarRange } from "./situation-tools.js";
import type { SituationFact, SituationStore } from "./situation-store.js";
import { StateError, type Database } from "./store.js";
import { readJson } from "./transport.js";

/**
 * Code-owned default checks: calendar heads-ups, due-soon nudges from the situation record, and
 * a review for commitments that stopped moving. Heads-ups and nudges are templated text with no
 * model turn; only a stalled commitment starts a normal proactive review.
 */
export interface AlertSettings { version: number; calendarLeadMinutes: number; dueSoon: boolean; stalled: boolean }
interface CalendarCacheEvent { key: string; title: string; start: string; end: string; tentative: boolean }
interface AlertMeta { lastCalendarPoll: number | null; calendarIssue: string | null }

const MINUTE = 60_000, HOUR = 60 * MINUTE, DAY = 24 * HOUR;
const CALENDAR_POLL_MS = 20 * MINUTE;
const STALLED_AFTER_MS = 2 * DAY;
const NUDGE_LOCAL_TIME = "09:00";
const TERMINAL = new Set(["delivered", "cancelled", "canceled", "returned", "refunded", "paid", "rejected", "withdrawn", "closed", "completed", "resolved", "expired", "ended"]);

const iso = (now: number) => new Date(now).toISOString();

export class AlertStore {
  constructor(readonly db: Database) {
    for (const sql of [
      "CREATE TABLE IF NOT EXISTS umpi_alert_settings (id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL)",
      "CREATE TABLE IF NOT EXISTS umpi_alert_meta (id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL)",
      "CREATE TABLE IF NOT EXISTS umpi_alert_events (key TEXT PRIMARY KEY, start INTEGER NOT NULL, data TEXT NOT NULL)",
      "CREATE TABLE IF NOT EXISTS umpi_alert_sent (key TEXT PRIMARY KEY, at INTEGER NOT NULL)",
    ]) this.db.all(sql);
    this.db.all("INSERT OR IGNORE INTO umpi_alert_settings VALUES (1,?)", JSON.stringify({ version: 1, calendarLeadMinutes: 15, dueSoon: true, stalled: true } satisfies AlertSettings));
    this.db.all("INSERT OR IGNORE INTO umpi_alert_meta VALUES (1,?)", JSON.stringify({ lastCalendarPoll: null, calendarIssue: null } satisfies AlertMeta));
  }
  settings(): AlertSettings { return JSON.parse(this.db.all<{ data: string }>("SELECT data FROM umpi_alert_settings WHERE id=1")[0]!.data) as AlertSettings; }
  meta(): AlertMeta { return JSON.parse(this.db.all<{ data: string }>("SELECT data FROM umpi_alert_meta WHERE id=1")[0]!.data) as AlertMeta; }
  writeMeta(meta: AlertMeta): void { this.db.all("UPDATE umpi_alert_meta SET data=? WHERE id=1", JSON.stringify(meta)); }
  configure(value: unknown): AlertSettings {
    const body = record(value);
    if (Object.keys(body).some(key => !["expectedVersion", "calendarLeadMinutes", "dueSoon", "stalled"].includes(key))) throw new InputError("Unknown alert setting");
    const previous = this.settings();
    if (body.expectedVersion !== previous.version) throw new StateError(409, "Alert settings changed; read the current version");
    const lead = body.calendarLeadMinutes ?? previous.calendarLeadMinutes;
    if (!Number.isSafeInteger(lead) || (lead as number) < 0 || (lead as number) > 180) throw new InputError("calendarLeadMinutes must be 0 (off) to 180");
    for (const key of ["dueSoon", "stalled"] as const) if (body[key] !== undefined && typeof body[key] !== "boolean") throw new InputError(`${key} must be a boolean`);
    const settings: AlertSettings = { version: previous.version + 1, calendarLeadMinutes: lead as number,
      dueSoon: (body.dueSoon as boolean | undefined) ?? previous.dueSoon, stalled: (body.stalled as boolean | undefined) ?? previous.stalled };
    this.db.all("UPDATE umpi_alert_settings SET data=? WHERE id=1", JSON.stringify(settings));
    return settings;
  }
  replaceEvents(events: CalendarCacheEvent[], now: number): void {
    this.db.transaction(() => {
      this.db.all("DELETE FROM umpi_alert_events");
      for (const event of events) this.db.all("INSERT OR REPLACE INTO umpi_alert_events VALUES (?,?,?)", event.key, Date.parse(event.start), JSON.stringify(event));
      this.db.all("DELETE FROM umpi_alert_sent WHERE at < ?", now - 60 * DAY);
    });
  }
  events(from: number): CalendarCacheEvent[] {
    return this.db.all<{ data: string }>("SELECT data FROM umpi_alert_events WHERE start >= ? ORDER BY start LIMIT 200", from).map(row => JSON.parse(row.data) as CalendarCacheEvent);
  }
  sent(key: string): boolean { return this.db.all("SELECT key FROM umpi_alert_sent WHERE key=?", key).length > 0; }
  markSent(key: string, now: number): void { this.db.all("INSERT OR IGNORE INTO umpi_alert_sent VALUES (?,?)", key, now); }
}

/** A local wall-clock time on the local day `offset` days from `instant`'s local day. */
function localTimeOn(instant: number, offset: number, time: string, timezone: string): number {
  const day = shiftPlanningDay(planningDay(instant, timezone), offset), start = Date.parse(planningDayBounds(day, timezone).start);
  const [hours, minutes] = time.split(":").map(Number) as [number, number];
  return start + hours * HOUR + minutes * MINUTE;
}
function isLocalMidnight(instant: number, timezone: string): boolean {
  return Date.parse(planningDayBounds(planningDay(instant, timezone), timezone).start) === instant;
}
function money(fact: SituationFact): string {
  if (!fact.amount) return "";
  const value = fact.amount.value.toLocaleString("en-IN", { maximumFractionDigits: 2 });
  return fact.amount.currency === "INR" ? ` (₹${value})` : ` (${value} ${fact.amount.currency})`;
}

interface Nudge { key: string; at: number; until: number; text: string }

/** The parent router authenticates the owner control credential before calling this. */
export async function alertRequest(request: Request, runtime: AlertRuntime, wake: () => Promise<void>): Promise<Response | undefined> {
  const path = new URL(request.url).pathname;
  if (path === "/api/alerts" && request.method === "GET") return Response.json(runtime.status());
  if (path === "/api/alerts/settings" && request.method === "PUT") {
    const settings = runtime.store.configure(await readJson(request, 4_096));
    await wake();
    return Response.json(settings);
  }
}

export class AlertRuntime {
  constructor(
    readonly store: AlertStore,
    private readonly situation: SituationStore,
    private readonly proactive: ProactiveStore,
    private readonly calendarCredentials: () => string | undefined,
    private readonly ownedCommitment: (id: string) => boolean,
    private readonly onCalendar?: (events: { id?: string; title: string; start: string; end: string; tentative?: boolean }[], now: number) => void,
  ) {}
  private get timezone(): string { return this.proactive.timezone; }
  private clock(instant: number): string {
    return new Intl.DateTimeFormat("en-IN", { timeZone: this.timezone, hour: "numeric", minute: "2-digit" }).format(instant);
  }
  private dayWord(due: number, now: number): string {
    const today = planningDay(now, this.timezone), target = planningDay(due, this.timezone);
    return target === today ? "today" : target === shiftPlanningDay(today, 1) ? "tomorrow" : target === shiftPlanningDay(today, 2) ? "in 2 days" : `on ${target}`;
  }

  /** Due-soon rules, evaluated from the current record so corrections and new evidence apply immediately. */
  private nudges(now: number): Nudge[] {
    const result: Nudge[] = [];
    for (const fact of this.situation.active(["bill", "subscription", "job", "booking", "order"], now)) {
      if (TERMINAL.has(fact.state) || fact.owner?.dismissed) continue;
      if (fact.kind === "order") {
        if (fact.state === "out_for_delivery" && Date.parse(fact.updatedAt) > now - 12 * HOUR) {
          result.push({ key: `due:${fact.id}:out_for_delivery`, at: Date.parse(fact.updatedAt), until: Date.parse(fact.updatedAt) + 12 * HOUR,
            text: `Out for delivery today: ${fact.title}${fact.counterparty ? ` from ${fact.counterparty}` : ""}.` });
        }
        continue;
      }
      if (!fact.dueAt) continue;
      const due = Date.parse(fact.dueAt), dateOnly = isLocalMidnight(due, this.timezone);
      let at: number, text: string;
      if (fact.kind === "bill") {
        at = localTimeOn(due, -1, NUDGE_LOCAL_TIME, this.timezone);
        text = `Bill due ${this.dayWord(due, Math.max(now, at))}: ${fact.title}${money(fact)}.`;
      } else if (fact.kind === "subscription") {
        at = localTimeOn(due, -2, NUDGE_LOCAL_TIME, this.timezone);
        text = `${fact.title} renews ${this.dayWord(due, Math.max(now, at))}${money(fact)}. Keep it, or cancel before then.`;
      } else if (dateOnly) {
        at = localTimeOn(due, -1, NUDGE_LOCAL_TIME, this.timezone);
        text = `${fact.kind === "job" ? "Application deadline" : "Booked"} ${this.dayWord(due, Math.max(now, at))}: ${fact.title}${fact.detail ? `. ${fact.detail}` : ""}.`;
      } else {
        at = due - HOUR;
        text = `In 1 hour (${this.clock(due)}): ${fact.title}${fact.kind === "job" && fact.detail ? `. ${fact.detail}` : ""}.`;
      }
      result.push({ key: `due:${fact.id}:${fact.dueAt}`, at, until: due, text });
    }
    return result;
  }

  private quiet(now: number): boolean | undefined {
    const due = this.proactive.notificationDueAt(now);
    return due === undefined ? undefined : due > now;
  }

  async drive(now = Date.now()): Promise<void> {
    if (!this.proactive.settings().enabled) return;
    const settings = this.store.settings(), owner = this.proactive.owner;
    if (settings.calendarLeadMinutes > 0) {
      const meta = this.store.meta();
      if (meta.lastCalendarPoll === null || now - meta.lastCalendarPoll >= CALENDAR_POLL_MS) {
        const range = await readCalendarRange(this.calendarCredentials(), planningDay(now, this.timezone), 2, this.timezone) as
          { days: { coverage: string; issues?: string[]; events: { id?: string; title: string; start: string; end: string; allDay?: boolean; tentative?: boolean }[] }[] };
        const events = range.days.flatMap(day => day.events.filter(event => !event.allDay)
          .map(event => ({ key: `${event.start}|${event.title}`.slice(0, 300), title: event.title, start: event.start, end: event.end, tentative: event.tentative === true })));
        const issue = range.days.flatMap(day => day.issues ?? [])[0] ?? null;
        // A failed read keeps the previous cache instead of looking like an empty calendar.
        if (!issue || events.length) this.store.replaceEvents(events, now);
        if (!issue) this.onCalendar?.(range.days.flatMap(day => day.events.filter(event => !event.allDay)), now);
        this.store.writeMeta({ lastCalendarPoll: now, calendarIssue: issue });
      }
      for (const event of this.store.events(now)) {
        const start = Date.parse(event.start), key = `cal:${event.key}`;
        if (start - settings.calendarLeadMinutes * MINUTE > now || this.store.sent(key)) continue;
        const quiet = this.quiet(now);
        if (quiet === undefined) break;
        this.store.markSent(key, now);
        if (!quiet) owner.enqueue(`alert:${key}`, "telegram", `${event.tentative ? "Tentative, " : ""}at ${this.clock(start)}: ${event.title} (in ${Math.max(1, Math.round((start - now) / MINUTE))} min).`);
      }
    }
    if (settings.dueSoon) {
      for (const nudge of this.nudges(now)) {
        if (nudge.at > now || now >= nudge.until || this.store.sent(nudge.key)) continue;
        const quiet = this.quiet(now);
        if (quiet === undefined) break;
        if (quiet) continue; // Deferred until quiet hours end, while still useful.
        this.store.markSent(nudge.key, now);
        owner.enqueue(`alert:${nudge.key}`, "telegram", nudge.text);
      }
    }
    if (settings.stalled) {
      const live = new Set(this.proactive.wakeups().filter(wake => wake.status === "scheduled" || wake.status === "running").map(wake => wake.commitmentId));
      for (const commitment of this.proactive.commitments()) {
        if (!["active", "blocked"].includes(commitment.status) || this.ownedCommitment(commitment.id) || commitment.nextReviewAt || live.has(commitment.id)) continue;
        if (Date.parse(commitment.updatedAt) > now - STALLED_AFTER_MS) continue;
        const key = `stalled:${commitment.id}:v${commitment.version}`;
        if (this.store.sent(key)) continue;
        const dueAt = this.proactive.notificationDueAt(now);
        if (dueAt === undefined) break;
        this.store.markSent(key, now);
        this.proactive.triggerEvent(commitment.id, dueAt);
      }
    }
  }

  nextDue(now = Date.now()): number | undefined {
    if (!this.proactive.settings().enabled) return;
    const settings = this.store.settings(), due: number[] = [];
    if (settings.calendarLeadMinutes > 0) {
      const last = this.store.meta().lastCalendarPoll;
      due.push(last === null ? now : last + CALENDAR_POLL_MS);
      const next = this.store.events(now).find(event => !this.store.sent(`cal:${event.key}`));
      if (next) due.push(Date.parse(next.start) - settings.calendarLeadMinutes * MINUTE);
    }
    if (settings.dueSoon) for (const nudge of this.nudges(now)) if (now < nudge.until && !this.store.sent(nudge.key)) due.push(nudge.at);
    if (settings.stalled) {
      for (const commitment of this.proactive.commitments()) {
        if (["active", "blocked"].includes(commitment.status) && !this.ownedCommitment(commitment.id) && !commitment.nextReviewAt && !this.store.sent(`stalled:${commitment.id}:v${commitment.version}`)) {
          due.push(Date.parse(commitment.updatedAt) + STALLED_AFTER_MS);
        }
      }
    }
    return due.length ? Math.max(now, Math.min(...due)) : undefined;
  }

  status(now = Date.now()): object {
    const meta = this.store.meta(), settings = this.store.settings();
    return { settings, lastCalendarPoll: meta.lastCalendarPoll === null ? null : iso(meta.lastCalendarPoll), calendarIssue: meta.calendarIssue,
      upcomingEvents: this.store.events(now).length, nextAt: this.nextDue(now) === undefined ? null : iso(this.nextDue(now)!) };
  }
}
