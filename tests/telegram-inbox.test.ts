import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { TelegramInbox, type TelegramInboxOptions } from "../src/worker/telegram-inbox.js";
import { Store, StateError, type Database } from "../src/worker/store.js";
import { MAX_TELEGRAM_INBOX_PENDING, MAX_VOICE_NOTE_BYTES, MAX_VOICE_TRANSCRIPT_LENGTH, VoiceNoteError, type TelegramInboxDelivery, type TelegramVoiceNote } from "../src/shared/voice-note.js";

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function voice(id = "voice-1", changes: Partial<TelegramVoiceNote> = {}): TelegramVoiceNote {
  return { kind: "voice", id, messageId: 1, fileId: "synthetic-file", fileUniqueId: "synthetic-unique", duration: 15,
    sentAt: "2026-03-01T23:59:58Z", ...changes };
}
function fixture(t: TestContext, changes: Partial<TelegramInboxOptions> = {}) {
  const sqlite = new DatabaseSync(":memory:");
  t.after(() => sqlite.close());
  let depth = 0;
  const db: Database = {
    all: <T extends object>(sql: string, ...values: (string | number | null)[]) => sqlite.prepare(sql).all(...values) as T[],
    transaction: <T>(run: () => T): T => {
      const name = `inbox_${depth++}`;
      sqlite.exec(`SAVEPOINT ${name}`);
      try { const value = run(); sqlite.exec(`RELEASE ${name}`); return value; }
      catch (error) { sqlite.exec(`ROLLBACK TO ${name}; RELEASE ${name}`); throw error; }
      finally { depth--; }
    },
  };
  const store = new Store(db);
  store.setSession("telegram", "telegram-session");
  const deliveries: TelegramInboxDelivery[] = [], work: Promise<void>[] = [];
  let downloadCalls = 0, transcriptionCalls = 0, foregroundCalls = 0, wakeCalls = 0;
  const options: TelegramInboxOptions = {
    db,
    download: async () => { downloadCalls++; return { bytes: new Uint8Array([79, 103, 103, 83, 9]), filename: "voice-note.ogg", mimeType: "audio/ogg" }; },
    downloadImage: async () => { throw new Error("no image expected"); },
    transcribe: async () => { transcriptionCalls++; return "Remind me tomorrow morning to review the draft."; },
    deliver: async input => {
      deliveries.push(input);
      return store.admit(input.id, input.text, "telegram", "telegram-session").id;
    },
    notify: (id, text) => { store.enqueue(id, "telegram", text); },
    track: task => { work.push(task); }, wake: async () => { wakeCalls++; }, foreground: () => { foregroundCalls++; },
    ...changes,
  };
  const inbox = new TelegramInbox(options);
  async function drain(target = inbox) {
    for (let round = 0; round < 30 && target.hasPending() && (target.nextDue() ?? Infinity) <= Date.now(); round++) {
      await target.drive();
      await Promise.all(work.splice(0));
    }
  }
  return { inbox, options, db, store, work, deliveries, drain,
    counts: () => ({ downloadCalls, transcriptionCalls, foregroundCalls, wakeCalls }) };
}

interface Diagnostic {
  pending: number; recent: { id: string; status: string; errorCode: string | null; operationId: string | null; dispatchedAt: string | null }[];
}

test("delayed voice keeps FIFO admission and original dates while native approval remains usable", async t => {
  const speech = deferred<string>(), entered = deferred<void>();
  const f = fixture(t, { transcribe: async () => { entered.resolve(); return speech.promise; } });
  await f.inbox.accept(voice("before-midnight", { caption: "Context: the draft is for the weekly review." }));
  await f.inbox.drive();
  await entered.promise;
  await f.inbox.accept({ kind: "message", id: "after-midnight", text: "Use the short version.", sentAt: "2026-03-02T00:00:03Z" });
  await f.inbox.drive();
  assert.equal(f.deliveries.length, 0);
  assert.equal(f.inbox.hasPending(), true);
  assert.ok(f.inbox.nextDue()! > Date.now());
  f.store.createJob({ jobId: "native-job", command: "printf review", cwd: "/workspace", timeoutMs: 10_000, createdAt: "2026-03-02T00:00:04Z" }, "telegram", "telegram-session");
  assert.equal(f.store.approveJob("native-job", 1).status, "queued");
  speech.resolve("Remind me tomorrow morning to review the draft.");
  await Promise.all(f.work.splice(0));
  await f.drain();
  assert.deepEqual(f.deliveries, [
    { id: "before-midnight", text: "Remind me tomorrow morning to review the draft.", source: "voice", sentAt: "2026-03-01T23:59:58Z", caption: "Context: the draft is for the weekly review." },
    { id: "after-midnight", text: "Use the short version.", source: "text", sentAt: "2026-03-02T00:00:03Z" },
  ]);
  assert.deepEqual(f.store.pendingOperations().map(op => op.requestId), ["before-midnight", "after-midnight"]);
  assert.equal(f.inbox.hasPending(), false);
  assert.equal(f.inbox.nextDue(), undefined);
});

