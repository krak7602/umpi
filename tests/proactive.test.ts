import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InputError } from "../src/shared/protocol.js";
import { Store, StateError, type Channel, type Database } from "../src/worker/store.js";
import { HEARTBEAT_MS, ProactiveStore, type Commitment } from "../src/worker/proactive-store.js";

const BASE = Date.parse("2026-10-12T12:00:00Z");
const sessions = { control: "background-control", telegram: "background-telegram" };
const at = (now: number): string => new Date(now).toISOString();
function fixture(t: TestContext, timezone = "UTC", start = BASE) {
  const directory = mkdtempSync(join(tmpdir(), "umpi-proactive-")), path = join(directory, "state.sqlite");
  let sqlite = new DatabaseSync(path), depth = 0, now = start;
  t.mock.timers.enable({ apis: ["Date"], now: start });
  const db: Database = {
    all: <T extends object>(query: string, ...bindings: (string | number | null)[]) => sqlite.prepare(query).all(...bindings) as T[],
    transaction: <T>(run: () => T): T => {
      const savepoint = `proactive_${depth++}`; sqlite.exec(`SAVEPOINT ${savepoint}`);
      try { const result = run(); sqlite.exec(`RELEASE ${savepoint}`); return result; }
      catch (error) { sqlite.exec(`ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`); throw error; }
      finally { depth--; }
    },
  };
  let owner = new Store(db);
  owner.setSession("control", "foreground-control"); owner.setSession("telegram", "foreground-telegram");
  owner.registerBackgroundSession(sessions.control, "control"); owner.registerBackgroundSession(sessions.telegram, "telegram");
  let proactive = new ProactiveStore(owner, timezone);
  t.after(() => { sqlite.close(); rmSync(directory, { recursive: true, force: true }); });
  return {
    db, get owner() { return owner; }, get proactive() { return proactive; },
    time(value: number) { now = value; t.mock.timers.setTime(value); },
    enable(quietHours: { start: string; end: string } | null = null) { return proactive.configure({ expectedVersion: proactive.settings().version, enabled: true, quietHours }, now); },
    drive(busy = false, available: Partial<Record<Channel, string>> = sessions) { proactive.drive(now, busy, available); },
    reopen() { sqlite.close(); sqlite = new DatabaseSync(path); owner = new Store(db); proactive = new ProactiveStore(owner, timezone); },
  };
}
function responsibility(id = "commitment-1", nextReviewAt: string | null = null, allowNotify = false) {
  return { id, purpose: "Review the requested export", source: "Owner requested an export status check", nextAction: "Inspect the recorded export result", blocker: null, status: "active", nextReviewAt, jobId: null, allowNotify };
}
function edit(commitment: Commitment) {
  const { purpose, source, nextAction, blocker, status, nextReviewAt, jobId } = commitment;
  return { expectedVersion: commitment.version, purpose, source, nextAction, blocker, status, nextReviewAt, jobId };
}
function wake(id = "wake-1", commitmentId = "commitment-1", due = BASE + 60_000, expires = due + 60_000, repeatEveryMinutes: number | null = null) {
  return { id, commitmentId, purpose: "Review the requested export", dueAt: at(due), expiresAt: at(expires), repeatEveryMinutes };
}
function assignment(jobId = "job-1") { return { jobId, command: "printf export-ready", cwd: "/workspace", timeoutMs: 10_000, createdAt: at(Date.now()) }; }
function finishJob(owner: Store, jobId = "job-1") {
  owner.approveJob(jobId, 1); owner.poll({ executorId: "executor-1", workspaces: ["/workspace"] });
  return owner.complete({ executorId: "executor-1", jobId, status: "succeeded", exitCode: 0, output: "export-ready", truncated: false, finishedAt: at(Date.now()) });
}

test("disabled is durable; a custom wake runs before heartbeat once and recovers the same operation", t => {
  const f = fixture(t);
  f.proactive.createCommitment(responsibility(), "control", "foreground-control"); f.proactive.scheduleWakeup(wake());
  f.time(BASE + 60_000); f.drive(); assert.equal(f.owner.pendingOperations().length, 0); assert.equal(f.proactive.nextDue(Date.now(), false), undefined);
  f.enable(); f.drive(); const run = f.proactive.runForSession(sessions.control)!;
  assert.equal(run.trigger, "wakeup"); assert.equal(f.proactive.settings().nextHeartbeatAt, Date.now() + HEARTBEAT_MS);
  assert.equal(f.owner.operation(run.operationId)?.background?.runId, run.id);
  f.reopen(); f.drive(); f.drive(); assert.equal(f.proactive.runForSession(sessions.control)?.id, run.id); assert.equal(f.owner.pendingOperations().length, 1);
  const reported = f.proactive.report(sessions.control, { outcome: "no_action", note: "No export completion has been recorded." });
  assert.equal(reported.status, "completed"); assert.equal(f.proactive.commitment("commitment-1")?.nextReviewAt, null);
  assert.throws(() => f.proactive.report(sessions.control, { outcome: "completed", note: "A second report is not allowed." }), StateError);
  f.owner.settle(run.operationId, "This unstructured answer must not be delivered."); f.drive();
  assert.equal(f.owner.deliveries().length, 0); assert.equal(f.proactive.status().runs.length, 1);
});

test("idle and unchanged blocked obligations get quiet heartbeat checks, not model loops", t => {
  const f = fixture(t); f.enable();
  f.proactive.createCommitment({ ...responsibility(), status: "blocked", blocker: "Waiting for owner input" }, "control", "foreground-control");
  for (let tick = 1; tick <= 4; tick++) { f.time(BASE + tick * HEARTBEAT_MS); f.drive(); }
  assert.equal(f.proactive.status().runs.length, 0); assert.match(f.proactive.status().lastCheck!.reason, /No eligible/);
  assert.equal(f.proactive.settings().nextHeartbeatAt, BASE + 5 * HEARTBEAT_MS);
});

