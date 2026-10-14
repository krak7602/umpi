import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import type { Context, JsonValue } from "@earendil-works/chord";
import { awaitWithContext, BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, getCurrentSystemPrompt, Type } from "@earendil-works/pi-ai";
import type { FauxResponseStep, TranscriptContext } from "@earendil-works/pi-ai";
import type { ConversationId, Extension, Harness as NativeHarness, TaskId, ToolExecutionApi, ToolExecutionResult } from "@earendil-works/pi-durable";
import { createRegistry, defineDoc, defineTask, defineTool, Harness, LiveDoc } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { InputError, record } from "../src/shared/protocol.js";
import { assistantSubagentExtension } from "../src/worker/subagent-profile.js";
import { SubagentRuntime } from "../src/worker/subagent-runtime.js";
import type { SubagentReport, SubagentRuntimeHost, SubagentScope } from "../src/worker/subagent-types.js";
import { StateError, Store } from "../src/worker/store.js";
import type { Database } from "../src/worker/store.js";

const context = BACKGROUND_CONTEXT;
type Deferred = { promise: Promise<void>; resolve(): void };
function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
async function eventually<T>(harness: NativeHarness, read: () => Promise<T>, accept: (value: T) => boolean): Promise<T> {
  let pulse = deferred();
  const stop = harness.subscribeCommits(() => pulse.resolve());
  try {
    for (;;) {
      const changed = pulse.promise;
      const value = await read();
      if (accept(value)) return value;
      await changed;
      pulse = deferred();
    }
  } finally { stop(); }
}
function decoded(result: ToolExecutionResult): Record<string, unknown> {
  const content = result.content?.[0];
  assert.equal(result.isError, undefined, content?.type === "text" ? content.text : "tool error");
  assert.equal(content?.type, "text");
  return record(JSON.parse(content?.type === "text" ? content.text : "null"));
}
function lastText(request: TranscriptContext): string {
  const last = request.messages.findLast(message => message.role !== "system");
  if (last === undefined) return "";
  return typeof last.content === "string" ? last.content : last.content.flatMap(part => part.type === "text" ? [part.text] : []).join("");
}
function nativeId(value: unknown): ConversationId {
  assert.equal(typeof value, "number"); assert.ok(Number.isSafeInteger(value));
  return value as ConversationId;
}

