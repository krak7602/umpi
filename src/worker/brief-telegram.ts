import { InputError, record } from "../shared/protocol.js";
import { BriefStore } from "./brief-store.js";
import type { SituationStore } from "./situation-store.js";
import { StateError, type TelegramMarkup } from "./store.js";
import { readJson } from "./transport.js";

type BriefButton = { groupId: string; settingsVersion: number } & ({ action: "now" } | { action: "configure"; enabled: boolean });
export interface BriefCallbackResult { text: string; replyMarkup: TelegramMarkup }

export function formatBriefStatus(store: BriefStore): string {
  const settings = store.settings(), status = store.status() as { today: { sent: boolean; status: string } | null };
  return `Morning brief: ${settings.enabled ? "on" : "paused"} · ${settings.time} ${store.timezone}.\n`
    + `Today: ${status.today ? status.today.status === "committed" ? status.today.sent ? "sent" : "nothing worth sending" : "being written" : "not yet"}.\n`
    + (store.proactive.settings().enabled ? "It uses your calendar, today's plan, reminders, and the situation record from mail." : "Follow-through is paused. Open /schedule to enable background reviews first.");
}

function table(store: BriefStore): void { store.db.all("CREATE TABLE IF NOT EXISTS umpi_brief_buttons (token TEXT PRIMARY KEY, data TEXT NOT NULL)"); }

export function enqueueBriefControls(store: BriefStore, requestId: string): void {
  table(store);
  const owner = store.proactive.owner;
  owner.effect(`brief-menu:${requestId}`, () => {
    const settings = store.settings(), groupId = `brief-menu:${requestId}`;
    const now = `brf:${crypto.randomUUID()}`, configure = `brf:${crypto.randomUUID()}`;
    for (const [token, button] of [[now, { groupId, settingsVersion: settings.version, action: "now" }], [configure, { groupId, settingsVersion: settings.version, action: "configure", enabled: !settings.enabled }]] as [string, BriefButton][]) {
      owner.db.all("INSERT INTO umpi_brief_buttons VALUES (?,?)", token, JSON.stringify(button));
    }
    const keyboard: TelegramMarkup["inline_keyboard"] = [];
    if (settings.enabled) keyboard.push([{ text: "Brief now", callback_data: now }]);
    keyboard.push([{ text: settings.enabled ? "Pause morning brief" : `Enable at ${settings.time}`, callback_data: configure }]);
    owner.enqueue(groupId, "telegram", formatBriefStatus(store), { inline_keyboard: keyboard });
    return { posted: true };
  });
}

/** Parent performs owner webhook checks first. */
export async function handleBriefCallback(store: BriefStore, token: string, messageId: number, wake: () => Promise<void>): Promise<BriefCallbackResult | undefined> {
  if (!token.startsWith("brf:")) return;
  table(store);
  const owner = store.proactive.owner;
  const row = owner.db.all<{ data: string }>("SELECT data FROM umpi_brief_buttons WHERE token=?", token)[0];
  if (!row) throw new StateError(409, "This brief control is no longer available. Open /brief again.");
  const button = JSON.parse(row.data) as BriefButton;
  if (!owner.deliveries(button.groupId).some(delivery => delivery.channel === "telegram" && delivery.status === "sent" && delivery.messageId === messageId
    && delivery.replyMarkup?.inline_keyboard.some(buttons => buttons.some(item => item.callback_data === token)))) {
    throw new StateError(409, "This brief control does not belong to that confirmed message.");
  }
  const result = owner.effect<BriefCallbackResult>(`brief-button:${token}`, () => {
    if (store.settings().version !== button.settingsVersion) throw new StateError(409, "Brief settings changed. Open /brief again.");
    if (button.action === "now") {
      store.requestNow();
      return { text: "Writing your brief now.", replyMarkup: { inline_keyboard: [] } };
    }
    const sessionId = owner.session("telegram");
    if (!sessionId) throw new StateError(409, "The owner conversation is unavailable. Open /brief again.");
    const settings = store.configure({ expectedVersion: button.settingsVersion, enabled: button.enabled }, sessionId);
    return { text: settings.enabled ? `Morning brief enabled for ${settings.time} each day.` : "Morning brief paused.", replyMarkup: { inline_keyboard: [] } };
  });
  await wake();
  return result;
}

/** The parent router authenticates the owner control credential before calling this. */
export async function briefRequest(request: Request, store: BriefStore, situation: SituationStore, telegramSession: () => string | undefined, wake: () => Promise<void>): Promise<Response | undefined> {
  const path = new URL(request.url).pathname;
  if (path === "/api/situation" && request.method === "GET") return Response.json(situation.read({ includeSpends: true }));
  if (path === "/api/brief" && request.method === "GET") return Response.json(store.status());
  if (path === "/api/brief/settings" && request.method === "PUT") {
    const body = record(await readJson(request, 4_096));
    if (Object.keys(body).some(key => !["expectedVersion", "enabled", "time"].includes(key))) throw new InputError("Unknown brief setting");
    const sessionId = telegramSession();
    if (!sessionId) throw new StateError(409, "Open the owner Telegram conversation before enabling the morning brief");
    const settings = store.configure(body, sessionId);
    await wake();
    return Response.json(settings);
  }
  if (path === "/api/brief/run" && request.method === "POST") {
    const brief = store.requestNow();
    await wake();
    return Response.json({ day: brief.day, status: brief.status }, { status: 202 });
  }
}
