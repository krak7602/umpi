import assert from "node:assert/strict";
import test from "node:test";
import { BrowserRuntime, type BrowserRuntimeHost } from "../src/worker/browser-runtime.js";
import type { BrowserSnapshots } from "../src/worker/browser-snapshots.js";
import { BrowserStore } from "../src/worker/browser-store.js";
import { CodingRuntime, type CodingRuntimeHost } from "../src/worker/coding-runtime.js";
import { CodingStore } from "../src/worker/coding-store.js";
import { EXECUTOR_OFFLINE_NOTICE_MS, ExecutorPresence } from "../src/worker/executor-presence.js";
import { JournalRuntime, JournalStore } from "../src/worker/journal.js";
import { KnockPushStore } from "../src/worker/knock-push.js";
import { KnockStore } from "../src/worker/knocks.js";
import { KNOCK_CLAIM_MS, KNOCK_EXPIRY_MS, KNOCK_RETRY_MS } from "../src/shared/knock.js";
import type { MailStore } from "../src/worker/mail-store.js";
import { PlanningStore } from "../src/worker/planning-store.js";
import type { VaultPlanningClient } from "../src/worker/planning-runtime.js";
import { ProactiveStore } from "../src/worker/proactive-store.js";
import type { SituationStore } from "../src/worker/situation-store.js";
import { Store } from "../src/worker/store.js";
import { TelegramInbox } from "../src/worker/telegram-inbox.js";
import { planningDay } from "../src/shared/daily-planning.js";
import { vaultNoteRevision } from "../src/shared/vault-planning.js";
import type { TelegramInboxInput } from "../src/shared/voice-note.js";
import { DAY, HOUR, MINUTE, SECOND, flush, scenario, simulate, tables, type Clock, type Item, type Lane, type Random, type Sqlite } from "./support/liveness.js";

/**
 * Liveness of the coordinator's lanes, checked by simulation (the harness is `tests/support/liveness.ts`).
 *
 * The property: every piece of work in a non-terminal state has a finite next wake that is not "now forever", or a
 * reason the owner can see. Two checks over every state a random sequence reaches:
 *
 * 1. No orphan. A work item that is not finished has a wake (the lane's `nextDue` is a finite time), or it is in a
 *    state from the lane's `waiting` list. Each entry of that list quotes the code or doc that shows the state to
 *    the owner.
 * 2. No spin. Driven at `nextDue` with nothing else changing, the lane changes durable state or comes to rest. Fifty
 *    wakes in a row that change nothing are a tight loop (the due time is not in the future) or an endless poll (the
 *    due time is "now + n" and thirty more days end nothing).
 *
 * Each lane's `drive` and `nextDue` copy the lane's stage in `Coordinator.onJob` (`src/worker/index.ts`), because the
 * `Assistant` Durable Object cannot be built in a unit test. The stage name is given at each copy. A violation the
 * simulation found is reduced to a named test below its lane. The seven found so far are fixed, and their tests pass.
 * A new one that cannot be fixed at once is marked `todo` and listed in the lane's `known` list, so that the
 * simulation steps over it and still reports any other violation.
 */

const iso = (at: number) => new Date(at).toISOString();
const SESSION = "owner-telegram";
function ownerStore(sqlite: Sqlite): Store {
  const store = new Store(sqlite.db);
  store.setSession("control", "owner-control");
  store.setSession("telegram", SESSION);
  return store;
}
const ids = (sqlite: Sqlite, query: string) => sqlite.db.all<{ id: string; status: string }>(query);
/** One element of a list, or nothing when the list is empty. */
const any = <T>(random: Random, list: readonly T[]): T | undefined => list.length ? random.pick(list) : undefined;
const earliest = (...times: (number | undefined)[]): number | undefined => {
  const finite = times.filter((time): time is number => time !== undefined);
  return finite.length ? Math.min(...finite) : undefined;
};

// ---------------------------------------------------------------------------------------------------------------
// Reminders and knock pushes: stages "reminders" and "knock-push".
// ---------------------------------------------------------------------------------------------------------------

interface ReminderWorld { sqlite: Sqlite; store: Store; pushes: KnockPushStore; phone: { paired: boolean; accepts: boolean }; made: number }
function wireReminders(world: ReminderWorld): void {
  world.store = ownerStore(world.sqlite);
  world.pushes = new KnockPushStore(world.sqlite.db);
  // As in the `Assistant` constructor: a reminder the phone has not set is knocked by push, when a phone can take alerts.
  world.store.knockFallback = reminder => { if (!world.phone.paired) return false; world.pushes.queue(reminder); return true; };
}
const REMINDER_TEXTS = ["Water the fig tree", "Send the invoice draft", "Stretch for five minutes", "Call the bike shop"];
const scheduled = (world: ReminderWorld) => world.store.reminders().filter(reminder => reminder.status === "scheduled");
const reminders: Lane<ReminderWorld> = {
  name: "reminders and knock pushes",
  open(sqlite) { const world = { sqlite, phone: { paired: false, accepts: true }, made: 0 } as ReminderWorld; wireReminders(world); return world; },
  restart(world) { wireReminders(world); },
  drive(world, clock) {
    world.store.fireReminders(clock.now());
    // Stage "knock-push": an answered, changed, or cancelled reminder stops knocking.
    const knock = world.pushes.next();
    if (!knock) return;
    const reminder = world.store.reminder(knock.reminderId);
    if (!reminder || reminder.version !== knock.version || reminder.answer || reminder.status !== "fired") world.pushes.finish(knock.id, "skipped");
    else world.pushes.finish(knock.id, world.phone.paired && world.phone.accepts ? "sent" : "failed");
  },
  nextDue: world => earliest(world.store.nextReminder(), world.pushes.nextDue()),
  items: world => [
    ...scheduled(world).map(reminder => ({ id: reminder.id, state: "reminder:scheduled" })),
    ...ids(world.sqlite, "SELECT id, status FROM umpi_knock_push WHERE status='pending'").map(row => ({ id: row.id, state: "knock-push:pending" })),
  ],
  fingerprint: world => tables(world.sqlite.sqlite, ["umpi_reminders", "umpi_knock_push", "umpi_phone_knocks"]),
  // Every open state has a time: a scheduled reminder its due time, a pending push its `at`.
  waiting: {},
  actions: [
    { name: "owner sets a reminder", weight: 3, run(world, random, clock) {
      world.store.createReminder(`reminder-${++world.made}`, random.pick(REMINDER_TEXTS), iso(clock.now() + random.pick([30 * SECOND, 5 * MINUTE, 2 * HOUR, 30 * HOUR])), "telegram", random.pick(["knock", "gentle"] as const));
    } },
    { name: "owner moves a reminder", run(world, random, clock) {
      const reminder = any(random, scheduled(world));
      if (reminder) world.store.updateReminder(reminder.id, reminder.version, reminder.text, iso(clock.now() + random.pick([MINUTE, 3 * HOUR])));
    } },
    { name: "owner cancels a reminder", run(world, random) {
      const reminder = any(random, scheduled(world));
      if (reminder) world.store.cancelReminder(reminder.id, reminder.version);
    } },
    { name: "the phone confirms the knocks it set", run(world) {
      world.store.recordPhoneKnocks("phone-1", { scheduled: scheduled(world).map(reminder => ({ id: reminder.id, version: reminder.version })) });
    } },
    { name: "owner answers a knock on the phone", weight: 2, run(world, random, clock) {
      const reminder = any(random, world.store.reminders());
      if (reminder) world.store.answerPhoneKnock(reminder.id, { version: reminder.version, action: random.pick(["done", "snooze", "later"]) }, 10, clock.now());
    } },
    { name: "a phone is paired", run(world) { world.phone.paired = true; } },
    { name: "the phone is unpaired", run(world) { world.phone.paired = false; } },
    { name: "push delivery breaks", run(world) { world.phone.accepts = false; } },
    { name: "push delivery works again", run(world) { world.phone.accepts = true; } },
  ],
};
test("liveness: reminders and knock pushes", async t => { await simulate(t, reminders, { sequences: 300 }); });

// ---------------------------------------------------------------------------------------------------------------
// The outbox: stage "telegram-delivery". Proactive holds are in the proactive lane.
// ---------------------------------------------------------------------------------------------------------------