test("a busy heartbeat and missing session retain eligibility with bounded wake backoff", t => {
  const f = fixture(t); f.enable(); f.proactive.createCommitment(responsibility("commitment-1", at(BASE + 1)), "control", "foreground-control");
  f.time(BASE + HEARTBEAT_MS); f.drive(true); assert.equal(f.proactive.status().runs.length, 0);
  assert.equal(f.proactive.nextDue(Date.now(), true), Date.now() + 60_000);
  f.time(Date.now() + 60_000); f.drive(false, {}); assert.equal(f.proactive.status().runs.length, 0);
  assert.equal(f.proactive.nextDue(Date.now(), false), Date.now() + 60_000);
  f.drive(); assert.equal(f.proactive.runForSession(sessions.control)?.trigger, "heartbeat");
  assert.equal(f.proactive.commitment("commitment-1")?.nextReviewAt, null);
});

test("commitment CAS invalidates old wake and submitted run without reusing its session early", t => {
  const f = fixture(t); f.enable();
  const initial = f.proactive.createCommitment(responsibility(), "control", "foreground-control"); f.proactive.scheduleWakeup(wake());
  f.time(BASE + 60_000); f.drive(); const run = f.proactive.runForSession(sessions.control)!; f.owner.submitted(run.operationId);
  const changed = f.proactive.updateCommitment(initial.id, { ...edit(initial), nextAction: "Inspect the corrected export instead", nextReviewAt: at(BASE + HEARTBEAT_MS) });
  assert.equal(changed.version, 2); assert.equal(f.proactive.wakeup("wake-1")?.status, "cancelled"); assert.equal(f.proactive.run(run.id)?.status, "superseded");
  assert.throws(() => f.proactive.updateCommitment(initial.id, edit(initial)), StateError);
  assert.throws(() => f.proactive.assertRunCurrent(sessions.control), StateError);
  f.proactive.scheduleWakeup(wake("wake-2", initial.id, Date.now() + 1, Date.now() + HEARTBEAT_MS * 2));
  f.time(Date.now() + 1); f.drive(); assert.equal(f.proactive.status().runs.length, 1);
  assert.equal(f.owner.operation(run.operationId)?.status, "submitted");
  f.owner.settle(run.operationId, "Old review aborted", true); f.drive();
  assert.notEqual(f.proactive.runForSession(sessions.control)?.id, run.id); assert.equal(f.proactive.status().runs.length, 2);
  assert.equal(f.owner.deliveries().length, 0);
});

test("moving or cancelling a running wake invalidates the claim and rejects stale editors", t => {
  const f = fixture(t); f.enable(); f.proactive.createCommitment(responsibility(), "control", "foreground-control"); f.proactive.scheduleWakeup(wake());
  f.time(BASE + 60_000); f.drive(); const old = f.proactive.runForSession(sessions.control)!;
  const moved = f.proactive.updateWakeup("wake-1", { expectedVersion: 1, purpose: "Review the requested export", dueAt: at(BASE + 120_000), expiresAt: at(BASE + 180_000), repeatEveryMinutes: null });
  assert.equal(moved.version, 2); assert.equal(f.proactive.run(old.id)?.status, "superseded"); assert.equal(f.owner.operation(old.operationId)?.status, "failed");
  assert.throws(() => f.proactive.cancelWakeup("wake-1", 1), StateError);
  f.time(BASE + 120_000); f.drive(); const next = f.proactive.runForSession(sessions.control)!;
  f.proactive.cancelWakeup("wake-1", 2); assert.equal(f.proactive.run(next.id)?.status, "superseded");
  assert.throws(() => f.proactive.report(sessions.control, { outcome: "advanced", note: "The cancelled review cannot report." }), StateError);
});

test("missed custom windows expire; recurring missed occurrences coalesce without catch-up turns", t => {
  const f = fixture(t); f.enable(); f.proactive.createCommitment(responsibility(), "control", "foreground-control");
  f.proactive.scheduleWakeup(wake()); f.time(BASE + 120_000); f.drive();
  assert.equal(f.proactive.wakeup("wake-1")?.status, "expired"); assert.equal(f.proactive.status().runs.length, 0);
  f.proactive.scheduleWakeup(wake("repeat", "commitment-1", BASE + 180_000, BASE + 240_000, 15));
  f.time(BASE + 61 * 60_000); f.drive();
  const recurring = f.proactive.wakeup("repeat")!;
  assert.equal(recurring.status, "scheduled"); assert.equal(recurring.dueAt, at(BASE + 63 * 60_000)); assert.equal(recurring.expiresAt, at(BASE + 64 * 60_000));
  assert.equal(f.proactive.status().runs.length, 0);
});

