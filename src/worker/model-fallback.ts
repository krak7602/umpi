import { isAnthropicApiKey, type SubscriptionFallback } from "../model/provider.js";
import type { Database } from "./store.js";

/** How long requests use the API key after a subscription limit, before trying the subscription again. */
export const FALLBACK_WINDOW_MS = 30 * 60_000;

interface FallbackState { limitedUntil: number; lastLimitedAt: number | null; lastUsedAt: number | null; day: string; usedToday: number }

/**
 * Durable state for the limit-only API-key fallback. The key comes from a Worker secret and is never stored here.
 * Without a valid key, a subscription limit is only recorded.
 */
export class ModelFallback implements SubscriptionFallback {
  private readonly day: Intl.DateTimeFormat;
  private readonly clock: Intl.DateTimeFormat;
  constructor(private readonly db: Database, private readonly secret: () => string | undefined, timezone: string,
    private readonly notify: (groupId: string, text: string) => void, private readonly now = () => Date.now()) {
    this.day = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" });
    this.clock = new Intl.DateTimeFormat("en-GB", { timeZone: timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    db.all("CREATE TABLE IF NOT EXISTS umpi_model_fallback (id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL)");
  }
  private state(): FallbackState {
    const row = this.db.all<{ data: string }>("SELECT data FROM umpi_model_fallback WHERE id=1")[0];
    return row ? JSON.parse(row.data) as FallbackState : { limitedUntil: 0, lastLimitedAt: null, lastUsedAt: null, day: "", usedToday: 0 };
  }
  private save(state: FallbackState): void {
    this.db.all("INSERT INTO umpi_model_fallback VALUES (1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data", JSON.stringify(state));
  }
  /** Pasted secrets can carry surrounding whitespace or a newline. */
  private secretValue(): string | undefined { return this.secret()?.trim() || undefined; }
  configured(): boolean { const key = this.secretValue(); return !!key && isAnthropicApiKey(key); }
  key(): string | undefined { return this.configured() ? this.secretValue() : undefined; }
  /** Why a set secret is not used, without revealing it. */
  private keyIssue(): string | null {
    const key = this.secretValue();
    if (!key || isAnthropicApiKey(key)) return null;
    if (key.startsWith("sk-ant-oat")) return "This is a subscription OAuth token, not an API key; create an API key in the Anthropic Console";
    if (key.startsWith("sk-ant-admin")) return "This is an Admin API key; create a standard API key in the Anthropic Console";
    return "Not an Anthropic API key (expected sk-ant-…)";
  }
  active(): boolean { return this.configured() && this.state().limitedUntil > this.now(); }
  limited(): void {
    const now = this.now(), state = this.state(), wasActive = state.limitedUntil > now;
    state.lastLimitedAt = now;
    if (this.configured()) state.limitedUntil = now + FALLBACK_WINDOW_MS;
    this.save(state);
    if (this.configured() && !wasActive) {
      // One notice per local day: the first switch says that API credits are in use.
      this.notify(`notice:model-fallback:${this.day.format(now)}`, `Claude subscription limit reached. Umpi is using API credits until about ${this.clock.format(state.limitedUntil)}, then tries the subscription again.`);
    }
  }
  used(): void {
    const now = this.now(), state = this.state(), day = this.day.format(now);
    this.save({ ...state, lastUsedAt: now, day, usedToday: state.day === day ? state.usedToday + 1 : 1 });
  }
  /** Checks the key with Anthropic's free model list. Only the HTTP status is returned. */
  async check(fetcher: typeof fetch = fetch): Promise<object> {
    const key = this.key();
    if (!key) return { configured: false, keyIssue: this.keyIssue() };
    try {
      const response = await fetcher("https://api.anthropic.com/v1/models?limit=1", { redirect: "manual", signal: AbortSignal.timeout(15_000),
        headers: { "x-api-key": key, "anthropic-version": "2023-06-01" } });
      return { configured: true, accepted: response.ok, status: response.status };
    } catch { return { configured: true, accepted: false, status: null }; }
  }
  status(): object {
    const state = this.state(), iso = (value: number | null) => value === null ? null : new Date(value).toISOString();
    return { configured: this.configured(), keyIssue: this.keyIssue(), active: this.active(), activeUntil: this.active() ? iso(state.limitedUntil) : null,
      lastLimitedAt: iso(state.lastLimitedAt), lastUsedAt: iso(state.lastUsedAt), requestsToday: state.day === this.day.format(this.now()) ? state.usedToday : 0 };
  }
}
