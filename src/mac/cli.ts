import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { closeSync, fstatSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { DEFAULT_CONFIG_PATH, grantBrowserSite, initializeConfig, loadConfig, privateFile, revokeBrowserSite, setBrowserEnabled, setCodingEnabled, setContextEnabled, stateDirectory } from "./config.js";
import { AsideContextLane } from "./aside-context.js";
import { ExecutionJournal, readJournalStatus } from "./journal.js";
import { MacExecutor } from "./daemon.js";
import { CodingJournal, MacCodingExecutor, readCodingJournalStatus } from "./coding.js";
import { BrowserJournal, MacBrowserExecutor, readBrowserJournalStatus } from "./browser.js";
import { browserSitePolicyJson } from "../shared/browser.js";
import { coordinatorUrl } from "../shared/coordinator-url.ts";
import { WakeChannel } from "./wake.js";
import { installService, restartService, servicePaths, serviceState, uninstallService } from "./service.js";
import { execFileSync } from "node:child_process";

const HELP = `umpi Mac executor (Node 24)

  npm run mac -- init --server-url URL --workspace PATH [--workspace PATH]
  npm run mac -- run
  npm run mac -- status
  npm run mac -- service-install
  npm run mac -- service-status
  npm run mac -- service-restart
  npm run mac -- service-uninstall
  npm run mac -- resume --confirm-stopped
  npm run mac -- coding-enable
  npm run mac -- coding-disable
  npm run mac -- browser-grant --policy PATH --policy-digest SHA256
  npm run mac -- browser-revoke --site ID
  npm run mac -- browser-enable [--all-sites]
  npm run mac -- browser-disable
  npm run mac -- context-enable
  npm run mac -- context-disable

Common options:
  --config PATH             Private config (default ~/.config/umpi/mac/config.json)
  --state-dir PATH          Private journal directory (default config sibling state/)
  --help                    Show this help

Init options:
  --server-url URL          HTTPS coordinator origin; HTTP only for exact loopback
  --workspace PATH          Allowed starting directory root; repeat as needed
  --poll-interval-ms N      Poll interval, 100..60000 (default 1000)
  --token-stdin             Read executor token from redirected stdin

Browser grant options:
  --policy PATH            Owner-only JSON file containing an exact BrowserSitePolicy
  --policy-digest SHA256    Explicit coordinator canonical policy digest to approve
  --site ID                Existing local site ID to revoke
  --all-sites              Enable any approved public website without per-site grants

Init never overwrites a config. It generates a stable executorId and reads the
executor token with a hidden terminal prompt, or from stdin when redirected.
Never pass a credential as an argument or URL. Store config and state outside the
repository in owner-only directories. Config is JSON, mode 0600, with serverUrl,
executorToken, executorId, workspaces, optional pollIntervalMs, coding.enabled,
and browser.enabled/browser.allSites/browser.sites (both lanes default disabled). Stop the daemon
before changing config. Preserve state and executorId together. All grant/opt-in
changes require exclusive stopped-daemon state ownership and preserve other values.

service-install runs the executor as a login item (launchd agent dev.umpi.executor). It starts at
login, restarts after a crash, and runs a bundled copy under ~/Library/Application Support/Umpi
with this Node and this shell's PATH. Run it again after updating the code or Node; it replaces the
running copy. Logs go to executor.log beside the config. Stop any executor started with run first.
The executor keeps one outbound wake socket to the coordinator. While idle it checks in every 5
minutes and polls at once when woken; while work runs it polls at the configured interval.

Commands run as this Mac user through /bin/sh. Workspace validation restricts the
starting cwd, NOT filesystem access. This is not a sandbox. UMPI_* and TELEGRAM_*
environment variables are removed from command children. SIGINT/SIGTERM stop the
active process group and preserve its result for delivery on the next connection.

Coding opt-in permits separately owner-approved full coding tasks, not merely an
exact shell command. Grants bind an exact configured canonical workspace and a hard
deadline. The original Git-selected source is read-only during capture; coding tools
run in an owner-only private copy and return a review patch, never auto-applied.
Native coding is unsandboxed as this Mac user; opt-in alone grants no task. Lifetime
supervision stops the owned foreground process group, not deliberately detached or
new-group services. External file/network effects are not contained or rolled back.
Coding and shell work share one execution slot. Disabling prevents new coding work;
it does not discard accepted runs, uncertain outcomes, or pending result delivery.

Context sends Aside's own 10-minute activity summaries (never raw clicks, keystrokes,
screen text or page snapshots) to the coordinator every 5 minutes, and answers the
owner's Aside memory searches from chat with at most 8 short results. It reads Aside
data read-only and keeps only a cursor file in the state directory.

Browser uses its own independent lane and only task-owned Aside tabs. For restricted
execution, register the same exact site policy with the coordinator, inspect its
ID/origins/resource hosts and cookie scope, then browser-grant its private JSON file
and exact policy digest. browser-enable requires at least one approved site;
browser-enable --all-sites explicitly permits any approved public website without
per-site Mac grants. Granting alone never enables execution. Revoking the last site
disables restricted opt-in, but does not disable all-site mode. Disabling/revoking
preserves prior accepted runs, uncertain outcomes and delivery. Every task still
requires owner approval; cloud snapshot approval is separate. Native browser action
scope is not a network sandbox. Status contains only metadata and site IDs/digests,
never observations, screenshots, cookies or credentials.

After an interrupted start, run reports uncertainty without replaying prior work.
Shell/coding pause together; browser recovery pauses only its independent lane.
Stop the daemon, inspect prior processes, task-owned tabs and effects, then use
resume --confirm-stopped only after confirming all prior shell, coding and browser
work has stopped. Resume preserves uncertain results and durably reports explicit
stopped reconciliation for coding/browser. Recovery never rolls back prior effects.
`;

class UsageError extends Error {}

async function readToken(forceStdin: boolean): Promise<string> {
  if (!process.stdin.isTTY) {
    let token = "";
    for await (const chunk of process.stdin) {
      token += String(chunk);
      if (token.length > 4096) throw new UsageError("Executor token input is too long");
    }
    return token.trim();
  }
  if (forceStdin) throw new UsageError("--token-stdin requires redirected input");
  process.stderr.write("Executor token (hidden): ");
  const wasRaw = process.stdin.isRaw;
  process.stdin.setRawMode(true);
  process.stdin.setEncoding("utf8");
  process.stdin.resume();
  return new Promise<string>((resolveToken, reject) => {
    let value = "";
    const finish = (error?: Error) => {
      process.stdin.removeListener("data", onData);
      process.stdin.removeListener("end", onEnd);
      process.stdin.setRawMode(wasRaw);
      process.stdin.pause();
      process.stderr.write("\n");
      if (error) reject(error); else resolveToken(value);
    };
    const onEnd = () => finish(new UsageError("Token input ended before confirmation"));
    const onData = (chunk: string) => {
      for (const character of chunk) {
        if (character === "\u0003" || character === "\u0004") { finish(new UsageError("Token input cancelled")); return; }
        if (character === "\r" || character === "\n") { finish(); return; }
        if (character === "\u007f" || character === "\b") value = value.slice(0, -1);
        else value += character;
        if (value.length > 4096) { finish(new UsageError("Executor token input is too long")); return; }
      }
    };
    process.stdin.on("data", onData);
    process.stdin.once("end", onEnd);
  });
}

async function main(): Promise<void> {
  process.umask(0o077);
  let parsed;
  try {
    parsed = parseArgs({
      allowPositionals: true,
      strict: true,
      options: {
        config: { type: "string" },
        "state-dir": { type: "string" },
        "server-url": { type: "string" },
        workspace: { type: "string", multiple: true },
        "poll-interval-ms": { type: "string" },
        "token-stdin": { type: "boolean" },
        "confirm-stopped": { type: "boolean" },
        policy: { type: "string" },
        "policy-digest": { type: "string" },
        site: { type: "string" },
        "all-sites": { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch { throw new UsageError("Invalid arguments. Use --help; credentials must never be passed as arguments."); }
  const { values, positionals } = parsed;
  if (values.help || positionals.length === 0) { process.stdout.write(HELP); return; }
  if (positionals.length !== 1) throw new UsageError("Specify exactly one command. Use --help.");
  const command = positionals[0];
  if (!["init", "run", "status", "resume", "service-install", "service-status", "service-restart", "service-uninstall", "coding-enable", "coding-disable", "browser-enable", "browser-disable", "browser-grant", "browser-revoke", "context-enable", "context-disable"].includes(command!)) throw new UsageError("Unknown command. Use --help.");
  if (values["all-sites"] !== undefined && command !== "browser-enable") throw new UsageError("--all-sites is only accepted by browser-enable");
  if (command === "browser-grant") {
    if (!values.policy || !values["policy-digest"] || values.site) throw new UsageError("browser-grant requires --policy PATH and --policy-digest SHA256");
  } else if (command === "browser-revoke") {
    if (!values.site || values.policy || values["policy-digest"]) throw new UsageError("browser-revoke requires only --site ID");
  } else if (values.policy || values["policy-digest"] || values.site) throw new UsageError("Browser grant options are only accepted by browser-grant/browser-revoke");
  const configPath = resolve(values.config ?? DEFAULT_CONFIG_PATH);
  if (command === "init") {
    if (!values["server-url"] || !values.workspace?.length) throw new UsageError("init requires --server-url and at least one --workspace");
    if (values["confirm-stopped"] || values["state-dir"]) throw new UsageError("init does not accept recovery or state-directory options");
    initializeConfig(configPath, {
      serverUrl: values["server-url"],
      executorToken: await readToken(values["token-stdin"] ?? false),
      workspaces: values.workspace.map(path => resolve(path)),
      pollIntervalMs: values["poll-interval-ms"] === undefined ? undefined : Number(values["poll-interval-ms"]),
    });
    process.stdout.write("Created private executor configuration with a stable executor ID.\n");
    return;
  }
  if (values["server-url"] || values.workspace || values["poll-interval-ms"] || values["token-stdin"]) throw new UsageError("Use init or edit the private config to change executor settings");
  if (command !== "resume" && values["confirm-stopped"]) throw new UsageError("--confirm-stopped is only accepted by resume");
  const config = loadConfig(configPath);
  const directory = stateDirectory(configPath, values["state-dir"]);
  if (command === "service-status") {
    process.stdout.write(`${JSON.stringify(serviceState(servicePaths(configPath)), null, 2)}\n`);
    return;
  }
  if (command === "service-uninstall") {
    uninstallService(configPath);
    process.stdout.write("Login item removed. The executor is stopped; its config, journals and log are kept.\n");
    return;
  }
  if (command === "service-restart") {
    restartService();
    process.stdout.write("Executor restarted by launchd.\n");
    return;
  }
  if (command === "service-install") {
    let commit: string | null = null;
    try { commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null; } catch { /* Not a checkout. */ }
    const state = await installService(configPath, values["state-dir"], commit);
    process.stdout.write(`${JSON.stringify(state, null, 2)}\nLogin item installed. It starts at login and restarts after a crash.\n`);
    return;
  }
  if (command === "status") {
    process.stdout.write(`${JSON.stringify({ executorId: config.executorId, serverUrl: config.serverUrl, workspaces: config.workspaces, journal: readJournalStatus(directory), coding: { enabled: config.coding.enabled, journal: readCodingJournalStatus(directory) }, context: { enabled: config.context?.enabled ?? false }, browser: { enabled: config.browser.enabled, allSites: config.browser.allSites, sites: config.browser.sites.map(site => ({ siteId: site.siteId, policyDigest: createHash("sha256").update(browserSitePolicyJson(site)).digest("hex") })), journal: readBrowserJournalStatus(directory) } }, null, 2)}\n`);
    return;
  }
  if (command === "resume" && !values["confirm-stopped"]) throw new UsageError("Verify all prior shell, coding and browser work has stopped, then explicitly pass --confirm-stopped");
  const journal = new ExecutionJournal(directory, config);
  let codingJournal: CodingJournal | undefined;
  let browserJournal: BrowserJournal | undefined;
  try {
    codingJournal = new CodingJournal(directory, config);
    browserJournal = new BrowserJournal(directory, config);
    if (command === "browser-enable" || command === "browser-disable") {
      const enabled = command === "browser-enable";
      setBrowserEnabled(configPath, enabled, enabled ? values["all-sites"] ?? false : undefined);
      process.stdout.write(enabled
        ? values["all-sites"]
          ? "Browser opt-in enabled for any approved public website. Each task still requires separate owner approval.\n"
          : "Browser opt-in enabled for locally approved site digests. Each task still requires separate owner approval.\n"
        : "Browser opt-in disabled. Prior browser state and pending results were preserved.\n");
      return;
    }
    if (command === "browser-grant") {
      const fd = privateFile(resolve(values.policy!));
      let policy: unknown;
      try {
        if (fstatSync(fd).size > 65_536) throw new UsageError("Browser policy file is too large");
        policy = JSON.parse(readFileSync(fd, "utf8"));
      } finally { closeSync(fd); }
      grantBrowserSite(configPath, policy, values["policy-digest"]!);
      process.stdout.write("Exact browser site policy digest approved locally. Browser opt-in was not changed; coordinator registration and task approval remain separate.\n");
      return;
    }
    if (command === "browser-revoke") {
      revokeBrowserSite(configPath, values.site!);
      process.stdout.write("Local browser site approval revoked. Revoking the last site disables restricted opt-in only; prior state and pending reports were preserved.\n");
      return;
    }
    if (command === "context-enable" || command === "context-disable") {
      const enabled = command === "context-enable";
      setContextEnabled(configPath, enabled);
      process.stdout.write(enabled
        ? "Aside context enabled: activity summaries are sent every 5 minutes, and memory searches requested from chat are answered.\n"
        : "Aside context disabled. Nothing more is sent; summaries already sent stay in the coordinator until they expire.\n");
      return;
    }
    if (command === "coding-enable" || command === "coding-disable") {
      const enabled = command === "coding-enable";
      setCodingEnabled(configPath, enabled);
      process.stdout.write(enabled
        ? "Coding opt-in enabled. Each task still requires a separate owner grant for an exact workspace and deadline.\n"
        : "Coding opt-in disabled. Prior coding state and pending results were preserved.\n");
      return;
    }
    if (command === "resume") {
      browserJournal.confirmStopped();
      codingJournal.resumeAfterOwnerConfirmation();
      journal.resumeAfterOwnerConfirmation();
      process.stdout.write("Execution pauses cleared after explicit owner stopped confirmation. Prior uncertain results preserved; coding/browser stopped reconciliation will be delivered on reconnect.\n");
      return;
    }
    const stop = new AbortController();
    const onSignal = () => stop.abort();
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
    try {
      const coding = new MacCodingExecutor(config, codingJournal);
      const browser = new MacBrowserExecutor(config, browserJournal);
      const context = config.context?.enabled ? new AsideContextLane(config.executorId, directory) : undefined;
      const log = (event: string) => process.stderr.write(`umpi-mac: ${new Date().toISOString()} ${event}\n`);
      const executor = new MacExecutor(config, journal, log, coding, browser, context);
      const wake = new WakeChannel({ origin: coordinatorUrl(config.serverUrl), token: config.executorToken, executorId: config.executorId,
        onWake: () => executor.requestPoll(), onState: connected => log(connected ? "wake_connected" : "wake_disconnected") });
      executor.useWake(wake);
      wake.start();
      try { await executor.run(stop.signal); } finally { wake.stop(); }
    } finally {
      process.removeListener("SIGINT", onSignal);
      process.removeListener("SIGTERM", onSignal);
    }
  } finally {
    try { browserJournal?.close(); } finally { try { codingJournal?.close(); } finally { journal.close(); } }
  }
}

void main().catch(error => {
  // JSON parsing, native errors, and provider responses can embed input. Never
  // print those raw messages, command text, config contents, or credentials.
  process.stderr.write(error instanceof UsageError
    ? `${error.message}\n`
    : "Mac executor failed. Check config mode 0600, owner-only storage outside the repository, workspace paths, and exclusive state ownership. Existing journal was preserved.\n");
  process.exitCode = 1;
});
