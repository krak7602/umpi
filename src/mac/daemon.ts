import { setTimeout as delay } from "node:timers/promises";
import type { ExecutorPollResult, JobCompletion, MacJobAssignment } from "../shared/protocol.js";
import { parsePollResult } from "../shared/protocol.js";
import { coordinatorUrl } from "../shared/coordinator-url.ts";
import type { CodingExecutorPoll, CodingExecutorPollResult, CodingExecutorReport } from "../shared/coding.js";
import { MAX_CODING_RPC_BYTES } from "../shared/coding-rpc.js";
import { MacCodingExecutor, parseCodingPollResult } from "./coding.js";
import type { BrowserExecutorPoll, BrowserExecutorPollResult, BrowserExecutorReport } from "../shared/browser.js";
import { MacBrowserExecutor, parseBrowserPollResult } from "./browser.js";
import type { MacConfig } from "./config.js";
import { ExecutionJournal } from "./journal.js";
import { rejectedCommand, startCommand, type RunningCommand } from "./command.js";

export class CoordinatorUnavailable extends Error {
  constructor(readonly status?: number) {
    super(status === undefined ? "Coordinator request failed; retaining durable state" : `Coordinator returned HTTP ${status}; retaining durable state`);
  }
}

export class CoordinatorClient {
  private readonly origin: URL;
  constructor(private readonly config: MacConfig) {
    this.origin = coordinatorUrl(config.serverUrl);
  }

  private async request(path: string, body: unknown, signal?: AbortSignal): Promise<Response> {
    const timeout = AbortSignal.timeout(10_000);
    try {
      const response = await fetch(new URL(path, this.origin), {
        method: "POST",
        headers: { authorization: `Bearer ${this.config.executorToken}`, "content-type": "application/json" },
        body: JSON.stringify(body),
        redirect: "error",
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new CoordinatorUnavailable(response.status);
      }
      return response;
    } catch (error) {
      if (error instanceof CoordinatorUnavailable) throw error;
      throw new CoordinatorUnavailable();
    }
  }

  async poll(signal?: AbortSignal): Promise<ExecutorPollResult> {
    const response = await this.request("/api/executor/poll", { executorId: this.config.executorId, workspaces: this.config.workspaces }, signal);
    try {
      if (!response.body) throw new Error("Missing poll response");
      const reader = response.body.getReader();
      const buffers: Uint8Array[] = [];
      let length = 0;
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        length += chunk.value.length;
        if (length > 131_072) {
          await reader.cancel();
          throw new Error("Poll response too large");
        }
        buffers.push(chunk.value);
      }
      return parsePollResult(JSON.parse(Buffer.concat(buffers, length).toString("utf8")));
    } catch { throw new CoordinatorUnavailable(); }
  }

  async complete(completion: JobCompletion, signal?: AbortSignal): Promise<void> {
    const response = await this.request("/api/executor/complete", completion, signal);
    await response.body?.cancel();
  }

  async pollCoding(poll: CodingExecutorPoll, signal?: AbortSignal): Promise<CodingExecutorPollResult> {
    const response = await this.request("/api/executor/coding/poll", poll, signal);
    try {
      if (!response.body) throw new Error("Missing coding poll response");
      const reader = response.body.getReader();
      const buffers: Uint8Array[] = [];
      let length = 0;
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        length += chunk.value.length;
        if (length > MAX_CODING_RPC_BYTES + 131_072) {
          await reader.cancel();
          throw new Error("Coding poll response too large");
        }
        buffers.push(chunk.value);
      }
      return parseCodingPollResult(JSON.parse(Buffer.concat(buffers, length).toString("utf8")));
    } catch { throw new CoordinatorUnavailable(); }
  }

  async reportCoding(report: CodingExecutorReport, signal?: AbortSignal): Promise<void> {
    const response = await this.request("/api/executor/coding/report", report, signal);
    await response.body?.cancel();
  }

  async pollBrowser(poll: BrowserExecutorPoll, signal?: AbortSignal): Promise<BrowserExecutorPollResult> {
    const response = await this.request("/api/executor/browser/poll", poll, signal);
    try {
      if (!response.body) throw new Error("Missing browser poll response");
      const reader = response.body.getReader();
      const buffers: Uint8Array[] = [];
      let length = 0;
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        length += chunk.value.length;
        if (length > 8 * 1024 * 1024) {
          await reader.cancel();
          throw new Error("Browser poll response too large");
        }
        buffers.push(chunk.value);
      }
      const allowLoopback = ["localhost", "127.0.0.1", "[::1]"].includes(this.origin.hostname);
      return parseBrowserPollResult(JSON.parse(Buffer.concat(buffers, length).toString("utf8")), allowLoopback);
    } catch { throw new CoordinatorUnavailable(); }
  }

  async reportBrowser(report: BrowserExecutorReport, signal?: AbortSignal): Promise<void> {
    const response = await this.request("/api/executor/browser/report", report, signal);
    await response.body?.cancel();
  }
}

