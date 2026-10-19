import { MailRuntime } from "./mail-runtime.js";
import { StateError, type TelegramMarkup } from "./store.js";

type MailButton = { groupId: string; settingsVersion: number } & (
  | { action: "configure"; enabled: boolean; lookbackDays: number; pollMinutes: number }
  | { action: "check"; rebootstrap: boolean }
  | { action: "handled" | "snooze" | "draft"; threadId: string; threadVersion: number }
);
export interface MailCallbackResult { text: string; replyMarkup: TelegramMarkup; prompt?: string; wake?: boolean }

export function formatMailStatus(runtime: MailRuntime): string {
  const settings = runtime.store.settings(), item = runtime.store.attention(1)[0];
  const status = runtime.store.status() as { counts: Record<string, number>; factsPending: number };
  const accounts = runtime.store.accounts().filter(account => runtime.accounts.some(configured => configured.id === account.id));
  let text = `Mail follow-through: ${settings.enabled ? "on" : "paused"} · every ${settings.pollMinutes} minutes · first scan ${settings.lookbackDays} days.\n`
    + `Gmail: ${runtime.available() ? `read-only access to ${runtime.accounts.length} inbox${runtime.accounts.length === 1 ? "" : "es"}` : "authorization not configured"}.`;
  for (const account of accounts) {
    text += `\n• ${account.id}: from ${account.bootstrapAfter ?? "not started"} · last check ${account.lastSyncAt ?? "not run"}${account.lastStatus ? ` (${account.lastStatus})` : ""}`;
    if (account.continuation) text += " · scan continuing";
    if (account.issue) text += ` · ${account.issue}`;
  }
  text += `\nAwaiting review: ${status.counts.pending ?? 0} new · ${status.factsPending} for facts · needs you: ${status.counts.attention ?? 0} · snoozed: ${status.counts.snoozed ?? 0}.`;
  if (settings.enabled && !runtime.store.proactive.settings().enabled) text += "\nFollow-through is paused in /schedule, so mailbox checks are also paused.";
  if (item) text += `\n\nNext item\n${item.subject}\nFrom: ${item.sender}\nReceived: ${item.receivedAt}\nWhy: ${item.reason}\nSuggested: ${item.suggestedAction}\nOpen: ${item.webUrl}`;
  else text += "\n\nNo selected mail item is waiting for owner action.";
  return text.slice(0, 4_000);
}

function table(runtime: MailRuntime): void {
  runtime.store.db.all("CREATE TABLE IF NOT EXISTS umpi_mail_buttons (token TEXT PRIMARY KEY, data TEXT NOT NULL)");
}
function addButton(runtime: MailRuntime, token: string, button: MailButton): void {
  runtime.store.db.all("INSERT INTO umpi_mail_buttons VALUES (?,?)", token, JSON.stringify(button));
}
export function enqueueMailControls(runtime: MailRuntime, requestId: string): void {
  table(runtime);
  const owner = runtime.store.proactive.owner;
  owner.effect(`mail-menu:${requestId}`, () => {
    const settings = runtime.store.settings(), groupId = `mail-menu:${requestId}`, keyboard: TelegramMarkup["inline_keyboard"] = [];
    if (!settings.enabled) {
      for (const choices of [[0, 7], [14, 30]]) {
        const row: TelegramMarkup["inline_keyboard"][number] = [];
        for (const lookbackDays of choices) {
          const token = `mail:${crypto.randomUUID()}`;
          addButton(runtime, token, { groupId, settingsVersion: settings.version, action: "configure", enabled: true, lookbackDays, pollMinutes: settings.pollMinutes });
          row.push({ text: lookbackDays === 0 ? "Start from now" : `Start with ${lookbackDays} days`, callback_data: token });
        }
        keyboard.push(row);
      }
    } else {
      const check = `mail:${crypto.randomUUID()}`, pause = `mail:${crypto.randomUUID()}`;
      addButton(runtime, check, { groupId, settingsVersion: settings.version, action: "check", rebootstrap: false });
      addButton(runtime, pause, { groupId, settingsVersion: settings.version, action: "configure", enabled: false, lookbackDays: settings.lookbackDays, pollMinutes: settings.pollMinutes });
      keyboard.push([{ text: "Check now", callback_data: check }, { text: "Pause", callback_data: pause }]);
      if (runtime.store.accounts().some(account => account.lastStatus === "cursor_expired")) {
        const token = `mail:${crypto.randomUUID()}`;
        addButton(runtime, token, { groupId, settingsVersion: settings.version, action: "check", rebootstrap: true });
        keyboard.push([{ text: `Rescan last ${settings.lookbackDays} days`, callback_data: token }]);
      }
    }
    const item = runtime.store.attention(1)[0];
    if (item) {
      const actions = (["draft", "snooze", "handled"] as const).map(action => {
        const token = `mail:${crypto.randomUUID()}`;
        addButton(runtime, token, { groupId, settingsVersion: settings.version, action, threadId: item.id, threadVersion: item.version });
        return { text: action === "draft" ? "Draft reply" : action === "snooze" ? "Tomorrow" : "Handled", callback_data: token };
      });
      keyboard.push(actions);
    }
    owner.enqueue(groupId, "telegram", formatMailStatus(runtime), { inline_keyboard: keyboard });
    return { posted: true };
  });
}

