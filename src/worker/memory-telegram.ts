import type { Context } from "@earendil-works/chord";
import type { Harness } from "@earendil-works/pi-durable";
import type { CoreBlock } from "../shared/core-context.js";
import { memoryChanges, type MemoryChange, type MemoryHistoryEntry, type MemoryReview } from "../shared/memory-review.js";
import { InputError, identifier } from "../shared/protocol.js";
import { decideMemoryReview, proposeMemoryRestore, readCoreContext, readMemoryHistory, readMemoryReview, readMemoryReviews, readMemoryRevision } from "./core-context.js";
import { StateError, type ButtonBinding, type Store, type TelegramEntity, type TelegramMarkup } from "./store.js";

const PREFIX = "memory:";
const EMPTY: TelegramMarkup = { inline_keyboard: [] };
const HISTORY_PAGE_SIZE = 8;
const CHANGE_SUMMARY_CHARACTERS = 3_000;
type Action =
  | { kind: "decision"; reviewId: string; decision: "approve" | "reject" }
  | { kind: "review"; reviewId: string }
  | { kind: "history"; beforeRevision?: number }
  | { kind: "revision"; revision: number }
  | { kind: "topic"; revision: number; blockId: string }
  | { kind: "restore"; revision: number; blockId: string; expectedRevision: number };
type Button = { text: string; action: Action };
type Card = { text: string; entities: TelegramEntity[] };
type Field = readonly [label: string, value: string, literal?: boolean];
type CallbackResult = { text: string; replyMarkup: TelegramMarkup };

function initialize(store: Store): void {
  store.db.all("CREATE TABLE IF NOT EXISTS umpi_memory_telegram_cards (id TEXT PRIMARY KEY, review_id TEXT, status TEXT NOT NULL)");
  store.db.all("CREATE INDEX IF NOT EXISTS umpi_memory_telegram_pending ON umpi_memory_telegram_cards(status, review_id)");
  store.db.all("CREATE TABLE IF NOT EXISTS umpi_memory_telegram_tokens (token TEXT PRIMARY KEY, group_id TEXT NOT NULL, data TEXT NOT NULL)");
}

/** Every value is literal text. Offsets and Store's chunk clipping both use UTF-16 units. */
function card(title: string, fields: readonly Field[], note?: string): Card {
  let text = title;
  const entities: TelegramEntity[] = [{ type: "bold", offset: 0, length: title.length }];
  for (const [label, value, literal = true] of fields) {
    text += "\n\n";
    entities.push({ type: "bold", offset: text.length, length: label.length });
    text += `${label}\n`;
    if (value.length && literal) entities.push({ type: "pre", offset: text.length, length: value.length });
    text += value;
  }
  if (note) text += `\n\n${note}`;
  return { text, entities };
}

function hasCard(store: Store, groupId: string): boolean {
  return store.db.all("SELECT id FROM umpi_memory_telegram_cards WHERE id=?", groupId).length !== 0;
}

function enqueueCard(store: Store, groupId: string, content: Card, rows: Button[][], review?: MemoryReview): void {
  store.db.transaction(() => {
    if (hasCard(store, groupId)) return;
    // Bounded ledger fields keep review, overview and history cards below Store's delivery cap.
    // Fail closed rather than ever granting approval for truncated review text.
    if (content.text.length > 65_536) throw new StateError(503, "The complete memory review could not be delivered.");
    const replyMarkup: TelegramMarkup = {
      inline_keyboard: rows.map(row => row.map(button => {
        const token = `${PREFIX}${crypto.randomUUID()}`;
        store.db.all("INSERT INTO umpi_memory_telegram_tokens VALUES (?, ?, ?)", token, groupId, JSON.stringify(button.action));
        return { text: button.text, callback_data: token };
      })),
    };
    store.db.all("INSERT INTO umpi_memory_telegram_cards VALUES (?, ?, ?)", groupId, review?.id ?? null, review?.status ?? "navigation");
    store.enqueue(groupId, "telegram", content.text, replyMarkup, content.entities);
  });
}

