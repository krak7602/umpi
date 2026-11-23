// The stores and runtimes `buildProfiles` needs, over node:sqlite, for tests/profiles.test.ts.
// Stores are real. Hosts that would reach a model, a network, or a Durable Object are stubs that fail when called:
// no tool factory calls them while the profiles are built.
import type { TestContext } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { ActivityStore } from "../../src/worker/activity-store.js";
import { BriefStore } from "../../src/worker/brief-store.js";
import { BrowserRuntime } from "../../src/worker/browser-runtime.js";
import { BrowserSnapshots } from "../../src/worker/browser-snapshots.js";
import { BrowserStore } from "../../src/worker/browser-store.js";
import { ChatLog } from "../../src/worker/chat.js";
import type { CloudMachines } from "../../src/worker/cloud-machines.js";
import { CodingRuntime } from "../../src/worker/coding-runtime.js";
import { CodingStore } from "../../src/worker/coding-store.js";
import { CompanionStore } from "../../src/worker/companion-store.js";
import { ContextHealth } from "../../src/worker/context-health.js";
import { Decisions } from "../../src/worker/decisions.js";
import { DreamStore } from "../../src/worker/dream-store.js";
import { DreamRuntime } from "../../src/worker/dream-tools.js";
import { HistoryIndex } from "../../src/worker/history-index.js";
import { JournalRuntime, JournalStore } from "../../src/worker/journal.js";
import { MailRuntime } from "../../src/worker/mail-runtime.js";
import { MailStore } from "../../src/worker/mail-store.js";
import { PlanningRuntime } from "../../src/worker/planning-runtime.js";
import { PlanningStore } from "../../src/worker/planning-store.js";
import { HEARTBEAT_MS, ProactiveStore } from "../../src/worker/proactive-store.js";
import { subagentScope, type ProfileSources } from "../../src/worker/profiles.js";
import { SituationStore } from "../../src/worker/situation-store.js";
import { SpeechWordStore } from "../../src/worker/speech-words.js";
import { Store, type Database } from "../../src/worker/store.js";
import { SubagentRuntime } from "../../src/worker/subagent-runtime.js";
import { T3ActionRequests } from "../../src/worker/t3-actions.js";
import { T3CodeStore } from "../../src/worker/t3-code.js";
import { T3Watcher } from "../../src/worker/t3-watch.js";
import { WebSeenStore, WebUsageStore } from "../../src/worker/web-search.js";
import { WebRequests } from "../../src/worker/web-requests.js";
import { WebWatcher } from "../../src/worker/web-watch.js";
import { WidgetStore } from "../../src/worker/widget.js";

export const PROFILE_TZ = "UTC";
/** The fixture's clock starts here: 23:10 on 2027-03-09. The night of that day opens at 02:00 on the 10th. */
export const PROFILE_EVENING = Date.parse("2027-03-09T23:10:00Z");
export const PROFILE_NIGHT = Date.parse("2027-03-10T02:00:00Z");

