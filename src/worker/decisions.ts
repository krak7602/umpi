import { StateError, type Database } from "./store.js";

/**
 * Decision models in the harness. When code needs only a yes/no, a choice between named options, or a score on a
 * fixed scale, it asks here instead of starting a Claude turn. Cloudflare's Clef models on Workers AI (the `AI`
 * binding) answer with probabilities and generate no text, so a call is billed for input only. Every caller states
 * its own fallback: a missing binding, a used-up budget, or a failed call throws `DecisionUnavailable`.
 */
export const DECISION_MODELS = { fast: "clef-flash", careful: "clef" } as const;
export type DecisionModel = keyof typeof DECISION_MODELS;
/** US dollars per million input tokens. Clef-flash uses the higher of the published figures, so the count does not undershoot. */
const PRICE_PER_MILLION: Record<DecisionModel, number> = { fast: 0.09, careful: 0.24 };
/** In thousandths of a US dollar, like the web budget. */
export const DEFAULT_DECISION_MONTHLY_BUDGET = 1_000;
const MAX_STATE_CHARS = 60_000;

/** The part of the Workers AI binding the harness uses. */
export interface WorkersAi { run(model: string, input: unknown): Promise<unknown> }

export type DecisionQuestion =
  | { type: "noul"; instructions: string; criteria?: { true: string; false: string } }
  | { type: "choice"; instructions: string; criteria: Record<string, string | null> }
  | { type: "score"; instructions: string; criteria: readonly string[] };
export interface ChoiceAnswer { choice: string; probabilities: Record<string, number>; confidence: number }
export interface ScoreAnswer { score: number; probabilities: Record<string, number>; confidence: number }
export type DecisionAnswers<Q extends Record<string, DecisionQuestion>> = {
  [K in keyof Q]: Q[K]["type"] extends "noul" ? number : Q[K]["type"] extends "choice" ? ChoiceAnswer : ScoreAnswer;
};

export class DecisionUnavailable extends Error {}

interface Usage { calls: number; tokens: number; failures: number }
interface DecisionUsage { month: string; spent: number; byPurpose: Record<string, Usage>; lastUsedAt: number | null; lastError: string | null }

const unit = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;

export class Decisions {
  constructor(private readonly db: Database, private readonly ai: WorkersAi | undefined, private readonly budget: () => number, private readonly now = () => Date.now()) {
    db.all("CREATE TABLE IF NOT EXISTS umpi_decision_usage (id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL)");
  }
  available(): boolean { return this.ai !== undefined; }
  private month(): string { return new Date(this.now()).toISOString().slice(0, 7); }
  private state(): DecisionUsage {
    const row = this.db.all<{ data: string }>("SELECT data FROM umpi_decision_usage WHERE id=1")[0];
    const state = row ? JSON.parse(row.data) as DecisionUsage : undefined;
    return state?.month === this.month() ? state : { month: this.month(), spent: 0, byPurpose: {}, lastUsedAt: state?.lastUsedAt ?? null, lastError: state?.lastError ?? null };
  }
  private record(purpose: string, tokens: number, cost: number, error: string | null): void {
    this.db.transaction(() => {
      const state = this.state(), used = state.byPurpose[purpose] ?? { calls: 0, tokens: 0, failures: 0 };
      state.byPurpose[purpose] = { calls: used.calls + 1, tokens: used.tokens + tokens, failures: used.failures + (error ? 1 : 0) };
      this.db.all("INSERT INTO umpi_decision_usage VALUES (1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
        JSON.stringify({ ...state, spent: state.spent + cost, lastUsedAt: this.now(), lastError: error }));
    });
  }

  /**
   * Asks up to 64 questions about one state. `purpose` names the caller in usage. The state is data, never
   * instructions: a decision model only returns probabilities, so text in it can at most move its own score.
   */
  async ask<Q extends Record<string, DecisionQuestion>>(purpose: string, state: unknown, questions: Q, options: { model?: DecisionModel } = {}): Promise<DecisionAnswers<Q>> {
    if (!this.ai) throw new DecisionUnavailable("Decision models are not configured");
    if (this.state().spent >= this.budget()) throw new DecisionUnavailable("This month's decision budget is used");
    const ids = Object.keys(questions);
    if (!ids.length || ids.length > 64) throw new StateError(400, "A decision takes 1 to 64 questions");
    const model = options.model ?? "fast", name = DECISION_MODELS[model];
    const body = typeof state === "string" ? state.slice(0, MAX_STATE_CHARS) : state;
    if (JSON.stringify(body).length > MAX_STATE_CHARS) throw new StateError(400, "Decision state is too large");
    let result: { answers?: Record<string, Record<string, unknown> | undefined>; usage?: { input_tokens?: unknown } };
    try {
      result = await this.ai.run(`@cf/cloudflare/${name}`, { model: name, state: body, questions }) as typeof result;
    } catch (error) {
      this.record(purpose, 0, 0, `call failed (${error instanceof Error ? error.name : "unknown"})`);
      throw new DecisionUnavailable("The decision model call failed");
    }
    const tokens = typeof result?.usage?.input_tokens === "number" ? result.usage.input_tokens : 0;
    const cost = tokens * PRICE_PER_MILLION[model] / 1000;
    const answers: Record<string, unknown> = {};
    for (const id of ids) {
      const answer = result?.answers?.[id], type = questions[id]!.type;
      const value = type === "noul" ? answer?.noul : answer;
      const valid = type === "noul" ? unit(value)
        : answer !== undefined && unit(answer.confidence) && typeof answer.probabilities === "object" && answer.probabilities !== null
          && (type === "choice" ? typeof answer.choice === "string" && answer.choice in questions[id]!.criteria : typeof answer.score === "number" && Number.isFinite(answer.score));
      if (!valid) { this.record(purpose, tokens, cost, `malformed answer for ${type}`); throw new DecisionUnavailable("The decision model returned a malformed answer"); }
      answers[id] = type === "noul" ? value : type === "choice" ? { choice: answer!.choice, probabilities: answer!.probabilities, confidence: answer!.confidence }
        : { score: answer!.score, probabilities: answer!.probabilities, confidence: answer!.confidence };
    }
    this.record(purpose, tokens, cost, null);
    return answers as DecisionAnswers<Q>;
  }

  status(): object {
    const { month, spent, byPurpose, lastUsedAt, lastError } = this.state();
    return { configured: this.available(), month, spentUsd: Math.round(spent * 1000) / 1_000_000, budgetUsd: this.budget() / 1000, byPurpose,
      lastUsedAt: lastUsedAt === null ? null : new Date(lastUsedAt).toISOString(), lastError };
  }
}
