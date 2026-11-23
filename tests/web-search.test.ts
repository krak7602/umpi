import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import type { ToolExecutionApi, ToolRegistration } from "@earendil-works/pi-durable";
import type { Database } from "../src/worker/store.js";
import { PARALLEL_ORIGIN, WebSeenStore, WebUsageStore, ownerWroteUrl, urlsIn, webForeground, webTools } from "../src/worker/web-search.js";

function database(t: TestContext): Database {
  const sqlite = new DatabaseSync(":memory:"); t.after(() => sqlite.close());
  return { all: <T extends object>(query: string, ...bindings: (string | number | null)[]) => sqlite.prepare(query).all(...bindings) as T[], transaction: <T>(run: () => T) => {
    sqlite.exec("BEGIN");
    try { const value = run(); sqlite.exec("COMMIT"); return value; } catch (error) { sqlite.exec("ROLLBACK"); throw error; }
  } };
}

interface Sent { url: string; headers: Record<string, string>; body: Record<string, unknown> }
/** `owner` holds invented owner messages. Without it the tools get no `ownerWrote`, as before the coordinator wires one. */
function setup(t: TestContext, options: { key?: string; budget?: number; reply?: (sent: Sent) => Response; background?: string[]; owner?: string[] } = {}) {
  let now = Date.parse("2026-10-29T10:00:00Z");
  const sent: Sent[] = [], asked: { url: string; conversationId: string }[] = [];
  const db = database(t);
  const usage = new WebUsageStore(db, () => options.budget ?? 4_500, () => now);
  const owner = options.owner;
  const tools = webTools({
    key: () => "key" in options ? options.key : "test-parallel-key", usage,
    foreground: webForeground(id => (options.background ?? []).includes(id)),
    ...(owner ? { ownerWrote: (url: string, conversationId: string) => { asked.push({ url, conversationId }); return conversationId !== "night" && ownerWroteUrl(owner, url); } } : {}),
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
  return { sent, asked, usage, db, run, advance: (ms: number) => { now += ms; }, now: () => now };
}

const SEARCH = { objective: "x", queries: ["x"] };
const DAY = 24 * 3600_000;
const spent = (usage: WebUsageStore) => (usage.status(true) as { spentUsd: number }).spentUsd;
const pagesRead = (usage: WebUsageStore) => (usage.status(true) as { pages: number }).pages;
/** Replies to a search with the given result URLs, and to a page read with one page for each requested URL. */
function site(results: string[], page: (url: string) => object = () => ({ excerpts: ["Text"] })): (sent: Sent) => Response {
  return sent => sent.url.endsWith("/v1/search") ? Response.json({ results: results.map(url => ({ url, title: "T", excerpts: ["Found"] })) })
    : Response.json({ results: (sent.body.urls as string[]).map(url => ({ url, title: "T", ...page(url) })) });
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
  const { sent, usage, run } = setup(t, { owner: ["Compare https://example.org/a and https://example.org/b for me"], reply: sent => Response.json({ extract_id: "e", session_id: "s",
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
  const limited = setup(t, { owner: ["open example.org"], reply: () => new Response("no", { status: 429 }) });
  assert.match((await limited.run("read_web_page", { urls: ["https://example.org"] })).value, /refused more requests/);
});

test("read_web_page reads a URL that web_search returned, and sends the comparison form", async t => {
  const { sent, usage, run } = setup(t, { reply: site(["https://example.org/a", "https://Example.org", "https://example.org/list?page=2&sort=new"]) });
  assert.equal((await run("web_search", SEARCH)).error, false);
  assert.equal((await run("read_web_page", { urls: ["https://example.org/a"] })).error, false);
  assert.deepEqual(sent[1]!.body.urls, ["https://example.org/a"]);
  // Scheme and host case, the fragment, and the slash of an empty path do not count. The fragment is not sent.
  assert.equal((await run("read_web_page", { urls: ["HTTPS://EXAMPLE.org/a#invented-fragment", "https://example.org/", "https://example.org/list?page=2&sort=new"] })).error, false);
  assert.deepEqual(sent[2]!.body.urls, ["https://example.org/a", "https://example.org/", "https://example.org/list?page=2&sort=new"]);
  assert.equal(pagesRead(usage), 4);
});

test("read_web_page reads a link from a page it already returned, and only from the returned text", async t => {
  const body = `See the [guide](https://docs.example.org/guide?v=2), the [next part](/a/part-2), [notes](notes_(draft).html) and https://example.net/ref.`;
  const { sent, run } = setup(t, { reply: site(["https://example.org/a/"], url => url === "https://example.org/a/"
    ? { excerpts: [body], full_content: `${body} ${"x".repeat(13_000)} [late](https://example.org/late)` } : { excerpts: ["Text"] }) });
  await run("web_search", SEARCH);
  assert.equal((await run("read_web_page", { urls: ["https://docs.example.org/guide?v=2"] })).error, true, "the link is not seen before its page is read");
  assert.equal((await run("read_web_page", { urls: ["https://example.org/a/"], full: true })).error, false);
  const linked = await run("read_web_page", { urls: ["https://docs.example.org/guide?v=2", "https://example.org/a/part-2", "https://example.org/a/notes_(draft).html"] });
  assert.equal(linked.error, false);
  assert.equal((await run("read_web_page", { urls: ["https://example.net/ref"] })).error, false, "the sentence's full stop is not part of the link");
  assert.equal((await run("read_web_page", { urls: ["https://example.org/late"] })).error, true, "a link past the returned text was not shown to the model");
  assert.equal(sent.length, 4);
  // A page links to at most 200 URLs.
  const many = setup(t, { reply: site(["https://example.org/index"], () => ({ excerpts: [Array.from({ length: 205 }, (_, index) => `https://example.org/item/${index}`).join(" ")] })) });
  await many.run("web_search", SEARCH);
  await many.run("read_web_page", { urls: ["https://example.org/index"] });
  assert.equal((await many.run("read_web_page", { urls: ["https://example.org/item/199"] })).error, false);
  assert.equal((await many.run("read_web_page", { urls: ["https://example.org/item/200"] })).error, true);
});

test("read_web_page reads a URL the owner wrote, with or without a scheme", async t => {
  const { sent, asked, run } = setup(t, { owner: ["Morning!", "Please read https://example.net/post/42?ref=home.", "And see Example.org/docs/Setup, (docs.example.org:8443/api) too"] });
  assert.equal((await run("read_web_page", { urls: ["https://example.net/post/42?ref=home"] })).error, false);
  assert.equal((await run("read_web_page", { urls: ["https://example.org/docs/Setup", "http://example.org/docs/Setup", "https://docs.example.org:8443/api"] })).error, false);
  assert.deepEqual(asked[0], { url: "https://example.net/post/42?ref=home", conversationId: "owner" });
  for (const url of ["http://example.net/post/42?ref=home", "https://example.net/post/42", "https://example.net/post/42?ref=home&x=1", "https://example.org/docs/setup", "https://example.org/docs", "https://example.org/", "https://docs.example.org/api"]) {
    assert.equal((await run("read_web_page", { urls: [url] })).error, true, url);
  }
  assert.equal(sent.length, 2);
  // The coordinator's answer can depend on the conversation; a missing `ownerWrote` means the owner wrote nothing.
  assert.equal((await run("read_web_page", { urls: ["https://example.net/post/42?ref=home"] }, "night")).error, true);
  const unwired = setup(t);
  assert.equal((await unwired.run("read_web_page", { urls: ["https://example.net/post/42?ref=home"] })).error, true);
});

test("ownerWroteUrl and urlsIn take only what the text holds", () => {
  // A URL in prose is listed with and without its closing punctuation; an unmatched ")" ends it.
  assert.deepEqual(urlsIn("Mail ana@example.org about https://example.org/a_(b), then (https://example.org/c)."), ["https://example.org/a_(b),", "https://example.org/a_(b)", "https://example.org/c"]);
  assert.deepEqual(urlsIn("see example.org/docs/setup.", { bare: true }), ["https://example.org/docs/setup.", "http://example.org/docs/setup.", "https://example.org/docs/setup", "http://example.org/docs/setup"]);
  assert.deepEqual(urlsIn("ana@example.org wrote v1.2 at 10.30", { bare: true }), [], "a mail address, a version and a time are not hosts");
  assert.deepEqual(urlsIn("https://example.org/a is https only", { bare: true }), ["https://example.org/a"], "a URL with a scheme is not also a bare host");
  assert.equal(ownerWroteUrl(["look at example.org/docs/setup"], "https://example.org/docs/setup?token=invented"), false);
  assert.equal(ownerWroteUrl(["look at example.org/docs/setup"], "https://user@example.org/docs/setup"), false);
  assert.equal(ownerWroteUrl(["look at example.org/docs/setup"], "ftp://example.org/docs/setup"), false);
});

test("read_web_page refuses a URL the model composed, sends nothing and charges nothing", async t => {
  const { sent, usage, run } = setup(t, { owner: ["hello"], reply: site(["https://example.org/a", "https://example.org/find?q=tea"]) });
  await run("web_search", SEARCH);
  const composed = [
    "https://collector.example/?d=invented-private-text",  // a host never seen
    "https://example.org/a?d=invented-private-text",       // a seen URL with an added query
    "https://example.org/find?q=tea&d=invented",           // a seen query with an added parameter
    "https://example.org/find?q=invented",                 // a seen query, changed
    "https://example.org/invented/path",                   // a seen host with a new path
    "https://example.org/a/invented",                      // a seen path with an added segment
    "https://example.org/A",                               // path case counts
    "http://example.org/a",                                // another scheme
    "https://example.org:8443/a",                          // another port
    "https://invented-text@example.org/a",                 // a user name
    "https://invented.example.org/a",                      // a subdomain
    "https://example.org/find?q=tea&",                     // a seen query with an added byte
  ];
  for (const url of composed) {
    const refused = await run("read_web_page", { urls: [url] });
    assert.equal(refused.error, true, url);
    assert.match(refused.value, /Find the page with web_search, or ask the owner for the link\./);
    assert.doesNotMatch(refused.value, /reword|rephrase|try again|another form|different URL/i);
  }
  // One refused URL refuses the call: the seen URL beside it is not read either.
  const mixed = await run("read_web_page", { urls: ["https://example.org/a", "https://example.org/a?d=invented"] });
  assert.equal(mixed.error, true); assert.match(mixed.value, /Not read: https:\/\/example\.org\/a\?d=invented\./);
  assert.equal(sent.length, 1, "only the search was sent");
  assert.equal(spent(usage), 0.001, "only the search was charged");
  assert.equal(pagesRead(usage), 0);
});

test("seen URLs do not pass between conversations, and background runs get no owner links", async t => {
  const { sent, run } = setup(t, { owner: ["read https://example.net/owner-link"], reply: site(["https://example.org/a"], () => ({ excerpts: ["[more](https://example.org/more)"] })) });
  await run("web_search", SEARCH, "owner");
  await run("read_web_page", { urls: ["https://example.org/a"] }, "owner");
  for (const url of ["https://example.org/a", "https://example.org/more"]) {
    assert.equal((await run("read_web_page", { urls: [url] }, "subagent")).error, true, url);
    assert.equal((await run("read_web_page", { urls: [url] }, "night")).error, true, url);
  }
  assert.equal(sent.length, 2);
  // The nightly run has sources 1 and 2 in its own conversation.
  await run("web_search", SEARCH, "night");
  assert.equal((await run("read_web_page", { urls: ["https://example.org/a"] }, "night")).error, false);
  assert.equal((await run("read_web_page", { urls: ["https://example.org/more"] }, "night")).error, false);
  assert.equal((await run("read_web_page", { urls: ["https://example.net/owner-link"] }, "night")).error, true);
  assert.equal((await run("read_web_page", { urls: ["https://example.net/owner-link"] }, "subagent")).error, false, "the fake allows owner links outside the night");
});

test("seen URLs stop counting after 30 days and are pruned; a conversation keeps its newest 2,000", async t => {
  const { db, usage, run, advance, now } = setup(t, { reply: site(["https://example.org/a", "https://example.org/b"]) });
  const rows = (conversation: string) => db.all<{ n: number }>("SELECT count(*) AS n FROM umpi_web_seen WHERE conversation=?", conversation)[0]!.n;
  await run("web_search", SEARCH);
  advance(29 * DAY);
  assert.equal((await run("read_web_page", { urls: ["https://example.org/a"] })).error, false, "still seen after 29 days; the read sees it again");
  advance(2 * DAY);
  assert.equal((await run("read_web_page", { urls: ["https://example.org/a"] })).error, false, "seen again 2 days ago");
  const before = spent(usage);
  assert.equal((await run("read_web_page", { urls: ["https://example.org/b"] })).error, true, "last seen 31 days ago");
  assert.equal(spent(usage), before);
  assert.equal(rows("owner"), 1, "the write pruned the old row");
  assert.deepEqual(db.all<{ hash: string }>("SELECT hash FROM umpi_web_seen").map(row => /^[0-9a-f]{64}$/.test(row.hash)), [true], "rows hold a hash, not the URL");

  const seen = new WebSeenStore(db, now);
  await seen.record("busy", Array.from({ length: 1500 }, (_, index) => `https://example.org/old/${index}`));
  advance(1000);
  await seen.record("busy", Array.from({ length: 1500 }, (_, index) => `https://example.org/new/${index}`));
  assert.equal(rows("busy"), 2000);
  assert.equal(await seen.has("busy", "https://example.org/new/0"), true);
  assert.equal(await seen.has("busy", "https://example.org/new/1499"), true);
  const oldKept = (await Promise.all(Array.from({ length: 1500 }, (_, index) => seen.has("busy", `https://example.org/old/${index}`)))).filter(Boolean).length;
  assert.equal(oldKept, 500, "the oldest rows went first");
  assert.equal(rows("owner"), 1, "the cap is for each conversation");
});
