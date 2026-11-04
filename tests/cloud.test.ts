import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import type { Database } from "../src/worker/store.js";
import { T3CodeStore } from "../src/worker/t3-code.js";
import { CloudMachines, githubRemote, CLOUD_MAX_AWAKE, type CloudMachineStart } from "../src/worker/cloud-machines.js";
import { asProviderContext, cloudModelRequest, piMessagesEvent } from "../src/worker/cloud-model.js";
import { cloudFetch } from "../src/worker/tailnet-fetch.js";
import { cloudflareDns } from "../src/worker/cloudflare-dns.js";

function database(t: TestContext): Database {
  const sqlite = new DatabaseSync(":memory:"); t.after(() => sqlite.close());
  return { all: <T extends object>(query: string, ...bindings: (string | number | null)[]) => sqlite.prepare(query).all(...bindings) as T[], transaction: run => run() };
}

/** A cloud machine's T3 Code over MCP, as its Durable Object relays it. */
function fakeMachine() {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  let status = "running";
  const json = (body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json", ...headers } });
  const tool = (name: string, args: Record<string, unknown>) => {
    calls.push({ name, args });
    if (name === "t3_project_create") return { id: "proj-1", title: args.title };
    if (name === "t3_thread_launch") return { threads: [{ threadId: "th-1", status: "starting", title: args.title }] };
    if (name === "t3_project_list") return { projects: [{ id: "proj-1", title: "app" }] };
    if (name === "t3_thread_list") return { threads: [{ threadId: "th-1", projectId: "proj-1", title: "Fix login", status, settled: false }] };
    return { ok: true };
  };
  const fetch = async (request: Request) => {
    assert.equal(new URL(request.url).pathname, "/t3/mcp");
    if (request.method === "DELETE") return new Response(null, { status: 200 });
    if (request.method === "GET") return new Response(null, { status: 405 });
    const message = await request.json() as { id?: number; method: string; params?: { name: string; arguments: Record<string, unknown>; protocolVersion?: string } };
    if (message.method === "initialize") return json({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: message.params!.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "t3", version: "0" } } }, { "mcp-session-id": "s" });
    if (message.id === undefined) return new Response(null, { status: 202 });
    return json({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: JSON.stringify(tool(message.params!.name, message.params!.arguments)) }] } });
  };
  return { fetch, calls, finish: () => { status = "completed"; } };
}

function fixture(t: TestContext) {
  const machine = fakeMachine();
  const events: string[] = [];
  const running = new Set<string>();
  let now = Date.parse("2026-11-04T10:00:00Z");
  const app = { sockets: 0, appAt: 0 };
  const published = new Map<string, string>();
  const stopping = new Set<string>();
  const t3 = new T3CodeStore(database(t), cloudFetch(() => machine, async () => { throw new Error("no other machines"); }), () => now);
  const start: Omit<CloudMachineStart, "modelToken"> = { modelUrl: "https://umpi.example/api/cloud/model", models: [{ id: "claude-x", name: "X", reasoning: true, input: ["text"], contextWindow: 1000, maxTokens: 100 }], defaultModel: "claude-x" };
  const cloud = new CloudMachines(database(t), t3, {
    stub: id => ({
      async wake(input, key) { events.push(`wake ${id} ${key} token:${input.modelToken.length}`); running.add(id); return { token: "mcp-token", restored: false }; },
      async save() { events.push(`save ${id}`); running.delete(id); return { size: 1234 }; },
      async discard() { events.push(`discard ${id}`); running.delete(id); },
      isRunning: () => running.has(id),
      condition: () => ({ running: running.has(id), stopping: running.has(id) && stopping.has(id) }),
      async publish(hostname) { published.set(id, hostname); },
      async pairing(baseUrl) { events.push(`pair ${id} ${baseUrl}`); return { pairUrl: `${baseUrl}/pair#token=one-time`, expiresAt: "2026-11-04T10:15:00Z" }; },
      inUse: () => app,
    }),
    start: () => start,
    deleteSaved: async key => { events.push(`delete ${key}`); },
    publicDomain: () => "example.com",
    dns: () => ({ async add(hostname) { events.push(`dns add ${hostname}`); }, async remove(hostname) { events.push(`dns remove ${hostname}`); } }),
  }, () => now);
  return { cloud, t3, machine, events, running, app, published, stopping, now: () => now, advance: (ms: number) => { now += ms; } };
}

