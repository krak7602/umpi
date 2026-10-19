import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolExecutionResult, type ToolRegistration } from "@earendil-works/pi-durable";
import { planningDay, shiftPlanningDay } from "../shared/daily-planning.js";
import { InputError, record } from "../shared/protocol.js";
import { readCalendarDay } from "./calendar.js";
import { SITUATION_KINDS, SituationStore, type SituationKind } from "./situation-store.js";
import { StateError, type Store } from "./store.js";

const MAX_CALENDAR_DAYS = 14;

async function result(run: () => unknown | Promise<unknown>): Promise<ToolExecutionResult> {
  try { return { content: [{ type: "text", text: JSON.stringify(await run()) }] }; }
  catch (error) {
    return { isError: true, content: [{ type: "text", text: error instanceof InputError || error instanceof StateError
      ? error.message : "The situation lookup could not complete. Say what is unavailable; do not guess." }] };
  }
}
function fields(value: unknown, allowed: string[]): Record<string, unknown> {
  const body = record(value);
  if (Object.keys(body).some(key => !allowed.includes(key))) throw new InputError("Unknown situation tool field");
  return body;
}
function foreground(owner: Store, conversationId: string): void {
  if (owner.isBackgroundSession(conversationId)) throw new StateError(403, "Situation and calendar lookups are for the owner's own conversation; background reviews use their scoped inputs");
}

/** Compact calendar days for chat. Coverage gaps stay explicit rather than looking like a free day. */
export async function readCalendarRange(credentials: string | undefined, start: string, days: number, timezone: string): Promise<object> {
  const result: object[] = [];
  for (let offset = 0; offset < days; offset++) {
    const day = shiftPlanningDay(start, offset), snapshot = await readCalendarDay(credentials, day, timezone);
    result.push({ day, coverage: snapshot.coverage, ...(snapshot.issues.length ? { issues: snapshot.issues } : {}),
      events: snapshot.events.map(({ id, title, start: from, end, allDay, status }) => ({ id, title, start: from, end, ...(allDay ? { allDay } : {}), ...(status === "tentative" ? { tentative: true } : {}) })) });
    if (snapshot.coverage === "unavailable" && offset === 0 && snapshot.issues.some(issue => /authorization/i.test(issue))) break;
  }
  return { timezone, days: result };
}

export function situationTools(owner: Store, situation: SituationStore, calendarCredentials: () => string | undefined): ToolRegistration[] {
  return [
    defineTool({ name: "read_situation", description: "Read the owner's current situation: orders and deliveries, spending totals, subscriptions, bills, job applications, bookings, account alerts, and other time-bound updates extracted from their mail. Use it for questions like what is going on, what is arriving, what did I spend, or where am I with applications. Facts are incomplete when a source email was missed; say so instead of guessing.",
      parameters: Type.Object({
        kinds: Type.Optional(Type.Array(Type.Union(SITUATION_KINDS.map(kind => Type.Literal(kind))), { maxItems: SITUATION_KINDS.length, description: "Filter by kind. Individual spends are only listed when 'spend' is requested; totals are always included." })),
        query: Type.Optional(Type.String({ minLength: 1, maxLength: 80, description: "Case-insensitive match on title, counterparty, state, or detail." })),
      }, { additionalProperties: false }), replay: "safe",
      async execute(input, api) { return result(() => {
        const body = fields(input, ["kinds", "query"]); foreground(owner, String(api.conversationId));
        return situation.read({ kinds: body.kinds as SituationKind[] | undefined, query: body.query as string | undefined, includeSpends: (body.kinds as string[] | undefined)?.includes("spend") });
      }); } }),
    defineTool({ name: "update_situation", description: "Apply the owner's correction to one situation fact from read_situation: a new state (for example cancelled, paid, delivered, rejected), dismiss to hide it, or a short note. Only on the owner's explicit statement in this conversation.",
      parameters: Type.Object({
        id: Type.String({ pattern: "^fact-[a-f0-9]{24}$" }),
        expectedVersion: Type.Integer({ minimum: 1 }),
        state: Type.Optional(Type.String({ minLength: 1, maxLength: 40 })),
        dismiss: Type.Optional(Type.Boolean()),
        note: Type.Optional(Type.String({ minLength: 1, maxLength: 240 })),
      }, { additionalProperties: false }), replay: "safe",
      async execute(input, api) { return result(() => {
        fields(input, ["id", "expectedVersion", "state", "dismiss", "note"]); foreground(owner, String(api.conversationId));
        const fact = situation.correct(input);
        return { id: fact.id, version: fact.version, state: fact.state, relevantUntil: fact.relevantUntil, owner: fact.owner };
      }); } }),
    defineTool({ name: "read_calendar", description: "Read the owner's Google Calendar (read-only) for up to 14 days from a local date. Use it for schedule questions and before planning around meetings. A day with coverage other than complete may be missing events.",
      parameters: Type.Object({
        from: Type.Optional(Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "Local start date; defaults to today." })),
        days: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_CALENDAR_DAYS })),
      }, { additionalProperties: false }), replay: "safe",
      async execute(input, api) { return result(async () => {
        const body = fields(input, ["from", "days"]); foreground(owner, String(api.conversationId));
        const today = planningDay(Date.now(), situation.timezone);
        let start = today;
        if (body.from !== undefined) {
          try { start = shiftPlanningDay(body.from as string, 0); } catch { throw new InputError("from must be a valid local date"); }
        }
        if (start < shiftPlanningDay(today, -7) || start > shiftPlanningDay(today, 60)) throw new InputError("Calendar reads start between 7 days ago and 60 days ahead");
        return readCalendarRange(calendarCredentials(), start, (body.days as number | undefined) ?? 1, situation.timezone);
      }); } }),
  ];
}

export const SITUATION_INSTRUCTIONS = `Situation awareness: read_situation holds what Umpi knows about the owner's current life from their mail (orders and deliveries, spending, subscriptions, bills, job applications, bookings, account alerts). read_calendar reads their calendar. Use them instead of asking the owner to explain things those sources already show. Answer from them directly and briefly. Facts come from automated extraction and can be incomplete or stale; when a source is missing or coverage is partial, say so. Spending totals only cover alerts that arrived by mail. When the owner corrects a fact (cancelled, already paid, not mine), apply it with update_situation.`;
