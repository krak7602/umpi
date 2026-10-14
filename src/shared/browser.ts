import { createHash } from "node:crypto";
import { parse as parseDomain } from "tldts";
import { boundedText, identifier, record } from "./protocol.js";

export const MAX_BROWSER_TIMEOUT_MS = 15 * 60_000;
export const MAX_BROWSER_PROMPT = 16_384;
export const MAX_BROWSER_OBSERVATION_BYTES = 65_536;
export const MAX_BROWSER_IMAGE_BYTES = 1_048_576;
export const MAX_BROWSER_SNAPSHOT_BYTES = 2 * 1024 * 1024;
export const MAX_BROWSER_OPERATIONS = 256;
export const MAX_BROWSER_SITES = 16;
export const BROWSER_REFRESH_MS = 6 * 60 * 60_000;
export const BROWSER_SNAPSHOT_MAX_AGE_MS = 30 * 24 * 60 * 60_000;
const SPECIAL_USE_BROWSER_SUFFIXES = ["arpa", "onion", "localhost", "local", "internal", "test", "invalid", "example"] as const;

export interface BrowserSitePolicy {
  siteId: string;
  title: string;
  origins: string[];
  cookieHosts: string[];
  cookieNames: string[];
  resourceHosts: string[];
  /** Requested first-party domain, including subdomains; exact cookie lists stay empty. */
  domain?: string;
  resources?: "public";
}
export interface BrowserSite extends BrowserSitePolicy { version: number; policyDigest: string }
export interface BrowserSiteScope { site: BrowserSite; startUrl: string }
export interface BrowserAssignment {
  taskId: string;
  runId: string;
  deadlineAt: string;
  sites: BrowserSiteScope[];
}
export interface BrowserSnapshotMetadata {
  snapshotId: string;
  siteId: string;
  policyDigest: string;
  keyId: string;
  capturedAt: string;
  expiresAt: string;
  bytes: number;
  digest: string;
}
export interface BrowserSnapshotPublicKey { keyId: string; publicKey: JsonWebKey }
/** Ciphertext only. AAD is the UTF-8 JSON encoding of these metadata fields in this order. */
export interface BrowserSnapshotEnvelope {
  version: 1;
  snapshotId: string;
  siteId: string;
  policyDigest: string;
  keyId: string;
  capturedAt: string;
  expiresAt: string;
  wrappedKey: string;
  nonce: string;
  ciphertext: string;
}
export interface BrowserCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  secure: boolean;
  httpOnly: boolean;
  sameSite?: "Strict" | "Lax" | "None";
  partitionKey?: string;
}
export interface BrowserAuthentication { version: 1; cookies: BrowserCookie[] }
export type BrowserAction =
  | { kind: "navigate"; siteId: string; url: string }
  | { kind: "observe"; siteId: string }
  | { kind: "screenshot"; siteId: string }
  | { kind: "click"; siteId: string; snapshotId: string; ref: string }
  | { kind: "fill"; siteId: string; snapshotId: string; ref: string; text: string }
  | { kind: "press"; siteId: string; snapshotId: string; ref: string; key: "Enter" | "Escape" | "Tab" | "ArrowDown" | "ArrowUp" };
export interface BrowserRequest { operationId: string; action: BrowserAction }
export interface BrowserObservation {
  siteId: string;
  snapshotId: string;
  url: string;
  title: string;
  tree: string;
}
export interface BrowserImage { siteId: string; url: string; mimeType: "image/png"; data: string }
export interface BrowserReceipt {
  operationId: string;
  status: "running" | "done" | "failed" | "uncertain";
  observation?: BrowserObservation;
  image?: BrowserImage;
  error?: string;
}
export interface BrowserStopped { stopped: boolean; uncertain: boolean }
export interface BrowserExecutorPoll {
  executorId: string;
  available: boolean;
  activeRunId: string | null;
  allSites?: boolean;
  sites: { siteId: string; policyDigest: string }[];
}
export interface BrowserExecutorPollResult {
  assignment: BrowserAssignment | null;
  requests: BrowserRequest[];
  cancel: boolean;
}
export type BrowserExecutorReport =
  | { kind: "ready"; executorId: string; taskId: string; runId: string }
  | { kind: "receipt"; executorId: string; taskId: string; runId: string; receipt: BrowserReceipt }
  | { kind: "stopped"; executorId: string; taskId: string; runId: string; stopped: boolean; uncertain: boolean; ownerConfirmedStopped?: boolean; issue?: string };

