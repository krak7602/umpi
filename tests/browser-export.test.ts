import assert from "node:assert/strict";
import test from "node:test";
import { createCipheriv, createDecipheriv, createHash, generateKeyPairSync, privateDecrypt, publicEncrypt, constants } from "node:crypto";
import { chmod, mkdtemp, readFile, realpath, rm, writeFile, lstat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { browserCookieAllowed, browserEnvelopeAad, browserSitePolicyJson, parseBrowserSite, requestedBrowserSite, BROWSER_REFRESH_MS, BROWSER_SNAPSHOT_MAX_AGE_MS } from "../src/shared/browser.js";
import type { BrowserSitePolicy, BrowserSnapshotEnvelope, BrowserSnapshotMetadata } from "../src/shared/browser.js";
import { browserPolicyDigest, browserRefreshDue, parseBrowserExportConfig, parseBrowserSnapshotKey, syncBrowserSnapshots, validateBrowserExportEnvelope, validateBrowserSnapshotReceipt } from "../src/mac/browser-export.js";
import type { BrowserExportConfig, BrowserExportRuntime, BrowserExportState } from "../src/mac/browser-export.js";
import { runBrowserCli } from "../src/cli/browser.js";

const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const publicKey = pair.publicKey.export({ format: "jwk" });
const key = { keyId: "synthetic-key", publicKey };
const NOW = Date.parse("2026-01-02T03:04:05.000Z");
const site: BrowserSitePolicy = { siteId: "example-site", title: "Synthetic site", origins: ["https://example.test"], cookieHosts: [".example.test"], cookieNames: ["session"], resourceHosts: ["example.test"] };
const policyDigest = browserPolicyDigest(site);
async function fixture(t: test.TestContext, requestedSites = false): Promise<BrowserExportConfig> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "umpi-browser-export-test-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  return parseBrowserExportConfig({ serverUrl: "https://coordinator.example", browserSyncToken: "synthetic-browser-sync-token-".repeat(2), isolatedLoopback: false, requestedSites, approvedSites: requestedSites ? [] : [site], sourceCookieDb: join(root, "synthetic.sqlite"), helperPath: join(root, "synthetic-helper"), stateDirectory: join(root, "state") });
}
function sealed(snapshotId: string, cookies: unknown[] = [], policy: BrowserSitePolicy = site, now = NOW): BrowserSnapshotEnvelope {
  const metadata = { snapshotId, siteId: policy.siteId, policyDigest: browserPolicyDigest(policy), keyId: key.keyId, capturedAt: new Date(now).toISOString(), expiresAt: new Date(now + BROWSER_SNAPSHOT_MAX_AGE_MS).toISOString() };
  const aes = Buffer.alloc(32, 7), nonce = Buffer.alloc(12, 9);
  const cipher = createCipheriv("aes-256-gcm", aes, nonce);
  cipher.setAAD(browserEnvelopeAad(metadata));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify({ version: 1, cookies })), cipher.final(), cipher.getAuthTag()]);
  const wrappedKey = publicEncrypt({ key: pair.publicKey, oaepHash: "sha256", padding: constants.RSA_PKCS1_OAEP_PADDING }, aes);
  return { version: 1, ...metadata, wrappedKey: wrappedKey.toString("base64"), nonce: nonce.toString("base64"), ciphertext: ciphertext.toString("base64") };
}
function decrypt(envelope: BrowserSnapshotEnvelope): unknown {
  const aes = privateDecrypt({ key: pair.privateKey, oaepHash: "sha256", padding: constants.RSA_PKCS1_OAEP_PADDING }, Buffer.from(envelope.wrappedKey, "base64"));
  const cipher = Buffer.from(envelope.ciphertext, "base64");
  const decipher = createDecipheriv("aes-256-gcm", aes, Buffer.from(envelope.nonce, "base64"));
  decipher.setAAD(browserEnvelopeAad(envelope)); decipher.setAuthTag(cipher.subarray(-16));
  return JSON.parse(Buffer.concat([decipher.update(cipher.subarray(0, -16)), decipher.final()]).toString());
}
function receipt(envelope: BrowserSnapshotEnvelope, body: Uint8Array) {
  return { snapshotId: envelope.snapshotId, siteId: envelope.siteId, policyDigest: envelope.policyDigest, keyId: envelope.keyId, capturedAt: envelope.capturedAt, expiresAt: envelope.expiresAt, bytes: body.byteLength, digest: createHash("sha256").update(body).digest("hex") };
}
function transport(uploads: BrowserSnapshotEnvelope[], override?: (value: BrowserSnapshotMetadata) => unknown): typeof fetch {
  return async (input, init) => {
    assert.equal(init?.redirect, "error");
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer " + "synthetic-browser-sync-token-".repeat(2));
    const path = new URL(String(input)).pathname;
    if (path === "/api/browser/sites") return Response.json({ sites: [{ ...site, version: 1, policyDigest }] });
    if (path === "/api/browser/snapshot-key") return Response.json(key);
    assert.equal(init?.method, "POST");
    const bytes = Buffer.from(init!.body as Uint8Array);
    const envelope: BrowserSnapshotEnvelope = JSON.parse(bytes.toString());
    assert.equal(path, `/api/browser/snapshots/${envelope.snapshotId}`);
    uploads.push(envelope);
    const result = receipt(envelope, bytes);
    return Response.json(override ? override(result) : result);
  };
}
const encryptedHelper: NonNullable<BrowserExportRuntime["helper"]> = async (_config, command, input) => {
  assert.equal(command, "export");
  assert.ok(input && typeof input === "object" && "snapshotId" in input && "site" in input && "policyDigest" in input && "key" in input);
  assert.equal(input.policyDigest, policyDigest); assert.deepEqual(input.site, site); assert.deepEqual(input.key, key);
  assert.ok(!("browserSyncToken" in input));
  assert.ok(typeof input.snapshotId === "string");
  return sealed(input.snapshotId);
};
function readSchedule(config: BrowserExportConfig, siteId = site.siteId): BrowserExportState {
  const db = new DatabaseSync(join(config.stateDirectory, "refresh.sqlite"), { readOnly: true });
  try {
    const row = db.prepare("SELECT last_attempt_at,last_success_at,next_attempt_at,last_outcome FROM export_sites WHERE site_id=?").get(siteId)!;
    return { lastAttemptAt: row.last_attempt_at as string | null, lastSuccessAt: row.last_success_at as string | null, nextAttemptAt: row.next_attempt_at as string | null, lastOutcome: row.last_outcome as BrowserExportState["lastOutcome"] };
  } finally { db.close(); }
}
interface ApprovedRequest { cursor: number; site: BrowserSitePolicy; version: number }
function requestedTransport(uploads: BrowserSnapshotEnvelope[], requests: ApprovedRequest[], cursors: number[] = [], pageSize = 16): typeof fetch {
  const upload = transport(uploads);
  return async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/browser/snapshot-requests") {
      assert.equal(init?.redirect, "error");
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer " + "synthetic-browser-sync-token-".repeat(2));
      const after = Number(url.searchParams.get("after")); cursors.push(after);
      const page = requests.filter(item => item.cursor > after).slice(0, pageSize);
      return Response.json({ sites: page.map(item => ({ ...item.site, version: item.version, policyDigest: browserPolicyDigest(item.site) })), nextCursor: page.at(-1)?.cursor ?? null });
    }
    const requested = /^\/api\/browser\/snapshot-requests\/([A-Za-z0-9_.:-]+)$/.exec(url.pathname);
    if (requested) {
      const item = requests.filter(item => item.site.siteId === requested[1]).at(-1);
      return item ? Response.json({ site: { ...item.site, version: item.version, policyDigest: browserPolicyDigest(item.site) } }) : new Response(null, { status: 404 });
    }
    assert.notEqual(url.pathname, "/api/browser/sites", "proposals/registered-site listings never authorize requested exports");
    return await upload(input, init);
  };
}
function scopedHelper(now: () => number, attempts: BrowserSitePolicy[], failed = new Set<string>()): NonNullable<BrowserExportRuntime["helper"]> {
  return async (_config, command, input) => {
    assert.equal(command, "export");
    assert.ok(input && typeof input === "object" && "site" in input && "snapshotId" in input && typeof input.snapshotId === "string");
    assert.ok(!("browserSyncToken" in input));
    const policy = parseBrowserSite(input.site);
    attempts.push(policy);
    if (failed.has(policy.siteId)) throw new Error("keychain-locked-or-not-authorized");
    return sealed(input.snapshotId, [], policy, now());
  };
}

