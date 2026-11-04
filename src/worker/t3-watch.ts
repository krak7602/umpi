import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolExecutionResult, type ToolRegistration } from "@earendil-works/pi-durable";
import { InputError, boundedText, record } from "../shared/protocol.js";
import { StateError, type Database, type Store } from "./store.js";
import { describe } from "./t3-actions.js";
import { T3Error, T3Unreachable, type T3Action, type T3CodeStore, type T3ThreadState } from "./t3-code.js";

/**
 * Following T3 Code threads that went through Umpi. When Umpi starts, messages, or answers a thread (from the chat,
 * the app, an approval, or a cloud machine start), it watches that thread and tells the owner once when it finishes
 * or starts waiting on them. A reply to that notice in Telegram goes to the thread. An action for a Mac that does not
 * answer is held and sent when the Mac is back. Checks are cheap reads, more often while a thread is new, and stop
 * after a day; a sleeping cloud machine is never woken to be checked.
 */
export type T3WatchSource = "chat" | "app" | "approval" | "cloud" | "asked" | "held";
export interface T3WatchRecord {
  id: string;
  machineId: string;
  machineLabel: string;
  threadId: string;
  title: string;
  source: T3WatchSource;
  status: "watching" | "done" | "ended";
  armedAt: string;
  expiresAt: string;
  nextCheckAt: string;
  lastStatus?: string;
  lastCheckedAt?: string;
  unreachableSince?: string;
  /** The run whose end was announced, and the run whose wait was announced (cleared once it stops waiting). */
  notifiedRun?: string;
  notifiedWaiting?: string;
  notices: number;
  lastNotice?: { kind: "finished" | "failed" | "stopped" | "waiting" | "ended" | "delivered"; at: string; text: string };
  endedAt?: string;
}
export interface T3HeldAction {
  id: string;
  machineId: string;
  machineLabel: string;
  action: T3Action;
  requestId: string;
  source: Exclude<T3WatchSource, "cloud" | "held" | "asked">;
  summary: string;
  threadTitle?: string;
  status: "held" | "sent" | "failed" | "expired";
  createdAt: string;
  attempts: number;
  nextAt: string;
  outcome?: string;
}
export interface T3WatchOptions {
  /** The owner's quiet hours: notices still arrive, without a sound. */
  quiet?(now: number): boolean;
  /** The owner's timezone, for times in notices. */
  timezone?: string;
}

const MINUTE = 60_000, HOUR = 60 * MINUTE;
export const T3_WATCH_HOURS = 24;
export const T3_HOLD_HOURS = 24;
const KEEP_MS = 7 * 24 * HOUR;
const FIRST_CHECK_MS = 45_000;
const HOLD_RETRY_MINUTES = [2, 5, 10, 15];
const ACTIVE = new Set(["preparing", "queued", "starting", "running"]);
const ENDED = new Set(["completed", "failed", "interrupted", "cancelled", "rolled_back"]);
const GROUP = "t3-watch:";

/** How long until the next check: often while a thread is new, then less often; the bridge to a Mac sleeps between. */
export function watchInterval(ageMs: number): number {
  return ageMs < 15 * MINUTE ? MINUTE : ageMs < 2 * HOUR ? 4 * MINUTE : 10 * MINUTE;
}

function clip(text: string, limit: number): string {
  const flat = text.trim();
  if (flat.length <= limit) return flat;
  const cut = flat.slice(0, limit), stop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("\n"));
  return `${stop > limit * 0.6 ? cut.slice(0, stop + 1) : cut}…`;
}

export class T3Watcher {
  constructor(private readonly db: Database, private readonly owner: Store, private readonly t3: T3CodeStore, private readonly options: T3WatchOptions = {}, private readonly now = () => Date.now()) {
    db.all("CREATE TABLE IF NOT EXISTS umpi_t3_watches (id TEXT PRIMARY KEY, machine_id TEXT NOT NULL, thread_id TEXT NOT NULL, open INTEGER NOT NULL, next_at INTEGER NOT NULL, data TEXT NOT NULL, UNIQUE (machine_id, thread_id))");
    db.all("CREATE TABLE IF NOT EXISTS umpi_t3_held (id TEXT PRIMARY KEY, open INTEGER NOT NULL, next_at INTEGER NOT NULL, data TEXT NOT NULL)");
  }

