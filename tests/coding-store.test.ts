import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { Store, StateError, type Database } from "../src/worker/store.js";
import { CodingStore, type CodingFinish, type CodingTask } from "../src/worker/coding-store.js";
import { type CodingArtifacts, type CodingExecutorPoll, type CodingSource } from "../src/shared/coding.js";
import { codingOperationPrefix, emptyCodingProgress, encodeCodingValue, type CodingRpcRequest, type CodingRpcState } from "../src/shared/coding-rpc.js";

function open(path = ":memory:") {
  const sqlite = new DatabaseSync(path);
  let depth = 0;
  const db: Database = {
    all: <T extends object>(query: string, ...bindings: (string | number | null)[]) => sqlite.prepare(query).all(...bindings) as T[],
    transaction: <T>(run: () => T): T => {
      const savepoint = `coding_${depth++}`;
      sqlite.exec(`SAVEPOINT ${savepoint}`);
      try { const value = run(); sqlite.exec(`RELEASE ${savepoint}`); return value; }
      catch (error) { sqlite.exec(`ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`); throw error; }
      finally { depth--; }
    },
  };
  const owner = new Store(db);
  owner.setSession("control", "owner-control");
  owner.setSession("telegram", "owner-telegram");
  const coding = new CodingStore(owner);
  return { owner, coding, close: () => sqlite.close() };
}
function fixture(t: TestContext) {
  const opened = open(); t.after(opened.close);
  opened.coding.poll(poll());
  return opened;
}
function persistent(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "umpi-coding-store-"));
  const path = join(directory, "state.sqlite");
  let current = open(path);
  t.after(() => { current.close(); rmSync(directory, { recursive: true, force: true }); });
  return {
    get current() { return current; },
    reopen() { current.close(); current = open(path); return current; },
  };
}
const cwd = "/workspace";
const poll = (overrides: Partial<CodingExecutorPoll> = {}): CodingExecutorPoll => ({ executorId: "mac-1", workspaces: [cwd], available: true, activeRunId: null, ...overrides });
const request = (taskId = "task-1", workspace = cwd) => ({ taskId, prompt: "Fix the parser and verify the changed behavior", cwd: workspace, timeoutMs: 60_000 });
const source = (sourceId = "source-1", workspace = cwd): CodingSource => ({ sourceId, cwd: workspace, capturedAt: new Date().toISOString(), digest: "a".repeat(64), bytes: 256, fileCount: 1, baseRevision: null });
const shell = (jobId = "shell-1") => ({ jobId, command: "printf hello", cwd, timeoutMs: 10_000, createdAt: new Date().toISOString() });
function create(coding: CodingStore, taskId = "task-1", workspace = cwd) {
  return coding.create(request(taskId, workspace), "control", "owner-control");
}
function start(coding: CodingStore, taskId = "task-1") {
  const task = create(coding, taskId);
  coding.approve(taskId, task.version);
  const assignment = coding.poll(poll()).assignment;
  assert.ok(assignment);
  return coding.ready(taskId, assignment.runId, "/private/coding-copy");
}
function rpc(task: CodingTask, sequence = 1, method: CodingRpcRequest["method"] = "exec", args: CodingRpcRequest["args"] = ["npm test"]): CodingRpcRequest {
  assert.ok(task.run);
  return { operationId: `${codingOperationPrefix(task.taskId, task.run.runId)}invocation:${sequence}`, method, args };
}
function done(operationId: string, value: unknown = { exitCode: 0 }): CodingRpcState {
  return { operationId, status: "done", progress: emptyCodingProgress(), result: { ok: true, value: encodeCodingValue(value) } };
}
function finish(task: CodingTask, overrides: Partial<CodingFinish> = {}): CodingFinish {
  return { expectedVersion: task.version, outcome: "blocked", summary: "Parser changes need owner review", verificationCommands: [], ...overrides };
}
const emptyDigest = createHash("sha256").update("").digest("hex");
const artifacts: CodingArtifacts = { baseDigest: emptyDigest, finalDigest: emptyDigest, patchDigest: emptyDigest, patch: "", changes: [] };

