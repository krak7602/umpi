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
  return { fetcher, approve, calls, sessions, revokeAll: () => tokens.clear() };
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