test("GitHub repositories are cloned over SSH", () => {
  assert.deepEqual(githubRemote("example-org/app"), { remote: "git@github.com:example-org/app.git", name: "app" });
  assert.deepEqual(githubRemote("https://github.com/me/site.git"), { remote: "git@github.com:me/site.git", name: "site" });
  assert.deepEqual(githubRemote("git@github.com:me/site"), { remote: "git@github.com:me/site.git", name: "site" });
  assert.throws(() => githubRemote("https://gitlab.com/me/site"), /owner\/name/);
});

test("a cloud machine is created, used, put to sleep when idle, listed without waking, and woken by use", async t => {
  const { cloud, t3, machine, events, advance } = fixture(t);
  const created = await cloud.create({ title: "Fix login", task: "Fix the login bug", repo: "example-org/app", branch: "fix/login" });
  assert.equal(created.threadId, "th-1");
  assert.equal(created.machine.status, "awake");
  assert.match(events[0]!, /^wake cloud-[a-z0-9]{10} cloud-machines\/cloud-[a-z0-9]{10}\/state\.tar\.zst token:43$/);
  assert.deepEqual(machine.calls.map(call => call.name), ["t3_project_clone", "t3_project_create", "t3_thread_launch"]);
  assert.deepEqual(machine.calls[0]!.args, { destinationPath: "/home/agent/work/app", remoteUrl: "git@github.com:example-org/app.git", protocol: "ssh" });
  assert.deepEqual(machine.calls[2]!.args.modelSelection, { provider: "pi", model: "default" });
  assert.deepEqual(machine.calls[2]!.args.workspaceStrategy, { type: "worktree", branch: "fix/login" });
  // It is a T3 Code machine like any other.
  const listed = t3.list()[0]!;
  assert.equal(listed.kind, "cloud");
  assert.equal(listed.label, "Fix login");
  // The gateway knows the machine by its own token.
  const token = (cloud as unknown as { token(id: string): string }).token(created.machine.id);
  assert.equal(cloud.machineFor(token), created.machine.id);
  assert.equal(cloud.machineFor("nope"), undefined);

  // Working: no sleep. Then two idle checks after the thread finishes put it to sleep.
  advance(200_000); await cloud.drive();
  assert.equal(cloud.list()[0]!.status, "awake");
  machine.finish();
  advance(120_000); await cloud.drive();
  assert.equal(cloud.list()[0]!.status, "awake");
  // Frequent coordinator runs do not count as more checks.
  await cloud.drive(); await cloud.drive();
  assert.equal(cloud.list()[0]!.status, "awake");
  advance(120_000); await cloud.drive();
  assert.equal(cloud.list()[0]!.status, "asleep");
  assert.ok(events.includes(`save ${created.machine.id}`));
  assert.equal(cloud.nextDue(), undefined);

  // Listing shows the threads it had, without waking it.
  const calls = machine.calls.length;
  const overview = await t3.overview();
  assert.equal(overview.machines[0]!.asleep, true);
  assert.equal(overview.machines[0]!.threads![0]!.status, "completed");
  assert.equal(machine.calls.length, calls);
  assert.equal(events.filter(event => event.startsWith("wake")).length, 1);

  // Reading a thread wakes it.
  await t3.read(created.machine.id, "th-1", { limit: 5 });
  assert.equal(events.filter(event => event.startsWith("wake")).length, 2);
  assert.equal(cloud.list()[0]!.status, "awake");

  await cloud.remove(created.machine.id);
  assert.deepEqual(events.slice(-2), [`discard ${created.machine.id}`, `delete cloud-machines/${created.machine.id}/state.tar.zst`]);
  assert.equal(t3.list().length, 0);
  assert.equal(cloud.list().length, 0);
});

test("at most a few machines are awake at once", async t => {
  const { cloud } = fixture(t);
  for (let index = 0; index < CLOUD_MAX_AWAKE; index++) await cloud.create({ title: `Task ${index}`, task: "work" });
  await assert.rejects(cloud.create({ title: "One more", task: "work" }), /already awake/);
  assert.equal(cloud.list().length, CLOUD_MAX_AWAKE, "nothing half-made is left behind");
});

