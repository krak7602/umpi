import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import type { Database } from "../src/worker/store.js";
import { T3CodeStore, machineUrl, t3CodeTools, t3CallbackPage } from "../src/worker/t3-code.js";
import { authorize } from "../src/worker/transport.js";
import { companionRole } from "../src/worker/companion-routes.js";

const ORIGIN = "https://t3.example";
const UMPI = "https://umpi.example";

function database(t: TestContext): Database {
  const sqlite = new DatabaseSync(":memory:"); t.after(() => sqlite.close());
  return { all: <T extends object>(query: string, ...bindings: (string | number | null)[]) => sqlite.prepare(query).all(...bindings) as T[], transaction: run => run() };
}

/** A small T3 Code server: OAuth discovery, registration, token exchange, and the MCP tools Umpi reads. */
function fakeT3(options: { expiresIn?: number } = {}) {
  const codes = new Map<string, { challenge: string; redirect: string; client: string }>();
  const tokens = new Set<string>();
  const calls: string[] = [];
  const acted: { name: string; args: Record<string, unknown> }[] = [];
  const sessions = { opened: 0, closed: 0 };
  let issued = 0;
  const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
  const tool = (name: string, args: Record<string, unknown>) => {
    calls.push(name);
    if (name === "t3_environment_read") return { environmentId: "env-1", label: "Work Mac" };
    if (name === "t3_project_list") return { projects: [{ id: "p1", title: "umpi" }], nextCursor: 1 };
    if (name === "t3_thread_list") return { threads: [
      { threadId: "th-1", projectId: "p1", title: "Fix the widget", status: "running", settled: false, updatedAt: "2026-11-03T10:00:00Z", model: "m", link: "<t3-thread://x>" },
      { threadId: "th-2", projectId: "p1", title: "Review", status: "completed", settled: true, parentThreadId: "th-1" },
    ].slice(0, Number(args.limit ?? 20)), nextCursor: 2, total: 9 };
    if (["t3_thread_send", "t3_thread_launch", "t3_thread_interrupt"].includes(name) || (name === "t3_pending_request" && args.action === "respond")) {
      acted.push({ name, args });
      if (name === "t3_thread_launch") return { threads: [{ threadId: "th-new", status: "starting", title: args.title, model: "m" }] };
      return { ok: true };
    }
    if (name === "t3_pending_request" && args.action === "list") return { requestIds: ["q1"] };
    if (name === "t3_pending_request" && args.action === "read") return args.threadId === "th-2"
      ? { requestId: args.requestId, questions: [{ id: "db", header: "DB", question: "Which DB?", options: [{ label: "SQLite in memory", description: "Fast", value: "sqlite" }, { label: "Postgres", description: "" }] }] }
      : { requestId: args.requestId, questions: [{ id: "choice", question: "Which DB?", options: [] }] };
    if (name === "t3_thread_search") return { matches: [{ threadId: "th-1", projectId: "p1", title: "Fix the widget", snippet: "…the widget…", messageCreatedAt: "2026-11-03T09:00:00Z" }] };
    if (name === "t3_thread_read") {
      const after = Number(args.afterPosition ?? -1);
      const items = [0, 5, 900, 990].filter(position => position > after).map(position => ({ position, type: position % 2 ? "assistant_message" : "user_message", createdBy: position % 2 ? "agent" : "user", text: `message ${position}`, textTruncated: false, updatedAt: "2026-11-03T10:00:00Z" }));
      return { thread: { threadId: args.threadId, title: "Fix the widget", status: "running", itemCount: 1000 }, items: items.slice(0, Number(args.limit)), nextPosition: 1000, hasMore: false };
    }
    throw new Error(`unknown tool ${name}`);
  };
  const fetcher = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin !== ORIGIN) return new Response("wrong host", { status: 500 });
    if (url.pathname === "/.well-known/oauth-protected-resource/mcp") return json({ resource: `${ORIGIN}/mcp`, authorization_servers: [ORIGIN], scopes_supported: ["orchestration:read", "orchestration:operate"], bearer_methods_supported: ["header"] });
    if (url.pathname === "/.well-known/oauth-authorization-server") return json({ issuer: ORIGIN, authorization_endpoint: `${ORIGIN}/oauth/mcp/authorize`, token_endpoint: `${ORIGIN}/oauth/mcp/token`,
      registration_endpoint: `${ORIGIN}/oauth/mcp/register`, response_types_supported: ["code"], grant_types_supported: ["authorization_code"], code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none"] });
    if (url.pathname === "/oauth/mcp/register" && request.method === "POST") {
      const body = await request.json() as { redirect_uris: string[]; client_name: string };
      assert.equal(body.client_name, "Umpi");
      return json({ client_id: `client:${body.redirect_uris.join(",")}`, redirect_uris: body.redirect_uris, client_name: body.client_name, token_endpoint_auth_method: "none" }, 201);
    }
    if (url.pathname === "/oauth/mcp/token" && request.method === "POST") {
      const form = new URLSearchParams(await request.text());
      const pending = codes.get(form.get("code") ?? "");
      codes.delete(form.get("code") ?? "");
      const challenge = createHash("sha256").update(form.get("code_verifier") ?? "").digest("base64url");
      if (!pending || pending.challenge !== challenge || pending.redirect !== form.get("redirect_uri") || pending.client !== form.get("client_id") || form.get("grant_type") !== "authorization_code") return json({ error: "invalid_grant" }, 400);
      const token = `token-${++issued}`; tokens.add(token);
      return json({ access_token: token, token_type: "Bearer", expires_in: options.expiresIn ?? 30 * 86_400, scope: "orchestration:read" });
    }
    if (url.pathname === "/mcp") {
      const token = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
      if (!tokens.has(token)) return json({ error: "invalid_mcp_credential" }, 401, { "www-authenticate": `Bearer resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp", error="invalid_token"` });
      if (request.method === "DELETE") { sessions.closed++; return new Response(null, { status: 200 }); }
      const message = await request.json() as { id?: number; method: string; params?: { name: string; arguments: Record<string, unknown>; protocolVersion?: string } };
      if (message.method === "initialize") { sessions.opened++; return json({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: message.params!.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "T3 Code", version: "0.1.6" } } }, 200, { "mcp-session-id": `s${sessions.opened}` }); }
      if (message.id === undefined) return new Response(null, { status: 202 });
      if (message.method === "tools/call") {
        try { return json({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: JSON.stringify(tool(message.params!.name, message.params!.arguments)) }] } }); }
        catch (error) { return json({ jsonrpc: "2.0", id: message.id, result: { isError: true, content: [{ type: "text", text: (error as Error).message }] } }); }
      }
      return json({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "no" } });
    }
    return new Response("not found", { status: 404 });
  };
  /** The owner approves on the machine: T3 checks the request and sends the browser back with a code. */
  const approve = (authorizeUrl: string, decline = false): URL => {
    const url = new URL(authorizeUrl);
    assert.equal(url.origin + url.pathname, `${ORIGIN}/oauth/mcp/authorize`);
    assert.equal(url.searchParams.get("code_challenge_method"), "S256");
    assert.equal(url.searchParams.get("response_type"), "code");
    assert.equal(url.searchParams.get("resource"), `${ORIGIN}/mcp`);
    const redirect = new URL(url.searchParams.get("redirect_uri")!);
    redirect.searchParams.set("state", url.searchParams.get("state")!);
    if (decline) { redirect.searchParams.set("error", "access_denied"); return redirect; }
    const code = `code-${codes.size + 1}-${Math.random()}`;
    codes.set(code, { challenge: url.searchParams.get("code_challenge")!, redirect: url.searchParams.get("redirect_uri")!, client: url.searchParams.get("client_id")! });
    redirect.searchParams.set("code", code);
    return redirect;
  };
  return { fetcher, approve, calls, acted, sessions, revokeAll: () => tokens.clear() };
}