const ApiTask = defineTask<null, { phase: "open" }, null>({
  name: "test.subagent-invocation", version: 1, initial: () => ({ phase: "open" }),
  phases: { open: async (_task, runtime, taskContext) => {
    // A real tool retains a live task until its invocation ends. Terminal tasks cannot acquire receipts.
    await runtime.sleep(Date.now() + 86_400_000, taskContext);
    return runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), taskContext);
  } },
  abort: (_task, runtime, taskContext) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), taskContext),
});
const ApiMemo = defineDoc<{ values: Record<string, JsonValue>; details: JsonValue | null }>({
  kind: "test.subagent-invocation-memo", version: 1, scope: "task", initial: () => ({ values: {}, details: null }),
});

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "umpi-subagents-"));
  const path = join(directory, "native.sqlite");
  const app = new DatabaseSync(":memory:");
  let depth = 0;
  const db: Database = {
    all: <T extends object>(query: string, ...bindings: (string | number | null)[]) => app.prepare(query).all(...bindings) as T[],
    transaction: <T>(run: () => T): T => {
      const name = `subagent_${depth++}`; app.exec(`SAVEPOINT ${name}`);
      try { const value = run(); app.exec(`RELEASE ${name}`); return value; }
      catch (error) { app.exec(`ROLLBACK TO ${name}; RELEASE ${name}`); throw error; }
      finally { depth--; }
    },
  };
  const store = new Store(db), models = createModels(), registry = createRegistry();
  const faux = fauxProvider({ provider: "subagent-test", tokensPerSecond: Infinity });
  models.setProvider(faux.provider);
  let harness: NativeHarness;
  let autoDrive = true, closed = false, denyScope = false, rejectDelivery = false, interruptAck = false, interruptSpawn = false;
  let scopeOverride: SubagentScope | undefined;
  let gate: Deferred | undefined, cleanup: Deferred | undefined, deliveryGate: Deferred | undefined;
  const started = deferred(), aborting = deferred(), deliveryStarted = deferred(), spawnCommitted = deferred(), spawnGate = deferred();
  const reports = new Map<string, SubagentReport>();
  const pending = new Set<Promise<void>>(), errors: unknown[] = [];
  function track(work: Promise<void>) {
    pending.add(work);
    void work.catch(error => { if (!closed) errors.push(error); }).finally(() => pending.delete(work));
  }
  let runtime: SubagentRuntime;
  const wake = async () => {
    if (autoDrive && !closed) track(Promise.resolve().then(() => runtime.drive()));
  };
  const general = () => {
    const profile = assistantSubagentExtension(store, "UTC", wake, (api, callContext) => runtime.childScope(api, callContext));
    return {
      ...profile,
      tools: profile.tools?.map(tool => tool.name !== "read_core_context" ? tool : { ...tool, async execute(args, api, callContext) {
        await runtime.childScope(api, callContext);
        started.resolve();
        if (gate !== undefined) {
          try { await awaitWithContext(gate.promise, callContext); }
          finally { if (cleanup !== undefined) { aborting.resolve(); await cleanup.promise; } }
        }
        return tool.execute(args, api, callContext);
      } }),
    } satisfies Extension;
  };
  const coding = {
    name: "test-coding-subagent", tools: [defineTool({
      name: "inspect_approved_copy", description: "Read the current approved test copy scope", parameters: Type.Object({}), replay: "safe",
      async execute(_args, api, callContext) {
        const scope = await runtime.childScope(api, callContext);
        if (scope.kind !== "coding") throw new StateError(403, "Not a coding child");
        started.resolve();
        if (gate !== undefined) await awaitWithContext(gate.promise, callContext);
        return { content: [{ type: "text", text: JSON.stringify(scope) }] };
      },
    })],
  } satisfies Extension;
  const host: SubagentRuntimeHost = {
    harness: async () => harness,
    scope(parentSessionId) { return scopeOverride ?? { kind: "assistant", parentSessionId, channel: "control" }; },
    validate(scope) {
      if (denyScope || (scope.kind === "coding" && (!scopeOverride || JSON.stringify(scope) !== JSON.stringify(scopeOverride)))) throw new StateError(409, "Approved scope changed");
    },
    profile(scope) { return scope.kind === "coding" ? coding : general(); },
    async deliver(report) {
      deliveryStarted.resolve();
      if (deliveryGate !== undefined) await deliveryGate.promise;
      if (rejectDelivery) throw new Error("Application admission interrupted");
      const prior = reports.get(report.id);
      if (prior !== undefined) assert.deepEqual(prior, report);
      reports.set(report.id, report);
      if (interruptAck) { interruptAck = false; throw new Error("Application admission succeeded before acknowledgement was interrupted"); }
    },
    wake, track,
  };
  runtime = new SubagentRuntime(host);
  registry.install({ ...runtime.extension(), tools: runtime.extension().tools?.map(tool => tool.name !== "spawn_subagent" ? tool : {
    ...tool, async execute(args, api, callContext) {
      const value = await tool.execute(args, api, callContext);
      if (interruptSpawn) { spawnCommitted.resolve(); await awaitWithContext(spawnGate.promise, callContext); }
      return value;
    },
  }) });
  registry.install(general()); registry.install(coding);
  registry.install({ name: "test-native-api", tasks: [ApiTask] });
  let mutationCount = 0;
  registry.install({ name: "test-parent-mutations", tools: [defineTool({
    name: "mutate_owner_state", description: "Parent-only test state mutation", parameters: Type.Object({}), replay: "safe",
    async execute() { mutationCount++; return { content: [{ type: "text", text: "mutated" }] }; },
  })] });
  const options = { models, registry, settings: { compaction: { enabled: false }, retry: { enabled: false } } };
  harness = await Harness.open(await openNodeSqliteStorage(path), options, context);
  const model = faux.getModel();
  const root = await harness.root(context, { agent: { model: { provider: model.provider, modelId: model.id }, thinkingLevel: "off", extensions: [runtime.extension(), registry.snapshot().extension("test-parent-mutations")!], tools: null } });
  const route: FauxResponseStep = request => {
    const child = getCurrentSystemPrompt(request.messages).includes("You are the focused subagent");
    const last = request.messages.findLast(message => message.role !== "system");
    const text = lastText(request);
    if (last?.role === "toolResult") return fauxAssistantMessage(child ? "Child completed with native evidence." : "Parent is available.");
    if (!child) {
      if (text === "delegate") return fauxAssistantMessage([fauxToolCall("spawn_subagent", { name: "reader", goal: "inspect context" })], { stopReason: "toolUse" });
      return fauxAssistantMessage("Parent is available.");
    }
    if (text.includes("forbidden")) return fauxAssistantMessage([
      fauxToolCall("spawn_subagent", { name: "nested", goal: "Do not execute" }),
      fauxToolCall("mutate_owner_state", {}),
    ], { stopReason: "toolUse" });
    if (text.includes("oversized")) return fauxAssistantMessage("x".repeat(20_000));
    if (text.includes("model failure")) return fauxAssistantMessage("", { stopReason: "error", errorMessage: "Scripted child failure" });
    return fauxAssistantMessage([fauxToolCall(scopeOverride?.kind === "coding" ? "inspect_approved_copy" : "read_core_context", {})], { stopReason: "toolUse" });
  };
  faux.setResponses(Array.from({ length: 400 }, () => route));
  t.after(async () => {
    closed = true; autoDrive = false; gate?.resolve(); cleanup?.resolve(); deliveryGate?.resolve(); spawnGate.resolve();
    await Promise.allSettled([...pending]); await harness.close(context); app.close();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    runtime, rootId: root.id, reports, errors, started, aborting, deliveryStarted, spawnCommitted, store, registry, faux,
    get harness() { return harness; }, get mutationCount() { return mutationCount; },
    set autoDrive(value: boolean) { autoDrive = value; }, set rejectDelivery(value: boolean) { rejectDelivery = value; },
    set interruptAck(value: boolean) { interruptAck = value; },
    set interruptSpawn(value: boolean) { interruptSpawn = value; },
    set denyScope(value: boolean) { denyScope = value; }, set scope(value: SubagentScope) { scopeOverride = value; },
    hold(delayedCleanup = false) { gate = deferred(); if (delayedCleanup) cleanup = deferred(); },
    release() { gate?.resolve(); }, releaseCleanup() { cleanup?.resolve(); },
    pauseDelivery() { deliveryGate = deferred(); }, releaseDelivery() { deliveryGate?.resolve(); },
    async reopen() { autoDrive = false; await Promise.allSettled([...pending]); await harness.close(context); harness = await Harness.open(await openNodeSqliteStorage(path), options, context); harness.resume(); },
    async api(conversationId = root.id, existing?: TaskId): Promise<ToolExecutionApi> {
      const taskId = existing ?? await harness.commit(tx => tx.createTask(ApiTask, null, { ownership: { kind: "conversation" }, conversationId }), context);
      const conversation = await harness.conversation(conversationId, context); assert.ok(conversation);
      // Receipts are exercised through their real native task identities and SQLite commits, including re-entry after reopen.
      return {
        taskId, conversationId, callId: `test:${taskId}`, registry: registry.snapshot(), models, env: undefined, outputWindow: undefined,
        agent: callContext => conversation.agent(callContext), output() {}, diagnostic() {},
        details: (value, callContext) => harness.commit(async tx => { (await tx.doc(ApiMemo, taskId)).details = value; }, callContext),
        commit: harness.commit.bind(harness), snapshot: harness.snapshot.bind(harness), snapshotAsOf: harness.snapshotAsOf.bind(harness), watchDoc: harness.watchDoc.bind(harness),
        memo: async <T extends JsonValue>(name: string, candidateOrContext: T | Context, callContext?: Context): Promise<T | undefined> => {
          if (callContext === undefined) return (await harness.snapshot(ApiMemo, taskId, candidateOrContext as Context))?.values[name] as T | undefined;
          return harness.commit(async tx => { const doc = await tx.doc(ApiMemo, taskId); if (!Object.hasOwn(doc.values, name)) doc.values[name] = candidateOrContext as T; return doc.values[name] as T; }, callContext);
        },
        createTask: (task, input, options, callContext) => harness.commit(tx => tx.createTask(task, input, { ...options, conversationId }), callContext),
        getTask: harness.getTask.bind(harness), waitForTask: harness.waitForTask.bind(harness), conversation: harness.conversation.bind(harness),
      };
    },
    tool(name: string) { const tool = runtime.extension().tools?.find(item => item.name === name); assert.ok(tool); return tool; },
  };
}