interface ActiveCommand {
  jobId: string;
  command: RunningCommand;
  settled: Promise<void>;
}
export type ExecutorEvent = "coordinator_unavailable" | "coordinator_connected" | "recovery_paused" | "command_started" | "command_finished";

export class MacExecutor {
  private active: ActiveCommand | undefined;
  private fault: Error | undefined;
  private stopping = false;
  private disconnected: boolean | undefined;
  private readonly client: CoordinatorClient;
  private readonly shutdown = new AbortController();

  constructor(readonly config: MacConfig, readonly journal: ExecutionJournal, private readonly emit: (event: ExecutorEvent) => void = () => {}, readonly coding?: MacCodingExecutor, readonly browser?: MacBrowserExecutor) {
    this.client = new CoordinatorClient(config);
  }

  get runningJobId(): string | null {
    return this.active?.jobId ?? null;
  }

  async acceptAssignment(assignment: MacJobAssignment, cancelled = false): Promise<void> {
    if (this.coding?.ownsSlot && !this.journal.get(assignment.jobId)?.completion) throw new Error("A coding run owns the executor slot");
    const entry = this.journal.accept(assignment);
    if (entry.completion) {
      this.journal.requestResend(assignment.jobId);
      return;
    }
    if (cancelled) {
      this.cancel(assignment.jobId);
      return;
    }
    if (this.active || this.stopping || this.journal.recoveryPaused) return;
    if (entry.phase !== "assigned") throw new Error("Unexpected unreconciled command in execution journal");
    this.journal.startIntent(assignment.jobId);
    let command: RunningCommand;
    try {
      command = startCommand(this.config.executorId, assignment, this.config.workspaces);
    } catch {
      this.journal.complete(rejectedCommand(this.config.executorId, assignment, "Command was not started: working directory validation or process creation failed."));
      return;
    }
    try {
      if (command.pid !== undefined) this.journal.running(assignment.jobId, command.pid);
    } catch {
      command.cancel();
      await command.completion;
      throw new Error("Command start could not be journaled; executor must stop and reconcile");
    }
    const active: ActiveCommand = { jobId: assignment.jobId, command, settled: Promise.resolve() };
    this.active = active;
    active.settled = command.completion.then(completion => {
      try {
        if (completion.status === "uncertain") this.journal.pauseExecution();
        this.journal.complete(completion);
        this.emit("command_finished");
      } catch {
        this.fault = new Error("Command result could not be persisted; executor must stop and reconcile");
      } finally {
        if (this.active === active) this.active = undefined;
      }
    });
    this.emit("command_started");
  }

  cancel(jobId: string): void {
    if (this.active?.jobId === jobId) {
      this.active.command.cancel();
      return;
    }
    const entry = this.journal.get(jobId);
    if (!entry) return; // Unknown coordinator state is not evidence of a local result.
    if (entry.completion) this.journal.requestResend(jobId);
    else if (entry.phase === "assigned") {
      this.journal.complete(rejectedCommand(this.config.executorId, entry.assignment, "Command cancelled before execution started.", "cancelled"));
    }
  }

  async waitForIdle(): Promise<void> {
    await this.active?.settled;
    if (this.fault) throw this.fault;
  }

  async flushCompletions(signal?: AbortSignal): Promise<void> {
    for (const completion of this.journal.pendingCompletions()) {
      await this.client.complete(completion, signal);
      this.journal.acknowledge(completion.jobId);
    }
  }

  async flushCodingReports(signal?: AbortSignal): Promise<void> {
    await this.coding?.flushReports(report => this.client.reportCoding(report, signal));
  }

  async flushBrowserReports(signal?: AbortSignal): Promise<void> {
    await this.browser?.flushReports(report => this.client.reportBrowser(report, signal));
  }

