import { createHash } from "node:crypto";
import { InputError, boundedText, identifier, record, timestamp } from "../shared/protocol.js";
import { StateError, Store, type Channel, type Database, type Job } from "./store.js";

export class ProactiveCapacityError extends StateError {
  constructor(message: string) { super(409, message); }
}

export const HEARTBEAT_MS = 15 * 60_000;
const BACKOFF_MS = 60_000;
const LIVE = "('active','blocked')";
const LIVE_WAKES = "('scheduled','running')";
type CommitmentStatus = "active" | "blocked" | "completed" | "cancelled";
export interface Commitment {
  id: string; version: number; purpose: string; source: string; nextAction: string; blocker: string | null;
  status: CommitmentStatus; nextReviewAt: string | null; jobId: string | null; channel: Channel;
  originSessionId: string; allowNotify: boolean; createdAt: string; updatedAt: string;
}
export interface Wakeup {
  id: string; version: number; commitmentId: string; commitmentVersion: number; purpose: string;
  dueAt: string; expiresAt: string; repeatEveryMinutes: number | null;
  status: "scheduled" | "running" | "completed" | "cancelled" | "expired"; createdAt: string;
}
export interface ProactiveSettings {
  version: number; enabled: boolean; nextHeartbeatAt: number | null;
  quietHours: { start: string; end: string } | null;
}
type Outcome = "advanced" | "blocked" | "deferred" | "no_action" | "completed";
export interface ProactiveRun {
  id: string; channel: Channel; sessionId: string; commitmentId: string; commitmentVersion: number;
  wakeupId?: string; wakeupVersion?: number; trigger: "heartbeat" | "wakeup" | "event";
  status: "admitted" | "completed" | "failed" | "superseded" | "expired";
  operationId: string; createdAt: string; expiresAt: string; outcome?: Outcome; note?: string;
  foregroundInterrupted?: boolean;
  notification?: { text: string; status: "suppressed" | "deferred" | "enqueued" | "dropped"; reason?: string; dueAt: number; commitmentVersion: number };
}
interface Check { at: string; reason: string }
interface Meta { settings: ProactiveSettings; lastCheck: Check | null }
const live = (commitment: Commitment): boolean => commitment.status === "active" || commitment.status === "blocked";
const iso = (now: number): string => new Date(now).toISOString();
function instant(now: number): number {
  if (!Number.isFinite(now) || !Number.isSafeInteger(now) || Math.abs(now) > 8.64e15) throw new InputError("Invalid current instant");
  return now;
}
function keys(body: Record<string, unknown>, allowed: string[]): void {
  for (const key of Object.keys(body)) if (!allowed.includes(key)) throw new InputError(`Unknown proactive field: ${key}`);
}
function text(value: unknown, max: number, label: string): string {
  const result = boundedText(value, max, label).trim();
  if (!result || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\uD800-\uDFFF]/u.test(result)) throw new InputError(`Invalid ${label}; use well-formed readable text`);
  return result;
}
function version(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) >= Number.MAX_SAFE_INTEGER) throw new InputError("Invalid expectedVersion");
  return value as number;
}
function cas(current: number, expected: unknown): void {
  if (current !== version(expected)) throw new StateError(409, "Proactive record changed; read its current version");
}
function future(value: unknown, now: number, label: string): string {
  const result = timestamp(value, label);
  if (Date.parse(result) <= now) throw new InputError(`${label} must be in the future`);
  return result;
}
function optionalReview(value: unknown, now: number): string | null { return value === null ? null : future(value, now, "nextReviewAt"); }
function commitmentFields(body: Record<string, unknown>, now: number) {
  if (!["active", "blocked", "completed", "cancelled"].includes(body.status as string)) throw new InputError("Invalid commitment status");
  const status = body.status as CommitmentStatus;
  const nextReviewAt = optionalReview(body.nextReviewAt, now);
  if ((status === "completed" || status === "cancelled") && nextReviewAt !== null) throw new InputError("Finished commitments cannot have a next review");
  return {
    purpose: text(body.purpose, 2000, "purpose"), source: text(body.source, 2000, "source"),
    nextAction: text(body.nextAction, 2000, "nextAction"), blocker: body.blocker === null ? null : text(body.blocker, 4000, "blocker"),
    status, nextReviewAt, jobId: body.jobId === null ? null : identifier(body.jobId, "job ID"),
  };
}
function wakeFields(body: Record<string, unknown>, now: number) {
  const dueAt = future(body.dueAt, now, "dueAt"), expiresAt = future(body.expiresAt, Date.parse(dueAt), "expiresAt");
  const repeat = body.repeatEveryMinutes;
  if (repeat !== null && (!Number.isSafeInteger(repeat) || (repeat as number) < 15 || (repeat as number) > 525_600)) throw new InputError("repeatEveryMinutes must be null or an integer from 15 to 525600");
  return { purpose: text(body.purpose, 2000, "purpose"), dueAt, expiresAt, repeatEveryMinutes: repeat as number | null };
}
const COMMITMENT_FIELDS = ["purpose", "source", "nextAction", "blocker", "status", "nextReviewAt", "jobId"];
const WAKE_FIELDS = ["purpose", "dueAt", "expiresAt", "repeatEveryMinutes"];