async function childTasks(harness: NativeHarness) {
  return harness.commit(tx => tx.scanTasks({ kind: "umpi.subagent-reporter" }, 100), context);
}

test("native background children leave the parent available and automatically produce one durable application report", async t => {
  const f = await fixture(t); f.hold();
  const root = await f.harness.conversation(f.rootId, context); assert.ok(root);
  const parent = await root.submit({ type: "input", content: "delegate", requestId: "delegate-one" }, context);
  assert.equal((await parent.wait(context)).status, "done");
  await f.started.promise;
  await root.waitForIdle(context);
  assert.equal((await f.harness.snapshot(LiveDoc, f.rootId, context))?.run, undefined);
  const another = await root.submit({ type: "input", content: "another question", requestId: "foreground-two" }, context);
  assert.equal((await another.wait(context)).status, "done");
  assert.equal(f.reports.size, 0);
  f.release();
  await eventually(f.harness, async () => [...f.reports.values()], reports => reports.length === 1);
  const report = [...f.reports.values()][0]!;
  assert.equal(report.outcome, "done"); assert.equal(report.scope.parentSessionId, String(f.rootId));
  const tasks = await childTasks(f.harness); assert.equal(tasks.items.length, 1);
  const task = tasks.items[0]!; assert.equal(task.state.status, "terminal");
  if (task.state.status === "terminal" && task.state.outcome.status === "completed") assert.deepEqual(task.state.outcome.result, report);
  await f.runtime.drive(); assert.equal(f.reports.size, 1); assert.deepEqual(f.errors, []);
});

