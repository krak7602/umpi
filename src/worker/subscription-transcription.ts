import { MAX_VOICE_NOTE_BYTES, MAX_VOICE_TRANSCRIPT_LENGTH, VoiceNoteError, type TelegramVoiceAudio } from "../shared/voice-note.js";

export interface SubscriptionTranscriptionAuth { access: string }
export const SUBSCRIPTION_TRANSCRIPTION_MODEL = "gpt-4o-mini-transcribe";
const ENDPOINT = "https://api.openai.com/v1/audio/transcriptions";
const DEADLINE_MS = 90_000;
const MAX_RESPONSE_BYTES = 128 * 1024;
const formats: Record<string, string> = {
  "voice-note.ogg": "audio/ogg", "voice-note.mp3": "audio/mpeg", "voice-note.m4a": "audio/mp4",
};

function credential(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 16_384 && !/\s/.test(value);
}

async function withAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let abort!: () => void;
  const interrupted = new Promise<never>((_, reject) => {
    abort = () => reject(new VoiceNoteError("transcription_failed"));
    signal.addEventListener("abort", abort, { once: true });
  });
  try { return await Promise.race([work, interrupted]); }
  finally { signal.removeEventListener("abort", abort); }
}

/** Keeps one audio buffer; Workers' fixed-length stream and Node's header preserve the upload length. */
function multipart(audio: TelegramVoiceAudio, boundary: string): { body: ReadableStream<Uint8Array>; byteLength: number } {
  const encoder = new TextEncoder();
  const prefix = encoder.encode(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${audio.filename}"\r\nContent-Type: ${audio.mimeType}\r\n\r\n`);
  const suffix = encoder.encode(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\n${SUBSCRIPTION_TRANSCRIPTION_MODEL}\r\n--${boundary}--\r\n`);
  const byteLength = prefix.byteLength + audio.bytes.byteLength + suffix.byteLength;
  let part = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (part === 0) controller.enqueue(prefix);
      else if (part === 1) controller.enqueue(audio.bytes);
      else if (part === 2) controller.enqueue(suffix);
      else controller.close();
      part++;
    },
  });
  const FixedLength = (globalThis as typeof globalThis & {
    FixedLengthStream?: new (length: number) => { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> };
  }).FixedLengthStream;
  return { body: FixedLength ? stream.pipeThrough(new FixedLength(byteLength)) : stream, byteLength };
}

async function responseText(response: Response, signal: AbortSignal): Promise<string> {
  const length = response.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_RESPONSE_BYTES)) throw new VoiceNoteError("transcription_failed");
  if (!response.body) throw new VoiceNoteError("transcription_failed");
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let size = 0, text = "", complete = false;
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    for (;;) {
      signal.throwIfAborted();
      const chunk = await withAbort(reader.read(), signal);
      signal.throwIfAborted();
      if (chunk.done) { complete = true; break; }
      size += chunk.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new VoiceNoteError("transcription_failed");
      text += decoder.decode(chunk.value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    signal.removeEventListener("abort", abort);
    if (!complete) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Subscription-only, single dispatch. Remote errors and credentials never leave this boundary. */
export async function transcribeSubscriptionAudio(
  audio: TelegramVoiceAudio, auth: () => Promise<SubscriptionTranscriptionAuth>, signal: AbortSignal,
): Promise<string> {
  if (!(audio.bytes instanceof Uint8Array) || audio.bytes.byteLength === 0) throw new VoiceNoteError("download_failed");
  if (audio.bytes.byteLength > MAX_VOICE_NOTE_BYTES) throw new VoiceNoteError("too_large");
  if (formats[audio.filename] !== audio.mimeType) throw new VoiceNoteError("transcription_failed");
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  const timer = setTimeout(abort, DEADLINE_MS);
  let response: Response | undefined;
  try {
    controller.signal.throwIfAborted();
    let authorization: SubscriptionTranscriptionAuth;
    try {
      authorization = await withAbort(auth(), controller.signal);
    } catch (error) {
      if (!controller.signal.aborted && error instanceof VoiceNoteError && error.code === "authorization_missing") throw error;
      throw new VoiceNoteError("transcription_failed");
    }
    if (!authorization || !credential(authorization.access)) throw new VoiceNoteError("authorization_missing");
    controller.signal.throwIfAborted();
    const boundary = `umpi-${crypto.randomUUID()}`;
    const upload = multipart(audio, boundary);
    response = await withAbort(fetch(ENDPOINT, {
      method: "POST", redirect: "manual", signal: controller.signal,
      headers: {
        Authorization: `Bearer ${authorization.access}`, "User-Agent": "umpi", Accept: "application/json",
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
        "Content-Length": String(upload.byteLength),
      },
      body: upload.body,
      ...{ duplex: "half" },
    }), controller.signal);
    if (response.status !== 200 || response.redirected) {
      throw new VoiceNoteError("transcription_failed");
    }
    const value: unknown = JSON.parse(await responseText(response, controller.signal));
    if (!value || typeof value !== "object" || Array.isArray(value) || !("text" in value) || typeof value.text !== "string" || value.text.includes("\0")) {
      throw new VoiceNoteError("transcription_failed");
    }
    if (value.text.length > MAX_VOICE_TRANSCRIPT_LENGTH) throw new VoiceNoteError("transcript_too_long");
    if (!value.text.trim()) throw new VoiceNoteError("speech_empty");
    return value.text.trim();
  } catch (error) {
    throw error instanceof VoiceNoteError ? error : new VoiceNoteError("transcription_failed");
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
    void response?.body?.cancel().catch(() => {});
  }
}
