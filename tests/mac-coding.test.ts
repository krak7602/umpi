import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { setImmediate as immediate } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";
import type { CodingArtifacts, CodingAssignment, CodingExecutorPoll, CodingExecutorPollResult, CodingExecutorReport } from "../src/shared/coding.ts";
import { codingOperationPrefix, emptyCodingProgress, type CodingRpcRequest, type CodingRpcState } from "../src/shared/coding-rpc.ts";
import { allowedCodingCwd, allowedCwd, loadConfig, parseConfig, type MacConfig } from "../src/mac/config.ts";
import { ExecutionJournal } from "../src/mac/journal.ts";
import { CodingJournal, MacCodingExecutor, parseCodingPollResult, readCodingJournalStatus } from "../src/mac/coding.ts";
import { CoordinatorUnavailable, MacExecutor } from "../src/mac/daemon.ts";
import { CodingStore, type CodingTask } from "../src/worker/coding-store.ts";
import { Store, type Database } from "../src/worker/store.ts";

const repository = fileURLToPath(new URL("../", import.meta.url));
const cliPath = fileURLToPath(new URL("../src/mac/cli.ts", import.meta.url));
const emptyPoll: CodingExecutorPollResult = { assignment: null, requests: [], cancelOperationIds: [], cancel: false };

function fixture(t: TestContext, serverUrl = "http://127.0.0.1:1", enabled = true) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "umpi-coding-mac-test-")));
  const workspace = join(root, "workspace");
  mkdirSync(workspace, { mode: 0o700 });
  execFileSync("git", ["init", "--quiet", workspace]);
  writeFileSync(join(workspace, "source.txt"), "baseline\n");
  const config: MacConfig = { executorId: "executor-test", executorToken: "private-test-token-with-at-least-32-characters", serverUrl, workspaces: [workspace], pollIntervalMs: 100, coding: { enabled }, browser: { enabled: false, allSites: false, sites: [] } };
  const state = join(root, "state");
  const journal = new ExecutionJournal(state, config);
  const codingJournal = new CodingJournal(state, config);
  const coding = new MacCodingExecutor(config, codingJournal);
  const executor = new MacExecutor(config, journal, () => {}, coding);
  t.after(async () => { await executor.stop(); codingJournal.close(); journal.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, workspace, config, state, journal, codingJournal, coding, executor };
}

function assignment(cwd: string, runId = "run-test", duration = 30_000): CodingAssignment {
  return { taskId: "task-test", runId, cwd, deadlineAt: new Date(Date.now() + duration).toISOString() };
}

function request(grant: CodingAssignment, method: CodingRpcRequest["method"], args: CodingRpcRequest["args"], sequence = 0): CodingRpcRequest {
  return { operationId: `${codingOperationPrefix(grant.taskId, grant.runId)}invocation-test:${sequence}`, method, args };
}

function poll(grant: CodingAssignment, requests: CodingRpcRequest[] = []): CodingExecutorPollResult {
  return { assignment: grant, requests, cancel: false, cancelOperationIds: [] };
}

async function until(predicate: () => boolean | Promise<boolean>, message: string): Promise<void> {
  const deadline = performance.now() + 10_000;
  while (!await predicate()) {
    if (performance.now() >= deadline) throw new Error(message);
    await immediate();
  }
}

const receivedOperationResults = new WeakMap<MacCodingExecutor, Map<string, CodingRpcState>>();
async function operationResult(coding: MacCodingExecutor, operationId: string): Promise<CodingRpcState> {
  let results = receivedOperationResults.get(coding);
  if (!results) { results = new Map(); receivedOperationResults.set(coding, results); }
  const settled = results;
  await until(async () => {
    await coding.flushReports(async report => { if (report.type === "operation" && report.state.status !== "running") settled.set(report.state.operationId, report.state); });
    return settled.has(operationId);
  }, "Coding operation did not settle");
  return settled.get(operationId)!;
}

async function coordinator(t: TestContext, handle: (request: IncomingMessage, response: ServerResponse, body: string) => void): Promise<string> {
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += String(chunk);
    handle(request, response, body);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
    return promise;
  });
  const address = server.address();
  assert(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
}

interface CoordinatorJournalFixture {
  owner: Store;
  coding: CodingStore;
  executorPoll(overrides?: Partial<CodingExecutorPoll>): CodingExecutorPoll;
  create(taskId: string): CodingTask;
  report(receipt: CodingExecutorReport): void;
}

function coordinatorJournal(t: TestContext, root: string, config: MacConfig): CoordinatorJournalFixture {
  const sqlite = new DatabaseSync(join(root, "coordinator.sqlite"));
  let depth = 0;
  const database: Database = {
    all: <T extends object>(query: string, ...bindings: (string | number | null)[]) => sqlite.prepare(query).all(...bindings) as T[],
    transaction: <T>(run: () => T): T => {
      const savepoint = `coding_${depth++}`;
      sqlite.exec(`SAVEPOINT ${savepoint}`);
      try { const value = run(); sqlite.exec(`RELEASE ${savepoint}`); return value; }
      catch (error) { sqlite.exec(`ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`); throw error; }
      finally { depth--; }
    },
  };
  const owner = new Store(database);
  owner.setSession("control", "owner-control");
  const coding = new CodingStore(owner);
  const executorPoll = (overrides: Partial<CodingExecutorPoll> = {}): CodingExecutorPoll => ({
    executorId: config.executorId, workspaces: config.workspaces, available: true, activeRunId: null, ...overrides,
  });
  coding.poll(executorPoll());
  const create = (taskId: string) => {
    const task = coding.create({ taskId, prompt: "Make the approved bounded change", cwd: config.workspaces[0], timeoutMs: 60_000 }, "control", "owner-control");
    return coding.approve(taskId, task.version);
  };
  const report = (receipt: CodingExecutorReport) => {
    assert.equal(receipt.executorId, config.executorId);
    if (receipt.type === "ready") coding.ready(receipt.taskId, receipt.runId, receipt.executionCwd);
    else if (receipt.type === "operation") coding.receipt(receipt.taskId, receipt.runId, receipt.state);
    else coding.stopped(receipt.taskId, receipt.runId, receipt.uncertain, receipt.issue, { ownerConfirmedStopped: receipt.ownerConfirmedStopped });
  };
  t.after(() => sqlite.close());
  return { owner, coding, executorPoll, create, report };
}

