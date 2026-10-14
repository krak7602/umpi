import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, StateError, type Database } from "../src/worker/store.js";
import { ProactiveStore, ProactiveCapacityError } from "../src/worker/proactive-store.js";
import { PlanningStore } from "../src/worker/planning-store.js";
import { vaultNoteRevision } from "../src/shared/vault-planning.js";
import { planningDay } from "../src/shared/daily-planning.js";

const START = Date.parse("2027-02-10T00:30:00Z");
const FOREGROUND = "planning-owner", BACKGROUND = "planning-review";
const TEMPLATE = "# {{date:MMM Do, YYYY}}\n\n## Plan\n\n### Schedule\n\n### Tasks\n\n## Done / changed\n\n## Notes\n\n## Links\n";
interface Fixture {
  owner: Store; proactive: ProactiveStore; planning: PlanningStore;
  time(value: number): void; reopen(): void;
}
function fixture(t: TestContext): Fixture {
  const directory = mkdtempSync(join(tmpdir(), "umpi-planning-")), path = join(directory, "state.sqlite");
  let sqlite = new DatabaseSync(path), depth = 0;
  t.mock.timers.enable({ apis: ["Date"], now: START });
  const db: Database = {
    all: <T extends object>(query: string, ...args: (string | number | null)[]) => sqlite.prepare(query).all(...args) as T[],
    transaction: <T>(work: () => T): T => {
      const name = `planning_${depth++}`; sqlite.exec(`SAVEPOINT ${name}`);
      try { const result = work(); sqlite.exec(`RELEASE ${name}`); return result; }
      catch (error) { sqlite.exec(`ROLLBACK TO ${name}; RELEASE ${name}`); throw error; }
      finally { depth--; }
    },
  };
  let owner = new Store(db), proactive = new ProactiveStore(owner, "UTC"), planning = new PlanningStore(proactive, "UTC");
  owner.setSession("control", FOREGROUND); owner.registerBackgroundSession(BACKGROUND, "control");
  proactive.configure({ expectedVersion: 1, enabled: true, quietHours: null });
  planning.configure({ expectedVersion: 1, enabled: true, time: "02:30" });
  t.after(() => { sqlite.close(); rmSync(directory, { recursive: true, force: true }); });
  return {
    get owner() { return owner; }, get proactive() { return proactive; }, get planning() { return planning; },
    time(value) { t.mock.timers.setTime(value); },
    reopen() { sqlite.close(); sqlite = new DatabaseSync(path); owner = new Store(db); proactive = new ProactiveStore(owner, "UTC"); planning = new PlanningStore(proactive, "UTC"); },
  };
}
function activate(f: Fixture) {
  const today = planningDay(Date.now(), "UTC");
  f.planning.request(today, "control", FOREGROUND);
  f.time(Date.now() + 1_000);
  f.proactive.drive(Date.now(), false, { control: BACKGROUND });
  const run = f.proactive.runForSession(BACKGROUND)!;
  f.owner.submitted(run.operationId);
  return run;
}
function capture(f: Fixture, target: string | null = null) {
  const day = planningDay(Date.now(), "UTC"), checkedAt = new Date(Date.now()).toISOString();
  return f.planning.capture(BACKGROUND, { day, checkedAt, revision: vaultNoteRevision(target), target, template: TEMPLATE, recent: [] },
    { day, timezone: "UTC", checkedAt, coverage: "unavailable", events: [], issues: ["Authorization absent"] }, 1);
}
const patch = { entries: [{ id: "owner-task-1", section: "tasks" as const, text: "Compare the two release options" }], coverage: [] };

test("a completed early manual plan does not consume the daily wall-clock preparation", t => {
  const f = fixture(t), run = activate(f), captured = capture(f);
  const intent = f.planning.prepare(BACKGROUND, captured.version, patch, 1);
  f.planning.finish(intent.intentId, { status: "synced", revision: vaultNoteRevision(intent.text), checkedAt: new Date(Date.now()).toISOString() });
  f.proactive.report(BACKGROUND, { outcome: "completed", note: "The intended note has a verified upload receipt." });
  f.owner.settle(run.operationId, "");
  f.time(Date.parse("2027-02-10T02:30:00Z"));
  f.planning.drive("control", FOREGROUND, true);
  const automatic = f.planning.plan("2027-02-10")!;
  assert.equal(automatic.attempt, 2);
  assert.equal(automatic.automatic, true);
  assert.equal(automatic.scheduled, true);
  assert.notEqual(automatic.commitmentId, run.commitmentId);
  const version = automatic.version;
  f.planning.drive("control", FOREGROUND, true);
  assert.equal(f.planning.plan(automatic.day)?.version, version);
  assert.equal(f.planning.nextDue(), Date.parse("2027-02-11T02:30:00Z"));
});

