import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { createServer } from "node:http";
import { Store, StateError, splitTelegram, type Database, type Delivery } from "../src/worker/store.js";
import { DurableCredentials } from "../src/worker/credentials.js";
import { authorize, readJson, sendTelegram, telegramUpdate } from "../src/worker/transport.js";
import type { JobCompletion } from "../src/shared/protocol.js";

function open(path = ":memory:") {
  const sqlite = new DatabaseSync(path);
  let depth = 0;
  const db: Database = {
    all: <T extends object>(query: string, ...bindings: (string | number | null)[]) => sqlite.prepare(query).all(...bindings) as T[],
    transaction: <T>(run: () => T): T => {
      const savepoint = `test_${depth++}`;
      sqlite.exec(`SAVEPOINT ${savepoint}`);
      try { const value = run(); sqlite.exec(`RELEASE ${savepoint}`); return value; }
      catch (error) { sqlite.exec(`ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`); throw error; }
      finally { depth--; }
    },
  };
  const store = new Store(db);
  store.setSession("control", "1");
  store.setSession("telegram", "2");
  return { store, db, close: () => sqlite.close() };
}
const assignment = (jobId = "job-1") => ({ jobId, command: "printf hello", cwd: "/workspace", timeoutMs: 10_000, createdAt: new Date().toISOString() });
const poll = (executorId = "mac-1") => ({ executorId, workspaces: ["/workspace"] });
const completion = (jobId = "job-1"): JobCompletion => ({ executorId: "mac-1", jobId, status: "succeeded", exitCode: 0, output: "hello", truncated: false, finishedAt: new Date().toISOString() });
const future = () => new Date(Date.now() + 60_000).toISOString();

test("message admission is durable/idempotent and channel-specific; changed text is rejected", t => {
  const { store, close } = open(); t.after(close);
  const first = store.admit("request-1", "hello", "control", "1");
  assert.deepEqual(store.admit("request-1", "hello", "control", "1"), first);
  assert.throws(() => store.admit("request-1", "different", "control", "1"), StateError);
  store.admit("request-1", "hello", "telegram", "2");
  assert.equal(store.pendingOperations().length, 2);
  store.settle(first.id, "local answer");
  assert.equal(store.operation(first.id)?.status, "done");
  assert.equal(store.deliveries(`answer:${first.id}`)[0]?.channel, "control");
  assert.equal(store.readyDeliveries().length, 0);
});
test("model Markdown is rendered only for Telegram conversation deliveries", t => {
  const { store, close } = open(); t.after(close);
  const markdown = "**Background lane:** Keep going.";
  const telegram = store.admit("rich-response", "request", "telegram", "2");
  store.settle(telegram.id, markdown);
  const telegramDelivery = store.deliveries(`answer:${telegram.id}`)[0]!;
  assert.equal(telegramDelivery.text, "Background lane: Keep going.");
  assert.deepEqual(telegramDelivery.entities?.map(entity => ({
    type: entity.type, text: telegramDelivery.text.slice(entity.offset, entity.offset + entity.length),
  })), [{ type: "bold", text: "Background lane:" }]);

  const control = store.admit("markdown-response", "request", "control", "1");
  store.settle(control.id, markdown);
  const controlDelivery = store.deliveries(`answer:${control.id}`)[0]!;
  assert.equal(controlDelivery.text, markdown);
  assert.equal(controlDelivery.entities, undefined);

  const long = store.admit("long-markdown-response", "request", "telegram", "2");
  store.settle(long.id, `**${"x".repeat(4_001)}**`);
  const parts = store.deliveries(`answer:${long.id}`);
  assert.equal(parts.map(part => part.text).join(""), "x".repeat(4_001));
  assert.deepEqual(parts.map(part => part.entities), [
    [{ type: "bold", offset: 0, length: 4_000 }],
    [{ type: "bold", offset: 0, length: 1 }],
  ]);
});


