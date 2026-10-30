import { InputError } from "../shared/protocol.js";
import { DecisionUnavailable, type Decisions } from "./decisions.js";
import type { Database } from "./store.js";

/**
 * Search over the owner's past: nightly digests and the day's conversation text, in the Durable Object's own
 * SQLite, so it needs no extra service or storage. Each passage is found two ways and the rankings are fused:
 * BM25 keyword ranking (SQLite FTS5, with English stemming) and meaning (256-dimension embeddings stored as int8,
 * scanned in full). The fused candidates are then reranked by a cross-encoder. At personal scale a full scan is a few
 * megabytes; no approximate index is needed.
 */
export interface HistoryPassage { id: string; source: "digest" | "conversation"; period: string; at: number; text: string }
export interface HistoryMatch { id: string; source: string; period: string; at: string; text: string; keyword: boolean; meaning: boolean; reranked: boolean }

const RRF_K = 60;
/** Fused candidates the reranker reads. */
const RERANK_CANDIDATES = 30;
const FTS_TABLE = "CREATE VIRTUAL TABLE IF NOT EXISTS umpi_history_fts USING fts5(id UNINDEXED, text, tokenize='porter unicode61 remove_diacritics 2')";
const CANDIDATES = 40;
const EMBED_BATCH = 32;

/** int8 per dimension, stored as base64 text: 256 dimensions are 344 characters. */
function quantize(vector: number[]): string {
  let binary = "";
  for (const value of vector) binary += String.fromCharCode(Math.max(-127, Math.min(127, Math.round(value * 127))) & 0xff);
  return btoa(binary);
}
function dot(query: number[], encoded: string): number {
  const binary = atob(encoded);
  let sum = 0;
  for (let i = 0; i < binary.length && i < query.length; i++) { const byte = binary.charCodeAt(i); sum += query[i]! * (byte > 127 ? byte - 256 : byte); }
  return sum / 127;
}
/** FTS5 query from plain words: each word quoted, any may match. */
export function ftsQuery(query: string): string {
  const words = [...new Set(query.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(word => word.length > 1))].slice(0, 12);
  if (!words.length) throw new InputError("Search needs at least one word");
  return words.map(word => `"${word}"`).join(" OR ");
}

export class HistoryIndex {
  constructor(private readonly db: Database, private readonly decisions?: Decisions) {
    for (const sql of [
      "CREATE TABLE IF NOT EXISTS umpi_history (id TEXT PRIMARY KEY, source TEXT NOT NULL, period TEXT NOT NULL, at INTEGER NOT NULL, text TEXT NOT NULL, vec TEXT)",
      "CREATE INDEX IF NOT EXISTS umpi_history_unembedded ON umpi_history(at) WHERE vec IS NULL",
    ]) db.all(sql);
    // The keyword index moved to the stemming tokenizer; an older index is rebuilt from the passages once.
    const existing = db.all<{ sql: string }>("SELECT sql FROM sqlite_master WHERE name='umpi_history_fts'")[0]?.sql;
    if (existing && !existing.includes("porter")) {
      db.transaction(() => {
        db.all("DROP TABLE umpi_history_fts");
        db.all(FTS_TABLE);
        db.all("INSERT INTO umpi_history_fts (id, text) SELECT id, text FROM umpi_history");
      });
    } else if (!existing) db.all(FTS_TABLE);
  }
  /** Adds or replaces passages; a changed passage is embedded again. */
  put(passages: HistoryPassage[]): void {
    this.db.transaction(() => {
      for (const passage of passages) {
        const old = this.db.all<{ text: string }>("SELECT text FROM umpi_history WHERE id=?", passage.id)[0];
        if (old?.text === passage.text) continue;
        this.db.all("INSERT INTO umpi_history VALUES (?,?,?,?,?,NULL) ON CONFLICT(id) DO UPDATE SET source=excluded.source,period=excluded.period,at=excluded.at,text=excluded.text,vec=NULL",
          passage.id, passage.source, passage.period, passage.at, passage.text);
        this.db.all("DELETE FROM umpi_history_fts WHERE id=?", passage.id);
        this.db.all("INSERT INTO umpi_history_fts (id, text) VALUES (?,?)", passage.id, passage.text);
      }
    });
  }
  /** Drops passages of a source older than `before`, such as conversation text past its retention. */
  prune(source: HistoryPassage["source"], before: number): void {
    this.db.transaction(() => {
      for (const row of this.db.all<{ id: string }>("SELECT id FROM umpi_history WHERE source=? AND at<?", source, before)) this.db.all("DELETE FROM umpi_history_fts WHERE id=?", row.id);
      this.db.all("DELETE FROM umpi_history WHERE source=? AND at<?", source, before);
    });
  }
  unembedded(): number { return this.db.all<{ n: number }>("SELECT count(*) AS n FROM umpi_history WHERE vec IS NULL")[0]?.n ?? 0; }
  /** Embeds waiting passages in batches; returns how many were embedded. Unavailable models leave them for later. */
  async embedPending(maxBatches = 4): Promise<number> {
    if (!this.decisions?.available()) return 0;
    let done = 0;
    for (let batch = 0; batch < maxBatches; batch++) {
      const rows = this.db.all<{ id: string; text: string }>("SELECT id, text FROM umpi_history WHERE vec IS NULL ORDER BY at DESC LIMIT ?", EMBED_BATCH);
      if (!rows.length) break;
      let vectors: number[][];
      try { vectors = await this.decisions.embed("history", rows.map(row => row.text), "document"); }
      catch (error) { if (error instanceof DecisionUnavailable) break; throw error; }
      this.db.transaction(() => rows.forEach((row, index) => this.db.all("UPDATE umpi_history SET vec=? WHERE id=? AND vec IS NULL", quantize(vectors[index]!), row.id)));
      done += rows.length;
    }
    return done;
  }

