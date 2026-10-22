import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { TelegramInbox, ALBUM_WAIT_MS, IMAGE_WITHOUT_CAPTION } from "../src/worker/telegram-inbox.js";
import { Store, type Database } from "../src/worker/store.js";
import { telegramUpdate } from "../src/worker/transport.js";
import { downloadTelegramImage } from "../src/worker/telegram-voice.js";
import { InputError } from "../src/shared/protocol.js";
import { MAX_IMAGE_BYTES, VoiceNoteError, type TelegramImage, type TelegramImageMessage, type TelegramInboxDelivery } from "../src/shared/voice-note.js";

const config = { TELEGRAM_BOT_TOKEN: "test-only-token", TELEGRAM_OWNER_ID: "123", TELEGRAM_CHAT_ID: "123" };
const base = { message_id: 7, date: 1_790_000_000, from: { id: 123, is_bot: false }, chat: { id: 123, type: "private" } };
const size = (id: string, width: number, height: number, file_size?: number) => ({ file_id: id, file_unique_id: `u-${id}`, width, height, ...(file_size ? { file_size } : {}) });
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);

test("a photo uses the largest Telegram size within the limits and keeps its caption and album", () => {
  const update = telegramUpdate({ update_id: 5, message: { ...base, caption: "What is this?", media_group_id: "album-1",
    photo: [size("s", 90, 67, 1_000), size("m", 1280, 960, 120_000), size("l", 2560, 1920, 400_000)] } }, config);
  assert.deepEqual(update, { kind: "image", id: "tg:5", messageId: 7, sentAt: "2026-09-21T14:13:20.000Z", caption: "What is this?", mediaGroupId: "album-1",
    image: { fileId: "m", fileUniqueId: "u-m", fileSize: 120_000, mimeType: "image/jpeg" } });
  const huge = telegramUpdate({ update_id: 6, message: { ...base, photo: [size("a", 2560, 1920, 3_000_000), size("b", 4000, 3000, 5_000_000)] } }, config) as TelegramImageMessage;
  assert.equal(huge.image.fileId, "a", "with no size inside the limits, the smallest is used");
  const file = telegramUpdate({ update_id: 7, message: { ...base, document: { file_id: "d", file_unique_id: "u-d", mime_type: "image/PNG", file_size: 50_000 } } }, config);
  assert.deepEqual((file as TelegramImageMessage).image, { fileId: "d", fileUniqueId: "u-d", fileSize: 50_000, mimeType: "image/png" });
  assert.throws(() => telegramUpdate({ update_id: 8, message: { ...base, text: "x", photo: [size("m", 10, 10)] } }, config), InputError);
  assert.throws(() => telegramUpdate({ update_id: 8, message: { ...base, photo: [] } }, config), InputError);
});

test("other attachments are skipped: a caption is still acted on, and without one the owner is told", () => {
  assert.deepEqual(telegramUpdate({ update_id: 9, message: { ...base, caption: "Remind me to watch this tonight", video: { file_id: "v" } } }, config),
    { kind: "message", id: "tg:9", text: "Remind me to watch this tonight", skipped: "a video", sentAt: "2026-09-21T14:13:20.000Z" });
  assert.deepEqual(telegramUpdate({ update_id: 10, message: { ...base, video_note: { file_id: "v" } } }, config),
    { kind: "unreadable", id: "tg:10", attachment: "a video message", sentAt: "2026-09-21T14:13:20.000Z" });
  assert.equal((telegramUpdate({ update_id: 11, message: { ...base, document: { file_id: "d", file_unique_id: "u", mime_type: "application/pdf" }, caption: "Summarise" } }, config) as { skipped: string }).skipped, "a file");
  assert.equal((telegramUpdate({ update_id: 12, message: { ...base, sticker: { file_id: "s" } } }, config) as { attachment: string }).attachment, "a sticker");
  assert.equal(telegramUpdate({ update_id: 13, message: { ...base, pinned_message: {} } }, config), undefined, "a service message is ignored, not rejected");
});

