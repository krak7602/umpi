import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { mergeDailyPlan } from "../src/shared/daily-planning.js";
import { vaultNoteRevision, type VaultPlanningApply, type VaultPlanningResult, type VaultPlanningSnapshot } from "../src/shared/vault-planning.js";
import { JournalRuntime, JournalStore, noteTasks } from "../src/worker/journal.js";
import { MailStore } from "../src/worker/mail-store.js";
import { PlanningStore } from "../src/worker/planning-store.js";
import { ProactiveStore } from "../src/worker/proactive-store.js";
import { SituationStore } from "../src/worker/situation-store.js";
import { Store, type Database } from "../src/worker/store.js";
import { authorize } from "../src/worker/transport.js";

// 2027-04-15 08:00 in Asia/Kolkata (after the 02:30 preparation time).
const NOW = Date.parse("2027-04-15T02:30:00Z");
const TZ = "Asia/Kolkata";
const TEMPLATE = "# {{date:MMM Do, YYYY}}\n\n## Plan\n\n### Schedule\n\n### Tasks\n\n## Done / changed\n\n## Notes\n\n## Links\n";

function fakeVault(notes: Map<string, string>) {
  const writes: VaultPlanningApply[] = [];
  let failNext = 0;
  return {
    writes, failWrites(count: number) { failNext = count; },
    client: {
      async getSnapshot(day: string): Promise<VaultPlanningSnapshot> {
        const target = notes.get(day) ?? null;
        return { day, checkedAt: new Date().toISOString(), revision: vaultNoteRevision(target), target, template: TEMPLATE, recent: [] };
      },
      async applyNote(intent: VaultPlanningApply): Promise<VaultPlanningResult> {
        writes.push(intent);
        if (failNext > 0) { failNext--; return { status: "unconfirmed", revision: intent.beforeRevision, checkedAt: new Date().toISOString() }; }
        if (vaultNoteRevision(notes.get(intent.day) ?? null) !== intent.beforeRevision) return { status: "conflict", revision: vaultNoteRevision(notes.get(intent.day) ?? null), checkedAt: new Date().toISOString() };
        notes.set(intent.day, intent.text);
        return { status: "synced", revision: vaultNoteRevision(intent.text), checkedAt: new Date().toISOString() };
      },
    },
  };
}

function fixture(t: TestContext) {
  const sqlite = new DatabaseSync(":memory:"); let depth = 0;
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  const db: Database = {
    all: <T extends object>(query: string, ...bindings: (string | number | null)[]) => sqlite.prepare(query).all(...bindings) as T[],
    transaction<T>(run: () => T): T {
      const name = `j_${depth++}`; sqlite.exec(`SAVEPOINT ${name}`);
      try { const value = run(); sqlite.exec(`RELEASE ${name}`); return value; }
      catch (error) { sqlite.exec(`ROLLBACK TO ${name}; RELEASE ${name}`); throw error; }
      finally { depth--; }
    },
  };
  const owner = new Store(db); owner.setSession("telegram", "owner");
  const proactive = new ProactiveStore(owner, TZ); proactive.configure({ expectedVersion: 1, enabled: true, quietHours: null }, NOW);
  const situation = new SituationStore(db, TZ), planning = new PlanningStore(proactive, TZ), mail = new MailStore(proactive, situation);
  const notes = new Map<string, string>(), vault = fakeVault(notes);
  const work: Promise<unknown>[] = [];
  const journal = new JournalRuntime(new JournalStore(db), proactive, {
    vault: () => vault.client, planning, situation, mail, calendarCredentials: () => undefined, ownedCommitment: () => false,
    track: promise => { work.push(promise); }, wake: async () => {},
  });
  async function drive(now = Date.now()) { journal.drive(now); await Promise.all(work.splice(0)); }
  const sent = () => owner.deliveries().filter(delivery => delivery.groupId.startsWith("journal:")).map(delivery => delivery.text);
  return { owner, proactive, situation, journal, notes, vault, drive, sent, time(now: number) { t.mock.timers.setTime(now); } };
}
const source = { account: "primary", threadId: "t", webUrl: "https://mail.google.com/x", receivedAt: "2027-04-14T05:00:00Z" };