test("recurrence advances beyond now with its useful window, and blocked stops it", t => {
  const f = fixture(t); f.enable(); f.proactive.createCommitment(responsibility(), "control", "foreground-control");
  f.proactive.scheduleWakeup(wake("repeat", "commitment-1", BASE + 60_000, BASE + 60 * 60_000, 15));
  f.time(BASE + 32 * 60_000); f.drive(); const first = f.proactive.runForSession(sessions.control)!;
  f.proactive.report(sessions.control, { outcome: "advanced", note: "The export produced a new intermediate result." }); f.owner.settle(first.operationId, "");
  assert.equal(f.proactive.wakeup("repeat")?.dueAt, at(BASE + 46 * 60_000)); assert.equal(f.proactive.wakeup("repeat")?.expiresAt, at(BASE + 105 * 60_000));
  assert.equal(f.proactive.wakeup("repeat")?.commitmentVersion, f.proactive.commitment("commitment-1")?.version);
  f.time(BASE + 46 * 60_000); f.drive(); const second = f.proactive.runForSession(sessions.control)!;
  f.proactive.report(sessions.control, { outcome: "blocked", note: "Further progress requires owner input.", blocker: "Choose an export destination" }); f.owner.settle(second.operationId, "");
  assert.equal(f.proactive.wakeup("repeat")?.status, "cancelled"); f.time(BASE + 120 * 60_000); f.drive(); assert.equal(f.proactive.status().runs.length, 2);
});

test("a failed or unstructured proactive turn cannot repeat every heartbeat or recurrence", t => {
  const f = fixture(t); f.enable(); f.proactive.createCommitment(responsibility("commitment-1", at(BASE + 1)), "control", "foreground-control");
  f.proactive.scheduleWakeup(wake("repeat", "commitment-1", BASE + 60_000, BASE + 60 * 60_000, 15));
  f.time(BASE + 60_000); f.drive(); const run = f.proactive.runForSession(sessions.control)!;
  f.owner.settle(run.operationId, "Provider failure", true); f.drive();
  assert.equal(f.proactive.run(run.id)?.status, "failed"); assert.equal(f.proactive.wakeup("repeat")?.status, "cancelled");
  f.time(BASE + 10 * HEARTBEAT_MS); f.drive(); assert.equal(f.proactive.status().runs.length, 1); assert.equal(f.owner.deliveries().length, 0);
});

test("an explicit deferred review is admitted only at a heartbeat and report silence is durable", t => {
  const f = fixture(t); f.enable(); f.proactive.createCommitment(responsibility("commitment-1", at(BASE + 1)), "control", "foreground-control");
  f.time(BASE + HEARTBEAT_MS); f.drive(); const first = f.proactive.runForSession(sessions.control)!;
  f.proactive.report(sessions.control, { outcome: "deferred", note: "Check the export after its documented processing window.", nextReviewAt: at(BASE + HEARTBEAT_MS + 60_000) }); f.owner.settle(first.operationId, "");
  f.time(BASE + HEARTBEAT_MS + 60_000); f.drive(); assert.equal(f.proactive.status().runs.length, 1);
  f.time(BASE + 2 * HEARTBEAT_MS); f.drive(); assert.equal(f.proactive.status().runs.length, 2);
  assert.equal(f.proactive.status().runs.find(run => run.id === first.id)?.outcome, "deferred"); assert.equal(f.owner.deliveries().length, 0);
});

test("notifications require original permission and meaningful non-no_action results", t => {
  const f = fixture(t); f.enable(); f.proactive.createCommitment(responsibility(), "control", "foreground-control"); f.proactive.scheduleWakeup(wake());
  f.time(BASE + 60_000); f.drive(); const first = f.proactive.runForSession(sessions.control)!;
  assert.equal(f.proactive.report(sessions.control, { outcome: "advanced", note: "The export status changed.", notification: "The export has progressed." }).notification?.status, "suppressed"); f.owner.settle(first.operationId, "");
  f.proactive.createCommitment(responsibility("notify", null, true), "control", "foreground-control"); f.proactive.scheduleWakeup(wake("notify-wake", "notify", Date.now() + 1, Date.now() + 60_000));
  f.time(Date.now() + 1); f.drive();
  const report = f.proactive.report(sessions.control, { outcome: "no_action", note: "There is no new recorded export evidence.", notification: "Please check again." });
  assert.equal(report.notification?.status, "suppressed"); assert.equal(f.owner.deliveries().length, 0);
});

test("notification text deduplication survives restart and a later recurring review", t => {
  const f = fixture(t); f.enable(); f.proactive.createCommitment(responsibility("commitment-1", null, true), "control", "foreground-control");
  f.proactive.scheduleWakeup(wake("repeat", "commitment-1", BASE + 60_000, BASE + 60 * 60_000, 15));
  f.time(BASE + 60_000); f.drive(); const first = f.proactive.runForSession(sessions.control)!;
  f.proactive.report(sessions.control, { outcome: "advanced", note: "The export reached its first stage.", notification: "The export is ready for review." }); f.owner.settle(first.operationId, "");
  assert.equal(f.owner.deliveries(`proactive:${first.id}`).length, 1);
  f.reopen(); f.time(BASE + 16 * 60_000); f.drive(); const second = f.proactive.runForSession(sessions.control)!;
  const report = f.proactive.report(sessions.control, { outcome: "advanced", note: "The export is still at its first stage.", notification: "The export is ready for review." });
  assert.equal(report.notification?.reason, "Repeated notification text"); assert.equal(f.owner.deliveries(`proactive:${second.id}`).length, 0);
});

