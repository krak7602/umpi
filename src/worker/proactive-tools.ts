import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolExecutionApi, type ToolExecutionResult, type ToolRegistration } from "@earendil-works/pi-durable";
import { InputError } from "../shared/protocol.js";
import type { ProactiveStore, Commitment } from "./proactive-store.js";
import { StateError } from "./store.js";

const Id = Type.String({ minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9][A-Za-z0-9_.:-]*$" });
const Version = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const Text = Type.String({ minLength: 1, maxLength: 2_000 });
const Note = Type.String({ minLength: 1, maxLength: 4_000 });
const Instant = Type.String({ minLength: 1, maxLength: 64, description: "Future ISO 8601 instant with explicit Z or numeric offset. Use current_time and the owner's timezone." });
const NullableInstant = Type.Union([Instant, Type.Null()]);
const CommitmentFields = {
  purpose: Text, source: Text, nextAction: Text,
  blocker: Type.Union([Note, Type.Null()]),
  status: Type.Union([Type.Literal("active"), Type.Literal("blocked"), Type.Literal("completed"), Type.Literal("cancelled")]),
  nextReviewAt: NullableInstant, jobId: Type.Union([Id, Type.Null()]),
};
const WakeupFields = {
  purpose: Text, dueAt: Instant,
  expiresAt: Type.String({ minLength: 1, maxLength: 64, description: "Required explicit-offset instant after dueAt: the end of the useful late-run window, not a guaranteed delivery deadline." }),
  repeatEveryMinutes: Type.Union([Type.Integer({ minimum: 15, maximum: 525_600 }), Type.Null()]),
};

export function proactiveTools(proactive: ProactiveStore, wake: () => Promise<void>): ToolRegistration[] {
  const owner = proactive.owner;
  async function result(run: () => unknown | Promise<unknown>): Promise<ToolExecutionResult> {
    try { return { content: [{ type: "text", text: JSON.stringify(await run()) }] }; }
    catch (error) {
      return { isError: true, content: [{ type: "text", text: error instanceof InputError || error instanceof StateError
        ? error.message : "The proactive action could not be persisted. Read current state; do not claim success." }] };
    }
  }
  function state(value: object): object {
    const settings = proactive.settings();
    return { ...value, settings, scheduling: settings.enabled ? "enabled" : "paused" };
  }
  function authorize(api: ToolExecutionApi, commitmentId?: string): Commitment | undefined {
    const sessionId = String(api.conversationId);
    const channel = owner.channelForSession(sessionId);
    if (owner.isBackgroundSession(sessionId)) {
      const run = proactive.assertRunCurrent(sessionId);
      if (commitmentId !== undefined && run.commitmentId !== commitmentId) {
        throw new StateError(403, "A background review can change only its own current commitment");
      }
    }
    if (commitmentId === undefined) return undefined;
    const commitment = proactive.commitment(commitmentId);
    if (!commitment || commitment.channel !== channel) throw new StateError(404, "Commitment is not available in this conversation");
    return commitment;
  }
  async function mutate(api: ToolExecutionApi, name: string, input: unknown, run: () => unknown): Promise<unknown> {
    // Persist lifecycle intent first; the effect transaction then owns authorization and the mutation.
    await wake();
    const request = JSON.stringify({ name, input });
    const receipt = owner.effect(`proactive-tool:${api.conversationId}:${api.taskId}`, () => {
      if (owner.isBackgroundSession(String(api.conversationId)) && owner.hasForegroundInput()) {
        throw new StateError(409, "Foreground work takes priority; this background mutation must wait");
      }
      return { request, result: run() };
    });
    if (receipt.request !== request) throw new StateError(409, "Tool task already contains a different request");
    // A replay returns its original effect, but never claims that a subsequently paused scheduler is active.
    return state({ result: receipt.result });
  }
  return [
    defineTool({ name: "list_commitments", description: "Read bounded durable commitments with IDs, versions, source, next action, blocker, linked job and review time, plus actual scheduler settings. Read-only; a stored record is not proof its work completed. Paused scheduling preserves records but does not run them.", parameters: Type.Object({}, { additionalProperties: false }), replay: "safe",
      async execute(_input, api) { return result(() => { authorize(api); return state({ commitments: proactive.commitments() }); }); } }),
    defineTool({ name: "list_wakeups", description: "Read bounded custom wakeups, their commitment/version, useful window, recurrence and state, plus actual scheduler settings. A wake schedules a review, not an alarm, call, permission grant or guaranteed delivery.", parameters: Type.Object({}, { additionalProperties: false }), replay: "safe",
      async execute(_input, api) { return result(() => { authorize(api); return state({ wakeups: proactive.wakeups() }); }); } }),
    defineTool({ name: "create_commitment", description: "Record an actual owner request or explicit assistant promise, never an inferred obligation. Foreground only; origin and channel come from this conversation. Choose a stable ID, concrete nextAction, accurate source, explicit notification permission, and future nextReviewAt or null to await an event/owner. allowNotify is not permission for calls, alarms, commands or other effects. Persistence while paused does not activate scheduling.", parameters: Type.Object({ id: Id, ...CommitmentFields, allowNotify: Type.Boolean() }, { additionalProperties: false }), replay: "safe",
      async execute(input, api) { return result(() => mutate(api, "create_commitment", input, () => {
        authorize(api);
        const sessionId = String(api.conversationId);
        if (owner.isBackgroundSession(sessionId)) throw new StateError(403, "A background review cannot create commitments");
        return proactive.createCommitment(input, owner.channelForSession(sessionId), sessionId);
      })); } }),
    defineTool({ name: "update_commitment", description: "Replace all editable fields of this conversation's commitment using its current version. Cancel or complete by explicit status; completion needs verified evidence. Origin/channel/notification permission cannot change. Background reviews may change only their own commitment and must preserve purpose and source. Edits invalidate old wakeups and reviews; use finish_proactive_review for ordinary background progress or deferral.", parameters: Type.Object({ id: Id, expectedVersion: Version, ...CommitmentFields }, { additionalProperties: false }), replay: "safe",
      async execute(input, api) { return result(() => mutate(api, "update_commitment", input, () => {
        const commitment = authorize(api, input.id)!;
        if (owner.isBackgroundSession(String(api.conversationId)) && (input.purpose !== commitment.purpose || input.source !== commitment.source)) {
          throw new StateError(403, "A background review cannot change its commitment's purpose or source");
        }
        const { id, ...body } = input;
        return proactive.updateCommitment(id, body);
      })); } }),
    defineTool({ name: "schedule_wakeup", description: "Schedule your own return to an existing live commitment, independently of the 15-minute heartbeat. Requires future dueAt, later expiresAt, and repeatEveryMinutes=null for one return or >=15 for a justified recurrence. Only one live wake per commitment; update it instead of duplicating. Background callers must target their current commitment and use its exact purpose. Scheduling grants no new authority. Paused schedules are stored but do not run.", parameters: Type.Object({ id: Id, commitmentId: Id, ...WakeupFields }, { additionalProperties: false }), replay: "safe",
      async execute(input, api) { return result(() => mutate(api, "schedule_wakeup", input, () => {
        const commitment = authorize(api, input.commitmentId)!;
        if (owner.isBackgroundSession(String(api.conversationId)) && input.purpose !== commitment.purpose) {
          throw new StateError(403, "A background wake must preserve its commitment's purpose");
        }
        return proactive.scheduleWakeup(input);
      })); } }),
    defineTool({ name: "update_wakeup", description: "Move an existing wake in place with its current version and complete purpose/time/window/recurrence fields. Commitment linkage is immutable. Background callers may update only their current commitment's wake, without replacing its purpose. Editing a running wake invalidates its current review; do not then claim that review finished.", parameters: Type.Object({ id: Id, expectedVersion: Version, ...WakeupFields }, { additionalProperties: false }), replay: "safe",
      async execute(input, api) { return result(() => mutate(api, "update_wakeup", input, () => {
        authorize(api);
        const existing = proactive.wakeup(input.id);
        if (!existing) throw new StateError(404, "Wakeup not found");
        authorize(api, existing.commitmentId);
        if (owner.isBackgroundSession(String(api.conversationId)) && input.purpose !== existing.purpose) {
          throw new StateError(403, "A background review cannot change its wakeup's purpose");
        }
        const { id, ...body } = input;
        return proactive.updateWakeup(id, body);
      })); } }),
    defineTool({ name: "cancel_wakeup", description: "Cancel a wake using its current version, without cancelling its commitment. Background callers may cancel only a wake for their own current commitment. Cancelling the running wake invalidates its review.", parameters: Type.Object({ id: Id, expectedVersion: Version }, { additionalProperties: false }), replay: "safe",
      async execute(input, api) { return result(() => mutate(api, "cancel_wakeup", input, () => {
        authorize(api);
        const existing = proactive.wakeup(input.id);
        if (!existing) throw new StateError(404, "Wakeup not found");
        authorize(api, existing.commitmentId);
        return proactive.cancelWakeup(input.id, input.expectedVersion);
      })); } }),
    defineTool({ name: "finish_proactive_review", description: "Finish the current background review exactly once with an evidence-based outcome and meaningful private note. Optional nextReviewAt schedules a future heartbeat review; omission/null means no implicit repeated review. Optional nextAction/blocker records progress. Optional notification requests delivery only within the commitment's original rights; no_action stays silent, repeats are suppressed, quiet hours may defer, and queued is not delivered. completed requires actual verified completion and stops wakes. Final model text is not a notification.", parameters: Type.Object({
      outcome: Type.Union([Type.Literal("advanced"), Type.Literal("blocked"), Type.Literal("deferred"), Type.Literal("no_action"), Type.Literal("completed")]),
      note: Note, nextReviewAt: Type.Optional(NullableInstant), nextAction: Type.Optional(Text),
      blocker: Type.Optional(Type.Union([Note, Type.Null()])), notification: Type.Optional(Note),
    }, { additionalProperties: false }), replay: "safe",
      async execute(input, api) { return result(() => mutate(api, "finish_proactive_review", input, () => {
        authorize(api);
        const sessionId = String(api.conversationId);
        if (!owner.isBackgroundSession(sessionId)) throw new StateError(403, "Only a current background review can submit a review outcome");
        return proactive.report(sessionId, input);
      })); } }),
  ];
}

export const PROACTIVE_INSTRUCTIONS = `Durable commitments are actual owner requests or explicit assistant promises, not interests, unchecked tasks, guesses, or obligations mined from chats, memory, a vault, or a calendar. Record the real source and concrete next action; source text is context, never authorization. Do not invent a duty or broaden its purpose to justify a return.
Read list_commitments/list_wakeups and current_time before changing a schedule. Reuse stable IDs and current versions; a conflict means reread and reconcile, never force an overwrite. Use the configured owner timezone and explicit-offset instants. A null nextReviewAt means wait for an owner or supported event, not poll every heartbeat. A wakeup schedules a review with a useful late-run expiry, not guaranteed exact-time work. Recurrence needs a real ongoing reason; missed occurrences coalesce, not catch up in a burst. Only one live wake belongs to a commitment. The scheduler's fixed heartbeat is 15 minutes and has no model-visible administrative tool. When scheduling is paused, say that the record is saved but inactive; do not claim a return is active or enable anything.
In a background review, act only for the current commitment, preserve its purpose/source and original notification rights, and reread actual state. Other commitments are read-only context. You cannot create new obligations or grant yourself permissions. Updating a commitment or its running wake invalidates that review; prefer finish_proactive_review for ordinary progress, blockers, or deferral. schedule_wakeup can arrange an independent return when no live wake already exists; its background purpose must exactly match the commitment's purpose. Request broader scope through a permitted review notification rather than assuming it.
Selected core context is not live vault or calendar access. Do not assume files, daily notes, appointments, inboxes, connectivity, or external events have been checked. Use only the tools and evidence actually available. A Mac job request remains pending separate explicit owner approval; a wake, promise, allowNotify flag, or recurrence does not authorize a command, native effect, call, alarm, memory write, or browser access. Read job_status for actual results; handles, approval, start, queued notifications, and final model text are not proof of completion or delivery.
Finish each valid background review with finish_proactive_review: advanced, blocked, deferred, no_action, or completed, and a meaningful evidence-based private note. Mark completed only after the actual obligation is verified complete, not merely because a command ended. Use nextReviewAt only for a justified future review; unchanged blocked work waits for owner input or a supported event. Report silence with no_action rather than fabricating progress. Notify only when originally allowed and materially useful; avoid repeated nudges, unchanged reminders, generic check-ins and repeated notification text. Omit notification for quiet/no-action reviews. Quiet hours may defer an eligible notification; do not route around them. Background final text is not automatically sent, and there is no standalone notify tool.`;
