import assert from "node:assert/strict";
import test from "node:test";
import type { TestContext } from "node:test";
import { DatabaseSync } from "node:sqlite";
import type { R2Bucket } from "@cloudflare/workers-types";
import { browserEnvelopeAad, browserOperationPrefix, requestedBrowserSite } from "../src/shared/browser.js";
import type { BrowserSitePolicy, BrowserSnapshotEnvelope } from "../src/shared/browser.js";
import { BrowserStore } from "../src/worker/browser-store.js";
import { BrowserSnapshots } from "../src/worker/browser-snapshots.js";
import { BrowserRuntime } from "../src/worker/browser-runtime.js";
import { browserExecutorRequest, browserRequest, browserSyncRequest } from "../src/worker/browser-http.js";
import { enqueueBrowserApproval, handleBrowserCallback } from "../src/worker/browser-telegram.js";
import { Store } from "../src/worker/store.js";
import type { Database } from "../src/worker/store.js";
import { authorize } from "../src/worker/transport.js";
function fixture(t: TestContext, policy: BrowserSitePolicy = { siteId: "fixture", title: "Fixture", origins: ["https://example.test"], cookieHosts: [".example.test"], cookieNames: ["session"], resourceHosts: [] }) {
  const sqlite = new DatabaseSync(":memory:"); let depth = 0;
  const db: Database = {
    all: <T extends object>(query: string, ...bindings: (string | number | null)[]) => sqlite.prepare(query).all(...bindings) as T[],
    transaction<T>(run: () => T): T { const name = `browser_${depth++}`; sqlite.exec(`SAVEPOINT ${name}`); try { const result = run(); assert.equal(result instanceof Promise, false); sqlite.exec(`RELEASE ${name}`); return result; } catch (error) { sqlite.exec(`ROLLBACK TO ${name}; RELEASE ${name}`); throw error; } finally { depth--; } },
  };
  t.after(() => sqlite.close()); const owner = new Store(db), store = new BrowserStore(owner);
  owner.setSession("control", "owner-control"); owner.setSession("telegram", "owner-telegram");
  const site = store.registerSite(policy, 0);
  const objects = new Map<string, Uint8Array<ArrayBuffer>>();
  const provider: { beforePut?: () => Promise<void>; afterPut?: () => Promise<"wrong" | "lost" | void>; beforeDelete?: (key: string) => Promise<void>; puts: number; deletes: number } = { puts: 0, deletes: 0 };
  const bucket = {
    async put(key: string, bytes: Uint8Array<ArrayBuffer>, options: { customMetadata: Record<string, string> }) {
      provider.puts++; await provider.beforePut?.(); objects.set(key, bytes.slice());
      const result = await provider.afterPut?.();
      if (result === "lost") throw Error("Synthetic receipt loss");
      return { key: result === "wrong" ? "wrong-key" : key, size: bytes.length, customMetadata: options.customMetadata, checksums: { sha256: await crypto.subtle.digest("SHA-256", bytes) } };
    },
    async get(key: string) { const bytes = objects.get(key); return bytes ? { size: bytes.length, async arrayBuffer() { return bytes.slice().buffer; } } : null; },
    async delete(key: string) { provider.deletes++; await provider.beforeDelete?.(key); objects.delete(key); },
  } as unknown as R2Bucket;
  const snapshots = new BrowserSnapshots(store, () => bucket);
  const runtime = new BrowserRuntime(store, snapshots, { harness() { throw Error("Not a model fixture"); }, extension() { throw Error("Not a model fixture"); }, cloud() { return undefined; }, cloudAvailable() { return false; }, async modelReady() { return false; }, async wake() {}, track() { throw Error("No task execution in interface fixture"); } });
  const task = (id = "task") => store.create({ taskId: id, prompt: "Read the approved fixture", sites: [{ siteId: site.siteId, startUrl: "https://example.test/" }], timeoutMs: 60_000 }, "telegram", "owner-telegram");
  function claim(id = "task") { const task = store.requireTask(id); store.approve(id, task.version); const assignment = store.poll({ executorId: "mac", available: true, activeRunId: null, sites: [{ siteId: site.siteId, policyDigest: site.policyDigest }] }).assignment!; store.ready(id, assignment.runId); return assignment; }
  async function prepareUpload(id: string, cookies: unknown[] = [{ name: "session", value: "synthetic-private-cookie", domain: ".example.test", path: "/", expires: -1, secure: true, httpOnly: true }]) {
    const key = await snapshots.publicKey(), metadata = { snapshotId: id, siteId: site.siteId, policyDigest: site.policyDigest, keyId: key.keyId, capturedAt: new Date(Date.now() - Number(id.split("-").at(-1) ?? 0) * 1000).toISOString(), expiresAt: new Date(Date.now() + 86_400_000).toISOString() };
    const raw = crypto.getRandomValues(new Uint8Array(32)), nonce = crypto.getRandomValues(new Uint8Array(12));
    const aes = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt"]), rsa = await crypto.subtle.importKey("jwk", key.publicKey, { name: "RSA-OAEP", hash: "SHA-256" }, false, ["encrypt"]);
    const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: browserEnvelopeAad(metadata) as Uint8Array<ArrayBuffer> }, aes, new TextEncoder().encode(JSON.stringify({ version: 1, cookies })));
    const wrapped = await crypto.subtle.encrypt({ name: "RSA-OAEP" }, rsa, raw);
    const envelope: BrowserSnapshotEnvelope = { version: 1, ...metadata, wrappedKey: Buffer.from(wrapped).toString("base64"), nonce: Buffer.from(nonce).toString("base64"), ciphertext: Buffer.from(ciphertext).toString("base64") };
    return new TextEncoder().encode(JSON.stringify(envelope));
  }
  async function upload(id: string, cookies?: unknown[]) { return snapshots.upload(id, await prepareUpload(id, cookies)); }
  return { store, owner, runtime, site, snapshots, objects, provider, bucket, task, claim, prepareUpload, upload };
}
test("browser roles forbid cross-role key, upload, task and executor access", async () => {
  const env = { UMPI_CONTROL_TOKEN: "o".repeat(32), UMPI_EXECUTOR_TOKEN: "e".repeat(32), UMPI_BROWSER_SYNC_TOKEN: "s".repeat(32) };
  const routes = [["GET", "/api/browser/snapshot-key", env.UMPI_BROWSER_SYNC_TOKEN], ["POST", "/api/browser/snapshots/snapshot", env.UMPI_BROWSER_SYNC_TOKEN], ["POST", "/api/browser/tasks", env.UMPI_CONTROL_TOKEN], ["POST", "/api/executor/browser/poll", env.UMPI_EXECUTOR_TOKEN]];
  for (const [method, path, permitted] of routes) for (const token of Object.values(env)) {
    const request = new Request(`https://example.test${path}`, { method, headers: { authorization: `Bearer ${token}` } });
    if (token === permitted) await authorize(request, env); else await assert.rejects(authorize(request, env), { status: 401 });
  }
  await assert.rejects(authorize(new Request("https://example.test/api/browser/tasks/task/execute", { method: "POST" }), env), { status: 404 });
});
test("colliding synchronizer credentials cannot inherit general owner or executor privileges", async () => {
  const base = { UMPI_CONTROL_TOKEN: "o".repeat(32), UMPI_EXECUTOR_TOKEN: "e".repeat(32) };
  for (const token of Object.values(base)) {
    const env = { ...base, UMPI_BROWSER_SYNC_TOKEN: token };
    await assert.rejects(authorize(new Request("https://example.test/api/messages", { method: "POST", headers: { authorization: `Bearer ${token}` } }), env), { status: 503 });
    await assert.rejects(authorize(new Request("https://example.test/api/executor/browser/poll", { method: "POST", headers: { authorization: `Bearer ${token}` } }), env), { status: 503 });
  }
});
test("Mac ownership survives disconnect and versioned corrections without transferring", async t => {
  const f = fixture(t); f.task(); const run = f.claim();
  f.store.correct("task", 1, "Read the current page only");
  assert.equal(f.store.requireTask("task").run!.runId, run.runId);
  assert.throws(() => f.store.requestCloud("task", 2, []), { status: 409 });
  f.store.cancel("task", 2); assert.equal(f.store.requireTask("task").status, "cancel_requested");
  assert.equal(f.store.poll({ executorId: "mac", available: false, activeRunId: run.runId, sites: [] }).cancel, true);
  f.store.stopped("task", run.runId, false); assert.equal(f.store.requireTask("task").status, "cancelled");
});
test("completion needs settled owned observations and actual stop; replay cannot change terminal receipt", t => {
  const f = fixture(t); f.task(); const run = f.claim(), operationId = browserOperationPrefix("task", run.runId) + "observe";
  f.store.enqueue("task", run.runId, { operationId, action: { kind: "observe", siteId: "fixture" } });
  assert.throws(() => f.store.requestFinish("task", run.runId, { expectedVersion: 1, outcome: "completed", summary: "Read", observationIds: [] }), { status: 409 });
  f.store.dispatched(operationId); const receipt = { operationId, status: "done", observation: { siteId: "fixture", snapshotId: "view", url: "https://example.test/", title: "Fixture", tree: "Actual fixture content" } };
  f.store.receipt("task", run.runId, receipt); assert.throws(() => f.store.receipt("task", run.runId, { ...receipt, observation: { ...receipt.observation, tree: "Different content" } }), { status: 409 });
  f.store.requestFinish("task", run.runId, { expectedVersion: 1, outcome: "completed", summary: "Read actual fixture", observationIds: [operationId] });
  assert.equal(f.store.requireTask("task").status, "finishing"); f.store.stopped("task", run.runId, false);
  assert.equal(f.store.requireTask("task").status, "completed"); assert.equal(f.store.requireTask("task").result!.evidence[0]!.observationId, "view");
});
test("a lost dispatched browser action remains uncertain after tab close and cannot transfer", t => {
  const f = fixture(t); f.task(); const run = f.claim(), operationId = browserOperationPrefix("task", run.runId) + "click";
  f.store.enqueue("task", run.runId, { operationId, action: { kind: "click", siteId: "fixture", snapshotId: "view", ref: "e1" } }); f.store.dispatched(operationId);
  f.store.cancel("task", 1); f.store.stopped("task", run.runId, false);
  assert.equal(f.store.requireTask("task").status, "uncertain"); assert.throws(() => f.store.requestCloud("task", 1, []), { status: 409 });
  f.store.reconcile("task", 1); assert.equal(f.store.requireTask("task").status, "failed"); assert.equal(f.store.operation(operationId)!.receipt, undefined);
});
test("encrypted snapshots bind exact site cookies, preserve unspecified SameSite, and pin pending approvals", async t => {
  const f = fixture(t), oldest = await f.upload("snapshot-3"); f.task(); f.store.requestCloud("task", 1, [oldest.snapshotId]);
  await f.upload("snapshot-2"); await f.upload("snapshot-1"); await f.snapshots.prune();
  assert(f.store.snapshot(oldest.snapshotId)); assert.equal(f.objects.size, 3);
  const authentication = await f.snapshots.authentication(oldest); assert.deepEqual(authentication.cookies.map(cookie => cookie.value), ["synthetic-private-cookie"]); assert(!Object.hasOwn(authentication.cookies[0]!, "sameSite"));
  assert([...f.objects.values()].every(bytes => !Buffer.from(bytes).toString().includes("synthetic-private-cookie")));
  await assert.rejects(f.upload("snapshot-4", [{ ...authentication.cookies[0], domain: ".unapproved.test" }]), { status: 400 });
  f.store.cancel("task", 2); await f.snapshots.prune(); assert.equal(f.store.snapshot(oldest.snapshotId), undefined); assert.equal(f.objects.size, 2);
});
test("a stopped cloud continuation retains reviewed snapshots and can select a new fixed version before approval", async t => {
  const f = fixture(t), original = await f.upload("snapshot-3"); f.task(); f.store.requestCloud("task", 1, [original.snapshotId]); f.store.approve("task", 2);
  const run = f.store.claimCloud()!.run!; f.store.ready("task", run.runId);
  f.store.requestFinish("task", run.runId, { expectedVersion: 2, outcome: "needs_input", summary: "Wait for the owner's next instruction", observationIds: [] });
  f.store.stopped("task", run.runId, false); f.store.correct("task", 2, "Continue the approved read");
  assert.equal(f.runtime.read("task").deadlineAt, null);
  await f.upload("snapshot-2"); const latest = await f.upload("snapshot-1"); await f.snapshots.prune();
  assert(f.store.snapshot(original.snapshotId));
  f.store.requestCloud("task", 3, [latest.snapshotId]); f.store.approve("task", 4);
  const next = f.store.claimCloud()!.run!;
  assert.notEqual(next.runId, run.runId); assert.equal(next.snapshots[0]!.snapshotId, latest.snapshotId);
  assert.equal(f.store.ownedRun("task", run.runId).snapshots[0]!.snapshotId, original.snapshotId);
});
test("failed original closure does not become a stop receipt or authorize reconciliation", async t => {
  const f = fixture(t); f.task(); const run = f.claim();
  const request = new Request("https://example.test/api/executor/browser/report", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "stopped", executorId: "mac", taskId: "task", runId: run.runId, stopped: false, uncertain: true }) });
  await browserExecutorRequest(request, f.runtime);
  assert.equal(f.store.requireTask("task").run!.stoppedAt, undefined); assert.equal(f.store.requireTask("task").status, "uncertain");
  assert.throws(() => f.store.reconcile("task", 1), { status: 409 });
});
test("a large reviewed task cannot hide the owner's final prohibition behind a live approval button", async t => {
  const f = fixture(t), prohibition = "Only read the requested page; do not submit any website action.";
  let task = f.task();
  for (let i = 0; i < 12; i++) task = f.store.correct(task.taskId, task.version, "x".repeat(7900) + (i === 11 ? prohibition : `Owner instruction ${i}`));
  enqueueBrowserApproval(f.runtime, task);
  const review = f.owner.deliveries(`browser-approval:${task.taskId}:${task.version}`);
  assert(review.map(delivery => delivery.text).join("").includes(prohibition));
  const final = review.at(-1)!, token = final.replyMarkup!.inline_keyboard[0]![0]!.callback_data;
  await assert.rejects(handleBrowserCallback(f.runtime, token, 100 + review.length - 1), { status: 409 });
  for (let index = 0; index < review.length; index++) { f.owner.beginDelivery(review[index]!.id); f.owner.finishDelivery(review[index]!.id, "sent", undefined, 100 + index); }
  await handleBrowserCallback(f.runtime, token, 100 + review.length - 1);
  assert.equal(f.store.requireTask(task.taskId).status, "queued");
});
test("Telegram browser approval is tied to confirmed message and current reviewed scope", async t => {
  const f = fixture(t); enqueueBrowserApproval(f.runtime, f.task());
  const delivery = f.owner.readyDeliveries()[0]!, token = delivery.replyMarkup!.inline_keyboard[0]![0]!.callback_data;
  await assert.rejects(handleBrowserCallback(f.runtime, token, 42), { status: 409 });
  f.owner.beginDelivery(delivery.id); f.owner.finishDelivery(delivery.id, "sent", undefined, 42);
  await assert.rejects(handleBrowserCallback(f.runtime, token, 43), { status: 409 });
  f.store.correct("task", 1, "Read a different section"); await assert.rejects(handleBrowserCallback(f.runtime, token, 42), { status: 409 });
  assert.equal(f.store.requireTask("task").status, "pending_approval");
});
test("executor report rejects a foreign owner without changing durable browser state", async t => {
  const f = fixture(t); f.task(); const run = f.claim();
  const request = new Request("https://example.test/api/executor/browser/report", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "stopped", executorId: "other", taskId: "task", runId: run.runId, uncertain: false }) });
  await assert.rejects(browserExecutorRequest(request, f.runtime), { status: 403 }); assert.equal(f.store.requireTask("task").status, "running");
});

