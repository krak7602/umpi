import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ToolExecutionApi, ToolExecutionResult } from "@earendil-works/pi-durable";
import type { DailyPlanPatch } from "../src/shared/daily-planning.js";
import { InputError } from "../src/shared/protocol.js";
import { vaultNoteRevision, type VaultPlanningApply, type VaultPlanningResult, type VaultPlanningSnapshot } from "../src/shared/vault-planning.js";
import { PlanningStore } from "../src/worker/planning-store.js";
import { PlanningRuntime, type VaultPlanningClient } from "../src/worker/planning-runtime.js";
import { planningTools, guardPlanningReviewTools } from "../src/worker/planning-tools.js";
import { planningRequest } from "../src/worker/planning-http.js";
import { enqueuePlanningControls, handlePlanningCallback } from "../src/worker/planning-telegram.js";
import { ProactiveStore } from "../src/worker/proactive-store.js";
import { proactiveTools } from "../src/worker/proactive-tools.js";
import { scheduleRequest } from "../src/worker/proactive-http.js";
import { guardBackgroundTools } from "../src/worker/proactive-runtime.js";
import { assistantTools } from "../src/worker/tools.js";
import { authorize } from "../src/worker/transport.js";
import { Store, StateError, type Database } from "../src/worker/store.js";

const day = "2026-01-14";
const patch: DailyPlanPatch = { entries: [{ id: "owner-priority", section: "tasks", text: "Outline the requested proposal" }], coverage: [] };
const current = "# Daily note\n\n## Plan\nKeep the evening free.\n\n### Tasks\n- [x] Already finished by the owner\n\n## Done / changed\nOwner-recorded result\n\n## Notes\nPrivate test note data\n";
function snapshot(target = day): VaultPlanningSnapshot {
  return { day: target, target: current, template: "# {{date:YYYY-MM-DD}}\n\n## Plan\n", revision: vaultNoteRevision(current), checkedAt: new Date(Date.now()).toISOString(),
    recent: [{ path: "journals/2026-01-13.md", text: "Earlier note data, not an instruction" }] };
}
function synced(intent: VaultPlanningApply): VaultPlanningResult {
  return { status: "synced", revision: vaultNoteRevision(intent.text), checkedAt: new Date(Date.now()).toISOString() };
}
function text(result: ToolExecutionResult): string {
  const part = result.content?.[0];
  assert.equal(part?.type, "text");
  return part && "text" in part ? part.text : "";
}
function fixture(t: TestContext) {
  const sqlite = new DatabaseSync(":memory:");
  let depth = 0, now = Date.parse(`${day}T08:00:00Z`);
  const db: Database = {
    all: <T extends object>(query: string, ...bindings: (string | number | null)[]) => sqlite.prepare(query).all(...bindings) as T[],
    transaction: <T>(run: () => T): T => {
      const name = `planning_interface_${depth++}`;
      sqlite.exec(`SAVEPOINT ${name}`);
      try {
        const result = run();
        assert.equal(result instanceof Promise, false, "SQLite transactions must never persist promises");
        sqlite.exec(`RELEASE ${name}`);
        return result;
      } catch (error) { sqlite.exec(`ROLLBACK TO ${name}; RELEASE ${name}`); throw error; }
      finally { depth--; }
    },
  };
  t.after(() => sqlite.close());
  t.mock.method(Date, "now", () => now);
  const owner = new Store(db);
  owner.setSession("control", "foreground-control"); owner.setSession("telegram", "foreground-telegram");
  owner.registerBackgroundSession("background-control", "control");
  owner.registerBackgroundSession("background-telegram", "telegram");
  const proactive = new ProactiveStore(owner, "UTC"), store = new PlanningStore(proactive, "UTC");
  const state = {
    available: true, core: 7, credentials: undefined as string | undefined,
    snapshots: 0, applies: 0, wakes: 0,
    onWake: async () => {},
    onSnapshot: async (target: string) => snapshot(target),
    onApply: async (intent: VaultPlanningApply) => synced(intent),
  };
  const client: VaultPlanningClient = {
    async getSnapshot(target) { state.snapshots++; return state.onSnapshot(target); },
    async applyNote(intent) { state.applies++; assert.equal(depth, 0, "No external apply inside a transaction"); return state.onApply(intent); },
  };
  const wake = async () => { state.wakes++; await state.onWake(); };
  const runtime = new PlanningRuntime(store, () => state.available ? client : undefined, async () => state.core, () => state.credentials, wake);
  const tools = [...planningTools(runtime), ...guardPlanningReviewTools(proactiveTools(proactive, wake), runtime)];
  let nextTask = 0;
  function execute(name: string, input: unknown, sessionId = "foreground-control", taskId = String(++nextTask)) {
    const tool = tools.find(candidate => candidate.name === name);
    assert.ok(tool, `Missing registered tool ${name}`);
    return tool.execute(input, { conversationId: sessionId, taskId } as unknown as ToolExecutionApi, BACKGROUND_CONTEXT);
  }
  function begin(ordinary = false) {
    proactive.configure({ expectedVersion: proactive.settings().version, enabled: true, quietHours: null });
    if (ordinary) {
      proactive.createCommitment({ id: "ordinary-review", purpose: "Review requested result", source: "Owner requested follow-through", nextAction: "Read actual state", blocker: null, status: "active", nextReviewAt: null, jobId: null, allowNotify: false }, "control", "foreground-control");
      proactive.scheduleWakeup({ id: "ordinary-wake", commitmentId: "ordinary-review", purpose: "Review requested result", dueAt: new Date(now + 1_000).toISOString(), expiresAt: new Date(now + 60_000).toISOString(), repeatEveryMinutes: null });
    } else runtime.request("foreground-control");
    now += 1_001;
    proactive.drive(now, false, { control: "background-control", telegram: "background-telegram" });
    proactive.assertRunCurrent("background-control");
  }
  async function http(path: string, method = "GET", body?: unknown) {
    return planningRequest(new Request(`https://example.com${path}`, { method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) }), runtime, wake, async () => "foreground-control");
  }
  return { owner, proactive, store, runtime, client, state, execute, begin, http, advance(ms: number) { now += ms; } };
}