function fields(value: Record<string, unknown>, required: string[], optional: string[] = []): void {
  if (required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) throw new Error("Invalid browser protocol fields");
}
function texts(value: unknown, maximum: number, label: string): string[] {
  if (!Array.isArray(value) || value.length > maximum) throw new Error(`Invalid ${label}`);
  const result = value.map(item => boundedText(item, 256, label));
  if (new Set(result).size !== result.length) throw new Error(`Duplicate ${label}`);
  return result;
}
export function browserHost(value: string): string {
  const host = value.toLowerCase();
  if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(host) || host.length > 253 || host.includes("..")) throw new Error("Invalid browser host");
  return host;
}
export function browserPublicUrl(value: unknown): string {
  const url = new URL(boundedText(value, 4096, "browser URL")), parsed = parseDomain(url.hostname, { allowPrivateDomains: true });
  const specialUse = SPECIAL_USE_BROWSER_SUFFIXES.some(suffix => url.hostname === suffix || url.hostname.endsWith(`.${suffix}`));
  if (url.protocol !== "https:" || url.port || url.username || url.password || specialUse || !parsed.domain || !parsed.isIcann && !parsed.isPrivate || parsed.isIp) throw new Error("Browser URL must use public HTTPS DNS");
  return url.href;
}
function domainContains(host: string, domain: string): boolean { return host === domain || host.endsWith(`.${domain}`); }
export function browserUrl(value: unknown, origins: readonly string[], allowLoopback = false, domain?: string): string {
  const url = new URL(boundedText(value, 4096, "browser URL"));
  if (domain) {
    browserPublicUrl(url.href);
    if (!domainContains(url.hostname, domain)) throw new Error("Browser URL is outside its approved domain");
  } else {
    const loopback = allowLoopback && url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if ((!loopback && url.protocol !== "https:") || url.username || url.password || !origins.includes(url.origin)) throw new Error("Browser URL is outside its approved origins");
  }
  return url.href;
}
export function browserCookieAllowed(name: string, domain: string, site: BrowserSitePolicy): boolean {
  if (!site.domain) return site.cookieNames.includes(name) && site.cookieHosts.includes(domain);
  const host = domain.startsWith(".") ? domain.slice(1) : domain;
  try { if (browserHost(host) !== host) return false; } catch { return false; }
  return domainContains(host, site.domain) && name.length > 0 && name.length <= 256 && !/[\u0000-\u0020\u007f;,=]/.test(name);
}
export function requestedBrowserSite(value: unknown): BrowserSitePolicy {
  const url = new URL(browserPublicUrl(value)), domain = parseDomain(url.hostname, { allowPrivateDomains: true }).domain!;
  return { siteId: `web-${createHash("sha256").update(domain).digest("hex").slice(0, 32)}`, title: domain, origins: [`https://${domain}`], cookieHosts: [], cookieNames: [], resourceHosts: [], domain, resources: "public" };
}
export function browserDisplayUrl(value: string): string { const url = new URL(value); return url.origin + url.pathname; }
export function browserOperationPrefix(taskId: string, runId: string): string { return `browser:${taskId.length}:${taskId}:${runId.length}:${runId}:`; }
export function browserEnvelopeAad(value: Pick<BrowserSnapshotEnvelope, "snapshotId" | "siteId" | "policyDigest" | "keyId" | "capturedAt" | "expiresAt">): Uint8Array {
  return new TextEncoder().encode(JSON.stringify([value.snapshotId, value.siteId, value.policyDigest, value.keyId, value.capturedAt, value.expiresAt]));
}
export function parseBrowserSite(value: unknown, allowLoopback = false): BrowserSitePolicy {
  const input = record(value); fields(input, ["siteId", "title", "origins", "cookieHosts", "cookieNames", "resourceHosts"], ["domain", "resources"]);
  let domain: string | undefined;
  if (input.domain !== undefined) {
    domain = browserHost(boundedText(input.domain, 253, "browser domain"));
    browserPublicUrl(`https://${domain}`);
    const parsed = parseDomain(domain, { allowPrivateDomains: true });
    if (domain !== input.domain || parsed.domain !== domain || !parsed.isIcann && !parsed.isPrivate || parsed.isIp) throw new Error("Browser scope must use one registrable public domain");
  }
  if (input.resources !== undefined && input.resources !== "public") throw new Error("Invalid browser resource scope");
  const origins = texts(input.origins, 16, "browser origins");
  if (!origins.length) throw new Error("A browser site needs approved origins");
  for (const origin of origins) if (new URL(browserUrl(origin, origins, allowLoopback, domain)).origin !== origin) throw new Error("Browser origins must be canonical");
  const cookieHosts = texts(input.cookieHosts, 32, "cookie hosts");
  for (const host of cookieHosts) browserHost(host.startsWith(".") ? host.slice(1) : host);
  const cookieNames = texts(input.cookieNames, 128, "cookie names");
  if (cookieNames.some(name => !name || /[\u0000-\u0020\u007f;,=]/.test(name))) throw new Error("Invalid exact cookie names");
  const resourceHosts = texts(input.resourceHosts, 128, "resource hosts").map(browserHost);
  if (domain && (cookieHosts.length || cookieNames.length)) throw new Error("Requested domain scope cannot contain a second exact cookie scope");
  return { siteId: identifier(input.siteId, "browser site"), title: boundedText(input.title, 256, "site title"), origins, cookieHosts, cookieNames, resourceHosts, ...(domain ? { domain } : {}), ...(input.resources === "public" ? { resources: "public" as const } : {}) };
}
export function parseBrowserAssignment(value: unknown, allowLoopback = false): BrowserAssignment {
  const input = record(value); fields(input, ["taskId", "runId", "deadlineAt", "sites"]);
  const deadlineAt = boundedText(input.deadlineAt, 40, "browser deadline");
  if (!/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(deadlineAt) || !Number.isFinite(Date.parse(deadlineAt))) throw new Error("Invalid browser deadline");
  if (!Array.isArray(input.sites) || !input.sites.length || input.sites.length > MAX_BROWSER_SITES) throw new Error("Invalid browser task sites");
  const sites = input.sites.map(value => {
    const scope = record(value); fields(scope, ["site", "startUrl"]); const site = record(scope.site);
    fields(site, ["siteId", "title", "origins", "cookieHosts", "cookieNames", "resourceHosts", "version", "policyDigest"], ["domain", "resources"]);
    const { version, policyDigest, ...policy } = site;
    if (!Number.isSafeInteger(version) || Number(version) < 1 || typeof policyDigest !== "string" || !/^[a-f0-9]{64}$/.test(policyDigest)) throw new Error("Invalid browser site revision");
    const parsed = { ...parseBrowserSite(policy, allowLoopback), version: Number(version), policyDigest };
    return { site: parsed, startUrl: browserUrl(scope.startUrl, parsed.origins, allowLoopback, parsed.domain) };
  });
  if (new Set(sites.map(scope => scope.site.siteId)).size !== sites.length) throw new Error("Duplicate browser task sites");
  return { taskId: identifier(input.taskId, "browser task"), runId: identifier(input.runId, "browser run"), deadlineAt, sites };
}
export function parseBrowserRequest(value: unknown): BrowserRequest {
  const input = record(value); fields(input, ["operationId", "action"]);
  const operationId = boundedText(input.operationId, 512, "browser operation");
  if (!/^[A-Za-z0-9_.:-]+$/.test(operationId)) throw new Error("Invalid browser operation identity");
  const action = record(input.action), kind = action.kind, siteId = identifier(action.siteId, "browser site");
  if (kind === "navigate") { fields(action, ["kind", "siteId", "url"]); return { operationId, action: { kind, siteId, url: boundedText(action.url, 4096, "browser URL") } }; }
  if (kind === "observe" || kind === "screenshot") { fields(action, ["kind", "siteId"]); return { operationId, action: { kind, siteId } }; }
  if (kind !== "click" && kind !== "fill" && kind !== "press") throw new Error("Unknown browser action");
  fields(action, ["kind", "siteId", "snapshotId", "ref", ...(kind === "fill" ? ["text"] : kind === "press" ? ["key"] : [])]);
  const snapshotId = identifier(action.snapshotId, "browser observation"), ref = boundedText(action.ref, 32, "browser reference");
  if (!/^(?:f\d+)?e\d+$/.test(ref)) throw new Error("Invalid browser reference");
  if (kind === "click") return { operationId, action: { kind, siteId, snapshotId, ref } };
  if (kind === "fill") return { operationId, action: { kind, siteId, snapshotId, ref, text: boundedText(action.text, 8192, "browser input") } };
  const key = action.key;
  if (key !== "Enter" && key !== "Escape" && key !== "Tab" && key !== "ArrowDown" && key !== "ArrowUp") throw new Error("Unsupported browser key");
  return { operationId, action: { kind, siteId, snapshotId, ref, key } };
}

