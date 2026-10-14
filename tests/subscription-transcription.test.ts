import assert from "node:assert/strict";
import test from "node:test";
import { transcribeSubscriptionAudio } from "../src/worker/subscription-transcription.js";
import { MAX_VOICE_NOTE_BYTES, MAX_VOICE_TRANSCRIPT_LENGTH, VoiceNoteError, type TelegramVoiceAudio } from "../src/shared/voice-note.js";

const authorization = { access: "synthetic-access" };
function audio(): TelegramVoiceAudio {
  return { bytes: new Uint8Array([79, 103, 103, 83, 0, 1, 2, 3]), filename: "voice-note.ogg", mimeType: "audio/ogg" };
}
function failure(code: string) {
  return (error: unknown) => {
    assert.ok(error instanceof VoiceNoteError);
    assert.equal(error.code, code);
    assert.doesNotMatch(String(error), /synthetic-access|synthetic-account|private-provider|chatgpt\.com|api\.openai\.com/);
    return true;
  };
}


test("missing or malformed authorization fails before dispatch and never exposes the callback error", async t => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; throw new Error("must not dispatch"); });
  await assert.rejects(transcribeSubscriptionAudio(audio(), async () => {
    throw new Error("private-provider transient refresh failure synthetic-access");
  }, new AbortController().signal), failure("transcription_failed"));
  for (const auth of [
    async () => { throw new VoiceNoteError("authorization_missing"); },
    async () => ({ access: "" }),
    async () => ({ access: "bad\r\naccess" }),
  ]) await assert.rejects(transcribeSubscriptionAudio(audio(), auth, new AbortController().signal), failure("authorization_missing"));
  assert.equal(calls, 0);
});

test("HTTP failures and manual redirects are single failures, not retries or configuration results", async t => {
  for (const status of [301, 302, 307, 308, 401, 403, 429, 500]) {
    let calls = 0, cancelled = 0;
    const body = new ReadableStream<Uint8Array>({ cancel() { cancelled++; } });
    t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
      calls++; assert.equal(init.redirect, "manual");
      return new Response(body, { status, headers: { location: "https://untrusted.invalid/credential-target" } });
    });
    await assert.rejects(transcribeSubscriptionAudio(audio(), async () => authorization, new AbortController().signal), failure("transcription_failed"));
    assert.equal(calls, 1); assert.equal(cancelled, 1);
  }
});

test("an already-followed response is never accepted as a transcript", async t => {
  const response = Response.json({ text: "This result came from an untrusted redirect." });
  Object.defineProperty(response, "redirected", { value: true });
  t.mock.method(globalThis, "fetch", async () => response);
  await assert.rejects(transcribeSubscriptionAudio(audio(), async () => authorization, new AbortController().signal), failure("transcription_failed"));
});

test("remote exceptions, invalid JSON and invalid response schemas never leak provider details or become speech", async t => {
  for (const payload of ["private-provider synthetic-access", "null", "[]", '{"result":"not a text result"}', '{"text":7}', '{"text":"bad\\u0000text"}']) {
    t.mock.method(globalThis, "fetch", async () => new Response(payload));
    await assert.rejects(transcribeSubscriptionAudio(audio(), async () => authorization, new AbortController().signal), failure("transcription_failed"));
  }
  t.mock.method(globalThis, "fetch", async () => { throw new Error("private-provider synthetic-access synthetic-account"); });
  await assert.rejects(transcribeSubscriptionAudio(audio(), async () => authorization, new AbortController().signal), failure("transcription_failed"));
});

test("blank speech fails while exact 16,000-character text is retained and oversized text fails", async t => {
  for (const text of ["", " \n\t "]) {
    t.mock.method(globalThis, "fetch", async () => Response.json({ text }));
    await assert.rejects(transcribeSubscriptionAudio(audio(), async () => authorization, new AbortController().signal), failure("speech_empty"));
  }
  const transcript = "a".repeat(MAX_VOICE_TRANSCRIPT_LENGTH);
  t.mock.method(globalThis, "fetch", async () => Response.json({ text: transcript }));
  assert.equal(await transcribeSubscriptionAudio(audio(), async () => authorization, new AbortController().signal), transcript);
  t.mock.method(globalThis, "fetch", async () => Response.json({ text: transcript + "b" }));
  await assert.rejects(transcribeSubscriptionAudio(audio(), async () => authorization, new AbortController().signal), failure("transcript_too_long"));
});

