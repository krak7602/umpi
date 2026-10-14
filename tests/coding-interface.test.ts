import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { gzipSync } from "node:zlib";
import type { R2Bucket } from "@cloudflare/workers-types";
import type { CodingArtifacts, CodingExecutorReport, CodingSource } from "../src/shared/coding.js";
import { codingOperationPrefix, emptyCodingProgress } from "../src/shared/coding-rpc.js";
import { codingSourceDigest } from "../src/shared/coding-source.js";
import { InputError } from "../src/shared/protocol.js";
import { codingExecutorRequest, codingRequest } from "../src/worker/coding-http.js";
import { CodingRuntime, type CodingCloudClient } from "../src/worker/coding-runtime.js";
import { CodingStore } from "../src/worker/coding-store.js";
import { enqueueCodingApproval, enqueueCodingControls, handleCodingCallback } from "../src/worker/coding-telegram.js";
import { StateError, Store, type Database, type Delivery } from "../src/worker/store.js";
import { authorize } from "../src/worker/transport.js";

const cwd = "/Users/owner/Project";
interface StoredObject { bytes: Uint8Array<ArrayBuffer>; metadata: Record<string, string>; contentType: string }
interface CodingInterfaceFixture {
  runtime: CodingRuntime;
  store: CodingStore;
  objects: Map<string, StoredObject>;
  report(value: CodingExecutorReport | object): Promise<Response | undefined>;
}
function fixture(t: TestContext) {
  const sqlite = new DatabaseSync(":memory:");
  let depth = 0;
  const db: Database = {
    all: <T extends object>(query: string, ...bindings: (string | number | null)[]) => sqlite.prepare(query).all(...bindings) as T[],
    transaction: <T>(run: () => T): T => {
      const name = `coding_interface_${depth++}`; sqlite.exec(`SAVEPOINT ${name}`);
      try { const result = run(); assert.equal(result instanceof Promise, false); sqlite.exec(`RELEASE ${name}`); return result; }
      catch (error) { sqlite.exec(`ROLLBACK TO ${name}; RELEASE ${name}`); throw error; }
      finally { depth--; }
    },
  };
  t.after(() => sqlite.close());
  const owner = new Store(db), store = new CodingStore(owner);
  owner.setSession("control", "owner-control"); owner.setSession("telegram", "owner-telegram");
  store.poll({ executorId: "mac", workspaces: [cwd], available: true, activeRunId: null });
  const objects = new Map<string, StoredObject>();
  const state = { archive: true, cloud: false, puts: 0, wakes: 0, failWake: false, receipt: "matching" as "matching" | "lost" | "wrong-key" | "wrong-cwd" | "wrong-digest" };
  const bucket = {
    async put(key: string, value: Uint8Array<ArrayBuffer>, options: { sha256: string; customMetadata: Record<string, string>; httpMetadata: { contentType: string } }) {
      state.puts++;
      const bytes = new Uint8Array(value), digest = await codingSourceDigest(bytes);
      assert.equal(digest, options.sha256);
      objects.set(key, { bytes, metadata: { ...options.customMetadata }, contentType: options.httpMetadata.contentType });
      if (state.receipt === "lost") return null;
      const checksum = await crypto.subtle.digest("SHA-256", bytes);
      return { key: state.receipt === "wrong-key" ? `${key}.other` : key, size: bytes.length,
        checksums: { sha256: state.receipt === "wrong-digest" ? new ArrayBuffer(32) : checksum },
        customMetadata: { ...options.customMetadata, ...(state.receipt === "wrong-cwd" ? { cwd: "/other" } : {}) } };
    },
    async get(key: string) {
      const object = objects.get(key);
      return object ? { key, size: object.bytes.length, customMetadata: object.metadata, body: new Blob([object.bytes]).stream() } : null;
    },
  } as unknown as R2Bucket;
  const runtime = new CodingRuntime(store, {
    archive: () => state.archive ? bucket : undefined,
    cloud: () => state.cloud ? {} as CodingCloudClient : undefined,
    cloudAvailable: () => state.cloud,
    async wake() { state.wakes++; if (state.failWake) throw new Error("wake unavailable"); },
    harness() { throw new Error("HTTP must not invoke a model"); },
    extension() { throw new Error("HTTP must not instantiate coding tools"); },
    async modelReady() { throw new Error("HTTP must not query model credentials"); },
    track() { throw new Error("HTTP must not start a runner"); },
  });
  function task(id = "task", channel: "control" | "telegram" = "telegram") {
    const created = store.create({ taskId: id, prompt: "Make the requested small source change", cwd, timeoutMs: 60_000 }, channel, channel === "telegram" ? "owner-telegram" : "owner-control");
    enqueueCodingApproval(runtime, created); return created;
  }
  async function http(path: string, method = "GET", body?: unknown) {
    return codingRequest(new Request(`https://example.com${path}`, { method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) }), runtime, async () => "owner-control");
  }
  function confirm(groupId: string, firstId = 100): Delivery {
    const deliveries = owner.deliveries(groupId); assert.ok(deliveries.length);
    for (const item of deliveries) { assert.ok(owner.beginDelivery(item.id)); owner.finishDelivery(item.id, "sent", undefined, firstId + item.part); }
    return owner.delivery(deliveries.at(-1)!.id)!;
  }
  async function report(value: CodingExecutorReport | object) {
    return codingExecutorRequest(new Request("https://example.com/api/executor/coding/report", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(value) }), runtime);
  }
  function claim(id = "task") {
    store.approve(id, store.requireTask(id).version);
    const assignment = store.poll({ executorId: "mac", workspaces: [cwd], available: true, activeRunId: null }).assignment;
    assert.ok(assignment); return assignment;
  }
  return { owner, store, runtime, state, objects, task, http, confirm, report, claim };
}
function callback(delivery: Delivery, label: string): string {
  const result = delivery.replyMarkup?.inline_keyboard.flat().find(button => button.text === label)?.callback_data;
  assert.ok(result); return result;
}
function snapshot(content = "export const value = 1;\n"): Promise<Uint8Array<ArrayBuffer>> {
  return codingSourceDigest(new TextEncoder().encode(content)).then(digest => new Uint8Array(gzipSync(JSON.stringify({ version: 1, capturedAt: "2026-10-10T00:00:00.000Z", baseRevision: null,
    files: [{ path: "index.ts", mode: 0o100644, bytes: Buffer.byteLength(content), digest, content: Buffer.from(content).toString("base64") }], exclusions: [] }))));
}
async function upload(f: CodingInterfaceFixture, bytes: Uint8Array<ArrayBuffer>, sourceId = "source", workspace = cwd, extra: Record<string, string> = {}) {
  return codingRequest(new Request(`https://example.com/api/coding/sources/${sourceId}`, { method: "POST", headers: { "content-type": "application/gzip", "content-length": String(bytes.length), "x-umpi-coding-cwd": Buffer.from(workspace).toString("base64url"), ...extra }, body: bytes }), f.runtime, async () => "owner-control");
}
async function finish(f: CodingInterfaceFixture, taskId: string, patch = "diff --git a/index.ts b/index.ts\n") {
  const task = f.store.requireTask(taskId), runId = task.run!.runId;
  await f.report({ type: "ready", taskId, runId, executorId: "mac", executionCwd: "/private/coding-copy" });
  const request = { expectedVersion: task.version, outcome: "needs_input" as const, summary: "Owner review is needed", verificationCommands: [] };
  f.store.requestFinish(taskId, runId, request);
  const artifacts: CodingArtifacts = { patch, patchDigest: await codingSourceDigest(new TextEncoder().encode(patch)), baseDigest: "a".repeat(64), finalDigest: "b".repeat(64), changes: [{ path: "index.ts", kind: "modified" }] };
  const key = `coding/runs/${taskId}/${runId}/patches/${artifacts.patchDigest}.patch`;
  f.objects.set(key, { bytes: new TextEncoder().encode(patch), metadata: { digest: artifacts.patchDigest }, contentType: "text/x-diff; charset=utf-8" });
  f.store.artifacts(taskId, runId, artifacts, key);
  return { artifacts, key };
}

