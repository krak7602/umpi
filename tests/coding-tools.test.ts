import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ToolExecutionApi, ToolExecutionResult, ToolRegistration } from "@earendil-works/pi-durable";
import type { PiHarness } from "agents/harness/pi";
import { createBashTool, createWriteTool } from "@earendil-works/pi-durable/tools";
import { CodingNodeSession } from "../src/coding/rpc.js";
import { captureCodingSnapshot, restoreCodingSnapshot } from "../src/coding/workspace.js";
import type { CodingAssignment, CodingArtifacts } from "../src/shared/coding.js";
import { codingOperationPrefix, decodeCodingValue } from "../src/shared/coding-rpc.js";
import { CodingRuntime, type CodingRuntimeHost } from "../src/worker/coding-runtime.js";
import { CodingStore } from "../src/worker/coding-store.js";
import { codingExtension, codingOwnerTools, codingSubagentExtension } from "../src/worker/coding-tools.js";
import { Store, StateError, type Database } from "../src/worker/store.js";
import type { SubagentScope, SubagentScopeReader } from "../src/worker/subagent-types.js";

function fixture(t: TestContext, overrides: Partial<CodingRuntimeHost> = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "umpi-coding-tools-")));
  const cwd = join(root, "original");
  mkdirSync(cwd, { mode: 0o700 });
  execFileSync("git", ["init", "--quiet", "--template=", cwd], { stdio: "ignore" });
  writeFileSync(join(cwd, "target.txt"), "staged owner bytes\n");
  execFileSync("git", ["-C", cwd, "add", "--", "target.txt"], { stdio: "ignore" });
  writeFileSync(join(cwd, "target.txt"), "dirty owner bytes\n");
  writeFileSync(join(cwd, "untracked.txt"), "untracked owner bytes\n");
  const index = readFileSync(join(cwd, ".git", "index"));
  const sqlite = new DatabaseSync(join(root, "owner.sqlite"));
  let depth = 0;
  const db: Database = {
    all: <T extends object>(query: string, ...bindings: (string | number | null)[]) => sqlite.prepare(query).all(...bindings) as T[],
    transaction: <T>(run: () => T): T => {
      const savepoint = `coding_tools_${depth++}`;
      sqlite.exec(`SAVEPOINT ${savepoint}`);
      try { const value = run(); sqlite.exec(`RELEASE ${savepoint}`); return value; }
      catch (error) { sqlite.exec(`ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`); throw error; }
      finally { depth--; }
    },
  };
  const owner = new Store(db);
  owner.setSession("control", "owner-control");
  owner.registerBackgroundSession("owner-background", "control");
  const store = new CodingStore(owner);
  const poll = (executorId = "native-owner", activeRunId: string | null = null) => ({ executorId, workspaces: [cwd], available: true, activeRunId });
  store.poll(poll());
  const sessions = new Map<string, CodingNodeSession>();
  const unavailable = (): never => { throw new Error("This tool-only fixture must not start model generation or cloud execution"); };
  const host: CodingRuntimeHost = {
    harness: unavailable, extension: unavailable, archive: () => undefined, cloud: () => undefined,
    cloudAvailable: () => false, modelReady: async () => false, wake: async () => {}, track: unavailable, ...overrides,
  };
  const runtime = new CodingRuntime(store, host);
  const ownerTools = codingOwnerTools(runtime);
  const tools = codingExtension(runtime).tools!;
  t.after(async () => {
    try { for (const session of sessions.values()) await session.close(); }
    finally { sqlite.close(); rmSync(root, { recursive: true, force: true }); }
  });
  const request = { taskId: "coding-work", prompt: "Change target.txt in the approved private source copy", cwd, timeoutMs: 60_000 };

  // An in-process native executor route driver: use the same store poll/receipt
  // boundaries as the transport, but execute every admitted request on real files.
  async function pump() {
    const task = store.task(request.taskId);
    if (!task?.run || !sessions.has(task.run.runId) || task.run.stoppedAt) return;
    const session = sessions.get(task.run.runId)!;
    const response = store.poll(poll(task.run.executorId, task.run.runId));
    for (const operationId of response.cancelOperationIds) await session.cancel(operationId);
    for (const request of response.requests) await session.submit(request);
    for (const state of session.states()) {
      const previous = store.operation(state.operationId);
      if (previous && (!previous.receipt || previous.receipt.status === "running")) store.receipt(task.taskId, task.run.runId, state);
    }
  }
  async function execute(registrations: readonly ToolRegistration[], name: string, input: unknown, taskId: number, conversationId = "coding-conversation") {
    const tool = registrations.find(tool => tool.name === name);
    assert(tool, `Missing registered tool ${name}`);
    const api = {
      conversationId, taskId, output: (_chunk: string | Uint8Array) => {}, diagnostic: (_value: unknown) => {},
      outputWindow: { maxBytes: 50_000, maxLines: 2_000, minIntervalMs: 0, bytesPerSecond: 1_000_000 },
    } as unknown as ToolExecutionApi;
    let complete = false;
    const result = Promise.resolve().then(() => tool.execute(input, api, BACKGROUND_CONTEXT));
    void result.then(() => { complete = true; }, () => { complete = true; });
    const deadline = performance.now() + 10_000;
    while (!complete) {
      await pump();
      if (performance.now() >= deadline) throw new Error("Coding tool did not settle through the native RPC driver");
      await delay(1);
    }
    return result;
  }
  async function openCopy(assignment: CodingAssignment, sourceCwd = cwd) {
    const copy = join(root, `copy-${assignment.runId}`);
    const snapshot = await captureCodingSnapshot(sourceCwd);
    await restoreCodingSnapshot(snapshot.bytes, copy);
    const session = await CodingNodeSession.open({ assignment: { ...assignment, cwd: copy }, stateDirectory: join(root, `state-${assignment.runId}`) });
    sessions.set(assignment.runId, session);
    store.ready(assignment.taskId, assignment.runId, copy);
    store.session(assignment.taskId, "coding-conversation");
    return { copy, session };
  }
  function unchangedOriginal() {
    assert.equal(readFileSync(join(cwd, "target.txt"), "utf8"), "dirty owner bytes\n");
    assert.equal(readFileSync(join(cwd, "untracked.txt"), "utf8"), "untracked owner bytes\n");
    assert.deepEqual(readFileSync(join(cwd, ".git", "index")), index);
  }
  return {
    root, cwd, owner, store, poll, request, runtime, openCopy, unchangedOriginal,
    ownerExecute: (name: string, input: unknown, taskId: number, session = "owner-control") => execute(ownerTools, name, input, taskId, session),
    execute: (name: string, input: unknown, taskId: number) => execute(tools, name, input, taskId),
    childExecute: (readScope: SubagentScopeReader, name: string, input: unknown, taskId: number, conversationId = "coding-child") => execute(codingSubagentExtension(runtime, readScope).tools!, name, input, taskId, conversationId),
  };
}