function cli(configPath: string, state: string, ...args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", cliPath, ...args, "--config", configPath, "--state-dir", state], { cwd: repository, encoding: "utf8" });
}

test("coding config defaults closed and uses exact canonical roots without narrowing the old shell contract", t => {
  const f = fixture(t);
  const { coding: _coding, ...legacy } = f.config;
  assert.deepEqual(parseConfig(legacy).coding, { enabled: false });
  assert.deepEqual(parseConfig(f.config).coding, { enabled: true });
  assert.throws(() => parseConfig({ ...legacy, coding: { enabled: "true" } }));
  const nested = join(f.workspace, "nested");
  mkdirSync(nested);
  const alias = join(f.root, "alias");
  symlinkSync(f.workspace, alias);
  assert.equal(allowedCwd(nested, f.config.workspaces), nested);
  assert.equal(allowedCodingCwd(f.workspace, f.config.workspaces), f.workspace);
  assert.throws(() => allowedCodingCwd(nested, f.config.workspaces));
  assert.throws(() => allowedCodingCwd(alias, f.config.workspaces));
});

test("coding opt-in changes only private config and cannot race a running daemon", t => {
  const f = fixture(t, undefined, false);
  const configPath = join(f.root, "config.json");
  writeFileSync(configPath, JSON.stringify(f.config), { mode: 0o600 });
  assert.notEqual(cli(configPath, f.state, "coding-enable").status, 0);
  assert.equal(loadConfig(configPath).coding.enabled, false);
  f.codingJournal.close();
  f.journal.close();
  const enabled = cli(configPath, f.state, "coding-enable");
  assert.equal(enabled.status, 0, enabled.stderr);
  const loaded = loadConfig(configPath);
  assert.equal(loaded.coding.enabled, true);
  assert.equal(loaded.executorId, f.config.executorId);
  assert.equal(loaded.executorToken, f.config.executorToken);
  assert.deepEqual(loaded.workspaces, f.config.workspaces);
  assert.equal(statSync(configPath).mode & 0o777, 0o600);
  assert.equal(`${enabled.stdout}${enabled.stderr}`.includes(f.config.executorToken), false);
  const disabled = cli(configPath, f.state, "coding-disable");
  assert.equal(disabled.status, 0, disabled.stderr);
  assert.equal(loadConfig(configPath).coding.enabled, false);
});

test("no coding work starts without opt-in and exact workspace authorization", async t => {
  const f = fixture(t, undefined, false);
  const effect = join(f.workspace, "forbidden-effect");
  const grant = assignment(f.workspace);
  await f.coding.handlePoll(poll(grant, [request(grant, "appendFile", [effect, "wrong"])]), true);
  assert.equal(existsSync(effect), false);
  assert.equal(existsSync(f.codingJournal.sessionDirectory(grant.runId)), false);
  const reports: CodingExecutorReport[] = [];
  await f.coding.flushReports(async report => { reports.push(report); });
  assert.equal(reports.some(report => report.type === "ready"), false);
  assert(reports.some(report => report.type === "stopped" && !report.uncertain));
  f.config.coding.enabled = true;
  const nested = join(f.workspace, "nested");
  mkdirSync(nested);
  const wrongRoot = assignment(nested, "run-wrong-root");
  await f.coding.handlePoll(poll(wrongRoot, [request(wrongRoot, "appendFile", [effect, "wrong"])]), true);
  assert.equal(existsSync(effect), false);
  assert.equal(existsSync(f.codingJournal.sessionDirectory(wrongRoot.runId)), false);
});

test("real coding mutations have immutable receipts and duplicate delivery never replays effects", async t => {
  const f = fixture(t);
  const grant = assignment(f.workspace);
  const append = request(grant, "appendFile", ["effects.txt", "one\n"]);
  await f.coding.handlePoll(poll(grant, [append]), true);
  const executionCwd = f.codingJournal.executionCwd(grant.runId)!;
  const effect = join(executionCwd, "effects.txt");
  const completed = await operationResult(f.coding, append.operationId);
  assert.equal(completed.status, "done");
  assert.equal(completed.result?.ok, true);
  assert.equal(readFileSync(effect, "utf8"), "one\n");
  assert.equal(existsSync(join(f.workspace, "effects.txt")), false);
  await f.coding.handlePoll(poll(grant, [append]), true);
  assert.deepEqual(await operationResult(f.coding, append.operationId), completed);
  assert.equal(readFileSync(effect, "utf8"), "one\n");
  await assert.rejects(f.coding.handlePoll(poll({ ...grant, deadlineAt: new Date(Date.now() + 60_000).toISOString() }), true));
  await f.coding.stop();
  assert.equal(f.coding.recoveryPaused, true);
  f.codingJournal.resumeAfterOwnerConfirmation();
  f.codingJournal.close();
  const reopened = new CodingJournal(f.state, f.config);
  const restarted = new MacCodingExecutor(f.config, reopened);
  try {
    await restarted.handlePoll(poll(grant, [append]), true);
    const received: string[] = [];
    await assert.rejects(restarted.flushReports(async report => { received.push(JSON.stringify(report)); throw new CoordinatorUnavailable(503); }), CoordinatorUnavailable);
    await restarted.flushReports(async report => { received.push(JSON.stringify(report)); });
    assert.equal(received[0], received[1]);
    assert.equal(readFileSync(effect, "utf8"), "one\n");
    assert.equal(restarted.available, true);
  } finally { await restarted.shutdown(); reopened.close(); }
});

