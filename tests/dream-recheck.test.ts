import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { shiftPlanningDay } from "../src/shared/daily-planning.js";
import { Decisions, type WorkersAi } from "../src/worker/decisions.js";
import { DreamStore, RECHECK_BUCKETS, RECHECK_SAMPLE, type Night, type RecheckCounts, type RecheckMonth, type RecheckRun } from "../src/worker/dream-store.js";
import { DreamRuntime } from "../src/worker/dream-tools.js";
import { HistoryIndex } from "../src/worker/history-index.js";
import { ProactiveStore } from "../src/worker/proactive-store.js";
import { Store, type Database } from "../src/worker/store.js";

// Every night, probe, and passage here is invented.
const TODAY = "2026-11-20";
const ago = (days: number) => shiftPlanningDay(TODAY, -days);

function fixture(t: TestContext) {
  const sqlite = new DatabaseSync(":memory:"); let depth = 0; t.after(() => sqlite.close());
  const db: Database = {
    all: <T extends object>(query: string, ...bindings: (string | number | null)[]) => sqlite.prepare(query).all(...bindings) as T[],
    transaction<T>(run: () => T): T {
      const name = `d_${depth++}`; sqlite.exec(`SAVEPOINT ${name}`);
      try { const value = run(); sqlite.exec(`RELEASE ${name}`); return value; }
      catch (error) { sqlite.exec(`ROLLBACK TO ${name}; RELEASE ${name}`); throw error; }
      finally { depth--; }
    },
  };
  const dream = new DreamStore(new ProactiveStore(new Store(db), "UTC"));
  /** A closed night as the store keeps it, with its probes. */
  const night = (day: string, probes: Night["probes"]) => {
    const at = `${day}T21:00:00.000Z`;
    const record: Night = { day, version: 3, status: "compacted", manual: false, runId: `run-${day}`, since: at, requestedAt: at, committedAt: at, probes, overnight: null, lessonEdits: 0,
      compaction: { at, sessions: 1, failed: 0, probesKept: probes.length, probesRepaired: 0 } };
    db.all("INSERT INTO umpi_dream_nights VALUES (?,?) ON CONFLICT(day) DO UPDATE SET data=excluded.data", day, JSON.stringify(record));
  };
  const status = () => (dream.status() as { recheck: { lastRun: RecheckRun | null; months: ({ month: string } & RecheckMonth)[] } }).recheck;
  return { db, dream, night, status };
}
type Fixture = ReturnType<typeof fixture>;
const runtime = (f: Fixture, decisions: Decisions, index: HistoryIndex, track?: (work: Promise<void>) => void) =>
  new DreamRuntime(f.dream, decisions, index, { sessions: () => [], async compact() {}, ...(track ? { track } : {}) });