interface OutboxWorld { sqlite: Sqlite; store: Store; telegram: { enabled: boolean; result: "sent" | "failed" | "uncertain" }; made: number; messageId: number }
const OUTBOX_BEHIND = "delivery:pending behind a part that was not sent";
const OUTBOX_DEFECT = "outbox: when a part of a message fails, its later parts are cancelled with a reason and do not stay pending";
function driveOutbox(world: OutboxWorld): void {
  // Telegram turned off: nothing is sent there. One bounded external send per drive otherwise.
  if (!world.telegram.enabled) {
    for (const ready of world.store.readyDeliveries()) world.store.discardDeliveryGroup(ready.groupId, "Telegram is turned off; this message is in the app's chat.");
    return;
  }
  const next = world.store.readyDeliveries()[0], delivery = next && world.store.beginDelivery(next.id);
  if (delivery) world.store.finishDelivery(delivery.id, world.telegram.result, world.telegram.result === "sent" ? undefined : "Telegram did not confirm the send", world.telegram.result === "sent" ? ++world.messageId : undefined);
}
function restartOutbox(world: OutboxWorld): void { world.store = ownerStore(world.sqlite); world.store.recoverDeliveries(); }
const outbox: Lane<OutboxWorld> = {
  name: "outbox",
  open(sqlite) { return { sqlite, store: ownerStore(sqlite), telegram: { enabled: true, result: "sent" }, made: 0, messageId: 0 }; },
  restart: restartOutbox,
  drive: driveOutbox,
  nextDue: (world, clock) => world.telegram.enabled && world.store.readyDeliveries().length ? clock.now() + 100 : undefined,
  items(world) {
    const rows = world.sqlite.db.all<{ id: string; group_id: string; part: number; status: string }>("SELECT id, group_id, part, status FROM umpi_outbox ORDER BY group_id, part");
    return rows.filter(row => ["pending", "held", "sending"].includes(row.status)).map(row => {
      const blocked = rows.some(other => other.group_id === row.group_id && other.part < row.part && ["failed", "uncertain", "cancelled"].includes(other.status));
      return { id: row.id, state: blocked ? OUTBOX_BEHIND : `delivery:${row.status}` };
    });
  },
  fingerprint: world => tables(world.sqlite.sqlite, ["umpi_outbox"]),
  waiting: {},
  actions: [
    // Every producer of a message also wakes the coordinator, so each enqueue is followed by one drive.
    { name: "a short message is queued", weight: 3, run(world) { world.store.enqueue(`notice:${++world.made}`, "telegram", "The export finished without errors."); driveOutbox(world); } },
    { name: "a message of three parts is queued", weight: 2, run(world) { world.store.enqueue(`notice:${++world.made}`, "telegram", "Line of a long report. ".repeat(450)); driveOutbox(world); } },
    { name: "Telegram refuses sends", run(world) { world.telegram.result = "failed"; } },
    { name: "Telegram answers without confirming", run(world) { world.telegram.result = "uncertain"; } },
    { name: "Telegram accepts sends", weight: 2, run(world) { world.telegram.result = "sent"; } },
    { name: "the coordinator stops during a send", run(world) {
      const next = world.store.readyDeliveries()[0];
      if (!next || !world.telegram.enabled) return;
      world.store.beginDelivery(next.id);
      restartOutbox(world); driveOutbox(world);
    } },
    { name: "a deploy turns Telegram off or on", run(world) { world.telegram.enabled = !world.telegram.enabled; restartOutbox(world); driveOutbox(world); } },
  ],
};
test("liveness: outbox", async t => { await simulate(t, outbox, { sequences: 300 }); });
test(OUTBOX_DEFECT, async t => {
  for (const result of ["failed", "uncertain"] as const) {
    const violation = await scenario(t, outbox, world => {
      world.telegram.result = result;
      world.store.enqueue("notice:long", "telegram", "Line of a long report. ".repeat(450));
      driveOutbox(world);
      const parts = world.store.deliveries("notice:long");
      assert.deepEqual(parts.map(delivery => delivery.status), [result, "cancelled", "cancelled"]);
      assert.match(parts[1]!.error!, /part 1 of this message was not confirmed/);
    });
    assert.equal(violation, undefined, violation?.detail);
  }
});
test("outbox: a send interrupted by a restart becomes uncertain and closes the parts behind it", async t => {
  const violation = await scenario(t, outbox, world => {
    world.store.enqueue("notice:long", "telegram", "Line of a long report. ".repeat(450));
    world.store.beginDelivery(world.store.readyDeliveries()[0]!.id);
    restartOutbox(world);
    assert.deepEqual(world.store.deliveries("notice:long").map(delivery => delivery.status), ["uncertain", "cancelled", "cancelled"]);
  });
  assert.equal(violation, undefined, violation?.detail);
});

// ---------------------------------------------------------------------------------------------------------------
// Mac jobs: stage "executor" (`Assistant.driveExecutor`). Its `due` here is
// `executorPresence.nextDue(store.executors(), knocks.nextDue())`: the knock time or the offline notice time.
// ---------------------------------------------------------------------------------------------------------------

