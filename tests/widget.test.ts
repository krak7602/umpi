import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { openTasks, WidgetStore } from "../src/worker/widget.js";

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

test("widget buttons are a stored choice of known actions; the earlier idea button becomes voice", t => {
  const sqlite = new DatabaseSync(":memory:"); t.after(() => sqlite.close());
  const db = { all: <T extends object>(sql: string, ...values: (string | number | null)[]) => sqlite.prepare(sql).all(...values) as T[], transaction: <T>(run: () => T) => run() };
  const widgets = new WidgetStore(db);
  assert.deepEqual(widgets.actions(), ["voice", "today", "chat", "work"], "the default buttons");
  assert.deepEqual(widgets.setActions(["voice", "remind"]), ["voice", "remind"]);
  assert.throws(() => widgets.setActions(["voice", "voice"]), /once/);
  assert.throws(() => widgets.setActions(["camera"]), /Unknown widget action/);
  sqlite.prepare("UPDATE umpi_widget SET data=? WHERE id=2").run(JSON.stringify(["idea", "today", "ideas"]));
  assert.deepEqual(widgets.actions(), ["voice", "today"], "stored older buttons are read in the new terms");
});