test("Mac work requires explicit approval and returns only to its original execution owner", t => {
  const { store, close } = open(); t.after(close);
  store.createJob(assignment(), "control", "1");
  assert.equal(store.poll(poll()).job, null);
  store.approveJob("job-1", 1);
  const claimed = store.poll(poll());
  assert.equal(claimed.job?.jobId, "job-1");
  assert.deepEqual(store.poll(poll()).job, claimed.job);
  assert.equal(store.poll(poll("mac-2")).job, null);
  assert.throws(() => store.complete({ ...completion(), executorId: "mac-2" }), StateError);
  const done = completion();
  store.complete(done);
  assert.equal(store.complete(done).status, "succeeded");
  assert.throws(() => store.complete({ ...done, output: "contradictory" }), StateError);
  assert.equal(store.pendingOperations().filter(op => op.id === "job:job-1:completion").length, 1);
});

test("job edits preserve identity, reject stale versions, and invalidate prior approval", t => {
  const { store, close } = open(); t.after(close);
  store.createJob(assignment(), "control", "1"); store.approveJob("job-1", 1);
  const updated = store.updateJob("job-1", 1, { command: "printf corrected", cwd: "/workspace", timeoutMs: 12_000 });
  assert.equal(updated.jobId, "job-1"); assert.equal(updated.version, 2); assert.equal(updated.status, "pending_approval");
  assert.equal(store.poll(poll()).job, null);
  assert.throws(() => store.approveJob("job-1", 1), StateError);
  assert.throws(() => store.approveJob("job-1"), StateError);
  assert.throws(() => store.updateJob("job-1", 1, assignment()), StateError);
  store.approveJob("job-1", 2); store.poll(poll());
  assert.throws(() => store.updateJob("job-1", 2, assignment()), StateError);
});

test("running cancellation waits for Mac confirmation and a raced success remains truthful", t => {
  const { store, close } = open(); t.after(close);
  store.createJob(assignment(), "control", "1"); store.approveJob("job-1", 1); store.poll(poll());
  const cancelling = store.cancelJob("job-1");
  assert.equal(cancelling.status, "running"); assert.equal(cancelling.cancelRequested, true);
  assert.deepEqual(store.poll(poll()).cancelJobIds, ["job-1"]);
  assert.deepEqual(store.poll(poll()).cancelJobIds, ["job-1"]);
  assert.deepEqual(store.poll(poll("mac-2")).cancelJobIds, []);
  const final = store.complete(completion());
  assert.equal(final.status, "succeeded"); assert.equal(final.cancelRequested, false);
  assert.deepEqual(store.poll(poll()).cancelJobIds, []);
});

test("cancelling queued work prevents execution and atomically creates feedback", t => {
  const { store, close } = open(); t.after(close);
  store.createJob(assignment(), "control", "1"); store.approveJob("job-1", 1);
  store.cancelJob("job-1");
  assert.equal(store.poll(poll()).job, null);
  assert.equal(store.operation("job:job-1:completion")?.status, "admitted");
  assert.throws(() => store.complete(completion()), StateError);
});

test("completion rejects contradictions but preserves a deadline failure even after exit zero", t => {
  const { store, close } = open(); t.after(close);
  store.createJob(assignment(), "control", "1"); store.approveJob("job-1", 1); store.poll(poll());
  assert.throws(() => store.complete({ ...completion(), status: "succeeded", exitCode: 1 }));
  assert.throws(() => store.complete({ ...completion(), status: "uncertain", exitCode: 0 }));
  assert.throws(() => store.complete({ ...completion(), finishedAt: "2000-01-01T00:00:00Z" }));
  assert.equal(store.complete({ ...completion(), status: "failed", exitCode: 0 }).status, "failed");
});

test("tool replay commits mutation and result together, while failed mutations roll back", t => {
  const { store, close } = open(); t.after(close);
  const first = store.effect("tool:1:5", () => store.createReminder("r-1", "take a break", future(), "control"));
  assert.deepEqual(store.effect("tool:1:5", () => { throw new Error("must not replay"); }), first);
  assert.throws(() => store.effect("tool:1:6", () => {
    store.createReminder("r-2", "not committed", future(), "control"); throw new Error("interruption");
  }));
  assert.equal(store.reminder("r-2"), undefined);
});