  private iso(at = this.now()): string { return new Date(at).toISOString(); }
  private label(machineId: string): string { return this.t3.list().find(machine => machine.id === machineId)?.label ?? "the machine"; }
  private cloud(machineId: string): boolean { return this.t3.list().find(machine => machine.id === machineId)?.kind === "cloud"; }
  private write(watch: T3WatchRecord): void {
    this.db.all("INSERT INTO umpi_t3_watches VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET open=excluded.open, next_at=excluded.next_at, data=excluded.data",
      watch.id, watch.machineId, watch.threadId, watch.status === "watching" ? 1 : 0, Date.parse(watch.nextCheckAt), JSON.stringify(watch));
  }
  private writeHeld(held: T3HeldAction): void {
    this.db.all("INSERT INTO umpi_t3_held VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET open=excluded.open, next_at=excluded.next_at, data=excluded.data",
      held.id, held.status === "held" ? 1 : 0, Date.parse(held.nextAt), JSON.stringify(held));
  }
  private find(machineId: string, threadId: string): T3WatchRecord | undefined {
    const row = this.db.all<{ data: string }>("SELECT data FROM umpi_t3_watches WHERE machine_id=? AND thread_id=?", machineId, threadId)[0];
    return row ? JSON.parse(row.data) as T3WatchRecord : undefined;
  }
  watch(id: string): T3WatchRecord | undefined {
    const row = this.db.all<{ data: string }>("SELECT data FROM umpi_t3_watches WHERE id=?", id)[0];
    return row ? JSON.parse(row.data) as T3WatchRecord : undefined;
  }
  watching(): T3WatchRecord[] {
    return this.db.all<{ data: string }>("SELECT data FROM umpi_t3_watches WHERE open=1 ORDER BY next_at").map(row => JSON.parse(row.data) as T3WatchRecord);
  }
  held(): T3HeldAction[] {
    return this.db.all<{ data: string }>("SELECT data FROM umpi_t3_held WHERE open=1 ORDER BY next_at").map(row => JSON.parse(row.data) as T3HeldAction);
  }

  /** Starts (or restarts) following a thread; a thread already followed keeps what it has announced. */
  arm(machineId: string, threadId: string, source: T3WatchSource, title?: string): T3WatchRecord {
    const now = this.now(), existing = this.find(machineId, threadId);
    const watch: T3WatchRecord = {
      ...(existing ?? { id: `t3w-${crypto.randomUUID()}`, machineId, threadId, notices: 0 }),
      machineLabel: this.label(machineId), title: title ?? existing?.title ?? "Untitled", source, status: "watching",
      armedAt: this.iso(now), expiresAt: this.iso(now + T3_WATCH_HOURS * HOUR), nextCheckAt: this.iso(now + FIRST_CHECK_MS),
    };
    delete watch.endedAt; delete watch.unreachableSince;
    this.write(watch);
    return watch;
  }
  /** Stops following a thread without a notice, such as after the owner stops it. */
  unwatch(machineId: string, threadId: string): boolean {
    const watch = this.find(machineId, threadId);
    if (!watch || watch.status !== "watching") return false;
    this.write({ ...watch, status: "ended", endedAt: this.iso() });
    return true;
  }

