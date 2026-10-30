import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { ContextHealth, contextHooks } from "../src/worker/context-health.js";
import { Decisions, type WorkersAi } from "../src/worker/decisions.js";
import { DreamStore, weekOf } from "../src/worker/dream-store.js";
import { DreamRuntime, dreamInputs, historyTools, refExists, transcript } from "../src/worker/dream-tools.js";
import { HistoryIndex } from "../src/worker/history-index.js";
import { DREAM_PART_CHARS, LONG_DAY_TOKENS } from "../src/worker/dream-store.js";
import { MailStore } from "../src/worker/mail-store.js";
import { ProactiveStore } from "../src/worker/proactive-store.js";
import { SituationStore } from "../src/worker/situation-store.js";
import { Store, type Database } from "../src/worker/store.js";

const TZ = "Asia/Kolkata";
// 2026-10-30 23:00 local.
const EVENING = Date.parse("2026-10-30T17:30:00Z");
const NIGHT = Date.parse("2026-10-30T20:30:00Z"); // 02:00 local on the 31st

function fixture(t: TestContext, now = EVENING) {
  t.mock.timers.enable({ apis: ["Date"], now });
  const sqlite = new DatabaseSync(":memory:"); let depth = 0; t.after(() => sqlite.close());
  const db: Database = {
    all: <T extends object>(query: string, ...bindings: (string | number | null)[]) => sqlite.prepare(query).all(...bindings) as T[],
    transaction<T>(run: () => T): T {
      const name = `d_${depth++}`; sqlite.exec(`SAVEPOINT ${name}`);
      try { const value = run(); sqlite.exec(`RELEASE ${name}`); return value; }
      catch (error) { sqlite.exec(`ROLLBACK TO ${name}; RELEASE ${name}`); throw error; }
      finally { depth--; }
    },
  };
  const owner = new Store(db); owner.setSession("telegram", "owner"); owner.registerBackgroundSession("dream-review", "telegram");
  const proactive = new ProactiveStore(owner, TZ); proactive.configure({ expectedVersion: 1, enabled: true, quietHours: null }, now);
  const situation = new SituationStore(db, TZ), mail = new MailStore(proactive, situation), dream = new DreamStore(proactive);
  dream.refExists = ref => refExists({ dream, mail }, ref);
  return { db, owner, proactive, situation, mail, dream, time(at: number) { t.mock.timers.setTime(at); } };
}
type Fixture = ReturnType<typeof fixture>;
function openNight(f: Fixture, now: number) {
  f.proactive.drive(now, false, { telegram: "dream-review" });
  const run = f.proactive.runForSession("dream-review")!;
  f.owner.submitted(run.operationId);
  return run;
}
const message = (role: string, text: string, at: number) => ({ model: [{ role, content: [{ type: "text", text }], timestamp: at }] });
const RESULT = (overrides: Record<string, unknown> = {}) => ({
  digest: { summary: "Built the decision service with Clef and Clairic; deployed it; the owner chose Clef-flash for price.", decisions: ["Use Clef-flash for mail screening"],
    standingInstructions: ["No need to mention that in the documents"], openLoops: [{ ref: "r1", text: "Stretch reminder" }, { ref: "gone", text: "Removed record" }, { ref: null, text: "Check the first Clairic fact" }],
    people: [], topics: ["decision models"] },
  week: "This week: context work, knocks, decision models.", probes: [{ question: "Which Clef model screens mail?", answer: "Clef-flash." }, { question: "What was the monthly decision budget?", answer: "One US dollar." }],
  lessons: [{ op: "add", text: "Do not mention usage limits in documents.", evidence: "No need to mention that in the documents" }],
  overnight: { whileYouSlept: ["Looked up the Clairic preview status: still preview (Cloudflare docs)."], tomorrow: ["Confirm the first recorded mail fact."] },
  ...overrides,
});