function historyButton(): Button { return { text: "History", action: { kind: "history" } }; }
function source(block: CoreBlock): string { return `${block.source.path}\n${block.source.heading}`; }
function body(text: string): string { return text || "(Empty topic)"; }
function sameTopic(a: CoreBlock, b: CoreBlock): boolean {
  return a.id === b.id && a.kind === b.kind && a.source.path === b.source.path && a.source.heading === b.source.heading;
}
function outcome(review: MemoryReview): string {
  switch (review.status) {
    case "approved": return `Approved as memory revision ${review.appliedRevision}. Obsidian synchronization is separate; this is not confirmation of a vault write.`;
    case "rejected": return "Rejected. This proposal did not change memory or Obsidian.";
    case "stale": return "This review is out of date because memory changed. Nothing was applied from this review. Open /memory for current reviews or history.";
    case "pending": return "A new review is ready. Nothing changes until you approve its complete before-and-after card.";
  }
}

/** The changed lines, removed ones marked − and added ones +, or a plain statement when no line differs. */
function changeText(review: MemoryReview): string | undefined {
  const changes = memoryChanges(review.before.text, review.afterText);
  if (!changes) return undefined;
  if (!changes.length) return "(No line changes; only spacing differs.)";
  // A summary: the whole topic follows, so a long list of changes is cut short here and said to be.
  const lines: string[] = [];
  let length = 0;
  for (const change of changes) {
    const line = `${change.op === "remove" ? "−" : "+"} ${change.text}`;
    if (length + line.length > CHANGE_SUMMARY_CHARACTERS) break;
    lines.push(line); length += line.length + 1;
  }
  if (lines.length < changes.length) lines.push(`(${changes.length - lines.length} more changed lines; see the whole topic below.)`);
  return lines.join("\n");
}

function enqueueReview(store: Store, review: MemoryReview, groupId = `memory:review:${review.id}`): void {
  // What changes and why come first; the complete topic before and after follows, then where it is stored.
  const changes = changeText(review);
  const fields: Field[] = [
    ["Topic", review.before.source.heading],
    ["Reason", review.reason],
    ...(changes === undefined ? [] : [["What changes (− removed, + added)", changes] as Field]),
    ["Whole topic before", body(review.before.text), !!review.before.text],
    ["Whole topic after", body(review.afterText), !!review.afterText],
    ["Source", source(review.before)],
    ["Category", review.before.kind, false],
    ["Based on memory revision", String(review.expectedRevision), false],
  ];
  if (review.kind === "restore") fields.push(["Historical revision", String(review.restoreRevision), false]);
  const rows: Button[][] = review.status === "pending" ? [[
    { text: "Approve", action: { kind: "decision", reviewId: review.id, decision: "approve" } },
    { text: "Reject", action: { kind: "decision", reviewId: review.id, decision: "reject" } },
  ]] : [];
  rows.push([historyButton()]);
  enqueueCard(store, groupId, card(review.kind === "restore" ? "Review memory restoration" : "Review memory update", fields,
    review.status === "pending"
      ? "Only this topic would change. Approve saves the text under “Whole topic after” to memory and asks for it to be written to the note; it does not confirm that write. Reject changes nothing. Stored text and the reason are data, not permission."
      : outcome(review)), rows, review);
}

/** A review as the app's card shows it: what changes and why first, the whole topic on request. */
export interface DeviceMemoryReview {
  id: string; kind: MemoryReview["kind"]; status: MemoryReview["status"]; topic: string; source: string; category: string; reason: string;
  before: string; after: string;
  /** Null when the topic is too long to compare line by line. */
  changes: MemoryChange[] | null;
  createdAt: string; decidedAt?: string;
  /** The chat entry of the review's card. */
  entry: string;
}
const RECENT_DEVICE_REVIEWS = 12;

