import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { Store, type Database } from "../src/worker/store.js";
import { T3ActionRequests, t3ActionTools } from "../src/worker/t3-actions.js";
import { T3CodeStore, T3Error, T3Unreachable, type T3Action, type T3Machine, type T3ThreadState } from "../src/worker/t3-code.js";
import { T3Watcher, t3WatchTools } from "../src/worker/t3-watch.js";
import { telegramUpdate } from "../src/worker/transport.js";

const START = Date.parse("2026-11-04T10:00:00Z"), MINUTE = 60_000;

function database(t: TestContext): Database {
  const sqlite = new DatabaseSync(":memory:"); let depth = 0; t.after(() => sqlite.close());
  return {
    all: <T extends object>(query: string, ...bindings: (string | number | null)[]) => sqlite.prepare(query).all(...bindings) as T[],
    transaction<T>(run: () => T): T {
      const name = `w_${depth++}`; sqlite.exec(`SAVEPOINT ${name}`);
      try { const value = run(); sqlite.exec(`RELEASE ${name}`); return value; }
      catch (error) { sqlite.exec(`ROLLBACK TO ${name}; RELEASE ${name}`); throw error; }
      finally { depth--; }
    },
  };
}

/** A T3 store whose machines and threads the test scripts: what each check sees, and whether the machine answers. */
function fakeT3() {
  const machines: T3Machine[] = [{ id: "mac", label: "Work Mac", host: "work.example.ts.net", status: "connected", addedAt: "2026-11-01T00:00:00Z" },
    { id: "cloud-1", label: "Fix login", host: "cloud-1.cloud.umpi.internal", status: "connected", addedAt: "2026-11-01T00:00:00Z", kind: "cloud", asleep: false }];
  const threads = new Map<string, T3ThreadState>();
  const acted: { machine: string; action: T3Action; requestId: string }[] = [];
  const reads: string[] = [];
  let offline = false;
  let questions: { question: string; options: { label: string }[] }[] = [];
  const reach = (machine: string) => { if (offline && machine === "mac") throw new T3Unreachable("Work Mac did not answer: no answer within 20 seconds"); };
  const store = {
    list: () => machines,
    pick: (name: unknown) => machines.find(machine => machine.id === name || machine.label === name) ?? machines[0]!,
    async act(machine: string, action: T3Action, requestId: string) {
      reach(machine); acted.push({ machine, action, requestId });
      return action.kind === "start" ? { threadId: "th-new", title: action.title } : { ok: true };
    },
    async states(machine: string, ids: string[]) { reach(machine); reads.push(`${machine}:${ids.join(",")}`); return new Map(ids.map(id => [id, threads.get(id)])); },
    async read() { return { messages: [{ position: 1, type: "user_message", by: "user", text: "fix it" }, { position: 2, type: "assistant_message", by: "agent", text: "Fixed the login bug and pushed fix/login. Tests pass." }], hasMore: false }; },
    async questions() { return { requests: questions.length ? [{ requestId: "q1", questions: questions.map((item, index) => ({ id: `q${index}`, ...item })) }] : [] }; },
  };
  return {
    t3: store as unknown as T3CodeStore, machines, threads, acted, reads,
    set offline(value: boolean) { offline = value; },
    set questions(value: typeof questions) { questions = value; },
  };
}

function fixture(t: TestContext, quiet = false) {
  t.mock.timers.enable({ apis: ["Date"], now: START });
  const db = database(t), owner = new Store(db); owner.setSession("telegram", "owner");
  const fake = fakeT3();
  const watcher = new T3Watcher(db, owner, fake.t3, { quiet: () => quiet, timezone: "Asia/Kolkata" });
  const notices = () => owner.deliveries().filter(delivery => /^t3-(watch|held):/.test(delivery.groupId)).reverse();
  const at = (ms: number) => t.mock.timers.setTime(START + ms);
  const thread = (id: string, status: string, run?: { id: string; status: string; requestedAt: string; completedAt?: string }, pendingRequests = 0) =>
    fake.threads.set(id, { threadId: id, title: "Fix the login bug", status, pendingRequests, ...(run ? { run } : {}) });
  const sent = (id: string, messageId: number) => { owner.beginDelivery(id); owner.finishDelivery(id, "sent", undefined, messageId); };
  return { db, owner, fake, watcher, notices, at, thread, sent };
}
const iso = (ms: number) => new Date(START + ms).toISOString();