test("webhook duplicates before, during and after speech processing do not repeat any admission", async t => {
  const speech = deferred<string>(), entered = deferred<void>();
  let calls = 0;
  const f = fixture(t, { transcribe: async () => { calls++; entered.resolve(); return speech.promise; } });
  const input = voice();
  assert.equal((await f.inbox.accept(input)).status, "queued");
  await f.inbox.accept({ ...input });
  await f.inbox.drive(); await entered.promise;
  await f.inbox.accept({ ...input }); await f.inbox.drive();
  speech.resolve("Please put the review on tomorrow's list.");
  await Promise.all(f.work.splice(0));
  const duplicate = await f.inbox.accept(input);
  await f.inbox.drive();
  assert.equal(duplicate.status, "delivered");
  assert.equal(duplicate.operationId, "message:telegram:voice-1");
  assert.equal(calls, 1);
  assert.equal(f.counts().downloadCalls, 1);
  assert.equal(f.counts().foregroundCalls, 1);
  assert.equal(f.deliveries.length, 1);
  assert.equal(f.store.pendingOperations().length, 1);
});

test("one immutable ID rejects changed voice metadata and changed text without replacing recorded intent", async t => {
  const f = fixture(t);
  const original = voice();
  await f.inbox.accept(original);
  for (const change of [
    { caption: "different context" }, { fileId: "different-file" }, { fileUniqueId: "different-unique" }, { duration: 16 },
    { fileSize: 123 }, { sentAt: "2026-03-02T00:00:00Z" }, { messageId: 2 },
  ]) await assert.rejects(f.inbox.accept({ ...original, ...change }), error => error instanceof StateError && error.status === 409);
  await assert.rejects(f.inbox.accept({ kind: "message", id: original.id, text: "Replace speech with text." }), StateError);
  await f.inbox.accept({ kind: "message", id: "text-id", text: "Original text." });
  await assert.rejects(f.inbox.accept({ kind: "message", id: "text-id", text: "Replacement text." }), StateError);
  await f.drain();
  assert.equal(f.counts().downloadCalls, 1);
  assert.deepEqual(f.deliveries.map(input => input.id), ["voice-1", "text-id"]);
  assert.equal(f.deliveries[1]!.text, "Original text.");
});

test("restart after provider dispatch preserves uncertainty, reports once and releases later text", async t => {
  const speech = deferred<string>(), entered = deferred<void>();
  let calls = 0;
  const f = fixture(t, { transcribe: async () => {
    calls++;
    const persisted = JSON.parse(f.db.all<{ data: string }>("SELECT data FROM umpi_telegram_inbox WHERE id=?", "voice-1")[0]!.data);
    assert.equal(persisted.status, "transcribing");
    assert.equal(typeof persisted.dispatchedAt, "string");
    assert.equal(persisted.transcript, undefined);
    entered.resolve(); return speech.promise;
  } });
  await f.inbox.accept(voice()); await f.inbox.drive(); await entered.promise;
  await f.inbox.accept({ kind: "message", id: "later", text: "Please continue with text." });
  const recovered = new TelegramInbox(f.options);
  assert.equal(f.store.deliveries("telegram-inbox-error:voice-1").length, 0);
  recovered.recover(); recovered.recover();
  assert.equal(f.store.deliveries("telegram-inbox-error:voice-1").length, 1);
  const record = (recovered.status() as Diagnostic).recent.find(row => row.id === "voice-1")!;
  assert.equal(record.status, "failed"); assert.equal(record.errorCode, "interrupted");
  assert.equal(typeof record.dispatchedAt, "string");
  speech.resolve("A late result cannot replace an interrupted record.");
  await Promise.all(f.work.splice(0));
  await f.drain(recovered);
  assert.equal(calls, 1);
  assert.deepEqual(f.deliveries.map(input => input.id), ["later"]);
  assert.equal(f.store.pendingOperations().length, 1);
  assert.equal((await recovered.accept(voice())).status, "failed");
});

