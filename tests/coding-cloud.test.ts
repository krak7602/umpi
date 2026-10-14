import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { gzipSync } from "node:zlib";
import type { R2Bucket, R2Object } from "@cloudflare/workers-types";
import { createCodingService } from "../src/coding/server.js";
import { CodingCloudRun, persistCodingObject, readCodingBody, type CodingCloudOptions, type CodingCloudStorage } from "../src/worker/coding-cloud.js";
import type { CodingArtifacts, CodingAssignment } from "../src/shared/coding.js";
import { codingOperationPrefix, decodeCodingValue, type CodingRpcRequest, type CodingRpcState } from "../src/shared/coding-rpc.js";
import { codingSourceDigest, inspectCodingSnapshot } from "../src/shared/coding-source.js";

class MemoryStorage implements CodingCloudStorage {
  readonly values = new Map<string, unknown>();
  failAfterIntent = false;
  async get<T>(key: string): Promise<T | undefined> { return structuredClone(this.values.get(key)) as T | undefined; }
  async put<T>(key: string, value: T): Promise<void> {
    this.values.set(key, structuredClone(value));
    if (this.failAfterIntent && key.startsWith("coding-operation:")) { this.failAfterIntent = false; throw new Error("Synthetic actor loss after durable admission"); }
  }
  async list<T>(prefix: string): Promise<Map<string, T>> { return new Map([...this.values].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => [key, structuredClone(value) as T])); }
}
interface StoredObject { bytes: Uint8Array<ArrayBuffer>; customMetadata: Record<string, string> }
interface Fixture {
  root: string;
  workspace: string;
  assignment: CodingAssignment;
  sourceKey: string;
  storage: MemoryStorage;
  objects: Map<string, StoredObject>;
  options: CodingCloudOptions;
  run: CodingCloudRun;
  starts: number;
  destroys: number;
  rpcRequests: number;
  dropReply: boolean;
  releaseCheckpoint?: () => void;
  checkpointEntered?: () => void;
}
async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  server.closeAllConnections();
  const closed = once(server, "close"); server.close(); await closed;
}
async function fixture(t: test.TestContext, deadlineMs = 60_000, idleTimeoutMs = 120_000): Promise<Fixture> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "umpi-cloud-test-")));
  const assignment: CodingAssignment = { taskId: "task", runId: "run", cwd: "/approved/original", deadlineAt: new Date(Date.now() + deadlineMs).toISOString() };
  const source = gzipSync(JSON.stringify({ version: 1, capturedAt: "2026-01-01T00:00:00.000Z", baseRevision: null, files: [], exclusions: [] }));
  const digest = await codingSourceDigest(source), sourceKey = `coding/sources/task/source/${digest}.gz`;
  const objects = new Map<string, StoredObject>([[sourceKey, { bytes: new Uint8Array(source), customMetadata: { cwd: assignment.cwd, digest } }]]);
  const storage = new MemoryStorage(), workspace = join(root, "workspace");
  const server = createCodingService({ workspace, stateDirectory: join(root, "state"), idleTimeoutMs, terminate: () => {} });
  let origin = "";
  let f!: Fixture;
  const bucket = {
    async get(key: string) {
      const object = objects.get(key);
      if (!object) return null;
      return { key, size: object.bytes.length, customMetadata: object.customMetadata, body: new Blob([object.bytes]).stream() };
    },
    async put(key: string, value: Uint8Array<ArrayBuffer>, options: { customMetadata?: Record<string, string> }) {
      const bytes = new Uint8Array(value);
      if (key.includes("/checkpoints/") && f.checkpointEntered) {
        const wait = new Promise<void>(resolve => { f.releaseCheckpoint = resolve; });
        f.checkpointEntered(); await wait;
      }
      objects.set(key, { bytes, customMetadata: options.customMetadata ?? {} });
      return { key, size: bytes.length };
    },
  } as unknown as R2Bucket;
  const options: CodingCloudOptions = {
    storage, bucket,
    async startContainer() { f.starts++; server.listen(0, "127.0.0.1"); await once(server, "listening"); const address = server.address(); assert.ok(address && typeof address !== "string"); origin = `http://127.0.0.1:${address.port}`; },
    async request(path, init) {
      if (!server.listening) throw new Error("Synthetic container is stopped");
      if (path === "/rpc") f.rpcRequests++;
      const response = await fetch(`${origin}${path}`, init);
      if (path === "/rpc" && f.dropReply) {
        f.dropReply = false;
        let state = await response.json() as CodingRpcState;
        const deadline = Date.now() + 5000;
        while (state.status === "running" && Date.now() < deadline) {
          await delay(10);
          const observed = await fetch(`${origin}/operations/${encodeURIComponent(state.operationId)}`, { headers: init?.headers });
          state = await observed.json() as CodingRpcState;
        }
        assert.equal(state.status, "done");
        throw new Error("Synthetic response loss after real mutation");
      }
      return response;
    },
    async destroyContainer() { f.destroys++; await closeServer(server); },
    async scheduleDeadline(deadline) { assert.equal(deadline.toISOString(), assignment.deadlineAt); },
  };
  f = { root, workspace, assignment, sourceKey, storage, objects, options, run: new CodingCloudRun(options), starts: 0, destroys: 0, rpcRequests: 0, dropReply: false };
  t.after(async () => { await f.run.stopRun().catch(() => {}); await closeServer(server); await rm(root, { recursive: true, force: true }); });
  return f;
}
function operation(sequence: number, method: CodingRpcRequest["method"], args: CodingRpcRequest["args"]): CodingRpcRequest {
  return { operationId: `${codingOperationPrefix("task", "run")}invocation:${sequence}`, method, args };
}
async function settled(run: CodingCloudRun, request: CodingRpcRequest): Promise<CodingRpcState> {
  let state = await run.invoke(request);
  const deadline = Date.now() + 10_000;
  while (state.status === "running" && Date.now() < deadline) { await delay(10); state = await run.inspect(request.operationId); }
  assert.equal(state.status, "done");
  return state;
}

