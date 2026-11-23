import type { Database } from "./store.js";

export const EXECUTOR_WAKE_TAG = "umpi-executor-wake";
/** The Mac pings every minute; the runtime answers without waking the object. A socket with no recent ping is stale. */
export const WAKE_SOCKET_STALE_MS = 3 * 60_000;
/** A laptop can sleep overnight. One notice is sent only after a full day without the executor. */
export const EXECUTOR_OFFLINE_NOTICE_MS = 24 * 3_600_000;

/** While a socket is live, the time it was last seen live is recorded at most this often. */
const ONLINE_MARK_MS = 3_600_000;

interface PresenceMeta { lastConnectedAt: number | null; lastDisconnectedAt: number | null; noticeFor: number | null; lastOnlineAt?: number | null }

/**
 * Executor presence and wake bookkeeping. Demand is the set of executor-visible work items; a wake
 * is sent only when an item appears that was not announced before. Items that are gone are forgotten.
 */
export class ExecutorPresence {
  private announced = new Set<string>();
  constructor(private readonly db: Database) {
    db.all("CREATE TABLE IF NOT EXISTS umpi_executor_presence (id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL)");
  }
  private meta(): PresenceMeta {
    const row = this.db.all<{ data: string }>("SELECT data FROM umpi_executor_presence WHERE id=1")[0];
    return row ? JSON.parse(row.data) as PresenceMeta : { lastConnectedAt: null, lastDisconnectedAt: null, noticeFor: null };
  }
  private save(meta: PresenceMeta): void {
    this.db.all("INSERT INTO umpi_executor_presence VALUES (1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data", JSON.stringify(meta));
  }
  connected(now = Date.now()): void { this.save({ ...this.meta(), lastConnectedAt: now }); }
  disconnected(now = Date.now()): void { this.save({ ...this.meta(), lastDisconnectedAt: now }); }
  shouldWake(demand: readonly string[]): boolean {
    const fresh = demand.some(item => !this.announced.has(item));
    this.announced = new Set(demand);
    return fresh;
  }
  /** The latest evidence that the executor was running: a socket event or any executor poll. */
  lastSeen(pollSeenAt: number | null): number | null {
    const meta = this.meta();
    const times = [meta.lastConnectedAt, meta.lastDisconnectedAt, meta.lastOnlineAt ?? null, pollSeenAt].filter((time): time is number => time !== null);
    return times.length ? Math.max(...times) : null;
  }
  /** One notice per offline period, only for an executor that has connected before. */
  offlineNotice(online: boolean, pollSeenAt: number | null, now = Date.now()): { id: string; lastSeen: number } | undefined {
    if (online) {
      // A live socket is evidence too. It is recorded, so that a socket that dies without a close still leads to a notice.
      const meta = this.meta();
      if (now - (meta.lastOnlineAt ?? 0) >= ONLINE_MARK_MS) this.save({ ...meta, lastOnlineAt: now });
      return undefined;
    }
    const lastSeen = this.lastSeen(pollSeenAt), meta = this.meta();
    if (lastSeen === null || now - lastSeen < EXECUTOR_OFFLINE_NOTICE_MS || meta.noticeFor === lastSeen) return undefined;
    this.save({ ...meta, noticeFor: lastSeen });
    return { id: `notice:executor-offline:${lastSeen}`, lastSeen };
  }
  /**
   * The `due` of the coordinator's executor stage: when `offlineNotice` must be asked again, or `other` when that is
   * earlier. It is one day after the executor was last seen, until the notice for that absence is sent. Without it the
   * notice would go out only when some other subsystem happened to wake the coordinator. `executors` are the store's
   * executor records, whose `lastSeenAt` is the last poll. While the Mac stays connected this is one wake a day.
   */
  nextDue(executors: readonly object[], other?: number): number | undefined {
    const polls = executors.map(executor => Date.parse((executor as { lastSeenAt?: string }).lastSeenAt ?? "")).filter(Number.isFinite);
    const lastSeen = this.lastSeen(polls.length ? Math.max(...polls) : null);
    const notice = lastSeen === null || this.meta().noticeFor === lastSeen ? undefined : lastSeen + EXECUTOR_OFFLINE_NOTICE_MS;
    return notice === undefined ? other : other === undefined ? notice : Math.min(notice, other);
  }
  status(online: boolean, sockets: number, pollSeenAt: number | null): object {
    const meta = this.meta(), iso = (value: number | null) => value === null ? null : new Date(value).toISOString();
    return { online, wakeSockets: sockets, lastConnectedAt: iso(meta.lastConnectedAt), lastDisconnectedAt: iso(meta.lastDisconnectedAt), lastSeenAt: iso(this.lastSeen(pollSeenAt)) };
  }
}