test("quiet notifications persist across restart and disable, then release exactly once", t => {
  const start = Date.parse("2026-10-12T22:59:00Z"), morning = Date.parse("2026-10-13T07:00:00Z");
  const f = fixture(t, "UTC", start); f.enable({ start: "22:00", end: "07:00" });
  f.proactive.createCommitment(responsibility("commitment-1", null, true), "control", "foreground-control"); f.proactive.scheduleWakeup(wake("wake-1", "commitment-1", start + 60_000, morning + 60_000));
  f.time(start + 60_000); f.drive(); const run = f.proactive.runForSession(sessions.control)!;
  const report = f.proactive.report(sessions.control, { outcome: "completed", note: "The recorded export completed successfully.", notification: "Your requested export completed." }); f.owner.settle(run.operationId, "");
  assert.equal(report.notification?.status, "deferred"); assert.equal(report.notification?.dueAt, morning); assert.equal(f.owner.deliveries().length, 0);
  f.proactive.configure({ expectedVersion: f.proactive.settings().version, enabled: false, quietHours: { start: "22:00", end: "07:00" } });
  f.reopen(); f.time(morning); f.drive(); assert.equal(f.owner.deliveries().length, 0);
  f.enable({ start: "22:00", end: "07:00" }); f.drive(); f.drive();
  assert.equal(f.owner.deliveries(`proactive:${run.id}`).length, 1); assert.equal(f.proactive.run(run.id)?.notification?.status, "enqueued");
});

test("quiet notifications expire or become irrelevant on commitment edits", t => {
  const start = Date.parse("2026-10-12T22:00:00Z"), f = fixture(t, "UTC", start); f.enable({ start: "22:00", end: "07:00" });
  for (const [index, cancel] of [false, true].entries()) {
    const id = `commitment-${index}`;
    f.proactive.createCommitment(responsibility(id, null, true), "control", "foreground-control"); f.proactive.scheduleWakeup(wake(`wake-${index}`, id, Date.now() + 1, Date.now() + 60_000));
    f.time(Date.now() + 1); f.drive(); const run = f.proactive.runForSession(sessions.control)!;
    f.proactive.report(sessions.control, { outcome: "advanced", note: "The export status changed.", notification: `Export ${index} progressed.` }); f.owner.settle(run.operationId, "");
    if (cancel) f.proactive.updateCommitment(id, { ...edit(f.proactive.commitment(id)!), status: "cancelled" });
    f.time(Date.now() + 60_000); f.drive(); assert.equal(f.proactive.run(run.id)?.notification?.status, "dropped");
  }
  assert.equal(f.owner.deliveries().length, 0);
});

test("the last-mile delivery guard catches cancellation, disabling and newly configured quiet hours", t => {
  const f = fixture(t); f.enable(); f.proactive.createCommitment(responsibility("commitment-1", null, true), "telegram", "foreground-telegram");
  f.proactive.scheduleWakeup(wake("wake-1", "commitment-1", BASE + 60_000, BASE + 3 * 60 * 60_000));
  f.time(BASE + 60_000); f.drive(); const run = f.proactive.runForSession(sessions.telegram)!;
  f.proactive.report(sessions.telegram, { outcome: "advanced", note: "The export changed.", notification: "The export is ready." }); f.owner.settle(run.operationId, "");
  const group = `proactive:${run.id}`; assert.equal(f.proactive.notificationDeliveryState(group), "ready");
  f.proactive.configure({ expectedVersion: f.proactive.settings().version, enabled: false, quietHours: null });
  assert.equal(f.proactive.notificationDeliveryState(group), "deferred"); assert.equal(f.proactive.nextDue(Date.now(), false), undefined);
  f.enable({ start: "12:00", end: "12:02" }); f.owner.holdDeliveryGroup(group, true);
  assert.equal(f.proactive.notificationDeliveryState(group), "deferred"); assert.equal(f.proactive.nextDue(Date.now(), false), BASE + 120_000);
  f.time(BASE + 120_000); assert.equal(f.proactive.notificationDeliveryState(group), "ready");
  f.proactive.updateCommitment("commitment-1", { ...edit(f.proactive.commitment("commitment-1")!), status: "cancelled" });
  assert.equal(f.proactive.notificationDeliveryState(group), "drop"); assert.equal(f.proactive.notificationDeliveryState("answer:ordinary"), "ready");
});

test("quiet-end resolution handles DST gaps without a timer or timezone offset assumption", t => {
  const start = Date.parse("2026-03-08T06:29:00Z"), end = Date.parse("2026-03-08T07:00:00Z");
  const f = fixture(t, "America/New_York", start); f.enable({ start: "01:00", end: "02:30" });
  f.proactive.createCommitment(responsibility("commitment-1", null, true), "control", "foreground-control"); f.proactive.scheduleWakeup(wake("wake-1", "commitment-1", start + 60_000, end + 60_000));
  f.time(start + 60_000); f.drive(); const report = f.proactive.report(sessions.control, { outcome: "advanced", note: "The export produced new evidence.", notification: "Export evidence is available." });
  assert.equal(report.notification?.dueAt, end);
});

test("job completion coalesces with a due wake and heartbeat, persists while disabled and leaves unlinked jobs unchanged", t => {
  const f = fixture(t);
  f.owner.createJob(assignment(), "control", "foreground-control");
  f.proactive.createCommitment({ ...responsibility("commitment-1", at(BASE + 1)), jobId: "job-1" }, "control", "foreground-control");
  f.proactive.scheduleWakeup(wake("wake-1", "commitment-1", BASE + HEARTBEAT_MS, BASE + 2 * HEARTBEAT_MS));
  finishJob(f.owner); assert.equal(f.owner.operation("job:job-1:completion"), undefined); f.reopen();
  f.time(BASE + HEARTBEAT_MS); f.drive(); assert.equal(f.proactive.status().runs.length, 0);
  f.enable(); f.drive(); const run = f.proactive.runForSession(sessions.control)!;
  assert.equal(run.wakeupId, "wake-1"); assert.match(f.owner.operation(run.operationId)!.text, /export-ready/);
  f.proactive.report(sessions.control, { outcome: "no_action", note: "The recorded job result was reviewed privately." }); f.owner.settle(run.operationId, ""); f.drive();
  assert.equal(f.proactive.status().runs.length, 1);
  f.owner.createJob(assignment("unlinked"), "control", "foreground-control"); finishJob(f.owner, "unlinked"); assert.ok(f.owner.operation("job:unlinked:completion"));
});

