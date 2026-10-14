import { InputError, boundedText, identifier, record, timestamp } from "./protocol.js";

export type FieldValue = string | number | boolean | null;
export const CAPABILITY_IDS = ["alarm.schedule", "alarm.cancel", "notification.schedule", "notification.cancel", "activity.track"] as const;
export type CapabilityId = typeof CAPABILITY_IDS[number];
export interface Capability { id: CapabilityId; version: 1; status: "available" | "permission_required" | "unsupported"; reason?: string }
export interface FieldDefinition { id: string; label: string; kind: "text" | "multiline" | "toggle" | "number" | "date" | "choice"; options?: { id: string; label: string }[] }
export type Binding = { fieldId: string } | { value: FieldValue };
export interface WorkflowStep { kind: "set_value" | "device_action" | "message"; fieldId?: string; value?: FieldValue; capability?: CapabilityId; input?: Record<string, Binding>; text?: string; when?: { fieldId: string; equals: FieldValue } }
export interface WorkflowButton { id: string; title: string; steps: WorkflowStep[] }
export interface WorkflowDefinition { id: string; title: string; description?: string; fields: FieldDefinition[]; actions: WorkflowButton[] }
export interface Workflow { id: string; revision: number; definition: WorkflowDefinition; values: Record<string, FieldValue>; archived: boolean; updatedAt: string }
export interface CompanionMutation { operationId: string; workflowId: string; expectedRevision: number; kind: "create" | "define" | "set_values" | "archive" | "restore" | "remove"; definition?: WorkflowDefinition; values?: Record<string, FieldValue> }
export interface WorkflowTombstone { id: string; revision: number; removed: true; updatedAt: string }
export type MutationReceipt = Workflow | WorkflowTombstone;
export type ActionStatus = "pending" | "applied" | "failed" | "permission_required" | "unsupported" | "conflict" | "uncertain";
export interface DeviceAction { id: string; deviceId: string; capability: CapabilityId; input: Record<string, FieldValue>; status: ActionStatus; createdAt: string; updatedAt: string; result?: string }
export interface ActionRequest { id: string; deviceId: string; capability: CapabilityId; input: Record<string, FieldValue> }
export interface Device { id: string; label: string; capabilities: Capability[]; lastSeenAt: string; revoked: boolean }
export interface DeviceRegistration { capabilities: Capability[]; apnsToken?: string; apnsEnvironment?: "sandbox" | "production"; activityTokens?: { jobId: string; token: string }[]; activityJobIds?: string[] }
export interface PairClaim { code: string; deviceId: string; label: string; token: string; capabilities: Capability[] }

