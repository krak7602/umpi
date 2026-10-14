import type { JobStatus } from "../shared/protocol.js";

export interface CompanionPushConfig {
  APNS_TEAM_ID?: string;
  APNS_KEY_ID?: string;
  APNS_PRIVATE_KEY?: string;
  APNS_BUNDLE_ID?: string;
}

export interface CompanionPushTarget {
  deviceId: string;
  apnsToken?: string;
  apnsEnvironment?: "sandbox" | "production";
  activityTokens?: readonly { jobId: string; token: string }[];
}

export interface CompanionPushEvent {
  revision: number;
  jobs: readonly { jobId: string; status: JobStatus }[];
  alert?: boolean;
}

export interface CompanionPushResult {
  /** APNs acceptance is not delivery to the phone or acknowledgment of an effect. */
  status: "accepted" | "failed" | "uncertain" | "unconfigured";
  reason?: string;
}

export interface CompanionPushOptions {
  /** Trusted transport injection, not a device-supplied URL or an automatic relay. */
  fetch?: typeof fetch;
  timeoutMs?: number;
  now?: () => number;
}

type Notification = { token: string; type: "background" | "alert" | "liveactivity"; body: string };
type SigningToken = { value: string; issuedAt: number };
type Credentials = Required<CompanionPushConfig>;
const signingTokens = new WeakMap<CompanionPushConfig, { credentials: Credentials; token: Promise<SigningToken> }>();
const encoder = new TextEncoder();
const terminalStatuses: Partial<Record<JobStatus, true>> = { succeeded: true, failed: true, cancelled: true, uncertain: true };
const jobStatuses: Record<JobStatus, true> = { pending_approval: true, queued: true, running: true, succeeded: true, failed: true, cancelled: true, uncertain: true };
const tokenPattern = /^(?:[a-fA-F0-9]{2}){1,512}$/;
const idPattern = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const apnsIdPattern = /^[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}$/;

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

async function sign(credentials: Credentials, now: number): Promise<SigningToken> {
  const pem = credentials.APNS_PRIVATE_KEY.replace(/\\n/g, "\n").trim();
  const match = /^-----BEGIN PRIVATE KEY-----\s+([A-Za-z0-9+/=\s]+)\s+-----END PRIVATE KEY-----$/.exec(pem);
  if (!match || pem.length > 4096) throw new Error("Invalid signing key");
  const bytes = Uint8Array.from(atob(match[1]!.replace(/\s/g, "")), character => character.charCodeAt(0));
  const key = await crypto.subtle.importKey("pkcs8", bytes, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const issuedAt = Math.floor(now / 1000);
  const header = base64url(encoder.encode(JSON.stringify({ alg: "ES256", kid: credentials.APNS_KEY_ID })));
  const claims = base64url(encoder.encode(JSON.stringify({ iss: credentials.APNS_TEAM_ID, iat: issuedAt })));
  const input = `${header}.${claims}`;
  // Web Crypto returns the JWT-required IEEE P1363 r||s encoding, not ASN.1 DER.
  const signature = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, encoder.encode(input)));
  if (signature.length !== 64) throw new Error("Invalid signing result");
  return { value: `${input}.${base64url(signature)}`, issuedAt };
}

async function providerToken(config: CompanionPushConfig, credentials: Credentials, now: number): Promise<string> {
  const cached = signingTokens.get(config);
  if (cached && Object.keys(credentials).every(key => credentials[key as keyof Credentials] === cached.credentials[key as keyof Credentials])) {
    const token = await cached.token;
    const age = now / 1000 - token.issuedAt;
    if (age >= 0 && age < 50 * 60) return token.value;
  }
  const token = sign(credentials, now);
  const entry = { credentials, token };
  signingTokens.set(config, entry);
  try {
    return (await token).value;
  } catch {
    if (signingTokens.get(config) === entry) signingTokens.delete(config);
    throw new Error("Invalid APNs configuration");
  }
}

function notifications(target: CompanionPushTarget, event: CompanionPushEvent, now: number): Notification[] {
  if (!idPattern.test(target.deviceId) || !Number.isSafeInteger(event.revision) || event.revision < 0 ||
      !["sandbox", "production"].includes(target.apnsEnvironment ?? "") ||
      (target.activityTokens?.length ?? 0) > 32) throw new Error("Invalid push target");
  const result: Notification[] = [];
  if (target.apnsToken) {
    result.push({ token: target.apnsToken, type: event.alert ? "alert" : "background", body: JSON.stringify({
      aps: event.alert
        ? { alert: { title: "Umpi", body: "Open Umpi to review the latest changes." }, "content-available": 1 }
        : { "content-available": 1 },
      revision: event.revision,
    }) });
  }
  const timestamp = Math.floor(now / 1000);
  const seen = new Set<string>();
  for (const activity of target.activityTokens ?? []) {
    if (!idPattern.test(activity.jobId) || seen.has(activity.jobId)) throw new Error("Invalid activity target");
    seen.add(activity.jobId);
    const job = event.jobs.find(candidate => candidate.jobId === activity.jobId);
    // No invented state for a job no longer present in the authoritative snapshot.
    if (!job) continue;
    if (!Object.hasOwn(jobStatuses, job.status)) throw new Error("Invalid job status");
    const terminal = terminalStatuses[job.status] === true;
    result.push({ token: activity.token, type: "liveactivity", body: JSON.stringify({ aps: {
      timestamp,
      event: terminal ? "end" : "update",
      "content-state": { title: `Umpi task ${job.jobId.slice(0, 8)}`, status: job.status },
      ...(terminal ? { "dismissal-date": timestamp + 60 } : { "stale-date": timestamp + 300 }),
    } }) });
  }
  if (result.some(notification => !tokenPattern.test(notification.token) || encoder.encode(notification.body).byteLength > 4096)) {
    throw new Error("Invalid push payload");
  }
  return result;
}

