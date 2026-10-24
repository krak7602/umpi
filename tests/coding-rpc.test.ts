import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as nextTurn, setTimeout as delay } from "node:timers/promises";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { getOrThrow, type ExecutionEnv, type WatchChange } from "@earendil-works/pi-durable/env";
import { createBashTool, createEditTool, createReadTool, createWriteTool, type EditToolDetails, type ReadToolDetails } from "@earendil-works/pi-durable/tools";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import { CodingNodeSession, readCodingNodeStates } from "../src/coding/rpc.ts";
import { codingCommandEnvironment } from "../src/coding/shell.ts";
import { captureCodingSnapshot, restoreCodingSnapshot } from "../src/coding/workspace.ts";
import { createCodingEnvironment } from "../src/worker/coding-env.ts";
import { codingOperationPrefix, decodeCodingValue, encodeCodingValue, parseCodingRpcRequest, parseCodingRpcState, type CodingRpcRequest, type CodingRpcState } from "../src/shared/coding-rpc.ts";
import type { CodingAssignment, CodingArtifacts } from "../src/shared/coding.ts";

function workspace(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "umpi-coding-rpc-")));
  const cwd = join(root, "workspace");
  mkdirSync(cwd, { mode: 0o700 });
  execFileSync("git", ["init", "--quiet", cwd], { stdio: "ignore" });
  writeFileSync(join(cwd, "input.txt"), "alpha\nbeta\n");
  const disposals: (() => Promise<void>)[] = [];
  t.after(async () => {
    try { for (const dispose of disposals.reverse()) await dispose(); }
    finally { rmSync(root, { recursive: true, force: true }); }
  });
  const assignment: CodingAssignment = { taskId: "task-rpc", runId: "run-rpc", cwd, deadlineAt: new Date(Date.now() + 60_000).toISOString() };
  return { root, cwd, assignment, stateDirectory: join(root, "state"), disposals };
}

async function fixture(t: TestContext) {
  const files = workspace(t);
  const session = await CodingNodeSession.open(files);
  files.disposals.push(() => session.close());
  let invocation = 0;
  const environment = (): ExecutionEnv => createCodingEnvironment({
    assignment: files.assignment, namespaceId: "test-native-files", invocationId: `invocation-${++invocation}`,
    invoke: async request => { await session.submit(request); return session.state(request.operationId)!; },
    inspect: async operationId => session.state(operationId)!,
    cancel: operationId => session.cancel(operationId),
  }, BACKGROUND_CONTEXT);
  return { ...files, session, environment };
}

async function settled(session: CodingNodeSession, operationId: string): Promise<CodingRpcState> {
  const deadline = performance.now() + 10_000;
  while (true) {
    const state = session.state(operationId);
    assert(state);
    if (state.status !== "running") return state;
    if (performance.now() >= deadline) throw new Error("Coding operation did not settle");
    await nextTurn();
  }
}

async function fileAppears(path: string): Promise<void> {
  const deadline = performance.now() + 10_000;
  while (!existsSync(path)) {
    if (performance.now() >= deadline) throw new Error("Command did not reach its observable effect");
    await nextTurn();
  }
}

function request(sequence: string, method: CodingRpcRequest["method"], args: unknown[]): CodingRpcRequest {
  return { operationId: `${codingOperationPrefix("task-rpc", "run-rpc")}${sequence}`, method, args: args.map(encodeCodingValue) };
}

test("the actual first-party write, read, edit and bash tools operate through the remote environment", async t => {
  const f = await fixture(t);
  const env = f.environment();
  const output: string[] = [];
  const diagnostics: unknown[] = [];
  const api = {
    env, output: (chunk: string | Uint8Array) => output.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk)),
    outputWindow: { maxBytes: 50_000, maxLines: 2000, minIntervalMs: 0, bytesPerSecond: 1_000_000 },
    diagnostic: (value: unknown) => diagnostics.push(value),
  } as unknown as ToolExecutionApi;
  await createWriteTool().execute({ path: "nested/tool.txt", content: "first\nsecond\n" }, api, BACKGROUND_CONTEXT);
  const read = await createReadTool().execute({ path: "nested/tool.txt" }, api as unknown as ToolExecutionApi<ReadToolDetails>, BACKGROUND_CONTEXT);
  assert.match(JSON.stringify(read), /first/);
  await createEditTool().execute({ path: "nested/tool.txt", edits: [{ oldText: "second", newText: "changed" }] }, api as unknown as ToolExecutionApi<EditToolDetails>, BACKGROUND_CONTEXT);
  assert.equal(readFileSync(join(f.cwd, "nested/tool.txt"), "utf8"), "first\nchanged\n");
  await createBashTool().execute({ command: "printf 'shell-evidence'" }, api, BACKGROUND_CONTEXT);
  assert.equal(output.join(""), "shell-evidence");
  assert.equal(diagnostics.length, 0);
  await env.cleanup(BACKGROUND_CONTEXT);
});