test("real HTTP coding writes and executes once, retains output and checkpoints before shutdown", async t => {
  const f = await fixture(t);
  await f.run.startRun(f.assignment, f.sourceKey);
  const write = operation(1, "writeFile", ["source.txt", "first\n"]);
  assert.equal((await settled(f.run, write)).result?.ok, true);
  const command = operation(2, "exec", ["printf 'second\\n' >> source.txt; printf 'real command output'", {}]);
  const executed = await settled(f.run, command);
  assert.equal(executed.result?.ok, true);
  assert.match(executed.progress.output.map(chunk => chunk.text).join(""), /real command output/);
  assert.deepEqual(await f.run.invoke(command), executed);
  assert.equal(await readFile(join(f.workspace, "source.txt"), "utf8"), "first\nsecond\n");
  const actorAfterEviction = new CodingCloudRun(f.options);
  assert.deepEqual(await actorAfterEviction.inspect(command.operationId), executed);
  const artifactState = await settled(actorAfterEviction, operation(3, "artifacts", []));
  assert.ok(artifactState.result?.ok);
  const artifacts = decodeCodingValue(artifactState.result.value) as unknown as CodingArtifacts;
  assert.equal(artifacts.baseDigest, await codingSourceDigest(f.objects.get(f.sourceKey)!.bytes));
  assert.match(artifacts.patch, /first/);
  const checkpoint = await actorAfterEviction.checkpoint();
  const retained = f.objects.get(checkpoint.key); assert.ok(retained);
  assert.equal(await codingSourceDigest(retained.bytes), checkpoint.digest);
  const snapshot = await inspectCodingSnapshot(retained.bytes);
  assert.equal(Buffer.from(snapshot.document.files.find(file => file.path === "source.txt")!.content, "base64").toString(), "first\nsecond\n");
  await assert.rejects(actorAfterEviction.invoke(operation(4, "appendFile", ["source.txt", "forbidden"])), /no longer admits/);
  assert.deepEqual(await actorAfterEviction.stopRun(), { stopped: true, uncertain: false });
  assert.deepEqual(await actorAfterEviction.inspect(command.operationId), executed);
  assert.equal(f.starts, 1);
});

