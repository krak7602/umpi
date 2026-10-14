import { createHash, randomUUID } from "node:crypto";
import { BROWSER_SNAPSHOT_MAX_AGE_MS, MAX_BROWSER_OPERATIONS, MAX_BROWSER_PROMPT, MAX_BROWSER_SITES, MAX_BROWSER_TIMEOUT_MS, browserOperationPrefix, browserPublicUrl, browserSitePolicyJson, browserUrl, parseBrowserReceipt, parseBrowserRequest, parseBrowserSite, requestedBrowserSite } from "../shared/browser.js";
import type { BrowserAssignment, BrowserExecutorPoll, BrowserExecutorPollResult, BrowserReceipt, BrowserRequest, BrowserSite, BrowserSiteScope, BrowserSnapshotMetadata } from "../shared/browser.js";
import { boundedText, identifier, InputError, record } from "../shared/protocol.js";
import { StateError } from "./store.js";
import type { Channel, Store } from "./store.js";

export type BrowserStatus = "pending_approval" | "queued" | "preparing" | "running" | "finishing" | "cancel_requested" | "completed" | "waiting_input" | "blocked" | "cancelled" | "failed" | "uncertain";
export interface BrowserRun {
  runId: string; target: "mac" | "cloud"; executorId: string; assignment: BrowserAssignment;
  snapshots: BrowserSnapshotMetadata[]; startDispatchedAt?: string; readyAt?: string; stoppedAt?: string; reconciledAt?: string;
  result?: BrowserResult;
}
export interface BrowserResult { outcome: "completed" | "needs_input" | "blocked"; summary: string; evidence: { siteId: string; url: string; observationId: string }[] }
export interface BrowserTask {
  taskId: string; version: number; status: BrowserStatus; target: "mac" | "cloud";
  prompt: string; sites: BrowserSiteScope[]; timeoutMs: number; corrections: string[];
  channel: Channel; parentSessionId: string; sessionId?: string; createdAt: string; updatedAt: string;
  selectedSnapshots: BrowserSnapshotMetadata[]; run?: BrowserRun; finish?: BrowserResult; result?: BrowserResult; issue?: string; stopOutcome?: "cancelled" | "failed";
}
export interface BrowserRpcRecord { taskId: string; runId: string; request: BrowserRequest; dispatched: boolean; receipt?: BrowserReceipt }
export interface BrowserInput { operationId: string; taskId: string; runId: string; text: string; initial: boolean; status: "pending" | "submitted" | "done" }
export interface BrowserExecutor extends BrowserExecutorPoll { lastSeenAt: string }
export interface BrowserSnapshotCandidate {
  metadata: BrowserSnapshotMetadata; key: string; status: "uploading" | "quarantined" | "deleting";
  uncertain: boolean; nextAttemptAt: number;
}
const iso = (now = Date.now()) => new Date(now).toISOString();
const terminal = new Set<BrowserStatus>(["completed", "waiting_input", "blocked", "cancelled", "failed", "uncertain"]);
const active = new Set<BrowserStatus>(["preparing", "running", "finishing", "cancel_requested"]);

