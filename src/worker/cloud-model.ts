import type { Api, AssistantMessage, AssistantMessageEvent, Context, Model, Models } from "@earendil-works/pi-ai";
import { InputError, record } from "../shared/protocol.js";
import { StateError, type Database } from "./store.js";

/**
 * The model gateway for cloud machines. Pi on a cloud machine speaks pi-ai's `pi-messages` protocol to Umpi: one
 * POST of `{ model, context, options }`, answered with a stream of server-sent events. Umpi runs the request with its
 * own Claude login, so no model credential enters a container, and only Umpi refreshes it.
 */
export const CLOUD_MODEL_PATH = "/api/cloud/model/messages";
export const CLOUD_MODEL_PROVIDER = "anthropic";
const MAX_REQUEST_BYTES = 24_000_000;

/**
 * Each machine's own model budget. The agent on a machine reads repository content, which can carry instructions, and
 * it can read its gateway token. So one machine, or a copy of its token, can spend only this much of the owner's Claude
 * plan. The limits are several times what real coding work needs: one busy thread makes about four requests a minute
 * and 2,000 a day, and a machine can run a few threads with subagents.
 */
export const CLOUD_MODEL_REQUESTS_PER_MINUTE = 60;
export const CLOUD_MODEL_REQUESTS_PER_DAY = 6_000;
/** Input, output, and cache-write tokens for each UTC day. Cache reads are not counted: they repeat the same context. */
export const CLOUD_MODEL_TOKENS_PER_DAY = 100_000_000;

/** A model request over the machine's budget. The agent gets the message, a code, and when to try again. */
export class CloudModelRefused extends StateError {
  constructor(message: string, readonly code: "cloud_model_minute" | "cloud_model_day", readonly retryAfterSeconds: number) { super(429, message); }
}
/** One admitted request: `spent` records the tokens it used, once known. */
export interface CloudModelAdmission { spent(usage: { input?: number; output?: number; cacheWrite?: number } | undefined): void }
interface CloudModelUsage { day: string; requests: number; tokens: number; minute: string; minuteRequests: number; refused: number; lastUsedAt: string | null; lastRefusedAt: string | null }