for (const receipt of ["lost", "wrong"] as const) test(`${receipt} upload receipt quarantines ciphertext and survives cleanup/restart without replay`, async t => {
  const f = fixture(t), bytes = await f.prepareUpload("snapshot-1");
  f.provider.afterPut = async () => receipt;
  await assert.rejects(f.snapshots.upload("snapshot-1", bytes), { status: 503 });
  const candidate = f.store.snapshotCandidate("snapshot-1")!;
  assert.equal(candidate.status, "quarantined"); assert.equal(candidate.uncertain, true);
  assert.equal(f.store.snapshot("snapshot-1"), undefined); assert.equal(f.objects.size, 1);
  f.task(); assert.throws(() => f.store.requestCloud("task", 1, ["snapshot-1"]), { status: 404 });
  await assert.rejects(f.snapshots.upload("snapshot-1", bytes), { status: 409 });
  assert.equal(f.provider.puts, 1);
  await f.snapshots.prune(); assert.equal(f.objects.size, 0);
  // Present absence is not proof a lost provider write can never arrive later.
  assert.equal(f.store.snapshotCandidate("snapshot-1")!.uncertain, true);
  f.objects.set(candidate.key, bytes.slice());
  const recovered = new BrowserSnapshots(new BrowserStore(f.owner), () => f.bucket);
  const due = recovered.nextDue()!; assert(due > Date.now());
  await recovered.drivePrune(due);
  assert.equal(f.objects.size, 0); assert.equal(f.provider.puts, 1);
  assert(f.store.snapshotCandidate("snapshot-1")); assert.equal(f.store.snapshot("snapshot-1"), undefined);
});

