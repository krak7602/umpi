import { nextPlanningTime, planningDay, planningDayBounds } from "../shared/daily-planning.js";
import { InputError, boundedText, record } from "../shared/protocol.js";
import { ProactiveStore, type Commitment, type ProactiveRun } from "./proactive-store.js";
import { StateError, type Database } from "./store.js";

export const BRIEF_COMMITMENT_ID = "morning-brief";
export const BRIEF_DEFAULT_TIME = "03:30";
const BRIEF_MAX_CHARS = 3_500;

export interface BriefSettings { version: number; enabled: boolean; time: string }
export interface BriefRecord {
  day: string;
  version: number;
  status: "requested" | "committed";
  manual: boolean;
  runId: string | null;
  text: string | null;
  requestedAt: string;
  committedAt: string | null;
}

const iso = (now: number) => new Date(now).toISOString();
function commitmentEdit(commitment: Commitment) {
  const { purpose, source, nextAction, blocker, status, nextReviewAt, jobId } = commitment;
  return { expectedVersion: commitment.version, purpose, source, nextAction, blocker, status, nextReviewAt, jobId };
}

/** One scheduled, owner-enabled brief per local day. The text is model-written; scheduling and delivery rights are code-owned. */
export class BriefStore {
  readonly db: Database;
  constructor(readonly proactive: ProactiveStore) {
    this.db = proactive.db;
    for (const sql of [
      "CREATE TABLE IF NOT EXISTS umpi_brief_settings (id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL)",
      "CREATE TABLE IF NOT EXISTS umpi_briefs (day TEXT PRIMARY KEY, data TEXT NOT NULL)",
    ]) this.db.all(sql);
    this.db.all("INSERT OR IGNORE INTO umpi_brief_settings VALUES (1,?)", JSON.stringify({ version: 1, enabled: false, time: BRIEF_DEFAULT_TIME } satisfies BriefSettings));
  }
  get timezone(): string { return this.proactive.timezone; }
  private rows<T>(sql: string, ...bindings: (string | number | null)[]): T[] {
    return this.db.all<{ data: string }>(sql, ...bindings).map(row => JSON.parse(row.data) as T);
  }
  private save(brief: BriefRecord): BriefRecord {
    this.db.all("INSERT INTO umpi_briefs VALUES (?,?) ON CONFLICT(day) DO UPDATE SET data=excluded.data", brief.day, JSON.stringify(brief));
    this.db.all("DELETE FROM umpi_briefs WHERE day < ?", planningDay(Date.parse(brief.requestedAt) - 30 * 86_400_000, this.timezone));
    return brief;
  }
  settings(): BriefSettings { return this.rows<BriefSettings>("SELECT data FROM umpi_brief_settings WHERE id=1")[0]!; }
  brief(day: string): BriefRecord | undefined { return this.rows<BriefRecord>("SELECT data FROM umpi_briefs WHERE day=?", day)[0]; }
  /** The previous delivered brief bounds "what changed" for the next one. */
  lastCommitted(before?: string): BriefRecord | undefined {
    return this.rows<BriefRecord>(`SELECT data FROM umpi_briefs WHERE json_extract(data,'$.status')='committed'${before ? " AND day<?" : ""} ORDER BY day DESC LIMIT 1`, ...(before ? [before] : []))[0];
  }
  private commitment(): Commitment | undefined { return this.proactive.commitment(BRIEF_COMMITMENT_ID); }
  ownsCommitment(id: string): boolean { return id === BRIEF_COMMITMENT_ID && !!this.commitment(); }
  private ensureCommitment(sessionId: string, now: number): void {
    const previous = this.commitment();
    if (!previous) {
      this.proactive.createCommitment({ id: BRIEF_COMMITMENT_ID, purpose: "Write the owner's daily morning brief from their current situation, calendar, and plan",
        source: "Owner-enabled morning brief", nextAction: "Use read_brief_inputs, then commit_brief. Stay quiet when nothing matters.", blocker: null,
        status: "active", nextReviewAt: null, jobId: null, allowNotify: true }, "telegram", sessionId, now);
      return;
    }
    if (previous.status !== "active") this.proactive.updateCommitment(previous.id, { ...commitmentEdit(previous), status: "active", nextReviewAt: null, blocker: null }, now);
  }
  configure(value: unknown, sessionId: string, now = Date.now()): BriefSettings {
    const body = record(value);
    if (Object.keys(body).some(key => !["expectedVersion", "enabled", "time"].includes(key))) throw new InputError("Unknown brief setting");
    if (typeof body.enabled !== "boolean") throw new InputError("Brief settings require enabled");
    const time = body.time === undefined ? this.settings().time : body.time;
    if (typeof time !== "string" || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new InputError("Brief time must be local HH:mm");
    if (this.proactive.owner.isBackgroundSession(sessionId) || this.proactive.owner.channelForSession(sessionId) !== "telegram") throw new StateError(403, "Brief settings require the owner Telegram conversation");
    return this.db.transaction(() => {
      const previous = this.settings();
      if (body.expectedVersion !== previous.version) throw new StateError(409, "Brief settings changed; read the current version");
      const settings: BriefSettings = { version: previous.version + 1, enabled: body.enabled as boolean, time };
      this.db.all("UPDATE umpi_brief_settings SET data=? WHERE id=1", JSON.stringify(settings));
      if (settings.enabled) this.ensureCommitment(sessionId, now);
      // Enabling after today's time starts tomorrow; "Brief now" covers an immediate one.
      const today = planningDay(now, this.timezone);
      if (settings.enabled && !previous.enabled && !this.brief(today) && this.scheduledAt(today) <= now) {
        this.save({ day: today, version: 1, status: "committed", manual: false, runId: null, text: null, requestedAt: iso(now), committedAt: null });
      }
      return settings;
    });
  }
  private scheduledAt(day: string): number {
    return nextPlanningTime(Date.parse(planningDayBounds(day, this.timezone).start) - 1, this.timezone, this.settings().time);
  }
  /** One local date, not a 24-hour interval: a late alarm sends today's brief once and never builds a backlog. */
  due(now = Date.now()): boolean {
    if (!this.settings().enabled || !this.proactive.settings().enabled) return false;
    const today = planningDay(now, this.timezone);
    return !this.brief(today) && this.scheduledAt(today) <= now;
  }
  nextDue(now = Date.now()): number | undefined {
    if (!this.settings().enabled || !this.proactive.settings().enabled) return;
    return this.due(now) ? now : nextPlanningTime(now, this.timezone, this.settings().time);
  }
  private request(manual: boolean, now: number): BriefRecord {
    const day = planningDay(now, this.timezone), previous = this.brief(day);
    if (!this.commitment()) throw new StateError(409, "Enable the morning brief in /brief first");
    const brief = this.save({ day, version: (previous?.version ?? 0) + 1, status: "requested", manual, runId: null, text: null, requestedAt: iso(now), committedAt: null });
    this.proactive.triggerEvent(BRIEF_COMMITMENT_ID, now);
    return brief;
  }
  drive(now = Date.now()): void {
    if (!this.due(now)) return;
    this.db.transaction(() => { if (this.due(now)) this.request(false, now); });
  }
  requestNow(now = Date.now()): BriefRecord {
    if (!this.proactive.settings().enabled) throw new StateError(409, "Follow-through is paused in /schedule; enable it before requesting a brief");
    return this.db.transaction(() => this.request(true, now));
  }
  forSession(sessionId: string, now = Date.now()): { run: ProactiveRun; brief: BriefRecord } {
    const run = this.proactive.assertRunCurrent(sessionId, now);
    if (!this.ownsCommitment(run.commitmentId)) throw new StateError(403, "This proactive review does not own the morning brief");
    const brief = this.brief(planningDay(now, this.timezone));
    if (!brief) throw new StateError(409, "No brief was requested for today");
    return { run, brief };
  }
  commit(sessionId: string, value: unknown, now = Date.now()): BriefRecord {
    const text = value === null ? null : boundedText(value, BRIEF_MAX_CHARS, "brief text").trim() || null;
    return this.db.transaction(() => {
      const { run, brief } = this.forSession(sessionId, now);
      if (brief.status === "committed" && brief.runId === run.id) return brief;
      return this.save({ ...brief, version: brief.version + 1, status: "committed", runId: run.id, text, committedAt: iso(now) });
    });
  }
  finishInput(sessionId: string, original: unknown, now = Date.now()): Record<string, unknown> {
    const { run, brief } = this.forSession(sessionId, now);
    if (brief.status !== "committed" || brief.runId !== run.id) throw new StateError(409, "Commit the brief before finishing this review");
    const body = record(original);
    return brief.text
      ? { ...body, outcome: "advanced", note: `Delivered the ${brief.manual ? "requested" : "scheduled"} brief for ${brief.day}.`, nextReviewAt: null, nextAction: "Wait for the next scheduled brief.", blocker: null, notification: brief.text }
      : { ...body, outcome: "no_action", note: `Nothing worth a brief for ${brief.day}; stayed quiet.`, nextReviewAt: null, nextAction: "Wait for the next scheduled brief.", blocker: null, notification: undefined };
  }
  status(now = Date.now()): object {
    const settings = this.settings(), today = this.brief(planningDay(now, this.timezone));
    return { settings, nextAt: this.nextDue(now) === undefined ? null : iso(this.nextDue(now)!), today: today ? { status: today.status, manual: today.manual, sent: today.text !== null, committedAt: today.committedAt } : null };
  }
}