test("task/source/workspace/run mismatches fail before any container or command starts", async t => {
  const f = await fixture(t);
  await assert.rejects(f.run.startRun({ ...f.assignment, taskId: "other" }, f.sourceKey), /not owned/);
  await assert.rejects(f.run.startRun({ ...f.assignment, cwd: "/other/workspace" }, f.sourceKey), /workspace/);
  assert.equal(f.starts, 0);
  await f.run.startRun(f.assignment, f.sourceKey);
  await assert.rejects(f.run.startRun({ ...f.assignment, runId: "different" }, f.sourceKey), /immutable/);
  await assert.rejects(f.run.invoke({ ...operation(1, "writeFile", ["bad", "bad"]), operationId: `${codingOperationPrefix("other", "run")}invocation:1` }), /another run/);
  const request = operation(1, "writeFile", ["source.txt", "original"]);
  await settled(f.run, request);
  await assert.rejects(f.run.invoke({ ...request, args: ["source.txt", "changed"] }), /different arguments/);
  assert.equal(await readFile(join(f.workspace, "source.txt"), "utf8"), "original");
});

test("early source or deadline rejection can stop without an owner and durably forbids late startup", async t => {
  for (const rejection of ["source", "deadline"] as const) {
    const f = await fixture(t);
    const rejected = rejection === "source" ? { ...f.assignment, cwd: "/wrong" } : { ...f.assignment, deadlineAt: new Date(Date.now() - 1000).toISOString() };
    await assert.rejects(f.run.startRun(rejected, f.sourceKey), rejection === "source" ? /workspace/ : /deadline/);
    assert.equal(await f.storage.get("coding-owner"), undefined);
    let confirm!: () => void, entered!: () => void;
    const confirmation = new Promise<void>(resolve => { confirm = resolve; });
    const destroying = new Promise<void>(resolve => { entered = resolve; });
    const destroy = f.options.destroyContainer;
    f.options.destroyContainer = async () => {
      assert.deepEqual(await f.storage.get("coding-stop-fence"), { stopped: false });
      entered(); await confirmation; await destroy();
    };
    let acknowledged = false;
    const stopping = f.run.stopRun().then(result => { acknowledged = true; return result; });
    await destroying;
    assert.equal(acknowledged, false);
    const late = assert.rejects(f.run.startRun(f.assignment, f.sourceKey), /cannot be restarted/);
    confirm();
    assert.deepEqual(await stopping, { stopped: true, uncertain: false });
    await late;
    f.run = new CodingCloudRun(f.options);
    await assert.rejects(f.run.startRun(f.assignment, f.sourceKey), /cannot be restarted/);
    assert.deepEqual(await f.run.stopRun(), { stopped: true, uncertain: false });
    assert.equal(f.starts, 0);
    assert.equal(f.destroys, 1);
  }
});

test("stop queued during rejected R2 admission fences the later start after the await", async t => {
  const f = await fixture(t);
  let release!: () => void, entered!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const reading = new Promise<void>(resolve => { entered = resolve; });
  f.options.bucket.get = (async () => { entered(); await pending; return null; }) as R2Bucket["get"];
  const admission = assert.rejects(f.run.startRun(f.assignment, f.sourceKey), /workspace/);
  await reading;
  const stopping = f.run.stopRun();
  const late = assert.rejects(f.run.startRun(f.assignment, f.sourceKey), /cannot be restarted/);
  release();
  await admission;
  assert.deepEqual(await stopping, { stopped: true, uncertain: false });
  await late;
  assert.equal(f.starts, 0);
  assert.equal(f.destroys, 1);
});

test("unconfirmed no-owner destruction retains the durable fence until a confirmed retry", async t => {
  const f = await fixture(t);
  const destroy = f.options.destroyContainer;
  f.options.destroyContainer = async () => { throw new Error("Destruction not confirmed"); };
  assert.deepEqual(await f.run.stopRun(), { stopped: false, uncertain: true });
  f.run = new CodingCloudRun(f.options);
  await assert.rejects(f.run.startRun(f.assignment, f.sourceKey), /cannot be restarted/);
  f.options.destroyContainer = destroy;
  assert.deepEqual(await f.run.stopRun(), { stopped: true, uncertain: false });
  assert.equal(f.starts, 0);
});

