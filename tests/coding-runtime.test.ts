import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { gzipSync } from "node:zlib";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { R2Bucket } from "@cloudflare/workers-types";
import { createCodingService } from "../src/coding/server.js";
import type { CodingAssignment } from "../src/shared/coding.js";
import { codingOperationPrefix, type CodingRpcRequest, type CodingRpcState } from "../src/shared/coding-rpc.js";
import { codingSourceDigest, inspectCodingSnapshot } from "../src/shared/coding-source.js";
import { CodingCloudRun, type CodingCloudStorage } from "../src/worker/coding-cloud.js";
import { CodingRuntime } from "../src/worker/coding-runtime.js";
import { CodingStore } from "../src/worker/coding-store.js";
import { Store, type Database } from "../src/worker/store.js";

interface Barrier { entered: Promise<void>; enter(): void; release(): void; wait: Promise<void> }
interface VerifiedFinishFixture {
  store: CodingStore;
  assignment: CodingAssignment;
  operation(sequence: number, method: CodingRpcRequest["method"], args: CodingRpcRequest["args"]): CodingRpcRequest;
  recordEffect(request: CodingRpcRequest): Promise<CodingRpcState>;
}

function barrier() {
  const entered = Promise.withResolvers<void>(), released = Promise.withResolvers<void>();
  return { entered: entered.promise, enter: entered.resolve, release: released.resolve, wait: released.promise };
}
interface StoredObject { bytes: Uint8Array<ArrayBuffer>; metadata: Record<string, string>; contentType: string }

function openStore(path: string) {
  const sqlite = new DatabaseSync(path);
  let depth = 0;
  const db: Database = {
    all: <T extends object>(sql: string, ...bindings: (string | number | null)[]) => sqlite.prepare(sql).all(...bindings) as T[],
    transaction: <T>(run: () => T): T => {
      const savepoint = `coding_runtime_${depth++}`;
      sqlite.exec(`SAVEPOINT ${savepoint}`);
      try { const result = run(); assert.equal(result instanceof Promise, false); sqlite.exec(`RELEASE ${savepoint}`); return result; }
      catch (error) { sqlite.exec(`ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`); throw error; }
      finally { depth--; }
    },
  };
  const owner = new Store(db);
  return { owner, store: new CodingStore(owner), close: () => sqlite.close() };
}

