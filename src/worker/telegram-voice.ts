import { MAX_VOICE_NOTE_BYTES, MAX_VOICE_NOTE_SECONDS, VoiceNoteError, type TelegramVoiceAudio, type TelegramVoiceNote } from "../shared/voice-note.js";
import { record } from "../shared/protocol.js";
import { readJson, type TelegramConfig } from "./transport.js";

function fail(): never { throw new VoiceNoteError("download_failed"); }
function fileSize(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || Number(value) <= 0) fail();
  if (Number(value) > MAX_VOICE_NOTE_BYTES) throw new VoiceNoteError("too_large");
  return value as number;
}

function safePath(value: unknown): string {
  if (typeof value !== "string" || value.length > 512 || !/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_.-]+)+$/.test(value) ||
      value.split("/").some(segment => segment === "." || segment === ".." || segment.length > 128)) fail();
  return value;
}

const formats = [
  { filename: "voice-note.ogg", mimeType: "audio/ogg", extensions: ["ogg", "oga", "opus"], mimes: ["audio/ogg", "application/ogg", "audio/opus"] },
  { filename: "voice-note.mp3", mimeType: "audio/mpeg", extensions: ["mp3"], mimes: ["audio/mpeg", "audio/mp3"] },
  { filename: "voice-note.m4a", mimeType: "audio/mp4", extensions: ["m4a", "mp4"], mimes: ["audio/mp4", "audio/m4a", "audio/x-m4a"] },
] as const;

function audioFormat(bytes: Uint8Array, path: string, declaredMime: string | undefined, contentType: string | null): { filename: string; mimeType: string } {
  const starts = (offset: number, text: string) => text.split("").every((char, index) => bytes[offset + index] === char.charCodeAt(0));
  const format = starts(0, "OggS") ? formats[0] :
    starts(0, "ID3") || (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0) ? formats[1] :
    bytes.length >= 12 && starts(4, "ftyp") ? formats[2] : undefined;
  if (!format) fail();
  const extension = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  if (!(format.extensions as readonly string[]).includes(extension)) fail();
  for (const mime of [declaredMime, contentType?.split(";", 1)[0]?.trim()]) {
    if (mime && mime.toLowerCase() !== "application/octet-stream" && !(format.mimes as readonly string[]).includes(mime.toLowerCase())) fail();
  }
  return { filename: format.filename, mimeType: format.mimeType };
}

/** Telegram credentials and response details never escape this fixed-host boundary. */
export async function downloadTelegramVoice(note: TelegramVoiceNote, config: TelegramConfig, signal: AbortSignal, fetcher: typeof fetch = fetch): Promise<TelegramVoiceAudio> {
  let response: Response | undefined;
  try {
    signal.throwIfAborted();
    if (note.duration > MAX_VOICE_NOTE_SECONDS) throw new VoiceNoteError("too_long");
    const declaredSize = fileSize(note.fileSize);
    const token = config.TELEGRAM_BOT_TOKEN;
    if (!token || !/^[A-Za-z0-9:_-]+$/.test(token)) fail();
    response = await fetcher(`https://api.telegram.org/bot${token}/getFile`, {
      method: "POST", redirect: "manual", signal, headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file_id: note.fileId }),
    });
    if (!response.ok || response.redirected) fail();
    const payload = record(await readJson(response, 16_384));
    if (payload.ok !== true) fail();
    const result = record(payload.result);
    if (result.file_id !== note.fileId || result.file_unique_id !== note.fileUniqueId) fail();
    const expectedSize = fileSize(result.file_size);
    if (declaredSize !== undefined && expectedSize !== undefined && declaredSize !== expectedSize) fail();
    const path = safePath(result.file_path);
    signal.throwIfAborted();
    response = await fetcher(`https://api.telegram.org/file/bot${token}/${path}`, { redirect: "manual", signal });
    if (!response.ok || response.redirected || !response.body) fail();
    const length = response.headers.get("content-length");
    const headerSize = length === null ? undefined : /^\d+$/.test(length) ? fileSize(Number(length)) : fail();
    const sizes = [declaredSize, expectedSize, headerSize].filter((size): size is number => size !== undefined);
    if (sizes.some(size => size !== sizes[0])) fail();
    const capacity = sizes[0] ?? MAX_VOICE_NOTE_BYTES;
    const bytes = new Uint8Array(capacity);
    const reader = response.body.getReader();
    const cancel = () => { void reader.cancel().catch(() => undefined); };
    signal.addEventListener("abort", cancel, { once: true });
    let size = 0;
    try {
      for (;;) {
        signal.throwIfAborted();
        const chunk = await reader.read();
        signal.throwIfAborted();
        if (chunk.done) break;
        if (size + chunk.value.byteLength > MAX_VOICE_NOTE_BYTES) throw new VoiceNoteError("too_large");
        if (size + chunk.value.byteLength > capacity) fail();
        bytes.set(chunk.value, size);
        size += chunk.value.byteLength;
      }
    } catch (error) {
      await reader.cancel().catch(() => undefined);
      throw error;
    } finally {
      signal.removeEventListener("abort", cancel);
      reader.releaseLock();
    }
    if (size === 0 || sizes.some(expected => expected !== size)) fail();
    const audio = bytes.subarray(0, size);
    return { bytes: audio, ...audioFormat(audio, path, note.mimeType, response.headers.get("content-type")) };
  } catch (error) {
    if (response?.body && !response.body.locked) await response.body.cancel().catch(() => undefined);
    if (signal.aborted) throw new VoiceNoteError("interrupted");
    if (error instanceof VoiceNoteError) throw error;
    throw new VoiceNoteError("download_failed");
  }
}