interface JobWorld { sqlite: Sqlite; store: Store; presence: ExecutorPresence; knocks: KnockStore; mac: { present: boolean }; made: number }
const WORKSPACE = "/workspace/app";
const MAC_DEFECT = "Mac jobs: a job whose Mac went away gets the offline notice from the stage's own wake, one day after the Mac was last seen";
function wireJobs(world: JobWorld): void {
  world.store = ownerStore(world.sqlite);
  world.presence = new ExecutorPresence(world.sqlite.db);
  world.knocks = new KnockStore(world.sqlite.db);
}
function pollSeenAt(store: Store): number | null {
  const times = (store.executors() as { lastSeenAt?: string }[]).map(executor => Date.parse(executor.lastSeenAt ?? "")).filter(Number.isFinite);
  return times.length ? Math.max(...times) : null;
}
/** Where the Mac is, as the owner can know it: present, never set up, away without a notice, or away with the notice sent. */
function macState(world: JobWorld): string {
  if (world.mac.present) return "mac-present";
  const lastSeen = world.presence.lastSeen(pollSeenAt(world.store));
  if (lastSeen === null) return "mac-never-seen";
  return world.store.deliveries(`notice:executor-offline:${lastSeen}`).length ? "mac-away-noticed" : "mac-away";
}
function driveJobs(world: JobWorld, clock: Clock): void {
  // `driveExecutor`: tells the owner once when the Mac has been away for a day. The wake socket is a boolean here.
  const notice = world.presence.offlineNotice(world.mac.present, pollSeenAt(world.store), clock.now());
  if (notice) world.store.enqueue(notice.id, "telegram", "Your Mac's Umpi executor has not connected for a day. Mac jobs, coding and browser tasks, and Aside context wait until it is back.");
}
const openJobs = (world: JobWorld) => world.store.jobs().filter(job => ["pending_approval", "queued", "running"].includes(job.status));
const MAC_WORKS = "The Mac is connected and polls; `/api/status` lists the job as queued or running with the executor online (`ExecutorPresence.status`).";
const MAC_NOTICED = "index.ts `driveExecutor`: \"Your Mac's Umpi executor has not connected since …. Mac jobs, coding and browser tasks, and Aside context wait until it is back.\"";
const MAC_NEVER = "executor-presence.ts `offlineNotice`: \"One notice per offline period, only for an executor that has connected before.\" `/api/status` shows no executor.";
const jobs: Lane<JobWorld> = {
  name: "Mac jobs",
  open(sqlite) { const world = { sqlite, mac: { present: false }, made: 0 } as JobWorld; wireJobs(world); return world; },
  restart: wireJobs,
  drive: driveJobs,
  nextDue: world => world.presence.nextDue(world.store.executors(), world.knocks.nextDue()),
  items: world => openJobs(world).map(job => ({ id: job.jobId, state: job.status === "pending_approval" ? "pending_approval" : `${job.status}${job.cancelRequested ? "+cancel" : ""}:${macState(world)}` })),
  // The presence record is left out: while the Mac stays connected it is marked once a day, which is bookkeeping, not progress.
  fingerprint: world => tables(world.sqlite.sqlite, ["umpi_jobs", "umpi_outbox"]),
  waiting: {
    pending_approval: {
      evidence: "assistant-runtime.md: \"Every new or edited Mac command starts as `pending_approval`.\" store.ts `notifyApproval` posts the card with Approve and Cancel.",
      shown: (world, item) => { const job = world.store.job(item.id)!; return world.store.deliveries(`approval:${job.jobId}:${job.version}`).length > 0; },
    },
    "queued:mac-present": { evidence: MAC_WORKS },
    "running:mac-present": { evidence: MAC_WORKS },
    "running+cancel:mac-present": { evidence: "store.ts `resolveTelegramCallback`: \"Cancellation requested. Waiting for the Mac to confirm.\"" },
    "queued:mac-never-seen": { evidence: MAC_NEVER },
    "queued:mac-away-noticed": { evidence: MAC_NOTICED },
    "running:mac-away-noticed": { evidence: MAC_NOTICED },
    "running+cancel:mac-away-noticed": { evidence: MAC_NOTICED },
  },
  actions: [
    { name: "owner asks for a Mac command", weight: 3, run(world, _random, clock) {
      world.store.createJob({ jobId: `job-${++world.made}`, command: "printf done", cwd: WORKSPACE, timeoutMs: 10_000, createdAt: iso(clock.now()) }, "telegram", SESSION);
    } },
    { name: "owner approves a job", weight: 3, run(world, random) {
      const job = any(random, openJobs(world).filter(job => job.status === "pending_approval"));
      if (job) world.store.approveJob(job.jobId, job.version);
    } },
    { name: "owner cancels a job", run(world, random) { const job = any(random, openJobs(world)); if (job) world.store.cancelJob(job.jobId, job.version); } },
    { name: "owner edits a job", run(world, random) {
      const job = any(random, openJobs(world));
      if (job) world.store.updateJob(job.jobId, job.version, { command: "printf changed", cwd: WORKSPACE, timeoutMs: 20_000 });
    } },
    { name: "the Mac connects", weight: 2, run(world, _random, clock) { world.mac.present = true; world.presence.connected(clock.now()); } },
    { name: "the Mac polls", weight: 3, run(world) { if (world.mac.present) world.store.poll({ executorId: "mac-1", workspaces: [WORKSPACE] }); } },
    { name: "the Mac reports a job's end", weight: 2, run(world, random, clock) {
      const job = world.mac.present ? openJobs(world).find(job => job.status === "running" && job.executorId === "mac-1") : undefined;
      if (!job) return;
      const status = job.cancelRequested ? "cancelled" : random.pick(["succeeded", "failed", "uncertain"]);
      world.store.complete({ executorId: "mac-1", jobId: job.jobId, status, exitCode: status === "succeeded" ? 0 : status === "failed" ? 1 : null, output: "", truncated: false, finishedAt: iso(clock.now()) });
    } },
    { name: "the Mac goes to sleep", weight: 2, run(world, _random, clock) { if (world.mac.present) { world.mac.present = false; world.presence.disconnected(clock.now()); } } },
  ],
};
test("liveness: Mac jobs", async t => { await simulate(t, jobs, { sequences: 300, maxSteps: 20 }); });
test(MAC_DEFECT, async t => {
  const violation = await scenario(t, jobs, (world, clock) => {
    world.mac.present = true; world.presence.connected(clock.now());
    world.store.poll({ executorId: "mac-1", workspaces: [WORKSPACE] });
    const job = world.store.createJob({ jobId: "job-1", command: "printf done", cwd: WORKSPACE, timeoutMs: 10_000, createdAt: iso(clock.now()) }, "telegram", SESSION);
    world.store.approveJob(job.jobId, job.version);
    world.store.poll({ executorId: "mac-1", workspaces: [WORKSPACE] });
    assert.equal(world.store.job("job-1")!.status, "running");
    const left = clock.now();
    world.mac.present = false; world.presence.disconnected(left);
    driveJobs(world, clock);
    assert.equal(jobs.nextDue(world, clock), left + EXECUTOR_OFFLINE_NOTICE_MS, "the stage asks to be woken when the notice is due");
    clock.advance(EXECUTOR_OFFLINE_NOTICE_MS);
    driveJobs(world, clock);
    assert.equal(world.store.deliveries(`notice:executor-offline:${left}`).length, 1, "the notice is sent at that wake");
    assert.equal(jobs.nextDue(world, clock), undefined, "one notice per absence; nothing more to wake for");
  });
  assert.equal(violation, undefined, violation?.detail);
});
test("executor presence: the notice time follows the last poll, and a Mac that stays connected costs one wake a day", async t => {
  await scenario(t, jobs, (world, clock) => {
    assert.equal(world.presence.nextDue([]), undefined, "an executor that never connected gets no notice and no wake");
    assert.equal(world.presence.nextDue([], 5), 5, "the other time passes through");
    const start = clock.now();
    world.mac.present = true; world.presence.connected(start);
    assert.equal(world.presence.nextDue([]), start + EXECUTOR_OFFLINE_NOTICE_MS);
    assert.equal(world.presence.nextDue([], start + MINUTE), start + MINUTE, "the earlier time wins");
    clock.advance(HOUR);
    assert.equal(world.presence.nextDue([{ lastSeenAt: iso(clock.now()) }]), clock.now() + EXECUTOR_OFFLINE_NOTICE_MS, "a poll is evidence of presence");
    // A day later the socket is still live: no notice, and the next check is a day on, not now.
    clock.advance(EXECUTOR_OFFLINE_NOTICE_MS);
    assert.equal(world.presence.offlineNotice(true, null, clock.now()), undefined);
    assert.equal(world.presence.nextDue([]), clock.now() + EXECUTOR_OFFLINE_NOTICE_MS);
    // The socket then dies without a close event: the recorded time still leads to the notice.
    clock.advance(EXECUTOR_OFFLINE_NOTICE_MS);
    assert.ok(world.presence.offlineNotice(false, null, clock.now()));
    assert.equal(world.presence.nextDue([]), undefined);
  });
});
// ---------------------------------------------------------------------------------------------------------------
// Mac knocks: `KnockStore`. No stage drives it; its `nextDue` is part of the `due` of stage "executor", and settles
// stale knocks and abandoned claims itself.
// The lane is idle today: nothing calls `KnockStore.add` (`Store.reminderFired` is not set in `index.ts`).
// ---------------------------------------------------------------------------------------------------------------

interface KnockWorld { sqlite: Sqlite; knocks: KnockStore; claimed: { id: string; attempt: number }[]; made: number }
const KNOCK_DEFECT = "Mac knocks: an open knock that the Mac never polls expires at its time, and nextDue is never in the past";
const knocks: Lane<KnockWorld> = {
  name: "Mac knocks",
  open(sqlite) { return { sqlite, knocks: new KnockStore(sqlite.db), claimed: [], made: 0 }; },
  restart(world) { world.knocks = new KnockStore(world.sqlite.db); },
  // Stage "executor" wakes the Mac's socket and never settles a knock; only the Mac's poll does.
  drive() {},
  nextDue: world => world.knocks.nextDue(),
  items: world => ids(world.sqlite, "SELECT id, status FROM umpi_knocks WHERE status IN ('pending','claimed')").map(row => ({ id: row.id, state: `knock:${row.status}` })),
  fingerprint: world => tables(world.sqlite.sqlite, ["umpi_knocks"]),
  waiting: {},
  actions: [
    { name: "a reminder asks the Mac to knock", weight: 2, run(world, random) { world.knocks.add({ id: `reminder-${++world.made}`, version: 1, text: random.pick(REMINDER_TEXTS), intensity: random.pick(["knock", "gentle"] as const) }); } },
    { name: "the Mac polls for knocks", weight: 2, run(world) { world.claimed.push(...world.knocks.poll({ executorId: "mac-1" }).knocks); } },
    { name: "the Mac reports the owner's answer", weight: 2, run(world, random) {
      const claim = world.claimed.shift();
      if (claim) world.knocks.report({ executorId: "mac-1", id: claim.id, attempt: claim.attempt, outcome: random.pick(["done", "snoozed", "missed", "away"]) });
    } },
  ],
};
test("liveness: Mac knocks", async t => { await simulate(t, knocks, { sequences: 200 }); });
test(KNOCK_DEFECT, async t => {
  const violation = await scenario(t, knocks, (world, clock) => {
    world.knocks.add({ id: "reminder-1", version: 1, text: "Water the fig tree" });
    assert.equal(world.knocks.nextDue(), clock.now() + KNOCK_EXPIRY_MS, "a knock that waits for the Mac's poll is next looked at when it expires");
    clock.advance(KNOCK_EXPIRY_MS);
    assert.equal(world.knocks.nextDue(), undefined);
    assert.equal(world.knocks.get("reminder-1:1")!.status, "expired");
  });
  assert.equal(violation, undefined, violation?.detail);
});
test("Mac knocks: a claim the Mac abandons becomes a later attempt without a poll", async t => {
  const violation = await scenario(t, knocks, (world, clock) => {
    world.knocks.add({ id: "reminder-1", version: 1, text: "Water the fig tree" });
    world.knocks.poll({ executorId: "mac-1" });
    assert.equal(world.knocks.nextDue(), clock.now() + KNOCK_CLAIM_MS);
    clock.advance(KNOCK_CLAIM_MS);
    assert.equal(world.knocks.nextDue(), clock.now() + KNOCK_RETRY_MS, "the second attempt has its own time");
    assert.deepEqual({ status: world.knocks.get("reminder-1:1")!.status, attempt: world.knocks.get("reminder-1:1")!.attempt }, { status: "pending", attempt: 2 });
  });
  assert.equal(violation, undefined, violation?.detail);
});

