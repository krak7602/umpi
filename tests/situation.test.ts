import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import type { GmailSyncResult, GmailThreadSnapshot } from "../src/worker/gmail.js";
import { BriefStore } from "../src/worker/brief-store.js";
import { MAIL_FACT_SCAN_VERSION, MAIL_REVIEW_BUDGET_BYTES, MailStore } from "../src/worker/mail-store.js";
import { parseMailAccounts } from "../src/worker/mail-runtime.js";
import { cleanEmailText } from "../src/worker/mail-text.js";
import { ProactiveStore } from "../src/worker/proactive-store.js";
import { SituationStore } from "../src/worker/situation-store.js";
import { StateError, Store, type Database } from "../src/worker/store.js";
import { authorize } from "../src/worker/transport.js";

const NOW = Date.parse("2027-04-15T06:00:00Z");
const TZ = "Asia/Kolkata";
const grant = { clientId: "fixture-client", clientSecret: "fixture-secret", refreshToken: "fixture-refresh" };

function fixture(t: TestContext) {
  const sqlite = new DatabaseSync(":memory:"); let depth = 0;
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  const db: Database = {
    all: <T extends object>(query: string, ...bindings: (string | number | null)[]) => sqlite.prepare(query).all(...bindings) as T[],
    transaction<T>(run: () => T): T {
      const name = `s_${depth++}`; sqlite.exec(`SAVEPOINT ${name}`);
      try { const value = run(); sqlite.exec(`RELEASE ${name}`); return value; }
      catch (error) { sqlite.exec(`ROLLBACK TO ${name}; RELEASE ${name}`); throw error; }
      finally { depth--; }
    },
  };
  const owner = new Store(db); owner.setSession("telegram", "owner"); owner.registerBackgroundSession("review", "telegram");
  const proactive = new ProactiveStore(owner, TZ); proactive.configure({ expectedVersion: 1, enabled: true, quietHours: null }, NOW);
  const situation = new SituationStore(db, TZ);
  const mail = new MailStore(proactive, situation);
  mail.configure({ expectedVersion: 1, enabled: true, lookbackDays: 30, pollMinutes: 30 }, "owner", NOW);
  t.after(() => sqlite.close());
  return { owner, proactive, situation, mail, time(now: number) { t.mock.timers.setTime(now); } };
}
type Fixture = ReturnType<typeof fixture>;
function snapshot(id: string, changes: Partial<GmailThreadSnapshot> = {}): GmailThreadSnapshot {
  return {
    id, versionKey: `${id}-in:none`, subject: `Subject ${id}`, sender: "Bank <alerts@bank.example>", receivedAt: "2027-04-14T09:00:00.000Z",
    lastIncomingAt: "2027-04-14T09:00:00.000Z", lastOutgoingAt: null, unread: true, important: false, starred: false, category: "updates",
    awaitingReply: true, webUrl: `https://mail.google.com/mail/#all/${id}`,
    messages: [{ id: `${id}-in`, sentAt: "2027-04-14T09:00:00.000Z", direction: "incoming", from: "Bank <alerts@bank.example>", subject: `Subject ${id}`, excerpt: "Rs.450.00 debited" }],
    ...changes,
  };
}
function sync(f: Fixture, threads: GmailThreadSnapshot[], account = "primary", historyId = "200") {
  const result: GmailSyncResult = { status: "complete", checkedAt: new Date(Date.now()).toISOString(), historyId, continuation: null, threads, discovered: threads.length, issues: [] };
  return f.mail.applySync(account, f.mail.settings().version, result, Date.now());
}
function open(f: Fixture) {
  f.proactive.drive(Date.now(), false, { telegram: "review" });
  const run = f.proactive.runForSession("review")!;
  f.owner.submitted(run.operationId);
  return { run, input: f.mail.reviewInputs("review") as { threads: { id: string; version: number; mode: string }[] } };
}
function finish(f: Fixture, run: { operationId: string }) {
  f.proactive.report("review", f.mail.finishInput("review", { outcome: "advanced", note: "done" }));
  f.owner.settle(run.operationId, "");
}
const spend = (sourceId: string, ref: string, value: number, happenedAt = "2027-04-14T14:30:00+05:30") =>
  ({ sourceId, kind: "spend", key: `hdfc ${ref}`, title: "UPI payment", state: "debited", counterparty: "Zomato", amount: { value, currency: "INR", direction: "debit" }, happenedAt });