/** Parent performs Telegram owner checks before this version-bound effect. */
export async function handleMailCallback(runtime: MailRuntime, token: string, messageId: number): Promise<MailCallbackResult | undefined> {
  if (!token.startsWith("mail:")) return;
  table(runtime);
  const { store } = runtime, owner = store.proactive.owner;
  const row = owner.db.all<{ data: string }>("SELECT data FROM umpi_mail_buttons WHERE token=?", token)[0];
  if (!row) throw new StateError(409, "This mail control is no longer available. Open /mail again.");
  const button = JSON.parse(row.data) as MailButton;
  if (!owner.deliveries(button.groupId).some(delivery => delivery.channel === "telegram" && delivery.status === "sent" && delivery.messageId === messageId
    && delivery.replyMarkup?.inline_keyboard.some(buttons => buttons.some(item => item.callback_data === token)))) {
    throw new StateError(409, "This mail control does not belong to that confirmed message.");
  }
  let wake = false;
  const response = owner.effect<MailCallbackResult>(`mail-button:${token}`, () => {
    if (store.settings().version !== button.settingsVersion) throw new StateError(409, "Mail settings changed. Open /mail again.");
    const replyMarkup: TelegramMarkup = { inline_keyboard: [] };
    if (button.action === "configure") {
      const sessionId = owner.session("telegram");
      if (!sessionId) throw new StateError(409, "The owner conversation is unavailable. Open /mail again.");
      store.configure({ expectedVersion: button.settingsVersion, enabled: button.enabled, lookbackDays: button.lookbackDays, pollMinutes: button.pollMinutes }, sessionId);
      wake = true;
      return { text: button.enabled ? `Read-only mail follow-through enabled with a fixed ${button.lookbackDays === 0 ? "from-now" : `${button.lookbackDays}-day`} boundary. The first result will be one bounded digest.`
        : "Mail follow-through paused. Existing review state is retained; Gmail is unchanged.", replyMarkup, wake: true };
    }
    if (button.action === "check") {
      store.requestCheck(Date.now(), button.rebootstrap); wake = true;
      return { text: button.rebootstrap ? "Bounded Gmail re-scan queued." : "Gmail check queued.", replyMarkup, wake: true };
    }
    if (button.action === "handled") {
      store.markHandled(button.threadId, button.threadVersion);
      return { text: "Marked handled in Umpi. Gmail was not changed.", replyMarkup };
    }
    if (button.action === "snooze") {
      store.snooze(button.threadId, button.threadVersion, new Date(Date.now() + 24 * 60 * 60_000).toISOString()); wake = true;
      return { text: "Snoozed for 24 hours in Umpi. Gmail was not changed.", replyMarkup, wake: true };
    }
    return { text: "Drafting in chat. Nothing will be saved or sent to Gmail.", replyMarkup, prompt: store.draftPrompt(button.threadId, button.threadVersion) };
  });
  if (wake || response.wake) await runtime.wake();
  return response;
}
