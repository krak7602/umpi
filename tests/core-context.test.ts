import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxProvider, fauxAssistantMessage, fauxToolCall, getCurrentSystemPrompt } from "@earendil-works/pi-ai";
import { createRegistry, defineTask, Harness, type ConversationId, type TaskId, type ToolExecutionApi, type ToolExecutionResult } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { MAX_CORE_BLOCKS, MAX_CORE_BLOCK_TEXT_LENGTH, MAX_CORE_TEXT_LENGTH, normalizeSourceText, parseCoreBlock, parseCoreContext, sourceRevision, type CoreBlock } from "../src/shared/core-context.js";
import { MAX_PENDING_MEMORY_REVIEWS, type MemoryReview } from "../src/shared/memory-review.js";
import { InputError } from "../src/shared/protocol.js";
import { CoreContextDoc, coreContextSection, coreContextTools, decideMemoryReview, proposeMemoryRestore, proposeMemoryUpdate, readCoreContext, readMemoryHistory, readMemoryReview, readMemoryReviews, readMemoryRevision, replaceCoreContext } from "../src/worker/core-context.js";
import { StateError } from "../src/worker/store.js";

const context = BACKGROUND_CONTEXT;
const HoldTask = defineTask<null, { phase: "hold" }, null>({
  name: "test.core-context-hold", version: 1, initial: () => ({ phase: "hold" }),
  phases: { async hold() { throw new Error("This unregistered task must never be scheduled"); } },
  async abort() { throw new Error("This unregistered task must never be scheduled"); },
});

async function fixture(t: TestContext, keepRecentTokens = 20_000) {
  const directory = await mkdtemp(join(tmpdir(), "umpi-core-context-"));
  const path = join(directory, "state.sqlite");
  const models = createModels();
  const faux = fauxProvider({ provider: "core-context-test", tokensPerSecond: Infinity });
  models.setProvider(faux.provider);
  const registry = createRegistry();
  registry.install({ name: "core-context", sections: [coreContextSection], tools: coreContextTools() });
  const options = { models, registry, settings: { compaction: { enabled: false, keepRecentTokens }, retry: { enabled: false } } };
  let harness = await Harness.open(await openNodeSqliteStorage(path), options, context);
  t.after(async () => { await harness.close(context); await rm(directory, { recursive: true, force: true }); });
  return {
    get harness() { return harness; }, faux, registry,
    async reopen() { await harness.close(context); harness = await Harness.open(await openNodeSqliteStorage(path), options, context); },
    async root() {
      const model = faux.getModel();
      return harness.root(context, { agent: { model: { provider: model.provider, modelId: model.id }, thinkingLevel: "off" } });
    },
  };
}

async function block(id = "preferences", text = "Use short summaries.", kind: CoreBlock["kind"] = "preferences"): Promise<CoreBlock> {
  return { id, kind, text: normalizeSourceText(text), source: { path: "Subjects/Example.md", heading: id, revision: await sourceRevision(text) }, pendingSource: false };
}

function decoded(result: ToolExecutionResult) {
  const content = result.content?.[0];
  assert.equal(result.isError, undefined);
  assert.equal(content?.type, "text");
  return parseCoreContext(JSON.parse(content && "text" in content ? content.text : "null"));
}

function decodedReview(result: ToolExecutionResult): MemoryReview {
  const content = result.content?.[0];
  assert.equal(result.isError, undefined);
  assert.equal(content?.type, "text");
  const review = JSON.parse(content && "text" in content ? content.text : "null") as MemoryReview;
  assert.equal(typeof review.id, "string");
  assert.ok(["pending", "approved", "rejected", "stale"].includes(review.status));
  return review;
}

async function taskApi(harness: Harness, conversationId: ConversationId) {
  const taskId = await harness.commit(tx => tx.createTask(HoldTask, null, { ownership: { kind: "conversation" }, conversationId }), context);
  return invocation(harness, conversationId, taskId);
}

function invocation(harness: Harness, conversationId: ConversationId, taskId: TaskId): ToolExecutionApi {
  // Direct invocation isolates crash replay while all document/task persistence remains real Pi SQLite.
  return { taskId, conversationId, commit: harness.commit.bind(harness), snapshot: harness.snapshot.bind(harness) } as ToolExecutionApi;
}

const proposalTool = coreContextTools().find(tool => tool.name === "propose_core_context_update")!;
const readTool = coreContextTools().find(tool => tool.name === "read_core_context")!;

test("initial reads do not create a document; native core survives SQLite reopen, reset, and conversation changes", async t => {
  const f = await fixture(t);
  assert.deepEqual(await readCoreContext(f.harness, context), { revision: 0, blocks: [] });
  assert.equal(await f.harness.snapshot(CoreContextDoc, context), undefined);
  const root = await f.root();
  const second = await f.harness.createConversation({ ownership: { kind: "ownerless" } }, context);
  const imported = await replaceCoreContext(f.harness, context, { expectedRevision: 0, blocks: [await block()] });
  const rootId = root.id;
  const secondId = second.id;
  await root.reset(undefined, context);
  assert.deepEqual(await readCoreContext(f.harness, context), imported);
  await f.reopen();
  assert.deepEqual(await readCoreContext(f.harness, context), imported);
  const reopened = await f.harness.conversation(secondId, context);
  assert.ok(reopened);
  await reopened.reset(undefined, context);
  for (const conversationId of [rootId, secondId]) {
    const result = await readTool.execute({}, await taskApi(f.harness, conversationId), context);
    assert.deepEqual(decoded(result), imported);
  }
});

