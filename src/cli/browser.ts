import { closeSync, fstatSync, readFileSync } from "node:fs";
import { open, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { privateDirectory, privateFile } from "../mac/config.js";
import { buildBrowserExportHelper, invokeBrowserExportHelper, loadBrowserExportConfig, parseBrowserExportConfig, syncBrowserSnapshots, watchBrowserSnapshots } from "../mac/browser-export.js";
import type { BrowserExportRuntime } from "../mac/browser-export.js";

const USAGE = `Usage:
  npm run browser -- helper-build --output PRIVATE_EXECUTABLE [--synthetic-fixture]
  npm run browser -- config-create --config PRIVATE.json --origin HTTPS_ORIGIN --cookie-db EXACT_DB --helper PRIVATE_EXECUTABLE --state PRIVATE_DIR (--requested-sites | --approved-sites PRIVATE_POLICIES.json) [--isolated-loopback]
  npm run browser -- authorize --config PRIVATE.json
  npm run browser -- sync --config PRIVATE.json
  npm run browser -- watch --config PRIVATE.json

config-create reads ONLY UMPI_BROWSER_SYNC_TOKEN from the environment. Its role
must be browser-sync, distinct from control/executor/model credentials. The policy
file is a JSON array of locally owner-approved BrowserSitePolicy objects. Requested
mode exports only sites from server-approved tasks, never proposals or the entire
cookie jar. Hosted origins require HTTPS; HTTP is allowed only for an explicitly
isolated loopback. These two configuration modes are mutually exclusive.
Config/helper/state directories must be canonical owner-only 0700 outside the
repository; config/state files are 0600. Source is the exact owner-selected Aside
Cookies database: there is no profile discovery or fallback.

helper-build compiles Swift using the macOS SDK and ad-hoc signs a NEW executable.
The owner must explicitly authorize this narrow helper for the exact Keychain
item Aside Safe Storage / Aside. Only authorize may prompt. No ACL changes are
made automatically. Rebuilding/re-signing changes its code identity and can require
fresh owner authorization; retain its stable signed executable. Never grant broad
trust to security, a shell, Node, or a general interpreter. Watch never prompts.

Supported export: read-only Chromium schema24, encrypted v10 AES-CBC cookies with
validated domain hashes, exact host_key/name lists or requested registrable-domain
scope (including supported cookie names), ordinary unpartitioned cookies and
SameSite None/Lax/Strict; unspecified SameSite is preserved by omitting that
attribute. Expired cookies are omitted; empty scope produces ordinary empty
authentication. Partitioned cookies, unknown schemas/encryption/storage, locked or
unauthorized Keychain fail truthfully.
No localStorage, IndexedDB, profile files, password manager, login detection or
recovery is exported. Stdout is encrypted inside the helper; CLI reports metadata
only. Watch polls new approved requests approximately once per minute and persists
independent six-hour site attempts, including failures/restarts and policy changes;
sync is a separate explicit one-shot attempt. No login recovery or detection.

--synthetic-fixture builds a separate compile-time helper incapable of reading
Aside's Keychain item. Its fixture-create command accepts a NEW private SQLite path
on stdin, creates only synthetic cookies and a synthetic Keychain item; export uses
that item. fixture-delete deletes only that synthetic item. Use only for isolated
smoke verification; it is not a production authorization fallback.
`;
export interface BrowserCliRuntime extends BrowserExportRuntime {
  env?: NodeJS.ProcessEnv;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
}
export async function runBrowserCli(args: readonly string[], runtime: BrowserCliRuntime = {}): Promise<void> {
  const stdout = runtime.stdout ?? (text => { process.stdout.write(text); });
  const command = args[0];
  if (!command || ["help", "--help", "-h"].includes(command)) { stdout(USAGE); return; }
  if (!["helper-build", "config-create", "authorize", "sync", "watch"].includes(command)) throw new Error("Use browser --help for supported commands");
  let values;
  try { ({ values } = parseArgs({ args: args.slice(1), options: {
    config: { type: "string" }, output: { type: "string" }, origin: { type: "string" }, "cookie-db": { type: "string" }, helper: { type: "string" }, state: { type: "string" }, "approved-sites": { type: "string" }, "requested-sites": { type: "boolean" }, "isolated-loopback": { type: "boolean" }, "synthetic-fixture": { type: "boolean" }, help: { type: "boolean", short: "h" },
  } })); } catch { throw new Error("Invalid browser arguments; never pass tokens as arguments"); }
  if (values.help) { stdout(USAGE); return; }
  const allowed = command === "helper-build" ? ["output", "synthetic-fixture"] : command === "config-create" ? ["config", "origin", "cookie-db", "helper", "state", "approved-sites", "requested-sites", "isolated-loopback"] : ["config"];
  if (Object.keys(values).some(key => !allowed.includes(key))) throw new Error("Arguments do not match the selected browser command");
  if (command === "helper-build") {
    if (!values.output) throw new Error("helper-build requires --output");
    await buildBrowserExportHelper(values.output, values["synthetic-fixture"] ?? false);
    stdout(`${JSON.stringify({ helperBuilt: true, syntheticFixture: values["synthetic-fixture"] ?? false, ownerAuthorizationRequired: !values["synthetic-fixture"] })}\n`);
    return;
  }
  if (!values.config) throw new Error("Specify the private browser --config file");
  if (command === "config-create") {
    if (!values.origin || !values["cookie-db"] || !values.helper || !values.state) throw new Error("config-create requires explicit origin, cookie DB, helper and state");
    const requestedSites = values["requested-sites"] ?? false;
    if (requestedSites === Object.hasOwn(values, "approved-sites")) throw new Error("Select exactly one of --requested-sites or --approved-sites");
    let approvedSites: unknown = [];
    if (values["approved-sites"]) {
      const policyPath = resolve(values["approved-sites"]);
      if (privateDirectory(dirname(policyPath), false) !== dirname(policyPath)) throw new Error("Approved policy directory must be canonical");
      const fd = privateFile(policyPath);
      try { if (fstatSync(fd).size > 65536) throw new Error("Approved policy file too large"); approvedSites = JSON.parse(readFileSync(fd, "utf8")); } finally { closeSync(fd); }
    }
    const config = parseBrowserExportConfig({ serverUrl: values.origin, browserSyncToken: (runtime.env ?? process.env).UMPI_BROWSER_SYNC_TOKEN, isolatedLoopback: values["isolated-loopback"] ?? false, requestedSites, approvedSites, sourceCookieDb: resolve(values["cookie-db"]), helperPath: resolve(values.helper), stateDirectory: resolve(values.state) });
    const path = resolve(values.config);
    if (privateDirectory(dirname(path)) !== dirname(path)) throw new Error("Config directory must be canonical");
    const file = await open(path, "wx", 0o600);
    let saved = false;
    try { await file.writeFile(JSON.stringify(config)); await file.sync(); saved = true; }
    finally { await file.close(); if (!saved) await unlink(path); }
    const directory = await open(dirname(path), "r"); try { await directory.sync(); } finally { await directory.close(); }
    stdout(`${JSON.stringify({ configured: true, requestedSites: config.requestedSites, approvedSiteCount: config.approvedSites.length, role: "browser-sync" })}\n`);
    return;
  }
  const config = loadBrowserExportConfig(values.config);
  if (command === "authorize") {
    const result = await (runtime.helper ?? invokeBrowserExportHelper)(config, "authorize");
    if (!result || typeof result !== "object" || Object.keys(result).length !== 1 || !("authorized" in result) || result.authorized !== true) throw new Error("Browser helper authorization was not confirmed");
    stdout('{"authorized":true}\n'); return;
  }
  const syncRuntime = { ...runtime, output: (metadata: Parameters<NonNullable<BrowserExportRuntime["output"]>>[0]) => { stdout(`${JSON.stringify(metadata)}\n`); } };
  if (command === "sync") { await syncBrowserSnapshots(config, syncRuntime); return; }
  await watchBrowserSnapshots(config, syncRuntime, () => { (runtime.stderr ?? (text => { process.stderr.write(text); }))("Browser snapshot sync failed; no authorization prompt or login recovery. Failed site attempts retain their independent six-hour schedules.\n"); });
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort()); process.once("SIGTERM", () => controller.abort());
  runBrowserCli(process.argv.slice(2), { signal: controller.signal }).catch(error => {
    if (!controller.signal.aborted) { process.stderr.write(`${error instanceof Error ? error.message : "Browser command failed"}\n`); process.exitCode = 1; }
  });
}