/** Site grants, authentication metadata and browser ownership never join coding state. */
export class BrowserStore {
  constructor(readonly owner: Store, readonly allowLoopback = false) {
    for (const sql of [
      "CREATE TABLE IF NOT EXISTS umpi_browser_tasks (id TEXT PRIMARY KEY,status TEXT NOT NULL,target TEXT NOT NULL,run_id TEXT,executor TEXT)",
      "CREATE TABLE IF NOT EXISTS umpi_browser_values (kind TEXT NOT NULL,id TEXT NOT NULL,part INTEGER NOT NULL,data TEXT NOT NULL,PRIMARY KEY(kind,id,part))",
      "CREATE TABLE IF NOT EXISTS umpi_browser_sites (id TEXT PRIMARY KEY)",
      "CREATE TABLE IF NOT EXISTS umpi_browser_snapshot_requests (cursor INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE)",
      "CREATE TABLE IF NOT EXISTS umpi_browser_snapshots (id TEXT PRIMARY KEY,site_id TEXT NOT NULL,captured_at TEXT NOT NULL)",
      "CREATE INDEX IF NOT EXISTS umpi_browser_snapshots_site ON umpi_browser_snapshots(site_id,captured_at)",
      "CREATE TABLE IF NOT EXISTS umpi_browser_snapshot_cleanup (id TEXT PRIMARY KEY,due INTEGER NOT NULL)",
      "CREATE INDEX IF NOT EXISTS umpi_browser_snapshot_cleanup_due ON umpi_browser_snapshot_cleanup(due)",
      "CREATE TABLE IF NOT EXISTS umpi_browser_executors (id TEXT PRIMARY KEY)",
      "CREATE TABLE IF NOT EXISTS umpi_browser_runs (id TEXT PRIMARY KEY,task_id TEXT NOT NULL)",
      "CREATE INDEX IF NOT EXISTS umpi_browser_runs_task ON umpi_browser_runs(task_id)",
      "CREATE TABLE IF NOT EXISTS umpi_browser_sessions (id TEXT PRIMARY KEY,task_id TEXT NOT NULL UNIQUE)",
      "CREATE TABLE IF NOT EXISTS umpi_browser_rpc (id TEXT PRIMARY KEY,task_id TEXT NOT NULL,run_id TEXT NOT NULL,status TEXT NOT NULL,observation INTEGER NOT NULL DEFAULT 0,bytes INTEGER NOT NULL DEFAULT 0)",
      "CREATE INDEX IF NOT EXISTS umpi_browser_rpc_run ON umpi_browser_rpc(run_id,status)",
      "CREATE TABLE IF NOT EXISTS umpi_browser_inputs (id TEXT PRIMARY KEY,task_id TEXT NOT NULL,run_id TEXT NOT NULL,status TEXT NOT NULL)",
    ]) owner.db.all(sql);
  }
  private value<T>(kind: string, id: string): T | undefined {
    const parts = this.owner.db.all<{ data: string }>("SELECT data FROM umpi_browser_values WHERE kind=? AND id=? ORDER BY part", kind, id);
    return parts.length ? JSON.parse(parts.map(part => part.data).join("")) as T : undefined;
  }
  private saveValue(kind: string, id: string, value: unknown): void {
    const text = JSON.stringify(value);
    this.owner.db.all("DELETE FROM umpi_browser_values WHERE kind=? AND id=?", kind, id);
    for (let offset = 0, part = 0; offset < text.length; part++) {
      let end = Math.min(offset + 32_768, text.length);
      if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]!)) end--;
      this.owner.db.all("INSERT INTO umpi_browser_values VALUES (?,?,?,?)", kind, id, part, text.slice(offset, end)); offset = end;
    }
  }
  private version(task: BrowserTask, expected: unknown): void { if (!Number.isSafeInteger(expected) || expected !== task.version) throw new StateError(409, "Browser task changed; read its current version"); }
  private save(task: BrowserTask): BrowserTask {
    this.owner.db.all("INSERT INTO umpi_browser_tasks VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,target=excluded.target,run_id=excluded.run_id,executor=excluded.executor", task.taskId, task.status, task.target, task.run?.runId ?? null, task.run?.executorId ?? null);
    this.saveValue("task", task.taskId, task);
    if (task.run) { this.owner.db.all("INSERT OR IGNORE INTO umpi_browser_runs VALUES (?,?)", task.run.runId, task.taskId); this.saveValue("run", task.run.runId, { taskId: task.taskId, run: task.run }); }
    if (terminal.has(task.status) && (!task.run || task.run.stoppedAt || task.status === "uncertain")) this.feedback(task);
    return task;
  }
  task(id: string): BrowserTask | undefined { return this.value("task", id); }
  requireTask(id: string): BrowserTask { const task = this.task(id); if (!task) throw new StateError(404, "Browser task not found"); return task; }
  tasks(): BrowserTask[] { return this.owner.db.all<{ id: string }>("SELECT id FROM umpi_browser_tasks ORDER BY rowid DESC LIMIT 100").map(row => this.requireTask(row.id)); }
  active(): BrowserTask[] { return this.owner.db.all<{ id: string }>("SELECT id FROM umpi_browser_tasks WHERE status IN ('queued','preparing','running','finishing','cancel_requested','uncertain') ORDER BY rowid").map(row => this.requireTask(row.id)); }
  reviewedOrActive(): BrowserTask[] { return this.owner.db.all<{ id: string }>("SELECT id FROM umpi_browser_tasks WHERE status IN ('pending_approval','queued','preparing','running','finishing','cancel_requested','uncertain') ORDER BY rowid").map(row => this.requireTask(row.id)); }
  site(id: string): BrowserSite | undefined { return this.value("site", id); }
  sites(): BrowserSite[] { return this.owner.db.all<{ id: string }>("SELECT id FROM umpi_browser_sites ORDER BY rowid").map(row => this.site(row.id)!); }
  settings(): { version: number; allSites: boolean } { return this.value("settings", "permissions") ?? { version: 1, allSites: false }; }
  configure(expectedVersion: unknown, allSites: unknown): { version: number; allSites: boolean } {
    if (typeof allSites !== "boolean") throw new InputError("Browser all-site permission must be a boolean");
    return this.owner.db.transaction(() => {
      const current = this.settings();
      if (expectedVersion !== current.version) throw new StateError(409, "Browser permissions changed; read the current version");
      const next = { version: current.version + 1, allSites }; this.saveValue("settings", "permissions", next); return next;
    });
  }
  snapshotRequests(after = 0): { sites: BrowserSite[]; nextCursor: number | null } {
    if (!Number.isSafeInteger(after) || after < 0) throw new InputError("Invalid browser snapshot request cursor");
    const rows = this.owner.db.all<{ id: string; cursor: number }>("SELECT id,cursor FROM umpi_browser_snapshot_requests WHERE cursor>? ORDER BY cursor LIMIT 16", after);
    return { sites: rows.map(row => this.value<BrowserSite>("snapshot-request", row.id)!), nextCursor: rows.at(-1)?.cursor ?? null };
  }
  requestedSnapshotSite(id: string): BrowserSite | undefined { return this.value("snapshot-request", id); }
  registerSite(value: unknown, expectedVersion: unknown): BrowserSite {
    const policy = parseBrowserSite(value, this.allowLoopback), previous = this.site(policy.siteId);
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion !== (previous?.version ?? 0)) throw new StateError(409, "Browser site policy changed");
    // The registry is not a website allowlist. Tasks and archive operations retain their own bounds.
    const site: BrowserSite = { ...policy, version: (previous?.version ?? 0) + 1, policyDigest: createHash("sha256").update(browserSitePolicyJson(policy)).digest("hex") };
    return this.owner.db.transaction(() => {
      this.owner.db.all("INSERT OR IGNORE INTO umpi_browser_sites VALUES (?)", site.siteId); this.saveValue("site", site.siteId, site);
      this.owner.db.all("DELETE FROM umpi_browser_snapshot_requests WHERE id=?", site.siteId);
      this.owner.db.all("DELETE FROM umpi_browser_values WHERE kind='snapshot-request' AND id=?", site.siteId);
      // A new grant never changes the scope of a dispatched run. Old unclaimed approvals are stale.
      for (const task of this.reviewedOrActive()) if (!task.run && ["queued", "pending_approval"].includes(task.status) && task.sites.some(scope => scope.site.siteId === site.siteId)) this.save({ ...task, version: task.version + 1, status: "failed", issue: "An approved site policy changed; request a new task with its current scope", updatedAt: iso() });
      return site;
    });
  }
  /** Private crypto state is accessible only to trusted snapshot code, never status/tools. */
  snapshotKey(): { keyId: string; privateKey: JsonWebKey; publicKey: JsonWebKey } | undefined { return this.value("private-key", "snapshot"); }
  saveSnapshotKey(value: { keyId: string; privateKey: JsonWebKey; publicKey: JsonWebKey }): void { this.owner.db.transaction(() => { if (!this.snapshotKey()) this.saveValue("private-key", "snapshot", value); }); }
  snapshot(id: string): BrowserSnapshotMetadata | undefined { return this.value("snapshot", id); }
  snapshotObjectKey(id: string): string { const snapshot = this.snapshot(id); if (!snapshot) throw new StateError(404, "Browser snapshot not found"); return `browser/snapshots/${snapshot.siteId}/${snapshot.snapshotId}/${snapshot.digest}.json`; }
  snapshots(): BrowserSnapshotMetadata[] { return this.owner.db.all<{ id: string }>("SELECT id FROM umpi_browser_snapshots ORDER BY captured_at DESC LIMIT 256").map(row => this.snapshot(row.id)!); }
  snapshotCandidate(id: string): BrowserSnapshotCandidate | undefined { return this.value("snapshot-cleanup", id); }
  snapshotCandidates(): BrowserSnapshotCandidate[] { return this.owner.db.all<{ id: string }>("SELECT id FROM umpi_browser_snapshot_cleanup ORDER BY due,rowid").map(row => this.snapshotCandidate(row.id)!); }
  private saveCandidate(candidate: BrowserSnapshotCandidate): void {
    this.owner.db.all("INSERT INTO umpi_browser_snapshot_cleanup VALUES (?,?) ON CONFLICT(id) DO UPDATE SET due=excluded.due", candidate.metadata.snapshotId, candidate.nextAttemptAt);
    this.saveValue("snapshot-cleanup", candidate.metadata.snapshotId, candidate);
  }
  private removeCandidate(id: string): void {
    this.owner.db.all("DELETE FROM umpi_browser_snapshot_cleanup WHERE id=?", id);
    this.owner.db.all("DELETE FROM umpi_browser_values WHERE kind='snapshot-cleanup' AND id=?", id);
  }
  admitSnapshot(metadata: BrowserSnapshotMetadata, now = Date.now()): BrowserSnapshotMetadata | undefined {
    return this.owner.db.transaction(() => {
      const intent = this.owner.effectResult<BrowserSnapshotMetadata>(`browser-upload:${metadata.snapshotId}`);
      if (intent && JSON.stringify(intent) !== JSON.stringify(metadata)) throw new StateError(409, "Browser snapshot identity already owns different encrypted state");
      if (this.owner.effectResult(`browser-delete:${metadata.snapshotId}`)) throw new StateError(409, "Browser snapshot is quarantined or deleting; uploads cannot be retried");
      const saved = this.snapshot(metadata.snapshotId);
      if (saved) { if (JSON.stringify(saved) !== JSON.stringify(metadata)) throw new StateError(409, "Snapshot identity already contains different immutable state"); return saved; }
      if (intent || this.snapshotCandidate(metadata.snapshotId)) throw new StateError(409, "Browser upload was already admitted without a confirmed commit; do not repeat it");
      if (this.snapshotCandidates().filter(candidate => candidate.status !== "deleting").length >= 64 || this.snapshots().length >= 256) throw new StateError(503, "Private browser snapshot cleanup requires attention before another upload");
      if (this.site(metadata.siteId)?.policyDigest !== metadata.policyDigest || Date.parse(metadata.expiresAt) <= now) throw new StateError(409, "Browser snapshot grant or expiry changed before upload");
      this.owner.effect(`browser-upload:${metadata.snapshotId}`, () => metadata);
      this.saveCandidate({ metadata, key: `browser/snapshots/${metadata.siteId}/${metadata.snapshotId}/${metadata.digest}.json`, status: "uploading", uncertain: true, nextAttemptAt: now + 5 * 60_000 });
      return undefined;
    });
  }
  saveSnapshot(metadata: BrowserSnapshotMetadata): BrowserSnapshotMetadata {
    return this.owner.db.transaction(() => {
      const previous = this.snapshot(metadata.snapshotId), candidate = this.snapshotCandidate(metadata.snapshotId);
      if (this.owner.effectResult(`browser-delete:${metadata.snapshotId}`)) throw new StateError(409, "Browser snapshot is quarantined or deleting");
      if (previous) { if (JSON.stringify(previous) !== JSON.stringify(metadata)) throw new StateError(409, "Snapshot identity already contains different immutable state"); return previous; }
      if (!candidate || candidate.status !== "uploading" || JSON.stringify(candidate.metadata) !== JSON.stringify(metadata) || this.owner.effectResult(`browser-delete:${metadata.snapshotId}`)) throw new StateError(409, "Browser upload is quarantined; a late receipt cannot make it usable");
      const site = this.site(metadata.siteId);
      if (site?.policyDigest !== metadata.policyDigest || site.domain && this.requestedSnapshotSite(site.siteId)?.policyDigest !== site.policyDigest || Date.parse(metadata.expiresAt) <= Date.now()) throw new StateError(409, "Browser grant, requested capture or expiry changed during upload; no new usable snapshot was admitted");
      this.owner.db.all("INSERT INTO umpi_browser_snapshots VALUES (?,?,?)", metadata.snapshotId, metadata.siteId, metadata.capturedAt);
      this.saveValue("snapshot", metadata.snapshotId, metadata); this.removeCandidate(metadata.snapshotId);
      return metadata;
    });
  }
  quarantineSnapshot(id: string, uncertain: boolean, now = Date.now()): void {
    this.owner.db.transaction(() => {
      const candidate = this.snapshotCandidate(id); if (!candidate || this.snapshot(id)) return;
      this.owner.effect(`browser-delete:${id}`, () => ({ key: candidate.key }));
      this.saveCandidate({ ...candidate, status: "quarantined", uncertain, nextAttemptAt: now });
    });
  }
  beginSnapshotDelete(id: string, now = Date.now()): BrowserSnapshotCandidate | undefined {
    return this.owner.db.transaction(() => {
      const snapshot = this.snapshot(id); if (!snapshot || this.snapshotPinned(id)) return;
      const existing = this.snapshotCandidate(id); if (existing) return existing;
      const key = this.snapshotObjectKey(id);
      this.owner.effect(`browser-delete:${id}`, () => ({ key }));
      const candidate: BrowserSnapshotCandidate = { metadata: snapshot, key, status: "deleting", uncertain: false, nextAttemptAt: now };
      this.saveCandidate(candidate); return candidate;
    });
  }
  finishSnapshotDelete(id: string, deleted: boolean, now = Date.now()): void {
    this.owner.db.transaction(() => {
      const candidate = this.snapshotCandidate(id); if (!candidate || candidate.status === "uploading") return;
      // DELETE acknowledgement cannot exclude a provider PUT completing later. Keep
      // uncertain candidates fenced and re-delete periodically; never invent a receipt.
      if (deleted && !this.snapshotPinned(id)) {
        this.owner.db.all("DELETE FROM umpi_browser_snapshots WHERE id=?", id);
        this.owner.db.all("DELETE FROM umpi_browser_values WHERE kind='snapshot' AND id=?", id);
        if (!candidate.uncertain) { this.removeCandidate(id); return; }
      }
      this.saveCandidate({ ...candidate, nextAttemptAt: now + 15 * 60_000 });
    });
  }
  deferSnapshotCleanup(id: string, due: number): void {
    this.owner.db.transaction(() => { const candidate = this.snapshotCandidate(id); if (candidate) this.saveCandidate({ ...candidate, nextAttemptAt: due }); });
  }
  snapshotPruneDue(): number | undefined { return this.value<number>("housekeeping", "snapshots"); }
  saveSnapshotPruneDue(due: number): void { this.owner.db.transaction(() => this.saveValue("housekeeping", "snapshots", due)); }
  snapshotPinned(id: string): boolean {
    return this.reviewedOrActive().some(task =>
      ["pending_approval", "queued"].includes(task.status) && task.selectedSnapshots.some(snapshot => snapshot.snapshotId === id) ||
      task.run !== undefined && (!task.run.stoppedAt || task.status === "uncertain" && !task.run.reconciledAt) && task.run.snapshots.some(snapshot => snapshot.snapshotId === id));
  }
  create(value: unknown, channel: Channel, parentSessionId: string): BrowserTask {
    const input = record(value);
    if (Object.keys(input).some(key => !["taskId", "prompt", "sites", "timeoutMs"].includes(key))) throw new InputError("Invalid browser task fields");
    if (this.owner.isBackgroundSession(parentSessionId) || this.owner.channelForSession(parentSessionId) !== channel) throw new StateError(403, "Browser tasks require an explicit foreground owner request");
    if (!Array.isArray(input.sites) || !input.sites.length || input.sites.length > MAX_BROWSER_SITES) throw new InputError("Choose explicit browser sites");
    const scopes = input.sites, timeoutMs = input.timeoutMs;
    if (!Number.isSafeInteger(timeoutMs) || Number(timeoutMs) < 1000 || Number(timeoutMs) > MAX_BROWSER_TIMEOUT_MS) throw new InputError("Invalid browser task deadline");
    const taskId = identifier(input.taskId, "browser task"), prompt = boundedText(input.prompt, MAX_BROWSER_PROMPT, "browser goal");
    return this.owner.db.transaction(() => {
      if (this.task(taskId)) throw new StateError(409, "Browser task identity already exists; correct the existing task");
      if (this.reviewedOrActive().length >= 64) throw new StateError(409, "Review or reconcile existing browser tasks before admitting more");
      const sites = scopes.map(value => {
        const scope = record(value);
        if (Object.keys(scope).some(key => !["siteId", "startUrl"].includes(key))) throw new InputError("Invalid browser site scope");
        let site: BrowserSite | undefined;
        if (scope.siteId !== undefined) site = this.site(identifier(scope.siteId, "browser site"));
        else {
          if (!this.settings().allSites) throw new StateError(403, "Browser website access is restricted to owner-configured sites");
          const policy = requestedBrowserSite(scope.startUrl);
          site = this.site(policy.siteId) ?? this.registerSite(policy, 0);
        }
        if (!site) throw new StateError(404, "Browser site is not owner-configured");
        return { site, startUrl: browserUrl(scope.startUrl, site.origins, this.allowLoopback, site.domain) };
      });
      if (new Set(sites.map(scope => scope.site.siteId)).size !== sites.length) throw new InputError("Duplicate browser task sites");
      return this.save({ taskId, prompt, sites, timeoutMs: Number(timeoutMs), version: 1, status: "pending_approval", target: "mac", selectedSnapshots: [], corrections: [], channel, parentSessionId, createdAt: iso(), updatedAt: iso() });
    });
  }
  requestCloud(id: string, expectedVersion: unknown, snapshotIds: unknown): BrowserTask {
    return this.owner.db.transaction(() => {
      const task = this.requireTask(id); this.version(task, expectedVersion);
      if (!["queued", "pending_approval"].includes(task.status) || task.run && !task.run.stoppedAt) throw new StateError(409, "Only unclaimed browser work with any prior owner stopped can move to cloud; silence never transfers ownership");
      if (!Array.isArray(snapshotIds) || snapshotIds.length > task.sites.length) throw new InputError("Choose at most one saved snapshot per site; omitted sites use no saved session");
      const snapshots = snapshotIds.map(id => { const snapshot = this.snapshot(identifier(id, "browser snapshot")); if (!snapshot || this.owner.effectResult(`browser-delete:${snapshot.snapshotId}`)) throw new StateError(404, "Browser snapshot unavailable"); return snapshot; });
      if (new Set(snapshots.map(snapshot => snapshot.siteId)).size !== snapshots.length) throw new InputError("Duplicate browser snapshot sites");
      for (const snapshot of snapshots) { const scope = task.sites.find(scope => scope.site.siteId === snapshot.siteId); if (!scope || snapshot.policyDigest !== scope.site.policyDigest || Date.parse(snapshot.expiresAt) <= Date.now() || Date.now() - Date.parse(snapshot.capturedAt) > BROWSER_SNAPSHOT_MAX_AGE_MS) throw new StateError(409, "Browser snapshot does not match the approved current site scope"); }
      return this.save({ ...task, version: task.version + 1, status: "pending_approval", target: "cloud", selectedSnapshots: snapshots, updatedAt: iso() });
    });
  }
  approve(id: string, expectedVersion: unknown): BrowserTask {
    return this.owner.db.transaction(() => {
      const task = this.requireTask(id); this.version(task, expectedVersion);
      if (task.status === "queued") return task;
      if (task.status !== "pending_approval") throw new StateError(409, "Only a pending browser task can be approved");
      for (const scope of task.sites) if (this.site(scope.site.siteId)?.policyDigest !== scope.site.policyDigest) throw new StateError(409, "Browser site policy changed since review");
      if (task.target === "cloud" && task.selectedSnapshots.some(snapshot => !this.snapshot(snapshot.snapshotId) || this.owner.effectResult(`browser-delete:${snapshot.snapshotId}`) || Date.parse(snapshot.expiresAt) <= Date.now() || Date.now() - Date.parse(snapshot.capturedAt) > BROWSER_SNAPSHOT_MAX_AGE_MS)) throw new StateError(409, "Approved browser snapshot is no longer within its current capture bound");
      for (const scope of task.sites) {
        this.owner.db.all("INSERT OR REPLACE INTO umpi_browser_snapshot_requests (id) VALUES (?)", scope.site.siteId);
        this.saveValue("snapshot-request", scope.site.siteId, scope.site);
      }
      return this.save({ ...task, status: "queued", updatedAt: iso() });
    });
  }
  correct(id: string, expectedVersion: unknown, textValue: unknown): BrowserTask {
    const text = boundedText(textValue, 8000, "browser correction").trim(); if (!text) throw new InputError("A browser correction must describe the change");
    return this.owner.db.transaction(() => {
      const task = this.requireTask(id); this.version(task, expectedVersion);
      if (["cancel_requested", "finishing", "uncertain", "failed", "cancelled"].includes(task.status) || task.corrections.length >= 32) throw new StateError(409, "This browser outcome must be reconciled before further work");
      const running = ["preparing", "running"].includes(task.status);
      const next = this.save({ ...task, version: task.version + 1, corrections: [...task.corrections, text], updatedAt: iso(), ...(running ? {} : { status: "pending_approval" as const, finish: undefined, result: undefined, issue: undefined }) });
      if (task.status === "running") this.addInput(next, text, false);
      return next;
    });
  }
  cancel(id: string, expectedVersion: unknown): BrowserTask {
    return this.owner.db.transaction(() => { const task = this.requireTask(id); this.version(task, expectedVersion); if (terminal.has(task.status)) return task; return this.save({ ...task, status: task.run && !task.run.stoppedAt ? "cancel_requested" : "cancelled", stopOutcome: "cancelled", issue: task.run && !task.run.stoppedAt ? "Browser stop requested; external effects are not rolled back" : "Cancelled before browsing", updatedAt: iso() }); });
  }
  private begin(task: BrowserTask, executorId: string): BrowserTask {
    const runId = randomUUID(), assignment = { taskId: task.taskId, runId, deadlineAt: iso(Date.now() + task.timeoutMs), sites: task.sites };
    return this.save({ ...task, status: "preparing", finish: undefined, result: undefined, issue: undefined, stopOutcome: undefined, updatedAt: iso(), run: { runId, target: task.target, executorId, assignment, snapshots: task.selectedSnapshots } });
  }
  claimCloud(): BrowserTask | undefined {
    return this.owner.db.transaction(() => { if (this.active().some(task => task.run?.target === "cloud" && (!task.run.stoppedAt || task.status === "uncertain" && !task.run.reconciledAt))) return; const task = this.active().find(task => task.target === "cloud" && task.status === "queued"); return task ? this.begin(task, `browser-cloud:${task.taskId}`) : undefined; });
  }
  executors(): BrowserExecutor[] { return this.owner.db.all<{ id: string }>("SELECT id FROM umpi_browser_executors ORDER BY rowid DESC LIMIT 32").map(row => this.value<BrowserExecutor>("executor", row.id)!); }
  poll(poll: BrowserExecutorPoll): BrowserExecutorPollResult {
    return this.owner.db.transaction(() => {
      this.owner.db.all("INSERT OR IGNORE INTO umpi_browser_executors VALUES (?)", poll.executorId); this.saveValue("executor", poll.executorId, { ...poll, lastSeenAt: iso() });
      let task = this.active().find(task => task.run?.target === "mac" && task.run.executorId === poll.executorId && (!task.run.stoppedAt || task.status === "uncertain" && !task.run.reconciledAt));
      if (task?.run?.stoppedAt) return { assignment: null, requests: [], cancel: false };
      if (poll.activeRunId && task?.run?.runId !== poll.activeRunId) { const prior = this.value<{ taskId: string; run: BrowserRun }>("run", poll.activeRunId); if (!prior || prior.run.executorId !== poll.executorId) throw new StateError(409, "Browser executor reported a foreign owner"); return { assignment: prior.run.assignment, requests: [], cancel: true }; }
      if (!task && poll.available && poll.activeRunId === null) { const queued = this.active().find(task => task.target === "mac" && task.status === "queued" && task.sites.every(scope => poll.allSites ? scope.site.origins.every(origin => { try { browserPublicUrl(origin); return true; } catch { return false; } }) : poll.sites.some(site => site.siteId === scope.site.siteId && site.policyDigest === scope.site.policyDigest))); if (queued) task = this.begin(queued, poll.executorId); }
      if (!task?.run) return { assignment: null, requests: [], cancel: false };
      this.expire(); task = this.requireTask(task.taskId);
      const cancelled = ["cancel_requested", "uncertain"].includes(task.status) || task.status === "finishing";
      const requests = cancelled ? [] : this.pendingOperations(task.run!.runId).slice(0, 16).map(operation => { this.dispatched(operation.request.operationId); return operation.request; });
      return { assignment: task.run!.assignment, requests, cancel: cancelled };
    });
  }
  currentRun(taskId: string, runId: string): BrowserTask { const task = this.requireTask(taskId); if (task.run?.runId !== runId) throw new StateError(409, "This browser operation belongs to an older run"); return task; }
  ownedRun(taskId: string, runId: string): BrowserRun { const saved = this.value<{ taskId: string; run: BrowserRun }>("run", runId); if (!saved || saved.taskId !== taskId) throw new StateError(404, "Browser run not found"); return saved.run; }
  runs(taskId: string): BrowserRun[] { this.requireTask(taskId); return this.owner.db.all<{ id: string }>("SELECT id FROM umpi_browser_runs WHERE task_id=? ORDER BY rowid DESC LIMIT 64", taskId).map(row => this.ownedRun(taskId, row.id)); }
  assertRunning(taskId: string, runId: string): BrowserTask { const task = this.currentRun(taskId, runId); if (task.status !== "running" || task.run!.stoppedAt || Date.parse(task.run!.assignment.deadlineAt) <= Date.now()) throw new StateError(409, "Browser execution is no longer authorized"); return task; }
  ready(taskId: string, runId: string): void { this.owner.db.transaction(() => { const task = this.currentRun(taskId, runId); if (task.run!.readyAt || task.status !== "preparing") return; const next = this.save({ ...task, status: "running", run: { ...task.run!, readyAt: iso() }, updatedAt: iso() }); this.addInput(next, next.prompt + (next.corrections.length ? `\n\nOwner corrections:\n${next.corrections.join("\n\n")}` : ""), true); }); }
  startDispatched(taskId: string, runId: string): void { this.owner.db.transaction(() => { const task = this.currentRun(taskId, runId); if (task.status !== "preparing") throw new StateError(409, "Browser start is no longer approved"); this.save({ ...task, run: { ...task.run!, startDispatchedAt: task.run!.startDispatchedAt ?? iso() } }); }); }
  session(taskId: string, sessionId: string): void { this.owner.db.transaction(() => { const task = this.requireTask(taskId), previous = this.forSession(sessionId); if (task.sessionId && task.sessionId !== sessionId || previous && previous.taskId !== taskId || this.owner.isBackgroundSession(sessionId) || [this.owner.session("control"), this.owner.session("telegram")].includes(sessionId)) throw new StateError(409, "That browser conversation has another owner"); this.owner.db.all("INSERT OR IGNORE INTO umpi_browser_sessions VALUES (?,?)", sessionId, taskId); this.save({ ...task, sessionId }); }); }
  forSession(sessionId: string): BrowserTask | undefined { const row = this.owner.db.all<{ task_id: string }>("SELECT task_id FROM umpi_browser_sessions WHERE id=?", sessionId)[0]; return row ? this.task(row.task_id) : undefined; }
  private addInput(task: BrowserTask, text: string, initial: boolean): void { const input: BrowserInput = { taskId: task.taskId, runId: task.run!.runId, operationId: `browser-input:${randomUUID()}`, text, initial, status: "pending" }; this.owner.db.all("INSERT INTO umpi_browser_inputs VALUES (?,?,?,?)", input.operationId, input.taskId, input.runId, input.status); this.saveValue("input", input.operationId, input); }
  inputs(): BrowserInput[] { return this.owner.db.all<{ id: string }>("SELECT id FROM umpi_browser_inputs WHERE status!='done' ORDER BY rowid").map(row => this.value<BrowserInput>("input", row.id)!); }
  inputState(id: string, status: BrowserInput["status"]): void { this.owner.db.transaction(() => { const input = this.value<BrowserInput>("input", id); if (!input || input.status === "done") return; this.owner.db.all("UPDATE umpi_browser_inputs SET status=? WHERE id=?", status, id); this.saveValue("input", id, { ...input, status }); }); }
  operation(id: string): BrowserRpcRecord | undefined { return this.value("rpc", id); }
  pendingOperations(runId: string): BrowserRpcRecord[] { return this.owner.db.all<{ id: string }>("SELECT id FROM umpi_browser_rpc WHERE run_id=? AND status IN ('pending','running') ORDER BY rowid", runId).map(row => this.operation(row.id)!); }
  operations(runId: string): BrowserRpcRecord[] { return this.owner.db.all<{ id: string }>("SELECT id FROM umpi_browser_rpc WHERE run_id=? ORDER BY rowid", runId).map(row => this.operation(row.id)!); }
  recentObservations(runId: string): { operationId: string; siteId: string; snapshotId: string; url: string; title: string }[] {
    return this.owner.db.all<{ id: string }>("SELECT id FROM umpi_browser_rpc WHERE run_id=? AND observation=1 ORDER BY rowid DESC LIMIT 16", runId).map(row => {
      const observation = this.operation(row.id)!.receipt!.observation!;
      return { operationId: row.id, siteId: observation.siteId, snapshotId: observation.snapshotId, url: observation.url, title: observation.title };
    }).reverse();
  }
  enqueue(taskId: string, runId: string, value: unknown): BrowserRpcRecord {
    const request = parseBrowserRequest(value);
    return this.owner.db.transaction(() => {
      const task = this.assertRunning(taskId, runId);
      if (!request.operationId.startsWith(browserOperationPrefix(taskId, runId))) throw new StateError(403, "Browser operation is outside its run");
      const scope = task.sites.find(scope => scope.site.siteId === request.action.siteId); if (!scope) throw new StateError(403, "Browser operation is outside its site grant");
      if (request.action.kind === "navigate") browserUrl(request.action.url, scope.site.origins, this.allowLoopback, scope.site.domain);
      const previous = this.operation(request.operationId); if (previous) { if (JSON.stringify(previous.request) !== JSON.stringify(request)) throw new StateError(409, "Browser operation already contains different arguments"); return previous; }
      if (this.owner.db.all<{ count: number }>("SELECT COUNT(*) AS count FROM umpi_browser_rpc WHERE run_id=?", runId)[0]!.count >= MAX_BROWSER_OPERATIONS) throw new StateError(409, "Browser operation limit reached");
      const operation = { taskId, runId, request, dispatched: false }; this.owner.db.all("INSERT INTO umpi_browser_rpc (id,task_id,run_id,status) VALUES (?,?,?,?)", request.operationId, taskId, runId, "pending"); this.saveValue("rpc", request.operationId, operation); return operation;
    });
  }
  dispatched(id: string): void { this.owner.db.transaction(() => { const operation = this.operation(id); if (operation && !operation.dispatched) this.saveValue("rpc", id, { ...operation, dispatched: true }); }); }
  receipt(taskId: string, runId: string, value: unknown): void {
    const receipt = parseBrowserReceipt(value);
    this.owner.db.transaction(() => {
      const task = this.currentRun(taskId, runId), operation = this.operation(receipt.operationId);
      if (!operation || operation.taskId !== taskId || operation.runId !== runId || !operation.dispatched) throw new StateError(403, "Browser receipt has no dispatched owner");
      if (operation.receipt && operation.receipt.status !== "running") { if (JSON.stringify(operation.receipt) !== JSON.stringify(receipt)) throw new StateError(409, "Terminal browser receipt is immutable"); return; }
      if ((receipt.observation?.siteId ?? receipt.image?.siteId ?? operation.request.action.siteId) !== operation.request.action.siteId) throw new StateError(409, "Browser receipt changed site ownership");
      const location = receipt.observation?.url ?? receipt.image?.url, scope = task.sites.find(scope => scope.site.siteId === operation.request.action.siteId)!; if (location) browserUrl(location, scope.site.origins, this.allowLoopback, scope.site.domain);
      const bytes = new TextEncoder().encode(JSON.stringify(receipt)).length;
      const stored = this.owner.db.all<{ bytes: number }>("SELECT SUM(bytes) AS bytes FROM umpi_browser_rpc WHERE run_id=? AND id!=?", runId, receipt.operationId)[0]?.bytes ?? 0;
      if (stored + bytes > 16 * 1024 * 1024) throw new StateError(413, "Browser run output budget exceeded");
      this.owner.db.all("UPDATE umpi_browser_rpc SET status=?,observation=?,bytes=? WHERE id=?", receipt.status, receipt.observation ? 1 : 0, bytes, receipt.operationId); this.saveValue("rpc", receipt.operationId, { ...operation, receipt });
      if (receipt.status === "uncertain") this.uncertain(taskId, "The browser owner cannot confirm an interrupted action; do not repeat it");
    });
  }
  requestFinish(taskId: string, runId: string, value: unknown): void {
    const input = record(value), summary = boundedText(input.summary, 8000, "browser result");
    if (Object.keys(input).some(key => !["summary", "expectedVersion", "outcome", "observationIds"].includes(key))) throw new InputError("Invalid browser completion fields");
    if (input.outcome !== "completed" && input.outcome !== "needs_input" && input.outcome !== "blocked") throw new InputError("Invalid browser completion outcome");
    const outcome = input.outcome;
    this.owner.db.transaction(() => {
      const task = this.assertRunning(taskId, runId); this.version(task, input.expectedVersion);
      if (!Array.isArray(input.observationIds) || input.observationIds.length > 16 || new Set(input.observationIds).size !== input.observationIds.length) throw new InputError("Invalid browser completion observations");
      if (this.pendingOperations(runId).length) throw new StateError(409, "Browser operations have not settled");
      const evidence = input.observationIds.map(id => { const operation = this.operation(boundedText(id, 512, "browser observation operation")); if (!operation || operation.runId !== runId || operation.receipt?.status !== "done" || !operation.receipt.observation) throw new StateError(409, "Completion requires actual owned observations"); const observation = operation.receipt.observation; return { siteId: observation.siteId, url: observation.url, observationId: observation.snapshotId }; });
      if (input.outcome === "completed" && !evidence.length) throw new StateError(409, "Completion requires actual browser evidence");
      this.save({ ...task, status: "finishing", finish: { outcome, summary, evidence }, updatedAt: iso() });
    });
  }
  fail(id: string, issue: string): void { this.owner.db.transaction(() => { const task = this.requireTask(id); if (terminal.has(task.status)) return; this.save({ ...task, status: task.run && !task.run.stoppedAt ? "cancel_requested" : "failed", stopOutcome: "failed", issue, updatedAt: iso() }); }); }
  uncertain(id: string, issue: string): void { this.owner.db.transaction(() => { const task = this.requireTask(id); if (task.run?.stoppedAt && task.status !== "uncertain") return; this.save({ ...task, status: "uncertain", issue, updatedAt: iso() }); }); }
  stopped(taskId: string, runId: string, uncertain: boolean, issue?: string, ownerConfirmedStopped = false): void {
    this.owner.db.transaction(() => {
      const task = this.currentRun(taskId, runId); if (task.run!.stoppedAt && !ownerConfirmedStopped) return;
      for (const operation of this.pendingOperations(runId)) if (!operation.dispatched) {
        this.owner.db.all("UPDATE umpi_browser_rpc SET status='failed' WHERE id=?", operation.request.operationId);
        this.saveValue("rpc", operation.request.operationId, { ...operation, receipt: { operationId: operation.request.operationId, status: "failed", error: "Browser stopped before this operation was dispatched" } });
      }
      const unresolved = this.pendingOperations(runId).filter(operation => operation.dispatched);
      if (!uncertain && unresolved.length) uncertain = true;
      const run: BrowserRun = { ...task.run!, stoppedAt: iso(), ...(ownerConfirmedStopped ? { reconciledAt: iso() } : {}) };
      const status: BrowserStatus = uncertain || task.status === "uncertain" && !ownerConfirmedStopped ? "uncertain" : task.stopOutcome ?? (task.finish ? task.finish.outcome === "completed" ? "completed" : task.finish.outcome === "needs_input" ? "waiting_input" : "blocked" : "failed");
      const result = !uncertain && task.finish ? task.finish : undefined; run.result = result;
      this.save({ ...task, status, run, result, issue: task.issue ?? issue ?? (status === "failed" ? "Browser ended without structured completion" : undefined), updatedAt: iso() });
    });
  }
  reconcile(taskId: string, expectedVersion: unknown): BrowserTask { return this.owner.db.transaction(() => { const task = this.requireTask(taskId); this.version(task, expectedVersion); if (task.status !== "uncertain" || !task.run?.stoppedAt) throw new StateError(409, "Reconciliation requires the retained owner's actual stop receipt"); const next = this.save({ ...task, status: "failed", run: { ...task.run, reconciledAt: iso() }, issue: "Prior browser owner is confirmed stopped; uncertain effects were not replayed", updatedAt: iso() }); return next; }); }
  expire(now = Date.now()): void { for (const task of this.active()) if (task.run && !task.run.stoppedAt && active.has(task.status) && Date.parse(task.run.assignment.deadlineAt) <= now) this.fail(task.taskId, "Approved browser deadline expired; waiting for actual stop"); }
  private feedback(task: BrowserTask): void {
    const key = `browser-feedback:${task.taskId}:${task.run?.runId ?? `version-${task.version}`}:${task.status}`;
    const result = task.result ? { outcome: task.result.outcome, summary: task.result.summary, evidenceCount: task.result.evidence.length } : null;
    this.owner.effect(key, () => this.owner.admitResult(`browser-result:${randomUUID()}`, `Browser task outcome (external effects are not rolled back).\n${JSON.stringify({ taskId: task.taskId, status: task.status, stopConfirmed: !task.run || Boolean(task.run.stoppedAt), issue: task.issue ?? null, result })}`, task.channel, task.parentSessionId));
  }
}