// ---------------------------------------------------------------------------------------------------------------
// Proactive commitments, wakeups, and reviews: stage "proactive", with the two outbox stages that release its notices.
// ---------------------------------------------------------------------------------------------------------------

interface ProactiveWorld { sqlite: Sqlite; store: Store; proactive: ProactiveStore; made: number; messageId: number }
const BACKGROUND = { control: "background-control", telegram: "background-telegram" } as const;
function wireProactive(world: ProactiveWorld): void {
  world.store = ownerStore(world.sqlite);
  world.store.registerBackgroundSession(BACKGROUND.control, "control");
  world.store.registerBackgroundSession(BACKGROUND.telegram, "telegram");
  world.proactive = new ProactiveStore(world.store, "UTC");
}
const backgroundTurns = (world: ProactiveWorld) => world.store.pendingOperations().filter(op => op.background);
function driveProactive(world: ProactiveWorld, clock: Clock): void {
  const { store, proactive } = world, now = clock.now();
  proactive.drive(now, store.hasForegroundInput(), BACKGROUND);
  // `Coordinator.driveOperation`: a review that is no longer current is ended; a submitted turn is aborted and then fails.
  for (const op of backgroundTurns(world)) {
    const run = proactive.run(op.background!.runId);
    if (!run || !proactive.settings().enabled || run.status === "superseded" || run.status === "expired") store.settle(op.id, "Background review is no longer actionable.", true);
  }
  // Stage "delivery-holds".
  for (const groupId of store.pendingDeliveryGroups("proactive:")) {
    const state = proactive.notificationDeliveryState(groupId, now);
    if (state === "drop") store.discardDeliveryGroup(groupId, "This proactive update is no longer relevant or permitted.");
    else store.holdDeliveryGroup(groupId, state === "deferred");
  }
  // Stage "telegram-delivery": Telegram accepts every message in this lane.
  const next = store.readyDeliveries()[0], delivery = next && store.beginDelivery(next.id);
  if (delivery) store.finishDelivery(delivery.id, "sent", undefined, ++world.messageId);
}
const liveCommitments = (world: ProactiveWorld) => world.proactive.commitments().filter(commitment => commitment.status === "active" || commitment.status === "blocked");
const liveWakes = (world: ProactiveWorld) => world.proactive.wakeups().filter(wake => wake.status === "scheduled" || wake.status === "running");
const PAUSED = "assistant-runtime.md: \"Scheduler settings start paused. `/schedule` offers owner-only native Enable/Pause controls; `/status` includes a compact summary. … Pausing retains responsibilities and stops proactive runs/notifications\". The owner paused it; only the owner resumes it.";
const proactive: Lane<ProactiveWorld> = {
  name: "proactive commitments and reviews",
  open(sqlite) { const world = { sqlite, made: 0, messageId: 0 } as ProactiveWorld; wireProactive(world); return world; },
  restart: wireProactive,
  drive: driveProactive,
  nextDue: (world, clock) => earliest(world.proactive.nextDue(clock.now(), world.store.hasForegroundInput()), world.store.readyDeliveries().length ? clock.now() + 100 : undefined),
  items(world) {
    const paused = world.proactive.settings().enabled ? "" : ":paused";
    const status = world.proactive.status();
    return [
      ...liveCommitments(world).map(commitment => ({ id: commitment.id, state: `commitment:${commitment.status}${paused}` })),
      ...liveWakes(world).map(wake => ({ id: wake.id, state: `wakeup:${wake.status}${paused}` })),
      ...status.runs.filter(run => run.status === "admitted").map(run => ({ id: run.id, state: `review:admitted${paused}` })),
      ...status.runs.filter(run => run.notification?.status === "deferred").map(run => ({ id: `${run.id}:notice`, state: `notice:deferred${paused}` })),
      ...world.store.pendingDeliveryGroups("proactive:").map(id => ({ id, state: `notice:in-outbox${paused}` })),
    ];
  },
  // The heartbeat's own bookkeeping (`umpi_proactive_meta`) is left out, so a heartbeat that finds nothing is not progress.
  fingerprint: world => tables(world.sqlite.sqlite, ["umpi_commitments", "umpi_wakeups", "umpi_proactive_runs", "umpi_outbox", "umpi_operations"]),
  waiting: {
    "commitment:active:paused": { evidence: PAUSED }, "commitment:blocked:paused": { evidence: PAUSED },
    "wakeup:scheduled:paused": { evidence: PAUSED }, "wakeup:running:paused": { evidence: PAUSED },
    "review:admitted:paused": { evidence: PAUSED }, "notice:deferred:paused": { evidence: PAUSED }, "notice:in-outbox:paused": { evidence: PAUSED },
  },
  polls: [{
    everyAtLeastMs: MINUTE,
    // A turn of the operations lane (not covered here) is in the way: the owner's own message, or a submitted review turn.
    when: world => world.store.pendingOperations().length > 0,
    evidence: "proactive-store.ts `nextDue`: \"Every blocked or just-attempted due item gets a one-minute floor, never an alarm hot loop.\"",
  }],
  actions: [
    { name: "owner turns follow-through on", weight: 3, run(world, random, clock) {
      world.proactive.configure({ expectedVersion: world.proactive.settings().version, enabled: true, quietHours: random.pick([null, null, { start: "22:00", end: "07:00" }, { start: "07:30", end: "09:00" }]) }, clock.now());
    } },
    { name: "owner pauses follow-through", run(world, _random, clock) { world.proactive.configure({ expectedVersion: world.proactive.settings().version, enabled: false, quietHours: null }, clock.now()); } },
    { name: "owner adds a responsibility", weight: 3, run(world, random, clock) {
      world.proactive.createCommitment({ id: `commitment-${++world.made}`, purpose: "Follow the greenhouse sensor export", source: "Owner asked to hear when the export is ready", nextAction: "Read the recorded export result",
        blocker: null, status: "active", nextReviewAt: random.pick([null, iso(clock.now() + 10 * MINUTE), iso(clock.now() + 3 * HOUR)]), jobId: null, allowNotify: random.chance(0.6),
        ...(random.chance(0.4) ? { retry: { everyMinutes: 15, maxAttempts: 2 } } : {}) }, "telegram", SESSION, clock.now());
    } },
    { name: "owner edits a responsibility", run(world, random, clock) {
      const commitment = any(random, liveCommitments(world));
      if (!commitment) return;
      const status = random.pick(["active", "blocked", "completed", "cancelled"]), finished = status === "completed" || status === "cancelled";
      world.proactive.updateCommitment(commitment.id, { expectedVersion: commitment.version, purpose: commitment.purpose, source: commitment.source, nextAction: commitment.nextAction, blocker: commitment.blocker,
        status, nextReviewAt: finished ? null : random.pick([null, iso(clock.now() + 20 * MINUTE)]), jobId: null }, clock.now());
    } },
    { name: "a wakeup is scheduled", weight: 2, run(world, random, clock) {
      const commitment = any(random, liveCommitments(world));
      if (!commitment) return;
      const due = clock.now() + random.pick([MINUTE, 40 * MINUTE, 6 * HOUR]);
      world.proactive.scheduleWakeup({ id: `wake-${++world.made}`, commitmentId: commitment.id, purpose: commitment.purpose, dueAt: iso(due), expiresAt: iso(due + random.pick([10 * MINUTE, 2 * HOUR])), repeatEveryMinutes: random.pick([null, 15, 1_440]) }, clock.now());
    } },
    { name: "a wakeup is cancelled", run(world, random, clock) { const wake = any(random, liveWakes(world)); if (wake) world.proactive.cancelWakeup(wake.id, wake.version, clock.now()); } },
    { name: "a subsystem reports an event", run(world, random, clock) { const commitment = any(random, liveCommitments(world)); if (commitment) world.proactive.triggerEvent(commitment.id, clock.now()); } },
    { name: "the coordinator submits the review turn", weight: 2, run(world) { const op = backgroundTurns(world).find(op => op.status === "admitted"); if (op) world.store.submitted(op.id); } },
    { name: "the review reports its outcome", weight: 3, run(world, random, clock) {
      const op = backgroundTurns(world)[0];
      if (!op) return;
      const outcome = random.pick(["advanced", "blocked", "deferred", "no_action", "completed"]);
      try {
        world.proactive.report(op.sessionId, { outcome, note: "Read the recorded result; nothing else was changed.", ...(outcome === "completed" ? {} : { nextReviewAt: random.pick([null, iso(clock.now() + HOUR)]) }),
          ...(random.chance(0.5) ? { notification: `The export is ready (${world.made}).` } : {}) }, clock.now());
      } finally { world.store.settle(op.id, ""); }
    } },
    { name: "the review turn ends without a report", run(world) { const op = backgroundTurns(world)[0]; if (op) world.store.settle(op.id, "Looked at the export."); } },
    { name: "the review turn fails", run(world) { const op = backgroundTurns(world)[0]; if (op) world.store.settle(op.id, "The provider refused the request.", true); } },
    { name: "owner sends a message", run(world) { world.store.admit(`message-${++world.made}`, "Is the export ready?", "telegram", SESSION); } },
    { name: "the owner's message is answered", weight: 2, run(world) { const op = world.store.pendingOperations().find(op => !op.background); if (op) world.store.settle(op.id, ""); } },
  ],
};
test("liveness: proactive commitments and reviews", async t => { await simulate(t, proactive, { sequences: 80, maxSteps: 20 }); });

