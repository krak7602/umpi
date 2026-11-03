import { InputError, record } from "../shared/protocol.js";
import type { Database, TelegramMarkup } from "./store.js";

/**
 * The owner's shared conversation as the app shows it: what the owner said in Telegram or the app, and what Umpi said
 * back or sent on its own. The Telegram and app surfaces share one Pi conversation; this log is the readable history of
 * it, written in the same transactions that admit owner messages and queue Umpi's messages. Telegram command panels
 * (menus, memory views) are Telegram's own interface and are not part of it.
 */
export type ChatSurface = "telegram" | "app";
export type ChatNotify = "telegram" | "app";
export interface ChatButton { label: string; data: string }
export interface ChatEntry {
  seq: number;
  id: string;
  at: string;
  role: "owner" | "umpi";
  surface: ChatSurface;
  /** For owner messages: how it was sent. For Umpi: a reply to the owner, or a message it started. */
  kind: "text" | "voice" | "image" | "file" | "reply" | "message";
  text: string;
  images?: number;
  file?: string;
  /** What an app attachment was, such as a video and its length. */
  media?: { kind: string; name?: string; seconds?: number; count?: number };
  operationId?: string;
  buttons?: ChatButton[][];
}
type NewEntry = Omit<ChatEntry, "seq" | "at">;

const MAX_PAGE = 100;
/** Telegram's own interface, not conversation. */
const PANEL = /^(?:[a-z]+-menu:|memory:overview:|memory:view:|control:)/;
/** Umpi's answers to something the owner just said; anything else Umpi sends is a message it started. */
const REPLY = /^(?:answer:|telegram-inbox-error:)/;

export function chatButtons(markup: TelegramMarkup | undefined): ChatButton[][] | undefined {
  const rows = (markup as { inline_keyboard?: { text: string; callback_data?: string }[][] } | undefined)?.inline_keyboard;
  const buttons = rows?.map(row => row.filter(button => typeof button.callback_data === "string").map(button => ({ label: button.text, data: button.callback_data! }))).filter(row => row.length);
  return buttons?.length ? buttons : undefined;
}

export class ChatLog {
  /** Called after an entry is added, outside any decision about it; the coordinator wakes sockets and push. */
  appended: ((entry: ChatEntry) => void) | undefined;

  constructor(private readonly db: Database, private readonly now = () => Date.now()) {
    db.all("CREATE TABLE IF NOT EXISTS umpi_chat (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, at INTEGER NOT NULL, data TEXT NOT NULL)");
    db.all("CREATE TABLE IF NOT EXISTS umpi_chat_push (seq INTEGER PRIMARY KEY, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0)");
    db.all("CREATE TABLE IF NOT EXISTS umpi_chat_settings (id TEXT PRIMARY KEY, data TEXT NOT NULL)");
  }

  settings(): { notify: ChatNotify; version: number } {
    const row = this.db.all<{ data: string }>("SELECT data FROM umpi_chat_settings WHERE id='settings'")[0];
    return row ? JSON.parse(row.data) as { notify: ChatNotify; version: number } : { notify: "telegram", version: 1 };
  }
  configure(value: unknown): { notify: ChatNotify; version: number } {
    const input = record(value);
    if (Object.keys(input).some(key => !["expectedVersion", "notify"].includes(key))) throw new InputError("Unknown chat setting");
    if (input.notify !== "telegram" && input.notify !== "app") throw new InputError("notify must be telegram or app");
    return this.db.transaction(() => {
      const current = this.settings();
      if (input.expectedVersion !== current.version) throw new InputError(`Chat settings changed; expected version ${current.version}`);
      const next = { notify: input.notify as ChatNotify, version: current.version + 1 };
      this.db.all("INSERT INTO umpi_chat_settings VALUES ('settings', ?) ON CONFLICT(id) DO UPDATE SET data=excluded.data", JSON.stringify(next));
      return next;
    });
  }

  private add(entry: NewEntry): ChatEntry | undefined {
    // Checked first: a conflicting insert would still use up a position.
    if (this.db.all("SELECT seq FROM umpi_chat WHERE id=?", entry.id).length) return undefined;
    const at = new Date(this.now()).toISOString();
    const inserted = this.db.all<{ seq: number }>("INSERT INTO umpi_chat (id, at, data) VALUES (?,?,?) ON CONFLICT(id) DO NOTHING RETURNING seq", entry.id, Date.parse(at), JSON.stringify(entry))[0];
    if (!inserted) return undefined;
    const full = { ...entry, seq: inserted.seq, at };
    this.appended?.(full);
    return full;
  }
  /** An owner message admitted to the shared conversation. */
  owner(operationId: string, text: string, surface: ChatSurface, kind: ChatEntry["kind"], extra: { images?: number; file?: string; media?: ChatEntry["media"] } = {}): void {
    this.add({ id: `owner:${operationId}`, role: "owner", surface, kind, text, operationId, ...extra });
  }
  /** Umpi's reply to an app message: shown and announced in the app only. */
  appReply(operationId: string, text: string): void {
    if (this.add({ id: `umpi:answer:${operationId}`, role: "umpi", surface: "app", kind: "reply", text, operationId })) this.queuePush(`umpi:answer:${operationId}`);
  }
  /**
   * A message queued for Telegram. Returns whether Telegram should deliver it silently because the app announces it.
   * Replies to the owner in Telegram stay normal there and are not pushed to the app.
   */
  telegram(groupId: string, text: string, markup?: TelegramMarkup, options?: { quiet: true }): { silent: boolean } {
    if (PANEL.test(groupId)) return { silent: false };
    const reply = REPLY.test(groupId);
    const buttons = chatButtons(markup);
    const entry = this.add({ id: `umpi:${groupId}`, role: "umpi", surface: "telegram", kind: reply ? "reply" : "message", text, ...(buttons ? { buttons } : {}) });
    // A quiet message already alerted the owner another way, such as a knock on the phone.
    if (reply || options?.quiet || this.settings().notify !== "app") return { silent: false };
    if (entry) this.queuePush(entry.id);
    return { silent: true };
  }
  /** A test alert for the app only, never Telegram, so the owner can see push work before switching to it. */
  testAlert(): ChatEntry {
    const entry = this.add({ id: `umpi:test-alert:${this.now()}`, role: "umpi", surface: "app", kind: "message", text: "Test alert from Umpi. If this arrived as a notification, alerts in this app work." })!;
    this.queuePush(entry.id);
    return entry;
  }
  private queuePush(id: string): void {
    const seq = this.db.all<{ seq: number }>("SELECT seq FROM umpi_chat WHERE id=?", id)[0]?.seq;
    if (seq !== undefined) this.db.all("INSERT INTO umpi_chat_push (seq, status) VALUES (?, 'pending') ON CONFLICT(seq) DO NOTHING", seq);
  }