test("one outbound slot prevents shell and coding from claiming simultaneous work and still polls cancellation", async t => {
  const codingPolls: CodingExecutorPoll[] = [];
  const authorizations: (string | undefined)[] = [];
  let shellPolls = 0;
  let grant: CodingAssignment;
  let workspace = "";
  let allowCoding = false;
  let cancelCoding = false;
  const origin = await coordinator(t, (req, res, body) => {
    authorizations.push(req.headers.authorization);
    res.setHeader("content-type", "application/json");
    if (req.url === "/api/executor/poll") {
      shellPolls++;
      res.end(JSON.stringify({ job: shellPolls === 1 ? { jobId: "shell-test", command: "sleep 30", cwd: workspace, timeoutMs: 30_000, createdAt: new Date().toISOString() } : null, cancelJobIds: shellPolls > 1 ? ["shell-test"] : [] }));
    } else if (req.url === "/api/executor/coding/poll") {
      codingPolls.push(JSON.parse(body) as CodingExecutorPoll);
      res.end(JSON.stringify(allowCoding ? { ...poll(grant), cancel: cancelCoding } : emptyPoll));
    } else res.end("{}");
  });
  const f = fixture(t, origin);
  workspace = f.workspace;
  grant = assignment(workspace);
  await f.executor.pollOnce();
  assert.equal(f.executor.runningJobId, "shell-test");
  assert.equal(codingPolls.at(-1)?.available, false);
  await f.executor.pollOnce();
  await f.executor.waitForIdle();
  allowCoding = true;
  await f.executor.pollOnce();
  assert.equal(codingPolls.at(-1)?.available, true);
  assert.equal(f.coding.activeRunId, grant.runId);
  const shellPollsAtClaim = shellPolls;
  await f.executor.pollOnce();
  assert.equal(shellPolls, shellPollsAtClaim);
  assert.equal(codingPolls.at(-1)?.activeRunId, grant.runId);
  await assert.rejects(f.executor.acceptAssignment({ jobId: "overlap", command: "true", cwd: workspace, timeoutMs: 1000, createdAt: new Date().toISOString() }));
  assert.equal(f.journal.get("overlap"), undefined);
  cancelCoding = true;
  await f.executor.pollOnce();
  await f.executor.flushCodingReports();
  assert.equal(f.coding.ownsSlot, false);
  assert(authorizations.every(value => value === `Bearer ${f.config.executorToken}`));
});

test("coding deadline and actual process cleanup remain local during coordinator disconnect", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
  const f = fixture(t);
  const grant = assignment(f.workspace, "deadline-run", 30_000);
  const running = request(grant, "exec", [[process.execPath, "-e", `require('node:fs').writeFileSync("ready", String(process.pid)); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)`], {}]);
  await f.coding.handlePoll(poll(grant, [running]), true);
  const executionCwd = f.codingJournal.executionCwd(grant.runId)!;
  const ready = join(executionCwd, "ready");
  await until(() => existsSync(ready), "Coding child did not start");
  await assert.rejects(f.executor.pollOnce(), CoordinatorUnavailable);
  t.mock.timers.tick(30_000);
  let stopped: Extract<CodingExecutorReport, { type: "stopped" }> | undefined;
  await until(async () => {
    await f.coding.flushReports(async report => { if (report.type === "stopped") stopped = report; });
    return stopped !== undefined;
  }, "Local coding deadline did not stop disconnected work");
  assert.equal(stopped!.uncertain, false);
  const pid = Number(readFileSync(ready, "utf8"));
  assert.throws(() => process.kill(pid, 0));
  assert.equal(f.coding.ownsSlot, false);
  const later = request(grant, "appendFile", ["after-deadline", "wrong"], 1);
  await f.coding.handlePoll(poll(grant, [later]), true);
  assert.equal(existsSync(join(executionCwd, "after-deadline")), false);
});

test("operation cancellation targets the real operation without losing sibling receipts or run ownership", async t => {
  const f = fixture(t);
  const grant = assignment(f.workspace);
  const running = request(grant, "exec", [[process.execPath, "-e", `require('node:fs').writeFileSync("cancel-ready", String(process.pid)); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)`], {}]);
  const sibling = request(grant, "appendFile", ["sibling-effect", "kept"], 1);
  await f.coding.handlePoll(poll(grant, [running, sibling]), true);
  const executionCwd = f.codingJournal.executionCwd(grant.runId)!;
  const ready = join(executionCwd, "cancel-ready");
  const effect = join(executionCwd, "sibling-effect");
  await until(() => existsSync(ready) && existsSync(effect), "Operations did not execute");
  const siblingResult = await operationResult(f.coding, sibling.operationId);
  await f.coding.handlePoll({ ...poll(grant), cancelOperationIds: [running.operationId] }, true);
  assert.notEqual((await operationResult(f.coding, running.operationId)).status, "running");
  assert.equal(f.coding.activeRunId, grant.runId);
  assert.equal(readFileSync(effect, "utf8"), "kept");
  await f.coding.handlePoll(poll(grant, [sibling]), true);
  assert.deepEqual(await operationResult(f.coding, sibling.operationId), siblingResult);
  assert.throws(() => process.kill(Number(readFileSync(ready, "utf8")), 0));
});