test("a valid provider receipt cannot commit across a grant race, and failed DELETE retains recovery work", async t => {
  const f = fixture(t), bytes = await f.prepareUpload("snapshot-1");
  f.provider.afterPut = async () => {
    f.store.registerSite({ siteId: f.site.siteId, title: "Changed policy", origins: f.site.origins, cookieHosts: f.site.cookieHosts, cookieNames: f.site.cookieNames, resourceHosts: f.site.resourceHosts }, 1);
  };
  await assert.rejects(f.snapshots.upload("snapshot-1", bytes), { status: 409 });
  assert.equal(f.store.snapshot("snapshot-1"), undefined);
  assert.equal(f.store.snapshotCandidate("snapshot-1")!.uncertain, false);
  f.provider.beforeDelete = async () => { throw Error("Synthetic provider deletion failure"); };
  await f.snapshots.prune(); assert.equal(f.objects.size, 1);
  const due = f.snapshots.nextDue()!; assert(due > Date.now());
  f.provider.beforeDelete = undefined;
  const recovered = new BrowserSnapshots(new BrowserStore(f.owner), () => f.bucket);
  await recovered.drivePrune(due);
  assert.equal(f.objects.size, 0); assert.equal(f.store.snapshotCandidate("snapshot-1"), undefined);
  await assert.rejects(f.snapshots.upload("snapshot-1", bytes), { status: 409 });
  assert.equal(f.provider.puts, 1);
});