test("coding HTTP authorization separates owner and executor paths and rejects unsupported methods", async () => {
  const env = { UMPI_CONTROL_TOKEN: "o".repeat(32), UMPI_EXECUTOR_TOKEN: "e".repeat(32) };
  const ownerRoutes = [["GET", "/api/coding"], ["GET", "/api/coding/sources"], ["POST", "/api/coding/sources/source"], ["GET", "/api/coding/tasks"], ["POST", "/api/coding/tasks"],
    ["GET", "/api/coding/tasks/task"], ...["approve", "cancel", "correct", "cloud", "reconcile"].map(action => ["POST", `/api/coding/tasks/task/${action}`]), ...["patch", "checkpoint"].map(action => ["GET", `/api/coding/tasks/task/${action}`])];
  for (const [method, path] of ownerRoutes) {
    await authorize(new Request(`https://example.com${path}`, { method, headers: { authorization: `Bearer ${env.UMPI_CONTROL_TOKEN}` } }), env);
    await assert.rejects(authorize(new Request(`https://example.com${path}`, { method, headers: { authorization: `Bearer ${env.UMPI_EXECUTOR_TOKEN}` } }), env), { status: 401 });
  }
  for (const path of ["/api/executor/coding/poll", "/api/executor/coding/report"]) {
    await authorize(new Request(`https://example.com${path}`, { method: "POST", headers: { authorization: `Bearer ${env.UMPI_EXECUTOR_TOKEN}` } }), env);
    await assert.rejects(authorize(new Request(`https://example.com${path}`, { method: "POST", headers: { authorization: `Bearer ${env.UMPI_CONTROL_TOKEN}` } }), env), { status: 401 });
  }
  for (const [method, path] of [["POST", "/api/coding"], ["PUT", "/api/coding/tasks"], ["GET", "/api/coding/tasks/task/approve"], ["POST", "/api/coding/tasks/task/patch"], ["GET", "/api/executor/coding/poll"], ["POST", "/api/executor/coding/start"], ["POST", "/api/coding/tasks/task/execute"]]) {
    await assert.rejects(authorize(new Request(`https://example.com${path}`, { method, headers: { authorization: `Bearer ${env.UMPI_CONTROL_TOKEN}` } }), env), { status: 404 });
  }
});

