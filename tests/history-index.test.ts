import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import type { Database } from "../src/worker/store.js";
import { Decisions, type WorkersAi } from "../src/worker/decisions.js";
import { HistoryIndex } from "../src/worker/history-index.js";

function database(t: TestContext): { db: Database; sqlite: DatabaseSync } {
  const sqlite = new DatabaseSync(":memory:"); t.after(() => sqlite.close());
  return { sqlite, db: { all: <T extends object>(query: string, ...bindings: (string | number | null)[]) => sqlite.prepare(query).all(...bindings) as T[], transaction: <T>(run: () => T) => run() } };
}
const DAY = Date.parse("2026-10-20T06:00:00Z");
const passages = [
  { id: "a", text: "assistant: We deployed the worker with the AI binding.", at: DAY },
  { id: "b", text: "owner: Remind me to stretch every evening.", at: DAY + 86_400_000 },
  { id: "c", text: "assistant: The budget for decision models is one dollar a month.", at: DAY + 2 * 86_400_000 },
];

test("keyword search stems words, filters by time, and the reranker orders the fused candidates", async t => {
  const { db } = database(t);
  const reranked: string[][] = [];
  const ai: WorkersAi = { async run(model, raw) {
    const input = raw as { queries?: string[]; documents?: string[]; query?: string; contexts?: { text: string }[] };
    if (model.includes("reranker")) {
      reranked.push(input.contexts!.map(context => context.text));
      // A crude relevance judge: money passages for money questions, deploy passages for deploy questions.
      const query = input.query!;
      return { response: input.contexts!.map((context, id) => ({ id, score: /spend|much/.test(query) && /dollar/.test(context.text) ? 0.9 : /deploy/.test(query) && /deploy/.test(context.text) ? 0.8 : 0.1 })) };
    }
    const texts = input.queries ?? input.documents ?? [];
    return { data: texts.map(text => Array.from({ length: 1024 }, (_, i) => i === 0 ? (/deploy|ship|release/.test(text) ? 1 : 0.01) : i === 1 ? (/budget|dollar|cost|spend/.test(text) ? 1 : 0.01) : 0)) };
  } };
  const index = new HistoryIndex(db, new Decisions(db, ai, () => 1_000));
  index.put(passages.map(passage => ({ ...passage, source: "conversation" as const, period: new Date(passage.at).toISOString().slice(0, 10) })));
  assert.equal(await index.embedPending(), 3);

  const stemmed = await index.search("deploying", { limit: 3 });
  assert.equal(stemmed[0]!.id, "a"); assert.equal(stemmed[0]!.keyword, true, "deploying matches deployed");
  const money = await index.search("how much can we spend", { limit: 3 });
  assert.equal(money[0]!.id, "c"); assert.equal(money[0]!.reranked, true);
  assert.ok(reranked.at(-1)!.length >= 2, "the reranker saw several fused candidates");
  const window = await index.search("stretch evening deployed", { from: DAY + 86_400_000, to: DAY + 2 * 86_400_000 });
  assert.deepEqual(window.map(match => match.id), ["b"], "only passages inside the time window");
});

test("without models, keyword search still answers; an older keyword index moves to the stemmer", async t => {
  const { db, sqlite } = database(t);
  sqlite.exec("CREATE TABLE umpi_history (id TEXT PRIMARY KEY, source TEXT NOT NULL, period TEXT NOT NULL, at INTEGER NOT NULL, text TEXT NOT NULL, vec TEXT)");
  sqlite.exec("CREATE VIRTUAL TABLE umpi_history_fts USING fts5(id UNINDEXED, text, tokenize='unicode61 remove_diacritics 2')");
  sqlite.prepare("INSERT INTO umpi_history VALUES ('old','digest','2026-10-01',1,'We were deploying the release',NULL)").run();
  sqlite.prepare("INSERT INTO umpi_history_fts (id, text) VALUES ('old','We were deploying the release')").run();
  const index = new HistoryIndex(db);
  assert.match(db.all<{ sql: string }>("SELECT sql FROM sqlite_master WHERE name='umpi_history_fts'")[0]!.sql, /porter/);
  const matches = await index.search("deployed");
  assert.deepEqual(matches.map(match => [match.id, match.reranked, match.meaning]), [["old", false, false]]);
});