test("replacement is CAS atomic, rejects stale writers, and no-op imports do not churn revisions", async t => {
  const f = await fixture(t);
  const selected = await block();
  const first = await replaceCoreContext(f.harness, context, { expectedRevision: 0, blocks: [selected] });
  assert.equal(first.revision, 1);
  assert.deepEqual(await replaceCoreContext(f.harness, context, { expectedRevision: 1, blocks: [selected] }), first);
  await assert.rejects(replaceCoreContext(f.harness, context, { expectedRevision: 0, blocks: [selected] }), error => error instanceof StateError && error.status === 409);
  const results = await Promise.allSettled([
    replaceCoreContext(f.harness, context, { expectedRevision: 1, blocks: [await block("preferences", "Use tables.")] }),
    replaceCoreContext(f.harness, context, { expectedRevision: 1, blocks: [await block("preferences", "Use paragraphs.")] }),
  ]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(results.filter(result => result.status === "rejected" && result.reason instanceof StateError && result.reason.status === 409).length, 1);
  assert.equal((await readCoreContext(f.harness, context)).revision, 2);
});

test("synchronized imports validate source hashes, kinds, mappings, revisions, and all bounds", async t => {
  const f = await fixture(t);
  const selected = await block();
  assert.equal(await sourceRevision(" \r\nA\r\nB\r\n "), createHash("sha256").update("A\nB").digest("hex"));
  for (const bad of [
    { ...selected, source: { ...selected.source, revision: "0".repeat(64) } },
    { ...selected, pendingSource: true },
    { ...selected, kind: "daily" },
    { ...selected, text: "x".repeat(MAX_CORE_BLOCK_TEXT_LENGTH + 1) },
    { ...selected, text: "bad\0text" },
    ...["/absolute.md", "../escape.md", "Notes/../escape.md", ".private/Note.md", "Notes//Note.md", "C:\\Note.md", "Note.txt"].map(path => ({ ...selected, source: { ...selected.source, path } })),
    { ...selected, source: { ...selected.source, heading: "Two\nheadings" } },
    { ...selected, source: { ...selected.source, revision: "F".repeat(64) } },
  ]) {
    await assert.rejects(replaceCoreContext(f.harness, context, { expectedRevision: 0, blocks: [bad] }), InputError);
  }
  for (const expectedRevision of [-1, 0.5, "0", Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(replaceCoreContext(f.harness, context, { expectedRevision, blocks: [] }), InputError);
  }
  const sixteen = await Promise.all(Array.from({ length: MAX_CORE_BLOCKS }, (_, index) => block(`block-${index}`, "x")));
  await assert.rejects(replaceCoreContext(f.harness, context, { expectedRevision: 0, blocks: [...sixteen, await block("extra")] }), InputError);
  await assert.rejects(replaceCoreContext(f.harness, context, { expectedRevision: 0, blocks: [selected, selected] }), InputError);
  await assert.rejects(replaceCoreContext(f.harness, context, { expectedRevision: 0, blocks: [selected, { ...selected, id: "other" }] }), InputError);
  const full = [await block("one", "x".repeat(MAX_CORE_BLOCK_TEXT_LENGTH)), await block("two", "y".repeat(MAX_CORE_BLOCK_TEXT_LENGTH))];
  await assert.rejects(replaceCoreContext(f.harness, context, { expectedRevision: 0, blocks: [...full, await block("three", "z")] }), InputError);
  assert.equal((await readCoreContext(f.harness, context)).revision, 0);
  assert.equal((await replaceCoreContext(f.harness, context, { expectedRevision: 0, blocks: full })).blocks.reduce((length, item) => length + item.text.length, 0), MAX_CORE_TEXT_LENGTH);
  assert.equal(parseCoreBlock({ ...selected, pendingSource: true }).pendingSource, true);
});

test("model proposals do not mutate facts; only owner approval changes one topic and queues source sync", async t => {
  const f = await fixture(t);
  const root = await f.root();
  const first = await block();
  const other = await block("background", "A fictional research project.", "background");
  const imported = await replaceCoreContext(f.harness, context, { expectedRevision: 0, blocks: [first, other] });
  assert.deepEqual(coreContextTools().map(tool => tool.name), ["read_core_context", "propose_core_context_update", "read_core_context_history"]);
  const proposed = decodedReview(await proposalTool.execute({ expectedRevision: 1, blockId: first.id, text: "Use detailed summaries.", reason: "The owner explicitly corrected this preference." }, await taskApi(f.harness, root.id), context));
  assert.equal(proposed.status, "pending");
  assert.deepEqual(proposed.before, first);
  assert.equal(proposed.conversationId, String(root.id));
  assert.deepEqual(await readCoreContext(f.harness, context), imported);
  assert.deepEqual(await readMemoryReviews(f.harness, context), [proposed]);
  assert.deepEqual((await readMemoryHistory(f.harness, context)).entries.map(entry => entry.revision), [1, 0]);
  const publications: string[][] = [];
  const stop = f.harness.subscribeCommits(publication => {
    publications.push(publication.changes.flatMap(change => change.type === "document" ? [change.record.kind] : []));
  });
  const approved = await decideMemoryReview(f.harness, context, proposed.id, "approve");
  stop();
  assert.equal(approved.status, "approved");
  assert.equal(approved.appliedRevision, 2);
  assert.ok(publications.some(kinds => ["umpi.core-context", "umpi.memory-history", "umpi.memory-review", "umpi.memory-review-index"].every(kind => kinds.includes(kind))));
  const corrected = await readCoreContext(f.harness, context);
  assert.deepEqual(corrected, { revision: 2, blocks: [{ ...first, text: proposed.afterText, pendingSource: true }, other] });
  assert.deepEqual(await decideMemoryReview(f.harness, context, proposed.id, "approve"), approved);
  await assert.rejects(decideMemoryReview(f.harness, context, proposed.id, "reject"), error => error instanceof StateError && error.status === 409);
  assert.deepEqual(await readMemoryReviews(f.harness, context), []);
  assert.deepEqual((await readMemoryRevision(f.harness, context, 2)).context, corrected);
  const missing = await proposalTool.execute({ expectedRevision: 2, blockId: "unapproved", text: "Do not promote.", reason: "Test" }, await taskApi(f.harness, root.id), context);
  assert.equal(missing.isError, true);
  const clearing = await proposeMemoryUpdate(f.harness, context, { id: "clear", expectedRevision: 2, blockId: first.id, text: "", reason: "Owner requested removal." });
  assert.deepEqual(await readCoreContext(f.harness, context), corrected);
  await decideMemoryReview(f.harness, context, clearing.id, "approve");
  assert.equal((await readCoreContext(f.harness, context)).blocks[0]?.text, "");
  const synced = await replaceCoreContext(f.harness, context, { expectedRevision: 3, blocks: [await block(first.id, ""), other] });
  assert.equal(synced.blocks[0]?.pendingSource, false);
  const syncHistory = await readMemoryRevision(f.harness, context, 4);
  assert.equal(syncHistory.source, "source_sync");
  assert.deepEqual(syncHistory.context, synced);
  const removed = await replaceCoreContext(f.harness, context, { expectedRevision: 4, blocks: [other] });
  assert.deepEqual(removed, { revision: 5, blocks: [other] });
});

test("rejection and ID replay are durable; opposing decisions and changed payloads conflict", async t => {
  const f = await fixture(t);
  const imported = await replaceCoreContext(f.harness, context, { expectedRevision: 0, blocks: [await block()] });
  const request = { id: "rejected", expectedRevision: 1, blockId: "preferences", text: "Prefer examples.", reason: "Owner request." };
  const proposed = await proposeMemoryUpdate(f.harness, context, request);
  assert.deepEqual(await proposeMemoryUpdate(f.harness, context, { ...request, text: ` ${request.text}\r\n` }), proposed);
  for (const change of [{ text: "Different." }, { reason: "Different." }, { expectedRevision: 0 }, { blockId: "other" }, { conversationId: "different" }]) {
    await assert.rejects(proposeMemoryUpdate(f.harness, context, { ...request, ...change }), error => error instanceof StateError && error.status === 409);
  }
  const rejected = await decideMemoryReview(f.harness, context, proposed.id, "reject");
  assert.equal(rejected.status, "rejected");
  assert.deepEqual(await readCoreContext(f.harness, context), imported);
  await f.reopen();
  assert.deepEqual(await readMemoryReview(f.harness, context, proposed.id), rejected);
  assert.deepEqual(await proposeMemoryUpdate(f.harness, context, request), rejected);
  assert.deepEqual(await decideMemoryReview(f.harness, context, proposed.id, "reject"), rejected);
  await assert.rejects(decideMemoryReview(f.harness, context, proposed.id, "approve"), error => error instanceof StateError && error.status === 409);
  assert.deepEqual((await readMemoryHistory(f.harness, context)).entries.map(entry => entry.revision), [1, 0]);
  await assert.rejects(readMemoryReview(f.harness, context, "absent"), error => error instanceof StateError && error.status === 404);
  await assert.rejects(decideMemoryReview(f.harness, context, "absent", "reject"), error => error instanceof StateError && error.status === 404);
});

test("native task receipt and proposal commit together; reopen/reset replay cannot restore stale facts", async t => {
  const f = await fixture(t);
  const root = await f.root();
  const imported = await replaceCoreContext(f.harness, context, { expectedRevision: 0, blocks: [await block()] });
  const api = await taskApi(f.harness, root.id);
  const publications: string[][] = [];
  const stop = f.harness.subscribeCommits(publication => {
    publications.push(publication.changes.flatMap(change => change.type === "document" ? [change.record.kind] : []));
  });
  const request = { expectedRevision: 1, blockId: "preferences", text: "Prefer examples.", reason: "Owner request." };
  const original = await proposalTool.execute(request, api, context);
  stop();
  const proposed = decodedReview(original);
  assert.equal(proposed.status, "pending");
  assert.deepEqual(await readCoreContext(f.harness, context), imported);
  assert.ok(publications.some(kinds => kinds.includes("umpi.memory-review") && kinds.includes("umpi.memory-proposal-receipt")));
  assert.equal(publications.some(kinds => kinds.includes("umpi.core-context")), false);
  await f.reopen();
  assert.deepEqual(await proposalTool.execute(request, invocation(f.harness, root.id, api.taskId), context), original);
  assert.equal((await proposalTool.execute({ ...request, text: "Changed payload." }, invocation(f.harness, root.id, api.taskId), context)).isError, true);
  await replaceCoreContext(f.harness, context, { expectedRevision: 1, blocks: [await block("preferences", "A newer explicit source edit.")] });
  const replay = decodedReview(await proposalTool.execute(request, invocation(f.harness, root.id, api.taskId), context));
  assert.equal(replay.id, proposed.id);
  assert.equal(replay.status, "stale");
  const reopened = await f.harness.conversation(root.id, context);
  assert.ok(reopened);
  await reopened.reset(undefined, context);
  await f.reopen();
  const resetReplay = await proposalTool.execute(request, invocation(f.harness, root.id, api.taskId), context);
  if (!resetReplay.isError) assert.equal(decodedReview(resetReplay).status, "stale");
  assert.equal((await readMemoryReview(f.harness, context, proposed.id)).status, "stale");
  assert.equal((await decideMemoryReview(f.harness, context, proposed.id, "approve")).status, "stale");
  assert.deepEqual(await readMemoryReviews(f.harness, context), []);
  assert.equal((await readCoreContext(f.harness, context)).revision, 2);
  assert.equal((await readCoreContext(f.harness, context)).blocks[0]?.text, "A newer explicit source edit.");
});

test("failed proposal and approval transactions leave neither partial journal nor mutation", async t => {
  const f = await fixture(t);
  const root = await f.root();
  const imported = await replaceCoreContext(f.harness, context, { expectedRevision: 0, blocks: [await block()] });
  const api = await taskApi(f.harness, root.id);
  const request = { expectedRevision: 1, blockId: "preferences", text: "A corrected preference.", reason: "Owner request." };
  const failing: ToolExecutionApi = { ...api, commit: (run, ctx) => f.harness.commit(async tx => { await run(tx); throw new Error("synthetic-private-storage-diagnostic"); }, ctx) };
  const failed = await proposalTool.execute(request, failing, context);
  assert.equal(failed.isError, true);
  assert.equal(JSON.stringify(failed).includes("synthetic-private-storage-diagnostic"), false);
  assert.deepEqual(await readCoreContext(f.harness, context), imported);
  assert.deepEqual(await readMemoryReviews(f.harness, context), []);
  const proposed = decodedReview(await proposalTool.execute(request, api, context));
  await assert.rejects(decideMemoryReview(failing, context, proposed.id, "approve"), /synthetic-private-storage-diagnostic/);
  assert.deepEqual(await readCoreContext(f.harness, context), imported);
  assert.equal((await readMemoryReview(f.harness, context, proposed.id)).status, "pending");
  await assert.rejects(readMemoryRevision(f.harness, context, 2), error => error instanceof StateError && error.status === 404);
  await f.reopen();
  assert.equal((await decideMemoryReview(f.harness, context, proposed.id, "approve")).appliedRevision, 2);
});

test("proposals enforce aggregate bounds and reject no-ops without consuming an ID or changing source state", async t => {
  const f = await fixture(t);
  const root = await f.root();
  const first = await block("one", "x".repeat(6_000));
  const second = await block("two", "y".repeat(5_999));
  const third = await block("three", "z");
  const imported = await replaceCoreContext(f.harness, context, { expectedRevision: 0, blocks: [first, second, third] });
  const request = { id: "no-op", expectedRevision: 1, blockId: "one", text: first.text, reason: "Owner request." };
  await assert.rejects(proposeMemoryUpdate(f.harness, context, request), error => error instanceof StateError && error.status === 409);
  await assert.rejects(readMemoryReview(f.harness, context, request.id), error => error instanceof StateError && error.status === 404);
  assert.equal((await proposalTool.execute({ expectedRevision: 1, blockId: "three", text: "zz", reason: "Owner request." }, await taskApi(f.harness, root.id), context)).isError, true);
  for (const change of [{ reason: "" }, { reason: " " }, { reason: "x".repeat(2_001) }, { text: "bad\0text" }, { expectedRevision: -1 }]) {
    await assert.rejects(proposeMemoryUpdate(f.harness, context, { ...request, ...change }), InputError);
  }
  assert.deepEqual(await readCoreContext(f.harness, context), imported);
  assert.deepEqual(await readMemoryReviews(f.harness, context), []);
  const replacement = await proposeMemoryUpdate(f.harness, context, { ...request, text: "Smaller." });
  assert.equal(replacement.id, request.id);
  assert.equal(replacement.status, "pending");
});

test("existing installations capture their exact baseline lazily without rewriting current context", async t => {
  const f = await fixture(t);
  const existing = { revision: 41, blocks: [{ ...await block(), text: "An existing pending correction.", pendingSource: true }] };
  await f.harness.commit(async tx => {
    const current = await tx.doc(CoreContextDoc);
    current.revision = existing.revision;
    current.blocks = existing.blocks;
  }, context);
  assert.deepEqual(await readMemoryHistory(f.harness, context), { entries: [], nextBeforeRevision: null });
  const publications: string[][] = [];
  const stop = f.harness.subscribeCommits(publication => {
    publications.push(publication.changes.flatMap(change => change.type === "document" ? [change.record.kind] : []));
  });
  const review = await proposeMemoryUpdate(f.harness, context, { id: "existing", expectedRevision: 41, blockId: "preferences", text: "The new proposed correction.", reason: "Owner request." });
  stop();
  assert.equal(publications.some(kinds => kinds.includes("umpi.core-context")), false);
  assert.deepEqual(await readCoreContext(f.harness, context), existing);
  const baseline = await readMemoryRevision(f.harness, context, 41);
  assert.equal(baseline.source, "baseline");
  assert.deepEqual(baseline.context, existing);
  assert.equal((await readMemoryHistory(f.harness, context)).nextBeforeRevision, null);
  await assert.rejects(readMemoryRevision(f.harness, context, 40), error => error instanceof StateError && error.status === 404);
  await f.reopen();
  assert.deepEqual(await readMemoryRevision(f.harness, context, 41), baseline);
  assert.deepEqual(await readMemoryReview(f.harness, context, review.id), review);
  await decideMemoryReview(f.harness, context, review.id, "approve");
  assert.deepEqual((await readMemoryHistory(f.harness, context)).entries.map(entry => entry.revision), [42, 41]);
  assert.deepEqual((await readMemoryRevision(f.harness, context, 41)).context, existing);
});

test("concurrent approvals and source synchronization persist stale losers instead of overwriting", async t => {
  const f = await fixture(t);
  const selected = await block();
  await replaceCoreContext(f.harness, context, { expectedRevision: 0, blocks: [selected] });
  const first = await proposeMemoryUpdate(f.harness, context, { id: "race-a", expectedRevision: 1, blockId: selected.id, text: "Correction A.", reason: "Owner request." });
  const second = await proposeMemoryUpdate(f.harness, context, { id: "race-b", expectedRevision: 1, blockId: selected.id, text: "Correction B.", reason: "Owner request." });
  const results = await Promise.all([
    decideMemoryReview(f.harness, context, first.id, "approve"),
    decideMemoryReview(f.harness, context, second.id, "approve"),
  ]);
  assert.deepEqual(results.map(review => review.status).sort(), ["approved", "stale"]);
  const winner = results.find(review => review.status === "approved")!;
  const stale = results.find(review => review.status === "stale")!;
  assert.equal((await readCoreContext(f.harness, context)).revision, 2);
  assert.equal((await readCoreContext(f.harness, context)).blocks[0]?.text, winner.afterText);
  await f.reopen();
  assert.equal((await readMemoryReview(f.harness, context, stale.id)).status, "stale");
  assert.deepEqual(await decideMemoryReview(f.harness, context, stale.id, "approve"), stale);
  assert.deepEqual(await readMemoryReviews(f.harness, context), []);
  const racing = await proposeMemoryUpdate(f.harness, context, { id: "race-source", expectedRevision: 2, blockId: selected.id, text: "Another correction.", reason: "Owner request." });
  const source = await block(selected.id, "Source edit wins when synchronized first.");
  const [sourceResult, decisionResult] = await Promise.allSettled([
    replaceCoreContext(f.harness, context, { expectedRevision: 2, blocks: [source] }),
    decideMemoryReview(f.harness, context, racing.id, "approve"),
  ]);
  assert.equal(decisionResult.status, "fulfilled");
  if (decisionResult.status === "fulfilled" && decisionResult.value.status === "approved") {
    assert.equal(sourceResult.status, "rejected");
    if (sourceResult.status === "rejected") assert.ok(sourceResult.reason instanceof StateError && sourceResult.reason.status === 409);
    assert.equal((await readCoreContext(f.harness, context)).blocks[0]?.text, racing.afterText);
  } else {
    assert.equal(sourceResult.status, "fulfilled");
    if (decisionResult.status === "fulfilled") assert.equal(decisionResult.value.status, "stale");
    assert.deepEqual((await readCoreContext(f.harness, context)).blocks, [source]);
  }
  assert.equal((await readCoreContext(f.harness, context)).revision, 3);
  assert.deepEqual((await readMemoryHistory(f.harness, context)).entries.map(entry => entry.revision), [3, 2, 1, 0]);
});

test("frozen before-block comparison prevents stale writes even if a legacy writer keeps the same revision", async t => {
  const f = await fixture(t);
  await replaceCoreContext(f.harness, context, { expectedRevision: 0, blocks: [await block()] });
  const proposal = await proposeMemoryUpdate(f.harness, context, { id: "frozen", expectedRevision: 1, blockId: "preferences", text: "An obsolete correction.", reason: "Owner request." });
  const changed = await block("preferences", "An external replacement.");
  await f.harness.commit(async tx => { (await tx.doc(CoreContextDoc)).blocks = [changed]; }, context);
  assert.equal((await readMemoryReview(f.harness, context, proposal.id)).status, "stale");
  assert.deepEqual(await readMemoryReviews(f.harness, context), []);
  const stale = await decideMemoryReview(f.harness, context, proposal.id, "approve");
  assert.equal(stale.status, "stale");
  assert.ok(stale.decidedAt);
  await f.reopen();
  assert.deepEqual(await readMemoryReview(f.harness, context, proposal.id), stale);
  assert.deepEqual((await readCoreContext(f.harness, context)).blocks, [changed]);
});

test("reviewed per-topic restore recovers agent-cleared text without undoing newer unrelated facts or provenance", async t => {
  const f = await fixture(t);
  const first = await block();
  const other = await block("background", "Original project.", "background");
  await replaceCoreContext(f.harness, context, { expectedRevision: 0, blocks: [first, other] });
  const clear = await proposeMemoryUpdate(f.harness, context, { id: "clear-for-restore", expectedRevision: 1, blockId: first.id, text: "", reason: "Owner requested removal." });
  await decideMemoryReview(f.harness, context, clear.id, "approve");
  const updateOther = await proposeMemoryUpdate(f.harness, context, { id: "other-newer", expectedRevision: 2, blockId: other.id, text: "Newer unrelated project.", reason: "Owner corrected the project." });
  await decideMemoryReview(f.harness, context, updateOther.id, "approve");
  const beforeRestore = await readCoreContext(f.harness, context);
  const request = { id: "restore-cleared", expectedRevision: 3, blockId: first.id, revision: 1 };
  const restore = await proposeMemoryRestore(f.harness, context, request);
  assert.equal(restore.kind, "restore");
  assert.equal(restore.restoreRevision, 1);
  assert.equal(restore.before.text, "");
  assert.equal(restore.afterText, first.text);
  assert.deepEqual(await readCoreContext(f.harness, context), beforeRestore);
  await f.reopen();
  assert.deepEqual(await proposeMemoryRestore(f.harness, context, request), restore);
  const approved = await decideMemoryReview(f.harness, context, restore.id, "approve");
  const restored = await readCoreContext(f.harness, context);
  assert.deepEqual(restored, { revision: 4, blocks: [{ ...first, pendingSource: true }, beforeRestore.blocks[1]] });
  assert.equal(approved.appliedRevision, 4);
  assert.deepEqual(await proposeMemoryRestore(f.harness, context, request), approved);
  await assert.rejects(proposeMemoryRestore(f.harness, context, { ...request, revision: 2 }), error => error instanceof StateError && error.status === 409);
  await assert.rejects(proposeMemoryRestore(f.harness, context, { ...request, id: "noop-restore", expectedRevision: 4 }), error => error instanceof StateError && error.status === 409);
  const entry = await readMemoryRevision(f.harness, context, 4);
  assert.equal(entry.source, "approved_restore");
  assert.equal(entry.reviewId, restore.id);
  assert.deepEqual(entry.context, restored);
  assert.deepEqual((await readMemoryRevision(f.harness, context, 1)).context.blocks, [first, other]);
  const firstPage = await readMemoryHistory(f.harness, context, { limit: 2 });
  assert.deepEqual(firstPage.entries.map(item => item.revision), [4, 3]);
  assert.equal(firstPage.nextBeforeRevision, 3);
  const secondPage = await readMemoryHistory(f.harness, context, { beforeRevision: firstPage.nextBeforeRevision!, limit: 2 });
  assert.deepEqual(secondPage.entries.map(item => item.revision), [2, 1]);
  assert.equal(secondPage.nextBeforeRevision, 1);
  const lastPage = await readMemoryHistory(f.harness, context, { beforeRevision: secondPage.nextBeforeRevision!, limit: 2 });
  assert.deepEqual(lastPage.entries.map(item => item.revision), [0]);
  assert.equal(lastPage.nextBeforeRevision, null);
  const synchronized = await replaceCoreContext(f.harness, context, { expectedRevision: 4, blocks: [first, await block(other.id, updateOther.afterText, other.kind)] });
  assert.ok(synchronized.blocks.every(item => !item.pendingSource));
  assert.equal((await readMemoryRevision(f.harness, context, 5)).source, "source_sync");
  assert.deepEqual(await replaceCoreContext(f.harness, context, { expectedRevision: 5, blocks: synchronized.blocks }), synchronized);
  await f.reopen();
  assert.equal((await readMemoryHistory(f.harness, context)).entries.length, 6);
  assert.deepEqual(await readMemoryRevision(f.harness, context, 4), entry);
});

test("restoration cannot recreate deleted topics or cross source mappings and kinds", async t => {
  const f = await fixture(t);
  const original = await block();
  await replaceCoreContext(f.harness, context, { expectedRevision: 0, blocks: [original] });
  await replaceCoreContext(f.harness, context, { expectedRevision: 1, blocks: [] });
  await assert.rejects(proposeMemoryRestore(f.harness, context, { id: "deleted", expectedRevision: 2, blockId: original.id, revision: 1 }), error => error instanceof StateError && error.status === 409);
  let revision = 2;
  const changed = await block(original.id, "New mapped text.");
  for (const remapped of [
    { ...changed, source: { ...changed.source, path: "Different.md" } },
    { ...changed, source: { ...changed.source, heading: "Different heading" } },
    { ...changed, kind: "background" },
  ]) {
    const current = await replaceCoreContext(f.harness, context, { expectedRevision: revision, blocks: [remapped] });
    revision = current.revision;
    await assert.rejects(proposeMemoryRestore(f.harness, context, { id: `remapped-${revision}`, expectedRevision: revision, blockId: original.id, revision: 1 }), error => error instanceof StateError && error.status === 409);
    assert.deepEqual(await readCoreContext(f.harness, context), current);
  }
  await assert.rejects(proposeMemoryRestore(f.harness, context, { id: "missing-history", expectedRevision: revision, blockId: original.id, revision: 999 }), error => error instanceof StateError && error.status === 404);
  await assert.rejects(proposeMemoryRestore(f.harness, context, { id: "missing-historical-topic", expectedRevision: revision, blockId: original.id, revision: 0 }), error => error instanceof StateError && error.status === 409);
  assert.deepEqual(await readMemoryReviews(f.harness, context), []);
});

test("pending review index is bounded without eviction and history inputs are bounded", async t => {
  const f = await fixture(t);
  await replaceCoreContext(f.harness, context, { expectedRevision: 0, blocks: [await block()] });
  const request = { id: "bounded-0", expectedRevision: 1, blockId: "preferences", text: "A proposed correction.", reason: "Owner request." };
  for (let index = 0; index < MAX_PENDING_MEMORY_REVIEWS; index++) {
    await proposeMemoryUpdate(f.harness, context, { ...request, id: `bounded-${index}` });
  }
  await assert.rejects(proposeMemoryUpdate(f.harness, context, { ...request, id: "overflow" }), error => error instanceof StateError && error.status === 409);
  assert.equal((await readMemoryReviews(f.harness, context)).length, MAX_PENDING_MEMORY_REVIEWS);
  assert.equal((await proposeMemoryUpdate(f.harness, context, request)).status, "pending");
  await decideMemoryReview(f.harness, context, request.id, "reject");
  await proposeMemoryUpdate(f.harness, context, { ...request, id: "overflow" });
  assert.equal((await readMemoryReviews(f.harness, context)).length, MAX_PENDING_MEMORY_REVIEWS);
  await replaceCoreContext(f.harness, context, { expectedRevision: 1, blocks: [await block("preferences", "A fresh source edit.")] });
  assert.deepEqual(await readMemoryReviews(f.harness, context), []);
  assert.equal((await readMemoryReview(f.harness, context, "bounded-1")).status, "stale");
  assert.equal((await readMemoryReview(f.harness, context, request.id)).status, "rejected");
  for (const options of [{ limit: 0 }, { limit: 51 }, { limit: 0.5 }, { beforeRevision: -1 }, { beforeRevision: 0.5 }]) {
    await assert.rejects(readMemoryHistory(f.harness, context, options), InputError);
  }
  assert.deepEqual(await readMemoryHistory(f.harness, context, { beforeRevision: 0 }), { entries: [], nextBeforeRevision: null });
  const root = await f.root();
  const historyTool = coreContextTools().find(tool => tool.name === "read_core_context_history")!;
  const response = await historyTool.execute({ limit: 1 }, await taskApi(f.harness, root.id), context);
  assert.equal(response.isError, undefined);
  const content = response.content?.[0];
  assert.equal(content?.type, "text");
  assert.deepEqual(JSON.parse(content && "text" in content ? content.text : "null"), await readMemoryHistory(f.harness, context, { limit: 1 }));
});

test("real Pi model round leaves prompt unchanged until owner approval and never injects history or proposals", { timeout: 15_000 }, async t => {
  const f = await fixture(t);
  let replayed = false;
  f.registry.install({
    name: "core-context", sections: [coreContextSection],
    tools: coreContextTools().map(tool => tool.name !== "propose_core_context_update" ? tool : {
      ...tool,
      async execute(args, api, ctx) {
        const first = await tool.execute(args, api, ctx);
        assert.deepEqual(await tool.execute(args, api, ctx), first);
        replayed = true;
        return first;
      },
    }),
  });
  const root = await f.root();
  const selected = await block("preferences", "Use short summaries.");
  await replaceCoreContext(f.harness, context, { expectedRevision: 0, blocks: [selected] });
  const prompts: string[] = [];
  f.faux.setResponses([
    request => {
      prompts.push(getCurrentSystemPrompt(request.messages));
      return fauxAssistantMessage(fauxToolCall("propose_core_context_update", { expectedRevision: 1, blockId: selected.id, text: "Use detailed summaries.", reason: "An explicit owner correction." }), { stopReason: "toolUse" });
    },
    request => { prompts.push(getCurrentSystemPrompt(request.messages)); return fauxAssistantMessage("The preference change awaits owner review."); },
    request => { prompts.push(getCurrentSystemPrompt(request.messages)); return fauxAssistantMessage("Acknowledged."); },
  ]);
  const submission = await root.submit({ type: "input", content: "Remember this correction: use detailed summaries rather than short summaries." }, context);
  assert.equal((await submission.wait(context)).status, "done");
  assert.match(prompts[0]!, /Use short summaries/);
  assert.match(prompts[0]!, /"revision":1/);
  assert.equal(prompts[0]!.includes(selected.source.path), false);
  assert.equal(prompts[0]!.includes(selected.source.revision), false);
  assert.equal(prompts[1], prompts[0]);
  const [proposed] = await readMemoryReviews(f.harness, context);
  assert.ok(proposed);
  assert.equal(prompts[1]!.includes(proposed.reason), false);
  assert.equal(prompts[1]!.includes(proposed.afterText), false);
  await decideMemoryReview(f.harness, context, proposed.id, "approve");
  await root.reset(undefined, context);
  assert.equal((await (await root.submit({ type: "input", content: "Continue." }, context)).wait(context)).status, "done");
  assert.match(prompts[2]!, /Use detailed summaries/);
  assert.match(prompts[2]!, /"revision":2/);
  assert.equal(prompts[2]!.includes(selected.text), false);
  await f.reopen();
  const model = f.faux.getModel();
  const second = await f.harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: { provider: model.provider, modelId: model.id }, thinkingLevel: "off" } }, context);
  f.faux.setResponses([request => { prompts.push(getCurrentSystemPrompt(request.messages)); return fauxAssistantMessage("Shared context is present."); }]);
  assert.equal((await (await second.submit({ type: "input", content: "Continue in another conversation." }, context)).wait(context)).status, "done");
  assert.equal(prompts[3], prompts[2]);
  assert.equal(replayed, true);
  assert.equal((await readCoreContext(f.harness, context)).blocks[0]?.pendingSource, true);
});

