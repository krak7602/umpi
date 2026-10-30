import { Type, type AssistantMessage, type ToolCall } from "@earendil-works/pi-ai";
import { CompactionTask, GenerationTask, ToolTask, defineTool, hook, type HookRegistration, type ToolExecutionResult, type ToolRegistration } from "@earendil-works/pi-durable";
import { StateError, type Database } from "./store.js";

/**
 * Context policy. Background compaction starts at 550k tokens, as a safety net; the nightly run keeps the owner
 * conversation far below it. The reserve leaves room for a summary of about 26k tokens.
 */
export const CONTEXT_COMPACTION = { reserveTokens: 32_768, backgroundTokens: 417_232 } as const;
/** Tool results above this size keep their start inline; the full text is stored behind a handle. */
export const TOOL_RESULT_INLINE_CHARS = 32_000;
export const TOOL_RESULT_READ_CHARS = 32_000;
const TOOL_PAYLOAD_DAYS = 14;

interface Health {
  contextTokens: number; input: number; cacheRead: number; cacheWrite: number; cacheWrite1h: number; output: number;
  responses: number; cachedResponses: number; lastResponseAt: number | null;
  compactions: number; lastCompaction: { at: number; reason: string; entries: number } | null;
  resets: number; lastResetAt: number | null;
}
const empty = (): Health => ({ contextTokens: 0, input: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, output: 0, responses: 0, cachedResponses: 0, lastResponseAt: null,
  compactions: 0, lastCompaction: null, resets: 0, lastResetAt: null });

/** Per-conversation context size, cache use, compactions and resets. Counts only; never message content. */
export class ContextHealth {
  constructor(private readonly db: Database, private readonly now = () => Date.now()) {
    db.all("CREATE TABLE IF NOT EXISTS umpi_context_health (conversation_id TEXT PRIMARY KEY, data TEXT NOT NULL)");
    db.all("CREATE TABLE IF NOT EXISTS umpi_tool_payloads (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, tool TEXT NOT NULL, created_at INTEGER NOT NULL, text TEXT NOT NULL)");
  }
  read(conversationId: string): Health {
    const row = this.db.all<{ data: string }>("SELECT data FROM umpi_context_health WHERE conversation_id=?", conversationId)[0];
    return row ? { ...empty(), ...JSON.parse(row.data) as Partial<Health> } : empty();
  }
  private update(conversationId: string, change: (health: Health) => Health): void {
    this.db.transaction(() => {
      this.db.all("INSERT INTO umpi_context_health VALUES (?,?) ON CONFLICT(conversation_id) DO UPDATE SET data=excluded.data",
        conversationId, JSON.stringify(change(this.read(conversationId))));
    });
  }
  /** A terminal provider response. Its usage is the size of the request that produced it. */
  responded(conversationId: string, message: Pick<AssistantMessage, "usage">): void {
    const usage = message.usage;
    if (!usage) return;
    const context = usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
    if (context <= 0) return;
    this.update(conversationId, health => ({ ...health, contextTokens: context, input: usage.input, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite,
      cacheWrite1h: usage.cacheWrite1h ?? 0, output: usage.output, responses: health.responses + 1, cachedResponses: health.cachedResponses + (usage.cacheRead > 0 ? 1 : 0), lastResponseAt: this.now() }));
  }
  compacting(conversationId: string, reason: string, entries: number): void {
    this.update(conversationId, health => ({ ...health, compactions: health.compactions + 1, lastCompaction: { at: this.now(), reason, entries } }));
  }
  wasReset(conversationId: string): void {
    this.update(conversationId, health => ({ ...health, contextTokens: 0, resets: health.resets + 1, lastResetAt: this.now() }));
  }
  /** Whether the conversation answered since its last reset, so a reset would clear something. */
  usedSinceReset(conversationId: string): boolean {
    const health = this.read(conversationId);
    return health.lastResponseAt !== null && (health.lastResetAt === null || health.lastResponseAt > health.lastResetAt);
  }

  storePayload(conversationId: string, tool: string, text: string): string {
    const id = `result-${crypto.randomUUID()}`, now = this.now();
    this.db.all("DELETE FROM umpi_tool_payloads WHERE created_at < ?", now - TOOL_PAYLOAD_DAYS * 86_400_000);
    this.db.all("INSERT INTO umpi_tool_payloads VALUES (?,?,?,?,?)", id, conversationId, tool, now, text);
    return id;
  }
  readPayload(conversationId: string, id: string, offset: number, length: number): { tool: string; offset: number; text: string; total: number; more: boolean } {
    const row = this.db.all<{ tool: string; text: string }>("SELECT tool, text FROM umpi_tool_payloads WHERE id=? AND conversation_id=?", id, conversationId)[0];
    if (!row) throw new StateError(404, "That stored result is not available in this conversation (results are kept 14 days)");
    const text = row.text.slice(offset, offset + length);
    return { tool: row.tool, offset, text, total: row.text.length, more: offset + text.length < row.text.length };
  }

