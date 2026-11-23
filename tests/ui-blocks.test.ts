import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import { ChatLog } from "../src/worker/chat.js";
import { Store, type Database } from "../src/worker/store.js";
import { uiTools } from "../src/worker/ui-blocks.js";
import { UI_CATALOG, UI_LIMITS, uiCatalogText, validateUiSpec } from "../src/worker/ui-spec.js";
import { webForeground } from "../src/worker/web-search.js";

// Every title, place, and number here is invented.
const TRAINS = { type: "card", title: "Trains to the coast", children: [
  { type: "table", columns: [{ title: "Leaves" }, { title: "Arrives" }, { title: "Fare", align: "end" }], rows: [["07:10", "09:25", 420], ["09:40", "11:50", "380"]] },
  { type: "stack", direction: "horizontal", gap: "small", children: [{ type: "badge", label: "Fastest: 07:10", tone: "positive" }, { type: "button", label: "Remind me at 6:30 for the 07:10", action: "send" }] },
] };

test("a block of known components is accepted and cleaned; numbers in table cells become text", () => {
  const checked = validateUiSpec(TRAINS);
  assert.equal(checked.ok, true);
  if (!checked.ok) return;
  assert.deepEqual((checked.spec.children as { rows: unknown }[])[0]!.rows, [["07:10", "09:25", "420"], ["09:40", "11:50", "380"]]);
  assert.deepEqual(checked.urls, []);
  // Every component type passes with its smallest valid form.
  const smallest: Record<string, object> = {
    stack: { children: [{ type: "divider" }] }, grid: { columns: 2, children: [{ type: "divider" }] }, card: { children: [{ type: "divider" }] },
    section: { title: "Plan", children: [{ type: "divider" }] }, tabs: { tabs: [{ label: "Day", children: [{ type: "divider" }] }, { label: "Week", children: [{ type: "divider" }] }] },
    disclosure: { title: "More", children: [{ type: "divider" }] }, divider: {}, text: { text: "Dry until six." }, markdown: { text: "**Dry** until six." }, icon: { name: "sun.max" },
    badge: { label: "Open" }, stat: { label: "Fare", value: "420" }, keyvalue: { rows: [{ label: "Platform", value: "3" }] }, list: { items: [{ title: "Water the ferns" }] },
    table: { columns: [{ title: "Leaves" }], rows: [["07:10"]] }, progress: { value: 0.4 }, timeline: { items: [{ title: "Leave home" }] },
    chart: { kind: "line", series: [{ name: "Fare", points: [{ x: "Mon", y: 420 }, { x: 2, y: 380 }] }] }, button: { label: "Book the 07:10", action: "send" },
    link: { label: "Timetable", url: "https://trains.example/coast" },
  };
  assert.deepEqual(Object.keys(smallest).sort(), Object.keys(UI_CATALOG).sort(), "the test covers every component");
  for (const [type, props] of Object.entries(smallest)) assert.equal(validateUiSpec({ type, ...props }).ok, true, type);
});

test("what does not fit the format is refused with the place and the fix", () => {
  const errors = (spec: unknown) => { const checked = validateUiSpec(spec); return checked.ok ? [] : checked.errors; };
  assert.match(errors({ type: "flightCard", title: "x" })[0]!, /^ui: "flightCard" is not a component; use stack, grid, card/);
  assert.deepEqual(errors({ type: "text", text: "Hello", colour: "red" }), ["ui(text).colour: is not a property here; use text, style, tone, align"]);
  assert.deepEqual(errors({ type: "card", children: [{ type: "stat", label: "Fare" }] }), ["ui(card).children[0](stat).value: is required"]);
  assert.deepEqual(errors({ type: "badge", label: "Open", tone: "green" }), ["ui(badge).tone: must be one of neutral, accent, positive, warning, critical, muted"]);
  assert.deepEqual(errors({ type: "table", columns: [{ title: "A" }, { title: "B" }], rows: [["1"]] }), ["ui(table).rows[0]: has 1 cells for 2 columns"]);
  assert.deepEqual(errors({ type: "progress", value: 40 }), ["ui(progress).value: must be from 0 to 1"]);
  assert.deepEqual(errors({ type: "button", label: "Open it", action: "open" }), ["ui(button).url: is required for action open"]);
  assert.deepEqual(errors({ type: "button", label: "Yes", action: "send", text: "Delete everything" }), ["ui(button): a send button sends its label; it takes no url or text"]);
  assert.deepEqual(errors({ type: "link", label: "Notes", url: "http://trains.example" }), ["ui(link).url: must be an https address"]);
  assert.deepEqual(errors({ type: "card", children: [] }), ["ui(card).children: must be a list of at least one component"]);
  assert.deepEqual(errors("a card"), ["ui: must be a component: an object with a type"]);
  // A prototype name is not a component.
  assert.match(errors({ type: "constructor" })[0]!, /is not a component/);
  let deep: object = { type: "divider" };
  for (let level = 0; level < UI_LIMITS.depth; level++) deep = { type: "stack", children: [deep] };
  assert.match(errors(deep).join("\n"), /nested deeper than 6 levels/);
  const wide = { type: "stack", children: Array.from({ length: 24 }, () => ({ type: "stack", children: Array.from({ length: 8 }, () => ({ type: "divider" })) })) };
  assert.match(errors(wide).join("\n"), /more than 150 components/);
  assert.match(errors({ type: "stack", children: Array.from({ length: 4 }, () => ({ type: "markdown", text: "x".repeat(4_000) })) }).join("\n"), /larger than 12000 characters/);
  assert.equal(errors({ type: "stack", children: Array.from({ length: 24 }, () => ({ type: "text", text: 7 })) }).length, 12, "a long list of errors is cut");
});

