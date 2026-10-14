import { planningDay, shiftPlanningDay, type DailyPlanPatch } from "../shared/daily-planning.js";
import { InputError, timestamp } from "../shared/protocol.js";
import { vaultNoteRevision, type VaultPlanningApply, type VaultPlanningResult, type VaultPlanningSnapshot } from "../shared/vault-planning.js";
import { readCalendarDay } from "./calendar.js";
import { PlanningStore, type DailyPlanRecord, type DailyWriteIntent } from "./planning-store.js";
import { StateError } from "./store.js";

export interface VaultPlanningClient {
  getSnapshot(day: string): Promise<VaultPlanningSnapshot>;
  applyNote(intent: VaultPlanningApply): Promise<VaultPlanningResult>;
}
interface CommitReceipt { request: string; intentId: string }
const unavailable = "The private note workspace is unavailable; no new note content was collected or confirmed.";
const uncertain = "The note upload was not confirmed. The immutable write is retained; inspect it before explicitly resuming.";
const conflict = "The note changed or a sync conflict was detected. Completion was not confirmed; inspect the retained write and current note.";

/** External effects never run inside SQLite effects. Only their immutable intent does. */
export class PlanningRuntime {
  private readonly applying = new Set<string>();
  constructor(
    readonly store: PlanningStore,
    private readonly workspace: () => VaultPlanningClient | undefined,
    private readonly coreRevision: () => Promise<number>,
    private readonly calendarCredentials: () => string | undefined,
    readonly wake: () => Promise<void>,
  ) {}