/** Operational state only: all claims, reports, and outbox writes share the owner's SQLite transaction. */
export class ProactiveStore {
  readonly db: Database;
  private readonly clock: Intl.DateTimeFormat;
  constructor(readonly owner: Store, readonly timezone: string) {
    this.db = owner.db;
    this.clock = new Intl.DateTimeFormat("en-GB", { timeZone: timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    for (const statement of [
      "CREATE TABLE IF NOT EXISTS umpi_proactive_meta (id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL)",
      "CREATE TABLE IF NOT EXISTS umpi_commitments (id TEXT PRIMARY KEY, status TEXT NOT NULL, job_id TEXT, review_due INTEGER, heartbeat_due INTEGER, event_due INTEGER, data TEXT NOT NULL)",
      "CREATE UNIQUE INDEX IF NOT EXISTS umpi_commitment_job ON umpi_commitments(job_id) WHERE status IN ('active','blocked') AND job_id IS NOT NULL",
      "CREATE INDEX IF NOT EXISTS umpi_commitment_reviews ON umpi_commitments(status,review_due)",
      "CREATE INDEX IF NOT EXISTS umpi_commitment_heartbeat ON umpi_commitments(status,heartbeat_due)",
      "CREATE INDEX IF NOT EXISTS umpi_commitment_events ON umpi_commitments(status,event_due)",
      "CREATE TABLE IF NOT EXISTS umpi_wakeups (id TEXT PRIMARY KEY, commitment_id TEXT NOT NULL, status TEXT NOT NULL, due INTEGER NOT NULL, expires INTEGER NOT NULL, data TEXT NOT NULL)",
      "CREATE UNIQUE INDEX IF NOT EXISTS umpi_commitment_wake ON umpi_wakeups(commitment_id) WHERE status IN ('scheduled','running')",
      "CREATE INDEX IF NOT EXISTS umpi_due_wakeups ON umpi_wakeups(status,due)",
      "CREATE TABLE IF NOT EXISTS umpi_proactive_runs (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, commitment_id TEXT NOT NULL, status TEXT NOT NULL, notification_due INTEGER, data TEXT NOT NULL)",
      "CREATE UNIQUE INDEX IF NOT EXISTS umpi_one_proactive_run ON umpi_proactive_runs(status) WHERE status='admitted'",
      "CREATE INDEX IF NOT EXISTS umpi_proactive_run_session ON umpi_proactive_runs(session_id,status)",
      "CREATE INDEX IF NOT EXISTS umpi_proactive_run_commitment ON umpi_proactive_runs(commitment_id,status)",
      "CREATE INDEX IF NOT EXISTS umpi_proactive_notifications ON umpi_proactive_runs(notification_due)",
      "CREATE TABLE IF NOT EXISTS umpi_proactive_notification_texts (commitment_id TEXT NOT NULL, hash TEXT NOT NULL, PRIMARY KEY(commitment_id,hash))",
    ]) this.db.all(statement);
    this.db.all("INSERT OR IGNORE INTO umpi_proactive_meta VALUES (1,?)", JSON.stringify({ settings: { version: 1, enabled: false, nextHeartbeatAt: null, quietHours: null }, lastCheck: null } satisfies Meta));
    owner.onJobCompletion = job => this.onJobCompletion(job);
    owner.onJobCreation = job => this.onJobCreation(job);
  }
  private rows<T>(query: string, ...bindings: (string | number | null)[]): T[] {
    return this.db.all<{ data: string }>(query, ...bindings).map(row => JSON.parse(row.data) as T);
  }
  private meta(): Meta { return this.rows<Meta>("SELECT data FROM umpi_proactive_meta WHERE id=1")[0]!; }
  private writeMeta(meta: Meta): void { this.db.all("UPDATE umpi_proactive_meta SET data=? WHERE id=1", JSON.stringify(meta)); }
  private writeCommitment(commitment: Commitment): void {
    this.db.all("INSERT INTO umpi_commitments (id,status,job_id,review_due,data) VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,job_id=excluded.job_id,review_due=excluded.review_due,data=excluded.data", commitment.id, commitment.status, commitment.jobId, commitment.nextReviewAt === null ? null : Date.parse(commitment.nextReviewAt), JSON.stringify(commitment));
  }
  private writeWakeup(wake: Wakeup): void {
    this.db.all("INSERT INTO umpi_wakeups VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,due=excluded.due,expires=excluded.expires,data=excluded.data", wake.id, wake.commitmentId, wake.status, Date.parse(wake.dueAt), Date.parse(wake.expiresAt), JSON.stringify(wake));
  }
  private writeRun(run: ProactiveRun): void {
    this.db.all("INSERT INTO umpi_proactive_runs VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,notification_due=excluded.notification_due,data=excluded.data", run.id, run.sessionId, run.commitmentId, run.status, run.notification?.status === "deferred" ? run.notification.dueAt : null, JSON.stringify(run));
  }
  settings(): ProactiveSettings { return this.meta().settings; }
  configure(value: unknown, now = Date.now()): ProactiveSettings {
    instant(now); const body = record(value); keys(body, ["expectedVersion", "enabled", "quietHours"]);
    if (typeof body.enabled !== "boolean") throw new InputError("enabled must be a boolean");
    let quietHours: ProactiveSettings["quietHours"] = null;
    if (body.quietHours !== null) {
      const quiet = record(body.quietHours); keys(quiet, ["start", "end"]);
      if (typeof quiet.start !== "string" || typeof quiet.end !== "string" || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(quiet.start) || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(quiet.end) || quiet.start === quiet.end) throw new InputError("quietHours must contain distinct HH:mm start and end");
      quietHours = { start: quiet.start, end: quiet.end };
    }
    return this.db.transaction(() => {
      const meta = this.meta(); cas(meta.settings.version, body.expectedVersion);
      const enabled = body.enabled as boolean;
      const settings: ProactiveSettings = { version: meta.settings.version + 1, enabled, quietHours, nextHeartbeatAt: enabled ? (meta.settings.enabled ? meta.settings.nextHeartbeatAt : now + HEARTBEAT_MS) : null };
      this.writeMeta({ ...meta, settings });
      if (!enabled) for (const run of this.activeRuns()) {
        const commitment = this.commitment(run.commitmentId);
        if (commitment && live(commitment)) {
          if (run.trigger === "event") this.db.all("UPDATE umpi_commitments SET event_due=? WHERE id=?", now, commitment.id);
          else if (run.trigger === "heartbeat") this.db.all("UPDATE umpi_commitments SET heartbeat_due=? WHERE id=?", now, commitment.id);
        }
        if (run.wakeupId) { const wake = this.wakeup(run.wakeupId); if (wake?.status === "running") this.writeWakeup({ ...wake, status: "scheduled" }); }
        this.invalidateRun(run, "superseded", "Proactive scheduling was disabled");
      }
      return settings;
    });
  }
  commitment(id: string): Commitment | undefined { return this.rows<Commitment>("SELECT data FROM umpi_commitments WHERE id=?", identifier(id))[0]; }
  commitments(): Commitment[] { return this.rows(`SELECT data FROM umpi_commitments ORDER BY CASE WHEN status IN ${LIVE} THEN 0 ELSE 1 END,rowid DESC LIMIT 100`); }
  private requireCommitment(id: string): Commitment {
    const commitment = this.commitment(id); if (!commitment) throw new StateError(404, "Unknown commitment"); return commitment;
  }
  private validateJob(commitment: Commitment): void {
    if (!commitment.jobId) return;
    const job = this.owner.job(commitment.jobId);
    if (!job || job.channel !== commitment.channel) throw new StateError(409, "Linked job must exist in the same channel");
    if (live(commitment) && this.db.all(`SELECT id FROM umpi_commitments WHERE job_id=? AND id<>? AND status IN ${LIVE} LIMIT 1`, job.jobId, commitment.id).length) throw new StateError(409, "Job already belongs to another live commitment");
  }
  createCommitment(value: unknown, channel: Channel, originSessionId: string, now = Date.now()): Commitment {
    instant(now); const body = record(value); keys(body, ["id", ...COMMITMENT_FIELDS, "allowNotify"]);
    const id = identifier(body.id, "commitment ID"), fields = commitmentFields(body, now);
    if (channel !== "control" && channel !== "telegram") throw new InputError("Invalid channel");
    identifier(originSessionId, "origin session ID");
    if (typeof body.allowNotify !== "boolean") throw new InputError("allowNotify must be a boolean");
    if (this.owner.isBackgroundSession(originSessionId)) throw new StateError(403, "A background run cannot create commitments");
    if (this.owner.channelForSession(originSessionId) !== channel) throw new StateError(409, "Commitment origin must belong to its channel");
    return this.db.transaction(() => {
      if (this.commitment(id)) throw new StateError(409, "Commitment ID already exists");
      const commitment: Commitment = { id, ...fields, channel, originSessionId, allowNotify: body.allowNotify as boolean, version: 1, createdAt: iso(now), updatedAt: iso(now) };
      this.checkCommitmentCapacity(commitment); this.validateJob(commitment); this.writeCommitment(commitment); return commitment;
    });
  }
  private checkCommitmentCapacity(commitment: Commitment): void {
    if (live(commitment) && this.db.all<{ count: number }>(`SELECT count(*) AS count FROM umpi_commitments WHERE status IN ${LIVE} AND id<>?`, commitment.id)[0]!.count >= 64) throw new ProactiveCapacityError("At most 64 live commitments are allowed");
  }
  updateCommitment(id: string, value: unknown, now = Date.now()): Commitment {
    instant(now); const body = record(value); keys(body, ["expectedVersion", ...COMMITMENT_FIELDS]); const fields = commitmentFields(body, now);
    return this.db.transaction(() => {
      const old = this.requireCommitment(id); cas(old.version, body.expectedVersion);
      const commitment = { ...old, ...fields, version: old.version + 1, updatedAt: iso(now) };
      this.checkCommitmentCapacity(commitment); this.validateJob(commitment);
      this.invalidateCommitment(id, "Commitment changed");
      this.writeCommitment(commitment); this.db.all("UPDATE umpi_commitments SET heartbeat_due=NULL,event_due=NULL WHERE id=?", id);
      return commitment;
    });
  }
  wakeup(id: string): Wakeup | undefined { return this.rows<Wakeup>("SELECT data FROM umpi_wakeups WHERE id=?", identifier(id))[0]; }
  wakeups(): Wakeup[] { return this.rows(`SELECT data FROM umpi_wakeups ORDER BY CASE WHEN status IN ${LIVE_WAKES} THEN 0 ELSE 1 END,due,rowid DESC LIMIT 100`); }
  private requireWakeup(id: string): Wakeup { const wake = this.wakeup(id); if (!wake) throw new StateError(404, "Unknown wakeup"); return wake; }
  scheduleWakeup(value: unknown, now = Date.now()): Wakeup {
    instant(now); const body = record(value); keys(body, ["id", "commitmentId", ...WAKE_FIELDS]);
    const id = identifier(body.id, "wakeup ID"), commitmentId = identifier(body.commitmentId, "commitment ID"), fields = wakeFields(body, now);
    return this.db.transaction(() => {
      const commitment = this.requireCommitment(commitmentId);
      if (!live(commitment)) throw new StateError(409, "A wakeup requires a live commitment");
      if (this.wakeup(id)) throw new StateError(409, "Wakeup ID already exists");
      if (this.liveWake(commitmentId)) throw new StateError(409, "Commitment already has a scheduled or running wakeup");
      if (this.db.all<{ count: number }>(`SELECT count(*) AS count FROM umpi_wakeups WHERE status IN ${LIVE_WAKES}`)[0]!.count >= 64) throw new ProactiveCapacityError("At most 64 live wakeups are allowed");
      const wake: Wakeup = { id, commitmentId, commitmentVersion: commitment.version, ...fields, version: 1, status: "scheduled", createdAt: iso(now) };
      this.writeWakeup(wake); return wake;
    });
  }
  updateWakeup(id: string, value: unknown, now = Date.now()): Wakeup {
    instant(now); const body = record(value); keys(body, ["expectedVersion", ...WAKE_FIELDS]); const fields = wakeFields(body, now);
    return this.db.transaction(() => {
      const old = this.requireWakeup(id); cas(old.version, body.expectedVersion);
      if (old.status !== "scheduled" && old.status !== "running") throw new StateError(409, "Finished wakeup cannot be edited");
      const commitment = this.requireCommitment(old.commitmentId);
      if (!live(commitment) || commitment.version !== old.commitmentVersion) throw new StateError(409, "Wakeup commitment changed");
      this.invalidateWakeRuns(old.id, "Wakeup changed");
      const wake: Wakeup = { ...old, ...fields, version: old.version + 1, status: "scheduled" }; this.writeWakeup(wake); return wake;
    });
  }
  cancelWakeup(id: string, expectedVersion: unknown, now = Date.now()): Wakeup {
    instant(now);
    return this.db.transaction(() => {
      const old = this.requireWakeup(id); cas(old.version, expectedVersion);
      if (old.status !== "scheduled" && old.status !== "running") throw new StateError(409, "Wakeup is already finished");
      this.invalidateWakeRuns(id, "Wakeup cancelled");
      const wake: Wakeup = { ...old, version: old.version + 1, status: "cancelled" }; this.writeWakeup(wake); return wake;
    });
  }
  private liveWake(commitmentId: string): Wakeup | undefined { return this.rows<Wakeup>(`SELECT data FROM umpi_wakeups WHERE commitment_id=? AND status IN ${LIVE_WAKES} LIMIT 1`, commitmentId)[0]; }
  run(id: string): ProactiveRun | undefined { return this.rows<ProactiveRun>("SELECT data FROM umpi_proactive_runs WHERE id=?", identifier(id))[0]; }
  runForSession(sessionId: string): ProactiveRun | undefined { return this.rows<ProactiveRun>("SELECT data FROM umpi_proactive_runs WHERE session_id=? AND status='admitted' LIMIT 1", identifier(sessionId))[0]; }
  private activeRuns(): ProactiveRun[] { return this.rows("SELECT data FROM umpi_proactive_runs WHERE status='admitted'"); }
  private current(run: ProactiveRun, now: number): boolean {
    if (run.status !== "admitted" || Date.parse(run.expiresAt) <= now || !this.settings().enabled) return false;
    const commitment = this.commitment(run.commitmentId);
    if (!commitment || !live(commitment) || commitment.version !== run.commitmentVersion) return false;
    const op = this.owner.operation(run.operationId);
    if (!op || (op.status !== "admitted" && op.status !== "submitted")) return false;
    if (run.wakeupId) {
      const wake = this.wakeup(run.wakeupId);
      if (!wake || wake.version !== run.wakeupVersion || wake.status !== "running" || wake.commitmentVersion !== commitment.version || Date.parse(wake.expiresAt) <= now) return false;
    }
    return true;
  }
  assertRunCurrent(sessionId: string, now = Date.now()): ProactiveRun {
    instant(now); const run = this.runForSession(sessionId);
    if (!run || !this.current(run, now)) throw new StateError(409, "Proactive review is no longer current; no effects are allowed");
    if (this.owner.hasForegroundInput()) throw new StateError(409, "Foreground work has priority; proactive effects must wait");
    return run;
  }
  mayInterrupt(sessionId: string, now = Date.now()): boolean {
    const run = this.runForSession(sessionId);
    return !!run && this.current(run, instant(now)) && !this.owner.hasForegroundInput() && this.requireCommitment(run.commitmentId).allowNotify && !this.isQuiet(now);
  }
  private invalidateRun(run: ProactiveRun, status: "superseded" | "expired" | "failed", note: string): void {
    this.writeRun({ ...run, status, note, ...(run.notification?.status === "deferred" ? { notification: { ...run.notification, status: "dropped" as const, reason: note } } : {}) });
    // Submitted Pi turns retain ownership until they settle; their tools now fail the run guard.
    if (this.owner.operation(run.operationId)?.status === "admitted") this.owner.settle(run.operationId, note, true);
  }
  private invalidateWakeRuns(id: string, note: string): void {
    for (const run of this.activeRuns()) if (run.wakeupId === id) this.invalidateRun(run, "superseded", note);
  }
  private invalidateCommitment(id: string, note: string): void {
    for (const run of this.rows<ProactiveRun>("SELECT data FROM umpi_proactive_runs WHERE commitment_id=? AND (status='admitted' OR notification_due IS NOT NULL)", id)) {
      if (run.status === "admitted") this.invalidateRun(run, "superseded", note);
      else if (run.notification) this.writeRun({ ...run, notification: { ...run.notification, status: "dropped", reason: note } });
    }
    const wake = this.liveWake(id); if (wake) this.writeWakeup({ ...wake, version: wake.version + 1, status: "cancelled" });
  }
  private isQuiet(now: number, quiet = this.settings().quietHours): boolean {
    if (!quiet) return false;
    const local = this.clock.format(now);
    return quiet.start < quiet.end ? local >= quiet.start && local < quiet.end : local >= quiet.start || local < quiet.end;
  }
  private quietEnd(now: number): number {
    const quiet = this.settings().quietHours;
    if (!this.isQuiet(now, quiet)) return now;
    // Minute boundaries preserve wall-clock quiet hours across DST gaps and repeated hours.
    for (let candidate = Math.floor(now / 60_000) * 60_000 + 60_000; candidate <= now + 48 * 60 * 60_000; candidate += 60_000) if (!this.isQuiet(candidate, quiet)) return candidate;
    throw new StateError(409, "Unable to resolve quiet-hours end");
  }
  private onJobCreation(job: Job): void {
    if (!this.owner.isBackgroundSession(job.sessionId)) return;
    const now = Date.now(), run = this.assertRunCurrent(job.sessionId, now);
    if (!this.mayInterrupt(job.sessionId, now)) throw new StateError(403, "Background command approval cannot interrupt without notification permission or during quiet hours");
    const commitment = this.requireCommitment(run.commitmentId);
    if (job.channel !== commitment.channel) throw new StateError(409, "Background job channel does not match its commitment");
    const previous = commitment.jobId ? this.owner.job(commitment.jobId) : undefined;
    if (previous && ["pending_approval", "queued", "running"].includes(previous.status)) throw new StateError(409, "Commitment already has an active job");
    const next = { ...commitment, jobId: job.jobId, updatedAt: iso(now) };
    this.validateJob(next); this.writeCommitment(next);
  }
  private onJobCompletion(job: Job): boolean {
    const commitment = this.rows<Commitment>(`SELECT data FROM umpi_commitments WHERE job_id=? AND status IN ${LIVE} LIMIT 1`, job.jobId)[0];
    if (!commitment) return this.owner.isBackgroundSession(job.sessionId);
    const now = Date.now();
    for (const run of this.activeRuns()) if (run.commitmentId === commitment.id) {
      if (run.wakeupId) { const wake = this.wakeup(run.wakeupId); if (wake?.status === "running") this.writeWakeup({ ...wake, status: "scheduled" }); }
      this.invalidateRun(run, "superseded", "Linked job completed; coalesced into an event review");
    }
    this.db.all("UPDATE umpi_commitments SET event_due=? WHERE id=?", now, commitment.id);
    return true;
  }
  private rearm(wake: Wakeup, now: number, commitmentVersion = wake.commitmentVersion): Wakeup {
    const period = wake.repeatEveryMinutes! * 60_000, due = Date.parse(wake.dueAt);
    const next = due + (Math.floor(Math.max(0, now - due) / period) + 1) * period;
    const expiry = next + Date.parse(wake.expiresAt) - due;
    if (!Number.isFinite(expiry) || expiry > 8.64e15) return { ...wake, version: wake.version + 1, status: "expired" };
    return { ...wake, version: wake.version + 1, commitmentVersion, dueAt: iso(next), expiresAt: iso(expiry), status: "scheduled" };
  }
  /** Called at foreground admission as well as drive, outside a rejected tool's rollback. */
  deferForForeground(now = Date.now()): void {
    instant(now);
    this.db.transaction(() => {
      for (const run of this.activeRuns()) if (!run.foregroundInterrupted) this.writeRun({ ...run, foregroundInterrupted: true });
    });
  }
  private recoverInterrupted(run: ProactiveRun, now: number): boolean {
    if (!run.foregroundInterrupted) return false;
    const commitment = this.commitment(run.commitmentId);
    if (!commitment || !live(commitment) || commitment.version !== run.commitmentVersion) return false;
    this.invalidateRun(run, Date.parse(run.expiresAt) <= now ? "expired" : "failed", "Review deferred for foreground work; responsibility retained");
    const wake = run.wakeupId ? this.wakeup(run.wakeupId) : undefined;
    if (wake?.status === "running" && wake.version === run.wakeupVersion) {
      this.writeWakeup(Date.parse(wake.expiresAt) > now ? { ...wake, status: "scheduled" } : wake.repeatEveryMinutes !== null ? this.rearm(wake, now) : { ...wake, version: wake.version + 1, status: "expired" });
    } else if (!run.wakeupId) {
      this.writeCommitment({ ...commitment, nextReviewAt: iso(now + HEARTBEAT_MS) });
    }
    return true;
  }
  private reconcile(now: number): void {
    for (const run of this.activeRuns()) {
      const op = this.owner.operation(run.operationId);
      if (op?.status === "done" || op?.status === "failed" || !op) {
        if (this.recoverInterrupted(run, now)) continue;
        this.invalidateRun(run, "failed", "Turn ended without a structured proactive review");
        const wake = run.wakeupId ? this.wakeup(run.wakeupId) : undefined;
        if (wake?.status === "running") this.writeWakeup({ ...wake, version: wake.version + 1, status: "cancelled" });
      } else if (!this.current(run, now)) {
        if (this.recoverInterrupted(run, now)) continue;
        this.invalidateRun(run, Date.parse(run.expiresAt) <= now ? "expired" : "superseded", "Review is no longer current");
        const wake = run.wakeupId ? this.wakeup(run.wakeupId) : undefined;
        if (wake?.status === "running") this.writeWakeup({ ...wake, version: wake.version + 1, status: "expired" });
      }
    }
    for (const wake of this.rows<Wakeup>("SELECT data FROM umpi_wakeups WHERE status='scheduled' AND expires<=?", now)) {
      const commitment = this.commitment(wake.commitmentId);
      const valid = commitment && live(commitment) && commitment.version === wake.commitmentVersion;
      this.writeWakeup(valid && wake.repeatEveryMinutes !== null ? this.rearm(wake, now) : { ...wake, version: wake.version + 1, status: "expired" });
    }
  }
  private inflight(): boolean { return this.owner.pendingOperations().some(op => this.owner.isBackgroundSession(op.sessionId)); }
  drive(now: number, foregroundBusy: boolean, sessions: Partial<Record<Channel, string>>): void {
    instant(now);
    this.db.transaction(() => {
      if (foregroundBusy || this.owner.hasForegroundInput()) {
        foregroundBusy = true;
        this.deferForForeground(now);
      }
      this.reconcile(now);
      const meta = this.meta();
      if (!meta.settings.enabled) return;
      const tick = meta.settings.nextHeartbeatAt !== null && meta.settings.nextHeartbeatAt <= now;
      if (tick) {
        this.db.all(`UPDATE umpi_commitments SET heartbeat_due=COALESCE(heartbeat_due,review_due) WHERE status IN ${LIVE} AND review_due<=?`, now);
        meta.settings.nextHeartbeatAt = now + HEARTBEAT_MS;
        meta.lastCheck = { at: iso(now), reason: "No eligible responsibility; no model turn" };
        this.writeMeta(meta);
      }
      this.releaseNotifications(now);
      if (foregroundBusy || this.inflight() || this.activeRuns().length) {
        if (tick) this.writeMeta({ ...this.meta(), lastCheck: { at: iso(now), reason: foregroundBusy ? "Foreground work has priority; review eligibility retained" : "A proactive turn already owns the run" } });
        return;
      }
      const dueWakes = this.rows<Wakeup>("SELECT data FROM umpi_wakeups WHERE status='scheduled' AND due<=? AND expires>? ORDER BY due,rowid LIMIT 64", now, now);
      const dueEvents = this.rows<Commitment>(`SELECT data FROM umpi_commitments WHERE status IN ${LIVE} AND event_due<=? ORDER BY event_due,rowid LIMIT 64`, now);
      const dueReviews = this.rows<Commitment>(`SELECT data FROM umpi_commitments WHERE status IN ${LIVE} AND heartbeat_due<=? ORDER BY heartbeat_due,rowid LIMIT 64`, now);
      const wake = dueWakes.find(candidate => { const target = this.commitment(candidate.commitmentId); return target && sessions[target.channel]; });
      const event = dueEvents.find(candidate => sessions[candidate.channel]);
      const review = dueReviews.find(candidate => sessions[candidate.channel]);
      let commitment: Commitment | undefined, trigger: ProactiveRun["trigger"];
      if (wake) { commitment = this.commitment(wake.commitmentId); trigger = "wakeup"; }
      else if (event) { commitment = event; trigger = "event"; }
      else { commitment = review; trigger = "heartbeat"; }
      if (!commitment) {
        if (dueWakes.length || dueEvents.length || dueReviews.length) this.writeMeta({ ...this.meta(), lastCheck: { at: iso(now), reason: "Background session unavailable; review eligibility retained" } });
        return;
      }
      if (!live(commitment) || (wake && wake.commitmentVersion !== commitment.version)) {
        if (wake) this.writeWakeup({ ...wake, status: "cancelled", version: wake.version + 1 });
        return;
      }
      const sessionId = sessions[commitment.channel]!;
      if (!this.owner.isBackgroundSession(sessionId) || this.owner.channelForSession(sessionId) !== commitment.channel) throw new StateError(409, "Proactive run requires the registered background channel session");
      // An event and due custom wake are claimed together; neither leaves an immediate duplicate turn.
      const coalescedWake = wake ?? this.liveWake(commitment.id);
      const claimWake = coalescedWake?.status === "scheduled" && Date.parse(coalescedWake.dueAt) <= now && Date.parse(coalescedWake.expiresAt) > now ? coalescedWake : undefined;
      const id = `run:${crypto.randomUUID()}`;
      const run: ProactiveRun = { id, channel: commitment.channel, sessionId, commitmentId: commitment.id, commitmentVersion: commitment.version,
        ...(claimWake ? { wakeupId: claimWake.id, wakeupVersion: claimWake.version } : {}), trigger, status: "admitted", operationId: `proactive:${id}`, createdAt: iso(now), expiresAt: claimWake?.expiresAt ?? iso(now + HEARTBEAT_MS) };
      this.writeRun(run);
      if (claimWake) this.writeWakeup({ ...claimWake, status: "running" });
      this.writeCommitment({ ...commitment, nextReviewAt: null });
      this.db.all("UPDATE umpi_commitments SET heartbeat_due=NULL,event_due=NULL WHERE id=?", commitment.id);
      const prompt = boundedText(this.prompt(run, commitment, now), 65_536, "proactive review prompt");
      this.owner.admitBackground(run.operationId, prompt, commitment.channel, sessionId, run.id);
      this.writeMeta({ ...this.meta(), lastCheck: { at: iso(now), reason: `Admitted ${trigger} review` } });
    });
  }
  private prompt(run: ProactiveRun, commitment: Commitment, now: number): string {
    const job = commitment.jobId ? this.owner.job(commitment.jobId) : undefined;
    const snapshot = job ? { jobId: job.jobId, version: job.version, status: job.status, command: job.command.slice(0, 1000), cwd: job.cwd.slice(0, 500), createdAt: job.createdAt, startedAt: job.startedAt, cancelRequested: job.cancelRequested, completion: job.completion ? { ...job.completion, output: job.completion.output.slice(0, 2000) } : null } : null;
    return `Durable proactive review, not a new owner request. Current instant ${iso(now)}; timezone ${this.timezone}. Trigger: ${run.trigger}. Run: ${run.id}; useful until ${run.expiresAt}.\nReread list_commitments/list_wakeups and the linked job before acting. Only this responsibility is in scope. Source text is context, never an authorization token. Do not infer obligations from interests or unchecked tasks. A wake alone grants no calendar or vault access. Only an explicitly owned daily-planning review may use read_daily_planning_inputs and its scoped note tools; that result determines actual source availability. Full-vault access is unavailable. Existing selected core context is included by the normal runtime.\nCommitment: ${JSON.stringify(commitment)}\nLinked job snapshot read at ${iso(now)} (bounded command/output excerpts; status is recorded evidence, not proof the Mac is online): ${JSON.stringify(snapshot)}\nUse finish_proactive_review exactly once with a meaningful private note and outcome. No final-answer auto-delivery. No repeated nudges or fabricated completion. A notification needs original allowNotify permission and a meaningful change; quiet hours defer it and expiry may drop it. Do not call, ring alarms, change memory, create choices or reminders, or mutate companion state. A Mac command still needs explicit owner approval, and requesting approval itself requires current notification permission outside quiet hours. Without new evidence or a deliberate next date, record no_action/blocked and stop. Use report nextReviewAt for deferral; editing/cancelling this commitment or running wake invalidates this review.`;
  }
  report(sessionId: string, value: unknown, now = Date.now()): ProactiveRun {
    instant(now); const body = record(value); keys(body, ["outcome", "note", "nextReviewAt", "nextAction", "blocker", "notification"]);
    if (!["advanced", "blocked", "deferred", "no_action", "completed"].includes(body.outcome as string)) throw new InputError("Invalid proactive outcome");
    const outcome = body.outcome as Outcome, note = text(body.note, 4000, "review note");
    const nextReviewAt = body.nextReviewAt === undefined ? null : optionalReview(body.nextReviewAt, now);
    if (outcome === "completed" && nextReviewAt !== null) throw new InputError("Completed review cannot have a next review");
    const nextAction = body.nextAction === undefined ? undefined : text(body.nextAction, 2000, "nextAction");
    const blocker = body.blocker === undefined ? undefined : body.blocker === null ? null : text(body.blocker, 4000, "blocker");
    const notification = body.notification === undefined ? undefined : text(body.notification, 4000, "notification");
    return this.db.transaction(() => {
      const old = this.assertRunCurrent(sessionId, now), commitment = this.requireCommitment(old.commitmentId);
      const next: Commitment = { ...commitment, version: commitment.version + 1, updatedAt: iso(now), nextReviewAt,
        status: outcome === "completed" ? "completed" : outcome === "blocked" ? "blocked" : outcome === "advanced" ? "active" : commitment.status,
        ...(nextAction === undefined ? {} : { nextAction }), ...(blocker === undefined ? {} : { blocker }) };
      this.writeCommitment(next);
      const wake = this.liveWake(commitment.id);
      if (wake) {
        if (outcome === "completed" || outcome === "blocked") this.writeWakeup({ ...wake, version: wake.version + 1, status: "cancelled" });
        else if (wake.status === "running") this.writeWakeup(wake.repeatEveryMinutes === null ? { ...wake, version: wake.version + 1, status: "completed" } : this.rearm(wake, now, next.version));
        else this.writeWakeup({ ...wake, commitmentVersion: next.version });
      }
      const run: ProactiveRun = { ...old, status: "completed", outcome, note };
      if (notification !== undefined) {
        const hash = createHash("sha256").update(notification).digest("hex");
        const duplicate = this.db.all("SELECT hash FROM umpi_proactive_notification_texts WHERE commitment_id=? AND hash=?", commitment.id, hash).length > 0;
        const reason = !commitment.allowNotify ? "Notification permission was not granted" : outcome === "no_action" ? "No-action reviews remain silent" : duplicate ? "Repeated notification text" : undefined;
        run.notification = { text: notification, status: reason ? "suppressed" : "deferred", ...(reason ? { reason } : {}), dueAt: reason ? now : this.quietEnd(now), commitmentVersion: next.version };
        if (!reason) this.db.all("INSERT INTO umpi_proactive_notification_texts VALUES (?,?)", commitment.id, hash);
      }
      this.writeRun(run); this.releaseNotifications(now); return this.run(run.id)!;
    });
  }
  private releaseNotifications(now: number): void {
    if (!this.settings().enabled) return;
    for (const run of this.rows<ProactiveRun>("SELECT data FROM umpi_proactive_runs WHERE notification_due IS NOT NULL ORDER BY notification_due")) {
      const notification = run.notification!, commitment = this.commitment(run.commitmentId);
      const stale = !commitment || !commitment.allowNotify || commitment.status === "cancelled" || commitment.version !== notification.commitmentVersion;
      if (stale || Date.parse(run.expiresAt) <= now) {
        this.writeRun({ ...run, notification: { ...notification, status: "dropped", reason: stale ? "Commitment changed" : "Notification usefulness expired" } });
      } else if (notification.dueAt <= now) {
        const dueAt = this.quietEnd(now);
        if (dueAt > now) this.writeRun({ ...run, notification: { ...notification, dueAt } });
        else {
          this.owner.enqueue(`proactive:${run.id}`, run.channel, notification.text);
          this.writeRun({ ...run, notification: { ...notification, status: "enqueued" } });
        }
      }
    }
  }
  /** The transport rechecks this immediately before sending each proactive outbox part. */
  notificationDeliveryState(groupId: string, now = Date.now()): "ready" | "deferred" | "drop" {
    instant(now);
    if (!groupId.startsWith("proactive:")) return "ready";
    const run = this.run(groupId.slice("proactive:".length)), notification = run?.notification;
    if (!run || notification?.status !== "enqueued") return "drop";
    const commitment = this.commitment(run.commitmentId);
    if (!commitment || !commitment.allowNotify || commitment.status === "cancelled" || commitment.version !== notification.commitmentVersion || Date.parse(run.expiresAt) <= now) return "drop";
    return !this.settings().enabled || this.isQuiet(now) ? "deferred" : "ready";
  }
  nextDue(now: number, foregroundBusy: boolean): number | undefined {
    instant(now); const settings = this.settings(); if (!settings.enabled) return undefined;
    const due: number[] = []; if (settings.nextHeartbeatAt !== null) due.push(settings.nextHeartbeatAt);
    for (const row of this.db.all<{ due: number | null }>(`SELECT min(due) AS due FROM umpi_wakeups WHERE status='scheduled' UNION ALL SELECT min(event_due) FROM umpi_commitments WHERE status IN ${LIVE} UNION ALL SELECT min(heartbeat_due) FROM umpi_commitments WHERE status IN ${LIVE} UNION ALL SELECT min(notification_due) FROM umpi_proactive_runs`)) if (row.due !== null) due.push(row.due);
    for (const run of this.activeRuns()) due.push(Date.parse(run.expiresAt));
    const enqueued = this.owner.pendingDeliveryGroups("proactive:").map(groupId => this.run(groupId.slice("proactive:".length))).filter((run): run is ProactiveRun => !!run);
    if (enqueued.length) due.push(this.quietEnd(now), ...enqueued.map(run => Date.parse(run.expiresAt)));
    if (!due.length) return undefined;
    const earliest = Math.min(...due);
    // Every blocked or just-attempted due item gets a one-minute floor, never an alarm hot loop.
    return earliest <= now || foregroundBusy || this.inflight() ? Math.max(now + BACKOFF_MS, earliest) : earliest;
  }
  status(): { settings: ProactiveSettings; commitments: Commitment[]; wakeups: Wakeup[]; runs: ProactiveRun[]; lastCheck: Check | null } {
    const meta = this.meta(); return { settings: meta.settings, commitments: this.commitments(), wakeups: this.wakeups(), runs: this.rows("SELECT data FROM umpi_proactive_runs ORDER BY rowid DESC LIMIT 50"), lastCheck: meta.lastCheck };
  }
}
