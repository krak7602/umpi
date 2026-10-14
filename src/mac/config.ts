import { constants, closeSync, fsyncSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync, type Stats } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { identifier, record } from "../shared/protocol.js";
import { coordinatorUrl } from "../shared/coordinator-url.ts";
import { MAX_BROWSER_SITES, browserSitePolicyJson, parseBrowserSite } from "../shared/browser.js";
import type { BrowserSitePolicy } from "../shared/browser.js";

export interface MacConfig {
  serverUrl: string;
  executorToken: string;
  executorId: string;
  workspaces: string[];
  pollIntervalMs: number;
  coding: { enabled: boolean };
  browser: { enabled: boolean; allSites: boolean; sites: BrowserSitePolicy[] };
}

export const DEFAULT_CONFIG_PATH = join(homedir(), ".config", "umpi", "mac", "config.json");
const repositoryRoot = realpathSync(fileURLToPath(new URL("../../", import.meta.url)));

function within(path: string, root: string): boolean {
  const suffix = relative(root, path);
  return suffix === "" || (suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix));
}

export function assertOutsideRepository(path: string): void {
  let ancestor = resolve(path);
  const missing: string[] = [];
  for (;;) {
    try {
      ancestor = realpathSync(ancestor);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(ancestor);
      if (parent === ancestor) throw new Error("Cannot resolve private storage path");
      missing.unshift(relative(parent, ancestor));
      ancestor = parent;
    }
  }
  if (within(join(ancestor, ...missing), repositoryRoot)) {
    throw new Error("Executor configuration and state must be outside this repository");
  }
}

function assertPrivate(stat: Stats, directory: boolean): void {
  if ((directory ? !stat.isDirectory() : !stat.isFile()) || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0 || (!directory && stat.nlink !== 1)) {
    throw new Error(directory ? "Private directory must be owner-owned with mode 0700" : "Private file must be owner-owned with mode 0600 and one link");
  }
}

export function privateDirectory(path: string, create = true): string {
  const absolute = resolve(path);
  assertOutsideRepository(absolute);
  if (create) mkdirSync(absolute, { recursive: true, mode: 0o700 });
  assertPrivate(lstatSync(absolute), true);
  return realpathSync(absolute);
}

