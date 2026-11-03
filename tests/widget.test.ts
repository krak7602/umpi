import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { openTasks, WidgetStore } from "../src/worker/widget.js";
import { IdeaStore } from "../src/worker/ideas.js";

test("Umpi chooses widget items for a while, then the default returns; open tasks come from the note", t => {
  const sqlite = new DatabaseSync(":memory:"); t.after(() => sqlite.close());
  let now = Date.parse("2026-11-03T10:00:00Z");
  const store = new WidgetStore({ all: <T extends object>(sql: string, ...values: (string | number | null)[]) => sqlite.prepare(sql).all(...values) as T[], transaction: <T>(run: () => T) => run() }, () => now);
  assert.equal(store.current(), undefined);
  store.set({ items: [{ title: "Retest booked for 1 Feb", detail: "DDRC, fasting", symbol: "drop", link: "today" }], hours: 2 });
  assert.equal(store.current()!.items[0]!.title, "Retest booked for 1 Feb");
  assert.throws(() => store.set({ items: [] }), /1 to 8/);
  assert.throws(() => store.set({ items: [{ title: "x", symbol: "not a symbol!" }] }), /SF Symbol/);
  assert.throws(() => store.set({ items: [{ title: "x", link: "elsewhere" }] }), /chat, today, or work/);
  now += 3 * 3_600_000;
  assert.equal(store.current(), undefined, "an expired choice gives way to the default");
  assert.deepEqual(openTasks("## Tasks\n- [x] Walk\n- [ ] Buy oats and `curd`\n  * [ ] Call **[[Dad|dad]]** ==today==\nText\n"), ["Buy oats and curd", "Call dad today"]);
});

test("widget buttons are a stored choice of known actions; ideas are saved once and found by words", t => {
  const sqlite = new DatabaseSync(":memory:"); t.after(() => sqlite.close());
  const db = { all: <T extends object>(sql: string, ...values: (string | number | null)[]) => sqlite.prepare(sql).all(...values) as T[], transaction: <T>(run: () => T) => run() };
  const widgets = new WidgetStore(db);
  assert.deepEqual(widgets.actions(), ["idea", "today", "chat", "ideas"], "the default buttons");
  assert.deepEqual(widgets.setActions(["idea", "remind"]), ["idea", "remind"]);
  assert.deepEqual(widgets.actions(), ["idea", "remind"]);
  assert.throws(() => widgets.setActions(["idea", "idea"]), /once/);
  assert.throws(() => widgets.setActions(["camera"]), /Unknown widget action/);
  assert.throws(() => widgets.setActions(["idea", "today", "chat", "ideas", "work"]), /1 to 4/);
  widgets.set({ items: [{ title: "x" }] });
  assert.deepEqual(widgets.actions(), ["idea", "remind"], "choosing items leaves the buttons alone");

  let now = Date.parse("2026-11-03T10:00:00Z");
  const ideas = new IdeaStore(db, () => now);
  assert.equal(ideas.add({ id: "i1", text: "A widget that shows the next train", seconds: 6 }).created, true);
  assert.equal(ideas.add({ id: "i1", text: "A widget that shows the next train" }).created, false, "a resent capture is saved once");
  now += 60_000;
  ideas.add({ id: "i2", text: "Cook mathi curry on Sunday" });
  assert.deepEqual(ideas.list().map(idea => idea.id), ["i2", "i1"], "newest first");
  assert.deepEqual(ideas.list("widget train").map(idea => idea.id), ["i1"]);
  assert.throws(() => ideas.add({ id: "i3", text: "   " }), /needs text/);
});