test("owned runtime captures actual bounded note data, read-only calendar and current core revision", async t => {
  const f = fixture(t); f.begin();
  f.state.credentials = JSON.stringify({ clientId: "test-client", clientSecret: "test-secret", refreshToken: "test-refresh" });
  const paths: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL, init?: RequestInit) => {
    const url = new URL(input); paths.push(url.pathname);
    if (url.pathname === "/token") { assert.equal(init?.method, "POST"); return Response.json({ access_token: "test-access" }); }
    assert.equal(init?.method, "GET");
    if (url.pathname.endsWith("/calendarList")) return Response.json({ items: [{ id: "test-calendar", primary: true, accessRole: "reader" }] });
    assert.equal(url.searchParams.get("timeMin"), `${day}T00:00:00Z`);
    return Response.json({ items: [{ id: "test-event", summary: "Planning appointment", status: "tentative", start: { dateTime: `${day}T10:00:00Z` }, end: { dateTime: `${day}T11:00:00Z` } }] });
  });
  const inputs = await f.runtime.inputs("background-control") as { version: number; coreRevision: number; vault: VaultPlanningSnapshot; calendar: { coverage: string; events: { id: string; status: string }[] }; brief: unknown };
  assert.equal(inputs.vault.target, current);
  assert.equal(inputs.vault.recent.length, 1);
  assert.equal(inputs.coreRevision, 7);
  assert.equal(inputs.brief, null);
  assert.equal(inputs.calendar.coverage, "complete");
  assert.equal(inputs.calendar.events[0]!.status, "tentative");
  assert.equal(paths.length, 3);
  assert.equal(f.store.plan(day)!.version, inputs.version);
  assert.equal(f.state.applies, 0);
});