test("Done / changed gets marked lines below owner lines, and owner lines are never edited", () => {
  const current = "# Apr 14th, 2027\n\n## Plan\n\n### Tasks\n\n- [ ] Write the report\n\n## Done / changed\n\n- Called the bank\n\n## Notes\n\nOwner thoughts.\n";
  const merged = mergeDailyPlan({ day: "2027-04-14", current, template: TEMPLATE, previous: [], patch: { entries: [
    { id: "done-a", section: "done", text: "Delivered: Headphones" }, { id: "note-b", section: "notes", text: "Remember the invoice" },
  ], coverage: [] } });
  assert.match(merged.text, /## Done \/ changed\n\n- Called the bank\n- Delivered: Headphones <!-- umpi-plan:done-a -->\n/);
  assert.match(merged.text, /## Notes\n\nOwner thoughts\.\n- Remember the invoice <!-- umpi-plan:note-b -->\n/);
  assert.match(merged.text, /- \[ \] Write the report\n/);
  const again = mergeDailyPlan({ day: "2027-04-14", current: merged.text, template: TEMPLATE, previous: [], patch: { entries: [{ id: "done-a", section: "done", text: "Delivered: Headphones" }], coverage: [] } });
  assert.equal(again.text, merged.text, "a retried line is not duplicated");
  const missing = mergeDailyPlan({ day: "2027-04-14", current: "# Apr 14th, 2027\n\n## Plan\n", template: TEMPLATE, previous: [], patch: { entries: [{ id: "done-c", section: "done", text: "Paid: Rent" }], coverage: [] } });
  assert.match(missing.text, /## Plan\n\n## Done \/ changed\n\n- Paid: Rent <!-- umpi-plan:done-c -->\n$/);
});

test("check-ins read open and done tasks from the Tasks section only", () => {
  const tasks = noteTasks("# Day\n\n## Plan\n\n### Tasks\n\n- [x] DSA set <!-- umpi-plan:t1 -->\n- [ ] Ship mail fix\n- [ ] Apply to two roles\n\n## Done / changed\n\n- [ ] not a task\n");
  assert.deepEqual(tasks, { open: ["Ship mail fix", "Apply to two roles"], done: ["DSA set"] });
});

test("yesterday's close-out is written once from recorded facts, with spending as one total", async t => {
  const f = fixture(t);
  f.situation.observe({ kind: "order", key: "amazon 1", title: "Headphones", state: "delivered", happenedAt: "2027-04-14T11:00:00+05:30" }, source, NOW);
  f.situation.observe({ kind: "job", key: "acme backend", title: "Backend Engineer at Acme", state: "applied", happenedAt: "2027-04-14T15:00:00+05:30" }, source, NOW);
  f.situation.observe({ kind: "spend", key: "hdfc 1", title: "UPI", state: "debited", counterparty: "Zomato", amount: { value: 450, currency: "INR" }, happenedAt: "2027-04-14T13:00:00+05:30" }, source, NOW);
  f.situation.observe({ kind: "spend", key: "hdfc 2", title: "Card", state: "debited", counterparty: "Amazon", amount: { value: 1299, currency: "INR" }, happenedAt: "2027-04-14T18:00:00+05:30" }, source, NOW);
  f.situation.observe({ kind: "bill", key: "kseb", title: "Electricity bill", state: "due", dueAt: "2027-04-20T00:00:00+05:30", happenedAt: "2027-04-14T10:00:00+05:30" }, source, NOW);
  await f.drive();
  const note = f.notes.get("2027-04-14")!;
  assert.match(note, /## Done \/ changed\n\n- Delivered: Headphones <!-- umpi-plan:done-[a-f0-9]{16} -->\n- Applied: Backend Engineer at Acme <!--/);
  assert.match(note, /- Spent ₹1,749 in 2 payments \(largest: Amazon \(₹1,299\), Zomato \(₹450\)\)/);
  assert.doesNotMatch(note, /Electricity/, "a bill that only became due is not something that happened");
  const writes = f.vault.writes.length;
  await f.drive(NOW + 60_000);
  assert.equal(f.vault.writes.length, writes, "the close-out runs once per day");
});

test("routine additions batch hourly, owner requests write now, and today's note waits for morning preparation", async t => {
  const f = fixture(t);
  f.journal.store.configure({ expectedVersion: 1, closeOut: false, checkIns: [] });
  f.notes.set("2027-04-15", "# Apr 15th, 2027\n\n## Plan\n\n### Schedule\n\n### Tasks\n\n## Done / changed\n\n## Notes\n");
  f.journal.calendarEvents([{ id: "calendar-abc", title: "Standup", start: "2027-04-15T04:30:00Z", end: "2027-04-15T04:45:00Z" }]);
  await f.drive();
  assert.match(f.notes.get("2027-04-15")!, /### Schedule\n\n- 10:00–10:15 Standup <!-- umpi-plan:calendar-abc -->/);
  f.journal.calendarEvents([{ id: "calendar-def", title: "1:1", start: "2027-04-15T09:00:00Z", end: "2027-04-15T09:30:00Z", tentative: true }]);
  await f.drive(NOW + 60_000);
  assert.doesNotMatch(f.notes.get("2027-04-15")!, /1:1/, "a routine addition waits for the hourly batch");
  f.journal.add("2027-04-15", "tasks", "Call the landlord", NOW + 60_000);
  await f.drive(NOW + 60_000);
  assert.match(f.notes.get("2027-04-15")!, /- \[ \] Call the landlord <!--/);
  assert.match(f.notes.get("2027-04-15")!, /- \[tentative\] 14:30–15:00 1:1 <!--/, "the batch is written with the urgent line");
  assert.throws(() => f.journal.add("2027-05-30", "notes", "Too far"), /seven days/);
  f.owner.db.all("CREATE TABLE IF NOT EXISTS umpi_daily_plans (day TEXT PRIMARY KEY, status TEXT NOT NULL, commitment_id TEXT, data TEXT NOT NULL)");
  f.owner.db.all("INSERT OR REPLACE INTO umpi_daily_plans VALUES (?,?,?,?)", "2027-04-15", "ready", null, JSON.stringify({ day: "2027-04-15", status: "ready" }));
  f.journal.add("2027-04-15", "notes", "Second thought", NOW + 120_000);
  const before = f.vault.writes.length;
  await f.drive(NOW + 120_000);
  assert.equal(f.vault.writes.length, before, "today's note is not written while preparation holds its inputs");
});

test("unconfirmed writes retry later from the current note without duplicating lines", async t => {
  const f = fixture(t);
  f.journal.store.configure({ expectedVersion: 1, closeOut: false, checkIns: [] });
  f.vault.failWrites(1);
  f.journal.add("2027-04-15", "notes", "Retry me", NOW);
  await f.drive();
  assert.equal(f.notes.get("2027-04-15"), undefined);
  await f.drive(NOW + 5 * 60_000);
  assert.equal(f.vault.writes.length, 1, "retries wait ten minutes");
  await f.drive(NOW + 11 * 60_000);
  assert.equal((f.notes.get("2027-04-15")!.match(/Retry me/g) ?? []).length, 1);
  assert.deepEqual((f.journal.store.status() as { entries: Record<string, number> }).entries, { written: 1 });
});

test("check-ins summarize the note's tasks at their local time, once", async t => {
  const f = fixture(t);
  f.journal.store.configure({ expectedVersion: 1, closeOut: false, checkIns: ["13:00"] });
  f.notes.set("2027-04-15", "# Apr 15th, 2027\n\n## Plan\n\n### Tasks\n\n- [x] DSA set\n- [ ] Ship mail fix\n");
  await f.drive();
  assert.deepEqual(f.sent(), []);
  const oneLocal = Date.parse("2027-04-15T07:30:00Z");
  f.time(oneLocal); await f.drive(oneLocal);
  assert.deepEqual(f.sent(), ["Midday check-in: 1 of 2 tasks done. Still open: Ship mail fix. Want to move or drop anything?"]);
  await f.drive(oneLocal + 60_000);
  assert.equal(f.sent().length, 1);
});

test("journal routes are owner-only and exact-method", async () => {
  const env = { UMPI_CONTROL_TOKEN: "c".repeat(32), UMPI_EXECUTOR_TOKEN: "e".repeat(32) };
  for (const [method, path] of [["GET", "/api/journal"], ["PUT", "/api/journal/settings"]]) {
    await authorize(new Request(`https://example.test${path}`, { method, headers: { authorization: `Bearer ${env.UMPI_CONTROL_TOKEN}` } }), env);
    await assert.rejects(authorize(new Request(`https://example.test${path}`, { method, headers: { authorization: `Bearer ${env.UMPI_EXECUTOR_TOKEN}` } }), env), { status: 401 });
  }
});
