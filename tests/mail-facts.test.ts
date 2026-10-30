import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import type { GmailSyncResult, GmailThreadSnapshot } from "../src/worker/gmail.js";
import { Decisions, type WorkersAi } from "../src/worker/decisions.js";
import { mailFact } from "../src/worker/mail-facts.js";
import { MailRuntime } from "../src/worker/mail-runtime.js";
import { mailScreen } from "../src/worker/mail-screen.js";
import { MailStore } from "../src/worker/mail-store.js";
import { ProactiveStore } from "../src/worker/proactive-store.js";
import { SituationStore } from "../src/worker/situation-store.js";
import { Store, type Database } from "../src/worker/store.js";
import { zonedTimestamp } from "../src/shared/daily-planning.js";

const NOW = Date.parse("2026-10-30T09:00:00Z"), TZ = "Asia/Kolkata";
type Scripted = { screen: [number, number]; kind?: [string, number]; state?: [string, number]; fields?: Record<string, [unknown, number]> };

function fixture(t: TestContext, script: Record<string, Scripted>) {
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  const sqlite = new DatabaseSync(":memory:"); let depth = 0; t.after(() => sqlite.close());
  const db: Database = {
    all: <T extends object>(query: string, ...bindings: (string | number | null)[]) => sqlite.prepare(query).all(...bindings) as T[],
    transaction<T>(run: () => T): T {
      const name = `f_${depth++}`; sqlite.exec(`SAVEPOINT ${name}`);
      try { const value = run(); sqlite.exec(`RELEASE ${name}`); return value; }
      catch (error) { sqlite.exec(`ROLLBACK TO ${name}; RELEASE ${name}`); throw error; }
      finally { depth--; }
    },
  };
  const owner = new Store(db); owner.setSession("telegram", "owner"); owner.registerBackgroundSession("mail-review", "telegram");
  const proactive = new ProactiveStore(owner, TZ); proactive.configure({ expectedVersion: 1, enabled: true, quietHours: null }, NOW);
  const situation = new SituationStore(db, TZ), mail = new MailStore(proactive, situation);
  mail.configure({ expectedVersion: 1, enabled: true, lookbackDays: 14, pollMinutes: 30 }, "owner", NOW);
  const calls: string[] = [];
  const subject = (input: { state: unknown }) => { const state = typeof input.state === "string" ? input.state : JSON.stringify(input.state); return Object.keys(script).find(key => state.includes(key))!; };
  const ai: WorkersAi = { async run(model, raw) {
    const input = raw as { state: unknown; questions?: Record<string, unknown> }, entry = script[subject(input)]!;
    calls.push(`${model.split("/").pop()}:${input.questions ? Object.keys(input.questions)[0] : "fields"}`);
    if (model.endsWith("clairic")) return { answers: Object.fromEntries(Object.entries(entry.fields ?? {}).map(([name, [value, confidence]]) => [name, { type: "x", value, confidence }])), usage: { input_tokens: 700 } };
    if (input.questions!.attention) return { answers: { attention: { type: "noul", noul: entry.screen[0] }, facts: { type: "noul", noul: entry.screen[1] } }, usage: { input_tokens: 600 } };
    const choice = (pick: [string, number] | undefined, options: string[]) => ({ type: "choice", choice: pick?.[0] ?? options[0], probabilities: Object.fromEntries(options.map(option => [option, option === pick?.[0] ? pick[1] : 0.01])), confidence: pick?.[1] ?? 0 });
    const questions = input.questions as Record<string, { criteria: Record<string, string> }>;
    return { answers: Object.fromEntries(Object.entries(questions).map(([id, question]) => [id, choice(id === "kind" ? entry.kind : id === `${entry.kind?.[0]}_state` ? entry.state : undefined, Object.keys(question.criteria))])), usage: { input_tokens: 800 } };
  } };
  const decisions = new Decisions(db, ai, () => 1_000);
  const runtime = new MailRuntime(mail, undefined, async () => undefined, mailScreen(decisions), mailFact(decisions, TZ));
  return { mail, situation, runtime, decisions, calls, proactive, owner };
}
function thread(id: string, subject: string, sender: string, excerpt: string): GmailThreadSnapshot {
  return { id, versionKey: `${id}:none`, subject, sender, receivedAt: "2026-10-30T08:00:00.000Z", lastIncomingAt: "2026-10-30T08:00:00.000Z", lastOutgoingAt: null,
    unread: true, important: false, starred: false, category: "updates", awaitingReply: false, webUrl: `https://mail.google.com/mail/u/0/#all/${id}`,
    messages: [{ id: `${id}-m`, sentAt: "2026-10-30T08:00:00.000Z", direction: "incoming", from: sender, subject, excerpt }] };
}
const sync = (threads: GmailThreadSnapshot[], historyId = "200"): GmailSyncResult => ({ status: "complete", checkedAt: new Date(NOW).toISOString(), historyId, continuation: null, threads, discovered: threads.length, issues: [] });

