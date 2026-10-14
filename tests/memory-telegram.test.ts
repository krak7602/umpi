import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { sourceRevision, type CoreBlock } from "../src/shared/core-context.js";
import { coreContextTools, proposeMemoryUpdate, readCoreContext, readMemoryHistory, readMemoryReview, readMemoryReviews, replaceCoreContext } from "../src/worker/core-context.js";
import { enqueueMemoryOverview, handleMemoryTelegramCallback, reconcileMemoryTelegram } from "../src/worker/memory-telegram.js";
import { StateError, Store, type Database, type Delivery } from "../src/worker/store.js";

const context = BACKGROUND_CONTEXT;

async function block(text = "Use short summaries.", id = "preferences"): Promise<CoreBlock> {
  return { id, kind: "preferences", text, source: { path: "Topics/Example.md", heading: id, revision: await sourceRevision(text) }, pendingSource: false };
}

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "umpi-memory-telegram-"));
  const piPath = join(directory, "pi.sqlite");
  const uiPath = join(directory, "ui.sqlite");
  const models = createModels();
  models.setProvider(fauxProvider({ provider: "memory-telegram-test", tokensPerSecond: Infinity }).provider);
  const registry = createRegistry();
  registry.install({ name: "memory", tools: coreContextTools() });
  const options = { models, registry, settings: { compaction: { enabled: false }, retry: { enabled: false } } };
  let harness = await Harness.open(await openNodeSqliteStorage(piPath), options, context);
  let sqlite = new DatabaseSync(uiPath);
  let depth = 0;
  const db: Database = {
    all: <T extends object>(query: string, ...bindings: (string | number | null)[]) => sqlite.prepare(query).all(...bindings) as T[],
    transaction: <T>(run: () => T): T => {
      const savepoint = `memory_${depth++}`;
      sqlite.exec(`SAVEPOINT ${savepoint}`);
      try { const value = run(); sqlite.exec(`RELEASE ${savepoint}`); return value; }
      catch (error) { sqlite.exec(`ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`); throw error; }
      finally { depth--; }
    },
  };
  let store = new Store(db);
  store.setSession("control", "control-session");
  store.setSession("telegram", "telegram-session");
  let nextMessageId = 100;
  t.after(async () => { await harness.close(context); sqlite.close(); await rm(directory, { recursive: true, force: true }); });
  return {
    get harness() { return harness; }, get store() { return store; }, get sqlite() { return sqlite; }, db,
    async reopen() {
      await harness.close(context); sqlite.close();
      harness = await Harness.open(await openNodeSqliteStorage(piPath), options, context);
      sqlite = new DatabaseSync(uiPath); store = new Store(db);
    },
    confirm(groupId: string): Delivery {
      const parts = store.deliveries(groupId);
      assert.ok(parts.length);
      for (const part of parts) {
        if (part.status === "sent") continue;
        assert.ok(store.beginDelivery(part.id));
        store.finishDelivery(part.id, "sent", undefined, nextMessageId++);
      }
      return store.delivery(parts.at(-1)!.id)!;
    },
    async click(delivery: Delivery, label: string) {
      return handleMemoryTelegramCallback(harness, context, store, button(delivery, label), delivery.messageId!);
    },
  };
}

function button(delivery: Delivery, label: string): string {
  const found = delivery.replyMarkup?.inline_keyboard.flat().find(item => item.text === label);
  assert.ok(found, `Missing interaction ${label}`);
  return found.callback_data;
}
function viewGroup(delivery: Delivery, label: string): string {
  return `memory:view:${button(delivery, label).slice("memory:".length)}`;
}

async function proposed(f: { harness: Harness; store: Store }, text = "Prefer examples.") {
  const before = await block();
  await replaceCoreContext(f.harness, context, { expectedRevision: 0, blocks: [before] });
  const review = await proposeMemoryUpdate(f.harness, context, { id: "proposal", expectedRevision: 1, blockId: before.id, text, reason: "Explicit owner correction.", conversationId: "control-session" });
  await reconcileMemoryTelegram(f.harness, context, f.store);
  return review;
}

