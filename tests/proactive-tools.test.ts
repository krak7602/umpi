import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ToolExecutionApi, ToolExecutionResult } from "@earendil-works/pi-durable";
import { Store, type Database } from "../src/worker/store.js";
import { ProactiveStore, HEARTBEAT_MS } from "../src/worker/proactive-store.js";
import { proactiveTools } from "../src/worker/proactive-tools.js";

function creation(id = "commitment-one") {
  return { id, purpose: "Review the requested work", source: "The owner requested a follow-up", nextAction: "Inspect the recorded result",
    blocker: null, status: "active", nextReviewAt: null, jobId: null, allowNotify: false };
}
function update(id = "commitment-one") {
  const { allowNotify: _permission, ...fields } = creation(id);
  return { ...fields, expectedVersion: 1 };
}
function text(result: ToolExecutionResult): string {
  const item = result.content?.[0];
  assert.equal(item?.type, "text");
  return item && "text" in item ? item.text : "";
}
function decoded(result: ToolExecutionResult): Record<string, unknown> { return JSON.parse(text(result)) as Record<string, unknown>; }
function fixture(t: TestContext, wake?: () => Promise<void>) {
  const sqlite = new DatabaseSync(":memory:");
  let depth = 0;
  const db: Database = {
    all: <T extends object>(query: string, ...bindings: (string | number | null)[]) => sqlite.prepare(query).all(...bindings) as T[],
    transaction: <T>(run: () => T): T => {
      const savepoint = `proactive_tools_${depth++}`;
      sqlite.exec(`SAVEPOINT ${savepoint}`);
      try { const value = run(); sqlite.exec(`RELEASE ${savepoint}`); return value; }
      catch (error) { sqlite.exec(`ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`); throw error; }
      finally { depth--; }
    },
  };
  t.after(() => sqlite.close());
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const owner = new Store(db);
  owner.setSession("control", "foreground-control");
  owner.setSession("telegram", "foreground-telegram");
  owner.registerBackgroundSession("background-control", "control");
  const proactive = new ProactiveStore(owner, "UTC");
  const tools = proactiveTools(proactive, wake ?? (async () => {}));
  let task = 0;
  function execute(name: string, input: unknown, session = "foreground-control", taskId = ++task) {
    const tool = tools.find(value => value.name === name);
    assert.ok(tool, `Missing tool ${name}`);
    return tool.execute(input, { conversationId: session, taskId } as unknown as ToolExecutionApi, BACKGROUND_CONTEXT);
  }
  function beginReview() {
    proactive.configure({ expectedVersion: proactive.settings().version, enabled: true, quietHours: null }, now);
    proactive.createCommitment({ ...creation(), nextReviewAt: new Date(now + 1_000).toISOString() }, "control", "foreground-control", now);
    now += HEARTBEAT_MS + 1;
    proactive.drive(now, false, { control: "background-control" });
    assert.ok(proactive.assertRunCurrent("background-control", now));
  }
  function wakeup(id = "wake-one", commitmentId = "commitment-one") {
    return { id, commitmentId, purpose: creation().purpose, dueAt: new Date(now + 60_000).toISOString(),
      expiresAt: new Date(now + 3_600_000).toISOString(), repeatEveryMinutes: null };
  }
  return { owner, proactive, tools, execute, beginReview, wakeup };
}

test("proactive tools replay exact requests without accepting conflicting content or tools", async t => {
  const f = fixture(t);
  const first = await f.execute("create_commitment", creation(), "foreground-control", 10);
  assert.equal(first.isError, undefined);
  const result = decoded(first);
  assert.equal(result.scheduling, "paused");
  assert.equal((result.result as Record<string, unknown>).channel, "control");
  assert.equal((result.result as Record<string, unknown>).originSessionId, "foreground-control");
  assert.deepEqual(decoded(await f.execute("create_commitment", creation(), "foreground-control", 10)), result);
  assert.equal((await f.execute("create_commitment", { ...creation(), nextAction: "Different input" }, "foreground-control", 10)).isError, true);
  assert.equal((await f.execute("schedule_wakeup", f.wakeup(), "foreground-control", 10)).isError, true);
  assert.equal(f.proactive.commitments().length, 1);
  assert.equal(f.proactive.wakeups().length, 0);
});