test("SQLite reopen and exact tool replay retain one child, one submission and one report; changed replay payload conflicts", async t => {
  const f = await fixture(t); f.autoDrive = false; f.hold();
  const api = await f.api();
  const args = { name: "reader", goal: "inspect context" };
  const created = decoded(await f.tool("spawn_subagent").execute(args, api, context));
  f.harness.resume(); await f.started.promise;
  await f.reopen();
  const replayApi = await f.api(f.rootId, api.taskId);
  assert.deepEqual(decoded(await f.tool("spawn_subagent").execute(args, replayApi, context)), created);
  assert.equal((await f.tool("spawn_subagent").execute({ ...args, goal: "another goal" }, replayApi, context)).isError, true);
  f.release(); await f.runtime.drive();
  await eventually(f.harness, () => f.runtime.read(String(created.agentId)), value => record(value).status === "idle");
  await f.runtime.drive(); assert.equal(f.reports.size, 1);
  const tasks = await childTasks(f.harness); assert.equal(tasks.items.length, 1);
  const childId = nativeId(created.conversationId);
  const submissions = await f.harness.commit(tx => tx.submissionByRequest(childId, `subagent:${tasks.items[0]!.id}`), context);
  assert.ok(submissions); assert.equal(submissions.status, "done");
  const child = await f.harness.conversation(childId, context); assert.ok(child);
  assert.equal((await child.context(context)).messages.filter(message => message.role === "user" && JSON.stringify(message.content).includes(args.goal)).length, 1);
  await f.reopen(); await f.runtime.drive(); assert.equal(f.reports.size, 1);
  assert.equal(record(await f.runtime.read(String(created.agentId))).conversationId, childId);
});

