import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type, createModels, fauxProvider, fauxAssistantMessage, fauxToolCall, type Message } from "@earendil-works/pi-ai";
import { createRegistry, defineTool, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { Database } from "../src/worker/store.js";
import { CONTEXT_COMPACTION, ContextHealth, TOOL_RESULT_INLINE_CHARS, capToolResult, contextHooks, contextTools, mayResetBackground } from "../src/worker/context-health.js";

const context = BACKGROUND_CONTEXT;

function database(t: TestContext): Database {
  const sqlite = new DatabaseSync(":memory:"); t.after(() => sqlite.close());
  return { all: <T extends object>(query: string, ...bindings: (string | number | null)[]) => sqlite.prepare(query).all(...bindings) as T[], transaction: <T>(run: () => T) => run() };
}

test("background compaction starts at 550k tokens of a 1M window, leaving room for a long summary", () => {
  const blocking = 1_000_000 - CONTEXT_COMPACTION.reserveTokens;
  assert.equal(blocking - CONTEXT_COMPACTION.backgroundTokens, 550_000);
  assert.ok(Math.floor(0.8 * CONTEXT_COMPACTION.reserveTokens) >= 26_000);
});

test("context health records size, cache use, compactions and resets, and gates background resets", t => {
  let now = Date.parse("2026-10-30T10:00:00Z");
  const health = new ContextHealth(database(t), () => now);
  const usage = (input: number, cacheRead: number, cacheWrite: number) => ({ input, output: 500, cacheRead, cacheWrite, cacheWrite1h: cacheWrite, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
  health.responded("c1", { usage: usage(2_000, 0, 40_000) });
  now += 60_000;
  health.responded("c1", { usage: usage(1_000, 40_000, 2_000) });
  health.compacting("c1", "threshold", 120);
  const [status] = health.status([{ label: "telegram", id: "c1" }, { label: "control", id: undefined }]) as Record<string, unknown>[];
  assert.deepEqual(status, { label: "telegram", contextTokens: 43_500, lastResponseAt: "2026-10-30T10:01:00.000Z",
    lastRequest: { input: 1_000, cacheRead: 40_000, cacheWrite: 2_000, cacheWrite1h: 2_000, output: 500 }, responses: 2, cacheHitRate: 0.5,
    compactions: 1, lastCompaction: { at: "2026-10-30T10:01:00.000Z", reason: "threshold", entries: 120 }, resets: 0, lastResetAt: null });

  const idle = { activeRun: false, pendingOperation: false, openJob: false, pendingChoice: false };
  assert.equal(mayResetBackground(health, "c1", idle), true);
  for (const blocker of ["activeRun", "pendingOperation", "openJob", "pendingChoice"] as const) {
    assert.equal(mayResetBackground(health, "c1", { ...idle, [blocker]: true }), false, `${blocker} keeps the context`);
  }
  now += 1_000; health.wasReset("c1");
  assert.equal(mayResetBackground(health, "c1", idle), false, "nothing new to clear");
  assert.equal(mayResetBackground(health, "never-used", idle), false);
  now += 1_000; health.responded("c1", { usage: usage(500, 0, 0) });
  assert.equal(mayResetBackground(health, "c1", idle), true);
});

test("long tool results keep their start inline and the rest behind a handle scoped to the conversation", t => {
  const health = new ContextHealth(database(t));
  const short = { content: [{ type: "text" as const, text: "small" }] };
  assert.equal(capToolResult(short, () => { throw new Error("not stored"); }), short);
  const text = "a".repeat(TOOL_RESULT_INLINE_CHARS) + "b".repeat(10_000);
  const capped = capToolResult({ content: [{ type: "text", text }] }, full => health.storePayload("c1", "read_activity", full));
  const inline = capped.content![0]!;
  assert.ok(inline.type === "text" && inline.text.startsWith("a".repeat(TOOL_RESULT_INLINE_CHARS) + "\n\n[Result truncated"));
  const handle = /stored as (result-[0-9a-f-]{36})/.exec(inline.type === "text" ? inline.text : "")?.[1]!;
  const rest = health.readPayload("c1", handle, TOOL_RESULT_INLINE_CHARS, 32_000);
  assert.deepEqual({ ...rest, text: rest.text.length }, { tool: "read_activity", offset: TOOL_RESULT_INLINE_CHARS, text: 10_000, total: text.length, more: false });
  assert.throws(() => health.readPayload("other-conversation", handle, 0, 10), /not available/);
});

test("the hooks track a real conversation, cap foreground tool results, and record compaction", { timeout: 20_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), "umpi-context-health-"));
  const models = createModels();
  const faux = fauxProvider({ provider: "context-health-test", tokensPerSecond: Infinity });
  models.setProvider(faux.provider);
  const sqlite = new DatabaseSync(":memory:"); t.after(() => sqlite.close());
  const db: Database = { all: <T extends object>(query: string, ...bindings: (string | number | null)[]) => sqlite.prepare(query).all(...bindings) as T[], transaction: <T>(run: () => T) => run() };
  const health = new ContextHealth(db);
  const background = new Set<string>();
  const isForeground = (id: string) => !background.has(id);
  const big = defineTool({ name: "big_read", description: "Returns a long result", parameters: Type.Object({}), replay: "safe",
    async execute() { return { content: [{ type: "text", text: "x".repeat(TOOL_RESULT_INLINE_CHARS + 5_000) }] }; } });
  const registry = createRegistry();
  const extension = { name: "umpi", hooks: contextHooks({ health, isForeground }), tools: [big, ...contextTools(health, isForeground)] };
  registry.install(extension);
  const harness = await Harness.open(await openNodeSqliteStorage(join(directory, "state.sqlite")), { models, registry, settings: { extensions: [extension], compaction: { enabled: false, keepRecentTokens: 1 }, retry: { enabled: false } } }, context);
  t.after(async () => { await harness.close(context); await rm(directory, { recursive: true, force: true }); });
  const model = faux.getModel();
  const start = () => harness.root(context, { agent: { model: { provider: model.provider, modelId: model.id }, thinkingLevel: "off" } });

  const root = await start();
  const id = String(root.id);
  let seen: Message[] = [];
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("big_read", {}), { stopReason: "toolUse" }),
    request => { seen = [...request.messages]; return fauxAssistantMessage("Read it."); },
  ]);
  assert.equal((await (await root.submit({ type: "input", content: "Read the big thing." }, context)).wait(context)).status, "done");
  const result = seen.find(message => message.role === "toolResult");
  const text = result && result.role === "toolResult" ? result.content.map(part => part.type === "text" ? part.text : "").join("") : "";
  assert.match(text, /Result truncated: the first 32000 of 37000 characters/);
  assert.ok(text.length < TOOL_RESULT_INLINE_CHARS + 400, "the model sees only the start");
  const [tracked] = health.status([{ label: "root", id }]) as { responses: number; contextTokens: number }[];
  assert.equal(tracked!.responses, 2); assert.ok(tracked!.contextTokens > 0);

  const handle = /stored as (result-[0-9a-f-]{36})/.exec(text)![1]!;
  let followUp = "";
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("read_tool_result", { handle, offset: TOOL_RESULT_INLINE_CHARS }), { stopReason: "toolUse" }),
    request => { const last = request.messages.findLast(message => message.role === "toolResult"); followUp = last && last.role === "toolResult" && last.content[0]?.type === "text" ? last.content[0].text : ""; return fauxAssistantMessage("Done."); },
  ]);
  assert.equal((await (await root.submit({ type: "input", content: "Read the rest." }, context)).wait(context)).status, "done");
  assert.equal(JSON.parse(followUp).text.length, 5_000);

  faux.setResponses([fauxAssistantMessage("Summary of a synthetic exercise.")]);
  const task = await root.compact(undefined, context);
  assert.equal((await harness.waitForTask(task, context)).state.outcome.status, "completed");
  assert.equal((health.status([{ label: "root", id }])[0] as { compactions: number; lastCompaction: { reason: string } }).lastCompaction.reason, "manual");

  background.add(id);
  faux.setResponses([fauxAssistantMessage(fauxToolCall("big_read", {}), { stopReason: "toolUse" }), request => { seen = [...request.messages]; return fauxAssistantMessage("Background read."); }]);
  assert.equal((await (await root.submit({ type: "input", content: "Background review." }, context)).wait(context)).status, "done");
  const uncapped = seen.findLast(message => message.role === "toolResult");
  assert.ok(uncapped && uncapped.role === "toolResult" && uncapped.content[0]?.type === "text" && uncapped.content[0].text.length === TOOL_RESULT_INLINE_CHARS + 5_000, "background results are not capped");
});
