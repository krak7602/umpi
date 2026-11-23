import { execFile, spawn } from "node:child_process";
import type { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import type { JobCompletion, MacJobAssignment } from "../shared/protocol.js";
import { MAX_JOB_OUTPUT } from "../shared/protocol.js";
import { allowedCwd } from "./config.js";

export interface RunningCommand {
  pid: number | undefined;
  completion: Promise<JobCompletion>;
  cancel(): void;
}

export function commandEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (!/^(UMPI_|TELEGRAM_)/i.test(key)) clean[key] = value;
  }
  return clean;
}

export function rejectedCommand(executorId: string, assignment: MacJobAssignment, message: string, status: "failed" | "cancelled" = "failed"): JobCompletion {
  return { executorId, jobId: assignment.jobId, status, exitCode: null, output: message, truncated: false, finishedAt: new Date().toISOString() };
}

/** How long a stopped command has after SIGTERM before SIGKILL. */
const GRACE_MS = 500;
/** How long one stop pass waits for the command's processes to leave the process table. */
const SETTLE_MS = 3_000;
const POLL_MS = 100;
/** How long the output pipes have to close once nothing of the command is left. */
const CLOSE_MS = 250;

interface ProcessRow { pid: number; parent: number; group: number; zombie: boolean; started: string }

/** Runs a system tool with a fixed environment. Undefined when it did not run to its end. */
function tool(file: string, args: string[]): Promise<string | undefined> {
  return new Promise(resolve => {
    execFile(file, args, { env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LC_ALL: "C" }, timeout: 5_000, maxBuffer: 16 * 1024 * 1024, encoding: "utf8" },
      (error, stdout) => resolve(error && (error.killed || typeof error.code !== "number") ? undefined : stdout));
  });
}

/** The process table: pid, parent, process group, state, and start time. Undefined when it cannot be read. */
async function processTable(): Promise<ProcessRow[] | undefined> {
  const output = await tool("/bin/ps", ["-axo", "pid=,ppid=,pgid=,stat=,lstart="]);
  const rows: ProcessRow[] = [];
  for (const line of output?.split("\n") ?? []) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(line);
    if (match) rows.push({ pid: Number(match[1]), parent: Number(match[2]), group: Number(match[3]), zombie: match[4]!.startsWith("Z"), started: match[5]! });
  }
  return rows.length ? rows : undefined;
}

function descriptor(stream: Readable): number | undefined {
  // Node has no public name for a pipe's descriptor.
  const fd = (stream as unknown as { _handle?: { fd?: unknown } | null })._handle?.fd;
  return typeof fd === "number" && fd >= 0 ? fd : undefined;
}