class SqliteCloudStorage implements CodingCloudStorage {
  constructor(private readonly sqlite: DatabaseSync) {
    sqlite.exec("CREATE TABLE cloud_values (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  }
  async get<T>(key: string): Promise<T | undefined> {
    const row = this.sqlite.prepare("SELECT value FROM cloud_values WHERE key=?").get(key) as { value: string } | undefined;
    return row ? JSON.parse(row.value) as T : undefined;
  }
  async put<T>(key: string, value: T): Promise<void> {
    this.sqlite.prepare("INSERT INTO cloud_values VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, JSON.stringify(value));
  }
  async list<T>(prefix: string): Promise<Map<string, T>> {
    const rows = this.sqlite.prepare("SELECT key,value FROM cloud_values WHERE substr(key,1,?)=?").all(prefix.length, prefix) as { key: string; value: string }[];
    return new Map(rows.map(row => [row.key, JSON.parse(row.value) as T]));
  }
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  server.closeAllConnections();
  const closed = once(server, "close");
  server.close(); await closed;
}

async function sourceArchive(capturedAt: string): Promise<Uint8Array<ArrayBuffer>> {
  const content = "approved\n", bytes = new TextEncoder().encode(content);
  return new Uint8Array(gzipSync(JSON.stringify({ version: 1, capturedAt, baseRevision: null,
    files: [{ path: "value.txt", mode: 0o100644, bytes: bytes.length, digest: await codingSourceDigest(bytes), content: Buffer.from(bytes).toString("base64") }], exclusions: [] })));
}

async function fixture(t: TestContext, differentRunnerArchive = false) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "umpi-runtime-test-")));
  const original = join(root, "original"), workspace = join(root, "workspace");
  await mkdir(original); await writeFile(join(original, "value.txt"), "approved\n");
  const storePath = join(root, "owner.sqlite"), cloudSqlite = new DatabaseSync(join(root, "cloud.sqlite"));
  const cloudStorage = new SqliteCloudStorage(cloudSqlite);
  let opened = openStore(storePath), runtime!: CodingRuntime, origin = "";
  let responseBarrier: Barrier | undefined, patchBarrier: Barrier | undefined, destroyBarrier: Barrier | undefined;
  let patchReceipt: "matching" | "wrong-key" = "matching";
  const barriers: Barrier[] = [], tracked: Promise<void>[] = [], rpcRequests: string[] = [];
  let destroys = 0, harnessCalls = 0;
  const objects = new Map<string, StoredObject>();
  const bucket = {
    async get(key: string) {
      const object = objects.get(key);
      return object ? { key, size: object.bytes.length, customMetadata: { ...object.metadata }, body: new Blob([object.bytes]).stream() } : null;
    },
    async put(key: string, value: Uint8Array<ArrayBuffer>, options: { sha256: string; customMetadata: Record<string, string>; httpMetadata: { contentType: string } }) {
      const bytes = new Uint8Array(value);
      assert.equal(await codingSourceDigest(bytes), options.sha256);
      objects.set(key, { bytes, metadata: { ...options.customMetadata }, contentType: options.httpMetadata.contentType });
      if (key.includes("/patches/") && patchBarrier) {
        const pending = patchBarrier; patchBarrier = undefined;
        pending.enter(); await pending.wait;
      }
      return { key: key.includes("/patches/") && patchReceipt === "wrong-key" ? `${key}.other` : key, size: bytes.length };
    },
  } as unknown as R2Bucket;
  const server = createCodingService({ workspace, stateDirectory: join(root, "node"), terminate() { throw new Error("The test must not reach the service hard exit"); } });
  const cloud = new CodingCloudRun({
    storage: cloudStorage, bucket,
    async startContainer() {
      server.listen(0, "127.0.0.1"); await once(server, "listening");
      const address = server.address(); assert.ok(address && typeof address !== "string");
      origin = `http://127.0.0.1:${address.port}`;
    },
    async request(path, init) {
      if (!server.listening) throw new Error("The test container is stopped");
      if (path === "/rpc") rpcRequests.push((JSON.parse(new TextDecoder().decode(init?.body as Uint8Array)) as CodingRpcRequest).operationId);
      const response = await fetch(`${origin}${path}`, init);
      if (path === "/rpc" && responseBarrier) {
        const pending = responseBarrier; responseBarrier = undefined;
        pending.enter(); await pending.wait;
      }
      return response;
    },
    async destroyContainer() {
      if (destroyBarrier) {
        const pending = destroyBarrier; destroyBarrier = undefined;
        pending.enter(); await pending.wait;
      }
      await closeServer(server); destroys++;
    },
    async scheduleDeadline(deadline) { assert.equal(deadline.toISOString(), assignment.deadlineAt); },
  });
  function makeRuntime() {
    return new CodingRuntime(opened.store, {
      archive: () => bucket, cloud: () => cloud, cloudAvailable: () => true,
      async modelReady() { return false; },
      harness() { harnessCalls++; throw new Error("Runtime regressions must not invoke a coding model"); },
      extension() { throw new Error("Runtime regressions must not instantiate model tools"); },
      async wake() {},
      track(work) { tracked.push(work); },
    });
  }
  runtime = makeRuntime();
  opened.owner.setSession("control", "owner-control");
  opened.store.poll({ executorId: "mac", workspaces: [original], available: true, activeRunId: null });
  const approvedBytes = await sourceArchive("2026-01-01T00:00:00.000Z"), approved = (await inspectCodingSnapshot(approvedBytes)).manifest;
  const source = opened.store.saveSource({ sourceId: "source", cwd: original, capturedAt: approved.capturedAt, digest: approved.digest,
    bytes: approvedBytes.length, fileCount: approved.fileCount, baseRevision: approved.baseRevision });
  const created = opened.store.create({ taskId: "task", cwd: original, prompt: "Update value.txt and verify the result", timeoutMs: 60_000 }, "control", "owner-control");
  const offered = opened.store.requestCloud(created.taskId, created.version, source.sourceId);
  opened.store.approve(offered.taskId, offered.version);
  const claimed = opened.store.claimCloud(); assert.ok(claimed?.run);
  const assignment: CodingAssignment = claimed.run.assignment;
  const runnerBytes = differentRunnerArchive ? await sourceArchive("2026-01-02T00:00:00.000Z") : approvedBytes;
  const runnerDigest = await codingSourceDigest(runnerBytes), runnerSourceKey = `coding/sources/task/runner-source/${runnerDigest}.gz`;
  objects.set(runnerSourceKey, { bytes: runnerBytes, metadata: { cwd: original, digest: runnerDigest }, contentType: "application/gzip" });
  opened.store.startDispatched(assignment.taskId, assignment.runId);
  await cloud.startRun(assignment, runnerSourceKey);
  opened.store.ready(assignment.taskId, assignment.runId, "/workspace/project");

  async function driveOnce() {
    await runtime.drive();
    while (tracked.length) await Promise.all(tracked.splice(0));
  }
  async function driveUntil(predicate: () => boolean) {
    for (let attempt = 0; attempt < 128; attempt++) { if (predicate()) return; await driveOnce(); }
    assert.fail("The real coding driver did not reach its expected durable state");
  }
  function hold(kind: "response" | "patch" | "destroy") {
    const pending = barrier(); barriers.push(pending);
    if (kind === "response") responseBarrier = pending;
    else if (kind === "patch") patchBarrier = pending;
    else destroyBarrier = pending;
    return pending;
  }
  function operation(sequence: number, method: CodingRpcRequest["method"], args: CodingRpcRequest["args"]): CodingRpcRequest {
    return { operationId: `${codingOperationPrefix(assignment.taskId, assignment.runId)}invocation:${sequence}`, method, args };
  }
  async function nodeSettled(request: CodingRpcRequest): Promise<CodingRpcState> {
    const readyResponse = await fetch(`${origin}/ready`), ready = await readyResponse.json() as { bootId: string };
    const headers = { "x-umpi-coding-task": assignment.taskId, "x-umpi-coding-run": assignment.runId, "x-umpi-coding-boot": ready.bootId };
    const deadline = Date.now() + 10_000;
    do {
      const response = await fetch(`${origin}/operations/${encodeURIComponent(request.operationId)}`, { headers });
      assert.equal(response.status, 200);
      const state = await response.json() as CodingRpcState;
      if (state.status !== "running") return state;
    } while (Date.now() < deadline);
    assert.fail("The real Node operation did not settle");
  }
  async function recordEffect(request: CodingRpcRequest) {
    opened.store.enqueueRpc(assignment.taskId, assignment.runId, request);
    opened.store.dispatched(request.operationId);
    let state = await cloud.invoke(request);
    const deadline = Date.now() + 10_000;
    while (state.status === "running" && Date.now() < deadline) state = await cloud.inspect(request.operationId);
    assert.equal(state.status, "done"); assert.equal(state.result?.ok, true);
    opened.store.receipt(assignment.taskId, assignment.runId, state);
    return state;
  }
  t.after(async () => {
    for (const pending of barriers) pending.release();
    await Promise.allSettled(tracked.splice(0));
    await cloud.stopRun().catch(() => {}); await closeServer(server);
    opened.close(); cloudSqlite.close(); await rm(root, { recursive: true, force: true });
  });
  return {
    assignment, cloud, objects, original, workspace, server, source, rpcRequests, operation, hold, driveOnce, driveUntil, nodeSettled, recordEffect,
    get runtime() { return runtime; }, get store() { return opened.store; }, get destroys() { return destroys; }, get harnessCalls() { return harnessCalls; },
    wrongPatchReceipt() { patchReceipt = "wrong-key"; },
    reopen() { opened.close(); opened = openStore(storePath); runtime = makeRuntime(); },
  };
}