/** One invented subject for each age range: the day's digest holds the answer to that day's probe. */
const SUBJECTS = [
  { age: 3, word: "kiln", text: "Chose the celadon glaze for the kiln batch and booked the firing.", question: "Which glaze did we choose for the kiln batch?", answer: "Celadon." },
  { age: 12, word: "orchard", text: "Ordered forty quince saplings for the orchard, to arrive in March.", question: "How many saplings were ordered for the orchard?", answer: "Forty." },
  { age: 45, word: "telescope", text: "The telescope mirror is to be recoated by the workshop in Lyon.", question: "Where is the telescope mirror to be recoated?", answer: "Lyon." },
  { age: 150, word: "lighthouse", text: "Agreed to paint the lighthouse stairs teal before the open day.", question: "Which colour was agreed for the lighthouse stairs?", answer: "Teal." },
];
/** Embeddings by subject word, and a reranker that prefers passages sharing the question's subject word. */
function subjectAi(calls: string[] = []): WorkersAi {
  const subject = (text: string) => SUBJECTS.findIndex(item => text.toLowerCase().includes(item.word));
  return { async run(model, raw) {
    calls.push(model);
    const input = raw as { queries?: string[]; documents?: string[]; query?: string; contexts?: { text: string }[] };
    if (model.includes("reranker")) return { response: input.contexts!.map((context, id) => ({ id, score: subject(context.text) === subject(input.query!) ? 0.9 : 0.1 })) };
    return { data: (input.queries ?? input.documents ?? []).map(text => Array.from({ length: 1024 }, (_, i) => i === subject(text) ? 1 : 0.01)) };
  } };
}
/** The last night, four old nights with one probe each, their day digests, and two passages of other days. */
async function history(f: Fixture, index: HistoryIndex) {
  f.night(TODAY, [{ question: "What was planned for the greenhouse?", answer: "New vents." }]);
  for (const item of SUBJECTS) {
    f.night(ago(item.age), [{ question: item.question, answer: item.answer }]);
    index.put([{ id: `day:${ago(item.age)}`, source: "digest", period: ago(item.age), at: Date.parse(`${ago(item.age)}T21:00:00Z`), text: `day ${ago(item.age)}: ${item.text}` }]);
  }
  index.put([{ id: "week:2026-W46", source: "digest", period: "2026-W46", at: Date.parse(`${ago(5)}T21:00:00Z`), text: "week 2026-W46: Talked about the kiln shelves and the orchard fence, with no decision." },
    { id: `day:${ago(60)}`, source: "digest", period: ago(60), at: Date.parse(`${ago(60)}T21:00:00Z`), text: `day ${ago(60)}: Sorted the seed catalogue and cleaned the workshop.` }]);
  await index.embedPending();
}
const counts = (values: Partial<RecheckCounts>): RecheckCounts => ({ count: 1, top1: 0, top3: 0, top10: 0, missing: 0, ...values });
const FOUND = counts({ top1: 1, top3: 1, top10: 1 });

test("the sample of old probes is the same on a repeated call and is spread over the age ranges", t => {
  const f = fixture(t);
  for (let age = 0; age <= 200; age++) f.night(ago(age), [0, 1, 2].map(n => ({ question: `Invented question ${n} of the day ${age} days back?`, answer: `Answer ${n}.` })));
  const sample = f.dream.recheckSample(TODAY);
  assert.equal(sample.length, RECHECK_SAMPLE);
  assert.deepEqual(f.dream.recheckSample(TODAY), sample, "a repeated call picks the same probes");
  for (const bucket of RECHECK_BUCKETS) {
    const picked = sample.filter(probe => probe.bucket === bucket.id);
    assert.equal(picked.length, 3, `three probes aged ${bucket.id} days`);
    assert.equal(new Set(picked.map(probe => probe.day)).size, 3, "from three different nights");
    for (const probe of picked) assert.ok(probe.day <= ago(bucket.from) && probe.day >= ago(bucket.to), `${probe.day} is ${bucket.id} days old`);
  }
  const next = f.dream.recheckSample(shiftPlanningDay(TODAY, 1)).map(probe => probe.question);
  assert.ok(next.filter(question => sample.some(probe => probe.question === question)).length <= 4, "another day picks mostly other probes");
});

test("while old age ranges are empty, the sample is filled from the ranges that have probes", t => {
  const f = fixture(t);
  for (let age = 0; age <= 20; age++) f.night(ago(age), [0, 1].map(n => ({ question: `Invented question ${n} of the day ${age} days back?`, answer: "Yes." })));
  f.night(ago(30), []);
  const sample = f.dream.recheckSample(TODAY);
  assert.equal(sample.length, RECHECK_SAMPLE);
  assert.deepEqual([...new Set(sample.map(probe => probe.bucket))].sort(), ["2-7", "8-30"]);
  assert.equal(sample.filter(probe => probe.bucket === "2-7").length, 6);
  assert.deepEqual(fixture(t).dream.recheckSample(TODAY), [], "no nights, no sample");
});

