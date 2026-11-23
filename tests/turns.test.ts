import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { Store, type Operation } from "../src/worker/store.js";
import { TURN_CHECK_MS, TURN_RETRY_MS, TURN_WAIT_MS, Turns, setThinkingLevel, type TurnAnswer, type TurnHost } from "../src/worker/turns.js";
import { flush, openDatabase } from "./support/liveness.js";

/**
 * The turn driver (`src/worker/turns.ts`) against a real `Store` and a simulated model harness. The world's `wake`
 * counts the coordinator wakes; `reconcile` is one run of the coordinator's "operations" stage.
 */
interface Gate { promise: Promise<void>; open(): void }
function gate(): Gate {
  let open!: () => void;
  const promise = new Promise<void>(resolve => { open = resolve; });
  return { promise, open };
}
interface World {
  store: Store; turns: Turns; wakes: number; submits: string[]; waits: number; faults: unknown[]; finished: string[];
  /** The effort decision of the next owner turn stays pending until this opens. */
  effort?: Gate;
  /** Ends a running turn with this answer, as the model would. */
  answer(id: string, answer: TurnAnswer): void;
  /** What the next wait does in place of waiting. */
  failWait?: Error;
  reconcile(): Promise<void>;
  /** New in-memory state over the same database, as after a Durable Object restart. */
  restart(): void;
}
const START = Date.parse("2026-03-02T08:00:00Z");
function world(t: TestContext): World {
  // A wait holds a 20-second timer: the clock is simulated, so no test waits on it.
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: START });
  const sqlite = openDatabase();
  t.after(() => sqlite.sqlite.close());
  const answers = new Map<string, TurnAnswer>(), waiting = new Map<string, (answer: TurnAnswer) => void>();
  const w = { wakes: 0, submits: [], waits: 0, faults: [], finished: [] } as unknown as World;
  const host = (): TurnHost => ({
    store: w.store,
    harness: {
      async submit(_input, options) { w.submits.push(options.operationId); },
      wait(id, options) {
        w.waits++;
        if (w.failWait) { const error = w.failWait; delete w.failWait; return Promise.reject(error); }
        const done = answers.get(id);
        if (done) return Promise.resolve(done);
        return new Promise<TurnAnswer>((resolve, reject) => {
          waiting.set(id, resolve);
          options.signal.addEventListener("abort", () => { if (waiting.get(id) === resolve) waiting.delete(id); reject(new Error("wait aborted")); });
        });
      },
      async abort() { /* Not used by these turns. */ },
    },
    modelReady: async () => true,
    prepare: async () => { await w.effort?.promise; },
    beforeSubmit: async () => undefined,
    backgroundActionable: () => true,
    backgroundCurrent: () => true,
    finish: async (op, answer) => { w.finished.push(op.id); w.store.settle(op.id, answer.text ?? "", answer.status !== "done"); },
    resultFailed: error => { w.faults.push(error); },
    driveFailed: error => { w.faults.push(error); },
    wake: async () => { w.wakes++; },
    track: () => undefined,
  });
  w.restart = () => {
    w.store = new Store(sqlite.db);
    w.store.setSession("control", "owner-control");
    w.store.setSession("telegram", "owner-telegram");
    waiting.clear();
    w.turns = new Turns(host());
  };
  w.answer = (id, answer) => { answers.set(id, answer); waiting.get(id)?.(answer); waiting.delete(id); };
  w.reconcile = () => w.turns.drive();
  w.restart();
  return w;
}
const admit = (w: World, id: string, text: string): Operation => w.store.admit(id, text, "telegram", "owner-telegram", { kind: "app-text" });

test("a turn submitted in its request wakes the coordinator, so the finished reply does not wait for an unrelated wake", async t => {
  const w = world(t);
  w.effort = gate();
  const op = admit(w, "m1", "Water the ferns on Friday");
  const request = w.turns.submitDirect(op);
  await flush();
  // The wake made before admission runs now, while the effort decision is pending: the turn is admitted, so nothing is attached.
  await w.reconcile();
  assert.deepEqual(w.submits, [], "the reconciliation does not submit the turn a second time");
  assert.deepEqual(w.turns.following(), []);
  assert.equal(w.turns.nextDue(), undefined, "an admitted turn asks for no later run");
  w.effort.open();
  await request;
  assert.equal(w.store.operation(op.id)!.status, "submitted");
  assert.deepEqual(w.submits, [op.id]);
  assert.equal(w.wakes, 1, "the request path wakes the coordinator after the submit");
  // That wake is the reconciliation that follows the turn.
  await w.reconcile();
  assert.deepEqual(w.turns.following(), [op.id]);
  w.answer(op.id, { status: "done", text: "Reminder set for Friday." });
  await flush();
  assert.equal(w.store.operation(op.id)!.status, "done");
  assert.equal(w.store.operation(op.id)!.result, "Reminder set for Friday.");
  assert.equal(w.wakes, 2, "the result wakes the coordinator to deliver it");
  assert.deepEqual(w.turns.following(), []);
  assert.equal(w.turns.nextDue(), undefined);
});