  /**
   * Runs one action on a machine and follows its thread. When a Mac does not answer, the action is held and sent when
   * it is back; the request ID keeps a repeated send from acting twice.
   */
  async run(machineId: string, action: T3Action, requestId: string, source: T3HeldAction["source"], threadTitle?: string): Promise<{ result?: unknown; held?: T3HeldAction }> {
    try {
      const result = await this.t3.act(machineId, action, requestId);
      this.followed(machineId, action, result, source, threadTitle);
      return { result };
    } catch (error) {
      if (!(error instanceof T3Unreachable) || this.cloud(machineId)) throw error;
      return { held: this.hold(machineId, action, requestId, source, threadTitle) };
    }
  }
  private followed(machineId: string, action: T3Action, result: unknown, source: T3WatchSource, threadTitle?: string): void {
    if (action.kind === "stop") { this.unwatch(machineId, action.threadId); return; }
    const threadId = action.kind === "start" ? record(result).threadId : action.threadId;
    if (typeof threadId === "string" && threadId) this.arm(machineId, threadId, source, action.kind === "start" ? action.title : threadTitle);
  }
  private hold(machineId: string, action: T3Action, requestId: string, source: T3HeldAction["source"], threadTitle?: string): T3HeldAction {
    const now = this.now(), machineLabel = this.label(machineId);
    const held: T3HeldAction = { id: `t3h-${crypto.randomUUID()}`, machineId, machineLabel, action, requestId, source, summary: describe(action, machineLabel, threadTitle),
      ...(threadTitle ? { threadTitle } : {}), status: "held", createdAt: this.iso(now), attempts: 0, nextAt: this.iso(now + HOLD_RETRY_MINUTES[0]! * MINUTE) };
    this.writeHeld(held);
    // In the chat, Umpi says this itself; from the app, nothing else would.
    if (source === "app") this.notify(`t3-held:${held.id}:held`, `${machineLabel} did not answer, so Umpi holds this and sends it when the machine is back:\n\n${held.summary}`);
    return held;
  }

  private notify(group: string, text: string): void {
    this.owner.enqueue(group, "telegram", text, undefined, undefined, undefined, this.options.quiet?.(this.now()) ? { quiet: true } : undefined);
  }
  private announce(watch: T3WatchRecord, kind: NonNullable<T3WatchRecord["lastNotice"]>["kind"], text: string): T3WatchRecord {
    const next = { ...watch, notices: watch.notices + 1, lastNotice: { kind, at: this.iso(), text: clip(text, 300) } };
    this.notify(`${GROUP}${watch.id}:${next.notices}`, text);
    return next;
  }

  /** The thread a Telegram message belongs to, when it is one of these notices. */
  forMessage(messageId: number): T3WatchRecord | undefined {
    const group = this.owner.groupOfMessage(messageId);
    if (group?.startsWith(GROUP)) return this.watch(group.slice(GROUP.length).split(":")[0]!);
    const held = group && /^t3-held:([^:]+):/.exec(group)?.[1];
    if (!held) return undefined;
    const row = this.db.all<{ data: string }>("SELECT data FROM umpi_t3_held WHERE id=?", held)[0];
    const action = row ? (JSON.parse(row.data) as T3HeldAction) : undefined;
    const threadId = action && "threadId" in action.action ? action.action.threadId : undefined;
    return action && threadId ? this.find(action.machineId, threadId) : undefined;
  }
  /** Notices of the last day, newest first, so the conversation knows what the owner was told. */
  recent(limit = 8): { machine: string; threadId: string; title: string; notice: string; at: string; watching: boolean }[] {
    const since = this.now() - T3_WATCH_HOURS * HOUR;
    return this.db.all<{ data: string }>("SELECT data FROM umpi_t3_watches").map(row => JSON.parse(row.data) as T3WatchRecord)
      .filter(watch => watch.lastNotice && Date.parse(watch.lastNotice.at) >= since).sort((a, b) => b.lastNotice!.at.localeCompare(a.lastNotice!.at)).slice(0, limit)
      .map(watch => ({ machine: watch.machineLabel, threadId: watch.threadId, title: watch.title, notice: watch.lastNotice!.text, at: watch.lastNotice!.at, watching: watch.status === "watching" }));
  }