function decoded(result: ToolExecutionResult): Record<string, unknown> {
  const content = result.content?.[0];
  assert(content?.type === "text");
  return JSON.parse(content.text) as Record<string, unknown>;
}

test("owned first-party writes cannot replay into a freshly approved native continuation", async t => {
  const f = fixture(t);
  const task = f.store.create(f.request, "control", "owner-control");
  f.store.approve(task.taskId, task.version);
  const first = f.store.poll(f.poll()).assignment!;
  assert(first);
  const old = await f.openCopy(first);
  assert.equal(readFileSync(join(old.copy, "target.txt"), "utf8"), "dirty owner bytes\n");
  const writeName = createWriteTool().name;
  const oldInput = { path: "target.txt", content: "first run change\n" };
  assert.notEqual((await f.execute(writeName, oldInput, 101)).isError, true);
  assert.equal(readFileSync(join(old.copy, "target.txt"), "utf8"), oldInput.content);
  const priorOperations = f.store.operations(first.runId);
  await assert.rejects(f.execute(writeName, { ...oldInput, content: "conflicting replay\n" }, 101), StateError);
  assert.deepEqual(f.store.operations(first.runId), priorOperations);
  assert.equal(readFileSync(join(old.copy, "target.txt"), "utf8"), oldInput.content);

  const check = "test -f target.txt";
  assert.notEqual((await f.execute(createBashTool().name, { command: check }, 102)).isError, true);
  const childScope: SubagentScope = { kind: "coding", taskId: task.taskId, runId: first.runId, parentSessionId: "coding-conversation", deadlineAt: first.deadlineAt };
  assert.notEqual((await f.childExecute(async () => childScope, writeName, { path: "child.txt", content: "first child run\n" }, 101)).isError, true);
  const corrected = f.store.correct(task.taskId, task.version, "Wait for the owner's additional detail");
  const stale = await f.execute("finish_coding_task", { expectedVersion: task.version, outcome: "needs_input", summary: "Need detail", verificationCommands: [check] }, 103);
  assert.equal(stale.isError, true);
  assert.equal(f.store.requireTask(task.taskId).status, "running");
  const finish = await f.execute("finish_coding_task", { expectedVersion: corrected.version, outcome: "needs_input", summary: "Need detail", verificationCommands: [check] }, 104);
  assert.notEqual(finish.isError, true);
  assert.equal(finish.control?.terminate, true);
  const artifactId = `${codingOperationPrefix(task.taskId, first.runId)}finalize:0`;
  const artifactRequest = { operationId: artifactId, method: "artifacts" as const, args: [] };
  f.store.enqueueRpc(task.taskId, first.runId, artifactRequest, true);
  await old.session.submit(artifactRequest);
  const artifactDeadline = performance.now() + 10_000;
  while (old.session.state(artifactId)?.status === "running") {
    if (performance.now() >= artifactDeadline) throw new Error("Native artifact collection did not settle");
    await delay(1);
  }
  const artifactReceipt = old.session.state(artifactId)!;
  assert(artifactReceipt.result?.ok);
  f.store.receipt(task.taskId, first.runId, artifactReceipt);
  const artifacts = decodeCodingValue(artifactReceipt.result.value) as CodingArtifacts;
  assert(artifacts.changes.some(change => change.path === "target.txt" && change.kind === "modified"));
  const patchKey = join(f.root, `${first.runId}-${artifacts.patchDigest}.patch`);
  writeFileSync(patchKey, artifacts.patch, { mode: 0o600 });
  assert.equal(readFileSync(patchKey, "utf8"), artifacts.patch);
  f.store.artifacts(task.taskId, first.runId, artifacts, patchKey);
  await old.session.close();
  const settled = f.store.stopped(task.taskId, first.runId, false);
  assert.equal(settled.status, "waiting_input");
  assert.equal(settled.result?.verification[0]?.command, check);
  assert.equal(settled.result?.verification[0]?.exitCode, 0);
  const historical = f.store.ownedRun(task.taskId, first.runId);
  assert(historical.stoppedAt && historical.resultReadyAt);
  assert.equal(historical.patchKey, patchKey);

  const continuation = f.store.correct(task.taskId, settled.version, "Now write the additional requested detail");
  assert.equal(continuation.status, "pending_approval");
  assert.equal(continuation.approvedAt, undefined);
  assert.equal(f.store.poll(f.poll()).assignment, null);
  f.store.approve(task.taskId, continuation.version);
  assert.equal(f.store.poll(f.poll("different-native-owner")).assignment, null);
  const second = f.store.poll(f.poll()).assignment!;
  assert(second);
  assert.equal(second.sourceRunId, first.runId);
  assert.equal(f.store.requireTask(task.taskId).run?.executorId, historical.executorId);
  const current = await f.openCopy(second, old.copy);
  assert.equal(readFileSync(join(current.copy, "target.txt"), "utf8"), oldInput.content);
  writeFileSync(join(old.copy, "target.txt"), "retained old bytes must not be rewritten\n");
  const currentOperations = f.store.operations(second.runId);
  await assert.rejects(f.childExecute(async () => childScope, writeName, { path: "child.txt", content: "first child run\n" }, 101), StateError);
  const newChildScope: SubagentScope = { ...childScope, runId: second.runId, deadlineAt: second.deadlineAt };
  await assert.rejects(f.childExecute(async () => newChildScope, writeName, { path: "child.txt", content: "first child run\n" }, 101), StateError);
  assert.equal(readFileSync(join(current.copy, "child.txt"), "utf8"), "first child run\n");
  await assert.rejects(f.execute(writeName, oldInput, 101), StateError);
  await assert.rejects(f.execute(writeName, { ...oldInput, content: "wrong arguments in new run\n" }, 101), StateError);
  assert.deepEqual(f.store.operations(second.runId), currentOperations);
  assert.equal(readFileSync(join(old.copy, "target.txt"), "utf8"), "retained old bytes must not be rewritten\n");
  assert.equal(readFileSync(join(current.copy, "target.txt"), "utf8"), oldInput.content);
  assert.notEqual((await f.execute(writeName, { path: "target.txt", content: "legitimate current change\n" }, 105)).isError, true);
  assert.equal(readFileSync(join(current.copy, "target.txt"), "utf8"), "legitimate current change\n");
  assert.equal(readFileSync(join(old.copy, "target.txt"), "utf8"), "retained old bytes must not be rewritten\n");
  assert.deepEqual(new CodingStore(f.owner).ownedRun(task.taskId, first.runId), historical);
  assert.deepEqual(f.store.runs(task.taskId).find(run => run.runId === first.runId), historical);
  assert.equal(readFileSync(patchKey, "utf8"), artifacts.patch);
  f.unchangedOriginal();
});