/** Conversations: "owner-chat" and "owner-control" are the owner's; "review" and "night-review" are background sessions. */
export function profileFixture(t: TestContext) {
  t.mock.timers.enable({ apis: ["Date"], now: PROFILE_EVENING });
  const sqlite = new DatabaseSync(":memory:"); let depth = 0; t.after(() => sqlite.close());
  const db: Database = {
    all: <T extends object>(query: string, ...bindings: (string | number | null)[]) => sqlite.prepare(query).all(...bindings) as T[],
    transaction<T>(run: () => T): T {
      const name = `profile_${depth++}`; sqlite.exec(`SAVEPOINT ${name}`);
      try { const value = run(); sqlite.exec(`RELEASE ${name}`); return value; }
      catch (error) { sqlite.exec(`ROLLBACK TO ${name}; RELEASE ${name}`); throw error; }
      finally { depth--; }
    },
  };
  const stub = (what: string) => (): never => { throw new Error(`The profile fixture has no ${what}`); };
  const wake = async () => {}, track = () => {}, calendarCredentials = () => undefined;
  const store = new Store(db);
  store.setSession("control", "owner-control"); store.setSession("telegram", "owner-chat");
  store.registerBackgroundSession("review", "control"); store.registerBackgroundSession("night-review", "telegram");
  const proactive = new ProactiveStore(store, PROFILE_TZ); proactive.configure({ expectedVersion: 1, enabled: true, quietHours: null }, PROFILE_EVENING);
  const situation = new SituationStore(db, PROFILE_TZ), activity = new ActivityStore(db);
  const planning = new PlanningStore(proactive, PROFILE_TZ), mail = new MailStore(proactive, situation), brief = new BriefStore(proactive), dream = new DreamStore(proactive);
  const coding = new CodingStore(store), browser = new BrowserStore(store);
  const t3 = new T3CodeStore(db, stub("network")), t3Requests = new T3ActionRequests(db, store, t3);
  const t3Watch = new T3Watcher(db, store, t3, { quiet: now => proactive.quiet(now), timezone: PROFILE_TZ });
  const decisions = new Decisions(db, undefined, () => 0), history = new HistoryIndex(db, decisions);
  const webUsage = new WebUsageStore(db, () => 1_000), webWatch = new WebWatcher(db, decisions, { key: () => undefined, usage: webUsage }, { notice: () => undefined });
  const host = { harness: stub("harness"), extension: stub("extension"), archive: () => undefined, cloud: () => undefined, cloudAvailable: () => false, modelReady: async () => false, wake, track };
  const ownerSessions = () => (["telegram", "control"] as const).flatMap(channel => { const session = store.session(channel); return session ? [{ channel, session }] : []; });
  const sources: ProfileSources = {
    store, timezone: PROFILE_TZ, wake, notifyExecutor: () => {}, calendarCredentials, webKey: () => undefined,
    conversations: async () => ownerSessions().map(({ channel }) => ({ channel, entries: [] })),
    provenance: { refused: {}, allowed: 0 },
    companion: new CompanionStore(store), proactive, situation, activity, mail, brief, dream, coding, browser,
    journal: new JournalRuntime(new JournalStore(db), proactive, { vault: () => undefined, planning, situation, mail, calendarCredentials, ownedCommitment: () => false, track, wake }),
    speechWords: new SpeechWordStore(db), widgets: new WidgetStore(db), t3, t3Requests, t3Watch,
    // Not built: its tools only close over it, and its constructor needs Durable Object stubs.
    cloud: {} as CloudMachines,
    webUsage, webWatch, webRequests: new WebRequests(db, store, webWatch, { seen: new WebSeenStore(db), admit: () => undefined }), decisions, history, contextHealth: new ContextHealth(db), chat: new ChatLog(db),
    planningRuntime: new PlanningRuntime(planning, () => undefined, async () => 1, calendarCredentials, wake),
    mailRuntime: new MailRuntime(mail, undefined, wake),
    codingRuntime: new CodingRuntime(coding, host),
    browserRuntime: new BrowserRuntime(browser, new BrowserSnapshots(browser, () => undefined), host),
    dreamRuntime: new DreamRuntime(dream, decisions, history, { sessions: () => ownerSessions().map(item => item.session), compact: async () => {} }),
    subagents: new SubagentRuntime({ harness: stub("harness"), scope: session => subagentScope({ store, coding }, session), validate: () => {}, profile: stub("child profile"), deliver: async () => {}, wake, track }),
  };
  return {
    db, sources, time(at: number) { t.mock.timers.setTime(at); },
    /** Starts an ordinary background review in the session "review". */
    openReview(allowNotify = true) {
      proactive.createCommitment({ id: "kiln-check", purpose: "Check whether the kiln firing finished", source: "Owner asked for a check on the kiln", nextAction: "Read the firing log", status: "active", blocker: null,
        nextReviewAt: new Date(PROFILE_EVENING + 1_000).toISOString(), jobId: null, allowNotify }, "control", "owner-control");
      t.mock.timers.setTime(PROFILE_EVENING + HEARTBEAT_MS);
      proactive.drive(PROFILE_EVENING + HEARTBEAT_MS, false, { control: "review" });
      store.submitted(proactive.runForSession("review")!.operationId);
    },
    /** Enables the nightly run and opens the night in the session "night-review". */
    openNight() {
      dream.configure({ expectedVersion: 1, enabled: true }, "owner-chat", PROFILE_EVENING);
      t.mock.timers.setTime(PROFILE_NIGHT); dream.drive(PROFILE_NIGHT);
      proactive.drive(PROFILE_NIGHT, false, { telegram: "night-review" });
      store.submitted(proactive.runForSession("night-review")!.operationId);
    },
  };
}
export type ProfileFixture = ReturnType<typeof profileFixture>;