test("MCP addresses must be https and end in /mcp", () => {
  assert.equal(machineUrl("https://t3.example/mcp"), "https://t3.example/mcp");
  assert.equal(machineUrl("https://t3.example/"), "https://t3.example/mcp");
  assert.equal(machineUrl("https://t3.example/mcp/"), "https://t3.example/mcp");
  assert.equal(machineUrl("http://localhost:3773/mcp"), "http://localhost:3773/mcp");
  assert.throws(() => machineUrl("http://t3.example/mcp"), /https/);
  assert.throws(() => machineUrl("https://user:pw@t3.example/mcp"), /password/);
  assert.throws(() => machineUrl("https://t3.example/other"), /\/mcp/);
  assert.throws(() => machineUrl("not a url"), /MCP address/);
});

test("a machine is approved with PKCE, named from the machine, and read over MCP", async t => {
  const t3 = fakeT3();
  let now = Date.parse("2026-11-03T10:00:00Z");
  const store = new T3CodeStore(database(t), t3.fetcher, () => now);
  const started = await store.add({ url: `${ORIGIN}/mcp` }, UMPI);
  assert.equal(started.machine.status, "pending");
  assert.equal(new URL(new URL(started.authorizeUrl).searchParams.get("redirect_uri")!).href, `${UMPI}/t3/callback`);
  assert.equal(JSON.stringify(store.list()).includes("token"), false);

  const back = t3.approve(started.authorizeUrl);
  const finished = await store.finish(back.searchParams.get("state")!, back.searchParams.get("code")!, undefined);
  assert.equal(finished.ok, true);
  assert.equal(finished.label, "Work Mac");
  const [machine] = store.list();
  assert.equal(machine!.status, "connected");
  assert.equal(machine!.label, "Work Mac");
  assert.equal(machine!.expiresAt, "2026-12-03T10:00:00.000Z");
  // The same link cannot be used twice.
  assert.equal((await store.finish(back.searchParams.get("state")!, back.searchParams.get("code")!, undefined)).ok, false);

  const list = await store.threads(machine!.id, { limit: 5 });
  assert.equal(list.total, 9);
  assert.deepEqual(list.threads[0], { threadId: "th-1", title: "Fix the widget", status: "running", settled: false, projectId: "p1", project: "umpi", updatedAt: "2026-11-03T10:00:00Z", model: "m" });
  assert.equal(list.threads[1]!.subagent, true);
  const found = await store.search(machine!.id, "widget");
  assert.equal(found[0]!.snippet, "…the widget…");
  assert.equal(found[0]!.updatedAt, "2026-11-03T09:00:00Z");
  // The latest messages: the read starts near the end of the thread's 1000 items, and widens when that holds too few.
  const latest = await store.read(machine!.id, "th-1", { latest: true, limit: 2 });
  assert.deepEqual(latest.messages.map(item => item.position), [900, 990]);
  assert.equal(latest.messages[0]!.by, "user");
  const wider = await store.read(machine!.id, "th-1", { latest: true, limit: 3 });
  assert.deepEqual(wider.messages.map(item => item.position), [5, 900, 990]);
  const start = await store.read(machine!.id, "th-1", { limit: 10 });
  assert.deepEqual(start.messages.map(item => item.position), [0, 5, 900, 990]);
  // Each read opens a session and closes it.
  assert.equal(t3.sessions.opened, t3.sessions.closed);
  assert.deepEqual(store.status(), { machines: 1, connected: 1, pending: 0, expired: 0 });

  // After 30 days the access ends and the machine asks for approval again.
  now += 31 * 86_400_000;
  assert.equal(store.list()[0]!.status, "expired");
  await assert.rejects(store.threads(machine!.id), /approval again/);
});

