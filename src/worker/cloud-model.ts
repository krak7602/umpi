import type { Api, AssistantMessage, AssistantMessageEvent, Context, Model, Models } from "@earendil-works/pi-ai";
import { InputError, record } from "../shared/protocol.js";
import { StateError } from "./store.js";

/**
 * The model gateway for cloud machines. Pi on a cloud machine speaks pi-ai's `pi-messages` protocol to Umpi: one
 * POST of `{ model, context, options }`, answered with a stream of server-sent events. Umpi runs the request with its
 * own Claude login, so no model credential enters a container, and only Umpi refreshes it.
 */
export const CLOUD_MODEL_PATH = "/api/cloud/model/messages";
export const CLOUD_MODEL_PROVIDER = "anthropic";
const MAX_REQUEST_BYTES = 24_000_000;

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
  /** Notes use, so an idle check knows the machine is working. */
  used?(machineId: string): void;
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
  gateway.used?.(machine);
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