test("a confident fact is recorded without a review, joins an existing fact by reference, and unsure mail goes to the review", async t => {
  const f = fixture(t, {
    "Booking confirmed": { screen: [0.05, 0.9], kind: ["booking", 0.92], state: ["confirmed", 0.85],
      fields: { reference: ["QX7P2L", 0.99], counterparty: ["SkyAir", 0.9], amount: [null, 1], currency: [null, 1], happened: [null, 1], due: ["2026-11-14T06:10", 0.95] } },
    "Flight rescheduled": { screen: [0.1, 0.8], kind: ["booking", 0.9], state: ["changed", 0.8],
      fields: { reference: ["QX7P2L", 0.97], counterparty: ["Sky Air Travel", 0.8], amount: [null, 1], currency: [null, 1], happened: [null, 1], due: ["2026-11-14T09:30", 0.9] } },
    "Something vague": { screen: [0.1, 0.7], kind: ["order", 0.5], state: ["ordered", 0.9] },
    "Card alert": { screen: [0.1, 0.9], kind: ["spend", 0.95], state: ["debited", 0.9],
      fields: { reference: ["529312345678", 0.99], counterparty: ["Zomato", 0.9], amount: [null, 0.2], currency: ["Rs.", 0.9], happened: [null, 1], due: [null, 1] } },
  });
  const settings = f.mail.settings().version;
  f.mail.applySync("primary", settings, sync([thread("t1", "Booking confirmed: BLR to DEL", "SkyAir <noreply@sky.example>", "PNR QX7P2L departs 14 Nov 06:10."),
    thread("t3", "Something vague", "Shop <shop@example.test>", "Thanks for shopping."), thread("t4", "Card alert", "Bank <alerts@bank.example>", "Debited from your account. Ref 529312345678.")]), NOW);
  await f.runtime.drive(NOW);

  const facts = f.situation.active(["booking"]);
  assert.equal(facts.length, 1);
  assert.deepEqual({ key: facts[0]!.key, state: facts[0]!.state, dueAt: facts[0]!.dueAt, counterparty: facts[0]!.counterparty },
    { key: "booking:skyair qx7p2l", state: "confirmed", dueAt: "2026-11-14T06:10:00+05:30", counterparty: "SkyAir" });
  const status = f.mail.status() as { screen: Record<string, number>; counts: Record<string, number> };
  assert.equal(status.screen.recorded, 1); assert.equal(status.counts.pending, 2, "the unsure order and the spend without an amount wait for the review");
  assert.equal(f.situation.active(["spend"]).length, 0, "a spend needs its amount");

  f.mail.applySync("primary", settings, sync([thread("t2", "Flight rescheduled", "Sky Air Travel <care@sky.example>", "Your PNR QX7P2L now departs 09:30.")], "201"), NOW);
  await f.runtime.drive(NOW);
  const joined = f.situation.active(["booking"]);
  assert.equal(joined.length, 1, "the same reference joins the existing booking");
  assert.equal(joined[0]!.state, "changed"); assert.equal(joined[0]!.sources.length, 2);
  const usage = (f.decisions.status() as { byPurpose: Record<string, { calls: number }> }).byPurpose;
  assert.equal(usage.mail!.calls, 4); assert.equal(usage["mail-facts"]!.calls, 7, "kind and state for every fact candidate, fields only when the kind is clear");
});

test("dates without a zone are read in the owner's timezone", () => {
  assert.equal(zonedTimestamp("2026-11-14", TZ), "2026-11-14T00:00:00+05:30");
  assert.equal(zonedTimestamp("2026-11-14T06:10", TZ), "2026-11-14T06:10:00+05:30");
  assert.equal(zonedTimestamp("2026-11-14T06:10:00Z", TZ), "2026-11-14T06:10:00Z");
  assert.equal(zonedTimestamp("next Tuesday", TZ), undefined);
});