test("foreground proposals and corrections are idempotent but cannot approve or acquire background authority", async t => {
  const f = fixture(t);
  const proposed = await f.ownerExecute("request_coding_task", f.request, 201);
  assert.notEqual(proposed.isError, true);
  assert.equal(decoded(proposed).status, "pending_approval");
  assert.deepEqual(decoded(await f.ownerExecute("request_coding_task", f.request, 201)), decoded(proposed));
  assert.equal((await f.ownerExecute("request_coding_task", { ...f.request, prompt: "Conflicting owner request" }, 201)).isError, true);
  assert.equal(f.store.poll(f.poll()).assignment, null);
  const correction = { taskId: f.request.taskId, expectedVersion: 1, text: "Preserve the existing dirty source" };
  assert.notEqual((await f.ownerExecute("correct_coding_task", correction, 202)).isError, true);
  const corrected = f.store.requireTask(f.request.taskId);
  assert.equal(corrected.status, "pending_approval");
  assert.equal(corrected.approvedAt, undefined);
  assert.deepEqual(corrected.corrections, [correction.text]);
  assert.notEqual((await f.ownerExecute("correct_coding_task", correction, 202)).isError, true);
  assert.deepEqual(f.store.requireTask(f.request.taskId), corrected);
  assert.equal((await f.ownerExecute("correct_coding_task", { ...correction, text: "Different replay" }, 202)).isError, true);
  assert.equal((await f.ownerExecute("correct_coding_task", { ...correction, expectedVersion: corrected.version }, 203, "owner-background")).isError, true);
  assert.equal((await f.ownerExecute("request_coding_task", { ...f.request, taskId: "background-work" }, 204, "owner-background")).isError, true);
  assert.equal((await f.ownerExecute("cancel_coding_task", { taskId: corrected.taskId, expectedVersion: corrected.version }, 205, "owner-background")).isError, true);
  assert.equal(f.store.task("background-work"), undefined);
  assert.deepEqual(f.store.requireTask(f.request.taskId), corrected);
  assert.equal(f.store.poll(f.poll()).assignment, null);
  f.store.approve(corrected.taskId, corrected.version);
  assert.equal(f.store.poll(f.poll()).assignment?.taskId, corrected.taskId);
  f.unchangedOriginal();
});