test("cleanup fences an interrupted admission before a late PUT receipt without claiming atomic provider absence", async t => {
  const f = fixture(t), bytes = await f.prepareUpload("snapshot-1");
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  f.provider.beforePut = async () => { entered.resolve(); await release.promise; };
  const upload = f.snapshots.upload("snapshot-1", bytes);
  const rejected = assert.rejects(upload, { status: 409 });
  await entered.promise;
  assert.equal(f.store.snapshotCandidate("snapshot-1")!.status, "uploading");
  const interrupted = new BrowserSnapshots(new BrowserStore(f.owner), () => f.bucket);
  await interrupted.prune(Date.now() + 5 * 60_000 + 1);
  assert.equal(f.objects.size, 0); assert.equal(f.store.snapshotCandidate("snapshot-1")!.uncertain, true);
  f.task(); assert.throws(() => f.store.requestCloud("task", 1, ["snapshot-1"]), { status: 404 });
  release.resolve(); await rejected;
  assert.equal(f.objects.size, 1); assert.equal(f.store.snapshot("snapshot-1"), undefined);
  // The eventual receipt proves this PUT settled, not that the earlier DELETE won.
  assert.equal(f.store.snapshotCandidate("snapshot-1")!.uncertain, false);
  await interrupted.prune(); assert.equal(f.objects.size, 0);
  assert.equal(f.store.snapshotCandidate("snapshot-1"), undefined);
  await assert.rejects(f.snapshots.upload("snapshot-1", bytes), { status: 409 }); assert.equal(f.provider.puts, 1);
});

