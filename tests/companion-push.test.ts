import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { generateKeyPairSync } from "node:crypto";
import type { JobStatus } from "../src/shared/protocol.js";
import {
  sendCompanionPush,
  type CompanionPushConfig,
  type CompanionPushTarget,
} from "../src/worker/companion-push.js";

const target: CompanionPushTarget = { deviceId: "synthetic-device", apnsToken: "00".repeat(32), apnsEnvironment: "sandbox" };
const event = { revision: 7, jobs: [] };
const now = 1_800_000_000_000;
const providerId = "00000000-0000-4000-8000-000000000000";

function signingFixture() {
  const keys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const config: CompanionPushConfig = {
    APNS_TEAM_ID: "TESTTEAM00",
    APNS_KEY_ID: "TESTKEY000",
    APNS_PRIVATE_KEY: keys.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    APNS_BUNDLE_ID: "com.example.umpi",
  };
  return { config, publicKey: keys.publicKey.export({ format: "jwk" }) };
}

interface CapturedRequest {
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: Record<string, unknown>;
}

async function provider(t: { after: (fn: () => void) => void }) {
  const requests: CapturedRequest[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", chunk => { body += chunk; });
    request.on("end", () => {
      requests.push({ url: request.url!, headers: request.headers, body: JSON.parse(body) as Record<string, unknown> });
      if (request.url === "/disconnect") { request.socket.destroy(); return; }
      if (request.url === "/hang") return;
      if (request.url === "/redirect") {
        response.writeHead(307, { location: "/credential-leak", "apns-id": providerId });
        response.end();
        return;
      }
      if (request.url === "/unknown") { response.writeHead(200); response.end("not APNs"); return; }
      const status = Number(request.url!.slice(1)) || 200;
      response.writeHead(status, { "apns-id": providerId, "content-type": "application/json" });
      response.end(status === 200 ? "" : JSON.stringify({ reason: "private-provider-detail" }));
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address();
  assert(address && typeof address !== "string");
  const destinations: string[] = [];
  const transport = (path = "/200"): typeof fetch => (url, init) => {
    destinations.push(String(url));
    return fetch(`http://127.0.0.1:${address.port}${path}`, init);
  };
  return { requests, destinations, transport };
}

test("absent APNs credentials and absent device tokens never imply delivery", async () => {
  let calls = 0;
  const transport: typeof fetch = async () => { calls++; throw new Error("must not connect"); };
  const { config } = signingFixture();
  assert.deepEqual(await sendCompanionPush(target, event, {}, { fetch: transport }), { status: "unconfigured", reason: "missing_credentials" });
  for (const key of Object.keys(config)) {
    const partial = { ...config, [key]: "" };
    assert.equal((await sendCompanionPush(target, event, partial, { fetch: transport })).status, "unconfigured");
  }
  assert.deepEqual(await sendCompanionPush({ deviceId: target.deviceId }, event, config, { fetch: transport }), {
    status: "unconfigured", reason: "missing_device_token",
  });
  assert.equal(calls, 0);
});

test("background APNs requests carry real ES256 JWT signatures and correctly scoped headers", async t => {
  const remote = await provider(t);
  const { config, publicKey } = signingFixture();
  const result = await sendCompanionPush(target, event, config, { fetch: remote.transport(), now: () => now });
  assert.deepEqual(result, { status: "accepted" });
  assert.equal(remote.destinations[0], `https://api.sandbox.push.apple.com/3/device/${target.apnsToken}`);
  const request = remote.requests[0]!;
  assert.equal(request.headers["apns-topic"], "com.example.umpi");
  assert.equal(request.headers["apns-push-type"], "background");
  assert.equal(request.headers["apns-priority"], "5");
  assert.equal(request.headers["apns-expiration"], "0");
  assert.match(String(request.headers["apns-id"]), /^[a-f0-9-]{36}$/);
  assert.deepEqual(request.body, { aps: { "content-available": 1 }, revision: 7 });
  const jwt = String(request.headers.authorization).slice("bearer ".length);
  const [header, claims, signature] = jwt.split(".") as [string, string, string];
  assert.deepEqual(JSON.parse(Buffer.from(header, "base64url").toString()), { alg: "ES256", kid: config.APNS_KEY_ID });
  assert.deepEqual(JSON.parse(Buffer.from(claims, "base64url").toString()), { iss: config.APNS_TEAM_ID, iat: now / 1000 });
  const key = await crypto.subtle.importKey("jwk", publicKey, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  const bytes = Buffer.from(signature, "base64url");
  assert.equal(bytes.length, 64);
  assert.equal(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, bytes, new TextEncoder().encode(`${header}.${claims}`)), true);
  assert.equal(JSON.stringify(result).includes(jwt), false);
});

test("alerts ask for review without asserting device work, and production is explicit", async t => {
  const remote = await provider(t);
  const { config } = signingFixture();
  await sendCompanionPush({ ...target, apnsEnvironment: "production" }, { ...event, alert: true }, config, { fetch: remote.transport() });
  assert.equal(remote.destinations[0], `https://api.push.apple.com/3/device/${target.apnsToken}`);
  assert.equal(remote.requests[0]!.headers["apns-priority"], "10");
  assert.equal(remote.requests[0]!.headers["apns-push-type"], "alert");
  assert.deepEqual(remote.requests[0]!.body, {
    aps: { alert: { title: "Umpi", body: "Open Umpi to review the latest changes." }, "content-available": 1 }, revision: 7,
  });
});

test("Live Activities use actual job state, privacy-safe titles, stale dates and terminal end events", async t => {
  const remote = await provider(t);
  const { config } = signingFixture();
  const statuses: JobStatus[] = ["pending_approval", "queued", "running", "succeeded", "failed", "cancelled", "uncertain"];
  const jobs = statuses.map((status, index) => ({ jobId: `job-${index}`, status }));
  const activityTokens = jobs.map((job, index) => ({ jobId: job.jobId, token: (index + 1).toString(16).padStart(64, "0") }));
  activityTokens.push({ jobId: "missing-job", token: "ff".repeat(32) });
  assert.deepEqual(await sendCompanionPush({ ...target, apnsToken: undefined, activityTokens }, { revision: 9, jobs }, config, { fetch: remote.transport(), now: () => now }), { status: "accepted" });
  assert.equal(remote.requests.length, jobs.length);
  for (const request of remote.requests) {
    assert.equal(request.headers["apns-push-type"], "liveactivity");
    assert.equal(request.headers["apns-topic"], "com.example.umpi.push-type.liveactivity");
    assert.equal(request.headers["apns-priority"], "5");
    const aps = request.body.aps as Record<string, unknown>;
    const content = aps["content-state"] as { title: string; status: JobStatus };
    const job = jobs.find(candidate => candidate.status === content.status)!;
    assert.deepEqual(content, { title: `Umpi task ${job.jobId.slice(0, 8)}`, status: job.status });
    assert.equal(aps.timestamp, now / 1000);
    const terminal = statuses.indexOf(job.status) >= 3;
    assert.equal(aps.event, terminal ? "end" : "update");
    assert.equal(aps[terminal ? "dismissal-date" : "stale-date"], now / 1000 + (terminal ? 60 : 300));
    assert.equal(aps[terminal ? "stale-date" : "dismissal-date"], undefined);
  }
});

test("JWT is reused inside its validity window and refreshed before Apple's one-hour limit", async t => {
  const remote = await provider(t);
  const { config } = signingFixture();
  for (const elapsed of [0, 10 * 60_000, 51 * 60_000]) {
    assert.equal((await sendCompanionPush(target, event, config, { fetch: remote.transport(), now: () => now + elapsed })).status, "accepted");
  }
  assert.equal(remote.requests[0]!.headers.authorization, remote.requests[1]!.headers.authorization);
  assert.notEqual(remote.requests[1]!.headers.authorization, remote.requests[2]!.headers.authorization);
});

test("APNs rejections, redirects, disconnects and malformed responses remain truthful and private", async t => {
  const remote = await provider(t);
  const { config } = signingFixture();
  for (const status of [400, 403, 404, 405, 410, 413, 429, 500, 503]) {
    const result = await sendCompanionPush(target, event, config, { fetch: remote.transport(`/${status}`) });
    assert.deepEqual(result, { status: "failed", reason: status === 410 ? "token_expired" : "provider_rejected" });
    assert.equal(JSON.stringify(result).includes("private-provider-detail"), false);
  }
  for (const path of ["/redirect", "/disconnect", "/unknown"]) {
    const count = remote.requests.length;
    assert.equal((await sendCompanionPush(target, event, config, { fetch: remote.transport(path) })).status, "uncertain");
    assert.equal(remote.requests.length, count + 1); // No retries or redirected bearer-token leaks.
  }
  assert.equal(remote.requests.some(request => request.url === "/credential-leak"), false);
});

test("bounded delivery aborts an outstanding request without claiming it failed before acceptance", async t => {
  const remote = await provider(t);
  const { config } = signingFixture();
  // Warm signing separately so this assertion exercises a request in flight.
  await sendCompanionPush(target, event, config, { fetch: remote.transport() });
  const result = await sendCompanionPush(target, event, config, { fetch: remote.transport("/hang"), timeoutMs: 100 });
  assert.deepEqual(result, { status: "uncertain", reason: "timeout" });
  assert.equal(remote.requests.length, 2);
});

test("partial acceptance is uncertain, never a blanket accepted result or automatic retry", async t => {
  const remote = await provider(t);
  const { config } = signingFixture();
  let calls = 0;
  const mixed: typeof fetch = (url, init) => remote.transport(++calls === 1 ? "/200" : "/410")(url, init);
  const result = await sendCompanionPush({ ...target, activityTokens: [{ jobId: "job-1", token: "11".repeat(32) }] }, {
    revision: 1, jobs: [{ jobId: "job-1", status: "running" }],
  }, config, { fetch: mixed });
  assert.deepEqual(result, { status: "uncertain", reason: "partial_or_uncertain_delivery" });
  assert.equal(calls, 2);
});

test("bad keys, environments and path-injection tokens fail before any network activity", async () => {
  const { config } = signingFixture();
  let calls = 0;
  const transport: typeof fetch = async () => { calls++; throw new Error("must not connect"); };
  for (const broken of [
    { ...config, APNS_PRIVATE_KEY: "not a key" },
    { ...config, APNS_BUNDLE_ID: "com.example.umpi\r\nX-Leak: secret" },
    { ...config, APNS_TEAM_ID: "invalid" },
  ]) {
    assert.deepEqual(await sendCompanionPush(target, event, broken, { fetch: transport }), { status: "failed", reason: "invalid_configuration" });
  }
  for (const broken of [
    { ...target, apnsToken: "../another-path" },
    { ...target, apnsToken: "a".repeat(1026) },
    { ...target, apnsEnvironment: undefined },
    { ...target, activityTokens: Array.from({ length: 33 }, (_, index) => ({ jobId: `job-${index}`, token: "00".repeat(32) })) },
  ]) {
    assert.deepEqual(await sendCompanionPush(broken, event, config, { fetch: transport }), { status: "failed", reason: "invalid_request" });
  }
  assert.equal(calls, 0);
});