test("a completion event supersedes an in-flight review and waits for its operation to finish", t => {
  const f = fixture(t); f.enable(); f.owner.createJob(assignment(), "control", "foreground-control");
  f.proactive.createCommitment({ ...responsibility(), jobId: "job-1" }, "control", "foreground-control"); f.proactive.scheduleWakeup(wake());
  f.time(BASE + 60_000); f.drive(); const old = f.proactive.runForSession(sessions.control)!; f.owner.submitted(old.operationId);
  finishJob(f.owner); assert.equal(f.proactive.run(old.id)?.status, "superseded"); f.drive(); assert.equal(f.proactive.status().runs.length, 1);
  assert.throws(() => f.proactive.report(sessions.control, { outcome: "advanced", note: "This review lost its claim." }), StateError);
  f.owner.settle(old.operationId, "Aborted stale review", true); f.drive(); const next = f.proactive.runForSession(sessions.control)!;
  assert.notEqual(next.id, old.id); assert.equal(next.wakeupId, "wake-1"); assert.equal(f.owner.operation("job:job-1:completion"), undefined);
});

test("background jobs bind atomically to the run without approval or duplicate job ownership", t => {
  const f = fixture(t); f.enable(); f.proactive.createCommitment(responsibility("commitment-1", null, true), "control", "foreground-control"); f.proactive.scheduleWakeup(wake());
  f.time(BASE + 60_000); f.drive(); const run = f.proactive.runForSession(sessions.control)!;
  const job = f.owner.createJob(assignment(), "control", sessions.control);
  assert.equal(job.status, "pending_approval"); assert.equal(f.owner.poll({ executorId: "executor-1", workspaces: ["/workspace"] }).job, null);
  assert.equal(f.proactive.commitment("commitment-1")?.jobId, job.jobId); assert.equal(f.proactive.commitment("commitment-1")?.version, run.commitmentVersion);
  assert.throws(() => f.owner.createJob(assignment("job-2"), "control", sessions.control), StateError); assert.equal(f.owner.job("job-2"), undefined);
  assert.throws(() => f.proactive.createCommitment({ ...responsibility("other"), jobId: job.jobId }, "control", "foreground-control"), StateError);
  f.proactive.updateCommitment("commitment-1", { ...edit(f.proactive.commitment("commitment-1")!), status: "cancelled" });
  finishJob(f.owner); assert.equal(f.owner.operation("job:job-1:completion"), undefined);
});

test("background approval requests cannot bypass permission, quiet hours or a foreground arrival", async t => {
  for (const condition of ["permission", "quiet", "foreground"] as const) await t.test(condition, child => {
    const f = fixture(child); f.enable(condition === "quiet" ? { start: "12:00", end: "13:00" } : null);
    f.proactive.createCommitment(responsibility("commitment-1", null, condition !== "permission"), "control", "foreground-control"); f.proactive.scheduleWakeup(wake());
    f.time(BASE + 60_000); f.drive();
    if (condition === "foreground") f.owner.admit("owner-arrival", "Change the requested export", "control", "foreground-control");
    assert.equal(f.proactive.mayInterrupt(sessions.control), false);
    assert.throws(() => f.owner.createJob(assignment(), "control", sessions.control), StateError);
    assert.equal(f.owner.job("job-1"), undefined); assert.equal(f.owner.deliveries().length, 0);
  });
});

test("unknown fields, malformed versions, timestamps, immutable permissions and cross-channel links fail closed", t => {
  const f = fixture(t); const commitment = f.proactive.createCommitment(responsibility(), "control", "foreground-control");
  for (const body of [
    { ...edit(commitment), expectedVersion: "1" }, { ...edit(commitment), allowNotify: true },
    { ...edit(commitment), nextReviewAt: "2026-10-12T12:01:00" }, { ...edit(commitment), nextReviewAt: at(BASE) },
    { ...edit(commitment), purpose: " " }, { ...edit(commitment), source: "x".repeat(2001) }, { ...edit(commitment), nextAction: "bad\ud800" },
  ]) assert.throws(() => f.proactive.updateCommitment(commitment.id, body), InputError);
  for (const body of [wake("bad", commitment.id, BASE, BASE + 1), { ...wake("bad"), repeatEveryMinutes: 14 }, { ...wake("bad"), expiresAt: at(BASE + 60_000) }, { ...wake("bad"), allowNotify: true }]) assert.throws(() => f.proactive.scheduleWakeup(body), InputError);
  assert.throws(() => f.proactive.configure({ expectedVersion: 1, enabled: true, quietHours: { start: "22:00", end: "22:00" } }), InputError);
  assert.throws(() => f.proactive.configure({ expectedVersion: 1, enabled: true, quietHours: null, intervalMs: 1 }), InputError);
  f.owner.createJob(assignment(), "telegram", "foreground-telegram"); assert.throws(() => f.proactive.updateCommitment(commitment.id, { ...edit(commitment), jobId: "job-1" }), StateError);
  assert.throws(() => f.proactive.createCommitment(responsibility("background-created"), "control", sessions.control), StateError);
  assert.equal(f.proactive.commitment(commitment.id)?.version, 1); assert.equal(f.proactive.wakeups().length, 0);
});

