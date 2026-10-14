import { closeSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MAX_CODING_TIMEOUT_MS, parseCodingAssignment, type CodingAssignment, type CodingExecutorPollResult, type CodingExecutorReport } from "../shared/coding.js";
import { identifier, record } from "../shared/protocol.js";
import { parseCodingRpcRequest, type CodingRpcState } from "../shared/coding-rpc.js";
import { CodingNodeSession, readCodingNodeStates } from "../coding/rpc.js";
import { captureCodingSnapshot, restoreCodingSnapshot } from "../coding/workspace.js";
import { allowedCodingCwd, privateDirectory, privateFile, type MacConfig } from "./config.js";

type StoppedReport = Extract<CodingExecutorReport, { type: "stopped" }>;
interface StoredRun {
  assignment: string;
  phase: "active" | "stopped";
  stop_report: string | null;
  stop_acknowledged: number;
}
interface PendingReport { key: string; payload: string }
interface PreparedWorkspace { executionCwd: string; baselineArchive: Uint8Array }
interface StoredWorkspace { execution_cwd: string; baseline: Uint8Array }
export interface CodingJournalStatus {
  recoveryPaused: boolean;
  outstanding: { taskId: string; runId: string; phase: "active" | "stopped"; uncertain: boolean }[];
  unacknowledgedReports: number;
  recordedRuns: number;
}

function reportKey(runId: string, type: "ready" | "operation" | "stopped" | "owner-stopped", operationId?: string): string {
  return `${runId.length}.${runId}:${type}${operationId === undefined ? "" : `:${operationId}`}`;
}

function codingStatus(database: DatabaseSync): CodingJournalStatus {
  const paused = database.prepare("SELECT value FROM meta WHERE key = 'recovery_paused'").get() as { value: string } | undefined;
  const rows = database.prepare("SELECT * FROM runs WHERE phase = 'active' OR stop_acknowledged = 0 OR (? = '1' AND json_extract(stop_report, '$.uncertain') = 1) ORDER BY rowid").all(paused?.value ?? "0") as unknown as StoredRun[];
  const reports = database.prepare("SELECT COUNT(*) AS total FROM reports WHERE acknowledged = 0").get() as { total: number };
  const runs = database.prepare("SELECT COUNT(*) AS total FROM runs").get() as { total: number };
  return {
    recoveryPaused: paused?.value === "1",
    outstanding: rows.map(row => {
      const assignment = parseCodingAssignment(JSON.parse(row.assignment));
      return { taskId: assignment.taskId, runId: assignment.runId, phase: row.phase, uncertain: row.stop_report !== null && (JSON.parse(row.stop_report) as StoppedReport).uncertain };
    }),
    unacknowledgedReports: reports.total,
    recordedRuns: runs.total,
  };
}

/** Only opened alongside the existing shell journal's exclusive daemon lock. */
export class CodingJournal {
  private readonly database: DatabaseSync;
  private readonly lock: DatabaseSync;
  private closed = false;
  readonly directory: string;
  readonly executorId: string;