async function assertAbsent(workspace: string, path: string) {
  await assert.rejects(readFile(join(workspace, path)), { code: "ENOENT" });
}

test("cancelling a queued cloud write during an earlier HTTP response preserves its aborted receipt and never writes its file", { timeout: 30_000 }, async t => {
  const f = await fixture(t), first = f.operation(1, "writeFile", ["first.txt", "first\n"]), cancelled = f.operation(2, "writeFile", ["cancelled.txt", "forbidden\n"]), third = f.operation(3, "writeFile", ["third.txt", "allowed\n"]);
  for (const request of [first, cancelled, third]) f.store.enqueueRpc(f.assignment.taskId, f.assignment.runId, request);
  const pending = f.hold("response"), driving = f.driveOnce();
  await pending.entered;
  assert.equal((await f.nodeSettled(first)).result?.ok, true);
  await f.runtime.cancelOperation(f.assignment.taskId, f.assignment.runId, cancelled.operationId);
  const aborted = await f.runtime.inspect(f.assignment.taskId, f.assignment.runId, cancelled.operationId, BACKGROUND_CONTEXT);
  assert.equal(aborted.status, "done"); assert.equal(aborted.result?.ok, false);
  assert.equal(aborted.result && !aborted.result.ok ? aborted.result.error.code : undefined, "aborted");
  pending.release(); await driving;
  assert.equal((await f.nodeSettled(third)).result?.ok, true);
  assert.deepEqual(f.rpcRequests, [first.operationId, third.operationId]);
  await assertAbsent(f.workspace, "cancelled.txt");
  assert.equal(await readFile(join(f.workspace, "third.txt"), "utf8"), "allowed\n");
  assert.deepEqual(await f.runtime.inspect(f.assignment.taskId, f.assignment.runId, cancelled.operationId, BACKGROUND_CONTEXT), aborted);
  await f.driveOnce();
  f.reopen();
  await f.runtime.cancelOperation(f.assignment.taskId, f.assignment.runId, cancelled.operationId);
  assert.deepEqual(await f.runtime.inspect(f.assignment.taskId, f.assignment.runId, cancelled.operationId, BACKGROUND_CONTEXT), aborted);
  assert.equal(f.store.operation(cancelled.operationId)?.dispatched, false);
  await assertAbsent(f.workspace, "cancelled.txt"); assert.equal(f.harnessCalls, 0);
});