test("reminder corrections are versioned, fire the corrected text once, and cancellation stops firing", t => {
  const { store, close } = open(); t.after(close);
  store.createReminder("r-1", "original", future(), "telegram");
  const due = new Date(Date.now() + 120_000).toISOString();
  const corrected = store.updateReminder("r-1", 1, "corrected", due);
  assert.equal(corrected.version, 2);
  assert.throws(() => store.updateReminder("r-1", 1, "stale", due), StateError);
  assert.throws(() => store.cancelReminder("r-1", 1), StateError);
  store.fireReminders(Date.parse(due) - 1); assert.equal(store.readyDeliveries().length, 0);
  store.fireReminders(Date.parse(due)); store.fireReminders(Date.parse(due));
  assert.equal(store.deliveries("reminder:r-1:2").length, 1);
  assert.equal(store.deliveries("reminder:r-1:2")[0]?.text, "Reminder: corrected");
  assert.equal(store.reminder("r-1")?.status, "fired");
  store.createReminder("r-2", "cancel me", future(), "telegram");
  store.cancelReminder("r-2", 1); store.fireReminders(Date.now() + 3600_000);
  assert.equal(store.deliveries("reminder:r-2:2").length, 0);
  assert.throws(() => store.createReminder("r-3", "bad time", "2026-10-12T09:00:00", "control"));
});

test("restart preserves operation admission, execution ownership, feedback gap, reminders, and uncertain sends", t => {
  const directory = mkdtempSync(join(tmpdir(), "umpi-store-")); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "state.sqlite");
  let opened = open(path);
  opened.store.admit("accepted", "hello", "control", "1");
  opened.store.createJob(assignment("running"), "control", "1"); opened.store.approveJob("running", 1); opened.store.poll(poll());
  opened.store.createReminder("r-1", "after restart", future(), "telegram");
  opened.store.enqueue("send-1", "telegram", "ambiguous"); opened.store.beginDelivery("send-1:0"); opened.close();
  opened = open(path);
  assert.equal(opened.store.operation("message:control:accepted")?.status, "admitted");
  assert.equal(opened.store.poll(poll("mac-2")).job, null);
  assert.equal(opened.store.poll(poll()).job?.jobId, "running");
  opened.store.complete(completion("running")); opened.close();
  opened = open(path); t.after(opened.close);
  assert.equal(opened.store.operation("job:running:completion")?.status, "admitted");
  assert.equal(opened.store.reminder("r-1")?.status, "scheduled");
  opened.store.recoverDeliveries();
  assert.equal(opened.store.delivery("send-1:0")?.status, "uncertain");
  assert.equal(opened.store.readyDeliveries().length, 0);
});

test("Telegram chunks respect UTF-16 limits and never pass an ambiguous previous chunk", t => {
  const { store, close } = open(); t.after(close);
  const text = "x".repeat(3_999) + "😀" + "y".repeat(4_100);
  const chunks = splitTelegram(text);
  assert.equal(chunks.join(""), text);
  assert.ok(chunks.every(chunk => chunk.length <= 4_000 && !/[\uD800-\uDBFF]$/.test(chunk)));
  store.enqueue("long", "telegram", text);
  assert.equal(store.readyDeliveries().length, 1);
  store.beginDelivery("long:0"); store.finishDelivery("long:0", "uncertain", "lost response");
  assert.equal(store.readyDeliveries().length, 0);
});

test("Telegram transport distinguishes actual acceptance, rejection and network ambiguity", async () => {
  const delivery: Delivery = { id: "d", groupId: "d", part: 0, channel: "telegram", text: "hello", status: "sending", createdAt: new Date().toISOString() };
  const config = { TELEGRAM_BOT_TOKEN: "test-token", TELEGRAM_CHAT_ID: "123" };
  const accepted = await sendTelegram(delivery, config, async () => Response.json({ ok: true, result: { message_id: 7 } }));
  assert.deepEqual(accepted, { status: "sent", messageId: 7 });
  assert.equal((await sendTelegram(delivery, config, async () => Response.json({ ok: false, error_code: 403 }, { status: 403 }))).status, "failed");
  let sends = 0;
  assert.equal((await sendTelegram(delivery, config, async () => { sends++; throw new Error("secret must not escape"); })).status, "uncertain");
  assert.equal(sends, 1);
  assert.equal((await sendTelegram(delivery, {})).status, "failed");
});

