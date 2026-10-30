import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import type { Database } from "../src/worker/store.js";
import { DecisionUnavailable, Decisions, chooseEffort, decisionTools, type WorkersAi } from "../src/worker/decisions.js";

function database(t: TestContext): Database {
  const sqlite = new DatabaseSync(":memory:"); t.after(() => sqlite.close());
  return { all: <T extends object>(query: string, ...bindings: (string | number | null)[]) => sqlite.prepare(query).all(...bindings) as T[], transaction: <T>(run: () => T) => run() };
}
const QUESTIONS = {
  urgent: { type: "noul", instructions: "Is this urgent?" },
  team: { type: "choice", instructions: "Which team owns it?", criteria: { billing: "Payments and invoices", support: null } },
  severity: { type: "score", instructions: "How severe is it?", criteria: ["low", "medium", "high"] },
} as const;
const good = { urgent: { type: "noul", noul: 0.8 }, team: { type: "choice", choice: "billing", probabilities: { billing: 0.9, support: 0.1 }, confidence: 0.8 },
  severity: { type: "score", score: 1.4, legend: { 0: "low", 1: "medium", 2: "high" }, probabilities: { 0: 0.1, 1: 0.4, 2: 0.5 }, confidence: 0.4 } };

test("one call answers yes/no, choice and score questions, and usage is counted per caller and month", async t => {
  let now = Date.parse("2026-10-30T09:00:00Z");
  const calls: { model: string; input: Record<string, unknown> }[] = [];
  const ai: WorkersAi = { async run(model, input) { calls.push({ model, input: input as Record<string, unknown> }); return { answers: good, usage: { input_tokens: 1_000_000, output_tokens: 0 } }; } };
  const decisions = new Decisions(database(t), ai, () => 1_000, () => now);
  const answers = await decisions.ask("alerts", { text: "Card payment failed" }, QUESTIONS);
  assert.equal(answers.urgent, 0.8); assert.equal(answers.team.choice, "billing"); assert.equal(answers.severity.score, 1.4);
  assert.deepEqual(calls[0], { model: "@cf/cloudflare/clef-flash", input: { model: "clef-flash", state: { text: "Card payment failed" }, questions: QUESTIONS } });
  await decisions.ask("mail", "Another state", { urgent: QUESTIONS.urgent }, { model: "careful" });
  assert.equal(calls[1]!.model, "@cf/cloudflare/clef");
  assert.deepEqual(decisions.status(), { configured: true, month: "2026-10", spentUsd: 0.33, budgetUsd: 1,
    byPurpose: { alerts: { calls: 1, tokens: 1_000_000, failures: 0 }, mail: { calls: 1, tokens: 1_000_000, failures: 0 } }, lastUsedAt: "2026-10-30T09:00:00.000Z", lastError: null });
  now = Date.parse("2026-11-01T00:00:00Z");
  assert.equal((decisions.status() as { spentUsd: number }).spentUsd, 0, "the count restarts each month");
});

test("no binding, a used budget, a failed call, or a malformed answer is DecisionUnavailable for the caller's fallback", async t => {
  await assert.rejects(new Decisions(database(t), undefined, () => 1_000).ask("x", "s", { urgent: QUESTIONS.urgent }), DecisionUnavailable);
  let reply: unknown = { answers: good, usage: { input_tokens: 2_000_000, output_tokens: 0 } };
  const decisions = new Decisions(database(t), { async run() { if (reply instanceof Error) throw reply; return reply; } }, () => 100);
  await decisions.ask("x", "s", QUESTIONS);
  await assert.rejects(decisions.ask("x", "s", QUESTIONS), /budget is used/);
  const fresh = (r: unknown) => { reply = r; return new Decisions(database(t), { async run() { if (reply instanceof Error) throw reply; return reply; } }, () => 1_000); };
  for (const bad of [new Error("network"), { answers: { ...good, urgent: { type: "noul", noul: 1.2 } } }, { answers: { ...good, team: { ...good.team, choice: "sales" } } }, { answers: {} }]) {
    const d = fresh(bad);
    await assert.rejects(d.ask("x", "s", QUESTIONS), DecisionUnavailable);
    assert.equal((d.status() as { byPurpose: { x: { failures: number } } }).byPurpose.x.failures, 1);
  }
  await assert.rejects(fresh({ answers: good }).ask("x", "s", {}), /1 to 64 questions/);
});