test("owner cancellation while an earlier cloud response is awaited prevents every remaining write in that batch", { timeout: 30_000 }, async t => {
  const f = await fixture(t), first = f.operation(1, "writeFile", ["first.txt", "retained\n"]), second = f.operation(2, "writeFile", ["second.txt", "forbidden\n"]), third = f.operation(3, "writeFile", ["third.txt", "forbidden\n"]);
  for (const request of [first, second, third]) f.store.enqueueRpc(f.assignment.taskId, f.assignment.runId, request);
  const pending = f.hold("response"), driving = f.driveOnce();
  await pending.entered; assert.equal((await f.nodeSettled(first)).result?.ok, true);
  const current = f.store.requireTask(f.assignment.taskId);
  f.store.cancel(current.taskId, current.version);
  pending.release(); await driving;
  assert.deepEqual(f.rpcRequests, [first.operationId]);
  assert.equal(f.store.requireTask(current.taskId).status, "cancel_requested");
  for (const request of [second, third]) assert.equal(f.store.operation(request.operationId)?.dispatched, false);
  await assertAbsent(f.workspace, "second.txt"); await assertAbsent(f.workspace, "third.txt");
  await f.driveOnce();
  const stopped = f.store.requireTask(current.taskId);
  assert.equal(stopped.status, "cancelled"); assert.ok(stopped.run?.stoppedAt);
  assert.equal(f.server.listening, false); assert.equal(f.destroys, 1);
  assert.equal(await readFile(join(f.workspace, "first.txt"), "utf8"), "retained\n");
  await assertAbsent(f.workspace, "second.txt"); await assertAbsent(f.workspace, "third.txt");
  assert.equal(f.harnessCalls, 0);
});

test("deadline expiry during an awaited cloud response fences the next queued dispatch at the exact deadline boundary", { timeout: 30_000 }, async t => {
  const f = await fixture(t), first = f.operation(1, "writeFile", ["first.txt", "retained\n"]), late = f.operation(2, "writeFile", ["late.txt", "forbidden\n"]);
  for (const request of [first, late]) f.store.enqueueRpc(f.assignment.taskId, f.assignment.runId, request);
  const pending = f.hold("response"), driving = f.driveOnce();
  await pending.entered; assert.equal((await f.nodeSettled(first)).result?.ok, true);
  const deadline = Date.parse(f.assignment.deadlineAt);
  f.store.expire(deadline - 1); assert.equal(f.store.requireTask(f.assignment.taskId).status, "running");
  f.store.expire(deadline);
  assert.equal(f.store.requireTask(f.assignment.taskId).timedOut, true);
  pending.release(); await driving;
  assert.deepEqual(f.rpcRequests, [first.operationId]);
  assert.equal(f.store.operation(late.operationId)?.dispatched, false);
  await assertAbsent(f.workspace, "late.txt");
  await f.driveOnce();
  const stopped = f.store.requireTask(f.assignment.taskId);
  assert.equal(stopped.status, "failed"); assert.ok(stopped.run?.stoppedAt);
  await assertAbsent(f.workspace, "late.txt"); assert.equal(f.harnessCalls, 0);
});

async function requestVerifiedFinish(f: VerifiedFinishFixture) {
  await f.recordEffect(f.operation(1, "writeFile", ["value.txt", "updated\n"]));
  const command = "test \"$(cat value.txt)\" = updated", verification = f.operation(2, "exec", [command, {}]);
  await f.recordEffect(verification);
  const task = f.store.requireTask(f.assignment.taskId);
  f.store.requestFinish(task.taskId, f.assignment.runId, { expectedVersion: task.version, outcome: "completed", summary: "Updated value.txt and checked its actual contents", verificationCommands: [command] });
  return verification;
}