test("obtained speech survives crash after Core admission and recovery uses one original operation", async t => {
  const receipt = deferred<string>(), admitted = deferred<void>();
  let first = true;
  const f = fixture(t, { deliver: async input => {
    f.deliveries.push(input);
    const persisted = JSON.parse(f.db.all<{ data: string }>("SELECT data FROM umpi_telegram_inbox WHERE id=?", input.id)[0]!.data);
    assert.equal(persisted.transcript, "Remind me tomorrow morning to review the draft.");
    const operation = f.store.admit(input.id, input.text, "telegram", "telegram-session");
    if (first) { first = false; admitted.resolve(); return receipt.promise; }
    return operation.id;
  } });
  await f.inbox.accept(voice("voice-1", { caption: "Keep this caption as owner context." }));
  await f.inbox.drive(); await admitted.promise;
  const recovered = new TelegramInbox(f.options); recovered.recover();
  const oldWork = f.work.splice(0);
  await f.drain(recovered);
  receipt.resolve("message:telegram:voice-1"); await Promise.all(oldWork);
  assert.equal(f.counts().transcriptionCalls, 1);
  assert.equal(f.counts().downloadCalls, 1);
  assert.equal(f.store.pendingOperations().length, 1);
  assert.deepEqual(f.deliveries[0], f.deliveries[1]);
  assert.equal((await recovered.accept(voice("voice-1", { caption: "Keep this caption as owner context." }))).operationId, "message:telegram:voice-1");
  assert.equal(recovered.hasPending(), false);
});

test("restart during download can redownload safely without dispatching stale audio", async t => {
  const audio = deferred<{ bytes: Uint8Array; filename: string; mimeType: string }>(), entered = deferred<void>();
  let calls = 0;
  const stale = new Uint8Array([79, 103, 103, 83]);
  const f = fixture(t, { download: async () => {
    if (++calls === 1) { entered.resolve(); return audio.promise; }
    return { bytes: new Uint8Array([79, 103, 103, 83]), filename: "voice-note.ogg", mimeType: "audio/ogg" };
  } });
  await f.inbox.accept(voice()); await f.inbox.drive(); await entered.promise;
  const recovered = new TelegramInbox(f.options); recovered.recover();
  audio.resolve({ bytes: stale, filename: "voice-note.ogg", mimeType: "audio/ogg" });
  await Promise.all(f.work.splice(0)); await f.drain(recovered);
  assert.equal(calls, 2);
  assert.equal(f.counts().transcriptionCalls, 1);
  assert.deepEqual(Array.from(stale), [0, 0, 0, 0]);
  assert.equal(f.store.pendingOperations().length, 1);
});

test("duration and announced size fail durably before download and do not strand later messages", async t => {
  const f = fixture(t);
  await f.inbox.accept(voice("long", { duration: 301 }));
  await f.inbox.accept(voice("large", { fileSize: MAX_VOICE_NOTE_BYTES + 1 }));
  await f.inbox.accept({ kind: "message", id: "next", text: "Use text instead." });
  await f.drain();
  assert.equal(f.counts().downloadCalls, 0); assert.equal(f.counts().transcriptionCalls, 0);
  assert.deepEqual(f.deliveries.map(input => input.id), ["next"]);
  const status = f.inbox.status() as Diagnostic;
  assert.equal(status.recent.find(row => row.id === "long")!.errorCode, "too_long");
  assert.equal(status.recent.find(row => row.id === "large")!.errorCode, "too_large");
  assert.equal(f.store.deliveries("telegram-inbox-error:long").length, 1);
  assert.equal(f.store.deliveries("telegram-inbox-error:large").length, 1);
  assert.equal((await f.inbox.accept(voice("long", { duration: 301 }))).status, "failed");
  assert.equal(f.store.deliveries("telegram-inbox-error:long").length, 1);
});