test("actual child generation cannot inherit parent mutators or recursively delegate; reads and cancellation reject a wrong parent", async t => {
  const f = await fixture(t);
  const created = decoded(await f.tool("spawn_subagent").execute({ name: "reader", goal: "attempt forbidden tools" }, await f.api(), context));
  await eventually(f.harness, async () => f.reports.size, count => count === 1);
  assert.equal(f.mutationCount, 0);
  assert.equal((await childTasks(f.harness)).items.length, 1);
  const child = await f.harness.conversation(nativeId(created.conversationId), context); assert.ok(child);
  const parent = await f.harness.conversation(f.rootId, context); assert.ok(parent);
  assert.deepEqual((await child.agent(context)).model, (await parent.agent(context)).model);
  assert.equal((await child.agent(context)).thinkingLevel, (await parent.agent(context)).thinkingLevel);
  const offered = (await child.agent(context)).tools.map(tool => tool.name);
  assert.deepEqual(offered.sort(), ["current_time", "list_reminders", "job_status", "read_core_context"].sort());
  const messages = (await child.context(context)).messages;
  const toolResults = messages.filter(message => message.role === "toolResult");
  assert.equal(toolResults.length, 2); assert.ok(toolResults.every(message => message.isError));
  const other = await f.harness.createConversation({ ownership: { kind: "ownerless" } }, context);
  await assert.rejects(f.runtime.read(String(created.agentId), String(other.id)), error => error instanceof StateError && error.status === 404);
  await assert.rejects(f.runtime.cancel(String(created.agentId), 1, String(other.id)), error => error instanceof StateError && error.status === 404);
  const forbidden = await f.tool("spawn_subagent").execute({ name: "nested", goal: "inspect" }, await f.api(child.id), context);
  assert.equal(forbidden.isError, true); assert.equal((await childTasks(f.harness)).items.length, 1);
});

test("active correction is version bound, keeps its deadline and reports only the corrected generation as success", async t => {
  const f = await fixture(t); f.autoDrive = false; f.hold();
  const created = decoded(await f.tool("spawn_subagent").execute({ name: "reader", goal: "inspect original" }, await f.api(), context));
  f.harness.resume(); await f.started.promise;
  const correctionApi = await f.api();
  const args = { agentId: String(created.agentId), expectedVersion: 1, message: "inspect corrected", timeoutMs: 900_000 };
  const corrected = decoded(await f.tool("message_subagent").execute(args, correctionApi, context));
  assert.equal(corrected.agentId, created.agentId); assert.equal(corrected.conversationId, created.conversationId);
  assert.equal(corrected.deadlineAt, created.deadlineAt); assert.equal(corrected.version, 2);
  assert.deepEqual(decoded(await f.tool("message_subagent").execute(args, correctionApi, context)), corrected);
  assert.equal((await f.tool("message_subagent").execute(args, await f.api(), context)).isError, true);
  await assert.rejects(f.runtime.cancel(String(created.agentId), 1), error => error instanceof StateError && error.status === 409);
  f.release();
  await eventually(f.harness, () => f.runtime.read(String(created.agentId)), value => record(value).status === "idle");
  await f.runtime.drive();
  const reports = [...f.reports.values()]; assert.equal(reports.filter(report => report.outcome === "done").length, 1);
  assert.equal(reports.find(report => report.outcome === "done")?.version, 2);
  assert.ok(reports.some(report => report.version === 1 && report.outcome === "cancelled"));
  const child = await f.harness.conversation(nativeId(created.conversationId), context); assert.ok(child);
  assert.ok((await child.context(context)).messages.some(message => message.role === "user" && JSON.stringify(message.content).includes("inspect corrected")));
});

test("a replayed old cancel cannot stop a later follow-up, which inherits the parent's current agent selection", async t => {
  const f = await fixture(t); f.autoDrive = false; f.hold(true);
  const created = decoded(await f.tool("spawn_subagent").execute({ name: "reader", goal: "inspect context" }, await f.api(), context));
  f.harness.resume(); await f.started.promise;
  const cancelApi = await f.api(), args = { agentId: String(created.agentId), expectedVersion: 1 };
  const cancellation = decoded(await f.tool("cancel_subagent").execute(args, cancelApi, context));
  assert.equal(cancellation.status, "stopping");
  await f.runtime.drive(); await f.aborting.promise;
  const stopping = record(await f.runtime.read(String(created.agentId)));
  assert.equal(stopping.actualIdle, false); assert.equal(stopping.status, "stopping");
  assert.equal((await f.tool("message_subagent").execute({ agentId: String(created.agentId), expectedVersion: 2, message: "inspect new" }, await f.api(), context)).isError, true);
  f.releaseCleanup(); f.release();
  await eventually(f.harness, () => f.runtime.read(String(created.agentId)), value => record(value).status === "idle");
  await f.runtime.drive();
  const parent = await f.harness.conversation(f.rootId, context); assert.ok(parent);
  await parent.configure({ thinkingLevel: "high" }, context);
  const resumed = decoded(await f.tool("message_subagent").execute({ agentId: String(created.agentId), expectedVersion: 2, message: "inspect new" }, await f.api(), context));
  assert.equal(resumed.agentId, created.agentId); assert.equal(resumed.version, 3); assert.equal(resumed.epoch, 2);
  const resumedChild = await f.harness.conversation(nativeId(resumed.conversationId), context); assert.ok(resumedChild);
  assert.equal((await resumedChild.agent(context)).thinkingLevel, "high");
  assert.deepEqual(decoded(await f.tool("cancel_subagent").execute(args, cancelApi, context)), cancellation);
  assert.equal(record(await f.runtime.read(String(created.agentId))).version, 3);
  await assert.rejects(f.runtime.cancel(String(created.agentId), 2), StateError);
  await f.runtime.drive();
  await eventually(f.harness, () => f.runtime.read(String(created.agentId)), value => record(value).status === "idle");
  await f.runtime.drive(); assert.ok([...f.reports.values()].some(report => report.version === 3 && report.outcome === "done"));
});