test("actor loss after intent but before dispatch yields uncertainty without a duplicate send", async t => {
  const f = await fixture(t);
  await f.run.startRun(f.assignment, f.sourceKey);
  f.storage.failAfterIntent = true;
  const request = operation(1, "writeFile", ["never-created.txt", "content"]);
  await assert.rejects(f.run.invoke(request), /Synthetic actor loss/);
  f.run = new CodingCloudRun(f.options);
  assert.equal((await f.run.invoke(request)).status, "uncertain");
  assert.equal(f.rpcRequests, 0);
  assert.equal(f.starts, 1);
  await assert.rejects(readFile(join(f.workspace, "never-created.txt")), { code: "ENOENT" });
  await assert.rejects(f.run.startRun(f.assignment, f.sourceKey), /cannot be restarted/);
});

test("lost response after real mutation never replays admitted append", async t => {
  const f = await fixture(t);
  await f.run.startRun(f.assignment, f.sourceKey);
  await settled(f.run, operation(1, "writeFile", ["source.txt", ""]));
  const request = operation(2, "appendFile", ["source.txt", "once"]);
  f.dropReply = true;
  assert.equal((await f.run.invoke(request)).status, "uncertain");
  assert.equal((await new CodingCloudRun(f.options).invoke(request)).status, "uncertain");
  assert.equal(f.rpcRequests, 2);
  assert.equal(f.starts, 1);
  assert.equal(await readFile(join(f.workspace, "source.txt"), "utf8"), "once");
});

test("normal stop waits for the actual checkpoint R2 receipt before destroy", async t => {
  const f = await fixture(t);
  await f.run.startRun(f.assignment, f.sourceKey);
  let entered!: () => void;
  const checkpointEntered = new Promise<void>(resolve => { entered = resolve; });
  f.checkpointEntered = entered;
  const stopping = f.run.stopRun();
  await checkpointEntered;
  assert.equal(f.destroys, 0);
  f.releaseCheckpoint!();
  assert.deepEqual(await stopping, { stopped: true, uncertain: false });
  assert.equal(f.destroys, 1);
});

test("container loss preserves real finished outputs and forbids automatic restart", async t => {
  const f = await fixture(t);
  await f.run.startRun(f.assignment, f.sourceKey);
  const request = operation(1, "readTextFile", ["missing.txt"]), result = await settled(f.run, request);
  assert.equal(result.result?.ok, false);
  await f.options.destroyContainer(); await f.run.lost();
  assert.deepEqual(await new CodingCloudRun(f.options).inspect(request.operationId), result);
  await assert.rejects(f.run.invoke(operation(2, "writeFile", ["after-loss", "bad"])), /no longer admits/);
  await assert.rejects(f.run.startRun(f.assignment, f.sourceKey), /cannot be restarted/);
  assert.equal(f.starts, 1);
});

test("server rejects unknown endpoints and changed boot/run fencing", async t => {
  const f = await fixture(t);
  await f.run.startRun(f.assignment, f.sourceKey);
  const owner = await f.storage.get<{ bootId: string }>("coding-owner"); assert.ok(owner);
  const headers = { "x-umpi-coding-task": "task", "x-umpi-coding-run": "different", "x-umpi-coding-boot": owner.bootId };
  const wrongRun = await f.options.request("/snapshot", { headers }); assert.equal(wrongRun.status, 409); await wrongRun.body?.cancel();
  const wrongBoot = await f.options.request("/snapshot", { headers: { ...headers, "x-umpi-coding-run": "run", "x-umpi-coding-boot": "old-process" } }); assert.equal(wrongBoot.status, 409); await wrongBoot.body?.cancel();
  const arbitrary = await f.options.request("/exec", { method: "POST", body: "uname" }); assert.equal(arbitrary.status, 404); await arbitrary.body?.cancel();
  const earlySnapshot = await f.options.request("/snapshot", { headers: { ...headers, "x-umpi-coding-run": "run" } }); assert.equal(earlySnapshot.status, 409); await earlySnapshot.body?.cancel();
});

