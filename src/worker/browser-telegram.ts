import { randomUUID } from "node:crypto";
import { browserDisplayUrl } from "../shared/browser.js";
import type { BrowserRuntime } from "./browser-runtime.js";
import type { BrowserTask } from "./browser-store.js";
import { StateError } from "./store.js";
import type { TelegramMarkup } from "./store.js";
interface BrowserButton { groupId: string; taskId: string; version: number; status: BrowserTask["status"]; action: "view" | "approve" | "cancel" }
function buttons(runtime: BrowserRuntime): void { runtime.store.owner.db.all("CREATE TABLE IF NOT EXISTS umpi_browser_buttons (token TEXT PRIMARY KEY,data TEXT NOT NULL)"); }
function button(runtime: BrowserRuntime, text: string, value: BrowserButton) { const token = `brw:${randomUUID()}`; runtime.store.owner.db.all("INSERT INTO umpi_browser_buttons VALUES (?,?)", token, JSON.stringify(value)); return { text, callback_data: token }; }
const cancellable = new Set(["pending_approval", "queued", "preparing", "running", "finishing"]);
const MAX_BROWSER_REVIEW_CHARACTERS = 524_288;
function card(runtime: BrowserRuntime, task: BrowserTask, groupId: string, channel = task.channel): void {
  runtime.store.owner.effect(groupId, () => {
    const title = task.status === "pending_approval" ? task.target === "mac" ? "Browse with Aside on your Mac?" : "Browse in the bounded cloud?" : `Browser · ${task.status.replaceAll("_", " ")}`;
    const sites = task.sites.map(scope => `${scope.site.title}${scope.site.domain ? " · includes subdomains" : ""}\n${browserDisplayUrl(scope.startUrl)}`).join("\n\n");
    const scope = task.target === "mac" ? "Uses task-owned tabs in your existing Aside profile. Other tabs stay untouched. Requested-site sessions may be encrypted to Cloudflare for later tasks. Not an isolated network sandbox." : "Isolated site contexts with only the saved sessions shown below. No cloud state is written back to your Mac. Active browser time can incur Cloudflare usage.";
    const snapshots = task.target === "cloud" ? "\n\nSessions\n" + task.sites.map(scope => { const snapshot = task.selectedSnapshots.find(snapshot => snapshot.siteId === scope.site.siteId); return `${scope.site.title}: ${snapshot ? `saved ${snapshot.capturedAt}` : "no saved session"}`; }).join("\n") : "";
    const text = `${title}\n\n${task.prompt}${task.corrections.length ? `\n\nOwner corrections\n${task.corrections.join("\n\n")}` : ""}\n\n${sites}${snapshots}\n\n${Math.ceil(task.timeoutMs / 1000)}s limit · ${scope}\nOnly this goal authorizes website actions. Cancellation does not undo effects.${task.issue ? `\n\n${task.issue}` : ""}`;
    if (text.length > MAX_BROWSER_REVIEW_CHARACTERS) throw new StateError(413, "Browser review exceeds its complete-text budget; no partial approval is posted");
    const identity = { groupId, taskId: task.taskId, version: task.version, status: task.status }, row: TelegramMarkup["inline_keyboard"][number] = [];
    if (channel === "telegram" && task.status === "pending_approval") row.push(button(runtime, "Approve", { ...identity, action: "approve" }));
    if (channel === "telegram" && cancellable.has(task.status)) row.push(button(runtime, "Cancel", { ...identity, action: "cancel" }));
    runtime.store.owner.enqueue(groupId, channel, text, row.length ? { inline_keyboard: [row] } : undefined, [{ type: "bold", offset: 0, length: title.length }], text.length);
    return { posted: true };
  });
}
export function enqueueBrowserApproval(runtime: BrowserRuntime, task: BrowserTask): void {
  buttons(runtime); const prefix = `browser-approval:${task.taskId}:`, groupId = prefix + task.version;
  for (const group of runtime.store.owner.pendingDeliveryGroups(prefix)) if (task.status !== "pending_approval" || group !== groupId) runtime.store.owner.discardDeliveryGroup(group, "Browser scope changed; open /browse for current controls");
  if (task.status === "pending_approval") card(runtime, task, groupId);
}
export function enqueueBrowserControls(runtime: BrowserRuntime, requestId: string): void {
  buttons(runtime); const owner = runtime.store.owner, groupId = `browser-menu:${requestId}`;
  owner.effect(groupId, () => {
    const tasks = runtime.store.tasks().slice(0, 6), rows = tasks.map((task, index) => `${index + 1}. ${task.status.replaceAll("_", " ")} · ${task.target}\n${task.prompt.replace(/\s+/g, " ").slice(0, 180)}`);
    const markup: TelegramMarkup = { inline_keyboard: tasks.map((task, index) => [button(runtime, `Review ${index + 1}`, { groupId, taskId: task.taskId, version: task.version, status: task.status, action: "view" })]) };
    owner.enqueue(groupId, "telegram", `Browser\n\n${rows.length ? rows.join("\n\n") : "No browser tasks yet."}\n\nMac-first. Cloud needs separate approval and uses only selected saved sessions. A disconnect never duplicates claimed work.`, markup); return { posted: true };
  });
}
export async function handleBrowserCallback(runtime: BrowserRuntime, token: string, messageId: number): Promise<{ text: string; removeKeyboard: boolean } | undefined> {
  if (!token.startsWith("brw:")) return;
  if (!/^brw:[a-f0-9-]{36}$/.test(token) || !Number.isSafeInteger(messageId) || messageId <= 0) throw new StateError(409, "Invalid browser control");
  buttons(runtime); const owner = runtime.store.owner, row = owner.db.all<{ data: string }>("SELECT data FROM umpi_browser_buttons WHERE token=?", token)[0];
  if (!row) throw new StateError(409, "Browser control unavailable; open /browse again");
  const value = JSON.parse(row.data) as BrowserButton;
  const deliveries = owner.deliveries(value.groupId);
  if (!deliveries.length || deliveries.some(delivery => delivery.channel !== "telegram" || delivery.status !== "sent") || !deliveries.some(delivery => delivery.messageId === messageId && delivery.replyMarkup?.inline_keyboard.some(row => row.some(button => button.callback_data === token)))) throw new StateError(409, "Browser control belongs to a different or incomplete confirmed review");
  await runtime.wake();
  return owner.effect(`browser-button:${token}`, () => {
    const task = runtime.store.requireTask(value.taskId); if (task.version !== value.version) throw new StateError(409, "Browser instructions changed; open /browse again");
    if (value.action === "view") { card(runtime, task, `browser-view:${token}`, "telegram"); return { text: "Current browser task details opened.", removeKeyboard: false }; }
    if (task.status !== value.status || owner.effectResult(`browser-decision:${value.groupId}`)) throw new StateError(409, "Browser scope changed or this card was already used; open /browse again");
    if (value.action === "approve" && task.target === "cloud" && !runtime.cloudAvailable()) throw new StateError(503, "Cloud browser is unavailable");
    const next = value.action === "approve" ? runtime.store.approve(task.taskId, value.version) : runtime.store.cancel(task.taskId, value.version);
    owner.effect(`browser-decision:${value.groupId}`, () => ({ action: value.action })); enqueueBrowserApproval(runtime, next);
    return { text: value.action === "approve" ? "Approved for this goal, site scope and time limit." : next.status === "cancel_requested" ? "Stop requested; waiting for actual browser close." : "Cancelled before browsing.", removeKeyboard: true };
  });
}