test("native readiness rejects the original repository and descendants without authorizing file effects", t => {
  const f = fixture(t);
  const task = f.store.create(f.request, "control", "owner-control");
  f.store.approve(task.taskId, task.version);
  const assignment = f.store.poll(f.poll()).assignment!;
  assert(assignment);
  for (const unsafe of [f.cwd, join(f.cwd, "nested-copy")]) {
    assert.throws(() => f.store.ready(task.taskId, assignment.runId, unsafe), StateError);
    const retained = f.store.requireTask(task.taskId);
    assert.equal(retained.status, "preparing");
    assert.equal(retained.run?.executionCwd, undefined);
    assert.throws(() => f.store.assertRunning(task.taskId, assignment.runId), StateError);
  }
  f.unchangedOriginal();
});

test("coding children execute first-party effects in the approved copy with original conversation/task replay identities", async t => {
  const f = fixture(t), task = f.store.create(f.request, "control", "owner-control");
  f.store.approve(task.taskId, task.version);
  const assignment = f.store.poll(f.poll()).assignment!, { copy } = await f.openCopy(assignment);
  const scope: SubagentScope = { kind: "coding", taskId: task.taskId, runId: assignment.runId, parentSessionId: "coding-conversation", deadlineAt: assignment.deadlineAt };
  const readScope: SubagentScopeReader = async api => {
    assert(["coding-child", "coding-child-two"].includes(String(api.conversationId)));
    assert.equal(String(api.taskId), "501");
    return scope;
  };
  const writeName = createWriteTool().name;
  const childWrite = { path: "target.txt", content: "child one\n" };
  assert.notEqual((await f.childExecute(readScope, writeName, childWrite, 501)).isError, true);
  assert.equal(readFileSync(join(copy, "target.txt"), "utf8"), childWrite.content);
  const operations = f.store.operations(assignment.runId);
  assert.notEqual((await f.childExecute(readScope, writeName, childWrite, 501)).isError, true);
  assert.deepEqual(f.store.operations(assignment.runId), operations);
  await assert.rejects(f.childExecute(readScope, writeName, { ...childWrite, content: "conflicting replay\n" }, 501), StateError);
  assert.notEqual((await f.childExecute(readScope, writeName, { ...childWrite, path: "second.txt", content: "child two\n" }, 501, "coding-child-two")).isError, true);
  assert.equal(readFileSync(join(copy, "second.txt"), "utf8"), "child two\n");
  assert.notEqual((await f.execute(writeName, { path: "parent.txt", content: "parent\n" }, 501)).isError, true);
  assert.equal(readFileSync(join(copy, "parent.txt"), "utf8"), "parent\n");
  const bashReader: SubagentScopeReader = async api => { assert.equal(String(api.taskId), "502"); assert.equal(String(api.conversationId), "coding-child"); return scope; };
  const command = "printf 'child shell\\n' > shell.txt && test -f second.txt";
  assert.notEqual((await f.childExecute(bashReader, createBashTool().name, { command }, 502)).isError, true);
  assert.equal(readFileSync(join(copy, "shell.txt"), "utf8"), "child shell\n");
  assert(f.store.commands(assignment.runId).some(item => item.command === command && item.exitCode === 0 && item.error === null));
  const taskRead = await f.childExecute(async () => scope, "read_coding_task", {}, 503);
  assert.equal(decoded(taskRead).executionCwd, copy);
  assert.equal(f.store.forSession("coding-child"), undefined);
  assert.notEqual((await f.childExecute(async () => scope, "edit", { path: "target.txt", edits: [{ oldText: "child one", newText: "child edited" }] }, 504)).isError, true);
  assert.equal(readFileSync(join(copy, "target.txt"), "utf8"), "child edited\n");
  const childRead = await f.childExecute(async () => scope, "read", { path: "target.txt" }, 505);
  assert.notEqual(childRead.isError, true);
  assert(childRead.content?.some(item => item.type === "text" && item.text.includes("child edited")));
  await assert.rejects(f.childExecute(async () => scope, writeName, { path: join(f.cwd, "target.txt"), content: "forbidden original write\n" }, 506), StateError);
  await assert.rejects(f.childExecute(async () => scope, writeName, { path: "../original/target.txt", content: "forbidden traversal write\n" }, 507), StateError);
  await assert.rejects(f.execute(writeName, { path: join(f.cwd, "target.txt"), content: "forbidden parent write\n" }, 508), StateError);
  f.unchangedOriginal();
});

