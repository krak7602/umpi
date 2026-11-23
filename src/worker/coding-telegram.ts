import type { CodingRuntime } from "./coding-runtime.js";
import type { CodingTask } from "./coding-store.js";
import { StateError, type ButtonBinding, type TelegramEntity, type TelegramMarkup } from "./store.js";

type CodingButton = { groupId: string; taskId: string; version: number; status: CodingTask["status"]; action: "approve" | "cancel" | "view" };
export interface CodingCallbackResult { text: string; removeKeyboard: boolean }
const cancellable: Record<string, true> = { pending_approval: true, queued: true, preparing: true, running: true, finishing: true };
/** The outbox's largest text budget. A review is posted whole or not at all. */
const MAX_CODING_REVIEW_CHARACTERS = 524_288;

function buttons(runtime: CodingRuntime): void {
  runtime.store.owner.db.all("CREATE TABLE IF NOT EXISTS umpi_coding_buttons (token TEXT PRIMARY KEY,data TEXT NOT NULL)");
}
function button(runtime: CodingRuntime, text: string, value: CodingButton) {
  const token = `cod:${crypto.randomUUID()}`;
  runtime.store.owner.db.all("INSERT INTO umpi_coding_buttons VALUES (?,?)", token, JSON.stringify(value));
  return { text, callback_data: token };
}
function excerpt(text: string, limit: number): string {
  const clean = text.replace(/[\s\u0000-\u001f\u007f]+/g, " ").trim();
  if (clean.length <= limit) return clean;
  let end = limit - 1;
  if (/[\uD800-\uDBFF]/.test(clean[end - 1]!)) end--;
  return clean.slice(0, end) + "…";
}
function card(runtime: CodingRuntime, task: CodingTask): { text: string; entities: TelegramEntity[] } {
  const pending = task.status === "pending_approval";
  const title = pending ? task.target === "mac" ? "Code on your Mac?" : "Code in the bounded cloud?" : `Coding · ${task.status.replaceAll("_", " ")}`;
  const prompt = task.prompt + (task.corrections.length ? `\n\nOwner corrections, in order\n${task.corrections.join("\n\n")}` : "");
  const beforeFolder = `${title}\n\n${prompt}\n\nFolder\n`;
  const duration = `${Math.ceil(task.timeoutMs / 1_000)}s limit`;
  const source = task.sourceId ? runtime.store.source(task.sourceId) : undefined;
  const scope = task.target === "mac" ? `${duration} · Native tools, not a filesystem sandbox.\nRuns in a private source copy, including your current uncommitted source. Returns a patch; no automatic changes or Git operations in the original repository.\nStops owned foreground commands and process groups; deliberately detached services and external effects are not contained or rolled back.`
    : `${duration} · Isolated Linux snapshot, not your live Mac.\nSnapshot: ${source?.sourceId ?? "unavailable"}\nCaptured: ${source?.capturedAt ?? "unavailable"}\nSHA-256: ${source?.digest ?? "unavailable"}\n¼ CPU · 1 GiB RAM · 4 GB disk · one runner.\nBeyond-allowance compute ≤ $0.028008/hour; Workers, storage and egress excluded.\nPublic dependency internet; no model, vault or account credentials. No commit, push, deployment or automatic patch application.`;
  const folderOffset = beforeFolder.length, nameOffset = task.cwd.lastIndexOf("/") + 1;
  return { text: `${beforeFolder}${task.cwd}\n${scope}${task.issue ? `\n\n${task.issue}` : ""}`, entities: [
    { type: "bold", offset: 0, length: title.length },
    { type: "blockquote", offset: folderOffset, length: task.cwd.length },
    { type: "bold", offset: folderOffset + nameOffset, length: task.cwd.length - nameOffset },
  ] };
}
function enqueueCard(runtime: CodingRuntime, task: CodingTask, groupId: string, channel = task.channel): void {
  const owner = runtime.store.owner;
  owner.effect(groupId, () => {
    const view = card(runtime, task), row: TelegramMarkup["inline_keyboard"][number] = [];
    // The default budget would cut a long task after 65,536 characters and still post Approve under the rest.
    if (view.text.length > MAX_CODING_REVIEW_CHARACTERS) throw new StateError(413, "Coding review exceeds its complete-text budget; no partial approval is posted");
    const identity = { groupId, taskId: task.taskId, version: task.version, status: task.status };
    if (channel === "telegram") {
      if (task.status === "pending_approval") row.push(button(runtime, "Approve", { ...identity, action: "approve" }));
      if (cancellable[task.status]) row.push(button(runtime, "Cancel", { ...identity, action: "cancel" }));
    }
    owner.enqueue(groupId, channel, view.text, row.length ? { inline_keyboard: [row] } : undefined, view.entities, view.text.length);
    return { posted: true };
  });
}

/**
 * Called after a correction, in its mutation transaction. A correction to a claimed run joins it without a new
 * approval card, and the model wrote its text. So the owner gets the whole text at once, as a notice.
 */