test("a refused token marks the machine expired; approving again restores it", async t => {
  const t3 = fakeT3();
  const store = new T3CodeStore(database(t), t3.fetcher);
  const started = await store.add({ url: `${ORIGIN}/mcp`, label: "Laptop" }, UMPI);
  const back = t3.approve(started.authorizeUrl);
  await store.finish(back.searchParams.get("state")!, back.searchParams.get("code")!, undefined);
  assert.equal(store.list()[0]!.label, "Laptop");
  t3.revokeAll();
  await assert.rejects(store.threads(started.machine.id), /Approve Umpi again/);
  assert.equal(store.list()[0]!.status, "expired");

  const again = await store.connect(started.machine.id, UMPI);
  const back2 = t3.approve(again.authorizeUrl);
  assert.equal((await store.finish(back2.searchParams.get("state")!, back2.searchParams.get("code")!, undefined)).ok, true);
  assert.equal((await store.threads(started.machine.id)).threads.length, 2);
  // Adding the same address again restarts its approval instead of adding a second machine.
  await store.add({ url: `${ORIGIN}/mcp/` }, UMPI);
  assert.equal(store.list().length, 1);
  assert.equal(store.list()[0]!.status, "connected");
});

test("a declined or late approval does not connect", async t => {
  const t3 = fakeT3();
  let now = Date.parse("2026-11-03T10:00:00Z");
  const store = new T3CodeStore(database(t), t3.fetcher, () => now);
  const first = await store.add({ url: `${ORIGIN}/mcp` }, UMPI);
  const declined = t3.approve(first.authorizeUrl, true);
  const result = await store.finish(declined.searchParams.get("state")!, undefined, "access_denied");
  assert.equal(result.ok, false);
  assert.equal(store.list()[0]!.status, "failed");
  assert.match(store.list()[0]!.error!, /declined/);

  const second = await store.connect(first.machine.id, UMPI);
  now += 16 * 60_000;
  const late = t3.approve(second.authorizeUrl);
  assert.match((await store.finish(late.searchParams.get("state")!, late.searchParams.get("code")!, undefined)).message, /15 minutes/);
  assert.equal((await store.finish("unknown-state", "code", undefined)).ok, false);
  assert.equal(store.list()[0]!.status, "pending");
});