test("a found night counts as top-1, a night removed from the index as missing, and a day is re-checked once", async t => {
  const f = fixture(t), calls: string[] = [];
  const decisions = new Decisions(f.db, subjectAi(calls), () => 1_000), index = new HistoryIndex(f.db, decisions);
  await history(f, index);
  index.pruneDays(ago(100)); // The 150-day-old day leaves the index; its night record and probe stay.
  calls.length = 0;
  const nightly = runtime(f, decisions, index);
  await nightly.drive();
  assert.deepEqual(f.status().months, [{ month: "2026-11", full: { "2-7": FOUND, "8-30": FOUND, "31-120": FOUND, "121+": counts({ missing: 1 }) } }]);
  const { at, ...last } = f.status().lastRun!;
  assert.deepEqual(last, { day: TODAY, sampled: 4, full: 4, keywordOnly: 0, untallied: 0, unavailable: { meaning: 0, rerank: 0 } });
  assert.ok(Date.parse(at) > 0);
  assert.equal(calls.filter(model => model.includes("embedding")).length, 4, "one query embedding for each probe");
  assert.equal((decisions.status() as { byPurpose: Record<string, { calls: number }> }).byPurpose["history-recheck"]!.calls, calls.length, "usage is reported under its own purpose");

  // Nothing runs twice for the same day: not in this runtime, not in a new one, and not in the store.
  calls.length = 0;
  await nightly.drive(); await runtime(f, decisions, index).drive();
  assert.equal(calls.length, 0);
  assert.equal(f.dream.recordRecheck({ day: TODAY, at, sampled: 1, untallied: 0, unavailable: { meaning: 0, rerank: 0 } }, [{ bucket: "2-7", mode: "full", rank: 0 }]), false);
  assert.equal(f.status().months[0]!.full!["2-7"]!.count, 1);

  // The tally and the last run hold counts only.
  const stored = f.db.all<{ data: string }>("SELECT data FROM umpi_dream_recheck").map(row => row.data).join("\n");
  for (const item of SUBJECTS) for (const text of [item.word, item.question, item.answer.replace(".", "")]) assert.ok(!stored.toLowerCase().includes(text.toLowerCase()), `no probe text: ${text}`);
  assert.doesNotMatch(stored, /question|answer/);
});

test("a place below the first is counted in top-3 or top-10, and the next night adds to the same month", async t => {
  const f = fixture(t);
  // No models: keyword ranking alone. Two other days say more about the kiln than the probe's own day.
  const index = new HistoryIndex(f.db), decisions = new Decisions(f.db, undefined, () => 1_000);
  f.night(TODAY, []);
  f.night(ago(3), [{ question: "kiln glaze", answer: "Celadon." }]);
  index.put([{ id: `day:${ago(3)}`, source: "digest", period: ago(3), at: 3, text: `day ${ago(3)}: Talked for a long while about many other things, such as the garden wall, the cellar door, and the roof, and at the end chose a glaze.` },
    { id: `day:${ago(70)}`, source: "digest", period: ago(70), at: 1, text: "kiln glaze kiln glaze" }, { id: `day:${ago(71)}`, source: "digest", period: ago(71), at: 2, text: "kiln glaze kiln" }]);
  await runtime(f, decisions, index).drive();
  assert.deepEqual(f.status().months[0]!.keywordOnly, { "2-7": counts({ top3: 1, top10: 1 }) });

  // The next night re-checks the same probe at a higher age; the month's tally grows, and the last run is replaced.
  const tomorrow = shiftPlanningDay(TODAY, 1);
  f.night(tomorrow, []);
  for (let n = 0; n < 12; n++) index.put([{ id: `day:${ago(80 + n)}`, source: "digest", period: ago(80 + n), at: 10 + n, text: "glaze glaze glaze" }]);
  await runtime(f, decisions, index).drive();
  assert.deepEqual(f.status().months[0]!.keywordOnly, { "2-7": { count: 2, top1: 0, top3: 1, top10: 1, missing: 1 } });
  assert.equal(f.status().lastRun!.day, tomorrow);
});