test("archive consumer rejects wrong receipts and truncated or overlong streams", async () => {
  const bytes = new Uint8Array([1, 2, 3]);
  for (const receipt of [null, { key: "wrong", size: 3 }, { key: "key", size: 2 }]) {
    const bucket = { async put() { return receipt; } } as unknown as R2Bucket;
    await assert.rejects(persistCodingObject(bucket, "key", bytes, "application/gzip"), /receipt/);
  }
  await assert.rejects(readCodingBody(new Blob([bytes]).stream(), 2, 10), /exceeds/);
  await assert.rejects(readCodingBody(new Blob([bytes]).stream(), 4, 10), /Incomplete/);
  let confirm!: (receipt: R2Object) => void;
  const pending = new Promise<R2Object>(resolve => { confirm = resolve; });
  let finished = false;
  const bucket = { put() { return pending; } } as unknown as R2Bucket;
  const persisting = persistCodingObject(bucket, "key", bytes, "application/gzip").then(value => { finished = true; return value; });
  await delay(0); assert.equal(finished, false);
  confirm({ key: "key", size: 3 } as R2Object);
  assert.equal((await persisting).bytes, 3);
  assert.deepEqual(bytes, new Uint8Array([1, 2, 3]));
});

test("local hard deadline cancels real effects even without coordinator polling", async t => {
  const f = await fixture(t, 4000);
  await f.run.startRun(f.assignment, f.sourceKey);
  const command = operation(1, "exec", ["sleep 10; printf unsafe > late.txt", {}]);
  assert.equal((await f.run.invoke(command)).status, "running");
  await delay(Math.max(0, Date.parse(f.assignment.deadlineAt) - Date.now()) + 1200);
  const terminal = await f.run.inspect(command.operationId);
  assert.notEqual(terminal.status, "running");
  await assert.rejects(readFile(join(f.workspace, "late.txt")), { code: "ENOENT" });
  await assert.rejects(f.run.invoke(operation(2, "writeFile", ["late.txt", "forbidden"])), /no longer admits/);
});

test("idle HTTP service freezes admission while leaving a bounded checkpoint window", async t => {
  const f = await fixture(t, 60_000, 1000);
  await f.run.startRun(f.assignment, f.sourceKey);
  await delay(2200);
  const response = await f.options.request("/ready");
  const ready = await response.json() as { frozen: boolean };
  assert.equal(ready.frozen, true);
  const checkpoint = await f.run.checkpoint();
  assert.ok(f.objects.has(checkpoint.key));
  assert.deepEqual(await f.run.stopRun(), { stopped: true, uncertain: false });
});

test("periodic real service activity keeps model-thinking idle time active", async t => {
  const f = await fixture(t, 60_000, 1000);
  await f.run.startRun(f.assignment, f.sourceKey);
  for (let tick = 0; tick < 10; tick++) { await delay(250); await f.run.activity(); }
  const ready = await (await f.options.request("/ready")).json() as { frozen: boolean };
  assert.equal(ready.frozen, false);
  assert.equal(f.rpcRequests, 0);
  assert.equal((await settled(f.run, operation(1, "writeFile", ["after-thinking.txt", "active"]))).result?.ok, true);
  assert.equal(await readFile(join(f.workspace, "after-thinking.txt"), "utf8"), "active");
});

test("hard deadline freezes the real service despite ongoing correctly fenced activity", async t => {
  const f = await fixture(t, 4500, 1000);
  await f.run.startRun(f.assignment, f.sourceKey);
  const owner = await f.storage.get<{ bootId: string }>("coding-owner"); assert.ok(owner);
  const headers = { "x-umpi-coding-task": "task", "x-umpi-coding-run": "run", "x-umpi-coding-boot": owner.bootId };
  let accepted = 0, rejected = 0;
  const observeUntil = Date.parse(f.assignment.deadlineAt) + 1200;
  while (Date.now() < observeUntil) {
    const response = await f.options.request("/activity", { headers });
    if (response.status === 200) accepted++;
    else { assert.equal(response.status, 409); rejected++; }
    await response.body?.cancel();
    await delay(250);
  }
  assert.ok(accepted > 4);
  assert.ok(rejected > 0);
  const ready = await (await f.options.request("/ready")).json() as { frozen: boolean };
  assert.equal(ready.frozen, true);
  await assert.rejects(f.run.invoke(operation(1, "writeFile", ["after-deadline.txt", "forbidden"])), /no longer admits/);
  await assert.rejects(readFile(join(f.workspace, "after-deadline.txt")), { code: "ENOENT" });
});