test("crashed coding ownership pauses both lanes until explicit CLI stopped reconciliation and never replays", async t => {
  const f = fixture(t);
  const grant = assignment(f.workspace);
  const marker = join(f.root, "receipt.json");
  const append = request(grant, "appendFile", ["crash-effect", "one"]);
  f.codingJournal.close();
  f.journal.close();
  const source = `
    import { CodingJournal, MacCodingExecutor } from ${JSON.stringify(new URL("../src/mac/coding.ts", import.meta.url).href)};
    import { ExecutionJournal } from ${JSON.stringify(new URL("../src/mac/journal.ts", import.meta.url).href)};
    import { writeFileSync, existsSync, renameSync } from 'node:fs';
    import { setImmediate as immediate } from 'node:timers/promises';
    const config = ${JSON.stringify(f.config)};
    const shell = new ExecutionJournal(${JSON.stringify(f.state)}, config);
    const journal = new CodingJournal(${JSON.stringify(f.state)}, config);
    const executor = new MacCodingExecutor(config, journal);
    await executor.handlePoll(${JSON.stringify(poll(grant, [append]))}, true);
    while (!existsSync(${JSON.stringify(marker)})) {
      try {
        await executor.flushReports(async report => {
          if (report.type === 'operation' && report.state.status === 'done') {
            writeFileSync(${JSON.stringify(marker + ".next")}, JSON.stringify(report), {mode:0o600});
            renameSync(${JSON.stringify(marker + ".next")}, ${JSON.stringify(marker)});
            throw new Error('offline');
          }
        });
      } catch {}
      await immediate();
    }
    await Promise.withResolvers().promise;
  `;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source], { cwd: repository, stdio: "ignore" });
  try {
    await until(() => existsSync(marker), "Crash fixture did not persist its effect receipt");
    const exited = once(child, "exit");
    child.kill("SIGKILL");
    await exited;
    const shell = new ExecutionJournal(f.state, f.config);
    const recovered = new CodingJournal(f.state, f.config);
    const effect = join(recovered.executionCwd(grant.runId)!, "crash-effect");
    const coding = new MacCodingExecutor(f.config, recovered);
    const executor = new MacExecutor(f.config, shell, () => {}, coding);
    try {
      assert.equal(coding.recoveryPaused, true);
      assert.equal(coding.available, false);
      await coding.handlePoll(poll(grant, [append]), true);
      await assert.rejects(executor.acceptAssignment({ jobId: "blocked-shell", cwd: f.workspace, command: "true", timeoutMs: 1000, createdAt: new Date().toISOString() }));
      const reports: CodingExecutorReport[] = [];
      await coding.flushReports(async report => { reports.push(report); });
      assert.deepEqual(reports.find(report => report.type === "operation"), JSON.parse(readFileSync(marker, "utf8")));
      assert(reports.some(report => report.type === "stopped" && report.uncertain && !report.ownerConfirmedStopped));
      assert.equal(coding.ownsSlot, true);
      assert.equal(readFileSync(effect, "utf8"), "one");
    } finally { await executor.stop(); recovered.close(); shell.close(); }
    const configPath = join(f.root, "config.json");
    writeFileSync(configPath, JSON.stringify(f.config), { mode: 0o600 });
    assert.notEqual(cli(configPath, f.state, "resume").status, 0);
    assert.equal(readCodingJournalStatus(f.state)?.recoveryPaused, true);
    const resumed = cli(configPath, f.state, "resume", "--confirm-stopped");
    assert.equal(resumed.status, 0, resumed.stderr);
    const reconciled = new CodingJournal(f.state, f.config);
    const restarted = new MacCodingExecutor(f.config, reconciled);
    try {
      assert.equal(restarted.recoveryPaused, false);
      assert.equal(restarted.available, false); // Reconciliation must reach the coordinator before another claim.
      const reports: CodingExecutorReport[] = [];
      await restarted.flushReports(async report => { reports.push(report); });
      assert(reports.some(report => report.type === "stopped" && report.uncertain && report.ownerConfirmedStopped));
      assert.equal(restarted.available, true);
      assert.equal(readFileSync(effect, "utf8"), "one");
    } finally { await restarted.shutdown(); reconciled.close(); }
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
    }
  }
});

test("coding journal fences executor and coordinator identities and retains immutable terminal operations", t => {
  const f = fixture(t);
  const grant = assignment(f.workspace);
  f.codingJournal.accept(grant);
  const operationId = request(grant, "exists", ["source.txt"]).operationId;
  const state: CodingRpcState = { operationId, status: "done", progress: emptyCodingProgress(), result: { ok: true, value: true } };
  f.codingJournal.operation(grant, state);
  assert.throws(() => f.codingJournal.operation(grant, { ...state, result: { ok: true, value: false } }));
  assert.throws(() => new CodingJournal(f.state, f.config));
  f.codingJournal.close();
  assert.throws(() => new CodingJournal(f.state, { ...f.config, executorId: "other-executor" }));
  assert.throws(() => new CodingJournal(f.state, { ...f.config, serverUrl: "https://other.example" }));
});

test("coding polling rejects unfenced operations and preserves long operation IDs for cancellation", t => {
  const f = fixture(t);
  const grant = assignment(f.workspace);
  assert.throws(() => parseCodingPollResult({ ...emptyPoll, requests: [request(grant, "remove", ["source.txt"])] }));
  assert.throws(() => parseCodingPollResult({ ...poll(grant), requests: [{ operationId: "bad", method: "constructor", args: [] }] }));
  const operationId = `${codingOperationPrefix("t".repeat(120), "r".repeat(120))}invocation:0`;
  assert.deepEqual(parseCodingPollResult({ ...poll(grant), cancelOperationIds: [operationId] }).cancelOperationIds, [operationId]);
});

test("colon-bearing run IDs cannot collide with another run's immutable receipt keys", async t => {
  const f = fixture(t);
  const first = assignment(f.workspace, "first-run");
  const operationId = `${codingOperationPrefix(first.taskId, first.runId)}invocation:ready`;
  const state: CodingRpcState = { operationId, status: "done", progress: emptyCodingProgress(), result: { ok: true, value: true } };
  f.codingJournal.accept(first);
  f.codingJournal.operation(first, state);
  f.codingJournal.stopped(first, false);
  for (const receipt of f.codingJournal.pendingReports()) f.codingJournal.acknowledge(receipt);
  const second = assignment(f.workspace, `${first.runId}:operation:${codingOperationPrefix(first.taskId, first.runId)}invocation`);
  f.codingJournal.accept(second);
  await f.codingJournal.prepareWorkspace(second);
  f.codingJournal.ready(second);
  f.codingJournal.requestResend(first.runId);
  assert.equal(f.codingJournal.activeRunId, second.runId);
  const reports = f.codingJournal.pendingReports().map(receipt => JSON.parse(receipt.payload) as CodingExecutorReport);
  assert(reports.some(report => report.runId === first.runId && report.type === "operation" && report.state.operationId === operationId));
  assert(reports.some(report => report.runId === second.runId && report.type === "ready"));
  f.codingJournal.stopped(second, false);
});

