import { execFileSync } from "node:child_process";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The executor as a per-user launchd agent. It starts at login, restarts after a crash, and runs one
 * bundled JavaScript file with plain Node: no TypeScript loader, no npm process, and no dependence on
 * the repository checkout while it runs.
 */
export const SERVICE_LABEL = "dev.umpi.executor";

export interface ServicePaths { plist: string; directory: string; bundle: string; manifest: string; log: string }
export function servicePaths(configPath: string, home = homedir()): ServicePaths {
  const directory = join(home, "Library", "Application Support", "Umpi", "executor");
  return {
    plist: join(home, "Library", "LaunchAgents", `${SERVICE_LABEL}.plist`),
    directory, bundle: join(directory, "umpi-executor.mjs"), manifest: join(directory, "build.json"),
    log: join(dirname(resolve(configPath)), "executor.log"),
  };
}

const xml = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const string = (value: string) => `<string>${xml(value)}</string>`;

export interface PlistInput { node: string; bundle: string; args: string[]; log: string; workingDirectory: string; path: string }
/**
 * KeepAlive restarts the executor after a crash or a failed start; an orderly stop (exit 0) stays stopped.
 * PATH is the installing shell's PATH, so approved commands and coding tasks find the same tools.
 */
export function servicePlist(input: PlistInput): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>${string(SERVICE_LABEL)}
  <key>ProgramArguments</key>
  <array>${[input.node, input.bundle, "run", ...input.args].map(string).join("")}</array>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key>${string(input.path)}</dict>
  <key>WorkingDirectory</key>${string(input.workingDirectory)}
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>ProcessType</key>${string("Standard")}
  <key>StandardOutPath</key>${string(input.log)}
  <key>StandardErrorPath</key>${string(input.log)}
</dict>
</plist>
`;
}

/** Bundles the executor CLI into one ES module. The repository root is fixed for the outside-repository checks. */
export async function buildExecutorBundle(outfile: string): Promise<void> {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const { build } = await import("esbuild");
  await build({
    entryPoints: [join(root, "src", "mac", "cli.ts")], outfile, bundle: true, platform: "node", format: "esm", target: "node24",
    banner: { js: "import { createRequire as __umpiCreateRequire } from 'node:module'; const require = __umpiCreateRequire(import.meta.url);" },
    define: { UMPI_REPOSITORY_ROOT: JSON.stringify(root.replace(/\/$/, "")) }, external: ["esbuild"], logLevel: "error", legalComments: "none",
  });
}

function launchctl(args: string[], allowFailure = false): string {
  try { return execFileSync("launchctl", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); }
  catch (error) { if (allowFailure) return ""; throw new Error(`launchctl ${args[0]} failed`, { cause: error }); }
}
const domain = () => `gui/${userInfo().uid}`;

export interface ServiceState { installed: boolean; loaded: boolean; running: boolean; pid: number | null; lastExitCode: string | null; build: unknown }
export function serviceState(paths: ServicePaths): ServiceState {
  const printed = launchctl(["print", `${domain()}/${SERVICE_LABEL}`], true);
  const field = (name: string) => new RegExp(`^\\s*${name} = (.+)$`, "m").exec(printed)?.[1]?.trim() ?? null;
  let build: unknown = null;
  try { build = JSON.parse(readFileSync(paths.manifest, "utf8")); } catch { /* Not built. */ }
  const pid = field("pid");
  return { installed: existsSync(paths.plist), loaded: printed !== "", running: field("state") === "running", pid: pid ? Number(pid) : null, lastExitCode: field("last exit code"), build };
}

/** Other executors would hold the daemon lock, and launchd would keep retrying. */
export function otherExecutors(): number[] {
  let listed = "";
  try { listed = execFileSync("pgrep", ["-f", "(src/mac/cli\\.ts|umpi-executor\\.mjs) run"], { encoding: "utf8" }); } catch { return []; }
  const managed = serviceStateQuiet();
  return listed.split("\n").map(Number).filter(pid => Number.isInteger(pid) && pid > 0 && pid !== process.pid && pid !== managed);
}
function serviceStateQuiet(): number | null {
  const printed = launchctl(["print", `${domain()}/${SERVICE_LABEL}`], true);
  const pid = /^\s*pid = (\d+)$/m.exec(printed)?.[1];
  return pid ? Number(pid) : null;
}

export async function installService(configPath: string, stateDir: string | undefined, commit: string | null): Promise<ServiceState> {
  const paths = servicePaths(configPath);
  const others = otherExecutors();
  if (others.length) throw new Error(`Stop the executor already running (PID ${others.join(", ")}) before installing the login item`);
  mkdirSync(paths.directory, { recursive: true, mode: 0o700 }); chmodSync(paths.directory, 0o700);
  const temporary = `${paths.bundle}.${process.pid}.tmp`;
  await buildExecutorBundle(temporary);
  chmodSync(temporary, 0o600); renameSync(temporary, paths.bundle);
  writeFileSync(paths.manifest, `${JSON.stringify({ builtAt: new Date().toISOString(), commit, node: process.version })}\n`, { mode: 0o600 });
  // launchd would create the log with the default umask; it must stay owner-only.
  closeSync(openSync(paths.log, "a", 0o600)); chmodSync(paths.log, 0o600);
  const args = ["--config", resolve(configPath), ...(stateDir ? ["--state-dir", resolve(stateDir)] : [])];
  mkdirSync(dirname(paths.plist), { recursive: true });
  writeFileSync(paths.plist, servicePlist({ node: process.execPath, bundle: paths.bundle, args, log: paths.log, workingDirectory: homedir(), path: process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin" }), { mode: 0o644 });
  launchctl(["bootout", `${domain()}/${SERVICE_LABEL}`], true);
  launchctl(["bootstrap", domain(), paths.plist]);
  launchctl(["enable", `${domain()}/${SERVICE_LABEL}`], true);
  return serviceState(paths);
}

export function uninstallService(configPath: string): void {
  const paths = servicePaths(configPath);
  launchctl(["bootout", `${domain()}/${SERVICE_LABEL}`], true);
  rmSync(paths.plist, { force: true });
  rmSync(paths.directory, { recursive: true, force: true });
}

export function restartService(): void { launchctl(["kickstart", "-k", `${domain()}/${SERVICE_LABEL}`]); }