test("configuration rejects extra roles, ambiguous origins, implicit loopback and nonexact cookie hosts", async t => {
  const config = await fixture(t);
  for (const change of [{ executorToken: "synthetic" }, { serverUrl: "http://coordinator.example" }, { serverUrl: "http://127.0.0.1" }, { serverUrl: "https://coordinator.example/path" }, { serverUrl: "https://user@coordinator.example" }, { isolatedLoopback: true }, { approvedSites: [{ ...site, cookieHosts: [".EXAMPLE.test"] }] }, { approvedSites: [] }]) assert.throws(() => parseBrowserExportConfig({ ...config, ...change }));
  assert.equal(parseBrowserExportConfig({ ...config, isolatedLoopback: true, serverUrl: "http://127.0.0.1:8787" }).serverUrl, "http://127.0.0.1:8787");
  assert.notEqual(browserPolicyDigest({ ...site, cookieHosts: ["example.test"] }), policyDigest);
  assert.notEqual(browserPolicyDigest({ ...site, cookieNames: ["other"] }), policyDigest);
});

test("RSA-OAEP-SHA256 and AES256GCM envelope binds exact metadata and supports ordinary empty-cookie export", () => {
  const envelope = sealed("synthetic-snapshot");
  assert.deepEqual(decrypt(envelope), { version: 1, cookies: [] });
  assert.deepEqual(validateBrowserExportEnvelope(envelope, { snapshotId: envelope.snapshotId, site, key, now: NOW }), envelope);
  assert.throws(() => decrypt({ ...envelope, siteId: "different-site" }));
  for (const change of [{ nonce: "" }, { nonce: envelope.nonce + "\n" }, { wrappedKey: envelope.wrappedKey.replace(/=+$/, "") }, { ciphertext: Buffer.alloc(15).toString("base64") }, { siteId: "different-site" }, { expiresAt: new Date(NOW + BROWSER_SNAPSHOT_MAX_AGE_MS + 1).toISOString() }, { capturedAt: "2026-01-02T03:04:05Z" }, { capturedAt: new Date(NOW - 300001).toISOString() }, { extra: true }]) assert.throws(() => validateBrowserExportEnvelope({ ...envelope, ...change }, { snapshotId: envelope.snapshotId, site, key, now: NOW }));
  assert.throws(() => parseBrowserSnapshotKey({ ...key, publicKey: { ...publicKey, d: "synthetic-private-material" } }));
  assert.throws(() => parseBrowserSnapshotKey({ ...key, publicKey: { ...publicKey, alg: "RSA-OAEP" } }));
});