test("lost initial request delivery reconciles an exact durable cancellation without touching the filesystem", async t => {
  const f = fixture(t);
  const remote = coordinatorJournal(t, f.root, f.config);
  remote.create("lost-poll-task");
  const initial = remote.coding.poll(remote.executorPoll());
  const grant = initial.assignment!;
  await f.coding.handlePoll(initial, true);
  await f.coding.flushReports(async report => { remote.report(report); });
  const effect = join(f.codingJournal.executionCwd(grant.runId)!, "never-admitted");
  const append = request(grant, "appendFile", [effect, "must not run"]);
  remote.coding.enqueueRpc(grant.taskId, grant.runId, append);
  // The coordinator commits dispatch, but this first response never reaches Mac.
  const lost = remote.coding.poll(remote.executorPoll({ available: false, activeRunId: grant.runId }));
  assert.deepEqual(lost.requests, [append]);
  assert.equal(remote.coding.operation(append.operationId)?.dispatched, true);
  remote.coding.cancelOperation(grant.taskId, grant.runId, append.operationId);
  await f.coding.handlePoll({ ...poll(grant), cancelOperationIds: [append.operationId] }, true);
  await f.coding.flushReports(async report => { remote.report(report); });
  assert.equal(remote.coding.operation(append.operationId)?.receipt, undefined);
  const reconciled = remote.coding.poll(remote.executorPoll({ available: false, activeRunId: grant.runId }));
  assert.deepEqual(reconciled.requests, [append]);
  assert.deepEqual(reconciled.cancelOperationIds, [append.operationId]);
  await f.coding.handlePoll(reconciled, true);
  await assert.rejects(f.coding.flushReports(async () => { throw new CoordinatorUnavailable(503); }), CoordinatorUnavailable);
  assert.equal(existsSync(effect), false);
  await f.coding.flushReports(async report => { remote.report(report); });
  const cancellation = remote.coding.operation(append.operationId)!.receipt!;
  assert.equal(cancellation.status, "done");
  assert.equal(cancellation.result?.ok, false);
  if (!cancellation.result?.ok) assert.equal(cancellation.result?.error.code, "aborted");
  assert.equal(remote.coding.pendingOperations(grant.runId).length, 0);
  // Late original delivery can only replay the real cancellation receipt.
  await f.coding.handlePoll(lost, true);
  await f.coding.flushReports(async report => { remote.report(report); });
  assert.deepEqual(remote.coding.operation(append.operationId)?.receipt, cancellation);
  assert.equal(existsSync(effect), false);
  assert.equal(remote.coding.requestFinish(grant.taskId, grant.runId, {
    expectedVersion: remote.coding.requireTask(grant.taskId).version,
    outcome: "blocked", summary: "Owner cancelled this operation before admission", verificationCommands: [],
  }).status, "finishing");
});

test("delayed stopped-grant poll after report acknowledgement cannot reclaim the slot or starve either lane", async t => {
  let remote: CoordinatorJournalFixture;
  let oldRunId = "";
  let holdOldPoll = false;
  const delayed = Promise.withResolvers<{ response: ServerResponse; result: CodingExecutorPollResult }>();
  const origin = await coordinator(t, (req, res, body) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/api/executor/coding/poll") {
      const input = JSON.parse(body) as CodingExecutorPoll;
      const result = remote.coding.poll(input);
      if (holdOldPoll && input.activeRunId === oldRunId) {
        holdOldPoll = false;
        delayed.resolve({ response: res, result });
      } else res.end(JSON.stringify(result));
    } else if (req.url === "/api/executor/coding/report") {
      remote.report(JSON.parse(body) as CodingExecutorReport);
      res.end("{}");
    } else if (req.url === "/api/executor/poll") res.end(JSON.stringify(remote.owner.poll(JSON.parse(body))));
    else if (req.url === "/api/executor/complete") {
      remote.owner.complete(JSON.parse(body));
      res.end("{}");
    } else res.writeHead(404).end();
  });
  const f = fixture(t, origin);
  remote = coordinatorJournal(t, f.root, f.config);
  remote.create("stale-grant-task");
  await f.executor.pollOnce();
  await f.executor.flushCodingReports();
  oldRunId = f.coding.activeRunId!;
  const oldTask = remote.coding.requireTask("stale-grant-task");
  remote.coding.cancel(oldTask.taskId, oldTask.version);
  await f.executor.pollOnce();
  assert.equal(f.coding.ownsSlot, true); // Pending stop must still own the slot.
  holdOldPoll = true;
  const stop = new AbortController();
  let exited = false;
  let serviceError: unknown;
  const running = f.executor.run(stop.signal).then(() => { exited = true; }, error => { serviceError = error; exited = true; });
  try {
    let held: { response: ServerResponse; result: CodingExecutorPollResult } | undefined;
    void delayed.promise.then(value => { held = value; });
    await until(() => held !== undefined || exited, "The old owned-run poll was not dispatched");
    assert.ok(held);
    assert.equal(held.result.assignment?.runId, oldRunId);
    assert.equal(held.result.cancel, true);
    await until(() => !f.coding.ownsSlot, "Stopped report was not acknowledged while the old poll was delayed");
    assert.equal(f.codingJournal.snapshot().unacknowledgedReports, 0);
    remote.create("next-coding-task");
    const shellEffect = join(f.workspace, "shell-after-stale-poll");
    remote.owner.createJob({
      jobId: "shell-after-stale-poll", command: "printf 'shell resumed' > shell-after-stale-poll",
      cwd: f.workspace, timeoutMs: 1000, createdAt: new Date().toISOString(),
    }, "control", "owner-control");
    remote.owner.approveJob("shell-after-stale-poll", 1);
    held.response.end(JSON.stringify(held.result));
    await until(() => existsSync(shellEffect), "The acknowledged old coding grant starved shell polling");
    await until(() => remote.coding.requireTask("next-coding-task").status === "running", "The acknowledged old coding grant starved a new coding claim");
    const newRunId = f.coding.activeRunId;
    await f.coding.handlePoll(held.result, true);
    assert.equal(f.coding.activeRunId, newRunId);
    assert.equal(readFileSync(shellEffect, "utf8"), "shell resumed");
    assert.equal(remote.owner.job("shell-after-stale-poll")!.status, "succeeded");
    assert.notEqual(f.coding.activeRunId, oldRunId);
    assert.equal(f.coding.recoveryPaused, false);
    assert.equal(f.codingJournal.snapshot().outstanding.some(run => run.runId === oldRunId), false);
    assert.equal(exited, false);
    assert.equal(serviceError, undefined);
  } finally {
    stop.abort();
    await running;
  }
});

