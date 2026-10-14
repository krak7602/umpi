import { closeSync, existsSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MAX_BROWSER_OPERATIONS, MAX_BROWSER_TIMEOUT_MS, browserOperationPrefix, browserPublicUrl, browserSitePolicyJson, browserUrl, parseBrowserAssignment, parseBrowserReceipt, parseBrowserRequest, parseBrowserSite } from "../shared/browser.js";
import type { BrowserAssignment, BrowserExecutorPoll, BrowserExecutorPollResult, BrowserExecutorReport, BrowserReceipt, BrowserRequest } from "../shared/browser.js";
import { coordinatorUrl } from "../shared/coordinator-url.ts";
import { record } from "../shared/protocol.js";
import { privateDirectory, privateFile } from "./config.js";
import type { MacConfig } from "./config.js";
import { AsideBrowserBridge, BrowserActionRejected } from "./browser-aside.js";
import type { NativeBrowserBridge } from "./browser-aside.js";

type StoppedReport = Extract<BrowserExecutorReport, { kind: "stopped" }>;
interface StoredRun { run_id: string; assignment: string; phase: "active" | "stopped"; stop_report: string | null; stop_acknowledged: number }
interface StoredOperation { operation_id: string; run_id: string; request_digest: string; request: string; phase: "admitted" | "dispatched" | "terminal"; receipt: string }
interface StoredTab { site_id: string; target_id: string | null; phase: "opening" | "owned" | "ready" | "closed" }
interface PendingReport { key: string; payload: string }
export interface BrowserJournalStatus {
  recoveryPaused: boolean;
  outstanding: { taskId: string; runId: string; phase: "active" | "stopped"; uncertain: boolean; ownedTabs: number; unknownTabs: number }[];
  unacknowledgedReports: number;
  recordedRuns: number;
  recordedOperations: number;
}
function reportKey(runId: string, kind: string, operationId = ""): string { return `${runId.length}:${runId}:${kind}:${operationId}`; }
function policyDigest(site: Parameters<typeof browserSitePolicyJson>[0]): string { return createHash("sha256").update(browserSitePolicyJson(site)).digest("hex"); }

function journalStatus(database: DatabaseSync): BrowserJournalStatus {
  const pausedRow = database.prepare("SELECT value FROM meta WHERE key='recovery_paused'").get();
  const paused = pausedRow?.value === "1";
  const runs = database.prepare("SELECT * FROM runs WHERE phase='active' OR stop_acknowledged=0 OR (?=1 AND json_extract(stop_report,'$.uncertain')=1) ORDER BY rowid").all(Number(paused)) as unknown as StoredRun[];
  const reports = database.prepare("SELECT COUNT(*) AS n FROM reports WHERE acknowledged=0").get();
  const recordedRuns = database.prepare("SELECT COUNT(*) AS n FROM runs").get();
  const operations = database.prepare("SELECT COUNT(*) AS n FROM operations").get();
  return {
    recoveryPaused: paused,
    outstanding: runs.map(run => {
      const assignment = parseBrowserAssignment(JSON.parse(run.assignment), true);
      const tabs = database.prepare("SELECT target_id FROM tabs WHERE run_id=? AND phase!='closed'").all(run.run_id);
      const stopReport = run.stop_report === null ? null : record(JSON.parse(run.stop_report));
      const unknownPopup = database.prepare("SELECT value FROM meta WHERE key=?").get(`popup_uncertain:${run.run_id}`)?.value === "1";
      return { taskId: assignment.taskId, runId: assignment.runId, phase: run.phase, uncertain: stopReport?.uncertain === true || unknownPopup, ownedTabs: tabs.filter(tab => tab.target_id !== null).length, unknownTabs: tabs.filter(tab => tab.target_id === null).length + Number(unknownPopup) };
    }),
    unacknowledgedReports: Number(reports?.n),
    recordedRuns: Number(recordedRuns?.n),
    recordedOperations: Number(operations?.n),
  };
}

