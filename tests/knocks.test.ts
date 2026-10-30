import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { Store, type Database } from "../src/worker/store.js";
import { KnockStore } from "../src/worker/knocks.js";
import { authorize } from "../src/worker/transport.js";
import { KNOCK_CLAIM_MS, KNOCK_RETRY_MS, KNOCK_SNOOZE_MINUTES, type KnockAssignment, type KnockReport } from "../src/shared/knock.js";
import { tmpdir } from "node:os";
import { DEFAULT_KNOCK_TONE, KNOCK_POLL_MS, KnockLane, chimeSound, knockTonePath, knockTones, macPresenter } from "../src/mac/knock.js";
import { parseConfig } from "../src/mac/config.js";

const NOW = Date.parse("2026-10-30T09:00:00Z");

function database(t: TestContext): Database {
  const sqlite = new DatabaseSync(":memory:"); let depth = 0;
  t.after(() => sqlite.close());
  return {
    all: <T extends object>(query: string, ...bindings: (string | number | null)[]) => sqlite.prepare(query).all(...bindings) as T[],
    transaction<T>(run: () => T): T {
      const name = `k_${depth++}`; sqlite.exec(`SAVEPOINT ${name}`);
      try { const value = run(); sqlite.exec(`RELEASE ${name}`); return value; }
      catch (error) { sqlite.exec(`ROLLBACK TO ${name}; RELEASE ${name}`); throw error; }
      finally { depth--; }
    },
  };
}
function fixture(t: TestContext) {
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  const db = database(t);
  const store = new Store(db); store.setSession("telegram", "owner");
  let now = NOW;
  const knocks = new KnockStore(db, () => now);
  store.reminderFired = reminder => knocks.add(reminder);
  return { store, knocks, advance(ms: number) { now += ms; t.mock.timers.tick(ms); }, get now() { return now; } };
}
const report = (knock: KnockAssignment, outcome: KnockReport["outcome"], executorId = "mac-1") => ({ executorId, id: knock.id, attempt: knock.attempt, outcome });

test("a fired reminder knocks; Done records the answer and Snooze schedules it again", t => {
  const f = fixture(t);
  f.store.createReminder("stretch", "Stand up and stretch", new Date(NOW + 60_000).toISOString(), "telegram");
  f.advance(60_000); f.store.fireReminders(f.now);
  assert.deepEqual(f.knocks.demand(), ["knock:stretch:1:1"]);
  const [knock] = f.knocks.poll({ executorId: "mac-1" }).knocks;
  assert.deepEqual(knock, { id: "stretch:1", attempt: 1, text: "Stand up and stretch", intensity: "knock" });
  assert.deepEqual(f.knocks.demand(), [], "a claimed knock needs no further wake");
  assert.deepEqual(f.knocks.poll({ executorId: "mac-1" }).knocks, [], "a claim is handed out once");

  const answer = f.knocks.report(report(knock!, "snoozed"));
  assert.deepEqual(answer, { reminderId: "stretch", action: "snooze" });
  const snoozed = f.store.answerReminder(answer!.reminderId, answer!.action, KNOCK_SNOOZE_MINUTES, f.now)!;
  assert.equal(snoozed.status, "scheduled"); assert.equal(snoozed.version, 2);
  assert.equal(Date.parse(snoozed.dueAt), f.now + 10 * 60_000);
  assert.equal(f.knocks.report(report(knock!, "done")), null, "a repeated report changes nothing");

  f.advance(10 * 60_000); f.store.fireReminders(f.now);
  const [again] = f.knocks.poll({ executorId: "mac-1" }).knocks;
  assert.equal(again!.id, "stretch:2", "the snoozed reminder knocks again as its new version");
  assert.deepEqual(f.knocks.report(report(again!, "done")), { reminderId: "stretch", action: "done" });
  assert.equal(f.store.answerReminder("stretch", "done", KNOCK_SNOOZE_MINUTES, f.now)!.answer!.outcome, "done");
  assert.deepEqual(f.knocks.status(), { done: 1, snoozed: 1 });
});

test("an unanswered knock repeats three minutes apart, a gentle one knocks once, and stale work expires", t => {
  const f = fixture(t);
  f.store.createReminder("call", "Call the bank", new Date(NOW + 1_000).toISOString(), "telegram");
  f.store.createReminder("water", "Drink water", new Date(NOW + 1_000).toISOString(), "telegram", "gentle");
  f.advance(1_000); f.store.fireReminders(f.now);
  const first = f.knocks.poll({ executorId: "mac-1" }).knocks;
  assert.equal(first.length, 2);
  for (const knock of first) assert.equal(f.knocks.report(report(knock, "away")), null);
  assert.equal(f.knocks.nextDue(), f.now + KNOCK_RETRY_MS);
  assert.deepEqual(f.knocks.poll({ executorId: "mac-1" }).knocks, [], "the retry waits three minutes");
  f.advance(KNOCK_RETRY_MS);
  const second = f.knocks.poll({ executorId: "mac-1" }).knocks;
  assert.deepEqual(second.map(knock => [knock.id, knock.attempt]), [["call:1", 2]], "the gentle reminder does not repeat");

  // The executor stopped while showing the second knock: its claim lapses into the third attempt.
  f.advance(KNOCK_CLAIM_MS);
  f.knocks.poll({ executorId: "mac-1" });
  f.advance(KNOCK_RETRY_MS);
  const third = f.knocks.poll({ executorId: "mac-1" }).knocks;
  assert.deepEqual(third.map(knock => knock.attempt), [3]);
  f.knocks.report(report(third[0]!, "missed"));
  assert.deepEqual(f.knocks.status(), { missed: 2 });
  assert.equal(f.knocks.nextDue(), undefined);

  f.store.createReminder("late", "Late one", new Date(f.now + 1_000).toISOString(), "telegram");
  f.advance(1_000); f.store.fireReminders(f.now);
  f.advance(31 * 60_000);
  assert.deepEqual(f.knocks.poll({ executorId: "mac-1" }).knocks, [], "a knock nobody collected for half an hour is dropped");
  assert.equal((f.knocks.status() as Record<string, number>).expired, 1);
});

