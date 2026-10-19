import { Buffer } from "node:buffer";
import { cleanEmailText } from "./mail-text.js";

export const GMAIL_SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"] as const;
export const MAIL_SYNC_MESSAGE_BATCH_LIMIT = 50;
export const MAIL_TRIAGE_THREAD_LIMIT = 50;
export const MAIL_CONTEXT_MESSAGE_LIMIT = 8;
/** Characters of the cleaned latest incoming body given to the model. */
export const MAIL_BODY_EXCERPT_LIMIT = 2_500;

export interface GmailCredentials { clientId: string; clientSecret: string; refreshToken: string }
export interface GmailMessageContext {
  id: string;
  sentAt: string;
  direction: "incoming" | "outgoing";
  from: string;
  subject: string;
  excerpt: string;
}
/** Gmail's inbox tab for the latest incoming message; "primary" when no category label is present. */
export type GmailCategory = "primary" | "updates" | "promotions" | "social" | "forums";
export interface GmailThreadSnapshot {
  id: string;
  versionKey: string;
  subject: string;
  sender: string;
  receivedAt: string;
  lastIncomingAt: string;
  lastOutgoingAt: string | null;
  unread: boolean;
  important: boolean;
  starred: boolean;
  category: GmailCategory;
  awaitingReply: boolean;
  webUrl: string;
  messages: GmailMessageContext[];
}
export interface GmailSyncContinuation {
  mode: "bootstrap" | "incremental";
  startHistoryId: string;
  resultHistoryId: string;
  pageToken: string | null;
  pendingMessageIds: string[];
}
export interface GmailSyncRequest {
  mode: "bootstrap" | "incremental";
  after: string;
  historyId?: string;
  continuation?: GmailSyncContinuation;
}
export interface GmailSyncResult {
  status: "complete" | "partial" | "unavailable" | "cursor_expired";
  checkedAt: string;
  historyId: string | null;
  continuation: GmailSyncContinuation | null;
  threads: GmailThreadSnapshot[];
  discovered: number;
  issues: string[];
}

const API = "https://gmail.googleapis.com/gmail/v1/users/me";
const decoder = new TextDecoder("utf-8", { fatal: false });

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Gmail data");
  return value as Record<string, unknown>;
}
function secret(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 16_384 && !/\s/.test(value);
}
function providerId(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new Error("Invalid Gmail identifier");
  return value;
}
function historyId(value: unknown): string {
  if (typeof value !== "string" || !/^\d{1,32}$/.test(value)) throw new Error("Invalid Gmail history cursor");
  return value;
}
function pageToken(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.length < 1 || value.length > 4_096 || /[\s\u0000-\u001f\u007f]/.test(value)) throw new Error("Invalid Gmail page token");
  return value;
}
function instant(value: unknown): string {
  if (typeof value !== "string" || !/^\d{1,16}$/.test(value)) throw new Error("Invalid Gmail message time");
  const milliseconds = Number(value);
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0 || milliseconds > 8.64e15) throw new Error("Invalid Gmail message time");
  return new Date(milliseconds).toISOString();
}
function clean(value: unknown, limit: number, fallback = ""): string {
  if (typeof value !== "string") return fallback;
  const result = value.replace(/[\s\u0000-\u001f\u007f]+/g, " ").trim();
  return result.slice(0, limit) || fallback;
}
export function parseGmailCredentials(value: unknown): GmailCredentials {
  const data = object(value);
  if (!secret(data.clientId) || !secret(data.clientSecret) || !secret(data.refreshToken)) throw new Error("Invalid Gmail credentials");
  return { clientId: data.clientId, clientSecret: data.clientSecret, refreshToken: data.refreshToken };
}

