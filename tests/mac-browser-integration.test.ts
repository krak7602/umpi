import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as immediate } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { BrowserJournal, MacBrowserExecutor, readBrowserJournalStatus } from "../src/mac/browser.ts";
import { AsideConnectionLost } from "../src/mac/browser-aside.ts";
import type { BrowserTab, NativeBrowserBridge } from "../src/mac/browser-aside.ts";
import { CodingJournal, MacCodingExecutor } from "../src/mac/coding.ts";
import { initializeConfig, loadConfig } from "../src/mac/config.ts";
import { CoordinatorUnavailable, MacExecutor } from "../src/mac/daemon.ts";
import { ExecutionJournal } from "../src/mac/journal.ts";
import { browserOperationPrefix, browserSitePolicyJson, requestedBrowserSite } from "../src/shared/browser.ts";
import type { BrowserAction, BrowserAssignment, BrowserObservation, BrowserSitePolicy, BrowserStopped } from "../src/shared/browser.ts";
import { record } from "../src/shared/protocol.ts";

const exec = promisify(execFile);
const policy: BrowserSitePolicy = { siteId: "fixture", title: "Synthetic fixture", origins: ["https://fixture.example"], cookieHosts: [], cookieNames: [], resourceHosts: ["fixture.example"] };
const digest = createHash("sha256").update(browserSitePolicyJson(policy)).digest("hex");
function grant(): BrowserAssignment {
  return { taskId: "browser-task", runId: "browser-run", deadlineAt: new Date(Date.now() + 60_000).toISOString(), sites: [{ site: { ...policy, policyDigest: digest, version: 1 }, startUrl: "https://fixture.example/" }] };
}
function fixture(t: TestContext, serverUrl = "https://coordinator.example") {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "umpi-browser-integration-test-")));
  const cleanup: (() => void | Promise<void>)[] = [];
  t.after(async () => { for (const close of cleanup) await close(); rmSync(root, { recursive: true, force: true }); });
  const configPath = join(root, "config.json"), state = join(root, "state"), policyPath = join(root, "policy.json");
  const config = initializeConfig(configPath, { serverUrl, executorToken: "synthetic-executor-token-with-at-least-32-characters", workspaces: [root], pollIntervalMs: 100 });
  writeFileSync(policyPath, JSON.stringify(policy), { mode: 0o600 });
  return { root, configPath, state, policyPath, config, cleanup };
}
async function cli(configPath: string, command: string, ...args: string[]) {
  return exec(process.execPath, ["--import", "tsx", fileURLToPath(new URL("../src/mac/cli.ts", import.meta.url)), command, "--config", configPath, ...args], { cwd: fileURLToPath(new URL("../", import.meta.url)), timeout: 10_000 });
}
async function coordinator(t: TestContext, handle: (request: IncomingMessage, response: ServerResponse, body: Record<string, unknown>) => void) {
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += String(chunk);
    handle(request, response, record(JSON.parse(body)));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); }));
  const address = server.address(); assert(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
}
class GatedBridge implements NativeBrowserBridge {
  readonly effect = Promise.withResolvers<{ observation: BrowserObservation }>();
  readonly started = Promise.withResolvers<void>();
  effects = 0;
  readonly closed: string[][] = [];
  async openTab(_siteId: string, marker: string): Promise<string> { assert.match(marker, /^about:blank#umpi-browser-/); return "task-owned-target"; }
  async configureTab(tab: BrowserTab, assignment: BrowserAssignment): Promise<void> { assert.equal(tab.targetId, "task-owned-target"); assert.equal(assignment.runId, "browser-run"); }
  async invoke(tab: BrowserTab, _action: BrowserAction) { assert.equal(tab.targetId, "task-owned-target"); this.effects++; this.started.resolve(); return this.effect.promise; }
  async disconnect(): Promise<void> { this.effect.reject(new AsideConnectionLost()); await immediate(); }
  async stopTabs(targetIds: readonly string[]): Promise<BrowserStopped> { this.closed.push([...targetIds]); return { stopped: true, uncertain: false }; }
}

test("daemon browser lane runs alongside a real shell slot and receives cancellation despite shell transport failure", async t => {
  const assignment = grant(), request = { operationId: browserOperationPrefix(assignment.taskId, assignment.runId) + "observe", action: { kind: "observe", siteId: policy.siteId } };
  const polls: Record<string, unknown>[] = [], reports: Record<string, unknown>[] = [], headers: (string | undefined)[] = [];
  let cancel = false, failShell = false, failReport = true;
  const origin = await coordinator(t, (incoming, response, body) => {
    headers.push(incoming.headers.authorization);
    if (incoming.url === "/api/executor/browser/poll") {
      polls.push(body); response.end(JSON.stringify({ assignment, requests: [request], cancel }));
    } else if (incoming.url === "/api/executor/browser/report") {
      reports.push(body); response.writeHead(failReport ? 503 : 200).end("{}"); failReport = false;
    } else if (incoming.url === "/api/executor/poll") {
      response.writeHead(failShell ? 503 : 200).end(JSON.stringify({ job: null, cancelJobIds: [] }));
    } else if (incoming.url === "/api/executor/coding/poll") {
      assert.equal(body.available, false); response.end(JSON.stringify({ assignment: null, requests: [], cancelOperationIds: [], cancel: false }));
    } else { assert.fail(`Unexpected synthetic coordinator route ${incoming.url}`); }
  });
  const f = fixture(t, origin);
  const config = { ...f.config, coding: { enabled: true }, browser: { enabled: true, allSites: false, sites: [policy] } };
  const shellJournal = new ExecutionJournal(f.state, config), codingJournal = new CodingJournal(f.state, config), browserJournal = new BrowserJournal(f.state, config);
  const bridge = new GatedBridge(), coding = new MacCodingExecutor(config, codingJournal), browser = new MacBrowserExecutor(config, browserJournal, { bridgeFactory: () => bridge });
  const executor = new MacExecutor(config, shellJournal, () => {}, coding, browser);
  f.cleanup.push(async () => { await executor.stop(); browserJournal.close(); codingJournal.close(); shellJournal.close(); });
  // A real child holding a loopback listener exercises process-group ownership;
  // no guessed sleep or fake platform process is involved.
  const command = `'${process.execPath.replaceAll("'", "'\\''")}' -e 'require("node:net").createServer().listen(0, "127.0.0.1")'`;
  await executor.acceptAssignment({ jobId: "shell-job", command, cwd: f.root, timeoutMs: 30_000, createdAt: new Date().toISOString() });
  await executor.pollOnce(); await bridge.started.promise;
  assert.equal(executor.runningJobId, "shell-job"); assert.equal(browser.activeRunId, assignment.runId);
  assert.equal(polls[0]?.available, true); assert.deepEqual(polls[0]?.sites, [{ siteId: policy.siteId, policyDigest: digest }]);
  failShell = true; cancel = true;
  await assert.rejects(executor.pollOnce(), CoordinatorUnavailable);
  assert.equal(polls[1]?.available, false); assert.equal(polls[1]?.activeRunId, assignment.runId);
  assert.equal(executor.runningJobId, "shell-job"); assert.equal(browserJournal.result(request.operationId)?.status, "uncertain");
  assert.deepEqual(bridge.closed, [["task-owned-target"]]);
  await assert.rejects(executor.flushBrowserReports(), CoordinatorUnavailable);
  const undelivered = browserJournal.snapshot().unacknowledgedReports; assert(undelivered > 0);
  await executor.flushBrowserReports();
  assert.deepEqual(reports[0], reports[1]); assert.equal(browserJournal.snapshot().unacknowledgedReports, 0);
  assert(reports.some(report => report.kind === "stopped" && report.stopped === true && report.uncertain === true && report.ownerConfirmedStopped === undefined));
  await assert.rejects(executor.pollOnce(), CoordinatorUnavailable); await executor.flushBrowserReports();
  assert.equal(bridge.effects, 1); assert.equal(browserJournal.result(request.operationId)?.status, "uncertain");
  assert(headers.every(header => header === `Bearer ${config.executorToken}`));
});
test("unreconciled coding ownership suppresses shell claims but never suppresses the independent browser claim", async t => {
  const assignment = grant();
  let browserPoll: Record<string, unknown> | undefined;
  const origin = await coordinator(t, (incoming, response, body) => {
    if (incoming.url === "/api/executor/browser/poll") {
      browserPoll = body;
      response.end(JSON.stringify({ assignment, requests: [{ operationId: browserOperationPrefix(assignment.taskId, assignment.runId) + "read", action: { kind: "observe", siteId: policy.siteId } }], cancel: false }));
    } else if (incoming.url === "/api/executor/coding/poll") {
      assert.equal(body.available, false);
      response.end(JSON.stringify({ assignment: null, requests: [], cancelOperationIds: [], cancel: false }));
    } else { assert.fail("A coding-owned shell slot must not make a shell claim"); }
  });
  const f = fixture(t, origin), config = { ...f.config, coding: { enabled: true }, browser: { enabled: true, allSites: false, sites: [policy] } };
  const shellJournal = new ExecutionJournal(f.state, config), codingJournal = new CodingJournal(f.state, config), browserJournal = new BrowserJournal(f.state, config);
  const codingGrant = { taskId: "coding-task", runId: "coding-run", cwd: f.root, deadlineAt: new Date(Date.now() + 60_000).toISOString() };
  codingJournal.accept(codingGrant); codingJournal.stopped(codingGrant, true);
  const coding = new MacCodingExecutor(config, codingJournal), bridge = new GatedBridge();
  const browser = new MacBrowserExecutor(config, browserJournal, { bridgeFactory: () => bridge });
  const executor = new MacExecutor(config, shellJournal, () => {}, coding, browser);
  f.cleanup.push(async () => { await executor.stop(); browserJournal.close(); codingJournal.close(); shellJournal.close(); });
  assert.equal(coding.ownsSlot, true); assert.equal(coding.recoveryPaused, true);
  await executor.pollOnce(); await bridge.started.promise;
  assert.equal(browserPoll?.available, true); assert.equal(browser.activeRunId, assignment.runId);
  assert.equal(bridge.effects, 1); assert.equal(coding.ownsSlot, true); assert.equal(executor.runningJobId, null);
});


test("CLI grants require exact digests and private ownership, preserve unrelated values and require stopped daemon ownership", async t => {
  const f = fixture(t);
  const extra = { ...f.config, futureSetting: { retained: "untouched" }, coding: { enabled: false, futureCoding: "retained" } };
  writeFileSync(f.configPath, JSON.stringify(extra));
  await assert.rejects(cli(f.configPath, "browser-enable"));
  await assert.rejects(cli(f.configPath, "browser-grant", "--policy", f.policyPath, "--policy-digest", "0".repeat(64)));
  assert.deepEqual(JSON.parse(readFileSync(f.configPath, "utf8")), extra);
  chmodSync(f.policyPath, 0o644);
  await assert.rejects(cli(f.configPath, "browser-grant", "--policy", f.policyPath, "--policy-digest", digest));
  chmodSync(f.policyPath, 0o600);
  await cli(f.configPath, "browser-grant", "--policy", f.policyPath, "--policy-digest", digest);
  assert.equal(loadConfig(f.configPath).browser.enabled, false);
  await cli(f.configPath, "browser-enable");
  const saved = readFileSync(f.configPath, "utf8"), parsed = record(JSON.parse(saved));
  assert.deepEqual(parsed.futureSetting, extra.futureSetting); assert.deepEqual(parsed.coding, extra.coding);
  assert.equal(statSync(f.configPath).mode & 0o777, 0o600);
  const lock = new ExecutionJournal(f.state, loadConfig(f.configPath));
  try { await assert.rejects(cli(f.configPath, "browser-disable")); assert.equal(readFileSync(f.configPath, "utf8"), saved); }
  finally { lock.close(); }
  const status = await cli(f.configPath, "status");
  assert.deepEqual(record(record(JSON.parse(status.stdout)).browser).sites, [{ siteId: policy.siteId, policyDigest: digest }]);
  assert(!status.stdout.includes(f.config.executorToken)); assert(!status.stdout.includes("cookieHosts"));
  await cli(f.configPath, "browser-disable"); assert.equal(loadConfig(f.configPath).browser.sites.length, 1);
  await cli(f.configPath, "browser-enable"); await cli(f.configPath, "browser-revoke", "--site", policy.siteId);
  assert.deepEqual(loadConfig(f.configPath).browser, { enabled: false, allSites: false, sites: [] });
  assert.deepEqual(record(JSON.parse(readFileSync(f.configPath, "utf8"))).futureSetting, extra.futureSetting);
});

test("CLI all-site opt-in needs no grant, preserves private identity and accepted state, and remains guarded by stopped ownership", async t => {
  const f = fixture(t);
  const extra = { ...f.config, futureSetting: { retained: "untouched" } };
  writeFileSync(f.configPath, JSON.stringify(extra));
  await assert.rejects(cli(f.configPath, "status", "--all-sites"));
  await cli(f.configPath, "browser-enable", "--all-sites");
  const enabled = loadConfig(f.configPath);
  assert.deepEqual(enabled.browser, { enabled: true, allSites: true, sites: [] });
  assert.equal(enabled.executorId, f.config.executorId); assert.equal(enabled.executorToken, f.config.executorToken);
  assert.equal(statSync(f.configPath).mode & 0o777, 0o600);
  assert.deepEqual(record(JSON.parse(readFileSync(f.configPath, "utf8"))).futureSetting, extra.futureSetting);
  const journal = new BrowserJournal(f.state, enabled), assignment = grant();
  const request = { operationId: browserOperationPrefix(assignment.taskId, assignment.runId) + "accepted", action: { kind: "observe" as const, siteId: policy.siteId } };
  journal.accept(assignment); journal.admit(assignment, request); journal.dispatch(assignment, request.operationId);
  try {
    const saved = readFileSync(f.configPath, "utf8");
    await assert.rejects(cli(f.configPath, "browser-disable"));
    await assert.rejects(cli(f.configPath, "browser-enable", "--all-sites"));
    assert.equal(readFileSync(f.configPath, "utf8"), saved);
  } finally { journal.close(); }
  const prior = readBrowserJournalStatus(f.state);
  await cli(f.configPath, "browser-grant", "--policy", f.policyPath, "--policy-digest", digest);
  await cli(f.configPath, "browser-revoke", "--site", policy.siteId);
  assert.deepEqual(loadConfig(f.configPath).browser, { enabled: true, allSites: true, sites: [] });
  await cli(f.configPath, "browser-disable");
  assert.deepEqual(loadConfig(f.configPath).browser, { enabled: false, allSites: true, sites: [] });
  const after = readBrowserJournalStatus(f.state);
  assert.equal(after?.recordedRuns, prior?.recordedRuns); assert.equal(after?.recordedOperations, prior?.recordedOperations);
  const reopened = new BrowserJournal(f.state, loadConfig(f.configPath));
  try { assert.equal(reopened.result(request.operationId)?.status, "uncertain"); assert(reopened.snapshot().unacknowledgedReports > 0); }
  finally { reopened.close(); }
  await assert.rejects(cli(f.configPath, "browser-enable"));
  const status = record(record(JSON.parse((await cli(f.configPath, "status")).stdout)).browser);
  assert.equal(status.enabled, false); assert.equal(status.allSites, true);
});

test("daemon advertises all-site eligibility only for an available opted-in lane and still polls disabled accepted work", async t => {
  const site = requestedBrowserSite("https://shop.example.com/");
  const assignment = { ...grant(), sites: [{ site: { ...site, policyDigest: createHash("sha256").update(browserSitePolicyJson(site)).digest("hex"), version: 1 }, startUrl: "https://shop.example.com/" }] };
  const request = { operationId: browserOperationPrefix(assignment.taskId, assignment.runId) + "read", action: { kind: "observe", siteId: site.siteId } };
  const polls: Record<string, unknown>[] = [];
  let cancel = false;
  const origin = await coordinator(t, (incoming, response, body) => {
    if (incoming.url === "/api/executor/browser/poll") {
      polls.push(body); response.end(JSON.stringify({ assignment, requests: [request], cancel }));
    } else if (incoming.url === "/api/executor/poll") response.end(JSON.stringify({ job: null, cancelJobIds: [] }));
    else assert.fail(`Unexpected route ${incoming.url}`);
  });
  const f = fixture(t, origin), config = { ...f.config, browser: { enabled: true, allSites: true, sites: [] } };
  const shellJournal = new ExecutionJournal(f.state, config), browserJournal = new BrowserJournal(f.state, config), bridge = new GatedBridge();
  const browser = new MacBrowserExecutor(config, browserJournal, { bridgeFactory: () => bridge }), executor = new MacExecutor(config, shellJournal, () => {}, undefined, browser);
  f.cleanup.push(async () => { await executor.stop(); browserJournal.close(); shellJournal.close(); });
  await executor.pollOnce(); await bridge.started.promise;
  assert.equal(polls[0]?.available, true); assert.equal(polls[0]?.allSites, true); assert.deepEqual(polls[0]?.sites, []);
  await executor.pollOnce();
  assert.equal(polls[1]?.available, false); assert.equal(polls[1]?.allSites, false); assert.equal(polls[1]?.activeRunId, assignment.runId);
  config.browser.enabled = false; cancel = true;
  await executor.pollOnce();
  assert.equal(polls[2]?.available, false); assert.equal(polls[2]?.allSites, false); assert.deepEqual(polls[2]?.sites, []);
  assert.equal(browserJournal.result(request.operationId)?.status, "uncertain"); assert.equal(bridge.effects, 1);
  assert.deepEqual(bridge.closed, [["task-owned-target"]]);
});

test("CLI recovery requires explicit stopped confirmation and never turns dispatched uncertainty into success or action replay", async t => {
  const f = fixture(t), assignment = grant();
  const journal = new BrowserJournal(f.state, f.config);
  const request = { operationId: browserOperationPrefix(assignment.taskId, assignment.runId) + "click", action: { kind: "click" as const, siteId: policy.siteId, snapshotId: "snapshot", ref: "e1" } };
  journal.accept(assignment); journal.admit(assignment, request); journal.dispatch(assignment, request.operationId);
  journal.openingTab(assignment, policy.siteId); journal.ownedTab(assignment.runId, policy.siteId, "known-owned-tab"); journal.close();
  await assert.rejects(cli(f.configPath, "resume"));
  assert.equal(readBrowserJournalStatus(f.state)?.outstanding[0]?.phase, "active");
  await cli(f.configPath, "resume", "--confirm-stopped");
  const reopened = new BrowserJournal(f.state, f.config);
  try {
    assert.equal(reopened.recoveryPaused, false); assert.equal(reopened.result(request.operationId)?.status, "uncertain");
    const pending = reopened.pendingReports().map(item => record(JSON.parse(item.payload)));
    assert(pending.some(report => report.kind === "stopped" && report.stopped === true && report.uncertain === true && report.ownerConfirmedStopped === true));
    assert.equal(reopened.snapshot().recordedOperations, 1);
  } finally { reopened.close(); }
});