test("opened binary and text readers retain file identity across rename, preserve EOF, and directory cursors advance", async t => {
  const f = await fixture(t);
  const env = f.environment();
  const binary = getOrThrow(await env.openBinaryReader("input.txt", undefined, BACKGROUND_CONTEXT));
  const text = getOrThrow(await env.openTextLineReader("input.txt", BACKGROUND_CONTEXT));
  getOrThrow(await env.renameFile("input.txt", "renamed.txt", BACKGROUND_CONTEXT));
  getOrThrow(await env.writeFile("input.txt", "replacement", BACKGROUND_CONTEXT));
  assert.equal(new TextDecoder().decode(getOrThrow(await binary.read(0, 11, BACKGROUND_CONTEXT))), "alpha\nbeta\n");
  assert.equal(getOrThrow(await binary.info(BACKGROUND_CONTEXT)).size, 11);
  assert.deepEqual(getOrThrow(await binary.scanLines({ startLine: 1, endLine: 2 }, BACKGROUND_CONTEXT)), { newlines: 2, start: 6, end: 10, firstLineEnd: 10, lastLineStart: 6, selectedBytes: 4, firstLineBytes: 4 });
  assert.deepEqual(getOrThrow(await text.readLine(BACKGROUND_CONTEXT)), { text: "alpha", terminated: true });
  assert.deepEqual(getOrThrow(await text.readLine(BACKGROUND_CONTEXT)), { text: "beta", terminated: true });
  assert.equal(getOrThrow(await text.readLine(BACKGROUND_CONTEXT)), undefined);
  await binary.close(BACKGROUND_CONTEXT);
  await binary.close(BACKGROUND_CONTEXT);
  const closed = await binary.read(0, 1, BACKGROUND_CONTEXT);
  assert.equal(closed.ok, false);
  if (!closed.ok) assert.equal(closed.error.code, "invalid");
  await text.close(BACKGROUND_CONTEXT);
  const directory = getOrThrow(await env.openDirReader(".", BACKGROUND_CONTEXT));
  const names: string[] = [];
  while (true) {
    const page = getOrThrow(await directory.next(1, BACKGROUND_CONTEXT));
    assert(page.entries.length <= 1);
    names.push(...page.entries.map(entry => entry.name));
    if (page.done) break;
  }
  assert.equal(new Set(names).size, names.length);
  assert(names.includes("input.txt") && names.includes("renamed.txt"));
  await directory.close(BACKGROUND_CONTEXT);
  await env.cleanup(BACKGROUND_CONTEXT);
});

test("an immutable operation receipt deduplicates real writes, survives reopen, and rejects cross-run access", async t => {
  const f = await fixture(t);
  const append = request("effect:1", "appendFile", ["count.txt", "once"]);
  await Promise.all([f.session.submit(append), f.session.submit(append)]);
  const receipt = await settled(f.session, append.operationId);
  assert.equal(receipt.result?.ok, true);
  await f.session.submit(append);
  assert.equal(readFileSync(join(f.cwd, "count.txt"), "utf8"), "once");
  await assert.rejects(f.session.submit({ ...append, args: ["count.txt", "twice"] }), /identity/);
  await assert.rejects(f.session.submit({ ...append, operationId: "task-other:run-rpc:effect:1" }), /task\/run/);
  assert.throws(() => f.session.state("task-rpc:run-other:effect:1"), /task\/run/);
  await f.session.close();
  assert.deepEqual(readCodingNodeStates(f.stateDirectory), [receipt]);
  const reopened = await CodingNodeSession.open(f);
  try {
    await reopened.submit(append);
    assert.deepEqual(reopened.state(append.operationId), receipt);
    assert.equal(readFileSync(join(f.cwd, "count.txt"), "utf8"), "once");
    await assert.rejects(reopened.submit(request("effect:2", "appendFile", ["count.txt", "again"])), /stopped/);
  } finally { await reopened.close(); }
  await assert.rejects(CodingNodeSession.open({ ...f, assignment: { ...f.assignment, runId: "run-other" } }), /another immutable assignment/);
});