test("coding requires the exact advertised workspace and a current explicit approval", t => {
  const { coding } = fixture(t);
  for (const workspace of ["/workspace/child", "/work", "/Workspace"]) {
    assert.throws(() => create(coding, "wrong", workspace), StateError);
  }
  const task = create(coding);
  assert.equal(coding.poll(poll()).assignment, null);
  assert.throws(() => coding.approve(task.taskId, undefined as unknown as number), StateError);
  assert.throws(() => coding.approve(task.taskId, 0), StateError);
  coding.approve(task.taskId, task.version);
  assert.equal(coding.poll(poll({ executorId: "mac-other", workspaces: ["/workspace/child"] })).assignment, null);
  assert.equal(coding.poll(poll()).assignment?.cwd, cwd);
});

test("queued corrections invalidate approval and stale owner actions cannot overwrite them", t => {
  const { coding } = fixture(t);
  const task = create(coding);
  coding.approve(task.taskId, task.version);
  const corrected = coding.correct(task.taskId, task.version, "Preserve existing whitespace");
  assert.equal(corrected.version, 2);
  assert.equal(corrected.status, "pending_approval");
  assert.equal(corrected.approvedAt, undefined);
  assert.equal(coding.poll(poll()).assignment, null);
  assert.throws(() => coding.approve(task.taskId, task.version), StateError);
  assert.throws(() => coding.correct(task.taskId, task.version, "Discard owner correction"), StateError);
  assert.throws(() => coding.cancel(task.taskId, task.version), StateError);
  coding.approve(task.taskId, corrected.version);
  assert.equal(coding.poll(poll()).assignment?.taskId, task.taskId);
});

test("cloud offer binds an immutable exact-workspace upload and removes unclaimed Mac eligibility", t => {
  const { coding } = fixture(t);
  const task = create(coding);
  coding.approve(task.taskId, task.version);
  coding.saveSource(source("wrong-source", "/different"));
  assert.throws(() => coding.requestCloud(task.taskId, task.version, "missing"), StateError);
  assert.throws(() => coding.requestCloud(task.taskId, task.version, "wrong-source"), StateError);
  const uploaded = coding.saveSource(source());
  assert.deepEqual(coding.saveSource(uploaded), uploaded);
  assert.throws(() => coding.saveSource({ ...uploaded, digest: "b".repeat(64) }), StateError);
  const offered = coding.requestCloud(task.taskId, task.version, uploaded.sourceId);
  assert.equal(offered.status, "pending_approval");
  assert.equal(offered.target, "cloud");
  assert.equal(offered.sourceId, uploaded.sourceId);
  assert.equal(offered.approvedAt, undefined);
  assert.equal(coding.poll(poll()).assignment, null);
  assert.equal(coding.claimCloud(), undefined);
  assert.throws(() => coding.approve(task.taskId, task.version), StateError);
  coding.approve(task.taskId, offered.version);
  assert.equal(coding.poll(poll()).assignment, null);
  assert.equal(coding.claimCloud()?.run?.target, "cloud");
});

test("claimed and uncertain Mac work never falls back to cloud", t => {
  const { coding } = fixture(t);
  const task = create(coding);
  coding.saveSource(source());
  coding.approve(task.taskId, task.version);
  const assignment = coding.poll(poll()).assignment!;
  assert.throws(() => coding.requestCloud(task.taskId, task.version, "source-1"), StateError);
  coding.ready(task.taskId, assignment.runId, "/private/coding-copy");
  assert.throws(() => coding.requestCloud(task.taskId, task.version, "source-1"), StateError);
  coding.uncertain(task.taskId, "Disconnected after dispatch");
  assert.throws(() => coding.requestCloud(task.taskId, task.version, "source-1"), StateError);
  assert.equal(coding.claimCloud(), undefined);
  assert.equal(coding.requireTask(task.taskId).run?.runId, assignment.runId);
});

test("shell ownership prevents coding claims until that shell's real completion", t => {
  const { coding, owner } = fixture(t);
  owner.createJob(shell(), "control", "owner-control"); owner.approveJob("shell-1", 1);
  assert.equal(owner.poll({ executorId: "mac-1", workspaces: [cwd] }).job?.jobId, "shell-1");
  create(coding); coding.approve("task-1", 1);
  assert.equal(coding.poll(poll()).assignment, null);
  owner.complete({ executorId: "mac-1", jobId: "shell-1", status: "succeeded", exitCode: 0, output: "hello", truncated: false, finishedAt: new Date().toISOString() });
  assert.equal(coding.poll(poll()).assignment?.taskId, "task-1");
});