test("the night closes the previous day at 02:00, reads the owner's day, and commits a digest, lessons, and morning notes", async t => {
  const f = fixture(t);
  assert.equal(f.dream.nextDue(EVENING), undefined, "the nightly run starts disabled");
  f.dream.configure({ expectedVersion: 1, enabled: true }, "owner", EVENING);
  assert.equal(f.dream.due(EVENING), false);
  assert.equal(new Date(f.dream.nextDue(EVENING)!).toISOString(), "2026-10-30T20:30:00.000Z", "02:00 local");
  f.owner.createReminder("r1", "Stretch", new Date(NIGHT + 86_400_000).toISOString(), "telegram");

  f.time(NIGHT); f.dream.drive(NIGHT);
  assert.equal(f.dream.night("2026-10-30")?.status, "requested");
  openNight(f, NIGHT);
  const conversations = async () => [{ channel: "telegram", entries: [message("user", "Before the window", Date.parse("2026-10-29T10:00:00Z")),
    message("user", "Let's go with Clef-flash", Date.parse("2026-10-30T08:00:00Z")), message("assistant", "Done, it is deployed.", Date.parse("2026-10-30T08:05:00Z")),
    { model: [{ role: "toolResult", content: [{ type: "text", text: "SECRET TOOL OUTPUT" }], timestamp: Date.parse("2026-10-30T08:04:00Z") }] }] }];
  const inputs = await dreamInputs({ dream: f.dream, mail: f.mail, situation: f.situation, conversations }, "dream-review", NIGHT) as { conversation: string; openRecords: { id: string }[]; day: string };
  assert.equal(inputs.day, "2026-10-30");
  assert.match(inputs.conversation, /owner: Let's go with Clef-flash[\s\S]*assistant: Done, it is deployed\./);
  assert.doesNotMatch(inputs.conversation, /Before the window|SECRET TOOL OUTPUT/, "only this day's owner and assistant text");
  assert.ok(inputs.openRecords.some(record => record.id === "r1"));

  const night = f.dream.commit("dream-review", RESULT(), NIGHT);
  assert.equal(night.status, "committed"); assert.equal(night.lessonEdits, 1);
  assert.deepEqual(f.dream.digest("day:2026-10-30")!.data!.openLoops.map(loop => loop.ref), ["r1", null], "a loop naming a missing record is dropped");
  assert.equal(f.dream.digest(`week:${weekOf("2026-10-30")}`)!.text, "This week: context work, knocks, decision models.");
  assert.match(f.dream.playbook(), /L1: Do not mention usage limits in documents\./);
  assert.deepEqual(f.dream.overnightFor(NIGHT + 3_600_000)!.tomorrow, ["Confirm the first recorded mail fact."]);
  assert.equal(f.dream.finishInput("dream-review", { outcome: "advanced", note: "x" }, NIGHT).outcome, "advanced");
  assert.equal(f.dream.due(NIGHT + 60_000), false, "one night per day");
});

test("the anchored summary keeps instructions word for word, loop IDs, and the week; probes the summary misses are added back", async t => {
  const f = fixture(t);
  f.dream.configure({ expectedVersion: 1, enabled: true }, "owner", EVENING);
  f.owner.createReminder("r1", "Stretch", new Date(NIGHT + 86_400_000).toISOString(), "telegram");
  f.time(NIGHT); f.dream.drive(NIGHT); openNight(f, NIGHT);
  f.dream.commit("dream-review", RESULT(), NIGHT);
  const summary = f.dream.anchoredSummary("2026-10-30");
  assert.match(summary, /- "No need to mention that in the documents"/);
  assert.match(summary, /- \[r1\] Stretch reminder/);
  assert.match(summary, /This week so far: This week: context work/);
  assert.match(summary, /search_history and read_history/);

  const asked: string[] = [];
  const ai: WorkersAi = { async run(_model, raw) { const input = raw as { questions: Record<string, { instructions: string }> };
    asked.push(...Object.values(input.questions).map(question => question.instructions));
    return { answers: { p0: { type: "noul", noul: 0.95 }, p1: { type: "noul", noul: 0.1 } }, usage: { input_tokens: 900 } }; } };
  const compacted: [string, string][] = [];
  const runtime = new DreamRuntime(f.dream, new Decisions(f.db, ai, () => 1_000), undefined, { sessions: () => ["owner", "control-session"], async compact(session: string, marker: string) { compacted.push([session, marker]); } });
  await runtime.drive();
  assert.equal(asked.length, 2);
  assert.deepEqual(compacted.map(([session]) => session), ["owner", "control-session"]);
  const placed = runtime.summaryFor(compacted[0]![1])!;
  assert.match(placed, /Details kept from 2026-10-30:\n- What was the monthly decision budget\? One US dollar\./, "the missed probe is added");
  assert.doesNotMatch(placed, /Which Clef model screens mail\? Clef-flash\./, "a kept probe is not repeated");
  assert.equal(runtime.summaryFor("something else"), undefined);
  assert.deepEqual((f.dream.status() as { lastNight: { compaction: object } }).lastNight.compaction, { at: new Date(NIGHT).toISOString(), sessions: 2, failed: 0, probesKept: 1, probesRepaired: 1 });
  assert.equal(runtime.nextDue(), undefined, "compacted once");
});

/** Embeddings for tests: each text maps to a vector by which topic words it contains. */
const TOPICS = [["mail", "email", "screening", "clef"], ["budget", "dollar", "cap", "cost"], ["knock", "reminder", "chime"], ["deploy", "release", "ship"]];
const topicAi: WorkersAi = { async run(model, raw) {
  const input = raw as { queries?: string[]; documents?: string[] };
  if (!model.includes("embedding")) throw new Error("unexpected model");
  const texts = input.queries ?? input.documents ?? [];
  return { data: texts.map(text => { const lower = text.toLowerCase(); return Array.from({ length: 1024 }, (_, i) => i < TOPICS.length ? TOPICS[i]!.filter(word => lower.includes(word)).length + 0.01 : 0); }), shape: [texts.length, 1024] };
} };

test("history search finds digests and past conversation by words and by meaning; the owner can revert or retire a lesson", async t => {
  const f = fixture(t);
  const index = new HistoryIndex(f.db, new Decisions(f.db, topicAi, () => 1_000));
  f.dream.index = index;
  f.dream.configure({ expectedVersion: 1, enabled: true }, "owner", EVENING);
  f.time(NIGHT); f.dream.drive(NIGHT); openNight(f, NIGHT);
  const day = Date.parse("2026-10-30T08:00:00Z");
  f.dream.saveParts("2026-10-30", [{ at: day, text: "owner: which email screening model should we use?" }, { at: day + 1, text: "assistant: Clef-flash, it is the cheapest." }]);
  f.dream.commit("dream-review", RESULT(), NIGHT);
  assert.equal(await index.embedPending(), 3, "the day digest, the week summary, and one conversation passage");
  const [search, read, list, revert] = historyTools(f.dream, index, id => id === "dream-review");
  const run = async (tool: typeof search, input: unknown, conversationId = "owner") => JSON.parse(((await tool!.execute(input as never, { conversationId } as never, {} as never)) as { content: { text: string }[] }).content[0]!.text);
  const byWords = (await run(search, { query: "Clef-flash cheapest", source: "conversation" })).matches;
  assert.match(byWords[0].text, /Clef-flash, it is the cheapest/); assert.equal(byWords[0].keyword, true);
  const byMeaning = (await run(search, { query: "what did we choose for mail?" })).matches;
  assert.ok(byMeaning.some((match: { meaning: boolean; source: string }) => match.meaning && match.source === "conversation"), "a rephrased question finds the passage by meaning");
  assert.match((await run(read, { period: "2026-10-30" })).text, /decision service/);
  assert.match((await run(read, { period: "2026-W44" })).text, /This week/);
  assert.equal((await run(list, {})).lessons[0].id, "L1");
  assert.match(((await revert!.execute({ id: "L1", version: "retire" } as never, { conversationId: "dream-review" } as never, {} as never)) as { content: { text: string }[] }).content[0]!.text, /Only the owner/);
  assert.equal((await run(revert, { id: "L1", version: "retire" })).lesson.status, "retired");
  assert.equal(f.dream.playbook(), "");
  assert.equal((await run(revert, { id: "L1", version: 1 })).lesson.status, "active");
  assert.equal(f.dream.lessons()[0]!.history.length, 3);
  // Without embeddings, keyword search still works.
  assert.equal((await new HistoryIndex(f.db).search("Clef-flash")).length > 0, true);
});

test("a long day is read in parts, stuck work and delegated tasks reach the night, and drafts and reinforcement are saved", async t => {
  const f = fixture(t);
  f.dream.configure({ expectedVersion: 1, enabled: true }, "owner", EVENING);
  const drafts: [string, string][] = [];
  f.dream.saveDraft = (mailId, text) => { drafts.push([mailId, text]); return mailId === "mail-1"; };
  f.owner.createReminder("missed", "Call the bank", new Date(EVENING + 60_000).toISOString(), "telegram");
  f.time(EVENING + 60_000); f.owner.fireReminders(EVENING + 60_000);
  f.time(NIGHT); f.dream.drive(NIGHT); const first = openNight(f, NIGHT);
  const start = Date.parse("2026-10-30T02:00:00Z");
  const entries = Array.from({ length: 80 }, (_, i) => message(i % 2 ? "assistant" : "user", `${i === 0 ? "MORNING FACT " : ""}message ${i} ${"y".repeat(2_000)}`, start + i * 60_000));
  const inputs = await dreamInputs({ dream: f.dream, mail: f.mail, situation: f.situation, conversations: async () => [{ channel: "telegram", entries }],
    tasks: () => [{ kind: "coding", id: "c1", status: "failed", prompt: "Fix the build", result: "tsc failed", updatedAt: new Date(NIGHT - 3_600_000).toISOString() }] }, "dream-review", NIGHT) as Record<string, any>;
  assert.ok(inputs.conversationParts >= 3, "160k characters span several parts");
  assert.match(inputs.conversation, /MORNING FACT/, "the morning is not cut");
  assert.ok(inputs.conversation.length <= DREAM_PART_CHARS + 2_100);
  assert.match(f.dream.part("2026-10-30", inputs.conversationParts).map(line => line.text).join("\n"), /message 79/);
  assert.deepEqual(inputs.stuckWork.unansweredReminders.map((item: { id: string }) => item.id), ["missed"]);
  assert.deepEqual(inputs.tasks.map((task: { id: string }) => task.id), ["c1"]);
  const night = f.dream.commit("dream-review", RESULT({ drafts: [{ mailId: "mail-1", text: "Thanks, confirmed." }, { mailId: "gone", text: "x" }] }), NIGHT);
  assert.equal(night.drafts, 1); assert.equal(drafts.length, 2);
  f.proactive.report("dream-review", f.dream.finishInput("dream-review", { outcome: "advanced", note: "x" }, NIGHT), NIGHT); f.owner.settle(first.operationId, "");
  f.time(NIGHT + 86_400_000);
  f.dream.drive(NIGHT + 86_400_000); openNight(f, NIGHT + 86_400_000);
  f.dream.commit("dream-review", RESULT({ lessons: [{ op: "reinforce", id: "L1", evidence: "Again today" }] }), NIGHT + 86_400_000);
  assert.equal(f.dream.lessons()[0]!.support, 1); assert.equal(f.dream.lessons()[0]!.version, 1, "reinforcing does not change the rule");
});

test("a very long day closes early with the anchored summary, at most once in three hours", async t => {
  const f = fixture(t);
  f.dream.configure({ expectedVersion: 1, enabled: true }, "owner", EVENING);
  assert.equal(f.dream.closeLongDay([LONG_DAY_TOKENS - 1], EVENING), false);
  assert.equal(f.dream.closeLongDay([100_000, LONG_DAY_TOKENS], EVENING), true);
  assert.equal(f.dream.night("2026-10-30")!.manual, true);
  assert.equal(f.dream.closeLongDay([LONG_DAY_TOKENS], EVENING + 60_000), false, "the requested night is still running");
});

test("a manual run covers the day so far, and the scheduled night still closes the whole day", async t => {
  const f = fixture(t);
  f.dream.configure({ expectedVersion: 1, enabled: true }, "owner", EVENING);
  f.dream.requestNow(EVENING); openNight(f, EVENING);
  f.dream.commit("dream-review", RESULT(), EVENING);
  assert.equal(f.dream.night("2026-10-30")!.manual, true);
  assert.equal(f.dream.due(NIGHT), true, "the scheduled night still runs");
});

test("transcript keeps the newest owner and assistant lines within its budget", () => {
  const entries = Array.from({ length: 50 }, (_, index) => message(index % 2 ? "assistant" : "user", `line ${index} ${"x".repeat(80)}`, 1_000 + index));
  const text = transcript([{ channel: "control", entries }], 0, "UTC", 1_000);
  assert.match(text, /^\[earlier messages left out for length\]/); assert.match(text, /line 49/); assert.doesNotMatch(text, /line 10 /);
});

test("the nightly compaction places the prepared summary without a summarizing model call", { timeout: 20_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), "umpi-dream-"));
  const models = createModels(), faux = fauxProvider({ provider: "dream-test", tokensPerSecond: Infinity });
  models.setProvider(faux.provider);
  const sqlite = new DatabaseSync(":memory:"); t.after(() => sqlite.close());
  const db: Database = { all: <T extends object>(query: string, ...bindings: (string | number | null)[]) => sqlite.prepare(query).all(...bindings) as T[], transaction: <T>(run: () => T) => run() };
  const health = new ContextHealth(db), prepared = new Map([["umpi-nightly:2026-10-30:x", "[Nightly summary] The owner chose Clef-flash."]]);
  const registry = createRegistry();
  const extension = { name: "umpi", hooks: contextHooks({ health, isForeground: () => true, summaryFor: instructions => instructions ? prepared.get(instructions) : undefined }) };
  registry.install(extension);
  const harness = await Harness.open(await openNodeSqliteStorage(join(directory, "state.sqlite")), { models, registry, settings: { extensions: [extension], compaction: { enabled: false, keepRecentTokens: 1 }, retry: { enabled: false } } }, BACKGROUND_CONTEXT);
  t.after(async () => { await harness.close(BACKGROUND_CONTEXT); await rm(directory, { recursive: true, force: true }); });
  const model = faux.getModel();
  const root = await harness.root(BACKGROUND_CONTEXT, { agent: { model: { provider: model.provider, modelId: model.id }, thinkingLevel: "off" } });
  for (const text of ["First", "Second"]) {
    faux.setResponses([fauxAssistantMessage(`Reply to ${text}`)]);
    await (await root.submit({ type: "input", content: text }, BACKGROUND_CONTEXT)).wait(BACKGROUND_CONTEXT);
  }
  let summarizerCalls = 0;
  faux.setResponses([() => { summarizerCalls++; return fauxAssistantMessage("model summary"); }]);
  const task = await root.compact("umpi-nightly:2026-10-30:x", BACKGROUND_CONTEXT);
  assert.equal((await harness.waitForTask(task, BACKGROUND_CONTEXT)).state.outcome.status, "completed");
  assert.equal(summarizerCalls, 0, "no summarizing model call");
  let seen = "";
  faux.setResponses([request => { seen = JSON.stringify(request.messages); return fauxAssistantMessage("ok"); }]);
  await (await root.submit({ type: "input", content: "Third" }, BACKGROUND_CONTEXT)).wait(BACKGROUND_CONTEXT);
  assert.match(seen, /\[Nightly summary\] The owner chose Clef-flash\./);
  assert.doesNotMatch(seen, /Reply to First/, "the summarized history is gone from the request");
});