export function browserSitePolicyJson(site: BrowserSitePolicy): string {
  return JSON.stringify({ siteId: site.siteId, title: site.title, origins: site.origins, cookieHosts: site.cookieHosts, cookieNames: site.cookieNames, resourceHosts: site.resourceHosts, ...(site.domain ? { domain: site.domain } : {}), ...(site.resources ? { resources: site.resources } : {}) });
}

export function parseBrowserReceipt(value: unknown): BrowserReceipt {
  const input = record(value); fields(input, ["operationId", "status"], ["observation", "image", "error"]);
  const operationId = boundedText(input.operationId, 512, "browser operation");
  const status = input.status;
  if (!/^[A-Za-z0-9_.:-]+$/.test(operationId) || status !== "running" && status !== "done" && status !== "failed" && status !== "uncertain") throw new Error("Invalid browser operation receipt");
  const receipt: BrowserReceipt = { operationId, status };
  if (input.error !== undefined) receipt.error = boundedText(input.error, 1000, "browser issue");
  if (input.observation !== undefined) {
    const observation = record(input.observation); fields(observation, ["siteId", "snapshotId", "url", "title", "tree"]);
    if (typeof observation.tree !== "string" || observation.tree.length > MAX_BROWSER_OBSERVATION_BYTES) throw new Error("Invalid browser observation");
    const tree = observation.tree;
    if (new TextEncoder().encode(tree).length > MAX_BROWSER_OBSERVATION_BYTES) throw new Error("Browser observation exceeds its byte bound");
    const url = boundedText(observation.url, 4096, "browser location");
    if (browserDisplayUrl(url) !== url) throw new Error("Browser observation locations exclude queries and fragments");
    if (typeof observation.title !== "string" || observation.title.length > 1000) throw new Error("Invalid browser title");
    receipt.observation = { siteId: identifier(observation.siteId, "browser site"), snapshotId: identifier(observation.snapshotId, "browser observation"), url, title: observation.title, tree };
  }
  if (input.image !== undefined) {
    const image = record(input.image); fields(image, ["siteId", "url", "mimeType", "data"]);
    if (image.mimeType !== "image/png" || typeof image.data !== "string" || image.data.length > Math.ceil(MAX_BROWSER_IMAGE_BYTES / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(image.data) || image.data.length % 4) throw new Error("Invalid bounded browser image");
    const padding = image.data.endsWith("==") ? 2 : image.data.endsWith("=") ? 1 : 0;
    const finalValue = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/".indexOf(image.data[image.data.length - padding - 1]!);
    if (image.data.length / 4 * 3 - padding > MAX_BROWSER_IMAGE_BYTES || padding && (finalValue & (padding === 2 ? 15 : 3)) !== 0 || image.data.length < 12 || !atob(image.data.slice(0, 12)).startsWith("\u0089PNG\r\n\u001a\n")) throw new Error("Invalid bounded canonical PNG image");
    const url = boundedText(image.url, 4096, "browser location");
    if (browserDisplayUrl(url) !== url) throw new Error("Browser image locations exclude queries and fragments");
    receipt.image = { siteId: identifier(image.siteId, "browser site"), url, mimeType: "image/png", data: image.data };
  }
  if (receipt.status !== "done" && (receipt.observation || receipt.image) || receipt.observation && receipt.image) throw new Error("Invalid browser receipt outcome");
  return receipt;
}
