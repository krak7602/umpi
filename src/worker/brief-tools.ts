import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolExecutionResult, type ToolRegistration } from "@earendil-works/pi-durable";
import { planningDay, shiftPlanningDay } from "../shared/daily-planning.js";
import type { ActivityStore } from "./activity-store.js";
import { activityDay } from "./activity-tools.js";
import { InputError, record } from "../shared/protocol.js";
import { BriefStore } from "./brief-store.js";
import type { MailStore } from "./mail-store.js";
import type { PlanningRuntime } from "./planning-runtime.js";
import type { SituationStore } from "./situation-store.js";
import { readCalendarRange } from "./situation-tools.js";
import { StateError } from "./store.js";

export interface BriefSources {
  brief: BriefStore;
  situation: SituationStore;
  mail: MailStore;
  planning: PlanningRuntime;
  calendarCredentials: () => string | undefined;
  /** Aside activity summaries, when the Mac context lane is on. */
  activity?: ActivityStore;
}

/** Returned with the owned inputs, so ordinary conversations do not carry the writing rules. */
export const BRIEF_GUIDE = `Write the owner's morning brief for Telegram. They read it right after waking, so it must be scannable in under a minute.
- Open with one plain sentence on how the day looks.
- Today: calendar events with local times, the plan's main targets, and anything due today (payments, deliveries, deadlines, interviews).
- Changed since the last brief: facts listed in changedSinceLastBrief that matter (delivered or delayed orders, money in or out worth noticing, application progress, account alerts, mail needing a reply).
- Coming up: the next two or three days, only concrete items.
- Money: yesterday's spending total and anything unusual. Skip it when there were no spend alerts.
- Yesterday's work: one or two lines on what they mainly worked on, from yesterdayActivity, only when it is present and useful for today.
Leave out empty sections. Use short bullet lines, local times, and the owner's own wording for plan items. No greeting filler, praise, or sign-off, and no em or en dashes. Never invent events or facts; say when a source was unavailable. If nothing matters today and nothing changed, commit null and stay quiet.`;

async function result(run: () => unknown | Promise<unknown>): Promise<ToolExecutionResult> {
  try { return { content: [{ type: "text", text: JSON.stringify(await run()) }] }; }
  catch (error) {
    return { isError: true, content: [{ type: "text", text: error instanceof InputError || error instanceof StateError
      ? error.message : "The brief inputs could not be read. Finish the review with a blocker; do not invent a brief." }] };
  }
}
function fields(value: unknown, allowed: string[]): Record<string, unknown> {
  const body = record(value);
  if (Object.keys(body).some(key => !allowed.includes(key))) throw new InputError("Unknown brief tool field");
  return body;
}

export async function briefInputs(sources: BriefSources, sessionId: string, now = Date.now()): Promise<object> {
  const { brief: record } = sources.brief.forSession(sessionId, now);
  const day = planningDay(now, sources.brief.timezone), previous = sources.brief.lastCommitted(day);
  const since = previous?.committedAt ?? new Date(now - 86_400_000).toISOString();
  const calendar = await readCalendarRange(sources.calendarCredentials(), day, 2, sources.brief.timezone);
  sources.brief.forSession(sessionId);
  const plan = sources.planning.read(day) as { plan: { status: string; entries: { section: string; line: string }[] } | null; brief: { text: string } | null };
  const reminders = sources.mail.proactive.owner.reminders()
    .filter(item => item.status === "scheduled" && Date.parse(item.dueAt) <= now + 36 * 3_600_000).slice(0, 10).map(({ text, dueAt }) => ({ text, dueAt }));
  return {
    guide: BRIEF_GUIDE, now: new Date(now).toISOString(), day, timezone: sources.brief.timezone, manual: record.manual, lastBriefAt: previous?.committedAt ?? null,
    calendar,
    plan: plan.plan ? { status: plan.plan.status, entries: plan.plan.entries.slice(0, 40).map(entry => `${entry.section}: ${entry.line}`) } : null,
    ownerIntentForToday: plan.brief?.text.slice(0, 1_500) ?? null,
    reminders,
    mailNeedingOwner: sources.mail.attention(20).map(({ subject, sender, receivedAt, suggestedAction, status }) => ({ subject, sender, receivedAt, suggestedAction, status })),
    changedSinceLastBrief: sources.situation.changedIds(since, 100),
    situation: sources.situation.read({ budgetBytes: 20_000 }, now),
    yesterdayActivity: sources.activity ? activityDay(sources.activity, shiftPlanningDay(day, -1), sources.brief.timezone, false, 6_000) : null,
  };
}

export function briefTools(sources: BriefSources): ToolRegistration[] {
  return [
    defineTool({ name: "read_brief_inputs", description: "Only the owned morning-brief review: read today's calendar, plan, reminders, mail needing the owner, and the current situation with what changed since the last brief, plus the writing guide.", parameters: Type.Object({}, { additionalProperties: false }), replay: "safe",
      async execute(input, api) { return result(() => { fields(input, []); return briefInputs(sources, String(api.conversationId)); }); } }),
    defineTool({ name: "commit_brief", description: "Only the owned morning-brief review: save the brief text exactly as it should reach the owner, or null to stay quiet. Delivery happens when the review finishes.", parameters: Type.Object({ text: Type.Union([Type.String({ minLength: 1, maxLength: 3_500 }), Type.Null()]) }, { additionalProperties: false }), replay: "safe",
      async execute(input, api) { return result(() => {
        const body = fields(input, ["text"]); if (body.text !== null && typeof body.text !== "string") throw new InputError("Brief text must be a string or null");
        const saved = sources.brief.commit(String(api.conversationId), body.text);
        return { committed: true, day: saved.day, quiet: saved.text === null };
      }); } }),
  ];
}

/** The brief responsibility cannot be widened through generic commitment or wake tools, and its delivery comes from the committed text. */
export function guardBriefReviewTools(tools: ToolRegistration[], store: BriefStore): ToolRegistration[] {
  const restricted: Record<string, true> = { update_commitment: true, schedule_wakeup: true, update_wakeup: true, cancel_wakeup: true };
  return tools.map(tool => ({ ...tool, async execute(args, api, context) {
    const sessionId = String(api.conversationId), owner = store.proactive.owner, run = store.proactive.runForSession(sessionId);
    if (!owner.isBackgroundSession(sessionId) && restricted[tool.name]) {
      const input = record(args);
      const commitmentId = tool.name === "update_commitment" ? input.id : tool.name === "schedule_wakeup" ? input.commitmentId
        : typeof input.id === "string" ? store.proactive.wakeup(input.id)?.commitmentId : undefined;
      if (typeof commitmentId === "string" && store.ownsCommitment(commitmentId)) return result(() => { throw new StateError(403, "Use /brief controls for the morning brief."); });
    }
    if (owner.isBackgroundSession(sessionId) && run && store.ownsCommitment(run.commitmentId)) {
      if (restricted[tool.name]) return result(() => { throw new StateError(403, "The morning brief cannot rewrite its commitment or scheduler ownership."); });
      if (tool.name === "finish_proactive_review") {
        try { return tool.execute(store.finishInput(sessionId, args), api, context); }
        catch (error) { return result(() => { throw error; }); }
      }
    }
    return tool.execute(args, api, context);
  } }));
}

export const BRIEF_INSTRUCTIONS = `The morning brief is an owner-enabled daily background review. Only that owned review may call read_brief_inputs and commit_brief; it follows the guide returned with its inputs. In conversation, when the owner asks for a brief or a summary of their day, answer directly with read_situation and read_calendar.`;