test("successful shell receipts cannot rerun command effects", async t => {
  const f = await fixture(t);
  const operation = request("command:1", "exec", [[process.execPath, "-e", "require('node:fs').appendFileSync('command-effects', 'once')"]]);
  await Promise.all([f.session.submit(operation), f.session.submit(operation)]);
  const receipt = await settled(f.session, operation.operationId);
  assert(receipt.result?.ok);
  await f.session.submit(operation);
  assert.deepEqual(f.session.state(operation.operationId), receipt);
  assert.equal(readFileSync(join(f.cwd, "command-effects"), "utf8"), "once");
});

test("a 100000-line result fails its full receipt bound without poisoning immutable journal reads or reopen", async t => {
  const f = await fixture(t);
  writeFileSync(join(f.cwd, "many-lines"), "\n".repeat(100_000));
  const operation = request("receipt-bound:1", "readTextLines", ["many-lines", { maxLines: 100_000 }]);
  await f.session.submit(operation);
  const receipt = await settled(f.session, operation.operationId);
  assert.equal(receipt.status, "done");
  assert.equal(receipt.result?.ok, false);
  assert.deepEqual(parseCodingRpcState(JSON.parse(JSON.stringify(receipt))), receipt);
  assert.deepEqual(f.session.states(), [receipt]);
  writeFileSync(join(f.cwd, "many-lines"), "changed\n");
  await f.session.submit(operation);
  assert.deepEqual(f.session.state(operation.operationId), receipt);
  await f.session.close();
  assert.deepEqual(readCodingNodeStates(f.stateDirectory), [receipt]);
  const reopened = await CodingNodeSession.open(f);
  try {
    await reopened.submit(operation);
    assert.deepEqual(reopened.state(operation.operationId), receipt);
    assert.deepEqual(reopened.states(), [receipt]);
  } finally { await reopened.close(); }
});

test("nine long operations durably refuse only the ninth and leave the first eight usable", async t => {
  const f = await fixture(t);
  const operations = Array.from({ length: 8 }, (_, index) => request(`capacity:${index}`, "exec", [[process.execPath, "-e", `require('node:fs').writeFileSync('active-${index}', 'ready'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)`]]));
  for (const operation of operations) await f.session.submit(operation);
  const ninth = request("capacity:9", "exec", [[process.execPath, "-e", "require('node:fs').writeFileSync('refused-effect', 'bad')"]]);
  await f.session.submit(ninth);
  const refusal = await settled(f.session, ninth.operationId);
  assert.equal(refusal.status, "done");
  assert.equal(refusal.result?.ok, false);
  assert.equal(existsSync(join(f.cwd, "refused-effect")), false);
  await Promise.all(operations.map((_operation, index) => fileAppears(join(f.cwd, `active-${index}`))));
  assert(operations.every(operation => f.session.state(operation.operationId)?.status === "running"));
  await f.session.cancelRequest(operations[0]!);
  assert.equal((await settled(f.session, operations[0]!.operationId)).result?.ok, false);
  assert(operations.slice(1).every(operation => f.session.state(operation.operationId)?.status === "running"));
  await Promise.all(operations.slice(1).map(operation => f.session.cancel(operation.operationId)));
  assert.equal(f.session.uncertain, false);
  const next = request("capacity:10", "writeFile", ["still-usable", "yes"]);
  await f.session.submit(next);
  assert.equal((await settled(f.session, next.operationId)).result?.ok, true);
  await f.session.submit(ninth);
  assert.deepEqual(f.session.state(ninth.operationId), refusal);
});