// ---------------------------------------------------------------------------------------------------------------
// Coding tasks on the Mac: stage "coding" (`CodingRuntime.drive` and `nextDue`). The model is a fake Pi harness.
// Cloud runs, file and command operations, and artifact retention are not simulated.
// ---------------------------------------------------------------------------------------------------------------

/** A model conversation that accepts every turn and ends one only when the simulation says so. */
interface FakeModel { ready: boolean; sessions: number; waits: Map<string, (answer: { status: "done" }) => void> }
function fakeHarness(model: FakeModel) {
  return {
    sessions: { create: async () => ({ id: `task-session-${++model.sessions}` }) },
    conversation: async () => ({ configure: async () => undefined }),
    submit: async () => undefined,
    abort: async () => undefined,
    // The runtime follows a turn for 20 seconds and then lets go; its abort signal ends this promise.
    wait: (operationId: string, options: { signal: AbortSignal }) => new Promise<{ status: "done" }>((resolve, reject) => {
      model.waits.set(operationId, resolve);
      options.signal.addEventListener("abort", () => reject(new Error("The wait was given up")), { once: true });
    }),
  };
}
function endModelTurns(model: FakeModel): void {
  const waits = [...model.waits.values()];
  model.waits.clear();
  for (const end of waits) end({ status: "done" });
}
interface Run { taskId: string; runId: string }
interface CodingWorld { sqlite: Sqlite; store: Store; coding: CodingStore; runtime: CodingRuntime; model: FakeModel; mac: { present: boolean; run?: Run }; made: number }
const CODING_POLL = { executorId: "mac-1", workspaces: [WORKSPACE] };
const CODING_DEFECT = "coding: a task that waits for an absent Mac to confirm its stop is not polled; it wakes once, at its deadline";
function wireCoding(world: CodingWorld): void {
  world.store = ownerStore(world.sqlite);
  world.coding = new CodingStore(world.store);
  // A restart drops the waits of the old instance; the new one waits again.
  world.model.waits.clear();
  const host: CodingRuntimeHost = {
    harness: () => fakeHarness(world.model) as unknown as ReturnType<CodingRuntimeHost["harness"]>,
    extension: () => ({}) as ReturnType<CodingRuntimeHost["extension"]>,
    archive: () => undefined, cloud: () => undefined, cloudAvailable: () => false,
    modelReady: async () => world.model.ready, wake: async () => undefined, track: () => undefined,
  };
  world.runtime = new CodingRuntime(world.coding, host);
}
const CODING_OPEN = ["pending_approval", "queued", "preparing", "running", "finishing", "cancel_requested"];
const openCoding = (world: CodingWorld) => world.coding.tasks().filter(task => CODING_OPEN.includes(task.status) || task.status === "uncertain" && !task.run?.reconciledAt);
const CODING_UNCERTAIN = "coding-store.ts `feedback` admits a result turn for the owner: \"Uncertain effects must not be repeated or transferred.\" `stopped`: \"owner reconciliation is required\".";
const codingLane: Lane<CodingWorld> = {
  name: "coding tasks (Mac)",
  timers: true,
  open(sqlite) {
    const world = { sqlite, model: { ready: true, sessions: 0, waits: new Map() }, mac: { present: true }, made: 0 } as CodingWorld;
    wireCoding(world);
    // The Mac has advertised its workspace once; a task can only name an advertised workspace.
    world.coding.poll({ ...CODING_POLL, available: true, activeRunId: null });
    return world;
  },
  restart: wireCoding,
  async drive(world) { await world.runtime.drive(); },
  nextDue: world => world.runtime.nextDue(),
  items: world => openCoding(world).map(task => ({ id: task.taskId, state: task.status })),
  fingerprint: world => tables(world.sqlite.sqlite, ["umpi_coding_tasks", "umpi_coding_values", "umpi_coding_inputs"]),
  waiting: {
    pending_approval: { evidence: "assistant-runtime.md: \"Approval binds the current version, task prompt, exact canonical source cwd, and a deadline of at most one hour.\" coding-telegram.ts posts the card with Approve; `/code` lists the task." },
    // The missing wake for the Mac's offline notice is the Mac jobs lane's defect; it is not counted again here.
    queued: { evidence: "assistant-runtime.md: \"An offline Mac leaves unclaimed work queued.\" `CodingRuntime.status` and `/code` show the task as queued." },
    cancel_requested: {
      evidence: "coding-store.ts `cancel` and `expire` set the issue: \"Cancellation requested; waiting for the execution owner\", \"Coding time limit reached; waiting for the execution owner to confirm stop\". coding-telegram.ts answers the button: \"Stop requested. Existing changes remain; waiting for confirmed stop.\" After a day the Mac's offline notice is sent (Mac jobs lane).",
      shown: (world, item) => Boolean(world.coding.requireTask(item.id).issue),
    },
    uncertain: { evidence: CODING_UNCERTAIN, shown: (world, item) => { const task = world.coding.requireTask(item.id); return world.store.operation(`coding-result:${task.run!.runId}`) !== undefined; } },
  },
  actions: [
    { name: "owner asks for a coding task", weight: 3, run(world, random, clock) {
      world.coding.create({ taskId: `task-${++world.made}`, prompt: "Fix the date parser and run its tests", cwd: WORKSPACE, timeoutMs: random.pick([MINUTE, 10 * MINUTE]) }, "telegram", SESSION, clock.now());
    } },
    { name: "owner approves the task", weight: 3, run(world, random, clock) { const task = any(random, openCoding(world).filter(task => task.status === "pending_approval")); if (task) world.coding.approve(task.taskId, task.version, clock.now()); } },
    { name: "owner corrects the task", run(world, random, clock) { const task = any(random, world.coding.tasks()); if (task) world.coding.correct(task.taskId, task.version, "Also cover the leap-year case.", clock.now()); } },
    { name: "owner cancels the task", run(world, random, clock) { const task = any(random, openCoding(world)); if (task) world.coding.cancel(task.taskId, task.version, clock.now()); } },
    { name: "the Mac polls", weight: 4, run(world, _random, clock) {
      if (!world.mac.present) return;
      const result = world.coding.poll({ ...CODING_POLL, available: !world.mac.run, activeRunId: world.mac.run?.runId ?? null }, clock.now());
      if (result.assignment && !world.mac.run) world.mac.run = { taskId: result.assignment.taskId, runId: result.assignment.runId };
      // Told to stop, the Mac stops and says so.
      if (result.cancel && world.mac.run) { const run = world.mac.run; world.mac.run = undefined; world.coding.stopped(run.taskId, run.runId, false); }
    } },
    { name: "the Mac reports its source copy ready", weight: 3, run(world, _random, clock) { if (world.mac.present && world.mac.run) world.coding.ready(world.mac.run.taskId, world.mac.run.runId, "/private/copies/run", clock.now()); } },
    { name: "the Mac cannot say what its run did", run(world) {
      if (!world.mac.present || !world.mac.run) return;
      const run = world.mac.run; world.mac.run = undefined;
      world.coding.stopped(run.taskId, run.runId, true);
    } },
    { name: "the Mac goes to sleep", weight: 2, run(world) { world.mac.present = false; } },
    { name: "the Mac wakes", run(world) { world.mac.present = true; } },
    { name: "the coding model's turn ends", weight: 2, run(world) { endModelTurns(world.model); } },
    { name: "the coding model asks to finish", weight: 2, run: async (world, random) => {
      const task = any(random, openCoding(world).filter(task => task.status === "running"));
      if (task) await world.runtime.requestFinish(task.taskId, task.run!.runId, { expectedVersion: task.version, outcome: "blocked", summary: "The parser needs a decision on two-digit years.", verificationCommands: [] });
    } },
    { name: "model credentials stop working", run(world) { world.model.ready = false; } },
    { name: "model credentials work again", run(world) { world.model.ready = true; } },
  ],
  settle: () => flush(),
};
test("liveness: coding tasks on the Mac", async t => { await simulate(t, codingLane, { sequences: 200, maxSteps: 24 }); });
test(CODING_DEFECT, async t => {
  const violation = await scenario(t, codingLane, async (world, clock) => {
    const task = world.coding.create({ taskId: "task-1", prompt: "Fix the date parser and run its tests", cwd: WORKSPACE, timeoutMs: 10 * MINUTE }, "telegram", SESSION, clock.now());
    world.coding.approve(task.taskId, task.version, clock.now());
    const assignment = world.coding.poll({ ...CODING_POLL, available: true, activeRunId: null }, clock.now()).assignment!;
    const deadline = Date.parse(assignment.deadlineAt);
    assert.equal(world.runtime.nextDue(), deadline, "a claimed run that is not ready waits for the Mac; the coordinator acts alone only at the deadline");
    world.coding.ready(task.taskId, assignment.runId, "/private/copies/run", clock.now());
    assert.equal(world.runtime.nextDue(), clock.now() + 2_000, "the model turn of a running task is followed");
    // The Mac goes to sleep with the run. The owner cancels; only the Mac can confirm the stop.
    world.mac.present = false;
    world.coding.cancel(task.taskId, world.coding.requireTask(task.taskId).version, clock.now());
    await world.runtime.drive(); await flush();
    assert.equal(world.runtime.nextDue(), deadline, "the stop request is not polled");
    clock.advance(deadline - clock.now());
    await world.runtime.drive(); await flush();
    const waiting = world.coding.requireTask(task.taskId);
    assert.deepEqual({ status: waiting.status, timedOut: waiting.timedOut }, { status: "cancel_requested", timedOut: true });
    assert.match(waiting.issue!, /waiting for the execution owner/);
    assert.equal(world.runtime.nextDue(), undefined, "after the deadline nothing is left for the coordinator; the Mac's report wakes it");
  });
  assert.equal(violation, undefined, violation?.detail);
});