/**
 * Direct APNs HTTPS transport, using the same fetch path as cloudflare-apns2.
 * Workers node:http2 is a nonfunctional stub and must not be used here.
 * Managed-edge unauthenticated probes reached both APNs environments (HTTP 403);
 * local workerd instead returned "Network connection lost". Signed real-device
 * delivery remains unverified; APNs acceptance never proves phone delivery.
 */
export async function sendCompanionPush(
  target: CompanionPushTarget,
  event: CompanionPushEvent,
  config: CompanionPushConfig,
  options: CompanionPushOptions = {},
): Promise<CompanionPushResult> {
  const { APNS_TEAM_ID, APNS_KEY_ID, APNS_PRIVATE_KEY, APNS_BUNDLE_ID } = config;
  if (!APNS_TEAM_ID || !APNS_KEY_ID || !APNS_PRIVATE_KEY || !APNS_BUNDLE_ID) {
    return { status: "unconfigured", reason: "missing_credentials" };
  }
  if (!/^[A-Z0-9]{10}$/.test(APNS_TEAM_ID) || !/^[A-Z0-9]{10}$/.test(APNS_KEY_ID) ||
      APNS_BUNDLE_ID.length > 255 || !/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(APNS_BUNDLE_ID)) {
    return { status: "failed", reason: "invalid_configuration" };
  }
  if (!target.apnsToken && !target.activityTokens?.length) return { status: "unconfigured", reason: "missing_device_token" };
  const now = (options.now ?? Date.now)();
  let pending: Notification[];
  try {
    if (!Number.isFinite(now) || now < 0) throw new Error("Invalid time");
    pending = notifications(target, event, now);
  } catch {
    return { status: "failed", reason: "invalid_request" };
  }
  if (!pending.length) return { status: "unconfigured", reason: "missing_device_token" };
  const timeout = options.timeoutMs ?? 8000;
  if (!Number.isFinite(timeout) || timeout < 1 || timeout > 30_000) return { status: "failed", reason: "invalid_configuration" };
  const abort = new AbortController();
  let started = false;
  let timer: number | NodeJS.Timeout | undefined;
  const deadline = new Promise<CompanionPushResult>(resolve => {
    timer = setTimeout(() => {
      abort.abort();
      resolve({ status: started ? "uncertain" : "failed", reason: "timeout" });
    }, timeout);
  });
  const deliver = async (): Promise<CompanionPushResult> => {
    let bearer: string;
    try {
      bearer = await providerToken(config, { APNS_TEAM_ID, APNS_KEY_ID, APNS_PRIVATE_KEY, APNS_BUNDLE_ID }, now);
    } catch {
      return { status: "failed", reason: "invalid_configuration" };
    }
    if (abort.signal.aborted) return { status: "failed", reason: "timeout" };
    const fetcher = options.fetch ?? fetch;
    const host = target.apnsEnvironment === "sandbox" ? "api.sandbox.push.apple.com" : "api.push.apple.com";
    const results: CompanionPushResult[] = [];
    let next = 0;
    const drain = async (): Promise<void> => {
      while (next < pending.length && !abort.signal.aborted) {
        const notification = pending[next++]!;
        try {
          started = true;
          const response = await fetcher(`https://${host}/3/device/${notification.token}`, {
            method: "POST",
            redirect: "manual",
            signal: abort.signal,
            headers: {
              authorization: `bearer ${bearer}`,
              "content-type": "application/json",
              "apns-id": crypto.randomUUID(),
              "apns-topic": notification.type === "liveactivity" ? `${APNS_BUNDLE_ID}.push-type.liveactivity` : APNS_BUNDLE_ID,
              "apns-push-type": notification.type,
              "apns-priority": notification.type === "alert" ? "10" : "5",
              "apns-expiration": "0",
            },
            body: notification.body,
          });
          // Provider bodies may contain private data; never read, retain or log them.
          void response.body?.cancel().catch(() => {});
          if (!apnsIdPattern.test(response.headers.get("apns-id") ?? "")) {
            results.push({ status: "uncertain", reason: "invalid_provider_response" });
          } else if (response.status === 200) {
            results.push({ status: "accepted" });
          } else if ([400, 403, 404, 405, 410, 413, 429, 500, 503].includes(response.status)) {
            results.push({ status: "failed", reason: response.status === 410 ? "token_expired" : "provider_rejected" });
          } else {
            results.push({ status: "uncertain", reason: "invalid_provider_response" });
          }
        } catch {
          results.push({ status: "uncertain", reason: "transport_error" });
        }
      }
    };
    // Stay below Workers' simultaneous open-connection limit, including other work.
    await Promise.all(Array.from({ length: Math.min(4, pending.length) }, drain));
    if (results.length !== pending.length) return { status: "uncertain", reason: "timeout" };
    if (results.every(result => result.status === "accepted")) return { status: "accepted" };
    if (results.every(result => result.status === "failed")) return results[0]!;
    if (results.length === 1) return results[0]!;
    return { status: "uncertain", reason: "partial_or_uncertain_delivery" };
  };
  try {
    return await Promise.race([deliver(), deadline]);
  } finally {
    clearTimeout(timer);
  }
}