test("live record caps and one-wake-per-commitment keep due scans bounded", t => {
  const f = fixture(t);
  for (let index = 0; index < 64; index++) {
    const id = `commitment-${index}`; f.proactive.createCommitment(responsibility(id), "control", "foreground-control"); f.proactive.scheduleWakeup(wake(`wake-${index}`, id));
  }
  assert.throws(() => f.proactive.createCommitment(responsibility("too-many"), "control", "foreground-control"), StateError);
  assert.throws(() => f.proactive.scheduleWakeup(wake("duplicate", "commitment-0")), StateError);
  const first = f.proactive.commitment("commitment-0")!; f.proactive.updateCommitment(first.id, { ...edit(first), status: "completed" });
  f.proactive.createCommitment(responsibility("replacement"), "control", "foreground-control");
  assert.equal(f.proactive.commitments().filter(item => item.status === "active").length, 64); assert.equal(f.proactive.wakeup("wake-0")?.status, "cancelled");
  for (let index = 0; index < 50; index++) f.proactive.createCommitment({ ...responsibility(`history-${index}`), status: "completed" }, "control", "foreground-control");
  assert.equal(f.proactive.commitments().length, 100); assert.equal(f.proactive.commitments()[0]?.status, "active");
});

test("admission failure rolls back run, wake claim and eligibility together", t => {
  const f = fixture(t); f.enable(); f.proactive.createCommitment(responsibility(), "control", "foreground-control"); f.proactive.scheduleWakeup(wake());
  f.time(BASE + 60_000);
  const fault = t.mock.method(f.owner, "admitBackground", () => { throw new Error("Injected admission failure"); });
  assert.throws(() => f.drive(), /Injected admission failure/);
  assert.equal(f.proactive.status().runs.length, 0); assert.equal(f.proactive.wakeup("wake-1")?.status, "scheduled");
  fault.mock.restore(); f.drive(); assert.equal(f.proactive.status().runs.length, 1); assert.equal(f.owner.pendingOperations().length, 1);
});

test("a failed notification enqueue rolls back the structured report and dedup receipt", t => {
  const f = fixture(t); f.enable(); f.proactive.createCommitment(responsibility("commitment-1", null, true), "control", "foreground-control"); f.proactive.scheduleWakeup(wake());
  f.time(BASE + 60_000); f.drive(); const run = f.proactive.runForSession(sessions.control)!;
  const body = { outcome: "completed", note: "The export completed successfully.", notification: "Your requested export completed." };
  const fault = t.mock.method(f.owner, "enqueue", () => { throw new Error("Injected outbox failure"); });
  assert.throws(() => f.proactive.report(sessions.control, body), /Injected outbox failure/);
  assert.equal(f.proactive.run(run.id)?.status, "admitted"); assert.equal(f.proactive.commitment("commitment-1")?.version, 1); assert.equal(f.proactive.wakeup("wake-1")?.status, "running");
  fault.mock.restore(); assert.equal(f.proactive.report(sessions.control, body).notification?.status, "enqueued"); assert.equal(f.owner.deliveries(`proactive:${run.id}`).length, 1);
});

test("foreground interruption retains the responsibility without disguising ordinary failed turns", t => {
  const f = fixture(t); f.enable(); f.proactive.createCommitment(responsibility("commitment-1", at(BASE + 1)), "control", "foreground-control");
  f.time(BASE + HEARTBEAT_MS); f.drive(); const run = f.proactive.runForSession(sessions.control)!; f.owner.submitted(run.operationId);
  const foreground = f.owner.admit("priority", "Please help with this first", "control", "foreground-control");
  f.proactive.deferForForeground(); f.drive(true);
  assert.equal(f.proactive.run(run.id)?.foregroundInterrupted, true);
  assert.throws(() => f.proactive.report(sessions.control, { outcome: "no_action", note: "Foreground work has arrived." }), StateError);
  f.owner.settle(run.operationId, "Review interrupted", true); f.drive(true);
  assert.match(f.proactive.run(run.id)!.note!, /deferred for foreground/);
  assert.equal(f.proactive.commitment("commitment-1")?.nextReviewAt, at(Date.now() + HEARTBEAT_MS));
  f.owner.settle(foreground.id, ""); f.drive(); assert.equal(f.proactive.status().runs.length, 1);
  f.time(Date.now() + HEARTBEAT_MS); f.drive(); assert.equal(f.proactive.status().runs.length, 2);
});

test("foreground interruption reclaims a useful custom wake only after the old turn settles", t => {
  const f = fixture(t); f.enable(); f.proactive.createCommitment(responsibility(), "control", "foreground-control"); f.proactive.scheduleWakeup(wake());
  f.time(BASE + 60_000); f.drive(); const old = f.proactive.runForSession(sessions.control)!; f.owner.submitted(old.operationId);
  f.proactive.deferForForeground(); f.drive(true); f.drive(false); assert.equal(f.proactive.status().runs.length, 1);
  f.owner.settle(old.operationId, "Interrupted", true); f.drive();
  const current = f.proactive.runForSession(sessions.control)!;
  assert.notEqual(current.id, old.id); assert.equal(current.wakeupId, old.wakeupId);
  assert.match(f.proactive.run(old.id)!.note!, /deferred for foreground/);
});

test("run history is bounded independently of durable run lookup and operation linkage", t => {
  const f = fixture(t); f.enable(); f.proactive.createCommitment(responsibility(), "control", "foreground-control");
  let firstId = "";
  for (let index = 0; index < 51; index++) {
    f.proactive.scheduleWakeup(wake(`history-wake-${index}`, "commitment-1", Date.now() + 1, Date.now() + 60_000));
    f.time(Date.now() + 1); f.drive(); const run = f.proactive.runForSession(sessions.control)!;
    if (index === 0) firstId = run.id;
    f.proactive.report(sessions.control, { outcome: "no_action", note: "The explicitly requested status review found no new evidence." }); f.owner.settle(run.operationId, "");
  }
  assert.equal(f.proactive.status().runs.length, 50);
  assert.ok(f.proactive.run(firstId)); assert.ok(f.owner.operation(f.proactive.run(firstId)!.operationId));
});

