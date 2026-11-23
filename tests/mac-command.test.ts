import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { JobCompletion } from "../src/shared/protocol.js";
import { startCommand, type RunningCommand } from "../src/mac/command.js";

// Real short shell commands. The stop logic reads macOS `ps` and `lsof`, and the children are Perl one-liners.
const skip = process.platform !== "darwin" ? "needs macOS ps and lsof"
  : ["/bin/ps", "/usr/sbin/lsof", "/usr/bin/perl"].every(path => existsSync(path)) ? false : "ps, lsof, or perl is missing";
/** Every command must be reported this soon after its stop, or after its shell's exit. */
const SOON_MS = 4_000;

function fixture(t: TestContext) {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "umpi-mac-command-")));
  // Each child carries this word as an argument, so the process table shows what a test left behind.
  const token = `umpi-stop-${randomUUID()}`;
  const left = () => execFileSync("/bin/ps", ["-axo", "pid=,command="], { encoding: "utf8" }).split("\n").filter(line => line.includes(token)).map(line => Number(line.trim().split(/\s+/)[0]));
  t.after(() => {
    for (const pid of left()) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
    rmSync(cwd, { recursive: true, force: true });
  });
  /** A Perl child that writes the file `ready` when it is set up, then sleeps for a minute. */
  const child = (setup: string, modules = "") => `/usr/bin/perl ${modules} -e '${setup} open(F, q(>ready)); close(F); sleep 60' ${token}`;
  const start = (command: string, timeoutMs = 30_000) => startCommand("test-executor", { jobId: randomUUID(), command, cwd, timeoutMs, createdAt: new Date().toISOString() }, [cwd]);
  async function ready(): Promise<void> {
    for (let waited = 0; !existsSync(join(cwd, "ready")); waited += 10) { assert.ok(waited < 5_000, "the child did not start"); await delay(10); }
  }
  /** The completion and how long it took from now. Fails when the command is not reported soon. */
  async function reported(command: RunningCommand): Promise<JobCompletion & { ms: number }> {
    const from = performance.now(), late = AbortSignal.timeout(SOON_MS);
    const completion = await Promise.race([command.completion, new Promise<never>((_, reject) => late.addEventListener("abort", () => reject(new Error(`not reported within ${SOON_MS} ms`))))]);
    const ms = Math.round(performance.now() - from);
    t.diagnostic(`${t.name}: ${completion.status} after ${ms} ms`);
    return { ...completion, ms };
  }
  async function shellGone(command: RunningCommand): Promise<void> {
    for (let waited = 0; ; waited += 5) {
      try { process.kill(command.pid!, 0); } catch { return; }
      assert.ok(waited < 5_000, "the shell did not exit");
      await delay(5);
    }
  }
  return { cwd, child, start, ready, reported, shellGone, left };
}

test("a command that ends by itself reports its output and exit code at once", { skip }, async t => {
  const f = fixture(t);
  const failed = await f.reported(f.start("echo to-stdout; echo to-stderr >&2; exit 3"));
  assert.equal(failed.status, "failed"); assert.equal(failed.exitCode, 3);
  assert.match(failed.output, /to-stdout/); assert.match(failed.output, /to-stderr/);
  assert.ok(failed.ms < 1_000);
  const ok = await f.reported(f.start("true"));
  assert.deepEqual([ok.status, ok.exitCode, ok.output, ok.truncated], ["succeeded", 0, "", false]);
});

test("cancel stops a child that ignores SIGTERM", { skip }, async t => {
  const f = fixture(t);
  const command = f.start(`${f.child("$SIG{TERM} = q(IGNORE);")}; echo not-reached`);
  await f.ready();
  assert.equal(f.left().length, 2);
  command.cancel();
  const done = await f.reported(command);
  assert.equal(done.status, "cancelled");
  assert.match(done.output, /Command cancelled; external effects before cancellation are not undone\.$/);
  assert.doesNotMatch(done.output, /not-reached/);
  assert.deepEqual(f.left(), []);
});

test("a timeout stops a child that ignores SIGTERM", { skip }, async t => {
  const f = fixture(t);
  const command = f.start(`${f.child("$SIG{TERM} = q(IGNORE);")}; echo not-reached`, 400);
  const done = await f.reported(command);
  assert.equal(done.status, "failed");
  assert.match(done.output, /Command exceeded its timeout and its process group was stopped\.$/);
  assert.deepEqual(f.left(), []);
});

test("cancel stops a descendant that left the process group and closed its output", { skip }, async t => {
  const f = fixture(t);
  // Nothing but the parent chain leads to this child while the shell waits for it.
  const command = f.start(`${f.child("setpgrp(0, 0); close(STDOUT); close(STDERR);")} & wait`);
  await f.ready();
  command.cancel();
  const done = await f.reported(command);
  assert.equal(done.status, "cancelled");
  assert.deepEqual(f.left(), []);
});

test("the shell exits while a child in its own session keeps the output open", { skip }, async t => {
  const f = fixture(t);
  const command = f.start(`${f.child("POSIX::setsid();", "-MPOSIX")} & while [ ! -f ready ]; do sleep 0.05; done; echo shell-done`);
  const done = await f.reported(command);
  assert.deepEqual([done.status, done.exitCode, done.output], ["succeeded", 0, "shell-done\n"]);
  assert.deepEqual(f.left(), []);
});

test("the shell exits while a child in its own group ignores SIGTERM and keeps the output open", { skip }, async t => {
  const f = fixture(t);
  const command = f.start(`${f.child("$SIG{TERM} = q(IGNORE); setpgrp(0, 0);")} & while [ ! -f ready ]; do sleep 0.05; done; exit 7`);
  const done = await f.reported(command);
  assert.deepEqual([done.status, done.exitCode], ["failed", 7]);
  assert.deepEqual(f.left(), []);
});

test("cancel and timeout still act after the shell exited", { skip }, async t => {
  const f = fixture(t);
  const holder = `${f.child("$SIG{TERM} = q(IGNORE); POSIX::setsid();", "-MPOSIX")} & while [ ! -f ready ]; do sleep 0.05; done; echo shell-done`;
  const cancelled = f.start(holder);
  await f.shellGone(cancelled);
  assert.equal(f.left().length, 1);
  cancelled.cancel();
  const first = await f.reported(cancelled);
  assert.equal(first.status, "cancelled");
  assert.match(first.output, /^shell-done\n/);
  assert.deepEqual(f.left(), []);

  rmSync(join(f.cwd, "ready"));
  const started = performance.now(), timed = f.start(holder, 450);
  await f.shellGone(timed);
  // The shell is gone before the limit; the holder is still there when the limit passes.
  assert.ok(performance.now() - started < 450);
  const second = await f.reported(timed);
  assert.equal(second.status, "failed");
  assert.match(second.output, /Command exceeded its timeout/);
  assert.deepEqual(f.left(), []);
});