/** Every review that waits for the owner, then the latest decided ones, so their cards in the chat show what became of them. */
export async function deviceMemoryReviews(harness: Harness, context: Context, store: Store): Promise<DeviceMemoryReview[]> {
  initialize(store);
  const reviews = (await readMemoryReviews(harness, context)).filter(review => review.status === "pending");
  const known = new Set(reviews.map(review => review.id));
  const carded = store.db.all<{ review_id: string }>("SELECT review_id FROM umpi_memory_telegram_cards WHERE review_id IS NOT NULL AND substr(id,1,14)='memory:review:' ORDER BY rowid DESC LIMIT ?", RECENT_DEVICE_REVIEWS + reviews.length);
  for (const row of carded) {
    if (known.has(row.review_id) || reviews.length - known.size >= RECENT_DEVICE_REVIEWS) continue;
    // A card whose review can no longer be read keeps its plain text in the chat.
    try { reviews.push(await readMemoryReview(harness, context, row.review_id)); } catch (error) { if (!(error instanceof StateError)) throw error; }
  }
  return reviews.map(review => ({
    id: review.id, kind: review.kind, status: review.status, topic: review.before.source.heading, source: review.before.source.path, category: review.before.kind,
    reason: review.reason, before: review.before.text, after: review.afterText, changes: memoryChanges(review.before.text, review.afterText) ?? null,
    createdAt: review.createdAt, ...(review.decidedAt ? { decidedAt: review.decidedAt } : {}), entry: `umpi:memory:review:${review.id}`,
  }));
}

/** The Approve or Reject button of a review's own card, so a decision in the app runs exactly what the card's button runs. */
export function memoryDecisionButton(store: Store, reviewId: string, decision: "approve" | "reject"): { data: string; groupId: string } {
  initialize(store);
  const groupId = `memory:review:${identifier(reviewId, "memory review ID")}`;
  for (const row of store.db.all<{ token: string; data: string }>("SELECT token,data FROM umpi_memory_telegram_tokens WHERE group_id=?", groupId)) {
    const action = JSON.parse(row.data) as Action;
    if (action.kind === "decision" && action.reviewId === reviewId && action.decision === decision) return { data: row.token, groupId };
  }
  throw new StateError(409, "This memory review is no longer waiting for a decision.");
}

/** SQL is a replayable delivery projection, never the decision authority. */
function projectTerminal(store: Store, review: MemoryReview): void {
  if (review.status === "pending") return;
  store.db.transaction(() => {
    const cards = store.db.all<{ id: string }>("SELECT id FROM umpi_memory_telegram_cards WHERE review_id=? AND status='pending'", review.id);
    if (!cards.length) return;
    enqueueCard(store, `memory:outcome:${review.id}:${review.status}`, card("Memory review outcome", [
      ["Topic", review.before.source.heading], ["Source", source(review.before)], ["Outcome", outcome(review), false],
    ]), [[historyButton()]]);
    for (const item of cards) {
      for (const delivery of store.deliveries(item.id)) {
        // Already-sent markup must remain in the receipt so exact callback replays can be checked.
        // The webhook clears that keyboard on interaction; the new outcome card tells the owner now.
        if (delivery.status !== "pending" || !delivery.replyMarkup) continue;
        store.db.all("UPDATE umpi_outbox SET data=? WHERE id=? AND status='pending'", JSON.stringify({ ...delivery, replyMarkup: EMPTY }), delivery.id);
      }
    }
    store.db.all("UPDATE umpi_memory_telegram_cards SET status=? WHERE review_id=?", review.status, review.id);
  });
}

export async function reconcileMemoryTelegram(harness: Harness, context: Context, store: Store): Promise<void> {
  initialize(store);
  const pending = await readMemoryReviews(harness, context);
  for (const review of pending) {
    if (review.status === "pending") enqueueReview(store, review);
    else projectTerminal(store, review);
  }
  const projected = store.db.all<{ review_id: string }>("SELECT DISTINCT review_id FROM umpi_memory_telegram_cards WHERE status='pending'");
  const active = new Set(pending.filter(review => review.status === "pending").map(review => review.id));
  for (const row of projected) {
    if (!active.has(row.review_id)) projectTerminal(store, await readMemoryReview(harness, context, row.review_id));
  }
}