test("coding ownership prevents new shell claims through cancellation and uncertain stop", t => {
  const { coding, owner } = fixture(t);
  const task = start(coding);
  owner.createJob(shell(), "control", "owner-control"); owner.approveJob("shell-1", 1);
  const shellPoll = () => owner.poll({ executorId: "mac-1", workspaces: [cwd] });
  assert.equal(shellPoll().job, null);
  coding.cancel(task.taskId, task.version);
  assert.equal(shellPoll().job, null);
  coding.stopped(task.taskId, task.run!.runId, true, "Effects unresolved", { confirmedStopped: true });
  assert.equal(shellPoll().job, null);
  coding.stopped(task.taskId, task.run!.runId, true, "Owner confirmed local stop", { ownerConfirmedStopped: true });
  assert.equal(shellPoll().job?.jobId, "shell-1");
});

test("physically stopped but unreconciled coding retains the executor slot even for another workspace", t => {
  const { coding } = fixture(t);
  const task = start(coding);
  coding.stopped(task.taskId, task.run!.runId, true, "Unknown command effects", { confirmedStopped: true });
  coding.poll(poll({ workspaces: [cwd, "/other"] }));
  const other = create(coding, "other", "/other"); coding.approve(other.taskId, other.version);
  assert.equal(coding.poll(poll({ workspaces: [cwd, "/other"] })).assignment, null);
  coding.stopped(task.taskId, task.run!.runId, true, "Local owner reconciliation", { ownerConfirmedStopped: true });
  assert.equal(coding.poll(poll({ workspaces: [cwd, "/other"] })).assignment?.taskId, other.taskId);
});

test("disconnect and SQLite reopen retain the original owner, assignment, and hard deadline", t => {
  const persisted = persistent(t);
  let { coding } = persisted.current;
  coding.poll(poll());
  const task = start(coding);
  const assignment = task.run!.assignment;
  ({ coding } = persisted.reopen());
  assert.equal(coding.poll(poll({ executorId: "mac-2" })).assignment, null);
  assert.deepEqual(coding.poll(poll({ available: false, activeRunId: assignment.runId })).assignment, assignment);
  coding.uncertain(task.taskId, "Owner disappeared during a command");
  ({ coding } = persisted.reopen());
  assert.equal(coding.poll(poll({ executorId: "mac-2" })).assignment, null);
  const recovered = coding.poll(poll({ activeRunId: assignment.runId }));
  assert.deepEqual(recovered.assignment, assignment);
  assert.equal(recovered.cancel, true);
  assert.equal(coding.requireTask(task.taskId).status, "uncertain");
});

test("live corrections preserve task, conversation, workspace, owner, run, and deadline", t => {
  const { coding } = fixture(t);
  const task = start(coding);
  coding.session(task.taskId, "coding-session");
  const corrected = coding.correct(task.taskId, task.version, "Also preserve empty lines", Date.now() + 20_000);
  assert.equal(corrected.taskId, task.taskId);
  assert.equal(corrected.sessionId, "coding-session");
  assert.equal(corrected.cwd, task.cwd);
  assert.deepEqual(corrected.run, task.run);
  assert.equal(corrected.status, "running");
  assert.equal(corrected.version, task.version + 1);
  assert.deepEqual(coding.inputs().filter(input => !input.initial).map(input => input.text), ["Also preserve empty lines"]);
  assert.throws(() => coding.correct(task.taskId, task.version, "Stale edit"), StateError);
  coding.expire(Date.parse(task.run!.assignment.deadlineAt));
  assert.equal(coding.requireTask(task.taskId).status, "cancel_requested");
  assert.equal(coding.requireTask(task.taskId).timedOut, true);
  assert.equal(coding.poll(poll({ activeRunId: task.run!.runId })).cancel, true);
});

