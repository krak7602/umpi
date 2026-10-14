import test from "node:test";
import assert from "node:assert/strict";
import { downloadTelegramVoice } from "../src/worker/telegram-voice.js";
import { MAX_VOICE_NOTE_BYTES, VoiceNoteError, type TelegramVoiceNote } from "../src/shared/voice-note.js";
import { telegramUpdate } from "../src/worker/transport.js";
import { StateError } from "../src/worker/store.js";

const config = { TELEGRAM_BOT_TOKEN: "test-only-token", TELEGRAM_OWNER_ID: "123", TELEGRAM_CHAT_ID: "123" };
const note: TelegramVoiceNote = { kind: "voice", id: "tg:1", messageId: 1, fileId: "file-id", fileUniqueId: "unique-id", duration: 12, mimeType: "audio/ogg", sentAt: "2026-10-14T12:00:00Z" };
// Container signatures exercise transport identity, not decoding or transcription.
const ogg = new Uint8Array([79, 103, 103, 83, 0, 2, 0, 0, 0, 0, 0, 0]);
function metadata(extra: Record<string, unknown> = {}): Response {
  return Response.json({ ok: true, result: { file_id: note.fileId, file_unique_id: note.fileUniqueId, file_path: "voice/file_1.oga", ...extra } });
}
function failure(code: string): (error: unknown) => boolean {
  return error => error instanceof VoiceNoteError && error.code === code && error.message === code;
}

test("fixed-host media requests preserve bytes and use a generic truthful OGG filename", async () => {
  const requests: Array<{ url: string; options: RequestInit | undefined }> = [];
  const fetcher: typeof fetch = async (input, options) => {
    requests.push({ url: String(input), options });
    return requests.length === 1 ? metadata({ file_size: ogg.length }) : new Response(ogg, { headers: { "content-type": "audio/ogg", "content-length": String(ogg.length) } });
  };
  const signal = new AbortController().signal;
  const result = await downloadTelegramVoice({ ...note, fileSize: ogg.length }, config, signal, fetcher);
  assert.deepEqual(result, { bytes: ogg, filename: "voice-note.ogg", mimeType: "audio/ogg" });
  assert.deepEqual(requests.map(request => request.url), ["https://api.telegram.org/bottest-only-token/getFile", "https://api.telegram.org/file/bottest-only-token/voice/file_1.oga"]);
  assert.equal(requests[0]!.options?.body, JSON.stringify({ file_id: note.fileId }));
  assert.ok(requests.every(request => request.options?.redirect === "manual" && request.options.signal === signal));
});

test("legitimate MP3 and M4A media are not relabelled as OGG", async () => {
  for (const fixture of [
    { bytes: new Uint8Array([73, 68, 51, 4, 0, 0, 0, 0, 0, 0]), extension: "mp3", mime: "audio/mpeg" },
    { bytes: new Uint8Array([0, 0, 0, 20, 102, 116, 121, 112, 77, 52, 65, 32]), extension: "m4a", mime: "audio/mp4" },
  ]) {
    let calls = 0;
    const fetcher: typeof fetch = async () => ++calls === 1 ? metadata({ file_path: `voice/file.${fixture.extension}` }) : new Response(fixture.bytes, { headers: { "content-type": fixture.mime } });
    assert.deepEqual(await downloadTelegramVoice({ ...note, mimeType: fixture.mime }, config, new AbortController().signal, fetcher),
      { bytes: fixture.bytes, filename: `voice-note.${fixture.extension}`, mimeType: fixture.mime });
  }
});

test("unauthorized voice updates cannot reach media fetching", async () => {
  let fetched = false;
  const fetcher: typeof fetch = async () => { fetched = true; return metadata(); };
  await assert.rejects(async () => {
    const parsed = telegramUpdate({ update_id: 1, message: { from: { id: 456, is_bot: false }, chat: { id: 123, type: "private" }, voice: null } }, config);
    if (parsed?.kind === "voice") await downloadTelegramVoice(parsed, config, new AbortController().signal, fetcher);
  }, (error: unknown) => error instanceof StateError && error.status === 403);
  assert.equal(fetched, false);
});