// ---------------------------------------------------------------------------------------------------------------
// Browser tasks on the Mac: stage "browser" (`BrowserRuntime.drive` and `nextDue`). Cloud runs, browser operations,
// and snapshot upkeep are not simulated.
// ---------------------------------------------------------------------------------------------------------------

interface BrowserWorld { sqlite: Sqlite; store: Store; browser: BrowserStore; runtime: BrowserRuntime; model: FakeModel; mac: { present: boolean; run?: Run }; site: { siteId: string; policyDigest: string }; made: number }
const BROWSER_DEFECT = "browser: a task that waits for an absent Mac to confirm its stop is not polled, and its deadline is applied once";
function wireBrowser(world: BrowserWorld): void {
  world.store = ownerStore(world.sqlite);
  world.browser = new BrowserStore(world.store);
  world.model.waits.clear();
  const host: BrowserRuntimeHost = {
    harness: () => fakeHarness(world.model) as unknown as ReturnType<BrowserRuntimeHost["harness"]>,
    extension: () => ({}) as ReturnType<BrowserRuntimeHost["extension"]>,
    cloud: () => undefined, cloudAvailable: () => false,
    modelReady: async () => world.model.ready, wake: async () => undefined, track: () => undefined,
  };
  // No snapshot storage: nothing to prune.
  const snapshots = { nextDue: () => undefined, available: () => false, drivePrune: async () => undefined } as unknown as BrowserSnapshots;
  world.runtime = new BrowserRuntime(world.browser, snapshots, host);
}
const openBrowser = (world: BrowserWorld) => world.browser.tasks().filter(task => CODING_OPEN.includes(task.status) || task.status === "uncertain" && !task.run?.reconciledAt);
const browserLane: Lane<BrowserWorld> = {
  name: "browser tasks (Mac)",
  timers: true,
  open(sqlite) {
    const world = { sqlite, model: { ready: true, sessions: 0, waits: new Map() }, mac: { present: true }, made: 0 } as unknown as BrowserWorld;
    wireBrowser(world);
    world.site = world.browser.registerSite({ siteId: "fixture", title: "Fixture", origins: ["https://example.test"], cookieHosts: [".example.test"], cookieNames: ["session"], resourceHosts: [] }, 0);
    return world;
  },
  restart: wireBrowser,
  async drive(world) { await world.runtime.drive(); },
  nextDue: world => world.runtime.nextDue(),
  items: world => openBrowser(world).map(task => ({ id: task.taskId, state: task.status })),
  // `updatedAt` is left out, so a store that writes an unchanged task again on every drive does not pass for progress.
  fingerprint: world => JSON.stringify(world.browser.tasks().map(({ updatedAt: _updatedAt, ...task }) => task)) + tables(world.sqlite.sqlite, ["umpi_browser_inputs"]),
  waiting: {
    pending_approval: { evidence: "browser-telegram.ts `enqueueBrowserApproval` posts the card with Approve; `/browse` lists the task. browser-store.ts `approve`: \"Only a pending browser task can be approved\"." },
    queued: { evidence: "assistant-runtime.md: \"An offline Mac leaves unclaimed work queued.\" `BrowserRuntime.status` and `/browse` show the task as queued." },
    cancel_requested: {
      evidence: "browser-store.ts `cancel`, `fail`, and `expire` set the issue: \"Browser stop requested; external effects are not rolled back\", \"Approved browser deadline expired; waiting for actual stop\". browser-telegram.ts answers the button: \"Stop requested; waiting for actual browser close.\" After a day the Mac's offline notice is sent (Mac jobs lane).",
      shown: (world, item) => Boolean(world.browser.requireTask(item.id).issue),
    },
    uncertain: { evidence: "browser-store.ts `feedback` admits a result turn for the owner with the status and issue: \"The browser owner cannot confirm an interrupted action; do not repeat it\"." },
  },
  actions: [
    { name: "owner asks for a browser task", weight: 3, run(world) {
      world.browser.create({ taskId: `browse-${++world.made}`, prompt: "Read the opening hours on the approved page", sites: [{ siteId: world.site.siteId, startUrl: "https://example.test/" }], timeoutMs: MINUTE }, "telegram", SESSION);
    } },
    { name: "owner approves the task", weight: 3, run(world, random) { const task = any(random, openBrowser(world).filter(task => task.status === "pending_approval")); if (task) world.browser.approve(task.taskId, task.version); } },
    { name: "owner corrects the task", run(world, random) { const task = any(random, world.browser.tasks()); if (task) world.browser.correct(task.taskId, task.version, "Read the holiday hours as well."); } },
    { name: "owner cancels the task", run(world, random) { const task = any(random, openBrowser(world)); if (task) world.browser.cancel(task.taskId, task.version); } },
    { name: "the Mac polls", weight: 4, run(world) {
      if (!world.mac.present) return;
      const result = world.browser.poll({ executorId: "mac-1", available: !world.mac.run, activeRunId: world.mac.run?.runId ?? null, sites: [world.site] });
      if (result.assignment && !world.mac.run) world.mac.run = { taskId: result.assignment.taskId, runId: result.assignment.runId };
      if (result.cancel && world.mac.run) { const run = world.mac.run; world.mac.run = undefined; world.browser.stopped(run.taskId, run.runId, false); }
    } },
    { name: "the Mac reports its browser ready", weight: 3, run(world) { if (world.mac.present && world.mac.run) world.browser.ready(world.mac.run.taskId, world.mac.run.runId); } },
    { name: "the Mac cannot say what its run did", run(world) {
      if (!world.mac.present || !world.mac.run) return;
      const run = world.mac.run; world.mac.run = undefined;
      world.browser.stopped(run.taskId, run.runId, true);
    } },
    { name: "the Mac goes to sleep", weight: 2, run(world) { world.mac.present = false; } },
    { name: "the Mac wakes", run(world) { world.mac.present = true; } },
    { name: "the browser model's turn ends", weight: 2, run(world) { endModelTurns(world.model); } },
    { name: "the browser model asks to finish", weight: 2, run(world, random) {
      const task = any(random, openBrowser(world).filter(task => task.status === "running"));
      if (task) world.browser.requestFinish(task.taskId, task.run!.runId, { expectedVersion: task.version, outcome: "blocked", observationIds: [], summary: "The page asks for a sign-in the task does not have." });
    } },
    { name: "model credentials stop working", run(world) { world.model.ready = false; } },
    { name: "model credentials work again", run(world) { world.model.ready = true; } },
  ],
  settle: () => flush(),
};
test("liveness: browser tasks on the Mac", async t => { await simulate(t, browserLane, { sequences: 200, maxSteps: 24 }); });
test(BROWSER_DEFECT, async t => {
  const violation = await scenario(t, browserLane, async (world, clock) => {
    const task = world.browser.create({ taskId: "browse-1", prompt: "Read the opening hours on the approved page", sites: [{ siteId: world.site.siteId, startUrl: "https://example.test/" }], timeoutMs: 10 * MINUTE }, "telegram", SESSION);
    world.browser.approve(task.taskId, task.version);
    const assignment = world.browser.poll({ executorId: "mac-1", available: true, activeRunId: null, sites: [world.site] }).assignment!;
    const deadline = Date.parse(assignment.deadlineAt);
    assert.equal(world.runtime.nextDue(), deadline);
    world.browser.ready(task.taskId, assignment.runId);
    assert.equal(world.runtime.nextDue(), clock.now() + 2_000, "the model turn of a running task is followed");
    world.mac.present = false;
    world.browser.cancel(task.taskId, world.browser.requireTask(task.taskId).version);
    await world.runtime.drive(); await flush();
    assert.equal(world.runtime.nextDue(), deadline, "the stop request is not polled");
    clock.advance(deadline - clock.now());
    await world.runtime.drive(); await flush();
    const expired = world.browser.requireTask(task.taskId);
    assert.deepEqual({ status: expired.status, timedOut: expired.timedOut, stopOutcome: expired.stopOutcome }, { status: "cancel_requested", timedOut: true, stopOutcome: "failed" });
    assert.match(expired.issue!, /deadline expired; waiting for actual stop/);
    assert.equal(world.runtime.nextDue(), undefined);
    // Later drives leave the task as it is.
    clock.advance(HOUR);
    await world.runtime.drive(); await flush();
    assert.equal(world.browser.requireTask(task.taskId).updatedAt, expired.updatedAt);
  });
  assert.equal(violation, undefined, violation?.detail);
});