test("preparing corrections enter the initial input once, including across ready replay", t => {
  const { coding } = fixture(t);
  const task = create(coding); coding.approve(task.taskId, task.version);
  const assignment = coding.poll(poll()).assignment!;
  const corrected = coding.correct(task.taskId, task.version, "Keep CRLF endings");
  assert.equal(corrected.status, "preparing");
  assert.equal(coding.inputs().length, 0);
  coding.ready(task.taskId, assignment.runId, "/private/coding-copy");
  coding.ready(task.taskId, assignment.runId, "/private/coding-copy");
  const inputs = coding.inputs();
  assert.equal(inputs.length, 1);
  assert.equal(inputs[0]!.initial, true);
  assert.ok(inputs[0]!.text.includes(task.prompt));
  assert.equal(inputs[0]!.text.split("Keep CRLF endings").length - 1, 1);
  coding.inputState(inputs[0]!.operationId, "submitted");
  coding.inputState(inputs[0]!.operationId, "done");
  coding.ready(task.taskId, assignment.runId, "/private/coding-copy");
  assert.deepEqual(coding.inputs(), []);
});

test("settled cloud continuation retains its checkpoint and requires a new version-bound approval", t => {
  const { coding } = fixture(t);
  const task = create(coding); coding.saveSource(source());
  const offered = coding.requestCloud(task.taskId, task.version, "source-1");
  coding.approve(task.taskId, offered.version);
  const first = coding.claimCloud()!;
  coding.ready(task.taskId, first.run!.runId, "/workspace/project");
  coding.session(task.taskId, "cloud-conversation");
  for (const input of coding.inputs()) coding.inputState(input.operationId, "done");
  coding.requestFinish(task.taskId, first.run!.runId, finish(first, { outcome: "needs_input", summary: "Which behavior should empty input use?" }));
  const checkpoint = coding.saveSource({ ...source("checkpoint"), digest: "b".repeat(64) }, "coding/checkpoints/task-1/first.gz");
  coding.artifacts(task.taskId, first.run!.runId, artifacts, "coding/patches/first.patch", { key: coding.sourceKey(checkpoint.sourceId), sourceId: checkpoint.sourceId });
  assert.equal(coding.stopped(task.taskId, first.run!.runId, false).status, "waiting_input");
  const corrected = coding.correct(task.taskId, offered.version, "Empty input should return an empty list");
  assert.equal(corrected.status, "pending_approval");
  assert.equal(corrected.sourceId, checkpoint.sourceId);
  assert.equal(corrected.sessionId, "cloud-conversation");
  assert.equal(corrected.result, undefined);
  assert.equal(coding.claimCloud(), undefined);
  assert.equal(coding.poll(poll()).assignment, null);
  assert.throws(() => coding.approve(task.taskId, offered.version), StateError);
  coding.approve(task.taskId, corrected.version);
  const resumed = coding.claimCloud(Date.parse(first.run!.assignment.deadlineAt) + 1)!;
  assert.notEqual(resumed.run!.runId, first.run!.runId);
  assert.equal(resumed.sourceId, checkpoint.sourceId);
  assert.equal(resumed.sessionId, "cloud-conversation");
  assert.ok(Date.parse(resumed.run!.assignment.deadlineAt) > Date.parse(first.run!.assignment.deadlineAt));
  assert.throws(() => coding.ready(task.taskId, first.run!.runId, "/workspace/project"), StateError);
});

test("task cancellation before claim never dispatches; active cancellation requires owner stop acknowledgement", t => {
  const { coding } = fixture(t);
  const queued = create(coding, "queued"); coding.approve(queued.taskId, queued.version);
  assert.equal(coding.cancel(queued.taskId, queued.version).status, "cancelled");
  assert.equal(coding.poll(poll()).assignment, null);
  const running = start(coding, "running");
  assert.equal(coding.cancel(running.taskId, running.version).status, "cancel_requested");
  assert.equal(coding.requireTask(running.taskId).run?.stoppedAt, undefined);
  assert.equal(coding.poll(poll({ activeRunId: running.run!.runId })).cancel, true);
  assert.equal(coding.poll(poll({ executorId: "mac-2" })).assignment, null);
  assert.equal(coding.stopped(running.taskId, running.run!.runId, false).status, "cancelled");
  assert.equal(coding.poll(poll()).assignment, null);
});