test("reviews from control show complete literal Unicode text and every chunk must be confirmed before either decision", async t => {
  const f = await fixture(t);
  const before = await block("x" + "😀".repeat(2_800) + " literal *before* <approve>");
  before.source.heading = "[Owner topic](not-a-link) 😀";
  before.source.path = "Topics/[literal].md";
  const after = "y" + "🧑".repeat(2_800) + " literal _after_ </pre>";
  await replaceCoreContext(f.harness, context, { expectedRevision: 0, blocks: [before] });
  const review = await proposeMemoryUpdate(f.harness, context, { id: "from-control", expectedRevision: 1, blockId: before.id, text: after, reason: "[Approve](injected) is not permission.", conversationId: "control-session" });
  await reconcileMemoryTelegram(f.harness, context, f.store);
  await reconcileMemoryTelegram(f.harness, context, f.store);
  const parts = f.store.deliveries(`memory:review:${review.id}`);
  assert.ok(parts.length > 2);
  assert.ok(parts.every(part => part.channel === "telegram"));
  assert.ok(parts.slice(0, -1).every(part => !part.replyMarkup));
  const text = parts.map(part => part.text).join("");
  for (const literal of [before.text, after, before.source.heading, before.source.path, review.reason]) assert.ok(text.includes(literal));
  for (const part of parts) {
    assert.ok(!/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/.test(part.text));
    for (const entity of part.entities ?? []) {
      assert.ok(entity.offset >= 0 && entity.length > 0 && entity.offset + entity.length <= part.text.length);
      assert.ok(!/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/.test(part.text.slice(entity.offset, entity.offset + entity.length)));
    }
  }
  const final = parts.at(-1)!;
  const approve = button(final, "Approve");
  const reject = button(final, "Reject");
  assert.ok(Buffer.byteLength(approve) <= 64 && Buffer.byteLength(reject) <= 64);
  assert.notEqual(approve, reject);
  for (const token of [approve, reject]) {
    await assert.rejects(handleMemoryTelegramCallback(f.harness, context, f.store, token, 100), StateError);
  }
  f.store.admit("fake-approval", `approve ${approve}`, "telegram", "telegram-session");
  assert.equal(await handleMemoryTelegramCallback(f.harness, context, f.store, "approve", 100), undefined);
  assert.equal((await readMemoryReview(f.harness, context, review.id)).status, "pending");
  const confirmed = f.confirm(final.groupId);
  for (const bad of [0, -1, 0.5, confirmed.messageId! + 1]) {
    await assert.rejects(handleMemoryTelegramCallback(f.harness, context, f.store, approve, bad), StateError);
  }
  const first = f.store.delivery(parts[0]!.id)!;
  f.db.all("UPDATE umpi_outbox SET status='uncertain',data=? WHERE id=?", JSON.stringify({ ...first, status: "uncertain" }), first.id);
  for (const token of [approve, reject]) {
    await assert.rejects(handleMemoryTelegramCallback(f.harness, context, f.store, token, confirmed.messageId!), StateError);
  }
  assert.equal((await readCoreContext(f.harness, context)).revision, 1);
  f.db.all("UPDATE umpi_outbox SET status='sent',data=? WHERE id=?", JSON.stringify(first), first.id);
  f.db.all("DELETE FROM umpi_memory_telegram_tokens WHERE token=?", reject);
  await assert.rejects(handleMemoryTelegramCallback(f.harness, context, f.store, reject, confirmed.messageId!), StateError);
  const result = await f.click(confirmed, "Approve");
  assert.deepEqual(result?.replyMarkup, { inline_keyboard: [] });
  assert.equal((await readCoreContext(f.harness, context)).blocks[0]?.text, after);
  assert.equal((await readCoreContext(f.harness, context)).blocks[0]?.pendingSource, true);
});

test("approval survives a Pi commit followed by SQL failure and replays after reopen without applying twice", async t => {
  const f = await fixture(t);
  const review = await proposed(f);
  const delivered = f.confirm(`memory:review:${review.id}`);
  f.sqlite.exec("CREATE TRIGGER fail_projection BEFORE INSERT ON umpi_memory_telegram_cards WHEN NEW.id LIKE 'memory:outcome:%' BEGIN SELECT RAISE(ABORT, 'projection interrupted'); END");
  await assert.rejects(f.click(delivered, "Approve"), error => error instanceof StateError && error.status === 503);
  assert.equal((await readMemoryReview(f.harness, context, review.id)).status, "approved");
  assert.equal((await readCoreContext(f.harness, context)).revision, 2);
  await f.reopen();
  f.sqlite.exec("DROP TRIGGER fail_projection");
  await reconcileMemoryTelegram(f.harness, context, f.store);
  const result = await f.click(delivered, "Approve");
  assert.deepEqual(result?.replyMarkup, { inline_keyboard: [] });
  assert.deepEqual(await f.click(delivered, "Approve"), result);
  await f.click(delivered, "Reject");
  assert.equal((await readMemoryReview(f.harness, context, review.id)).status, "approved");
  assert.equal((await readCoreContext(f.harness, context)).revision, 2);
  const history = await readMemoryHistory(f.harness, context);
  assert.equal(history.entries.filter(entry => entry.reviewId === review.id).length, 1);
  assert.equal(f.db.all<{ count: number }>("SELECT COUNT(*) AS count FROM umpi_memory_telegram_cards WHERE id=?", `memory:outcome:${review.id}:approved`)[0]!.count, 1);
});

