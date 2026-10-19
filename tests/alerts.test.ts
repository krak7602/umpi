import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { AlertRuntime, AlertStore } from "../src/worker/alerts.js";
import { ProactiveStore } from "../src/worker/proactive-store.js";
import { SituationStore } from "../src/worker/situation-store.js";
import { Store, type Database } from "../src/worker/store.js";
import { authorize } from "../src/worker/transport.js";

// 2027-04-15 11:30 in Asia/Kolkata.
const NOW = Date.parse("2027-04-15T06:00:00Z");
const TZ = "Asia/Kolkata";
const source = { account: "primary", threadId: "t", webUrl: "https://mail.google.com/x", receivedAt: "2027-04-15T05:00:00Z" };

function fixture(t: TestContext) {
  const sqlite = new DatabaseSync(":memory:"); let depth = 0;
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  const db: Database = {
    all: <T extends object>(query: string, ...bindings: (string | number | null)[]) => sqlite.prepare(query).all(...bindings) as T[],
    transaction<T>(run: () => T): T {
      const name = `a_${depth++}`; sqlite.exec(`SAVEPOINT ${name}`);
      try { const value = run(); sqlite.exec(`RELEASE ${name}`); return value; }
      catch (error) { sqlite.exec(`ROLLBACK TO ${name}; RELEASE ${name}`); throw error; }
      finally { depth--; }
    },
  };
  const owner = new Store(db); owner.setSession("telegram", "owner"); owner.registerBackgroundSession("background", "telegram");
  const proactive = new ProactiveStore(owner, TZ); proactive.configure({ expectedVersion: 1, enabled: true, quietHours: null }, NOW);
  const situation = new SituationStore(db, TZ), store = new AlertStore(db);
  // Calendar polling is exercised through the cache; no provider credentials in tests.
  store.writeMeta({ lastCalendarPoll: NOW, calendarIssue: null });
  const alerts = new AlertRuntime(store, situation, proactive, () => undefined, id => id === "mail-follow-through");
  const sent = () => owner.deliveries().filter(delivery => delivery.groupId.startsWith("alert:")).sort((a, b) => a.id.localeCompare(b.id)).map(delivery => delivery.text);
  return { owner, proactive, situation, store, alerts, sent, time(now: number) { t.mock.timers.setTime(now); } };
}

test("due-soon nudges fire once at their local lead time and respect owner corrections", async t => {
  const f = fixture(t);
  f.store.configure({ expectedVersion: 1, calendarLeadMinutes: 0 });
  // Due on Apr 17 (date only): nudge at 09:00 local on Apr 16.
  const bill = f.situation.observe({ kind: "bill", key: "kseb april", title: "Electricity bill", state: "due", amount: { value: 1240, currency: "INR" }, dueAt: "2027-04-17T00:00:00+05:30" }, source, NOW);
  f.situation.observe({ kind: "subscription", key: "xbox game pass", title: "Xbox Game Pass", state: "active", amount: { value: 699, currency: "INR" }, dueAt: "2027-04-17T00:00:00+05:30" }, source, NOW);
  f.situation.observe({ kind: "job", key: "acme backend", title: "Backend Engineer at Acme", state: "interview", detail: "Video call with the team", dueAt: "2027-04-15T15:00:00+05:30" }, source, NOW);
  f.situation.observe({ kind: "order", key: "amazon 403-1", title: "Headphones", state: "out_for_delivery", counterparty: "Amazon.in" }, source, NOW);
  await f.alerts.drive(NOW);
  // The subscription's 09:00 nudge two days ahead already passed this morning, so it goes now.
  assert.deepEqual(f.sent().sort(), ["Out for delivery today: Headphones from Amazon.in.", "Xbox Game Pass renews in 2 days (₹699). Keep it, or cancel before then."]);
  assert.equal(f.alerts.nextDue(NOW), Date.parse("2027-04-15T08:30:00Z"), "the interview nudge is next, one hour before 15:00 local");
  f.time(Date.parse("2027-04-15T08:30:00Z")); await f.alerts.drive(Date.now());
  assert.ok(f.sent().some(text => /^In 1 hour \(3:00 pm\): Backend Engineer at Acme\. Video call with the team\.$/i.test(text)));
  assert.equal(f.sent().length, 3);
  f.situation.correct({ id: bill.id, expectedVersion: bill.version, state: "paid" });
  f.time(Date.parse("2027-04-16T03:30:00Z")); await f.alerts.drive(Date.now());
  assert.equal(f.sent().length, 3, "a paid bill does not nudge");
  await f.alerts.drive(Date.now());
  assert.equal(f.sent().length, 3, "nothing repeats");
});