test("a thread Umpi messaged is followed: one notice when its new run finishes, with the agent's last words", async t => {
  const f = fixture(t);
  // The thread's earlier run ended before Umpi acted; that is not news.
  f.thread("th-1", "completed", { id: "run-1", status: "completed", requestedAt: iso(-60 * MINUTE), completedAt: iso(-30 * MINUTE) });
  const ran = await f.watcher.run("mac", { kind: "send", threadId: "th-1", message: "fix the login bug" }, "umpi-call-1", "chat", "Fix the login bug");
  assert.deepEqual(ran.result, { ok: true });
  f.at(MINUTE); await f.watcher.drive();
  assert.equal(f.notices().length, 0, "the earlier run's end is not announced");
  f.thread("th-1", "running", { id: "run-2", status: "running", requestedAt: iso(5_000) });
  f.at(2 * MINUTE); await f.watcher.drive();
  assert.equal(f.notices().length, 0);
  f.thread("th-1", "completed", { id: "run-2", status: "completed", requestedAt: iso(5_000), completedAt: iso(150_000) });
  f.at(3 * MINUTE); await f.watcher.drive();
  const [notice] = f.notices();
  assert.ok(notice);
  assert.match(notice.text, /^"Fix the login bug" finished on Work Mac\.\n\nFixed the login bug and pushed fix\/login\. Tests pass\./);
  assert.match(notice.text, /Reply to this message/);
  assert.equal(f.watcher.watching().length, 0, "following ends with the notice");
  f.at(10 * MINUTE); await f.watcher.drive();
  assert.equal(f.notices().length, 1, "said once");
  assert.equal(f.fake.reads.length, 3, "no checks after it ended");
  assert.deepEqual(f.watcher.recent().map(item => item.title), ["Fix the login bug"]);
});

test("checks are frequent while a thread is new, then rarer, and stop after a day with one notice", async t => {
  const f = fixture(t);
  f.thread("th-1", "running", { id: "run-2", status: "running", requestedAt: iso(0) });
  f.watcher.arm("mac", "th-1", "asked", "Long migration");
  const due = () => Date.parse(f.watcher.watching()[0]!.nextCheckAt) - Date.now();
  f.at(MINUTE); await f.watcher.drive(); assert.equal(due(), MINUTE);
  f.at(30 * MINUTE); await f.watcher.drive(); assert.equal(due(), 4 * MINUTE);
  f.at(3 * 60 * MINUTE); await f.watcher.drive(); assert.equal(due(), 10 * MINUTE);
  f.at(24 * 60 * MINUTE); await f.watcher.drive();
  assert.equal(f.watcher.watching().length, 0);
  assert.match(f.notices()[0]!.text, /stopped following "Fix the login bug" on Work Mac after a day; it is still working/);
});

test("a waiting agent is announced once per wait, with its question; a permission request points to T3 Code", async t => {
  const f = fixture(t);
  f.fake.questions = [{ question: "Which database should the tests use?", options: [{ label: "SQLite in memory" }, { label: "Postgres" }] }];
  await f.watcher.run("mac", { kind: "start", title: "Add tests", message: "add tests" }, "umpi-call-2", "chat");
  f.thread("th-new", "waiting", { id: "run-1", status: "running", requestedAt: iso(0) }, 1);
  f.at(MINUTE); await f.watcher.drive();
  f.at(2 * MINUTE); await f.watcher.drive();
  assert.equal(f.notices().length, 1);
  assert.equal(f.notices()[0]!.text, '"Fix the login bug" on Work Mac is waiting on you:\n\nWhich database should the tests use?\n• SQLite in memory\n• Postgres\n\nReply to this message with your answer.');
  // Answered, it works on, then waits again in the same run: that is a new wait.
  f.thread("th-new", "running", { id: "run-1", status: "running", requestedAt: iso(0) });
  f.at(3 * MINUTE); await f.watcher.drive();
  f.fake.questions = [];
  f.thread("th-new", "waiting", { id: "run-1", status: "running", requestedAt: iso(0) }, 1);
  f.at(4 * MINUTE); await f.watcher.drive();
  assert.equal(f.notices().length, 2);
  assert.match(f.notices()[1]!.text, /waiting for your approval in T3 Code/);
});

