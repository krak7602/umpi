import { ProactiveStore } from "./proactive-store.js";
import { StateError, type TelegramMarkup } from "./store.js";

interface ScheduleButton { groupId: string; expectedVersion: number; enabled: boolean; }

export function formatScheduleStatus(proactive: ProactiveStore): string {
  const settings = proactive.settings();
  const commitments = proactive.commitments().filter(item => item.status === "active" || item.status === "blocked");
  const wakeups = proactive.wakeups().filter(item => item.status === "scheduled" || item.status === "running");
  return `Follow-through: ${settings.enabled ? "on" : "paused"}.\n15-minute reviews · ${commitments.length} tracked responsibilities · ${wakeups.length} custom wake-ups.\n${settings.enabled ? "Only actionable work starts an agent review; quiet checks do not message you." : "Responsibilities are retained. Text reminders and already-requested device alarms are not paused."}`;
}

export function enqueueScheduleControls(proactive: ProactiveStore, requestId: string): void {
  const { owner } = proactive;
  owner.db.all("CREATE TABLE IF NOT EXISTS umpi_schedule_buttons (token TEXT PRIMARY KEY, data TEXT NOT NULL)");
  owner.effect(`schedule-menu:${requestId}`, () => {
    const settings = proactive.settings();
    const groupId = `schedule-menu:${requestId}`;
    const token = `sch:${crypto.randomUUID()}`;
    const button: ScheduleButton = { groupId, expectedVersion: settings.version, enabled: !settings.enabled };
    owner.db.all("INSERT INTO umpi_schedule_buttons VALUES (?, ?)", token, JSON.stringify(button));
    owner.enqueue(groupId, "telegram", formatScheduleStatus(proactive), {
      inline_keyboard: [[{ text: settings.enabled ? "Pause follow-through" : "Enable follow-through", callback_data: token }]],
    });
    return { posted: true };
  });
}

export function handleScheduleCallback(proactive: ProactiveStore, token: string, messageId: number): { text: string; replyMarkup: TelegramMarkup } | undefined {
  if (!token.startsWith("sch:")) return;
  const { owner } = proactive;
  owner.db.all("CREATE TABLE IF NOT EXISTS umpi_schedule_buttons (token TEXT PRIMARY KEY, data TEXT NOT NULL)");
  return owner.db.transaction(() => {
    const row = owner.db.all<{ data: string }>("SELECT data FROM umpi_schedule_buttons WHERE token=?", token)[0];
    if (!row) throw new StateError(409, "This schedule control is no longer available. Open /schedule again.");
    const button = JSON.parse(row.data) as ScheduleButton;
    if (!owner.deliveries(button.groupId).some(delivery => delivery.channel === "telegram" && delivery.status === "sent" && delivery.messageId === messageId
      && delivery.replyMarkup?.inline_keyboard.some(buttons => buttons.some(item => item.callback_data === token)))) throw new StateError(409, "This control does not belong to that message.");
    return owner.effect(`schedule-button:${token}`, () => {
      proactive.configure({ expectedVersion: button.expectedVersion, enabled: button.enabled, quietHours: proactive.settings().quietHours });
      return { text: button.enabled ? "Follow-through enabled." : "Follow-through paused. Existing text reminders and device alarms are unchanged.", replyMarkup: { inline_keyboard: [] } };
    });
  });
}
