import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import type { JobCompletion, MacJobAssignment } from "../src/shared/protocol.ts";
import { MAX_JOB_OUTPUT } from "../src/shared/protocol.ts";
import { allowedCwd, initializeConfig, loadConfig, parseConfig, type MacConfig } from "../src/mac/config.ts";
import { ExecutionJournal } from "../src/mac/journal.ts";
import { CoordinatorUnavailable, MacExecutor } from "../src/mac/daemon.ts";

function shellArgument(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function nodeCommand(source: string): string {
  return `${shellArgument(process.execPath)} -e ${shellArgument(source)}`;
}

function fixture(t: TestContext, serverUrl = "http://127.0.0.1:1") {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "umpi-mac-test-")));
  const workspace = join(root, "workspace");
  mkdirSync(workspace, { mode: 0o700 });
  const config: MacConfig = { executorId: "executor-test", executorToken: "private-test-token-with-at-least-32-characters", serverUrl, workspaces: [workspace], pollIntervalMs: 100, coding: { enabled: false }, browser: { enabled: false, allSites: false, sites: [] } };
  const state = join(root, "state");
  const journal = new ExecutionJournal(state, config);
  const executor = new MacExecutor(config, journal);
  t.after(async () => { await executor.stop(); journal.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, workspace, config, state, journal, executor };
}

function assignment(cwd: string, command: string, jobId = "job-test", timeoutMs = 5000): MacJobAssignment {
  return { jobId, command, cwd, timeoutMs, createdAt: new Date().toISOString() };
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error("Child process did not reach its durable test effect");
    await delay(10);
  }
}

async function coordinator(t: TestContext, handle: (request: IncomingMessage, response: ServerResponse, body: string) => void): Promise<string> {
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += String(chunk);
    handle(request, response, body);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); }));
  const address = server.address();
  assert(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
}

test("duplicate and conflicting assignments never repeat a real filesystem effect", async t => {
  const f = fixture(t);
  const effect = join(f.workspace, "effects.txt");
  const job = assignment(f.workspace, nodeCommand(`require('node:fs').appendFileSync(${JSON.stringify(effect)}, 'one\\n'); setTimeout(() => {}, 150)`));
  await f.executor.acceptAssignment(job);
  await f.executor.acceptAssignment(job);
  await f.executor.waitForIdle();
  const completion = f.journal.get(job.jobId)!.completion;
  assert.equal(completion?.status, "succeeded");
  await f.executor.acceptAssignment(job);
  assert.equal(readFileSync(effect, "utf8"), "one\n");
  assert.deepEqual(f.journal.get(job.jobId)!.completion, completion);
  await assert.rejects(f.executor.acceptAssignment({ ...job, command: "rm -f never-run" }));
  assert.equal(readFileSync(effect, "utf8"), "one\n");
  f.journal.close();
  const reopened = new ExecutionJournal(f.state, f.config);
  const restarted = new MacExecutor(f.config, reopened);
  try {
    await restarted.acceptAssignment(job);
    assert.equal(restarted.runningJobId, null);
    assert.deepEqual(reopened.pendingCompletions(), [completion]);
    assert.equal(readFileSync(effect, "utf8"), "one\n");
  } finally { await restarted.stop(); reopened.close(); }
});

test("result callback retry sends identical durable completion without rerunning command", async t => {
  const received: string[] = [];
  const authorizations: (string | undefined)[] = [];
  const origin = await coordinator(t, (request, response, body) => {
    received.push(body);
    authorizations.push(request.headers.authorization);
    response.writeHead(received.length === 1 ? 503 : 200).end("{}");
  });
  const f = fixture(t, origin);
  const effect = join(f.workspace, "delivery-effects");
  const job = assignment(f.workspace, nodeCommand(`require('node:fs').appendFileSync(${JSON.stringify(effect)}, 'one')`));
  await f.executor.acceptAssignment(job);
  await f.executor.waitForIdle();
  await assert.rejects(f.executor.flushCompletions(), CoordinatorUnavailable);
  assert.equal(f.journal.pendingCompletions().length, 1);
  f.journal.close();
  const reopened = new ExecutionJournal(f.state, f.config);
  const restarted = new MacExecutor(f.config, reopened);
  try {
    await restarted.acceptAssignment(job);
    await restarted.flushCompletions();
    assert.equal(received.length, 2);
    assert.equal(received[0], received[1]);
    assert.deepEqual(authorizations, [`Bearer ${f.config.executorToken}`, `Bearer ${f.config.executorToken}`]);
    assert.equal(reopened.pendingCompletions().length, 0);
    assert.equal(readFileSync(effect, "utf8"), "one");
  } finally { await restarted.stop(); reopened.close(); }
});