/** Independent one-task lane, with its own lock and private identity-bound state. */
export class BrowserJournal {
  private readonly database: DatabaseSync;
  private readonly lock: DatabaseSync;
  private closed = false;
  readonly directory: string;
  readonly executorId: string;
  readonly serverUrl: string;
  readonly allowLoopback: boolean;
  constructor(directory: string, config: Pick<MacConfig, "executorId" | "serverUrl">) {
    this.directory = privateDirectory(directory);
    this.executorId = config.executorId;
    this.serverUrl = coordinatorUrl(config.serverUrl).origin;
    this.allowLoopback = ["localhost", "127.0.0.1", "[::1]"].includes(new URL(this.serverUrl).hostname);
    const lockPath = join(this.directory, "browser-lock.sqlite");
    const path = join(this.directory, "browser.sqlite");
    closeSync(privateFile(lockPath, true)); closeSync(privateFile(path, true));
    this.lock = new DatabaseSync(lockPath);
    try { this.lock.exec("PRAGMA busy_timeout=0; BEGIN EXCLUSIVE"); }
    catch { this.lock.close(); throw new Error("Browser state is already in use"); }
    let database: DatabaseSync | undefined;
    try {
      database = new DatabaseSync(path); this.database = database;
      database.exec(`
        PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
        CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS runs (run_id TEXT PRIMARY KEY, assignment TEXT NOT NULL, phase TEXT NOT NULL CHECK(phase IN ('active','stopped')), stop_report TEXT, stop_acknowledged INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE IF NOT EXISTS operations (operation_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, request_digest TEXT NOT NULL, request TEXT NOT NULL, phase TEXT NOT NULL CHECK(phase IN ('admitted','dispatched','terminal')), receipt TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS tabs (run_id TEXT NOT NULL, site_id TEXT NOT NULL, marker TEXT NOT NULL UNIQUE, target_id TEXT UNIQUE, phase TEXT NOT NULL CHECK(phase IN ('opening','owned','ready','closed')), PRIMARY KEY(run_id,site_id));
        CREATE TABLE IF NOT EXISTS reports (report_key TEXT PRIMARY KEY, run_id TEXT NOT NULL, payload TEXT NOT NULL, acknowledged INTEGER NOT NULL DEFAULT 0);
      `);
      for (const [key, value] of [["executor_id", this.executorId], ["server_url", this.serverUrl]] as const) {
        const existing = database.prepare("SELECT value FROM meta WHERE key=?").get(key) as { value: string } | undefined;
        if (existing && existing.value !== value) throw new Error("Browser journal belongs to another executor or coordinator");
        database.prepare("INSERT OR IGNORE INTO meta VALUES (?,?)").run(key, value);
      }
      for (const row of database.prepare("SELECT * FROM runs WHERE phase='active'").all() as unknown as StoredRun[]) {
        const assignment = parseBrowserAssignment(JSON.parse(row.assignment), this.allowLoopback);
        this.settlePending(assignment);
        if (this.tabs(assignment.runId).length) this.notePopupUncertainty(assignment);
        this.stopped(assignment, true, true, "Executor restarted with an accepted browser run; no action was replayed. Prior owned tabs and possible unowned popups require explicit owner stopped reconciliation.");
      }
    } catch (error) { database?.close(); this.lock.close(); throw error; }
  }
  private transaction<T>(run: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try { const value = run(); this.database.exec("COMMIT"); return value; }
    catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }
  private stored(runId: string): StoredRun | undefined { return this.database.prepare("SELECT * FROM runs WHERE run_id=?").get(runId) as StoredRun | undefined; }
  get activeRunId(): string | null {
    const row = this.database.prepare("SELECT run_id FROM runs WHERE phase='active' OR stop_acknowledged=0 ORDER BY rowid LIMIT 1").get();
    return typeof row?.run_id === "string" ? row.run_id : null;
  }
  get recoveryPaused(): boolean {
    const row = this.database.prepare("SELECT value FROM meta WHERE key='recovery_paused'").get();
    return row?.value === "1";
  }
  accept(input: BrowserAssignment): "new" | "active" | "stopped" {
    const assignment = parseBrowserAssignment(input, this.allowLoopback), encoded = JSON.stringify(assignment), existing = this.stored(assignment.runId);
    if (existing) { if (existing.assignment !== encoded) throw new Error("Coordinator changed an immutable browser assignment"); return existing.phase; }
    if (this.activeRunId !== null || this.recoveryPaused) throw new Error("Browser run overlaps unreconciled work");
    this.database.prepare("INSERT INTO runs (run_id,assignment,phase) VALUES (?,?,'active')").run(assignment.runId, encoded);
    return "new";
  }
  private assertActive(assignment: BrowserAssignment): void {
    const run = this.stored(assignment.runId);
    if (!run || run.phase !== "active" || run.assignment !== JSON.stringify(parseBrowserAssignment(assignment, this.allowLoopback))) throw new Error("Browser action requires its immutable active grant");
  }
  private enqueue(key: string, report: BrowserExecutorReport): void {
    const payload = JSON.stringify(report), existing = this.database.prepare("SELECT payload FROM reports WHERE report_key=?").get(key) as { payload: string } | undefined;
    if (existing?.payload === payload) return;
    if (existing) {
      const prior = record(JSON.parse(existing.payload));
      if (report.kind !== "receipt" || prior.kind !== "receipt" || parseBrowserReceipt(prior.receipt).status !== "running") throw new Error("Terminal browser reports are immutable");
    }
    this.database.prepare("INSERT INTO reports VALUES (?,?,?,0) ON CONFLICT(report_key) DO UPDATE SET payload=excluded.payload,acknowledged=0").run(key, report.runId, payload);
  }
  ready(assignment: BrowserAssignment): void {
    this.assertActive(assignment);
    if (this.tabs(assignment.runId).length !== assignment.sites.length || this.tabs(assignment.runId).some(tab => tab.phase !== "ready")) throw new Error("Browser readiness requires owned ready tabs");
    this.enqueue(reportKey(assignment.runId, "ready"), { kind: "ready", executorId: this.executorId, taskId: assignment.taskId, runId: assignment.runId });
  }
  openingTab(assignment: BrowserAssignment, siteId: string): string {
    this.assertActive(assignment);
    if (!assignment.sites.some(scope => scope.site.siteId === siteId)) throw new Error("Tab is outside its assigned sites");
    const marker = `about:blank#umpi-browser-${randomBytes(32).toString("hex")}`;
    this.database.prepare("INSERT INTO tabs VALUES (?,?,?,NULL,'opening')").run(assignment.runId, siteId, marker);
    return marker;
  }
  ownedTab(runId: string, siteId: string, targetId: string): void {
    if (!/^[A-Za-z0-9_.:-]{1,256}$/.test(targetId)) throw new Error("Invalid owned browser target");
    const result = this.database.prepare("UPDATE tabs SET target_id=?,phase='owned' WHERE run_id=? AND site_id=? AND phase='opening' AND target_id IS NULL").run(targetId, runId, siteId);
    if (result.changes !== 1) throw new Error("Browser target ownership was already assigned");
  }
  tabReady(runId: string, siteId: string): void { this.database.prepare("UPDATE tabs SET phase='ready' WHERE run_id=? AND site_id=? AND phase='owned'").run(runId, siteId); }
  tabs(runId: string): StoredTab[] { return this.database.prepare("SELECT site_id,target_id,phase FROM tabs WHERE run_id=? ORDER BY rowid").all(runId) as unknown as StoredTab[]; }
  tabsClosed(runId: string): void { this.database.prepare("UPDATE tabs SET phase='closed' WHERE run_id=? AND target_id IS NOT NULL").run(runId); }
  notePopupUncertainty(assignment: BrowserAssignment): void {
    this.assertActive(assignment);
    this.database.prepare("INSERT OR REPLACE INTO meta VALUES (?, '1')").run(`popup_uncertain:${assignment.runId}`);
  }
  hasPopupUncertainty(runId: string): boolean {
    return this.database.prepare("SELECT value FROM meta WHERE key=?").get(`popup_uncertain:${runId}`)?.value === "1";
  }
  stoppedAssignments(): BrowserAssignment[] {
    const rows = this.database.prepare("SELECT assignment FROM runs WHERE phase='stopped'").all();
    return rows.map(row => parseBrowserAssignment(JSON.parse(String(row.assignment)), this.allowLoopback));
  }
  admit(assignment: BrowserAssignment, input: BrowserRequest): { fresh: boolean; receipt: BrowserReceipt } {
    const grant = this.stored(assignment.runId);
    if (!grant || grant.assignment !== JSON.stringify(parseBrowserAssignment(assignment, this.allowLoopback))) throw new Error("Browser receipt replay requires its immutable grant");
    const request = parseBrowserRequest(input), encoded = JSON.stringify(request), digest = createHash("sha256").update(encoded).digest("hex");
    if (!request.operationId.startsWith(browserOperationPrefix(assignment.taskId, assignment.runId)) || request.operationId.length <= browserOperationPrefix(assignment.taskId, assignment.runId).length) throw new Error("Browser operation identity is outside its task run");
    const existing = this.database.prepare("SELECT * FROM operations WHERE operation_id=?").get(request.operationId) as StoredOperation | undefined;
    if (existing) {
      if (existing.run_id !== assignment.runId || existing.request_digest !== digest || existing.request !== encoded) throw new Error("Browser operation identity was reused with different input");
      this.requestResend(assignment.runId, request.operationId);
      return { fresh: false, receipt: parseBrowserReceipt(JSON.parse(existing.receipt)) };
    }
    if (!assignment.sites.some(scope => scope.site.siteId === request.action.siteId)) throw new Error("Browser request is outside its assigned sites");
    const count = this.database.prepare("SELECT COUNT(*) AS n FROM operations WHERE run_id=?").get(assignment.runId);
    if (Number(count?.n) >= MAX_BROWSER_OPERATIONS) throw new Error("Browser operation limit reached");
    const receipt: BrowserReceipt = grant.phase === "stopped"
      ? { operationId: request.operationId, status: "failed", error: "Browser run stopped before this request was admitted; no effect was performed." }
      : { operationId: request.operationId, status: "running" };
    this.transaction(() => {
      this.database.prepare("INSERT INTO operations VALUES (?,?,?,?,?,?)").run(request.operationId, assignment.runId, digest, encoded, grant.phase === "stopped" ? "terminal" : "admitted", JSON.stringify(receipt));
      this.enqueue(reportKey(assignment.runId, "receipt", request.operationId), { kind: "receipt", executorId: this.executorId, taskId: assignment.taskId, runId: assignment.runId, receipt });
    });
    return { fresh: true, receipt };
  }
  dispatch(assignment: BrowserAssignment, operationId: string): void {
    this.assertActive(assignment);
    if (this.database.prepare("UPDATE operations SET phase='dispatched' WHERE operation_id=? AND run_id=? AND phase='admitted'").run(operationId, assignment.runId).changes !== 1) throw new Error("Browser dispatch requires durable unused admission");
  }
  receipt(assignment: BrowserAssignment, input: BrowserReceipt): void {
    const receipt = parseBrowserReceipt(input), existing = this.database.prepare("SELECT * FROM operations WHERE operation_id=? AND run_id=?").get(receipt.operationId, assignment.runId) as StoredOperation | undefined;
    if (!existing || receipt.status === "running") throw new Error("Terminal browser result has no admission");
    const payload = JSON.stringify(receipt);
    if (existing.phase === "terminal") { if (existing.receipt !== payload) throw new Error("A terminal browser receipt is immutable"); return; }
    this.transaction(() => {
      this.database.prepare("UPDATE operations SET phase='terminal',receipt=? WHERE operation_id=?").run(payload, receipt.operationId);
      this.enqueue(reportKey(assignment.runId, "receipt", receipt.operationId), { kind: "receipt", executorId: this.executorId, taskId: assignment.taskId, runId: assignment.runId, receipt });
    });
  }
  result(operationId: string): BrowserReceipt | undefined { const row = this.database.prepare("SELECT receipt FROM operations WHERE operation_id=?").get(operationId) as { receipt: string } | undefined; return row && parseBrowserReceipt(JSON.parse(row.receipt)); }
  settlePending(assignment: BrowserAssignment): boolean {
    let uncertain = false;
    for (const row of this.database.prepare("SELECT * FROM operations WHERE run_id=? AND phase!='terminal'").all(assignment.runId) as unknown as StoredOperation[]) {
      uncertain ||= row.phase === "dispatched";
      this.receipt(assignment, { operationId: row.operation_id, status: row.phase === "dispatched" ? "uncertain" : "failed", error: row.phase === "dispatched" ? "Browser operation was interrupted after dispatch; its effects were not replayed." : "Browser operation stopped before dispatch; no effect was performed." });
    }
    return uncertain || !!this.database.prepare("SELECT 1 FROM operations WHERE run_id=? AND json_extract(receipt,'$.status')='uncertain' LIMIT 1").get(assignment.runId);
  }
  stopped(assignment: BrowserAssignment, stopped: boolean, uncertain: boolean, issue?: string): void {
    const existing = this.stored(assignment.runId);
    if (!existing || existing.assignment !== JSON.stringify(parseBrowserAssignment(assignment, this.allowLoopback))) throw new Error("Cannot stop an unowned or changed browser grant");
    if (existing.phase === "stopped") return;
    stopped &&= this.tabs(assignment.runId).every(tab => tab.phase === "closed");
    uncertain ||= !stopped || this.hasPopupUncertainty(assignment.runId);
    const report: StoppedReport = { kind: "stopped", executorId: this.executorId, taskId: assignment.taskId, runId: assignment.runId, stopped, uncertain, ...(issue ? { issue } : {}) };
    this.transaction(() => {
      this.database.prepare("DELETE FROM reports WHERE report_key=?").run(reportKey(assignment.runId, "ready"));
      this.enqueue(reportKey(assignment.runId, "stopped"), report);
      this.database.prepare("UPDATE runs SET phase='stopped',stop_report=?,stop_acknowledged=0 WHERE run_id=?").run(JSON.stringify(report), assignment.runId);
      if (uncertain) this.database.prepare("INSERT OR REPLACE INTO meta VALUES ('recovery_paused','1')").run();
    });
  }
  /** Explicit owner assertion, not proof derived from a lost RPC or a report replay. */
  confirmStopped(): void {
    this.transaction(() => {
      if (this.database.prepare("SELECT 1 FROM runs WHERE phase='active'").get()) throw new Error("Cannot confirm stopped while this browser journal has active work");
      for (const row of this.database.prepare("SELECT * FROM runs WHERE json_extract(stop_report,'$.uncertain')=1 AND NOT EXISTS(SELECT 1 FROM reports WHERE run_id=runs.run_id AND json_extract(payload,'$.ownerConfirmedStopped')=1)").all() as unknown as StoredRun[]) {
        const report = JSON.parse(row.stop_report!) as StoppedReport;
        this.enqueue(reportKey(row.run_id, "owner-stopped"), { ...report, stopped: true, ownerConfirmedStopped: true, issue: "Owner explicitly confirmed prior browser work has stopped. Prior uncertain receipts remain immutable; no action was replayed." });
        this.database.prepare("UPDATE runs SET stop_acknowledged=0 WHERE run_id=?").run(row.run_id);
      }
      this.database.prepare("INSERT OR REPLACE INTO meta VALUES ('recovery_paused','0')").run();
    });
  }
  requestResend(runId: string, operationId?: string): void { if (operationId === undefined) this.database.prepare("UPDATE reports SET acknowledged=0 WHERE run_id=?").run(runId); else this.database.prepare("UPDATE reports SET acknowledged=0 WHERE report_key=?").run(reportKey(runId, "receipt", operationId)); }
  pendingReports(): PendingReport[] { return this.database.prepare("SELECT report_key AS key,payload FROM reports WHERE acknowledged=0 ORDER BY CASE WHEN json_extract(payload,'$.kind')='receipt' THEN 0 WHEN json_extract(payload,'$.ownerConfirmedStopped')=1 THEN 2 ELSE 1 END,rowid").all() as unknown as PendingReport[]; }
  acknowledge(report: PendingReport): void {
    this.transaction(() => {
      this.database.prepare("UPDATE reports SET acknowledged=1 WHERE report_key=? AND payload=?").run(report.key, report.payload);
      const payload = JSON.parse(report.payload) as BrowserExecutorReport;
      this.database.prepare("UPDATE runs SET stop_acknowledged=1 WHERE run_id=? AND phase='stopped' AND NOT EXISTS(SELECT 1 FROM reports WHERE run_id=? AND acknowledged=0)").run(payload.runId, payload.runId);
    });
  }
  snapshot(): BrowserJournalStatus { return journalStatus(this.database); }
  close(): void { if (this.closed) return; this.closed = true; try { this.database.close(); } finally { this.lock.close(); } }
}