async function boundedJson(response: Response, maxBytes: number): Promise<unknown> {
  if (!response.body) throw new Error("Missing Gmail response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) { await reader.cancel(); throw new Error("Gmail response exceeded the read limit"); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(decoder.decode(bytes)) as unknown;
}

interface GmailClient {
  get(path: string, parameters?: URLSearchParams, maxBytes?: number): Promise<{ response: Response; value?: unknown }>;
}
async function client(credentials: GmailCredentials, fetcher: typeof fetch, signal: AbortSignal): Promise<GmailClient> {
  const tokenResponse = await fetcher("https://oauth2.googleapis.com/token", {
    method: "POST", redirect: "manual", signal,
    body: new URLSearchParams({ client_id: credentials.clientId, client_secret: credentials.clientSecret, refresh_token: credentials.refreshToken, grant_type: "refresh_token" }),
  });
  if (!tokenResponse.ok) throw new Error("Gmail authorization could not be refreshed");
  const token = object(await boundedJson(tokenResponse, 65_536));
  if (!secret(token.access_token)) throw new Error("Gmail authorization could not be refreshed");
  // Gmail's strictest read in this flow costs 10 quota units. Start at most 20
  // provider reads per second so concurrent hydration remains below 15,000 units/minute.
  const requestInterval = fetcher === globalThis.fetch ? 50 : 0;
  let nextRequestAt = 0, gate = Promise.resolve();
  async function waitForQuota(): Promise<void> {
    if (!requestInterval) return;
    const previous = gate, next = Promise.withResolvers<void>();
    gate = next.promise;
    await previous;
    const delay = Math.max(0, nextRequestAt - Date.now());
    if (delay) {
      const sleeper = Promise.withResolvers<void>();
      setTimeout(sleeper.resolve, delay);
      await sleeper.promise;
    }
    nextRequestAt = Date.now() + requestInterval;
    next.resolve();
  }
  return {
    async get(path, parameters = new URLSearchParams(), maxBytes = 524_288) {
      await waitForQuota();
      const url = new URL(`${API}${path}`);
      url.search = parameters.toString();
      const response = await fetcher(url, { method: "GET", redirect: "manual", signal, headers: { Authorization: `Bearer ${token.access_token}` } });
      if (!response.ok) return { response };
      try {
        return { response, value: await boundedJson(response, maxBytes) };
      } catch (error) {
        if (error instanceof Error && error.message === "Gmail response exceeded the read limit") {
          const kind = path.startsWith("/threads/") ? "thread metadata"
            : path.startsWith("/messages/") && parameters.get("format") === "full" ? "message body" : "provider";
          throw new Error(`Gmail ${kind} exceeded the bounded read limit`);
        }
        throw error;
      }
    },
  };
}

function headers(payload: unknown): Map<string, string> {
  const data = object(payload);
  if (!Array.isArray(data.headers)) throw new Error("Invalid Gmail headers");
  const result = new Map<string, string>();
  for (const item of data.headers) {
    const header = object(item);
    if (typeof header.name === "string" && typeof header.value === "string") result.set(header.name.toLowerCase(), clean(header.value, 1_000));
  }
  return result;
}
function labels(value: unknown): Set<string> {
  if (!Array.isArray(value) || value.some(label => typeof label !== "string" || label.length > 128)) throw new Error("Invalid Gmail labels");
  return new Set(value as string[]);
}
function decodeBody(value: unknown): string {
  if (typeof value !== "string" || value.length > 131_072 || !/^[A-Za-z0-9_-]*$/.test(value)) return "";
  try { return decoder.decode(Buffer.from(value, "base64url")); } catch { return ""; }
}
function bodyParts(payload: unknown, parts = { plain: [] as string[], html: [] as string[] }, depth = 0): { plain: string[]; html: string[] } {
  if (depth > 8) return parts;
  const data = object(payload), mime = typeof data.mimeType === "string" ? data.mimeType.toLowerCase() : "";
  const body = data.body === undefined ? {} : object(data.body);
  const direct = decodeBody(body.data);
  if (direct && (mime === "text/plain" || !mime)) parts.plain.push(direct);
  else if (direct && mime === "text/html") parts.html.push(direct);
  if (Array.isArray(data.parts)) for (const part of data.parts) bodyParts(part, parts, depth + 1);
  return parts;
}
/** Newlines are kept: they cost little and make receipts and alerts much easier to read. */
function bodyText(payload: unknown): string {
  const parts = bodyParts(payload);
  const text = cleanEmailText(parts.plain.join("\n"), parts.html.join("\n")).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, " ");
  return text.length > MAIL_BODY_EXCERPT_LIMIT ? `${text.slice(0, MAIL_BODY_EXCERPT_LIMIT)}…` : text;
}