test("unsafe paths and mismatched Telegram identity never trigger file requests or leak response data", async () => {
  for (const extra of [
    { file_id: "other" }, { file_unique_id: "other" }, { file_size: 0 }, { file_size: "12" },
    ...["../private.ogg", "voice/../private.ogg", "voice/%2e%2e/file.ogg", "/voice/file.ogg", "https://private.invalid/secret.ogg", "voice/file.ogg?token=private", "voice/file.ogg#secret", "voice\\secret.ogg", `voice/${"x".repeat(129)}.ogg`].map(file_path => ({ file_path })),
  ]) {
    let calls = 0;
    const fetcher: typeof fetch = async () => { calls++; return metadata(extra); };
    await assert.rejects(downloadTelegramVoice(note, config, new AbortController().signal, fetcher), failure("download_failed"));
    assert.equal(calls, 1);
  }
  await assert.rejects(downloadTelegramVoice(note, config, new AbortController().signal, async () => Response.json({ ok: false, description: "private-token-and-url" })), failure("download_failed"));
});

test("neither getFile nor file download follows redirects", async () => {
  for (const redirectStage of [1, 2]) {
    let calls = 0;
    const fetcher: typeof fetch = async (_input, options) => {
      calls++;
      assert.equal(options?.redirect, "manual");
      return calls === redirectStage ? new Response("private response", { status: 302, headers: { location: "https://private.invalid/secret" } }) : metadata();
    };
    await assert.rejects(downloadTelegramVoice(note, config, new AbortController().signal, fetcher), failure("download_failed"));
    assert.equal(calls, redirectStage);
  }
});

test("actual byte bounds, empty audio, size disagreement and media mismatch fail deterministically", async () => {
  const cases: Array<{ bytes: Uint8Array<ArrayBuffer>; extra: Record<string, unknown>; headers: Record<string, string>; code: string }> = [
    { bytes: new Uint8Array(0), extra: {}, headers: {}, code: "download_failed" },
    { bytes: ogg, extra: { file_size: ogg.length + 1 }, headers: {}, code: "download_failed" },
    { bytes: ogg, extra: { file_size: ogg.length - 1 }, headers: {}, code: "download_failed" },
    { bytes: ogg, extra: {}, headers: { "content-length": "99" }, code: "download_failed" },
    { bytes: ogg, extra: {}, headers: { "content-type": "audio/mpeg" }, code: "download_failed" },
    { bytes: ogg, extra: { file_path: "voice/file.mp3" }, headers: {}, code: "download_failed" },
    { bytes: new Uint8Array([1, 2, 3, 4]), extra: {}, headers: {}, code: "download_failed" },
    { bytes: new Uint8Array(MAX_VOICE_NOTE_BYTES + 1), extra: {}, headers: {}, code: "too_large" },
  ];
  for (const fixture of cases) {
    let calls = 0;
    const fetcher: typeof fetch = async () => ++calls === 1 ? metadata(fixture.extra) : new Response(fixture.bytes, { headers: fixture.headers });
    await assert.rejects(downloadTelegramVoice(note, config, new AbortController().signal, fetcher), failure(fixture.code));
    assert.equal(calls, 2);
  }
  let calls = 0;
  await assert.rejects(downloadTelegramVoice({ ...note, fileSize: 20 }, config, new AbortController().signal, async () => { calls++; return metadata({ file_size: 21 }); }), failure("download_failed"));
  assert.equal(calls, 1);
});

test("declared limits and pre-aborted work make no request", async () => {
  let calls = 0;
  const fetcher: typeof fetch = async () => { calls++; return metadata(); };
  for (const [change, code] of [[{ duration: 301 }, "too_long"], [{ fileSize: MAX_VOICE_NOTE_BYTES + 1 }, "too_large"]] as const) {
    await assert.rejects(downloadTelegramVoice({ ...note, ...change }, config, new AbortController().signal, fetcher), failure(code));
  }
  const controller = new AbortController();
  controller.abort(new Error("private abort reason"));
  await assert.rejects(downloadTelegramVoice(note, config, controller.signal, fetcher), failure("interrupted"));
  assert.equal(calls, 0);
});

test("cancellation closes an in-flight audio stream without leaking its reason", async () => {
  const controller = new AbortController();
  let cancelled = false;
  let calls = 0;
  const fetcher: typeof fetch = async () => {
    if (++calls === 1) return metadata();
    return new Response(new ReadableStream<Uint8Array>({
      pull() { controller.abort(new Error("private cancellation reason")); },
      cancel() { cancelled = true; },
    }));
  };
  await assert.rejects(downloadTelegramVoice(note, config, controller.signal, fetcher), failure("interrupted"));
  assert.equal(cancelled, true);
  assert.equal(calls, 2);
});