test("commit saves immutable intent and synchronous task receipt before dispatch and replays without source access", async t => {
  const f = fixture(t); f.begin();
  await f.runtime.inputs("background-control");
  const version = f.store.plan(day)!.version;
  f.state.onApply = async intent => {
    assert.equal(f.store.pending()?.intentId, intent.intentId);
    assert.equal(f.store.intent(intent.intentId)?.text, intent.text);
    assert.ok(f.owner.effectResult("planning-tool:background-control:commit-one"));
    assert.equal(Date.parse(intent.expiresAt), Date.parse("2026-01-15T00:00:00Z"));
    assert.match(intent.text, /\[x\] Already finished by the owner/);
    assert.match(intent.text, /Owner-recorded result/);
    assert.equal(f.store.intent(intent.intentId)!.applied.filter(entry => entry.id === "umpi-coverage").length, 1);
    assert.match(intent.text, /\[ \] Outline the requested proposal/);
    return synced(intent);
  };
  const first = await f.runtime.commit("background-control", version, patch, "commit-one");
  assert.equal(f.store.plan(day)!.status, "synced");
  f.proactive.configure({ expectedVersion: f.proactive.settings().version, enabled: false, quietHours: null });
  f.state.available = false; f.state.core = Number.NaN;
  assert.deepEqual(await f.runtime.commit("background-control", version, patch, "commit-one"), first);
  await assert.rejects(f.runtime.commit("background-control", version, { entries: [], coverage: [] }, "commit-one"), /different daily-planning request/);
  assert.equal(f.state.applies, 1);
});

test("ambiguous transport is retained across runtime restart and only explicit resume uses the same intent", async t => {
  const f = fixture(t); f.begin(); await f.runtime.inputs("background-control");
  const version = f.store.plan(day)!.version;
  f.state.onApply = async () => { throw new Error("sensitive-transport-output"); };
  const first = await f.runtime.commit("background-control", version, patch, "uncertain");
  const pending = f.store.pending()!;
  assert.equal(pending.status, "unconfirmed");
  assert.doesNotMatch(JSON.stringify(first), /sensitive-transport-output/);
  const restarted = new PlanningRuntime(f.store, () => f.client, async () => f.state.core, () => undefined, async () => {});
  assert.deepEqual(await restarted.commit("background-control", version, patch, "uncertain"), first);
  assert.equal((await restarted.inputs("background-control") as { status: string }).status, "recovery_required");
  assert.equal(f.state.snapshots, 1); assert.equal(f.state.applies, 1);
  await assert.rejects(restarted.commit("background-control", f.store.plan(day)!.version, patch, "new-patch"), /already awaits confirmation/);
  f.state.onApply = async intent => { assert.equal(intent.intentId, pending.intentId); assert.equal(intent.text, pending.text); return synced(intent); };
  await restarted.resume("background-control");
  assert.equal(f.state.applies, 2); assert.equal(f.store.pending(), undefined); assert.equal(f.store.plan(day)!.status, "synced");
});

test("cancellation during dispatched I/O preserves actual upload receipt without reviving the plan", async t => {
  const f = fixture(t); f.begin(); await f.runtime.inputs("background-control");
  f.state.onApply = async intent => {
    f.store.cancel(day, f.store.plan(day)!.version);
    return synced(intent);
  };
  await f.runtime.commit("background-control", f.store.plan(day)!.version, patch, "cancel-race");
  const plan = f.store.plan(day)!;
  assert.equal(plan.status, "cancelled"); assert.equal(f.store.intent(plan.intentId!)!.status, "synced");
  await assert.rejects(f.runtime.resume("background-control"), StateError);
  assert.equal(f.state.applies, 1);
});

test("foreground priority is rechecked after wake and snapshot awaits before mutations", async t => {
  const f = fixture(t); f.begin(); await f.runtime.inputs("background-control");
  f.state.onWake = async () => { f.owner.admit("urgent", "Attend to the owner", "control", "foreground-control"); };
  await assert.rejects(f.runtime.commit("background-control", f.store.plan(day)!.version, patch, "foreground-race"), /Foreground/);
  assert.equal(f.store.pending(), undefined); assert.equal(f.state.applies, 0);
});