test("unresolved start intent recovers as immutable uncertainty and requires explicit resume", async t => {
  const f = fixture(t);
  const effect = join(f.workspace, "must-not-replay");
  const job = assignment(f.workspace, nodeCommand(`require('node:fs').writeFileSync(${JSON.stringify(effect)}, 'unexpected')`));
  f.journal.accept(job);
  f.journal.startIntent(job.jobId);
  f.journal.close();
  const recovered = new ExecutionJournal(f.state, f.config);
  const restarted = new MacExecutor(f.config, recovered);
  try {
    const completion = recovered.get(job.jobId)!.completion;
    assert.equal(completion?.status, "uncertain");
    assert.equal(recovered.recoveryPaused, true);
    await restarted.acceptAssignment(job);
    assert.equal(existsSync(effect), false);
    const next = assignment(f.workspace, nodeCommand(`require('node:fs').writeFileSync(${JSON.stringify(effect)}, 'new-approved-job')`), "next-job");
    await restarted.acceptAssignment(next);
    assert.equal(recovered.get(next.jobId)?.phase, "assigned");
    assert.equal(existsSync(effect), false);
    recovered.resumeAfterOwnerConfirmation();
    await restarted.acceptAssignment(next);
    await restarted.waitForIdle();
    assert.equal(readFileSync(effect, "utf8"), "new-approved-job");
    assert.deepEqual(recovered.get(job.jobId)!.completion, completion);
  } finally { await restarted.stop(); recovered.close(); }
});

test("SIGKILL crash preserves a real running command journal without replay", async t => {
  const f = fixture(t);
  f.journal.close();
  const effect = join(f.workspace, "crash-effects");
  const job = assignment(f.workspace, nodeCommand(`require('node:fs').appendFileSync(${JSON.stringify(effect)}, 'one'); setInterval(() => {}, 1000)`), "crash-job", 30_000);
  const journalModule = new URL("../src/mac/journal.ts", import.meta.url).href;
  const executorModule = new URL("../src/mac/daemon.ts", import.meta.url).href;
  const source = `import { ExecutionJournal } from ${JSON.stringify(journalModule)}; import { MacExecutor } from ${JSON.stringify(executorModule)}; const config = ${JSON.stringify(f.config)}; const journal = new ExecutionJournal(${JSON.stringify(f.state)}, config); const executor = new MacExecutor(config, journal); await executor.acceptAssignment(${JSON.stringify(job)});`;
  const daemon = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source], { cwd: fileURLToPath(new URL("../", import.meta.url)), stdio: "ignore" });
  let orphanPid: number | null = null;
  let groupStopped = false;
  try {
    await waitForFile(effect);
    const exited = once(daemon, "exit");
    daemon.kill("SIGKILL");
    await exited;
    const recovered = new ExecutionJournal(f.state, f.config);
    const restarted = new MacExecutor(f.config, recovered);
    try {
      const entry = recovered.get(job.jobId)!;
      orphanPid = entry.pid;
      assert.equal(entry.completion?.status, "uncertain");
      assert.equal(recovered.recoveryPaused, true);
      assert(orphanPid !== null);
      process.kill(-orphanPid, "SIGKILL");
      orphanPid = null;
      groupStopped = true;
      await restarted.acceptAssignment(job);
      assert.equal(readFileSync(effect, "utf8"), "one");
      assert.equal(restarted.runningJobId, null);
    } finally { await restarted.stop(); recovered.close(); }
  } finally {
    if (daemon.exitCode === null && daemon.signalCode === null) {
      const exited = once(daemon, "exit");
      daemon.kill("SIGKILL");
      await exited;
    }
    if (!groupStopped) {
      const abandoned = new ExecutionJournal(f.state, f.config);
      try { orphanPid ??= abandoned.get(job.jobId)?.pid ?? null; } finally { abandoned.close(); }
      if (orphanPid !== null) { try { process.kill(-orphanPid, "SIGKILL"); } catch { /* Already exited. */ } }
    }
  }
});