test("offline housekeeping expires even the latest committed snapshots, independently of browser/model availability", async t => {
  const f = fixture(t), snapshot = await f.upload("snapshot-1");
  await f.snapshots.prune();
  const expiredAt = Date.parse(snapshot.expiresAt) + 1;
  assert(f.snapshots.nextDue(expiredAt)! <= expiredAt);
  const recovered = new BrowserSnapshots(new BrowserStore(f.owner), () => f.bucket);
  await recovered.drivePrune(expiredAt);
  assert.equal(f.objects.size, 0); assert.equal(f.store.snapshot(snapshot.snapshotId), undefined);
  assert.equal(f.store.snapshotCandidates().length, 0); assert.equal(recovered.nextDue(expiredAt), undefined);
  assert.equal(new BrowserSnapshots(f.store, () => undefined).nextDue(expiredAt), undefined);
});

test("expired pending, queued and uncertain owners retain their actual approved ciphertext until release", async t => {
  const f = fixture(t), snapshot = await f.upload("snapshot-3"); f.task();
  f.store.requestCloud("task", 1, [snapshot.snapshotId]);
  const expiredAt = Date.parse(snapshot.expiresAt) + 1;
  await f.snapshots.prune(expiredAt); assert.equal(f.provider.deletes, 0);
  f.store.approve("task", 2); await f.snapshots.prune(expiredAt); assert.equal(f.provider.deletes, 0);
  const run = f.store.claimCloud()!.run!; f.store.ready("task", run.runId);
  f.store.uncertain("task", "Synthetic uncertain provider ownership"); f.store.stopped("task", run.runId, true);
  await f.snapshots.prune(expiredAt); assert.equal(f.provider.deletes, 0);
  assert(f.store.snapshot(snapshot.snapshotId)); assert.equal(f.store.ownedRun("task", run.runId).snapshots[0]!.snapshotId, snapshot.snapshotId);
  f.store.reconcile("task", 2); await f.snapshots.prune(expiredAt);
  assert.equal(f.objects.size, 0); assert.equal(f.store.snapshot(snapshot.snapshotId), undefined);
});

