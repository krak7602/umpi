import { boundedText, identifier, InputError, timestamp } from "../shared/protocol.js";
import {
  MAX_IMAGE_BYTES, MAX_IMAGES_PER_MESSAGE, MAX_TELEGRAM_INBOX_PENDING, MAX_VOICE_NOTE_BYTES, MAX_VOICE_NOTE_SECONDS, MAX_VOICE_TRANSCRIPT_LENGTH,
  VoiceNoteError, type TelegramImage, type TelegramImageMessage, type TelegramInboxDelivery, type TelegramInboxInput, type TelegramVoiceAudio,
  type TelegramVoiceNote, type VoiceNoteFailureCode,
} from "../shared/voice-note.js";

/** Telegram sends album items as separate updates within about a second; the first waits this long for the rest. */
export const ALBUM_WAIT_MS = 2_000;
export const IMAGE_WITHOUT_CAPTION = "[Image without a caption]";
/** Text keeps retrying admission. An image stops after this many tries so it cannot hold up later messages. */
const MAX_IMAGE_DELIVERY_ATTEMPTS = 3;
import { StateError, type Database } from "./store.js";

export interface TelegramInboxOptions {
  db: Database;
  download(note: TelegramVoiceNote, signal: AbortSignal): Promise<TelegramVoiceAudio>;
  /** Downloads one image of at most `maxBytes`, base64-encoded. */
  downloadImage(image: TelegramImageMessage["image"], maxBytes: number, signal: AbortSignal): Promise<TelegramImage & { bytes: number }>;
  transcribe(audio: TelegramVoiceAudio, signal: AbortSignal): Promise<string>;
  deliver(input: TelegramInboxDelivery): Promise<string>;
  notify(id: string, text: string): void;
  wake(): Promise<void>;
  track(work: Promise<void>): void;
  foreground(): void;
}
type InboxState = "queued" | "downloading" | "transcribing" | "ready" | "delivering" | "delivered" | "failed" | "merged";
interface InboxEntry {
  input: TelegramInboxInput;
  status: InboxState;
  createdAt: string;
  updatedAt: string;
  due: number;
  transcript?: string;
  operationId?: string;
  attemptId?: string;
  dispatchedAt?: string;
  deadline?: number;
  deliveryAttempts: number;
  errorCode?: VoiceNoteFailureCode | "queue_full";
  issue?: string;
  /** Later images of the same album, delivered with this entry. */
  album?: TelegramImageMessage[];
  /** For an album image delivered with an earlier entry. */
  mergedInto?: string;
}
const pendingStates = "('queued','downloading','transcribing','ready','delivering')";
const terminal = ["delivered", "failed", "merged"];
const failures: Record<VoiceNoteFailureCode | "queue_full", string> = {
  too_long: "This voice note is longer than five minutes. Please send a shorter voice note or text.",
  too_large: "This voice note exceeds the 8 MiB audio limit. Please send a smaller voice note or text.",
  download_failed: "The voice-note audio could not be downloaded. No message was sent to the assistant. Please send text or a new voice note.",
  authorization_missing: "Voice-note transcription needs Umpi's independent ChatGPT subscription login. No message was sent to the assistant; please send text or check private authentication status.",
  transcription_failed: "The voice note could not be transcribed. No message was sent to the assistant. Please send text or a new voice note.",
  speech_empty: "No speech text was obtained from this voice note. No message was sent to the assistant. Please send text or a new voice note.",
  transcript_too_long: "The voice-note transcript exceeds the 16,000-character limit. No message was sent to the assistant. Please send a shorter voice note or text.",
  interrupted: "Voice-note transcription was interrupted and its result is unknown. It will not be repeated automatically. No transcript was sent to the assistant. Please send text or a new voice note.",
  image_too_large: "This image is larger than 1 MB. Please send it as a photo, not as a file, so Telegram compresses it.",
  image_download_failed: "The image could not be downloaded or is not a JPEG, PNG, WebP or GIF image. No message was sent to the assistant. Please send it again.",
  image_not_delivered: "The image message could not be confirmed as passed to the assistant. If no answer follows, please send it again.",
  unreadable: "I can't read this kind of message yet, so I did not act on it.",
  queue_full: "The Telegram message queue is full (eight pending messages). This message was not sent to the assistant. Please wait and send it again with a new message.",
};