test("sync uploads ciphertext only, validates immutable receipt, and durably schedules attempts and success", async t => {
  const config = await fixture(t), uploads: BrowserSnapshotEnvelope[] = [], emitted: unknown[] = [];
  const runtime = { now: () => NOW, helper: encryptedHelper, fetch: transport(uploads), output: (value: unknown) => emitted.push(value) };
  const result = await syncBrowserSnapshots(config, runtime);
  assert.equal(result.length, 1); assert.deepEqual(emitted, result); assert.equal(uploads.length, 1);
  assert.deepEqual(decrypt(uploads[0]!), { version: 1, cookies: [] });
  const state = readSchedule(config);
  assert.equal(state.lastOutcome, "success"); assert.equal(state.lastAttemptAt, new Date(NOW).toISOString()); assert.equal(state.lastSuccessAt, state.lastAttemptAt);
  assert.equal(browserRefreshDue(state, NOW + BROWSER_REFRESH_MS - 1), false); assert.equal(browserRefreshDue(state, NOW + BROWSER_REFRESH_MS), true);
  assert.deepEqual(await syncBrowserSnapshots(config, runtime, true), []); assert.equal(uploads.length, 1);
  assert.equal((await lstat(join(config.stateDirectory, "refresh.sqlite"))).mode & 0o777, 0o600);
  assert.equal((await lstat(config.stateDirectory)).mode & 0o777, 0o700);
});