export function readBrowserJournalStatus(directory: string): BrowserJournalStatus | null {
  const path = join(privateDirectory(directory, false), "browser.sqlite");
  if (!existsSync(path)) return null;
  closeSync(privateFile(path)); const database = new DatabaseSync(path, { readOnly: true });
  try { return journalStatus(database); } finally { database.close(); }
}
export function parseBrowserPollResult(value: unknown, allowLoopback = false): BrowserExecutorPollResult {
  const input = record(value);
  if (Object.keys(input).some(key => !["assignment", "requests", "cancel"].includes(key)) || !Array.isArray(input.requests) || input.requests.length > MAX_BROWSER_OPERATIONS || typeof input.cancel !== "boolean") throw new Error("Invalid browser poll result");
  const assignment = input.assignment === null ? null : parseBrowserAssignment(input.assignment, allowLoopback);
  if (!assignment && (input.requests.length || input.cancel)) throw new Error("Browser work has no run assignment");
  const requests = input.requests.map(parseBrowserRequest);
  if (new Set(requests.map(request => request.operationId)).size !== requests.length) throw new Error("Duplicate browser operations in a poll");
  return { assignment, requests, cancel: input.cancel };
}

interface ActiveRun { assignment: BrowserAssignment; bridge: NativeBrowserBridge; queue: Promise<void>; deadline: NodeJS.Timeout; stopping?: Promise<void>; uncertain: boolean; ready: boolean }
export interface MacBrowserExecutorOptions { bridgeFactory?: (allowLoopback: boolean) => NativeBrowserBridge }
export class MacBrowserExecutor {
  private active: ActiveRun | undefined;
  private shuttingDown = false;
  private fault: Error | undefined;
  private recovered = false;
  private readonly bridgeFactory: (allowLoopback: boolean) => NativeBrowserBridge;
  private readonly sites: BrowserExecutorPoll["sites"];
  constructor(readonly config: MacConfig, readonly journal: BrowserJournal, options: MacBrowserExecutorOptions = {}) {
    if (config.executorId !== journal.executorId || coordinatorUrl(config.serverUrl).origin !== journal.serverUrl) throw new Error("Browser executor does not match its journal identity");
    this.bridgeFactory = options.bridgeFactory ?? (local => new AsideBrowserBridge(local));
    this.sites = config.browser.sites.map(site => { const parsed = parseBrowserSite(site, journal.allowLoopback); return { siteId: parsed.siteId, policyDigest: policyDigest(parsed) }; });
    if (new Set(this.sites.map(site => site.siteId)).size !== this.sites.length) throw new Error("Duplicate local browser site policies");
  }
  get activeRunId(): string | null { return this.active?.assignment.runId ?? this.journal.activeRunId; }
  get recoveryPaused(): boolean { return this.journal.recoveryPaused; }
  get shouldPoll(): boolean { return this.config.browser.enabled || this.activeRunId !== null || this.journal.snapshot().unacknowledgedReports > 0; }
  get available(): boolean { return this.config.browser.enabled && !this.shuttingDown && !this.fault && !this.recoveryPaused && this.activeRunId === null; }
  advertisedSites(): BrowserExecutorPoll["sites"] { return this.config.browser.enabled ? this.sites.map(site => ({ ...site })) : []; }
  private validate(assignment: BrowserAssignment): void {
    for (const scope of assignment.sites) {
      if (policyDigest(scope.site) !== scope.site.policyDigest) throw new Error("Browser assignment canonical policy digest does not match");
      if (this.config.browser.allSites) {
        for (const origin of scope.site.origins) browserPublicUrl(origin);
        for (const host of [...scope.site.cookieHosts, ...scope.site.resourceHosts]) browserPublicUrl(`https://${host.startsWith(".") ? host.slice(1) : host}`);
        browserPublicUrl(scope.startUrl);
      } else {
        const local = this.sites.find(site => site.siteId === scope.site.siteId);
        if (!local || local.policyDigest !== scope.site.policyDigest) throw new Error("Browser assignment does not match the locally approved site policy");
      }
      browserUrl(scope.startUrl, scope.site.origins, this.journal.allowLoopback, scope.site.domain);
    }
    const remaining = Date.parse(assignment.deadlineAt) - Date.now();
    if (remaining <= 0 || remaining > MAX_BROWSER_TIMEOUT_MS) throw new Error("Browser deadline is outside its local bound");
  }
  async handlePoll(input: BrowserExecutorPollResult, mayStart = true): Promise<void> {
    if (this.fault) throw this.fault;
    const result = parseBrowserPollResult(input, this.journal.allowLoopback);
    if (!result.assignment) return;
    const assignment = result.assignment;
    let phase: "new" | "active" | "stopped";
    try { phase = this.journal.accept(assignment); }
    catch (error) { if (this.active) { this.active.uncertain = true; await this.stop("Coordinator changed browser ownership or immutable scope."); } throw error; }
    if (phase === "stopped") {
      for (const request of result.requests) this.journal.admit(assignment, request); // Exact replay or durable no-effect refusal; never dispatch.
      this.journal.requestResend(assignment.runId);
      return;
    }
    if (!this.active) {
      let issue: string | undefined;
      try { if (!this.config.browser.enabled || this.shuttingDown || !mayStart || this.recoveryPaused) throw new Error("Browser execution is disabled"); this.validate(assignment); }
      catch { issue = "Browser run was not started: local opt-in, policy digest, availability or deadline validation failed."; }
      if (issue || result.cancel) {
        for (const request of result.requests) this.journal.admit(assignment, request);
        this.journal.settlePending(assignment);
        this.journal.stopped(assignment, true, false, issue ?? "Browser run cancelled before opening any tab.");
        return;
      }
      const active: ActiveRun = { assignment, bridge: this.bridgeFactory(this.journal.allowLoopback), queue: Promise.resolve(), deadline: setTimeout(() => { void this.stop("Browser hard deadline elapsed.").catch(() => { this.fault = new Error("Browser deadline cleanup could not be journaled"); }); }, Math.max(1, Date.parse(assignment.deadlineAt) - Date.now())), uncertain: false, ready: false };
      this.active = active;
      active.bridge.setPopupUncertaintyHandler?.(() => {
        this.journal.notePopupUncertainty(assignment);
        active.uncertain = true;
      });
      active.queue = this.open(active);
    }
    const active = this.active;
    if (!active || active.stopping) return;
    if (result.cancel) {
      try { for (const request of result.requests) this.journal.admit(assignment, request); }
      catch { active.uncertain = true; }
      await this.stop("Owner or coordinator requested browser stop.");
      return;
    }
    try {
      for (const request of result.requests) {
        const admission = this.journal.admit(assignment, request);
        if (admission.fresh) active.queue = active.queue.then(() => this.execute(active, request));
      }
    } catch { active.uncertain = true; await this.stop("Browser request admission was not confirmed; no conflicting input was dispatched."); }
  }
  private async open(active: ActiveRun): Promise<void> {
    try {
      for (const scope of active.assignment.sites) {
        if (active.stopping || this.shuttingDown) return;
        const marker = this.journal.openingTab(active.assignment, scope.site.siteId);
        const targetId = await active.bridge.openTab(scope.site.siteId, marker);
        this.journal.ownedTab(active.assignment.runId, scope.site.siteId, targetId);
        if (active.stopping || this.shuttingDown) return;
        await active.bridge.configureTab({ siteId: scope.site.siteId, targetId }, active.assignment);
        if (active.stopping || this.shuttingDown) return;
        this.journal.tabReady(active.assignment.runId, scope.site.siteId);
      }
      if (!active.stopping) { this.journal.ready(active.assignment); active.ready = true; }
    } catch { if (!active.stopping) { active.uncertain = true; void this.stop("Aside task-owned tabs could not be opened safely.").catch(() => { this.fault = new Error("Browser opening cleanup could not be journaled"); }); } }
  }
  private async execute(active: ActiveRun, request: BrowserRequest): Promise<void> {
    if (active.stopping || !active.ready || this.shuttingDown) return;
    if (Date.now() >= Date.parse(active.assignment.deadlineAt)) { await this.stop("Browser hard deadline elapsed."); return; }
    const scope = active.assignment.sites.find(scope => scope.site.siteId === request.action.siteId)!;
    const tab = this.journal.tabs(active.assignment.runId).find(tab => tab.site_id === request.action.siteId && tab.phase === "ready");
    if (!tab?.target_id) { active.uncertain = true; await this.stop("Browser owned tab mapping was lost."); return; }
    try {
      if (request.action.kind === "navigate") browserUrl(request.action.url, scope.site.origins, this.journal.allowLoopback, scope.site.domain);
    } catch { this.journal.receipt(active.assignment, { operationId: request.operationId, status: "failed", error: "Browser navigation is outside its approved site origins." }); return; }
    try {
      this.journal.dispatch(active.assignment, request.operationId);
      const output = await active.bridge.invoke({ siteId: request.action.siteId, targetId: tab.target_id }, request.action);
      if (active.stopping) return;
      const location = output.observation?.url ?? output.image?.url;
      if (!location || (output.observation?.siteId ?? output.image?.siteId) !== request.action.siteId) throw new Error("Browser output identity was lost");
      browserUrl(location, scope.site.origins, this.journal.allowLoopback, scope.site.domain);
      this.journal.receipt(active.assignment, { operationId: request.operationId, status: "done", ...output });
    } catch (error) {
      if (active.stopping) return;
      const rejected = error instanceof BrowserActionRejected;
      this.journal.receipt(active.assignment, { operationId: request.operationId, status: rejected ? "failed" : "uncertain", error: rejected ? "Browser action was rejected by its current observation, credential or site boundary." : "Browser action lost its response after dispatch; effects were not replayed." });
      if (!rejected) { active.uncertain = true; await this.stop("Browser operation has an uncertain outcome; explicit stopped reconciliation is required."); }
    }
  }
  private async stop(issue: string): Promise<void> {
    const active = this.active;
    if (!active) return;
    if (active.stopping) return active.stopping;
    clearTimeout(active.deadline);
    const stop = Promise.withResolvers<void>();
    active.stopping = stop.promise; // Fence before disconnect or any asynchronous callback.
    void (async () => {
      let uncertain = active.uncertain;
      try { await active.bridge.disconnect(); } catch { uncertain = true; }
      // Native idle disconnect closes originals with popup monitoring intact;
      // interruption fences effects first. Never attach a guessed popup/user tab.
      const tabs = this.journal.tabs(active.assignment.runId);
      let stopped = !tabs.some(tab => tab.target_id === null);
      uncertain ||= !stopped;
      const targets = tabs.flatMap(tab => tab.target_id === null ? [] : [tab.target_id]);
      if (targets.length) {
        try {
          const closed = await active.bridge.stopTabs(targets);
          stopped &&= closed.stopped;
          if (closed.stopped) this.journal.tabsClosed(active.assignment.runId);
          if (!closed.stopped || closed.uncertain) uncertain = true;
        } catch { stopped = false; uncertain = true; }
      }
      if (this.journal.hasPopupUncertainty(active.assignment.runId)) {
        uncertain = true;
        issue += " Aside reported a popup or lost popup monitoring; its supported API cannot prove descendant target ownership. Unknown tabs were not guessed or closed; explicit owner stopped reconciliation is required.";
      }
      uncertain = this.journal.settlePending(active.assignment) || uncertain;
      this.journal.stopped(active.assignment, stopped, uncertain, issue);
      if (this.active === active) this.active = undefined;
    })().then(stop.resolve, stop.reject);
    return stop.promise;
  }
  private async recoverOwnedTabs(): Promise<void> {
    if (this.recovered) return;
    this.recovered = true;
    for (const assignment of this.journal.stoppedAssignments()) {
      const targets = this.journal.tabs(assignment.runId).filter(tab => tab.phase !== "closed" && tab.target_id !== null).map(tab => tab.target_id!);
      if (!targets.length) continue;
      const bridge = this.bridgeFactory(this.journal.allowLoopback);
      try { const closed = await bridge.stopTabs(targets); if (closed.stopped) this.journal.tabsClosed(assignment.runId); }
      catch { /* Original uncertainty remains immutable; this is not owner confirmation. */ }
      finally { await bridge.disconnect(); }
    }
  }
  async flushReports(send: (report: BrowserExecutorReport) => Promise<void>): Promise<void> {
    if (this.fault) throw this.fault;
    await this.recoverOwnedTabs();
    for (const report of this.journal.pendingReports()) { await send(JSON.parse(report.payload) as BrowserExecutorReport); this.journal.acknowledge(report); }
  }
  async shutdown(): Promise<void> { this.shuttingDown = true; await this.stop("Executor shutdown requested browser stop."); await this.recoverOwnedTabs(); }
}