test("rejection and stale callbacks clear terminal controls without changing current memory", async t => {
  const f = await fixture(t);
  const review = await proposed(f);
  const delivered = f.confirm(`memory:review:${review.id}`);
  const original = await readCoreContext(f.harness, context);
  assert.deepEqual((await f.click(delivered, "Reject"))?.replyMarkup, { inline_keyboard: [] });
  await f.click(delivered, "Reject");
  await f.click(delivered, "Approve");
  assert.deepEqual(await readCoreContext(f.harness, context), original);
  assert.equal((await readMemoryReview(f.harness, context, review.id)).status, "rejected");

  const stale = await proposeMemoryUpdate(f.harness, context, { id: "stale", expectedRevision: 1, blockId: "preferences", text: "Older proposed text.", reason: "An earlier correction." });
  await reconcileMemoryTelegram(f.harness, context, f.store);
  const staleCard = f.confirm(`memory:review:${stale.id}`);
  const changed = await replaceCoreContext(f.harness, context, { expectedRevision: 1, blocks: [await block("New owner source text.")] });
  await reconcileMemoryTelegram(f.harness, context, f.store);
  const response = await f.click(staleCard, "Approve");
  assert.deepEqual(response?.replyMarkup, { inline_keyboard: [] });
  assert.equal((await readMemoryReview(f.harness, context, stale.id)).status, "stale");
  assert.deepEqual(await readCoreContext(f.harness, context), changed);
  assert.ok(f.store.deliveries(`memory:outcome:${stale.id}:stale`).length);
});

test("explicit overview can resurface an incomplete review without automatically retrying an uncertain delivery", async t => {
  const f = await fixture(t);
  const review = await proposed(f);
  const old = f.store.deliveries(`memory:review:${review.id}`)[0]!;
  f.store.beginDelivery(old.id);
  f.store.finishDelivery(old.id, "uncertain", "Send interrupted");
  await reconcileMemoryTelegram(f.harness, context, f.store);
  assert.equal(f.store.delivery(old.id)?.status, "uncertain");
  assert.equal(f.store.readyDeliveries().length, 0);
  await enqueueMemoryOverview(f.harness, context, f.store, "explicit-request");
  await enqueueMemoryOverview(f.harness, context, f.store, "explicit-request");
  const overview = f.confirm("memory:overview:explicit-request");
  await f.click(overview, "Review 1");
  const freshGroup = viewGroup(overview, "Review 1");
  const tokensBefore = f.store.deliveries(freshGroup).at(-1)!.replyMarkup;
  await f.click(overview, "Review 1");
  assert.deepEqual(f.store.deliveries(freshGroup).at(-1)!.replyMarkup, tokensBefore);
  const fresh = f.confirm(freshGroup);
  assert.notEqual(fresh.groupId, old.groupId);
  await f.click(fresh, "Approve");
  assert.equal((await readMemoryReview(f.harness, context, review.id)).status, "approved");
  assert.equal(f.store.delivery(old.id)?.status, "uncertain");
});