test("owner policy mismatch fails before Keychain helper and persists a six-hour failure schedule", async t => {
  const config = await fixture(t); let helpers = 0;
  const runtime: BrowserExportRuntime = { now: () => NOW, helper: async () => { helpers++; throw new Error("must not run"); }, fetch: async () => Response.json({ sites: [{ ...site, cookieNames: ["different"], version: 2, policyDigest: browserPolicyDigest({ ...site, cookieNames: ["different"] }) }] }) };
  await assert.rejects(syncBrowserSnapshots(config, runtime), /local owner approval/); assert.equal(helpers, 0);
  assert.deepEqual(await syncBrowserSnapshots(config, runtime, true), []);
  const state = readSchedule(config);
  assert.equal(state.lastSuccessAt, null); assert.equal(state.lastOutcome, "failed"); assert.equal(state.nextAttemptAt, new Date(NOW + BROWSER_REFRESH_MS).toISOString());
});

test("receipt corruption and locked Keychain fail truthfully without authorization or immediate watch retry", async t => {
  const config = await fixture(t), uploads: BrowserSnapshotEnvelope[] = [];
  await assert.rejects(syncBrowserSnapshots(config, { now: () => NOW, helper: encryptedHelper, fetch: transport(uploads, value => ({ ...value, digest: "0".repeat(64) })) }), /receipt digest mismatch/);
  let calls = 0;
  const runtime: BrowserExportRuntime = { now: () => NOW + BROWSER_REFRESH_MS, fetch: transport(uploads), helper: async (_config, command) => { calls++; assert.equal(command, "export"); throw new Error("keychain-locked-or-not-authorized"); } };
  await assert.rejects(syncBrowserSnapshots(config, runtime, true), /keychain-locked-or-not-authorized/);
  assert.equal(calls, 1); assert.equal(uploads.length, 1);
  assert.deepEqual(await syncBrowserSnapshots(config, runtime, true), []); assert.equal(calls, 1);
  const envelope = sealed("receipt-test"), bytes = Buffer.from(JSON.stringify(envelope));
  assert.throws(() => validateBrowserSnapshotReceipt({ ...receipt(envelope, bytes), bytes: bytes.length + 1 }, envelope, bytes), /receipt/);
});

test("concurrent sync has one admission and releases its OS lock after failure", async t => {
  const config = await fixture(t);
  const entered = Promise.withResolvers<void>(), finish = Promise.withResolvers<void>();
  const first = syncBrowserSnapshots(config, { now: () => NOW, fetch: async () => { entered.resolve(); await finish.promise; throw new Error("synthetic transport failure"); } });
  await entered.promise;
  await assert.rejects(syncBrowserSnapshots(config), /already running|lock unavailable/);
  finish.resolve(); await assert.rejects(first, /synthetic transport failure/);
  await assert.rejects(syncBrowserSnapshots(config, { now: () => NOW, fetch: async () => { throw new Error("lock released"); } }), /lock released/);
});

test("CLI creates a private independent sync config and redacts credentials and local source paths", async t => {
  const config = await fixture(t), root = dirname(config.stateDirectory), policies = join(root, "policies.json"), path = join(root, "config.json");
  await writeFile(policies, JSON.stringify([site]), { mode: 0o600 });
  let stdout = "";
  await runBrowserCli(["config-create", "--config", path, "--origin", config.serverUrl, "--cookie-db", config.sourceCookieDb, "--helper", config.helperPath, "--state", config.stateDirectory, "--approved-sites", policies], { env: { UMPI_BROWSER_SYNC_TOKEN: config.browserSyncToken }, stdout: value => { stdout += value; } });
  assert.equal((await lstat(path)).mode & 0o777, 0o600); assert.deepEqual(JSON.parse(await readFile(path, "utf8")), config);
  assert.doesNotMatch(stdout, /synthetic-browser-sync-token|synthetic.sqlite|synthetic-helper/);
  await chmod(path, 0o644);
  await assert.rejects(runBrowserCli(["sync", "--config", path], { fetch: async () => { throw new Error("unsafe config must never transport"); } }), /Private file/);
});