test("child wrong scope, stale replay and closed runs reject before RPC effects while active children gate root finish", async t => {
  let childrenActive = true;
  const f = fixture(t, { subagents: { active: async () => childrenActive, stop: async () => {}, correct: async () => {} } });
  const task = f.store.create(f.request, "control", "owner-control");
  f.store.approve(task.taskId, task.version);
  const assignment = f.store.poll(f.poll()).assignment!, { copy } = await f.openCopy(assignment);
  const scope: SubagentScope = { kind: "coding", taskId: task.taskId, runId: assignment.runId, parentSessionId: "coding-conversation", deadlineAt: assignment.deadlineAt };
  const input = { path: "target.txt", content: "must not reach original\n" };
  const before = f.store.operations(assignment.runId);
  for (const wrong of [
    { ...scope, taskId: "missing-task" }, { ...scope, runId: "old-run" },
    { ...scope, parentSessionId: "other-parent" }, { ...scope, deadlineAt: new Date(Date.parse(assignment.deadlineAt) + 1).toISOString() },
    { kind: "assistant" as const, parentSessionId: "owner-control", channel: "control" as const },
  ]) await assert.rejects(f.childExecute(async () => wrong, createWriteTool().name, input, 601), StateError);
  assert.deepEqual(f.store.operations(assignment.runId), before);
  assert.equal(readFileSync(join(copy, "target.txt"), "utf8"), "dirty owner bytes\n");
  const finish = { expectedVersion: task.version, outcome: "needs_input", summary: "Need owner detail", verificationCommands: [] };
  assert.equal((await f.execute("finish_coding_task", finish, 602)).isError, true);
  assert.equal(f.store.requireTask(task.taskId).status, "running");
  assert.equal(f.store.requireTask(task.taskId).run?.stoppedAt, undefined);
  childrenActive = false;
  assert.notEqual((await f.execute("finish_coding_task", finish, 603)).isError, true);
  assert.equal(f.store.requireTask(task.taskId).status, "finishing");
  assert.equal(f.store.requireTask(task.taskId).run?.stoppedAt, undefined);
  await assert.rejects(f.childExecute(async () => scope, createWriteTool().name, input, 604), StateError);
  assert.equal((await f.childExecute(async () => scope, "read_coding_task", {}, 605)).isError, true);
  assert.deepEqual(f.store.operations(assignment.runId), before);
  f.unchangedOriginal();
});

