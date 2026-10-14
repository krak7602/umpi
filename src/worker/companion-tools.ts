import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolExecutionApi, type ToolExecutionResult, type ToolRegistration } from "@earendil-works/pi-durable";
import { InputError } from "../shared/protocol.js";
import { CAPABILITY_IDS } from "../shared/companion.js";
import { CompanionStore, companionHash } from "./companion-store.js";
import { StateError } from "./store.js";

const Id = Type.String({ minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9][A-Za-z0-9_.:-]*$" });
const Value = Type.Union([Type.String({ maxLength: 16_384 }), Type.Number(), Type.Boolean(), Type.Null()]);
const Capability = Type.Union(CAPABILITY_IDS.map(id => Type.Literal(id)));
const Binding = Type.Union([Type.Object({ fieldId: Id }, { additionalProperties: false }), Type.Object({ value: Value }, { additionalProperties: false })]);
const Step = Type.Object({
  kind: Type.Union([Type.Literal("set_value"), Type.Literal("device_action"), Type.Literal("message")]),
  fieldId: Type.Optional(Id), value: Type.Optional(Value), capability: Type.Optional(Capability),
  input: Type.Optional(Type.Record(Type.String(), Binding, { maxProperties: 8 })),
  text: Type.Optional(Type.String({ minLength: 1, maxLength: 16_384 })),
  when: Type.Optional(Type.Object({ fieldId: Id, equals: Value }, { additionalProperties: false })),
}, { additionalProperties: false });
const Definition = Type.Object({
  id: Id, title: Type.String({ minLength: 1, maxLength: 256 }), description: Type.Optional(Type.String({ minLength: 1, maxLength: 2_048 })),
  fields: Type.Array(Type.Object({ id: Id, label: Type.String({ minLength: 1, maxLength: 128 }),
    kind: Type.Union(["text", "multiline", "toggle", "number", "date", "choice"].map(kind => Type.Literal(kind))),
    options: Type.Optional(Type.Array(Type.Object({ id: Id, label: Type.String({ minLength: 1, maxLength: 128 }) }, { additionalProperties: false }), { maxItems: 32 })),
  }, { additionalProperties: false }), { maxItems: 32 }),
  actions: Type.Array(Type.Object({ id: Id, title: Type.String({ minLength: 1, maxLength: 128 }), steps: Type.Array(Step, { minItems: 1, maxItems: 16 }) }, { additionalProperties: false }), { maxItems: 16 }),
}, { additionalProperties: false });

export function companionTools(store: CompanionStore, wake: () => Promise<void>): ToolRegistration[] {
  async function result(run: () => Promise<unknown> | unknown): Promise<ToolExecutionResult> {
    try { return { content: [{ type: "text", text: JSON.stringify(await run()) }] }; }
    catch (error) {
      return { isError: true, content: [{ type: "text", text: error instanceof InputError || error instanceof StateError ? error.message : "Companion change could not be persisted. Read current state; do not claim success." }] };
    }
  }
  async function mutate(api: ToolExecutionApi, input: unknown, run: () => unknown): Promise<unknown> {
    await wake();
    const hash = companionHash(JSON.stringify(input));
    const receipt = store.owner.effect(`companion-tool:${api.conversationId}:${api.taskId}`, () => ({ hash, result: run() }));
    if (receipt.hash !== hash) throw new StateError(409, "Tool task already contains a different request");
    return receipt.result;
  }
  return [
    defineTool({ name: "read_companion_state", description: "Read durable native workflows, preserved owner values and revisions, paired device capabilities/last-seen time, requested device effects and actual acknowledgements, jobs, choices and operations. Offline drafts are NOT in this snapshot. Read before editing; last seen is not proof of current connectivity.", parameters: Type.Object({}), replay: "safe",
      async execute() { return result(() => store.snapshot()); } }),
    defineTool({ name: "update_companion", description: "Apply an explicit typed workflow mutation against its current revision. Definition edits preserve saved values. set_values merges only supplied fields; null clears explicitly. Archive, restore and remove are explicit distinct operations. Never infer deletion or cleanup; destructive changes require the owner's explicit request. Use a stable operationId for exact retries; stale edits conflict. Buttons cannot approve jobs or grant permissions.", parameters: Type.Object({
      operationId: Id, workflowId: Id, expectedRevision: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
      kind: Type.Union(["create", "define", "set_values", "archive", "restore", "remove"].map(kind => Type.Literal(kind))),
      definition: Type.Optional(Definition), values: Type.Optional(Type.Record(Type.String(), Value, { maxProperties: 128 })),
    }, { additionalProperties: false }), replay: "safe",
      async execute(input, api) { return result(() => mutate(api, input, () => store.mutate(input, "model"))); } }),
    defineTool({ name: "request_device_action", description: "Request an actual advertised native device capability with stable id and explicit deviceId. Inputs: alarm.schedule {alarmId:UUID,title,date:ISOinstant}; alarm.cancel {alarmId}; notification.schedule {notificationId,title,body,date}; notification.cancel {notificationId}; activity.track {jobId:existing job}. Returns pending, NOT applied; APNs acceptance and cloud persistence are never effect completion. Native permission and trusted remote-effect consent still apply. Never substitute this for Mac job approval.", parameters: Type.Object({ id: Id, deviceId: Id, capability: Capability, input: Type.Record(Type.String(), Value, { maxProperties: 8 }) }, { additionalProperties: false }), replay: "safe",
      async execute(input, api) { return result(() => mutate(api, input, () => store.requestAction(input))); } }),
  ];
}

export const COMPANION_INSTRUCTIONS = `The native Umpi companion renders shipped, bounded workflow definitions; it cannot run downloaded code or control arbitrary apps. Read read_companion_state before any change. Preserve stable IDs, saved values, owner drafts and unrelated fields. Omission never means deletion. Definition changes preserve even hidden field values; use explicit set_values with null to clear. Only explicit owner intent permits archive/remove; never guess cleanup. Use current revisions and stable operation/action IDs, stop on conflicts, reread and reconcile instead of forcing an overwrite. Offline drafts are not visible to the coordinator; lastSeenAt and serverTime qualify freshness. Local buttons can set values, request implemented device actions, or send ordinary messages; they can never approve a Mac job, grant permission or pair/revoke a device. Pairing credentials are never available through tools. Request only capabilities actually advertised by the target phone. Permission-required means the app must ask the owner. A requested action stays pending until a device acknowledgement; notification delivery, APNs acceptance, and Live Activity updates are not alarm registration or task completion. Use the app's fixed trusted review or existing owner approval channel for exact-version Mac approvals.`;