  /** Replaces a message's buttons after one was pressed; an empty keyboard removes them. */
  setButtons(seq: number, markup: TelegramMarkup): void {
    const entry = this.entry(seq);
    if (!entry) return;
    const { seq: _seq, at: _at, buttons: _old, ...rest } = entry;
    const buttons = chatButtons(markup);
    this.db.all("UPDATE umpi_chat SET data=? WHERE seq=?", JSON.stringify({ ...rest, ...(buttons ? { buttons } : {}) }), seq);
    this.changed?.(this.latest());
  }
  /** Called when an existing entry changes, so open apps read it again. */
  changed: ((latest: number) => void) | undefined;

  entry(seq: number): ChatEntry | undefined {
    const row = this.db.all<{ seq: number; at: number; data: string }>("SELECT seq, at, data FROM umpi_chat WHERE seq=?", seq)[0];
    return row ? { ...JSON.parse(row.data) as NewEntry, seq: row.seq, at: new Date(row.at).toISOString() } : undefined;
  }
  /** Newest first before `before`, or oldest first after `after`; `latest` lets the app tell whether it is current. */
  page(query: { before?: number; after?: number; limit?: number } = {}): { entries: ChatEntry[]; latest: number; more: boolean } {
    const limit = Math.min(Math.max(Math.trunc(query.limit ?? 50), 1), MAX_PAGE);
    if (query.before !== undefined && query.after !== undefined) throw new InputError("Use before or after, not both");
    for (const value of [query.before, query.after]) if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) throw new InputError("Invalid chat position");
    const rows = query.after !== undefined
      ? this.db.all<{ seq: number; at: number; data: string }>("SELECT seq, at, data FROM umpi_chat WHERE seq>? ORDER BY seq LIMIT ?", query.after, limit + 1)
      : this.db.all<{ seq: number; at: number; data: string }>("SELECT seq, at, data FROM umpi_chat WHERE seq<? ORDER BY seq DESC LIMIT ?", query.before ?? Number.MAX_SAFE_INTEGER, limit + 1).reverse();
    const more = rows.length > limit;
    const kept = query.after !== undefined ? rows.slice(0, limit) : rows.slice(rows.length > limit ? 1 : 0);
    return { entries: kept.map(row => ({ ...JSON.parse(row.data) as NewEntry, seq: row.seq, at: new Date(row.at).toISOString() })), latest: this.latest(), more };
  }
  latest(): number { return this.db.all<{ seq: number }>("SELECT max(seq) AS seq FROM umpi_chat")[0]?.seq ?? 0; }

  /** The next message to announce on the phone. A send is tried at most three times; APNs acceptance is not delivery. */
  nextPush(): ChatEntry | undefined {
    const row = this.db.all<{ seq: number }>("SELECT seq FROM umpi_chat_push WHERE status='pending' ORDER BY seq LIMIT 1")[0];
    return row ? this.entry(row.seq) : undefined;
  }
  finishPush(seq: number, status: "accepted" | "failed" | "uncertain" | "unconfigured"): void {
    this.db.transaction(() => {
      const row = this.db.all<{ attempts: number }>("SELECT attempts FROM umpi_chat_push WHERE seq=?", seq)[0];
      if (!row) return;
      const attempts = row.attempts + 1;
      // Only a definite failure is tried again; an uncertain send may have arrived.
      const done = status !== "failed" || attempts >= 3;
      this.db.all("UPDATE umpi_chat_push SET status=?, attempts=? WHERE seq=?", done ? status : "pending", attempts, seq);
    });
  }
  status(): object {
    const pushes = this.db.all<{ status: string; n: number }>("SELECT status, count(*) AS n FROM umpi_chat_push GROUP BY status");
    return { ...this.settings(), entries: this.db.all<{ n: number }>("SELECT count(*) AS n FROM umpi_chat")[0]!.n, latest: this.latest(), pushes: Object.fromEntries(pushes.map(row => [row.status, row.n])) };
  }
}