test("triage records situation facts; malformed facts are reported without discarding the batch", t => {
  const f = fixture(t);
  sync(f, [snapshot("a")]);
  const { run, input } = open(f), item = input.threads[0]!;
  assert.equal(item.mode, "triage");
  const committed = f.mail.commitReview("review", [{ id: item.id, expectedVersion: item.version, outcome: "ignore", summary: "Routine UPI alert" }], [
    spend(item.id, "529312345678", 450),
    { sourceId: item.id, kind: "spend", key: "missing amount", title: "Bad", state: "debited" },
    { sourceId: "mail-" + "0".repeat(32), kind: "order", key: "elsewhere", title: "Wrong source", state: "ordered" },
  ]) as { factsRecorded: number; rejectedFacts: { index: number }[] };
  assert.equal(committed.factsRecorded, 1);
  assert.deepEqual(committed.rejectedFacts.map(entry => entry.index), [1, 2]);
  finish(f, run);
  assert.equal(f.mail.thread(item.id)?.factScan, MAIL_FACT_SCAN_VERSION);
  assert.deepEqual(f.mail.thread(item.id)?.messages, [], "ignored mail keeps no excerpts after extraction");
  const read = f.situation.read({ kinds: ["spend"], includeSpends: true }) as { facts: { title: string }[]; spending: { totals: Record<string, Record<string, { debit: number }>> } };
  assert.equal(read.facts.length, 1);
  assert.equal(read.spending.totals.yesterday?.INR?.debit, 450, "local-day windows use the owner's timezone");
  assert.equal(read.spending.totals.today, undefined);
});

test("later mail updates one fact by key, older evidence never regresses it, and owner corrections stand", t => {
  const f = fixture(t), source = { account: "primary", webUrl: "https://mail.google.com/x" };
  const order = (state: string, at: string) => ({ kind: "order", key: "Amazon 403-1234567-1234567", title: "Headphones", state, happenedAt: at });
  f.situation.observe(order("shipped", "2027-04-13T10:00:00Z"), { ...source, threadId: "t1", receivedAt: "2027-04-13T10:00:00Z" });
  const delivered = f.situation.observe(order("delivered", "2027-04-14T10:00:00Z"), { ...source, threadId: "t2", receivedAt: "2027-04-14T10:00:00Z" });
  const stale = f.situation.observe(order("ordered", "2027-04-10T10:00:00Z"), { ...source, threadId: "t0", receivedAt: "2027-04-10T10:00:00Z" });
  assert.equal(stale.id, delivered.id); assert.equal(stale.state, "delivered");
  assert.deepEqual(stale.history.map(entry => entry.state), ["shipped", "delivered"]);
  assert.equal(stale.sources.length, 3);
  assert.throws(() => f.situation.correct({ id: stale.id, expectedVersion: 1, state: "returned" }), StateError);
  const corrected = f.situation.correct({ id: stale.id, expectedVersion: stale.version, state: "returned" });
  assert.equal(corrected.state, "returned");
  const dismissed = f.situation.correct({ id: corrected.id, expectedVersion: corrected.version, dismiss: true });
  assert.equal((f.situation.read() as { facts: unknown[] }).facts.length, 0);
  t.mock.timers.setTime(NOW + 1);
  f.situation.purge(); assert.equal(f.situation.fact(dismissed.id), undefined);
});