test("pin acquisition and immutable upload replay cannot race a dispatched delete; unrelated admissions remain usable", async t => {
  const f = fixture(t), bytes = await f.prepareUpload("snapshot-3"), oldest = await f.snapshots.upload("snapshot-3", bytes);
  await f.upload("snapshot-2"); await f.upload("snapshot-1"); f.task();
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  f.provider.beforeDelete = async () => { entered.resolve(); await release.promise; };
  const cleanup = f.snapshots.prune(); await entered.promise;
  assert.equal(f.store.snapshotCandidate(oldest.snapshotId)!.status, "deleting");
  assert.throws(() => f.store.requestCloud("task", 1, [oldest.snapshotId]), { status: 404 });
  await assert.rejects(f.snapshots.authentication(oldest), { status: 409 });
  await assert.rejects(f.snapshots.upload(oldest.snapshotId, bytes), { status: 409 });
  assert.strictEqual(f.snapshots.prune(), cleanup);
  const latest = await f.upload("snapshot-0");
  assert(f.store.snapshot(latest.snapshotId)); assert.equal(f.provider.puts, 4);
  release.resolve(); await cleanup; f.provider.beforeDelete = undefined;
  await f.snapshots.prune();
  assert.equal(f.store.snapshot(oldest.snapshotId), undefined); assert.equal(f.objects.size, 2);
  assert(f.store.snapshot(latest.snapshotId)); assert.equal(f.store.snapshotCandidates().length, 0);
});

test("successful receipt replay performs no PUT, changed ciphertext fails, and historical tombstones do not exhaust live candidate admission", async t => {
  const f = fixture(t), bytes = await f.prepareUpload("snapshot-1"), original = await f.snapshots.upload("snapshot-1", bytes);
  assert.deepEqual(await f.snapshots.upload("snapshot-1", bytes), original); assert.equal(f.provider.puts, 1);
  await assert.rejects(f.upload("snapshot-1"), { status: 409 }); assert.equal(f.provider.puts, 1);
  for (let i = 2; i <= 70; i++) { await f.upload(`snapshot-${i}`); await f.snapshots.prune(); }
  assert.equal(f.provider.puts, 70); assert.equal(f.objects.size, 2); assert.equal(f.store.snapshotCandidates().length, 0);
});

test("live quarantine admission is bounded while committed offline expiry still drains in bounded batches", async t => {
  const f = fixture(t), committed = await f.upload("snapshot-0");
  f.provider.afterPut = async () => "wrong";
  for (let i = 1; i <= 64; i++) await assert.rejects(f.upload(`snapshot-${i}`), { status: 503 });
  assert.equal(f.store.snapshotCandidates().length, 64); assert.equal(f.provider.puts, 65);
  await assert.rejects(f.upload("snapshot-65"), { status: 503 });
  assert.equal(f.provider.puts, 65); assert.equal(f.store.snapshotCandidate("snapshot-65"), undefined);
  let now = Date.parse(committed.expiresAt) + 1;
  let batches = 0;
  while (f.store.snapshot(committed.snapshotId)) {
    const before = f.provider.deletes;
    await f.snapshots.drivePrune(now);
    assert(f.provider.deletes - before <= 16);
    assert(++batches <= 5);
    const due = f.snapshots.nextDue(now)!; assert(due > now); now = due;
  }
  assert.equal(f.objects.size, 0); assert.equal(f.store.snapshotCandidates().length, 64);
  assert(f.store.snapshotCandidates().every(candidate => candidate.uncertain));
});