test("announced and actual response size are bounded independently of content-length", async t => {
  let cancelled = 0;
  const announced = new ReadableStream<Uint8Array>({ cancel() { cancelled++; } }, { highWaterMark: 0 });
  t.mock.method(globalThis, "fetch", async () => new Response(announced, { headers: { "content-length": String(128 * 1024 + 1) } }));
  await assert.rejects(transcribeSubscriptionAudio(audio(), async () => authorization, new AbortController().signal), failure("transcription_failed"));
  assert.equal(cancelled, 1);
  for (const length of [undefined, "3"]) {
    const oversized = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(128 * 1024 + 1)); },
      cancel() { cancelled++; },
    });
    t.mock.method(globalThis, "fetch", async () => new Response(oversized, { headers: length ? { "content-length": length } : {} }));
    await assert.rejects(transcribeSubscriptionAudio(audio(), async () => authorization, new AbortController().signal), failure("transcription_failed"));
  }
  assert.equal(cancelled, 3);
});

test("malformed UTF-8 is rejected rather than turned into fabricated replacement speech", async t => {
  const prefix = new TextEncoder().encode('{"text":"');
  const suffix = new TextEncoder().encode('"}');
  t.mock.method(globalThis, "fetch", async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(prefix); controller.enqueue(new Uint8Array([0xff])); controller.enqueue(suffix); controller.close(); },
  })));
  await assert.rejects(transcribeSubscriptionAudio(audio(), async () => authorization, new AbortController().signal), failure("transcription_failed"));
});

test("empty, oversized and unsafe file metadata never dispatch or acquire credentials", async t => {
  let requests = 0, authCalls = 0;
  t.mock.method(globalThis, "fetch", async () => { requests++; throw new Error("must not dispatch"); });
  for (const [clip, code] of [
    [{ ...audio(), bytes: new Uint8Array(0) }, "download_failed"],
    [{ ...audio(), bytes: new Uint8Array(MAX_VOICE_NOTE_BYTES + 1) }, "too_large"],
    [{ ...audio(), filename: 'voice-note.ogg"\r\nInjected: value' }, "transcription_failed"],
    [{ ...audio(), mimeType: "application/json" }, "transcription_failed"],
  ] as const) await assert.rejects(transcribeSubscriptionAudio(clip, async () => { authCalls++; return authorization; }, new AbortController().signal), failure(code));
  assert.equal(requests, 0); assert.equal(authCalls, 0);
});

test("already-aborted work never dispatches or acquires authorization", async t => {
  let requests = 0, authCalls = 0;
  t.mock.method(globalThis, "fetch", async () => { requests++; throw new Error("must not dispatch"); });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(transcribeSubscriptionAudio(audio(), async () => { authCalls++; return authorization; }, controller.signal), failure("transcription_failed"));
  assert.equal(requests, 0); assert.equal(authCalls, 0);
});

test("caller cancellation aborts a stalled response and cancels its reader", async t => {
  let reading!: () => void;
  const entered = new Promise<void>(resolve => { reading = resolve; });
  let cancelled = 0, dispatchSignal: AbortSignal | undefined;
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    dispatchSignal = init.signal as AbortSignal;
    return new Response(new ReadableStream<Uint8Array>({ pull() { reading(); }, cancel() { cancelled++; } }, { highWaterMark: 0 }));
  });
  const controller = new AbortController();
  const pending = transcribeSubscriptionAudio(audio(), async () => authorization, controller.signal);
  await entered; controller.abort();
  await assert.rejects(pending, failure("transcription_failed"));
  assert.equal(dispatchSignal!.aborted, true); assert.equal(cancelled, 1);
});

test("network deadline aborts even a transport that never settles, without issuing another request", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let entered!: () => void;
  const dispatched = new Promise<void>(resolve => { entered = resolve; });
  let dispatchSignal: AbortSignal | undefined, calls = 0;
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    calls++; dispatchSignal = init.signal as AbortSignal; entered();
    return new Promise<Response>(() => {});
  });
  const pending = transcribeSubscriptionAudio(audio(), async () => authorization, new AbortController().signal);
  await dispatched; t.mock.timers.tick(90_000);
  await assert.rejects(pending, failure("transcription_failed"));
  assert.equal(dispatchSignal!.aborted, true); assert.equal(calls, 1);
});

test("a stalled authorization callback obeys the same deadline and cannot dispatch late", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let resolve!: (value: typeof authorization) => void, entered!: () => void;
  const called = new Promise<void>(yes => { entered = yes; });
  const auth = new Promise<typeof authorization>(yes => { resolve = yes; });
  let requests = 0;
  t.mock.method(globalThis, "fetch", async () => { requests++; throw new Error("must not dispatch"); });
  const pending = transcribeSubscriptionAudio(audio(), async () => { entered(); return auth; }, new AbortController().signal);
  await called; t.mock.timers.tick(90_000);
  await assert.rejects(pending, failure("transcription_failed"));
  resolve(authorization);
  await Promise.resolve();
  assert.equal(requests, 0);
});
