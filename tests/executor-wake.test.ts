import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { authorize } from "../src/worker/transport.js";
import { ExecutorPresence, EXECUTOR_OFFLINE_NOTICE_MS } from "../src/worker/executor-presence.js";
import type { Database } from "../src/worker/store.js";
import { WakeChannel, WAKE_PING_MS, WAKE_PONG_TIMEOUT_MS, type WakeSocket } from "../src/mac/wake.js";
import { DEGRADED_POLL_MS, IDLE_POLL_MS, MacExecutor } from "../src/mac/daemon.js";
import { ExecutionJournal } from "../src/mac/journal.js";
import type { MacConfig } from "../src/mac/config.js";
import { servicePlist, SERVICE_LABEL } from "../src/mac/service.js";

const env = { UMPI_CONTROL_TOKEN: "c".repeat(40), UMPI_EXECUTOR_TOKEN: "e".repeat(40) };
const upgrade = (path: string, token: string, method = "GET") => new Request(`https://coordinator.example${path}`, { method, headers: { authorization: `Bearer ${token}`, upgrade: "websocket" } });

test("only the executor wake path may upgrade, and only with the executor credential", async () => {
  await authorize(upgrade("/api/executor/wake?executorId=mac-1", env.UMPI_EXECUTOR_TOKEN), env);
  await assert.rejects(authorize(upgrade("/api/executor/wake", env.UMPI_CONTROL_TOKEN), env), { status: 401 });
  await assert.rejects(authorize(upgrade("/api/status", env.UMPI_CONTROL_TOKEN), env), { status: 404 });
  await assert.rejects(authorize(upgrade("/api/executor/poll", env.UMPI_EXECUTOR_TOKEN, "POST"), env), { status: 404 });
  await assert.rejects(authorize(new Request("https://coordinator.example/api/executor/wake", { headers: { authorization: `Bearer ${env.UMPI_EXECUTOR_TOKEN}` } }), env), { status: 404 }, "a plain GET is not a route");
});

function database(t: TestContext): Database {
  const sqlite = new DatabaseSync(":memory:"); t.after(() => sqlite.close());
  return { all: <T extends object>(query: string, ...values: (string | number | null)[]) => sqlite.prepare(query).all(...values) as T[], transaction: <T>(run: () => T) => run() };
}

test("a wake is sent only for work the executor has not been told about", t => {
  const presence = new ExecutorPresence(database(t));
  assert.equal(presence.shouldWake([]), false);
  assert.equal(presence.shouldWake(["job:a:queued:false"]), true);
  assert.equal(presence.shouldWake(["job:a:queued:false"]), false, "the same queued job is announced once");
  assert.equal(presence.shouldWake(["job:a:running:true"]), true, "a cancellation is new work");
  assert.equal(presence.shouldWake([]), false);
  assert.equal(presence.shouldWake(["job:a:running:true"]), true, "work that went away and came back is announced again");
});

test("the offline notice is sent once per absence, only after a day, and never for an executor that never connected", t => {
  const presence = new ExecutorPresence(database(t)), start = Date.parse("2026-10-22T00:00:00Z");
  assert.equal(presence.offlineNotice(false, null, start + 2 * EXECUTOR_OFFLINE_NOTICE_MS), undefined);
  presence.connected(start); presence.disconnected(start + 60_000);
  assert.equal(presence.offlineNotice(false, start + 120_000, start + EXECUTOR_OFFLINE_NOTICE_MS), undefined, "a night away is not an outage");
  const notice = presence.offlineNotice(false, start + 120_000, start + 120_000 + EXECUTOR_OFFLINE_NOTICE_MS);
  assert.deepEqual(notice, { id: `notice:executor-offline:${start + 120_000}`, lastSeen: start + 120_000 });
  assert.equal(presence.offlineNotice(false, start + 120_000, start + 3 * EXECUTOR_OFFLINE_NOTICE_MS), undefined, "one notice per absence");
  assert.equal(presence.offlineNotice(true, null, start + 9 * EXECUTOR_OFFLINE_NOTICE_MS), undefined);
});

class FakeSocket implements WakeSocket {
  sent: string[] = []; closed?: number;
  private listeners = new Map<string, ((event: { data?: unknown }) => void)[]>();
  constructor(readonly url: string, readonly headers: Record<string, string>) {}
  addEventListener(type: string, listener: (event: { data?: unknown }) => void) { this.listeners.set(type, [...this.listeners.get(type) ?? [], listener]); }
  emit(type: string, data?: string) { for (const listener of this.listeners.get(type) ?? []) listener({ data }); }
  send(data: string) { this.sent.push(data); }
  close(code?: number) { this.closed = code; }
}