// ---------------------------------------------------------------------------------------------------------------
// The Telegram inbox: stage "telegram-inbox". Downloads, transcription, and admission are fakes that succeed, fail,
// or never answer; the inbox's own deadlines then end the phase.
// ---------------------------------------------------------------------------------------------------------------

type Outside = "works" | "fails" | "hangs";
interface InboxWorld { sqlite: Sqlite; store: Store; inbox: TelegramInbox; download: Outside; transcribe: Outside; deliver: Outside; generation: number; made: number }
const never = <T>() => new Promise<T>(() => undefined);
function wireInbox(world: InboxWorld): void {
  world.store = ownerStore(world.sqlite);
  const generation = ++world.generation;
  // A callback of an instance that was restarted away never answers: its process is gone.
  const outside = async <T>(mode: Outside, value: () => T): Promise<T> => {
    if (generation !== world.generation || mode === "hangs") return never<T>();
    if (mode === "fails") throw new Error("The outside service refused");
    return value();
  };
  world.inbox = new TelegramInbox({
    db: world.sqlite.db,
    download: () => outside(world.download, () => ({ bytes: new Uint8Array([1, 2, 3]), filename: "note.ogg", mimeType: "audio/ogg" })),
    downloadImage: () => outside(world.download, () => ({ data: "AAAA", mimeType: "image/png", bytes: 3 })),
    readFile: () => outside(world.download, () => ({ name: "notes.txt", text: "Three lines about the garden plan.", truncated: false })),
    transcribe: () => outside(world.transcribe, () => "Please check the garden plan."),
    deliver: input => outside(world.deliver, () => `message:telegram:${input.id}`),
    notify: (id, text) => world.store.enqueue(id, "telegram", text),
    wake: async () => undefined, track: () => undefined, foreground: () => undefined,
  });
}
function inboxMessage(world: InboxWorld, random: Random, clock: Clock): TelegramInboxInput {
  const id = `update-${++world.made}`, sentAt = iso(clock.now()), file = { fileId: `file-${world.made}`, fileUniqueId: `unique-${world.made}` };
  return random.pick<() => TelegramInboxInput>([
    () => ({ kind: "message", id, text: "Is the garden plan ready?", sentAt }),
    () => ({ kind: "voice", id, messageId: world.made, ...file, duration: 12, sentAt }),
    () => ({ kind: "image", id, messageId: world.made, sentAt, image: file, ...(random.chance(0.5) ? { mediaGroupId: "album-1" } : {}) }),
    () => ({ kind: "file", id, messageId: world.made, sentAt, file: { ...file, name: "notes.txt" } }),
  ])();
}
const INBOX_DEFECT = "inbox: a file whose read does not answer has its deadline when the read is given up, and then fails with a notice";
const inboxLane: Lane<InboxWorld> = {
  name: "Telegram inbox",
  timers: true,
  open(sqlite) { const world = { sqlite, download: "works", transcribe: "works", deliver: "works", generation: 0, made: 0 } as InboxWorld; wireInbox(world); return world; },
  restart(world) { wireInbox(world); world.inbox.recover(); },
  async drive(world) { await world.inbox.drive(); },
  nextDue: world => world.inbox.nextDue(),
  items: world => world.sqlite.db.all<{ id: string; status: string; kind: string }>("SELECT id, status, json_extract(data,'$.input.kind') AS kind FROM umpi_telegram_inbox WHERE status IN ('queued','downloading','transcribing','ready','delivering')")
    .map(row => ({ id: row.id, state: `inbox:${row.kind}:${row.status}` })),
  fingerprint: world => tables(world.sqlite.sqlite, ["umpi_telegram_inbox"]),
  // Every pending entry has a time: its `due`, or the deadline of the phase that works on it.
  waiting: {},
  actions: [
    { name: "owner sends a Telegram message", weight: 5, run: async (world, random, clock) => { await world.inbox.accept(inboxMessage(world, random, clock)); } },
    { name: "downloads fail", run(world) { world.download = "fails"; } },
    { name: "downloads never answer", run(world) { world.download = "hangs"; } },
    { name: "downloads work", run(world) { world.download = "works"; } },
    { name: "transcription fails", run(world) { world.transcribe = "fails"; } },
    { name: "transcription never answers", run(world) { world.transcribe = "hangs"; } },
    { name: "transcription works", run(world) { world.transcribe = "works"; } },
    { name: "admission to the assistant fails", run(world) { world.deliver = "fails"; } },
    { name: "admission to the assistant never answers", run(world) { world.deliver = "hangs"; } },
    { name: "admission to the assistant works", weight: 2, run(world) { world.deliver = "works"; } },
  ],
  settle: () => flush(),
};
test("liveness: Telegram inbox", async t => { await simulate(t, inboxLane, { sequences: 200 }); });
test(INBOX_DEFECT, async t => {
  const violation = await scenario(t, inboxLane, async (world, clock) => {
    world.download = "hangs";
    await world.inbox.accept({ kind: "file", id: "update-1", messageId: 1, sentAt: iso(clock.now()), file: { fileId: "file-1", fileUniqueId: "unique-1", name: "notes.txt" } });
    await world.inbox.drive(); await flush();
    assert.equal(world.inbox.nextDue(), clock.now() + 90 * SECOND, "the claim's deadline is the read's own limit");
    clock.advance(90 * SECOND); await flush();
    assert.equal(world.store.deliveries("telegram-inbox-error:update-1").length, 1);
    assert.equal(world.inbox.nextDue(), undefined);
  });
  assert.equal(violation, undefined, violation?.detail);
});
test("inbox: a voice note whose download does not answer fails at its deadline and tells the owner", async t => {
  const violation = await scenario(t, inboxLane, async (world, clock) => {
    world.download = "hangs";
    await world.inbox.accept({ kind: "voice", id: "update-1", messageId: 1, fileId: "file-1", fileUniqueId: "unique-1", duration: 12, sentAt: iso(clock.now()) });
    await world.inbox.drive();
    clock.advance(MINUTE); await flush();
    assert.equal(world.store.deliveries("telegram-inbox-error:update-1").length, 1);
  });
  assert.equal(violation, undefined, violation?.detail);
});