  available(): boolean { return this.workspace() !== undefined; }
  today(): string { return planningDay(Date.now(), this.store.timezone); }
  status(): object { return { ...this.store.status(), available: this.available() }; }
  foreground(sessionId: string) {
    const owner = this.store.proactive.owner;
    const channel = owner.channelForSession(sessionId);
    if (owner.isBackgroundSession(sessionId)) throw new StateError(403, "This daily-planning action requires the owner's foreground conversation");
    return channel;
  }
  day(value: string): string {
    try { return shiftPlanningDay(value, 0); }
    catch { throw new InputError("Use a valid ISO calendar date for the daily plan"); }
  }
  read(day: string): object {
    const target = this.day(day), plan = this.store.plan(target);
    const intent = plan?.intentId ? this.store.intent(plan.intentId) : undefined;
    const entries = intent?.applied ?? plan?.applied ?? [];
    return { day: target, available: this.available(), brief: this.store.brief(target), plan: plan ? {
      day: plan.day, version: plan.version, status: plan.status, automatic: plan.automatic,
      issue: plan.issue ?? null, updatedAt: plan.updatedAt, syncedAt: plan.syncedAt ?? null,
      calendarCoverage: plan.inputs?.calendar.coverage ?? null, coreRevision: plan.inputs?.coreRevision ?? null,
      entries: entries.slice(0, 128), entryCount: entries.length,
      pendingWrite: intent ? { intentId: intent.intentId, status: intent.status } : null,
    } : null };
  }
  async readNote(sessionId: string, value: string): Promise<object> {
    this.foreground(sessionId);
    const target = this.day(value), today = this.today();
    if (target < shiftPlanningDay(today, -7) || target > today) throw new InputError("Live note reads are limited to today and the previous seven days");
    const client = this.workspace();
    if (!client) throw new StateError(503, unavailable);
    let snapshot: VaultPlanningSnapshot;
    try { snapshot = await client.getSnapshot(target); }
    catch { throw new StateError(503, unavailable); }
    this.foreground(sessionId);
    return { ...this.read(target), note: { text: snapshot.target, checkedAt: snapshot.checkedAt, revision: snapshot.revision }, calendarRefreshed: false };
  }
  request(sessionId: string): DailyPlanRecord {
    const channel = this.foreground(sessionId);
    if (!this.available()) throw new StateError(503, unavailable);
    return this.store.request(this.today(), channel, sessionId);
  }
  private client(sessionId: string): VaultPlanningClient {
    const client = this.workspace();
    if (!client) {
      this.store.block(sessionId, unavailable);
      throw new StateError(503, unavailable);
    }
    return client;
  }
  private async revision(sessionId: string): Promise<number> {
    try {
      const revision = await this.coreRevision();
      if (!Number.isSafeInteger(revision) || revision < 0) throw new Error();
      return revision;
    } catch {
      const issue = "Current owner context is unavailable; no note write was dispatched";
      this.store.forSession(sessionId);
      this.store.block(sessionId, issue);
      throw new StateError(503, issue);
    }
  }
  async inputs(sessionId: string): Promise<object> {
    const plan = this.store.forSession(sessionId);
    const pending = this.store.pending();
    if (pending) return { status: "recovery_required", day: pending.day, intentId: pending.intentId, writeStatus: pending.status,
      issue: "A retained write must be resolved before collecting another plan. Resume only that write; do not propose a replacement." };
    const client = this.client(sessionId);
    let vault: VaultPlanningSnapshot;
    try { vault = await client.getSnapshot(plan.day); }
    catch {
      this.store.forSession(sessionId);
      this.store.block(sessionId, unavailable);
      throw new StateError(503, unavailable);
    }
    this.store.forSession(sessionId);
    const calendar = await readCalendarDay(this.calendarCredentials(), plan.day, this.store.timezone);
    this.store.forSession(sessionId);
    const coreRevision = await this.revision(sessionId);
    this.store.forSession(sessionId);
    const captured = this.store.capture(sessionId, vault, calendar, coreRevision);
    return { status: "ready", day: captured.day, version: captured.version, ...captured.inputs!, previous: captured.applied };
  }
  writeResult(intentId: string): object {
    const intent = this.store.intent(intentId);
    if (!intent) throw new StateError(409, "The retained daily-note write is unavailable; do not repeat the write");
    const plan = this.store.plan(intent.day);
    return { day: intent.day, intentId, status: intent.status, result: intent.result ?? null,
      planStatus: plan?.status ?? null, version: plan?.version ?? null, skipped: intent.skipped };
  }
  async commit(sessionId: string, expectedVersion: number, patch: DailyPlanPatch, taskKey: string): Promise<object> {
    const owner = this.store.proactive.owner;
    const key = `planning-tool:${sessionId}:${taskKey}`;
    const request = JSON.stringify({ name: "commit_daily_plan", expectedVersion, patch });
    const previous = owner.effectResult<CommitReceipt>(key);
    if (previous) {
      if (previous.request !== request) throw new StateError(409, "Tool task already contains a different daily-planning request");
      return this.writeResult(previous.intentId);
    }
    this.store.forSession(sessionId);
    await this.wake();
    const coreRevision = await this.revision(sessionId);
    this.store.forSession(sessionId);
    const client = this.client(sessionId);
    let created = false;
    const receipt = owner.effect(key, () => {
      const intent = this.store.prepare(sessionId, expectedVersion, patch, coreRevision);
      created = true;
      return { request, intentId: intent.intentId };
    });
    if (receipt.request !== request) throw new StateError(409, "Tool task already contains a different daily-planning request");
    // A replay, including after a restart, never implicitly retries uncertain external I/O.
    if (created) await this.apply(sessionId, this.store.intent(receipt.intentId)!, client);
    return this.writeResult(receipt.intentId);
  }
  async resume(sessionId: string): Promise<object> {
    let plan = this.store.forSession(sessionId);
    const intent = plan.intentId ? this.store.intent(plan.intentId) : undefined;
    if (!intent) throw new StateError(409, "There is no retained write for this daily preparation");
    if (intent.status === "synced") return this.writeResult(intent.intentId);
    if (!["prepared", "unconfirmed"].includes(intent.status)) throw new StateError(409, "This write needs owner review, not another upload attempt");
    await this.wake();
    const coreRevision = await this.revision(sessionId);
    plan = this.store.forSession(sessionId);
    if (!plan.inputs || plan.inputs.coreRevision !== coreRevision || (plan.inputs.brief?.version ?? 0) !== (this.store.brief(plan.day)?.version ?? 0)) {
      throw new StateError(409, "Owner context or the daily brief changed. Inspect the retained write; it cannot be replaced or resumed automatically.");
    }
    await this.apply(sessionId, intent, this.client(sessionId));
    return this.writeResult(intent.intentId);
  }
  private async apply(sessionId: string, intent: DailyWriteIntent, client: VaultPlanningClient): Promise<void> {
    const plan = this.store.forSession(sessionId);
    const current = this.store.intent(intent.intentId);
    if (current?.status === "synced") return;
    if (!current || !["prepared", "unconfirmed"].includes(current.status)) throw new StateError(409, "This retained write is no longer available for upload");
    if (plan.intentId !== intent.intentId || plan.day !== intent.day || Date.parse(intent.expiresAt) <= Date.now()) {
      throw new StateError(409, "The retained write no longer has current-day authorization");
    }
    if (this.applying.has(intent.intentId)) throw new StateError(409, "This retained write is already being checked; do not retry it concurrently");
    this.applying.add(intent.intentId);
    try {
      let result: VaultPlanningResult;
      try {
        const raw = await client.applyNote({ intentId: intent.intentId, day: intent.day, beforeRevision: intent.beforeRevision, text: intent.text, expiresAt: intent.expiresAt });
        if (!["synced", "conflict", "unconfirmed"].includes(raw.status) || !/^[a-f0-9]{64}$/.test(raw.revision) ||
            (raw.status === "synced" && raw.revision !== vaultNoteRevision(intent.text))) throw new Error();
        const checkedAt = timestamp(raw.checkedAt, "sync receipt time");
        result = { status: raw.status, revision: raw.revision, checkedAt,
          ...(raw.status === "synced" ? {} : { issue: raw.status === "conflict" ? conflict : uncertain }) };
      } catch {
        result = { status: "unconfirmed", revision: intent.beforeRevision, checkedAt: new Date(Date.now()).toISOString(), issue: uncertain };
      }
      // Cancellation/foreground admission during dispatched I/O cannot erase the actual result.
      this.store.finish(intent.intentId, result);
    } finally { this.applying.delete(intent.intentId); }
  }
}