test("forged, unconfirmed and cross-message buttons cannot approve; exact click changes only its task once", async t => {
  const f = fixture(t); f.task(); f.task("other");
  const pending = f.owner.deliveries("coding-approval:task:1").at(-1)!;
  const approve = callback(pending, "Approve");
  await assert.rejects(handleCodingCallback(f.runtime, `cod:${crypto.randomUUID()}`, 100), StateError);
  await assert.rejects(handleCodingCallback(f.runtime, approve, 100), StateError);
  f.confirm(pending.groupId);
  await assert.rejects(handleCodingCallback(f.runtime, approve, 101), StateError);
  for (const id of [0, -1, 0.5, Number.NaN]) await assert.rejects(handleCodingCallback(f.runtime, approve, id), StateError);
  const answer = await handleCodingCallback(f.runtime, approve, 100);
  assert.equal(f.store.requireTask("task").status, "queued"); assert.equal(f.store.requireTask("other").status, "pending_approval");
  const queued = f.store.requireTask("task");
  assert.deepEqual(await handleCodingCallback(f.runtime, approve, 100), answer);
  assert.deepEqual(f.store.requireTask("task"), queued);
  await assert.rejects(handleCodingCallback(f.runtime, callback(pending, "Cancel"), 100), StateError);
  assert.deepEqual(f.store.requireTask("task"), queued);
});

