import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, openSync, writeSync } from "node:fs";
import { resolve } from "node:path";
import type { Readable } from "node:stream";
import type { Context } from "@earendil-works/chord";
import { ExecutionError, StreamDecoder, err, ok, type Result, type ShellExecOptions, type ShellExecResult } from "@earendil-works/pi-durable/env";
import { codingProcessLaunch, type CodingProcessLaunch } from "./process-supervisor.js";

export const MAX_CODING_SHELL_BYTES = 16 * 1024 * 1024;

/** No ambient agent credentials or interpreter preload hooks enter approved native subprocesses. */
export function codingCommandEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (/^(UMPI_|TELEGRAM_|OPENAI_|ANTHROPIC_|CLAUDE_|GEMINI_|GOOGLE_|PI_|OMP_|ASIDE_|CLERK_|AWS_|AZURE_|CLOUDFLARE_|CF_|GITHUB_|GH_|HF_|HUGGING_FACE_|COHERE_|MISTRAL_|GROQ_|XAI_|DEEPSEEK_|OPENROUTER_|TOGETHER_|FIREWORKS_|CEREBRAS_|VENICE_|ZAI_|MINIMAX_|MOONSHOT_|QWEN_|DASHSCOPE_|SILICONFLOW_|NVIDIA_|VERCEL_|MODEL_)/i.test(key) || /(?:TOKEN|SECRET|PASSWORD|CREDENTIAL|API_?KEY|PRIVATE_?KEY)/i.test(key) || /^(NODE_OPTIONS|NODE_PATH|BASH_ENV|ENV|SHELLOPTS|BASHOPTS|CDPATH|GLOBIGNORE|LD_.*|DYLD_.*|PYTHONPATH|PYTHONHOME|RUBYOPT|RUBYLIB|PERL5OPT|PERL5LIB|ZDOTDIR)$/i.test(key)) continue;
    clean[key] = value;
  }
  return clean;
}

export interface CodingShellOptions {
  cwd: string;
  deadlineAt: string;
  command: string | readonly string[];
  options?: ShellExecOptions;
  context: Context;
  /** Allocated in the session's private disposable directory. */
  spillPath: () => string;
  chargeOutput: (bytes: number) => void;
  onUncertain: () => void;
}

