import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { FaultLedger, faultKind, nextWake, retryDelay, runStages, type Stage } from "../src/worker/faults.js";
import { StateError, type Database } from "../src/worker/store.js";

function database(t: TestContext): Database {
  const sqlite = new DatabaseSync(":memory:"); t.after(() => sqlite.close());
  return {
    all: <T extends object>(query: string, ...bindings: (string | number | null)[]) => sqlite.prepare(query).all(...bindings) as T[],
    transaction: <T>(run: () => T): T => run(),
  };
}

test("a stage that fails is reported and the later stages still run, except one that needs it", async () => {
  const ran: string[] = [], reported: string[] = [];
  const stage = (name: string, fail = false, needs?: string[]): Stage => ({ name, ...(needs ? { needs } : {}), run: async () => { ran.push(name); if (fail) throw new Error("private text that must not be kept"); } });
  const bad = await runStages([stage("reminders"), stage("mail", true), stage("holds", true), stage("delivery", false, ["holds"]), stage("push")], (name, error) => { reported.push(`${name}:${faultKind(error)}`); });
  assert.deepEqual(ran, ["reminders", "mail", "holds", "push"], "delivery is skipped because the hold decision failed; the push still goes");
  assert.deepEqual(bad, ["mail", "holds", "delivery"]);
  assert.deepEqual(reported, ["mail:Error", "holds:Error"]);
  assert.deepEqual(await runStages([stage("only")], () => assert.fail("nothing failed")), []);
});

test("the next wake is the earliest due of healthy stages; a failed stage waits for the retry instead of looping", async () => {
  const stages: Stage[] = [
    { name: "mail", run() {}, due: () => 1_000 },
    { name: "reminders", run() {}, due: () => 50_000 },
    { name: "quiet", run() {}, due: () => undefined },
    { name: "no-timer", run() {} },
  ];
  const none = () => assert.fail("no due time failed");
  assert.equal(await nextWake(stages, [], Infinity, none), 1_000);
  assert.equal(await nextWake(stages, ["mail"], 30_000, none), 30_000, "mail is due now but failed: the retry, not its own due time");
  assert.equal(await nextWake(stages, ["mail"], 90_000, none), 50_000, "a healthy reminder is not delayed by mail's fault");
  assert.equal(await nextWake([stages[2]!, stages[3]!], [], Infinity, none), Infinity, "nothing to wake for");
  const reported: string[] = [];
  const broken: Stage = { name: "cloud", run() {}, due: () => { throw new StateError(503, "not kept"); } };
  assert.equal(await nextWake([broken, stages[1]!], [], 20_000, (name, error) => { reported.push(`${name}:${faultKind(error)}`); }), 20_000);
  assert.deepEqual(reported, ["cloud:StateError:503"]);
});

test("a lasting fault is retried less and less often", () => {
  assert.deepEqual([1, 6, 7, 30, 31, 500].map(retryDelay), [10_000, 10_000, 60_000, 60_000, 300_000, 300_000]);
});

test("the ledger counts a fault by site and kind and never keeps its message", t => {
  let now = Date.parse("2027-03-01T10:00:00Z");
  const db = database(t), ledger = new FaultLedger(db, () => now);
  ledger.record("reconcile:mail", new TypeError("Invoice 4471 for Asha could not be parsed"));
  now += 60_000;
  ledger.record("reconcile:mail", new TypeError("another private sentence"));
  ledger.record("reconcile:mail", new StateError(409, "private"));
  ledger.record("http", Object.assign(new Error("x"), { code: "ECONNRESET" }));
  ledger.record("http", "a thrown string");
  ledger.record("http", Object.assign(new Error("x"), { name: "Weird name; DROP TABLE", code: "not a code!" }));
  const faults = ledger.recent();
  assert.deepEqual(faults.find(fault => fault.kind === "TypeError"), { site: "reconcile:mail", kind: "TypeError", count: 2, firstAt: "2027-03-01T10:00:00.000Z", lastAt: "2027-03-01T10:01:00.000Z" });
  assert.deepEqual(faults.map(fault => fault.kind).sort(), ["Error", "Error:ECONNRESET", "StateError:409", "TypeError", "string"]);
  assert.ok(!JSON.stringify(db.all("SELECT * FROM umpi_faults")).match(/Invoice|Asha|private|DROP/), "no message text is stored");
  now += 31 * 24 * 3_600_000;
  ledger.record("reconcile:brief", new RangeError("x"));
  assert.deepEqual(ledger.recent().map(fault => fault.site), ["reconcile:brief"], "faults not seen for 30 days are dropped");
  const closed: Database = { all() { throw new Error("database is closed"); }, transaction: run => run() };
  assert.doesNotThrow(() => new FaultLedger(db).record.call({ db: closed, now: () => now }, "x", new Error("y")), "recording never throws");
});