function intent(input: TelegramInboxInput): TelegramInboxInput {
  identifier(input.id, "Telegram message ID");
  if (input.kind === "message") {
    return { kind: "message", id: input.id, text: boundedText(input.text, 16_384, "Telegram message"),
      ...(input.sentAt !== undefined ? { sentAt: timestamp(input.sentAt, "Telegram sent time") } : {}),
      ...(input.skipped !== undefined ? { skipped: boundedText(input.skipped, 64, "skipped attachment") } : {}) };
  }
  if (input.kind === "unreadable") {
    return { kind: "unreadable", id: input.id, attachment: boundedText(input.attachment, 64, "Telegram attachment"),
      ...(input.sentAt !== undefined ? { sentAt: timestamp(input.sentAt, "Telegram sent time") } : {}) };
  }
  if (input.kind === "image") {
    const image = input.image;
    if (!Number.isSafeInteger(input.messageId) || input.messageId < 1 ||
        (image.fileSize !== undefined && (!Number.isSafeInteger(image.fileSize) || image.fileSize <= 0))) throw new InputError("Invalid Telegram image metadata");
    return {
      kind: "image", id: input.id, messageId: input.messageId, sentAt: timestamp(input.sentAt, "Telegram sent time"),
      image: { fileId: boundedText(image.fileId, 1_024, "Telegram file ID"), fileUniqueId: boundedText(image.fileUniqueId, 1_024, "Telegram unique file ID"),
        ...(image.fileSize !== undefined ? { fileSize: image.fileSize } : {}), ...(image.mimeType !== undefined ? { mimeType: boundedText(image.mimeType, 128, "image MIME type") } : {}) },
      ...(input.caption !== undefined && input.caption !== "" ? { caption: boundedText(input.caption, 1_024, "image caption") } : {}),
      ...(input.mediaGroupId !== undefined ? { mediaGroupId: boundedText(input.mediaGroupId, 64, "Telegram album ID") } : {}),
    };
  }
  if (input.kind !== "voice" || !Number.isSafeInteger(input.messageId) || input.messageId < 1 ||
      !Number.isSafeInteger(input.duration) || input.duration < 0 ||
      (input.fileSize !== undefined && (!Number.isSafeInteger(input.fileSize) || input.fileSize <= 0))) {
    throw new InputError("Invalid Telegram voice-note metadata");
  }
  return {
    kind: "voice", id: input.id, messageId: input.messageId,
    fileId: boundedText(input.fileId, 1_024, "Telegram file ID"),
    fileUniqueId: boundedText(input.fileUniqueId, 1_024, "Telegram unique file ID"),
    duration: input.duration, sentAt: timestamp(input.sentAt, "Telegram sent time"),
    ...(input.fileSize !== undefined ? { fileSize: input.fileSize } : {}),
    ...(input.mimeType !== undefined ? { mimeType: boundedText(input.mimeType, 128, "voice MIME type") } : {}),
    ...(input.caption !== undefined && input.caption !== "" ? { caption: boundedText(input.caption, 1_024, "voice caption") } : {}),
  };
}