export async function enqueueMemoryOverview(harness: Harness, context: Context, store: Store, requestId: string): Promise<void> {
  initialize(store);
  const groupId = `memory:overview:${identifier(requestId, "memory request ID")}`;
  if (hasCard(store, groupId)) return;
  const reviews = (await readMemoryReviews(harness, context)).filter(review => review.status === "pending");
  const fields: Field[] = reviews.map((review, index) => [
    `Review ${index + 1} · ${review.kind === "restore" ? "restoration" : "update"}`,
    review.before.source.heading,
  ]);
  if (!reviews.length) fields.push(["Pending reviews", "None.", false]);
  const rows = reviews.map((review, index) => [{ text: `Review ${index + 1}`, action: { kind: "review" as const, reviewId: review.id } }]);
  enqueueCard(store, groupId, card("Memory", fields,
    "Open a review to receive its complete before-and-after card, including a fresh delivery if an earlier card was incomplete. History includes completed memory revisions; restoring a topic always requires a new review."), [...rows, [historyButton()]]);
}

function historySource(entry: MemoryHistoryEntry): string {
  switch (entry.source) {
    case "baseline": return "Starting snapshot";
    case "source_sync": return "Source synchronization";
    case "approved_update": return "Approved update";
    case "approved_restore": return "Approved restoration";
  }
}

async function enqueueHistory(harness: Harness, context: Context, store: Store, groupId: string, beforeRevision?: number): Promise<void> {
  if (hasCard(store, groupId)) return;
  const page = await readMemoryHistory(harness, context, { beforeRevision, limit: HISTORY_PAGE_SIZE });
  const fields: Field[] = page.entries.map(entry => [`Revision ${entry.revision}`, `${historySource(entry)}\n${entry.at}`, false]);
  if (!fields.length) fields.push(["Revisions", "No recorded revisions on this page.", false]);
  const rows: Button[][] = page.entries.map(entry => [{ text: `Revision ${entry.revision}`, action: { kind: "revision", revision: entry.revision } }]);
  const navigation: Button[] = [];
  if (page.nextBeforeRevision !== null) navigation.push({ text: "Older", action: { kind: "history", beforeRevision: page.nextBeforeRevision } });
  if (beforeRevision !== undefined) navigation.push({ text: "Latest", action: { kind: "history" } });
  if (navigation.length) rows.push(navigation);
  enqueueCard(store, groupId, card("Memory history", fields, "Choose a revision, then a topic. History is read-only; historical text cannot approve its own restoration."), rows);
}

async function enqueueRevision(harness: Harness, context: Context, store: Store, groupId: string, revision: number): Promise<void> {
  if (hasCard(store, groupId)) return;
  const entry = await readMemoryRevision(harness, context, revision);
  const fields: Field[] = [["Recorded", `${historySource(entry)}\n${entry.at}`, false],
    ...entry.context.blocks.map((block, index): Field => [`Topic ${index + 1}`, source(block)])];
  if (!entry.context.blocks.length) fields.push(["Topics", "This revision contains no selected topics.", false]);
  const rows: Button[][] = entry.context.blocks.map((block, index) => [{ text: `Topic ${index + 1}`, action: { kind: "topic", revision, blockId: block.id } }]);
  rows.push([historyButton()]);
  enqueueCard(store, groupId, card(`Memory revision ${revision}`, fields, "Select a topic to read its full historical text. Only that topic can be proposed for restoration."), rows);
}

