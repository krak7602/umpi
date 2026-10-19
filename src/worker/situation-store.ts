import { createHash } from "node:crypto";
import { planningDay, planningDayBounds, shiftPlanningDay } from "../shared/daily-planning.js";
import { InputError, boundedText, record, timestamp } from "../shared/protocol.js";
import { StateError, type Database } from "./store.js";

export const SITUATION_KINDS = ["order", "spend", "subscription", "bill", "job", "booking", "account", "update"] as const;
export type SituationKind = (typeof SITUATION_KINDS)[number];
/** Facts are compact enough that a full read of every active item stays under Pi's 50 KB tool-result limit. */
export const SITUATION_READ_BUDGET_BYTES = 36_000;
const DAY = 86_400_000;
const MAX_FACTS = 2_000;
const MAX_HORIZON_DAYS = 180;
const SPEND_WINDOW_DAYS = 45;

export interface SituationSource { account: string; threadId: string; webUrl: string; at: string }
export interface SituationFact {
  id: string;
  version: number;
  kind: SituationKind;
  key: string;
  title: string;
  state: string;
  counterparty: string | null;
  amount: { value: number; currency: string; direction: "debit" | "credit" } | null;
  happenedAt: string | null;
  dueAt: string | null;
  detail: string | null;
  observedAt: string;
  relevantUntil: string;
  history: { state: string; at: string }[];
  sources: SituationSource[];
  owner: { state?: string; note?: string; dismissed?: boolean; at: string } | null;
  createdAt: string;
  updatedAt: string;
}
/** A model-extracted observation from one bounded mail thread. Untrusted until validated here. */
export interface SituationObservation {
  sourceId: string;
  kind: SituationKind;
  key: string;
  title: string;
  state: string;
  counterparty?: string;
  amount?: { value: number; currency: string; direction?: "debit" | "credit" };
  happenedAt?: string;
  dueAt?: string;
  detail?: string;
  relevantUntil?: string;
}