test("idle browser housekeeping removes expired ciphertext without model authentication, tasks or another Mac upload", async t => {
  const f = fixture(t), metadata = await f.upload("snapshot-1"), tracked: Promise<unknown>[] = [];
  t.mock.method(Date, "now", () => Date.parse(metadata.expiresAt) + 1);
  const runtime = new BrowserRuntime(f.store, f.snapshots, {
    harness() { throw Error("Housekeeping must not open a browser conversation"); },
    extension() { throw Error("Housekeeping must not acquire model tools"); },
    cloud() { throw Error("Housekeeping must not acquire a browser"); },
    cloudAvailable() { return false; },
    async modelReady() { throw Error("Housekeeping must not require model authentication"); },
    async wake() {},
    track(work) { tracked.push(work); },
  });
  assert.equal(runtime.nextDue(), Date.now());
  await runtime.drive(); await Promise.all(tracked);
  assert.equal(f.store.snapshot(metadata.snapshotId), undefined);
  assert.equal(f.objects.size, 0); assert.equal(runtime.nextDue(), undefined);
});

test("a lost first upload receipt schedules cleanup even without a usable snapshot or later Mac refresh", async t => {
  const f = fixture(t), tracked: Promise<unknown>[] = [];
  f.provider.afterPut = async () => "lost";
  const runtime = new BrowserRuntime(f.store, f.snapshots, {
    harness() { throw Error("Ciphertext cleanup must not open a conversation"); },
    extension() { throw Error("Ciphertext cleanup must not acquire tools"); },
    cloud() { throw Error("Ciphertext cleanup must not acquire a browser"); },
    cloudAvailable() { return false; },
    async modelReady() { throw Error("Ciphertext cleanup must not require model authentication"); },
    async wake() { await runtime.drive(); },
    track(work) { tracked.push(work); },
  });
  const body = await f.prepareUpload("snapshot-1");
  await assert.rejects(browserSyncRequest(new Request("https://example.test/api/browser/snapshots/snapshot-1", {
    method: "POST", headers: { "content-type": "application/json", "content-length": String(body.byteLength) }, body,
  }), runtime), { status: 503 });
  await Promise.all(tracked);
  assert.equal(f.objects.size, 0);
  assert.equal(f.store.snapshot("snapshot-1"), undefined);
  assert.equal(f.store.snapshotCandidate("snapshot-1")?.uncertain, true);
  assert(runtime.nextDue()! > Date.now());
});

test("any-site eligibility needs owner opt-in and task approval before native claim or session export", t => {
  const f = fixture(t), input = { taskId: "any", prompt: "Read the public example page", sites: [{ startUrl: "https://www.example.com/" }], timeoutMs: 60_000 };
  assert.throws(() => f.store.create(input, "telegram", "owner-telegram"), { status: 403 });
  f.store.configure(1, true);
  const proposed = f.store.create(input, "telegram", "owner-telegram");
  assert.equal(proposed.sites[0]!.site.domain, "example.com");
  assert.deepEqual(f.store.snapshotRequests(), { sites: [], nextCursor: null });
  assert.equal(f.store.poll({ executorId: "all-mac", available: true, activeRunId: null, allSites: true, sites: [] }).assignment, null);
  f.store.approve(proposed.taskId, proposed.version);
  const requests = f.store.snapshotRequests();
  assert.equal(requests.sites[0]!.policyDigest, proposed.sites[0]!.site.policyDigest);
  assert.equal(f.store.poll({ executorId: "restricted-mac", available: true, activeRunId: null, sites: [] }).assignment, null);
  const assignment = f.store.poll({ executorId: "all-mac", available: true, activeRunId: null, allSites: true, sites: [] }).assignment!;
  assert.equal(assignment.sites[0]!.startUrl, "https://www.example.com/");
  assert.throws(() => f.store.requestCloud(proposed.taskId, proposed.version, []), { status: 409 });
});

test("a new website beyond sixteen known domains remains eligible while task admission stays atomic", t => {
  const f = fixture(t); f.store.configure(1, true);
  for (let i = 0; i < 16; i++) {
    const task = f.store.create({ taskId: `prior-${i}`, prompt: "Read a public page", sites: [{ startUrl: `https://example-${i}.com/` }], timeoutMs: 60_000 }, "telegram", "owner-telegram");
    f.store.cancel(task.taskId, task.version);
  }
  const task = f.store.create({ taskId: "seventeenth", prompt: "Read the next public page", sites: [{ startUrl: "https://example-16.com/" }], timeoutMs: 60_000 }, "telegram", "owner-telegram");
  f.store.approve(task.taskId, task.version);
  const assignment = f.store.poll({ executorId: "all-mac", available: true, activeRunId: null, allSites: true, sites: [] }).assignment!;
  assert.equal(assignment.sites[0]!.site.domain, "example-16.com");
  const invalid = requestedBrowserSite("https://uncommitted-example.com/");
  assert.throws(() => f.store.create({ taskId: "invalid", prompt: "Do not admit partial scope", sites: [{ startUrl: "https://uncommitted-example.com/" }, { startUrl: "https://127.0.0.1/" }], timeoutMs: 60_000 }, "telegram", "owner-telegram"));
  assert.equal(f.store.site(invalid.siteId), undefined);
  assert.equal(f.store.task("invalid"), undefined);
});