export function privateFile(path: string, create = false): number {
  assertOutsideRepository(path);
  const flags = constants.O_NOFOLLOW | (create ? constants.O_RDWR | constants.O_CREAT : constants.O_RDONLY);
  const fd = openSync(path, flags, 0o600);
  try {
    assertPrivate(fstatSync(fd), false);
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

export function parseConfig(value: unknown): MacConfig {
  const input = record(value);
  if (typeof input.serverUrl !== "string") throw new Error("Configure a coordinator URL");
  if (typeof input.executorToken !== "string" || input.executorToken.length < 32 || input.executorToken.length > 4096 || /\s/.test(input.executorToken)) {
    throw new Error("Executor token must contain at least 32 non-whitespace characters");
  }
  if (!Array.isArray(input.workspaces) || input.workspaces.length === 0 || input.workspaces.length > 32) {
    throw new Error("Configure between one and 32 workspace roots");
  }
  const workspaces = input.workspaces.map((path: unknown) => {
    if (typeof path !== "string" || !isAbsolute(path) || path.length > 4096) throw new Error("Workspace roots must be absolute paths");
    const canonical = realpathSync(path);
    if (!statSync(canonical).isDirectory()) throw new Error("Workspace root must be a directory");
    return canonical;
  });
  const pollIntervalMs = input.pollIntervalMs ?? 1000;
  if (typeof pollIntervalMs !== "number" || !Number.isInteger(pollIntervalMs) || pollIntervalMs < 100 || pollIntervalMs > 60_000) {
    throw new Error("Poll interval must be between 100 and 60000 milliseconds");
  }
  const coding = input.coding === undefined ? { enabled: false } : record(input.coding);
  if (typeof coding.enabled !== "boolean") throw new Error("coding.enabled must be explicitly true or false");
  const browser = input.browser === undefined ? { enabled: false, allSites: false, sites: [] } : record(input.browser);
  const allSites = browser.allSites === undefined ? false : browser.allSites;
  if (typeof browser.enabled !== "boolean" || typeof allSites !== "boolean" || !Array.isArray(browser.sites) || browser.sites.length > MAX_BROWSER_SITES) throw new Error("Configure browser.enabled, browser.allSites and explicit browser site policies");
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(new URL(coordinatorUrl(input.serverUrl)).hostname);
  const browserSites = browser.sites.map(site => parseBrowserSite(site, local));
  if (new Set(browserSites.map(site => site.siteId)).size !== browserSites.length || browser.enabled && !allSites && browserSites.length === 0) throw new Error("Enabled restricted browser execution needs distinct approved site policies");
  return {
    serverUrl: coordinatorUrl(input.serverUrl).origin,
    executorToken: input.executorToken,
    executorId: identifier(input.executorId, "executor ID"),
    workspaces: [...new Set(workspaces)],
    pollIntervalMs,
    coding: { enabled: coding.enabled },
    browser: { enabled: browser.enabled, allSites, sites: browserSites },
  };
}

function readConfigDocument(path: string): Record<string, unknown> {
  const absolute = resolve(path);
  privateDirectory(dirname(absolute), false);
  const fd = privateFile(absolute);
  try {
    if (fstatSync(fd).size > 65_536) throw new Error("Executor configuration is too large");
    return record(JSON.parse(readFileSync(fd, "utf8")));
  } finally { closeSync(fd); }
}

export function loadConfig(path = DEFAULT_CONFIG_PATH): MacConfig {
  return parseConfig(readConfigDocument(path));
}

export function initializeConfig(path: string, input: { serverUrl: string; executorToken: string; workspaces: string[]; pollIntervalMs?: number }): MacConfig {
  const config = parseConfig({ ...input, executorId: randomUUID() });
  const absolute = resolve(path);
  privateDirectory(dirname(absolute));
  const fd = openSync(absolute, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, `${JSON.stringify(config, null, 2)}\n`); } finally { closeSync(fd); }
  return config;
}

/** Called only while the daemon's exclusive state locks are held by the CLI. */
function updateConfig(path: string, update: (document: Record<string, unknown>, config: MacConfig) => void): MacConfig {
  const absolute = resolve(path);
  const document = readConfigDocument(absolute);
  update(document, parseConfig(document));
  const config = parseConfig(document);
  const serialized = `${JSON.stringify(document, null, 2)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > 65_536) throw new Error("Executor configuration is too large");
  const temporary = join(dirname(absolute), `.config-${randomUUID()}.tmp`);
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    writeFileSync(fd, serialized);
    fsyncSync(fd);
  } catch (error) {
    unlinkSync(temporary);
    throw error;
  } finally { closeSync(fd); }
  try {
    renameSync(temporary, absolute);
    const directory = openSync(dirname(absolute), constants.O_RDONLY);
    try { fsyncSync(directory); } finally { closeSync(directory); }
  } catch (error) {
    try { unlinkSync(temporary); } catch { /* Rename may have completed. */ }
    throw error;
  }
  return config;
}

/** Called only while the daemon's exclusive state locks are held by the CLI. */
export function setCodingEnabled(path: string, enabled: boolean): MacConfig {
  return updateConfig(path, document => {
    document.coding = { ...(document.coding === undefined ? {} : record(document.coding)), enabled };
  });
}

/** Local opt-in never replaces the separately approved coordinator task grant. */
export function setBrowserEnabled(path: string, enabled: boolean, allSites?: boolean): MacConfig {
  return updateConfig(path, (document, config) => {
    document.browser = { ...(document.browser === undefined ? {} : record(document.browser)), enabled, allSites: allSites ?? config.browser.allSites, sites: config.browser.sites };
  });
}

/** Approve exactly the coordinator's canonical policy, identified by its digest. */
export function grantBrowserSite(path: string, value: unknown, expectedDigest: string): MacConfig {
  return updateConfig(path, (document, config) => {
    const allowLoopback = ["localhost", "127.0.0.1", "[::1]"].includes(new URL(config.serverUrl).hostname);
    const site = parseBrowserSite(value, allowLoopback);
    const digest = createHash("sha256").update(browserSitePolicyJson(site)).digest("hex");
    if (!/^[a-f0-9]{64}$/.test(expectedDigest) || digest !== expectedDigest) throw new Error("Browser policy does not match the explicitly approved coordinator digest");
    const sites = config.browser.sites.filter(existing => existing.siteId !== site.siteId);
    sites.push(site);
    document.browser = { ...(document.browser === undefined ? {} : record(document.browser)), enabled: config.browser.enabled, allSites: config.browser.allSites, sites };
  });
}

export function revokeBrowserSite(path: string, siteId: string): MacConfig {
  const id = identifier(siteId, "browser site");
  return updateConfig(path, (document, config) => {
    if (!config.browser.sites.some(site => site.siteId === id)) throw new Error("Browser site is not locally approved");
    const sites = config.browser.sites.filter(site => site.siteId !== id);
    document.browser = { ...(document.browser === undefined ? {} : record(document.browser)), enabled: config.browser.enabled && (config.browser.allSites || sites.length > 0), allSites: config.browser.allSites, sites };
  });
}

/** Coding grants bind exactly one canonical root, unlike shell subdirectories. */
export function allowedCodingCwd(cwd: string, workspaces: readonly string[]): string {
  const canonical = allowedCwd(cwd, workspaces);
  if (canonical !== cwd || !workspaces.includes(canonical)) throw new Error("Coding workspace must exactly match a configured canonical root");
  return canonical;
}

export function stateDirectory(configPath: string, explicit?: string): string {
  return privateDirectory(explicit ?? join(dirname(resolve(configPath)), "state"));
}

export function allowedCwd(cwd: string, workspaces: readonly string[]): string {
  if (!isAbsolute(cwd)) throw new Error("Working directory must be absolute");
  const canonical = realpathSync(cwd);
  if (!statSync(canonical).isDirectory() || !workspaces.some(root => within(canonical, root))) {
    throw new Error("Working directory is outside configured workspace roots");
  }
  return canonical;
}