test("coding deadlines revoke tool authority, retain original bounds, and remain active until pending reports are admitted", async t => {
  const f = await fixture(t); f.autoDrive = false; f.hold();
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const deadlineAt = new Date(Date.now() + 1_100).toISOString();
  f.scope = { kind: "coding", parentSessionId: String(f.rootId), taskId: "task-one", runId: "run-one", deadlineAt };
  const created = decoded(await f.tool("spawn_subagent").execute({ name: "editor", goal: "inspect approved copy", timeoutMs: 900_000 }, await f.api(), context));
  assert.equal(created.deadlineAt, deadlineAt);
  f.harness.resume(); await f.started.promise;
  assert.equal(await f.runtime.active(String(f.rootId), "run-one"), true);
  t.mock.timers.tick(1_101);
  await assert.rejects(f.runtime.childScope(await f.api(nativeId(created.conversationId)), context), StateError);
  f.pauseDelivery();
  const stopping = f.runtime.drive();
  await eventually(f.harness, () => f.runtime.read(String(created.agentId)), value => record(value).status === "idle");
  // Native idle is not report admission, so root finish remains gated even while app projection is in flight.
  assert.equal(await f.runtime.active(String(f.rootId), "run-one"), true);
  f.releaseDelivery(); await stopping; await f.runtime.drive();
  assert.equal(await f.runtime.active(String(f.rootId), "run-one"), false);
  assert.ok([...f.reports.values()].every(report => report.outcome === "expired"));
});

test("settled coding continuation receives a fresh approved-run conversation and rejects the old scope", async t => {
  const f = await fixture(t); f.autoDrive = false;
  const scope: SubagentScope = { kind: "coding", parentSessionId: String(f.rootId), taskId: "task-one", runId: "run-one", deadlineAt: new Date(Date.now() + 60_000).toISOString() };
  f.scope = scope;
  const created = decoded(await f.tool("spawn_subagent").execute({ name: "editor", goal: "inspect approved copy" }, await f.api(), context));
  await f.runtime.drive(); await eventually(f.harness, () => f.runtime.read(String(created.agentId)), value => record(value).status === "idle"); await f.runtime.drive();
  f.scope = { ...scope, runId: "run-two", deadlineAt: new Date(Date.now() + 120_000).toISOString() };
  const continued = decoded(await f.tool("message_subagent").execute({ agentId: String(created.agentId), expectedVersion: 1, message: "inspect new approved copy" }, await f.api(), context));
  assert.equal(continued.agentId, created.agentId); assert.notEqual(continued.conversationId, created.conversationId);
  await assert.rejects(f.runtime.childScope(await f.api(nativeId(created.conversationId)), context), StateError);
  assert.equal(await f.runtime.active(String(f.rootId), "run-one"), false);
  assert.equal(await f.runtime.active(String(f.rootId), "run-two"), true);
  const newChild = await f.harness.conversation(nativeId(continued.conversationId), context); assert.ok(newChild);
  assert.equal((await newChild.agent(context)).extensions.some(extension => extension.name === "umpi-subagent"), false);
  await f.runtime.drive(); await eventually(f.harness, () => f.runtime.read(String(created.agentId)), value => record(value).status === "idle"); await f.runtime.drive();
  assert.equal([...f.reports.values()].find(report => report.version === 2)?.scope.kind, "coding");
});

