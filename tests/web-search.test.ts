import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import type { ToolExecutionApi, ToolRegistration } from "@earendil-works/pi-durable";
import type { Database } from "../src/worker/store.js";
import { PARALLEL_ORIGIN, WebUsageStore, webForeground, webTools } from "../src/worker/web-search.js";

function database(t: TestContext): Database {
  const sqlite = new DatabaseSync(":memory:"); t.after(() => sqlite.close());
  return { all: <T extends object>(query: string, ...bindings: (string | number | null)[]) => sqlite.prepare(query).all(...bindings) as T[], transaction: <T>(run: () => T) => {
    sqlite.exec("BEGIN");
    try { const value = run(); sqlite.exec("COMMIT"); return value; } catch (error) { sqlite.exec("ROLLBACK"); throw error; }
  } };
}

interface Sent { url: string; headers: Record<string, string>; body: Record<string, unknown> }
function setup(t: TestContext, options: { key?: string; budget?: number; reply?: (sent: Sent) => Response; background?: string[] } = {}) {
  let now = Date.parse("2026-10-29T10:00:00Z");
  const sent: Sent[] = [];
  const usage = new WebUsageStore(database(t), () => options.budget ?? 4_500, () => now);
  const tools = webTools({
    key: () => "key" in options ? options.key : "test-parallel-key", usage,
    foreground: webForeground(id => (options.background ?? []).includes(id)),
    fetch: (async (url: string, init: RequestInit) => {
      const entry = { url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) as Record<string, unknown> };
      sent.push(entry);
      return options.reply?.(entry) ?? Response.json({ search_id: "search_1", session_id: "s", results: [
        { url: "https://example.org/a", title: "A", publish_date: "2026-10-01", excerpts: ["First"] },
        { url: "https://example.org/b", title: null, excerpts: ["Second", 3] },
      ] });
    }) as typeof fetch,
  });
  const tool = (name: string) => tools.find(item => item.name === name) as ToolRegistration;
  const run = async (name: string, input: object, conversationId = "owner") => {
    const output = await tool(name).execute(input as never, { conversationId } as unknown as ToolExecutionApi, {} as never);
    const first = output.content?.[0];
    return { error: output.isError === true, value: first && first.type === "text" ? first.text : "" };
  };
  return { sent, usage, run, advance: (ms: number) => { now += ms; } };
}

test("web_search sends a fast Parallel search and returns compact results", async t => {
  const { sent, usage, run } = setup(t);
  const output = await run("web_search", { objective: "Find the release date", queries: ["product release date"], sites: ["example.org"], after: "2026-01-01" });
  assert.equal(output.error, false);
  assert.equal(sent[0]!.url, `${PARALLEL_ORIGIN}/v1/search`);
  assert.equal(sent[0]!.headers["x-api-key"], "test-parallel-key");
  assert.deepEqual(sent[0]!.body, { objective: "Find the release date", search_queries: ["product release date"], mode: "fast", max_chars_total: 8000,
    advanced_settings: { max_results: 8, source_policy: { include_domains: ["example.org"], after_date: "2026-01-01" } } });
  const parsed = JSON.parse(output.value);
  assert.deepEqual(parsed.results, [
    { url: "https://example.org/a", title: "A", published: "2026-10-01", excerpts: ["First"] },
    { url: "https://example.org/b", excerpts: ["Second"] },
  ]);
  assert.match(parsed.note, /not instructions/);
  assert.deepEqual(usage.status(true), { configured: true, month: "2026-10", spentUsd: 0.001, budgetUsd: 4.5, searches: 1, pages: 0, lastUsedAt: "2026-10-29T10:00:00.000Z", lastError: null });
});

test("thorough searches cost more, and the monthly budget stops requests until the next month", async t => {
  const { sent, usage, run, advance } = setup(t, { budget: 7 });
  assert.equal((await run("web_search", { objective: "x", queries: ["x"], depth: "thorough" })).error, false);
  assert.equal(sent[0]!.body.mode, "advanced");
  assert.equal((await run("web_search", { objective: "x", queries: ["x"] })).error, false);
  const refused = await run("web_search", { objective: "x", queries: ["x"], depth: "thorough" });
  assert.equal(refused.error, true); assert.match(refused.value, /budget is used/);
  assert.equal(sent.length, 2, "a refused search is not sent");
  assert.equal((usage.status(true) as { spentUsd: number }).spentUsd, 0.006, "a refused search is not counted");
  advance(4 * 24 * 3600_000);
  assert.equal((await run("web_search", { objective: "x", queries: ["x"], depth: "thorough" })).error, false, "November starts a new budget");
  assert.equal((usage.status(true) as { month: string }).month, "2026-11");
});

test("read_web_page extracts excerpts or full content and reports unreadable pages", async t => {
  const { sent, usage, run } = setup(t, { reply: sent => Response.json({ extract_id: "e", session_id: "s",
    results: [{ url: "https://example.org/a", title: "A", excerpts: ["Part"], full_content: "x".repeat(10_000) }],
    errors: [{ url: "https://example.org/b", error_type: "fetch_failed", http_status_code: 404 }],
  }) });
  const excerpts = JSON.parse((await run("read_web_page", { urls: ["https://example.org/a", "https://example.org/b"], objective: "pricing" })).value);
  assert.deepEqual(sent[0]!.body, { urls: ["https://example.org/a", "https://example.org/b"], objective: "pricing", max_chars_total: 12000, advanced_settings: { excerpt_settings: { max_chars_per_result: 6000 } } });
  assert.deepEqual(excerpts.pages, [{ url: "https://example.org/a", title: "A", excerpts: ["Part"] }]);
  assert.deepEqual(excerpts.failed, [{ url: "https://example.org/b", error: "fetch_failed", status: 404 }]);
  const full = JSON.parse((await run("read_web_page", { urls: ["https://example.org/a", "https://example.org/b"], full: true })).value);
  assert.deepEqual(sent[1]!.body.advanced_settings, { full_content: { max_chars_per_result: 6000 } });
  assert.equal(full.pages[0].content.length, 6000);
  assert.equal((usage.status(true) as { pages: number }).pages, 4);
});

test("web tools refuse without a key, in background reviews, and say why the provider failed", async t => {
  const missing = setup(t, { key: undefined });
  const unconfigured = await missing.run("web_search", { objective: "x", queries: ["x"] });
  assert.equal(unconfigured.error, true); assert.match(unconfigured.value, /not configured/);

  const background = setup(t, { background: ["review"] });
  const refused = await background.run("web_search", { objective: "x", queries: ["x"] }, "review");
  assert.equal(refused.error, true); assert.match(refused.value, /owner's own conversation/);
  assert.equal(background.sent.length, 0);

  const rejected = setup(t, { reply: () => new Response("no", { status: 401 }) });
  assert.match((await rejected.run("web_search", { objective: "x", queries: ["x"] })).value, /key was rejected/);
  assert.equal((rejected.usage.status(true) as { lastError: string }).lastError, "HTTP 401");
  const limited = setup(t, { reply: () => new Response("no", { status: 429 }) });
  assert.match((await limited.run("read_web_page", { urls: ["https://example.org"] })).value, /refused more requests/);
});