test("owner-confirmed local stop releases workspace ownership without inventing a successful outcome", t => {
  const { coding } = fixture(t);
  const task = start(coding);
  const operation = rpc(task); coding.enqueueRpc(task.taskId, task.run!.runId, operation);
  coding.poll(poll({ activeRunId: task.run!.runId }));
  const uncertain: CodingRpcState = { operationId: operation.operationId, status: "uncertain", progress: emptyCodingProgress() };
  coding.receipt(task.taskId, task.run!.runId, uncertain);
  const next = create(coding, "next");
  assert.throws(() => coding.approve(next.taskId, next.version), StateError);
  const reconciled = coding.stopped(task.taskId, task.run!.runId, true, "Confirmed stopped on the Mac; effects still unknown", { ownerConfirmedStopped: true });
  assert.equal(reconciled.status, "uncertain");
  assert.ok(reconciled.run!.stoppedAt);
  assert.ok(reconciled.run!.reconciledAt);
  assert.equal(reconciled.result, undefined);
  assert.deepEqual(coding.operation(operation.operationId)?.receipt, uncertain);
  coding.approve(next.taskId, next.version);
  assert.equal(coding.poll(poll()).assignment?.taskId, next.taskId);
});

test("RPC request identity, terminal evidence, and replay remain immutable after reopen", t => {
  const persisted = persistent(t);
  let { coding } = persisted.current; coding.poll(poll());
  const task = start(coding); const runId = task.run!.runId;
  const operation = rpc(task, 1, "writeFile", ["parser.ts", "fixed"]);
  const first = coding.enqueueRpc(task.taskId, runId, operation);
  assert.deepEqual(coding.enqueueRpc(task.taskId, runId, operation), first);
  assert.equal(coding.operations(runId).length, 1);
  assert.throws(() => coding.enqueueRpc(task.taskId, runId, { ...operation, args: ["parser.ts", "different"] }), StateError);
  assert.deepEqual(coding.poll(poll({ activeRunId: runId })).requests, [operation]);
  const receipt = done(operation.operationId, undefined);
  coding.receipt(task.taskId, runId, receipt);
  coding.receipt(task.taskId, runId, receipt);
  assert.throws(() => coding.receipt(task.taskId, runId, done(operation.operationId, "contradiction")), StateError);
  ({ coding } = persisted.reopen());
  assert.deepEqual(coding.enqueueRpc(task.taskId, runId, operation).receipt, receipt);
  assert.equal(coding.operations(runId).length, 1);
  assert.deepEqual(coding.poll(poll({ activeRunId: runId })).requests, []);
  assert.throws(() => coding.enqueueRpc(task.taskId, runId, { ...operation, operationId: `${codingOperationPrefix("another-task", runId)}invocation:1` }), StateError);
  assert.throws(() => coding.receipt(task.taskId, runId, done(`${codingOperationPrefix(task.taskId, runId)}missing:1`)), StateError);
});

test("RPC cancellation distinguishes undispatched work from a dispatched command awaiting its receipt", t => {
  const { coding } = fixture(t);
  const task = start(coding); const runId = task.run!.runId;
  const before = rpc(task); coding.enqueueRpc(task.taskId, runId, before);
  coding.cancelOperation(task.taskId, runId, before.operationId);
  const cancelled = coding.operation(before.operationId)!;
  assert.equal(cancelled.dispatched, false);
  assert.equal(cancelled.receipt?.status, "done");
  assert.deepEqual(cancelled.receipt?.result, { ok: false, error: { name: "ExecutionError", code: "aborted", message: "Cancelled before execution" } });
  assert.deepEqual(coding.poll(poll({ activeRunId: runId })).requests, []);
  assert.throws(() => coding.requestFinish(task.taskId, runId, finish(task, { verificationCommands: ["npm test"] })), StateError);
  const running = rpc(task, 2); coding.enqueueRpc(task.taskId, runId, running);
  assert.deepEqual(coding.poll(poll({ activeRunId: runId })).requests, [running]);
  coding.cancelOperation(task.taskId, runId, running.operationId);
  assert.equal(coding.operation(running.operationId)?.receipt, undefined);
  assert.deepEqual(coding.poll(poll({ activeRunId: runId })).cancelOperationIds, [running.operationId]);
  assert.throws(() => coding.requestFinish(task.taskId, runId, finish(task)), StateError);
  coding.receipt(task.taskId, runId, done(running.operationId));
  assert.deepEqual(coding.poll(poll({ activeRunId: runId })).cancelOperationIds, []);
  assert.equal(coding.commands(runId).find(command => command.operationId === running.operationId)?.exitCode, 0);
});