test("same-run child reports retain identity across reopen, invalidate stale finish and cannot become corrections or closed-run work", async t => {
  const f = fixture(t), task = f.store.create(f.request, "control", "owner-control");
  f.store.approve(task.taskId, task.version);
  const assignment = f.store.poll(f.poll()).assignment!;
  await f.openCopy(assignment);
  const initial = f.store.inputs()[0]!;
  const corrected = f.store.correct(task.taskId, task.version, "Owner changes the target");
  const correction = f.store.inputs().find(item => !item.initial)!;
  assert.equal(correction.operationId, `coding-correction:${assignment.runId}:${corrected.version}`);
  assert.equal(correction.kind, "correction");
  const text = "Child reviewed the exact copy; parent must verify its own final changes.";
  f.store.subagentResult(task.taskId, assignment.runId, "native-report:one", text);
  const report = f.store.inputs().find(item => item.kind === "subagent")!;
  assert(report && report.operationId !== correction.operationId && report.operationId !== initial.operationId);
  assert.equal(report.text, text);
  const current = f.store.requireTask(task.taskId), count = f.store.inputs().length;
  assert.equal(current.version, corrected.version + 1);
  assert.equal(current.sessionId, "coding-conversation");
  assert.equal(current.run?.runId, assignment.runId);
  assert.equal(f.store.tasks().length, 1);
  const reopened = new CodingStore(f.owner);
  reopened.subagentResult(task.taskId, assignment.runId, "native-report:one", text);
  assert.equal(reopened.inputs().length, count);
  assert.deepEqual(reopened.requireTask(task.taskId), current);
  reopened.inputState(report.operationId, "done");
  reopened.subagentResult(task.taskId, assignment.runId, "native-report:one", text);
  assert.equal(reopened.inputs().length, count - 1);
  assert.throws(() => reopened.subagentResult(task.taskId, assignment.runId, "native-report:one", "different answer"), StateError);
  assert.throws(() => reopened.subagentResult(task.taskId, "older-run", "native-report:two", text), StateError);
  assert.equal((await f.execute("finish_coding_task", { expectedVersion: corrected.version, outcome: "needs_input", summary: "Need detail", verificationCommands: [] }, 701)).isError, true);
  reopened.cancel(task.taskId, current.version);
  assert.throws(() => reopened.subagentResult(task.taskId, assignment.runId, "native-report:two", text), StateError);
  const scope: SubagentScope = { kind: "coding", taskId: task.taskId, runId: assignment.runId, parentSessionId: "coding-conversation", deadlineAt: assignment.deadlineAt };
  await assert.rejects(f.childExecute(async () => scope, createWriteTool().name, { path: "target.txt", content: "cancelled write" }, 702), StateError);
  assert.equal(f.store.operations(assignment.runId).length, 0);
  f.unchangedOriginal();
});