test("bounded admission has a durable refusal while the actual shared daemon keeps both lanes usable", async t => {
  let remote: CoordinatorJournalFixture;
  const origin = await coordinator(t, (req, res, body) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/api/executor/coding/poll") res.end(JSON.stringify(remote.coding.poll(JSON.parse(body))));
    else if (req.url === "/api/executor/coding/report") {
      remote.report(JSON.parse(body) as CodingExecutorReport);
      res.end("{}");
    } else if (req.url === "/api/executor/poll") res.end(JSON.stringify(remote.owner.poll(JSON.parse(body))));
    else if (req.url === "/api/executor/complete") {
      remote.owner.complete(JSON.parse(body));
      res.end("{}");
    } else res.writeHead(404).end();
  });
  const f = fixture(t, origin);
  remote = coordinatorJournal(t, f.root, f.config);
  remote.create("bounded-admission-task");
  await f.executor.pollOnce();
  await f.executor.flushCodingReports();
  const grant = remote.coding.requireTask("bounded-admission-task").run!.assignment;
  const executionCwd = f.codingJournal.executionCwd(grant.runId)!;
  const markers = Array.from({ length: 8 }, (_, index) => join(executionCwd, `active-${index}`));
  const accepted = markers.map((marker, index) => request(grant, "exec", [[process.execPath, "-e",
    `require('node:fs').writeFileSync(${JSON.stringify(marker)}, String(process.pid)); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)`,
  ], {}], index));
  for (const operation of accepted) remote.coding.enqueueRpc(grant.taskId, grant.runId, operation);
  const refusedEffect = join(executionCwd, "refused-effect");
  const refused = request(grant, "appendFile", [refusedEffect, "wrong"], 8);
  remote.coding.enqueueRpc(grant.taskId, grant.runId, refused);
  const stop = new AbortController();
  let exited = false;
  let serviceError: unknown;
  const running = f.executor.run(stop.signal).then(() => { exited = true; }, error => { serviceError = error; exited = true; });
  try {
    await until(() => markers.every(marker => existsSync(marker)) && remote.coding.operation(refused.operationId)?.receipt?.status === "done", "Bounded admission did not retain and report its real refusal");
    const receipt = remote.coding.operation(refused.operationId)!.receipt!;
    assert.equal(receipt.result?.ok, false);
    if (!receipt.result?.ok) assert.equal(receipt.result?.error.code, "invalid");
    assert.equal(existsSync(refusedEffect), false);
    assert.equal(f.coding.activeRunId, grant.runId);
    assert.equal(exited, false);
    for (const operation of accepted) remote.coding.cancelOperation(grant.taskId, grant.runId, operation.operationId);
    await until(() => accepted.every(operation => remote.coding.operation(operation.operationId)?.receipt?.status === "done"), "Cancellation did not settle admitted operations after refusal");
    const subsequentEffect = join(executionCwd, "after-refusal");
    const subsequent = request(grant, "appendFile", [subsequentEffect, "coding resumed"], 9);
    remote.coding.enqueueRpc(grant.taskId, grant.runId, subsequent);
    await until(() => remote.coding.operation(subsequent.operationId)?.receipt?.status === "done", "The daemon did not accept coding work after its bounded refusal");
    assert.equal(remote.coding.operation(subsequent.operationId)?.receipt?.result?.ok, true);
    assert.equal(readFileSync(subsequentEffect, "utf8"), "coding resumed");
    const task = remote.coding.requireTask(grant.taskId);
    remote.coding.cancel(task.taskId, task.version);
    remote.owner.createJob({
      jobId: "shell-after-refusal", command: "printf 'shell resumed' > shell-after-refusal",
      cwd: f.workspace, timeoutMs: 1000, createdAt: new Date().toISOString(),
    }, "control", "owner-control");
    remote.owner.approveJob("shell-after-refusal", 1);
    await until(() => remote.owner.job("shell-after-refusal")?.status === "succeeded", "The coding refusal terminated or starved the shared shell daemon");
    assert.equal(readFileSync(join(f.workspace, "shell-after-refusal"), "utf8"), "shell resumed");
    assert.equal(f.coding.recoveryPaused, false);
    assert.equal(exited, false);
    assert.equal(serviceError, undefined);
  } finally {
    stop.abort();
    await running;
  }
});

