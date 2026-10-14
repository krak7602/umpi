import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Store, StateError, type Database } from "../src/worker/store.js";
import { CompanionStore } from "../src/worker/companion-store.js";
import { ProactiveStore, HEARTBEAT_MS } from "../src/worker/proactive-store.js";
import { assistantTools } from "../src/worker/tools.js";
import { guardBackgroundTools } from "../src/worker/proactive-runtime.js";
import { enqueueScheduleControls, handleScheduleCallback } from "../src/worker/proactive-telegram.js";
import { authorize } from "../src/worker/transport.js";

function fixture(t: TestContext) {
  const sqlite = new DatabaseSync(":memory:");
  let depth = 0;
  const db: Database = {
    all: <T extends object>(query: string, ...bindings: (string | number | null)[]) => sqlite.prepare(query).all(...bindings) as T[],
    transaction: <T>(run: () => T): T => {
      const name = `interface_${depth++}`;
      sqlite.exec(`SAVEPOINT ${name}`);
      try { const result = run(); sqlite.exec(`RELEASE ${name}`); return result; }
      catch (error) { sqlite.exec(`ROLLBACK TO ${name}; RELEASE ${name}`); throw error; }
      finally { depth--; }
    },
  };
  t.after(() => sqlite.close());
  const store = new Store(db);
  store.setSession("control", "1"); store.setSession("telegram", "2");
  store.registerBackgroundSession("3", "control");
  const proactive = new ProactiveStore(store, "UTC");
  return { store, proactive };
}

function begin(t: TestContext, allowNotify: boolean) {
  const f = fixture(t);
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  f.proactive.configure({ expectedVersion: f.proactive.settings().version, enabled: true, quietHours: null });
  f.proactive.createCommitment({ id: "review", purpose: "Check the requested result", source: "Owner requested a result check", nextAction: "Inspect the result", status: "active", blocker: null, nextReviewAt: new Date(now + 1_000).toISOString(), jobId: null, allowNotify }, "control", "1");
  now += HEARTBEAT_MS;
  f.proactive.drive(now, false, { control: "3" });
  return f;
}

const api = { conversationId: "3", taskId: "test-task" } as unknown as ToolExecutionApi;
const command = { jobId: "review-command", command: "printf result", cwd: "/workspace", timeoutMs: 10_000 };

test("background turns neither consume foreground choices nor leak final text or failure to notifications", t => {
  const { store } = fixture(t);
  store.createChoice("question", "Which result?", ["First", "Second"], "control", "1");
  const first = store.admitBackground("review-operation", "Inspect result", "control", "3", "review-run");
  assert.equal(store.pendingChoice("1")?.status, "pending");
  assert.deepEqual(store.admitBackground("review-operation", "Inspect result", "control", "3", "review-run"), first);
  assert.throws(() => store.admitBackground("review-operation", "Different work", "control", "3", "review-run"), StateError);
  store.settle(first.id, "This text is not an authorized notification");
  store.admitBackground("failed-review", "Inspect result", "control", "3", "failed-run");
  store.settle("failed-review", "Private model failure", true);
  assert.equal(store.deliveries(`answer:${first.id}`).length, 0);
  assert.equal(store.deliveries("answer:failed-review").length, 0);
  assert.throws(() => store.admitBackground("wrong-channel", "Inspect", "telegram", "3", "bad-run"), StateError);
});

test("quiet background operation churn does not bump companion revision or displace owner activity", t => {
  const { store } = fixture(t);
  const companion = new CompanionStore(store);
  store.admit("owner-message", "Track this work", "control", "1");
  store.settle("message:control:owner-message", "Recorded");
  const before = companion.snapshot();
  for (let i = 0; i < 55; i++) {
    store.admitBackground(`review-${i}`, "Inspect", "control", "3", `run-${i}`);
    store.settle(`review-${i}`, "No material change");
  }
  const after = companion.snapshot();
  assert.equal(after.revision, before.revision);
  assert.deepEqual(after.operations, before.operations);
});

test("background cannot request an interrupting approval without notification permission", async t => {
  const { store, proactive } = begin(t, false);
  const tools = guardBackgroundTools(assistantTools(store, "UTC", async () => {}), proactive);
  const result = await tools.find(tool => tool.name === "request_mac_command")!.execute(command, api, BACKGROUND_CONTEXT);
  assert.equal(result.isError, true);
  assert.equal(store.job(command.jobId), undefined);
  assert.equal(store.deliveries().length, 0);
});

test("foreground arriving during async tool wake prevents background command creation transactionally", async t => {
  const { store, proactive } = begin(t, true);
  const tools = guardBackgroundTools(assistantTools(store, "UTC", async () => { store.admit("urgent", "Help with this now", "control", "1"); }), proactive);
  const result = await tools.find(tool => tool.name === "request_mac_command")!.execute(command, api, BACKGROUND_CONTEXT);
  assert.equal(result.isError, true);
  assert.equal(store.job(command.jobId), undefined);
  assert.equal(store.deliveries().length, 0);
});