// This is approved native shell access, not a filesystem sandbox. The cwd check
// only controls where execution starts; an approved command can access other files.
export function startCommand(executorId: string, assignment: MacJobAssignment, workspaces: readonly string[]): RunningCommand {
  const cwd = allowedCwd(assignment.cwd, workspaces);
  const startedAt = Date.now();
  const child = spawn("/bin/sh", ["-c", assignment.command], {
    cwd,
    env: commandEnvironment(),
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const group = child.pid;
  const buffers: Buffer[] = [];
  let bytes = 0;
  let truncated = false;
  let stopReason: "cancelled" | "timeout" | null = null;
  let spawnFailed = false;
  let exit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  let closed = false;
  let finished = false;
  // A scan after the shell's exit found the group empty. Its number can then be reused, so it is never signalled again.
  let groupGone = group === undefined;
  // Processes of the command outside its group: descendants found by parent chain, and holders of its output.
  // The start time tells a reused pid apart.
  const tracked = new Map<number, string>();
  // The last stop pass ended with processes still in the table.
  let survivors = false;
  // The output had to be closed while a process that could not be found still held it.
  let stray = false;
  let sweep: Promise<void> | undefined;
  let again = false;
  let settling: Promise<void> | undefined;
  const outputClosed = Promise.withResolvers<void>();
  const completion = Promise.withResolvers<JobCompletion>();

  function capture(data: Buffer): void {
    const available = MAX_JOB_OUTPUT - bytes;
    if (data.length > available) truncated = true;
    if (available > 0) {
      const retained = Buffer.from(data.subarray(0, available));
      buffers.push(retained);
      bytes += retained.length;
    }
  }
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);

  function groupAnswers(): boolean {
    if (groupGone || group === undefined) return false;
    try {
      process.kill(-group, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== "ESRCH";
    }
  }

  // What one reading of the process table still shows of the command.
  function remaining(rows: ProcessRow[] | undefined): { inGroup: boolean; others: number[] } {
    if (!rows) {
      const inGroup = groupAnswers();
      if (exit && !inGroup) groupGone = true;
      return { inGroup, others: [] };
    }
    const alive = rows.filter(row => !row.zombie);
    const members = groupGone ? [] : alive.filter(row => row.group === group);
    if (exit && !members.length) groupGone = true;
    const known = new Set(members.map(row => row.pid));
    for (const [pid, started] of tracked) {
      if (alive.some(row => row.pid === pid && row.started === started)) known.add(pid);
      else tracked.delete(pid);
    }
    // A descendant that left the group is found through its parent while the parent lives, and stays tracked after.
    for (let grew = true; grew;) {
      grew = false;
      for (const row of alive) {
        if (known.has(row.pid) || !known.has(row.parent) || Date.parse(row.started) < startedAt - 2_000) continue;
        known.add(row.pid);
        tracked.set(row.pid, row.started);
        grew = true;
      }
    }
    return { inGroup: members.length > 0, others: [...tracked.keys()] };
  }

  function signal(left: { inGroup: boolean; others: number[] }, name: NodeJS.Signals): void {
    for (const target of [...(left.inGroup && group !== undefined ? [-group] : []), ...left.others]) {
      try {
        process.kill(target, name);
      } catch {
        // Gone already, or not ours to signal. The next reading of the table decides.
      }
    }
  }

  // One stop pass: SIGTERM, SIGKILL after the grace period, and a new reading until nothing is left.
  async function pass(): Promise<void> {
    const begun = Date.now();
    let asked = false;
    for (;;) {
      const left = remaining(await processTable());
      if (!left.inGroup && !left.others.length) {
        survivors = false;
        return;
      }
      const waited = Date.now() - begun;
      if (waited >= SETTLE_MS) {
        survivors = true;
        return;
      }
      if (waited >= GRACE_MS) signal(left, "SIGKILL");
      else if (!asked) {
        signal(left, "SIGTERM");
        asked = true;
      }
      await delay(POLL_MS);
    }
  }

  // Every request stops the command again: a request during a pass adds one more pass after it.
  function terminate(): Promise<void> {
    if (sweep) {
      again = true;
      return sweep;
    }
    const running = (async () => {
      do {
        again = false;
        await pass();
      } while (again);
    })().finally(() => { sweep = undefined; });
    sweep = running;
    return running;
  }

  // Other processes that hold the far end of the output pipes, by lsof's socket addresses. Undefined when unknown.
  async function outputHolders(): Promise<number[] | undefined> {
    const open = () => [child.stdout, child.stderr].map(descriptor).filter(fd => fd !== undefined).join(",");
    const fds = open();
    if (!fds) return undefined;
    const own = await tool("/usr/sbin/lsof", ["-nP", "-a", "-p", String(process.pid), "-d", fds, "-F", "dn"]);
    const all = own === undefined ? undefined : await tool("/usr/sbin/lsof", ["-nP", "-U", "-F", "pn"]);
    // A descriptor that closed meanwhile can name another pipe by now. Use the answer only when nothing changed.
    if (own === undefined || all === undefined || open() !== fds) return undefined;
    const near = new Set(own.split("\n").filter(line => line.startsWith("d")).map(line => line.slice(1)));
    if (!near.size) return undefined;
    const holders = new Set<number>();
    let pid = 0;
    for (const line of all.split("\n")) {
      if (line.startsWith("p")) pid = Number(line.slice(1));
      else if (pid !== process.pid && line.startsWith("n->") && near.has(line.slice(3))) holders.add(pid);
    }
    return [...holders];
  }

  function finish(): void {
    if (finished) return;
    finished = true;
    clearTimeout(timeout);
    // A holder that could not be stopped must not keep the job open.
    child.stdout.destroy();
    child.stderr.destroy();
    const code = exit?.code ?? null;
    let output = Buffer.concat(buffers, bytes).toString("utf8");
    let status: JobCompletion["status"] = code === 0 ? "succeeded" : "failed";
    let notice = "";
    if (survivors) {
      status = "uncertain";
      notice = "Process-group termination could not be confirmed; external effects may still be in progress.";
    } else if (stray) {
      status = "uncertain";
      notice = "A process outside the command's process group kept its output open and could not be found; it may still be running.";
    } else if (stopReason === "cancelled") {
      status = "cancelled";
      notice = "Command cancelled; external effects before cancellation are not undone.";
    } else if (stopReason === "timeout") {
      status = "failed";
      notice = "Command exceeded its timeout and its process group was stopped.";
    } else if (spawnFailed) {
      status = "failed";
      notice = "The command process could not be started.";
    } else if (exit?.signal) {
      notice = `Command terminated by ${exit.signal}.`;
    }
    if (notice) {
      const suffix = `\n${notice}`;
      if (output.length + suffix.length > MAX_JOB_OUTPUT) truncated = true;
      output = output.slice(0, MAX_JOB_OUTPUT - suffix.length) + suffix;
    }
    completion.resolve({
      executorId,
      jobId: assignment.jobId,
      status,
      exitCode: status === "uncertain" ? null : code,
      output,
      truncated,
      finishedAt: new Date().toISOString(),
    });
  }

  // After the shell is gone: stop what is left of the command, then report. A shell may exit while descendants
  // still hold its output pipes, in its group or outside it.
  async function settle(): Promise<void> {
    if (sweep) await sweep;
    else if (tracked.size || groupAnswers()) await terminate();
    else groupGone = true;
    const closing = () => closed ? undefined : Promise.race([outputClosed.promise, delay(CLOSE_MS)]);
    await closing();
    if (!closed) {
      const holders = await outputHolders();
      const rows = holders?.length ? await processTable() : undefined;
      for (const pid of holders ?? []) {
        const row = rows?.find(item => item.pid === pid && !item.zombie);
        if (row) tracked.set(pid, row.started);
      }
      if (tracked.size) {
        await terminate();
        await closing();
      }
    }
    while (sweep) await sweep;
    if (!closed && !spawnFailed) stray = true;
    finish();
  }

  function stop(reason: "cancelled" | "timeout"): void {
    if (finished) return;
    stopReason ??= reason;
    // A shell that outlives a whole pass cannot be waited for. Report it as unconfirmed.
    void terminate().then(() => { if (survivors && !exit) finish(); });
  }

  // A failed cleanup proves nothing about the command's processes.
  const ended = () => { settling ??= settle().catch(() => { survivors = true; finish(); }); };
  const timeout = setTimeout(() => stop("timeout"), assignment.timeoutMs);
  child.once("error", () => {
    spawnFailed = true;
    ended();
  });
  child.once("exit", (code, signal) => {
    exit = { code, signal };
    ended();
  });
  child.once("close", () => {
    closed = true;
    outputClosed.resolve();
  });
  return { pid: child.pid, completion: completion.promise, cancel: () => stop("cancelled") };
}