test("tools read every connected machine and explain what is missing", async t => {
  const t3 = fakeT3();
  const store = new T3CodeStore(database(t), t3.fetcher);
  const tools = new Map(t3CodeTools(store).map(tool => [tool.name, tool]));
  const run = async (name: string, input: object) => {
    const result = await (tools.get(name) as unknown as { execute(input: object): Promise<{ isError?: boolean; content: { text: string }[] }> }).execute(input);
    return { error: result.isError === true, body: result.content[0]!.text };
  };
  const none = await run("t3_code_threads", {});
  assert.equal(none.error, true);
  assert.match(none.body, /adds one in the app/);

  const started = await store.add({ url: `${ORIGIN}/mcp` }, UMPI);
  const back = t3.approve(started.authorizeUrl);
  await store.finish(back.searchParams.get("state")!, back.searchParams.get("code")!, undefined);
  const threads = JSON.parse((await run("t3_code_threads", { limit: 1 })).body);
  assert.equal(threads.machines[0].machine, "Work Mac");
  assert.equal(threads.machines[0].threads.length, 1);
  const read = JSON.parse((await run("t3_code_read_thread", { threadId: "th-1", machine: "work mac", limit: 2 })).body);
  assert.deepEqual(read.messages.map((item: { text: string }) => item.text), ["message 900", "message 990"]);
  const search = JSON.parse((await run("t3_code_search", { query: "widget" })).body);
  assert.equal(search.machines[0].threads[0].threadId, "th-1");
  const wrong = await run("t3_code_read_thread", { threadId: "th-1", machine: "Home" });
  assert.match(wrong.body, /Connected: Work Mac/);
});

