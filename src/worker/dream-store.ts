import { nextPlanningTime, planningDay, planningDayBounds, shiftPlanningDay } from "../shared/daily-planning.js";
import { InputError, boundedText, record } from "../shared/protocol.js";
import { ProactiveStore, type Commitment, type ProactiveRun, type RetryPolicy } from "./proactive-store.js";
import { StateError, type Database } from "./store.js";
import type { HistoryIndex } from "./history-index.js";

/**
 * The nightly run ("dream"). Once a night one background review reads the owner's day and writes a day digest, the
 * week (and at month end, the month) summary, open loops, the owner's standing instructions word for word, probe
 * questions, notes for the morning, and itemized lesson edits. Code then builds the anchored summary that replaces
 * the day's conversation history, so each day starts small. Digests stay searchable.
 */
export const DREAM_COMMITMENT_ID = "nightly-dream";
export const DREAM_DEFAULT_TIME = "02:00";
export const DREAM_RETRY: RetryPolicy = { everyMinutes: 60, maxAttempts: 3 };
const MAX_ACTIVE_LESSONS = 30;
const MAX_LESSON_EDITS = 5;
const DIGEST_DAYS_KEPT = 400;
/** A conversation part handed to the night at a time; the night reads every part. */
export const DREAM_PART_CHARS = 60_000;
const PASSAGE_CHARS = 2_000;
const PASSAGE_OVERLAP_CHARS = 600;
const MAX_NOTES = 6, NOTE_CHARS = 6_000;

/** Splits a note into passages of about PASSAGE_CHARS at paragraph or line breaks. */
export function notePassages(text: string): string[] {
  const passages: string[] = [];
  let current = "";
  for (const line of text.split("\n")) {
    // A break is taken at a line end; only a line longer than a passage is cut inside.
    if (current && current.length + line.length + 1 > PASSAGE_CHARS && line.length <= PASSAGE_CHARS) { passages.push(current.trim()); current = ""; }
    current += (current ? "\n" : "") + line;
    while (current.length > PASSAGE_CHARS) { passages.push(current.slice(0, PASSAGE_CHARS).trim()); current = current.slice(PASSAGE_CHARS); }
  }
  if (current.trim()) passages.push(current.trim());
  return passages;
}
/** A day this long is closed early with the anchored summary, before the 550k threshold. */
export const LONG_DAY_TOKENS = 450_000;
const LONG_DAY_GAP_MS = 3 * 3_600_000;

/** `firstDay` is the first day a scheduled night closes, so enabling late in a day does not close the day before. */
export interface DreamSettings { version: number; enabled: boolean; time: string; firstDay?: string }
export interface Probe { question: string; answer: string }
export interface DayDigest {
  summary: string;
  decisions: string[];
  standingInstructions: string[];
  openLoops: { ref: string | null; text: string }[];
  people: string[];
  topics: string[];
  /** What lasts from files and reference material the owner shared, kept as the understanding instead of the raw text. */
  notes?: { title: string; text: string }[];
}
export interface Night {
  day: string;
  version: number;
  status: "requested" | "committed" | "compacted";
  manual: boolean;
  runId: string | null;
  /** The start of the conversation this night reads. */
  since: string;
  requestedAt: string;
  committedAt: string | null;
  probes: Probe[];
  overnight: { whileYouSlept: string[]; tomorrow: string[] } | null;
  lessonEdits: number;
  /** Reply drafts saved on mail items overnight. */
  drafts?: number;
  compaction: { at: string; sessions: number; failed: number; probesKept: number; probesRepaired: number; error?: string } | null;
}
export interface Digest { id: string; level: "day" | "week" | "month" | "year"; period: string; text: string; data: DayDigest | null; updatedAt: string }
/** A day's conversation line; `file` names a document the owner shared, which is read overnight but not indexed raw. */
export interface TranscriptLine { at: number; text: string; file?: string }
export interface Lesson {
  id: string; version: number; text: string; status: "active" | "retired";
  /** Nights whose evidence confirmed the lesson; a well-supported lesson is kept over a newer one when merging. */
  support?: number;
  history: { version: number; text: string; status: "active" | "retired"; at: string; by: "dream" | "owner"; evidence: string | null }[];
}