test("cloud completion waits for the actual patch R2 receipt and confirmed destruction, retaining exact source and successful check evidence", { timeout: 30_000 }, async t => {
  const f = await fixture(t), verification = await requestVerifiedFinish(f);
  const patch = f.hold("patch"), destruction = f.hold("destroy");
  const finalizing = f.driveUntil(() => f.store.requireTask(f.assignment.taskId).status === "completed");
  await patch.entered;
  const awaitingReceipt = f.store.requireTask(f.assignment.taskId);
  assert.equal(awaitingReceipt.status, "finishing"); assert.equal(awaitingReceipt.result, undefined);
  assert.equal(awaitingReceipt.run?.resultReadyAt, undefined); assert.equal(awaitingReceipt.run?.stoppedAt, undefined);
  assert.equal(f.server.listening, true); assert.equal(f.destroys, 0);
  patch.release(); await destruction.entered;
  const awaitingStop = f.store.requireTask(f.assignment.taskId);
  assert.equal(awaitingStop.status, "finishing"); assert.ok(awaitingStop.run?.resultReadyAt);
  assert.equal(awaitingStop.run?.stoppedAt, undefined); assert.equal(f.server.listening, true);
  const checkpoint = f.objects.get(awaitingStop.run!.checkpointKey!); assert.ok(checkpoint);
  const snapshot = await inspectCodingSnapshot(checkpoint.bytes);
  const value = snapshot.document.files.find(file => file.path === "value.txt"); assert.ok(value);
  assert.equal(Buffer.from(value.content, "base64").toString(), "updated\n");
  destruction.release(); await finalizing;
  const completed = f.store.requireTask(f.assignment.taskId);
  assert.equal(completed.status, "completed"); assert.ok(completed.run?.stoppedAt);
  assert.equal(f.server.listening, false); assert.equal(f.destroys, 1);
  assert.equal(completed.result?.artifacts.baseDigest, f.source.digest);
  assert.deepEqual(completed.result?.verification.map(check => ({ operationId: check.operationId, command: check.command, exitCode: check.exitCode, error: check.error })), [{ operationId: verification.operationId, command: verification.args[0], exitCode: 0, error: null }]);
  const retainedPatch = f.objects.get(completed.run!.patchKey!); assert.ok(retainedPatch);
  assert.equal(await codingSourceDigest(retainedPatch.bytes), completed.result!.artifacts.patchDigest);
  assert.match(new TextDecoder().decode(retainedPatch.bytes), /-approved\n\+updated/);
  assert.equal(await readFile(join(f.original, "value.txt"), "utf8"), "approved\n");
  f.reopen();
  assert.deepEqual(f.store.runs(f.assignment.taskId)[0]?.result, completed.result);
  assert.equal(f.harnessCalls, 0);
});

test("a wrong R2 patch receipt cannot publish a completed cloud result even when actual patch bytes were stored", { timeout: 30_000 }, async t => {
  const f = await fixture(t); await requestVerifiedFinish(f); f.wrongPatchReceipt();
  await f.driveUntil(() => f.store.requireTask(f.assignment.taskId).status === "uncertain");
  const task = f.store.requireTask(f.assignment.taskId);
  assert.equal(task.result, undefined); assert.equal(task.run?.resultReadyAt, undefined); assert.equal(task.run?.patchKey, undefined);
  assert.equal(task.run?.stoppedAt, undefined); assert.equal(f.server.listening, true); assert.equal(f.destroys, 0);
  assert.ok([...f.objects.keys()].some(key => key.includes("/patches/")));
  assert.equal(f.harnessCalls, 0);
});

test("cloud finalization rejects a different exact archive digest even when its restored files match the approved source", { timeout: 30_000 }, async t => {
  const f = await fixture(t, true); await requestVerifiedFinish(f);
  await f.driveUntil(() => f.store.requireTask(f.assignment.taskId).status === "uncertain");
  const task = f.store.requireTask(f.assignment.taskId);
  assert.equal(task.result, undefined); assert.equal(task.run?.resultReadyAt, undefined); assert.equal(task.run?.patchKey, undefined);
  assert.equal([...f.objects.keys()].some(key => key.includes("/patches/")), false);
  assert.equal(await readFile(join(f.workspace, "value.txt"), "utf8"), "updated\n");
  assert.equal(await readFile(join(f.original, "value.txt"), "utf8"), "approved\n");
  assert.equal(f.destroys, 0); assert.equal(f.harnessCalls, 0);
});
