import { InputError, boundedText, record } from "../shared/protocol.js";
import { StateError, type Delivery, type TelegramMarkup } from "./store.js";
import { companionRole } from "./companion-routes.js";
import type { TelegramTextMessage, TelegramVoiceNote } from "../shared/voice-note.js";

export interface TelegramConfig {
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  TELEGRAM_OWNER_ID?: string;
  TELEGRAM_CHAT_ID?: string;
}

export async function readJson(request: Pick<Request, "headers" | "body">, maxBytes = 131_072): Promise<unknown> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) throw new StateError(415, "Content-Type must be application/json");
  if (Number(request.headers.get("content-length")) > maxBytes) throw new StateError(413, "Request body too large");
  if (!request.body) throw new InputError("Expected JSON body");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) { await reader.cancel(); throw new StateError(413, "Request body too large"); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes)) as unknown; }
  catch { throw new InputError("Invalid JSON body"); }
}

export function telegramMissing(config: TelegramConfig): string[] {
  return (["TELEGRAM_BOT_TOKEN", "TELEGRAM_WEBHOOK_SECRET", "TELEGRAM_OWNER_ID", "TELEGRAM_CHAT_ID"] as const)
    .filter(key => !config[key]);
}

export async function secretEqual(actual: string, expected: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [left, right] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(actual)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  const a = new Uint8Array(left); const b = new Uint8Array(right);
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a[i]! ^ b[i]!;
  return difference === 0;
}

export type TelegramUpdate =
  | TelegramTextMessage | TelegramVoiceNote
  | { kind: "callback"; id: string; callbackId: string; messageId: number; data: string };

function requireTelegramOwner(sender: Record<string, unknown>, chat: Record<string, unknown>, config: TelegramConfig): void {
  if (sender.is_bot !== false || chat.type !== "private" ||
      !Number.isSafeInteger(sender.id) || Number(sender.id) <= 0 ||
      !Number.isSafeInteger(chat.id) || Number(chat.id) <= 0 ||
      String(sender.id) !== config.TELEGRAM_OWNER_ID || String(chat.id) !== config.TELEGRAM_CHAT_ID) {
    throw new StateError(403, "Telegram sender or chat is not authorized");
  }
}

function telegramSentAt(value: unknown): string {
  if (!Number.isSafeInteger(value) || Number(value) <= 0 || Number(value) > 253_402_300_799) {
    throw new InputError("Invalid Telegram message date");
  }
  return new Date(Number(value) * 1000).toISOString();
}

function telegramFileId(value: unknown): string {
  if (typeof value !== "string" || !/^[\x21-\x7e]{1,1024}$/.test(value)) throw new InputError("Invalid Telegram file ID");
  return value;
}

export function telegramUpdate(value: unknown, config: TelegramConfig): TelegramUpdate | undefined {
  const update = record(value);
  if (!Number.isSafeInteger(update.update_id) || Number(update.update_id) < 0) throw new InputError("Invalid Telegram update ID");
  const id = `tg:${update.update_id}`;
  if (update.callback_query !== undefined) {
    if (update.message !== undefined) throw new InputError("Ambiguous Telegram update");
    const callback = record(update.callback_query);
    const message = record(callback.message);
    requireTelegramOwner(record(callback.from), record(message.chat), config);
    if (!Number.isSafeInteger(message.date) || Number(message.date) <= 0 ||
        !Number.isSafeInteger(message.message_id) || Number(message.message_id) <= 0 ||
        callback.inline_message_id !== undefined) throw new InputError("Invalid Telegram callback message");
    const callbackId = boundedText(callback.id, 256, "Telegram callback ID");
    const data = boundedText(callback.data, 64, "Telegram callback data");
    if (new TextEncoder().encode(data).byteLength > 64) throw new InputError("Invalid Telegram callback data");
    return { kind: "callback", id, callbackId, messageId: message.message_id as number, data };
  }
  if (update.message === undefined) return undefined;
  const message = record(update.message);
  requireTelegramOwner(record(message.from), record(message.chat), config);
  if (message.voice !== undefined) {
    if (message.text !== undefined || message.audio !== undefined || message.document !== undefined ||
        message.video !== undefined || message.video_note !== undefined || message.photo !== undefined ||
        message.animation !== undefined || message.sticker !== undefined) throw new InputError("Ambiguous Telegram voice message");
    const voice = record(message.voice);
    if (!Number.isSafeInteger(message.message_id) || Number(message.message_id) <= 0 ||
        !Number.isSafeInteger(voice.duration) || Number(voice.duration) < 0 ||
        (voice.file_size !== undefined && (!Number.isSafeInteger(voice.file_size) || Number(voice.file_size) <= 0))) {
      throw new InputError("Invalid Telegram voice metadata");
    }
    const note: TelegramVoiceNote = {
      kind: "voice", id, messageId: message.message_id as number,
      fileId: telegramFileId(voice.file_id), fileUniqueId: telegramFileId(voice.file_unique_id),
      duration: voice.duration as number, sentAt: telegramSentAt(message.date),
    };
    if (voice.file_size !== undefined) note.fileSize = voice.file_size as number;
    if (voice.mime_type !== undefined) {
      if (typeof voice.mime_type !== "string" || !/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/.test(voice.mime_type) || voice.mime_type.length > 128) {
        throw new InputError("Invalid Telegram voice MIME type");
      }
      note.mimeType = voice.mime_type;
    }
    if (message.caption !== undefined && message.caption !== "") note.caption = boundedText(message.caption, 1024, "Telegram caption");
    return note;
  }
  if (message.audio !== undefined || message.document !== undefined || message.caption !== undefined ||
      message.video !== undefined || message.video_note !== undefined || message.photo !== undefined ||
      message.animation !== undefined || message.sticker !== undefined) throw new InputError("Ambiguous Telegram text message");
  const text: TelegramTextMessage = { kind: "message", id, text: boundedText(message.text, 16_384, "Telegram text") };
  if (message.date !== undefined) text.sentAt = telegramSentAt(message.date);
  return text;
}