test("Telegram redirects cannot forward private messages or report delivery", async t => {
  let redirectedRequests = 0;
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) { /* Consume the submitted body. */ }
    if (request.url === "/send") {
      response.writeHead(307, { location: "/unexpected" });
      response.end();
    } else {
      redirectedRequests++;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, result: { message_id: 9 } }));
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); }));
  const address = server.address();
  assert(address && typeof address !== "string");
  const delivery: Delivery = { id: "redirect", groupId: "redirect", part: 0, channel: "telegram", text: "Private reminder", status: "sending", createdAt: new Date().toISOString() };
  const result = await sendTelegram(delivery, { TELEGRAM_BOT_TOKEN: "test-token", TELEGRAM_CHAT_ID: "123" }, (_url, init) => fetch(`http://127.0.0.1:${address.port}/send`, init));
  assert.equal(result.status, "uncertain");
  assert.equal(redirectedRequests, 0);
});

test("Telegram task admission requires the exact owner and private chat; bodies are bounded", async () => {
  const config = { TELEGRAM_OWNER_ID: "123", TELEGRAM_CHAT_ID: "123" };
  const update = { update_id: 4, message: { text: "hello", from: { id: 123, is_bot: false }, chat: { id: 123, type: "private" } } };
  assert.equal(telegramUpdate(update, config)?.kind, "message");
  assert.throws(() => telegramUpdate({ ...update, message: { ...update.message, from: { id: 456, is_bot: false } } }, config), StateError);
  assert.throws(() => telegramUpdate({ ...update, message: { ...update.message, chat: { id: 123, type: "group" } } }, config), StateError);
  await assert.rejects(readJson(new Request("https://local/", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "x".repeat(100) }) }), 50), StateError);
});

test("private credentials survive restart and serialize async refresh, login and delete", async t => {
  const directory = mkdtempSync(join(tmpdir(), "umpi-auth-")); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "state.sqlite");
  let opened = open(path);
  let credentials = new DurableCredentials(opened.db);
  await credentials.modify("openai-codex", async () => ({ type: "oauth", access: "first-private-access", refresh: "private-refresh", expires: 123 }));
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const refresh = credentials.modify("openai-codex", async current => { await gate; assert.equal(current?.type, "oauth"); return { ...current!, type: "oauth", access: "rotated-access", refresh: "rotated-refresh", expires: 456 }; });
  const login = credentials.modify("openai-codex", async current => { assert.equal(current?.type === "oauth" && current.access, "rotated-access"); return { type: "oauth", access: "new-login", refresh: "new-refresh", expires: 789 }; });
  release(); await Promise.all([refresh, login]);
  assert.deepEqual(await credentials.list(), [{ providerId: "openai-codex", type: "oauth" }]);
  assert.equal(JSON.stringify(await credentials.list()).includes("new-login"), false);
  opened.close(); opened = open(path); t.after(opened.close); credentials = new DurableCredentials(opened.db);
  const persisted = await credentials.read("openai-codex");
  assert.equal(persisted?.type === "oauth" && persisted.access, "new-login");
  assert.deepEqual(await credentials.modify("openai-codex", async () => undefined), persisted);
  await credentials.delete("openai-codex"); assert.equal(await credentials.read("openai-codex"), undefined);
});