test("cwd validation rejects sibling-prefix paths, relative paths, and symlink escapes", async t => {
  const f = fixture(t);
  const outside = join(f.root, "workspace-outside");
  mkdirSync(outside);
  symlinkSync(outside, join(f.workspace, "escape"));
  assert.throws(() => allowedCwd(outside, f.config.workspaces));
  assert.throws(() => allowedCwd(".", f.config.workspaces));
  assert.throws(() => allowedCwd(join(f.workspace, "escape"), f.config.workspaces));
  const effect = join(outside, "must-not-exist");
  await f.executor.acceptAssignment(assignment(join(f.workspace, "escape"), nodeCommand(`require('node:fs').writeFileSync(${JSON.stringify(effect)}, 'unsafe')`)));
  await f.executor.waitForIdle();
  assert.equal(existsSync(effect), false);
  assert.equal(f.journal.get("job-test")?.completion?.status, "failed");
});

test("combined stdout and stderr stay bounded while the real command completes", async t => {
  const f = fixture(t);
  const job = assignment(f.workspace, nodeCommand(`process.stdout.write(Buffer.alloc(${MAX_JOB_OUTPUT * 4}, 97)); process.stderr.write(Buffer.alloc(${MAX_JOB_OUTPUT * 4}, 98));`));
  await f.executor.acceptAssignment(job);
  await f.executor.waitForIdle();
  const completion = f.journal.get(job.jobId)!.completion!;
  assert.equal(completion.status, "succeeded");
  assert.equal(completion.truncated, true);
  assert(completion.output.length <= MAX_JOB_OUTPUT);
  assert(completion.output.length > 0);
});

test("polling continues during execution and cancellation kills the process group", async t => {
  let job: MacJobAssignment;
  let ready: string;
  let polls = 0;
  let finish!: (completion: JobCompletion) => void;
  const delivered = new Promise<JobCompletion>(resolve => { finish = resolve; });
  const origin = await coordinator(t, (request, response, body) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/api/executor/complete") {
      finish(JSON.parse(body) as JobCompletion);
      response.end("{}");
    } else {
      polls++;
      response.end(JSON.stringify({ job, cancelJobIds: existsSync(ready) ? [job.jobId] : [] }));
    }
  });
  const f = fixture(t, origin);
  ready = join(f.workspace, "running");
  const lateEffect = join(f.workspace, "descendant-effect");
  const descendant = `process.on('SIGTERM', () => {}); setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(lateEffect)}, 'late-effect'), 2000);`;
  job = assignment(f.workspace, nodeCommand(`require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { stdio: 'inherit' }); require('node:fs').writeFileSync(${JSON.stringify(ready)}, 'ready'); process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);`));
  const stop = new AbortController();
  const running = f.executor.run(stop.signal);
  const deadline = new AbortController();
  try {
    const completion = await Promise.race([delivered, delay(7000, undefined, { signal: deadline.signal }).then(() => { throw new Error("Cancellation was not delivered"); })]);
    assert.equal(completion.status, "cancelled");
    assert(polls >= 2);
  } finally { deadline.abort(); stop.abort(); await running; }
  await delay(2100);
  assert.equal(existsSync(lateEffect), false);
});

test("a timeout is a failed result rather than a cancellation or successful replay", async t => {
  const f = fixture(t);
  const job = assignment(f.workspace, nodeCommand("setInterval(() => {}, 1000)"), "timeout-job", 1000);
  await f.executor.acceptAssignment(job);
  await f.executor.waitForIdle();
  const completion = f.journal.get(job.jobId)!.completion!;
  assert.equal(completion.status, "failed");
  assert.equal(completion.exitCode, null);
  await f.executor.acceptAssignment(job);
  assert.equal(f.executor.runningJobId, null);
  assert.deepEqual(f.journal.get(job.jobId)!.completion, completion);
});

test("transport secrets are not inherited by approved command children", async t => {
  const f = fixture(t);
  const names = ["UMPI_EXECUTOR_TOKEN", "UMPI_CONTROL_TOKEN", "TELEGRAM_BOT_TOKEN", "TELEGRAM_WEBHOOK_SECRET"];
  const saved = names.map(name => process.env[name]);
  const effect = join(f.workspace, "environment-names.json");
  try {
    for (const name of names) process.env[name] = "private-fixture-value";
    const job = assignment(f.workspace, nodeCommand(`require('node:fs').writeFileSync(${JSON.stringify(effect)}, JSON.stringify(Object.keys(process.env).filter(name => /^(UMPI_|TELEGRAM_)/i.test(name))))`));
    await f.executor.acceptAssignment(job);
    await f.executor.waitForIdle();
    assert.deepEqual(JSON.parse(readFileSync(effect, "utf8")), []);
  } finally {
    names.forEach((name, index) => { if (saved[index] === undefined) delete process.env[name]; else process.env[name] = saved[index]; });
  }
});