test("backfill re-reads already-triaged mail once for facts without re-notifying, and bulk tabs never reach the model", t => {
  const f = fixture(t);
  sync(f, [snapshot("old")]);
  const first = open(f), item = first.input.threads[0]!;
  f.mail.commitReview("review", [{ id: item.id, expectedVersion: item.version, outcome: "ignore", summary: "Seen" }]);
  finish(f, first.run);
  // Simulate mail triaged before extraction existed, then a bounded re-scan of the same provider version.
  f.owner.db.all("UPDATE umpi_mail_threads SET data=json_remove(data,'$.factScan') WHERE id=?", item.id);
  const promo = snapshot("promo", { category: "promotions" }), starredPromo = snapshot("starred", { category: "promotions", starred: true });
  assert.deepEqual(sync(f, [snapshot("old"), promo, starredPromo], "primary", "201"), { changed: 3, pending: 2 });
  const promoThread = f.mail.status() as { counts: Record<string, number> };
  assert.equal(promoThread.counts.ignored, 2, "the old thread stays ignored and the promotion is skipped in code");
  const second = open(f);
  const modes = Object.fromEntries(second.input.threads.map(thread => [thread.id, thread.mode]));
  assert.equal(modes[item.id], "facts"); assert.equal(Object.keys(modes).length, 2);
  assert.throws(() => f.mail.commitReview("review", second.input.threads.map(thread => ({ id: thread.id, expectedVersion: thread.version, outcome: "ignore", summary: "x" }))), /facts_only/);
  f.mail.commitReview("review", second.input.threads.map(thread => thread.mode === "facts"
    ? { id: thread.id, expectedVersion: thread.version, outcome: "facts_only" as const }
    : { id: thread.id, expectedVersion: thread.version, outcome: "ignore" as const, summary: "Starred promo" }), [spend(item.id, "999", 120)]);
  const done = f.mail.finishInput("review", { outcome: "advanced", note: "x" });
  assert.equal(done.notification, undefined, "a facts-only backfill does not notify");
  assert.equal(f.mail.thread(item.id)?.status, "ignored"); assert.equal(f.mail.thread(item.id)?.factsPending, undefined);
  assert.equal(sync(f, [snapshot("old")], "primary", "202").changed, 0, "extracted mail is not reopened again");
});

test("review batches stay under Pi's tool-result limit even for long threads", t => {
  const f = fixture(t), excerpt = "x".repeat(2_400);
  sync(f, Array.from({ length: 40 }, (_, index) => snapshot(`long-${index}`, {
    messages: Array.from({ length: 8 }, (__, message) => ({ id: `m-${index}-${message}`, sentAt: "2027-04-14T09:00:00.000Z", direction: "incoming" as const, from: "Person <p@example.test>", subject: `Subject long-${index}`, excerpt })),
  })));
  const { input } = open(f);
  assert.ok(input.threads.length >= 1 && input.threads.length < 40);
  assert.ok(JSON.stringify(input).length < MAIL_REVIEW_BUDGET_BYTES + 4_000);
});

test("mailboxes are registered separately and keep distinct thread identities", t => {
  const f = fixture(t);
  assert.deepEqual(parseMailAccounts(JSON.stringify(grant)).map(account => account.id), ["primary"]);
  const accounts = parseMailAccounts(JSON.stringify({ accounts: [{ id: "primary", ...grant }, { id: "domain", ...grant }, { id: "Bad Id", ...grant }, { id: "broken" }] }));
  assert.deepEqual(accounts.map(account => account.id), ["primary", "domain"]);
  assert.deepEqual(parseMailAccounts("not json"), []);
  f.mail.ensureAccounts(["primary", "domain"], NOW);
  assert.equal(f.mail.account("domain")?.bootstrapAfter, new Date(NOW - 30 * 86_400_000).toISOString(), "a new mailbox starts from the current lookback");
  assert.deepEqual(f.mail.dueAccounts(["primary", "domain"], NOW), ["primary", "domain"]);
  sync(f, [snapshot("same")], "primary"); sync(f, [snapshot("same")], "domain");
  const { input } = open(f);
  assert.equal(new Set(input.threads.map(thread => thread.id)).size, 2);
});

test("email cleaning keeps facts, drops layout noise, quoted replies, tracking links, and footers", () => {
  const html = `<html><head><style>.x{color:red}</style></head><body><div style="display:none">‌‌‌ preview</div>
    <table><tr><td><p>Your order <b>403-1234567</b> has shipped.</p><p>Total: Rs. 1,299.00</p></td></tr>
    <tr><td><a href="https://track.example.com/c?u=abcdef123456&utm_source=x">Track package</a> <img src="https://pixel.example.com/o.gif"></td></tr></table>
    ${"<p>Line of detail.</p>".repeat(6)}
    <p>You received this email because you placed an order.</p><p>Unsubscribe | Privacy Policy | © 2027 Shop Ltd</p></body></html>`;
  const text = cleanEmailText("", html);
  assert.match(text, /403-1234567/); assert.match(text, /Rs\. 1,299\.00/); assert.match(text, /Track package/);
  assert.doesNotMatch(text, /utm_source|abcdef123456|pixel|color:red|Unsubscribe|You received this email/);
  assert.doesNotMatch(text, /‌/);
  const reply = cleanEmailText("Sounds good, Thursday works.\n\nOn Mon, Apr 12, 2027 at 9:00 AM Person <p@example.test> wrote:\n> Can we meet Thursday?\n> Thanks", "");
  assert.equal(reply, "Sounds good, Thursday works.");
});

