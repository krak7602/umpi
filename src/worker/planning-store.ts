import { randomUUID } from "node:crypto";
import { mergeDailyPlan, nextPlanningTime, planningDay, planningDayBounds, shiftPlanningDay, type AppliedPlanEntry, type DailyPlanPatch } from "../shared/daily-planning.js";
import { InputError, boundedText, record } from "../shared/protocol.js";
import { vaultNoteRevision, type VaultPlanningApply, type VaultPlanningSnapshot, type VaultPlanningResult } from "../shared/vault-planning.js";
import type { CalendarSnapshot } from "./calendar.js";
import { ProactiveStore, ProactiveCapacityError, type Commitment, type ProactiveRun, type RetryPolicy } from "./proactive-store.js";
import { StateError, type Channel, type Database } from "./store.js";

class PlanningDayEnded extends StateError {
  constructor() { super(409, "The local day is ending; prepare the new day after midnight"); }
}

export interface PlanningSettings { version: number; enabled: boolean; time: string }
export interface DailyBrief { day: string; version: number; text: string; updatedAt: string }
export interface DailyInputs {
  vault: VaultPlanningSnapshot; calendar: CalendarSnapshot; brief: DailyBrief | null; coreRevision: number; capturedAt: string;
}
export interface DailyPlanRecord {
  day: string; version: number; attempt: number; automatic: boolean; scheduled: boolean; settingsVersion: number;
  status: "requested" | "ready" | "applying" | "synced" | "blocked" | "cancelled";
  commitmentId: string | null; wakeId?: string; inputs?: DailyInputs; intentId?: string;
  applied: AppliedPlanEntry[]; issue?: string; updatedAt: string; syncedAt?: string;
}
export interface DailyWriteIntent extends VaultPlanningApply {
  status: "prepared" | "synced" | "conflict" | "unconfirmed" | "abandoned";
  before: string | null; applied: AppliedPlanEntry[];
  skipped: { id: string; reason: "owner_edited" | "owner_removed" | "already_present" }[];
  createdAt: string; result?: VaultPlanningResult;
}
const iso = (now: number): string => new Date(now).toISOString();
/** A daily note missed during a provider outage or an exhausted usage window is retried, not left blocked until the owner notices. */
export const PLANNING_RETRY: RetryPolicy = { everyMinutes: 60, maxAttempts: 3 };
function keys(body: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(body).some(key => !allowed.includes(key))) throw new InputError("Unknown daily-planning field");
}
function expected(actual: number, value: unknown): void {
  if (!Number.isSafeInteger(value) || actual !== value) throw new StateError(409, "Daily planning changed; read its current version");
}
function day(value: unknown): string {
  const result = boundedText(value, 10, "planning day"); shiftPlanningDay(result, 0); return result;
}
function edit(commitment: Commitment) {
  const { purpose, source, nextAction, blocker, status, nextReviewAt, jobId } = commitment;
  return { expectedVersion: commitment.version, purpose, source, nextAction, blocker, status, nextReviewAt, jobId };
}

