import { InputError, boundedText, identifier, record } from "../shared/protocol.js";
import type { Database } from "./store.js";

/**
 * Ideas the owner captured by voice from the widget or Control Center. Saved as spoken, with no model turn, so a capture
 * is instant and free; each is also added to the day's note and to history search so it can be found later.
 */
export interface Idea { id: string; text: string; at: string; seconds?: number }

export class IdeaStore {
  constructor(private readonly db: Database, private readonly now = () => Date.now()) {
    db.all("CREATE TABLE IF NOT EXISTS umpi_ideas (id TEXT PRIMARY KEY, at INTEGER NOT NULL, text TEXT NOT NULL, data TEXT NOT NULL)");
  }
  /** Saves an idea once; a resent capture returns the saved one. */
  add(value: unknown): { idea: Idea; created: boolean } {
    const input = record(value);
    if (Object.keys(input).some(key => !["id", "text", "seconds"].includes(key))) throw new InputError("Unknown idea field");
    const id = identifier(input.id, "idea ID"), text = boundedText(input.text, 8_000, "idea").trim();
    if (!text) throw new InputError("An idea needs text");
    if (input.seconds !== undefined && (typeof input.seconds !== "number" || input.seconds < 0 || input.seconds > 3_600)) throw new InputError("Invalid idea length");
    const existing = this.db.all<{ data: string }>("SELECT data FROM umpi_ideas WHERE id=?", id)[0];
    if (existing) return { idea: JSON.parse(existing.data) as Idea, created: false };
    const idea: Idea = { id, text, at: new Date(this.now()).toISOString(), ...(input.seconds !== undefined ? { seconds: Math.round(input.seconds as number) } : {}) };
    this.db.all("INSERT INTO umpi_ideas VALUES (?,?,?,?)", id, this.now(), text.toLowerCase(), JSON.stringify(idea));
    return { idea, created: true };
  }
  /** Newest first; `query` keeps ideas containing every word. */
  list(query?: string, limit = 100): Idea[] {
    const words = (query ?? "").toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8);
    const where = words.map(() => "text LIKE ?").join(" AND ");
    return this.db.all<{ data: string }>(`SELECT data FROM umpi_ideas${where ? ` WHERE ${where}` : ""} ORDER BY at DESC LIMIT ?`, ...words.map(word => `%${word}%`), Math.min(Math.max(limit, 1), 200))
      .map(row => JSON.parse(row.data) as Idea);
  }
  count(): number { return this.db.all<{ n: number }>("SELECT count(*) AS n FROM umpi_ideas")[0]!.n; }
}