test("requested mode is opt-in, mutually exclusive with fixed scopes and canonical in CLI config", async t => {
  const fixed = await fixture(t);
  const { requestedSites: _mode, ...withoutMode } = fixed;
  assert.equal(parseBrowserExportConfig(withoutMode).requestedSites, false);
  for (const requestedSites of [null, "true", 1]) assert.throws(() => parseBrowserExportConfig({ ...fixed, requestedSites }));
  assert.throws(() => parseBrowserExportConfig({ ...fixed, requestedSites: true }));
  const config = await fixture(t, true), path = join(dirname(config.stateDirectory), "requested.json");
  const args = ["config-create", "--config", path, "--origin", config.serverUrl, "--cookie-db", config.sourceCookieDb, "--helper", config.helperPath, "--state", config.stateDirectory];
  const env = { UMPI_BROWSER_SYNC_TOKEN: config.browserSyncToken };
  await assert.rejects(runBrowserCli(args, { env }), /exactly one/);
  await assert.rejects(runBrowserCli([...args, "--requested-sites", "--approved-sites", "/not-read.json"], { env }), /exactly one/);
  let stdout = "";
  await runBrowserCli([...args, "--requested-sites"], { env, stdout: value => { stdout += value; } });
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), config);
  assert.equal((await lstat(path)).mode & 0o777, 0o600);
  assert.doesNotMatch(stdout, /synthetic-browser-sync-token|synthetic.sqlite|synthetic-helper/);
  assert.equal(JSON.parse(stdout).requestedSites, true);
});

test("standing requested eligibility exports nothing until a server-approved request, then ordinary empty auth promptly", async t => {
  const config = await fixture(t, true), uploads: BrowserSnapshotEnvelope[] = [], attempts: BrowserSitePolicy[] = [];
  const requested = requestedBrowserSite("https://www.example.com/account");
  const requests: ApprovedRequest[] = [];
  let now = NOW;
  const runtime = { now: () => now, helper: scopedHelper(() => now, attempts), fetch: requestedTransport(uploads, requests) };
  assert.deepEqual(await syncBrowserSnapshots(config, runtime, true), []);
  assert.equal(attempts.length, 0); assert.equal(uploads.length, 0);
  requests.push({ cursor: 1, site: requested, version: 1 });
  now += 60_000;
  assert.equal((await syncBrowserSnapshots(config, runtime, true)).length, 1);
  assert.deepEqual(attempts, [requested]);
  assert.deepEqual(decrypt(uploads[0]!), { version: 1, cookies: [] });
  assert.equal(uploads[0]!.policyDigest, browserPolicyDigest(requested));
  assert.equal(readSchedule(config, requested.siteId).nextAttemptAt, new Date(now + BROWSER_REFRESH_MS).toISOString());
  assert.deepEqual(await syncBrowserSnapshots(config, { ...runtime }, true), []);
  assert.equal(attempts.length, 1);
  assert.equal((await syncBrowserSnapshots(config, runtime)).length, 1, "explicit sync is a separate one-shot, not an immediate watch retry");
});

test("requested pages drain beyond sixteen sites and resume their durable bounded cursor without dropping a tail", async t => {
  const config = await fixture(t, true), uploads: BrowserSnapshotEnvelope[] = [], attempts: BrowserSitePolicy[] = [], cursors: number[] = [];
  const requests = Array.from({ length: 35 }, (_, index) => ({ cursor: index + 1, site: requestedBrowserSite(`https://site${index}.com`), version: 1 }));
  const runtime = { now: () => NOW, helper: scopedHelper(() => NOW, attempts), fetch: requestedTransport(uploads, requests, cursors, 1) };
  assert.equal((await syncBrowserSnapshots(config, runtime, true)).length, 32);
  assert.deepEqual(cursors, Array.from({ length: 32 }, (_, index) => index));
  assert.equal((await syncBrowserSnapshots(config, { ...runtime }, true)).length, 3);
  assert.deepEqual(cursors.slice(32), [32, 33, 34, 35]);
  assert.equal(new Set(attempts.map(item => item.siteId)).size, 35);
  assert.equal(uploads.length, 35);
  assert.deepEqual(await syncBrowserSnapshots(config, runtime, true), []);
  assert.equal(cursors.at(-1), 35);
});

test("changed approved policy persists promptly without bypassing its site's six-hour attempt fence", async t => {
  const config = await fixture(t, true), uploads: BrowserSnapshotEnvelope[] = [], attempts: BrowserSitePolicy[] = [];
  const requests = [{ cursor: 1, site, version: 1 }];
  let now = NOW;
  const runtime = { now: () => now, helper: scopedHelper(() => now, attempts), fetch: requestedTransport(uploads, requests) };
  await syncBrowserSnapshots(config, runtime, true);
  const changed = { ...site, cookieNames: ["new-session"] };
  requests.splice(0, 1, { cursor: 2, site: changed, version: 2 });
  now += 60_000;
  assert.deepEqual(await syncBrowserSnapshots(config, runtime, true), []);
  assert.equal(readSchedule(config).lastAttemptAt, new Date(NOW).toISOString());
  now = NOW + BROWSER_REFRESH_MS;
  await syncBrowserSnapshots(config, { ...runtime }, true);
  assert.deepEqual(attempts, [site, changed]);
  assert.equal(uploads[1]!.policyDigest, browserPolicyDigest(changed));
  assert.notEqual(uploads[1]!.policyDigest, uploads[0]!.policyDigest);
});

