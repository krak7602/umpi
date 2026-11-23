import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import type { Database } from "../src/worker/store.js";
import { T3CodeStore } from "../src/worker/t3-code.js";
import { CloudMachines, githubRemote, machineDue, machineProblem, CLOUD_MAX_AWAKE, SAVE_ATTEMPTS, START_LIMIT_MS, type CloudMachineRecord, type CloudMachineStart } from "../src/worker/cloud-machines.js";
import { asProviderContext, cloudModelRequest, piMessagesEvent, CloudModelBudget, CloudModelRefused, CLOUD_MODEL_REQUESTS_PER_DAY, CLOUD_MODEL_REQUESTS_PER_MINUTE, CLOUD_MODEL_TOKENS_PER_DAY } from "../src/worker/cloud-model.js";
import { RESTORE_FAILED } from "../src/worker/cloud-machine-state.js";
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

/** One drive and the background work it started. */
async function drive(cloud: CloudMachines): Promise<void> { cloud.drive(); await cloud.settled(); }

function fixture(t: TestContext) {
  const machine = fakeMachine();
  const events: string[] = [];
  const running = new Set<string>();
  let now = Date.parse("2026-11-04T10:00:00Z");
  const app = { sockets: 0, appAt: 0 };
  const published = new Map<string, string>();
  const stopping = new Set<string>();
  const notices: { group: string; text: string }[] = [];
  const tokens: string[] = [];
  /** What goes wrong: an error for each save or wake, a save that reports lost work, and calls that never answer. */
  const faults: { save?: string; wake?: string; lost?: boolean; hang?: Promise<never> } = {};
  const db = database(t);
  const t3 = new T3CodeStore(database(t), cloudFetch(() => machine, async () => { throw new Error("no other machines"); }), () => now);
  const start: Omit<CloudMachineStart, "modelToken"> = { modelUrl: "https://umpi.example/api/cloud/model", models: [{ id: "claude-x", name: "X", reasoning: true, input: ["text"], contextWindow: 1000, maxTokens: 100 }], defaultModel: "claude-x" };
  /** A new store over the same database: what a restart of the coordinator leaves. */
  const open = () => {
    const cloud = new CloudMachines(db, t3, {
      stub: id => ({
        async wake(input, key, expect) {
          if (faults.hang) await faults.hang;
          if (faults.wake) { running.delete(id); throw new Error(faults.wake); }
          events.push(`wake ${id} ${key} token:${input.modelToken.length}${expect?.saved ? " saved" : ""}`); tokens.push(input.modelToken); running.add(id); return { token: "mcp-token", restored: false };
        },
        async save() {
          events.push(`save ${id}`);
          if (faults.hang) await faults.hang;
          if (faults.lost) { running.delete(id); return { size: 0, lost: true }; }
          if (faults.save) throw new Error(faults.save);
          running.delete(id); return { size: 1234 };
        },
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
    cloud.notice = (group, text) => { notices.push({ group, text }); };
    return cloud;
  };
  // A call that never answers, until the test ends: the store's own long timers must not outlive the test.
  const hang = () => { faults.hang = new Promise<never>((_, reject) => { t.after(() => reject(new Error("the test ended"))); }); faults.hang.catch(() => undefined); };
  return { cloud: open(), open, hang, t3, machine, events, running, app, published, stopping, notices, tokens, faults, now: () => now, advance: (ms: number) => { now += ms; } };
}

/**
 * The rule for every state: a machine that is not asleep has a finite next time later than now, or a reason the owner
 * can see in status and in the `cloud_machines` list.
 */
function assertRule(cloud: CloudMachines, now: number, where: string): void {
  const status = cloud.status() as { list: { id: string; status: string; problem?: string; nextAt: string | null }[] };
  const next = cloud.nextDue();
  for (const machine of cloud.list()) {
    const due = machineDue(machine, now), shown = status.list.find(item => item.id === machine.id)!;
    if ("at" in due) {
      assert.ok(Number.isFinite(due.at), `${where}: ${machine.status} has a finite time`);
      assert.ok(next !== undefined && Number.isFinite(next) && next > now, `${where}: the coordinator wakes later than now, not at once and not never`);
      assert.ok(shown.nextAt, `${where}: status shows the time`);
    } else {
      assert.ok(due.reason.length > 0, `${where}: ${machine.status} has a reason`);
      if (machine.status !== "asleep") assert.equal(shown.problem, due.reason, `${where}: the owner can see the reason`);
    }
    if (machine.status === "awake" && machine.save?.error) assert.match(shown.problem!, /^awake, could not save; \d+ attempts?; last tried at /, where);
  }
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
  advance(200_000); await drive(cloud);
  assert.equal(cloud.list()[0]!.status, "awake");
  machine.finish();
  advance(120_000); await drive(cloud);
  assert.equal(cloud.list()[0]!.status, "awake");
  // Frequent coordinator runs do not count as more checks.
  await drive(cloud); await drive(cloud);
  assert.equal(cloud.list()[0]!.status, "awake");
  advance(120_000); await drive(cloud);
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

  // A new thread with no project named goes to the machine's own project, with the model named for T3 Code.
  await t3.act(created.machine.id, { kind: "start", title: "Second", message: "More work" }, "req-second");
  const second = machine.calls.at(-1)!;
  assert.equal(second.name, "t3_thread_launch");
  assert.equal(second.args.projectId, "proj-1");
  assert.equal(second.args.scratch, undefined);
  assert.deepEqual(second.args.modelSelection, { provider: "pi", model: "default" });

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
  await drive(cloud);
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
  const idle = async () => { advance(125_000); await drive(cloud); };
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
  advance(125_000); await drive(cloud);
  assert.deepEqual(events, [`save ${machine.id}`]);
  assert.equal(cloud.list()[0]!.status, "asleep");
  void t3;
});

const MINUTE = 60_000;
/** The thread finishes, and two checks with nothing working follow: the second one saves. */
const idleOut = async (f: ReturnType<typeof fixture>) => { f.machine.finish(); f.advance(200_000); await drive(f.cloud); f.advance(125_000); await drive(f.cloud); };

test("a save that fails is tried again after 1, 5, and 15 minutes; then the owner is told and the machine keeps its work", async t => {
  const f = fixture(t), { cloud, events, running, notices, faults, advance, now } = f;
  const { machine } = await cloud.create({ title: "Fix login", task: "Fix the login bug" });
  faults.save = "storage did not answer";
  await idleOut(f);
  const saves = () => events.filter(event => event === `save ${machine.id}`).length;
  assert.equal(saves(), 1);
  let record = cloud.list()[0]!;
  assert.equal(record.status, "awake");
  assert.deepEqual(record.save, { since: record.save!.since, attempts: 1, lastTriedAt: new Date(now()).toISOString(), error: "storage did not answer", nextTryAt: new Date(now() + MINUTE).toISOString() });
  assert.equal(cloud.nextDue(), now() + MINUTE);
  assertRule(cloud, now(), "after the first failure");
  // Coordinator runs before the retry is due do not save again.
  advance(30_000); await drive(cloud);
  assert.equal(saves(), 1);
  for (const [attempt, wait] of [[2, 30_000], [3, 5 * MINUTE], [4, 15 * MINUTE]] as const) {
    assert.equal(notices.length, 0, "not told before the last quick attempt");
    advance(wait); await drive(cloud);
    assert.equal(saves(), attempt);
    assertRule(cloud, now(), `after attempt ${attempt}`);
  }
  assert.equal(SAVE_ATTEMPTS, 4);
  record = cloud.list()[0]!;
  assert.equal(running.has(machine.id), true, "never stopped unsaved");
  assert.equal(notices.length, 1);
  assert.match(notices[0]!.text, /^Fix login is awake and could not be saved after 4 attempts: storage did not answer\. It keeps running with its work/);
  assert.match(machineProblem(record)!, /^awake, could not save; 4 attempts; last tried at 2026-11-04T10:2\d:\d\d\.000Z; next try at .*: storage did not answer$/);
  assert.equal(events.at(-1), `wake ${machine.id} cloud-machines/${machine.id}/state.tar.zst token:43 saved`, "T3 Code is started again on the machine that stays awake");
  assert.equal(cloud.nextDue(), now() + 60 * MINUTE, "then once an hour");
  // The owner asking gets the reason, not a vague failure.
  await assert.rejects(cloud.sleep(machine.id), /Fix login could not be saved \(attempt 5\): storage did not answer\. It stays awake with its work/);
  advance(60 * MINUTE); await drive(cloud);
  assert.equal(saves(), 6);
  assert.equal(notices.length, 1, "told once, not at every attempt");
  // Storage answers again: the next hourly attempt saves it, and the owner hears that too.
  delete faults.save;
  advance(60 * MINUTE); await drive(cloud);
  record = cloud.list()[0]!;
  assert.equal(record.status, "asleep");
  assert.equal(record.save, undefined);
  assert.equal(running.has(machine.id), false);
  assert.deepEqual(notices.map(notice => notice.text).slice(1), ["Fix login is saved now and asleep."]);
  assert.equal(cloud.nextDue(), undefined);
});

test("a machine that could not be saved and is used again gets T3 Code back, and saves when it is next idle", async t => {
  const f = fixture(t), { cloud, t3, events, faults, advance, now } = f;
  const { machine } = await cloud.create({ title: "Task", task: "work" });
  faults.save = "storage did not answer";
  await idleOut(f);
  assert.equal(cloud.list()[0]!.save!.attempts, 1);
  events.length = 0;
  await t3.read(machine.id, "th-1", { limit: 3 });
  assert.deepEqual(events.map(event => event.split(" ")[0]), ["wake"], "the control server starts T3 Code again; nothing is restored over the work");
  assert.equal(cloud.list()[0]!.save, undefined);
  assert.equal(cloud.list()[0]!.status, "awake");
  assertRule(cloud, now(), "in use again");
  delete faults.save;
  for (let i = 0; i < 3; i++) { advance(125_000); await drive(cloud); }
  assert.equal(cloud.list()[0]!.status, "asleep");
});

test("a drive returns at once; a check or save runs beside it and a restart continues the save", async t => {
  const f = fixture(t), { cloud, open, events, running, faults, advance, now } = f;
  const { machine } = await cloud.create({ title: "Task", task: "work" });
  f.machine.finish();
  advance(200_000); await drive(cloud);
  const tracked: Promise<unknown>[] = []; let woken = 0;
  cloud.background = { track: work => { tracked.push(work); }, wake: () => { woken++; } };
  // The save never answers. The drive still returns, and the coordinator looks again in 30 seconds.
  f.hang();
  advance(125_000);
  cloud.drive();
  assert.equal(tracked.length, 1, "the work is handed to the coordinator to keep alive");
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(events.at(-1), `save ${machine.id}`);
  assert.equal(cloud.nextDue(), now() + 30_000);
  cloud.drive(); cloud.drive();
  assert.equal(tracked.length, 1, "one job for each machine");
  const during = cloud.list()[0]!;
  assert.equal(during.status, "awake");
  assert.equal(during.save!.running, true, "what is in progress is on the record");
  assertRule(cloud, now(), "while saving");

  // The coordinator restarts. Nothing runs the save now; the record says it was running, so it is due.
  delete faults.hang;
  const restarted = open();
  assert.equal(restarted.nextDue(), now() + 1_000);
  assertRule(restarted, now(), "after a restart");
  await drive(restarted);
  assert.equal(restarted.list()[0]!.status, "asleep");
  assert.equal(running.has(machine.id), false);
  assert.equal(woken, 0);

  // The same, but the container was gone and held nothing saved: lost work is said, not recorded as a sleep.
  await restarted.ensureAwake(machine.id);
  f.hang();
  void restarted.sleep(machine.id).catch(() => undefined);
  await new Promise(resolve => setTimeout(resolve, 20));
  delete faults.hang; faults.lost = true;
  const again = open();
  await drive(again);
  assert.equal(again.list()[0]!.status, "asleep");
  assert.match(again.list()[0]!.error!, /work since its last save was lost/);
  assert.match(f.notices.at(-1)!.text, /^Task stopped unexpectedly\. Work since its last save was lost/);
});

test("a restore that fails leaves the machine stopped with a reason and a notice; the next wake tries again", async t => {
  const f = fixture(t), { cloud, t3, events, running, notices, faults, now } = f;
  const { machine } = await cloud.create({ title: "Fix login", task: "Fix the login bug" });
  await cloud.sleep(machine.id);
  events.length = 0;
  faults.wake = `${RESTORE_FAILED}: storage holds 400 bytes of 1234`;
  await assert.rejects(t3.read(machine.id, "th-1", { limit: 3 }), /Fix login did not start: Saved state could not be restored: storage holds 400 bytes of 1234/);
  const record = cloud.list()[0]!;
  assert.equal(record.status, "failed");
  assert.equal(running.has(machine.id), false);
  assert.equal(machineProblem(record), `${RESTORE_FAILED}: storage holds 400 bytes of 1234`);
  assert.deepEqual(notices.map(notice => notice.text), [`Fix login did not wake: ${RESTORE_FAILED}: storage holds 400 bytes of 1234. It was stopped, and its saved state is unchanged. Waking it again tries the restore again.`]);
  assert.match(notices[0]!.group, new RegExp(`^cloud-machine:${machine.id}:restore:1$`));
  assertRule(cloud, now(), "restore failed");
  await drive(cloud);
  assert.ok(!events.some(event => event.startsWith("save")), "a machine that was not restored is never saved");
  await assert.rejects(cloud.ensureAwake(machine.id), /could not be restored/);
  assert.equal(notices.length, 1, "told once for one run of failures");
  delete faults.wake;
  await cloud.ensureAwake(machine.id);
  assert.equal(events.at(-1), `wake ${machine.id} cloud-machines/${machine.id}/state.tar.zst token:43 saved`, "a machine that was saved must come back with that state");
  assert.equal(cloud.list()[0]!.status, "awake");
  assert.equal(cloud.list()[0]!.error, undefined);
});

test("a wake that a restart cut off does not stay 'starting': it fails with a reason after its limit", async t => {
  const f = fixture(t), { cloud, open, faults, advance, now } = f;
  const { machine } = await cloud.create({ title: "Task", task: "work" });
  await cloud.sleep(machine.id);
  f.hang();
  void cloud.ensureAwake(machine.id).catch(() => undefined);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(cloud.list()[0]!.status, "starting");
  const restarted = open();
  assert.equal(restarted.nextDue(), now() + START_LIMIT_MS);
  assertRule(restarted, now(), "starting");
  advance(START_LIMIT_MS - MINUTE); await drive(restarted);
  assert.equal(restarted.list()[0]!.status, "starting");
  advance(MINUTE); await drive(restarted);
  assert.equal(restarted.list()[0]!.status, "failed");
  assert.match(restarted.list()[0]!.error!, /did not finish starting/);
  assert.equal(restarted.nextDue(), undefined);
  assertRule(restarted, now(), "start failed");
  delete faults.hang;
  await restarted.ensureAwake(machine.id);
  assert.equal(restarted.list()[0]!.status, "awake");
});

test("every state has a finite next time later than now, or a reason the owner can see", async t => {
  // Each state by itself, with records as old code and odd data leave them.
  const at = Date.parse("2026-11-04T12:00:00Z"), iso = (ms: number) => new Date(at + ms).toISOString();
  const base: CloudMachineRecord = { id: "cloud-0000000001", label: "Example", status: "awake", createdAt: iso(-3_600_000), idleChecks: 0 };
  const states: [string, Partial<CloudMachineRecord>, "time" | "reason"][] = [
    ["starting", { status: "starting", startingAt: iso(-MINUTE) }, "time"],
    ["starting, no start time", { status: "starting" }, "time"],
    ["awake, never checked", {}, "time"],
    ["awake, checked", { checkedAt: iso(-30_000) }, "time"],
    ["awake, bad date", { checkedAt: "not a date" }, "time"],
    ["awake, saving", { save: { since: iso(-MINUTE), attempts: 1, lastTriedAt: iso(-MINUTE), running: true } }, "time"],
    ["awake, save failed", { save: { since: iso(-MINUTE), attempts: 2, lastTriedAt: iso(-MINUTE), error: "storage did not answer", nextTryAt: iso(4 * MINUTE) } }, "time"],
    ["awake, save failed, no retry time", { save: { since: iso(-MINUTE), attempts: 2, lastTriedAt: iso(-MINUTE), error: "storage did not answer" } }, "time"],
    ["awake, could not save, owner told", { save: { since: iso(-MINUTE), attempts: 4, lastTriedAt: iso(-MINUTE), error: "storage did not answer", nextTryAt: iso(59 * MINUTE), told: true } }, "time"],
    ["asleep", { status: "asleep", sleptAt: iso(-MINUTE) }, "reason"],
    ["asleep after a loss", { status: "asleep", error: "It stopped unexpectedly; work since its last save was lost" }, "reason"],
    ["failed", { status: "failed", error: "Saved state could not be restored: cut short" }, "reason"],
    ["failed, no reason recorded", { status: "failed" }, "reason"],
  ];
  for (const [name, change, kind] of states) {
    for (const busy of [false, true]) {
      const due = machineDue({ ...base, ...change }, at, busy);
      if (kind === "time" || busy) { assert.ok("at" in due && Number.isFinite(due.at), name); if (busy) assert.ok("at" in due && due.at > at, `${name}: busy is not due at once`); }
      else assert.ok("reason" in due && due.reason.length > 0, name);
    }
  }
  assert.match(machineProblem({ ...base, ...states[8]![1] })!, /^awake, could not save; 4 attempts; last tried at 2026-11-04T11:59:00\.000Z; next try at 2026-11-04T12:59:00\.000Z: storage did not answer$/);

  // The store itself, walked from one due time to the next while saves fail, a restore fails, and work is lost.
  const f = fixture(t), { cloud, running, faults, advance, now } = f;
  const { machine } = await cloud.create({ title: "Walk", task: "work" });
  f.machine.finish();
  const walk = async (steps: number, where: string) => {
    for (let step = 0; step < steps; step++) {
      assertRule(cloud, now(), `${where}, step ${step}`);
      const next = cloud.nextDue();
      if (next === undefined) return;
      assert.ok(next >= now() + 1_000, `${where}: never due at once`);
      advance(next - now()); await drive(cloud);
    }
  };
  faults.save = "storage did not answer";
  await walk(12, "saves fail");
  assert.equal(cloud.list()[0]!.status, "awake");
  assert.ok(cloud.list()[0]!.save!.attempts > SAVE_ATTEMPTS, "the hourly attempts go on");
  delete faults.save;
  await walk(4, "saves work");
  assert.equal(cloud.list()[0]!.status, "asleep");
  faults.wake = `${RESTORE_FAILED}: cut short`;
  await assert.rejects(cloud.ensureAwake(machine.id));
  await walk(3, "restore failed");
  delete faults.wake;
  await cloud.ensureAwake(machine.id);
  running.clear();
  await walk(3, "container gone");
  assert.equal(cloud.list()[0]!.status, "asleep");
  assertRule(cloud, now(), "end");
});

test("each machine has a model budget, and its token works only while Umpi runs it", async t => {
  const f = fixture(t), { cloud, tokens, advance } = f;
  const { machine } = await cloud.create({ title: "Fix login", task: "Fix the login bug" });
  const token = () => (cloud as unknown as { token(id: string): string }).token(machine.id);
  assert.equal(tokens.at(-1), token());

  // Requests in one minute.
  for (let i = 0; i < CLOUD_MODEL_REQUESTS_PER_MINUTE; i++) cloud.used(machine.id).spent({ input: 1_000, output: 200, cacheWrite: 300, cacheRead: 90_000 } as never);
  assert.throws(() => cloud.used(machine.id), (error: unknown) => error instanceof CloudModelRefused && error.status === 429 && error.code === "cloud_model_minute" && error.retryAfterSeconds === 60 && /60 model requests in one minute/.test(error.message));
  const shown = () => (cloud.status() as { modelLimits: object; list: { model: { requests: number; tokens: number; refused: number } }[] });
  assert.deepEqual(shown().modelLimits, { requestsPerMinute: 60, requestsPerDay: 6_000, tokensPerDay: 100_000_000 });
  assert.deepEqual({ ...shown().list[0]!.model, day: undefined, lastUsedAt: undefined, lastRefusedAt: undefined }, { requests: 60, tokens: 90_000, refused: 1, day: undefined, lastUsedAt: undefined, lastRefusedAt: undefined }, "cache reads are not counted");
  advance(60_000);
  cloud.used(machine.id);

  // A sleeping machine's token is refused, and the next run has a new one.
  const first = token();
  await cloud.sleep(machine.id);
  assert.equal(cloud.machineFor(first), machine.id);
  assert.throws(() => cloud.used(machine.id), /not awake/);
  await cloud.ensureAwake(machine.id);
  assert.notEqual(token(), first);
  assert.equal(tokens.at(-1), token());
  assert.equal(cloud.machineFor(first), undefined, "a token copied out of an earlier run is unknown");
  cloud.used(machine.id);

  // Deleting the machine ends its token, even when a later step of the delete fails.
  const last = token();
  await cloud.remove(machine.id);
  assert.equal(cloud.machineFor(last), undefined);
  assert.throws(() => cloud.used(machine.id), /not awake/);
});

test("the model budget counts by UTC day and the gateway answers a refusal in the agent's own protocol", async t => {
  let now = Date.parse("2026-11-04T23:58:30Z");
  const budget = new CloudModelBudget(database(t), () => now);
  budget.admit("cloud-a").spent({ input: CLOUD_MODEL_TOKENS_PER_DAY - 10, output: 10 });
  assert.throws(() => budget.admit("cloud-a"), (error: unknown) => error instanceof CloudModelRefused && error.code === "cloud_model_day" && error.retryAfterSeconds === 90 && /Stop and tell the owner/.test(error.message));
  budget.admit("cloud-b");
  now += 90_000;
  budget.admit("cloud-a");
  assert.deepEqual(budget.status("cloud-a"), { day: "2026-11-05", requests: 1, tokens: 0, refused: 0, lastUsedAt: "2026-11-05T00:00:00.000Z", lastRefusedAt: "2026-11-04T23:58:30.000Z" });
  for (let i = 1; i < CLOUD_MODEL_REQUESTS_PER_DAY; i++) { if (i % CLOUD_MODEL_REQUESTS_PER_MINUTE === 0) now += 60_000; budget.admit("cloud-a"); }
  now += 60_000;
  assert.throws(() => budget.admit("cloud-a"), (error: unknown) => error instanceof CloudModelRefused && error.code === "cloud_model_day");
  budget.forget("cloud-a");
  assert.equal(budget.status("cloud-a").requests, 0);

  // Through the gateway: the admitted request records what it spent; the refused one never reaches a model.
  const usage = { input: 700, output: 50, cacheRead: 40_000, cacheWrite: 250 };
  let calls = 0;
  const models = { getModel: () => ({ id: "claude-x", api: "anthropic-messages", provider: "anthropic" }),
    streamSimple: () => { calls++; return (async function* () { yield { type: "done", reason: "stop", message: { usage } }; })(); } } as never;
  const gateway = { models, machineFor: () => "cloud-c", used: (id: string) => budget.admit(id) };
  const request = () => new Request("https://umpi.example/api/cloud/model/messages", { method: "POST", headers: { authorization: `Bearer ${"t".repeat(30)}` }, body: JSON.stringify({ model: "claude-x", context: { messages: [] } }) });
  await (await cloudModelRequest(request(), gateway)).text();
  assert.equal(budget.status("cloud-c").tokens, 1_000);
  for (let i = 1; i < CLOUD_MODEL_REQUESTS_PER_MINUTE; i++) budget.admit("cloud-c");
  const refused = await cloudModelRequest(request(), gateway);
  assert.equal(refused.status, 429);
  assert.ok(Number(refused.headers.get("retry-after")) > 0);
  const body = await refused.json() as { error: { message: string; code: string } };
  assert.equal(body.error.code, "cloud_model_minute");
  assert.match(body.error.message, /Wait \d+ seconds, then continue/);
  assert.equal(calls, 1);
});
