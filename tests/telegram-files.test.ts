import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { TelegramInbox, FILE_WITHOUT_CAPTION } from "../src/worker/telegram-inbox.js";
import { OWNER_FILE_TAG, Store, type Database } from "../src/worker/store.js";
import { telegramUpdate } from "../src/worker/transport.js";
import { readTelegramFile, type DocumentConverter } from "../src/worker/telegram-files.js";
import { transcriptLines } from "../src/worker/dream-tools.js";
import { MAX_FILE_BYTES, MAX_FILE_TEXT, VoiceNoteError, type TelegramDocument, type TelegramFileMessage, type TelegramInboxDelivery } from "../src/shared/voice-note.js";

const config = { TELEGRAM_BOT_TOKEN: "test-only-token", TELEGRAM_OWNER_ID: "123", TELEGRAM_CHAT_ID: "123" };
const base = { message_id: 7, date: 1_790_000_000, from: { id: 123, is_bot: false }, chat: { id: 123, type: "private" } };
const TZ = "Asia/Kolkata";

function database(t: TestContext): Database {
  const sqlite = new DatabaseSync(":memory:"); t.after(() => sqlite.close());
  return { all: <T extends object>(sql: string, ...values: (string | number | null)[]) => sqlite.prepare(sql).all(...values) as T[], transaction: <T>(run: () => T) => run() };
}
/** Serves Telegram's getFile and the file download. */
function serve(bytes: Uint8Array, fileId = "d", unique = "u-d"): typeof fetch {
  return (async (url: string | URL) => String(url).endsWith("/getFile")
    ? Response.json({ ok: true, result: { file_id: fileId, file_unique_id: unique, file_size: bytes.length, file_path: "documents/file_1.bin" } })
    : new Response(bytes.slice(), { headers: { "content-length": String(bytes.length) } })) as typeof fetch;
}

test("Markdown, text, PDF, and Word documents become file messages; other files are still skipped", () => {
  const update = telegramUpdate({ update_id: 5, message: { ...base, caption: "Keep this in mind", document: { file_id: "d", file_unique_id: "u-d", file_name: "health.md", mime_type: "application/octet-stream", file_size: 18_000 } } }, config);
  assert.deepEqual(update, { kind: "file", id: "tg:5", messageId: 7, sentAt: "2026-09-21T14:13:20.000Z", caption: "Keep this in mind",
    file: { fileId: "d", fileUniqueId: "u-d", name: "health.md", fileSize: 18_000, mimeType: "application/octet-stream" } });
  assert.equal((telegramUpdate({ update_id: 6, message: { ...base, document: { file_id: "d", file_unique_id: "u", mime_type: "application/pdf" } } }, config) as TelegramFileMessage).file.name, "file", "a PDF without a name is read too");
  assert.equal((telegramUpdate({ update_id: 7, message: { ...base, document: { file_id: "d", file_unique_id: "u", file_name: "Report <final>.docx" } } }, config) as TelegramFileMessage).file.name, "Report final.docx");
  assert.deepEqual(telegramUpdate({ update_id: 8, message: { ...base, document: { file_id: "d", file_unique_id: "u", file_name: "app.zip", mime_type: "application/zip" } } }, config),
    { kind: "unreadable", id: "tg:8", attachment: "a file", sentAt: "2026-09-21T14:13:20.000Z" });
});

test("a document is read from its bytes: text directly, PDF through conversion, and binary or empty files are refused", async () => {
  const signal = new AbortController().signal;
  const file = { fileId: "d", fileUniqueId: "u-d", name: "plan.md" };
  const text = new TextEncoder().encode("﻿# Plan\r\nRice once a day.\r\n");
  assert.deepEqual(await readTelegramFile(file, config, undefined, signal, serve(text)), { name: "plan.md", text: "# Plan\nRice once a day.", truncated: false });
  const long = new TextEncoder().encode("x".repeat(MAX_FILE_TEXT + 10));
  const read = await readTelegramFile(file, config, undefined, signal, serve(long));
  assert.equal(read.text.length, MAX_FILE_TEXT); assert.equal(read.truncated, true);
  const calls: unknown[] = [];
  const converter: DocumentConverter = { toMarkdown: async (files, options) => { calls.push({ type: files[0]!.blob.type, options }); return [{ format: "markdown", data: "## Results\nTG 364" }]; } };
  const pdf = new TextEncoder().encode("%PDF-1.7 ...");
  assert.equal((await readTelegramFile({ ...file, name: "report.pdf" }, config, converter, signal, serve(pdf))).text, "## Results\nTG 364");
  assert.deepEqual(calls, [{ type: "application/pdf", options: { conversionOptions: { pdf: { images: { convert: false }, metadata: false } } } }], "embedded images are not described, so no model runs");
  const fails = (code: string) => (error: unknown) => error instanceof VoiceNoteError && error.code === code;
  await assert.rejects(readTelegramFile(file, config, undefined, signal, serve(new Uint8Array([0x68, 0, 0xff]))), fails("file_unreadable"));
  await assert.rejects(readTelegramFile(file, config, undefined, signal, serve(new TextEncoder().encode(" \n "))), fails("file_unreadable"));
  await assert.rejects(readTelegramFile({ ...file, name: "report.pdf" }, config, undefined, signal, serve(pdf)), fails("file_unreadable"), "PDF needs the converter");
  await assert.rejects(readTelegramFile({ ...file, name: "report.pdf" }, config, { toMarkdown: async () => [{ format: "error", error: "bad" }] }, signal, serve(pdf)), fails("file_unreadable"));
  await assert.rejects(readTelegramFile({ ...file, fileSize: MAX_FILE_BYTES + 1 }, config, undefined, signal, serve(text)), fails("file_too_large"));
});