interface Metadata {
  id: string;
  threadId: string;
  sentAt: string;
  labels: Set<string>;
  from: string;
  subject: string;
  excerpt: string;
}
function metadata(value: unknown): Metadata {
  const data = object(value), values = headers(data.payload);
  return {
    id: providerId(data.id), threadId: providerId(data.threadId), sentAt: instant(data.internalDate), labels: labels(data.labelIds),
    from: clean(values.get("from"), 500, "Unknown sender"), subject: clean(values.get("subject"), 500, "(no subject)"),
    excerpt: clean(data.snippet, 2_000),
  };
}
function category(labels: Set<string>): GmailCategory {
  for (const name of ["promotions", "social", "forums", "updates"] as const) if (labels.has(`CATEGORY_${name.toUpperCase()}`)) return name;
  return "primary";
}
function metadataQuery(): URLSearchParams {
  const query = new URLSearchParams({ format: "metadata" });
  for (const name of ["From", "Subject", "Date", "Message-ID"]) query.append("metadataHeaders", name);
  return query;
}
function threadMetadataQuery(): URLSearchParams {
  const query = metadataQuery();
  query.set("fields", "messages(id,threadId,internalDate,labelIds,snippet,payload(headers))");
  return query;
}
async function mapConcurrent<T, R>(values: readonly T[], limit: number, run: (value: T) => Promise<R>): Promise<R[]> {
  const result = new Array<R>(values.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (true) {
      const index = next++;
      if (index >= values.length) return;
      result[index] = await run(values[index]!);
    }
  }));
  return result;
}

const MAIL_PENDING_MESSAGE_LIMIT = 1_000;
interface CandidateBatch {
  ids: string[];
  historyId: string | null;
  continuation: GmailSyncContinuation | null;
  expired: boolean;
}
function savedContinuation(request: GmailSyncRequest): GmailSyncContinuation | undefined {
  if (!request.continuation) return;
  const value = object(request.continuation);
  if (value.mode !== request.mode) throw new Error("Invalid Gmail continuation mode");
  const startHistoryId = historyId(value.startHistoryId), resultHistoryId = historyId(value.resultHistoryId);
  if (request.mode === "incremental" && startHistoryId !== historyId(request.historyId)) throw new Error("Gmail continuation cursor changed");
  if (!Array.isArray(value.pendingMessageIds) || value.pendingMessageIds.length > MAIL_PENDING_MESSAGE_LIMIT) throw new Error("Invalid Gmail continuation queue");
  return {
    mode: request.mode, startHistoryId, resultHistoryId, pageToken: pageToken(value.pageToken),
    pendingMessageIds: value.pendingMessageIds.map(providerId),
  };
}
function candidateBatch(ids: string[], state: Omit<GmailSyncContinuation, "pendingMessageIds">): CandidateBatch {
  const unique = [...new Set(ids.map(providerId))];
  if (unique.length > MAIL_PENDING_MESSAGE_LIMIT) throw new Error("Gmail change page exceeded the safe queue");
  const selected = unique.slice(0, MAIL_SYNC_MESSAGE_BATCH_LIMIT), pendingMessageIds = unique.slice(MAIL_SYNC_MESSAGE_BATCH_LIMIT);
  const continuation = pendingMessageIds.length || state.pageToken ? { ...state, pendingMessageIds } : null;
  return { ids: selected, historyId: continuation ? null : state.resultHistoryId, continuation, expired: false };
}
async function candidateMessageIds(api: GmailClient, request: GmailSyncRequest): Promise<CandidateBatch> {
  const saved = savedContinuation(request);
  if (saved?.pendingMessageIds.length) {
    return candidateBatch(saved.pendingMessageIds, {
      mode: saved.mode, startHistoryId: saved.startHistoryId, resultHistoryId: saved.resultHistoryId, pageToken: saved.pageToken,
    });
  }
  if (request.mode === "bootstrap") {
    const cutoff = Date.parse(request.after);
    if (!Number.isFinite(cutoff)) throw new Error("Invalid Gmail bootstrap boundary");
    let startHistoryId = saved?.startHistoryId;
    if (!startHistoryId) {
      const profile = await api.get("/profile", undefined, 65_536);
      if (!profile.response.ok) throw new Error("Gmail profile is unavailable");
      startHistoryId = historyId(object(profile.value).historyId);
    }
    // Gmail's date query uses a provider timezone. Query one earlier date, then enforce the exact ISO boundary locally.
    const query = new URLSearchParams({ labelIds: "INBOX", maxResults: String(MAIL_SYNC_MESSAGE_BATCH_LIMIT),
      q: `after:${new Date(cutoff - 86_400_000).toISOString().slice(0, 10).replace(/-/g, "/")}` });
    if (saved?.pageToken) query.set("pageToken", saved.pageToken);
    const response = await api.get("/messages", query, 262_144);
    if (!response.response.ok) throw new Error("Gmail bootstrap is unavailable");
    const data = object(response.value);
    if (data.messages !== undefined && !Array.isArray(data.messages)) throw new Error("Invalid Gmail message list");
    const ids = (data.messages as unknown[] | undefined ?? []).map(value => providerId(object(value).id));
    return candidateBatch(ids, { mode: "bootstrap", startHistoryId, resultHistoryId: startHistoryId, pageToken: pageToken(data.nextPageToken) });
  }
  if (!request.historyId) throw new Error("Gmail incremental sync requires a cursor");
  const startHistoryId = saved?.startHistoryId ?? historyId(request.historyId);
  const query = new URLSearchParams({ startHistoryId, historyTypes: "messageAdded", maxResults: "25" });
  if (saved?.pageToken) query.set("pageToken", saved.pageToken);
  const response = await api.get("/history", query, 524_288);
  if (response.response.status === 404) return { ids: [], historyId: null, continuation: null, expired: true };
  if (!response.response.ok) throw new Error("Gmail history is unavailable");
  const data = object(response.value);
  if (data.history !== undefined && !Array.isArray(data.history)) throw new Error("Invalid Gmail history");
  const ids: string[] = [];
  for (const value of data.history as unknown[] | undefined ?? []) {
    const entry = object(value);
    if (entry.messagesAdded !== undefined && !Array.isArray(entry.messagesAdded)) throw new Error("Invalid Gmail history messages");
    for (const added of entry.messagesAdded as unknown[] | undefined ?? []) ids.push(providerId(object(object(added).message).id));
  }
  return candidateBatch(ids, { mode: "incremental", startHistoryId, resultHistoryId: historyId(data.historyId), pageToken: pageToken(data.nextPageToken) });
}

