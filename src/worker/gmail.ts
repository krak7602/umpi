import { Buffer } from "node:buffer";

export const GMAIL_SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"] as const;
export const MAIL_BOOTSTRAP_THREAD_LIMIT = 200;
export const MAIL_TRIAGE_THREAD_LIMIT = 50;
export const MAIL_CONTEXT_MESSAGE_LIMIT = 8;

export interface GmailCredentials { clientId: string; clientSecret: string; refreshToken: string }
export interface GmailMessageContext {
  id: string;
  sentAt: string;
  direction: "incoming" | "outgoing";
  from: string;
  subject: string;
  excerpt: string;
}
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
  awaitingReply: boolean;
  webUrl: string;
  messages: GmailMessageContext[];
}
export interface GmailSyncRequest {
  mode: "bootstrap" | "incremental";
  after: string;
  historyId?: string;
}
export interface GmailSyncResult {
  status: "complete" | "partial" | "unavailable" | "cursor_expired";
  checkedAt: string;
  historyId: string | null;
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
  return {
    async get(path, parameters = new URLSearchParams(), maxBytes = 524_288) {
      const url = new URL(`${API}${path}`);
      url.search = parameters.toString();
      const response = await fetcher(url, { method: "GET", redirect: "manual", signal, headers: { Authorization: `Bearer ${token.access_token}` } });
      if (!response.ok) return { response };
      return { response, value: await boundedJson(response, maxBytes) };
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
function stripHtml(value: string): string {
  return value.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ").replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ").replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">");
}
function bodyText(payload: unknown, depth = 0): string {
  if (depth > 8) return "";
  const data = object(payload), mime = typeof data.mimeType === "string" ? data.mimeType.toLowerCase() : "";
  const body = data.body === undefined ? {} : object(data.body);
  const direct = decodeBody(body.data);
  if (direct && (mime === "text/plain" || !mime)) return direct;
  if (Array.isArray(data.parts)) {
    const plain = data.parts.map(part => bodyText(part, depth + 1)).filter(Boolean);
    if (plain.length) return plain.join("\n");
  }
  return direct && mime === "text/html" ? stripHtml(direct) : "";
}

interface Metadata {
  id: string;
  threadId: string;
  sentAt: string;
  labels: Set<string>;
  from: string;
  subject: string;
}
function metadata(value: unknown): Metadata {
  const data = object(value), values = headers(data.payload);
  return {
    id: providerId(data.id), threadId: providerId(data.threadId), sentAt: instant(data.internalDate), labels: labels(data.labelIds),
    from: clean(values.get("from"), 500, "Unknown sender"), subject: clean(values.get("subject"), 500, "(no subject)"),
  };
}
function metadataQuery(): URLSearchParams {
  const query = new URLSearchParams({ format: "metadata" });
  for (const name of ["From", "Subject", "Date", "Message-ID"]) query.append("metadataHeaders", name);
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

async function candidateMessageIds(api: GmailClient, request: GmailSyncRequest): Promise<{ ids: string[]; current: string; partial: boolean; expired: boolean }> {
  const profile = await api.get("/profile", undefined, 65_536);
  if (!profile.response.ok) throw new Error("Gmail profile is unavailable");
  const current = historyId(object(profile.value).historyId);
  const ids: string[] = [];
  let partial = false;
  if (request.mode === "bootstrap") {
    const cutoff = Date.parse(request.after);
    if (!Number.isFinite(cutoff)) throw new Error("Invalid Gmail bootstrap boundary");
    let pageToken: string | undefined;
    for (let page = 0; page < 2 && ids.length < MAIL_BOOTSTRAP_THREAD_LIMIT; page++) {
      // Gmail's date query uses a provider timezone. Query one earlier date, then enforce the exact ISO boundary locally.
      const query = new URLSearchParams({ labelIds: "INBOX", maxResults: "100", q: `after:${new Date(cutoff - 86_400_000).toISOString().slice(0, 10).replace(/-/g, "/")}` });
      if (pageToken) query.set("pageToken", pageToken);
      const response = await api.get("/messages", query, 262_144);
      if (!response.response.ok) throw new Error("Gmail bootstrap is unavailable");
      const data = object(response.value);
      if (data.messages !== undefined && !Array.isArray(data.messages)) throw new Error("Invalid Gmail message list");
      for (const value of data.messages as unknown[] | undefined ?? []) {
        const message = object(value);
        ids.push(providerId(message.id));
        if (ids.length >= MAIL_BOOTSTRAP_THREAD_LIMIT) break;
      }
      pageToken = typeof data.nextPageToken === "string" && data.nextPageToken ? data.nextPageToken : undefined;
      if (!pageToken) break;
      if (page === 1 || ids.length >= MAIL_BOOTSTRAP_THREAD_LIMIT) partial = true;
    }
  } else {
    if (!request.historyId) throw new Error("Gmail incremental sync requires a cursor");
    let pageToken: string | undefined;
    for (let page = 0; page < 5 && ids.length < MAIL_BOOTSTRAP_THREAD_LIMIT; page++) {
      const query = new URLSearchParams({ startHistoryId: historyId(request.historyId), historyTypes: "messageAdded", maxResults: "100" });
      if (pageToken) query.set("pageToken", pageToken);
      const response = await api.get("/history", query, 524_288);
      if (response.response.status === 404) return { ids: [], current, partial: false, expired: true };
      if (!response.response.ok) throw new Error("Gmail history is unavailable");
      const data = object(response.value);
      if (data.history !== undefined && !Array.isArray(data.history)) throw new Error("Invalid Gmail history");
      for (const value of data.history as unknown[] | undefined ?? []) {
        const entry = object(value);
        if (entry.messagesAdded !== undefined && !Array.isArray(entry.messagesAdded)) throw new Error("Invalid Gmail history messages");
        for (const added of entry.messagesAdded as unknown[] | undefined ?? []) {
          const message = object(object(added).message);
          ids.push(providerId(message.id));
          if (ids.length >= MAIL_BOOTSTRAP_THREAD_LIMIT) break;
        }
        if (ids.length >= MAIL_BOOTSTRAP_THREAD_LIMIT) break;
      }
      pageToken = typeof data.nextPageToken === "string" && data.nextPageToken ? data.nextPageToken : undefined;
      if (!pageToken) break;
      if (page === 4 || ids.length >= MAIL_BOOTSTRAP_THREAD_LIMIT) partial = true;
    }
  }
  return { ids: [...new Set(ids)], current, partial, expired: false };
}

async function threadSnapshot(api: GmailClient, threadId: string, cutoff: number): Promise<GmailThreadSnapshot | undefined> {
  const query = metadataQuery();
  const response = await api.get(`/threads/${encodeURIComponent(threadId)}`, query, 524_288);
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
  const contexts = await mapConcurrent(selected, 4, async message => {
    const full = await api.get(`/messages/${encodeURIComponent(message.id)}`, new URLSearchParams({ format: "full" }), 393_216);
    if (!full.response.ok) return { id: message.id, sentAt: message.sentAt, direction: message.labels.has("SENT") ? "outgoing" as const : "incoming" as const, from: message.from, subject: message.subject, excerpt: "" };
    const value = object(full.value), parsed = metadata(value);
    return { id: parsed.id, sentAt: parsed.sentAt, direction: parsed.labels.has("SENT") ? "outgoing" as const : "incoming" as const,
      from: parsed.from, subject: parsed.subject, excerpt: clean(bodyText(value.payload), 2_000) };
  });
  const lastOutgoingAt = latestOutgoing?.sentAt ?? null;
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
    awaitingReply: !lastOutgoingAt || lastOutgoingAt < latestIncoming.sentAt,
    webUrl: `https://mail.google.com/mail/#all/${encodeURIComponent(threadId)}`,
    messages: contexts,
  };
}

/** One bounded mailbox pass. Provider errors and account identity never enter the result. */
export async function readGmailChanges(credentials: string | undefined, request: GmailSyncRequest, now = Date.now(), fetcher: typeof fetch = fetch): Promise<GmailSyncResult> {
  const result: GmailSyncResult = { status: "unavailable", checkedAt: new Date(now).toISOString(), historyId: null, threads: [], discovered: 0, issues: [] };
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
    result.historyId = candidates.current;
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
    if (ranked.length > MAIL_TRIAGE_THREAD_LIMIT) { ranked.length = MAIL_TRIAGE_THREAD_LIMIT; candidates.partial = true; }
    const snapshots = await mapConcurrent(ranked, 4, item => threadSnapshot(api, item.threadId, cutoff));
    result.threads = snapshots.filter((value): value is GmailThreadSnapshot => value !== undefined)
      .sort((a, b) => Number(b.unread) - Number(a.unread) || Number(b.important) - Number(a.important) || b.receivedAt.localeCompare(a.receivedAt));
    result.status = candidates.partial ? "partial" : "complete";
    if (candidates.partial) issue("Gmail changes exceeded the bounded scan; the newest candidate threads were retained.");
    return result;
  } catch {
    issue("Gmail could not be read within the bounded sync attempt.");
    return result;
  }
}
