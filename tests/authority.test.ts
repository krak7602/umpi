// Authority checks in tested modules. Each test here fails when its one check is removed;
// `npm run test:mutants` removes each check in turn and proves it (scripts/mutate-authority.mjs).
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ToolExecutionApi, ToolRegistration } from "@earendil-works/pi-durable";
import { DreamStore } from "../src/worker/dream-store.js";
import { guardDreamReviewTools } from "../src/worker/dream-tools.js";
import { MailRuntime } from "../src/worker/mail-runtime.js";
import { MailStore } from "../src/worker/mail-store.js";
import { mailTools } from "../src/worker/mail-tools.js";
import { backgroundTools, guardBackgroundTools } from "../src/worker/proactive-runtime.js";
import { HEARTBEAT_MS, ProactiveStore } from "../src/worker/proactive-store.js";
import { SituationStore } from "../src/worker/situation-store.js";
import { StateError, Store, type Database } from "../src/worker/store.js";
import { authorize } from "../src/worker/transport.js";

const TZ = "Europe/Lisbon";
// 2027-03-09 23:10 local; the night of the 9th closes at 02:00 local on the 10th.
const EVENING = Date.parse("2027-03-09T23:10:00Z");
const NIGHT = Date.parse("2027-03-10T02:00:00Z");
const DAY = "2027-03-09";

function fixture(t: TestContext, now = EVENING) {
  t.mock.timers.enable({ apis: ["Date"], now });
  const sqlite = new DatabaseSync(":memory:"); let depth = 0; t.after(() => sqlite.close());
  const db: Database = {
    all: <T extends object>(query: string, ...bindings: (string | number | null)[]) => sqlite.prepare(query).all(...bindings) as T[],
    transaction<T>(run: () => T): T {
      const name = `a_${depth++}`; sqlite.exec(`SAVEPOINT ${name}`);
      try { const value = run(); sqlite.exec(`RELEASE ${name}`); return value; }
      catch (error) { sqlite.exec(`ROLLBACK TO ${name}; RELEASE ${name}`); throw error; }
      finally { depth--; }
    },
  };
  const owner = new Store(db);
  owner.setSession("control", "owner-control"); owner.setSession("telegram", "owner-chat");
  owner.registerBackgroundSession("review", "control"); owner.registerBackgroundSession("night-review", "telegram");
  const proactive = new ProactiveStore(owner, TZ); proactive.configure({ expectedVersion: 1, enabled: true, quietHours: null }, now);
  const ran: string[] = [];
  /** A tool that only records that it ran, so a refusal is told apart from a run. */
  const tool = (name: string) => ({ name, description: name, parameters: {}, replay: "safe", async execute() { ran.push(name); return { content: [{ type: "text", text: "ran" }] }; } }) as unknown as ToolRegistration;
  return { db, owner, proactive, ran, tool, time(at: number) { t.mock.timers.setTime(at); } };
}
type Fixture = ReturnType<typeof fixture>;

async function call(tools: ToolRegistration[], name: string, conversationId: string, input: unknown = {}) {
  const result = await tools.find(item => item.name === name)!.execute(input as never, { conversationId, taskId: "task" } as unknown as ToolExecutionApi, BACKGROUND_CONTEXT);
  return { refused: result.isError === true, text: (result.content![0] as { text: string }).text };
}

/** Starts an ordinary background review in the session "review". */
function openReview(f: Fixture, allowNotify: boolean) {
  f.proactive.createCommitment({ id: "kiln-check", purpose: "Check whether the kiln firing finished", source: "Owner asked for a check on the kiln", nextAction: "Read the firing log", status: "active", blocker: null,
    nextReviewAt: new Date(EVENING + 1_000).toISOString(), jobId: null, allowNotify }, "control", "owner-control");
  f.time(EVENING + HEARTBEAT_MS);
  f.proactive.drive(EVENING + HEARTBEAT_MS, false, { control: "review" });
  assert.ok(f.proactive.runForSession("review"), "the review is running");
}

