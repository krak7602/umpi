import { createHash, randomUUID } from "node:crypto";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import { isPlanInline, mergeDailyPlan, planningDay, planningDayBounds, shiftPlanningDay, type PlanEntry, type PlanSection } from "../shared/daily-planning.js";
import { InputError, record } from "../shared/protocol.js";
import { vaultNoteRevision } from "../shared/vault-planning.js";
import type { MailStore } from "./mail-store.js";
import type { PlanningStore } from "./planning-store.js";
import type { VaultPlanningClient } from "./planning-runtime.js";
import type { ProactiveStore } from "./proactive-store.js";
import type { SituationFact, SituationStore } from "./situation-store.js";
import { readCalendarRange } from "./situation-tools.js";
import { StateError, type Database } from "./store.js";
import { readJson } from "./transport.js";

/**
 * Code-owned daily-note writes: yesterday's close-out into Done / changed, intra-day additions
 * (new calendar events, owner requests), and plan-vs-done check-ins. Every line carries a marker,
 * so a retried write never duplicates and owner lines are never edited.
 */
export interface JournalSettings { version: number; closeOut: boolean; intraDay: boolean; checkIns: string[] }
interface QueuedEntry { key: string; day: string; section: PlanSection; text: string; certainty?: "tentative"; urgent: boolean; status: "queued" | "written" | "failed"; attempts: number; issue: string | null; createdAt: number; updatedAt: number }

const MINUTE = 60_000, HOUR = 60 * MINUTE;
const FLUSH_INTERVAL_MS = HOUR;
const RETRY_MS = 10 * MINUTE;
const MAX_ATTEMPTS = 5;
const CHECK_IN_WINDOW_MS = 2 * HOUR;
const CLOSE_OUT_LINES = 18;
const TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

