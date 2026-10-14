import { spawn } from "node:child_process";
import { constants, closeSync, fstatSync, readFileSync, readSync } from "node:fs";
import { chmod, copyFile, mkdtemp, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";
import { privateDirectory, privateFile } from "./config.js";
import { BROWSER_REFRESH_MS, BROWSER_SNAPSHOT_MAX_AGE_MS, MAX_BROWSER_SITES, MAX_BROWSER_SNAPSHOT_BYTES, browserSitePolicyJson, parseBrowserSite } from "../shared/browser.js";
import type { BrowserSitePolicy, BrowserSnapshotEnvelope, BrowserSnapshotMetadata, BrowserSnapshotPublicKey } from "../shared/browser.js";
import { identifier, record } from "../shared/protocol.js";

export interface BrowserExportConfig {
  serverUrl: string;
  browserSyncToken: string;
  isolatedLoopback: boolean;
  requestedSites: boolean;
  approvedSites: BrowserSitePolicy[];
  sourceCookieDb: string;
  helperPath: string;
  stateDirectory: string;
}
export interface BrowserExportState {
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  nextAttemptAt: string | null;
  lastOutcome: "success" | "failed" | "in-progress" | null;
}
interface StoredSite extends BrowserExportState {
  site: BrowserSitePolicy;
  policyVersion: number | null;
  policyDigest: string;
}
export interface BrowserExportRuntime {
  fetch?: typeof fetch;
  signal?: AbortSignal;
  now?: () => number;
  helper?: (config: BrowserExportConfig, command: "export" | "authorize", input?: unknown) => Promise<unknown>;
  output?: (metadata: BrowserSnapshotMetadata) => void;
}
const MAX_REQUEST_PAGES = 32;
const TRANSPORT_LIMIT = Math.ceil(MAX_BROWSER_SNAPSHOT_BYTES * 4 / 3) + 16384;
function exactFields(input: Record<string, unknown>, fields: readonly string[]): void {
  if (Object.keys(input).length !== fields.length || fields.some(field => !Object.hasOwn(input, field))) throw new Error("Invalid browser export fields");
}
function absolute(value: unknown): string {
  if (typeof value !== "string" || !isAbsolute(value) || value.includes("\0") || value.length > 4096 || resolve(value) !== value) throw new Error("Browser export paths must be explicit absolute canonical paths");
  return value;
}
export function browserPolicyDigest(site: BrowserSitePolicy): string { return createHash("sha256").update(browserSitePolicyJson(site)).digest("hex"); }
export function parseBrowserExportConfig(value: unknown): BrowserExportConfig {
  const input = record(value);
  const fields = ["serverUrl", "browserSyncToken", "isolatedLoopback", "approvedSites", "sourceCookieDb", "helperPath", "stateDirectory"];
  exactFields(input, Object.hasOwn(input, "requestedSites") ? [...fields, "requestedSites"] : fields);
  const requestedSites = Object.hasOwn(input, "requestedSites") ? input.requestedSites : false;
  if (typeof requestedSites !== "boolean") throw new Error("Invalid requested browser site mode");
  if (typeof input.serverUrl !== "string" || typeof input.isolatedLoopback !== "boolean") throw new Error("Configure an explicit browser sync origin and isolation flag");
  const url = new URL(input.serverUrl);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash || (url.protocol !== "https:" && !(input.isolatedLoopback && loopback && url.protocol === "http:")) || input.isolatedLoopback && !loopback) throw new Error("Browser sync requires HTTPS or an explicitly isolated loopback coordinator");
  if (typeof input.browserSyncToken !== "string" || input.browserSyncToken.length < 32 || input.browserSyncToken.length > 4096 || /\s/.test(input.browserSyncToken)) throw new Error("Configure the distinct browser-sync token in private config");
  if (!Array.isArray(input.approvedSites) || (requestedSites ? input.approvedSites.length !== 0 : input.approvedSites.length < 1 || input.approvedSites.length > MAX_BROWSER_SITES)) throw new Error("Select requested sites or explicit local browser site approvals, never both");
  const approvedSites = input.approvedSites.map(site => parseBrowserSite(site, input.isolatedLoopback as boolean));
  if (new Set(approvedSites.map(site => site.siteId)).size !== approvedSites.length) throw new Error("Duplicate browser site approval");
  // The helper matches raw host_key exactly; reject case-folding ambiguity locally.
  if (approvedSites.some(site => site.cookieHosts.some(host => host !== host.toLowerCase()))) throw new Error("Cookie hosts must be canonical lowercase exact host keys");
  return { serverUrl: url.origin, browserSyncToken: input.browserSyncToken, isolatedLoopback: input.isolatedLoopback, requestedSites, approvedSites, sourceCookieDb: absolute(input.sourceCookieDb), helperPath: absolute(input.helperPath), stateDirectory: absolute(input.stateDirectory) };
}
export function loadBrowserExportConfig(path: string): BrowserExportConfig {
  const absolutePath = resolve(path);
  if (privateDirectory(dirname(absolutePath), false) !== dirname(absolutePath)) throw new Error("Browser export config directory must be canonical");
  const fd = privateFile(absolutePath);
  try {
    if (fstatSync(fd).size > 65536) throw new Error("Browser export config exceeds size limit");
    return parseBrowserExportConfig(JSON.parse(readFileSync(fd, "utf8")));
  } finally { closeSync(fd); }
}
function canonicalBase64(value: unknown, minimum: number, maximum: number): string {
  if (typeof value !== "string" || value.length > Math.ceil(maximum / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new Error("Invalid encrypted snapshot encoding");
  const decoded = Buffer.from(value, "base64");
  if (decoded.length < minimum || decoded.length > maximum || decoded.toString("base64") !== value) throw new Error("Invalid encrypted snapshot encoding");
  return value;
}
function timestamp(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) throw new Error("Invalid browser snapshot timestamp");
  return value;
}
export function parseBrowserSnapshotKey(value: unknown): BrowserSnapshotPublicKey {
  const input = record(value); exactFields(input, ["keyId", "publicKey"]);
  const key = record(input.publicKey);
  if (Object.keys(key).some(name => !["kty", "n", "e", "alg", "ext", "key_ops"].includes(name)) || key.kty !== "RSA" || key.e !== "AQAB" || typeof key.n !== "string" || !/^[A-Za-z0-9_-]+$/.test(key.n)) throw new Error("Invalid browser snapshot public key");
  const n = Buffer.from(key.n, "base64url");
  if (n.toString("base64url") !== key.n || n.length < 256 || n.length > 512 || n[0]! < 128 || key.alg !== undefined && key.alg !== "RSA-OAEP-256" || key.ext !== undefined && key.ext !== true || key.key_ops !== undefined && (!Array.isArray(key.key_ops) || key.key_ops.length !== 1 || key.key_ops[0] !== "encrypt")) throw new Error("Invalid browser snapshot public key");
  return { keyId: identifier(input.keyId, "snapshot key"), publicKey: key as JsonWebKey };
}
export function validateBrowserExportEnvelope(value: unknown, expected: { snapshotId: string; site: BrowserSitePolicy; key: BrowserSnapshotPublicKey; now: number }): BrowserSnapshotEnvelope {
  const input = record(value);
  exactFields(input, ["version", "snapshotId", "siteId", "policyDigest", "keyId", "capturedAt", "expiresAt", "wrappedKey", "nonce", "ciphertext"]);
  if (input.version !== 1 || input.snapshotId !== expected.snapshotId || input.siteId !== expected.site.siteId || input.policyDigest !== browserPolicyDigest(expected.site) || input.keyId !== expected.key.keyId) throw new Error("Encrypted snapshot scope mismatch");
  const capturedAt = timestamp(input.capturedAt), expiresAt = timestamp(input.expiresAt);
  if (Math.abs(Date.parse(capturedAt) - expected.now) > 5 * 60_000 || Date.parse(expiresAt) - Date.parse(capturedAt) !== BROWSER_SNAPSHOT_MAX_AGE_MS) throw new Error("Encrypted snapshot capture time mismatch");
  const modulusBytes = Buffer.from(expected.key.publicKey.n!, "base64url").length;
  return { version: 1, snapshotId: expected.snapshotId, siteId: expected.site.siteId, policyDigest: browserPolicyDigest(expected.site), keyId: expected.key.keyId, capturedAt, expiresAt, wrappedKey: canonicalBase64(input.wrappedKey, modulusBytes, modulusBytes), nonce: canonicalBase64(input.nonce, 12, 12), ciphertext: canonicalBase64(input.ciphertext, 16, MAX_BROWSER_SNAPSHOT_BYTES + 16) };
}
export function validateBrowserSnapshotReceipt(value: unknown, envelope: BrowserSnapshotEnvelope, body: Uint8Array): BrowserSnapshotMetadata {
  const input = record(value);
  exactFields(input, ["snapshotId", "siteId", "policyDigest", "keyId", "capturedAt", "expiresAt", "bytes", "digest"]);
  for (const field of ["snapshotId", "siteId", "policyDigest", "keyId", "capturedAt", "expiresAt"] as const) if (input[field] !== envelope[field]) throw new Error("Browser snapshot receipt mismatch");
  if (input.bytes !== body.byteLength || input.digest !== createHash("sha256").update(body).digest("hex")) throw new Error("Browser snapshot receipt digest mismatch");
  return input as unknown as BrowserSnapshotMetadata;
}
async function responseJson(response: Response, maximum = 65536): Promise<unknown> {
  if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error(`Browser sync request rejected (HTTP ${response.status})`); }
  const chunks: Uint8Array[] = []; let size = 0;
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength; if (size > maximum) throw new Error("Browser sync response exceeds size limit");
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  return JSON.parse(Buffer.concat(chunks, size).toString("utf8"));
}
async function processOutput(binary: string, args: string[], input: string, maximum: number, signal?: AbortSignal): Promise<{ stdout: string; stderr: string }> {
  const { promise, resolve: accept, reject } = Promise.withResolvers<{ stdout: string; stderr: string }>();
  const child = spawn(binary, args, { stdio: ["pipe", "pipe", "pipe"], env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: process.env.HOME ?? "", TMPDIR: process.env.TMPDIR ?? "/tmp" }, signal });
  const out: Buffer[] = [], err: Buffer[] = []; let size = 0, errSize = 0, oversized = false;
  child.stdout.on("data", (chunk: Buffer) => { size += chunk.length; if (size > maximum) { oversized = true; child.kill(); } else out.push(chunk); });
  child.stderr.on("data", (chunk: Buffer) => { errSize += chunk.length; if (errSize > 65536) { oversized = true; child.kill(); } else err.push(chunk); });
  child.stdin.on("error", () => {});
  child.on("error", () => reject(new Error("Browser helper process unavailable")));
  child.on("close", code => {
    const stderr = Buffer.concat(err).toString("utf8").trim();
    if (oversized) reject(new Error("Browser helper output exceeds size limit"));
    else if (code !== 0) {
      const safeCodes = ["keychain-locked-or-not-authorized", "aside-safe-storage-not-found", "keychain-access-failed", "cookie-database-unavailable", "unsupported-cookie-schema", "unsupported-cookie-encryption", "cookie-domain-hash-mismatch", "unsupported-cookie-value", "unsupported-partitioned-cookie", "unsupported-cookie-attributes", "unsupported-cookie-expiration", "cookie-snapshot-too-large", "cookie-decryption-failed"];
      reject(new Error(safeCodes.includes(stderr) ? stderr : "Browser helper failed; no export was accepted"));
    } else accept({ stdout: Buffer.concat(out).toString("utf8"), stderr });
  });
  child.stdin.end(input);
  return await promise;
}
export async function invokeBrowserExportHelper(config: BrowserExportConfig, command: "export" | "authorize", input?: unknown): Promise<unknown> {
  if (process.platform !== "darwin") throw new Error("Aside cookie export requires macOS");
  if (privateDirectory(dirname(config.helperPath), false) !== dirname(config.helperPath)) throw new Error("Helper directory must be canonical");
  const fd = privateFile(config.helperPath);
  try {
    if (!(fstatSync(fd).mode & 0o100)) throw new Error("Browser helper must be executable");
    const header = Buffer.alloc(4);
    if (readSync(fd, header, 0, 4, 0) !== 4 || !["cffaedfe", "feedfacf", "cafebabe", "bebafeca"].includes(header.toString("hex"))) throw new Error("Browser helper must be a compiled macOS executable");
  } finally { closeSync(fd); }
  await processOutput("/usr/bin/codesign", ["--verify", "--strict", config.helperPath], "", 16384, AbortSignal.timeout(30_000));
  return JSON.parse((await processOutput(config.helperPath, [command], input === undefined ? "" : JSON.stringify(input), TRANSPORT_LIMIT, AbortSignal.timeout(command === "authorize" ? 120_000 : 60_000))).stdout);
}
export async function buildBrowserExportHelper(output: string, syntheticFixture = false): Promise<void> {
  if (process.platform !== "darwin") throw new Error("Build the dedicated browser helper on macOS");
  const destination = absolute(resolve(output)), directory = privateDirectory(dirname(destination));
  if (directory !== dirname(destination)) throw new Error("Helper output directory must be canonical");
  const scratch = await mkdtemp(join(directory, ".browser-helper-build-"));
  try {
    const temporary = join(scratch, "aside-cookie-export");
    const source = fileURLToPath(new URL("../browser/aside-cookie-export.swift", import.meta.url));
    const module = fileURLToPath(new URL("../browser/aside-export-system", import.meta.url));
    await processOutput("/usr/bin/xcrun", ["swiftc", "-O", "-I", module, "-framework", "Security", ...(syntheticFixture ? ["-D", "SYNTHETIC_FIXTURE"] : []), source, "-o", temporary], "", 65536, AbortSignal.timeout(120_000));
    await chmod(temporary, 0o700);
    await processOutput("/usr/bin/codesign", ["--force", "--sign", "-", "--identifier", syntheticFixture ? "io.umpi.aside-cookie-export.synthetic" : "io.umpi.aside-cookie-export", temporary], "", 65536, AbortSignal.timeout(30_000));
    await copyFile(temporary, destination, constants.COPYFILE_EXCL);
    await chmod(destination, 0o700);
  } finally { await rm(scratch, { recursive: true, force: true }); }
}