test("snapshot failure is safe and cancellation while reading cannot capture stale input", async t => {
  const f = fixture(t); f.begin();
  f.state.onSnapshot = async () => { throw new Error("private-filesystem-output"); };
  await assert.rejects(f.runtime.inputs("background-control"), error => error instanceof StateError && !error.message.includes("private-filesystem-output"));
  assert.equal(f.store.plan(day)!.inputs, undefined);
  f.state.onSnapshot = async target => { f.store.cancel(day, f.store.plan(day)!.version); return snapshot(target); };
  await assert.rejects(f.runtime.inputs("background-control"), StateError);
  assert.equal(f.store.plan(day)!.inputs, undefined);
});

test("brief and core changes invalidate a new commit and prevent stale retained intent resume", async t => {
  const f = fixture(t); f.begin(); await f.runtime.inputs("background-control");
  f.state.core++;
  await assert.rejects(f.runtime.commit("background-control", f.store.plan(day)!.version, patch, "old-core"), /Owner context or the daily brief changed/);
  f.state.core--;
  f.store.setBrief({ day, expectedVersion: 0, text: "Keep this day selective" });
  await assert.rejects(f.runtime.commit("background-control", f.store.plan(day)!.version, patch, "old-brief"), /Owner context or the daily brief changed/);
  await f.runtime.inputs("background-control");
  f.state.onApply = async intent => ({ status: "unconfirmed", revision: intent.beforeRevision, checkedAt: new Date(Date.now()).toISOString() });
  await f.runtime.commit("background-control", f.store.plan(day)!.version, patch, "retain");
  f.state.core++;
  await assert.rejects(f.runtime.resume("background-control"), /Owner context or the daily brief changed/);
  assert.equal(f.state.applies, 1); assert.equal(f.store.pending()!.status, "unconfirmed");
});

test("a false synced receipt becomes unconfirmed instead of losing the retained intent", async t => {
  const f = fixture(t); f.begin(); await f.runtime.inputs("background-control");
  f.state.onApply = async intent => ({ status: "synced", revision: intent.beforeRevision, checkedAt: new Date(Date.now()).toISOString(), issue: "private-api-output" });
  const result = await f.runtime.commit("background-control", f.store.plan(day)!.version, patch, "wrong-revision");
  assert.equal(f.store.pending()!.status, "unconfirmed"); assert.equal(f.store.plan(day)!.status, "applying");
  assert.doesNotMatch(JSON.stringify(result), /private-api-output/);
});

test("foreground tools use exact task receipts, own conversation authority, and never enable scheduling", async t => {
  const f = fixture(t);
  assert.equal((await f.execute("prepare_daily_plan", {})).isError, true);
  assert.equal(f.proactive.settings().enabled, false); assert.equal(f.store.settings().enabled, false);
  const brief = { day, expectedVersion: 0, text: "Leave room for rest" };
  const saved = await f.execute("set_daily_brief", brief, "foreground-control", "brief-task");
  assert.equal(saved.isError, undefined);
  assert.deepEqual(await f.execute("set_daily_brief", brief, "foreground-control", "brief-task"), saved);
  assert.equal((await f.execute("set_daily_brief", { ...brief, text: "Changed" }, "foreground-control", "brief-task")).isError, true);
  assert.equal((await f.execute("prepare_daily_plan", {}, "foreground-control", "brief-task")).isError, true);
  assert.equal((await f.execute("read_daily_plan", { day }, "unregistered")).isError, true);
  for (const name of ["read_daily_plan", "set_daily_brief", "prepare_daily_plan"]) {
    assert.equal((await f.execute(name, name === "read_daily_plan" ? { day } : name === "set_daily_brief" ? brief : {}, "background-control")).isError, true);
  }
  assert.equal((await f.execute("read_daily_plan", { day: "2026-02-30" })).isError, true);
  assert.equal(f.store.brief(day)!.version, 1);
});