export type SendResult = { status: "sent" | "failed" | "uncertain"; error?: string; messageId?: number };

/** Telegram sendMessage has no client idempotency key. A transport ambiguity is never retried. */
export async function sendTelegram(delivery: Delivery, config: TelegramConfig, fetcher: typeof fetch = fetch): Promise<SendResult> {
  if (!config.TELEGRAM_BOT_TOKEN || !config.TELEGRAM_CHAT_ID) return { status: "failed", error: "Configure TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID before sending" };
  let response: Response;
  try {
    response = await fetcher(`https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      // workerd rejects "error"; "manual" prevents forwarding private message data.
      redirect: "manual",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: config.TELEGRAM_CHAT_ID, text: delivery.text, link_preview_options: { is_disabled: true }, ...(delivery.replyMarkup ? { reply_markup: delivery.replyMarkup } : {}), ...(delivery.entities ? { entities: delivery.entities } : {}) }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch { return { status: "uncertain", error: "Telegram transport ended without a confirmed response; inspect the chat before resending" }; }
  let body: Record<string, unknown>;
  try { body = record(await readJson(response, 32_768)); }
  catch { return { status: "uncertain", error: "Telegram returned an unreadable response; delivery is unknown" }; }
  if (body.ok === false) return { status: "failed", error: `Telegram rejected sendMessage (HTTP ${response.status}, API ${typeof body.error_code === "number" ? body.error_code : "unknown"}); inspect bot/chat permissions and configuration` };
  if (body.ok !== true || !response.ok) return { status: "uncertain", error: "Telegram response did not confirm delivery" };
  const result = body.result;
  if (!result || typeof result !== "object" || !("message_id" in result) || !Number.isSafeInteger(result.message_id) || Number(result.message_id) <= 0) return { status: "uncertain", error: "Telegram success response omitted a valid message ID" };
  return { status: "sent", messageId: result.message_id as number };
}

/** UI acknowledgement/edit failures do not undo a committed action and are never retried here. */
async function telegramUi(method: string, payload: object, config: TelegramConfig, fetcher: typeof fetch): Promise<boolean> {
  if (!config.TELEGRAM_BOT_TOKEN) return false;
  try {
    const response = await fetcher(`https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}/${method}`, {
      method: "POST", redirect: "manual",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload), signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return false;
    return record(await readJson(response, 32_768)).ok === true;
  } catch { return false; }
}

export async function answerTelegramCallback(callbackId: string, text: string, config: TelegramConfig, fetcher: typeof fetch = fetch): Promise<boolean> {
  if (!callbackId || callbackId.length > 256 || callbackId.includes("\0")) return false;
  // Keep the UTF-16 bound conservative and never split a surrogate pair.
  let end = Math.min(text.length, 200);
  if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]!)) end--;
  return telegramUi("answerCallbackQuery", { callback_query_id: callbackId, text: text.slice(0, end) }, config, fetcher);
}

export async function editTelegramKeyboard(messageId: number, replyMarkup: TelegramMarkup, config: TelegramConfig, fetcher: typeof fetch = fetch): Promise<boolean> {
  if (!config.TELEGRAM_CHAT_ID || !Number.isSafeInteger(messageId) || messageId <= 0) return false;
  return telegramUi("editMessageReplyMarkup", { chat_id: config.TELEGRAM_CHAT_ID, message_id: messageId, reply_markup: replyMarkup }, config, fetcher);
}

/** The only admitted HTTP surfaces; control and executor privileges are deliberately disjoint. */
export async function authorize(request: Request, env: TelegramConfig & { UMPI_CONTROL_TOKEN?: string; UMPI_EXECUTOR_TOKEN?: string; UMPI_BROWSER_SYNC_TOKEN?: string }, deviceVerifier?: ((authorization: string | null) => unknown) | "forward-device"): Promise<void> {
  const path = new URL(request.url).pathname;
  if (request.headers.has("upgrade")) throw new StateError(404, "Not found");
  if (path === "/telegram/webhook" && request.method === "POST") {
    const missing = telegramMissing(env);
    if (missing.length) throw new StateError(503, `Telegram is not configured: ${missing.join(", ")}`);
    if (!await secretEqual(request.headers.get("x-telegram-bot-api-secret-token") ?? "", env.TELEGRAM_WEBHOOK_SECRET!)) throw new StateError(401, "Unauthorized");
    return;
  }
  const companion = companionRole(path, request.method);
  if (companion) {
    const url = new URL(request.url);
    if (url.protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) throw new StateError(400, "Companion connections require HTTPS");
    if (companion === "pair") return;
    if (companion === "device") {
      const authorization = request.headers.get("authorization");
      if (!authorization?.startsWith("Bearer ") || authorization.length > 256) throw new StateError(401, "Unauthorized device session");
      // An administrator or executor credential can never become a device credential.
      for (const token of [env.UMPI_CONTROL_TOKEN, env.UMPI_EXECUTOR_TOKEN, env.UMPI_BROWSER_SYNC_TOKEN]) {
        if (token && await secretEqual(authorization, `Bearer ${token}`)) throw new StateError(401, "Unauthorized device session");
      }
      if (deviceVerifier === "forward-device") return; // Only the outer Worker may defer the durable lookup.
      if (!deviceVerifier) throw new StateError(401, "Unauthorized device session");
      deviceVerifier(authorization); return;
    }
  }
  const executor = (path === "/api/executor/poll" || path === "/api/executor/complete" || /^\/api\/executor\/(?:coding|browser)\/(poll|report)$/.test(path)) && request.method === "POST";
  const memory = /^\/api\/core-context\/(?:reviews(?:\/[A-Za-z0-9_.:-]+(?:\/(?:approve|reject))?)?|history(?:\/\d+)?|restore)$/.test(path);
  const schedule = (path === "/api/schedule" && request.method === "GET")
    || (path === "/api/schedule/settings" && request.method === "PUT")
    || (/^\/api\/schedule\/(commitments|wakeups)$/.test(path) && ["GET", "POST"].includes(request.method))
    || (/^\/api\/schedule\/(commitments|wakeups)\/[A-Za-z0-9_.:-]+$/.test(path) && request.method === "PUT")
    || (/^\/api\/schedule\/wakeups\/[A-Za-z0-9_.:-]+\/cancel$/.test(path) && request.method === "POST");
  const planning = (path === "/api/planning" && request.method === "GET")
    || (path === "/api/planning/settings" && request.method === "PUT")
    || (path === "/api/planning/workspace" && ["GET", "PUT"].includes(request.method))
    || (path === "/api/planning/prepare" && request.method === "POST")
    || (/^\/api\/planning\/days\/\d{4}-\d{2}-\d{2}$/.test(path) && request.method === "GET")
    || (/^\/api\/planning\/briefs\/\d{4}-\d{2}-\d{2}$/.test(path) && request.method === "PUT")
    || (/^\/api\/planning\/days\/\d{4}-\d{2}-\d{2}\/cancel$/.test(path) && request.method === "POST")
    || (/^\/api\/planning\/writes\/[A-Za-z0-9_.:-]+$/.test(path) && request.method === "GET")
    || (/^\/api\/planning\/writes\/[A-Za-z0-9_.:-]+\/abandon$/.test(path) && request.method === "POST");
  const mail = (request.method === "GET" && (path === "/api/mail" || path === "/api/mail/items"))
    || (request.method === "PUT" && path === "/api/mail/settings")
    || (request.method === "POST" && (path === "/api/mail/check" || /^\/api\/mail\/items\/mail-[a-f0-9]{32}\/(?:handled|snooze)$/.test(path)));
  const brief = (request.method === "GET" && (path === "/api/brief" || path === "/api/situation" || path === "/api/alerts"))
    || (request.method === "PUT" && path === "/api/alerts/settings")
    || (request.method === "PUT" && path === "/api/brief/settings")
    || (request.method === "POST" && path === "/api/brief/run");
  const coding = (request.method === "GET" && (/^\/api\/coding(?:\/(?:sources|tasks))?$/.test(path) || /^\/api\/coding\/tasks\/[A-Za-z0-9_.:-]+(?:\/(?:patch|checkpoint))?$/.test(path)))
    || (request.method === "POST" && (path === "/api/coding/tasks" || /^\/api\/coding\/sources\/[A-Za-z0-9_.:-]+$/.test(path) || /^\/api\/coding\/tasks\/[A-Za-z0-9_.:-]+\/(?:approve|cancel|correct|cloud|reconcile)$/.test(path)))
    || (request.method === "GET" && /^\/api\/coding\/tasks\/[A-Za-z0-9_.:-]+\/runs(?:\/[A-Za-z0-9_.:-]+\/(?:patch|checkpoint))?$/.test(path));
  const browserSites = path === "/api/browser/sites" && request.method === "GET";
  const browserSync = ((["/api/browser/snapshot-key", "/api/browser/snapshot-requests"].includes(path) || /^\/api\/browser\/snapshot-requests\/[A-Za-z0-9_.:-]+$/.test(path)) && request.method === "GET") || (/^\/api\/browser\/snapshots\/[A-Za-z0-9_.:-]+$/.test(path) && request.method === "POST");
  const browser = (request.method === "GET" && (/^\/api\/browser(?:\/(?:sites|snapshots|tasks|settings))?$/.test(path) || /^\/api\/browser\/tasks\/[A-Za-z0-9_.:-]+(?:\/runs)?$/.test(path)))
    || (request.method === "PUT" && (path === "/api/browser/settings" || /^\/api\/browser\/sites\/[A-Za-z0-9_.:-]+$/.test(path)))
    || (request.method === "POST" && (path === "/api/browser/tasks" || /^\/api\/browser\/tasks\/[A-Za-z0-9_.:-]+\/(?:approve|cancel|correct|cloud|reconcile)$/.test(path)));
  const subagents = (request.method === "GET" && /^\/api\/subagents(?:\/[A-Za-z0-9_.:-]+)?$/.test(path))
    || (request.method === "POST" && /^\/api\/subagents\/[A-Za-z0-9_.:-]+\/cancel$/.test(path));
  if (browserSync || browserSites && env.UMPI_BROWSER_SYNC_TOKEN && await secretEqual(request.headers.get("authorization") ?? "", `Bearer ${env.UMPI_BROWSER_SYNC_TOKEN}`)) {
    const token = env.UMPI_BROWSER_SYNC_TOKEN;
    if (!token || token.length < 32 || [env.UMPI_CONTROL_TOKEN, env.UMPI_EXECUTOR_TOKEN].includes(token)) throw new StateError(503, "Configure a distinct UMPI_BROWSER_SYNC_TOKEN secret with at least 32 characters");
    if (!await secretEqual(request.headers.get("authorization") ?? "", `Bearer ${token}`)) throw new StateError(401, "Unauthorized browser synchronizer");
    return;
  }
  const control = subagents || browser || coding || mail || brief || planning || schedule || memory || companion === "control" || path === "/api/status" || path === "/api/messages" || path === "/api/jobs" || path === "/api/reminders" || path === "/api/auth" || path === "/api/core-context" || /^\/api\/messages\/[A-Za-z0-9_.:-]+$/.test(path) || /^\/api\/jobs\/[A-Za-z0-9_.:-]+\/(approve|cancel)$/.test(path);
  if (!executor && !control) throw new StateError(404, "Not found");
  if (!env.UMPI_CONTROL_TOKEN || !env.UMPI_EXECUTOR_TOKEN || env.UMPI_CONTROL_TOKEN.length < 32 || env.UMPI_EXECUTOR_TOKEN.length < 32 || env.UMPI_CONTROL_TOKEN === env.UMPI_EXECUTOR_TOKEN) {
    throw new StateError(503, "Configure distinct UMPI_CONTROL_TOKEN and UMPI_EXECUTOR_TOKEN secrets with at least 32 characters each");
  }
  if (env.UMPI_BROWSER_SYNC_TOKEN && (env.UMPI_BROWSER_SYNC_TOKEN.length < 32 || [env.UMPI_CONTROL_TOKEN, env.UMPI_EXECUTOR_TOKEN].includes(env.UMPI_BROWSER_SYNC_TOKEN))) throw new StateError(503, "Configure a distinct UMPI_BROWSER_SYNC_TOKEN; a synchronizer credential cannot inherit control or executor privileges");
  const token = executor ? env.UMPI_EXECUTOR_TOKEN : env.UMPI_CONTROL_TOKEN;
  if (!await secretEqual(request.headers.get("authorization") ?? "", `Bearer ${token}`)) throw new StateError(401, "Unauthorized");
}