/** Intent precedes filesystem effects; neither a model report nor a container write is a sync receipt. */
export class PlanningStore {
  readonly db: Database;
  constructor(readonly proactive: ProactiveStore, readonly timezone: string) {
    this.db = proactive.db;
    for (const sql of [
      "CREATE TABLE IF NOT EXISTS umpi_planning_settings (id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL)",
      "CREATE TABLE IF NOT EXISTS umpi_vault_authorization (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL)",
      "CREATE TABLE IF NOT EXISTS umpi_daily_briefs (day TEXT PRIMARY KEY, data TEXT NOT NULL)",
      "CREATE TABLE IF NOT EXISTS umpi_daily_plans (day TEXT PRIMARY KEY, status TEXT NOT NULL, commitment_id TEXT UNIQUE, data TEXT NOT NULL)",
      "CREATE TABLE IF NOT EXISTS umpi_daily_writes (id TEXT PRIMARY KEY, day TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL)",
      "CREATE INDEX IF NOT EXISTS umpi_pending_daily_writes ON umpi_daily_writes(status,day)",
    ]) this.db.all(sql);
    this.db.all("INSERT OR IGNORE INTO umpi_planning_settings VALUES (1,?)", JSON.stringify({ version: 1, enabled: false, time: "02:30" } satisfies PlanningSettings));
  }
  private rows<T>(sql: string, ...bindings: (string | number | null)[]): T[] {
    return this.db.all<{ data: string }>(sql, ...bindings).map(row => JSON.parse(row.data) as T);
  }
  settings(): PlanningSettings { return this.rows<PlanningSettings>("SELECT data FROM umpi_planning_settings WHERE id=1")[0]!; }
  vaultRevision(): number { return this.db.all<{ revision: number }>("SELECT revision FROM umpi_vault_authorization WHERE id=1")[0]?.revision ?? 0; }
  authorizeVault(revision: number): void {
    if (!Number.isSafeInteger(revision) || revision < 1) throw new InputError("Invalid private vault provisioning receipt");
    this.db.all("INSERT INTO umpi_vault_authorization VALUES (1,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision", revision);
  }
  plan(value: string): DailyPlanRecord | undefined { return this.rows<DailyPlanRecord>("SELECT data FROM umpi_daily_plans WHERE day=?", day(value))[0]; }
  brief(value: string): DailyBrief | null { return this.rows<DailyBrief>("SELECT data FROM umpi_daily_briefs WHERE day=?", day(value))[0] ?? null; }
  intent(id: string): DailyWriteIntent | undefined { return this.rows<DailyWriteIntent>("SELECT data FROM umpi_daily_writes WHERE id=?", id)[0]; }
  pending(): DailyWriteIntent | undefined { return this.rows<DailyWriteIntent>("SELECT data FROM umpi_daily_writes WHERE status IN ('prepared','unconfirmed') ORDER BY rowid LIMIT 1")[0]; }
  private save(plan: DailyPlanRecord): DailyPlanRecord {
    this.db.all("INSERT INTO umpi_daily_plans VALUES (?,?,?,?) ON CONFLICT(day) DO UPDATE SET status=excluded.status,commitment_id=excluded.commitment_id,data=excluded.data", plan.day, plan.status, plan.commitmentId, JSON.stringify(plan));
    return plan;
  }
  private saveIntent(intent: DailyWriteIntent): void {
    this.db.all("INSERT INTO umpi_daily_writes VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,data=excluded.data", intent.intentId, intent.day, intent.status, JSON.stringify(intent));
  }
  configure(value: unknown, now = Date.now()): PlanningSettings {
    const body = record(value); keys(body, ["expectedVersion", "enabled", "time"]);
    if (typeof body.enabled !== "boolean" || typeof body.time !== "string") throw new InputError("Planning settings require enabled and local HH:mm time");
    nextPlanningTime(now, this.timezone, body.time);
    return this.db.transaction(() => {
      const previous = this.settings(); expected(previous.version, body.expectedVersion);
      const settings = { version: previous.version + 1, enabled: body.enabled as boolean, time: body.time as string };
      this.db.all("UPDATE umpi_planning_settings SET data=? WHERE id=1", JSON.stringify(settings));
      for (const active of this.rows<DailyPlanRecord>("SELECT data FROM umpi_daily_plans WHERE status IN ('requested','ready','applying')")) {
        this.cancel(active.day, active.version, "Daily-planning settings changed; pending write evidence is retained", now);
      }
      return settings;
    });
  }
  setBrief(value: unknown, now = Date.now()): DailyBrief {
    const body = record(value); keys(body, ["day", "expectedVersion", "text"]);
    const target = day(body.day), today = planningDay(now, this.timezone);
    if (target < today || target > shiftPlanningDay(today, 7)) throw new InputError("A daily brief must target today or the next seven days");
    const text = boundedText(body.text, 8_000, "daily brief").trim();
    if (!text) throw new InputError("A daily brief must state the owner's actual intent");
    return this.db.transaction(() => {
      const previous = this.brief(target); expected(previous?.version ?? 0, body.expectedVersion);
      const brief: DailyBrief = { day: target, version: (previous?.version ?? 0) + 1, text, updatedAt: iso(now) };
      this.db.all("INSERT INTO umpi_daily_briefs VALUES (?,?) ON CONFLICT(day) DO UPDATE SET data=excluded.data", target, JSON.stringify(brief));
      return brief;
    });
  }
  request(target: string, channel: Channel, sessionId: string, automatic = false, now = Date.now()): DailyPlanRecord {
    if (day(target) !== planningDay(now, this.timezone)) throw new InputError("Preparation is limited to the current local day; future intent belongs in a daily brief");
    return this.db.transaction(() => {
      const previous = this.plan(target);
      const previousWake = previous?.wakeId ? this.proactive.wakeup(previous.wakeId) : undefined;
      if (previous && ["requested", "ready", "applying"].includes(previous.status) && previousWake && ["scheduled", "running"].includes(previousWake.status)) {
        return automatic && !previous.scheduled ? this.save({ ...previous, scheduled: true }) : previous;
      }
      const settings = this.settings();
      if (automatic && !settings.enabled) throw new StateError(409, "Automatic daily preparation is paused");
      if (!this.proactive.settings().enabled) throw new StateError(409, "Follow-through is paused; enable it before requesting background preparation");
      const pending = this.pending();
      if (pending && pending.day !== target) throw new StateError(409, "An earlier note upload is unresolved; review its retained write before preparing another day");
      if (previous?.commitmentId) {
        const old = this.proactive.commitment(previous.commitmentId);
        if (old && ["active", "blocked"].includes(old.status)) this.proactive.updateCommitment(old.id, { ...edit(old), status: "cancelled", nextReviewAt: null }, now);
      }
      const commitmentId = `daily-${randomUUID()}`;
      const purpose = `Prepare the current-day daily note for ${target}`;
      this.proactive.createCommitment({ id: commitmentId, purpose, source: automatic ? "Owner-enabled daily-note preparation" : "Owner requested preparation of today's daily note", nextAction: "Use read_daily_planning_inputs, then commit_daily_plan or resume_daily_plan. Confirm actual sync before reporting completion; keep normal success quiet.", blocker: null, status: "active", nextReviewAt: null, jobId: null, allowNotify: false, retry: PLANNING_RETRY }, channel, sessionId, now);
      const expiresAt = planningDayBounds(target, this.timezone).end;
      if (Date.parse(expiresAt) <= now + 1_000) throw new PlanningDayEnded();
      const wakeId = `daily-wake-${randomUUID()}`;
      this.proactive.scheduleWakeup({ id: wakeId, commitmentId, purpose, dueAt: iso(now + 1_000), expiresAt, repeatEveryMinutes: null }, now);
      return this.save({ day: target, version: (previous?.version ?? 0) + 1, attempt: (previous?.attempt ?? 0) + 1, automatic, scheduled: automatic || previous?.scheduled || false, settingsVersion: settings.version, status: "requested", commitmentId, wakeId, applied: previous?.applied ?? [], ...(pending?.day === target ? { intentId: pending.intentId, inputs: previous?.inputs } : {}), updatedAt: iso(now) });
    });
  }
  /** One local date, not one elapsed 24h interval; delayed alarms never build a backlog. */
  due(now = Date.now()): boolean {
    if (!this.settings().enabled || !this.proactive.settings().enabled) return false;
    const target = planningDay(now, this.timezone);
    const start = Date.parse(planningDayBounds(target, this.timezone).start);
    return !this.plan(target)?.scheduled && nextPlanningTime(start - 1, this.timezone, this.settings().time) <= now;
  }
  nextDue(now = Date.now()): number | undefined {
    if (!this.settings().enabled || !this.proactive.settings().enabled) return;
    if (this.due(now)) return now;
    return nextPlanningTime(now, this.timezone, this.settings().time);
  }
  drive(channel: Channel, sessionId: string, ready: boolean, now = Date.now()): void {
    this.db.transaction(() => {
      const today = planningDay(now, this.timezone);
      for (const plan of this.rows<DailyPlanRecord>("SELECT p.data FROM umpi_daily_plans p LEFT JOIN umpi_commitments c ON c.id=p.commitment_id WHERE p.day<? AND (p.status IN ('requested','ready','applying') OR c.status IN ('active','blocked'))", today)) {
        if (plan.commitmentId) {
          const commitment = this.proactive.commitment(plan.commitmentId);
          if (commitment && ["active", "blocked"].includes(commitment.status)) this.proactive.updateCommitment(commitment.id, { ...edit(commitment), status: "cancelled", nextReviewAt: null }, now);
        }
        if (["requested", "ready", "applying"].includes(plan.status)) this.cancel(plan.day, plan.version, "The planning day ended; no stale morning plan will be written. Any unconfirmed write remains recoverable.", now);
      }
      if (!this.due(now)) return;
      const current = this.plan(today), wake = current?.wakeId ? this.proactive.wakeup(current.wakeId) : undefined;
      if (current && ["requested", "ready", "applying"].includes(current.status) && wake && ["scheduled", "running"].includes(wake.status)) {
        this.save({ ...current, scheduled: true }); return;
      }
      if (!ready || this.pending()) {
        const previous = this.plan(today);
        this.save({ ...previous, day: today, version: (previous?.version ?? 0) + 1, attempt: previous?.attempt ?? 0, automatic: true, scheduled: true, settingsVersion: this.settings().version, status: "blocked", commitmentId: previous?.commitmentId ?? null, applied: previous?.applied ?? [], issue: !ready ? "Connect the private Obsidian workspace before enabling daily preparation" : "An earlier upload remains unconfirmed; inspect the retained write", updatedAt: iso(now) });
        return;
      }
      try {
        this.request(today, channel, sessionId, true, now);
      } catch (error) {
        // These are admission rejections, not arbitrary database or programming failures.
        if (!(error instanceof ProactiveCapacityError) && !(error instanceof PlanningDayEnded)) throw error;
        const previous = this.plan(today);
        this.save({ ...previous, day: today, version: (previous?.version ?? 0) + 1, attempt: (previous?.attempt ?? 0) + 1, automatic: true, scheduled: true, settingsVersion: this.settings().version, status: "blocked", commitmentId: previous?.commitmentId ?? null, applied: previous?.applied ?? [], issue: error.message, updatedAt: iso(now) });
      }
    });
  }
  reconcile(now = Date.now()): void {
    for (const plan of this.rows<DailyPlanRecord>("SELECT data FROM umpi_daily_plans WHERE status IN ('requested','ready','applying')")) {
      const wake = plan.wakeId ? this.proactive.wakeup(plan.wakeId) : undefined;
      if (wake && ["scheduled", "running"].includes(wake.status)) continue;
      const commitment = plan.commitmentId ? this.proactive.commitment(plan.commitmentId) : undefined;
      if (plan.day === planningDay(now, this.timezone) && commitment && ["active", "blocked"].includes(commitment.status)) {
        if (commitment.nextReviewAt && planningDay(Date.parse(commitment.nextReviewAt), this.timezone) === plan.day) continue;
        const run = this.rows<ProactiveRun>("SELECT data FROM umpi_proactive_runs WHERE commitment_id=? AND status='admitted'", commitment.id)[0];
        const operation = run ? this.proactive.owner.operation(run.operationId) : undefined;
        if (run?.trigger === "heartbeat" && run.commitmentVersion === commitment.version && Date.parse(run.expiresAt) > now
          && operation && ["admitted", "submitted"].includes(operation.status)) continue;
      }
      this.save({ ...plan, version: plan.version + 1, status: "blocked", issue: plan.issue ?? "Preparation stopped without a verified upload; review or explicitly resume it", updatedAt: iso(now) });
    }
  }
  forSession(sessionId: string, now = Date.now()): DailyPlanRecord {
    const run = this.proactive.assertRunCurrent(sessionId, now);
    const plan = this.rows<DailyPlanRecord>("SELECT data FROM umpi_daily_plans WHERE commitment_id=?", run.commitmentId)[0];
    if (!plan || plan.day !== planningDay(now, this.timezone) || plan.settingsVersion !== this.settings().version || ["cancelled", "blocked"].includes(plan.status)) throw new StateError(403, "This turn has no current daily-note write authorization");
    return plan;
  }
  ownsCommitment(id: string): boolean { return this.db.all("SELECT day FROM umpi_daily_plans WHERE commitment_id=? LIMIT 1", id).length > 0; }
  capture(sessionId: string, vault: VaultPlanningSnapshot, calendar: CalendarSnapshot, coreRevision: number, now = Date.now()): DailyPlanRecord {
    return this.db.transaction(() => {
      const plan = this.forSession(sessionId, now);
      if (this.pending()) throw new StateError(409, "Resume the retained write before collecting another plan");
      if (vault.day !== plan.day || calendar.day !== plan.day || vault.revision !== vaultNoteRevision(vault.target)) throw new StateError(409, "Planning inputs do not match the authorized day or note revision");
      return this.save({ ...plan, version: plan.version + 1, status: "ready", inputs: { vault, calendar, brief: this.brief(plan.day), coreRevision, capturedAt: iso(now) }, issue: undefined, updatedAt: iso(now) });
    });
  }
  prepare(sessionId: string, expectedVersion: number, patch: DailyPlanPatch, coreRevision: number, now = Date.now()): DailyWriteIntent {
    return this.db.transaction(() => {
      const plan = this.forSession(sessionId, now); expected(plan.version, expectedVersion);
      if (this.pending()) throw new StateError(409, "A note write already awaits confirmation; resume it instead");
      if (!plan.inputs || plan.status !== "ready") throw new StateError(409, "Read current daily-planning inputs before proposing a write");
      const inputs = plan.inputs;
      if (inputs.coreRevision !== coreRevision || (inputs.brief?.version ?? 0) !== (this.brief(plan.day)?.version ?? 0)) throw new StateError(409, "Owner context or the daily brief changed; collect current inputs and revise the plan");
      const coverage = [...patch.coverage];
      if (!inputs.brief) coverage.push("No evening brief was available; this plan uses the current note and standing priorities.");
      if (inputs.calendar.coverage !== "complete") coverage.push(inputs.calendar.coverage === "partial" ? "Calendar coverage is partial; this schedule may omit commitments." : "Calendar access was unavailable; meetings have not been verified.");
      const merged = mergeDailyPlan({ day: plan.day, current: inputs.vault.target, template: inputs.vault.template, previous: plan.applied, patch: { ...patch, coverage: [...new Set(coverage)] } });
      const intent: DailyWriteIntent = { intentId: `daily-write-${randomUUID()}`, day: plan.day, beforeRevision: inputs.vault.revision, before: inputs.vault.target, text: merged.text, expiresAt: planningDayBounds(plan.day, this.timezone).end, applied: merged.applied, skipped: merged.skipped, createdAt: iso(now), status: "prepared" };
      this.saveIntent(intent);
      this.save({ ...plan, version: plan.version + 1, status: "applying", intentId: intent.intentId, updatedAt: iso(now) });
      return intent;
    });
  }
  finish(intentId: string, result: VaultPlanningResult, now = Date.now()): DailyPlanRecord {
    return this.db.transaction(() => {
      const intent = this.intent(intentId);
      if (!intent) throw new StateError(404, "Unknown daily-note write");
      const plan = this.plan(intent.day)!;
      if (intent.status === "synced") return plan;
      if (result.status === "synced" && result.revision !== vaultNoteRevision(intent.text)) throw new StateError(409, "Sync receipt did not confirm the intended note content");
      this.saveIntent({ ...intent, status: intent.status === "abandoned" ? "abandoned" : result.status, result });
      if (plan.intentId !== intentId || intent.status === "abandoned") return plan;
      // Cancellation may win while external sync is in flight. Keep the real receipt without reviving the task.
      const status = plan.status === "cancelled" ? "cancelled" : result.status === "synced" ? "synced" : result.status === "conflict" ? "blocked" : "applying";
      return this.save({ ...plan, version: plan.version + 1, status, ...(result.status === "synced" ? { applied: intent.applied, syncedAt: result.checkedAt, issue: undefined } : { issue: result.issue ?? "Note upload has not been confirmed" }), updatedAt: iso(now) });
    });
  }
  block(sessionId: string, issue: string, now = Date.now()): void {
    const plan = this.forSession(sessionId, now);
    this.save({ ...plan, version: plan.version + 1, issue, updatedAt: iso(now) });
  }
  cancel(target: string, expectedVersion: number, issue = "Daily preparation was cancelled; retained writes are not discarded", now = Date.now()): DailyPlanRecord {
    return this.db.transaction(() => {
      const plan = this.plan(target); if (!plan) throw new StateError(404, "No daily preparation exists for that date");
      expected(plan.version, expectedVersion);
      if (plan.commitmentId) {
        const commitment = this.proactive.commitment(plan.commitmentId);
        if (commitment && ["active", "blocked"].includes(commitment.status)) this.proactive.updateCommitment(commitment.id, { ...edit(commitment), status: "cancelled", nextReviewAt: null }, now);
      }
      return this.save({ ...plan, version: plan.version + 1, status: "cancelled", issue, updatedAt: iso(now) });
    });
  }
  abandonIntent(id: string, expectedStatus: unknown, now = Date.now()): DailyWriteIntent {
    return this.db.transaction(() => {
      const intent = this.intent(id);
      if (!intent) throw new StateError(404, "Unknown retained note write");
      if (!["prepared", "unconfirmed"].includes(intent.status) || intent.status !== expectedStatus) throw new StateError(409, "Retained write changed; inspect its actual status before releasing it");
      const plan = this.plan(intent.day);
      if (plan?.intentId === id) this.cancel(plan.day, plan.version, "Owner released the retained proposal. This does not undo an upload that already occurred or was in flight.", now);
      const released = { ...intent, status: "abandoned" as const };
      this.saveIntent(released);
      return released;
    });
  }
  status(now = Date.now()): object {
    const due = this.nextDue(now), pending = this.pending();
    return { settings: this.settings(), timezone: this.timezone, nextPreparationAt: due === undefined ? null : iso(due), days: this.rows<DailyPlanRecord>("SELECT data FROM umpi_daily_plans ORDER BY day DESC LIMIT 14").map(({ day, version, status, issue, updatedAt, syncedAt, inputs }) => ({ day, version, status, issue: issue ?? null, updatedAt, syncedAt: syncedAt ?? null, calendarCoverage: inputs?.calendar.coverage ?? null })), pendingWrite: pending ? { day: pending.day, status: pending.status } : null };
  }
}