  constructor(directory: string, config: Pick<MacConfig, "executorId" | "serverUrl">) {
    this.directory = privateDirectory(directory);
    this.executorId = config.executorId;
    const lockPath = join(this.directory, "coding-lock.sqlite");
    const path = join(this.directory, "coding.sqlite");
    closeSync(privateFile(lockPath, true));
    closeSync(privateFile(path, true));
    this.lock = new DatabaseSync(lockPath);
    try { this.lock.exec("PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE"); }
    catch { this.lock.close(); throw new Error("Coding state is already in use"); }
    let database: DatabaseSync | undefined;
    try {
      database = new DatabaseSync(path);
      this.database = database;
      database.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = FULL;
        CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS runs (
          run_id TEXT PRIMARY KEY,
          assignment TEXT NOT NULL,
          phase TEXT NOT NULL CHECK (phase IN ('active', 'stopped')),
          stop_report TEXT,
          stop_acknowledged INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS workspaces (
          run_id TEXT PRIMARY KEY,
          execution_cwd TEXT NOT NULL,
          baseline BLOB NOT NULL
        );
        CREATE TABLE IF NOT EXISTS reports (
          report_key TEXT PRIMARY KEY,
          run_id TEXT NOT NULL,
          payload TEXT NOT NULL,
          acknowledged INTEGER NOT NULL DEFAULT 0
        );
      `);
      for (const [key, value] of [["executor_id", config.executorId], ["server_url", config.serverUrl]] as const) {
        const existing = database.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
        if (existing && existing.value !== value) throw new Error("Coding journal belongs to another executor or coordinator");
        database.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)").run(key, value);
      }
      const interrupted = database.prepare("SELECT * FROM runs WHERE phase = 'active'").all() as unknown as StoredRun[];
      for (const row of interrupted) {
        this.stopped(parseCodingAssignment(JSON.parse(row.assignment)), true, "Executor restarted with an accepted coding run. Prior processes or effects may remain; no operation was replayed. Confirm prior work has stopped before resuming.");
      }
    } catch (error) { database?.close(); this.lock.close(); throw error; }
  }

  sessionDirectory(runId: string): string {
    return join(this.directory, "coding-runs", identifier(runId, "coding run ID"));
  }

  executionCwd(runId: string): string | undefined {
    return (this.database.prepare("SELECT execution_cwd FROM workspaces WHERE run_id = ?").get(runId) as { execution_cwd: string } | undefined)?.execution_cwd;
  }

  async prepareWorkspace(assignment: CodingAssignment): Promise<PreparedWorkspace> {
    const run = this.stored(assignment.runId);
    if (!run || run.phase !== "active" || run.assignment !== JSON.stringify(parseCodingAssignment(assignment))) throw new Error("Coding workspace requires its immutable active grant");
    if (this.directory === assignment.cwd || this.directory.startsWith(`${assignment.cwd}/`)) throw new Error("Private coding state must be outside the original source workspace");
    const digest = createHash("sha256").update(assignment.runId).digest("hex");
    const executionCwd = join(this.directory, "coding-workspaces", digest, "workspace");
    const existing = this.database.prepare("SELECT * FROM workspaces WHERE run_id = ?").get(assignment.runId) as StoredWorkspace | undefined;
    if (existing) {
      if (existing.execution_cwd !== executionCwd || privateDirectory(executionCwd, false) !== executionCwd) throw new Error("Coding workspace mapping is not the owned private copy");
      return { executionCwd, baselineArchive: existing.baseline };
    }
    let sourceCwd = assignment.cwd;
    if (assignment.sourceRunId !== undefined) {
      const sourceRun = this.stored(assignment.sourceRunId);
      if (!sourceRun || sourceRun.phase !== "stopped" || sourceRun.stop_acknowledged !== 1) throw new Error("Coding continuation requires its acknowledged stopped source run");
      const sourceAssignment = parseCodingAssignment(JSON.parse(sourceRun.assignment));
      const sourceExecutionCwd = this.executionCwd(assignment.sourceRunId);
      const sourceDigest = createHash("sha256").update(assignment.sourceRunId).digest("hex");
      const expectedSource = join(this.directory, "coding-workspaces", sourceDigest, "workspace");
      if (sourceAssignment.taskId !== assignment.taskId || sourceAssignment.cwd !== assignment.cwd || sourceExecutionCwd !== expectedSource || privateDirectory(expectedSource, false) !== expectedSource) throw new Error("Coding continuation source is not this task's immutable owned private copy");
      sourceCwd = sourceExecutionCwd;
    }
    const captured = await captureCodingSnapshot(sourceCwd);
    const workspaceRoot = join(this.directory, "coding-workspaces");
    if (privateDirectory(this.directory, false) !== this.directory || privateDirectory(workspaceRoot) !== workspaceRoot || privateDirectory(dirname(executionCwd)) !== dirname(executionCwd)) throw new Error("Coding workspace parent is not canonical private state");
    await restoreCodingSnapshot(captured.bytes, executionCwd);
    this.database.prepare("INSERT INTO workspaces VALUES (?, ?, ?)").run(assignment.runId, executionCwd, captured.bytes);
    return { executionCwd, baselineArchive: captured.bytes };
  }

  private stored(runId: string): StoredRun | undefined {
    return this.database.prepare("SELECT * FROM runs WHERE run_id = ?").get(runId) as StoredRun | undefined;
  }

  get activeRunId(): string | null {
    const row = this.database.prepare("SELECT run_id FROM runs WHERE phase = 'active' OR stop_acknowledged = 0 ORDER BY rowid LIMIT 1").get() as { run_id: string } | undefined;
    return row?.run_id ?? null;
  }

  get recoveryPaused(): boolean {
    return (this.database.prepare("SELECT value FROM meta WHERE key = 'recovery_paused'").get() as { value: string } | undefined)?.value === "1";
  }

  accept(input: CodingAssignment): "new" | "active" | "stopped" {
    const assignment = parseCodingAssignment(input);
    const existing = this.stored(assignment.runId);
    if (existing) {
      if (existing.assignment !== JSON.stringify(assignment)) throw new Error("Coordinator changed an immutable coding assignment");
      return existing.phase;
    }
    if (this.activeRunId !== null || this.recoveryPaused) throw new Error("Coding run overlaps unreconciled work");
    this.database.prepare("INSERT INTO runs (run_id, assignment, phase) VALUES (?, ?, 'active')").run(assignment.runId, JSON.stringify(assignment));
    return "new";
  }

  private enqueue(key: string, report: CodingExecutorReport): void {
    const payload = JSON.stringify(report);
    const existing = this.database.prepare("SELECT payload FROM reports WHERE report_key = ?").get(key) as { payload: string } | undefined;
    if (existing?.payload === payload) return;
    if (existing && report.type === "operation") {
      const prior = JSON.parse(existing.payload) as Extract<CodingExecutorReport, { type: "operation" }>;
      if (prior.state.status !== "running") throw new Error("Coding operation terminal result is immutable");
    }
    this.database.prepare("INSERT INTO reports (report_key, run_id, payload) VALUES (?, ?, ?) ON CONFLICT(report_key) DO UPDATE SET payload = excluded.payload, acknowledged = 0").run(key, report.runId, payload);
  }

  ready(assignment: CodingAssignment): void {
    const executionCwd = this.executionCwd(assignment.runId);
    if (!executionCwd) throw new Error("Coding readiness requires a durable private workspace mapping");
    this.enqueue(reportKey(assignment.runId, "ready"), { executorId: this.executorId, taskId: assignment.taskId, runId: assignment.runId, type: "ready", executionCwd });
  }

  operation(assignment: CodingAssignment, state: CodingRpcState): void {
    this.enqueue(reportKey(assignment.runId, "operation", state.operationId), { executorId: this.executorId, taskId: assignment.taskId, runId: assignment.runId, type: "operation", state });
  }

  requestResend(runId: string, operationId?: string): void {
    if (operationId === undefined) {
      this.database.prepare("UPDATE reports SET acknowledged = 0 WHERE run_id = ?").run(runId);
    } else this.database.prepare("UPDATE reports SET acknowledged = 0 WHERE report_key = ?").run(reportKey(runId, "operation", operationId));
  }

  stopped(assignment: CodingAssignment, uncertain: boolean, issue?: string): void {
    const existing = this.stored(assignment.runId);
    if (!existing) throw new Error("Cannot stop an unowned coding run");
    if (existing.phase === "stopped") return;
    const report: StoppedReport = { executorId: this.executorId, taskId: assignment.taskId, runId: assignment.runId, type: "stopped", uncertain, ...(issue ? { issue } : {}) };
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare("DELETE FROM reports WHERE report_key = ?").run(reportKey(assignment.runId, "ready"));
      this.enqueue(reportKey(assignment.runId, "stopped"), report);
      this.database.prepare("UPDATE runs SET phase = 'stopped', stop_report = ?, stop_acknowledged = 0 WHERE run_id = ?").run(JSON.stringify(report), assignment.runId);
      if (uncertain) this.database.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('recovery_paused', '1')").run();
      this.database.exec("COMMIT");
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }

  /** Explicit CLI owner action; original uncertain report and effects remain unchanged. */
  resumeAfterOwnerConfirmation(): void {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const rows = this.database.prepare("SELECT * FROM runs WHERE json_extract(stop_report, '$.uncertain') = 1 AND NOT EXISTS (SELECT 1 FROM reports WHERE run_id = runs.run_id AND json_extract(payload, '$.ownerConfirmedStopped') = 1)").all() as unknown as StoredRun[];
      for (const row of rows) {
        const report = JSON.parse(row.stop_report!) as StoppedReport;
        this.enqueue(reportKey(report.runId, "owner-stopped"), { ...report, ownerConfirmedStopped: true, issue: "Owner explicitly confirmed prior work has stopped. Prior operation outcomes and filesystem effects remain uncertain; nothing was replayed or rolled back." });
        this.database.prepare("UPDATE runs SET stop_acknowledged = 0 WHERE run_id = ?").run(report.runId);
      }
      this.database.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('recovery_paused', '0')").run();
      this.database.exec("COMMIT");
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }

  pendingReports(): PendingReport[] {
    return this.database.prepare("SELECT report_key AS key, payload FROM reports WHERE acknowledged = 0 ORDER BY CASE WHEN json_extract(payload, '$.type') = 'operation' THEN 0 WHEN json_extract(payload, '$.ownerConfirmedStopped') = 1 THEN 2 ELSE 1 END, rowid").all() as unknown as PendingReport[];
  }

  acknowledge(receipt: PendingReport): void {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare("UPDATE reports SET acknowledged = 1 WHERE report_key = ? AND payload = ?").run(receipt.key, receipt.payload);
      const report = JSON.parse(receipt.payload) as CodingExecutorReport;
      this.database.prepare("UPDATE runs SET stop_acknowledged = 1 WHERE run_id = ? AND phase = 'stopped' AND NOT EXISTS (SELECT 1 FROM reports WHERE run_id = ? AND acknowledged = 0)").run(report.runId, report.runId);
      this.database.exec("COMMIT");
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }

  stoppedAssignments(): CodingAssignment[] {
    return (this.database.prepare("SELECT assignment FROM runs WHERE phase = 'stopped'").all() as { assignment: string }[]).map(row => parseCodingAssignment(JSON.parse(row.assignment)));
  }

  snapshot(): CodingJournalStatus { return codingStatus(this.database); }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try { this.database.close(); } finally { this.lock.close(); }
  }
}

export function readCodingJournalStatus(directory: string): CodingJournalStatus | null {
  const path = join(privateDirectory(directory, false), "coding.sqlite");
  if (!existsSync(path)) return null;
  closeSync(privateFile(path));
  const database = new DatabaseSync(path, { readOnly: true });
  try { return codingStatus(database); } finally { database.close(); }
}

export function parseCodingPollResult(value: unknown): CodingExecutorPollResult {
  const input = record(value);
  if (!Array.isArray(input.requests) || input.requests.length > 128 || !Array.isArray(input.cancelOperationIds) || input.cancelOperationIds.length > 128 || typeof input.cancel !== "boolean") throw new Error("Invalid coding poll result");
  const assignment = input.assignment === null ? null : parseCodingAssignment(input.assignment);
  if (assignment === null && (input.requests.length !== 0 || input.cancelOperationIds.length !== 0 || input.cancel)) throw new Error("Coding work has no run assignment");
  return {
    assignment,
    requests: input.requests.map(parseCodingRpcRequest),
    cancelOperationIds: input.cancelOperationIds.map(id => {
      if (typeof id !== "string" || !/^[A-Za-z0-9_.:-]{1,512}$/.test(id)) throw new Error("Invalid coding cancellation identity");
      return id;
    }),
    cancel: input.cancel,
  };
}

interface ActiveCodingRun {
  assignment: CodingAssignment;
  opening: Promise<CodingNodeSession>;
  session?: CodingNodeSession;
  stopping?: Promise<void>;
  reconciliationRequired?: boolean;
  deadline: NodeJS.Timeout;
}

export class MacCodingExecutor {
  private active: ActiveCodingRun | undefined;
  private fault: Error | undefined;
  private recovered = false;
  private shuttingDown = false;

  constructor(readonly config: MacConfig, readonly journal: CodingJournal) {}

  get activeRunId(): string | null { return this.active?.assignment.runId ?? this.journal.activeRunId; }
  get ownsSlot(): boolean { return this.activeRunId !== null || this.journal.recoveryPaused; }
  get recoveryPaused(): boolean { return this.journal.recoveryPaused; }
  get shouldPoll(): boolean { return this.config.coding.enabled || this.activeRunId !== null; }
  get available(): boolean { return this.config.coding.enabled && !this.shuttingDown && !this.ownsSlot && !this.fault; }

  private capture(): void {
    const active = this.active;
    if (!active?.session) return;
    for (const state of active.session.states()) this.journal.operation(active.assignment, state);
  }

  async recoverResults(): Promise<void> {
    if (this.recovered) return;
    for (const assignment of this.journal.stoppedAssignments()) {
      const directory = this.journal.sessionDirectory(assignment.runId);
      if (!existsSync(directory)) continue;
      for (const state of await readCodingNodeStates(directory)) this.journal.operation(assignment, state);
    }
    this.recovered = true;
  }

  async flushReports(send: (report: CodingExecutorReport) => Promise<void>): Promise<void> {
    if (this.fault) throw this.fault;
    await this.recoverResults();
    this.capture();
    if (this.active?.session?.uncertain) await this.stop("Coding operation has an uncertain outcome; explicit stopped reconciliation is required.");
    for (const receipt of this.journal.pendingReports()) {
      await send(JSON.parse(receipt.payload) as CodingExecutorReport);
      this.journal.acknowledge(receipt);
    }
  }

  private async reconcile(issue: string): Promise<void> {
    if (this.active) this.active.reconciliationRequired = true;
    await this.stop(issue);
  }

  async handlePoll(result: CodingExecutorPollResult, slotAvailable: boolean): Promise<void> {
    if (this.fault) throw this.fault;
    if (!result.assignment) return; // Silence never relinquishes immutable local ownership.
    const assignment = result.assignment;
    let phase: "new" | "active" | "stopped";
    try {
      phase = this.journal.accept(assignment);
      if (phase !== "stopped" && this.active && this.active.assignment.runId !== assignment.runId) throw new Error("Coordinator offered overlapping coding runs");
    } catch (error) {
      await this.reconcile("Coordinator changed coding ownership or immutable scope; explicit stopped reconciliation is required.");
      throw error;
    }
    if (phase === "stopped") return;
    if (!this.active) {
      let issue: string | undefined;
      try {
        if (!this.config.coding.enabled || this.shuttingDown || !slotAvailable) throw new Error("Coding execution is not enabled or the execution slot is occupied");
        allowedCodingCwd(assignment.cwd, this.config.workspaces);
        const remaining = Date.parse(assignment.deadlineAt) - Date.now();
        if (remaining <= 0 || remaining > MAX_CODING_TIMEOUT_MS) throw new Error("Coding deadline is outside the approved local bound");
      } catch { issue = "Coding run was not started: opt-in, exact workspace, execution slot, or deadline validation failed."; }
      if (issue || result.cancel) {
        this.journal.stopped(assignment, false, issue ?? "Coding run cancelled before opening its execution session.");
        return;
      }
      const opening = (async () => {
        const workspace = await this.journal.prepareWorkspace(assignment);
        return CodingNodeSession.open({
          assignment: { ...assignment, cwd: workspace.executionCwd },
          stateDirectory: this.journal.sessionDirectory(assignment.runId),
          baselineArchive: workspace.baselineArchive,
        });
      })();
      const active: ActiveCodingRun = {
        assignment,
        opening,
        deadline: setTimeout(() => { void this.stop("Coding hard deadline elapsed.").catch(() => { this.fault = new Error("Coding deadline cleanup could not be journaled"); }); }, Math.max(1, Date.parse(assignment.deadlineAt) - Date.now())),
      };
      this.active = active;
      try {
        active.session = await opening;
        if (active.stopping || this.shuttingDown) return;
        if (active.session.uncertain) { await this.stop("Coding session recovered uncertain operations; explicit stopped reconciliation is required."); return; }
        this.journal.ready(assignment);
      } catch {
        await this.stop("Coding session could not open safely; prior state requires inspection.");
        return;
      }
    }
    const active = this.active;
    if (!active?.session || active.stopping) return;
    try {
      const cancellations = new Set(result.cancelOperationIds);
      // A cancelled, previously dispatched request may never have reached this
      // journal. Persist its exact cancellation before admitting any new work.
      for (const request of result.requests) {
        if (cancellations.has(request.operationId)) await active.session.cancelRequest(request);
      }
      for (const operationId of cancellations) await active.session.cancel(operationId);
      if (result.cancel) { await this.stop("Owner or coordinator requested stop. Filesystem effects were not rolled back."); return; }
      for (const request of result.requests) {
        if (active.stopping || this.shuttingDown || Date.now() >= Date.parse(assignment.deadlineAt)) break;
        active.session.assertRequest(request);
        if (!active.session.state(request.operationId)) await active.session.submit(request);
        const state = active.session.state(request.operationId);
        if (state) this.journal.operation(assignment, state);
        this.journal.requestResend(assignment.runId, request.operationId);
      }
      this.capture();
    } catch {
      // Capacity refusals have real Node receipts. Any other failure is not
      // evidence of a mutation result or safe admission; retain the run instead
      // of terminating the shared shell/coding daemon or inventing success.
      await this.reconcile("Coding request admission or cancellation could not be confirmed; prior outcomes require explicit stopped reconciliation.");
      return;
    }
    if (active.session.uncertain) await this.stop("Coding operation has an uncertain outcome; explicit stopped reconciliation is required.");
  }

  async stop(issue = "Executor stopped; prior filesystem effects were not rolled back."): Promise<void> {
    const active = this.active;
    if (!active) return;
    if (active.stopping) return active.stopping;
    clearTimeout(active.deadline);
    active.stopping = (async () => {
      let uncertain = active.reconciliationRequired ?? false;
      let session: CodingNodeSession | undefined;
      try {
        session = active.session ?? await active.opening;
        await session.cancel();
      } catch { uncertain = true; }
      try { await session?.close(); } catch { uncertain = true; }
      if (session) {
        uncertain ||= session.uncertain;
        try { for (const state of session.states()) this.journal.operation(active.assignment, state); }
        catch { uncertain = true; }
      }
      this.journal.stopped(active.assignment, uncertain, issue);
      if (this.active === active) this.active = undefined;
    })();
    return active.stopping;
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    await this.stop();
  }
}