test("exact cancelled-before-admission requests persist cancellation and cannot mutate on late delivery", async t => {
  const f = await fixture(t);
  const operation = request("cancel-before:1", "appendFile", ["never-admitted", "bad"]);
  await f.session.cancel(operation.operationId);
  assert.equal(f.session.state(operation.operationId), undefined);
  await f.session.cancelRequest(operation);
  const receipt = f.session.state(operation.operationId)!;
  assert.equal(receipt.status, "done");
  assert.equal(receipt.result?.ok, false);
  if (receipt.result && !receipt.result.ok) assert.equal(receipt.result.error.code, "aborted");
  f.session.assertRequest(operation);
  await f.session.submit(operation);
  await f.session.cancelRequest(operation);
  assert.deepEqual(f.session.state(operation.operationId), receipt);
  assert.equal(existsSync(join(f.cwd, "never-admitted")), false);
  assert.throws(() => f.session.assertRequest({ ...operation, args: ["never-admitted", "different"] }), /identity/);
  await assert.rejects(f.session.cancelRequest({ ...operation, args: ["never-admitted", "different"] }), /identity/);
  await f.session.close();
  const reopened = await CodingNodeSession.open(f);
  try {
    await reopened.submit(operation);
    await reopened.cancelRequest(operation);
    assert.deepEqual(reopened.state(operation.operationId), receipt);
    assert.equal(existsSync(join(f.cwd, "never-admitted")), false);
  } finally { await reopened.close(); }
});

// Real process integration: fake timers cannot advance independently spawned
// Node children or the kernel supervisor's deadline. The waits cover an actual
// delayed mutation, not an implementation debounce or scheduling guess.
test("foreground-group cleanup preserves actual main exit and both output streams", async t => {
  const f = await fixture(t);
  const child = "setTimeout(() => require('node:fs').writeFileSync('late-foreground', 'bad'), 700)";
  const main = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(child)}], {stdio:'ignore'}).unref(); process.stdout.write('out'); process.stderr.write('err'); process.exitCode=7`;
  const operation = request("group:1", "exec", [[process.execPath, "-e", main]]);
  await f.session.submit(operation);
  const receipt = await settled(f.session, operation.operationId);
  assert(receipt.result?.ok);
  const result = decodeCodingValue(receipt.result.value);
  assert(result && typeof result === "object" && "exitCode" in result);
  assert.equal(result.exitCode, 7);
  assert.equal(receipt.progress.output.filter(chunk => chunk.stream === "stdout").map(chunk => chunk.text).join(""), "out");
  assert.equal(receipt.progress.output.filter(chunk => chunk.stream === "stderr").map(chunk => chunk.text).join(""), "err");
  await f.session.close();
  await delay(900);
  assert.equal(existsSync(join(f.cwd, "late-foreground")), false);
  assert.equal(f.session.uncertain, false);
});

test("Linux subreaper stops a detached new-group descendant while leaving an unrelated process alive", { skip: process.platform !== "linux" }, async t => {
  const f = await fixture(t);
  const unrelated = spawn(process.execPath, ["-e", "process.stdin.on('data', () => process.stdout.write('alive')); process.stdout.write('ready')"], { stdio: ["pipe", "pipe", "ignore"] });
  t.after(async () => {
    const exited = once(unrelated, "exit");
    unrelated.kill("SIGTERM");
    await exited;
  });
  await once(unrelated.stdout, "data");
  const child = "setTimeout(() => require('node:fs').writeFileSync('late-detached', 'bad'), 700)";
  const main = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(child)}], {detached:true,stdio:'ignore'}).unref(); process.stdout.write('owned'); process.exitCode=9`;
  const operation = request("detached:1", "exec", [[process.execPath, "-e", main]]);
  await f.session.submit(operation);
  const receipt = await settled(f.session, operation.operationId);
  assert(receipt.result?.ok);
  const result = decodeCodingValue(receipt.result.value);
  assert(result && typeof result === "object" && "exitCode" in result);
  assert.equal(result.exitCode, 9);
  assert.equal(receipt.progress.output.map(chunk => chunk.text).join(""), "owned");
  await f.session.close();
  await delay(900);
  assert.equal(existsSync(join(f.cwd, "late-detached")), false);
  const alive = once(unrelated.stdout, "data");
  unrelated.stdin.write("probe");
  assert.equal((await alive)[0].toString(), "alive");
  assert.equal(unrelated.exitCode, null);
  assert.equal(f.session.uncertain, false);
});