test("actual empty or oversized audio never reaches transcription or Pi and its buffer is cleared", async t => {
  for (const length of [0, MAX_VOICE_NOTE_BYTES + 1]) {
    const bytes = new Uint8Array(length); bytes.fill(17);
    const f = fixture(t, { download: async () => ({ bytes, filename: "voice-note.ogg", mimeType: "audio/ogg" }) });
    await f.inbox.accept(voice());
    await f.inbox.accept({ kind: "message", id: "next", text: "Continue with text." });
    await f.drain();
    assert.equal(f.counts().transcriptionCalls, 0);
    assert.deepEqual(f.deliveries.map(input => input.id), ["next"]);
    assert.equal((f.inbox.status() as Diagnostic).recent.find(row => row.id === "voice-1")!.errorCode, length ? "too_large" : "download_failed");
    assert.equal(bytes.some(byte => byte !== 0), false);
  }
});

test("provider failure, blank speech and oversized text are readable failures, never Pi inputs", async t => {
  for (const [result, code] of [[new Error("synthetic-private-provider-details"), "transcription_failed"],
    [new VoiceNoteError("authorization_missing"), "authorization_missing"], [" \n\t ", "speech_empty"],
    ["x".repeat(MAX_VOICE_TRANSCRIPT_LENGTH + 1), "transcript_too_long"]] as const) {
    const f = fixture(t, { transcribe: async () => { if (result instanceof Error) throw result; return result; } });
    await f.inbox.accept(voice()); await f.inbox.accept({ kind: "message", id: "later", text: "Text still works." });
    await f.drain();
    assert.deepEqual(f.deliveries.map(input => input.id), ["later"]);
    assert.equal((f.inbox.status() as Diagnostic).recent.find(row => row.id === "voice-1")!.errorCode, code);
    const outbox = f.store.deliveries("telegram-inbox-error:voice-1");
    assert.equal(outbox.length, 1);
    assert.doesNotMatch(outbox[0]!.text + JSON.stringify(f.inbox.status()), /synthetic-private-provider-details/);
    assert.equal(f.inbox.hasPending(), false);
  }
});

test("five-minute, exact-size metadata and 16,000-character speech boundaries remain admissible", async t => {
  const text = "a".repeat(MAX_VOICE_TRANSCRIPT_LENGTH);
  const f = fixture(t, { transcribe: async () => text });
  await f.inbox.accept(voice("boundary", { duration: 300, fileSize: MAX_VOICE_NOTE_BYTES, fileUniqueId: "u".repeat(1_024), caption: "c".repeat(1_024) }));
  await f.drain();
  assert.equal(f.store.pendingOperations()[0]!.text.length, MAX_VOICE_TRANSCRIPT_LENGTH);
  assert.equal(f.deliveries[0]!.caption!.length, 1_024);
  assert.equal(f.deliveries[0]!.text, text);
});

test("queue overflow records one rejected identity without dropping any of the eight pending intents", async t => {
  const f = fixture(t);
  for (let index = 0; index < MAX_TELEGRAM_INBOX_PENDING; index++) await f.inbox.accept({ kind: "message", id: `queued-${index}`, text: `Owner intent ${index}.` });
  const overflow = { kind: "message" as const, id: "overflow", text: "Extra owner intent." };
  assert.equal((await f.inbox.accept(overflow)).status, "failed");
  assert.equal((f.inbox.status() as Diagnostic).pending, MAX_TELEGRAM_INBOX_PENDING);
  await f.drain();
  assert.deepEqual(f.store.pendingOperations().map(op => op.requestId), Array.from({ length: 8 }, (_, index) => `queued-${index}`));
  assert.equal((await f.inbox.accept(overflow)).status, "failed");
  assert.equal(f.store.deliveries("telegram-inbox-error:overflow").length, 1);
  await f.inbox.accept({ ...overflow, id: "new-message" }); await f.drain();
  assert.equal(f.store.pendingOperations().at(-1)!.requestId, "new-message");
});