test("calendar heads-ups use the cached schedule and skip events outside the lead window", async t => {
  const f = fixture(t);
  f.store.replaceEvents([
    { key: "a", title: "Standup", start: "2027-04-15T06:10:00.000Z", end: "2027-04-15T06:25:00.000Z", tentative: false },
    { key: "b", title: "1:1", start: "2027-04-15T09:00:00.000Z", end: "2027-04-15T09:30:00.000Z", tentative: true },
  ], NOW);
  await f.alerts.drive(NOW);
  assert.deepEqual(f.sent(), ["at 11:40 am: Standup (in 10 min)."]);
  assert.equal(f.alerts.nextDue(NOW), NOW + 20 * 60_000, "the calendar cache is refreshed on its 20-minute cadence");
  f.time(Date.parse("2027-04-15T08:45:00Z")); f.store.writeMeta({ lastCalendarPoll: Date.now(), calendarIssue: null });
  await f.alerts.drive(Date.now());
  assert.ok(f.sent().includes("Tentative, at 2:30 pm: 1:1 (in 15 min).")); assert.equal(f.sent().length, 2);
  const settings = f.store.configure({ expectedVersion: 1, calendarLeadMinutes: 0 });
  assert.equal(settings.calendarLeadMinutes, 0);
});

test("a commitment that stopped moving gets one review per version, and system-owned work is excluded", async t => {
  const f = fixture(t);
  f.proactive.createCommitment({ id: "learn-dsa", purpose: "Finish the graph problems set", source: "Owner request", nextAction: "Check progress", blocker: null, status: "active", nextReviewAt: null, jobId: null, allowNotify: true }, "telegram", "owner", NOW);
  f.proactive.createCommitment({ id: "mail-follow-through", purpose: "Mail", source: "System", nextAction: "x", blocker: null, status: "active", nextReviewAt: null, jobId: null, allowNotify: true }, "telegram", "owner", NOW);
  await f.alerts.drive(NOW);
  assert.equal(f.store.sent("stalled:learn-dsa:v1"), false);
  f.time(NOW + 2 * 86_400_000 + 1); await f.alerts.drive(Date.now());
  assert.equal(f.store.sent("stalled:learn-dsa:v1"), true);
  assert.equal(f.store.sent("stalled:mail-follow-through:v1"), false);
  f.proactive.drive(Date.now(), false, { telegram: "background" });
  assert.equal(f.proactive.runForSession("background")?.commitmentId, "learn-dsa");
});

test("alert routes are owner-only and exact-method", async () => {
  const env = { UMPI_CONTROL_TOKEN: "c".repeat(32), UMPI_EXECUTOR_TOKEN: "e".repeat(32) };
  for (const [method, path] of [["GET", "/api/alerts"], ["PUT", "/api/alerts/settings"]]) {
    await authorize(new Request(`https://example.test${path}`, { method, headers: { authorization: `Bearer ${env.UMPI_CONTROL_TOKEN}` } }), env);
    await assert.rejects(authorize(new Request(`https://example.test${path}`, { method, headers: { authorization: `Bearer ${env.UMPI_EXECUTOR_TOKEN}` } }), env), { status: 401 });
  }
  await assert.rejects(authorize(new Request("https://example.test/api/alerts/settings", { method: "POST", headers: { authorization: `Bearer ${env.UMPI_CONTROL_TOKEN}` } }), env), { status: 404 });
});