test("one owner spans both channels and remains reserved until a reported turn really settles", t => {
  const f = fixture(t); f.enable();
  f.proactive.createCommitment(responsibility("control-work"), "control", "foreground-control");
  f.proactive.createCommitment(responsibility("telegram-work"), "telegram", "foreground-telegram");
  f.proactive.scheduleWakeup(wake("control-wake", "control-work")); f.proactive.scheduleWakeup(wake("telegram-wake", "telegram-work"));
  f.owner.createChoice("pending-question", "Which export format?", ["Text", "JSON"], "control", "foreground-control");
  f.time(BASE + 60_000); f.drive(); const first = f.proactive.runForSession(sessions.control)!;
  assert.equal(f.owner.pendingChoice("foreground-control")?.status, "pending");
  f.owner.submitted(first.operationId); f.proactive.report(sessions.control, { outcome: "no_action", note: "The recorded export state has not changed." });
  f.drive(); assert.equal(f.proactive.runForSession(sessions.telegram), undefined); assert.equal(f.proactive.status().runs.length, 1);
  f.owner.settle(first.operationId, ""); f.drive(); assert.equal(f.proactive.runForSession(sessions.telegram)?.commitmentId, "telegram-work");
});

test("expiry blocks tools before another drive and disabling retains a useful custom wake", t => {
  const f = fixture(t); f.enable(); f.proactive.createCommitment(responsibility(), "control", "foreground-control"); f.proactive.scheduleWakeup(wake());
  f.time(BASE + 60_000); f.drive(); const old = f.proactive.runForSession(sessions.control)!;
  f.proactive.configure({ expectedVersion: f.proactive.settings().version, enabled: false, quietHours: null });
  assert.equal(f.proactive.run(old.id)?.status, "superseded"); assert.equal(f.proactive.wakeup("wake-1")?.status, "scheduled");
  assert.throws(() => f.proactive.assertRunCurrent(sessions.control), StateError);
  f.enable(); f.drive(); const resumed = f.proactive.runForSession(sessions.control)!; assert.notEqual(resumed.id, old.id);
  f.time(BASE + 120_000);
  assert.throws(() => f.proactive.report(sessions.control, { outcome: "advanced", note: "The result arrived outside its useful window.", notification: "Too late" }), StateError);
  f.drive(); assert.equal(f.proactive.run(resumed.id)?.status, "expired"); assert.equal(f.owner.deliveries().length, 0);
});

test("a linked job event without a custom wake runs before the heartbeat and completion replay coalesces", t => {
  const f = fixture(t); f.enable(); f.owner.createJob(assignment(), "control", "foreground-control");
  f.proactive.createCommitment({ ...responsibility(), jobId: "job-1" }, "control", "foreground-control");
  const completed = finishJob(f.owner); f.owner.complete(completed.completion); f.drive();
  const run = f.proactive.runForSession(sessions.control)!;
  assert.equal(run.trigger, "event"); assert.equal(run.wakeupId, undefined); assert.equal(f.proactive.status().runs.length, 1);
  assert.equal(f.proactive.settings().nextHeartbeatAt, BASE + HEARTBEAT_MS);
  f.proactive.report(sessions.control, { outcome: "completed", note: "The recorded export completed successfully." }); f.owner.settle(run.operationId, ""); f.drive();
  assert.equal(f.proactive.status().runs.length, 1); assert.equal(f.owner.operation("job:job-1:completion"), undefined);
});

test("one missing background session does not starve available channel work or drop its own wake", t => {
  const f = fixture(t); f.enable();
  f.proactive.createCommitment(responsibility("control-work"), "control", "foreground-control");
  f.proactive.createCommitment(responsibility("telegram-work"), "telegram", "foreground-telegram");
  f.proactive.scheduleWakeup(wake("control-wake", "control-work")); f.proactive.scheduleWakeup(wake("telegram-wake", "telegram-work"));
  f.time(BASE + 60_000); f.drive(false, { telegram: sessions.telegram });
  const run = f.proactive.runForSession(sessions.telegram)!;
  assert.equal(run.commitmentId, "telegram-work"); assert.equal(f.proactive.wakeup("control-wake")?.status, "scheduled");
  f.proactive.report(sessions.telegram, { outcome: "no_action", note: "The requested export state is unchanged." }); f.owner.settle(run.operationId, "");
  f.drive(); assert.equal(f.proactive.runForSession(sessions.control)?.commitmentId, "control-work");
});