test("stale cards and unconfirmed sends fail closed while an explicit overview supplies current controls", async t => {
  const f = fixture(t); f.task();
  const old = f.confirm("coding-approval:task:1");
  await f.http("/api/coding/tasks/task/correct", "POST", { expectedVersion: 1, text: "Preserve the existing exported API" });
  await assert.rejects(handleCodingCallback(f.runtime, callback(old, "Approve"), old.messageId!), StateError);
  const next = f.owner.deliveries("coding-approval:task:2").at(-1)!;
  f.owner.beginDelivery(next.id); f.owner.finishDelivery(next.id, "uncertain", "No confirmed response", 200);
  await assert.rejects(handleCodingCallback(f.runtime, callback(next, "Approve"), 200), StateError);
  enqueueCodingApproval(f.runtime, f.store.requireTask("task"));
  assert.equal(f.owner.readyDeliveries().length, 0);
  enqueueCodingControls(f.runtime, "overview"); enqueueCodingControls(f.runtime, "overview");
  const menu = f.confirm("coding-menu:overview", 300);
  const view = callback(menu, "Review 1");
  await handleCodingCallback(f.runtime, view, 300);
  const before = f.owner.deliveries(`coding-view:${view}`);
  await handleCodingCallback(f.runtime, view, 300);
  assert.deepEqual(f.owner.deliveries(`coding-view:${view}`), before);
  const fresh = f.confirm(`coding-view:${view}`, 400);
  await handleCodingCallback(f.runtime, callback(fresh, "Approve"), fresh.messageId!);
  assert.equal(f.store.requireTask("task").status, "queued");
  assert.equal(f.owner.delivery(next.id)?.status, "uncertain");
});

test("wake and private archive prerequisites precede approval and task admission", async t => {
  const f = fixture(t); f.task(); const card = f.confirm("coding-approval:task:1");
  f.state.archive = false;
  await assert.rejects(handleCodingCallback(f.runtime, callback(card, "Approve"), 100), { status: 503 });
  await assert.rejects(f.http("/api/coding/tasks/task/approve", "POST", { expectedVersion: 1 }), { status: 503 });
  assert.equal(f.store.requireTask("task").status, "pending_approval");
  f.state.archive = true; f.state.failWake = true;
  await assert.rejects(f.http("/api/coding/tasks", "POST", { taskId: "new", prompt: "Owner request", cwd, timeoutMs: 60_000 }));
  await assert.rejects(handleCodingCallback(f.runtime, callback(card, "Approve"), 100));
  assert.equal(f.store.task("new"), undefined); assert.equal(f.store.requireTask("task").status, "pending_approval");
  f.state.failWake = false;
  const created = await f.http("/api/coding/tasks", "POST", { taskId: "new", prompt: "Owner request", cwd, timeoutMs: 60_000 });
  assert.equal(created?.status, 202); assert.equal(f.store.requireTask("new").parentSessionId, "owner-control");
});

test("source uploads preserve exact archive and workspace metadata, and immutable identities reject replacement", async t => {
  const f = fixture(t), bytes = await snapshot();
  const response = await upload(f, bytes); assert.ok(response);
  const source = await response.json() as CodingSource;
  assert.deepEqual(source, f.store.source("source"));
  assert.equal(source.digest, await codingSourceDigest(bytes)); assert.equal(source.cwd, cwd);
  const object = f.objects.get(`coding/uploads/source/${source.digest}.gz`)!;
  assert.deepEqual(object.bytes, bytes); assert.deepEqual(object.metadata, { cwd, digest: source.digest }); assert.equal(object.contentType, "application/gzip");
  await assert.rejects(upload(f, bytes, "source", "/another/workspace"), { status: 409 });
  await assert.rejects(upload(f, await snapshot("different bytes")), { status: 409 });
  assert.equal(f.state.puts, 1); assert.deepEqual(f.store.source("source"), source);
});

test("missing or mismatched R2 receipts never publish a source and receipt loss fences later metadata changes", async t => {
  const f = fixture(t), bytes = await snapshot();
  for (const receipt of ["lost", "wrong-key", "wrong-cwd", "wrong-digest"] as const) {
    f.state.receipt = receipt;
    await assert.rejects(upload(f, bytes, receipt), { status: 503 });
    assert.equal(f.store.source(receipt), undefined);
  }
  const puts = f.state.puts;
  await assert.rejects(upload(f, bytes, "lost", "/different"), { status: 409 }); assert.equal(f.state.puts, puts);
  f.state.receipt = "matching";
  await upload(f, bytes, "lost"); assert.equal(f.store.source("lost")?.cwd, cwd);
});