test("a new site's failure cannot re-export a healthy site or prevent its independent due attempt, including restarts", async t => {
  const config = await fixture(t, true), uploads: BrowserSnapshotEnvelope[] = [], attempts: BrowserSitePolicy[] = [], emitted: BrowserSnapshotMetadata[] = [];
  const healthy = { ...site, siteId: "z-healthy" }, failing = { ...site, siteId: "a-failing" };
  const requests = [{ cursor: 1, site: healthy, version: 1 }];
  const failed = new Set<string>();
  let now = NOW;
  const runtime = { now: () => now, helper: scopedHelper(() => now, attempts, failed), fetch: requestedTransport(uploads, requests), output: (value: BrowserSnapshotMetadata) => emitted.push(value) };
  await syncBrowserSnapshots(config, runtime, true);
  requests.push({ cursor: 2, site: failing, version: 1 }); failed.add(failing.siteId); now += 60_000;
  await assert.rejects(syncBrowserSnapshots(config, runtime, true), /keychain-locked/);
  assert.equal(uploads.length, 1); assert.equal(readSchedule(config, healthy.siteId).lastAttemptAt, new Date(NOW).toISOString());
  now += 60_000;
  assert.deepEqual(await syncBrowserSnapshots(config, { ...runtime }, true), []);
  assert.equal(attempts.length, 2);
  now = NOW + BROWSER_REFRESH_MS;
  assert.equal((await syncBrowserSnapshots(config, runtime, true)).length, 1);
  assert.equal(uploads.length, 2); assert.equal(uploads[1]!.siteId, healthy.siteId);
  now += 60_000;
  await assert.rejects(syncBrowserSnapshots(config, runtime, true), /keychain-locked/);
  assert.equal(uploads.length, 2); assert.equal(emitted.length, 2);
  assert.equal(readSchedule(config, failing.siteId).nextAttemptAt, new Date(now + BROWSER_REFRESH_MS).toISOString());
  assert.deepEqual(await syncBrowserSnapshots(config, { ...runtime }, true), []);
});

test("a failed first site does not prevent another due site or reset either schedule", async t => {
  const config = await fixture(t, true), attempts: BrowserSitePolicy[] = [], uploads: BrowserSnapshotEnvelope[] = [];
  const failing = { ...site, siteId: "a-failing" }, healthy = { ...site, siteId: "z-healthy" };
  const requests = [{ cursor: 1, site: failing, version: 1 }, { cursor: 2, site: healthy, version: 1 }];
  const runtime = { now: () => NOW, fetch: requestedTransport(uploads, requests), helper: scopedHelper(() => NOW, attempts, new Set([failing.siteId])) };
  await assert.rejects(syncBrowserSnapshots(config, runtime, true), /keychain-locked/);
  assert.deepEqual(attempts.map(item => item.siteId), [failing.siteId, healthy.siteId]);
  assert.deepEqual(uploads.map(item => item.siteId), [healthy.siteId]);
  assert.equal(readSchedule(config, failing.siteId).lastOutcome, "failed");
  assert.equal(readSchedule(config, healthy.siteId).lastOutcome, "success");
  const db = new DatabaseSync(join(config.stateDirectory, "refresh.sqlite"));
  try { db.prepare("UPDATE export_sites SET last_outcome='in-progress' WHERE site_id=?").run(failing.siteId); } finally { db.close(); }
  assert.deepEqual(await syncBrowserSnapshots(config, { ...runtime }, true), []);
  assert.equal(attempts.length, 2, "a process restart with an unfinished attempt cannot retry immediately");
});