export function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new InputError("Unexpected companion field");
}
function list(value: unknown, max: number, label: string): unknown[] {
  if (!Array.isArray(value) || value.length > max) throw new InputError(`Invalid ${label}; maximum ${max}`);
  return value;
}
function unique<T extends { id: string }>(items: T[]): T[] {
  if (new Set(items.map(item => item.id)).size !== items.length) throw new InputError("Duplicate companion identifier");
  return items;
}
export function revision(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new InputError("Invalid revision");
  return value;
}
export function fieldValue(value: unknown): FieldValue {
  if (value === null || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) return value;
  if (typeof value === "string" && value.length <= 16_384 && !value.includes("\0")) return value;
  throw new InputError("Invalid field value");
}
export function fieldValues(value: unknown, max = 128): Record<string, FieldValue> {
  const entries = Object.entries(record(value));
  if (entries.length > max) throw new InputError("Too many field values");
  return Object.fromEntries(entries.map(([key, val]) => [identifier(key, "field ID"), fieldValue(val)]));
}
function capabilityId(value: unknown): CapabilityId {
  if (!(CAPABILITY_IDS as readonly unknown[]).includes(value)) throw new InputError("Unsupported capability");
  return value as CapabilityId;
}
export function parseCapabilities(value: unknown): Capability[] {
  return unique(list(value, 5, "capabilities").map(item => {
    const input = record(item); exactKeys(input, ["id", "version", "status", "reason"]);
    if (input.version !== 1 || typeof input.status !== "string" || !["available", "permission_required", "unsupported"].includes(input.status)) throw new InputError("Invalid capability descriptor");
    return { id: capabilityId(input.id), version: 1 as const, status: input.status as Capability["status"], ...(input.reason === undefined ? {} : { reason: boundedText(input.reason, 512, "capability reason") }) };
  }));
}
export function parseDefinition(value: unknown): WorkflowDefinition {
  const input = record(value); exactKeys(input, ["id", "title", "description", "fields", "actions"]);
  const fields = unique(list(input.fields, 32, "workflow fields").map(item => {
    const f = record(item); exactKeys(f, ["id", "label", "kind", "options"]);
    if (typeof f.kind !== "string" || !["text", "multiline", "toggle", "number", "date", "choice"].includes(f.kind)) throw new InputError("Invalid field kind");
    const result: FieldDefinition = { id: identifier(f.id), label: boundedText(f.label, 128, "field label"), kind: f.kind as FieldDefinition["kind"] };
    if (f.kind === "choice") {
      result.options = unique(list(f.options, 32, "choice options").map(option => {
        const o = record(option); exactKeys(o, ["id", "label"]);
        return { id: identifier(o.id), label: boundedText(o.label, 128, "option label") };
      }));
      if (!result.options.length) throw new InputError("Choice field needs options");
    } else if (f.options !== undefined) throw new InputError("Only choice fields accept options");
    return result;
  }));
  const fieldId = (value: unknown): string => {
    const id = identifier(value, "bound field ID");
    if (!fields.some(field => field.id === id)) throw new InputError("Binding references an unknown field");
    return id;
  };
  const actions = unique(list(input.actions, 16, "workflow actions").map(item => {
    const a = record(item); exactKeys(a, ["id", "title", "steps"]);
    const steps: WorkflowStep[] = list(a.steps, 16, "workflow steps").map(item => {
      const s = record(item);
      let step: WorkflowStep;
      if (s.kind === "set_value") {
        exactKeys(s, ["kind", "fieldId", "value", "when"]);
        step = { kind: "set_value", fieldId: fieldId(s.fieldId), value: fieldValue(s.value) };
      } else if (s.kind === "message") {
        exactKeys(s, ["kind", "text", "when"]);
        step = { kind: "message", text: boundedText(s.text, 16_384, "message step") };
      } else if (s.kind === "device_action") {
        exactKeys(s, ["kind", "capability", "input", "when"]);
        const bindings = Object.entries(record(s.input));
        if (bindings.length > 8) throw new InputError("Too many action bindings");
        step = { kind: "device_action", capability: capabilityId(s.capability), input: Object.fromEntries(bindings.map(([key, value]) => {
          const b = record(value); exactKeys(b, ["fieldId", "value"]);
          if (("fieldId" in b) === ("value" in b)) throw new InputError("A binding needs exactly one source");
          return [identifier(key), "fieldId" in b ? { fieldId: fieldId(b.fieldId) } : { value: fieldValue(b.value) }];
        })) };
        const keys = Object.keys(step.input!);
        if (keys.length !== ACTION_KEYS[step.capability!].length || ACTION_KEYS[step.capability!].some(key => !keys.includes(key))) throw new InputError("Invalid capability input bindings");
      } else throw new InputError("Invalid workflow step kind");
      if (s.when !== undefined) {
        const w = record(s.when); exactKeys(w, ["fieldId", "equals"]);
        step.when = { fieldId: fieldId(w.fieldId), equals: fieldValue(w.equals) };
      }
      return step;
    });
    if (!steps.length) throw new InputError("An action needs at least one step");
    return { id: identifier(a.id), title: boundedText(a.title, 128, "action title"), steps };
  }));
  return { id: identifier(input.id), title: boundedText(input.title, 256, "workflow title"), ...(input.description === undefined ? {} : { description: boundedText(input.description, 2_048, "workflow description") }), fields, actions };
}
export function parseMutation(value: unknown): CompanionMutation {
  const input = record(value); exactKeys(input, ["operationId", "workflowId", "expectedRevision", "kind", "definition", "values"]);
  if (typeof input.kind !== "string" || !["create", "define", "set_values", "archive", "restore", "remove"].includes(input.kind)) throw new InputError("Invalid mutation kind");
  const result: CompanionMutation = { operationId: identifier(input.operationId, "operation ID"), workflowId: identifier(input.workflowId, "workflow ID"), expectedRevision: revision(input.expectedRevision), kind: input.kind as CompanionMutation["kind"] };
  if (result.kind === "create" || result.kind === "define") {
    result.definition = parseDefinition(input.definition);
    if (result.definition.id !== result.workflowId) throw new InputError("Definition ID must match workflow ID");
  } else if (input.definition !== undefined) throw new InputError("This mutation cannot change a definition");
  if (result.kind === "set_values" || (result.kind === "create" && input.values !== undefined)) result.values = fieldValues(input.values);
  else if (input.values !== undefined) throw new InputError("This mutation cannot change values");
  if (result.kind === "create" && result.expectedRevision !== 0) throw new InputError("Creation requires revision zero");
  return result;
}
const ACTION_KEYS: Record<CapabilityId, string[]> = {
  "alarm.schedule": ["alarmId", "title", "date"], "alarm.cancel": ["alarmId"],
  "notification.schedule": ["notificationId", "title", "body", "date"], "notification.cancel": ["notificationId"], "activity.track": ["jobId"],
};
export function parseAction(value: unknown, deviceId?: string): ActionRequest {
  const input = record(value); exactKeys(input, deviceId === undefined ? ["id", "deviceId", "capability", "input"] : ["id", "capability", "input"]);
  const capability = capabilityId(input.capability);
  const args = record(input.input); exactKeys(args, ACTION_KEYS[capability]);
  const values: Record<string, FieldValue> = {};
  for (const key of ACTION_KEYS[capability]) {
    if (key === "alarmId") {
      const id = boundedText(args[key], 36, "alarm ID");
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new InputError("Alarm ID must be a UUID");
      values[key] = id;
    } else if (key === "notificationId" || key === "jobId") values[key] = identifier(args[key], key);
    else if (key === "date") values[key] = timestamp(boundedText(args[key], 64, "action date"), "action date");
    else if (key === "body" && args[key] === "") values[key] = "";
    else values[key] = boundedText(args[key], key === "title" ? 256 : 4_096, key);
  }
  return { id: identifier(input.id, "action ID"), deviceId: identifier(deviceId ?? input.deviceId, "device ID"), capability, input: values };
}
export function parseAck(value: unknown): { status: Exclude<ActionStatus, "pending">; result?: string } {
  const input = record(value); exactKeys(input, ["status", "result"]);
  if (typeof input.status !== "string" || !["applied", "failed", "permission_required", "unsupported", "conflict", "uncertain"].includes(input.status)) throw new InputError("Invalid action acknowledgement");
  return { status: input.status as Exclude<ActionStatus, "pending">, ...(input.result === undefined ? {} : { result: boundedText(input.result, 2_048, "action result") }) };
}
export function credential(value: unknown): string {
  if (typeof value !== "string" || !/^(?:[A-Fa-f0-9]{64}|[A-Za-z0-9_-]{43})$/.test(value)) throw new InputError("Invalid device credential");
  return value;
}
export function parsePairClaim(value: unknown): PairClaim {
  const input = record(value); exactKeys(input, ["code", "deviceId", "label", "token", "capabilities"]);
  return { code: credential(input.code), deviceId: identifier(input.deviceId, "device ID"), label: boundedText(input.label, 128, "device label"), token: credential(input.token), capabilities: parseCapabilities(input.capabilities) };
}
export function parseRegistration(value: unknown): DeviceRegistration {
  const input = record(value); exactKeys(input, ["capabilities", "apnsToken", "apnsEnvironment", "activityTokens", "activityJobIds"]);
  const result: DeviceRegistration = { capabilities: parseCapabilities(input.capabilities) };
  const pushToken = (value: unknown): string => {
    if (typeof value !== "string" || !/^[a-fA-F0-9]{32,512}$/.test(value) || value.length % 2) throw new InputError("Invalid push token");
    return value;
  };
  if (input.apnsToken !== undefined) result.apnsToken = pushToken(input.apnsToken);
  if (input.apnsEnvironment !== undefined) {
    if (input.apnsEnvironment !== "sandbox" && input.apnsEnvironment !== "production") throw new InputError("Invalid push environment");
    result.apnsEnvironment = input.apnsEnvironment;
  }
  if (input.activityTokens !== undefined) {
    result.activityTokens = list(input.activityTokens, 16, "activity tokens").map(value => {
      const item = record(value); exactKeys(item, ["jobId", "token"]);
      return { jobId: identifier(item.jobId, "activity job ID"), token: pushToken(item.token) };
    });
    if (new Set(result.activityTokens.map(item => item.jobId)).size !== result.activityTokens.length) throw new InputError("Duplicate activity job ID");
  }
  if (input.activityJobIds !== undefined) {
    result.activityJobIds = list(input.activityJobIds, 16, "activity job IDs").map(value => identifier(value, "activity job ID"));
    if (new Set(result.activityJobIds).size !== result.activityJobIds.length) throw new InputError("Duplicate activity job ID");
  }
  return result;
}