test("the approval callback is public and its page escapes the machine name", async () => {
  await authorize(new Request(`${UMPI}/t3/callback?state=x&code=y`), {});
  await assert.rejects(authorize(new Request(`${UMPI}/t3/callback?state=x`, { method: "POST" }), {}));
  const page = await t3CallbackPage({ ok: true, label: "<b>Mac</b>", message: "ok" }).text();
  assert.match(page, /Connected to &#60;b&#62;Mac/);
  assert.equal(companionRole("/api/device/t3", "GET"), "device");
  assert.equal(companionRole("/api/device/t3/machines", "POST"), "device");
  assert.equal(companionRole("/api/device/t3/machines/t3-abc/connect", "POST"), "device");
  assert.equal(companionRole("/api/device/t3/machines/t3-abc", "DELETE"), "device");
  assert.equal(companionRole("/api/device/t3/machines/t3-abc", "GET"), undefined);
});

test("tailnet addresses go through the bridge; other addresses go direct", async () => {
  const { tailnetFetch } = await import("../src/worker/tailnet-fetch.js");
  const seen: string[] = [];
  const bridge = () => ({ async fetch(request: Request) { seen.push(`bridge ${request.method} ${request.headers.get("x-umpi-target")} ${request.headers.get("authorization")} ${await request.text()}`); return new Response("ok"); } });
  const direct: typeof fetch = async input => { seen.push(`direct ${new Request(input).url}`); return new Response("ok"); };
  const via = tailnetFetch(bridge, direct);
  await via("https://mac.example.ts.net/mcp", { method: "POST", headers: { authorization: "Bearer t" }, body: "{}" });
  await via("https://connect.example/mcp");
  await via("http://mac.example.ts.net/mcp");
  assert.deepEqual(seen, ["bridge POST https://mac.example.ts.net/mcp Bearer t {}", "direct https://connect.example/mcp", "direct http://mac.example.ts.net/mcp"]);
  await assert.rejects(tailnetFetch(undefined, direct)("https://mac.example.ts.net/mcp"), /bridge is not configured/);
});

test("a request a stopping bridge did not forward goes to the next bridge; nothing else is sent twice", async () => {
  const { sendPastDrain } = await import("../src/worker/tailnet-fetch.js");
  const draining = () => new Response("{}", { status: 503, headers: { "x-umpi-bridge": "draining" } });
  const bridge = (runningFor: number) => { let checks = 0; return { running: () => checks++ < runningFor, wait: async () => undefined }; };

  // Not forwarded by the old bridge: sent again once the old container has exited.
  let sends = 0;
  const answers = [draining(), new Response("fresh")];
  const resent = await sendPastDrain(async () => { sends++; return answers.shift()!; }, bridge(3));
  assert.equal(await resent.text(), "fresh");
  assert.equal(sends, 2);

  // An error with an unknown outcome (the container vanished mid-request) is never sent again.
  sends = 0;
  const lost = await sendPastDrain(async () => { sends++; return new Response("Container suddenly disconnected, try again", { status: 500 }); }, bridge(0));
  assert.equal(lost.status, 500);
  assert.equal(sends, 1);

  // An old bridge that does not exit in time: the caller gets the draining answer, not a second send.
  sends = 0;
  const stuck = await sendPastDrain(async () => { sends++; return draining(); }, bridge(Number.MAX_SAFE_INTEGER), 0);
  assert.equal(stuck.headers.get("x-umpi-bridge"), "draining");
  assert.equal(sends, 1);
});

async function connected(t: TestContext) {
  const t3 = fakeT3();
  const db = database(t);
  const store = new T3CodeStore(db, t3.fetcher);
  const started = await store.add({ url: `${ORIGIN}/mcp` }, UMPI);
  const back = t3.approve(started.authorizeUrl);
  await store.finish(back.searchParams.get("state")!, back.searchParams.get("code")!, undefined);
  return { t3, db, store, id: started.machine.id };
}

test("thread actions reach T3 Code with an idempotency key; projects resolve by name", async t => {
  const { t3, store, id } = await connected(t);
  await store.act(id, { kind: "send", threadId: "th-1", message: "commit and push" }, "umpi-call-1");
  await store.act(id, { kind: "stop", threadId: "th-1", reason: "wrong approach" }, "umpi-call-2");
  const started = await store.act(id, { kind: "start", title: "Fix login", message: "Fix the login bug", project: "UMPI", branch: "fix/login" }, "umpi-call-3");
  await store.act(id, { kind: "answer", threadId: "th-1", requestId: "q1", answers: { choice: "sqlite" } }, "umpi-call-4");
  assert.deepEqual(started, { threadId: "th-new", title: "Fix login", status: "starting", model: "m" });
  assert.deepEqual(t3.acted.map(item => item.name), ["t3_thread_send", "t3_thread_interrupt", "t3_thread_launch", "t3_pending_request"]);
  assert.deepEqual(t3.acted[0]!.args, { threadId: "th-1", message: "commit and push", mode: "auto", clientRequestId: "umpi-call-1" });
  assert.equal(t3.acted[1]!.args.stop, true);
  assert.deepEqual(t3.acted[2]!.args, { title: "Fix login", message: "Fix the login bug", clientRequestId: "umpi-call-3", projectId: "p1", workspaceStrategy: { type: "worktree", branch: "fix/login" } });
  await assert.rejects(store.act(id, { kind: "start", title: "x", message: "y", project: "nope" }, "umpi-call-5"), /No project called "nope"\. Projects: umpi/);
  const questions = await store.questions(id, "th-1");
  assert.deepEqual(questions.requests, [{ requestId: "q1", questions: [{ id: "choice", question: "Which DB?", options: [] }] }]);
});

test("an action Umpi decided on waits for Approve; Decline and second presses change nothing", async t => {
  const { t3, db, store } = await connected(t);
  const { Store } = await import("../src/worker/store.js");
  const { T3ActionRequests, parseAction } = await import("../src/worker/t3-actions.js");
  const owner = new Store(db);
  const requests = new T3ActionRequests(db, owner, store);
  const first = requests.request(undefined, parseAction({ kind: "send", threadId: "th-2", message: "Run the tests again" }), "The thread has waited an hour.");
  const second = requests.request("Work Mac", parseAction({ kind: "stop", threadId: "th-1" }), "It is looping.", "Fix the widget");
  assert.equal(second.summary, "Stop a thread.\nMachine: Work Mac (t3.example)\nThread ID: th-1\nThread title, as Umpi gave it (not checked): Fix the widget\nScope: the whole thread, like T3 Code's Stop button\nWhy, in Umpi's words: It is looping.");
  assert.equal(requests.pending().length, 2);
  const buttons = (id: string) => owner.deliveries(`t3-request:${id}`)[0]!.replyMarkup!.inline_keyboard[0]!.map(button => button.callback_data);
  const [approve, decline] = buttons(first.id);
  assert.equal(owner.deliveries(`t3-request:${first.id}`)[0]!.text, "T3 Code: may Umpi do this?\n\nSend a message to a thread.\nMachine: Work Mac (t3.example)\nThread ID: th-2\nMode: auto\nWhy, in Umpi's words: The thread has waited an hour.\n\nThe message, complete (19 characters):\n\nRun the tests again");
  // A press must come from the message that carried the button.
  await assert.rejects(requests.press(approve!, undefined, `t3-request:${second.id}`), /does not belong/);
  assert.equal(t3.acted.length, 0);
  const done = await requests.press(approve!, undefined, `t3-request:${first.id}`);
  assert.equal(done!.text, "Done on Work Mac.");
  assert.deepEqual(t3.acted.map(item => [item.name, item.args.clientRequestId]), [["t3_thread_send", `umpi-${first.id}`]]);
  assert.equal((await requests.press(decline!, undefined, `t3-request:${first.id}`))!.text, "Already done.");
  assert.equal((await requests.press(buttons(second.id)[1]!, undefined, `t3-request:${second.id}`))!.text, "Declined. Nothing was changed.");
  assert.equal(t3.acted.length, 1);
  assert.equal(requests.pending().length, 0);
  assert.match(owner.deliveries(`t3-request:${first.id}:outcome`)[0]!.text, /Done on Work Mac/);
  assert.equal(await requests.press("other:token", 1), undefined);
  assert.throws(() => parseAction({ kind: "send", threadId: "th-1" }), /message/);
  assert.throws(() => parseAction({ kind: "delete" }), /kind must be/);
});

test("an approval card shows the whole action, names the thread and machine, and refuses what it cannot show", async t => {
  const { t3, db, store } = await connected(t);
  const { Store } = await import("../src/worker/store.js");
  const { T3ActionRequests, T3_APPROVAL_TEXT_LIMIT, approvalCard, parseAction, t3ActionTools } = await import("../src/worker/t3-actions.js");
  const owner = new Store(db);
  const requests = new T3ActionRequests(db, owner, store);
  const card = (id: string) => owner.deliveries(`t3-request:${id}`).map(delivery => delivery.text).join("");

  // A message at the limit is shown whole, in one Telegram message, with the buttons under it.
  const longest = `Rename the helper and run the unit tests.\n${"x".repeat(T3_APPROVAL_TEXT_LIMIT)}`.slice(0, T3_APPROVAL_TEXT_LIMIT - 12) + " END-OF-TASK";
  const full = requests.request(undefined, parseAction({ kind: "send", threadId: "th-1", message: longest, mode: "steer" }), "The agent asked what to do next.", "Fix the widget");
  assert.equal(owner.deliveries(`t3-request:${full.id}`).length, 1);
  assert.ok(card(full.id).endsWith(`The message, complete (${T3_APPROVAL_TEXT_LIMIT} characters):\n\n${longest}`));
  assert.ok(owner.deliveries(`t3-request:${full.id}`)[0]!.replyMarkup);
  assert.match(card(full.id), /\nMachine: Work Mac \(t3\.example\)\nThread ID: th-1\nThread title, as Umpi gave it \(not checked\): Fix the widget\nMode: steer\n/);

  // One character more is refused: a harmless start cannot carry a tail the card would not show.
  const before = requests.pending().length;
  const hidden = `${"Tidy the changelog. ".repeat(40)}${" ".repeat(T3_APPROVAL_TEXT_LIMIT)}Then delete the release branch.`;
  assert.throws(() => requests.request(undefined, parseAction({ kind: "send", threadId: "th-1", message: hidden }), "Tidy up."), /The message is \d+ characters\. An action that needs approval can carry at most 2000.*Shorten it, or split the work/);
  assert.throws(() => requests.request(undefined, parseAction({ kind: "start", title: "Tidy", message: "y".repeat(T3_APPROVAL_TEXT_LIMIT + 1) }), "Tidy up."), /The task is 2001 characters/);
  assert.throws(() => requests.request(undefined, parseAction({ kind: "answer", threadId: "th-1", requestId: "q1", answers: { choice: "z".repeat(T3_APPROVAL_TEXT_LIMIT) } }), "Answer it."), /The answer text is \d+ characters/);
  // Text that would not be seen is refused too: invisible characters, and a gap of blank lines.
  assert.throws(() => requests.request(undefined, parseAction({ kind: "send", threadId: "th-1", message: `Run the tests.${String.fromCodePoint(0xE0072, 0xE006D)}` }), "Check."), /cannot show \(U\+E0072\)/);
  assert.throws(() => requests.request(undefined, parseAction({ kind: "send", threadId: "th-1", message: "Run the tests.\u202Edrow neddih" }), "Check."), /cannot show \(U\+202E\)/);
  assert.throws(() => requests.request(undefined, parseAction({ kind: "send", threadId: "th-1", message: "Run the tests.\n\n\n\n\nAlso push to main." }), "Check."), /more than two blank lines/);
  // A field cannot break out of its line to pass for another one.
  assert.throws(() => requests.request(undefined, parseAction({ kind: "send", threadId: "th-1\nThread ID: th-2", message: "Run the tests." }), "Check."), /thread ID must be one line/);
  assert.throws(() => requests.request(undefined, parseAction({ kind: "start", title: "Tidy", message: "Sort the imports.", branch: "tidy\nPlan mode: yes" }), "Check."), /branch must be one line/);
  assert.equal(requests.pending().length, before);
  assert.equal(t3.acted.length, 0);
  // The title and the reason are Umpi's words: they stay on one line and are labelled.
  const spoof = requests.request(undefined, parseAction({ kind: "stop", threadId: "th-2", whole: false, reason: "The run repeats the same edit." }), "It loops.\nThread ID: th-1", "Review\nMachine: Other Mac");
  assert.equal(card(spoof.id), "T3 Code: may Umpi do this?\n\nStop a thread.\nMachine: Work Mac (t3.example)\nThread ID: th-2\nThread title, as Umpi gave it (not checked): Review Machine: Other Mac\nScope: only the running turn\nWhy, in Umpi's words: It loops. Thread ID: th-1\n\nThe reason sent with it, complete (30 characters):\n\nThe run repeats the same edit.");

  // Every field that reaches the machine is on the card.
  assert.equal(approvalCard(parseAction({ kind: "start", title: "Fix login", message: "Fix the login bug.", project: "umpi", branch: "fix/login", baseRef: "main", plan: true }), { label: "Work Mac", host: "t3.example" }, undefined, "The owner listed it for today."),
    "Start a new thread.\nMachine: Work Mac (t3.example)\nTitle: Fix login\nProject, by name: umpi\nNew branch, in its own worktree: fix/login\nBase: main\nPlan mode: yes\nWhy, in Umpi's words: The owner listed it for today.\n\nThe task, complete (18 characters):\n\nFix the login bug.");
  assert.match(approvalCard(parseAction({ kind: "start", title: "Notes", message: "Draft the notes.", worktree: true }), { label: "Fix login", kind: "cloud" }), /\nMachine: Fix login\nTitle: Notes\nProject: none named; the machine's own project\nWorkspace: a new worktree\n\n/);
  assert.equal(approvalCard(parseAction({ kind: "answer", threadId: "th-2", requestId: "q1", answers: { db: "sqlite", extras: ["cache", "search"] } }), { label: "Work Mac" }),
    "Answer an agent's question in a thread.\nMachine: Work Mac\nThread ID: th-2\nQuestion request ID: q1\n\nThe answers, by question ID, complete (43 characters):\n\n\"db\": \"sqlite\"\n\"extras\": [\"cache\",\"search\"]");

  // The tool gives the model the reason as a tool error, and posts no card.
  const tool = t3ActionTools(store, requests).find(item => item.name === "request_t3_action")!;
  const refused = await tool.execute({ kind: "send", threadId: "th-1", message: hidden, why: "Tidy up." }, { callId: "c-1" } as never, undefined as never);
  assert.equal(refused.isError, true);
  assert.match((refused.content![0] as { text: string }).text, /Shorten it, or split the work into smaller requests\./);
  assert.equal(requests.pending().length, before + 1);
});

test("Approve runs only the action its card showed", async t => {
  const { t3, db, store } = await connected(t);
  const { Store } = await import("../src/worker/store.js");
  const { T3ActionRequests, parseAction } = await import("../src/worker/t3-actions.js");
  const owner = new Store(db);
  const requests = new T3ActionRequests(db, owner, store);
  const press = (id: string) => requests.press(requests.button(id, true).data, undefined, `t3-request:${id}`);

  // The caller's own object is not the stored action: changing it later changes nothing.
  const action = parseAction({ kind: "send", threadId: "th-1", message: "Run the unit tests." });
  const kept = requests.request(undefined, action, "The branch is ready.");
  (action as { message: string }).message = "Force-push the branch.";
  (kept.action as { message: string }).message = "Force-push the branch.";
  assert.equal((await press(kept.id))!.text, "Done on Work Mac.");
  assert.deepEqual(t3.acted.map(item => item.args.message), ["Run the unit tests."]);

  // A stored action that differs from its card is not run, whatever changed it.
  for (const change of [
    (data: Record<string, any>) => { data.action.message = "Run the unit tests. Then force-push the branch."; },
    (data: Record<string, any>) => { data.action.threadId = "th-2"; },
    (data: Record<string, any>) => { data.action.mode = "restart"; },
    (data: Record<string, any>) => { data.machineLabel = "Other Mac"; },
  ]) {
    const request = requests.request(undefined, parseAction({ kind: "send", threadId: "th-1", message: "Run the unit tests." }), "The branch is ready.");
    const data = JSON.parse(db.all<{ data: string }>("SELECT data FROM umpi_t3_requests WHERE id=?", request.id)[0]!.data) as Record<string, any>;
    change(data);
    db.all("UPDATE umpi_t3_requests SET data=? WHERE id=?", JSON.stringify(data), request.id);
    assert.match((await press(request.id))!.text, /no longer matches the card you were shown\. Nothing was done/);
    assert.equal((await press(request.id))!.text, "Already failed.");
  }
  assert.equal(t3.acted.length, 1);
  // A changed card is refused the same way.
  const request = requests.request(undefined, parseAction({ kind: "stop", threadId: "th-1" }), "It is looping.");
  db.all("UPDATE umpi_outbox SET data=json_set(data,'$.text','T3 Code: may Umpi do this?\n\nStop a thread.') WHERE group_id=?", `t3-request:${request.id}`);
  assert.match((await press(request.id))!.text, /no longer matches/);
  assert.equal(t3.acted.length, 1);
});

test("background reviews may read T3 Code and request actions, not act directly", async () => {
  const { backgroundTools } = await import("../src/worker/proactive-runtime.js");
  for (const name of ["t3_code_threads", "t3_code_read_thread", "t3_code_search", "t3_code_questions", "request_t3_action"]) assert.equal(backgroundTools.has(name), true, name);
  for (const name of ["t3_code_send", "t3_code_start", "t3_code_stop", "t3_code_answer"]) assert.equal(backgroundTools.has(name), false, name);
});

test("the app's own thread actions are device routes", () => {
  assert.equal(companionRole("/api/device/t3/act", "POST"), "device");
  assert.equal(companionRole("/api/device/t3/act", "GET"), undefined);
});

test("an approval push carries its category and both buttons", async () => {
  const { generateKeyPairSync } = await import("node:crypto");
  const { sendCompanionPush } = await import("../src/worker/companion-push.js");
  const keys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const config = { APNS_TEAM_ID: "TESTTEAM00", APNS_KEY_ID: "TESTKEY000", APNS_PRIVATE_KEY: keys.privateKey.export({ format: "pem", type: "pkcs8" }).toString(), APNS_BUNDLE_ID: "com.example.umpi" };
  const sent: Record<string, unknown>[] = [];
  const transport = (async (_url: string | URL, init?: RequestInit) => { sent.push(JSON.parse(String(init!.body))); return new Response(null, { status: 200, headers: { "apns-id": "123e4567-e89b-12d3-a456-426614174000" } }); }) as typeof fetch;
  await sendCompanionPush({ deviceId: "phone-1", apnsToken: "ab".repeat(32), apnsEnvironment: "sandbox" },
    { revision: 0, jobs: [], message: { body: "T3 Code: may Umpi do this?", seq: 7, approval: { request: "t3r-1" } } }, config, { fetch: transport });
  assert.equal((sent[0]!.aps as Record<string, unknown>).category, "UMPI_APPROVAL");
  assert.deepEqual(sent[0]!.approval, { request: "t3r-1" });
  assert.equal(sent[0]!.chat, 7);
});

test("pending questions keep their choices", async t => {
  const { store, id } = await connected(t);
  const read = await store.questions(id, "th-2");
  assert.deepEqual(read.requests[0]!.questions[0]!.options, [{ label: "SQLite in memory", description: "Fast", value: "sqlite" }, { label: "Postgres" }]);
  assert.equal(read.requests[0]!.questions[0]!.header, "DB");
});