test("only the claiming executor's report counts, and only the executor credential reaches the routes", async t => {
  const f = fixture(t);
  f.store.createReminder("x", "X", new Date(NOW + 1_000).toISOString(), "telegram");
  f.advance(1_000); f.store.fireReminders(f.now);
  const [knock] = f.knocks.poll({ executorId: "mac-1" }).knocks;
  assert.equal(f.knocks.report(report(knock!, "done", "mac-2")), null);
  assert.throws(() => f.knocks.report({ ...report(knock!, "done"), outcome: "maybe" }), /Invalid knock outcome/);
  const env = { UMPI_CONTROL_TOKEN: "c".repeat(40), UMPI_EXECUTOR_TOKEN: "e".repeat(40) };
  const request = (path: string, token: string) => new Request(`https://coordinator.example${path}`, { method: "POST", headers: { authorization: `Bearer ${token}` } });
  for (const path of ["/api/executor/knock/poll", "/api/executor/knock/report"]) {
    await authorize(request(path, env.UMPI_EXECUTOR_TOKEN), env);
    await assert.rejects(authorize(request(path, env.UMPI_CONTROL_TOKEN), env), { status: 401 });
  }
});

test("the Mac lane polls on wake or each minute, shows knocks one at a time, and resends unsent answers", async () => {
  let now = 0, polls = 0, failReport = true;
  const sent: KnockReport[] = [], shown: string[] = [];
  const queue: KnockAssignment[][] = [[{ id: "a:1", attempt: 1, text: "A", intensity: "knock" }, { id: "b:1", attempt: 1, text: "B", intensity: "gentle" }]];
  const transport = {
    async poll() { polls++; return { knocks: queue.shift() ?? [] }; },
    async report(report: KnockReport) { if (failReport) { failReport = false; throw new Error("offline"); } sent.push(report); },
  };
  const events: string[] = [];
  const lane = new KnockLane("mac-1", { async present(knock) { shown.push(knock.id); return knock.id === "a:1" ? "done" : "away"; } }, { emit: event => events.push(event), now: () => now });
  const signal = new AbortController().signal;
  await lane.tick(transport, signal); await lane.idle();
  assert.deepEqual(shown, ["a:1", "b:1"]); assert.deepEqual(events, ["knock_done", "knock_away"]);
  assert.deepEqual(sent.map(item => item.outcome), ["away"], "the first answer failed to send");
  await lane.tick(transport, signal);
  assert.deepEqual(sent.map(item => item.outcome), ["away", "done"], "it is resent on the next tick");
  assert.equal(polls, 1, "no poll before a minute without a wake");
  lane.wake(); await lane.tick(transport, signal); assert.equal(polls, 2);
  now += KNOCK_POLL_MS; await lane.tick(transport, signal); assert.equal(polls, 3);
});

test("the fallback chime is a 24-second WAV that stays quiet, and an idle owner is not knocked", async () => {
  const wav = chimeSound();
  assert.equal(wav.toString("ascii", 0, 4), "RIFF"); assert.equal(wav.toString("ascii", 8, 12), "WAVE");
  const rate = wav.readUInt32LE(24), bytes = wav.readUInt32LE(40);
  assert.equal(bytes / 2 / rate, 24);
  const pcm = new Int16Array(wav.buffer.slice(wav.byteOffset + 44, wav.byteOffset + wav.length));
  const peak = (from: number, to: number) => pcm.subarray(from * rate, to * rate).reduce((max, value) => Math.max(max, Math.abs(value)), 0) / 32_767;
  assert.ok(peak(0, 3) > 0.05, "it is audible from the start");
  assert.ok(peak(0, 3) < peak(18, 24), "it swells a little");
  assert.ok(peak(0, 24) < 0.45, "it never gets loud");
  const presenter = macPresenter("/nonexistent", { idle: async () => 600 });
  assert.equal(await presenter.present({ id: "a:1", attempt: 1, text: "A", intensity: "knock" }, new AbortController().signal), "away");
});

test("the knock tone is a named setting, and the Mac's tone library is listed by name", () => {
  const base = { serverUrl: "https://coordinator.example", executorToken: "private-test-token-with-at-least-32-characters", executorId: "executor-test", workspaces: [tmpdir()] };
  assert.equal(parseConfig(base).knock, undefined);
  assert.deepEqual(parseConfig({ ...base, knock: { tone: "Slow Rise" } }).knock, { tone: "Slow Rise" });
  for (const knock of [{ tone: "../etc/passwd" }, { tone: "" }, { tone: "Silk", volume: 1 }, "Silk"]) assert.throws(() => parseConfig({ ...base, knock }));
  const tones = knockTones();
  assert.equal(new Set(tones.map(tone => tone.name)).size, tones.length, "names are unique");
  if (process.platform === "darwin" && tones.length) {
    assert.ok(knockTonePath(DEFAULT_KNOCK_TONE), "the default tone ships with macOS");
    assert.ok(tones.every(tone => tone.path.startsWith("/System/Library/")));
  }
  assert.equal(knockTonePath("Not a tone"), undefined);
});