  private driving?: Promise<void>;
  /**
   * Starts a drive beside the coordinator's other work when something is due: a Mac that does not answer can take
   * 20 seconds, which must not hold up reminders or messages. One drive at a time; `wake` reschedules after it.
   */
  kick(track: (work: Promise<void>) => void, wake: () => unknown): void {
    if (this.driving) return;
    const now = this.now();
    const due = this.db.all("SELECT 1 FROM umpi_t3_watches WHERE open=1 AND next_at<=? UNION ALL SELECT 1 FROM umpi_t3_held WHERE open=1 AND next_at<=? LIMIT 1", now, now).length > 0;
    if (!due) return;
    const work = this.drive().catch(() => undefined).finally(() => { this.driving = undefined; void wake(); });
    this.driving = work;
    track(work);
  }

  nextDue(): number | undefined {
    if (this.driving) return this.now() + 30_000;
    const next = this.db.all<{ at: number | null }>("SELECT MIN(next_at) AS at FROM (SELECT next_at FROM umpi_t3_watches WHERE open=1 UNION ALL SELECT next_at FROM umpi_t3_held WHERE open=1)")[0]?.at;
    return typeof next === "number" ? Math.max(this.now() + 1_000, next) : undefined;
  }

  async drive(): Promise<void> {
    const now = this.now();
    for (const held of this.db.all<{ data: string }>("SELECT data FROM umpi_t3_held WHERE open=1 AND next_at<=?", now).map(row => JSON.parse(row.data) as T3HeldAction)) await this.retry(held);
    const due = this.db.all<{ machine_id: string }>("SELECT DISTINCT machine_id FROM umpi_t3_watches WHERE open=1 AND next_at<=?", now);
    for (const { machine_id: machineId } of due) {
      try { await this.check(machineId); } catch { /* the next drive tries again */ }
    }
    this.db.all("DELETE FROM umpi_t3_watches WHERE open=0 AND next_at<?", now - KEEP_MS);
    this.db.all("DELETE FROM umpi_t3_held WHERE open=0 AND next_at<?", now - KEEP_MS);
  }

  private async retry(held: T3HeldAction): Promise<void> {
    const now = this.now(), since = new Date(held.createdAt);
    try {
      const result = await this.t3.act(held.machineId, held.action, held.requestId);
      this.writeHeld({ ...held, status: "sent", attempts: held.attempts + 1, nextAt: this.iso(now), outcome: JSON.stringify(result ?? {}).slice(0, 500) });
      this.followed(held.machineId, held.action, result, "held", held.threadTitle);
      const watch = "threadId" in held.action ? this.find(held.machineId, held.action.threadId) : undefined;
      const text = `${held.machineLabel} is back, so Umpi sent what it held since ${this.time(since)}:\n\n${held.summary}`;
      if (watch) this.write(this.announce(watch, "delivered", text));
      else this.notify(`t3-held:${held.id}:sent`, text);
    } catch (error) {
      if (error instanceof T3Unreachable && now - since.getTime() < T3_HOLD_HOURS * HOUR) {
        const attempts = held.attempts + 1;
        this.writeHeld({ ...held, attempts, nextAt: this.iso(now + (HOLD_RETRY_MINUTES[attempts] ?? HOLD_RETRY_MINUTES.at(-1)!) * MINUTE) });
        return;
      }
      const expired = error instanceof T3Unreachable;
      const outcome = error instanceof Error ? error.message.slice(0, 300) : "It did not work";
      this.writeHeld({ ...held, status: expired ? "expired" : "failed", attempts: held.attempts + 1, nextAt: this.iso(now), outcome });
      this.notify(`t3-held:${held.id}:${expired ? "expired" : "failed"}`, expired
        ? `${held.machineLabel} did not answer for a day, so Umpi did not send this. Nothing was changed:\n\n${held.summary}`
        : `Umpi held this for ${held.machineLabel}, but it did not work when sent (${outcome}):\n\n${held.summary}`);
    }
  }