test("an unavailable decision service is tallied apart as keyword only", async t => {
  const f = fixture(t);
  const decisions = new Decisions(f.db, subjectAi(), () => 1_000), index = new HistoryIndex(f.db, decisions);
  await history(f, index);
  // Tonight the service is off: the same index, searched without embeddings or reranking.
  const off = new Decisions(f.db, undefined, () => 1_000);
  await runtime(f, off, new HistoryIndex(f.db, off)).drive();
  const last = f.status().lastRun!;
  assert.deepEqual([last.full, last.keywordOnly, last.unavailable.meaning], [0, 4, 4]);
  assert.deepEqual(Object.keys(f.status().months[0]!).sort(), ["keywordOnly", "month"]);
  assert.deepEqual(f.status().months[0]!.keywordOnly!["8-30"], FOUND);

  // The next night the service answers: its results go to `full`, and the keyword-only counts stay as they were.
  f.night(shiftPlanningDay(TODAY, 1), []);
  await runtime(f, decisions, index).drive();
  const month = f.status().months[0]!;
  assert.equal(Object.values(month.keywordOnly!).reduce((sum, bucket) => sum + bucket.count, 0), 4);
  assert.equal(Object.values(month.full!).reduce((sum, bucket) => sum + bucket.count, 0), 4);

  // A failing reranker after a working embedding is neither full nor keyword only: searched, not tallied.
  f.night(shiftPlanningDay(TODAY, 2), []);
  const half: WorkersAi = { async run(model, raw) { if (model.includes("reranker")) throw new Error("down"); return subjectAi().run(model, raw); } };
  const halfDecisions = new Decisions(f.db, half, () => 1_000);
  await runtime(f, halfDecisions, new HistoryIndex(f.db, halfDecisions)).drive();
  const mixed = f.status().lastRun!;
  // Five probes now: the first night of this test is two days old, so its probe is sampled too.
  assert.deepEqual([mixed.sampled, mixed.full, mixed.keywordOnly, mixed.unavailable.meaning], [5, 0, 0, 0]);
  assert.ok(mixed.untallied > 0 && mixed.untallied === mixed.unavailable.rerank);
});

test("a used-up budget skips the re-check and says so; the re-check waits for the night's own work and can run tracked", async t => {
  const f = fixture(t), calls: string[] = [];
  const decisions = new Decisions(f.db, subjectAi(calls), () => 1_000), index = new HistoryIndex(f.db, decisions);
  await history(f, index);
  calls.length = 0;
  const spent = new Decisions(f.db, subjectAi(calls), () => 0);
  await runtime(f, spent, new HistoryIndex(f.db, spent)).drive();
  assert.equal(calls.length, 0, "no model call");
  assert.equal(f.status().lastRun!.skipped, "budget"); assert.equal(f.status().lastRun!.sampled, 0);
  assert.deepEqual(f.status().months, []);

  // A night that is committed but not yet compacted is not re-checked before its compaction.
  const tomorrow = shiftPlanningDay(TODAY, 1);
  f.night(tomorrow, []);
  f.db.all("UPDATE umpi_dream_nights SET data=json_set(data,'$.status','committed') WHERE day=?", tomorrow);
  assert.equal(f.dream.recheckDue(), undefined);
  f.dream.compacted(tomorrow, { at: `${tomorrow}T21:05:00.000Z`, sessions: 0, failed: 0, probesKept: 0, probesRepaired: 0 });
  assert.equal(f.dream.recheckDue(), tomorrow);

  // With a tracker the drive hands the re-check over and does not wait for it.
  const tracked: Promise<void>[] = [];
  await runtime(f, decisions, index, work => { tracked.push(work); }).drive();
  assert.equal(tracked.length, 1);
  await tracked[0];
  assert.equal(f.status().lastRun!.day, tomorrow); assert.equal(f.status().lastRun!.full, 4);
});