test("an image download checks the real bytes, encodes them and respects the remaining limit", async () => {
  const image = { fileId: "m", fileUniqueId: "u-m" };
  const serve = (bytes: Uint8Array): typeof fetch => {
    let calls = 0;
    return async () => ++calls === 1 ? Response.json({ ok: true, result: { file_id: "m", file_unique_id: "u-m", file_path: "photos/file_1.jpg" } }) : new Response(bytes as BodyInit);
  };
  const signal = new AbortController().signal;
  assert.deepEqual(await downloadTelegramImage(image, MAX_IMAGE_BYTES, config, signal, serve(JPEG)), { data: Buffer.from(JPEG).toString("base64"), mimeType: "image/jpeg", bytes: JPEG.length });
  const fails = (code: string) => (error: unknown) => error instanceof VoiceNoteError && error.code === code;
  await assert.rejects(downloadTelegramImage(image, MAX_IMAGE_BYTES, config, signal, serve(new TextEncoder().encode("<html>not an image"))), fails("image_download_failed"));
  await assert.rejects(downloadTelegramImage(image, 4, config, signal, serve(JPEG)), fails("image_too_large"));
});

function fixture(t: TestContext, downloadImage: (image: TelegramImageMessage["image"], maxBytes: number) => Promise<TelegramImage & { bytes: number }>) {
  const sqlite = new DatabaseSync(":memory:"); t.after(() => sqlite.close());
  const db: Database = { all: <T extends object>(sql: string, ...values: (string | number | null)[]) => sqlite.prepare(sql).all(...values) as T[], transaction: <T>(run: () => T) => run() };
  const store = new Store(db); store.setSession("telegram", "telegram-session");
  const deliveries: TelegramInboxDelivery[] = [], work: Promise<void>[] = [];
  let failDelivery = 0;
  const inbox = new TelegramInbox({ db, download: async () => { throw new Error("no voice"); }, transcribe: async () => "", downloadImage: (image, maxBytes) => downloadImage(image, maxBytes),
    deliver: async input => { if (failDelivery-- > 0) throw new Error("not confirmed"); deliveries.push(input); return `op:${input.id}`; },
    notify: (id, text) => { store.enqueue(id, "telegram", text); }, track: task => { work.push(task); }, wake: async () => undefined, foreground: () => undefined });
  const drain = async () => {
    for (let round = 0; round < 20 && inbox.hasPending() && (inbox.nextDue() ?? Infinity) <= Date.now(); round++) { await inbox.drive(); await Promise.all(work.splice(0)); }
  };
  return { inbox, store, deliveries, drain, failNext: (count: number) => { failDelivery = count; } };
}
const photo = (id: string, changes: Partial<TelegramImageMessage> = {}): TelegramImageMessage =>
  ({ kind: "image", id, messageId: 1, sentAt: "2026-10-22T08:00:00Z", image: { fileId: `f-${id}`, fileUniqueId: `u-${id}`, mimeType: "image/jpeg" }, ...changes });
const encoded = (id: string, bytes = 100) => ({ data: Buffer.from(id.padEnd(3, "_")).toString("base64"), mimeType: "image/jpeg" as const, bytes });

test("an image is downloaded and delivered with its caption; without a caption it still reaches the assistant", async t => {
  const f = fixture(t, async image => encoded(image.fileId));
  await f.inbox.accept(photo("tg:1", { caption: "Which plant is this?" }));
  await f.inbox.accept(photo("tg:2"));
  await f.drain();
  assert.deepEqual(f.deliveries.map(delivery => [delivery.text, delivery.source, delivery.images?.length]), [["Which plant is this?", "image", 1], [IMAGE_WITHOUT_CAPTION, "image", 1]]);
});

test("an album becomes one owner message, and images over the combined limit are counted, not sent", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-22T08:00:00Z") });
  const f = fixture(t, async (image, maxBytes) => {
    const bytes = image.fileId === "f-tg:3" ? MAX_IMAGE_BYTES - 150 : 100;
    if (bytes > maxBytes) throw new VoiceNoteError("image_too_large");
    return encoded(image.fileId, bytes);
  });
  await f.inbox.accept(photo("tg:1", { mediaGroupId: "g", caption: "Compare these" }));
  await f.inbox.accept(photo("tg:2", { mediaGroupId: "g" }));
  assert.equal((await f.inbox.accept(photo("tg:3", { mediaGroupId: "g" }))).status, "merged");
  await f.inbox.accept(photo("tg:4", { mediaGroupId: "g" }));
  await f.drain();
  assert.equal(f.deliveries.length, 0, "the album waits for its remaining images");
  t.mock.timers.tick(ALBUM_WAIT_MS);
  await f.drain();
  assert.equal(f.deliveries.length, 1);
  assert.deepEqual({ text: f.deliveries[0]!.text, images: f.deliveries[0]!.images?.length, omitted: f.deliveries[0]!.omittedImages }, { text: "Compare these", images: 3, omitted: 1 });
  assert.equal(f.inbox.hasPending(), false);
});

