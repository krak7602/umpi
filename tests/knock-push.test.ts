import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { generateKeyPairSync } from "node:crypto";
import { Store, type Database } from "../src/worker/store.js";
import { KnockPushStore, KNOCK_PUSH_REPEAT_MS } from "../src/worker/knock-push.js";
import { sendCompanionPush } from "../src/worker/companion-push.js";

function database(t: { after: (fn: () => void) => void }): Database {
  const sqlite = new DatabaseSync(":memory:"); t.after(() => sqlite.close());
  let depth = 0;
  return {
    all: <T extends object>(sql: string, ...values: (string | number | null)[]) => sqlite.prepare(sql).all(...values) as T[],
    transaction: <T>(run: () => T): T => {
      const name = `k_${depth++}`; sqlite.exec(`SAVEPOINT ${name}`);
      try { const value = run(); sqlite.exec(`RELEASE ${name}`); return value; }
      catch (error) { sqlite.exec(`ROLLBACK TO ${name}; RELEASE ${name}`); throw error; }
      finally { depth--; }
    },
  };
}

test("a reminder the phone did not set is knocked by push, three times, and the message stays quiet", t => {
  const db = database(t);
  let now = Date.now();
  const owner = new Store(db); owner.setSession("telegram", "s");
  const pushes = new KnockPushStore(db, () => now);
  owner.knockFallback = reminder => { pushes.queue(reminder); return true; };
  const due = new Date(now + 60_000).toISOString();
  owner.createReminder("r1", "Check D-U-N-S", due, "telegram", undefined, "- Look in spam too.");
  owner.createReminder("r2", "Stretch", due, "telegram", "gentle");
  owner.recordPhoneKnocks("phone", { scheduled: [{ id: "r2", version: 1 }] });
  now += 61_000;
  owner.fireReminders(now);
  assert.equal(owner.deliveries("reminder:r1:1")[0]!.silent, true, "the pushed knock is the alert");
  const first = pushes.next()!;
  assert.deepEqual({ id: first.id, text: first.text, hint: first.hint, gentle: first.gentle }, { id: "r1:1:0", text: "Check D-U-N-S", hint: "Look in spam too.", gentle: false });
  pushes.finish(first.id, "sent");
  assert.equal(pushes.next(), undefined, "a phone that set its own knock gets no push; repeats wait three minutes");
  assert.equal(pushes.nextDue(), now + KNOCK_PUSH_REPEAT_MS);
  now += KNOCK_PUSH_REPEAT_MS;
  assert.equal(pushes.next()!.attempt, 1);
});

test("a pushed knock carries the knock category, sound, Time Sensitive level, and the reminder", async () => {
  const keys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const config = { APNS_TEAM_ID: "TESTTEAM00", APNS_KEY_ID: "TESTKEY000", APNS_PRIVATE_KEY: keys.privateKey.export({ format: "pem", type: "pkcs8" }).toString(), APNS_BUNDLE_ID: "com.example.umpi" };
  const bodies: Record<string, unknown>[] = [];
  const transport = (async (_url: string | URL, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init!.body)) as Record<string, unknown>);
    return new Response(null, { status: 200, headers: { "apns-id": "123e4567-e89b-12d3-a456-426614174000" } });
  }) as typeof fetch;
  const result = await sendCompanionPush({ deviceId: "phone", apnsToken: "ab".repeat(32), apnsEnvironment: "sandbox" },
    { revision: 0, jobs: [], knock: { reminderId: "r1", version: 1, attempt: 1, text: "Check D-U-N-S", hint: "Look in spam too.", gentle: false } }, config, { fetch: transport });
  assert.equal(result.status, "accepted");
  assert.deepEqual(bodies[0], { aps: { alert: { title: "Umpi · still waiting", body: "Check D-U-N-S\nLook in spam too." }, sound: "knock.caf", category: "UMPI_KNOCK",
    "interruption-level": "time-sensitive", "thread-id": "knock.r1" }, reminderId: "r1", version: 1 });
});