test("atomic admission caps active children, failed or oversized answers stay truthful, and projection recovers after reopen", async t => {
  const f = await fixture(t); f.autoDrive = false;
  const admissions = await Promise.all(Array.from({ length: 5 }, async (_, index) => f.tool("spawn_subagent").execute({ name: `reader-${index}`, goal: "oversized answer" }, await f.api(), context)));
  assert.equal(admissions.filter(value => !value.isError).length, 4); assert.equal(admissions.filter(value => value.isError).length, 1);
  f.rejectDelivery = true;
  f.harness.resume();
  await eventually(f.harness, () => f.runtime.status(), value => {
    const agents = record(value).agents; return Array.isArray(agents) && agents.every(agent => record(agent).status === "idle");
  });
  await assert.rejects(f.runtime.drive(), /Application admission interrupted/);
  await f.reopen(); f.rejectDelivery = false; await f.runtime.drive();
  assert.equal(f.reports.size, 4);
  assert.ok([...f.reports.values()].every(report => report.outcome === "failed" && report.text.includes("exceeded")));
  assert.ok([...f.reports.values()].every(report => JSON.stringify({ type: "subagent_result", report }).length < 16_384));
  const failure = decoded(await f.tool("spawn_subagent").execute({ name: "failure", goal: "model failure" }, await f.api(), context));
  await f.runtime.drive(); await eventually(f.harness, () => f.runtime.read(String(failure.agentId)), value => record(value).status === "idle"); await f.runtime.drive();
  assert.equal([...f.reports.values()].find(report => report.agentId === failure.agentId)?.outcome, "failed");
  await assert.rejects(f.runtime.cancel(String(failure.agentId), "1"), InputError);
});

test("coding lifecycle correction replays exactly once and settled follow-up retains its original active deadline", async t => {
  const f = await fixture(t); f.autoDrive = false;
  f.scope = { kind: "coding", parentSessionId: String(f.rootId), taskId: "task-one", runId: "run-one", deadlineAt: new Date(Date.now() + 600_000).toISOString() };
  const created = decoded(await f.tool("spawn_subagent").execute({ name: "editor", goal: "inspect approved copy" }, await f.api(), context));
  f.harness.resume();
  await eventually(f.harness, () => f.runtime.read(String(created.agentId)), value => record(value).status === "idle");
  assert.equal(await f.runtime.active(String(f.rootId), "run-one"), true);
  await f.runtime.correct(String(f.rootId), "run-one", "input-one", "Use the corrected task scope");
  await f.runtime.correct(String(f.rootId), "run-one", "input-one", "Use the corrected task scope");
  await assert.rejects(f.runtime.correct(String(f.rootId), "run-one", "input-one", "Different correction"), StateError);
  const corrected = record(await f.runtime.read(String(created.agentId)));
  assert.equal(corrected.agentId, created.agentId); assert.equal(corrected.version, 2); assert.equal(corrected.epoch, 2);
  assert.equal(corrected.deadlineAt, created.deadlineAt); assert.equal((await childTasks(f.harness)).items.length, 2);
  await eventually(f.harness, () => f.runtime.read(String(created.agentId)), value => record(value).status === "idle");
  await f.runtime.drive();
  assert.equal([...f.reports.values()].filter(report => report.outcome === "done").length, 1);
  assert.equal([...f.reports.values()].find(report => report.outcome === "done")?.version, 2);
  assert.equal(await f.runtime.active(String(f.rootId), "run-one"), false);
});

test("scope invalidation and coding lifecycle stop join real child work without starting another run", async t => {
  const f = await fixture(t); f.autoDrive = false; f.hold();
  f.scope = { kind: "coding", parentSessionId: String(f.rootId), taskId: "task-one", runId: "run-one", deadlineAt: new Date(Date.now() + 60_000).toISOString() };
  const created = decoded(await f.tool("spawn_subagent").execute({ name: "editor", goal: "inspect approved copy" }, await f.api(), context));
  f.harness.resume(); await f.started.promise;
  f.denyScope = true;
  await assert.rejects(f.runtime.childScope(await f.api(nativeId(created.conversationId)), context), StateError);
  await f.runtime.stop(String(f.rootId), "run-one");
  const stopped = record(await f.runtime.read(String(created.agentId)));
  assert.equal(stopped.status, "idle"); assert.equal(stopped.actualIdle, true);
  assert.equal(await f.runtime.active(String(f.rootId), "run-one"), true);
  await f.runtime.drive();
  assert.equal(await f.runtime.active(String(f.rootId), "run-one"), false);
  assert.equal((await childTasks(f.harness)).items.length, 1);
  assert.ok([...f.reports.values()].every(report => report.outcome === "cancelled"));
  assert.equal(await f.runtime.nextDue(), undefined);
});