test("source upload rejects malformed encoding, size declarations and unsafe paths before archive mutation", async t => {
  const f = fixture(t), bytes = await snapshot();
  for (const workspace of ["/workspace//nested", "/workspace/..", "/workspace/", "/workspace\nsecret"]) await assert.rejects(upload(f, bytes, "source", workspace), InputError);
  for (const header of ["!", "Lw==", "_w", Buffer.from(cwd).toString("base64url") + "="]) await assert.rejects(upload(f, bytes, "source", cwd, { "x-umpi-coding-cwd": header }), InputError);
  for (const length of ["", "01", "-1", "1.0"]) await assert.rejects(upload(f, bytes, "source", cwd, { "content-length": length }), InputError);
  await assert.rejects(upload(f, bytes, "source", cwd, { "content-length": String(bytes.length - 1) }), { status: 413 });
  await assert.rejects(upload(f, bytes, "source", cwd, { "content-length": String(bytes.length + 1) }), { status: 503 });
  await assert.rejects(upload(f, bytes, "source", cwd, { "content-length": String(32 * 1024 * 1024 + 1) }), { status: 413 });
  await assert.rejects(upload(f, new Uint8Array([1, 2, 3])), InputError);
  f.state.failWake = true; await assert.rejects(upload(f, bytes));
  assert.equal(f.state.puts, 0); assert.equal(f.store.sources().length, 0);
});

test("cloud offer binds an owner-uploaded exact-workspace source and invalidates old native approval", async t => {
  const f = fixture(t); f.task(); const native = f.confirm("coding-approval:task:1");
  await upload(f, await snapshot());
  await assert.rejects(f.http("/api/coding/tasks/task/cloud", "POST", { expectedVersion: 1, sourceId: "source" }), { status: 503 });
  f.state.cloud = true;
  await assert.rejects(f.http("/api/coding/tasks/task/cloud", "POST", { expectedVersion: 1, sourceId: "missing" }), { status: 409 });
  await upload(f, await snapshot(), "other-workspace", "/another/project");
  await assert.rejects(f.http("/api/coding/tasks/task/cloud", "POST", { expectedVersion: 1, sourceId: "other-workspace" }), { status: 409 });
  await f.http("/api/coding/tasks/task/cloud", "POST", { expectedVersion: 1, sourceId: "source" });
  assert.equal(f.store.requireTask("task").target, "cloud"); assert.equal(f.store.requireTask("task").status, "pending_approval");
  await assert.rejects(handleCodingCallback(f.runtime, callback(native, "Approve"), 100), StateError);
  assert.equal(f.store.poll({ executorId: "mac", workspaces: [cwd], available: true, activeRunId: null }).assignment, null);
  const cloud = f.confirm("coding-approval:task:2", 200);
  await handleCodingCallback(f.runtime, callback(cloud, "Approve"), 200);
  assert.equal(f.store.requireTask("task").status, "queued"); assert.equal(f.store.requireTask("task").sourceId, "source");
});

test("patch downloads are bound to retained bytes and all three result digests, including empty patches", async t => {
  const f = fixture(t); f.task(); f.claim();
  const { artifacts, key } = await finish(f, "task");
  const response = await f.http("/api/coding/tasks/task/patch"); assert.ok(response);
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), f.objects.get(key)!.bytes);
  assert.equal(response.headers.get("x-umpi-coding-patch-digest"), artifacts.patchDigest);
  assert.equal(response.headers.get("x-umpi-coding-base-digest"), artifacts.baseDigest);
  assert.equal(response.headers.get("x-umpi-coding-final-digest"), artifacts.finalDigest);
  assert.equal(response.headers.get("cache-control"), "private, no-store"); assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  f.objects.get(key)!.bytes = new TextEncoder().encode("replaced archive object");
  await assert.rejects(f.http("/api/coding/tasks/task/patch"), { status: 409 });
  await assert.rejects(f.http("/api/coding/tasks/task/checkpoint"), { status: 404 });
  const g = fixture(t); g.task(); g.claim(); await finish(g, "task", "");
  const empty = await g.http("/api/coding/tasks/task/patch"); assert.equal((await empty!.arrayBuffer()).byteLength, 0);
});