test("private configuration, stable identity, HTTPS, and exclusive state ownership are enforced", t => {
  const f = fixture(t);
  const configPath = join(f.root, "config.json");
  const created = initializeConfig(configPath, { serverUrl: f.config.serverUrl, executorToken: f.config.executorToken, workspaces: f.config.workspaces });
  assert.equal(loadConfig(configPath).executorId, created.executorId);
  assert.equal(statSync(configPath).mode & 0o777, 0o600);
  assert.throws(() => initializeConfig(configPath, { serverUrl: f.config.serverUrl, executorToken: f.config.executorToken, workspaces: f.config.workspaces }));
  chmodSync(configPath, 0o644);
  assert.throws(() => loadConfig(configPath));
  chmodSync(configPath, 0o600);
  assert.throws(() => parseConfig({ ...f.config, serverUrl: "http://remote.example" }));
  assert.throws(() => parseConfig({ ...f.config, serverUrl: "https://user:credential@example.com" }));
  assert.throws(() => new ExecutionJournal(f.state, f.config));
  const link = join(f.root, "config-link.json");
  symlinkSync(configPath, link);
  assert.throws(() => loadConfig(link));
  f.journal.close();
  assert.throws(() => new ExecutionJournal(f.state, { ...f.config, executorId: "different-executor" }));
});

test("unknown cancellation does not invent a command result and disconnect does not kill work", async t => {
  const f = fixture(t);
  f.executor.cancel("unknown-job");
  assert.equal(f.journal.get("unknown-job"), undefined);
  const effect = join(f.workspace, "offline-effect");
  const job = assignment(f.workspace, nodeCommand(`setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(effect)}, 'finished-offline'), 100)`));
  await f.executor.acceptAssignment(job);
  await assert.rejects(f.executor.pollOnce(), CoordinatorUnavailable);
  await f.executor.waitForIdle();
  assert.equal(readFileSync(effect, "utf8"), "finished-offline");
  assert.equal(f.journal.get(job.jobId)!.completion?.status, "succeeded");
  assert.equal(f.journal.pendingCompletions().length, 1);
});

test("CLI SIGTERM stops active work and leaves a durable cancellation rather than restart uncertainty", async t => {
  let job: MacJobAssignment;
  const origin = await coordinator(t, (request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(request.url === "/api/executor/poll" ? JSON.stringify({ job, cancelJobIds: [] }) : "{}");
  });
  const f = fixture(t, origin);
  f.journal.close();
  const configPath = join(f.root, "config.json");
  writeFileSync(configPath, JSON.stringify(f.config), { mode: 0o600 });
  const ready = join(f.workspace, "signal-ready");
  job = assignment(f.workspace, nodeCommand(`require('node:fs').writeFileSync(${JSON.stringify(ready)}, 'ready'); setInterval(() => {}, 1000)`), "signal-job", 30_000);
  const daemon = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("../src/mac/cli.ts", import.meta.url)), "run", "--config", configPath, "--state-dir", f.state], {
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    stdio: "ignore",
  });
  try {
    await waitForFile(ready);
    const exited = once(daemon, "exit", { signal: AbortSignal.timeout(6000) });
    daemon.kill("SIGTERM");
    const [code, signal] = await exited;
    assert.equal(code, 0);
    assert.equal(signal, null);
    const reopened = new ExecutionJournal(f.state, f.config);
    try {
      assert.equal(reopened.get(job.jobId)?.completion?.status, "cancelled");
      assert.equal(reopened.recoveryPaused, false);
    } finally { reopened.close(); }
  } finally {
    if (daemon.exitCode === null && daemon.signalCode === null) {
      const exited = once(daemon, "exit");
      daemon.kill("SIGKILL");
      await exited;
    }
    const abandoned = new ExecutionJournal(f.state, f.config);
    try {
      const entry = abandoned.get(job.jobId);
      if (entry?.completion?.status === "uncertain" && entry.pid !== null) {
        try { process.kill(-entry.pid, "SIGKILL"); } catch { /* Already exited. */ }
      }
    } finally { abandoned.close(); }
  }
});