test("the coordinator submits an admitted turn itself when no request did, and a turn is submitted once", async t => {
  const w = world(t);
  const op = admit(w, "m2", "Move the dentist reminder to Monday");
  await w.reconcile();
  assert.deepEqual(w.submits, [op.id]);
  assert.deepEqual(w.turns.following(), [op.id]);
  assert.equal(w.wakes, 0, "the reconciliation attaches the wait itself and needs no wake");
  await w.turns.submitDirect(w.store.operation(op.id)!);
  await w.reconcile();
  assert.deepEqual(w.submits, [op.id], "a late request and a second reconciliation submit nothing more");
  assert.equal(w.waits, 1, "and attach no second wait");
});

test("a running turn's wait renews itself at its limit; the coordinator only checks it every 30 seconds", async t => {
  const w = world(t);
  const op = admit(w, "m3", "Plan the garden beds for spring");
  await w.reconcile();
  assert.equal(w.turns.nextDue(), Date.now() + TURN_CHECK_MS, "a followed turn is checked slowly, not every two seconds");
  for (let round = 1; round <= 3; round++) {
    t.mock.timers.tick(TURN_WAIT_MS);
    await flush();
    assert.equal(w.waits, round + 1, "the wait is renewed with no reconciliation in between");
    assert.deepEqual(w.turns.following(), [op.id]);
  }
  assert.equal(w.wakes, 0, "a renewal does not wake the coordinator");
  w.answer(op.id, { status: "done", text: "Three beds: beans, squash, herbs." });
  await flush();
  assert.equal(w.store.operation(op.id)!.result, "Three beds: beans, squash, herbs.");
  assert.equal(w.wakes, 1);
});

test("after a restart, the first reconciliation follows a turn that was running", async t => {
  const w = world(t);
  const op = admit(w, "m4", "Summarize the week's notes");
  await w.reconcile();
  w.restart();
  assert.deepEqual(w.turns.following(), [], "the wait was in memory only");
  assert.equal(w.turns.nextDue(), START + TURN_RETRY_MS, "a running turn with no wait asks for a run soon");
  // `Coordinator.onStart` wakes: one reconciliation follows every restart.
  await w.reconcile();
  assert.deepEqual(w.submits, [op.id], "the turn is not submitted again");
  assert.deepEqual(w.turns.following(), [op.id]);
  w.answer(op.id, { status: "done", text: "Four notes, two open tasks." });
  await flush();
  assert.equal(w.store.operation(op.id)!.status, "done");
});

test("a wait that fails is reported, retried after two seconds, and never in a tight loop", async t => {
  const w = world(t);
  const op = admit(w, "m5", "Draft a note to the plumber");
  w.failWait = new Error("storage is busy");
  await w.reconcile();
  await flush();
  assert.equal(w.faults.length, 1);
  assert.deepEqual(w.turns.following(), []);
  assert.equal(w.wakes, 0, "the retry is not immediate");
  assert.equal(w.turns.nextDue(), Date.now() + TURN_RETRY_MS);
  t.mock.timers.tick(TURN_RETRY_MS);
  await flush();
  assert.equal(w.wakes, 1);
  await w.reconcile();
  assert.deepEqual(w.turns.following(), [op.id]);
  w.answer(op.id, { status: "unanswered", reason: "aborted" });
  await flush();
  assert.equal(w.store.operation(op.id)!.status, "failed", "a turn the model did not answer ends as failed");
});

test("the thinking level is written only when it differs from the one in effect", async () => {
  let level = "high", commits = 0;
  const conversation = { async agent() { return { thinkingLevel: level }; }, async configure(change: { thinkingLevel: string }) { level = change.thinkingLevel; commits++; } };
  assert.equal(await setThinkingLevel(conversation, "high", undefined), false);
  assert.equal(commits, 0, "an unchanged effort costs no commit before the turn");
  assert.equal(await setThinkingLevel(conversation, "low", undefined), true);
  assert.equal(await setThinkingLevel(conversation, "low", undefined), false);
  assert.equal(commits, 1);
  assert.equal(level, "low");
});