test("late restart coalesces days and missing setup produces no model turn or hot loop", t => {
  const f = fixture(t);
  f.reopen(); f.time(Date.parse("2027-02-14T10:00:00Z"));
  f.planning.drive("control", FOREGROUND, false);
  assert.equal(f.planning.plan("2027-02-14")?.status, "blocked");
  assert.equal(f.planning.plan("2027-02-13"), undefined);
  assert.equal(f.planning.plan("2027-02-10"), undefined);
  f.proactive.drive(Date.now(), false, { control: BACKGROUND });
  assert.equal(f.owner.pendingOperations().length, 0);
  assert.equal(f.planning.nextDue(), Date.parse("2027-02-15T02:30:00Z"));
  f.reopen();
  assert.equal(f.planning.nextDue(), Date.parse("2027-02-15T02:30:00Z"));
});

test("unconfirmed intent survives restart/day expiry and only owner release unblocks later preparation", t => {
  const f = fixture(t); activate(f);
  const captured = capture(f), intent = f.planning.prepare(BACKGROUND, captured.version, patch, 1);
  f.reopen();
  assert.equal(f.planning.pending()?.text, intent.text);
  f.time(Date.parse("2027-02-11T03:00:00Z"));
  f.planning.drive("control", FOREGROUND, true);
  assert.equal(f.planning.plan("2027-02-10")?.status, "cancelled");
  assert.equal(f.planning.plan("2027-02-11")?.status, "blocked");
  assert.throws(() => f.planning.request("2027-02-11", "control", FOREGROUND), StateError);
  assert.throws(() => f.planning.abandonIntent(intent.intentId, "unconfirmed"), StateError);
  f.planning.abandonIntent(intent.intentId, "prepared");
  const next = f.planning.request("2027-02-11", "control", FOREGROUND);
  f.planning.finish(intent.intentId, { status: "synced", revision: vaultNoteRevision(intent.text), checkedAt: new Date(Date.now()).toISOString() });
  assert.equal(f.planning.intent(intent.intentId)?.status, "abandoned");
  assert.equal(f.planning.intent(intent.intentId)?.result?.status, "synced");
  assert.equal(f.planning.plan("2027-02-10")?.status, "cancelled");
  assert.equal(f.planning.plan("2027-02-11")?.commitmentId, next.commitmentId);
  assert.equal(f.planning.pending(), undefined);
});

test("owner brief and settings edits invalidate stale planning effects without creating a replacement write", t => {
  const f = fixture(t); activate(f);
  const captured = capture(f);
  f.planning.setBrief({ day: captured.day, expectedVersion: 0, text: "Only compare the release options; defer implementation." });
  assert.throws(() => f.planning.prepare(BACKGROUND, captured.version, patch, 1), StateError);
  assert.equal(f.planning.pending(), undefined);
  const fresh = capture(f);
  assert.equal(fresh.inputs?.brief?.version, 1);
  const settings = f.planning.settings();
  f.planning.configure({ expectedVersion: settings.version, enabled: false, time: settings.time });
  assert.throws(() => f.planning.prepare(BACKGROUND, fresh.version, patch, 1), StateError);
  assert.equal(f.planning.pending(), undefined);
  assert.equal(f.planning.nextDue(), undefined);
});

test("explicit same-day recovery renews a stopped review and retains the original source/version evidence", t => {
  const f = fixture(t), run = activate(f), captured = capture(f);
  const intent = f.planning.prepare(BACKGROUND, captured.version, patch, 1);
  f.planning.finish(intent.intentId, { status: "unconfirmed", revision: intent.beforeRevision, checkedAt: new Date(Date.now()).toISOString() });
  f.proactive.report(BACKGROUND, { outcome: "blocked", note: "The upload did not return a confirmation." });
  f.owner.settle(run.operationId, ""); f.planning.reconcile();
  const retried = f.planning.request(captured.day, "control", FOREGROUND);
  assert.notEqual(retried.commitmentId, run.commitmentId);
  assert.equal(retried.intentId, intent.intentId);
  assert.equal(retried.inputs?.coreRevision, captured.inputs?.coreRevision);
  assert.equal(retried.inputs?.vault.revision, captured.inputs?.vault.revision);
  assert.equal(f.planning.pending()?.text, intent.text);
});

test("automatic capacity rejection is durable and does not stop other responsibility admission", t => {
  const f = fixture(t);
  for (let index = 0; index < 64; index++) f.proactive.createCommitment({
    id: `existing-${index}`, purpose: "Review a synthetic responsibility", source: "Owner request",
    nextAction: "Review", blocker: null, status: "active", nextReviewAt: "2027-02-10T02:00:00Z", jobId: null, allowNotify: false,
  }, "control", FOREGROUND);
  f.time(Date.parse("2027-02-10T02:30:00Z"));
  f.planning.drive("control", FOREGROUND, true);
  const blocked = f.planning.plan("2027-02-10")!;
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.attempt, 1);
  assert.equal(blocked.commitmentId, null);
  f.proactive.drive(Date.now(), false, { control: BACKGROUND });
  assert.ok(f.proactive.runForSession(BACKGROUND));
  f.reopen();
  f.planning.drive("control", FOREGROUND, true);
  assert.deepEqual(f.planning.plan(blocked.day), blocked);
  assert.equal(f.planning.nextDue(), Date.parse("2027-02-11T02:30:00Z"));
});