test("untranscribed owner input arriving during tool wake blocks background execution before Core admission", async t => {
  const { store, proactive } = begin(t, true);
  let preprocessing = false;
  store.pendingForegroundInput = () => preprocessing;
  const tools = guardBackgroundTools(assistantTools(store, "UTC", async () => { preprocessing = true; }), proactive);
  const result = await tools.find(tool => tool.name === "request_mac_command")!.execute(command, api, BACKGROUND_CONTEXT);
  assert.equal(result.isError, true);
  assert.equal(store.pendingOperations().filter(op => !op.background).length, 0);
  assert.equal(store.job(command.jobId), undefined);
  assert.equal(store.deliveries().length, 0);
});

test("permitted background command still requires explicit owner approval and has one completion owner", async t => {
  const { store, proactive } = begin(t, true);
  const tools = guardBackgroundTools(assistantTools(store, "UTC", async () => {}), proactive);
  const result = await tools.find(tool => tool.name === "request_mac_command")!.execute(command, api, BACKGROUND_CONTEXT);
  assert.equal(result.isError, undefined);
  assert.equal(store.job(command.jobId)?.status, "pending_approval");
  assert.equal(store.poll({ executorId: "executor", workspaces: ["/workspace"] }).job, null);
  assert.equal(proactive.commitment("review")?.jobId, command.jobId);
  store.cancelJob(command.jobId, 1);
  assert.equal(store.operation(`job:${command.jobId}:completion`), undefined);
});

test("held notification groups do not block unrelated deliveries; discarded chunks cannot restart", t => {
  const { store } = fixture(t);
  for (let i = 0; i < 12; i++) {
    store.enqueue(`proactive:${i}`, "telegram", "Deferred update");
    store.holdDeliveryGroup(`proactive:${i}`, true);
  }
  store.enqueue("owner-answer", "telegram", "Requested answer");
  assert.equal(store.readyDeliveries()[0]?.groupId, "owner-answer");
  store.enqueue("proactive:long", "telegram", "a".repeat(8_000));
  store.discardDeliveryGroup("proactive:long", "Cancelled responsibility");
  store.holdDeliveryGroup("proactive:long", false);
  assert.ok(store.deliveries("proactive:long").every(delivery => delivery.status === "cancelled"));
  assert.equal(store.beginDelivery("proactive:long:0"), undefined);
  store.holdDeliveryGroup("proactive:0", false);
  assert.equal(store.readyDeliveries()[0]?.groupId, "proactive:0");
});

test("scheduler controls require confirmed exact-message binding and reject stale settings without changing them", t => {
  const { store, proactive } = fixture(t);
  enqueueScheduleControls(proactive, "first");
  const card = store.deliveries("schedule-menu:first")[0]!;
  const token = card.replyMarkup!.inline_keyboard[0]![0]!.callback_data;
  assert.throws(() => handleScheduleCallback(proactive, token, 17), StateError);
  store.beginDelivery(card.id); store.finishDelivery(card.id, "sent", undefined, 17);
  assert.throws(() => handleScheduleCallback(proactive, token, 18), StateError);
  const result = handleScheduleCallback(proactive, token, 17);
  assert.equal(proactive.settings().enabled, true);
  assert.deepEqual(handleScheduleCallback(proactive, token, 17), result);
  enqueueScheduleControls(proactive, "second");
  const stale = store.deliveries("schedule-menu:second")[0]!;
  store.beginDelivery(stale.id); store.finishDelivery(stale.id, "sent", undefined, 19);
  proactive.configure({ expectedVersion: proactive.settings().version, enabled: true, quietHours: { start: "22:00", end: "06:00" } });
  assert.throws(() => handleScheduleCallback(proactive, stale.replyMarkup!.inline_keyboard[0]![0]!.callback_data, 19), StateError);
  assert.equal(proactive.settings().enabled, true);
  assert.deepEqual(proactive.settings().quietHours, { start: "22:00", end: "06:00" });
});

test("schedule administration is owner-only and unknown methods or route suffixes stay closed", async () => {
  const config = { UMPI_CONTROL_TOKEN: "c".repeat(40), UMPI_EXECUTOR_TOKEN: "e".repeat(40) };
  for (const [path, method] of [["/api/schedule", "GET"], ["/api/schedule/settings", "PUT"], ["/api/schedule/commitments", "POST"], ["/api/schedule/wakeups/one/cancel", "POST"]]) {
    await authorize(new Request(`https://example.com${path}`, { method, headers: { authorization: `Bearer ${config.UMPI_CONTROL_TOKEN}` } }), config);
    for (const token of [config.UMPI_EXECUTOR_TOKEN, "device-token", ""]) await assert.rejects(authorize(new Request(`https://example.com${path}`, { method, headers: { authorization: `Bearer ${token}` } }), config), error => error instanceof StateError && error.status === 401);
  }
  for (const path of ["/api/schedule/settings/arbitrary", "/api/schedule/wakeups/one/approve"]) await assert.rejects(authorize(new Request(`https://example.com${path}`, { headers: { authorization: `Bearer ${config.UMPI_CONTROL_TOKEN}` } }), config), error => error instanceof StateError && error.status === 404);
  await assert.rejects(authorize(new Request("https://example.com/api/schedule", { method: "DELETE", headers: { authorization: `Bearer ${config.UMPI_CONTROL_TOKEN}` } }), config), error => error instanceof StateError && error.status === 404);
});