test("foreground tools derive authority from the registered conversation, never supplied channel or origin", async t => {
  const f = fixture(t);
  assert.equal((await f.execute("create_commitment", { ...creation(), channel: "telegram", originSessionId: "foreground-telegram" })).isError, true);
  assert.equal(f.proactive.commitments().length, 0);
  assert.equal((await f.execute("create_commitment", creation(), "unregistered-session")).isError, true);
  f.proactive.createCommitment(creation(), "telegram", "foreground-telegram");
  assert.equal((await f.execute("update_commitment", update())).isError, true);
  assert.equal((await f.execute("schedule_wakeup", f.wakeup())).isError, true);
  assert.equal((await f.execute("update_commitment", { ...update(), channel: "telegram" })).isError, true);
  assert.equal(f.proactive.commitment("commitment-one")?.version, 1);
});

test("background tools cannot create obligations, target other commitments, or change purpose/source/notification authority", async t => {
  const f = fixture(t); f.beginReview();
  f.proactive.createCommitment(creation("commitment-two"), "control", "foreground-control");
  const otherWake = f.proactive.scheduleWakeup(f.wakeup("wake-two", "commitment-two"));
  const background = "background-control";
  for (const [name, input] of [
    ["create_commitment", creation("new-obligation")],
    ["update_commitment", update("commitment-two")],
    ["update_commitment", { ...update(), purpose: "A different duty" }],
    ["update_commitment", { ...update(), source: "A different source" }],
    ["update_commitment", { ...update(), retry: { everyMinutes: 15, maxAttempts: 10 } }],
    ["update_commitment", { ...update(), allowNotify: true }],
    ["update_commitment", { ...update(), channel: "telegram" }],
    ["schedule_wakeup", f.wakeup("foreign-wake", "commitment-two")],
    ["schedule_wakeup", { ...f.wakeup(), purpose: "Invented duty" }],
    ["update_wakeup", { id: otherWake.id, expectedVersion: otherWake.version, purpose: otherWake.purpose, dueAt: otherWake.dueAt, expiresAt: otherWake.expiresAt, repeatEveryMinutes: null }],
    ["cancel_wakeup", { id: otherWake.id, expectedVersion: otherWake.version }],
  ] as const) {
    assert.equal((await f.execute(name, input, background)).isError, true, name);
  }
  assert.equal(f.proactive.commitments().length, 2);
  assert.equal(f.proactive.commitment("commitment-one")?.allowNotify, false);
  assert.equal(f.proactive.commitment("commitment-one")?.version, 1);
  assert.equal(f.proactive.wakeup("wake-two")?.version, 1);
  assert.ok(f.proactive.assertRunCurrent(background));
  for (const name of ["list_commitments", "list_wakeups"]) assert.equal((await f.execute(name, {}, background)).isError, undefined);
});

test("background can schedule its own return and finish a silent review; receipt replays after run closes", async t => {
  const f = fixture(t); f.beginReview();
  const background = "background-control";
  const scheduled = await f.execute("schedule_wakeup", f.wakeup(), background, 100);
  assert.equal(scheduled.isError, undefined);
  assert.equal(f.proactive.wakeup("wake-one")?.status, "scheduled");
  const report = { outcome: "deferred", note: "The requested result is not available yet; one later review remains useful." };
  const finished = await f.execute("finish_proactive_review", report, background, 101);
  assert.equal(finished.isError, undefined);
  assert.equal((decoded(finished).result as Record<string, unknown>).status, "completed");
  assert.equal(f.owner.deliveries().length, 0);
  assert.deepEqual(decoded(await f.execute("finish_proactive_review", report, background, 101)), decoded(finished));
  assert.equal((await f.execute("finish_proactive_review", { ...report, note: "Different report" }, background, 101)).isError, true);
  assert.equal((await f.execute("schedule_wakeup", f.wakeup("wake-late"), background, 102)).isError, true);
  assert.equal((await f.execute("finish_proactive_review", report)).isError, true);
});