const META_SCHEMA = "CREATE TABLE export_meta (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL CHECK(version=1), requested_sites INTEGER NOT NULL CHECK(requested_sites IN (0,1)), request_cursor INTEGER NOT NULL CHECK(request_cursor>=0))";
const SITES_SCHEMA = "CREATE TABLE export_sites (site_id TEXT PRIMARY KEY CHECK(length(site_id)<=128), policy_json TEXT NOT NULL CHECK(length(policy_json)<=65536), policy_version INTEGER CHECK(policy_version IS NULL OR policy_version>=1), policy_digest TEXT NOT NULL CHECK(length(policy_digest)=64), last_attempt_at TEXT CHECK(last_attempt_at IS NULL OR length(last_attempt_at)=24), last_success_at TEXT CHECK(last_success_at IS NULL OR length(last_success_at)=24), next_attempt_at TEXT CHECK(next_attempt_at IS NULL OR length(next_attempt_at)=24), last_outcome TEXT CHECK(last_outcome IS NULL OR last_outcome IN ('success','failed','in-progress')))";
function transaction(db: DatabaseSync, action: () => void): void {
  db.exec("BEGIN IMMEDIATE");
  try { action(); db.exec("COMMIT"); } catch (error) { db.exec("ROLLBACK"); throw error; }
}
function openState(config: BrowserExportConfig): DatabaseSync {
  const path = join(config.stateDirectory, "refresh.sqlite");
  const fd = privateFile(path, true);
  let fresh: boolean;
  try { fresh = fstatSync(fd).size === 0; } finally { closeSync(fd); }
  const db = new DatabaseSync(path);
  try {
    db.exec("PRAGMA trusted_schema=OFF; PRAGMA synchronous=FULL; PRAGMA busy_timeout=0");
    if (fresh) transaction(db, () => {
      db.exec(META_SCHEMA + ";" + SITES_SCHEMA);
      db.prepare("INSERT INTO export_meta VALUES(1,1,?,0)").run(Number(config.requestedSites));
    });
    const schema = db.prepare("SELECT name,sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY name LIMIT 3").all();
    if (schema.length !== 2 || schema[0]?.name !== "export_meta" || schema[0]?.sql !== META_SCHEMA || schema[1]?.name !== "export_sites" || schema[1]?.sql !== SITES_SCHEMA) throw new Error("Invalid browser refresh schema");
    const meta = record(db.prepare("SELECT * FROM export_meta LIMIT 2").get());
    exactFields(meta, ["id", "version", "requested_sites", "request_cursor"]);
    if (meta.id !== 1 || meta.version !== 1 || meta.requested_sites !== Number(config.requestedSites) || !Number.isSafeInteger(meta.request_cursor) || (meta.request_cursor as number) < 0) throw new Error("Invalid browser refresh mode or cursor");
    return db;
  } catch (error) { db.close(); throw error; }
}
function storedSite(value: unknown, allowLoopback: boolean): StoredSite {
  const row = record(value);
  exactFields(row, ["site_id", "policy_json", "policy_version", "policy_digest", "last_attempt_at", "last_success_at", "next_attempt_at", "last_outcome"]);
  if (typeof row.policy_json !== "string" || Buffer.byteLength(row.policy_json) > 65536) throw new Error("Invalid stored browser policy");
  const site = parseBrowserSite(JSON.parse(row.policy_json), allowLoopback);
  if (row.site_id !== site.siteId || row.policy_digest !== browserPolicyDigest(site) || row.policy_json !== browserSitePolicyJson(site) || row.policy_version !== null && (!Number.isSafeInteger(row.policy_version) || (row.policy_version as number) < 1)) throw new Error("Invalid stored browser policy digest");
  const lastAttemptAt = row.last_attempt_at === null ? null : timestamp(row.last_attempt_at);
  const lastSuccessAt = row.last_success_at === null ? null : timestamp(row.last_success_at);
  const nextAttemptAt = row.next_attempt_at === null ? null : timestamp(row.next_attempt_at);
  const lastOutcome = row.last_outcome;
  if (lastOutcome !== null && lastOutcome !== "success" && lastOutcome !== "failed" && lastOutcome !== "in-progress" || (lastAttemptAt === null) !== (nextAttemptAt === null) || (lastAttemptAt === null) !== (lastOutcome === null) || lastAttemptAt !== null && Date.parse(nextAttemptAt!) !== Date.parse(lastAttemptAt) + BROWSER_REFRESH_MS || lastSuccessAt !== null && (lastAttemptAt === null || Date.parse(lastSuccessAt) > Date.parse(nextAttemptAt!))) throw new Error("Invalid browser refresh schedule");
  return { site, policyVersion: row.policy_version as number | null, policyDigest: row.policy_digest as string, lastAttemptAt, lastSuccessAt, nextAttemptAt, lastOutcome };
}
function remoteSite(value: unknown, allowLoopback: boolean): { site: BrowserSitePolicy; version: number; policyDigest: string } {
  const raw = record(value);
  const { version, policyDigest, ...policy } = raw;
  const site = parseBrowserSite(policy, allowLoopback);
  if (!Number.isSafeInteger(version) || (version as number) < 1 || policyDigest !== browserPolicyDigest(site)) throw new Error("Invalid registered browser site policy digest");
  return { site, version: version as number, policyDigest: policyDigest as string };
}
function savePolicy(db: DatabaseSync, site: BrowserSitePolicy, version: number | null): void {
  const policy = browserSitePolicyJson(site);
  if (Buffer.byteLength(policy) > 65536) throw new Error("Browser policy exceeds state size limit");
  db.prepare("INSERT INTO export_sites(site_id,policy_json,policy_version,policy_digest) VALUES(?,?,?,?) ON CONFLICT(site_id) DO UPDATE SET policy_json=excluded.policy_json,policy_version=excluded.policy_version,policy_digest=excluded.policy_digest").run(site.siteId, policy, version, browserPolicyDigest(site));
}
type BrowserRequest = (path: string, init?: RequestInit) => Promise<unknown>;
async function updateRequestedSites(db: DatabaseSync, config: BrowserExportConfig, request: BrowserRequest): Promise<void> {
  for (let page = 0; page < MAX_REQUEST_PAGES; page++) {
    const cursor = db.prepare("SELECT request_cursor FROM export_meta WHERE id=1").get()!.request_cursor as number;
    const remote = record(await request(`/api/browser/snapshot-requests?after=${cursor}`));
    exactFields(remote, ["sites", "nextCursor"]);
    if (!Array.isArray(remote.sites) || remote.sites.length > MAX_BROWSER_SITES) throw new Error("Invalid requested browser site page");
    if (remote.sites.length === 0) {
      if (remote.nextCursor !== null) throw new Error("Invalid empty requested browser site cursor");
      return;
    }
    if (!Number.isSafeInteger(remote.nextCursor) || (remote.nextCursor as number) <= cursor) throw new Error("Invalid requested browser site cursor");
    const sites = remote.sites.map(item => remoteSite(item, config.isolatedLoopback));
    if (new Set(sites.map(item => item.site.siteId)).size !== sites.length) throw new Error("Duplicate requested browser site");
    transaction(db, () => {
      for (const item of sites) {
        const previous = db.prepare("SELECT * FROM export_sites WHERE site_id=?").get(item.site.siteId);
        if (previous) {
          const old = storedSite(previous, config.isolatedLoopback);
          if (old.policyVersion === null || item.version < old.policyVersion || item.version === old.policyVersion && item.policyDigest !== old.policyDigest) throw new Error("Invalid requested browser policy version");
        }
        savePolicy(db, item.site, item.version);
      }
      db.prepare("UPDATE export_meta SET request_cursor=? WHERE id=1").run(remote.nextCursor as number);
    });
  }
  // Cursor and every accepted policy are durable. The next watch poll resumes
  // here instead of dropping the tail or using an unbounded response/loop.
}
async function lease(directory: string): Promise<() => Promise<void>> {
  // SQLite's OS lock is automatically released after a crash. FULL-synchronous
  // per-site schedule commits survive it; no stale PID deletion or UI retry.
  const path = join(directory, "sync-lock.sqlite");
  closeSync(privateFile(path, true));
  const db = new DatabaseSync(path);
  try { db.exec("PRAGMA busy_timeout=0; BEGIN EXCLUSIVE"); }
  catch { db.close(); throw new Error("Browser sync already running or lock unavailable"); }
  return async () => { try { db.exec("ROLLBACK"); } finally { db.close(); } };
}
export function browserRefreshDue(state: BrowserExportState, now: number): boolean { return state.nextAttemptAt === null || now >= Date.parse(state.nextAttemptAt); }