  /**
   * Keyword and meaning rankings fused by reciprocal rank, then reranked by the cross-encoder. Meaning or reranking
   * is skipped when its model is unavailable. `from` and `to` bound the passage time in milliseconds.
   */
  async search(query: string, options: { source?: HistoryPassage["source"]; limit?: number; from?: number; to?: number } = {}): Promise<HistoryMatch[]> {
    const limit = Math.min(options.limit ?? 8, 20);
    const where: string[] = [], bindings: (string | number)[] = [];
    if (options.source) { where.push("h.source=?"); bindings.push(options.source); }
    if (options.from !== undefined) { where.push("h.at>=?"); bindings.push(options.from); }
    if (options.to !== undefined) { where.push("h.at<?"); bindings.push(options.to); }
    const filter = where.length ? ` AND ${where.join(" AND ")}` : "";
    const keyword = this.db.all<{ id: string }>(`SELECT f.id AS id FROM umpi_history_fts f JOIN umpi_history h ON h.id=f.id WHERE umpi_history_fts MATCH ?${filter} ORDER BY bm25(umpi_history_fts) LIMIT ?`,
      ftsQuery(query), ...bindings, CANDIDATES).map(row => row.id);
    let meaning: string[] = [];
    if (this.decisions?.available()) {
      try {
        const [vector] = await this.decisions.embed("history-search", [query], "query");
        meaning = this.db.all<{ id: string; vec: string }>(`SELECT h.id AS id, h.vec AS vec FROM umpi_history h WHERE h.vec IS NOT NULL${filter}`, ...bindings)
          .map(row => ({ id: row.id, score: dot(vector!, row.vec) })).sort((a, b) => b.score - a.score).slice(0, CANDIDATES).map(row => row.id);
      } catch (error) { if (!(error instanceof DecisionUnavailable)) throw error; }
    }
    const fused = new Map<string, number>();
    keyword.forEach((id, rank) => fused.set(id, (fused.get(id) ?? 0) + 1 / (RRF_K + rank + 1)));
    meaning.forEach((id, rank) => fused.set(id, (fused.get(id) ?? 0) + 1 / (RRF_K + rank + 1)));
    const candidates = [...fused.entries()].sort((a, b) => b[1] - a[1]).slice(0, RERANK_CANDIDATES).map(([id]) => id);
    if (!candidates.length) return [];
    const rows = this.db.all<{ id: string; source: string; period: string; at: number; text: string }>(`SELECT id, source, period, at, text FROM umpi_history WHERE id IN (${candidates.map(() => "?").join(",")})`, ...candidates);
    const byId = new Map(rows.map(row => [row.id, row]));
    let ordered = candidates.filter(id => byId.has(id)), reranked = false;
    if (this.decisions?.available() && ordered.length > 1) {
      try {
        const scores = await this.decisions.rerank("history-search", query, ordered.map(id => byId.get(id)!.text));
        ordered = ordered.map((id, index) => ({ id, score: scores[index]! })).sort((a, b) => b.score - a.score).map(item => item.id);
        reranked = true;
      } catch (error) { if (!(error instanceof DecisionUnavailable)) throw error; }
    }
    return ordered.slice(0, limit).map(id => { const row = byId.get(id)!;
      return { id, source: row.source, period: row.period, at: new Date(row.at).toISOString(), text: row.text.slice(0, 1_500), keyword: keyword.includes(id), meaning: meaning.includes(id), reranked }; });
  }
  status(): object {
    const rows = this.db.all<{ source: string; n: number; embedded: number }>("SELECT source, count(*) AS n, sum(vec IS NOT NULL) AS embedded FROM umpi_history GROUP BY source");
    return Object.fromEntries(rows.map(row => [row.source, { passages: row.n, embedded: row.embedded }]));
  }
}