test("completion needs settled command evidence rather than a model's claim that verification ran", t => {
  const { coding } = fixture(t);
  const task = start(coding); const runId = task.run!.runId;
  const outcome = finish(task, { outcome: "completed", verificationCommands: ["npm test"] });
  assert.throws(() => coding.requestFinish(task.taskId, runId, outcome), StateError);
  const operation = rpc(task); coding.enqueueRpc(task.taskId, runId, operation);
  assert.throws(() => coding.requestFinish(task.taskId, runId, outcome), StateError);
  coding.poll(poll({ activeRunId: runId }));
  coding.receipt(task.taskId, runId, { operationId: operation.operationId, status: "running", progress: emptyCodingProgress() });
  assert.throws(() => coding.requestFinish(task.taskId, runId, outcome), StateError);
  coding.receipt(task.taskId, runId, done(operation.operationId, { exitCode: 1 }));
  assert.throws(() => coding.requestFinish(task.taskId, runId, finish(task, { verificationCommands: ["npm test --changed"] })), StateError);
  assert.throws(() => coding.requestFinish(task.taskId, runId, outcome), StateError);
  coding.requestFinish(task.taskId, runId, { ...outcome, outcome: "blocked", summary: "Recorded parser verification failed" });
  coding.artifacts(task.taskId, runId, artifacts, "coding/patches/task-1.patch");
  const settled = coding.stopped(task.taskId, runId, false);
  assert.equal(settled.status, "blocked");
  assert.deepEqual(settled.result?.verification, [{ operationId: operation.operationId, command: "npm test", exitCode: 1, error: null }]);
});

test("completed outcome requires successful named evidence but retains earlier failing command history", t => {
  const { coding } = fixture(t);
  const task = start(coding); const runId = task.run!.runId;
  assert.throws(() => coding.requestFinish(task.taskId, runId, finish(task, { outcome: "completed" })), StateError);
  const failed = rpc(task, 1); coding.enqueueRpc(task.taskId, runId, failed);
  coding.poll(poll({ activeRunId: runId }));
  coding.receipt(task.taskId, runId, done(failed.operationId, { exitCode: 1 }));
  const passed = rpc(task, 2); coding.enqueueRpc(task.taskId, runId, passed);
  coding.poll(poll({ activeRunId: runId }));
  coding.receipt(task.taskId, runId, done(passed.operationId, { exitCode: 0 }));
  coding.requestFinish(task.taskId, runId, finish(task, { outcome: "completed", summary: "Parser fixed and verified", verificationCommands: ["npm test"] }));
  coding.artifacts(task.taskId, runId, artifacts, "coding/patches/task-1.patch");
  const settled = coding.stopped(task.taskId, runId, false);
  assert.equal(settled.status, "completed");
  assert.deepEqual(settled.result?.verification, [{ operationId: passed.operationId, command: "npm test", exitCode: 0, error: null }]);
  assert.deepEqual(coding.commands(runId).map(command => command.exitCode), [1, 0]);
});

test("finish requires the version actually read by the model and rejects an intervening owner correction", t => {
  const { coding } = fixture(t);
  const task = start(coding); const runId = task.run!.runId;
  const { expectedVersion: _version, ...missingVersion } = finish(task);
  assert.throws(() => coding.requestFinish(task.taskId, runId, missingVersion as CodingFinish), StateError);
  const staleFinish = finish(task);
  const corrected = coding.correct(task.taskId, task.version, "Do not change the public API");
  assert.throws(() => coding.requestFinish(task.taskId, runId, staleFinish), StateError);
  assert.equal(coding.requireTask(task.taskId).status, "running");
  assert.equal(coding.requireTask(task.taskId).finish, undefined);
  const currentFinish = finish(corrected);
  assert.equal(coding.requestFinish(task.taskId, runId, currentFinish).status, "finishing");
  assert.equal(coding.requestFinish(task.taskId, runId, currentFinish).status, "finishing");
  assert.throws(() => coding.requestFinish(task.taskId, runId, staleFinish), StateError);
});

