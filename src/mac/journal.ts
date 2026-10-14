import { closeSync, existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { JobCompletion, MacJobAssignment } from "../shared/protocol.js";
import { parseAssignment, parseCompletion } from "../shared/protocol.js";
import { privateDirectory, privateFile, type MacConfig } from "./config.js";

export type JournalPhase = "assigned" | "start_intent" | "running" | "terminal";
export interface JournalEntry {
  assignment: MacJobAssignment;
  phase: JournalPhase;
  pid: number | null;
  completion: JobCompletion | null;
  acknowledged: boolean;
}
interface StoredEntry {
  assignment: string;
  phase: JournalPhase;
  pid: number | null;
  completion: string | null;
  acknowledged: number;
}
export interface JournalStatus {
  recoveryPaused: boolean;
  outstanding: { jobId: string; phase: JournalPhase; pid: number | null }[];
  unacknowledgedResults: number;
  recordedJobs: number;
}

function decode(row: StoredEntry): JournalEntry {
  return {
    assignment: parseAssignment(JSON.parse(row.assignment)),
    phase: row.phase,
    pid: row.pid,
    completion: row.completion === null ? null : parseCompletion(JSON.parse(row.completion)),
    acknowledged: row.acknowledged === 1,
  };
}

function status(database: DatabaseSync): JournalStatus {
  const pause = database.prepare("SELECT value FROM meta WHERE key = 'recovery_paused'").get() as { value: string } | undefined;
  const pending = database.prepare("SELECT assignment, phase, pid FROM jobs WHERE phase != 'terminal' OR acknowledged = 0 OR (? = '1' AND json_extract(completion, '$.status') = 'uncertain') ORDER BY rowid").all(pause?.value ?? "0") as unknown as Pick<StoredEntry, "assignment" | "phase" | "pid">[];
  const count = database.prepare("SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN phase = 'terminal' AND acknowledged = 0 THEN 1 ELSE 0 END), 0) AS unacknowledged FROM jobs").get() as { total: number; unacknowledged: number };
  return {
    recoveryPaused: pause?.value === "1",
    outstanding: pending.map(row => ({ jobId: parseAssignment(JSON.parse(row.assignment)).jobId, phase: row.phase, pid: row.pid })),
    unacknowledgedResults: count.unacknowledged,
    recordedJobs: count.total,
  };
}

export class ExecutionJournal {
  private readonly database: DatabaseSync;
  private readonly lock: DatabaseSync;
  private closed = false;
  readonly executorId: string;

  constructor(directory: string, config: Pick<MacConfig, "executorId" | "serverUrl">) {
    const root = privateDirectory(directory);
    const lockPath = join(root, "daemon-lock.sqlite");
    const journalPath = join(root, "execution.sqlite");
    closeSync(privateFile(lockPath, true));
    closeSync(privateFile(journalPath, true));
    this.executorId = config.executorId;
    this.lock = new DatabaseSync(lockPath);
    try {
      this.lock.exec("PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE");
    } catch {
      this.lock.close();
      throw new Error("Executor state is already open by another daemon or recovery command");
    }
    let database: DatabaseSync | undefined;
    try {
      database = new DatabaseSync(journalPath);
      this.database = database;
      this.database.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = FULL;
        CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS jobs (
          job_id TEXT PRIMARY KEY,
          assignment TEXT NOT NULL,
          phase TEXT NOT NULL CHECK (phase IN ('assigned', 'start_intent', 'running', 'terminal')),
          pid INTEGER,
          completion TEXT,
          acknowledged INTEGER NOT NULL DEFAULT 0 CHECK (acknowledged IN (0, 1))
        );
      `);
      for (const [key, value] of [["executor_id", config.executorId], ["server_url", config.serverUrl]] as const) {
        const existing = this.database.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
        if (existing && existing.value !== value) throw new Error("Journal belongs to a different executor or coordinator; do not reuse its state directory");
        this.database.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)").run(key, value);
      }
      this.recoverInterrupted();
    } catch (error) {
      database?.close();
      this.lock.close();
      throw error;
    }
  }

  private recoverInterrupted(): void {
    const interrupted = this.database.prepare("SELECT * FROM jobs WHERE phase IN ('start_intent', 'running')").all() as unknown as StoredEntry[];
    if (interrupted.length === 0) return;
    this.database.exec("BEGIN IMMEDIATE");
    try {
      for (const row of interrupted) {
        const entry = decode(row);
        const completion: JobCompletion = {
          executorId: this.executorId,
          jobId: entry.assignment.jobId,
          status: "uncertain",
          exitCode: null,
          output: "Executor restarted after recording command start intent. The command may have performed external effects or may still be running. It was not replayed; execution is paused until the owner confirms prior commands have stopped.",
          truncated: false,
          finishedAt: new Date().toISOString(),
        };
        this.database.prepare("UPDATE jobs SET phase = 'terminal', completion = ?, acknowledged = 0 WHERE job_id = ?").run(JSON.stringify(completion), completion.jobId);
      }
      this.database.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('recovery_paused', '1')").run();
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  get(jobId: string): JournalEntry | undefined {
    const row = this.database.prepare("SELECT * FROM jobs WHERE job_id = ?").get(jobId) as StoredEntry | undefined;
    return row ? decode(row) : undefined;
  }

  accept(input: MacJobAssignment): JournalEntry {
    const assignment = parseAssignment(input);
    const existing = this.get(assignment.jobId);
    if (existing) {
      if (JSON.stringify(existing.assignment) !== JSON.stringify(assignment)) throw new Error("Coordinator changed an existing assignment");
      return existing;
    }
    if (this.database.prepare("SELECT 1 FROM jobs WHERE phase != 'terminal' LIMIT 1").get()) {
      throw new Error("Coordinator offered overlapping assignments; retaining existing command");
    }
    this.database.prepare("INSERT INTO jobs (job_id, assignment, phase) VALUES (?, ?, 'assigned')").run(assignment.jobId, JSON.stringify(assignment));
    return this.get(assignment.jobId)!;
  }

  startIntent(jobId: string): void {
    if (this.recoveryPaused) throw new Error("Execution is paused for crash recovery");
    const result = this.database.prepare("UPDATE jobs SET phase = 'start_intent' WHERE job_id = ? AND phase = 'assigned'").run(jobId);
    if (result.changes !== 1) throw new Error("Command does not have an unstarted assignment");
  }

  running(jobId: string, pid: number): void {
    const result = this.database.prepare("UPDATE jobs SET phase = 'running', pid = ? WHERE job_id = ? AND phase = 'start_intent'").run(pid, jobId);
    if (result.changes !== 1) throw new Error("Command start intent is missing");
  }

  complete(input: JobCompletion): void {
    const completion = parseCompletion(input);
    if (completion.executorId !== this.executorId) throw new Error("Completion executor does not own this journal");
    const entry = this.get(completion.jobId);
    if (!entry) throw new Error("Completion has no assignment");
    if (entry.completion) {
      if (JSON.stringify(entry.completion) !== JSON.stringify(completion)) throw new Error("A terminal command result is immutable");
      return;
    }
    this.database.prepare("UPDATE jobs SET phase = 'terminal', completion = ?, acknowledged = 0 WHERE job_id = ?").run(JSON.stringify(completion), completion.jobId);
  }

  pendingCompletions(): JobCompletion[] {
    return (this.database.prepare("SELECT completion FROM jobs WHERE phase = 'terminal' AND acknowledged = 0 ORDER BY rowid").all() as { completion: string }[])
      .map(row => parseCompletion(JSON.parse(row.completion)));
  }

  acknowledge(jobId: string): void {
    this.database.prepare("UPDATE jobs SET acknowledged = 1 WHERE job_id = ? AND phase = 'terminal'").run(jobId);
  }

  requestResend(jobId: string): void {
    this.database.prepare("UPDATE jobs SET acknowledged = 0 WHERE job_id = ? AND phase = 'terminal'").run(jobId);
  }

  get recoveryPaused(): boolean {
    const row = this.database.prepare("SELECT value FROM meta WHERE key = 'recovery_paused'").get() as { value: string } | undefined;
    return row?.value === "1";
  }

  pauseExecution(): void {
    this.database.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('recovery_paused', '1')").run();
  }

  resumeAfterOwnerConfirmation(): void {
    this.database.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('recovery_paused', '0')").run();
  }

  snapshot(): JournalStatus {
    return status(this.database);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try { this.database.close(); } finally { this.lock.close(); }
  }
}

export function readJournalStatus(directory: string): JournalStatus | null {
  const path = join(privateDirectory(directory, false), "execution.sqlite");
  if (!existsSync(path)) return null;
  closeSync(privateFile(path));
  const database = new DatabaseSync(path, { readOnly: true });
  try { return status(database); } finally { database.close(); }
}