test("Linux deadline cleanup reaches a detached descendant without coordinator contact", { skip: process.platform !== "linux" }, async t => {
  const f = await fixture(t);
  const child = "require('node:fs').writeFileSync('detached-ready', 'yes'); setTimeout(() => require('node:fs').writeFileSync('late-deadline-detached', 'bad'), 900)";
  const main = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(child)}], {detached:true,stdio:'ignore'}).unref(); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)`;
  const operation = request("detached-deadline:1", "exec", [[process.execPath, "-e", main], { timeout: 0.5 }]);
  await f.session.submit(operation);
  await fileAppears(join(f.cwd, "detached-ready"));
  const receipt = await settled(f.session, operation.operationId);
  assert.equal(receipt.result?.ok, false);
  if (receipt.result && !receipt.result.ok) assert.equal(receipt.result.error.code, "timeout");
  await f.session.close();
  await delay(1000);
  assert.equal(existsSync(join(f.cwd, "late-deadline-detached")), false);
  assert.equal(f.session.uncertain, false);
});

test("handle capacity returns an actual error and closing a handle releases capacity", async t => {
  const f = await fixture(t);
  let first: unknown;
  for (let index = 0; index < 64; index++) {
    const operation = request(`handles:${index}`, "openBinaryReader", ["input.txt"]);
    await f.session.submit(operation);
    const receipt = await settled(f.session, operation.operationId);
    assert(receipt.result?.ok);
    first ??= decodeCodingValue(receipt.result.value);
  }
  const excess = request("handles:64", "openBinaryReader", ["input.txt"]);
  await f.session.submit(excess);
  const refused = await settled(f.session, excess.operationId);
  assert.equal(refused.result?.ok, false);
  assert(first && typeof first === "object" && "handleId" in first && typeof first.handleId === "string");
  const close = request("handles:65", "handle.close", [first.handleId]);
  await f.session.submit(close);
  assert.equal((await settled(f.session, close.operationId)).result?.ok, true);
  const replacement = request("handles:66", "openBinaryReader", ["input.txt"]);
  await f.session.submit(replacement);
  assert.equal((await settled(f.session, replacement.operationId)).result?.ok, true);
});

test("cancellation is operation-scoped, streamed output precedes exit, and no interrupted command fabricates success", { timeout: 10_000 }, async t => {
  const f = await fixture(t);
  const cancelledEnv = f.environment();
  const otherEnv = f.environment();
  const controller = new AbortController();
  const { promise: observed, resolve: observe } = Promise.withResolvers<void>();
  const cancelled = cancelledEnv.exec([process.execPath, "-e", "process.stdout.write('ready'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)"], { onOutput: text => { if (text.includes("ready")) observe(); } }, withAbortSignal(controller.signal, BACKGROUND_CONTEXT));
  await observed;
  const survivor = otherEnv.exec([process.execPath, "-e", "require('node:fs').writeFileSync('survivor', 'done')"], undefined, BACKGROUND_CONTEXT);
  controller.abort();
  const stopped = await cancelled;
  assert.equal(stopped.ok, false);
  if (!stopped.ok) assert.equal(stopped.error.code, "aborted");
  assert.equal(getOrThrow(await survivor).exitCode, 0);
  assert.equal(readFileSync(join(f.cwd, "survivor"), "utf8"), "done");
  await cancelledEnv.cleanup(BACKGROUND_CONTEXT);
  await otherEnv.cleanup(BACKGROUND_CONTEXT);
});

test("windowed output accounts exactly for omitted UTF-8 bytes and newlines; lossless overflow fails truthfully", async t => {
  const f = await fixture(t);
  const command = [process.execPath, "-e", "process.stdout.write('😀\\n'.repeat(60000))"];
  const operation = request("window:1", "exec", [command, { window: { maxBytes: 1024, maxLines: 50, minIntervalMs: 0, bytesPerSecond: 1_000_000 } }]);
  await f.session.submit(operation);
  const receipt = await settled(f.session, operation.operationId);
  assert.equal(receipt.result?.ok, true);
  assert(receipt.progress.omitted.bytes > 0);
  const tail = receipt.progress.output.map(chunk => chunk.text).join("");
  assert.equal(Buffer.byteLength(tail) + receipt.progress.omitted.bytes, 300_000);
  assert.equal(tail.split("\n").length - 1 + receipt.progress.omitted.newlines, 60_000);
  assert(!tail.includes("�"));
  const overflow = request("window:2", "exec", [command]);
  await f.session.submit(overflow);
  const failed = await settled(f.session, overflow.operationId);
  assert.equal(failed.result?.ok, false);
  if (failed.result && !failed.result.ok) assert.equal(failed.result.error.code, "callback_error");
  // Delay the real invocation response until completion, exercising an actual dropped transport prefix.
  const env = createCodingEnvironment({
    assignment: f.assignment, namespaceId: "test-native-files", invocationId: "window-consumer",
    invoke: async request => { await f.session.submit(request); return settled(f.session, request.operationId); },
    inspect: async operationId => f.session.state(operationId)!,
    cancel: operationId => f.session.cancel(operationId),
  }, BACKGROUND_CONTEXT);
  let bytes = 0, newlines = 0, omitted = 0;
  const executed = await env.exec(command, {
    window: { maxBytes: 1024, maxLines: 50, minIntervalMs: 0, bytesPerSecond: 1_000_000 },
    onOutput: (text, _context, info) => {
      bytes += Buffer.byteLength(text) + (info.skipped?.bytes ?? 0);
      newlines += text.split("\n").length - 1 + (info.skipped?.newlines ?? 0);
      omitted += info.skipped?.bytes ?? 0;
    },
  }, BACKGROUND_CONTEXT);
  assert.equal(getOrThrow(executed).exitCode, 0);
  assert.equal(bytes, 300_000);
  assert.equal(newlines, 60_000);
  assert(omitted > 0);
  await env.cleanup(BACKGROUND_CONTEXT);
});

test("real watcher coverage reports a change and close prevents later callbacks", { timeout: 10_000 }, async t => {
  const f = await fixture(t);
  const env = f.environment();
  const changes: WatchChange[] = [];
  const { promise: changed, resolve: resolveChange } = Promise.withResolvers<void>();
  const watched = getOrThrow(await env.watch([{ path: "input.txt" }], change => { changes.push(change); resolveChange(); }, BACKGROUND_CONTEXT));
  writeFileSync(join(f.cwd, "input.txt"), "changed");
  await changed;
  assert(changes.some(change => "paths" in change || "overflow" in change));
  assert(!changes.some(change => "error" in change));
  await watched.close(BACKGROUND_CONTEXT);
  const count = changes.length;
  getOrThrow(await env.writeFile("input.txt", "changed again", BACKGROUND_CONTEXT));
  assert.equal(getOrThrow(await env.readTextFile("input.txt", BACKGROUND_CONTEXT)), "changed again");
  assert.equal(changes.length, count);
  await env.cleanup(BACKGROUND_CONTEXT);
});

/** A simulated crash leaves its command running, as a real one would; stop its whole group afterwards. */
function killOrphanedGroup(pid: number): void {
  const group = (target: number) => Number(execFileSync("ps", ["-o", "pgid=", "-p", String(target)], { encoding: "utf8" }).trim());
  try {
    const orphan = group(pid);
    if (orphan > 1 && orphan !== group(process.pid)) process.kill(-orphan, "SIGKILL");
  } catch { /* Already gone. */ }
}

test("SIGKILL after command admission recovers uncertainty without replaying an external effect", async t => {
  const f = workspace(t);
  const marker = join(f.cwd, "started.json");
  const operation = request("crash:1", "exec", [[process.execPath, "-e", `require('node:fs').appendFileSync('effect', 'once'); require('node:fs').writeFileSync(${JSON.stringify(marker)}, JSON.stringify({pid:process.pid})); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)`]]);
  const source = `import { CodingNodeSession } from ${JSON.stringify(new URL("../src/coding/rpc.ts", import.meta.url).href)}; const session = await CodingNodeSession.open(${JSON.stringify(f)}); await session.submit(${JSON.stringify(operation)});`;
  const runner = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source], { stdio: "ignore" });
  try {
    await fileAppears(marker);
    const { pid } = JSON.parse(readFileSync(marker, "utf8")) as { pid: number };
    t.after(() => killOrphanedGroup(pid));
    const exited = once(runner, "exit");
    runner.kill("SIGKILL");
    await exited;
    const receipt = readCodingNodeStates(f.stateDirectory)[0]!;
    assert.equal(receipt.status, "uncertain");
    const recovered = await CodingNodeSession.open(f);
    try {
      assert.equal(recovered.uncertain, true);
      await recovered.submit(operation);
      assert.equal(recovered.state(operation.operationId)?.status, "uncertain");
      assert.equal(readFileSync(join(f.cwd, "effect"), "utf8"), "once");
      await assert.rejects(recovered.submit(request("crash:2", "writeFile", ["no-replay", "bad"])), /uncertain/);
    } finally { await recovered.close(); }
  } finally {
    runner.kill("SIGKILL");
  }
});

test("local deadline stops a real process without coordinator contact and releases temporary output", async t => {
  const f = workspace(t);
  const start = Date.now();
  f.assignment.deadlineAt = new Date(start + 1500).toISOString();
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: start });
  const session = await CodingNodeSession.open(f);
  f.disposals.push(() => session.close());
  const operation = request("deadline:1", "exec", [[process.execPath, "-e", "process.stdout.write('started'); require('node:fs').writeFileSync('deadline-started', 'yes'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)"], { spill: { afterBytes: 1, afterLines: 1 } }]);
  await session.submit(operation);
  await fileAppears(join(f.cwd, "deadline-started"));
  t.mock.timers.tick(1501);
  const receipt = await settled(session, operation.operationId);
  assert.equal(receipt.result?.ok, false);
  if (receipt.result && !receipt.result.ok) assert.equal(receipt.result.error.code, "aborted");
  await session.close();
  await assert.rejects(session.submit(request("deadline:2", "writeFile", ["too-late", "bad"])), /closed/);
  assert.equal(existsSync(join(f.cwd, "too-late")), false);
  if (receipt.result && !receipt.result.ok && receipt.result.error.spillPath) assert.equal(existsSync(receipt.result.error.spillPath), false);
});

test("cloud baseline retains the exact approved digest and rejects a different actual workspace", async t => {
  const f = workspace(t);
  const approved = await captureCodingSnapshot(f.cwd);
  const cloudCwd = join(f.root, "cloud");
  await restoreCodingSnapshot(approved.bytes, cloudCwd);
  const assignment = { ...f.assignment, cwd: cloudCwd };
  const session = await CodingNodeSession.open({ assignment, stateDirectory: f.stateDirectory, baselineArchive: approved.bytes });
  try {
    const operation = request("artifacts:1", "artifacts", []);
    await session.submit(operation);
    const receipt = await settled(session, operation.operationId);
    assert(receipt.result?.ok);
    const artifacts = decodeCodingValue(receipt.result.value) as CodingArtifacts;
    assert.equal(artifacts.baseDigest, approved.manifest.digest);
    assert.equal(artifacts.patch, "");
  } finally { await session.close(); }
  writeFileSync(join(cloudCwd, "input.txt"), "not approved");
  await assert.rejects(CodingNodeSession.open({ assignment, stateDirectory: join(f.root, "different-state"), baselineArchive: approved.bytes }), /does not match/);
});

test("wire parser refuses unknown methods, invalid arity and binary tags; command environment drops secrets without mutation", () => {
  assert.notEqual(codingOperationPrefix("a:b", "c"), codingOperationPrefix("a", "b:c"));
  assert.throws(() => parseCodingRpcRequest({ operationId: "task:run:i:1", method: "constructor", args: [] }));
  assert.throws(() => parseCodingRpcRequest({ operationId: "task:run:i:1", method: "writeFile", args: ["path"] }));
  assert.throws(() => parseCodingRpcRequest({ operationId: "task:run:i:1", method: "writeFile", args: ["path", { $coding: "bytes", base64: "!" }] }));
  const bytes = new Uint8Array([0, 128, 255]);
  assert.deepEqual(decodeCodingValue(encodeCodingValue(bytes)), bytes);
  const ambient = { PATH: "/usr/bin", HOME: "/home/test", UMPI_CONTROL_TOKEN: "private", OPENAI_API_KEY: "private", TELEGRAM_BOT_TOKEN: "private", NODE_OPTIONS: "--require private", DYLD_INSERT_LIBRARIES: "private", CUSTOM_VALUE: "kept" };
  assert.deepEqual(codingCommandEnvironment(ambient), { PATH: "/usr/bin", HOME: "/home/test", CUSTOM_VALUE: "kept" });
  assert.equal(ambient.NODE_OPTIONS, "--require private");
});