/** Enables the nightly run and opens the night of DAY in the session "night-review". */
function openNight(f: Fixture) {
  const dream = new DreamStore(f.proactive);
  dream.configure({ expectedVersion: 1, enabled: true }, "owner-chat", EVENING);
  f.time(NIGHT); dream.drive(NIGHT);
  f.proactive.drive(NIGHT, false, { telegram: "night-review" });
  f.owner.submitted(f.proactive.runForSession("night-review")!.operationId);
  assert.equal(dream.ownsSession("night-review"), true);
  return dream;
}

const SAID = ["Keep the glaze notes in the blue folder from now on", "Never order clay without asking me first", "Stop rounding the kiln temperatures in the log"];
const nightResult = (summary: string, lessons: { text: string; evidence: string }[]) => ({
  digest: { summary, decisions: [], standingInstructions: [], openLoops: [], people: [], topics: ["pottery"] },
  probes: [{ question: "Where do the glaze notes go?", answer: "In the blue folder." }],
  lessons: lessons.map(lesson => ({ op: "add", ...lesson })),
});

test("a background review may call only the tools on the background list", async t => {
  const f = fixture(t); openReview(f, true);
  assert.equal(backgroundTools.has("create_reminder"), false); assert.equal(backgroundTools.has("current_time"), true);
  const tools = guardBackgroundTools([f.tool("create_reminder"), f.tool("current_time")], f.proactive);
  const refused = await call(tools, "create_reminder", "review");
  assert.equal(refused.refused, true);
  assert.match(refused.text, /does not authorize that action/);
  assert.equal((await call(tools, "current_time", "review")).refused, false, "a listed tool runs");
  assert.equal((await call(tools, "create_reminder", "owner-control")).refused, false, "the owner's conversation is not limited by the list");
  assert.deepEqual(f.ran, ["current_time", "create_reminder"], "the refused call never reached the tool");
  // `extra` widens the list for the one session and tool it names, and for nothing else.
  const widened = guardBackgroundTools([f.tool("search_history"), f.tool("create_reminder")], f.proactive, (session, name) => session === "review" && name === "search_history");
  assert.equal((await call(widened, "search_history", "review")).refused, false);
  assert.equal((await call(widened, "create_reminder", "review")).refused, true);
});

test("a background review cannot ask for an approval that would interrupt the owner", async t => {
  // A review that may not notify: the approval card would be a notification.
  const silent = fixture(t); openReview(silent, false);
  const tools = guardBackgroundTools([silent.tool("request_t3_action"), silent.tool("request_mac_command"), silent.tool("t3_code_threads")], silent.proactive);
  for (const name of ["request_t3_action", "request_mac_command"]) {
    const refused = await call(tools, name, "review");
    assert.equal(refused.refused, true, name);
    assert.match(refused.text, /would interrupt the owner/);
  }
  assert.equal((await call(tools, "t3_code_threads", "review")).refused, false, "reading interrupts nobody");
  assert.deepEqual(silent.ran, ["t3_code_threads"]);
  t.mock.timers.reset();

  // A review that may notify, inside quiet hours: the card waits.
  const quiet = fixture(t); openReview(quiet, true);
  const quietTools = guardBackgroundTools([quiet.tool("request_t3_action")], quiet.proactive);
  assert.equal((await call(quietTools, "request_t3_action", "review")).refused, false, "outside quiet hours, with permission to notify, the card is shown");
  quiet.proactive.configure({ expectedVersion: quiet.proactive.settings().version, enabled: true, quietHours: { start: "22:00", end: "07:00" } }, EVENING + HEARTBEAT_MS);
  assert.ok(quiet.proactive.runForSession("review"), "the review is still running");
  const held = await call(quietTools, "request_t3_action", "review");
  assert.equal(held.refused, true);
  assert.match(held.text, /would interrupt the owner/);
  assert.deepEqual(quiet.ran, ["request_t3_action"], "only the call outside quiet hours ran");
});