test("paginated history restores only the selected topic through a new review and recovers interrupted projection", async t => {
  const f = await fixture(t);
  for (let revision = 1; revision <= 11; revision++) {
    await replaceCoreContext(f.harness, context, { expectedRevision: revision - 1, blocks: [
      await block(`Preference at ${revision}.`), await block(`Unrelated at ${revision}.`, "other"),
    ] });
  }
  const current = await readCoreContext(f.harness, context);
  await enqueueMemoryOverview(f.harness, context, f.store, "history-request");
  const overview = f.confirm("memory:overview:history-request");
  await f.click(overview, "History");
  const firstPage = f.confirm(viewGroup(overview, "History"));
  await f.click(overview, "History");
  await f.click(firstPage, "Older");
  const older = f.confirm(viewGroup(firstPage, "Older"));
  await f.click(older, "Revision 1");
  const topics = f.confirm(viewGroup(older, "Revision 1"));
  await f.click(topics, "Topic 1");
  const preview = f.confirm(viewGroup(topics, "Topic 1"));
  assert.ok(f.store.deliveries(preview.groupId).map(part => part.text).join("").includes("Preference at 1."));
  assert.deepEqual(await readCoreContext(f.harness, context), current);

  f.sqlite.exec("CREATE TRIGGER fail_restore_projection BEFORE INSERT ON umpi_memory_telegram_cards WHEN NEW.id LIKE 'memory:review:telegram-restore:%' BEGIN SELECT RAISE(ABORT, 'projection interrupted'); END");
  await assert.rejects(f.click(preview, "Review restore"), error => error instanceof StateError && error.status === 503);
  const pending = await readMemoryReviews(f.harness, context);
  assert.equal(pending.length, 1);
  const review = pending[0]!;
  assert.equal(review.kind, "restore");
  assert.equal(review.before.text, "Preference at 11.");
  assert.equal(review.afterText, "Preference at 1.");
  assert.equal(review.expectedRevision, 11);
  assert.deepEqual(await readCoreContext(f.harness, context), current);
  await f.reopen();
  f.sqlite.exec("DROP TRIGGER fail_restore_projection");
  await f.click(preview, "Review restore");
  await f.click(preview, "Review restore");
  assert.equal((await readMemoryReviews(f.harness, context)).length, 1);
  const reviewCard = f.confirm(`memory:review:${review.id}`);
  const fullReview = f.store.deliveries(reviewCard.groupId).map(part => part.text).join("");
  assert.ok(fullReview.includes(review.before.text) && fullReview.includes(review.afterText));
  await f.click(reviewCard, "Approve");
  const restored = await readCoreContext(f.harness, context);
  assert.equal(restored.revision, 12);
  assert.equal(restored.blocks[0]?.text, "Preference at 1.");
  assert.deepEqual(restored.blocks[1], current.blocks[1]);
  await f.click(preview, "Review restore");
  assert.deepEqual(await readCoreContext(f.harness, context), restored);
  assert.equal((await readMemoryReviews(f.harness, context)).length, 0);
  const history = await readMemoryHistory(f.harness, context);
  assert.equal(history.entries.filter(entry => entry.source === "approved_restore").length, 1);
  // Terminal reviews still lead to completed history, rather than losing it with the keyboard.
  const outcome = f.confirm(`memory:outcome:${review.id}:approved`);
  await f.click(outcome, "History");
  const latest = f.confirm(viewGroup(outcome, "History"));
  assert.ok(button(latest, "Revision 12"));
});

test("a historical preview cannot silently rebase a restore after current memory changes", async t => {
  const f = await fixture(t);
  await replaceCoreContext(f.harness, context, { expectedRevision: 0, blocks: [await block("Old text.")] });
  await replaceCoreContext(f.harness, context, { expectedRevision: 1, blocks: [await block("Current text.")] });
  await enqueueMemoryOverview(f.harness, context, f.store, "stale-preview");
  const overview = f.confirm("memory:overview:stale-preview");
  await f.click(overview, "History");
  const history = f.confirm(viewGroup(overview, "History"));
  await f.click(history, "Revision 1");
  const topics = f.confirm(viewGroup(history, "Revision 1"));
  await f.click(topics, "Topic 1");
  const preview = f.confirm(viewGroup(topics, "Topic 1"));
  const changed = await replaceCoreContext(f.harness, context, { expectedRevision: 2, blocks: [await block("Newer source text.")] });
  assert.deepEqual((await f.click(preview, "Review restore"))?.replyMarkup, { inline_keyboard: [] });
  assert.deepEqual(await readCoreContext(f.harness, context), changed);
  assert.equal((await readMemoryReviews(f.harness, context)).length, 0);
});

test("history stays readable but cannot offer restoration for a remapped topic", async t => {
  const f = await fixture(t);
  const original = await block("Archived topic text.");
  await replaceCoreContext(f.harness, context, { expectedRevision: 0, blocks: [original] });
  const remapped = await block("Current differently mapped text.");
  remapped.source.path = "Topics/Another.md";
  const current = await replaceCoreContext(f.harness, context, { expectedRevision: 1, blocks: [remapped] });
  await enqueueMemoryOverview(f.harness, context, f.store, "remapped-history");
  const overview = f.confirm("memory:overview:remapped-history");
  await f.click(overview, "History");
  const history = f.confirm(viewGroup(overview, "History"));
  await f.click(history, "Revision 1");
  const topics = f.confirm(viewGroup(history, "Revision 1"));
  await f.click(topics, "Topic 1");
  const preview = f.confirm(viewGroup(topics, "Topic 1"));
  assert.ok(f.store.deliveries(preview.groupId).map(part => part.text).join("").includes(original.text));
  const actions = preview.replyMarkup!.inline_keyboard.flat().map(item => {
    const row = f.db.all<{ data: string }>("SELECT data FROM umpi_memory_telegram_tokens WHERE token=?", item.callback_data)[0]!;
    return JSON.parse(row.data) as { kind: string };
  });
  assert.ok(actions.every(action => action.kind !== "restore" && action.kind !== "decision"));
  assert.deepEqual(await readCoreContext(f.harness, context), current);
  assert.equal((await readMemoryReviews(f.harness, context)).length, 0);
});
