import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import type { ToolExecutionApi, ToolRegistration } from "@earendil-works/pi-durable";
import { Decisions } from "../src/worker/decisions.js";
import { Store, type Database } from "../src/worker/store.js";
import { WebSeenStore, WebUsageStore, webForeground } from "../src/worker/web-search.js";
import { WebRequests, webRequestCard, webRequestTools } from "../src/worker/web-requests.js";
import { WebWatcher } from "../src/worker/web-watch.js";

// Every venue, title, and address here is invented.
function database(t: TestContext): Database {
  const sqlite = new DatabaseSync(":memory:"); t.after(() => sqlite.close());
  return { all: <T extends object>(query: string, ...bindings: (string | number | null)[]) => sqlite.prepare(query).all(...bindings) as T[], transaction: <T>(run: () => T) => {
    sqlite.exec("BEGIN");
    try { const value = run(); sqlite.exec("COMMIT"); return value; } catch (error) { sqlite.exec("ROLLBACK"); throw error; }
  } };
}

const VENUE = "https://tickets.example/harbour-screens", DATED = "https://tickets.example/harbour-screens/2026-12-18";
const WATCH = { title: "Glass Tide at Harbour Screens", urls: [DATED], lookFor: "Show times for Glass Tide", condition: "Glass Tide is listed with at least one show time.", requires: ["Glass Tide"] };

function setup(t: TestContext, world: { page: string; failed?: boolean } = { page: "Harbour Screens. Paper Lanterns 6:00 PM." }) {
  let now = Date.parse("2026-11-02T10:00:00Z");
  const db = database(t), owner = new Store(db);
  owner.setSession("telegram", "owner");
  const usage = new WebUsageStore(db, () => 4_500, () => now), seen = new WebSeenStore(db, () => now);
  const decisions = new Decisions(db, { async run() { return { answers: { met: { noul: 0.95 } }, usage: { input_tokens: 10 } }; } }, () => 1_000, () => now);
  const read: string[][] = [], admitted: { id: string; text: string; channel: string; sessionId: string }[] = [];
  const watcher = new WebWatcher(db, decisions, { key: () => "test-parallel-key", usage, fetch: (async (_url: string, init: RequestInit) => {
    const urls = (JSON.parse(String(init.body)) as { urls: string[] }).urls;
    read.push(urls);
    return Response.json(world.failed ? { results: [], errors: [{ url: urls[0], error_type: "fetch_error", http_status_code: 404 }] }
      : { results: urls.map(url => ({ url, title: "Harbour Screens", excerpts: [world.page], full_content: world.page, acquired_at: "2026-11-02T00:00:00Z" })), errors: [] });
  }) as typeof fetch }, { notice: () => undefined, now: () => now });
  const cleared: string[] = [];
  const requests = new WebRequests(db, owner, watcher, { seen, admit: (id, text, channel, sessionId) => { admitted.push({ id, text, channel, sessionId }); }, clearButtons: group => { cleared.push(group); }, now: () => now });
  const tools = webRequestTools(requests, watcher, { foreground: webForeground(id => id === "review"), known: (url, id) => seen.has(id, url) });
  const run = async (name: string, input: object, conversationId = "owner") => {
    const output = await (tools.find(tool => tool.name === name) as ToolRegistration).execute(input as never, { conversationId } as unknown as ToolExecutionApi, {} as never);
    const first = output.content?.[0];
    return { error: output.isError === true, value: first?.type === "text" ? first.text : "" };
  };
  const card = (id: string) => owner.deliveries(`web-request:${id}`)[0]!;
  const buttons = (id: string) => card(id).replyMarkup!.inline_keyboard[0]!.map(button => button.callback_data);
  return { world, owner, seen, watcher, requests, read, admitted, cleared, run, card, buttons, advance: (hours: number) => { now += hours * 3_600_000; } };
}