test("parent model ending waits for same-run reports and forwards each owner correction once without extending the run", async t => {
  const tracked: Promise<void>[] = [], submitted: { id: string; text: string }[] = [];
  const waits = new Map<string, PromiseWithResolvers<{ status: "done" }>>();
  const corrections: { id: string; text: string }[] = [];
  let active = true, aborts = 0;
  const harness = {
    async submit(text: string, options: { operationId: string }) { submitted.push({ id: options.operationId, text }); },
    wait(id: string) {
      const pending = Promise.withResolvers<{ status: "done" }>();
      waits.set(id, pending); return pending.promise;
    },
    async abort() { aborts++; },
  };
  const f = fixture(t, {
    harness: () => harness as unknown as PiHarness,
    modelReady: async () => true, track: work => { tracked.push(work); },
    subagents: { active: async () => active, stop: async () => {}, correct: async (_parent, _run, id, text) => { corrections.push({ id, text }); } },
  });
  const task = f.store.create(f.request, "control", "owner-control");
  f.store.approve(task.taskId, task.version);
  const assignment = f.store.poll(f.poll()).assignment!, { copy } = await f.openCopy(assignment);
  f.owner.effect(`coding-session:${assignment.runId}`, () => ({ sessionId: "coding-conversation", cwd: copy }));
  const initial = f.store.inputs()[0]!;
  await f.runtime.drive();
  for (let tries = 0; !waits.has(initial.operationId) && tries < 100; tries++) await delay(1);
  assert(waits.has(initial.operationId));
  waits.get(initial.operationId)!.resolve({ status: "done" });
  await Promise.all(tracked.splice(0));
  assert.equal(f.store.requireTask(task.taskId).status, "running");
  assert.equal(f.store.inputs().length, 0);
  assert.equal(aborts, 0);
  const corrected = f.store.correct(task.taskId, task.version, "Owner correction while child is working");
  const correction = f.store.inputs()[0]!;
  f.store.subagentResult(task.taskId, assignment.runId, "native-report:model-end", "Child result with actual effects still requiring parent verification.");
  const report = f.store.inputs().find(item => item.kind === "subagent")!;
  await f.runtime.drive();
  for (let tries = 0; !waits.has(report.operationId) && tries < 100; tries++) await delay(1);
  assert(waits.has(report.operationId));
  await f.runtime.drive();
  assert.deepEqual(corrections, [{ id: correction.operationId, text: correction.text }]);
  assert.equal(submitted.filter(item => item.id === correction.operationId).length, 1);
  assert.equal(submitted.filter(item => item.id === report.operationId).length, 1);
  assert.equal(f.store.requireTask(task.taskId).run?.assignment.deadlineAt, assignment.deadlineAt);
  assert.equal(f.store.requireTask(task.taskId).run?.runId, assignment.runId);
  assert.equal(f.store.requireTask(task.taskId).sessionId, "coding-conversation");
  assert.equal(corrected.version + 1, f.store.requireTask(task.taskId).version);
  waits.get(correction.operationId)!.resolve({ status: "done" });
  waits.get(report.operationId)!.resolve({ status: "done" });
  await Promise.all(tracked.splice(0));
  assert.equal(f.store.requireTask(task.taskId).status, "running");
  active = false;
  const version = f.store.requireTask(task.taskId).version;
  assert.notEqual((await f.execute("finish_coding_task", { expectedVersion: version, outcome: "needs_input", summary: "Report integrated; need owner detail", verificationCommands: [] }, 801)).isError, true);
  assert.equal(f.store.requireTask(task.taskId).run?.stoppedAt, undefined);
  f.unchangedOriginal();
});