test("strict executor reports enforce native task/run ownership and unknown receipt fields cannot mutate state", async t => {
  const f = fixture(t); f.task(); const assignment = f.claim();
  const identity = { taskId: "task", runId: assignment.runId, executorId: "mac" };
  await assert.rejects(f.report({ ...identity, executorId: "other", type: "ready", executionCwd: "/private/coding-copy" }), { status: 403 });
  await assert.rejects(f.report({ ...identity, runId: "wrong", type: "ready", executionCwd: "/private/coding-copy" }), StateError);
  await assert.rejects(f.report({ ...identity, type: "ready", executionCwd: "/private/coding-copy", cwd: "/different" }), InputError);
  await assert.rejects(f.report({ ...identity, type: "stopped", uncertain: false, ownerConfirmedStopped: false }), InputError);
  assert.equal(f.store.requireTask("task").status, "preparing");
  await f.report({ ...identity, type: "ready", executionCwd: "/private/coding-copy" });
  const operationId = `${codingOperationPrefix("task", assignment.runId)}read:1`;
  f.store.enqueueRpc("task", assignment.runId, { operationId, method: "exists", args: ["index.ts"] });
  const state = { operationId, status: "done" as const, progress: emptyCodingProgress(), result: { ok: true as const, value: true } };
  await assert.rejects(f.report({ ...identity, executorId: "other", type: "operation", state }), { status: 403 });
  assert.equal(f.store.operation(operationId)?.receipt, undefined);
  await f.report({ ...identity, type: "operation", state }); assert.deepEqual(f.store.operation(operationId)?.receipt, state);
  await assert.rejects(f.report({ ...identity, type: "operation", state: { ...state, operationId: `${codingOperationPrefix("other", assignment.runId)}read:1` } }), { status: 403 });
});

test("a repeated historical stopped receipt is acknowledged without altering the newer coding run", async t => {
  const f = fixture(t); f.task(); const first = f.claim(); await finish(f, "task");
  const stopped: CodingExecutorReport = { type: "stopped", taskId: "task", runId: first.runId, executorId: "mac", uncertain: false };
  await f.report(stopped); assert.equal(f.store.requireTask("task").status, "waiting_input");
  await f.http("/api/coding/tasks/task/correct", "POST", { expectedVersion: 1, text: "Continue with this owner correction" });
  const second = f.claim(); assert.notEqual(first.runId, second.runId);
  const before = f.store.requireTask("task");
  assert.equal((await f.report(stopped))?.status, 200);
  assert.deepEqual(f.store.requireTask("task"), before);
  await assert.rejects(f.report({ ...stopped, uncertain: true, issue: "late changed receipt" }), { status: 409 });
  await assert.rejects(f.report({ ...stopped, executorId: "other" }), { status: 403 });
  await assert.rejects(f.report({ type: "ready", taskId: "task", runId: first.runId, executorId: "mac", executionCwd: "/private/coding-copy" }), { status: 409 });
  assert.deepEqual(f.store.requireTask("task"), before);
  const history = await f.http("/api/coding/tasks/task/runs");
  const runs = await history!.json() as { runId: string; result?: { artifacts: { patchDigest: string } } }[];
  const prior = runs.find(run => run.runId === first.runId)!;
  const patch = await f.http(`/api/coding/tasks/task/runs/${first.runId}/patch`);
  assert.equal(patch!.headers.get("x-umpi-coding-patch-digest"), prior.result!.artifacts.patchDigest);
  assert.equal(await codingSourceDigest(new Uint8Array(await patch!.arrayBuffer())), prior.result!.artifacts.patchDigest);
  assert.equal(f.store.requireTask("task").run!.assignment.sourceRunId, first.runId);
  await assert.rejects(f.http(`/api/coding/tasks/unrelated/runs/${first.runId}/patch`), { status: 404 });
});