  async pollOnce(signal?: AbortSignal): Promise<void> {
    if (this.fault) throw this.fault;
    // Browser has an independent slot and must receive cancellation even when
    // shell/coding transport fails or either execution lane is unavailable.
    const results = await Promise.allSettled([this.pollCommandLanes(signal), this.pollBrowserLane(signal)]);
    const failures = results.filter(result => result.status === "rejected");
    const failure = failures.find(result => !(result.reason instanceof CoordinatorUnavailable)) ?? failures[0];
    if (failure) throw failure.reason;
  }

  private async pollBrowserLane(signal?: AbortSignal): Promise<void> {
    if (this.stopping || !this.browser?.shouldPoll) return;
    const result = await this.client.pollBrowser({
      executorId: this.config.executorId,
      available: this.browser.available,
      allSites: this.browser.available && this.config.browser.allSites,
      activeRunId: this.browser.activeRunId,
      sites: this.browser.advertisedSites(),
    }, signal);
    await this.browser.handlePoll(result, !this.stopping);
  }

  private async pollCommandLanes(signal?: AbortSignal): Promise<void> {
    // Shell and coding claims are deliberately sequential: the old shell endpoint
    // has no availability field and therefore must not be called while coding owns
    // the slot. Coding polling still receives cancellation while either lane runs.
    if (!this.coding?.ownsSlot) {
      const result = await this.client.poll(signal);
      for (const jobId of result.cancelJobIds) this.cancel(jobId);
      if (result.job) await this.acceptAssignment(result.job, result.cancelJobIds.includes(result.job.jobId));
    }
    if (this.stopping || !this.coding?.shouldPoll) return;
    const shellBusy = this.active !== undefined || this.journal.recoveryPaused || this.journal.snapshot().outstanding.some(entry => entry.phase !== "terminal");
    const available = !shellBusy && this.coding.available;
    const result = await this.client.pollCoding({
      executorId: this.config.executorId,
      workspaces: this.config.workspaces,
      available,
      activeRunId: this.coding.activeRunId,
    }, signal);
    await this.coding.handlePoll(result, !shellBusy && !this.stopping);
  }

  async run(signal: AbortSignal): Promise<void> {
    const stop = () => {
      this.stopping = true;
      this.shutdown.abort();
      this.active?.command.cancel();
      void this.coding?.shutdown().catch(() => { this.fault = new Error("Coding shutdown could not be persisted; reconcile before resuming"); });
      void this.browser?.shutdown().catch(() => { this.fault = new Error("Browser shutdown could not be persisted; reconcile before resuming"); });
    };
    signal.addEventListener("abort", stop, { once: true });
    if (signal.aborted) stop();
    if (this.journal.recoveryPaused || this.coding?.recoveryPaused || this.browser?.recoveryPaused) this.emit("recovery_paused");
    try {
      while (!this.stopping) {
        // Callback loss must not prevent the independent poll from receiving a
        // cancellation. Both requests only carry this executor's credential.
        const results = await Promise.allSettled([
          this.flushCompletions(this.shutdown.signal),
          this.flushCodingReports(this.shutdown.signal),
          this.flushBrowserReports(this.shutdown.signal),
          this.pollOnce(this.shutdown.signal),
        ]);
        let unavailable = false;
        for (const result of results) {
          if (result.status === "rejected") {
            if (!(result.reason instanceof CoordinatorUnavailable)) throw result.reason;
            unavailable = true;
          }
        }
        if (this.stopping) break;
        if (unavailable !== this.disconnected) this.emit(unavailable ? "coordinator_unavailable" : "coordinator_connected");
        this.disconnected = unavailable;
        if (this.fault) throw this.fault;
        try { await delay(this.config.pollIntervalMs, undefined, { signal: this.shutdown.signal }); } catch { break; }
      }
    } finally {
      signal.removeEventListener("abort", stop);
      stop();
      await Promise.all([this.coding?.shutdown(), this.browser?.shutdown(), this.waitForIdle()]);
      // Durable results remain available for the next run if shutdown delivery
      // fails. Do not hold teardown open for an unreachable coordinator.
      try { await this.flushCompletions(AbortSignal.timeout(2000)); } catch { /* Retry from the journal on reconnect. */ }
      try { await this.flushCodingReports(AbortSignal.timeout(2000)); } catch { /* Durable coding receipts retry on reconnect. */ }
      try { await this.flushBrowserReports(AbortSignal.timeout(2000)); } catch { /* Durable browser receipts and actual-stop reports retry on reconnect. */ }
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.shutdown.abort();
    this.active?.command.cancel();
    await Promise.all([this.coding?.shutdown(), this.browser?.shutdown(), this.waitForIdle()]);
  }
}