test("the nightly run cannot change its own commitment or schedule", async t => {
  const f = fixture(t);
  const restricted = ["update_commitment", "schedule_wakeup", "update_wakeup", "cancel_wakeup"];
  const dream = new DreamStore(f.proactive);
  const tools = guardDreamReviewTools([...restricted, "list_commitments"].map(f.tool), dream);
  // Before the night opens, the session is not the nightly run, and this guard lets the call through.
  assert.equal((await call(tools, "update_wakeup", "night-review", { id: "none" })).refused, false);
  f.ran.length = 0;
  dream.configure({ expectedVersion: 1, enabled: true }, "owner-chat", EVENING);
  f.time(NIGHT); dream.drive(NIGHT);
  f.proactive.drive(NIGHT, false, { telegram: "night-review" });
  assert.equal(dream.ownsSession("night-review"), true);
  for (const name of restricted) {
    const refused = await call(tools, name, "night-review", { id: "none", commitmentId: "none" });
    assert.equal(refused.refused, true, name);
    assert.match(refused.text, /nightly run cannot rewrite its commitment or schedule/);
  }
  assert.equal((await call(tools, "list_commitments", "night-review")).refused, false, "reading stays allowed");
  assert.deepEqual(f.ran, ["list_commitments"]);
});

test("the nightly run commits once: a second commit in the same run changes nothing", t => {
  const f = fixture(t), dream = openNight(f);
  dream.saveParts(DAY, SAID.map((text, index) => ({ at: Date.parse(`${DAY}T10:00:00Z`) + index, text: `owner: ${text}`, owner: text })));
  const first = dream.commit("night-review", nightResult("Sorted the glaze notes and fired two bowls.", [{ text: "File glaze notes in the blue folder.", evidence: SAID[0]! }]), NIGHT);
  assert.equal(first.status, "committed"); assert.equal(first.lessonEdits, 1);
  const second = dream.commit("night-review", nightResult("A rewritten day that must not replace the first.", [{ text: "Ask before ordering clay.", evidence: SAID[1]! }]), NIGHT + 60_000);
  assert.deepEqual(second, first, "the second commit returns the first night unchanged");
  assert.equal(dream.digest(`day:${DAY}`)!.text, "Sorted the glaze notes and fired two bowls.");
  assert.deepEqual(dream.lessons().map(lesson => lesson.text), ["File glaze notes in the blue folder."], "no lesson from the second commit");
});

test("at most 30 lessons are active: the night's extra lesson is not added", t => {
  const f = fixture(t), dream = openNight(f);
  for (let n = 1; n <= 29; n++) {
    const lesson = { id: `L${n}`, version: 1, text: `Invented lesson ${n}.`, status: "active", history: [{ version: 1, text: `Invented lesson ${n}.`, status: "active", at: new Date(EVENING).toISOString(), by: "owner", evidence: null }] };
    f.db.all("INSERT INTO umpi_lessons VALUES (?,?,?)", lesson.id, lesson.status, JSON.stringify(lesson));
  }
  dream.saveParts(DAY, SAID.map((text, index) => ({ at: Date.parse(`${DAY}T10:00:00Z`) + index, text: `owner: ${text}`, owner: text })));
  // Both edits quote the owner, so only the cap can stop the second one.
  const night = dream.commit("night-review", nightResult("Two corrections about the studio log.", [
    { text: "Ask before ordering clay.", evidence: SAID[1]! }, { text: "Log kiln temperatures exactly.", evidence: SAID[2]! }]), NIGHT);
  assert.equal(night.lessonEdits, 1, "the thirtieth lesson is added, the thirty-first is not");
  assert.equal(dream.lessons().length, 30);
  assert.equal(dream.lessons().some(lesson => lesson.text === "Log kiln temperatures exactly."), false);
  assert.deepEqual(night.dropped?.lessons ?? [], [], "the extra lesson was grounded; the cap refused it");
});

test("a background session cannot read mail through the owner's mail tool", async t => {
  const f = fixture(t);
  const mail = new MailStore(f.proactive, new SituationStore(f.db, TZ));
  const tools = mailTools(new MailRuntime(mail, undefined, async () => {}));
  const refused = await call(tools, "read_mail_follow_through", "review");
  assert.equal(refused.refused, true);
  assert.match(refused.text, /Background mail access requires the explicitly owned triage tool/);
  const allowed = await call(tools, "read_mail_follow_through", "owner-chat");
  assert.equal(allowed.refused, false);
  assert.deepEqual(Object.keys(JSON.parse(allowed.text)).sort(), ["attention", "recentReplies", "status"]);
});