test("the gateway maps pi-ai events to pi-messages and refuses unknown machines", async () => {
  const partial = { role: "assistant", content: [{ type: "thinking", thinking: "t", thinkingSignature: "sig" }, { type: "toolCall", id: "call-1", name: "read", arguments: {} }], usage: {} } as never;
  assert.deepEqual(piMessagesEvent({ type: "thinking_end", contentIndex: 0, content: "t", partial }), { type: "thinking_end", contentIndex: 0, content: "t", contentSignature: "sig" });
  assert.deepEqual(piMessagesEvent({ type: "toolcall_start", contentIndex: 1, partial }), { type: "toolcall_start", contentIndex: 1, id: "call-1", toolName: "read" });
  const usage = { input: 1, output: 2 } as never;
  assert.deepEqual(piMessagesEvent({ type: "done", reason: "stop", message: { usage, responseId: "r1" } as never }), { type: "done", reason: "stop", usage, responseId: "r1" });

  const model = { id: "claude-x", api: "anthropic-messages", provider: "anthropic" };
  const seen: { context?: unknown } = {};
  const models = {
    getModel: (provider: string, id: string) => provider === "anthropic" && id === "claude-x" ? model : undefined,
    streamSimple: (_model: unknown, context: unknown) => { seen.context = context; return (async function* () {
      yield { type: "start", partial };
      yield { type: "text_delta", contentIndex: 0, delta: "hi", partial };
      yield { type: "done", reason: "stop", message: { usage } };
    })(); },
  } as never;
  const gateway = { models, machineFor: (token: string) => token === "t".repeat(30) ? "cloud-1" : undefined };
  const request = (token: string) => new Request("https://umpi.example/api/cloud/model/messages", { method: "POST", headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify({ model: "claude-x", context: { messages: [{ role: "assistant", api: "pi-messages", provider: "umpi", model: "claude-x", content: [] }] }, options: {} }) });
  await assert.rejects(cloudModelRequest(request("x".repeat(30)), gateway), /Unknown cloud machine/);
  const response = await cloudModelRequest(request("t".repeat(30)), gateway);
  const lines = (await response.text()).split("\n\n").filter(Boolean).map(line => JSON.parse(line.slice(5)));
  assert.deepEqual(lines.map(line => line.type), ["start", "text_delta", "done"]);
  // Earlier turns are named for the real provider again.
  assert.equal((seen.context as { messages: { api: string; provider: string }[] }).messages[0]!.api, "anthropic-messages");
  assert.equal(asProviderContext({ messages: [] } as never, model as never).messages.length, 0);
});

test("the app's cloud machine controls are device routes", async () => {
  const { companionRole } = await import("../src/worker/companion-routes.js");
  assert.equal(companionRole("/api/device/cloud/cloud-abc123def0/wake", "POST"), "device");
  assert.equal(companionRole("/api/device/cloud/cloud-abc123def0/sleep", "POST"), "device");
  assert.equal(companionRole("/api/device/cloud/cloud-abc123def0", "DELETE"), "device");
  assert.equal(companionRole("/api/device/cloud/other/wake", "POST"), undefined);
});

test("a machine whose container stopped unexpectedly wakes again from its last save", async t => {
  const { cloud, t3, events, running } = fixture(t);
  const { machine } = await cloud.create({ title: "Task", task: "work" });
  running.clear();
  await cloud.drive();
  assert.equal(cloud.list()[0]!.status, "asleep");
  assert.match(cloud.list()[0]!.error!, /stopped unexpectedly/);
  await t3.read(machine.id, "th-1", { limit: 3 });
  assert.equal(events.filter(event => event.startsWith("wake")).length, 2);
  assert.equal(cloud.list()[0]!.status, "awake");
});

