import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import {
  coreContextMetadata, readCoreContext, syncVaultContext, VaultContextError,
  type VaultSyncOptions,
} from "./vault-context.ts";

const USAGE = `Usage:
  npm run memory -- status URL
  npm run memory -- sync URL --vault PATH [--source 'id:kind:relative/path.md#Exact heading'] [--expected-revision N]
  npm run memory -- watch URL --vault PATH [--source 'id:kind:relative/path.md#Exact heading'] [--expected-revision N] [--interval-ms N]

URL must be an HTTPS origin, or loopback HTTP for local development.
UMPI_CONTROL_TOKEN is read only from the environment, never from arguments.
Kinds: background, preferences, workstreams. Repeat --source to select sections.
Initial bootstrap requires explicit --source and --expected-revision 0.
Later sync uses stored source mappings, never vault-wide discovery.
Watch defaults to 60000 ms, minimum 5000 ms; Ctrl-C stops it. No service is installed.
Only counts, revisions, and pending status are printed, never note contents.
`;

export interface MemoryCliOptions {
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  signal?: AbortSignal;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
}

export async function runMemoryCli(args: readonly string[], runtime: MemoryCliOptions = {}): Promise<void> {
  const stdout = runtime.stdout ?? (text => { process.stdout.write(text); });
  const stderr = runtime.stderr ?? (text => { process.stderr.write(text); });
  const [command, origin, ...flags] = args;
  if (command === undefined || command === "help" || command === "--help" || command === "-h") {
    stdout(USAGE);
    return;
  }
  if (!["status", "sync", "watch"].includes(command) || !origin) throw new VaultContextError("Use memory --help for supported commands and arguments");
  let values: { vault?: string; source?: string[]; "expected-revision"?: string; "interval-ms"?: string };
  try {
    ({ values } = parseArgs({
      args: flags,
      options: {
        vault: { type: "string" },
        source: { type: "string", multiple: true },
        "expected-revision": { type: "string" },
        "interval-ms": { type: "string" },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch { throw new VaultContextError("Invalid memory arguments; use memory --help. Tokens must never be passed as arguments"); }
  const connection = {
    coordinatorOrigin: origin,
    controlToken: (runtime.env ?? process.env).UMPI_CONTROL_TOKEN,
    ...(runtime.fetch ? { fetch: runtime.fetch } : {}),
    ...(runtime.signal ? { signal: runtime.signal } : {}),
  };
  if (command === "status") {
    if (flags.length) throw new VaultContextError("Memory status accepts only the coordinator origin");
    stdout(`${JSON.stringify(coreContextMetadata(await readCoreContext(connection)))}\n`);
    return;
  }
  if (!values.vault) throw new VaultContextError("Memory sync and watch require --vault PATH");
  if (command !== "watch" && values["interval-ms"] !== undefined) throw new VaultContextError("Only memory watch accepts --interval-ms");
  const expected = values["expected-revision"];
  if (expected !== undefined && (!/^\d+$/.test(expected) || !Number.isSafeInteger(Number(expected)))) {
    throw new VaultContextError("Expected revision must be a nonnegative safe integer");
  }
  const intervalValue = values["interval-ms"] ?? "60000";
  const interval = Number(intervalValue);
  if (!/^\d+$/.test(intervalValue) || !Number.isSafeInteger(interval) || interval < 5_000 || interval > 2_147_483_647) {
    throw new VaultContextError("Watch interval must be an integer between 5000 and 2147483647 milliseconds");
  }
  const cancellation = new AbortController();
  const interrupt = () => cancellation.abort();
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  const signal = runtime.signal ? AbortSignal.any([runtime.signal, cancellation.signal]) : cancellation.signal;
  let options: VaultSyncOptions = {
    ...connection,
    signal,
    vault: values.vault,
    ...(values.source ? { sources: values.source } : {}),
    ...(expected !== undefined ? { expectedRevision: Number(expected) } : {}),
  };
  try {
    do {
      try {
        const result = await syncVaultContext(options);
        stdout(`${JSON.stringify(result)}\n`);
        // Explicit bootstrap selections apply once, not as automatic re-creation after deletion.
        options = { ...connection, vault: values.vault, signal };
      } catch (error) {
        if (signal.aborted) return;
        if (command !== "watch" || !(error instanceof VaultContextError) || error.kind !== "network") throw error;
        stderr(`${error.message}\n`);
      }
      if (command !== "watch" || signal.aborted) return;
      try { await delay(interval, undefined, { signal }); }
      catch { if (signal.aborted) return; throw new VaultContextError("Memory watch timer failed"); }
    } while (!signal.aborted);
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runMemoryCli(process.argv.slice(2)).catch(error => {
    const message = error instanceof VaultContextError
      ? error.message
      : "Core context operation failed; private filesystem, note, and network details were not displayed";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