test("a links card shows each address Umpi wrote; Approve makes them readable and continues the conversation", async t => {
  const s = setup(t);
  await s.seen.record("owner", [VENUE]);
  assert.deepEqual(JSON.parse((await s.run("request_web_links", { urls: [VENUE], why: "The venue page" })).value), { requested: false, note: "These addresses are readable already. Call read_web_page with them." });
  const asked = JSON.parse((await s.run("request_web_links", { urls: [VENUE, DATED], why: "The venue's page for 18 December, where the listing will show" })).value) as { requested: boolean; id: string };
  assert.equal(asked.requested, true);
  assert.equal(s.card(asked.id).text, `Open these links?\n\nUmpi worked out these addresses itself. No search result or message of yours had them.\n\nWhy: The venue's page for 18 December, where the listing will show\n\n- ${DATED}\n\nCheck each address Umpi wrote before you approve: a link can carry text to the site it names.`);
  assert.equal(await s.seen.has("owner", DATED), false, "nothing is readable before the owner approves");
  const [approve, decline] = s.buttons(asked.id);
  await assert.rejects(s.requests.press(approve!, undefined, "web-request:other"), /does not belong/);
  const done = await s.requests.press(approve!, undefined, `web-request:${asked.id}`);
  assert.deepEqual(done, { text: "Approved. Umpi is reading.", replyMarkup: { inline_keyboard: [] } });
  assert.equal(await s.seen.has("owner", DATED), true);
  assert.equal(await s.seen.has("other", DATED), false, "only the conversation that asked may read them");
  assert.equal(s.admitted.length, 1);
  assert.equal(s.admitted[0]!.sessionId, "owner"); assert.equal(s.admitted[0]!.channel, "telegram");
  assert.ok(s.admitted[0]!.text.includes(DATED));
  assert.equal((await s.requests.press(decline!, undefined, `web-request:${asked.id}`))!.text, "Already approved.");
  assert.equal(s.admitted.length, 1, "a second press starts nothing");
  assert.equal(await s.requests.press("other:token", 1), undefined);
});