test("control/executor authentication is separate and generic Agent routes remain closed", async () => {
  const env = { UMPI_CONTROL_TOKEN: "control-secret-".repeat(3), UMPI_EXECUTOR_TOKEN: "executor-secret-".repeat(3) };
  const request = (path: string, token?: string) => new Request(`https://local${path}`, { method: "POST", headers: token ? { authorization: `Bearer ${token}` } : {} });
  await authorize(request("/api/messages", env.UMPI_CONTROL_TOKEN), env);
  await authorize(request("/api/executor/poll", env.UMPI_EXECUTOR_TOKEN), env);
  await assert.rejects(authorize(request("/api/messages", env.UMPI_EXECUTOR_TOKEN), env), StateError);
  await assert.rejects(authorize(request("/api/executor/complete", env.UMPI_CONTROL_TOKEN), env), StateError);
  for (const [path, method] of [
    ["/api/core-context", "GET"], ["/api/core-context", "PUT"],
    ["/api/core-context/reviews", "GET"], ["/api/core-context/reviews/proposal", "GET"],
    ["/api/core-context/reviews/proposal/approve", "POST"], ["/api/core-context/reviews/proposal/reject", "POST"],
    ["/api/core-context/history", "GET"], ["/api/core-context/history/1", "GET"],
    ["/api/core-context/restore", "POST"],
  ]) {
    const memoryRequest = (token?: string) => new Request(`https://local${path}`, { method: method!, headers: token ? { authorization: `Bearer ${token}` } : {} });
    await authorize(memoryRequest(env.UMPI_CONTROL_TOKEN), env);
    for (const token of [undefined, env.UMPI_EXECUTOR_TOKEN]) {
      await assert.rejects(authorize(memoryRequest(token), env), (error: unknown) => error instanceof StateError && error.status === 401);
    }
  }
  await assert.rejects(authorize(request("/api/jobs/job-1/approve"), env), StateError);
  await assert.rejects(authorize(request("/agents/Assistant/owner", env.UMPI_CONTROL_TOKEN), env), StateError);
  await assert.rejects(authorize(request("/api/auth", env.UMPI_CONTROL_TOKEN), { ...env, UMPI_EXECUTOR_TOKEN: env.UMPI_CONTROL_TOKEN }), StateError);
  const telegram = { TELEGRAM_BOT_TOKEN: "bot", TELEGRAM_WEBHOOK_SECRET: "webhook-private", TELEGRAM_OWNER_ID: "123", TELEGRAM_CHAT_ID: "123" };
  await assert.rejects(authorize(request("/telegram/webhook"), telegram), StateError);
  await authorize(new Request("https://local/telegram/webhook", { method: "POST", headers: { "x-telegram-bot-api-secret-token": telegram.TELEGRAM_WEBHOOK_SECRET } }), telegram);
});

test("subagent state and cancellation are owner-only exact-method surfaces", async () => {
  const env = { UMPI_CONTROL_TOKEN: "control-secret-".repeat(3), UMPI_EXECUTOR_TOKEN: "executor-secret-".repeat(3), UMPI_BROWSER_SYNC_TOKEN: "browser-sync-secret-".repeat(3) };
  const request = (path: string, method: string, token?: string) => new Request(`https://example.test${path}`, { method, headers: token ? { authorization: `Bearer ${token}` } : {} });
  for (const [path, method] of [["/api/subagents", "GET"], ["/api/subagents/agent-1", "GET"], ["/api/subagents/agent-1/cancel", "POST"]]) {
    await authorize(request(path!, method!, env.UMPI_CONTROL_TOKEN), env);
    for (const token of [undefined, env.UMPI_EXECUTOR_TOKEN, env.UMPI_BROWSER_SYNC_TOKEN, "device-session"]) {
      await assert.rejects(authorize(request(path!, method!, token), env), { status: 401 });
    }
  }
  for (const [path, method] of [["/api/subagents", "POST"], ["/api/subagents/agent-1", "PUT"], ["/api/subagents/agent-1/cancel", "GET"], ["/api/subagents/agent-1/spawn", "POST"], ["/api/subagents/agent-1/approve", "POST"]]) {
    await assert.rejects(authorize(request(path!, method!, env.UMPI_CONTROL_TOKEN), env), { status: 404 });
  }
});