// ---------------------------------------------------------------------------------------------------------------
// The journal queue: stage "journal" (`JournalRuntime.drive` and `nextDue`). Close-out and check-ins are turned off,
// so the lane is the queue of lines waiting to be written to a daily note. Morning preparation is never busy here.
// ---------------------------------------------------------------------------------------------------------------

interface JournalWorld { sqlite: Sqlite; store: Store; proactive: ProactiveStore; journal: JournalRuntime; vault: { mode: "works" | "conflicts" | "unconfirmed" | "down"; notes: Map<string, string> }; made: number }
const NOTE_TEMPLATE = "# {{date:MMM Do, YYYY}}\n\n## Plan\n\n### Schedule\n\n### Tasks\n\n## Done / changed\n\n## Notes\n\n## Links\n";
const JOURNAL_PAUSED = "journal:automatic line queued while follow-through is paused";
const JOURNAL_DEFECT = "journal: a line the owner asked to add to the daily note is written while follow-through is paused";
function wireJournal(world: JournalWorld): void {
  world.store = ownerStore(world.sqlite);
  world.proactive = new ProactiveStore(world.store, "UTC");
  const { vault } = world, checkedAt = () => iso(Date.now());
  const client: VaultPlanningClient = {
    async getSnapshot(day) {
      if (vault.mode === "down") throw new Error("The private note workspace is unavailable");
      const target = vault.notes.get(day) ?? null;
      return { day, checkedAt: checkedAt(), revision: vaultNoteRevision(target), target, template: NOTE_TEMPLATE, recent: [] };
    },
    async applyNote(intent) {
      if (vault.mode === "down") throw new Error("The private note workspace is unavailable");
      if (vault.mode !== "works") return { status: vault.mode === "conflicts" ? "conflict" : "unconfirmed", revision: intent.beforeRevision, checkedAt: checkedAt() };
      vault.notes.set(intent.day, intent.text);
      return { status: "synced", revision: vaultNoteRevision(intent.text), checkedAt: checkedAt() };
    },
  };
  world.journal = new JournalRuntime(new JournalStore(world.sqlite.db), world.proactive, {
    vault: () => client, planning: new PlanningStore(world.proactive, "UTC"),
    // Close-out is off, so recorded facts and mail are never read.
    situation: {} as SituationStore, mail: {} as MailStore,
    calendarCredentials: () => undefined, ownedCommitment: () => false, track: () => undefined, wake: async () => undefined,
  });
}
const journalLane: Lane<JournalWorld> = {
  name: "journal queue",
  open(sqlite) {
    const world = { sqlite, vault: { mode: "works", notes: new Map() }, made: 0 } as JournalWorld;
    wireJournal(world);
    world.journal.store.configure({ expectedVersion: 1, closeOut: false, checkIns: [] });
    return world;
  },
  restart: wireJournal,
  drive(world, clock) { world.journal.drive(clock.now()); },
  nextDue: (world, clock) => world.journal.nextDue(clock.now()),
  // `JournalRuntime.add` gives the owner's lines keys that start with "note-"; a calendar line has its event's key.
  items: world => world.journal.store.queued().map(entry => ({ id: entry.key, state: world.proactive.settings().enabled || entry.key.startsWith("note-") ? "journal:queued" : JOURNAL_PAUSED })),
  fingerprint: world => tables(world.sqlite.sqlite, ["umpi_journal_entries", "umpi_journal_marks"]),
  waiting: { [JOURNAL_PAUSED]: { evidence: `${PAUSED} assistant-runtime.md: "the close-out, calendar additions, and check-ins wait while it is paused."` } },
  actions: [
    { name: "owner turns follow-through on", weight: 3, run(world, _random, clock) { world.proactive.configure({ expectedVersion: world.proactive.settings().version, enabled: true, quietHours: null }, clock.now()); } },
    { name: "owner pauses follow-through", run(world, _random, clock) { world.proactive.configure({ expectedVersion: world.proactive.settings().version, enabled: false, quietHours: null }, clock.now()); } },
    { name: "owner asks to add a line to today's note", weight: 4, run(world, random, clock) {
      world.journal.add(planningDay(clock.now(), "UTC"), random.pick(["notes", "tasks", "done"] as const), `Ordered seeds for the balcony, batch ${++world.made}`, clock.now());
    } },
    { name: "a new calendar event is seen", weight: 2, run(world, _random, clock) {
      world.journal.calendarEvents([{ id: `event-${++world.made}`, title: "Garden club call", start: iso(clock.now() + HOUR), end: iso(clock.now() + 2 * HOUR) }], clock.now());
    } },
    { name: "the vault works", weight: 2, run(world) { world.vault.mode = "works"; } },
    { name: "the vault reports a conflict on every write", run(world) { world.vault.mode = "conflicts"; } },
    { name: "the vault does not confirm writes", run(world) { world.vault.mode = "unconfirmed"; } },
    { name: "the vault is unavailable", run(world) { world.vault.mode = "down"; } },
  ],
  settle: () => flush(),
};
test("liveness: journal queue", async t => { await simulate(t, journalLane, { sequences: 200 }); });
test(JOURNAL_DEFECT, async t => {
  const violation = await scenario(t, journalLane, async (world, clock) => {
    assert.equal(world.proactive.settings().enabled, false, "follow-through starts paused");
    const day = planningDay(clock.now(), "UTC");
    world.journal.add(day, "notes", "Ordered seeds for the balcony", clock.now());
    assert.equal(world.journal.nextDue(clock.now()), clock.now(), "the owner's line is due at once");
    world.journal.drive(clock.now()); await flush();
    assert.match(world.vault.notes.get(day) ?? "", /Ordered seeds for the balcony/);
    assert.deepEqual(world.journal.store.queued(), []);
  });
  assert.equal(violation, undefined, violation?.detail);
});
test("journal: automatic lines wait while follow-through is paused, and are written when it is on again", async t => {
  const violation = await scenario(t, journalLane, async (world, clock) => {
    const day = planningDay(clock.now(), "UTC"), on = (enabled: boolean) => world.proactive.configure({ expectedVersion: world.proactive.settings().version, enabled, quietHours: null }, clock.now());
    on(true);
    world.journal.calendarEvents([{ id: "event-1", title: "Garden club call", start: iso(clock.now() + HOUR), end: iso(clock.now() + 2 * HOUR) }], clock.now());
    on(false);
    world.journal.add(day, "notes", "Ordered seeds for the balcony", clock.now());
    world.journal.drive(clock.now()); await flush();
    assert.match(world.vault.notes.get(day)!, /Ordered seeds/);
    assert.doesNotMatch(world.vault.notes.get(day)!, /Garden club call/);
    assert.equal(world.journal.nextDue(clock.now()), undefined, "the paused calendar line asks for no wake");
    on(true);
    clock.advance(2 * HOUR);
    world.journal.drive(clock.now()); await flush();
    assert.match(world.vault.notes.get(day)!, /Garden club call/);
  });
  assert.equal(violation, undefined, violation?.detail);
});
test("journal: without a vault a line is refused, not queued", async t => {
  await scenario(t, journalLane, (world, clock) => {
    const journal = new JournalRuntime(world.journal.store, world.proactive, { vault: () => undefined, planning: new PlanningStore(world.proactive, "UTC"), situation: {} as SituationStore, mail: {} as MailStore,
      calendarCredentials: () => undefined, ownedCommitment: () => false, track: () => undefined, wake: async () => undefined });
    assert.throws(() => journal.add(planningDay(clock.now(), "UTC"), "notes", "Ordered seeds for the balcony", clock.now()), /vault is not available/);
    assert.deepEqual(journal.store.queued(), []);
  });
});