test("a rejected Core receipt retains real speech and schedules only same-ID delivery recovery", async t => {
  let deliveryCalls = 0;
  const f = fixture(t, { deliver: async input => {
    if (++deliveryCalls === 1) throw new Error("synthetic-private-core-details");
    return f.store.admit(input.id, input.text, "telegram", "telegram-session").id;
  } });
  await f.inbox.accept(voice()); await f.inbox.drive(); await Promise.all(f.work.splice(0));
  const due = f.inbox.nextDue()!;
  assert.ok(due > Date.now());
  assert.equal(f.inbox.hasPending(), true);
  assert.equal(f.counts().transcriptionCalls, 1);
  assert.doesNotMatch(JSON.stringify(f.inbox.status()), /synthetic-private-core-details/);
  const original = Date.now;
  t.mock.method(Date, "now", () => Math.max(original(), due));
  await f.drain();
  assert.equal(deliveryCalls, 2);
  assert.equal(f.counts().transcriptionCalls, 1);
  assert.equal(f.counts().downloadCalls, 1);
  assert.equal(f.store.pendingOperations()[0]!.requestId, "voice-1");
});

test("owner diagnostics are bounded and exclude message, caption, Telegram file IDs and audio", async t => {
  const f = fixture(t);
  for (let index = 0; index < 25; index++) await f.inbox.accept(voice(`failure-${index}`, { duration: 301, caption: "synthetic-private-caption", fileId: "synthetic-private-file" }));
  const status = f.inbox.status() as Diagnostic;
  assert.equal(status.recent.length, 20);
  assert.equal(status.pending, 0);
  assert.doesNotMatch(JSON.stringify(status), /synthetic-private-caption|synthetic-private-file|bytes|transcript/);
});

test("network phase deadlines abort work, fail the voice and release later text", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const stage of ["download", "transcribe"] as const) {
    let entered!: () => void, signal: AbortSignal | undefined;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const wait = (inputSignal: AbortSignal) => {
      signal = inputSignal; entered();
      return new Promise<never>(() => {});
    };
    const f = fixture(t, stage === "download" ? { download: async (_note, signal) => wait(signal) }
      : { transcribe: async (_audio, signal) => wait(signal) });
    await f.inbox.accept(voice()); await f.inbox.drive(); await started;
    await f.inbox.accept({ kind: "message", id: "later", text: "Continue without the recording." });
    t.mock.timers.tick(stage === "download" ? 60_000 : 120_000);
    await Promise.all(f.work.splice(0)); await f.drain();
    assert.equal(signal!.aborted, true);
    assert.deepEqual(f.deliveries.map(input => input.id), ["later"]);
    assert.equal((f.inbox.status() as Diagnostic).recent.find(row => row.id === "voice-1")!.errorCode,
      stage === "download" ? "download_failed" : "transcription_failed");
    assert.equal(f.store.deliveries("telegram-inbox-error:voice-1").length, 1);
  }
});

test("SQL stores intent and real speech only, and successful processing clears the ephemeral audio", async t => {
  const bytes = new Uint8Array([79, 103, 103, 83, 61, 62, 63, 64]);
  const f = fixture(t, { download: async () => ({ bytes, filename: "voice-note.ogg", mimeType: "audio/ogg" }) });
  await f.inbox.accept(voice()); await f.drain();
  const stored = JSON.parse(f.db.all<{ data: string }>("SELECT data FROM umpi_telegram_inbox WHERE id=?", "voice-1")[0]!.data);
  assert.equal(stored.transcript, "Remind me tomorrow morning to review the draft.");
  assert.equal(stored.status, "delivered");
  assert.equal(stored.audio, undefined); assert.equal(stored.bytes, undefined);
  assert.equal(stored.input.bytes, undefined);
  assert.deepEqual(Array.from(bytes), [0, 0, 0, 0, 0, 0, 0, 0]);
});

test("failed durable wake does not acknowledge or retain a stranded message; the same input can be admitted later", async t => {
  let unavailable = true;
  const f = fixture(t, { wake: async () => { if (unavailable) throw new Error("Lifecycle wake unavailable"); } });
  const input = voice();
  await assert.rejects(f.inbox.accept(input));
  assert.equal(f.inbox.hasPending(), false);
  assert.equal(f.store.operation("message:telegram:voice-1"), undefined);
  assert.equal(f.store.deliveries().length, 0);
  unavailable = false;
  await f.inbox.accept(input);
  await f.drain();
  assert.equal(f.store.operation("message:telegram:voice-1")?.text, "Remind me tomorrow morning to review the draft.");
  assert.equal(f.counts().transcriptionCalls, 1);
});