/** Durable admission order, with no automatic replay of a possibly performed transcription. */
export class TelegramInbox {
  private working?: { id: string; attemptId: string };
  constructor(private readonly options: TelegramInboxOptions) {
    options.db.all("CREATE TABLE IF NOT EXISTS umpi_telegram_inbox (id TEXT PRIMARY KEY, status TEXT NOT NULL, due INTEGER NOT NULL, data TEXT NOT NULL)");
    options.db.all("CREATE INDEX IF NOT EXISTS umpi_telegram_inbox_pending ON umpi_telegram_inbox(status, due)");
  }
  private entry(id: string): InboxEntry | undefined {
    const row = this.options.db.all<{ data: string }>("SELECT data FROM umpi_telegram_inbox WHERE id=?", id)[0];
    return row ? JSON.parse(row.data) as InboxEntry : undefined;
  }
  private write(entry: InboxEntry): void {
    this.options.db.all("INSERT INTO umpi_telegram_inbox VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,due=excluded.due,data=excluded.data",
      entry.input.id, entry.status, entry.due, JSON.stringify(entry));
  }
  private head(): InboxEntry | undefined {
    const row = this.options.db.all<{ data: string }>(`SELECT data FROM umpi_telegram_inbox WHERE status IN ${pendingStates} ORDER BY rowid LIMIT 1`)[0];
    return row ? JSON.parse(row.data) as InboxEntry : undefined;
  }
  private fail(entry: InboxEntry, code: VoiceNoteFailureCode | "queue_full"): void {
    const issue = code === "unreadable" && entry.input.kind === "unreadable"
      ? `I can't read ${entry.input.attachment} yet, so I did not act on this. Send a screenshot, or describe it in text.` : failures[code];
    this.options.db.transaction(() => {
      this.write({ ...entry, status: "failed", updatedAt: new Date().toISOString(), errorCode: code, issue });
      // The parent's deterministic outbox write uses this same synchronous Database transaction.
      this.options.notify(`telegram-inbox-error:${entry.input.id}`, issue);
    });
  }
  /** An album entry that has not started downloading and still has room for another image. */
  private albumHost(group: string): InboxEntry | undefined {
    const row = this.options.db.all<{ data: string }>("SELECT data FROM umpi_telegram_inbox WHERE status='queued' AND json_extract(data,'$.input.mediaGroupId')=? ORDER BY rowid LIMIT 1", group)[0];
    const host = row ? JSON.parse(row.data) as InboxEntry : undefined;
    return host && 1 + (host.album?.length ?? 0) < MAX_IMAGES_PER_MESSAGE ? host : undefined;
  }
  async accept(input: TelegramInboxInput): Promise<{ id: string; status: InboxState; operationId?: string }> {
    const accepted = intent(input);
    const existing = this.entry(accepted.id);
    if (existing) {
      if (JSON.stringify(existing.input) !== JSON.stringify(accepted)) throw new StateError(409, "Telegram message ID already contains different input");
      if (!terminal.includes(existing.status)) await this.options.wake();
      return { id: existing.input.id, status: existing.status, ...(existing.operationId ? { operationId: existing.operationId } : {}) };
    }
    // Persist lifecycle intent before the first application write, as normal Core admission does.
    await this.options.wake();
    let created = false;
    const entry = this.options.db.transaction(() => {
      const previous = this.entry(accepted.id);
      if (previous) {
        if (JSON.stringify(previous.input) !== JSON.stringify(accepted)) throw new StateError(409, "Telegram message ID already contains different input");
        return previous;
      }
      created = true;
      const now = new Date().toISOString();
      const next: InboxEntry = { input: accepted, status: accepted.kind === "message" ? "ready" : "queued",
        createdAt: now, updatedAt: now, due: Date.now() + (accepted.kind === "image" && accepted.mediaGroupId ? ALBUM_WAIT_MS : 0), deliveryAttempts: 0 };
      if (accepted.kind === "unreadable") { this.fail(next, "unreadable"); return this.entry(accepted.id)!; }
      if (accepted.kind === "image" && accepted.mediaGroupId && (accepted.image.fileSize ?? 0) <= MAX_IMAGE_BYTES) {
        const host = this.albumHost(accepted.mediaGroupId);
        if (host) {
          // The album is answered once. Each later image waits a little more for the rest.
          this.write({ ...host, album: [...host.album ?? [], accepted], due: Date.now() + ALBUM_WAIT_MS, updatedAt: now });
          this.write({ ...next, status: "merged", mergedInto: host.input.id });
          return this.entry(accepted.id)!;
        }
      }
      const count = this.options.db.all<{ count: number }>(`SELECT COUNT(*) AS count FROM umpi_telegram_inbox WHERE status IN ${pendingStates}`)[0]!.count;
      const code = accepted.kind === "voice" && accepted.duration > MAX_VOICE_NOTE_SECONDS ? "too_long"
        : accepted.kind === "voice" && (accepted.fileSize ?? 0) > MAX_VOICE_NOTE_BYTES ? "too_large"
          : accepted.kind === "image" && (accepted.image.fileSize ?? 0) > MAX_IMAGE_BYTES ? "image_too_large"
            : count >= MAX_TELEGRAM_INBOX_PENDING ? "queue_full" : undefined;
      if (code) { this.fail(next, code); return this.entry(accepted.id)!; }
      this.write(next);
      return next;
    });
    if (created) {
      this.options.foreground();
    }
    return { id: entry.input.id, status: entry.status, ...(entry.operationId ? { operationId: entry.operationId } : {}) };
  }
  /** Constructor is SQL-only; recovery callbacks run only after the parent has finished initialization. */
  recover(): void {
    const entries = this.options.db.all<{ data: string }>("SELECT data FROM umpi_telegram_inbox WHERE status IN ('downloading','transcribing','delivering') ORDER BY rowid");
    for (const row of entries) {
      const entry = JSON.parse(row.data) as InboxEntry;
      if (this.working?.id === entry.input.id && this.working.attemptId === entry.attemptId) continue;
      if (entry.status === "transcribing") this.fail(entry, "interrupted");
      else this.write({ ...entry, status: entry.status === "downloading" || entry.input.kind === "image" ? "queued" : "ready", due: Date.now(),
        updatedAt: new Date().toISOString(), ...(entry.status === "delivering" ? { issue: "Assistant admission was interrupted; recovery reuses the original message identity." } : {}) });
    }
  }
  hasPending(): boolean {
    return this.options.db.all(`SELECT id FROM umpi_telegram_inbox WHERE status IN ${pendingStates} LIMIT 1`).length > 0;
  }
  nextDue(): number | undefined {
    const entry = this.head();
    if (!entry) return undefined;
    return this.working?.id === entry.input.id ? entry.deadline : entry.due;
  }
  status(): object {
    const counts = this.options.db.all<{ status: string; count: number }>("SELECT status, COUNT(*) AS count FROM umpi_telegram_inbox GROUP BY status");
    const recent = this.options.db.all<{ data: string }>("SELECT data FROM umpi_telegram_inbox ORDER BY rowid DESC LIMIT 20");
    return { pending: counts.filter(row => !terminal.includes(row.status)).reduce((sum, row) => sum + row.count, 0),
      limit: MAX_TELEGRAM_INBOX_PENDING, counts, recent: recent.map(row => {
        const entry = JSON.parse(row.data) as InboxEntry;
        return { id: entry.input.id, source: entry.input.kind === "message" ? "text" : entry.input.kind, status: entry.status,
          sentAt: entry.input.sentAt ?? null, createdAt: entry.createdAt, updatedAt: entry.updatedAt,
          operationId: entry.operationId ?? null, dispatchedAt: entry.dispatchedAt ?? null,
          errorCode: entry.errorCode ?? null, issue: entry.issue ?? null, deliveryAttempts: entry.deliveryAttempts };
      }) };
  }
  async drive(): Promise<void> {
    if (this.working) return;
    this.recover();
    const entry = this.head();
    if (!entry || entry.due > Date.now()) return;
    const attemptId = crypto.randomUUID();
    this.working = { id: entry.input.id, attemptId };
    const next = { ...entry, attemptId, status: entry.status === "queued" ? "downloading" : "delivering" } as InboxEntry;
    next.updatedAt = new Date().toISOString();
    next.deadline = Date.now() + (next.status === "downloading" ? 60_000 : 30_000);
    this.write(next);
    // Start callbacks in a microtask after the durable claim, never inside the drive/admission transaction.
    const work = Promise.resolve().then(() => this.process(next)).finally(async () => {
      this.working = undefined;
      await this.options.wake();
    });
    this.options.track(work);
  }
  private current(entry: InboxEntry, status: InboxState): InboxEntry | undefined {
    const current = this.entry(entry.input.id);
    return current && current.attemptId === entry.attemptId && current.status === status ? current : undefined;
  }
  private async phase<T>(run: (signal: AbortSignal) => Promise<T>, milliseconds: number): Promise<T> {
    const controller = new AbortController();
    let reject!: () => void;
    const interrupted = new Promise<never>((_, fail) => { reject = () => fail(new Error("Inbox phase deadline")); });
    const timer = setTimeout(() => { controller.abort(); reject(); }, milliseconds);
    try { return await Promise.race([Promise.resolve().then(() => run(controller.signal)), interrupted]); }
    finally { clearTimeout(timer); }
  }
  /** Downloads an album's images in order within the combined limit; the ones that do not fit are counted, not sent. */
  private async downloadAlbum(entry: InboxEntry, signal: AbortSignal): Promise<{ images: TelegramImage[]; omitted: number }> {
    const images: TelegramImage[] = [];
    let used = 0, omitted = 0;
    for (const part of [entry.input as TelegramImageMessage, ...entry.album ?? []]) {
      const left = MAX_IMAGE_BYTES - used;
      if ((part.image.fileSize ?? 0) > left) { omitted++; continue; }
      try {
        const image = await this.options.downloadImage(part.image, left, signal);
        if (signal.aborted) throw new VoiceNoteError("image_download_failed");
        used += image.bytes; images.push({ data: image.data, mimeType: image.mimeType });
      } catch (error) {
        if (error instanceof VoiceNoteError && error.code === "image_too_large") { omitted++; continue; }
        throw error;
      }
    }
    if (!images.length) throw new VoiceNoteError("image_too_large");
    return { images, omitted };
  }
  private async process(entry: InboxEntry): Promise<void> {
    let media: { images: TelegramImage[]; omitted: number } | undefined;
    if (entry.status === "downloading" && entry.input.kind === "image") {
      try { media = await this.phase(signal => this.downloadAlbum(entry, signal), 60_000); }
      catch (error) {
        const current = this.current(entry, "downloading");
        if (current) this.fail(current, error instanceof VoiceNoteError && error.code === "image_too_large" ? "image_too_large" : "image_download_failed");
        return;
      }
      const current = this.current(entry, "downloading");
      if (!current) return;
      // Image bytes are not stored here; an interrupted delivery downloads them again.
      entry = { ...current, status: "ready", updatedAt: new Date().toISOString(), due: Date.now() };
      this.write(entry);
    }
    let audio: TelegramVoiceAudio | undefined;
    if (entry.status === "downloading" && entry.input.kind === "voice") {
      try {
        audio = await this.phase(async signal => {
          const result = await this.options.download(entry.input as TelegramVoiceNote, signal);
          if (signal.aborted) { result.bytes.fill(0); throw new VoiceNoteError("download_failed"); }
          return result;
        }, 60_000);
      } catch (error) {
        const current = this.current(entry, "downloading");
        if (current) this.fail(current, error instanceof VoiceNoteError ? error.code : "download_failed");
        return;
      }
      try {
        const downloading = this.current(entry, "downloading");
        if (!downloading) return;
        if (!(audio.bytes instanceof Uint8Array) || audio.bytes.byteLength === 0) { this.fail(downloading, "download_failed"); return; }
        if (audio.bytes.byteLength > MAX_VOICE_NOTE_BYTES) { this.fail(downloading, "too_large"); return; }
        const dispatched: InboxEntry = { ...downloading, status: "transcribing", dispatchedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(), deadline: Date.now() + 120_000 };
        this.write(dispatched);
        let transcript: string;
        try { transcript = await this.phase(signal => this.options.transcribe(audio!, signal), 120_000); }
        catch (error) {
          const current = this.current(entry, "transcribing");
          if (current) this.fail(current, error instanceof VoiceNoteError ? error.code : "transcription_failed");
          return;
        }
        const current = this.current(entry, "transcribing");
        if (!current) return;
        if (typeof transcript !== "string" || transcript.includes("\0")) { this.fail(current, "transcription_failed"); return; }
        if (transcript.length > MAX_VOICE_TRANSCRIPT_LENGTH) { this.fail(current, "transcript_too_long"); return; }
        if (!transcript.trim()) { this.fail(current, "speech_empty"); return; }
        // Actual text is committed before crossing the separately idempotent Core admission boundary.
        entry = { ...current, status: "ready", transcript: transcript.trim(), updatedAt: new Date().toISOString(), due: Date.now() };
        this.write(entry);
      } finally { audio.bytes.fill(0); audio = undefined; }
    }
    const current = this.entry(entry.input.id);
    if (!current || current.attemptId !== entry.attemptId || !["ready", "delivering"].includes(current.status)) return;
    if (current.input.kind === "image" && !media) { this.write({ ...current, status: "queued", due: Date.now(), updatedAt: new Date().toISOString() }); return; }
    const delivering: InboxEntry = { ...current, status: "delivering", deliveryAttempts: current.deliveryAttempts + 1,
      updatedAt: new Date().toISOString(), deadline: Date.now() + 30_000 };
    this.write(delivering);
    const input = delivering.input;
    const captions = input.kind === "image" ? [input, ...delivering.album ?? []].map(part => part.caption).filter((caption): caption is string => !!caption).join("\n\n") : "";
    const delivery: TelegramInboxDelivery = {
      id: input.id, text: input.kind === "message" ? input.text : input.kind === "voice" ? delivering.transcript! : captions || IMAGE_WITHOUT_CAPTION,
      source: input.kind === "message" ? "text" : input.kind === "voice" ? "voice" : "image", ...(input.sentAt !== undefined ? { sentAt: input.sentAt } : {}),
      ...(input.kind === "voice" && input.caption !== undefined ? { caption: input.caption } : {}),
      ...(input.kind === "message" && input.skipped !== undefined ? { skipped: input.skipped } : {}),
      ...(media ? { images: media.images, ...(media.omitted ? { omittedImages: media.omitted } : {}) } : {}),
    };
    try {
      const operationId = await this.phase(() => this.options.deliver(delivery), 30_000);
      if (typeof operationId !== "string" || !operationId.length || operationId.length > 256 || operationId.includes("\0")) throw new Error();
      const current = this.current(delivering, "delivering");
      if (current) this.write({ ...current, status: "delivered", operationId, updatedAt: new Date().toISOString(), issue: undefined });
    } catch {
      const current = this.current(delivering, "delivering");
      if (current?.input.kind === "image" && current.deliveryAttempts >= MAX_IMAGE_DELIVERY_ATTEMPTS) { this.fail(current, "image_not_delivered"); return; }
      if (current) this.write({ ...current, status: current.input.kind === "image" ? "queued" : "ready", updatedAt: new Date().toISOString(),
        due: Date.now() + Math.min(30_000, 1_000 * 2 ** Math.min(current.deliveryAttempts - 1, 5)),
        issue: "Assistant admission was not confirmed; the obtained input is retained and recovery reuses the original message identity." });
    }
  }
}