test("the wake channel authenticates by header, polls on connect and on wake, keeps alive, and reconnects", t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.parse("2026-10-24T10:00:00Z") });
  const sockets: FakeSocket[] = [], states: boolean[] = [];
  let wakes = 0;
  const channel = new WakeChannel({ origin: new URL("https://coordinator.example"), token: "secret-token", executorId: "mac 1", onWake: () => { wakes++; },
    onState: connected => { states.push(connected); }, connect: (url, headers) => { const socket = new FakeSocket(url, headers); sockets.push(socket); return socket; }, random: () => 1 });
  channel.start();
  assert.equal(sockets[0]!.url, "wss://coordinator.example/api/executor/wake?executorId=mac%201");
  assert.deepEqual(sockets[0]!.headers, { authorization: "Bearer secret-token" });
  assert.doesNotMatch(sockets[0]!.url, /secret/);
  sockets[0]!.emit("open");
  assert.equal(channel.connected, true); assert.equal(wakes, 1, "anything queued while away is collected on connect");
  sockets[0]!.emit("message", "wake"); assert.equal(wakes, 2);
  sockets[0]!.emit("message", "something else"); assert.equal(wakes, 2);
  t.mock.timers.tick(WAKE_PING_MS); assert.deepEqual(sockets[0]!.sent, ["ping"]);
  sockets[0]!.emit("message", "pong");
  t.mock.timers.tick(WAKE_PONG_TIMEOUT_MS); assert.equal(sockets.length, 1, "an answered ping keeps the socket");
  t.mock.timers.tick(WAKE_PING_MS - WAKE_PONG_TIMEOUT_MS); assert.deepEqual(sockets[0]!.sent, ["ping", "ping"]);
  t.mock.timers.tick(WAKE_PONG_TIMEOUT_MS);
  assert.equal(sockets.length, 2, "an unanswered ping replaces the socket at once"); assert.equal(sockets[0]!.closed, 4000);
  sockets[1]!.emit("open"); sockets[1]!.emit("close");
  assert.equal(channel.connected, false);
  t.mock.timers.tick(999); assert.equal(sockets.length, 2);
  t.mock.timers.tick(1); assert.equal(sockets.length, 3, "a lost socket reconnects after a backoff");
  sockets[2]!.emit("error"); t.mock.timers.tick(2_000); assert.equal(sockets.length, 4, "the backoff grows");
  channel.stop(); t.mock.timers.tick(120_000); assert.equal(sockets.length, 4);
  assert.deepEqual(states, [true, false, true, false]);
});

test("a ping timer that fires far too late means the Mac slept, so the socket is replaced", t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const sockets: FakeSocket[] = [];
  const channel = new WakeChannel({ origin: new URL("http://127.0.0.1:8787"), token: "t", executorId: "mac-1", onWake: () => undefined, connect: url => { const socket = new FakeSocket(url, {}); sockets.push(socket); return socket; } });
  channel.start(); sockets[0]!.emit("open");
  assert.match(sockets[0]!.url, /^ws:\/\/127\.0\.0\.1:8787\//);
  t.mock.timers.setTime(3 * WAKE_PING_MS); // The process was suspended; the timer fires only after waking.
  t.mock.timers.tick(WAKE_PING_MS);
  assert.equal(sockets.length, 2); assert.deepEqual(sockets[0]!.sent, [], "no ping goes to a dead socket");
  channel.stop();
});

function executor(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "umpi-wake-test-")));
  mkdirSync(join(root, "workspace"), { mode: 0o700 });
  const config: MacConfig = { executorId: "executor-test", executorToken: "private-test-token-with-at-least-32-characters", serverUrl: "http://127.0.0.1:1", workspaces: [join(root, "workspace")], pollIntervalMs: 1_000, coding: { enabled: false }, browser: { enabled: false, allSites: false, sites: [] } };
  const journal = new ExecutionJournal(join(root, "state"), config), mac = new MacExecutor(config, journal);
  t.after(async () => { await mac.stop(); journal.close(); rmSync(root, { recursive: true, force: true }); });
  return mac;
}

test("an idle executor waits for a wake with the socket up, polls more often without it, and polls fast while busy", t => {
  const mac = executor(t);
  const wake = { connected: false };
  assert.equal(mac.nextDelay(false), 1_000, "without a wake channel the configured interval is kept");
  mac.useWake(wake);
  assert.equal(mac.nextDelay(false), DEGRADED_POLL_MS);
  wake.connected = true;
  assert.equal(mac.nextDelay(false), IDLE_POLL_MS);
  assert.equal(mac.nextDelay(true), DEGRADED_POLL_MS, "an unreachable coordinator is retried sooner than the idle beat");
  assert.equal(mac.busy, false);
});

test("a wake interrupts the idle wait", async t => {
  const mac = executor(t);
  mac.useWake({ connected: true });
  const pause = (mac as unknown as { pause(ms: number): Promise<void> }).pause.bind(mac);
  const started = Date.now();
  const waiting = pause(IDLE_POLL_MS);
  setTimeout(() => mac.requestPoll(), 20);
  await waiting;
  assert.ok(Date.now() - started < 2_000);
  mac.requestPoll();
  const early = Date.now(); await pause(IDLE_POLL_MS);
  assert.ok(Date.now() - early < 100, "a wake during a poll is not lost");
});

test("the login item restarts after a crash, keeps the shell PATH, and escapes its values", () => {
  const plist = servicePlist({ node: "/opt/node/bin/node", bundle: "/Users/me/Library/Application Support/Umpi/executor/umpi-executor.mjs", args: ["--config", "/Users/me/.config/umpi/mac/a&b.json"],
    log: "/Users/me/.config/umpi/mac/executor.log", workingDirectory: "/Users/me", path: "/opt/homebrew/bin:/usr/bin" });
  assert.match(plist, new RegExp(`<key>Label</key><string>${SERVICE_LABEL.replace(/\./g, "\\.")}</string>`));
  assert.match(plist, /<array><string>\/opt\/node\/bin\/node<\/string><string>[^<]+umpi-executor\.mjs<\/string><string>run<\/string><string>--config<\/string><string>[^<]*a&amp;b\.json<\/string><\/array>/);
  assert.match(plist, /<key>KeepAlive<\/key><dict><key>SuccessfulExit<\/key><false\/><\/dict>/);
  assert.match(plist, /<key>RunAtLoad<\/key><true\/>/);
  assert.match(plist, /<key>PATH<\/key><string>\/opt\/homebrew\/bin:\/usr\/bin<\/string>/);
  assert.doesNotMatch(plist, /token/i);
});