const iso = (now: number) => new Date(now).toISOString();
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
function texts(value: unknown, max: number, each: number, label: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > max) throw new InputError(`${label} must be a list of at most ${max}`);
  return value.map(item => boundedText(item, each, label).trim()).filter(Boolean);
}
function keys(body: Record<string, unknown>, allowed: string[], label: string): void {
  const unknown = Object.keys(body).find(key => !allowed.includes(key));
  if (unknown) throw new InputError(`Unknown ${label} field: ${unknown}`);
}
function commitmentEdit(commitment: Commitment) {
  const { purpose, source, nextAction, blocker, status, nextReviewAt, jobId } = commitment;
  return { expectedVersion: commitment.version, purpose, source, nextAction, blocker, status, nextReviewAt, jobId };
}
/** ISO week id ("2026-W44") of a local date. */
export function weekOf(day: string): string {
  const date = new Date(`${day}T00:00:00Z`), weekday = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - weekday + 3);
  const firstThursday = new Date(Date.UTC(date.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((date.getTime() - firstThursday.getTime()) / 86_400_000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

export class DreamStore {
  readonly db: Database;
  /** Validates that an open-loop reference names a live record (commitment, reminder, mail item, choice). */
  refExists: (ref: string) => boolean = () => false;
  /** Saves an overnight reply draft on a mail item that needs the owner; false when the item no longer waits. */
  saveDraft: (mailId: string, text: string, now: number) => boolean = () => false;
  /** Digests and conversation text go here for history search. */
  index?: HistoryIndex;
  constructor(readonly proactive: ProactiveStore) {
    this.db = proactive.db;
    for (const sql of [
      "CREATE TABLE IF NOT EXISTS umpi_dream_settings (id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL)",
      "CREATE TABLE IF NOT EXISTS umpi_dream_nights (day TEXT PRIMARY KEY, data TEXT NOT NULL)",
      "CREATE TABLE IF NOT EXISTS umpi_digests (id TEXT PRIMARY KEY, level TEXT NOT NULL, period TEXT NOT NULL, search TEXT NOT NULL, data TEXT NOT NULL)",
      "CREATE INDEX IF NOT EXISTS umpi_digest_level ON umpi_digests(level,period)",
      "CREATE TABLE IF NOT EXISTS umpi_lessons (id TEXT PRIMARY KEY, status TEXT NOT NULL, data TEXT NOT NULL)",
      "CREATE TABLE IF NOT EXISTS umpi_dream_parts (day TEXT NOT NULL, part INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY (day, part))",
    ]) this.db.all(sql);
    this.db.all("INSERT OR IGNORE INTO umpi_dream_settings VALUES (1,?)", JSON.stringify({ version: 1, enabled: false, time: DREAM_DEFAULT_TIME } satisfies DreamSettings));
  }
  get timezone(): string { return this.proactive.timezone; }
  private rows<T>(sql: string, ...bindings: (string | number | null)[]): T[] {
    return this.db.all<{ data: string }>(sql, ...bindings).map(row => JSON.parse(row.data) as T);
  }
  settings(): DreamSettings { return this.rows<DreamSettings>("SELECT data FROM umpi_dream_settings WHERE id=1")[0]!; }
  night(day: string): Night | undefined { return this.rows<Night>("SELECT data FROM umpi_dream_nights WHERE day=?", day)[0]; }
  lastNight(before?: string): Night | undefined {
    return this.rows<Night>(`SELECT data FROM umpi_dream_nights WHERE json_extract(data,'$.status')<>'requested'${before ? " AND day<?" : ""} ORDER BY day DESC LIMIT 1`, ...(before ? [before] : []))[0];
  }
  private saveNight(night: Night): Night {
    this.db.all("INSERT INTO umpi_dream_nights VALUES (?,?) ON CONFLICT(day) DO UPDATE SET data=excluded.data", night.day, JSON.stringify(night));
    return night;
  }
  private commitment(): Commitment | undefined { return this.proactive.commitment(DREAM_COMMITMENT_ID); }
  ownsCommitment(id: string): boolean { return id === DREAM_COMMITMENT_ID && !!this.commitment(); }
  ownsSession(sessionId: string): boolean {
    const run = this.proactive.runForSession(sessionId);
    return !!run && this.ownsCommitment(run.commitmentId);
  }

  configure(value: unknown, sessionId: string, now = Date.now()): DreamSettings {
    const body = record(value); keys(body, ["expectedVersion", "enabled", "time"], "dream setting");
    if (typeof body.enabled !== "boolean") throw new InputError("Dream settings require enabled");
    const time = body.time === undefined ? this.settings().time : body.time;
    if (typeof time !== "string" || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new InputError("Dream time must be local HH:mm");
    return this.db.transaction(() => {
      const previous = this.settings();
      if (body.expectedVersion !== previous.version) throw new StateError(409, "Dream settings changed; read the current version");
      const firstDay = shiftPlanningDay(planningDay(nextPlanningTime(now, this.timezone, time), this.timezone), -1);
      const settings: DreamSettings = { version: previous.version + 1, enabled: body.enabled as boolean, time, ...(body.enabled ? { firstDay: previous.enabled && previous.firstDay ? previous.firstDay : firstDay } : {}) };
      this.db.all("UPDATE umpi_dream_settings SET data=? WHERE id=1", JSON.stringify(settings));
      const current = this.commitment();
      if (settings.enabled && !current) {
        this.proactive.createCommitment({ id: DREAM_COMMITMENT_ID, purpose: "Close the owner's day overnight: digest it, keep open loops and standing instructions, prepare the morning, and learn from corrections",
          source: "Owner-enabled nightly run", nextAction: "Use read_dream_inputs, then commit_dream.", blocker: null, status: "active", nextReviewAt: null, jobId: null, allowNotify: false, retry: DREAM_RETRY }, "telegram", sessionId, now);
      } else if (current && current.status !== (settings.enabled ? "active" : "cancelled")) {
        this.proactive.updateCommitment(current.id, { ...commitmentEdit(current), status: settings.enabled ? "active" : "cancelled", nextReviewAt: null, blocker: null }, now);
      }
      return settings;
    });
  }
  private scheduledAt(day: string): number {
    return nextPlanningTime(Date.parse(planningDayBounds(day, this.timezone).start) - 1, this.timezone, this.settings().time);
  }
  due(now = Date.now()): boolean {
    if (!this.settings().enabled || !this.proactive.settings().enabled || !this.commitment()) return false;
    const today = planningDay(now, this.timezone);
    if (this.scheduledAt(today) > now) return false;
    const day = shiftPlanningDay(today, -1), night = this.night(day), first = this.settings().firstDay;
    if (first && day < first) return false;
    // A manual run during that day covered only part of it, so the scheduled night still runs.
    return !night || (night.manual && night.status !== "requested" && Date.parse(night.requestedAt) < Date.parse(planningDayBounds(day, this.timezone).end));
  }
  nextDue(now = Date.now()): number | undefined {
    if (!this.settings().enabled || !this.proactive.settings().enabled) return;
    return this.due(now) ? now : nextPlanningTime(now, this.timezone, this.settings().time);
  }
  private request(day: string, manual: boolean, now: number): Night {
    const previous = this.night(day), last = this.lastNight();
    const since = last?.committedAt ?? planningDayBounds(day, this.timezone).start;
    const night = this.saveNight({ day, version: (previous?.version ?? 0) + 1, status: "requested", manual, runId: null, since, requestedAt: iso(now),
      committedAt: null, probes: [], overnight: null, lessonEdits: 0, compaction: null });
    this.proactive.setRetryPolicy(DREAM_COMMITMENT_ID, DREAM_RETRY);
    this.proactive.triggerEvent(DREAM_COMMITMENT_ID, now);
    return night;
  }
  drive(now = Date.now()): void {
    if (!this.due(now)) return;
    this.db.transaction(() => { if (this.due(now)) this.request(shiftPlanningDay(planningDay(now, this.timezone), -1), false, now); });
  }
  /**
   * Closes a very long day early, so its compaction uses the anchored summary rather than the 550k threshold's
   * generic one. At most once in three hours; the scheduled night still closes the whole day.
   */
  closeLongDay(contextTokens: number[], now = Date.now()): boolean {
    if (!contextTokens.some(tokens => tokens >= LONG_DAY_TOKENS) || !this.settings().enabled || !this.commitment() || !this.proactive.settings().enabled) return false;
    const latest = this.rows<Night>("SELECT data FROM umpi_dream_nights ORDER BY json_extract(data,'$.requestedAt') DESC LIMIT 1")[0];
    if (latest && (latest.status === "requested" || latest.status === "committed" || now - Date.parse(latest.requestedAt) < LONG_DAY_GAP_MS)) return false;
    this.requestNow(now);
    return true;
  }
  /** Runs the night for today so far, for a check or after a long day. */
  requestNow(now = Date.now()): Night {
    if (!this.proactive.settings().enabled) throw new StateError(409, "Follow-through is paused in /schedule; enable it first");
    if (!this.commitment() || !this.settings().enabled) throw new StateError(409, "Enable the nightly run first");
    return this.db.transaction(() => this.request(planningDay(now, this.timezone), true, now));
  }
  /** The night the current owned review works on. */
  forSession(sessionId: string, now = Date.now()): { run: ProactiveRun; night: Night } {
    const run = this.proactive.assertRunCurrent(sessionId, now);
    if (!this.ownsCommitment(run.commitmentId)) throw new StateError(403, "This review does not own the nightly run");
    const night = this.rows<Night>("SELECT data FROM umpi_dream_nights ORDER BY json_extract(data,'$.requestedAt') DESC LIMIT 1")[0];
    if (!night || (night.status !== "requested" && night.runId !== run.id)) throw new StateError(409, "No nightly run was requested");
    return { run, night };
  }

  // Digests ------------------------------------------------------------------------------------------------------
  digest(id: string): Digest | undefined { return this.rows<Digest>("SELECT data FROM umpi_digests WHERE id=?", id)[0]; }
  private saveDigest(digest: Digest): void {
    const search = `${digest.text}\n${JSON.stringify(digest.data ?? {})}`.toLowerCase();
    this.db.all("INSERT INTO umpi_digests VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET search=excluded.search,data=excluded.data", digest.id, digest.level, digest.period, search, JSON.stringify(digest));
    const extra = digest.data ? [...digest.data.decisions.map(text => `Decision: ${text}`), ...digest.data.openLoops.map(loop => `Open: ${loop.text}`)].join("\n") : "";
    this.index?.put([{ id: digest.id, source: "digest", period: digest.period, at: Date.parse(digest.updatedAt), text: `${digest.level} ${digest.period}: ${digest.text}${extra ? `\n${extra}` : ""}` }]);
    if (digest.level === "day" && this.index) {
      // Each note is searchable on its own, in passages small enough for the reranker; a rewritten day replaces them.
      const passages = (digest.data?.notes ?? []).flatMap((note, index) => notePassages(note.text).map((text, part) =>
        ({ id: `note:${digest.period}:${index}:${part}`, source: "digest" as const, period: digest.period, at: Date.parse(digest.updatedAt), text: `Note ${digest.period}, ${note.title}${part ? " (continued)" : ""}: ${text}` })));
      this.index.removeExcept(`note:${digest.period}:`, passages.map(passage => passage.id));
      this.index.put(passages);
    }
  }
  dayDigests(from: string, to: string): Digest[] {
    return this.rows<Digest>("SELECT data FROM umpi_digests WHERE level='day' AND period>=? AND period<=? ORDER BY period", from, to);
  }
  /** Puts digests written before the index existed into it; unchanged passages are skipped. */
  backfillIndex(): void {
    if (!this.index) return;
    for (const digest of this.rows<Digest>("SELECT data FROM umpi_digests")) this.saveDigest(digest);
  }
  monthDigests(year: string): { month: string; summary: string }[] {
    return this.rows<Digest>("SELECT data FROM umpi_digests WHERE level='month' AND period LIKE ? ORDER BY period", `${year}-%`).map(digest => ({ month: digest.period, summary: digest.text }));
  }
  /** The conversation since the last night, in parts the night reads one by one. */
  saveParts(day: string, lines: TranscriptLine[]): number {
    const parts: TranscriptLine[][] = [[]]; let size = 0;
    for (const line of lines) {
      if (size + line.text.length > DREAM_PART_CHARS && parts.at(-1)!.length) { parts.push([]); size = 0; }
      parts.at(-1)!.push(line); size += line.text.length + 1;
    }
    this.db.transaction(() => {
      this.db.all("DELETE FROM umpi_dream_parts WHERE day=?", day);
      parts.forEach((part, index) => this.db.all("INSERT INTO umpi_dream_parts VALUES (?,?,?)", day, index + 1, JSON.stringify(part)));
      this.db.all("DELETE FROM umpi_dream_parts WHERE day < ?", shiftPlanningDay(day, -7));
    });
    return parts.length;
  }
  partCount(day: string): number { return this.db.all<{ n: number }>("SELECT count(*) AS n FROM umpi_dream_parts WHERE day=?", day)[0]!.n; }
  part(day: string, part: number): TranscriptLine[] {
    const row = this.db.all<{ data: string }>("SELECT data FROM umpi_dream_parts WHERE day=? AND part=?", day, part)[0];
    if (!row) throw new StateError(404, `There is no conversation part ${part}`);
    return JSON.parse(row.data) as TranscriptLine[];
  }
  /** The day's conversation text becomes searchable passages of about 2,000 characters. */
  private indexConversation(day: string): void {
    if (!this.index) return;
    const passages: { at: number; lines: string[]; size: number }[] = [];
    for (let part = 1; part <= this.partCount(day); part++) for (const line of this.part(day, part)) {
      if (line.file) continue;
      const last = passages.at(-1);
      if (!last || last.size + line.text.length > PASSAGE_CHARS) {
        // A passage starts with the previous passage's last line, so a question and its answer are not split apart.
        const carried = last?.lines.at(-1);
        const lines = carried && carried.length <= PASSAGE_OVERLAP_CHARS ? [carried, line.text] : [line.text];
        passages.push({ at: line.at, lines, size: lines.reduce((sum, text) => sum + text.length + 1, 0) });
      } else { last.lines.push(line.text); last.size += line.text.length + 1; }
    }
    this.index.put(passages.map((passage, index) => ({ id: `conv:${day}:${passage.at}:${index}`, source: "conversation", period: day, at: passage.at, text: passage.lines.join("\n") })));
  }

  // Lessons ------------------------------------------------------------------------------------------------------
  lessons(includeRetired = false): Lesson[] {
    return this.rows<Lesson>(`SELECT data FROM umpi_lessons${includeRetired ? "" : " WHERE status='active'"} ORDER BY id`);
  }
  private saveLesson(lesson: Lesson): void {
    this.db.all("INSERT INTO umpi_lessons VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,data=excluded.data", lesson.id, lesson.status, JSON.stringify(lesson));
  }
  private editLesson(edit: unknown, by: "dream" | "owner", now: number): void {
    const body = record(edit); keys(body, ["op", "id", "text", "evidence"], "lesson edit");
    const evidence = body.evidence === undefined ? null : boundedText(body.evidence, 300, "lesson evidence").trim() || null;
    if (body.op === "add") {
      if (this.lessons().length >= MAX_ACTIVE_LESSONS) throw new InputError(`At most ${MAX_ACTIVE_LESSONS} active lessons; retire or merge one first`);
      const text = boundedText(body.text, 300, "lesson text").trim();
      const next = this.db.all<{ n: number }>("SELECT count(*) AS n FROM umpi_lessons")[0]!.n + 1;
      const id = `L${next}`;
      this.saveLesson({ id, version: 1, text, status: "active", history: [{ version: 1, text, status: "active", at: iso(now), by, evidence }] });
      return;
    }
    if (body.op !== "update" && body.op !== "retire" && body.op !== "reinforce") throw new InputError("Lesson op must be add, update, reinforce, or retire");
    const old = typeof body.id === "string" ? this.rows<Lesson>("SELECT data FROM umpi_lessons WHERE id=?", body.id)[0] : undefined;
    if (!old) throw new InputError("Unknown lesson id");
    // Reinforcing counts the evidence without changing the rule, so the history stays a list of real edits.
    if (body.op === "reinforce") { if (old.status === "active") this.saveLesson({ ...old, support: (old.support ?? 0) + 1 }); return; }
    const text = body.op === "update" ? boundedText(body.text, 300, "lesson text").trim() : old.text, status = body.op === "retire" ? "retired" as const : "active" as const;
    this.saveLesson({ ...old, version: old.version + 1, text, status, history: [...old.history, { version: old.version + 1, text, status, at: iso(now), by, evidence }].slice(-12) });
  }
  /** Owner action: return a lesson to an earlier version, or retire it. Every change stays in its history. */
  revertLesson(id: string, version: number | "retire", now = Date.now()): Lesson {
    return this.db.transaction(() => {
      const old = this.rows<Lesson>("SELECT data FROM umpi_lessons WHERE id=?", id)[0];
      if (!old) throw new StateError(404, "Unknown lesson");
      if (version === "retire") this.editLesson({ op: "retire", id, evidence: "Retired by the owner" }, "owner", now);
      else {
        const target = old.history.find(entry => entry.version === version);
        if (!target) throw new InputError("That lesson version is not in its history");
        this.saveLesson({ ...old, version: old.version + 1, text: target.text, status: target.status,
          history: [...old.history, { version: old.version + 1, text: target.text, status: target.status, at: iso(now), by: "owner" as const, evidence: `Reverted to version ${version}` }].slice(-12) });
      }
      return this.rows<Lesson>("SELECT data FROM umpi_lessons WHERE id=?", id)[0]!;
    });
  }
  /** The playbook section in the system prompt. Empty when nothing was learned yet. */
  playbook(): string {
    const active = this.lessons();
    if (!active.length) return "";
    return `Lessons learned from the owner's corrections. They are applied automatically; the owner can list or revert them with list_lessons and revert_lesson. Follow them unless the owner says otherwise now:\n${active.map(lesson => `- ${lesson.id}: ${lesson.text}`).join("\n")}`;
  }

  // Commit -------------------------------------------------------------------------------------------------------
  commit(sessionId: string, value: unknown, now = Date.now()): Night {
    const body = record(value); keys(body, ["digest", "week", "month", "year", "probes", "lessons", "overnight", "drafts"], "nightly result");
    const raw = record(body.digest); keys(raw, ["summary", "decisions", "standingInstructions", "openLoops", "people", "topics", "notes"], "digest");
    const digest: DayDigest = {
      summary: boundedText(raw.summary, 6_000, "digest summary").trim(),
      decisions: texts(raw.decisions, 25, 300, "decisions"),
      standingInstructions: texts(raw.standingInstructions, 25, 500, "standing instructions"),
      openLoops: (raw.openLoops === undefined ? [] : Array.isArray(raw.openLoops) && raw.openLoops.length <= 40 ? raw.openLoops : (() => { throw new InputError("openLoops must be a list of at most 40"); })())
        .map(item => { const loop = record(item); keys(loop, ["ref", "text"], "open loop");
          return { ref: typeof loop.ref === "string" && loop.ref ? loop.ref : null, text: boundedText(loop.text, 300, "open loop").trim() }; }),
      people: texts(raw.people, 30, 80, "people"),
      topics: texts(raw.topics, 30, 80, "topics"),
    };
    const notes = (raw.notes === undefined || raw.notes === null ? [] : Array.isArray(raw.notes) && raw.notes.length <= MAX_NOTES ? raw.notes : (() => { throw new InputError(`At most ${MAX_NOTES} notes a day`); })())
      .map(item => { const note = record(item); keys(note, ["title", "text"], "note");
        return { title: boundedText(note.title, 120, "note title").trim(), text: boundedText(note.text, NOTE_CHARS, "note text").trim() }; })
      .filter(note => note.title && note.text);
    if (notes.length) digest.notes = notes;
    if (!digest.summary) throw new InputError("The day digest needs a summary");
    // Loops that point at records are kept only while those records exist; free-text loops stay as written.
    digest.openLoops = digest.openLoops.filter(loop => loop.ref === null || this.refExists(loop.ref));
    const week = body.week === undefined || body.week === null ? null : boundedText(body.week, 4_000, "week summary").trim() || null;
    const month = body.month === undefined || body.month === null ? null : boundedText(body.month, 6_000, "month summary").trim() || null;
    const year = body.year === undefined || body.year === null ? null : boundedText(body.year, 8_000, "year summary").trim() || null;
    const drafts = (body.drafts === undefined ? [] : Array.isArray(body.drafts) && body.drafts.length <= 10 ? body.drafts : (() => { throw new InputError("At most 10 drafts a night"); })())
      .map(item => { const draft = record(item); keys(draft, ["mailId", "text"], "draft"); return { mailId: boundedText(draft.mailId, 80, "mail id"), text: boundedText(draft.text, 3_000, "draft text").trim() }; });
    const probes = (Array.isArray(body.probes) ? body.probes : []).slice(0, 8).map(item => { const probe = record(item); keys(probe, ["question", "answer"], "probe");
      return { question: boundedText(probe.question, 300, "probe question").trim(), answer: boundedText(probe.answer, 300, "probe answer").trim() }; });
    const edits = body.lessons === undefined ? [] : Array.isArray(body.lessons) && body.lessons.length <= MAX_LESSON_EDITS ? body.lessons : (() => { throw new InputError(`At most ${MAX_LESSON_EDITS} lesson edits a night`); })();
    const overnightRaw = body.overnight === undefined || body.overnight === null ? null : record(body.overnight);
    if (overnightRaw) keys(overnightRaw, ["whileYouSlept", "tomorrow"], "overnight");
    const overnight = overnightRaw ? { whileYouSlept: texts(overnightRaw.whileYouSlept, 8, 400, "whileYouSlept"), tomorrow: texts(overnightRaw.tomorrow, 8, 400, "tomorrow") } : null;
    return this.db.transaction(() => {
      const { run, night } = this.forSession(sessionId, now);
      if (night.status !== "requested") return night;
      // The inputs include any earlier digest of this day, and the model writes the whole day, so this replaces it.
      const updatedAt = iso(now);
      this.saveDigest({ id: `day:${night.day}`, level: "day", period: night.day, text: digest.summary, data: digest, updatedAt });
      if (week) this.saveDigest({ id: `week:${weekOf(night.day)}`, level: "week", period: weekOf(night.day), text: week, data: null, updatedAt });
      if (month) this.saveDigest({ id: `month:${night.day.slice(0, 7)}`, level: "month", period: night.day.slice(0, 7), text: month, data: null, updatedAt });
      if (year) this.saveDigest({ id: `year:${night.day.slice(0, 4)}`, level: "year", period: night.day.slice(0, 4), text: year, data: null, updatedAt });
      this.indexConversation(night.day);
      this.index?.prune("conversation", Date.parse(planningDayBounds(shiftPlanningDay(night.day, -DIGEST_DAYS_KEPT), this.timezone).start));
      const drafted = drafts.filter(draft => draft.text && this.saveDraft(draft.mailId, draft.text, now)).length;
      let applied = 0;
      for (const edit of edits) { try { this.editLesson(edit, "dream", now); applied++; } catch (error) { if (!(error instanceof InputError)) throw error; } }
      this.db.all("DELETE FROM umpi_digests WHERE level='day' AND period < ?", shiftPlanningDay(night.day, -DIGEST_DAYS_KEPT));
      this.index?.pruneDays(shiftPlanningDay(night.day, -DIGEST_DAYS_KEPT));
      return this.saveNight({ ...night, version: night.version + 1, status: "committed", runId: run.id, committedAt: updatedAt, probes, overnight, lessonEdits: applied, drafts: drafted });
    });
  }
  finishInput(sessionId: string, original: unknown, now = Date.now()): Record<string, unknown> {
    const { run, night } = this.forSession(sessionId, now);
    if (night.status === "requested" || night.runId !== run.id) throw new StateError(409, "Commit the nightly result before finishing this review");
    return { ...record(original), outcome: "advanced", note: `Closed ${night.day}: digest written, ${night.probes.length} probe(s), ${night.lessonEdits} lesson edit(s).`,
      nextReviewAt: null, nextAction: "Wait for the next night.", blocker: null, notification: undefined };
  }

  /** The committed night whose summary has not replaced the conversation history yet. */
  pendingCompaction(): Night | undefined {
    return this.rows<Night>("SELECT data FROM umpi_dream_nights WHERE json_extract(data,'$.status')='committed' ORDER BY day DESC LIMIT 1")[0];
  }
  compacted(day: string, result: Night["compaction"]): void {
    this.db.transaction(() => { const night = this.night(day); if (night?.status === "committed") this.saveNight({ ...night, version: night.version + 1, status: "compacted", compaction: result }); });
  }
  /** Notes for this morning's brief from the night that just ran. */
  overnightFor(now = Date.now()): Night["overnight"] {
    const night = this.lastNight();
    return night?.overnight && night.committedAt && now - Date.parse(night.committedAt) < 20 * 3_600_000 ? night.overnight : null;
  }

  /**
   * The anchored summary that replaces the conversation history up to the night. Standing instructions are kept
   * word for word; open loops carry their record IDs; yesterday is in detail; the rest of the week is brief; older
   * history is a search away. `repairs` are probe answers the summary was found to miss.
   */
  anchoredSummary(day: string, repairs: Probe[] = []): string {
    const week = this.dayDigests(shiftPlanningDay(day, -6), day), today = week.at(-1);
    if (!today?.data || today.period !== day) throw new StateError(409, "The day digest is missing");
    const instructions = [...new Set(week.flatMap(digest => digest.data?.standingInstructions ?? []))].slice(-40);
    const loops = today.data.openLoops;
    const earlier = week.slice(0, -1).map(digest => `- ${digest.period}: ${digest.text.replace(/\s+/g, " ").slice(0, 400)}`);
    const weekSummary = this.digest(`week:${weekOf(day)}`)?.text;
    return [
      `[Nightly summary of the conversation through ${day}. Earlier messages were replaced by this summary.]`,
      instructions.length ? `Standing instructions from the owner, in their words:\n${instructions.map(text => `- "${text}"`).join("\n")}` : "",
      loops.length ? `Open loops (check current state with tools before acting; IDs name live records):\n${loops.map(loop => `- ${loop.ref ? `[${loop.ref}] ` : ""}${loop.text}`).join("\n")}` : "",
      `${day} in detail:\n${today.text}${today.data.decisions.length ? `\nDecisions:\n${today.data.decisions.map(text => `- ${text}`).join("\n")}` : ""}`,
      earlier.length ? `Earlier this week:\n${earlier.join("\n")}` : "",
      weekSummary ? `This week so far: ${weekSummary}` : "",
      repairs.length ? `Details kept from ${day}:\n${repairs.map(probe => `- ${probe.question} ${probe.answer}`).join("\n")}` : "",
      "Older history: use search_history and read_history (day, week, and month digests).",
    ].filter(Boolean).join("\n\n");
  }

  status(now = Date.now()): object {
    const settings = this.settings(), last = this.lastNight();
    const counts = this.db.all<{ level: string; n: number }>("SELECT level, count(*) AS n FROM umpi_digests GROUP BY level");
    return { settings, nextAt: this.nextDue(now) === undefined ? null : iso(this.nextDue(now)!),
      lastNight: last ? { day: last.day, status: last.status, manual: last.manual, committedAt: last.committedAt, probes: last.probes.length, lessonEdits: last.lessonEdits, drafts: last.drafts ?? 0, compaction: last.compaction } : null,
      digests: Object.fromEntries(counts.map(row => [row.level, row.n])), lessons: this.lessons().length, history: this.index?.status() ?? null };
  }
}

export function validDay(value: unknown): string {
  if (typeof value !== "string" || !DAY_RE.test(value)) throw new InputError("Use a local date such as 2026-10-30");
  return value;
}