test("wake admission rejection rolls back the new responsibility, but unexpected errors escape", t => {
  const f = fixture(t);
  f.time(Date.parse("2027-02-10T02:30:00Z"));
  const schedule = t.mock.method(f.proactive, "scheduleWakeup", () => { throw new ProactiveCapacityError("Wake registry is full"); });
  f.planning.drive("control", FOREGROUND, true);
  assert.equal(f.planning.plan("2027-02-10")?.status, "blocked");
  assert.equal(f.proactive.db.all("SELECT id FROM umpi_commitments").length, 0);
  assert.equal(f.planning.due(), false);
  schedule.mock.restore();
  f.time(Date.parse("2027-02-11T02:30:00Z"));
  const failure = new Error("Unexpected storage failure");
  t.mock.method(f.proactive, "scheduleWakeup", () => { throw failure; });
  assert.throws(() => f.planning.drive("control", FOREGROUND, true), error => error === failure);
  assert.equal(f.planning.plan("2027-02-11"), undefined);
});

test("an explicit same-day deferred review keeps input and write authority through its heartbeat", t => {
  const f = fixture(t), run = activate(f);
  f.proactive.report(BACKGROUND, { outcome: "deferred", note: "Review after the source refresh", nextReviewAt: "2027-02-10T01:30:00Z" });
  f.owner.settle(run.operationId, "");
  f.planning.reconcile();
  assert.equal(f.planning.plan("2027-02-10")?.status, "requested");
  f.time(Date.parse("2027-02-10T01:30:00Z"));
  f.proactive.drive(Date.now(), false, { control: BACKGROUND });
  const heartbeat = f.proactive.runForSession(BACKGROUND)!;
  assert.equal(heartbeat.trigger, "heartbeat");
  f.owner.submitted(heartbeat.operationId);
  f.planning.reconcile();
  const captured = capture(f);
  const intent = f.planning.prepare(BACKGROUND, captured.version, patch, 1);
  assert.equal(f.planning.forSession(BACKGROUND).intentId, intent.intentId);
  // Unstructured termination of that heartbeat must not retain preparation authority.
  f.owner.settle(heartbeat.operationId, "");
  f.proactive.drive(Date.now(), false, { control: BACKGROUND });
  f.planning.reconcile();
  assert.equal(f.planning.plan(captured.day)?.status, "blocked");
  assert.throws(() => f.planning.forSession(BACKGROUND), StateError);
  assert.equal(f.planning.pending()?.intentId, intent.intentId);
});

test("a deferred review without a same-day next review stops preparation", t => {
  const f = fixture(t), run = activate(f);
  f.proactive.report(BACKGROUND, { outcome: "deferred", note: "No same-day source availability", nextReviewAt: "2027-02-11T01:30:00Z" });
  f.owner.settle(run.operationId, "");
  f.planning.reconcile();
  assert.equal(f.planning.plan("2027-02-10")?.status, "blocked");
});

test("an ordinary one-shot turn without a structured report stops planning", t => {
  const f = fixture(t), run = activate(f);
  f.owner.settle(run.operationId, "");
  f.proactive.drive(Date.now(), false, { control: BACKGROUND });
  f.planning.reconcile();
  assert.equal(f.planning.plan("2027-02-10")?.status, "blocked");
  assert.throws(() => f.planning.forSession(BACKGROUND), StateError);
});

for (const outcome of ["blocked", "synced", "completed"] as const) test(`day expiry retires ${outcome} planning responsibility without changing note evidence`, t => {
  const f = fixture(t), run = activate(f);
  let intentId: string | undefined;
  if (outcome !== "blocked") {
    const captured = capture(f), intent = f.planning.prepare(BACKGROUND, captured.version, patch, 1);
    intentId = intent.intentId;
    f.planning.finish(intentId, { status: "synced", revision: vaultNoteRevision(intent.text), checkedAt: new Date(Date.now()).toISOString() });
  }
  if (outcome !== "synced") f.proactive.report(BACKGROUND, { outcome: outcome === "completed" ? "completed" : "blocked", note: "Truthful review outcome" });
  f.owner.settle(run.operationId, "");
  f.proactive.drive(Date.now(), false, { control: BACKGROUND });
  f.planning.reconcile();
  const before = f.planning.plan("2027-02-10")!, commitment = f.proactive.commitment(run.commitmentId)!;
  const receipt = intentId ? f.planning.intent(intentId) : undefined;
  f.time(Date.parse("2027-02-11T01:00:00Z"));
  f.planning.drive("control", FOREGROUND, true);
  assert.deepEqual(f.planning.plan(before.day), before);
  assert.equal(f.proactive.commitment(run.commitmentId)?.status, outcome === "completed" ? "completed" : "cancelled");
  if (outcome === "completed") assert.deepEqual(f.proactive.commitment(run.commitmentId), commitment);
  if (intentId) assert.deepEqual(f.planning.intent(intentId), receipt);
});