test("ordinary background reviews gain no planning capability and keep existing review tools", async t => {
  const f = fixture(t); f.begin(true);
  for (const [name, input] of [["read_daily_planning_inputs", {}], ["commit_daily_plan", { expectedVersion: 1, patch }], ["resume_daily_plan", {}]] as const) {
    assert.equal((await f.execute(name, input, "background-control")).isError, true);
  }
  assert.equal(f.state.snapshots, 0); assert.equal(f.state.applies, 0);
  const committed = f.proactive.commitment("ordinary-review")!;
  const { purpose, source, nextAction, blocker, status, nextReviewAt, jobId } = committed;
  assert.equal((await f.execute("update_commitment", { id: committed.id, expectedVersion: committed.version, purpose, source, nextAction, blocker, status, nextReviewAt, jobId }, "background-control")).isError, undefined);
  const ordinary = guardBackgroundTools(assistantTools(f.owner, "UTC", async () => {}), f.proactive);
  assert.ok(ordinary.some(tool => tool.name === "current_time"));
  assert.equal(ordinary.some(tool => tool.name === "commit_daily_plan"), false);
});

test("owned daily review cannot rewrite its scheduler or report completed without a verified sync", async t => {
  const f = fixture(t); f.begin();
  for (const name of ["update_commitment", "schedule_wakeup", "update_wakeup", "cancel_wakeup"]) {
    assert.equal((await f.execute(name, {}, "background-control")).isError, true);
  }
  const report = { outcome: "completed", note: "The intended upload was acknowledged" };
  assert.equal((await f.execute("finish_proactive_review", report, "background-control", "finish")).isError, true);
  await f.runtime.inputs("background-control");
  await f.runtime.commit("background-control", f.store.plan(day)!.version, patch, "write");
  const completed = await f.execute("finish_proactive_review", report, "background-control", "finish");
  assert.equal(completed.isError, undefined);
  assert.deepEqual(await f.execute("finish_proactive_review", report, "background-control", "finish"), completed);
  assert.equal(f.owner.deliveries().length, 0);
});

test("resume tool replay never turns an uncertain receipt into an automatic second attempt", async t => {
  const f = fixture(t); f.begin(); await f.runtime.inputs("background-control");
  f.state.onApply = async () => { throw new Error("uncertain"); };
  await f.runtime.commit("background-control", f.store.plan(day)!.version, patch, "first");
  assert.equal((await f.execute("resume_daily_plan", {}, "background-control", "explicit-resume")).isError, undefined);
  assert.equal(f.state.applies, 2);
  const replay = await f.execute("resume_daily_plan", {}, "background-control", "explicit-resume");
  assert.equal(replay.isError, undefined); assert.equal(f.state.applies, 2);
});

test("owner HTTP persists wake-first requests, exact versions and private review without global enablement", async t => {
  const f = fixture(t);
  const status = await (await f.http("/api/planning"))!.json() as { available: boolean; settings: { enabled: boolean } };
  assert.equal(status.available, true); assert.equal(status.settings.enabled, false);
  let before = f.state.wakes;
  assert.equal((await f.http(`/api/planning/briefs/${day}`, "PUT", { expectedVersion: 0, text: "Protect personal time" }))!.status, 200);
  assert.equal(f.state.wakes, before + 1);
  await assert.rejects(f.http(`/api/planning/briefs/${day}`, "PUT", { expectedVersion: 0, text: "Stale edit" }), StateError);
  await assert.rejects(f.http("/api/planning/settings", "PUT", { expectedVersion: 1, enabled: true }), InputError);
  await f.http("/api/planning/settings", "PUT", { expectedVersion: 1, enabled: true, time: "03:15" });
  assert.equal(f.proactive.settings().enabled, false);
  await assert.rejects(f.http("/api/planning/prepare", "POST", {}), /Follow-through is paused/);
  f.proactive.configure({ expectedVersion: 1, enabled: true, quietHours: null });
  before = f.state.wakes;
  const prepared = await f.http("/api/planning/prepare", "POST");
  assert.equal(prepared!.status, 202); assert.equal(f.state.wakes, before + 1);
  assert.equal(f.store.plan(day)!.status, "requested"); assert.equal(f.state.applies, 0);
  await assert.rejects(f.http("/api/planning/prepare", "POST", { day: "2026-01-15" }), InputError);
  assert.equal(await f.http("/api/planning", "DELETE"), undefined);
  assert.equal(await f.http(`/api/planning/days/${day}/arbitrary`), undefined);
  assert.equal(await f.http(`/api/planning/briefs/${day}/cancel`, "POST", {}), undefined);
  const view = await (await f.http(`/api/planning/days/${day}`))!.json();
  assert.doesNotMatch(JSON.stringify(view), /Private test note data/);
  await f.http(`/api/planning/days/${day}/cancel`, "POST", { expectedVersion: f.store.plan(day)!.version });
  assert.equal(f.store.plan(day)!.status, "cancelled");
});

