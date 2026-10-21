import { PlanningRuntime } from "./planning-runtime.js";
import { StateError, type TelegramMarkup } from "./store.js";

type PlanningButton = { groupId: string; settingsVersion: number } & (
  | { action: "prepare"; day: string; planVersion: number; briefVersion: number }
  | { action: "configure"; enabled: boolean; time: string }
);
export interface PlanningCallbackResult { text: string; replyMarkup: TelegramMarkup }

export function formatPlanningStatus(runtime: PlanningRuntime): string {
  const { store } = runtime, settings = store.settings(), plan = store.plan(runtime.today());
  const pending = store.pending();
  return `Daily preparation: ${settings.enabled ? "on" : "paused"} · ${settings.time} ${store.timezone}.\n`
    + `Note vault: ${runtime.available() ? "configured" : "not configured"}.\n`
    + `Today: ${plan ? plan.status === "synced" ? "upload confirmed" : plan.status : "not requested"}.\n`
    + (pending ? "A retained upload needs review; no replacement plan will bypass it.\n" : "")
    + (store.proactive.settings().enabled ? "Prepare today queues a quiet background review; it is not a completed note." : "Follow-through is paused. Open /schedule to enable background reviews before preparing today.");
}

export function enqueuePlanningControls(runtime: PlanningRuntime, requestId: string): void {
  const { store } = runtime, owner = store.proactive.owner;
  owner.db.all("CREATE TABLE IF NOT EXISTS umpi_planning_buttons (token TEXT PRIMARY KEY, data TEXT NOT NULL)");
  owner.effect(`planning-menu:${requestId}`, () => {
    const settings = store.settings(), day = runtime.today(), groupId = `planning-menu:${requestId}`;
    const prepareToken = `pln:${crypto.randomUUID()}`, configureToken = `pln:${crypto.randomUUID()}`;
    const buttons: [string, PlanningButton][] = [
      [prepareToken, { groupId, settingsVersion: settings.version, action: "prepare", day, planVersion: store.plan(day)?.version ?? 0, briefVersion: store.brief(day)?.version ?? 0 }],
      [configureToken, { groupId, settingsVersion: settings.version, action: "configure", enabled: !settings.enabled, time: settings.time }],
    ];
    for (const [token, button] of buttons) owner.db.all("INSERT INTO umpi_planning_buttons VALUES (?,?)", token, JSON.stringify(button));
    owner.enqueue(groupId, "telegram", formatPlanningStatus(runtime), { inline_keyboard: [
      [{ text: "Prepare today", callback_data: prepareToken }],
      [{ text: settings.enabled ? "Pause daily preparation" : "Enable daily preparation", callback_data: configureToken }],
    ] });
    return { posted: true };
  });
}

/** Parent performs owner webhook checks first; wake happens before the synchronous decision. */
export async function handlePlanningCallback(runtime: PlanningRuntime, token: string, messageId: number): Promise<PlanningCallbackResult | undefined> {
  if (!token.startsWith("pln:")) return;
  const { store } = runtime, owner = store.proactive.owner;
  owner.db.all("CREATE TABLE IF NOT EXISTS umpi_planning_buttons (token TEXT PRIMARY KEY, data TEXT NOT NULL)");
  const row = owner.db.all<{ data: string }>("SELECT data FROM umpi_planning_buttons WHERE token=?", token)[0];
  if (!row) throw new StateError(409, "This planning control is no longer available. Open /plan again.");
  const button = JSON.parse(row.data) as PlanningButton;
  if (!owner.deliveries(button.groupId).some(delivery => delivery.channel === "telegram" && delivery.status === "sent" && delivery.messageId === messageId
    && delivery.replyMarkup?.inline_keyboard.some(buttons => buttons.some(item => item.callback_data === token)))) {
    throw new StateError(409, "This planning control does not belong to that confirmed message.");
  }
  await runtime.wake();
  return owner.effect(`planning-button:${token}`, () => {
    if (store.settings().version !== button.settingsVersion) throw new StateError(409, "Daily-planning settings changed. Open /plan again.");
    if (button.action === "configure") {
      store.configure({ expectedVersion: button.settingsVersion, enabled: button.enabled, time: button.time });
      return { text: button.enabled
        ? store.proactive.settings().enabled ? "Daily preparation enabled. Actual source access and upload will be checked when it runs." : "Daily preparation saved as enabled, but follow-through remains paused. Open /schedule when ready."
        : "Daily preparation paused. Retained writes remain available for review; reminders and device alarms are unchanged.", replyMarkup: { inline_keyboard: [] } };
    }
    if (button.day !== runtime.today() || (store.plan(button.day)?.version ?? 0) !== button.planVersion || (store.brief(button.day)?.version ?? 0) !== button.briefVersion) {
      throw new StateError(409, "Today's planning state changed. Open /plan again before preparing it.");
    }
    const sessionId = owner.session("telegram");
    if (!sessionId) throw new StateError(409, "The owner conversation is unavailable. Open /plan again.");
    const plan = runtime.request(sessionId);
    return { text: plan.status === "synced" ? "Today's note upload is confirmed." : "Today's preparation is recorded for background review. The note is not yet confirmed synced.", replyMarkup: { inline_keyboard: [] } };
  });
}