  private time(at: Date): string {
    return at.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: this.options.timezone ?? "UTC" });
  }

  /**
   * Checks every followed thread on one machine in one session. `final` is the check before a cloud machine sleeps.
   * A sleeping cloud machine is not woken: its threads wait for its next wake.
   */
  async check(machineId: string, final = false): Promise<void> {
    const now = this.now();
    const open = this.db.all<{ data: string }>("SELECT data FROM umpi_t3_watches WHERE open=1 AND machine_id=?", machineId).map(row => JSON.parse(row.data) as T3WatchRecord);
    if (!open.length) return;
    const machine = this.t3.list().find(item => item.id === machineId);
    if (!machine) { for (const watch of open) this.write({ ...watch, status: "ended", endedAt: this.iso(now) }); return; }
    if (machine.kind === "cloud" && machine.asleep && !final) {
      for (const watch of open) this.write(now >= Date.parse(watch.expiresAt) ? { ...watch, status: "ended", endedAt: this.iso(now) } : { ...watch, nextCheckAt: this.iso(now + 10 * MINUTE) });
      return;
    }
    let states: Map<string, T3ThreadState | undefined>;
    try { states = await this.t3.states(machineId, open.map(watch => watch.threadId)); }
    catch (error) {
      for (const watch of open) {
        const unreachableSince = watch.unreachableSince ?? this.iso(now);
        if (now < Date.parse(watch.expiresAt)) { this.write({ ...watch, unreachableSince, lastCheckedAt: this.iso(now), nextCheckAt: this.iso(now + 10 * MINUTE) }); continue; }
        const why = error instanceof T3Unreachable ? `${watch.machineLabel} has not answered since ${this.time(new Date(unreachableSince))}` : error instanceof Error ? error.message.slice(0, 200) : "it could not be read";
        this.write({ ...this.announce(watch, "ended", `Umpi stopped following "${watch.title}" on ${watch.machineLabel}: ${why}. Ask again when you want news of it.`), status: "ended", endedAt: this.iso(now) });
      }
      return;
    }
    for (const watch of open) {
      const state = states.get(watch.threadId);
      if (!state) { this.write({ ...watch, status: "ended", endedAt: this.iso(now) }); continue; }
      this.write(await this.observe({ ...watch, title: state.title || watch.title, lastStatus: state.status, lastCheckedAt: this.iso(now) }, state, now));
    }
  }

  private async observe(watch: T3WatchRecord, state: T3ThreadState, now: number): Promise<T3WatchRecord> {
    delete watch.unreachableSince;
    const runKey = state.run?.id ?? state.updatedAt ?? "-";
    const waiting = state.status === "waiting" || state.pendingRequests > 0;
    if (waiting) {
      if (watch.notifiedWaiting !== runKey) watch = { ...this.announce(watch, "waiting", await this.waitingText(watch)), notifiedWaiting: runKey };
    } else delete watch.notifiedWaiting;
    const endedAt = state.run?.completedAt ?? state.updatedAt;
    const runEnded = !waiting && !ACTIVE.has(state.status) && (ENDED.has(state.status) || (state.run !== undefined && ENDED.has(state.run.status)));
    // Only a run that ended after Umpi acted is news; the earlier run of a thread just messaged is not.
    if (runEnded && endedAt && Date.parse(endedAt) >= Date.parse(watch.armedAt) - 5_000 && watch.notifiedRun !== runKey) {
      const status = ENDED.has(state.status) ? state.status : state.run!.status;
      const kind = status === "completed" ? "finished" : status === "failed" ? "failed" : "stopped";
      return { ...this.announce(watch, kind, await this.endedText(watch, state, kind)), notifiedRun: runKey, status: "done", endedAt: this.iso(now), nextCheckAt: this.iso(now) };
    }
    if (now >= Date.parse(watch.expiresAt)) {
      const still = waiting ? "still waiting on you" : ACTIVE.has(state.status) ? "still working" : `${state.status}`;
      return { ...this.announce(watch, "ended", `Umpi stopped following "${watch.title}" on ${watch.machineLabel} after a day; it is ${still}. Ask again when you want news of it.`), status: "ended", endedAt: this.iso(now), nextCheckAt: this.iso(now) };
    }
    return { ...watch, nextCheckAt: this.iso(now + watchInterval(now - Date.parse(watch.armedAt))) };
  }

  private async endedText(watch: T3WatchRecord, state: T3ThreadState, kind: "finished" | "failed" | "stopped"): Promise<string> {
    const head = kind === "finished" ? `"${watch.title}" finished on ${watch.machineLabel}.` : kind === "failed" ? `"${watch.title}" failed on ${watch.machineLabel}.` : `"${watch.title}" stopped on ${watch.machineLabel} before it finished.`;
    let last: string | undefined;
    try {
      const { messages } = await this.t3.read(watch.machineId, watch.threadId, { latest: true, limit: 4, maxChars: 1_500 });
      last = messages.filter(message => message.by === "agent" || message.type.includes("assistant")).at(-1)?.text;
    } catch { /* the notice still says it ended */ }
    const extra = [state.branch ? `Branch: ${state.branch}.` : "", state.pullRequests ? `It has ${state.pullRequests === 1 ? "a pull request" : `${state.pullRequests} pull requests`}.` : ""].filter(Boolean).join(" ");
    return [head, last ? clip(last, 700) : "", extra, "Reply to this message to send it a follow-up."].filter(Boolean).join("\n\n");
  }

  private async waitingText(watch: T3WatchRecord): Promise<string> {
    try {
      const { requests } = await this.t3.questions(watch.machineId, watch.threadId);
      const asked = requests.flatMap(request => request.questions).slice(0, 3);
      if (asked.length) {
        const lines = asked.map(question => [clip(question.question, 400), ...question.options.slice(0, 6).map(option => `• ${option.label}`)].join("\n"));
        return [`"${watch.title}" on ${watch.machineLabel} is waiting on you:`, ...lines, "Reply to this message with your answer."].join("\n\n");
      }
    } catch { /* a permission request, or the question could not be read */ }
    return `"${watch.title}" on ${watch.machineLabel} is waiting for your approval in T3 Code (a command or an edit). Umpi cannot answer that one for you.`;
  }
}