test("the guide for the model is written from the catalog and names every component", () => {
  const guide = uiCatalogText();
  for (const type of Object.keys(UI_CATALOG)) assert.ok(guide.includes(`- ${type}(`), type);
  assert.ok(guide.includes("- list(style?: plain|numbered|checklist, items: [{title, detail?, icon?, trailing?, tone?, checked?}])"));
  assert.ok(guide.length < 2_400, "the guide is part of every owner request");
});

function fixture(t: TestContext) {
  const sqlite = new DatabaseSync(":memory:"); t.after(() => sqlite.close());
  let depth = 0;
  const db: Database = {
    all: <T extends object>(query: string, ...bindings: (string | number | null)[]) => sqlite.prepare(query).all(...bindings) as T[],
    transaction: <T>(run: () => T): T => {
      const name = `u_${depth++}`; sqlite.exec(`SAVEPOINT ${name}`);
      try { const value = run(); sqlite.exec(`RELEASE ${name}`); return value; }
      catch (error) { sqlite.exec(`ROLLBACK TO ${name}; RELEASE ${name}`); throw error; }
      finally { depth--; }
    },
  };
  const store = new Store(db), chat = new ChatLog(db);
  store.chat = chat;
  store.setSession("telegram", "owner"); store.registerBackgroundSession("review", "telegram");
  const known = new Set(["https://trains.example/coast"]);
  const tool = uiTools(store, chat, { foreground: webForeground(id => id === "review"), known: async url => known.has(url) })[0]!;
  const show = async (spec: unknown, conversationId = "owner") => {
    const output = await tool.execute({ spec } as never, { conversationId } as unknown as ToolExecutionApi, {} as never);
    return { error: output.isError === true, text: (output.content![0] as { text: string }).text };
  };
  const entries = () => chat.page({ limit: 20 }).entries;
  return { store, chat, show, entries };
}

test("show_ui attaches blocks to the reply of the running turn, in order, and to no other reply", async t => {
  const f = fixture(t);
  assert.match((await f.show(TRAINS)).text, /No reply is being written/);
  const first = f.store.admit("m1", "When are the trains to the coast?", "telegram", "owner");
  assert.deepEqual(JSON.parse((await f.show(TRAINS)).text), { shown: true, position: 1, note: "The block appears under your reply. Write the reply text now; it must stand without the block." });
  assert.equal(JSON.parse((await f.show({ type: "link", label: "Timetable", url: "https://trains.example/coast" })).text).position, 2);
  assert.equal(f.entries().find(entry => entry.role === "umpi"), undefined, "nothing is shown before the reply");
  f.store.settle(first.id, "Two trains leave before ten; the 07:10 is faster.");
  const reply = f.entries().find(entry => entry.role === "umpi")!;
  assert.equal(reply.text, "Two trains leave before ten; the 07:10 is faster.");
  assert.equal(reply.ui!.length, 2);
  assert.equal((reply.ui![0] as { title: string }).title, "Trains to the coast");
  assert.deepEqual(reply.ui![1], { type: "link", label: "Timetable", url: "https://trains.example/coast" });
  // The next turn's reply starts without blocks.
  const second = f.store.admit("m2", "Thanks", "telegram", "owner");
  f.store.settle(second.id, "Any time.");
  assert.equal(f.entries().filter(entry => entry.role === "umpi").at(-1)!.ui, undefined);
});

test("show_ui refuses a bad block, an address the conversation does not have, a fourth block, and a background review", async t => {
  const f = fixture(t);
  f.store.admit("m1", "Show me the plan", "telegram", "owner");
  const bad = await f.show({ type: "card", children: [{ type: "stat", label: "Fare" }] });
  assert.equal(bad.error, true);
  assert.equal(bad.text, "The block does not fit the format. Fix these and call show_ui again:\nui(card).children[0](stat).value: is required");
  const composed = await f.show({ type: "button", label: "Open the booking page", action: "open", url: "https://elsewhere.example/?d=private" });
  assert.match(composed.text, /^Not shown: https:\/\/elsewhere\.example\/\?d=private\. A block takes an address only when/);
  for (let index = 1; index <= UI_LIMITS.blocks; index++) assert.equal((await f.show({ type: "text", text: `Part ${index}` })).error, false);
  assert.match((await f.show({ type: "text", text: "One more" })).text, /already has 3 blocks/);
  assert.match((await f.show(TRAINS, "review")).text, /owner's own conversation/);
});