/** Counts each machine's model requests and tokens, and refuses requests over the limits above. */
export class CloudModelBudget {
  constructor(private readonly db: Database, private readonly now = () => Date.now()) {
    db.all("CREATE TABLE IF NOT EXISTS umpi_cloud_model_usage (machine_id TEXT PRIMARY KEY, data TEXT NOT NULL)");
  }
  private state(machineId: string): CloudModelUsage {
    const row = this.db.all<{ data: string }>("SELECT data FROM umpi_cloud_model_usage WHERE machine_id=?", machineId)[0];
    const state = row ? JSON.parse(row.data) as CloudModelUsage : undefined;
    const stamp = new Date(this.now()).toISOString(), day = stamp.slice(0, 10), minute = stamp.slice(0, 16);
    // The counts restart with each UTC day and each minute.
    const today = state?.day === day ? state : { day, requests: 0, tokens: 0, minute, minuteRequests: 0, refused: 0, lastUsedAt: state?.lastUsedAt ?? null, lastRefusedAt: state?.lastRefusedAt ?? null };
    return today.minute === minute ? today : { ...today, minute, minuteRequests: 0 };
  }
  private save(machineId: string, state: CloudModelUsage): void {
    this.db.all("INSERT INTO umpi_cloud_model_usage VALUES (?, ?) ON CONFLICT(machine_id) DO UPDATE SET data=excluded.data", machineId, JSON.stringify(state));
  }
  /** Counts one request before it runs, so a lost response still counts; throws `CloudModelRefused` over a limit. */
  admit(machineId: string): CloudModelAdmission {
    const refusal = this.db.transaction(() => {
      const state = this.state(machineId), at = new Date(this.now()).toISOString();
      const untilMinute = 60 - new Date(this.now()).getUTCSeconds(), untilDay = Math.ceil((Date.parse(`${state.day}T00:00:00Z`) + 86_400_000 - this.now()) / 1000);
      const refusal = state.requests >= CLOUD_MODEL_REQUESTS_PER_DAY || state.tokens >= CLOUD_MODEL_TOKENS_PER_DAY
        ? new CloudModelRefused(`This cloud machine has used its model budget for today (${state.requests} requests, ${state.tokens} tokens). The count restarts at 00:00 UTC. Stop and tell the owner; do not retry before then.`, "cloud_model_day", untilDay)
        : state.minuteRequests >= CLOUD_MODEL_REQUESTS_PER_MINUTE
          ? new CloudModelRefused(`This cloud machine made ${CLOUD_MODEL_REQUESTS_PER_MINUTE} model requests in one minute, which is its limit. Wait ${untilMinute} seconds, then continue.`, "cloud_model_minute", untilMinute)
          : undefined;
      this.save(machineId, refusal ? { ...state, refused: state.refused + 1, lastRefusedAt: at } : { ...state, requests: state.requests + 1, minuteRequests: state.minuteRequests + 1, lastUsedAt: at });
      return refusal;
    });
    if (refusal) throw refusal;
    return { spent: usage => {
      const tokens = [usage?.input, usage?.output, usage?.cacheWrite].reduce<number>((sum, value) => sum + (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0), 0);
      if (tokens) this.db.transaction(() => { const state = this.state(machineId); this.save(machineId, { ...state, tokens: state.tokens + tokens }); });
    } };
  }
  /** Removes a deleted machine's counts. */
  forget(machineId: string): void { this.db.all("DELETE FROM umpi_cloud_model_usage WHERE machine_id=?", machineId); }
  status(machineId: string): { day: string; requests: number; tokens: number; refused: number; lastUsedAt: string | null; lastRefusedAt: string | null } {
    const { day, requests, tokens, refused, lastUsedAt, lastRefusedAt } = this.state(machineId);
    return { day, requests, tokens, refused, lastUsedAt, lastRefusedAt };
  }
}

type PiMessagesEvent = Record<string, unknown> & { type: string };

/** pi-ai's own stream events, written as pi-messages events. */
export function piMessagesEvent(event: AssistantMessageEvent): PiMessagesEvent | undefined {
  switch (event.type) {
    case "start": return { type: "start" };
    case "text_start": case "thinking_start": return { type: event.type, contentIndex: event.contentIndex };
    case "text_delta": case "thinking_delta": case "toolcall_delta": return { type: event.type, contentIndex: event.contentIndex, delta: event.delta };
    case "text_end": {
      const part = event.partial.content[event.contentIndex] as { textSignature?: string } | undefined;
      return { type: "text_end", contentIndex: event.contentIndex, content: event.content, ...(part?.textSignature ? { contentSignature: part.textSignature } : {}) };
    }
    case "thinking_end": {
      const part = event.partial.content[event.contentIndex] as { thinkingSignature?: string; redacted?: boolean } | undefined;
      return { type: "thinking_end", contentIndex: event.contentIndex, content: event.content,
        ...(part?.thinkingSignature ? { contentSignature: part.thinkingSignature } : {}), ...(part?.redacted ? { redacted: true } : {}) };
    }
    case "toolcall_start": {
      const part = event.partial.content[event.contentIndex] as { id?: string; name?: string } | undefined;
      return { type: "toolcall_start", contentIndex: event.contentIndex, id: part?.id ?? "", toolName: part?.name ?? "" };
    }
    case "toolcall_end": return { type: "toolcall_end", contentIndex: event.contentIndex, toolCall: event.toolCall };
    case "done": {
      if (event.reason === "deferred") return { type: "error", reason: "error", usage: event.message.usage, errorMessage: "Deferred responses are not supported" };
      return { type: "done", reason: event.reason, usage: event.message.usage, ...(event.message.responseId ? { responseId: event.message.responseId } : {}) };
    }
    case "error": return { type: "error", reason: event.reason, usage: event.error.usage, ...(event.error.errorMessage ? { errorMessage: event.error.errorMessage } : {}) };
  }
}