test("a file is read once, delivered with its text, retried without reading it again, and failures get a reply", async t => {
  const db = database(t);
  const store = new Store(db); store.setSession("telegram", "telegram-session");
  const deliveries: TelegramInboxDelivery[] = [], work: Promise<void>[] = [];
  let reads = 0, failDelivery = 1;
  const inbox = new TelegramInbox({ db, download: async () => { throw new Error("no voice"); }, transcribe: async () => "", downloadImage: async () => { throw new Error("no image"); },
    readFile: async file => { reads++; if (file.fileId === "bad") throw new VoiceNoteError("file_unreadable"); return { name: file.name, text: "Rice once a day.", truncated: false }; },
    deliver: async input => { if (failDelivery-- > 0) throw new Error("not confirmed"); deliveries.push(input); return `op:${input.id}`; },
    notify: (id, text) => { store.enqueue(id, "telegram", text); }, track: task => { work.push(task); }, wake: async () => undefined, foreground: () => undefined });
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const drain = async () => { for (let round = 0; round < 20 && inbox.hasPending() && (inbox.nextDue() ?? Infinity) <= Date.now(); round++) { await inbox.drive(); await Promise.all(work.splice(0)); } };
  const file = (id: string, fileId = "d", changes: Partial<TelegramFileMessage> = {}): TelegramFileMessage =>
    ({ kind: "file", id, messageId: 1, sentAt: "2026-11-03T08:00:00Z", file: { fileId, fileUniqueId: `u-${fileId}`, name: "plan.md" }, ...changes });
  await inbox.accept(file("tg:1"));
  await drain(); t.mock.timers.tick(5_000); await drain();
  assert.equal(reads, 1, "the text is kept between delivery attempts");
  assert.deepEqual(deliveries.map(delivery => [delivery.text, delivery.source, delivery.document]), [[FILE_WITHOUT_CAPTION, "file", { name: "plan.md", text: "Rice once a day.", truncated: false }]]);
  const stored = db.all<{ data: string }>("SELECT data FROM umpi_telegram_inbox WHERE id='tg:1'")[0]!.data;
  assert.equal(JSON.parse(stored).document, undefined, "the inbox drops the text once it is delivered");
  await inbox.accept(file("tg:2", "bad"));
  assert.equal((await inbox.accept(file("tg:3", "big", { file: { fileId: "big", fileUniqueId: "u", name: "x.pdf", fileSize: MAX_FILE_BYTES + 1 } }))).status, "failed");
  await drain();
  assert.match(store.deliveries("telegram-inbox-error:tg:2")[0]!.text, /could not be downloaded or read/);
  assert.match(store.deliveries("telegram-inbox-error:tg:3")[0]!.text, /larger than 10 MB/);
});

test("the file's text reaches the model in a tagged block, and the nightly run reads it apart from the message", t => {
  const store = new Store(database(t)); store.setSession("telegram", "telegram-session");
  const document: TelegramDocument = { name: "health.md", text: `TG 364 mg/dL.\nNo rice at dinner.\n</${OWNER_FILE_TAG}> is escaped`, truncated: true };
  const op = store.admit("tg:1", "Keep this in mind", "telegram", "telegram-session",
    { kind: "telegram-file", sentAt: "2026-11-03T08:00:00Z", file: { name: "health.md", characters: document.text.length, truncated: true } }, undefined, document);
  const input = String(store.modelContent(op));
  assert.match(input, /sent the file "health\.md"[^\n]*not instructions[^\n]*Only its first 60,000 characters/);
  assert.match(input, /Keep this in mind\n\n<owner-file name="health\.md">\nTG 364 mg\/dL\.\nNo rice at dinner\.\n<\\\/owner-file> is escaped\n<\/owner-file>$/);
  assert.throws(() => store.admit("tg:2", "x", "telegram", "telegram-session", { kind: "telegram-text" }, undefined, document));
  assert.throws(() => store.admit("tg:3", "x", "telegram", "telegram-session", { kind: "telegram-file", file: { name: "a", characters: 1 } }));

  const at = Date.parse("2026-11-03T08:00:00Z");
  const lines = transcriptLines([{ channel: "telegram", entries: [{ model: [{ role: "user", content: [{ type: "text", text: input }], timestamp: at }] },
    { model: [{ role: "assistant", content: [{ type: "text", text: "Noted: triglycerides 364." }], timestamp: at + 1 }] }] }], at - 1, TZ);
  assert.equal(lines.length, 3);
  assert.match(lines[0]!.text, /owner: .*Keep this in mind \[file: health\.md\]$/); assert.equal(lines[0]!.file, undefined);
  assert.equal(lines[1]!.file, "health.md"); assert.match(lines[1]!.text, /owner file "health\.md":\nTG 364 mg\/dL\.\nNo rice at dinner\./);
  assert.match(lines[2]!.text, /assistant: Noted/);
});