test("an action for a Mac that does not answer is held, retried, and sent once when it is back", async t => {
  const f = fixture(t);
  f.fake.offline = true;
  const ran = await f.watcher.run("mac", { kind: "send", threadId: "th-1", message: "commit and push" }, "app-req-1", "app", "Fix the login bug");
  assert.equal(ran.held?.status, "held");
  assert.match(f.notices()[0]!.text, /^Work Mac did not answer, so Umpi holds this and sends it when the machine is back:\n\nSend to "Fix the login bug" on Work Mac:\n\ncommit and push$/);
  f.at(MINUTE); await f.watcher.drive();
  assert.equal(f.fake.acted.length, 0, "not before its retry time");
  f.at(2 * MINUTE); await f.watcher.drive();
  assert.equal(Date.parse(f.watcher.held()[0]!.nextAt), START + 7 * MINUTE, "the next try waits longer");
  f.fake.offline = false;
  f.thread("th-1", "running", { id: "run-3", status: "running", requestedAt: iso(7 * MINUTE) });
  f.at(7 * MINUTE); await f.watcher.drive();
  assert.deepEqual(f.fake.acted, [{ machine: "mac", action: { kind: "send", threadId: "th-1", message: "commit and push" }, requestId: "app-req-1" }], "the same request ID, so a send that did land is not repeated");
  assert.equal(f.watcher.held().length, 0);
  assert.match(f.notices()[1]!.text, /^Work Mac is back, so Umpi sent what it held since 15:30:/);
  assert.equal(f.watcher.watching()[0]?.threadId, "th-1", "and the thread is followed from then");
});

test("a held action that never gets through expires after a day with nothing sent; a cloud machine is never held", async t => {
  const f = fixture(t);
  f.fake.offline = true;
  await f.watcher.run("mac", { kind: "stop", threadId: "th-1" }, "umpi-call-3", "chat");
  assert.equal(f.notices().length, 0, "in the chat Umpi says it itself");
  for (let minute = 2; minute <= 24 * 60 + 15; minute += 15) { f.at(minute * MINUTE); await f.watcher.drive(); }
  assert.equal(f.watcher.held().length, 0);
  assert.match(f.notices().at(-1)!.text, /^Work Mac did not answer for a day, so Umpi did not send this\. Nothing was changed:/);
  assert.equal(f.fake.acted.length, 0);
  // A cloud machine is woken instead, so its failure is a real error, not a hold.
  (f.fake.t3 as unknown as { act: () => Promise<never> }).act = async () => { throw new T3Unreachable("Fix login did not answer"); };
  await assert.rejects(f.watcher.run("cloud-1", { kind: "send", threadId: "th-1", message: "x" }, "r", "chat"), T3Unreachable);
  assert.equal(f.watcher.held().length, 0);
});

test("a sleeping cloud machine is never woken to be checked; its last check before sleep still announces", async t => {
  const f = fixture(t);
  f.watcher.arm("cloud-1", "th-c", "cloud", "Fix login");
  f.fake.machines[1]!.asleep = true;
  f.at(5 * MINUTE); await f.watcher.drive();
  assert.equal(f.fake.reads.length, 0, "asleep: not read");
  f.fake.machines[1]!.asleep = false;
  f.thread("th-c", "completed", { id: "run-1", status: "completed", requestedAt: iso(0), completedAt: iso(4 * MINUTE) });
  await f.watcher.check("cloud-1", true);
  assert.match(f.notices()[0]!.text, /finished on Fix login/);
});

test("stopping a thread stops following it; notices in quiet hours arrive without a sound", async t => {
  const f = fixture(t, true);
  f.thread("th-1", "running", { id: "run-2", status: "running", requestedAt: iso(0) });
  await f.watcher.run("mac", { kind: "send", threadId: "th-1", message: "go" }, "r1", "chat");
  await f.watcher.run("mac", { kind: "stop", threadId: "th-1" }, "r2", "chat");
  assert.equal(f.watcher.watching().length, 0);
  f.watcher.arm("mac", "th-1", "asked");
  f.thread("th-1", "failed", { id: "run-2", status: "failed", requestedAt: iso(0), completedAt: iso(MINUTE) });
  f.at(2 * MINUTE); await f.watcher.drive();
  assert.match(f.notices()[0]!.text, /^"Fix the login bug" failed on Work Mac\./);
  assert.equal(f.notices()[0]!.silent, true);
});