// The coordinator calls `authorize` before its routes (`onRequest` in src/worker/index.ts, which no test can import),
// and the Worker entry calls it before it forwards. This covers the function for one request of every route family.
test("no route family is reachable without its own credential", async () => {
  const env = { UMPI_CONTROL_TOKEN: "c".repeat(40), UMPI_EXECUTOR_TOKEN: "e".repeat(40), UMPI_BROWSER_SYNC_TOKEN: "s".repeat(40) };
  const request = (method: string, path: string, token?: string) => new Request(`https://coordinator.example${path}`, { method, headers: token ? { authorization: `Bearer ${token}` } : {} });
  const control: [string, string][] = [
    ["GET", "/api/status"], ["POST", "/api/messages"], ["GET", "/api/messages/m-1"], ["GET", "/api/jobs"], ["POST", "/api/jobs/job-1/approve"], ["GET", "/api/reminders"], ["GET", "/api/auth"],
    ["GET", "/api/core-context"], ["GET", "/api/core-context/reviews"], ["GET", "/api/core-context/history"], ["POST", "/api/core-context/restore"], ["POST", "/api/model/fallback/check"],
    ["GET", "/api/schedule"], ["PUT", "/api/schedule/settings"], ["GET", "/api/planning"], ["POST", "/api/planning/prepare"], ["GET", "/api/mail"], ["POST", "/api/mail/check"],
    ["GET", "/api/brief"], ["POST", "/api/brief/run"], ["GET", "/api/situation"], ["GET", "/api/alerts"], ["PUT", "/api/alerts/settings"], ["GET", "/api/journal"], ["GET", "/api/dream"], ["POST", "/api/dream/run"],
    ["GET", "/api/coding"], ["POST", "/api/coding/tasks"], ["GET", "/api/browser"], ["POST", "/api/browser/tasks"], ["GET", "/api/subagents"], ["POST", "/api/subagents/agent-1/cancel"],
    ["GET", "/api/companion/state"], ["POST", "/api/companion/pairings"],
  ];
  const executor: [string, string][] = [["POST", "/api/executor/poll"], ["POST", "/api/executor/complete"], ["POST", "/api/executor/coding/poll"], ["POST", "/api/executor/browser/report"],
    ["POST", "/api/executor/context/report"], ["POST", "/api/executor/knock/poll"]];
  const synchronizer: [string, string][] = [["GET", "/api/browser/snapshot-key"], ["GET", "/api/browser/snapshot-requests"], ["POST", "/api/browser/snapshots/snapshot-1"]];
  const device: [string, string][] = [["GET", "/api/device/state"], ["GET", "/api/device/chat"], ["POST", "/api/device/messages"], ["POST", "/api/device/chat/press"], ["DELETE", "/api/device/session"]];
  const families = [
    { routes: control, own: env.UMPI_CONTROL_TOKEN }, { routes: executor, own: env.UMPI_EXECUTOR_TOKEN }, { routes: synchronizer, own: env.UMPI_BROWSER_SYNC_TOKEN },
  ];
  const others = (own: string) => [undefined, "x".repeat(40), ...Object.values(env).filter(token => token !== own)];
  for (const { routes, own } of families) for (const [method, path] of routes) {
    await authorize(request(method, path, own), env);
    for (const token of others(own)) await assert.rejects(authorize(request(method, path, token), env), { status: 401 }, `${method} ${path} with ${token ? `the token ${token[0]}...` : "no credential"}`);
  }
  // A device route needs a device session: no credential and every administrator token are refused, and without a
  // verifier (the coordinator always passes one) any bearer is refused.
  for (const [method, path] of device) {
    for (const token of [undefined, ...Object.values(env)]) await assert.rejects(authorize(request(method, path, token), env, () => { throw new Error("the verifier must not see an administrator token"); }), { status: 401 }, `${method} ${path}`);
    await assert.rejects(authorize(request(method, path, "d".repeat(40)), env), { status: 401 });
    await assert.rejects(authorize(request(method, path, "d".repeat(40)), env, () => { throw new StateError(401, "Unknown device"); }), { status: 401 });
  }
  // A path outside the table of routes does not exist, with or without a credential.
  for (const path of ["/api", "/api/statuses", "/api/executor", "/api/device", "/internal/state"]) await assert.rejects(authorize(request("GET", path, env.UMPI_CONTROL_TOKEN), env), { status: 404 }, path);
});
