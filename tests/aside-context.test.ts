import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AsideContextLane, asideMemorySearch, readActivitySummaries, SUMMARY_PUSH_INTERVAL_MS } from "../src/mac/aside-context.js";
import { ActivityStore, ACTIVITY_RETENTION_MS } from "../src/worker/activity-store.js";
import { activityDay } from "../src/worker/activity-tools.js";
import type { ContextReport } from "../src/shared/context.js";
import type { Database } from "../src/worker/store.js";

const T0 = Date.parse("2026-10-21T15:40:00Z");

function temp(t: TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), "umpi-aside-")); t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}
/** A ledger with Aside's real table and column names, including the raw events table that must never be read. */
function ledger(directory: string): { path: string; summary(id: string, minutes: number, status?: string, updated?: number): void } {
  const path = join(directory, "ledger.db"), db = new DatabaseSync(path);
  db.exec(`CREATE TABLE context_awareness_summaries (id TEXT PRIMARY KEY, kind TEXT, window_from INTEGER, window_to INTEGER, created_at INTEGER, updated_at INTEGER,
    title TEXT, description TEXT, body TEXT, apps TEXT, domains TEXT, citations TEXT, source_ids TEXT, status TEXT);
    CREATE TABLE context_awareness_events (id TEXT PRIMARY KEY, occurred_at INTEGER, kind TEXT, payload TEXT);
    INSERT INTO context_awareness_events VALUES ('e1', 0, 'keyboard.text_input', 'typed secret');`);
  return { path, summary(id, minutes, status = "completed", updated = T0 + minutes * 60_000) {
    db.prepare("INSERT INTO context_awareness_summaries VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(id, "10min", T0 + (minutes - 10) * 60_000, T0 + minutes * 60_000, updated, updated,
      `Title ${id}`, `Description ${id}`, `Body ${id}`, JSON.stringify(["Ghostty", "Aside"]), JSON.stringify(["github.com"]), "[]", "[]", status);
  } };
}
function database(t: TestContext): Database {
  const sqlite = new DatabaseSync(":memory:"); t.after(() => sqlite.close());
  return { all: <T extends object>(query: string, ...bindings: (string | number | null)[]) => sqlite.prepare(query).all(...bindings) as T[], transaction: <T>(run: () => T) => run() };
}

test("the Mac reads only completed summaries from Aside's ledger, in update order, and advances its cursor", t => {
  const directory = temp(t), source = ledger(directory);
  source.summary("s-1", 10); source.summary("s-2", 20, "pending"); source.summary("s-3", 30);
  const first = readActivitySummaries(source.path, 0);
  assert.deepEqual(first.summaries.map(summary => summary.id), ["s-1", "s-3"]);
  assert.deepEqual(first.summaries[0], { id: "s-1", windowFrom: new Date(T0).toISOString(), windowTo: new Date(T0 + 600_000).toISOString(),
    title: "Title s-1", description: "Description s-1", body: "Body s-1", apps: ["Ghostty", "Aside"], domains: ["github.com"] });
  assert.doesNotMatch(JSON.stringify(first), /typed secret/);
  // A summary completed later, for an earlier window, is still sent once.
  source.summary("s-0", 0, "completed", T0 + 40 * 60_000);
  assert.deepEqual(readActivitySummaries(source.path, first.cursor).summaries.map(summary => summary.id), ["s-0"]);
  assert.deepEqual(readActivitySummaries(join(directory, "missing.db"), 7), { summaries: [], cursor: 7 });
});

test("the lane answers lookups every tick, sends summaries at most every five minutes, and keeps its cursor across restarts", async t => {
  const directory = temp(t), source = ledger(directory);
  source.summary("s-1", 10);
  let now = T0 + 3_600_000;
  const reports: ContextReport[] = [], requests = [{ id: "memory-1", query: "job search" }, { id: "memory-2", query: "broken" }];
  const transport = { poll: async () => ({ requests: requests.splice(0) }), report: async (report: ContextReport) => { reports.push(report); } };
  const search = async (query: string) => { if (query === "broken") throw new Error("boom"); return [{ path: "projects/jobs.md", title: "Jobs", excerpt: `About ${query}`, date: "2026-10-20", score: 0.9 }]; };
  const lane = new AsideContextLane("executor-1", directory, { ledgerPath: source.path, search, now: () => now });
  await lane.tick(transport);
  assert.deepEqual(reports.map(report => report.kind === "memory" ? `${report.requestId}:${report.status}` : `summaries:${report.summaries.length}`), ["memory-1:ok", "memory-2:error", "summaries:1"]);
  source.summary("s-2", 20);
  await lane.tick(transport); assert.equal(reports.length, 3, "not yet due");
  now += SUMMARY_PUSH_INTERVAL_MS;
  const restarted = new AsideContextLane("executor-1", directory, { ledgerPath: source.path, search, now: () => now });
  await restarted.tick(transport);
  assert.equal(reports.length, 4); assert.deepEqual((reports[3] as { summaries: { id: string }[] }).summaries.map(summary => summary.id), ["s-2"]);
  assert.equal(JSON.parse(readFileSync(join(directory, "aside-context.json"), "utf8")).cursor, T0 + 20 * 60_000);
});