test("a declined or expired card opens nothing, and long or non-https addresses get no card", async t => {
  const s = setup(t);
  const first = JSON.parse((await s.run("request_web_links", { urls: [DATED], why: "The dated page" })).value) as { id: string };
  assert.equal((await s.requests.press(s.buttons(first.id)[1]!, undefined, `web-request:${first.id}`))!.text, "Declined. Nothing was opened.");
  const second = JSON.parse((await s.run("request_web_links", { urls: [`${DATED}?screen=2`], why: "Another page" })).value) as { id: string };
  s.advance(25);
  assert.equal((await s.requests.press(s.buttons(second.id)[0]!, undefined, `web-request:${second.id}`))!.text, "This request expired.");
  assert.equal(await s.seen.has("owner", DATED), false); assert.equal(s.admitted.length, 0);
  assert.match((await s.run("request_web_links", { urls: [`https://tickets.example/?q=${"x".repeat(300)}`], why: "Long" })).value, /An address of more than 300 characters cannot be shown on a card\. Ask the owner to paste that link\./);
  assert.match((await s.run("request_web_links", { urls: [DATED], why: "From a review" }, "review")).value, /owner's own conversation/);
  for (let index = 0; index < 5; index++) assert.equal((await s.run("request_web_links", { urls: [`${DATED}/${index}`], why: "More" })).error, false);
  assert.match((await s.run("request_web_links", { urls: [`${DATED}/9`], why: "Too many" })).value, /5 web requests already wait/);
});

test("a watch card shows the whole watch and marks the addresses Umpi wrote; Approve creates it in code", async t => {
  const s = setup(t);
  await s.seen.record("owner", [VENUE]);
  const asked = JSON.parse((await s.run("request_web_watch", { ...WATCH, urls: [VENUE, DATED], everyMinutes: 120, days: 20, why: "The dated page is where the listing appears" })).value) as { id: string };
  assert.equal(s.card(asked.id).text, `Set up this web watch?\n\nGlass Tide at Harbour Screens\n\n- Tells you when: Glass Tide is listed with at least one show time.\n- Must mention: "Glass Tide"\n- Checks every 120 minutes for 20 days.\n- Why: The dated page is where the listing appears\n\nPages:\n\n- ${VENUE}\n- ${DATED} (Umpi wrote this address)\n\nCheck each address Umpi wrote before you approve: a link can carry text to the site it names.`);
  assert.equal(s.read.length, 0, "nothing is read before the owner approves");
  const done = await s.requests.press(s.buttons(asked.id)[0]!, undefined, `web-request:${asked.id}`);
  assert.equal(done!.text, "Watching: Glass Tide at Harbour Screens");
  assert.deepEqual(s.read, [[VENUE, DATED]]);
  const watch = s.watcher.list()[0]!;
  assert.equal(watch.status, "active"); assert.equal(watch.everyMinutes, 120); assert.deepEqual(watch.urls, [VENUE, DATED]);
  assert.match(s.owner.deliveries(`web-request:${asked.id}:outcome`)[0]!.text, /^Watching: Glass Tide at Harbour Screens\n\nUmpi checks every 120 minutes until 2026-11-22 and tells you when this is true: Glass Tide is listed with at least one show time\.\n\nRight now: The page does not mention "Glass Tide"\.$/);
  assert.equal(s.admitted.length, 0, "a watch card starts no model turn");
  assert.equal(await s.seen.has("owner", DATED), true, "the approved address can be read afterwards");
  assert.equal(JSON.stringify(s.requests.status()).includes("tickets.example"), false, "status carries no address");
});

test("an approved watch that is already true, or whose page cannot be read, says so and saves nothing", async t => {
  const open = setup(t, { page: "Harbour Screens. Glass Tide 7:00 PM, 10:30 PM." });
  const first = JSON.parse((await open.run("request_web_watch", WATCH)).value) as { id: string };
  assert.equal((await open.requests.press(open.buttons(first.id)[0]!, undefined, `web-request:${first.id}`))!.text, "Already true: Glass Tide at Harbour Screens");
  assert.match(open.owner.deliveries(`web-request:${first.id}:outcome`)[0]!.text, /The page text shows the condition is true\.\n\nFrom the page:\n> Harbour Screens\. Glass Tide 7:00 PM, 10:30 PM\.\n\nhttps:\/\/tickets\.example\/harbour-screens\/2026-12-18\n\nNo watch was set up\.$/);
  assert.equal(open.watcher.list().length, 0);

  const missing = setup(t, { page: "", failed: true });
  const second = JSON.parse((await missing.run("request_web_watch", WATCH)).value) as { id: string };
  assert.equal((await missing.requests.press(missing.buttons(second.id)[0]!, undefined, `web-request:${second.id}`))!.text, "No watch was set up: Glass Tide at Harbour Screens");
  assert.match(missing.owner.deliveries(`web-request:${second.id}:outcome`)[0]!.text, /the first live check failed\. The site did not give the page \(fetch_error, status 404\)/);
  assert.equal(missing.requests.request(second.id)!.status, "failed");
  // A watch that could not be saved is refused before any card is shown.
  assert.match((await missing.run("request_web_watch", { ...WATCH, everyMinutes: 5 })).value, /checks every 30 to 1440 minutes/);
});

test("the card is written from the stored request, so a changed request is not run", async t => {
  const s = setup(t);
  const asked = JSON.parse((await s.run("request_web_links", { urls: [DATED], why: "The dated page" })).value) as { id: string };
  const stored = s.requests.request(asked.id)!;
  assert.equal(webRequestCard(stored), s.card(asked.id).text);
  // Something rewrites the stored address after the card went out.
  s.owner.db.all("UPDATE umpi_web_requests SET data=? WHERE id=?", JSON.stringify({ ...stored, urls: ["https://elsewhere.example/?d=private"], composed: ["https://elsewhere.example/?d=private"] }), asked.id);
  assert.match((await s.requests.press(s.buttons(asked.id)[0]!, undefined, `web-request:${asked.id}`))!.text, /no longer matches the card you were shown/);
  assert.equal(await s.seen.has("owner", "https://elsewhere.example/?d=private"), false); assert.equal(s.admitted.length, 0);
});

test("the sweep removes the buttons of an expired card and of a card that no longer matches its request, once", async t => {
  const s = setup(t);
  const live = JSON.parse((await s.run("request_web_links", { urls: [DATED], why: "The dated page" })).value) as { id: string };
  const old = JSON.parse((await s.run("request_web_links", { urls: [`${DATED}?screen=2`], why: "Another page" })).value) as { id: string };
  assert.equal(s.requests.sweep(), 0, "a card that can still be answered keeps its buttons");
  // A later version draws this request's card another way, so the card the owner has is void.
  const stored = s.requests.request(old.id)!;
  s.owner.db.all("UPDATE umpi_web_requests SET data=? WHERE id=?", JSON.stringify({ ...stored, why: "Worded another way" }), old.id);
  assert.equal(s.requests.sweep(), 1);
  assert.deepEqual(s.cleared, [`web-request:${old.id}`]);
  assert.equal(s.requests.request(old.id)!.status, "failed");
  assert.equal(s.requests.request(live.id)!.status, "pending");
  s.advance(25);
  assert.equal(s.requests.sweep(), 1, "the other card is past its 24 hours");
  assert.deepEqual(s.cleared, [`web-request:${old.id}`, `web-request:${live.id}`]);
  assert.equal(s.requests.sweep(), 0, "each card is cleared once");
});