async function enqueueTopic(harness: Harness, context: Context, store: Store, groupId: string, revision: number, blockId: string): Promise<void> {
  if (hasCard(store, groupId)) return;
  const historical = await readMemoryRevision(harness, context, revision);
  const block = historical.context.blocks.find(item => item.id === blockId);
  if (!block) throw new StateError(404, "This historical topic is unavailable.");
  const current = await readCoreContext(harness, context);
  const active = current.blocks.find(item => item.id === blockId);
  const restorable = active && sameTopic(active, block) && active.text !== block.text;
  const rows: Button[][] = [];
  if (restorable) rows.push([{ text: "Review restore", action: { kind: "restore", revision, blockId, expectedRevision: current.revision } }]);
  rows.push([{ text: "Topics", action: { kind: "revision", revision } }, historyButton()]);
  const note = restorable
    ? "Review restore creates a new before-and-after proposal against the current memory revision. It does not change memory. You must approve that separate review. Other topics stay untouched."
    : active && sameTopic(active, block)
      ? "This topic already has the same text. There is nothing to restore."
      : "This topic is no longer selected with the same source mapping and category. Restore its selection in the owner-edited Obsidian source instead; history cannot recreate or remap it.";
  enqueueCard(store, groupId, card(`Historical topic · revision ${revision}`, [
    ["Topic", block.source.heading], ["Source", source(block)], ["Category", block.kind, false],
    ["Historical text", body(block.text), !!block.text],
  ], note), rows);
}

/** The action of a button on its own message: a complete, confirmed Telegram message, or the app's chat entry, which holds the whole card. */
function boundAction(store: Store, token: string, binding: ButtonBinding): Action {
  if (!/^memory:[0-9a-f-]{36}$/.test(token) || (typeof binding === "number" && (!Number.isSafeInteger(binding) || binding < 1))) throw new StateError(400, "Invalid memory button.");
  const row = store.db.all<{ group_id: string; data: string }>("SELECT group_id,data FROM umpi_memory_telegram_tokens WHERE token=?", token)[0];
  if (!row) throw new StateError(409, "This memory button is no longer available.");
  if (!store.buttonShown(row.group_id, token, binding, true)) throw new StateError(409, "This memory button requires its complete, confirmed review message.");
  return JSON.parse(row.data) as Action;
}

export async function handleMemoryTelegramCallback(harness: Harness, context: Context, store: Store, data: string, binding: ButtonBinding): Promise<CallbackResult | undefined> {
  if (!data.startsWith(PREFIX)) return undefined;
  initialize(store);
  const action = boundAction(store, data, binding);
  const groupId = `memory:view:${data.slice(PREFIX.length)}`;
  try {
    switch (action.kind) {
      case "decision": {
        const existing = await readMemoryReview(harness, context, action.reviewId);
        const review = existing.status === "stale" ? existing : await decideMemoryReview(harness, context, action.reviewId, action.decision);
        projectTerminal(store, review);
        return { text: outcome(review), replyMarkup: EMPTY };
      }
      case "review": {
        const review = await readMemoryReview(harness, context, action.reviewId);
        enqueueReview(store, review, groupId);
        projectTerminal(store, review);
        return { text: review.status === "pending" ? "Complete review queued." : outcome(review), replyMarkup: EMPTY };
      }
      case "history":
        await enqueueHistory(harness, context, store, groupId, action.beforeRevision);
        return { text: "Memory history queued.", replyMarkup: EMPTY };
      case "revision":
        await enqueueRevision(harness, context, store, groupId, action.revision);
        return { text: "Historical topics queued.", replyMarkup: EMPTY };
      case "topic":
        await enqueueTopic(harness, context, store, groupId, action.revision, action.blockId);
        return { text: "Historical topic queued.", replyMarkup: EMPTY };
      case "restore": {
        // Never consume the token before Pi commits. Replay repeats precisely the same payload,
        // including the preview-time revision, even after that proposal was approved elsewhere.
        const review = await proposeMemoryRestore(harness, context, {
          id: `telegram-restore:${data.slice(PREFIX.length)}`,
          expectedRevision: action.expectedRevision, blockId: action.blockId, revision: action.revision,
        });
        enqueueReview(store, review);
        projectTerminal(store, review);
        return { text: outcome(review), replyMarkup: EMPTY };
      }
    }
    throw new StateError(409, "This memory button is no longer available.");
  } catch (error) {
    // Only a correctly bound callback reaches this point. Unknown failures remain retryable:
    // SQL and Pi are independent stores, so a Pi commit may already have succeeded.
    if (error instanceof InputError || error instanceof StateError && error.status < 500) return { text: error.message, replyMarkup: EMPTY };
    throw new StateError(503, "Memory review could not be completed. Try this button again or open /memory.");
  }
}