  status(conversations: { label: string; id: string | undefined }[]): object[] {
    return conversations.flatMap(({ label, id }) => {
      if (!id) return [];
      const health = this.read(id), iso = (value: number | null) => value === null ? null : new Date(value).toISOString();
      return [{ label, contextTokens: health.contextTokens, lastResponseAt: iso(health.lastResponseAt),
        lastRequest: { input: health.input, cacheRead: health.cacheRead, cacheWrite: health.cacheWrite, cacheWrite1h: health.cacheWrite1h, output: health.output },
        responses: health.responses, cacheHitRate: health.responses ? Math.round(100 * health.cachedResponses / health.responses) / 100 : null,
        compactions: health.compactions, lastCompaction: health.lastCompaction && { ...health.lastCompaction, at: iso(health.lastCompaction.at) },
        resets: health.resets, lastResetAt: iso(health.lastResetAt) }];
    });
  }
}

/** Inline start of a long result, with a handle to the rest. Non-text content is kept as is. */
export function capToolResult(result: ToolExecutionResult, store: (text: string) => string, limit = TOOL_RESULT_INLINE_CHARS): ToolExecutionResult {
  const content = result.content ?? [];
  const text = content.flatMap(part => part.type === "text" ? [part.text] : []).join("\n");
  if (text.length <= limit) return result;
  const handle = store(text);
  const shown = text.slice(0, limit);
  const note = `\n\n[Result truncated: the first ${shown.length} of ${text.length} characters are shown. The full result is stored as ${handle}; call read_tool_result with that handle and offset ${shown.length} to read on.]`;
  return { ...result, content: [{ type: "text", text: shown + note }, ...content.filter(part => part.type !== "text")] };
}

/** What a background session may still be waiting on; a reset would orphan any of these. */
export interface BackgroundWork { activeRun: boolean; pendingOperation: boolean; openJob: boolean; pendingChoice: boolean }
export function mayResetBackground(health: ContextHealth, session: string, work: BackgroundWork): boolean {
  return health.usedSinceReset(session) && !work.activeRun && !work.pendingOperation && !work.openJob && !work.pendingChoice;
}

export interface ContextHooksOptions { health: ContextHealth; isForeground(conversationId: string): boolean }

/** Hooks on the main extension: size tracking, compaction records, and capped tool results in foreground conversations. */
export function contextHooks(options: ContextHooksOptions): HookRegistration[] {
  return [
    hook(GenerationTask, { afterResponse(message, api) { options.health.responded(String(api.conversationId), message); } }),
    hook(CompactionTask, { beforeCompact(compaction, api) { options.health.compacting(String(api.conversationId), compaction.reason, compaction.entries.length); return undefined; } }),
    hook(ToolTask, { afterTool(call: ToolCall, result, api) {
      const conversationId = String(api.conversationId);
      // Background reviews start fresh each run, so their results never accumulate.
      if (call.name === "read_tool_result" || !options.isForeground(conversationId)) return undefined;
      return capToolResult(result, text => options.health.storePayload(conversationId, call.name, text));
    } }),
  ];
}

export function contextTools(health: ContextHealth, isForeground: (conversationId: string) => boolean): ToolRegistration[] {
  return [
    defineTool({ name: "read_tool_result", description: `Read more of a long tool result that was truncated in this conversation, by its handle. Returns up to ${TOOL_RESULT_READ_CHARS} characters from offset.`,
      parameters: Type.Object({ handle: Type.String({ pattern: "^result-[0-9a-f-]{36}$" }), offset: Type.Optional(Type.Integer({ minimum: 0 })) }, { additionalProperties: false }), replay: "safe",
      async execute(input, api) {
        try {
          const conversationId = String(api.conversationId);
          if (!isForeground(conversationId)) throw new StateError(403, "Stored results are for the owner's own conversation");
          return { content: [{ type: "text", text: JSON.stringify(health.readPayload(conversationId, input.handle, input.offset ?? 0, TOOL_RESULT_READ_CHARS)) }] };
        } catch (error) {
          return { isError: true, content: [{ type: "text", text: error instanceof StateError ? error.message : "The stored result could not be read." }] };
        }
      } }),
  ];
}