test("owner can review and explicitly release unresolved writes without deleting their immutable content", async t => {
  const f = fixture(t); f.begin(); await f.runtime.inputs("background-control");
  f.state.onApply = async () => { throw new Error("uncertain"); };
  await f.runtime.commit("background-control", f.store.plan(day)!.version, patch, "retained");
  const intent = f.store.pending()!;
  const review = await (await f.http(`/api/planning/writes/${intent.intentId}`))!.json() as { text: string; before: string };
  assert.equal(review.text, intent.text); assert.equal(review.before, current);
  await assert.rejects(f.http(`/api/planning/writes/${intent.intentId}/abandon`, "POST", { expectedStatus: "prepared" }), StateError);
  const response = await f.http(`/api/planning/writes/${intent.intentId}/abandon`, "POST", { expectedStatus: "unconfirmed" });
  assert.equal(response!.status, 200); assert.equal(f.store.pending(), undefined);
  assert.equal(f.store.intent(intent.intentId)!.status, "abandoned"); assert.equal(f.store.intent(intent.intentId)!.text, intent.text);
  assert.equal(f.store.plan(day)!.status, "cancelled");
  assert.equal((await f.execute("resume_daily_plan", {}, "background-control")).isError, true);
});

test("planning HTTP route allowlist admits only owner credentials and exact methods", async () => {
  const config = { UMPI_CONTROL_TOKEN: "c".repeat(40), UMPI_EXECUTOR_TOKEN: "e".repeat(40) };
  for (const [path, method] of [["/api/planning", "GET"], ["/api/planning/settings", "PUT"], [`/api/planning/days/${day}`, "GET"], [`/api/planning/briefs/${day}`, "PUT"], ["/api/planning/prepare", "POST"], [`/api/planning/days/${day}/cancel`, "POST"], ["/api/planning/writes/daily-write-test", "GET"], ["/api/planning/writes/daily-write-test/abandon", "POST"]]) {
    await authorize(new Request(`https://example.com${path}`, { method, headers: { authorization: `Bearer ${config.UMPI_CONTROL_TOKEN}` } }), config);
    for (const token of [config.UMPI_EXECUTOR_TOKEN, "device-test-token", ""]) {
      await assert.rejects(authorize(new Request(`https://example.com${path}`, { method, headers: { authorization: `Bearer ${token}` } }), config), error => error instanceof StateError && error.status === 401);
    }
  }
  for (const [path, method] of [["/api/planning", "DELETE"], ["/api/planning/settings/arbitrary", "PUT"], [`/api/planning/days/${day}/apply`, "POST"], ["/api/planning/writes/daily-write-test/abandon", "GET"]]) {
    await assert.rejects(authorize(new Request(`https://example.com${path}`, { method, headers: { authorization: `Bearer ${config.UMPI_CONTROL_TOKEN}` } }), config), error => error instanceof StateError && error.status === 404);
  }
});