test("changing a requested policy withdraws export authority and fresh approval advances a durable cursor", t => {
  const f = fixture(t); f.task(); f.store.approve("task", 1);
  const first = f.store.snapshotRequests();
  const changed = f.store.registerSite({ siteId: f.site.siteId, title: "Changed reviewed policy", origins: f.site.origins, cookieHosts: f.site.cookieHosts, cookieNames: f.site.cookieNames, resourceHosts: [] }, 1);
  assert.deepEqual(f.store.snapshotRequests(first.nextCursor!), { sites: [], nextCursor: null });
  const next = f.task("new-policy");
  assert.deepEqual(f.store.snapshotRequests(), { sites: [], nextCursor: null });
  f.store.approve(next.taskId, next.version);
  const reopened = new BrowserStore(f.owner).snapshotRequests(first.nextCursor!);
  assert.equal(reopened.sites[0]!.policyDigest, changed.policyDigest);
  assert(reopened.nextCursor! > first.nextCursor!);
});

test("cloud offers can explicitly select no saved session without weakening claimed-owner fences", t => {
  const f = fixture(t); f.task();
  const offer = f.store.requestCloud("task", 1, []);
  assert.deepEqual(offer.selectedSnapshots, []);
  assert.equal(f.store.claimCloud(), undefined);
  f.store.approve("task", offer.version);
  const run = f.store.claimCloud()!.run!;
  assert.deepEqual(run.snapshots, []);
  assert.equal(run.target, "cloud");
  assert.throws(() => f.store.requestCloud("task", offer.version, []), { status: 409 });
});

test("domain snapshots preserve requested first-party cookies and reject neighbouring account scopes before PUT", async t => {
  const policy = requestedBrowserSite("https://www.example.com/"), f = fixture(t, policy);
  const cookie = { name: "session", value: "synthetic-domain-cookie", domain: ".login.example.com", path: "/", expires: -1, secure: true, httpOnly: true };
  await assert.rejects(f.upload("snapshot-0", [cookie]), { status: 403 });
  const task = f.store.create({ taskId: "domain-capture", prompt: "Read this requested site", sites: [{ siteId: policy.siteId, startUrl: "https://www.example.com/" }], timeoutMs: 60_000 }, "telegram", "owner-telegram");
  f.store.approve(task.taskId, task.version);
  const metadata = await f.upload("snapshot-1", [cookie]);
  assert.deepEqual((await f.snapshots.authentication(metadata)).cookies, [cookie]);
  await assert.rejects(f.upload("snapshot-2", [{ ...cookie, domain: ".example.com.other.com" }]), { status: 400 });
  assert.equal(f.provider.puts, 1);
});

test("requested export and all-site settings have distinct roles and reject malformed permission advertisements", async t => {
  const f = fixture(t), env = { UMPI_CONTROL_TOKEN: "o".repeat(32), UMPI_EXECUTOR_TOKEN: "e".repeat(32), UMPI_BROWSER_SYNC_TOKEN: "s".repeat(32) };
  for (const token of Object.values(env)) {
    const request = new Request("https://example.test/api/browser/snapshot-requests?after=0", { headers: { authorization: `Bearer ${token}` } });
    if (token === env.UMPI_BROWSER_SYNC_TOKEN) await authorize(request, env); else await assert.rejects(authorize(request, env), { status: 401 });
  }
  const changed = await browserRequest(new Request("https://example.test/api/browser/settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedVersion: 1, allSites: true }) }), f.runtime, async () => "owner-control");
  assert.equal(changed!.status, 200);
  assert.equal(f.store.settings().allSites, true);
  await assert.rejects(browserExecutorRequest(new Request("https://example.test/api/executor/browser/poll", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ executorId: "mac", available: true, activeRunId: null, allSites: [], sites: [] }) }), f.runtime));
  await assert.rejects(browserSyncRequest(new Request("https://example.test/api/browser/snapshot-requests?after=-1"), f.runtime));
});