test("executor owner-confirmed stop retains uncertainty while recording release proof", async t => {
  const f = fixture(t); f.task(); const run = f.claim();
  await f.report({ type: "stopped", taskId: "task", runId: run.runId, executorId: "mac", uncertain: true, issue: "Interrupted operation" });
  assert.equal(f.store.requireTask("task").run?.stoppedAt, undefined);
  await f.report({ type: "stopped", taskId: "task", runId: run.runId, executorId: "mac", uncertain: true, issue: "Interrupted operation", ownerConfirmedStopped: true });
  const task = f.store.requireTask("task"); assert.equal(task.status, "uncertain"); assert.ok(task.run?.stoppedAt); assert.ok(task.run?.reconciledAt);
});

test("checkpoint recovery returns only a previously retained run-bound source and never creates an archive", async t => {
  const f = fixture(t); f.task(); const run = f.claim(); const { artifacts, key: patchKey } = await finish(f, "task");
  const bytes = await snapshot(), digest = await codingSourceDigest(bytes);
  const key = `coding/runs/task/${run.runId}/checkpoints/${digest}.gz`;
  f.store.saveSource({ sourceId: `checkpoint-${run.runId}`, cwd, digest, bytes: bytes.length, fileCount: 1, capturedAt: "2026-10-10T00:00:00.000Z", baseRevision: null }, key);
  f.objects.set(key, { bytes, metadata: { digest }, contentType: "application/gzip" });
  f.store.artifacts("task", run.runId, artifacts, patchKey, { key, sourceId: `checkpoint-${run.runId}` });
  const response = await f.http("/api/coding/tasks/task/checkpoint"); assert.ok(response);
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes);
  assert.equal(response.headers.get("content-type"), "application/gzip");
  assert.equal(response.headers.get("x-umpi-coding-source-digest"), digest);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.equal(f.state.puts, 0);
  f.objects.delete(key);
  await assert.rejects(f.http("/api/coding/tasks/task/checkpoint"), { status: 404 });
  assert.equal(f.state.puts, 0);
});

test("owner mutations reject extra fields, missing versions and nonexplicit reconciliation", async t => {
  const f = fixture(t); f.task();
  for (const [action, input] of [
    ["approve", { expectedVersion: "1" }], ["cancel", {}], ["approve", { expectedVersion: 1, target: "cloud" }],
    ["correct", { expectedVersion: 1, text: "Correction", cwd: "/different" }],
    ["reconcile", { expectedVersion: 1, confirmStopped: false }], ["reconcile", { expectedVersion: 1 }],
  ] as const) await assert.rejects(f.http(`/api/coding/tasks/task/${action}`, "POST", input), InputError);
  assert.equal(f.store.requireTask("task").status, "pending_approval");
  assert.equal(f.store.requireTask("task").version, 1);
  assert.equal(f.state.wakes, 0);
  assert.equal(await f.http("/api/coding/tasks/task/patch", "POST"), undefined);
  assert.equal(await f.http("/api/coding/tasks/task/approve", "GET"), undefined);
});

test("executor poll cannot claim work until lifecycle wake succeeds and refuses owner fields", async t => {
  const f = fixture(t); f.task(); f.store.approve("task", 1);
  const poll = (body: object) => codingExecutorRequest(new Request("https://example.com/api/executor/coding/poll", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }), f.runtime);
  const input = { executorId: "mac", workspaces: [cwd], available: true, activeRunId: null };
  await assert.rejects(poll({ ...input, approve: true }), InputError);
  f.state.failWake = true; await assert.rejects(poll(input));
  assert.equal(f.store.requireTask("task").run, undefined);
  f.state.failWake = false;
  const response = await poll(input); assert.ok(response);
  const result = await response.json() as { assignment: { taskId: string; runId: string } };
  assert.equal(result.assignment.taskId, "task"); assert.equal(result.assignment.runId, f.store.requireTask("task").run?.runId);
});