/** Explicit sync is a one-shot; watch honors each site's durable attempt fence,
 * including failed/in-progress attempts and later approved policy changes. */
export async function syncBrowserSnapshots(config: BrowserExportConfig, runtime: BrowserExportRuntime = {}, scheduled = false): Promise<BrowserSnapshotMetadata[]> {
  config = parseBrowserExportConfig(config);
  const directory = privateDirectory(config.stateDirectory);
  if (directory !== config.stateDirectory) throw new Error("Browser refresh directory must be canonical");
  const release = await lease(directory);
  let db: DatabaseSync | undefined;
  const now = runtime.now ?? Date.now;
  try {
    db = openState(config);
    const state = db;
    const fetcher = runtime.fetch ?? fetch;
    const request: BrowserRequest = async (path, init = {}) => responseJson(await fetcher(config.serverUrl + path, { ...init, redirect: "error", signal: AbortSignal.any([runtime.signal ?? new AbortController().signal, AbortSignal.timeout(60_000)]), headers: { authorization: `Bearer ${config.browserSyncToken}`, "content-type": "application/json" } }), 1024 * 1024);
    let firstFailure: unknown;
    let failureCount = 0;
    const failed = (error: unknown) => { if (failureCount++ === 0) firstFailure = error; };
    if (config.requestedSites) {
      try { await updateRequestedSites(state, config, request); }
      catch (error) { if (runtime.signal?.aborted) throw error; failed(error); }
    } else transaction(state, () => {
      for (const site of config.approvedSites) savePolicy(state, site, null);
    });
    const receipts: BrowserSnapshotMetadata[] = [];
    let key: BrowserSnapshotPublicKey | undefined;
    let setupError: unknown;
    let setupDone = false;
    let registered: Map<string, string> | undefined;
    let afterSite = "";
    for (;;) {
      runtime.signal?.throwIfAborted();
      const approved = config.requestedSites ? "" : ` AND site_id IN (${config.approvedSites.map(() => "?").join(",")})`;
      const sql = `SELECT * FROM export_sites WHERE site_id>?${scheduled ? " AND (next_attempt_at IS NULL OR next_attempt_at<=?)" : ""}${approved} ORDER BY site_id LIMIT 16`;
      const rows = state.prepare(sql).all(afterSite, ...(scheduled ? [new Date(now()).toISOString()] : []), ...(config.requestedSites ? [] : config.approvedSites.map(site => site.siteId)));
      if (!rows.length) break;
      const sites = rows.map(row => storedSite(row, config.isolatedLoopback));
      afterSite = sites.at(-1)!.site.siteId;
      const attemptAt = now();
      transaction(state, () => {
        for (const item of sites) state.prepare("UPDATE export_sites SET last_attempt_at=?,next_attempt_at=?,last_outcome='in-progress' WHERE site_id=?").run(new Date(attemptAt).toISOString(), new Date(attemptAt + BROWSER_REFRESH_MS).toISOString(), item.site.siteId);
      });
      if (!setupDone) {
        setupDone = true;
        try {
          if (!config.requestedSites) {
            const remote = record(await request("/api/browser/sites")); exactFields(remote, ["sites"]);
            if (!Array.isArray(remote.sites)) throw new Error("Invalid registered browser site policies");
            registered = new Map();
            for (const value of remote.sites) {
              const item = remoteSite(value, config.isolatedLoopback);
              if (registered.has(item.site.siteId)) throw new Error("Duplicate registered browser site policy");
              registered.set(item.site.siteId, item.policyDigest);
            }
            if (sites.every(item => registered!.get(item.site.siteId) !== item.policyDigest)) throw new Error("Registered browser site differs from local owner approval");
          }
          key = parseBrowserSnapshotKey(await request("/api/browser/snapshot-key"));
        } catch (error) { setupError = error; }
      }
      for (const item of sites) {
        runtime.signal?.throwIfAborted();
        try {
          if (setupError !== undefined) throw setupError;
          if (registered && registered.get(item.site.siteId) !== item.policyDigest) throw new Error("Registered browser site differs from local owner approval");
          if (config.requestedSites) {
            const current = record(await request(`/api/browser/snapshot-requests/${encodeURIComponent(item.site.siteId)}`));
            exactFields(current, ["site"]);
            const authority = remoteSite(current.site, config.isolatedLoopback);
            if (authority.site.siteId !== item.site.siteId || authority.version !== item.policyVersion || authority.policyDigest !== item.policyDigest) throw new Error("Requested browser capture changed before export; wait for its approved policy update");
          }
          const snapshotId = randomUUID();
          const value = await (runtime.helper ?? invokeBrowserExportHelper)(config, "export", { sourceCookieDb: config.sourceCookieDb, site: item.site, policyDigest: item.policyDigest, snapshotId, key: key! });
          const envelope = validateBrowserExportEnvelope(value, { snapshotId, site: item.site, key: key!, now: now() });
          const body = Buffer.from(JSON.stringify(envelope));
          if (body.byteLength > MAX_BROWSER_SNAPSHOT_BYTES) throw new Error("Encrypted browser snapshot exceeds upload size limit");
          const receipt = validateBrowserSnapshotReceipt(await request(`/api/browser/snapshots/${encodeURIComponent(snapshotId)}`, { method: "POST", body }), envelope, body);
          state.prepare("UPDATE export_sites SET last_success_at=?,last_outcome='success' WHERE site_id=?").run(new Date(now()).toISOString(), item.site.siteId);
          receipts.push(receipt); runtime.output?.(receipt);
        } catch (error) {
          state.prepare("UPDATE export_sites SET last_outcome='failed' WHERE site_id=?").run(item.site.siteId);
          if (runtime.signal?.aborted) throw error;
          failed(error);
        }
      }
    }
    if (failureCount === 1) throw firstFailure;
    if (failureCount) throw new AggregateError([firstFailure], "Browser snapshot export failed for one or more sites");
    return receipts;
  } finally { db?.close(); await release(); }
}
export async function watchBrowserSnapshots(config: BrowserExportConfig, runtime: BrowserExportRuntime = {}, onFailure: () => void = () => {}): Promise<void> {
  config = parseBrowserExportConfig(config);
  for (;;) {
    runtime.signal?.throwIfAborted();
    try { await syncBrowserSnapshots(config, runtime, true); }
    catch (error) { if (runtime.signal?.aborted) throw error; onFailure(); }
    await sleep(60_000, undefined, { signal: runtime.signal });
  }
}