async function threadSnapshot(api: GmailClient, threadId: string, cutoff: number): Promise<GmailThreadSnapshot | undefined> {
  const query = threadMetadataQuery();
  const response = await api.get(`/threads/${encodeURIComponent(threadId)}`, query, 2_097_152);
  if (!response.response.ok) return;
  const data = object(response.value);
  if (!Array.isArray(data.messages)) throw new Error("Invalid Gmail thread");
  const all = (data.messages as unknown[]).map(metadata).sort((a, b) => a.sentAt.localeCompare(b.sentAt) || a.id.localeCompare(b.id));
  const incoming = all.filter(message => !message.labels.has("SENT"));
  const latestIncoming = incoming.at(-1);
  if (!latestIncoming || Date.parse(latestIncoming.sentAt) < cutoff) return;
  const outgoing = all.filter(message => message.labels.has("SENT"));
  const latestOutgoing = outgoing.at(-1);
  const selected = all.slice(-MAIL_CONTEXT_MESSAGE_LIMIT);
  const context = (message: Metadata) => ({ id: message.id, sentAt: message.sentAt,
    direction: message.labels.has("SENT") ? "outgoing" as const : "incoming" as const,
    from: message.from, subject: message.subject, excerpt: message.excerpt });
  const contexts = selected.map(context);
  const lastOutgoingAt = latestOutgoing?.sentAt ?? null;
  const awaitingReply = !lastOutgoingAt || lastOutgoingAt < latestIncoming.sentAt;
  const latestIndex = selected.findIndex(message => message.id === latestIncoming.id);
  if (awaitingReply && latestIndex >= 0) {
    try {
      const full = await api.get(`/messages/${encodeURIComponent(latestIncoming.id)}`, new URLSearchParams({ format: "full" }), 393_216);
      if (full.response.ok) {
        const value = object(full.value), parsed = metadata(value);
        contexts[latestIndex] = { ...context(parsed), excerpt: bodyText(value.payload) || parsed.excerpt };
      }
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "Gmail message body exceeded the bounded read limit") throw error;
    }
  }
  return {
    id: threadId,
    versionKey: `${latestIncoming.id}:${latestOutgoing?.id ?? "none"}`,
    subject: latestIncoming.subject,
    sender: latestIncoming.from,
    receivedAt: latestIncoming.sentAt,
    lastIncomingAt: latestIncoming.sentAt,
    lastOutgoingAt,
    unread: latestIncoming.labels.has("UNREAD"),
    important: latestIncoming.labels.has("IMPORTANT"),
    starred: latestIncoming.labels.has("STARRED"),
    category: category(latestIncoming.labels),
    awaitingReply,
    webUrl: `https://mail.google.com/mail/#all/${encodeURIComponent(threadId)}`,
    messages: contexts,
  };
}