test("own wake edits preserve background purpose and require the current version", async t => {
  const f = fixture(t); f.beginReview();
  const background = "background-control";
  assert.equal((await f.execute("schedule_wakeup", f.wakeup(), background)).isError, undefined);
  const { commitmentId: _commitmentId, ...fields } = f.wakeup();
  assert.equal((await f.execute("update_wakeup", { ...fields, expectedVersion: 1, purpose: "A different duty" }, background)).isError, true);
  const edited = await f.execute("update_wakeup", { ...fields, expectedVersion: 1, repeatEveryMinutes: 30 }, background);
  assert.equal(edited.isError, undefined);
  assert.equal(f.proactive.wakeup("wake-one")?.repeatEveryMinutes, 30);
  assert.equal((await f.execute("cancel_wakeup", { id: "wake-one", expectedVersion: 1 }, background)).isError, true);
  const current = f.proactive.wakeup("wake-one")!;
  assert.equal((await f.execute("cancel_wakeup", { id: current.id, expectedVersion: current.version }, background)).isError, undefined);
  assert.equal(f.proactive.wakeup("wake-one")?.status, "cancelled");
});

test("background scope is rechecked after asynchronous wake intent and before the effect", async t => {
  let foregroundArrives = false;
  const f = fixture(t, async () => {
    if (foregroundArrives) f.owner.admit("incoming", "Owner needs attention", "control", "foreground-control");
  });
  f.beginReview();
  foregroundArrives = true;
  const denied = await f.execute("schedule_wakeup", f.wakeup(), "background-control");
  assert.equal(denied.isError, true);
  assert.equal(f.proactive.wakeups().length, 0);
});

test("foreground admission blocks new background effects while exact existing receipts remain replayable", async t => {
  const f = fixture(t); f.beginReview();
  const background = "background-control";
  const first = await f.execute("schedule_wakeup", f.wakeup(), background, 200);
  assert.equal(first.isError, undefined);
  const wake = f.proactive.wakeup("wake-one")!;
  f.owner.admit("owner-message", "Continue in this conversation", "control", "foreground-control");
  assert.equal((await f.execute("cancel_wakeup", { id: wake.id, expectedVersion: wake.version }, background)).isError, true);
  assert.equal(f.proactive.wakeup(wake.id)?.status, "scheduled");
  assert.deepEqual(decoded(await f.execute("schedule_wakeup", f.wakeup(), background, 200)), decoded(first));
  assert.equal((await f.execute("finish_proactive_review", { outcome: "no_action", note: "No material update." }, background)).isError, true);
});

test("replayed effects report currently paused scheduling rather than stale enabled settings", async t => {
  const f = fixture(t); f.beginReview();
  const first = await f.execute("schedule_wakeup", f.wakeup(), "background-control", 300);
  assert.equal(decoded(first).scheduling, "enabled");
  f.proactive.configure({ expectedVersion: f.proactive.settings().version, enabled: false, quietHours: null });
  const replay = await f.execute("schedule_wakeup", f.wakeup(), "background-control", 300);
  assert.equal(replay.isError, undefined);
  assert.equal(decoded(replay).scheduling, "paused");
  assert.deepEqual(decoded(replay).result, decoded(first).result);
  assert.equal((await f.execute("cancel_wakeup", { id: "wake-one", expectedVersion: 1 }, "background-control")).isError, true);
});

test("wake-intent failures produce a bounded safe error without a mutation or internal details", async t => {
  const f = fixture(t, async () => { throw new Error("private storage details must not escape"); });
  const failed = await f.execute("create_commitment", creation());
  assert.equal(failed.isError, true);
  assert.doesNotMatch(text(failed), /private storage details/);
  assert.equal(f.proactive.commitments().length, 0);
});