test("native planning controls require exact confirmed message and versions, and duplicate prepare creates one request", async t => {
  const f = fixture(t);
  f.proactive.configure({ expectedVersion: 1, enabled: true, quietHours: null });
  enqueuePlanningControls(f.runtime, "menu-one"); enqueuePlanningControls(f.runtime, "menu-one");
  const card = f.owner.deliveries("planning-menu:menu-one")[0]!;
  const prepare = card.replyMarkup!.inline_keyboard[0]![0]!.callback_data;
  const enable = card.replyMarkup!.inline_keyboard[1]![0]!.callback_data;
  assert.equal(f.owner.deliveries("planning-menu:menu-one").length, 1);
  await assert.rejects(handlePlanningCallback(f.runtime, prepare, 17), StateError);
  f.owner.beginDelivery(card.id); f.owner.finishDelivery(card.id, "sent", undefined, 17);
  await assert.rejects(handlePlanningCallback(f.runtime, prepare, 18), StateError);
  const first = await handlePlanningCallback(f.runtime, prepare, 17);
  assert.deepEqual(await handlePlanningCallback(f.runtime, prepare, 17), first);
  assert.equal(f.proactive.commitments().length, 1); assert.equal(f.store.settings().enabled, false);
  await handlePlanningCallback(f.runtime, enable, 17);
  assert.equal(f.store.settings().enabled, true);
  assert.equal(f.store.plan(day)!.status, "cancelled");
  assert.equal(await handlePlanningCallback(f.runtime, "unrelated", 17), undefined);
});

test("old planning cards cannot prepare a different day or ignore intervening brief/settings changes", async t => {
  const f = fixture(t);
  f.proactive.configure({ expectedVersion: 1, enabled: true, quietHours: null });
  enqueuePlanningControls(f.runtime, "stale-brief");
  const card = f.owner.deliveries("planning-menu:stale-brief")[0]!;
  f.owner.beginDelivery(card.id); f.owner.finishDelivery(card.id, "sent", undefined, 20);
  f.store.setBrief({ day, expectedVersion: 0, text: "A new owner correction" });
  await assert.rejects(handlePlanningCallback(f.runtime, card.replyMarkup!.inline_keyboard[0]![0]!.callback_data, 20), StateError);
  enqueuePlanningControls(f.runtime, "stale-day");
  const next = f.owner.deliveries("planning-menu:stale-day")[0]!;
  f.owner.beginDelivery(next.id); f.owner.finishDelivery(next.id, "sent", undefined, 21);
  f.advance(24 * 60 * 60_000);
  await assert.rejects(handlePlanningCallback(f.runtime, next.replyMarkup!.inline_keyboard[0]![0]!.callback_data, 21), StateError);
  f.store.configure({ expectedVersion: 1, enabled: false, time: "04:00" });
  await assert.rejects(handlePlanningCallback(f.runtime, next.replyMarkup!.inline_keyboard[1]![0]!.callback_data, 21), StateError);
  assert.equal(f.proactive.commitments().length, 0);
});

test("lifecycle wake failure prevents foreground brief/settings mutations and unavailable workspace never promises preparation", async t => {
  const f = fixture(t);
  f.state.onWake = async () => { throw new Error("private-lifecycle-failure"); };
  const result = await f.execute("set_daily_brief", { day, expectedVersion: 0, text: "Owner intent" });
  assert.equal(result.isError, true);
  assert.doesNotMatch(text(result), /private-lifecycle-failure/);
  assert.equal(f.store.brief(day), null);
  await assert.rejects(f.http("/api/planning/settings", "PUT", { expectedVersion: 1, enabled: true, time: "03:00" }));
  assert.equal(f.store.settings().version, 1);
  f.state.onWake = async () => {};
  f.state.available = false;
  f.proactive.configure({ expectedVersion: 1, enabled: true, quietHours: null });
  await assert.rejects(f.http("/api/planning/prepare", "POST"), error => error instanceof StateError && error.status === 503);
  assert.equal(f.store.plan(day), undefined);
});