test("Clairic extracts typed fields; a missing value is null with its confidence, and a missing field fails", async t => {
  const calls: { model: string; input: Record<string, unknown> }[] = [];
  let answers: Record<string, unknown> = { invoice: { type: "text", value: "INV-2291", confidence: 1, span: [8, 16] }, total: { type: "number", value: 1080, confidence: 0.9999 }, po: { type: "text", value: null, p_null: 1 } };
  const decisions = new Decisions(database(t), { async run(model, input) { calls.push({ model, input: input as Record<string, unknown> }); return { answers, truncated: false, usage: { input_tokens: 655, output_tokens: 0 } }; } }, () => 1_000);
  const fields = { invoice: { type: "text" }, total: { type: "number", decimals: 2 }, po: { type: "text", instructions: "Purchase order number" } } as const;
  assert.deepEqual(await decisions.extract("bills", "Invoice INV-2291 ... total $1,080.00", fields), { invoice: { value: "INV-2291", confidence: 1 }, total: { value: 1080, confidence: 0.9999 }, po: { value: null, confidence: 1 } });
  assert.deepEqual(calls[0], { model: "@cf/cloudflare/clairic", input: { model: "clairic", state: "Invoice INV-2291 ... total $1,080.00", fields } });
  answers = { invoice: answers.invoice! };
  await assert.rejects(decisions.extract("bills", "x", fields), DecisionUnavailable);
  await assert.rejects(decisions.extract("bills", "  ", fields), /needs text/);
});

test("Claude's decide and extract_fields tools run each item and report per-item results", async t => {
  const ai: WorkersAi = { async run(model, raw) {
    const input = raw as { state: string };
    if (input.state.includes("broken")) throw new Error("down");
    return model.endsWith("clairic") ? { answers: { amount: { type: "number", value: input.state.length, confidence: 0.9 } }, usage: { input_tokens: 10 } }
      : { answers: { invoice: { type: "noul", noul: input.state.includes("invoice") ? 0.9 : 0.1 } }, usage: { input_tokens: 10 } };
  } };
  const [decide, extract] = decisionTools(new Decisions(database(t), ai, () => 1_000));
  const run = async (tool: typeof decide, input: unknown) => JSON.parse(((await tool!.execute(input as never, {} as never, {} as never)) as { content: { text: string }[] }).content[0]!.text);
  assert.deepEqual(await run(decide, { items: [{ id: "a", text: "an invoice" }, { id: "b", text: "a note" }, { id: "c", text: "broken" }], questions: { invoice: { type: "noul", instructions: "Is it an invoice?" } } }),
    { answers: { a: { invoice: 0.9 }, b: { invoice: 0.1 }, c: { error: "The decision model call failed" } } });
  assert.deepEqual(await run(extract, { items: [{ id: "a", text: "12345" }], fields: { amount: { type: "number" } } }), { values: { a: { amount: { value: 5, confidence: 0.9 } } } });
  assert.match((await run(extract, { items: [{ id: "a", text: "x" }], fields: { names: { type: "list" } } })).error, /list field needs items/);
  const [offline] = decisionTools(new Decisions(database(t), undefined, () => 1_000));
  assert.match((await run(offline, { items: [{ id: "a", text: "x" }], questions: { q: { type: "noul", instructions: "?" } } })).error, /not configured/);
});

test("owner-message effort drops only on a confident quick or normal answer, and anything else keeps high", async t => {
  let pick = { choice: "quick", p: 0.8 }, seen: unknown;
  const ai: WorkersAi = { async run(_model, raw) { seen = (raw as { state: unknown }).state;
    return { answers: { effort: { type: "choice", choice: pick.choice, probabilities: { quick: 0.05, normal: 0.05, deep: 0.05, [pick.choice]: pick.p }, confidence: pick.p } }, usage: { input_tokens: 300 } }; } };
  const decisions = new Decisions(database(t), ai, () => 1_000);
  assert.equal(await chooseEffort(decisions, "thanks!", "Done: reminder set for 5 pm."), "low");
  assert.deepEqual(seen, { previousReply: "Done: reminder set for 5 pm.", message: "thanks!" }, "the previous reply gives a short answer its context");
  pick = { choice: "normal", p: 0.7 }; assert.equal(await chooseEffort(decisions, "what's on my calendar tomorrow?", undefined), "medium");
  pick = { choice: "quick", p: 0.4 }; assert.equal(await chooseEffort(decisions, "yes", "Shall I refactor the sync engine?"), "high", "an unsure answer keeps high");
  pick = { choice: "deep", p: 0.9 }; assert.equal(await chooseEffort(decisions, "plan my week", undefined), "high");
  assert.equal(await chooseEffort(new Decisions(database(t), undefined, () => 1_000), "hi", undefined), "high");
  assert.equal(await chooseEffort(new Decisions(database(t), { async run() { throw new Error("down"); } }, () => 1_000), "hi", undefined), "high");
});