const iso = (now: number) => new Date(now).toISOString();
const shortId = (prefix: string, value: string) => `${prefix}-${createHash("sha256").update(value).digest("hex").slice(0, 16)}`;
/** One readable inline line, or nothing. */
function line(text: string): string | undefined {
  const cleaned = text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").replace(/<!--|-->/g, "").replace(/\s+/g, " ").trim().slice(0, 240)
    .replace(/^(?:#{1,6}\s+|[-+*>]\s+|\d+[.)]\s+|\[[ xX]\]\s+)+/, "").trim();
  return cleaned && isPlanInline(cleaned) ? cleaned : undefined;
}
function money(fact: SituationFact): string {
  if (!fact.amount) return "";
  const value = fact.amount.value.toLocaleString("en-IN", { maximumFractionDigits: 2 });
  return fact.amount.currency === "INR" ? ` (₹${value})` : ` (${value} ${fact.amount.currency})`;
}
/** Plain wording for one observed state change. Untracked combinations fall back to "title: state". */
export function closeOutLine(fact: SituationFact, state: string): string | undefined {
  const label = state.replace(/_/g, " ");
  const verbs: Record<string, Record<string, string>> = {
    order: { ordered: "Ordered", shipped: "Shipped", out_for_delivery: "Out for delivery", delivered: "Delivered", cancelled: "Order cancelled", return_requested: "Return requested", refunded: "Refunded" },
    job: { applied: "Applied", assessment: "Assessment received", interview: "Interview scheduled", offer: "Offer", rejected: "Rejected", withdrawn: "Withdrew", follow_up: "Follow-up" },
    subscription: { renewed: "Renewed", active: "Subscribed", trial: "Trial started", cancelled: "Cancelled", payment_failed: "Payment failed", price_change: "Price change" },
    bill: { paid: "Paid", overdue: "Overdue" },
    booking: { confirmed: "Booked", booked: "Booked", registered: "Registered", cancelled: "Booking cancelled" },
    account: {},
    update: {},
  };
  if (fact.kind === "spend" || (fact.kind === "bill" && state === "due")) return;
  const verb = verbs[fact.kind]?.[state];
  if (fact.kind === "account") return line(`Account alert: ${fact.title}`);
  if (fact.kind === "update") return line(fact.title);
  return line(verb ? `${verb}: ${fact.title}${["ordered", "renewed", "paid", "active"].includes(state) ? money(fact) : ""}` : `${fact.title}: ${label}`);
}

export class JournalStore {
  constructor(readonly db: Database) {
    for (const sql of [
      "CREATE TABLE IF NOT EXISTS umpi_journal_settings (id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL)",
      "CREATE TABLE IF NOT EXISTS umpi_journal_entries (key TEXT PRIMARY KEY, day TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL)",
      "CREATE INDEX IF NOT EXISTS umpi_journal_queue ON umpi_journal_entries(status,day)",
      "CREATE TABLE IF NOT EXISTS umpi_journal_marks (key TEXT PRIMARY KEY, at INTEGER NOT NULL)",
    ]) this.db.all(sql);
    this.db.all("INSERT OR IGNORE INTO umpi_journal_settings VALUES (1,?)", JSON.stringify({ version: 1, closeOut: true, intraDay: true, checkIns: ["13:00", "18:00"] } satisfies JournalSettings));
  }
  settings(): JournalSettings { return JSON.parse(this.db.all<{ data: string }>("SELECT data FROM umpi_journal_settings WHERE id=1")[0]!.data) as JournalSettings; }
  configure(value: unknown): JournalSettings {
    const body = record(value);
    if (Object.keys(body).some(key => !["expectedVersion", "closeOut", "intraDay", "checkIns"].includes(key))) throw new InputError("Unknown journal setting");
    const previous = this.settings();
    if (body.expectedVersion !== previous.version) throw new StateError(409, "Journal settings changed; read the current version");
    for (const key of ["closeOut", "intraDay"] as const) if (body[key] !== undefined && typeof body[key] !== "boolean") throw new InputError(`${key} must be a boolean`);
    if (body.checkIns !== undefined && (!Array.isArray(body.checkIns) || body.checkIns.length > 4 || body.checkIns.some(time => typeof time !== "string" || !TIME.test(time)))) {
      throw new InputError("checkIns must be up to four local HH:mm times");
    }
    const settings: JournalSettings = { version: previous.version + 1, closeOut: (body.closeOut as boolean | undefined) ?? previous.closeOut,
      intraDay: (body.intraDay as boolean | undefined) ?? previous.intraDay, checkIns: body.checkIns ? [...new Set(body.checkIns as string[])].sort() : previous.checkIns };
    this.db.all("UPDATE umpi_journal_settings SET data=? WHERE id=1", JSON.stringify(settings));
    return settings;
  }
  mark(key: string): number | undefined { return this.db.all<{ at: number }>("SELECT at FROM umpi_journal_marks WHERE key=?", key)[0]?.at; }
  setMark(key: string, at: number): void { this.db.all("INSERT INTO umpi_journal_marks VALUES (?,?) ON CONFLICT(key) DO UPDATE SET at=excluded.at", key, at); }
  /** Queue once per key; a key already written or queued is not repeated. */
  queue(day: string, entries: { key: string; section: PlanSection; text: string; certainty?: "tentative" }[], urgent: boolean, now: number): number {
    let added = 0;
    for (const entry of entries) {
      const text = line(entry.text);
      if (!text) continue;
      const data: QueuedEntry = { key: entry.key, day, section: entry.section, text, ...(entry.certainty ? { certainty: entry.certainty } : {}), urgent, status: "queued", attempts: 0, issue: null, createdAt: now, updatedAt: now };
      const before = this.db.all("SELECT key FROM umpi_journal_entries WHERE key=?", entry.key).length;
      this.db.all("INSERT OR IGNORE INTO umpi_journal_entries VALUES (?,?,?,?)", entry.key, day, "queued", JSON.stringify(data));
      if (!before) added++;
    }
    return added;
  }
  queued(): QueuedEntry[] {
    return this.db.all<{ data: string }>("SELECT data FROM umpi_journal_entries WHERE status='queued' ORDER BY day, rowid").map(row => JSON.parse(row.data) as QueuedEntry);
  }
  settle(entries: QueuedEntry[], status: QueuedEntry["status"], issue: string | null, now: number): void {
    this.db.transaction(() => {
      for (const entry of entries) {
        const attempts = entry.attempts + (status === "written" ? 0 : 1);
        const final = status === "written" ? "written" : attempts >= MAX_ATTEMPTS ? "failed" : "queued";
        this.db.all("UPDATE umpi_journal_entries SET status=?, data=? WHERE key=?", final, JSON.stringify({ ...entry, status: final, attempts, issue, updatedAt: now }), entry.key);
      }
      this.db.all("DELETE FROM umpi_journal_entries WHERE status<>'queued' AND json_extract(data,'$.updatedAt') < ?", now - 45 * 24 * HOUR);
      this.db.all("DELETE FROM umpi_journal_marks WHERE at < ?", now - 45 * 24 * HOUR);
    });
  }
  status(): object {
    const counts = this.db.all<{ status: string; count: number }>("SELECT status,count(*) AS count FROM umpi_journal_entries GROUP BY status");
    const lastIssue = this.db.all<{ data: string }>("SELECT data FROM umpi_journal_entries WHERE json_extract(data,'$.issue') IS NOT NULL ORDER BY json_extract(data,'$.updatedAt') DESC LIMIT 1")[0];
    return { settings: this.settings(), entries: Object.fromEntries(counts.map(row => [row.status, row.count])), lastIssue: lastIssue ? (JSON.parse(lastIssue.data) as QueuedEntry).issue : null };
  }
}

/** Open and done tasks in the note's Tasks section (owner and planner lines alike). */
export function noteTasks(text: string): { open: string[]; done: string[] } {
  const lines = text.split(/\r?\n/), open: string[] = [], done: string[] = [];
  let level = 0;
  for (const raw of lines) {
    const heading = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(raw);
    if (heading) { level = heading[2]!.trim().toLowerCase() === "tasks" ? heading[1]!.length : level && heading[1]!.length > level ? level : 0; continue; }
    if (!level) continue;
    const task = /^\s*[-+*]\s+\[([ xX])\]\s+(.*)$/.exec(raw);
    if (!task) continue;
    const label = task[2]!.replace(/\s*<!-- umpi-plan:[A-Za-z0-9._:-]+ -->\s*$/, "").trim();
    if (label) (task[1] === " " ? open : done).push(label);
  }
  return { open, done };
}

export interface JournalSources {
  vault: () => VaultPlanningClient | undefined;
  planning: PlanningStore;
  situation: SituationStore;
  mail: MailStore;
  calendarCredentials: () => string | undefined;
  ownedCommitment: (id: string) => boolean;
  track: (work: Promise<unknown>) => void;
  wake: () => Promise<void>;
}

export class JournalRuntime {
  private working?: Promise<void>;
  constructor(readonly store: JournalStore, private readonly proactive: ProactiveStore, private readonly sources: JournalSources) {}
  get timezone(): string { return this.proactive.timezone; }
  wake(): Promise<void> { return this.sources.wake(); }
  private clock(instant: number): string {
    return new Intl.DateTimeFormat("en-GB", { timeZone: this.timezone, hour: "2-digit", minute: "2-digit" }).format(instant);
  }
  private at(day: string, time: string): number {
    const [hours, minutes] = time.split(":").map(Number) as [number, number];
    return Date.parse(planningDayBounds(day, this.timezone).start) + hours * HOUR + minutes * MINUTE;
  }
  /** Today's note is written by morning preparation; never race it with another write. */
  private planningBusy(day: string): boolean {
    const plan = this.sources.planning.plan(day);
    return !!this.sources.planning.pending() || (!!plan && ["requested", "ready", "applying"].includes(plan.status));
  }

  /** Owner request from conversation: written on the next drive, not batched. */
  add(day: string, section: PlanSection, text: string, now = Date.now()): { key: string; day: string } {
    const today = planningDay(now, this.timezone);
    let target: string;
    try { target = shiftPlanningDay(day, 0); } catch { throw new InputError("day must be a valid local date"); }
    if (target < shiftPlanningDay(today, -7) || target > shiftPlanningDay(today, 7)) throw new InputError("Daily-note additions target a note within seven days of today");
    if (!line(text)) throw new InputError("The note line must be one readable line of text");
    const key = `note-${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    this.store.queue(target, [{ key, section, text }], true, now);
    return { key, day: target };
  }

  /** New timed calendar events for today, from the default-check calendar cache. Identities match the planner's. */
  calendarEvents(events: { id?: string; title: string; start: string; end: string; tentative?: boolean }[], now = Date.now()): void {
    if (!this.store.settings().intraDay) return;
    const today = planningDay(now, this.timezone);
    const entries = events.filter(event => event.id && planningDay(Date.parse(event.start), this.timezone) === today && Date.parse(event.start) > now)
      .map(event => ({ key: event.id!, section: "schedule" as const, text: `${this.clock(Date.parse(event.start))}–${this.clock(Date.parse(event.end))} ${event.title}`, ...(event.tentative ? { certainty: "tentative" as const } : {}) }));
    if (entries.length) this.store.queue(today, entries, false, now);
  }

  /** Factual lines for a finished day. No model call: every line comes from recorded state. */
  async closeOut(day: string, now = Date.now()): Promise<{ key: string; section: PlanSection; text: string }[]> {
    const bounds = planningDayBounds(day, this.timezone), start = Date.parse(bounds.start), end = Date.parse(bounds.end);
    const lines: { key: string; section: PlanSection; text: string }[] = [];
    const push = (key: string, text: string | undefined) => { if (text && lines.length < CLOSE_OUT_LINES) lines.push({ key: shortId("done", `${day}|${key}`), section: "done", text }); };
    const calendar = await readCalendarRange(this.sources.calendarCredentials(), day, 1, this.timezone) as { days: { events: { title: string; start: string; allDay?: boolean }[] }[] };
    const meetings = (calendar.days[0]?.events ?? []).filter(event => !event.allDay).map(event => `${this.clock(Date.parse(event.start))} ${event.title}`);
    if (meetings.length) push("meetings", line(`Meetings: ${meetings.slice(0, 6).join("; ")}${meetings.length > 6 ? `; +${meetings.length - 6} more` : ""}`));
    for (const commitment of this.proactive.commitments()) {
      if (commitment.status === "completed" && !this.sources.ownedCommitment(commitment.id) && !commitment.id.startsWith("rollout-")) {
        const at = Date.parse(commitment.updatedAt);
        if (at >= start && at < end) push(`commitment:${commitment.id}`, line(`Completed: ${commitment.purpose}`));
      }
    }
    for (const change of this.sources.situation.changedBetween(start, end)) {
      // Spends are summarized as one total below.
      if (change.fact.kind !== "spend") push(`${change.fact.id}:${change.state}`, closeOutLine(change.fact, change.state));
    }
    const spends = this.sources.situation.active(["spend"], start).filter(fact => fact.amount?.direction === "debit" && Date.parse(fact.observedAt) >= start && Date.parse(fact.observedAt) < end);
    const byCurrency = new Map<string, number>();
    for (const fact of spends) byCurrency.set(fact.amount!.currency, (byCurrency.get(fact.amount!.currency) ?? 0) + fact.amount!.value);
    if (spends.length) {
      const totals = [...byCurrency].map(([currency, value]) => currency === "INR" ? `₹${Math.round(value).toLocaleString("en-IN")}` : `${value.toFixed(2)} ${currency}`).join(" + ");
      const largest = [...spends].sort((a, b) => b.amount!.value - a.amount!.value).slice(0, 3).map(fact => `${fact.counterparty ?? fact.title}${money(fact)}`).join(", ");
      push("spending", line(spends.length === 1 ? `Spent ${totals} (${spends[0]!.counterparty ?? spends[0]!.title})` : `Spent ${totals} in ${spends.length} payments (largest: ${largest})`));
    }
    const mail = this.sources.mail.attention(50).filter(thread => Date.parse(thread.receivedAt) >= start && Date.parse(thread.receivedAt) < end);
    if (mail.length) push("mail", line(`Mail that needed you: ${mail.slice(0, 3).map(thread => thread.subject).join("; ")}${mail.length > 3 ? `; +${mail.length - 3} more` : ""}`));
    return lines;
  }

  private async checkIn(time: string, now: number): Promise<void> {
    const client = this.sources.vault(), day = planningDay(now, this.timezone);
    if (!client) return;
    const snapshot = await client.getSnapshot(day);
    const tasks = snapshot.target ? noteTasks(snapshot.target) : { open: [], done: [] };
    const total = tasks.open.length + tasks.done.length;
    if (!total) return;
    const label = Number(time.slice(0, 2)) < 15 ? "Midday check-in" : "Evening check-in";
    const open = tasks.open.slice(0, 5).join("; ") + (tasks.open.length > 5 ? `; +${tasks.open.length - 5} more` : "");
    const text = tasks.open.length
      ? `${label}: ${tasks.done.length} of ${total} tasks done. Still open: ${open}. Want to move or drop anything?`
      : `${label}: all ${total} tasks done.`;
    const quiet = this.proactive.notificationDueAt(now);
    if (quiet === undefined || quiet > now) return;
    this.proactive.owner.enqueue(`journal:checkin:${day}:${time}`, "telegram", text);
  }

  private async write(day: string, entries: QueuedEntry[], client: VaultPlanningClient, now: number): Promise<void> {
    try {
      const snapshot = await client.getSnapshot(day);
      if (snapshot.revision !== vaultNoteRevision(snapshot.target)) throw new Error("note revision mismatch");
      // No previous baselines: existing marked lines are kept as written, and an entry whose marker exists is not repeated.
      const patchEntries: PlanEntry[] = entries.map(entry => ({ id: entry.key, section: entry.section, text: entry.text, ...(entry.certainty ? { certainty: entry.certainty } : {}) }));
      const merged = mergeDailyPlan({ day, current: snapshot.target, template: snapshot.template, previous: [], patch: { entries: patchEntries, coverage: [] } });
      if (merged.text === snapshot.target) { this.store.settle(entries, "written", null, now); return; }
      const result = await client.applyNote({ intentId: `journal-${randomUUID()}`, day, beforeRevision: snapshot.revision, text: merged.text, expiresAt: iso(now + 15 * MINUTE) });
      if (result.status === "synced" && result.revision === vaultNoteRevision(merged.text)) {
        this.store.settle(entries, "written", null, now);
        this.store.setMark(`lastwrite:${day}`, now);
      } else {
        this.store.settle(entries, "queued", result.status === "conflict" ? "The note changed during the write; it will be retried from the current note." : "The note upload was not confirmed; it will be retried.", now);
      }
    } catch (error) {
      this.store.settle(entries, "queued", error instanceof Error && /unavailable|provision/i.test(error.message) ? "The private note workspace is unavailable." : "The note write failed; it will be retried.", now);
    }
  }

  private async work(now: number): Promise<void> {
    const settings = this.store.settings(), today = planningDay(now, this.timezone), yesterday = shiftPlanningDay(today, -1);
    const client = this.sources.vault();
    if (!client) return;
    // Close out yesterday once, after this morning's preparation time.
    if (settings.closeOut && !this.store.mark(`closeout:${yesterday}`) && now >= this.at(today, this.sources.planning.settings().time)) {
      this.store.setMark(`closeout:${yesterday}`, now);
      this.store.queue(yesterday, await this.closeOut(yesterday, now), true, now);
    }
    for (const time of settings.checkIns) {
      const due = this.at(today, time), key = `checkin:${today}:${time}`;
      if (now < due || now >= due + CHECK_IN_WINDOW_MS || this.store.mark(key)) continue;
      this.store.setMark(key, now);
      try { await this.checkIn(time, now); } catch { /* the note was unavailable; a missed check-in is not retried */ }
    }
    const byDay = new Map<string, QueuedEntry[]>();
    for (const entry of this.store.queued()) byDay.set(entry.day, [...(byDay.get(entry.day) ?? []), entry]);
    for (const [day, entries] of byDay) {
      if (day === today && this.planningBusy(day)) continue;
      const lastWrite = this.store.mark(`lastwrite:${day}`) ?? 0, lastTry = Math.max(...entries.map(entry => entry.attempts ? entry.updatedAt : 0));
      const urgent = entries.some(entry => entry.urgent);
      if (lastTry && now - lastTry < RETRY_MS) continue;
      if (!urgent && now - lastWrite < FLUSH_INTERVAL_MS) continue;
      await this.write(day, entries, client, now);
    }
  }

  /** Vault work runs in the background so the coordinator never waits on a container. */
  drive(now = Date.now()): void {
    if (!this.proactive.settings().enabled || this.working || !this.sources.vault() || this.nextDue(now) === undefined || this.nextDue(now)! > now) return;
    this.working = this.work(now).finally(() => { this.working = undefined; void this.sources.wake(); });
    this.sources.track(this.working);
  }

  nextDue(now = Date.now()): number | undefined {
    if (!this.proactive.settings().enabled || !this.sources.vault()) return;
    const settings = this.store.settings(), today = planningDay(now, this.timezone), yesterday = shiftPlanningDay(today, -1), tomorrow = shiftPlanningDay(today, 1);
    const due: number[] = [];
    const planningTime = this.sources.planning.settings().time;
    if (settings.closeOut) due.push(this.store.mark(`closeout:${yesterday}`) ? this.at(tomorrow, planningTime) : Math.max(now, this.at(today, planningTime)));
    for (const time of settings.checkIns) {
      const todayAt = this.at(today, time);
      due.push(!this.store.mark(`checkin:${today}:${time}`) && now < todayAt + CHECK_IN_WINDOW_MS ? Math.max(now, todayAt) : this.at(tomorrow, time));
    }
    const byDay = new Map<string, QueuedEntry[]>();
    for (const entry of this.store.queued()) byDay.set(entry.day, [...(byDay.get(entry.day) ?? []), entry]);
    for (const [day, entries] of byDay) {
      const lastTry = Math.max(...entries.map(entry => entry.attempts ? entry.updatedAt : 0));
      const ready = entries.some(entry => entry.urgent) ? now : (this.store.mark(`lastwrite:${day}`) ?? 0) + FLUSH_INTERVAL_MS;
      due.push(Math.max(ready, lastTry ? lastTry + RETRY_MS : 0, day === today && this.planningBusy(day) ? now + 5 * MINUTE : 0));
    }
    return due.length ? Math.max(now, Math.min(...due)) : undefined;
  }

  status(now = Date.now()): object { const next = this.nextDue(now); return { ...this.store.status(), nextAt: next === undefined ? null : iso(next) }; }
}

export function journalTools(runtime: JournalRuntime, isBackground: (conversationId: string) => boolean): ToolRegistration[] {
  return [defineTool({ name: "add_to_daily_note", description: "Write one line into the owner's Obsidian daily note when they ask to note, log, add, or record something there. section: tasks (an unchecked task), schedule (a timed item), done (something that happened), notes (a free note), or links. Defaults to today's note. The line is written within a few minutes; it never edits the owner's existing lines.",
    parameters: Type.Object({
      text: Type.String({ minLength: 1, maxLength: 240 }),
      section: Type.Union([Type.Literal("tasks"), Type.Literal("schedule"), Type.Literal("done"), Type.Literal("notes"), Type.Literal("links")]),
      day: Type.Optional(Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "Local date; defaults to today. Within seven days of today." })),
    }, { additionalProperties: false }), replay: "safe",
    async execute(input, api) {
      try {
        if (isBackground(String(api.conversationId))) throw new StateError(403, "Daily-note additions are for the owner's own conversation");
        const body = record(input);
        const day = typeof body.day === "string" ? body.day : planningDay(Date.now(), runtime.timezone);
        const queued = runtime.add(day, body.section as PlanSection, String(body.text));
        await runtime.wake();
        return { content: [{ type: "text", text: JSON.stringify({ queued: true, day: queued.day, note: "Queued for the daily note; it is written within a few minutes. It is not confirmed yet." }) }] };
      } catch (error) {
        return { isError: true, content: [{ type: "text", text: error instanceof InputError || error instanceof StateError ? error.message : "The note line could not be queued." }] };
      }
    } })];
}

export const JOURNAL_INSTRUCTIONS = `The owner's Obsidian daily note is the record of each day. For questions about today's plan or schedule, read today's note first with read_daily_plan and refresh=true, and use read_calendar only when the note has no schedule or to check for events added since the morning. When the owner asks to note, log, or add something to their daily note, use add_to_daily_note; it confirms queueing, not the written note. Yesterday's Done / changed section is filled automatically each morning from recorded facts.`;

/** The parent router authenticates the owner control credential before calling this. */
export async function journalRequest(request: Request, runtime: JournalRuntime, wake: () => Promise<void>): Promise<Response | undefined> {
  const path = new URL(request.url).pathname;
  if (path === "/api/journal" && request.method === "GET") return Response.json(runtime.status());
  if (path === "/api/journal/settings" && request.method === "PUT") {
    const settings = runtime.store.configure(await readJson(request, 4_096));
    await wake();
    return Response.json(settings);
  }
}