test("an unreadable message gets one short reply and never reaches the assistant", async t => {
  const f = fixture(t, async () => { throw new Error("no image"); });
  const accepted = await f.inbox.accept({ kind: "unreadable", id: "tg:1", attachment: "a video" });
  assert.equal(accepted.status, "failed");
  assert.equal((await f.inbox.accept({ kind: "unreadable", id: "tg:1", attachment: "a video" })).status, "failed", "a webhook retry is not answered twice");
  await f.drain();
  assert.equal(f.deliveries.length, 0);
  assert.deepEqual(f.store.deliveries("telegram-inbox-error:tg:1").map(delivery => delivery.text), ["I can't read a video yet, so I did not act on this. Send a screenshot, or describe it in text."]);
});

test("an oversized or unreadable image fails with a reply, and an unconfirmed delivery downloads again", async t => {
  let downloads = 0;
  const f = fixture(t, async image => { downloads++; if (image.fileId === "f-tg:2") throw new VoiceNoteError("image_download_failed"); return encoded(image.fileId); });
  assert.equal((await f.inbox.accept(photo("tg:1", { image: { fileId: "x", fileUniqueId: "y", fileSize: MAX_IMAGE_BYTES + 1 } }))).status, "failed");
  await f.inbox.accept(photo("tg:2"));
  await f.drain();
  assert.match(f.store.deliveries("telegram-inbox-error:tg:1")[0]!.text, /larger than 1 MB/);
  assert.match(f.store.deliveries("telegram-inbox-error:tg:2")[0]!.text, /could not be downloaded/);
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  f.failNext(1); downloads = 0;
  await f.inbox.accept(photo("tg:3"));
  await f.drain();
  t.mock.timers.tick(5_000);
  await f.drain();
  assert.equal(f.deliveries.length, 1); assert.equal(downloads, 2, "image bytes are not kept between attempts");
  f.failNext(3);
  await f.inbox.accept(photo("tg:4"));
  await f.inbox.accept({ kind: "message", id: "tg:5", text: "later text" });
  for (let round = 0; round < 3; round++) { await f.drain(); t.mock.timers.tick(30_000); }
  assert.match(f.store.deliveries("telegram-inbox-error:tg:4")[0]!.text, /could not be confirmed/);
  assert.equal(f.deliveries.at(-1)!.text, "later text", "a stuck image does not hold up later messages");
});

test("admitted images go to Pi after the text and are removed once Pi accepts the message", t => {
  const sqlite = new DatabaseSync(":memory:"); t.after(() => sqlite.close());
  const db: Database = { all: <T extends object>(sql: string, ...values: (string | number | null)[]) => sqlite.prepare(sql).all(...values) as T[], transaction: <T>(run: () => T) => run() };
  const store = new Store(db); store.setSession("telegram", "telegram-session");
  const images: TelegramImage[] = [{ data: Buffer.from(JPEG).toString("base64"), mimeType: "image/jpeg" }];
  const op = store.admit("tg:1", "What is this?", "telegram", "telegram-session", { kind: "telegram-image", sentAt: "2026-10-22T08:00:00Z", omittedImages: 1 }, images);
  const content = store.modelContent(op);
  assert.ok(Array.isArray(content));
  assert.match((content[0] as { text: string }).text, /image is attached after this text\. 1 more image\(s\)[^\n]*\n\nWhat is this\?$/);
  assert.deepEqual(content.slice(1), [{ type: "image", data: images[0]!.data, mimeType: "image/jpeg" }]);
  store.submitted(op.id);
  assert.equal(typeof store.modelContent(store.operation(op.id)!), "string");
  const skipped = store.admit("tg:2", "Remind me to watch this", "telegram", "telegram-session", { kind: "telegram-text", skipped: "a video" });
  assert.match(String(store.modelContent(skipped)), /attached a video, which Umpi cannot read, so it was not used/);
  assert.throws(() => store.admit("tg:3", "x", "telegram", "telegram-session", { kind: "telegram-text" }, images), InputError);
  assert.throws(() => store.admit("tg:4", "x", "telegram", "telegram-session", { kind: "telegram-image" }, [{ data: "not base64!", mimeType: "image/jpeg" }]), InputError);
});