/** Following a thread the owner names, when they ask to hear about it. Threads Umpi acts on are followed by themselves. */
export function t3WatchTools(t3: T3CodeStore, watcher: T3Watcher): ToolRegistration[] {
  const result = async (run: () => Promise<unknown>): Promise<ToolExecutionResult> => {
    try { return { content: [{ type: "text", text: JSON.stringify(await run()) }] }; }
    catch (error) { return { isError: true, content: [{ type: "text", text: error instanceof T3Error || error instanceof InputError || error instanceof StateError ? error.message : "That thread could not be followed." }] }; }
  };
  return [
    defineTool({ name: "t3_code_follow", description: "Tell the owner when a T3 Code thread finishes or starts waiting on them, for up to a day; stop: true ends that. Threads Umpi starts, messages, or answers are followed already; use this when the owner asks about one they started themselves. Also lists what Umpi follows, what it holds for an offline machine, and its recent notices, with no threadId.",
      parameters: Type.Object({ machine: Type.Optional(Type.String({ maxLength: 100 })), threadId: Type.Optional(Type.String({ maxLength: 100 })), title: Type.Optional(Type.String({ maxLength: 200 })),
        stop: Type.Optional(Type.Boolean()) }, { additionalProperties: false }),
      replay: "safe",
      async execute(input) {
        return result(async () => {
          const body = record(input);
          if (body.threadId === undefined) return { following: watcher.watching().map(watch => ({ machine: watch.machineLabel, threadId: watch.threadId, title: watch.title, status: watch.lastStatus, since: watch.armedAt })),
            held: watcher.held().map(held => ({ machine: held.machineLabel, summary: held.summary, since: held.createdAt })), recentNotices: watcher.recent() };
          const machine = t3.pick(body.machine), threadId = boundedText(body.threadId, 100, "thread ID");
          if (body.stop === true) return { following: false, changed: watcher.unwatch(machine.id, threadId) };
          const watch = watcher.arm(machine.id, threadId, "asked", typeof body.title === "string" && body.title.trim() ? body.title.trim() : undefined);
          return { following: true, machine: watch.machineLabel, until: watch.expiresAt, note: "Umpi tells the owner once when it finishes or waits on them." };
        });
      } }),
  ];
}