/**
 * A cloud machine's earlier assistant turns name the gateway as their provider. Naming the real provider again keeps
 * thinking signatures valid across turns instead of being dropped as another provider's.
 */
export function asProviderContext(context: Context, model: Model<Api>): Context {
  return { ...context, messages: context.messages.map(message => message.role === "assistant" && (message as AssistantMessage).api === "pi-messages"
    ? { ...message, api: model.api, provider: model.provider, model: (message as AssistantMessage).model } as AssistantMessage : message) };
}

export interface CloudModelGateway {
  models: Models;
  /** The machine a gateway token belongs to, or undefined. */
  machineFor(token: string): string | undefined;
  /**
   * One request from this machine, before it runs. Notes use, so an idle check knows the machine is working, and
   * counts the request against the machine's budget. Throws `CloudModelRefused` when the machine is over it, or a
   * `StateError` when the machine may not use the gateway now. Returns where to record what the request spent.
   */
  used?(machineId: string): CloudModelAdmission | void;
}

/** Answers one `pi-messages` request. */
export async function cloudModelRequest(request: Request, gateway: CloudModelGateway): Promise<Response> {
  const token = /^Bearer ([A-Za-z0-9_-]{20,200})$/.exec(request.headers.get("authorization") ?? "")?.[1];
  const machine = token ? gateway.machineFor(token) : undefined;
  if (!machine) throw new StateError(401, "Unknown cloud machine");
  const length = Number(request.headers.get("content-length") ?? "0");
  if (length > MAX_REQUEST_BYTES) throw new StateError(413, "Request too large");
  const text = await request.text();
  if (text.length > MAX_REQUEST_BYTES) throw new StateError(413, "Request too large");
  let body: Record<string, unknown>;
  try { body = record(JSON.parse(text)); } catch { throw new InputError("Invalid model request"); }
  if (typeof body.model !== "string") throw new InputError("model is required");
  const model = gateway.models.getModel(CLOUD_MODEL_PROVIDER, body.model);
  if (!model) throw new InputError(`Unknown model ${body.model.slice(0, 80)}`);
  const context = record(body.context) as unknown as Context;
  if (!Array.isArray(context.messages)) throw new InputError("context.messages is required");
  const options = record(body.options ?? {});
  let admission: CloudModelAdmission | void;
  try { admission = gateway.used?.(machine); }
  catch (error) {
    if (!(error instanceof CloudModelRefused)) throw error;
    // The shape pi-ai's `pi-messages` client reads, so the agent sees the reason and not a bare status.
    return Response.json({ error: { message: error.message, code: error.code } }, { status: 429, headers: { "retry-after": String(error.retryAfterSeconds), "cache-control": "no-store" } });
  }
  const events = gateway.models.streamSimple(model, asProviderContext(context, model), {
    signal: request.signal,
    ...(typeof options.maxTokens === "number" ? { maxTokens: options.maxTokens } : {}),
    ...(typeof options.temperature === "number" ? { temperature: options.temperature } : {}),
    ...(typeof options.reasoning === "string" ? { reasoning: options.reasoning as never } : {}),
    ...(options.toolChoice !== undefined ? { toolChoice: options.toolChoice as never } : {}),
    ...(typeof options.sessionId === "string" ? { sessionId: options.sessionId.slice(0, 200) } : {}),
    ...(options.cacheRetention === "short" || options.cacheRetention === "long" || options.cacheRetention === "none" ? { cacheRetention: options.cacheRetention } : {}),
  });
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const event of events) {
          const out = piMessagesEvent(event);
          if (out) controller.enqueue(encoder.encode(`data: ${JSON.stringify(out)}\n\n`));
          if (event.type === "done") admission?.spent(event.message.usage);
          if (event.type === "error") admission?.spent(event.error.usage);
          if (event.type === "done" || event.type === "error") break;
        }
      } catch (error) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "error", reason: "error", usage: emptyUsage(), errorMessage: error instanceof Error ? error.message.slice(0, 300) : "Model request failed" })}\n\n`));
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-store" } });
}

function emptyUsage() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}