test("wrong run and boot activity never extends the real service idle window", async t => {
  const f = await fixture(t, 60_000, 1000);
  await f.run.startRun(f.assignment, f.sourceKey);
  const owner = await f.storage.get<{ bootId: string }>("coding-owner"); assert.ok(owner);
  for (let tick = 0; tick < 10; tick++) {
    await delay(250);
    for (const identity of [{ run: "other", boot: owner.bootId }, { run: "run", boot: "old-process" }]) {
      const response = await f.options.request("/activity", { headers: { "x-umpi-coding-task": "task", "x-umpi-coding-run": identity.run, "x-umpi-coding-boot": identity.boot } });
      assert.equal(response.status, 409); await response.body?.cancel();
    }
  }
  const ready = await (await f.options.request("/ready")).json() as { frozen: boolean };
  assert.equal(ready.frozen, true);
  await assert.rejects(f.run.activity(), /unconfirmed/);
});

test("a replaced Node process reports uncertainty and refuses old scratch adoption", async t => {
  const f = await fixture(t);
  await f.run.startRun(f.assignment, f.sourceKey);
  await settled(f.run, operation(1, "writeFile", ["source.txt", "retained"]));
  const oldReadyResponse = await f.options.request("/ready");
  const oldReady = await oldReadyResponse.json() as { bootId: string };
  await f.run.cancel();
  await f.options.destroyContainer();
  const replacement = createCodingService({ workspace: f.workspace, stateDirectory: join(f.root, "state"), terminate: () => {} });
  replacement.listen(0, "127.0.0.1"); await once(replacement, "listening");
  try {
    const address = replacement.address(); assert.ok(address && typeof address !== "string");
    const origin = `http://127.0.0.1:${address.port}`;
    const response = await fetch(`${origin}/ready`), ready = await response.json() as { bootId: string; uncertain: boolean; initialized: boolean };
    assert.notEqual(ready.bootId, oldReady.bootId);
    assert.equal(ready.uncertain, true);
    assert.equal(ready.initialized, false);
    const attempt = await fetch(`${origin}/start`, { method: "POST", headers: { "x-umpi-coding-boot": ready.bootId } });
    assert.equal(attempt.status, 409); await attempt.body?.cancel();
    assert.equal(await readFile(join(f.workspace, "source.txt"), "utf8"), "retained");
  } finally { await closeServer(replacement); }
});

test("failed checkpoint receipt permits only an explicitly uncertain forced stop", async t => {
  const f = await fixture(t);
  await f.run.startRun(f.assignment, f.sourceKey);
  f.options.bucket.put = (async () => null) as unknown as R2Bucket["put"];
  assert.deepEqual(await f.run.stopRun(), { stopped: true, uncertain: true });
  assert.equal(f.destroys, 1);
  assert.equal([...f.objects.keys()].some(key => key.includes("/checkpoints/")), false);
});

test("pre-admission cancellation accepts only owned IDs and invents no receipt", async t => {
  const f = await fixture(t);
  await f.run.startRun(f.assignment, f.sourceKey);
  const pending = operation(1, "writeFile", ["pending.txt", "content"]);
  await f.run.cancel(pending.operationId);
  await assert.rejects(f.run.inspect(pending.operationId), /Unknown coding operation/);
  assert.equal(f.rpcRequests, 0);
  await assert.rejects(f.run.cancel(`${codingOperationPrefix("other", "run")}invocation:1`), /another run/);
  assert.equal((await settled(f.run, operation(2, "writeFile", ["unrelated.txt", "still active"]))).result?.ok, true);
});