test("native coding mutates only its durable source copy and preserves dirty owner work through replay and restart", async t => {
  const f = fixture(t);
  execFileSync("git", ["-C", f.workspace, "add", "--", "source.txt"]);
  writeFileSync(join(f.workspace, "source.txt"), "owner dirty source\n");
  const untracked = Buffer.from([0, 1, 2, 255]);
  writeFileSync(join(f.workspace, "notes.bin"), untracked);
  writeFileSync(join(f.workspace, ".env.local"), "DO_NOT_COPY=private\n");
  mkdirSync(join(f.workspace, "node_modules"));
  writeFileSync(join(f.workspace, "node_modules", "generated.txt"), "do not copy");
  const originalIndex = readFileSync(join(f.workspace, ".git", "index"));
  const grant = assignment(f.workspace, "private-copy-run");
  await f.coding.handlePoll(poll(grant), true);
  const executionCwd = f.codingJournal.executionCwd(grant.runId)!;
  assert.notEqual(executionCwd, f.workspace);
  assert.equal(executionCwd.startsWith(`${f.state}/`), true);
  assert.equal(readFileSync(join(executionCwd, "source.txt"), "utf8"), "owner dirty source\n");
  assert.deepEqual(readFileSync(join(executionCwd, "notes.bin")), untracked);
  assert.equal(existsSync(join(executionCwd, ".env.local")), false);
  assert.equal(existsSync(join(executionCwd, "node_modules")), false);
  const reports: CodingExecutorReport[] = [];
  await f.coding.flushReports(async report => { reports.push(report); });
  assert.equal(reports.find(report => report.type === "ready")?.executionCwd, executionCwd);
  // Owner edits after capture stay in the original; coding sees the pinned copy.
  writeFileSync(join(f.workspace, "source.txt"), "owner later source\n");
  const mutation = request(grant, "writeFile", ["source.txt", "private copy changed\n"]);
  await f.coding.handlePoll(poll(grant, [mutation]), true);
  assert.equal((await operationResult(f.coding, mutation.operationId)).result?.ok, true);
  assert.equal(readFileSync(join(executionCwd, "source.txt"), "utf8"), "private copy changed\n");
  assert.equal(readFileSync(join(f.workspace, "source.txt"), "utf8"), "owner later source\n");
  assert.deepEqual(readFileSync(join(f.workspace, "notes.bin")), untracked);
  assert.deepEqual(readFileSync(join(f.workspace, ".git", "index")), originalIndex);
  const review = request(grant, "artifacts", [], 1);
  await f.coding.handlePoll(poll(grant, [review]), true);
  const result = (await operationResult(f.coding, review.operationId)).result;
  assert.ok(result?.ok);
  const artifacts = result.value as unknown as CodingArtifacts;
  assert.deepEqual(artifacts.changes, [{ path: "source.txt", kind: "modified" }]);
  assert.match(artifacts.patch, /-owner dirty source\n/);
  assert.match(artifacts.patch, /\+private copy changed\n/);
  assert.equal(artifacts.patch.includes("owner later source"), false);
  await assert.rejects(f.coding.handlePoll(poll({ ...grant, deadlineAt: new Date(Date.now() + 60_000).toISOString() }), true));
  assert.equal(f.coding.recoveryPaused, true);
  assert.equal(readFileSync(join(executionCwd, "source.txt"), "utf8"), "private copy changed\n");
  f.codingJournal.close();
  writeFileSync(join(f.workspace, "source.txt"), "owner source after restart\n");
  const reopened = new CodingJournal(f.state, f.config);
  const restarted = new MacCodingExecutor(f.config, reopened);
  try {
    assert.equal(reopened.executionCwd(grant.runId), executionCwd);
    assert.equal(restarted.recoveryPaused, true);
    await restarted.handlePoll(poll(grant, [mutation]), true);
    await restarted.flushReports(async () => {});
    assert.equal(restarted.ownsSlot, true);
    assert.equal(readFileSync(join(executionCwd, "source.txt"), "utf8"), "private copy changed\n");
    assert.equal(readFileSync(join(f.workspace, "source.txt"), "utf8"), "owner source after restart\n");
    assert.deepEqual(readFileSync(join(f.workspace, ".git", "index")), originalIndex);
    assert.deepEqual(readFileSync(join(f.workspace, "notes.bin")), untracked);
  } finally { await restarted.shutdown(); reopened.close(); }
});

test("remaining request identity errors are retained as uncertainty without inventing terminal success", async t => {
  const f = fixture(t);
  const grant = assignment(f.workspace, "identity-refusal-run");
  const original = request(grant, "appendFile", ["effect.txt", "one"]);
  await f.coding.handlePoll(poll(grant, [original]), true);
  const receipt = await operationResult(f.coding, original.operationId);
  await f.coding.handlePoll(poll(grant, [{ ...original, args: ["effect.txt", "wrong"] }]), true);
  const reports: CodingExecutorReport[] = [];
  await f.coding.flushReports(async report => { reports.push(report); });
  assert(reports.some(report => report.type === "stopped" && report.uncertain));
  assert.equal(f.coding.recoveryPaused, true);
  assert.equal(f.coding.ownsSlot, true);
  assert.equal(readFileSync(join(f.codingJournal.executionCwd(grant.runId)!, "effect.txt"), "utf8"), "one");
  assert.equal(existsSync(join(f.workspace, "effect.txt")), false);
  const operation = reports.find(report => report.type === "operation");
  if (operation?.type === "operation") assert.deepEqual(operation.state, receipt);
  await assert.rejects(f.executor.acceptAssignment({
    jobId: "shell-blocked-by-uncertainty", command: "true", cwd: f.workspace,
    timeoutMs: 1000, createdAt: new Date().toISOString(),
  }));
  assert.equal(f.journal.get("shell-blocked-by-uncertainty"), undefined);
});

