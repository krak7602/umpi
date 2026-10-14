import { spawn } from "node:child_process";
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

// This is approved native shell access, not a filesystem sandbox. The cwd check
// only controls where execution starts; an approved command can access other files.
export function startCommand(executorId: string, assignment: MacJobAssignment, workspaces: readonly string[]): RunningCommand {
  const cwd = allowedCwd(assignment.cwd, workspaces);
  const child = spawn("/bin/sh", ["-c", assignment.command], {
    cwd,
    env: commandEnvironment(),
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const buffers: Buffer[] = [];
  let bytes = 0;
  let truncated = false;
  let stopReason: "cancelled" | "timeout" | null = null;
  let spawnFailed = false;
  let terminationFailed = false;
  let cleanup: Promise<void> | undefined;
  let finished = false;

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

  function signalGroup(signal: NodeJS.Signals): boolean {
    if (child.pid === undefined) return false;
    try {
      process.kill(-child.pid, signal);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") terminationFailed = true;
      return false;
    }
  }

  function terminateGroup(): Promise<void> {
    if (!cleanup) {
      cleanup = (async () => {
        if (signalGroup("SIGTERM")) {
          await delay(500);
          signalGroup("SIGKILL");
        }
      })();
    }
    return cleanup;
  }

  function stop(reason: "cancelled" | "timeout"): void {
    if (finished || stopReason !== null) return;
    stopReason = reason;
    void terminateGroup();
  }

  const timeout = setTimeout(() => stop("timeout"), assignment.timeoutMs);
  const completion = new Promise<JobCompletion>(resolve => {
    child.once("error", () => { spawnFailed = true; });
    // A shell may exit while descendants still hold its output pipes. Clean up
    // the process group on exit as well as on cancellation and timeout.
    child.once("exit", () => { void terminateGroup(); });
    child.once("close", (code, signal) => {
      void (async () => {
        clearTimeout(timeout);
        await terminateGroup();
        finished = true;
        let output = Buffer.concat(buffers, bytes).toString("utf8");
        let status: JobCompletion["status"] = code === 0 ? "succeeded" : "failed";
        let notice = "";
        if (terminationFailed) {
          status = "uncertain";
          notice = "Process-group termination could not be confirmed; external effects may still be in progress.";
        } else if (stopReason === "cancelled") {
          status = "cancelled";
          notice = "Command cancelled; external effects before cancellation are not undone.";
        } else if (stopReason === "timeout") {
          status = "failed";
          notice = "Command exceeded its timeout and its process group was stopped.";
        } else if (spawnFailed) {
          status = "failed";
          notice = "The command process could not be started.";
        } else if (signal) {
          notice = `Command terminated by ${signal}.`;
        }
        if (notice) {
          const suffix = `\n${notice}`;
          if (output.length + suffix.length > MAX_JOB_OUTPUT) truncated = true;
          output = output.slice(0, MAX_JOB_OUTPUT - suffix.length) + suffix;
        }
        resolve({
          executorId,
          jobId: assignment.jobId,
          status,
          exitCode: status === "uncertain" ? null : code,
          output,
          truncated,
          finishedAt: new Date().toISOString(),
        });
      })();
    });
  });
  return { pid: child.pid, completion, cancel: () => stop("cancelled") };
}