test("abandonment during dispatched I/O keeps the late actual receipt without restoring authority", async t => {
  const f = fixture(t); f.begin(); await f.runtime.inputs("background-control");
  let intentId = "";
  f.state.onApply = async intent => {
    intentId = intent.intentId;
    f.store.abandonIntent(intent.intentId, "prepared");
    return synced(intent);
  };
  await f.runtime.commit("background-control", f.store.plan(day)!.version, patch, "abandon-race");
  const intent = f.store.intent(intentId)!;
  assert.equal(intent.status, "abandoned");
  assert.equal(intent.result!.status, "synced");
  assert.equal(f.store.plan(day)!.status, "cancelled");
  assert.equal(f.store.pending(), undefined);
});

test("explicit same-day recovery reauthorizes only the retained write and never creates a replacement patch", async t => {
  const f = fixture(t); f.begin(); await f.runtime.inputs("background-control");
  f.state.onApply = async () => { throw new Error("uncertain"); };
  await f.runtime.commit("background-control", f.store.plan(day)!.version, patch, "initial");
  const retained = f.store.pending()!;
  const run = f.proactive.runForSession("background-control")!;
  await f.execute("finish_proactive_review", { outcome: "blocked", note: "Upload was unconfirmed; inspect retained intent" }, "background-control");
  f.owner.settle(run.operationId, "");
  f.store.reconcile();
  assert.equal(f.store.plan(day)!.status, "blocked");
  f.runtime.request("foreground-control");
  f.advance(1_001);
  f.proactive.drive(Date.now(), false, { control: "background-control" });
  assert.equal(f.store.plan(day)!.intentId, retained.intentId);
  assert.equal((await f.runtime.inputs("background-control") as { status: string }).status, "recovery_required");
  f.state.onApply = async intent => {
    assert.equal(intent.intentId, retained.intentId);
    assert.equal(intent.text, retained.text);
    return synced(intent);
  };
  await f.runtime.resume("background-control");
  assert.equal(f.store.plan(day)!.status, "synced");
  assert.equal(f.state.snapshots, 1);
});

test("generic owner scheduling routes and tools cannot repurpose planner-owned authority", async t => {
  const f = fixture(t); f.begin(); await f.runtime.inputs("background-control");
  await f.runtime.commit("background-control", f.store.plan(day)!.version, patch, "owned-http");
  const run = f.proactive.runForSession("background-control")!;
  await f.execute("finish_proactive_review", { outcome: "completed", note: "Upload confirmation recorded." }, "background-control");
  f.owner.settle(run.operationId, "");
  const plan = f.store.plan(day)!, commitment = f.proactive.commitment(plan.commitmentId!)!;
  const edit = { expectedVersion: commitment.version, purpose: "A different responsibility", source: "A different source",
    nextAction: "Use a different adapter", blocker: null, status: "active", nextReviewAt: new Date(Date.now() + 60_000).toISOString(), jobId: null };
  const wake = f.proactive.wakeup(plan.wakeId!)!;
  const changes: [string, string, object][] = [
    [`/api/schedule/commitments/${commitment.id}`, "PUT", edit],
    ["/api/schedule/wakeups", "POST", { id: "repurposed-wake", commitmentId: commitment.id }],
    [`/api/schedule/wakeups/${wake.id}`, "PUT", { expectedVersion: wake.version }],
    [`/api/schedule/wakeups/${wake.id}/cancel`, "POST", { expectedVersion: wake.version }],
  ];
  for (const [path, method, body] of changes) {
    await assert.rejects(scheduleRequest(new Request(`https://example.invalid${path}`, {
      method, headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    }), f.proactive, f.runtime.wake, async () => "foreground-control", id => f.store.ownsCommitment(id)),
    error => error instanceof StateError && error.status === 403);
  }
  assert.equal((await f.execute("update_commitment", { id: commitment.id, ...edit })).isError, true);
  assert.equal(f.proactive.commitment(commitment.id)?.status, "completed");
  assert.equal(f.proactive.commitment(commitment.id)?.purpose, commitment.purpose);
  assert.equal(f.proactive.wakeup("repurposed-wake"), undefined);
});