test("a Telegram reply to a notice names its thread for the model; other replies do not", async t => {
  const f = fixture(t);
  f.thread("th-1", "completed", { id: "run-2", status: "completed", requestedAt: iso(0), completedAt: iso(MINUTE) });
  f.watcher.arm("mac", "th-1", "chat", "Fix the login bug");
  f.at(2 * MINUTE); await f.watcher.drive();
  const notice = f.notices()[0]!;
  f.sent(notice.id, 4242);
  const update = telegramUpdate({ update_id: 9, message: { message_id: 4250, date: Math.floor((START + 3 * MINUTE) / 1000), text: "push it and open a PR", from: { id: 7, is_bot: false }, chat: { id: 7, type: "private" },
    reply_to_message: { message_id: 4242, date: 1, text: notice.text } } }, { TELEGRAM_OWNER_ID: "7", TELEGRAM_CHAT_ID: "7" } as never);
  assert.equal(update?.kind === "message" ? update.replyTo : undefined, 4242);
  const watch = f.watcher.forMessage(4242)!;
  assert.equal(watch.threadId, "th-1");
  assert.equal(f.watcher.forMessage(1), undefined);
  const op = f.owner.admit("tg:9", "push it and open a PR", "telegram", "owner", { kind: "telegram-text", replyTo: { t3Thread: { machine: watch.machineLabel, threadId: watch.threadId, title: watch.title } } });
  assert.match(op.modelInput!, /The owner replied to Umpi's notice about the T3 Code thread "Fix the login bug" on Work Mac \(threadId th-1\)\. Unless the message is clearly for Umpi itself, it is for that thread/);
});

test("the chat tools and an approval follow the thread, and say when a Mac's action is held", async t => {
  const f = fixture(t);
  const requests = new T3ActionRequests(f.db, f.owner, f.fake.t3);
  requests.watcher = f.watcher;
  const tools = Object.fromEntries([...t3ActionTools(f.fake.t3, requests, f.watcher), ...t3WatchTools(f.fake.t3, f.watcher)].map(tool => [tool.name, tool]));
  let calls = 0;
  const call = async (name: string, input: object) => JSON.parse(((await tools[name]!.execute(input, { callId: `c-${++calls}` } as never, undefined as never)).content![0] as { text: string }).text);
  assert.deepEqual(await call("t3_code_send", { machine: "mac", threadId: "th-1", threadTitle: "Fix the login bug", message: "add a test" }), { machine: "Work Mac", ok: true, following: true });
  f.fake.offline = true;
  const held = await call("t3_code_send", { machine: "mac", threadId: "th-2", message: "rebase" });
  assert.equal(held.held, true); assert.match(held.note, /holds this and sends it when the machine is back/);
  const listed = await call("t3_code_follow", {});
  assert.deepEqual(listed.following.map((item: { threadId: string }) => item.threadId), ["th-1"]);
  assert.equal(listed.held.length, 1);
  // An approval Umpi asked for runs through the same path.
  f.fake.offline = false;
  const request = requests.request("mac", { kind: "send", threadId: "th-3", message: "rerun CI" }, "CI flaked", "CI fix");
  const approve = requests.button(request.id, true);
  f.sent(f.owner.deliveries(approve.groupId)[0]!.id, 77);
  assert.equal((await requests.press(approve.data, 77))?.text, "Done on Work Mac.");
  assert.ok(f.watcher.watching().some(watch => watch.threadId === "th-3" && watch.source === "approval" && watch.title === "CI fix"));
});

test("the T3 store tells a machine that did not answer from one that refused, and reads a thread's state", async t => {
  const db = database(t);
  let mode: "down" | "refuse" | "ok" = "down";
  const fetcher: typeof fetch = async (input, init) => {
    if (mode === "down") throw new TypeError("fetch failed");
    if (mode === "refuse") return new Response("no", { status: 404 });
    const message = JSON.parse(String(init?.body)) as { id?: number; method: string; params: { protocolVersion?: string; arguments: Record<string, unknown> } };
    if (message.method === "initialize") return Response.json({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "T3", version: "1" } } }, { headers: { "mcp-session-id": "s" } });
    if (message.id === undefined) return new Response(null, { status: 202 });
    const thread = { thread: { threadId: message.params.arguments.threadId, title: "Fix", status: "completed", latestRunId: "r2", pendingRequestCount: 0, branch: "fix/login", pullRequests: [{}], updatedAt: "2026-11-04T10:05:00Z" },
      recentRuns: [{ runId: "r2", status: "completed", requestedAt: "2026-11-04T10:00:00Z", completedAt: "2026-11-04T10:05:00Z" }], items: [] };
    if (message.params.arguments.threadId === "gone") return Response.json({ jsonrpc: "2.0", id: message.id, result: { isError: true, content: [{ type: "text", text: "Thread not found" }] } });
    return Response.json({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: JSON.stringify(thread) }] } });
  };
  const store = new T3CodeStore(db, fetcher);
  store.registerCloud("m1", "Box", "token");
  await assert.rejects(store.states("m1", ["t1"]), T3Unreachable);
  mode = "refuse";
  await assert.rejects(store.states("m1", ["t1"]), (error: unknown) => error instanceof T3Error && !(error instanceof T3Unreachable));
  mode = "ok";
  const states = await store.states("m1", ["t1", "gone"]);
  assert.deepEqual(states.get("t1"), { threadId: "t1", title: "Fix", status: "completed", pendingRequests: 0, updatedAt: "2026-11-04T10:05:00Z", branch: "fix/login", pullRequests: 1,
    run: { id: "r2", status: "completed", requestedAt: "2026-11-04T10:00:00Z", completedAt: "2026-11-04T10:05:00Z" } });
  assert.equal(states.get("gone"), undefined);
});