test("finishing and cancellation stop child models before artifact or parent lifecycle without claiming executor stop", async t => {
  for (const cancel of [false, true]) {
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    const tracked: Promise<void>[] = [];
    let aborts = 0;
    const f = fixture(t, {
      harness: () => ({ async abort() { aborts++; } }) as unknown as PiHarness,
      track: work => { tracked.push(work); },
      subagents: { active: async () => false, correct: async () => {}, async stop() { entered.resolve(); await release.promise; } },
    });
    const task = f.store.create(f.request, "control", "owner-control");
    f.store.approve(task.taskId, task.version);
    const assignment = f.store.poll(f.poll()).assignment!;
    await f.openCopy(assignment);
    if (cancel) f.store.cancel(task.taskId, task.version);
    else await f.runtime.requestFinish(task.taskId, assignment.runId, { expectedVersion: task.version, outcome: "needs_input", summary: "Need owner input", verificationCommands: [] });
    await f.runtime.drive(); await entered.promise;
    assert.equal(aborts, 0);
    assert.equal(f.store.operations(assignment.runId).length, 0);
    assert.equal(f.store.requireTask(task.taskId).run?.stoppedAt, undefined);
    release.resolve(); await Promise.all(tracked.splice(0));
    assert.equal(aborts, cancel ? 1 : 0);
    assert.equal(f.store.operations(assignment.runId).filter(item => item.request.method === "artifacts").length, cancel ? 0 : 1);
    assert.equal(f.store.requireTask(task.taskId).run?.stoppedAt, undefined);
    f.unchangedOriginal();
  }
});

test("parent deadline expiry fences an existing child invocation and report without treating it as executor stop", async t => {
  const f = fixture(t), task = f.store.create(f.request, "control", "owner-control");
  f.store.approve(task.taskId, task.version);
  const assignment = f.store.poll(f.poll()).assignment!, { copy } = await f.openCopy(assignment);
  const scope: SubagentScope = { kind: "coding", taskId: task.taskId, runId: assignment.runId, parentSessionId: "coding-conversation", deadlineAt: assignment.deadlineAt };
  const input = { path: "target.txt", content: "before deadline\n" };
  assert.notEqual((await f.childExecute(async () => scope, createWriteTool().name, input, 901)).isError, true);
  const operations = f.store.operations(assignment.runId);
  f.store.expire(Date.parse(assignment.deadlineAt));
  assert.equal(f.store.requireTask(task.taskId).status, "cancel_requested");
  assert.equal(f.store.requireTask(task.taskId).timedOut, true);
  assert.equal(f.store.requireTask(task.taskId).run?.stoppedAt, undefined);
  await assert.rejects(f.childExecute(async () => scope, createWriteTool().name, input, 901), StateError);
  await assert.rejects(f.childExecute(async () => scope, createBashTool().name, { command: "printf 'expired' > target.txt" }, 902), StateError);
  assert.throws(() => f.store.subagentResult(task.taskId, assignment.runId, "expired-report", "Expired child must not create current parent input"), StateError);
  assert.deepEqual(f.store.operations(assignment.runId), operations);
  assert.equal(readFileSync(join(copy, "target.txt"), "utf8"), input.content);
  f.unchangedOriginal();
});