/** One bounded mailbox pass. Durable continuation drains every provider page before the history cursor advances. */
export async function readGmailChanges(credentials: string | undefined, request: GmailSyncRequest, now = Date.now(), fetcher: typeof fetch = fetch): Promise<GmailSyncResult> {
  const result: GmailSyncResult = { status: "unavailable", checkedAt: new Date(now).toISOString(), historyId: null, continuation: null, threads: [], discovered: 0, issues: [] };
  const issue = (message: string) => { if (!result.issues.includes(message)) result.issues.push(message); };
  let auth: GmailCredentials;
  try { auth = parseGmailCredentials(JSON.parse(credentials ?? "null")); }
  catch { issue("Gmail authorization is missing or invalid."); return result; }
  const cutoff = Date.parse(request.after);
  if (!Number.isFinite(cutoff) || cutoff > now) { issue("Gmail bootstrap boundary is invalid."); return result; }
  const signal = AbortSignal.timeout(60_000);
  try {
    const api = await client(auth, fetcher, signal);
    const candidates = await candidateMessageIds(api, request);
    result.historyId = candidates.historyId;
    result.continuation = candidates.continuation;
    if (candidates.expired) { result.status = "cursor_expired"; issue("Gmail incremental history expired; explicit bounded re-bootstrap is required."); return result; }
    const metadataRows = await mapConcurrent(candidates.ids, 8, async id => {
      const response = await api.get(`/messages/${encodeURIComponent(id)}`, metadataQuery(), 131_072);
      return response.response.ok ? metadata(response.value) : undefined;
    });
    const newest = new Map<string, Metadata>();
    for (const item of metadataRows) {
      if (!item || (!item.labels.has("INBOX") && !item.labels.has("SENT"))) continue;
      const previous = newest.get(item.threadId);
      if (!previous || previous.sentAt < item.sentAt) newest.set(item.threadId, item);
    }
    const ranked = [...newest.values()].sort((a, b) => Number(b.labels.has("UNREAD")) - Number(a.labels.has("UNREAD"))
      || Number(b.labels.has("IMPORTANT")) - Number(a.labels.has("IMPORTANT")) || b.sentAt.localeCompare(a.sentAt));
    result.discovered = ranked.length;
    const snapshots = await mapConcurrent(ranked, 4, item => threadSnapshot(api, item.threadId, cutoff));
    result.threads = snapshots.filter((value): value is GmailThreadSnapshot => value !== undefined)
      .sort((a, b) => Number(b.unread) - Number(a.unread) || Number(b.important) - Number(a.important) || b.receivedAt.localeCompare(a.receivedAt));
    result.status = candidates.continuation ? "partial" : "complete";
    if (candidates.continuation) issue("Gmail scan has more bounded batches; durable progress will continue.");
    return result;
  } catch (error) {
    const safeDetail = error instanceof Error && /^(?:Gmail|Invalid Gmail|Missing Gmail)/.test(error.message) ? error.message : null;
    issue(safeDetail ? `${safeDetail}.` : "Gmail could not be read within the bounded sync attempt.");
    return result;
  }
}
