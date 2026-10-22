import { MAX_IMAGE_BYTES, MAX_VOICE_NOTE_BYTES, MAX_VOICE_NOTE_SECONDS, VoiceNoteError, type TelegramFile, type TelegramImage, type TelegramImageMessage, type TelegramVoiceAudio, type TelegramVoiceNote } from "../shared/voice-note.js";
import { record } from "../shared/protocol.js";
import { readJson, type TelegramConfig } from "./transport.js";

function fail(): never { throw new VoiceNoteError("download_failed"); }
function fileSize(value: unknown, maxBytes: number): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || Number(value) <= 0) fail();
  if (Number(value) > maxBytes) throw new VoiceNoteError("too_large");
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
async function downloadTelegramFile(file: TelegramFile, maxBytes: number, config: TelegramConfig, signal: AbortSignal, fetcher: typeof fetch): Promise<{ bytes: Uint8Array; path: string; contentType: string | null }> {
  let response: Response | undefined;
  try {
    signal.throwIfAborted();
    const declaredSize = fileSize(file.fileSize, maxBytes);
    const token = config.TELEGRAM_BOT_TOKEN;
    if (!token || !/^[A-Za-z0-9:_-]+$/.test(token)) fail();
    response = await fetcher(`https://api.telegram.org/bot${token}/getFile`, {
      method: "POST", redirect: "manual", signal, headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file_id: file.fileId }),
    });
    if (!response.ok || response.redirected) fail();
    const payload = record(await readJson(response, 16_384));
    if (payload.ok !== true) fail();
    const result = record(payload.result);
    if (result.file_id !== file.fileId || result.file_unique_id !== file.fileUniqueId) fail();
    const expectedSize = fileSize(result.file_size, maxBytes);
    if (declaredSize !== undefined && expectedSize !== undefined && declaredSize !== expectedSize) fail();
    const path = safePath(result.file_path);
    signal.throwIfAborted();
    response = await fetcher(`https://api.telegram.org/file/bot${token}/${path}`, { redirect: "manual", signal });
    if (!response.ok || response.redirected || !response.body) fail();
    const length = response.headers.get("content-length");
    const headerSize = length === null ? undefined : /^\d+$/.test(length) ? fileSize(Number(length), maxBytes) : fail();
    const sizes = [declaredSize, expectedSize, headerSize].filter((size): size is number => size !== undefined);
    if (sizes.some(size => size !== sizes[0])) fail();
    const capacity = sizes[0] ?? maxBytes;
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
        if (size + chunk.value.byteLength > maxBytes) throw new VoiceNoteError("too_large");
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
    return { bytes: bytes.subarray(0, size), path, contentType: response.headers.get("content-type") };
  } catch (error) {
    if (response?.body && !response.body.locked) await response.body.cancel().catch(() => undefined);
    if (signal.aborted) throw new VoiceNoteError("interrupted");
    if (error instanceof VoiceNoteError) throw error;
    throw new VoiceNoteError("download_failed");
  }
}

export async function downloadTelegramVoice(note: TelegramVoiceNote, config: TelegramConfig, signal: AbortSignal, fetcher: typeof fetch = fetch): Promise<TelegramVoiceAudio> {
  if (note.duration > MAX_VOICE_NOTE_SECONDS) throw new VoiceNoteError("too_long");
  const file = await downloadTelegramFile(note, MAX_VOICE_NOTE_BYTES, config, signal, fetcher);
  return { bytes: file.bytes, ...audioFormat(file.bytes, file.path, note.mimeType, file.contentType) };
}

/** The format comes from the bytes, not from Telegram's declared type. */
function imageType(bytes: Uint8Array): TelegramImage["mimeType"] | undefined {
  const starts = (offset: number, values: number[]) => values.every((value, index) => bytes[offset + index] === value);
  if (starts(0, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (starts(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (starts(0, [0x52, 0x49, 0x46, 0x46]) && starts(8, [0x57, 0x45, 0x42, 0x50])) return "image/webp";
  if (starts(0, [0x47, 0x49, 0x46, 0x38])) return "image/gif";
  return undefined;
}

/** Image download is read-only, so an interrupted attempt may be repeated. */
export async function downloadTelegramImage(image: TelegramImageMessage["image"], maxBytes: number, config: TelegramConfig, signal: AbortSignal, fetcher: typeof fetch = fetch): Promise<TelegramImage & { bytes: number }> {
  let file;
  try { file = await downloadTelegramFile(image, Math.min(maxBytes, MAX_IMAGE_BYTES), config, signal, fetcher); }
  catch (error) { throw new VoiceNoteError(error instanceof VoiceNoteError && error.code === "too_large" ? "image_too_large" : "image_download_failed"); }
  const mimeType = imageType(file.bytes);
  if (!mimeType) throw new VoiceNoteError("image_download_failed");
  const size = file.bytes.byteLength;
  let binary = "";
  for (let offset = 0; offset < size; offset += 0x8000) binary += String.fromCharCode(...file.bytes.subarray(offset, offset + 0x8000));
  file.bytes.fill(0);
  return { data: btoa(binary), mimeType, bytes: size };
}