test("native continuation copies the prior owned workspace instead of replacing pending work from the original", async t => {
  const f = fixture(t);
  const first = assignment(f.workspace, "source-copy-run");
  const initial = request(first, "writeFile", ["source.txt", "private first change\n"]);
  const addition = request(first, "writeFile", ["private-added.txt", "preserve private addition\n"], 1);
  await f.coding.handlePoll(poll(first, [initial, addition]), true);
  assert.equal((await operationResult(f.coding, initial.operationId)).result?.ok, true);
  assert.equal((await operationResult(f.coding, addition.operationId)).result?.ok, true);
  const firstCwd = f.codingJournal.executionCwd(first.runId)!;
  await f.coding.stop();
  await f.coding.flushReports(async () => {});
  assert.equal(f.coding.ownsSlot, false);
  writeFileSync(join(f.workspace, "source.txt"), "owner changed original after first run\n");
  writeFileSync(join(f.workspace, "owner-added.txt"), "owner later addition\n");
  const next: CodingAssignment = { ...assignment(f.workspace, "continued-copy-run"), sourceRunId: first.runId };
  await f.coding.handlePoll(poll(next), true);
  const nextCwd = f.codingJournal.executionCwd(next.runId)!;
  assert.notEqual(nextCwd, firstCwd);
  assert.equal(readFileSync(join(nextCwd, "source.txt"), "utf8"), "private first change\n");
  assert.equal(readFileSync(join(nextCwd, "private-added.txt"), "utf8"), "preserve private addition\n");
  assert.equal(existsSync(join(nextCwd, "owner-added.txt")), false);
  const changed = request(next, "writeFile", ["source.txt", "private second change\n"]);
  await f.coding.handlePoll(poll(next, [changed]), true);
  assert.equal((await operationResult(f.coding, changed.operationId)).result?.ok, true);
  const review = request(next, "artifacts", [], 1);
  await f.coding.handlePoll(poll(next, [review]), true);
  const result = (await operationResult(f.coding, review.operationId)).result;
  assert.ok(result?.ok);
  const artifacts = result.value as unknown as CodingArtifacts;
  assert.deepEqual(artifacts.changes, [{ path: "source.txt", kind: "modified" }]);
  assert.match(artifacts.patch, /-private first change\n/);
  assert.match(artifacts.patch, /\+private second change\n/);
  assert.equal(readFileSync(join(firstCwd, "source.txt"), "utf8"), "private first change\n");
  assert.equal(readFileSync(join(f.workspace, "source.txt"), "utf8"), "owner changed original after first run\n");
  assert.equal(readFileSync(join(f.workspace, "owner-added.txt"), "utf8"), "owner later addition\n");
  assert.equal(existsSync(join(f.workspace, "private-added.txt")), false);
});

test("a missing or foreign continuation source never falls back to executing the original workspace", async t => {
  const missing = fixture(t);
  const grant: CodingAssignment = { ...assignment(missing.workspace, "missing-copy-run"), sourceRunId: "unknown-source-run" };
  await missing.coding.handlePoll(poll(grant, [request(grant, "appendFile", ["source.txt", "wrong"])]), true);
  assert.equal(missing.codingJournal.executionCwd(grant.runId), undefined);
  assert.equal(readFileSync(join(missing.workspace, "source.txt"), "utf8"), "baseline\n");
  const reports: CodingExecutorReport[] = [];
  await missing.coding.flushReports(async report => { reports.push(report); });
  assert.equal(reports.some(report => report.type === "ready"), false);
  assert(reports.some(report => report.type === "stopped" && report.uncertain));
  assert.equal(missing.coding.ownsSlot, true);

  const foreign = fixture(t);
  const source = assignment(foreign.workspace, "foreign-source-run");
  await foreign.coding.handlePoll(poll(source), true);
  await foreign.coding.stop();
  await foreign.coding.flushReports(async () => {});
  const otherTask: CodingAssignment = { ...assignment(foreign.workspace, "foreign-copy-run"), taskId: "another-task", sourceRunId: source.runId };
  await foreign.coding.handlePoll(poll(otherTask, [request(otherTask, "appendFile", ["source.txt", "wrong"])]), true);
  assert.equal(foreign.codingJournal.executionCwd(otherTask.runId), undefined);
  assert.equal(readFileSync(join(foreign.workspace, "source.txt"), "utf8"), "baseline\n");
  assert.equal(foreign.coding.recoveryPaused, true);
});

test("owner stop still reconciles a lost dispatched request before acknowledging the entire run", async t => {
  const f = fixture(t);
  const remote = coordinatorJournal(t, f.root, f.config);
  remote.create("lost-request-owner-stop");
  const initial = remote.coding.poll(remote.executorPoll());
  const grant = initial.assignment!;
  await f.coding.handlePoll(initial, true);
  await f.coding.flushReports(async report => { remote.report(report); });
  const append = request(grant, "appendFile", ["never-admitted-on-stop", "wrong"]);
  remote.coding.enqueueRpc(grant.taskId, grant.runId, append);
  remote.coding.poll(remote.executorPoll({ available: false, activeRunId: grant.runId }));
  remote.coding.cancelOperation(grant.taskId, grant.runId, append.operationId);
  const task = remote.coding.requireTask(grant.taskId);
  remote.coding.cancel(task.taskId, task.version);
  const cancelled = remote.coding.poll(remote.executorPoll({ available: false, activeRunId: grant.runId }));
  assert.equal(cancelled.cancel, true);
  assert.deepEqual(cancelled.requests, [append]);
  await f.coding.handlePoll(cancelled, true);
  assert.equal(f.coding.ownsSlot, true);
  await f.coding.flushReports(async report => { remote.report(report); });
  const receipt = remote.coding.operation(append.operationId)!.receipt!;
  assert.equal(receipt.status, "done");
  assert.equal(receipt.result?.ok, false);
  if (!receipt.result?.ok) assert.equal(receipt.result?.error.code, "aborted");
  assert.equal(remote.coding.pendingOperations(grant.runId).length, 0);
  assert.equal(remote.coding.requireTask(grant.taskId).status, "cancelled");
  assert.equal(f.coding.ownsSlot, false);
  assert.equal(existsSync(join(f.codingJournal.executionCwd(grant.runId)!, "never-admitted-on-stop")), false);
  assert.equal(existsSync(join(f.workspace, "never-admitted-on-stop")), false);
});