test("recovery after application admission but before native acknowledgement reuses the exact report identity", async t => {
  const f = await fixture(t); f.autoDrive = false;
  const created = decoded(await f.tool("spawn_subagent").execute({ name: "reader", goal: "inspect context" }, await f.api(), context));
  f.harness.resume();
  await eventually(f.harness, () => f.runtime.read(String(created.agentId)), value => record(value).status === "idle");
  f.interruptAck = true;
  await assert.rejects(f.runtime.drive(), /acknowledgement was interrupted/);
  assert.equal(f.reports.size, 1);
  const admitted = [...f.reports.values()][0]!;
  await f.reopen(); await f.runtime.drive();
  assert.equal(f.reports.size, 1); assert.deepEqual([...f.reports.values()][0], admitted);
  assert.equal(record(await f.runtime.read(String(created.agentId))).pendingReports, 0);
  assert.equal((await childTasks(f.harness)).items.length, 1);
});

test("a native orphaned reporter is recovered as a truthful durable terminal report, not silently lost", async t => {
  const f = await fixture(t); f.autoDrive = false; f.hold();
  f.scope = { kind: "coding", parentSessionId: String(f.rootId), taskId: "task-one", runId: "run-one", deadlineAt: new Date(Date.now() + 60_000).toISOString() };
  const created = decoded(await f.tool("spawn_subagent").execute({ name: "editor", goal: "inspect approved copy" }, await f.api(), context));
  f.harness.resume(); await f.started.promise;
  const extension = f.runtime.extension();
  f.registry.install({ ...extension, tasks: extension.tasks?.filter(task => task.definition.name !== "umpi.subagent-reporter") });
  await f.reopen();
  await f.runtime.stop(String(f.rootId), "run-one");
  const task = (await childTasks(f.harness)).items[0]!;
  assert.equal(task.state.status, "terminal");
  if (task.state.status === "terminal") assert.equal(task.state.outcome.status, "orphaned");
  await f.runtime.drive();
  assert.equal(f.reports.size, 1); assert.equal([...f.reports.values()][0]?.outcome, "cancelled");
  assert.equal(record(await f.runtime.read(String(created.agentId))).pendingReports, 0);
});

test("Harness itself replays an interrupted native spawn tool without creating another child or submission", async t => {
  const f = await fixture(t); f.autoDrive = false; f.hold(); f.interruptSpawn = true;
  const root = await f.harness.conversation(f.rootId, context); assert.ok(root);
  const parentInput = await root.submit({ type: "input", content: "delegate", requestId: "native-spawn-replay" }, context);
  await f.spawnCommitted.promise; await f.started.promise;
  const before = record(await f.runtime.status()).agents;
  assert.ok(Array.isArray(before)); assert.equal(before.length, 1);
  const original = record(before[0]);
  f.interruptSpawn = false;
  await f.reopen();
  const resumed = await f.harness.submission(parentInput.id, context); assert.ok(resumed);
  assert.equal((await resumed.wait(context)).status, "done");
  const after = record(await f.runtime.status()).agents;
  assert.ok(Array.isArray(after)); assert.equal(after.length, 1);
  assert.equal(record(after[0]).agentId, original.agentId);
  assert.equal((await childTasks(f.harness)).items.length, 1);
  f.release();
  await eventually(f.harness, () => f.runtime.read(String(original.agentId)), value => record(value).status === "idle");
  await f.runtime.drive(); assert.equal(f.reports.size, 1);
  const child = await f.harness.conversation(nativeId(original.conversationId), context); assert.ok(child);
  assert.equal((await child.context(context)).messages.filter(message => message.role === "user" && JSON.stringify(message.content).includes("inspect context")).length, 1);
});