test("the morning brief is scheduled once per local day, quiet when empty, and delivered from committed text only", t => {
  const f = fixture(t), brief = new BriefStore(f.proactive);
  assert.equal(brief.due(NOW), false);
  brief.configure({ expectedVersion: 1, enabled: true, time: "03:30" }, "owner", NOW);
  const nextLocal0330 = Date.parse("2027-04-15T22:00:00Z");
  assert.equal(brief.nextDue(NOW), nextLocal0330);
  f.time(nextLocal0330 + 60_000);
  brief.drive(Date.now()); assert.equal(brief.due(Date.now()), false, "one brief per local day");
  f.proactive.drive(Date.now(), false, { telegram: "review" });
  const run = f.proactive.runForSession("review")!;
  assert.equal(run.commitmentId, "morning-brief");
  assert.throws(() => brief.finishInput("review", { outcome: "advanced", note: "x" }), /Commit the brief/);
  brief.commit("review", "Light day. Interview at 11:00.");
  const done = brief.finishInput("review", { outcome: "no_action", note: "model note is replaced", notification: "model text is ignored" });
  assert.equal(done.outcome, "advanced"); assert.equal(done.notification, "Light day. Interview at 11:00.");
  f.owner.submitted(run.operationId); f.proactive.report("review", done); f.owner.settle(run.operationId, "");
  f.time(nextLocal0330 + 86_400_000);
  brief.drive(Date.now());
  f.proactive.drive(Date.now(), false, { telegram: "review" });
  const quiet = f.proactive.runForSession("review")!;
  brief.commit("review", null);
  assert.equal(brief.finishInput("review", { outcome: "advanced", note: "x" }).outcome, "no_action");
  assert.equal(quiet.commitmentId, "morning-brief");
});

test("situation and brief control routes are owner-only and exact-method", async () => {
  const env = { UMPI_CONTROL_TOKEN: "c".repeat(32), UMPI_EXECUTOR_TOKEN: "e".repeat(32) };
  for (const [method, path] of [["GET", "/api/situation"], ["GET", "/api/brief"], ["PUT", "/api/brief/settings"], ["POST", "/api/brief/run"]]) {
    await authorize(new Request(`https://example.test${path}`, { method, headers: { authorization: `Bearer ${env.UMPI_CONTROL_TOKEN}` } }), env);
    await assert.rejects(authorize(new Request(`https://example.test${path}`, { method, headers: { authorization: `Bearer ${env.UMPI_EXECUTOR_TOKEN}` } }), env), { status: 401 });
  }
  for (const [method, path] of [["POST", "/api/situation"], ["GET", "/api/brief/run"], ["DELETE", "/api/brief"]]) {
    await assert.rejects(authorize(new Request(`https://example.test${path}`, { method, headers: { authorization: `Bearer ${env.UMPI_CONTROL_TOKEN}` } }), env), { status: 404 });
  }
});

test("every important thread can notify; the digest lists the newest 15 and counts the rest", t => {
  const f = fixture(t);
  sync(f, Array.from({ length: 18 }, (_, index) => snapshot(`urgent-${index}`, { receivedAt: `2027-04-14T${String(index).padStart(2, "0")}:00:00.000Z`, lastIncomingAt: `2027-04-14T${String(index).padStart(2, "0")}:00:00.000Z` })));
  const { run, input } = open(f);
  assert.equal(input.threads.length, 18);
  f.mail.commitReview("review", input.threads.map(thread => ({ id: thread.id, expectedVersion: thread.version, outcome: "notify" as const, summary: "Needs you", reason: "Deadline", suggestedAction: "Reply today" })));
  const done = f.mail.finishInput("review", { outcome: "advanced", note: "x" });
  const text = String(done.notification);
  assert.match(text, /^18 emails may need you/); assert.match(text, /3 more in \/mail\./);
  assert.equal((text.match(/Reply today/g) ?? []).length, 15);
  f.proactive.report("review", done); f.owner.settle(run.operationId, "");
  assert.equal(f.mail.attention(50).length, 18);
});