test("a machine opens in the owner's T3 Code app at its own address; a connected app keeps it awake for a while", async t => {
  const { cloud, events, running, app, published, now, advance, machine: t3 } = fixture(t);
  const { machine } = await cloud.create({ title: "Fix login", task: "Fix the login bug" });
  const host = `${machine.id.slice("cloud-".length)}-umpi.example.com`;
  await cloud.sleep(machine.id);
  events.length = 0;
  const opened = await cloud.open(machine.id);
  assert.deepEqual(opened, { address: `https://${host}`, pairUrl: `https://${host}/pair#token=one-time`, expiresAt: "2026-11-04T10:15:00Z", firstTime: true });
  assert.deepEqual(events.map(event => event.replace(/ cloud-machines.*/, "")), [`dns add ${host}`, `wake ${machine.id}`, `pair ${machine.id} https://${host}`], "a sleeping machine is woken to pair");
  assert.equal(published.get(machine.id), host);
  events.length = 0;
  assert.equal((await cloud.open(machine.id)).firstTime, false);
  assert.ok(!events.some(event => event.startsWith("dns")), "the name is made once");

  // Idle threads, but the app is connected and in use: it stays awake, up to two hours after its threads last worked.
  t3.finish();
  const idle = async () => { advance(125_000); await cloud.drive(); };
  for (let i = 0; i < 3; i++) await idle();
  assert.equal(running.has(machine.id), false, "nothing working and no app: it sleeps");
  await cloud.ensureAwake(machine.id);
  app.sockets = 1;
  for (let i = 0; i < 6; i++) { app.appAt = now(); await idle(); }
  assert.equal(running.has(machine.id), true, "the app in use keeps it awake");
  advance(11 * 60_000); await idle(); await idle(); await idle();
  assert.equal(running.has(machine.id), false, "an app left open but unused does not");
  await cloud.ensureAwake(machine.id);
  for (let i = 0; i < 70; i++) { app.appAt = now(); await idle(); }
  assert.equal(running.has(machine.id), false, "nor does one used for over two hours with no thread working");
  // Woken again later (threads last worked hours ago), the app keeps it awake from the wake on.
  await cloud.ensureAwake(machine.id);
  for (let i = 0; i < 6; i++) { app.appAt = now(); await idle(); }
  assert.equal(running.has(machine.id), true, "the two hours count from the wake, not from old work");

  events.length = 0;
  await cloud.remove(machine.id);
  assert.ok(events.includes(`dns remove ${host}`), "deleting the machine removes its name");
});

test("a machine's DNS name is one proxied record, made once and removed with the machine", async () => {
  const records = new Map<string, { id: string; body: Record<string, unknown> }>();
  const calls: string[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input)), method = init?.method ?? "GET";
    calls.push(`${method} ${url.pathname}`);
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer dns-token");
    const ok = (result: unknown) => Response.json({ success: true, result });
    if (url.pathname === "/client/v4/zones") return ok(url.searchParams.get("name") === "example.com" ? [{ id: "zone-1" }] : []);
    if (url.pathname === "/client/v4/zones/zone-1/dns_records" && method === "GET") return ok([...records.values()].filter(record => record.body.name === url.searchParams.get("name")));
    if (url.pathname === "/client/v4/zones/zone-1/dns_records" && method === "POST") { const body = JSON.parse(String(init!.body)); records.set("r1", { id: "r1", body }); return ok({ id: "r1" }); }
    if (method === "DELETE") { records.delete(url.pathname.split("/").pop()!); return ok({}); }
    return Response.json({ success: false, errors: [{ message: "unexpected" }] }, { status: 400 });
  };
  const dns = cloudflareDns("dns-token", "example.com", fetcher);
  await dns.add("0123456789-umpi.example.com");
  await dns.add("0123456789-umpi.example.com");
  assert.deepEqual(records.get("r1")?.body, { type: "AAAA", name: "0123456789-umpi.example.com", content: "100::", proxied: true, ttl: 1, comment: "Umpi cloud machine" });
  assert.equal(calls.filter(call => call.startsWith("POST")).length, 1, "made once");
  assert.equal(calls.filter(call => call === "GET /client/v4/zones").length, 1, "the zone is looked up once");
  await dns.remove("0123456789-umpi.example.com");
  assert.equal(records.size, 0);
  await assert.rejects(cloudflareDns("dns-token", "other.example", fetcher).add("x-umpi.other.example"), /cannot see the zone/);
});

test("a machine being stopped by the platform is saved first: at its request, or on the next check", async t => {
  const { cloud, events, running, stopping, advance, machine: t3 } = fixture(t);
  const { machine } = await cloud.create({ title: "Fix login", task: "Fix the login bug" });
  const token = (cloud as unknown as { token(id: string): string }).token(machine.id);
  assert.equal(cloud.stopping("not-a-machine-token-000000"), undefined);
  // The machine's own request; two at once share one save.
  const first = cloud.stopping(token)!, second = cloud.stopping(token)!;
  assert.equal(first.id, machine.id);
  await Promise.all([first.save, second.save]);
  assert.equal(events.filter(event => event === `save ${machine.id}`).length, 1, "saved once");
  assert.equal(running.has(machine.id), false);
  assert.equal(cloud.list()[0]!.status, "asleep");

  // Its request did not arrive: the next check sees it stopping and saves it, though a thread is still working.
  await cloud.ensureAwake(machine.id);
  stopping.add(machine.id);
  events.length = 0;
  advance(125_000); await cloud.drive();
  assert.deepEqual(events, [`save ${machine.id}`]);
  assert.equal(cloud.list()[0]!.status, "asleep");
  void t3;
});