test("requested domain selection never expands to wildcard jars, public/private suffixes, unrelated siblings or malformed hosts", () => {
  const policy = requestedBrowserSite("https://sub.example.com/account");
  assert.equal(policy.domain, "example.com");
  assert.equal(browserSitePolicyJson(policy), JSON.stringify({ siteId: policy.siteId, title: policy.title, origins: policy.origins, cookieHosts: [], cookieNames: [], resourceHosts: [], domain: "example.com", resources: "public" }));
  for (const host of ["example.com", ".example.com", "www.example.com", ".nested.www.example.com"]) {
    assert.equal(browserCookieAllowed("session", host, policy), true);
    assert.equal(browserCookieAllowed("any-supported-name", host, policy), true);
  }
  for (const host of [".com", ".notexample.com", ".example.com.attacker.org", ".github.io", "..example.com", ".foo..example.com", ".EXAMPLE.com", "*", "*.example.com"]) assert.equal(browserCookieAllowed("session", host, policy), false);
  assert.equal(browserCookieAllowed("invalid;name", ".example.com", policy), false);
  const privatePolicy = requestedBrowserSite("https://app.tenant.github.io");
  assert.equal(privatePolicy.domain, "tenant.github.io");
  assert.equal(browserCookieAllowed("session", ".tenant.github.io", privatePolicy), true);
  for (const host of [".github.io", ".other.github.io", ".io"]) assert.equal(browserCookieAllowed("session", host, privatePolicy), false);
  for (const domain of ["com", "co.uk", "github.io", "localhost", "example.test", "*.example.com", "127.0.0.1"]) assert.throws(() => parseBrowserSite({ ...policy, domain, origins: ["https://" + domain] }));
});

test("external requested JSON rejects unknown fields, bad versions/digests, unsafe scopes and nonadvancing cursors before export", async t => {
  const policy = requestedBrowserSite("https://example.com");
  const valid = { ...policy, version: 1, policyDigest: browserPolicyDigest(policy) };
  const invalidPages: unknown[] = [
    { sites: [valid], nextCursor: 1, extra: true },
    { sites: [{ ...valid, version: 0 }], nextCursor: 1 },
    { sites: [{ ...valid, version: 1.5 }], nextCursor: 1 },
    { sites: [{ ...valid, policyDigest: "0".repeat(64) }], nextCursor: 1 },
    { sites: [{ ...valid, extra: true }], nextCursor: 1 },
    { sites: [{ ...valid, domain: null }], nextCursor: 1 },
    { sites: [{ ...valid, resources: "*" }], nextCursor: 1 },
    { sites: [{ ...valid, domain: "co.uk", origins: ["https://co.uk"] }], nextCursor: 1 },
    { sites: [valid], nextCursor: null },
    { sites: [valid], nextCursor: 0 },
    { sites: [valid], nextCursor: 1.5 },
    { sites: [], nextCursor: 1 },
    { sites: [valid, { ...valid, extra: true }], nextCursor: 2 },
    { sites: [valid, valid], nextCursor: 2 },
  ];
  for (const page of invalidPages) {
    const config = await fixture(t, true); let helpers = 0, calls = 0;
    const runtime = { now: () => NOW, helper: async () => { helpers++; throw new Error("must not export"); }, fetch: async (input: Parameters<typeof fetch>[0]) => { calls++; assert.match(String(input), /snapshot-requests\?after=0$/); return Response.json(page); } };
    await assert.rejects(syncBrowserSnapshots(config, runtime, true));
    assert.equal(helpers, 0); assert.equal(calls, 1);
  }
});

test("requested state rejects schema or mode changes without reading credentials or transporting", async t => {
  const config = await fixture(t, true);
  await syncBrowserSnapshots(config, { now: () => NOW, fetch: requestedTransport([], []) }, true);
  await assert.rejects(syncBrowserSnapshots({ ...config, requestedSites: false, approvedSites: [site] }, { fetch: async () => { throw new Error("must not transport"); } }), /mode or cursor/);
  const db = new DatabaseSync(join(config.stateDirectory, "refresh.sqlite"));
  try { db.exec("CREATE TABLE unexpected_state(value TEXT)"); } finally { db.close(); }
  await assert.rejects(syncBrowserSnapshots(config, { fetch: async () => { throw new Error("must not transport"); } }), /refresh schema/);
});