const iso = (now: number) => new Date(now).toISOString();
function clean(value: unknown, maximum: number, label: string): string {
  const result = boundedText(value, maximum, label).replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  if (!result) throw new InputError(`${label} must not be empty`);
  return result;
}
function optionalText(value: unknown, maximum: number, label: string): string | null {
  return value === undefined || value === null || value === "" ? null : clean(value, maximum, label);
}
function optionalInstant(value: unknown, label: string): string | null {
  return value === undefined || value === null || value === "" ? null : timestamp(value, label);
}
function stateName(value: unknown): string {
  const result = clean(value, 40, "situation state").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
  if (!result) throw new InputError("situation state must contain letters or digits");
  return result;
}
function kindOf(value: unknown): SituationKind {
  if (typeof value !== "string" || !(SITUATION_KINDS as readonly string[]).includes(value)) throw new InputError(`situation kind must be one of ${SITUATION_KINDS.join(", ")}`);
  return value as SituationKind;
}
function normalizedKey(kind: SituationKind, value: unknown): string {
  const key = clean(value, 160, "situation key").toLowerCase().replace(/[^a-z0-9@#.+-]+/g, " ").trim();
  if (!key) throw new InputError("situation key must identify the item");
  return `${kind}:${key}`;
}
function amountOf(value: unknown): SituationFact["amount"] {
  if (value === undefined || value === null) return null;
  const body = record(value);
  if (Object.keys(body).some(key => !["value", "currency", "direction"].includes(key))) throw new InputError("Unknown situation amount field");
  if (typeof body.value !== "number" || !Number.isFinite(body.value) || body.value < 0 || body.value > 1e10) throw new InputError("situation amount must be a non-negative number");
  if (typeof body.currency !== "string" || !/^[A-Z]{3}$/.test(body.currency)) throw new InputError("situation currency must be an ISO 4217 code such as INR");
  const direction = body.direction ?? "debit";
  if (direction !== "debit" && direction !== "credit") throw new InputError("situation amount direction must be debit or credit");
  return { value: Math.round(body.value * 100) / 100, currency: body.currency, direction };
}
const TERMINAL = new Set(["delivered", "cancelled", "canceled", "returned", "refunded", "paid", "rejected", "withdrawn", "closed", "completed", "resolved", "expired", "ended"]);

/** Expiry is code-owned so a model hint cannot keep a stale fact around indefinitely. */
function defaultRelevance(fact: Pick<SituationFact, "kind" | "state" | "dueAt" | "observedAt">): number {
  const observed = Date.parse(fact.observedAt), due = fact.dueAt ? Date.parse(fact.dueAt) : undefined, done = TERMINAL.has(fact.state);
  switch (fact.kind) {
    case "spend": return observed + SPEND_WINDOW_DAYS * DAY;
    case "order": return done ? observed + 3 * DAY : Math.max(due !== undefined ? due + 3 * DAY : 0, observed + 21 * DAY);
    case "subscription": return due !== undefined ? due + 3 * DAY : observed + 45 * DAY;
    case "bill": return done ? observed + 3 * DAY : due !== undefined ? due + 7 * DAY : observed + 30 * DAY;
    case "job": return done ? observed + 14 * DAY : observed + 60 * DAY;
    case "booking": return (due ?? observed) + 2 * DAY;
    case "account": return observed + 7 * DAY;
    case "update": return due !== undefined ? due + 2 * DAY : observed + 14 * DAY;
  }
}

/** Operational, expiring facts derived from owner data sources. Never standing memory and never Gmail state. */
export class SituationStore {
  constructor(readonly db: Database, readonly timezone: string) {
    for (const sql of [
      "CREATE TABLE IF NOT EXISTS umpi_situation_facts (id TEXT PRIMARY KEY, kind TEXT NOT NULL, relevant_until INTEGER NOT NULL, observed INTEGER NOT NULL, data TEXT NOT NULL)",
      "CREATE INDEX IF NOT EXISTS umpi_situation_relevance ON umpi_situation_facts(relevant_until)",
      "CREATE INDEX IF NOT EXISTS umpi_situation_kind ON umpi_situation_facts(kind,observed)",
    ]) this.db.all(sql);
  }
  private rows(sql: string, ...bindings: (string | number | null)[]): SituationFact[] {
    return this.db.all<{ data: string }>(sql, ...bindings).map(row => JSON.parse(row.data) as SituationFact);
  }
  private write(fact: SituationFact): SituationFact {
    this.db.all("INSERT INTO umpi_situation_facts VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET kind=excluded.kind,relevant_until=excluded.relevant_until,observed=excluded.observed,data=excluded.data",
      fact.id, fact.kind, Date.parse(fact.relevantUntil), Date.parse(fact.observedAt), JSON.stringify(fact));
    return fact;
  }
  fact(id: string): SituationFact | undefined { return this.rows("SELECT data FROM umpi_situation_facts WHERE id=?", id)[0]; }

  /** Validate and merge one observation. Older evidence fills gaps but never regresses a newer state. Call inside a transaction. */
  observe(value: unknown, source: Omit<SituationSource, "at"> & { receivedAt: string }, now = Date.now()): SituationFact {
    const body = record(value);
    if (Object.keys(body).some(key => !["sourceId", "kind", "key", "title", "state", "counterparty", "amount", "happenedAt", "dueAt", "detail", "relevantUntil"].includes(key))) throw new InputError("Unknown situation fact field");
    const kind = kindOf(body.kind), key = normalizedKey(kind, body.key), amount = amountOf(body.amount);
    if (kind === "spend" && !amount) throw new InputError("A spend fact requires its amount");
    const happenedAt = optionalInstant(body.happenedAt, "situation happenedAt"), dueAt = optionalInstant(body.dueAt, "situation dueAt");
    const hint = optionalInstant(body.relevantUntil, "situation relevantUntil");
    const observedAt = happenedAt && Date.parse(happenedAt) <= now + DAY ? happenedAt : source.receivedAt;
    const incoming = {
      kind, key, title: clean(body.title, 120, "situation title"), state: stateName(body.state),
      counterparty: optionalText(body.counterparty, 80, "situation counterparty"), amount, happenedAt, dueAt,
      detail: optionalText(body.detail, 240, "situation detail"), observedAt,
    };
    const id = `fact-${createHash("sha256").update(key).digest("hex").slice(0, 24)}`;
    const previous = this.fact(id);
    const sourceRecord: SituationSource = { account: source.account, threadId: source.threadId, webUrl: source.webUrl, at: source.receivedAt };
    const sources = [sourceRecord, ...(previous?.sources ?? []).filter(item => item.threadId !== source.threadId)].slice(0, 5);
    let next: SituationFact;
    if (!previous) {
      next = { id, version: 1, ...incoming, relevantUntil: "", history: [{ state: incoming.state, at: observedAt }], sources, owner: null, createdAt: iso(now), updatedAt: iso(now) };
    } else if (Date.parse(observedAt) < Date.parse(previous.observedAt)) {
      next = { ...previous, version: previous.version + 1, sources, updatedAt: iso(now),
        counterparty: previous.counterparty ?? incoming.counterparty, amount: previous.amount ?? incoming.amount,
        happenedAt: previous.happenedAt ?? incoming.happenedAt, dueAt: previous.dueAt ?? incoming.dueAt, detail: previous.detail ?? incoming.detail };
    } else {
      // An owner correction stands until newer evidence arrives after it.
      const ownerHolds = previous.owner?.state !== undefined && Date.parse(previous.owner.at) > Date.parse(observedAt);
      const state = ownerHolds ? previous.state : incoming.state;
      const history = state === previous.state ? previous.history : [...previous.history, { state, at: observedAt }].slice(-8);
      next = { ...previous, ...incoming, state, version: previous.version + 1, history, sources, updatedAt: iso(now),
        counterparty: incoming.counterparty ?? previous.counterparty, amount: incoming.amount ?? previous.amount,
        happenedAt: incoming.happenedAt ?? previous.happenedAt, dueAt: incoming.dueAt ?? previous.dueAt, detail: incoming.detail ?? previous.detail };
    }
    const fallback = defaultRelevance(next);
    const requested = hint ? Date.parse(hint) : fallback;
    next.relevantUntil = iso(Math.min(Math.max(requested, now + DAY), now + MAX_HORIZON_DAYS * DAY, Math.max(fallback, requested)));
    if (previous?.owner?.dismissed && Date.parse(observedAt) <= Date.parse(previous.owner.at)) next.relevantUntil = previous.relevantUntil;
    return this.write(next);
  }

  /** Owner correction from the foreground conversation or control API. */
  correct(value: unknown, now = Date.now()): SituationFact {
    const body = record(value);
    if (Object.keys(body).some(key => !["id", "expectedVersion", "state", "dismiss", "note"].includes(key))) throw new InputError("Unknown situation correction field");
    if (typeof body.id !== "string") throw new InputError("Situation correction requires a fact id");
    if (body.dismiss !== undefined && typeof body.dismiss !== "boolean") throw new InputError("dismiss must be a boolean");
    if (body.state === undefined && body.dismiss === undefined && body.note === undefined) throw new InputError("Provide a state, dismiss, or note");
    return this.db.transaction(() => {
      const previous = this.fact(body.id as string);
      if (!previous) throw new StateError(404, "Situation fact not found");
      if (body.expectedVersion !== previous.version) throw new StateError(409, "Situation fact changed; read its current version");
      const state = body.state === undefined ? undefined : stateName(body.state);
      const note = body.note === undefined ? previous.owner?.note : optionalText(body.note, 240, "situation note") ?? undefined;
      const owner = { ...(state ? { state } : previous.owner?.state ? { state: previous.owner.state } : {}), ...(note ? { note } : {}), ...(body.dismiss ? { dismissed: true } : {}), at: iso(now) };
      const next: SituationFact = { ...previous, version: previous.version + 1, owner, updatedAt: iso(now),
        ...(state && state !== previous.state ? { state, history: [...previous.history, { state, at: iso(now) }].slice(-8) } : {}) };
      next.relevantUntil = body.dismiss ? iso(now) : iso(Math.max(Date.parse(previous.relevantUntil), defaultRelevance(next)));
      return this.write(next);
    });
  }

  purge(now = Date.now()): number {
    const expired = this.db.all<{ count: number }>("SELECT count(*) AS count FROM umpi_situation_facts WHERE relevant_until < ?", now)[0]?.count ?? 0;
    if (expired) this.db.all("DELETE FROM umpi_situation_facts WHERE relevant_until < ?", now);
    const overflow = (this.db.all<{ count: number }>("SELECT count(*) AS count FROM umpi_situation_facts")[0]?.count ?? 0) - MAX_FACTS;
    if (overflow > 0) this.db.all("DELETE FROM umpi_situation_facts WHERE id IN (SELECT id FROM umpi_situation_facts ORDER BY relevant_until LIMIT ?)", overflow);
    return expired + Math.max(0, overflow);
  }

  private view(fact: SituationFact): object {
    const { id, version, kind, title, state, counterparty, amount, happenedAt, dueAt, detail, observedAt, relevantUntil, history, sources, owner } = fact;
    return { id, version, kind, title, state, counterparty, amount, happenedAt, dueAt, detail, observedAt, relevantUntil,
      ...(history.length > 1 ? { history } : {}), source: sources[0] ? { account: sources[0].account, webUrl: sources[0].webUrl } : null, ...(owner ? { owner } : {}) };
  }

  /** Money totals are computed here, never by the model. */
  spending(now = Date.now()): object {
    const facts = this.rows("SELECT data FROM umpi_situation_facts WHERE kind='spend' AND observed >= ? AND relevant_until >= ?", now - 30 * DAY, now)
      .filter(fact => fact.amount && !fact.owner?.dismissed);
    const dayStart = Date.parse(planningDayBounds(planningDay(now, this.timezone), this.timezone).start);
    const yesterdayStart = Date.parse(planningDayBounds(shiftPlanningDay(planningDay(now, this.timezone), -1), this.timezone).start);
    const windows: Record<string, [number, number]> = { today: [dayStart, Infinity], yesterday: [yesterdayStart, dayStart], last7Days: [now - 7 * DAY, Infinity], last30Days: [now - 30 * DAY, Infinity] };
    const totals: Record<string, Record<string, { debit: number; credit: number; count: number }>> = {};
    const merchants = new Map<string, { counterparty: string; currency: string; debit: number; count: number }>();
    for (const fact of facts) {
      const at = Date.parse(fact.observedAt), amount = fact.amount!;
      for (const [name, [start, end]] of Object.entries(windows)) {
        if (at < start || at >= end) continue;
        const bucket = ((totals[name] ??= {})[amount.currency] ??= { debit: 0, credit: 0, count: 0 });
        bucket[amount.direction] = Math.round((bucket[amount.direction] + amount.value) * 100) / 100; bucket.count++;
      }
      if (amount.direction === "debit") {
        const name = fact.counterparty ?? "Unknown", label = `${name.toLowerCase()}|${amount.currency}`;
        const entry = merchants.get(label) ?? { counterparty: name, currency: amount.currency, debit: 0, count: 0 };
        entry.debit = Math.round((entry.debit + amount.value) * 100) / 100; entry.count++; merchants.set(label, entry);
      }
    }
    return { totals, topCounterparties30Days: [...merchants.values()].sort((a, b) => b.debit - a.debit).slice(0, 8),
      note: "Totals cover spend facts extracted from bank/UPI/card alert mail only; missing alerts mean missing spends." };
  }

  /** Active facts by urgency, bounded by bytes. Individual spends are summarized unless explicitly requested. */
  read(options: { kinds?: SituationKind[]; query?: string; changedSince?: string; includeSpends?: boolean; budgetBytes?: number } = {}, now = Date.now()): object {
    const kinds = options.kinds?.length ? options.kinds : SITUATION_KINDS.filter(kind => kind !== "spend" || options.includeSpends);
    const query = options.query?.toLowerCase().trim();
    const since = options.changedSince ? Date.parse(options.changedSince) : undefined;
    const candidates = this.rows(`SELECT data FROM umpi_situation_facts WHERE relevant_until >= ? AND kind IN (${kinds.map(() => "?").join(",")}) ORDER BY observed DESC LIMIT 600`, now, ...kinds)
      .filter(fact => !fact.owner?.dismissed)
      .filter(fact => !query || [fact.title, fact.counterparty, fact.detail, fact.state, fact.kind].some(value => value?.toLowerCase().includes(query)))
      .filter(fact => !options.changedSince || since === undefined || Date.parse(fact.updatedAt) >= since);
    const urgency = (fact: SituationFact) => {
      const due = fact.dueAt ? Date.parse(fact.dueAt) : Infinity;
      return TERMINAL.has(fact.state) ? 2 : due !== Infinity && due >= now - DAY ? 0 : 1;
    };
    candidates.sort((a, b) => urgency(a) - urgency(b) || (a.dueAt && b.dueAt ? a.dueAt.localeCompare(b.dueAt) : 0) || b.observedAt.localeCompare(a.observedAt));
    const facts: object[] = []; let bytes = 0;
    const budget = Math.min(options.budgetBytes ?? SITUATION_READ_BUDGET_BYTES - 6_000, SITUATION_READ_BUDGET_BYTES - 6_000);
    for (const fact of candidates) {
      const view = this.view(fact), size = JSON.stringify(view).length;
      if (bytes + size > budget) break;
      facts.push(view); bytes += size;
    }
    return { now: iso(now), timezone: this.timezone, facts, omitted: candidates.length - facts.length, ...(kinds.includes("spend") || !options.kinds?.length ? { spending: this.spending(now) } : {}) };
  }

  /** Raw active facts for code-owned checks such as due-soon nudges. */
  active(kinds: readonly SituationKind[], now = Date.now()): SituationFact[] {
    if (!kinds.length) return [];
    return this.rows(`SELECT data FROM umpi_situation_facts WHERE relevant_until >= ? AND kind IN (${kinds.map(() => "?").join(",")}) ORDER BY observed DESC LIMIT 500`, now, ...kinds);
  }

  /** Facts updated since an instant, for "what changed" summaries. */
  changedIds(since: string, limit = 200): string[] {
    return this.rows("SELECT data FROM umpi_situation_facts WHERE json_extract(data,'$.updatedAt') >= ? ORDER BY observed DESC LIMIT ?", since, limit).map(fact => fact.id);
  }

  status(now = Date.now()): object {
    const counts = this.db.all<{ kind: string; count: number }>("SELECT kind,count(*) AS count FROM umpi_situation_facts WHERE relevant_until >= ? GROUP BY kind", now);
    return { active: Object.fromEntries(counts.map(row => [row.kind, row.count])) };
  }
}