/** Linux owns all descendants; native Mac explicitly owns only the anchored foreground group. */
export async function executeCodingShell(input: CodingShellOptions): Promise<Result<ShellExecResult, ExecutionError>> {
  const { options, context } = input;
  if (context.abortSignal?.aborted) return err(new ExecutionError("aborted", "Command cancelled before spawn"));
  if (options?.timeout !== undefined && (!Number.isFinite(options.timeout) || options.timeout <= 0 || options.timeout * 1000 > 2_147_483_647)) return err(new ExecutionError("timeout", "Invalid command timeout"));
  if (options?.spill && (!Number.isSafeInteger(options.spill.afterBytes) || options.spill.afterBytes < 0 || options.spill.afterBytes > MAX_CODING_SHELL_BYTES || !Number.isSafeInteger(options.spill.afterLines) || options.spill.afterLines < 0)) return err(new ExecutionError("unknown", "Invalid shell spill bounds"));
  const argv = typeof input.command === "string" ? ["/bin/bash", "-c", input.command] : [...input.command];
  if (!argv[0]) return err(new ExecutionError("spawn_error", "Empty command"));
  const deadline = Math.min(Date.parse(input.deadlineAt), options?.timeout === undefined ? Infinity : Date.now() + options.timeout * 1000);
  if (!Number.isFinite(deadline) || deadline <= Date.now()) return err(new ExecutionError("timeout", "Command deadline has elapsed"));
  let launch: CodingProcessLaunch;
  try { launch = codingProcessLaunch(argv, input.cwd, deadline); }
  catch (error) { return err(new ExecutionError("spawn_error", error instanceof Error ? error.message : "Coding process supervision unavailable")); }
  const environment = codingCommandEnvironment({ ...(options?.inheritEnv === false ? {} : process.env), ...options?.env });
  const { promise, resolve: resolveResult } = Promise.withResolvers<Result<ShellExecResult, ExecutionError>>();
  let child: ChildProcess;
  try { child = spawn(launch.executable, launch.args, { cwd: resolve(input.cwd, options?.cwd ?? "."), env: environment, detached: true, stdio: ["pipe", "pipe", "pipe", "pipe"] }); }
  catch (error) { return err(new ExecutionError("spawn_error", error instanceof Error ? error.message : "Could not spawn command")); }
  const stdout = child.stdout!, stderr = child.stderr!, status = child.stdio[3] as Readable;
  const decoders = { stdout: new StreamDecoder(), stderr: new StreamDecoder() };
  let failure: ExecutionError | undefined;
  let finished = false;
  let bytes = 0, newlines = 0;
  const prefix: Buffer[] = [];
  let spill: string | undefined, descriptor: number | undefined;
  let timer: NodeJS.Timeout | undefined, settlementTimer: NodeJS.Timeout | undefined;
  let protocol = "", protocolOffset = 0;
  let receipt: { kind: "CLEAN" | "GROUP" | "GROUP_ABORT" | "GROUP_TIMEOUT"; code: number; execError: number } | undefined;
  let spawnFailed = false, uncertain = false, blocked = false;

  const markUncertain = (message: string) => {
    if (!uncertain) input.onUncertain();
    uncertain = true;
    failure = new ExecutionError("unknown", message);
  };
  const requestCleanup = () => {
    // Linux subreaper or Mac's in-group lifetime watcher performs actual cleanup.
    // Never send delayed numerical PID/group signals from Node, and never kill
    // the Linux helper before it has killed/reaped its children.
    child.stdin?.destroy();
  };
  const settle = (signal: NodeJS.Signals | null, forced = false) => {
    if (finished) return;
    if (!forced && !spawnFailed && !uncertain) {
      const clean = launch.ownership === "linux-descendants"
        ? receipt?.kind === "CLEAN" && child.exitCode === 0
        : signal === "SIGKILL" && receipt !== undefined && receipt.kind !== "CLEAN";
      if (!clean && !blocked) markUncertain("Process supervisor could not certify owned-process cleanup");
    }
    for (const stream of ["stdout", "stderr"] as const) emit(decoders[stream].decode(), stream);
    finished = true;
    clearTimeout(timer);
    clearTimeout(settlementTimer);
    context.abortSignal?.removeEventListener("abort", abort);
    child.stdin?.destroy();
    stdout.destroy();
    stderr.destroy();
    status.destroy();
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch { failure ??= new ExecutionError("unknown", "Failed to close command output spill"); }
    }
    if (failure) {
      if (spill) failure.spillPath = spill;
      resolveResult(err(failure));
    } else if (receipt) {
      if (receipt.execError !== 0) resolveResult(err(new ExecutionError("spawn_error", `Command exec failed with operating-system error ${receipt.execError}`)));
      else resolveResult(ok({ exitCode: receipt.code, ...(spill ? { spillPath: spill } : {}) }));
    } else resolveResult(err(new ExecutionError("unknown", "Command produced no exit receipt")));
  };
  const armSettlement = () => {
    settlementTimer ??= setTimeout(() => {
      markUncertain("Owned processes did not settle after cleanup; effects remain uncertain");
      settle(null, true);
    }, 1500);
  };
  const stop = (error: ExecutionError) => {
    failure ??= error;
    requestCleanup();
    armSettlement();
  };
  const abort = () => stop(new ExecutionError("aborted", "Command cancelled; prior external effects are not rolled back"));
  const emit = (text: string, stream: "stdout" | "stderr") => {
    if (finished || !text || failure) return;
    try { options?.onOutput?.(text, context, { stream }); }
    catch (error) { stop(new ExecutionError("callback_error", error instanceof Error ? error.message : "Output callback failed")); }
  };
  const feed = (data: Buffer, stream: "stdout" | "stderr") => {
    if (finished || failure) return;
    bytes += data.length;
    try {
      input.chargeOutput(data.length);
      if (bytes > MAX_CODING_SHELL_BYTES) throw new Error("Command output exceeds the bounded coding output allowance");
      emit(decoders[stream].decode(data), stream);
      if (!options?.spill) return;
      for (const byte of data) if (byte === 10) newlines++;
      if (descriptor === undefined && (bytes > options.spill.afterBytes || newlines + (data.at(-1) === 10 ? 0 : 1) > options.spill.afterLines)) {
        spill = input.spillPath();
        descriptor = openSync(spill, "wx", 0o600);
        for (const previous of prefix) writeAll(descriptor, previous);
        prefix.length = 0;
      }
      if (descriptor === undefined) prefix.push(data);
      else writeAll(descriptor, data);
    } catch (error) { stop(new ExecutionError("unknown", error instanceof Error ? error.message : "Could not preserve shell output")); }
  };
  stdout.on("data", (data: Buffer) => feed(data, "stdout"));
  stderr.on("data", (data: Buffer) => feed(data, "stderr"));
  child.stdin?.on("error", () => { /* Owner-lifetime EOF is expected during cleanup. */ });
  status.on("data", (data: Buffer) => {
    if (finished) return;
    protocol += data.toString("utf8");
    if (protocol.length > 4096) { markUncertain("Invalid bounded process-supervisor protocol"); requestCleanup(); armSettlement(); return; }
    let end: number;
    while ((end = protocol.indexOf("\n", protocolOffset)) !== -1) {
      const line = protocol.slice(protocolOffset, end);
      protocolOffset = end + 1;
      const parsed = /^UMPI_SUPERVISOR_V1 (CLEAN|GROUP|GROUP_ABORT|GROUP_TIMEOUT) (\d{1,3}) (\d{1,10})(?: ([012]))?$/.exec(line);
      const kind = parsed?.[1];
      if (parsed && (kind === "CLEAN" || kind === "GROUP" || kind === "GROUP_ABORT" || kind === "GROUP_TIMEOUT") && Number(parsed[2]) <= 255 && Number(parsed[3]) <= 2_147_483_647 && (kind === "CLEAN" ? parsed[4] !== undefined : parsed[4] === undefined)) {
        receipt = { kind, code: Number(parsed[2]), execError: Number(parsed[3]) };
        if (receipt.kind === "GROUP_TIMEOUT" || parsed[4] === "1") failure ??= new ExecutionError("timeout", "Command exceeded its deadline");
        if (receipt.kind === "GROUP_ABORT" || parsed[4] === "2") failure ??= new ExecutionError("aborted", "Command cancelled; prior external effects are not rolled back");
      } else if (/^UMPI_SUPERVISOR_V1 BLOCKED [a-z_]+$/.test(line)) {
        blocked = true;
        failure ??= new ExecutionError("spawn_error", `Process supervision refused execution: ${line.split(" ").at(-1)}`);
      } else { markUncertain("Process supervisor reported uncertain cleanup or invalid status"); requestCleanup(); armSettlement(); }
    }
  });
  child.once("error", error => { spawnFailed = true; failure = new ExecutionError("spawn_error", error.message); });
  child.once("exit", armSettlement);
  child.once("close", (_code, signal) => settle(signal));
  timer = setTimeout(() => stop(new ExecutionError("timeout", "Command exceeded its deadline")), Math.max(0, deadline - Date.now()));
  if (context.abortSignal?.aborted) abort();
  else context.abortSignal?.addEventListener("abort", abort, { once: true });
  return promise;
}

function writeAll(descriptor: number, data: Uint8Array): void {
  let offset = 0;
  while (offset < data.byteLength) offset += writeSync(descriptor, data, offset, data.byteLength - offset);
}