export function enqueueCodingCorrection(runtime: CodingRuntime, task: CodingTask): void {
  const correction = task.corrections.at(-1);
  if (correction === undefined || (task.status !== "preparing" && task.status !== "running")) return;
  const title = "Coding · correction sent to the approved task";
  const text = `${title}\n\n${correction}\n\nFolder\n${task.cwd}\nThis text joined the approved task without a new approval. The task keeps its folder, tools and time limit. To stop it, open /code.`;
  runtime.store.owner.enqueue(`coding-correction:${task.taskId}:${task.version}`, task.channel, text, undefined, [{ type: "bold", offset: 0, length: title.length }], text.length);
}

/** Called after owner proposals/corrections, inside their mutation transaction where possible. */
export function enqueueCodingApproval(runtime: CodingRuntime, task: CodingTask): void {
  buttons(runtime);
  const owner = runtime.store.owner, prefix = `coding-approval:${task.taskId}:`, groupId = `${prefix}${task.version}`;
  for (const group of owner.pendingDeliveryGroups(prefix)) if (task.status !== "pending_approval" || group !== groupId) owner.discardDeliveryGroup(group, "Coding approval changed; open /code for current controls");
  if (task.status === "pending_approval") enqueueCard(runtime, task, groupId);
}

/** Explicit owner overview can create a fresh card without resending an uncertain delivery. */
export function enqueueCodingControls(runtime: CodingRuntime, requestId: string): void {
  buttons(runtime);
  const owner = runtime.store.owner, groupId = `coding-menu:${requestId}`;
  owner.effect(groupId, () => {
    const tasks = runtime.store.tasks(), shown = tasks.slice(0, 6);
    const rows = shown.map((task, index) => `${index + 1}. ${task.status.replaceAll("_", " ")} · ${task.target}\n${excerpt(task.prompt, 180)}\n${excerpt(task.cwd, 160)}`);
    const markup: TelegramMarkup = { inline_keyboard: shown.map((task, index) => [button(runtime, `Review ${index + 1}`, { groupId, taskId: task.taskId, version: task.version, status: task.status, action: "view" })]) };
    owner.enqueue(groupId, "telegram", `Coding\n\n${rows.length ? rows.join("\n\n") : "No coding tasks yet."}${tasks.length > shown.length ? `\n\n${tasks.length - shown.length} more retained tasks are available through owner control.` : ""}\n\nMac-first. Cloud needs a separately uploaded snapshot and explicit approval. Silence never transfers a running task.`, markup);
    return { posted: true };
  });
}

/** Only the owner-authenticated Telegram webhook may call this handler. */
export async function handleCodingCallback(runtime: CodingRuntime, token: string, binding: ButtonBinding): Promise<CodingCallbackResult | undefined> {
  if (!token.startsWith("cod:")) return;
  if (!/^cod:[a-f0-9-]{36}$/.test(token)) throw new StateError(409, "Invalid coding control");
  buttons(runtime);
  const owner = runtime.store.owner;
  const row = owner.db.all<{ data: string }>("SELECT data FROM umpi_coding_buttons WHERE token=?", token)[0];
  if (!row) throw new StateError(409, "This coding control is unavailable. Open /code again.");
  const value = JSON.parse(row.data) as CodingButton;
  // Approve needs every part of the review confirmed in Telegram: the owner must have had the whole text.
  if (!owner.buttonShown(value.groupId, token, binding, value.action === "approve")) throw new StateError(409, "This coding control does not belong to that confirmed message, or the review did not arrive whole.");
  await runtime.wake();
  return owner.effect(`coding-button:${token}`, () => {
    const task = runtime.store.requireTask(value.taskId);
    if (task.version !== value.version) throw new StateError(409, "Coding instructions changed. Open /code again.");
    if (value.action === "view") {
      enqueueCard(runtime, task, `coding-view:${token}`, "telegram");
      return { text: "Current coding task details opened.", removeKeyboard: false };
    }
    if (task.status !== value.status) throw new StateError(409, "Coding execution state changed. Open /code again.");
    // One decision consumes every control on this card, including its other button.
    if (owner.effectResult(`coding-decision:${value.groupId}`)) throw new StateError(409, "This coding card was already used. Open /code again.");
    let next: CodingTask;
    if (value.action === "approve") {
      if (task.status !== "pending_approval") throw new StateError(409, "This task is no longer waiting for approval.");
      runtime.archive();
      if (task.target === "cloud" && !runtime.cloudAvailable()) throw new StateError(503, "Cloud coding is unavailable");
      next = runtime.store.approve(task.taskId, value.version);
    } else {
      if (!cancellable[task.status]) throw new StateError(409, "This coding task cannot be cancelled from that card.");
      next = runtime.store.cancel(task.taskId, value.version);
    }
    owner.effect(`coding-decision:${value.groupId}`, () => ({ action: value.action }));
    enqueueCodingApproval(runtime, next);
    return { text: value.action === "approve" ? "Approved for this task and time limit. Waiting for its execution owner."
      : next.status === "cancel_requested" ? "Stop requested. Existing changes remain; waiting for confirmed stop." : "Cancelled before execution.", removeKeyboard: true };
  });
}