test("non-BMP request and result text survive a 32 KiB JSON chunk boundary and SQLite reopen", t => {
  const persisted = persistent(t);
  let { coding } = persisted.current; coding.poll(poll());
  const task = start(coding); const runId = task.run!.runId;
  const marker = "BOUNDARY_MARKER";
  const operation = rpc(task, 1, "writeFile", ["unicode.txt", marker]);
  const envelope = { taskId: task.taskId, runId, request: operation, cancelRequested: false, dispatched: false };
  const requestOffset = JSON.stringify(envelope).indexOf(marker);
  const text = "x".repeat(32_767 - requestOffset) + "\u{1f680}" + "y".repeat(40_000);
  operation.args[1] = text;
  coding.enqueueRpc(task.taskId, runId, operation);
  assert.equal(coding.operation(operation.operationId)?.request.args[1], text);
  coding.receipt(task.taskId, runId, done(operation.operationId));
  const reading = rpc(task, 2, "readTextFile", ["unicode.txt"]);
  const record = coding.enqueueRpc(task.taskId, runId, reading);
  const receipt = done(reading.operationId, marker);
  const receiptOffset = JSON.stringify({ ...record, dispatched: true, receipt }).indexOf(marker);
  const resultText = "z".repeat(32_767 - receiptOffset) + "\u{1f642}" + "q".repeat(40_000);
  const finalReceipt = done(reading.operationId, resultText);
  coding.receipt(task.taskId, runId, finalReceipt);
  ({ coding } = persisted.reopen());
  const recovered = coding.operation(operation.operationId)!;
  assert.deepEqual(recovered.request, operation);
  assert.deepEqual(coding.operation(reading.operationId)?.receipt, finalReceipt);
  assert.deepEqual(coding.poll(poll({ activeRunId: runId })).requests, []);
});

test("more than 100 newer tasks cannot hide an older coding conversation or transfer its ownership", t => {
  const persisted = persistent(t);
  let { coding } = persisted.current; coding.poll(poll());
  const oldest = create(coding, "oldest"); coding.session(oldest.taskId, "old-conversation");
  for (let index = 0; index < 105; index++) create(coding, `newer-${index}`);
  ({ coding } = persisted.reopen());
  assert.equal(coding.forSession("old-conversation")?.taskId, oldest.taskId);
  assert.throws(() => coding.session("newer-104", "old-conversation"), StateError);
  assert.equal(coding.requireTask("newer-104").sessionId, undefined);
  assert.equal(coding.forSession("old-conversation")?.taskId, oldest.taskId);
  assert.throws(() => coding.session(oldest.taskId, "replacement-conversation"), StateError);
  assert.throws(() => coding.session("newer-104", "owner-control"), StateError);
  assert.equal(coding.requireTask("newer-104").sessionId, undefined);
});

test("automatic result admission preserves pending owner clarification and immutable foreground routing", t => {
  const { owner } = fixture(t);
  const question = owner.createChoice("clarification", "Keep or remove empty lines?", ["Keep", "Remove"], "control", "owner-control");
  const id = "coding-result:task-1:run-1";
  const evidence = "Coding task finished. Verification: npm test exited 0.";
  const admitted = owner.admitResult(id, evidence, "control", "owner-control");
  assert.equal(admitted.status, "admitted");
  assert.equal(admitted.modelInput, undefined);
  assert.deepEqual(owner.pendingChoice("owner-control"), question);
  assert.deepEqual(owner.admitResult(id, evidence, "control", "owner-control"), admitted);
  assert.equal(owner.pendingOperations().filter(operation => operation.id === id).length, 1);
  assert.throws(() => owner.admitResult(id, "Different evidence", "control", "owner-control"), StateError);
  assert.throws(() => owner.admitResult(id, evidence, "telegram", "owner-telegram"), StateError);
  assert.throws(() => owner.admitResult("wrong-route", evidence, "telegram", "owner-control"), StateError);
  assert.deepEqual(owner.pendingChoice("owner-control"), question);
  const answer = owner.admit("owner-answer", "Keep", "control", "owner-control");
  assert.equal(owner.pendingChoice("owner-control"), undefined);
  assert.ok(answer.modelInput?.includes("Owner's answer:\nKeep"));
});

test("a stop acknowledgement preserves the actual coordinator failure cause", t => {
  const { coding } = fixture(t), task = start(coding);
  coding.fail(task.taskId, "Model authentication is unavailable");
  coding.stopped(task.taskId, task.run!.runId, false, "Coordinator requested stop");
  assert.equal(coding.requireTask(task.taskId).status, "failed");
  assert.equal(coding.requireTask(task.taskId).issue, "Model authentication is unavailable");
});