test("core context remains available when transcript compaction omits its facts", { timeout: 15_000 }, async t => {
  const f = await fixture(t, 1);
  const selected = await block("preferences", "Reserve the quiet hour for independent study.");
  await replaceCoreContext(f.harness, context, { expectedRevision: 0, blocks: [selected] });
  const root = await f.root();
  const review = await proposeMemoryUpdate(f.harness, context, { id: "survive-compaction", expectedRevision: 1, blockId: selected.id, text: "A separately reviewed quiet-hour change.", reason: "Owner request." });
  const history = await readMemoryHistory(f.harness, context);
  f.faux.setResponses([fauxAssistantMessage("First response."), fauxAssistantMessage("Second response."), fauxAssistantMessage("Third response.")]);
  for (let index = 0; index < 3; index++) {
    const submission = await root.submit({ type: "input", content: `Unrelated synthetic conversation ${index}: ${"filler ".repeat(1_000)}` }, context);
    assert.equal((await submission.wait(context)).status, "done");
  }
  f.faux.setResponses([fauxAssistantMessage("The conversation covered a synthetic exercise; no owner preferences are included in this summary.")]);
  const task = await root.compact(undefined, context);
  const settled = (await f.harness.waitForTask(task, context)).state;
  assert.equal(settled.outcome.status, "completed");
  assert.ok(settled.outcome.result.submissionId !== undefined);
  const placement = await f.harness.submission(settled.outcome.result.submissionId, context);
  assert.ok(placement);
  assert.equal((await placement.wait(context)).status, "done");
  let prompt = "";
  f.faux.setResponses([request => { prompt = getCurrentSystemPrompt(request.messages); return fauxAssistantMessage("Continued."); }]);
  assert.equal((await (await root.submit({ type: "input", content: "Continue after compaction." }, context)).wait(context)).status, "done");
  assert.ok(prompt.includes(selected.text));
  assert.equal(prompt.includes(review.afterText), false);
  assert.deepEqual(await readMemoryHistory(f.harness, context), history);
  assert.deepEqual(await readMemoryReview(f.harness, context, review.id), review);
  assert.deepEqual(await readCoreContext(f.harness, context), { revision: 1, blocks: [selected] });
  await root.reset(undefined, context);
  await f.reopen();
  assert.deepEqual(await readMemoryHistory(f.harness, context), history);
  assert.deepEqual(await readMemoryReview(f.harness, context, review.id), review);
});