test("a retry policy re-runs a failed event review at its interval, at most maxAttempts times", t => {
  const f = fixture(t); f.enable();
  f.proactive.createCommitment({ ...responsibility(), retry: { everyMinutes: 60, maxAttempts: 2 } }, "control", "foreground-control");
  const exhausted: string[] = []; f.proactive.onRetryExhausted = (commitment, reason) => exhausted.push(`${commitment.id}: ${reason}`);
  f.proactive.triggerEvent("commitment-1", BASE); f.drive();
  const fail = (): string => { const run = f.proactive.runForSession(sessions.control)!; f.owner.settle(run.operationId, "Provider failure", true); f.drive(); return run.id; };
  const first = fail();
  assert.equal(f.proactive.run(first)?.status, "failed"); assert.match(f.proactive.run(first)!.note!, /retry 1 of 2/);
  assert.equal(f.proactive.commitment("commitment-1")?.failedAttempts, 1); assert.equal(f.proactive.commitment("commitment-1")?.version, 1);
  f.time(BASE + 59 * 60_000); f.drive(); assert.equal(f.proactive.runForSession(sessions.control), undefined);
  f.time(BASE + 60 * 60_000); f.drive(); assert.ok(f.proactive.runForSession(sessions.control));
  fail(); assert.equal(f.proactive.commitment("commitment-1")?.failedAttempts, 2);
  f.time(BASE + 120 * 60_000); f.drive(); const last = fail();
  assert.equal(f.proactive.run(last)?.note, "Model turn failed: Provider failure");
  assert.deepEqual(exhausted, ["commitment-1: Model turn failed: Provider failure"]);
  assert.equal(f.proactive.commitment("commitment-1")?.failedAttempts, 0);
  f.time(BASE + 10 * 60 * 60_000); f.drive(); assert.equal(f.proactive.runForSession(sessions.control), undefined);
  assert.equal(f.proactive.status().runs.length, 3);
});

test("a successful review resets retry attempts, and an owner edit supersedes a pending retry budget", t => {
  const f = fixture(t); f.enable();
  f.proactive.createCommitment({ ...responsibility(), retry: { everyMinutes: 15, maxAttempts: 3 } }, "control", "foreground-control");
  f.proactive.triggerEvent("commitment-1", BASE); f.drive();
  let run = f.proactive.runForSession(sessions.control)!; f.owner.settle(run.operationId, "Provider failure", true); f.drive();
  f.time(BASE + 15 * 60_000); f.drive(); run = f.proactive.runForSession(sessions.control)!;
  f.proactive.report(sessions.control, { outcome: "no_action", note: "The export has not changed." }); f.owner.settle(run.operationId, "");
  assert.equal(f.proactive.commitment("commitment-1")?.failedAttempts, 0);
  const edited = f.proactive.updateCommitment("commitment-1", edit(f.proactive.commitment("commitment-1")!));
  assert.deepEqual(edited.retry, { everyMinutes: 15, maxAttempts: 3 });
  assert.equal(f.proactive.updateCommitment("commitment-1", { ...edit(edited), retry: null }).retry, null);
});

test("a one-time wake retries inside its useful window; a recurring wake keeps its rhythm", t => {
  const f = fixture(t); f.enable();
  f.proactive.createCommitment({ ...responsibility(), retry: { everyMinutes: 60, maxAttempts: 3 } }, "control", "foreground-control");
  f.proactive.scheduleWakeup(wake("once", "commitment-1", BASE + 60_000, BASE + 100 * 60_000));
  f.time(BASE + 60_000); f.drive(); let run = f.proactive.runForSession(sessions.control)!;
  f.owner.settle(run.operationId, "Provider failure", true); f.drive();
  assert.equal(f.proactive.wakeup("once")?.status, "scheduled"); assert.equal(f.proactive.wakeup("once")?.dueAt, at(BASE + 61 * 60_000));
  f.time(BASE + 61 * 60_000); f.drive(); run = f.proactive.runForSession(sessions.control)!; assert.equal(run.wakeupId, "once");
  f.owner.settle(run.operationId, "Provider failure", true); f.drive();
  // The next retry would land after the wake expires.
  assert.equal(f.proactive.wakeup("once")?.status, "cancelled"); assert.equal(f.proactive.commitment("commitment-1")?.failedAttempts, 0);

  f.proactive.createCommitment({ ...responsibility("commitment-2"), retry: { everyMinutes: 30, maxAttempts: 3 } }, "control", "foreground-control");
  f.proactive.scheduleWakeup(wake("hourly", "commitment-2", Date.now() + 60_000, Date.now() + 120_000, 120));
  const start = Date.now() + 60_000; f.time(start); f.drive(); run = f.proactive.runForSession(sessions.control)!;
  f.owner.settle(run.operationId, "Provider failure", true); f.drive();
  assert.equal(f.proactive.wakeup("hourly")?.dueAt, at(start + 120 * 60_000));
  f.time(start + 30 * 60_000); f.drive(); assert.equal(f.proactive.runForSession(sessions.control)?.trigger, "event");
});

test("retry policies are bounded", t => {
  const f = fixture(t);
  for (const retry of [{ everyMinutes: 5, maxAttempts: 1 }, { everyMinutes: 60, maxAttempts: 0 }, { everyMinutes: 60, maxAttempts: 11 }, { everyMinutes: 60 }, { everyMinutes: 60, maxAttempts: 2, extra: 1 }]) {
    assert.throws(() => f.proactive.createCommitment({ ...responsibility(), retry }, "control", "foreground-control"), InputError);
  }
});

test("with a retry policy, a recurring wake shorter than the interval continues at its next occurrence", t => {
  const f = fixture(t); f.enable();
  f.proactive.createCommitment({ ...responsibility(), retry: { everyMinutes: 60, maxAttempts: 1 } }, "control", "foreground-control");
  f.proactive.scheduleWakeup(wake("repeat", "commitment-1", BASE + 60_000, BASE + 120_000, 15));
  f.time(BASE + 60_000); f.drive(); const run = f.proactive.runForSession(sessions.control)!;
  f.owner.settle(run.operationId, "Provider failure", true); f.drive();
  assert.equal(f.proactive.wakeup("repeat")?.status, "scheduled"); assert.equal(f.proactive.wakeup("repeat")?.dueAt, at(BASE + 16 * 60_000));
  assert.match(f.proactive.run(run.id)!.note!, new RegExp(`retry 1 of 1 at ${at(BASE + 16 * 60_000)}`));
});