test("a failed summary report does not advance the cursor", async t => {
  const directory = temp(t), source = ledger(directory);
  source.summary("s-1", 10);
  const lane = new AsideContextLane("executor-1", directory, { ledgerPath: source.path, now: () => T0 + 3_600_000 });
  await assert.rejects(lane.tick({ poll: async () => ({ requests: [] }), report: async () => { throw new Error("offline"); } }));
  const sent: ContextReport[] = [];
  await lane.tick({ poll: async () => ({ requests: [] }), report: async report => { sent.push(report); } });
  assert.equal(sent.length, 1);
});

test("memory search runs Aside with a fixed argument list and bounds its output", async t => {
  const directory = temp(t), script = join(directory, "aside");
  writeFileSync(script, `#!/bin/sh\nprintf '%s\\n' "$@" > "${join(directory, "args")}"\nprintf '[{"path":"USER.md","title":"User","excerpt":"Lives in Bangalore","score":0.81234,"date":"2026-10-17","chunkId":"x"},{"bad":1}]'\n`);
  chmodSync(script, 0o700);
  const results = await asideMemorySearch(script)("where do I live; rm -rf /");
  assert.deepEqual(results, [{ path: "USER.md", title: "User", excerpt: "Lives in Bangalore", date: "2026-10-17", score: 0.812 }]);
  assert.deepEqual(readFileSync(join(directory, "args"), "utf8").trim().split("\n"), ["memory", "search", "--json", "-n", "8", "--", "where do I live; rm -rf /"]);
});

test("the coordinator dispatches each lookup once, stores results, keeps two weeks of summaries, and holds one Mac", t => {
  const store = new ActivityStore(database(t));
  let now = T0 + 3_600_000;
  const id = store.requestMemory("job search", now);
  assert.deepEqual(store.poll({ executorId: "mac-1" }, now), { requests: [{ id, query: "job search" }] });
  assert.deepEqual(store.poll({ executorId: "mac-1" }, now).requests, []);
  assert.throws(() => store.poll({ executorId: "mac-2" }, now), /Another Mac/);
  store.report({ executorId: "mac-1", kind: "memory", requestId: id, status: "ok", results: [{ path: "a.md", title: "A", excerpt: "x", date: null, score: null }] }, now);
  assert.equal(store.memoryResult(id)?.status, "done");
  const late = store.requestMemory("late", now); now += 31_000;
  assert.deepEqual(store.poll({ executorId: "mac-1" }, now).requests, [], "an unclaimed lookup is not sent after the tool gave up");
  assert.equal(store.memoryResult(late)?.status, "pending");
  const summary = (sid: string, windowTo: number) => ({ id: sid, windowFrom: new Date(windowTo - 600_000).toISOString(), windowTo: new Date(windowTo).toISOString(), title: sid, description: "", body: "", apps: [], domains: [] });
  store.report({ executorId: "mac-1", kind: "summaries", summaries: [summary("old", now - ACTIVITY_RETENTION_MS - 1), summary("new", now - 60_000), summary("new", now - 60_000)] }, now);
  assert.deepEqual(store.read(0, now).map(item => item.id), ["new"]);
  assert.throws(() => store.report({ executorId: "mac-1", kind: "summaries", summaries: Array.from({ length: 25 }, (_, index) => summary(`s${index}`, now)) }, now));
  now += 11 * 60_000;
  assert.doesNotThrow(() => store.poll({ executorId: "mac-2" }, now), "a different Mac may take over after ten quiet minutes");
});

test("a day of activity is listed oldest first in local time, keeping the newest entries within the budget", t => {
  const store = new ActivityStore(database(t)), now = Date.parse("2026-10-21T18:00:00Z");
  store.report({ executorId: "mac-1", kind: "summaries", summaries: [1, 2, 3].map(index => ({ id: `s${index}`, windowFrom: new Date(T0 + (index - 1) * 600_000).toISOString(), windowTo: new Date(T0 + index * 600_000).toISOString(),
    title: `Work ${index}`, description: "d".repeat(200), body: "b", apps: ["Ghostty"], domains: [] })) }, now);
  const day = activityDay(store, "2026-10-21", "Asia/Kolkata", false) as { entries: { time: string; title: string }[] };
  assert.deepEqual(day.entries.map(entry => `${entry.time} ${entry.title}`), ["21:10–21:20 Work 1", "21:20–21:30 Work 2", "21:30–21:40 Work 3"]);
  const small = activityDay(store, "2026-10-21", "Asia/Kolkata", false, 400) as { entries: { title: string }[]; omittedOlder: number };
  assert.deepEqual(small.entries.map(entry => entry.title), ["Work 3"]); assert.equal(small.omittedOlder, 2);
});