test("stale or conflicting request versions cannot replace the last approved policy or reset its schedule", async t => {
  const config = await fixture(t, true), attempts: BrowserSitePolicy[] = [], uploads: BrowserSnapshotEnvelope[] = [];
  const requests = [{ cursor: 1, site, version: 2 }];
  const runtime = { now: () => NOW, fetch: requestedTransport(uploads, requests), helper: scopedHelper(() => NOW, attempts) };
  await syncBrowserSnapshots(config, runtime, true);
  for (const replacement of [{ cursor: 2, site, version: 1 }, { cursor: 2, site: { ...site, cookieNames: ["different"] }, version: 2 }]) {
    requests.splice(0, 1, replacement);
    await assert.rejects(syncBrowserSnapshots(config, runtime, true), /policy version/);
    assert.equal(attempts.length, 1);
    assert.equal(readSchedule(config).nextAttemptAt, new Date(NOW + BROWSER_REFRESH_MS).toISOString());
  }
  requests.splice(0, 1, { cursor: 2, site, version: 2 });
  assert.deepEqual(await syncBrowserSnapshots(config, runtime, true), []);
});

test("request polling failure cannot block an already-approved healthy site's due attempt", async t => {
  const config = await fixture(t, true), attempts: BrowserSitePolicy[] = [], uploads: BrowserSnapshotEnvelope[] = [], emitted: BrowserSnapshotMetadata[] = [];
  let now = NOW;
  const fetcher = requestedTransport(uploads, [{ cursor: 1, site, version: 1 }]);
  const runtime = { now: () => now, fetch: fetcher, helper: scopedHelper(() => now, attempts), output: (value: BrowserSnapshotMetadata) => emitted.push(value) };
  await syncBrowserSnapshots(config, runtime, true);
  now += BROWSER_REFRESH_MS;
  await assert.rejects(syncBrowserSnapshots(config, { ...runtime, fetch: async (input, init) => {
    if (new URL(String(input)).pathname === "/api/browser/snapshot-requests") throw new Error("synthetic request polling failure");
    return await fetcher(input, init);
  } }, true), /request polling failure/);
  assert.equal(attempts.length, 2); assert.equal(uploads.length, 2); assert.equal(emitted.length, 2);
  assert.equal(readSchedule(config).lastOutcome, "success");
});

test("requested durable state remains owner-only and refuses insecure files before any network request", async t => {
  const config = await fixture(t, true), path = join(config.stateDirectory, "refresh.sqlite");
  await syncBrowserSnapshots(config, { now: () => NOW, fetch: requestedTransport([], []) }, true);
  assert.equal((await lstat(path)).mode & 0o777, 0o600);
  await chmod(path, 0o644);
  await assert.rejects(syncBrowserSnapshots(config, { fetch: async () => { throw new Error("must not transport"); } }), /Private file/);
});


test("requested response pages cannot exceed bounded site or transport sizes", async t => {
  const policy = requestedBrowserSite("https://example.com"), valid = { ...policy, version: 1, policyDigest: browserPolicyDigest(policy) };
  for (const page of [{ sites: Array.from({ length: 17 }, () => valid), nextCursor: 17 }, { sites: [{ ...valid, title: "x".repeat(1024 * 1024) }], nextCursor: 1 }]) {
    const config = await fixture(t, true); let helpers = 0;
    await assert.rejects(syncBrowserSnapshots(config, { now: () => NOW, fetch: async () => Response.json(page), helper: async () => { helpers++; throw new Error("must not export"); } }, true), /page|size limit/);
    assert.equal(helpers, 0);
  }
});

test("withdrawing an approved request blocks cached scope before Keychain dispatch without affecting another due site", async t => {
  const config = await fixture(t, true), uploads: BrowserSnapshotEnvelope[] = [], attempts: BrowserSitePolicy[] = [];
  const first = requestedBrowserSite("https://example.com/"), second = requestedBrowserSite("https://example.org/");
  const requests: ApprovedRequest[] = [{ cursor: 1, site: first, version: 1 }, { cursor: 2, site: second, version: 1 }];
  let now = NOW;
  const runtime = { now: () => now, helper: scopedHelper(() => now, attempts), fetch: requestedTransport(uploads, requests) };
  await syncBrowserSnapshots(config, runtime, true);
  attempts.length = 0; uploads.length = 0;
  requests.splice(0, 1); now += BROWSER_REFRESH_MS;
  await assert.rejects(syncBrowserSnapshots(config, runtime, true));
  assert.deepEqual(attempts.map(site => site.siteId), [second.siteId]);
  assert.equal(uploads[0]!.siteId, second.siteId);
  assert.equal(readSchedule(config, first.siteId).lastOutcome, "failed");
  assert.equal(readSchedule(config, second.siteId).lastOutcome, "success");
});
