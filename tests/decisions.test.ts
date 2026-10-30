import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import type { Database } from "../src/worker/store.js";
import { DecisionUnavailable, Decisions, type WorkersAi } from "../src/worker/decisions.js";

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
