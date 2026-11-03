import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import type { Capability } from "../src/shared/companion.js";
import { record } from "../src/shared/protocol.js";
import { ChatLog, type ChatEntry } from "../src/worker/chat.js";
import { Store, type Database } from "../src/worker/store.js";
import { CompanionStore } from "../src/worker/companion-store.js";
import { companionRequest, type CompanionHttpContext } from "../src/worker/companion-http.js";
import { sendCompanionPush } from "../src/worker/companion-push.js";
import { authorize } from "../src/worker/transport.js";

const capabilities: Capability[] = [{ id: "notification.schedule", version: 1, status: "available" }];
const config = { UMPI_CONTROL_TOKEN: "control-".repeat(8), UMPI_EXECUTOR_TOKEN: "executor-".repeat(8) };

function fixture(t: TestContext) {
  const sqlite = new DatabaseSync(":memory:"); t.after(() => sqlite.close());
  let depth = 0;
  const db: Database = {
    all: <T extends object>(query: string, ...bindings: (string | number | null)[]) => sqlite.prepare(query).all(...bindings) as T[],
    transaction: <T>(run: () => T): T => {
      const name = `chat_${depth++}`; sqlite.exec(`SAVEPOINT ${name}`);
      try { const value = run(); sqlite.exec(`RELEASE ${name}`); return value; }
      catch (error) { sqlite.exec(`ROLLBACK TO ${name}; RELEASE ${name}`); throw error; }
      finally { depth--; }
    },
  };
  const owner = new Store(db); owner.setSession("control", "control-session"); owner.setSession("telegram", "telegram-session");
  const chat = new ChatLog(db); owner.chat = chat;
  const appended: ChatEntry[] = []; chat.appended = entry => { appended.push(entry); };
  const companion = new CompanionStore(owner);
  const context: CompanionHttpContext = { companion, config, chat, async wake() {}, async requireModel() {},
    async admitApp(id, deviceId, message) {
      companion.requireDevice(deviceId);
      return owner.admit(id, message.text || "[attachment]", "telegram", "telegram-session", { kind: message.images ? "app-image" : message.document ? "app-file" : message.voice ? "app-voice" : "app-text",
        ...(message.context ? { note: message.context } : {}), ...(message.media ? { media: message.media } : {}),
        ...(message.document ? { file: { name: message.document.name, characters: message.document.text.length } } : {}) }, message.images, message.document);
    },
    async readFile(name, bytes) { return { name, text: new TextDecoder().decode(bytes), truncated: false }; },
    async press(seq, data) {
      const entry = chat.entry(seq);
      const result = owner.resolveTelegramCallback(data, { groupId: entry!.id.slice("umpi:".length) });
      chat.setButtons(seq, result.replyMarkup);
      return result;
    },
    async today(day) { return { day: day ?? "2026-11-03", text: null, revision: "none" }; },
    async setTask() { return { status: "synced" }; },
    async widget() { return { items: [], source: "default", updatedAt: "" }; } };
  return { db, owner, chat, appended, companion, context };
}
function pair(companion: CompanionStore) {
  const token = randomBytes(32).toString("base64url");
  companion.claimPairing({ code: companion.createPairing()!.code, token, deviceId: "phone-1", label: "Phone", capabilities });
  return token;
}
function request(path: string, token: string, body?: unknown, method = body === undefined ? "GET" : "POST") {
  return new Request(`https://coordinator.example${path}`, { method, headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}

test("one conversation: Telegram and app messages are both in the history, and each reply stays where the owner wrote", t => {
  const f = fixture(t);
  const telegram = f.owner.admit("tg:1", "What's on today?", "telegram", "telegram-session", { kind: "telegram-text" });
  f.owner.settle(telegram.id, "**Two** meetings.");
  const app = f.owner.admit("app:1", "And tomorrow?", "telegram", "telegram-session", { kind: "app-text" });
  assert.equal(app.surface, "app"); assert.equal(app.sessionId, "telegram-session", "the app shares the Telegram conversation");
  assert.match(String(f.owner.modelContent(app)), /^Authenticated Umpi app owner-message context/);
  f.owner.settle(app.id, "Nothing yet.");
  const entries = f.chat.page().entries.map(entry => [entry.role, entry.surface, entry.kind, entry.text]);
  assert.deepEqual(entries, [["owner", "telegram", "text", "What's on today?"], ["umpi", "telegram", "reply", "**Two** meetings."],
    ["owner", "app", "text", "And tomorrow?"], ["umpi", "app", "reply", "Nothing yet."]], "the app shows the reply's Markdown, not Telegram's rendering");
  assert.deepEqual(f.owner.deliveries().map(delivery => delivery.groupId), [`answer:${telegram.id}`], "the app reply is not sent to Telegram");
  assert.equal(f.chat.nextPush()?.text, "Nothing yet.", "an app reply is announced on the phone");
  f.chat.finishPush(f.chat.nextPush()!.seq, "accepted");
  assert.equal(f.chat.nextPush(), undefined, "a Telegram reply is not announced on the phone");
  assert.equal(f.appended.length, 4, "every new entry wakes the app's socket");
  f.owner.admit("tg:2", "/status", "telegram", "telegram-session");
  assert.equal(f.chat.latest(), 4, "commands are Telegram's interface, not conversation");
});

test("Umpi's own messages notify through the app once chosen, and Telegram then delivers them silently", t => {
  const f = fixture(t);
  f.owner.enqueue("proactive:run-1", "telegram", "Your brief is ready.");
  f.owner.enqueue("mail-menu:1", "telegram", "Mail settings", { inline_keyboard: [[{ text: "Pause", callback_data: "mail:pause" }]] });
  assert.equal(f.owner.deliveries("proactive:run-1")[0]!.silent, undefined);
  assert.equal(f.chat.nextPush(), undefined, "by default Telegram notifies");
  assert.throws(() => f.chat.configure({ expectedVersion: 7, notify: "app" }));
  assert.deepEqual(f.chat.configure({ expectedVersion: 1, notify: "app" }), { notify: "app", version: 2 });
  f.owner.enqueue("reminder:r1:1", "telegram", "Reminder: stretch");
  f.owner.enqueue("approval:job-1:1", "telegram", "Approve this command?", { inline_keyboard: [[{ text: "Approve", callback_data: "job:approve" }]] });
  f.owner.enqueue("telegram-inbox-error:tg:9", "telegram", "The file could not be read.");
  assert.equal(f.owner.deliveries("reminder:r1:1")[0]!.silent, true);
  assert.equal(f.owner.deliveries("telegram-inbox-error:tg:9")[0]!.silent, undefined, "a reply in Telegram still sounds there");
  const entries = f.chat.page().entries;
  assert.deepEqual(entries.map(entry => entry.id), ["umpi:proactive:run-1", "umpi:reminder:r1:1", "umpi:approval:job-1:1", "umpi:telegram-inbox-error:tg:9"], "menus are left out");
  assert.deepEqual(entries[2]!.buttons, [[{ label: "Approve", data: "job:approve" }]]);
  const pushed: string[] = [];
  for (let next = f.chat.nextPush(); next; next = f.chat.nextPush()) { pushed.push(next.text); f.chat.finishPush(next.seq, "accepted"); }
  assert.deepEqual(pushed, ["Reminder: stretch", "Approve this command?"]);
  f.owner.enqueue("alert:x", "telegram", "Meeting in 10 minutes");
  const seq = f.chat.nextPush()!.seq;
  f.chat.finishPush(seq, "failed"); assert.equal(f.chat.nextPush()?.seq, seq, "a failed send is tried again");
  f.chat.finishPush(seq, "uncertain"); assert.equal(f.chat.nextPush(), undefined, "an uncertain send may have arrived, so it is not repeated");
});

test("the app reads history in pages, changes the notification setting, and sends text, images, and files", async t => {
  const f = fixture(t);
  const token = pair(f.companion);
  for (let index = 1; index <= 5; index++) f.owner.enqueue(`proactive:${index}`, "telegram", `Message ${index}`);
  const page = async (query: string) => record(await (await companionRequest(request(`/api/device/chat${query}`, token), f.context))!.json());
  const newest = await page("?limit=2");
  assert.deepEqual((newest.entries as ChatEntry[]).map(entry => entry.text), ["Message 4", "Message 5"]); assert.equal(newest.more, true); assert.equal(newest.latest, 5);
  assert.deepEqual(((await page("?before=4&limit=2")).entries as ChatEntry[]).map(entry => entry.seq), [2, 3]);
  assert.deepEqual(((await page("?after=3")).entries as ChatEntry[]).map(entry => entry.seq), [4, 5]);
  await assert.rejects(page("?before=x"));
  const settings = await companionRequest(request("/api/device/chat/settings", token, { expectedVersion: 1, notify: "app" }, "PUT"), f.context);
  assert.equal(record(await settings!.json()).notify, "app");

  const sent = await companionRequest(request("/api/device/messages", token, { id: "m1", text: "Hi from the phone" }), f.context);
  assert.equal(sent!.status, 202);
  const op = record(await sent!.json());
  assert.equal(op.surface, "app"); assert.equal(op.channel, "telegram");
  const again = await companionRequest(request("/api/device/messages", token, { id: "m1", text: "Hi from the phone" }), f.context);
  assert.equal(record(await again!.json()).id, op.id, "a resent message is admitted once");
  const file = await companionRequest(request("/api/device/messages", token, { id: "m2", file: { name: "plan.md", data: Buffer.from("Rice once a day.").toString("base64") } }), f.context);
  assert.match(String(f.owner.modelContent(f.owner.operation(String(record(await file!.json()).id))!)), /<owner-file name="plan\.md">\nRice once a day\.\n<\/owner-file>$/);
  const video = await companionRequest(request("/api/device/messages", token, { id: "mv", text: "Look at this", images: [{ data: Buffer.from([0xff, 0xd8, 0xff, 0xe0]).toString("base64"), mimeType: "image/jpeg" }],
    context: "Video: 4 frames attached. Speech: water the plants.", media: { kind: "video", seconds: 4, count: 4 } }), f.context);
  const videoOp = f.owner.operation(String(record(await video!.json()).id))!;
  assert.match(JSON.stringify(f.owner.modelContent(videoOp)), /Look at this\\n\\nVideo: 4 frames attached\. Speech: water the plants\./, "the note reaches the model after the owner's words");
  assert.equal((String((f.owner.modelContent(videoOp) as { text: string }[])[0]!.text).match(/water the plants/g) ?? []).length, 1, "the note is not repeated in the header");
  const shown = f.chat.page().entries.at(-1)!;
  assert.equal(shown.text, "Look at this"); assert.deepEqual(shown.media, { kind: "video", seconds: 4, count: 4 });
  await companionRequest(request("/api/device/messages", token, { id: "m0", voice: true, text: "Remember to buy eggs" }), f.context);
  assert.equal(f.chat.page().entries.at(-1)!.kind, "voice", "a voice message is marked as one");
  const image = { data: Buffer.from([0xff, 0xd8, 0xff, 0xe0]).toString("base64"), mimeType: "image/jpeg" };
  await companionRequest(request("/api/device/messages", token, { id: "m3", text: "What is this?", images: [image] }), f.context);
  const latest = (await page("?after=5")).entries as ChatEntry[];
  assert.deepEqual(latest.map(entry => [entry.surface, entry.kind, entry.text, entry.file ?? entry.images ?? null]),
    [["app", "text", "Hi from the phone", null], ["app", "file", "[attachment]", "plan.md"], ["app", "image", "Look at this", 1], ["app", "voice", "Remember to buy eggs", null], ["app", "image", "What is this?", 1]]);
  await assert.rejects(companionRequest(request("/api/device/messages", token, { id: "m4" }), f.context), /needs text, images, or a file/);
  await assert.rejects(companionRequest(request("/api/device/messages", token, { id: "m6", voice: true, text: "x", images: [image] }), f.context), /transcript only/);
  await assert.rejects(companionRequest(request("/api/device/messages", token, { id: "m5", file: { name: "x", data: "not base64!" } }), f.context), /base64/);
  await assert.rejects(companionRequest(request("/api/device/chat", "not-a-paired-token"), f.context));
  await assert.rejects(companionRequest(request("/api/device/chat/socket", token), f.context), /WebSocket/);
  const upgrade = (path: string, token?: string) => new Request(`https://coordinator.example${path}`, { headers: { upgrade: "websocket", ...(token ? { authorization: `Bearer ${token}` } : {}) } });
  await authorize(upgrade("/api/device/chat/socket", token), config, "forward-device");
  await assert.rejects(authorize(upgrade("/api/device/chat/socket"), config, "forward-device"), /Unauthorized/, "the socket needs a device credential");
  await assert.rejects(authorize(upgrade("/api/device/chat/socket", config.UMPI_CONTROL_TOKEN), config, "forward-device"), /Unauthorized/);
  await assert.rejects(authorize(upgrade("/api/device/state", token), config, "forward-device"), /Not found/, "other upgrades are refused");
});

test("a chat message reaches the phone as an alert with its preview and position", async () => {
  const keys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const push = { APNS_TEAM_ID: "TESTTEAM00", APNS_KEY_ID: "TESTKEY000", APNS_PRIVATE_KEY: keys.privateKey.export({ format: "pem", type: "pkcs8" }).toString(), APNS_BUNDLE_ID: "com.example.umpi" };
  const sent: { headers: Headers; body: Record<string, unknown> }[] = [];
  const transport = (async (_url: string | URL, init?: RequestInit) => {
    sent.push({ headers: new Headers(init!.headers), body: JSON.parse(String(init!.body)) as Record<string, unknown> });
    return new Response(null, { status: 200, headers: { "apns-id": "123e4567-e89b-12d3-a456-426614174000" } });
  }) as typeof fetch;
  const result = await sendCompanionPush({ deviceId: "phone-1", apnsToken: "ab".repeat(32), apnsEnvironment: "sandbox" },
    { revision: 0, jobs: [], message: { body: "Your brief is ready.", seq: 42 } }, push, { fetch: transport });
  assert.equal(result.status, "accepted");
  assert.equal(sent[0]!.headers.get("apns-push-type"), "alert");
  assert.deepEqual(sent[0]!.body, { aps: { alert: { title: "Umpi", body: "Your brief is ready." }, sound: "default", "thread-id": "chat", "content-available": 1 }, chat: 42 });
});

test("a button pressed in the app answers the same approval as Telegram's, and the message's buttons change", async t => {
  const f = fixture(t);
  const token = pair(f.companion);
  f.owner.createJob({ jobId: "job-1", command: "printf safe", cwd: "/workspace", timeoutMs: 1_000, createdAt: new Date().toISOString() }, "telegram", "telegram-session");
  const card = f.chat.page().entries.find(entry => entry.id.startsWith("umpi:approval:job-1"))!;
  const approve = card.buttons!.flat().find(button => /approve/i.test(button.label))!;
  const pressed = await companionRequest(request("/api/device/chat/press", token, { seq: card.seq, data: approve.data }), f.context);
  assert.match(String(record(await pressed!.json()).text), /Approved/);
  assert.equal(f.owner.job("job-1")!.status, "queued");
  assert.ok(!f.chat.entry(card.seq)!.buttons?.flat().some(button => button.data === approve.data), "the used button is gone");
  f.owner.enqueue("approval:other:1", "telegram", "Other", { inline_keyboard: [[{ text: "Approve", callback_data: approve.data }]] });
  const other = f.chat.page().entries.at(-1)!;
  await assert.rejects(companionRequest(request("/api/device/chat/press", token, { seq: other.seq, data: approve.data }), f.context), /no longer available|does not belong/, "a button is bound to its own message");
  f.owner.enqueue("proactive:x", "telegram", "Mail", { inline_keyboard: [[{ text: "Draft", callback_data: "mail:draft:1" }]] });
  await assert.rejects(companionRequest(request("/api/device/chat/press", token, { seq: f.chat.latest(), data: "mail:draft:1" }), f.context), /only be answered in Telegram/);
});

test("a knock scheduled on the phone is the alert: the reminder message is silent, not pushed, and the phone answers it", async t => {
  const f = fixture(t);
  const token = pair(f.companion);
  f.chat.configure({ expectedVersion: 1, notify: "app" });
  const due = new Date(Date.now() + 60_000).toISOString();
  f.owner.createReminder("r1", "Stretch", due, "telegram");
  f.owner.createReminder("r2", "Water plants", due, "telegram");
  await companionRequest(request("/api/device/knocks", token, { scheduled: [{ id: "r1", version: 1 }] }), f.context);
  f.owner.fireReminders(Date.now() + 61_000);
  assert.equal(f.owner.deliveries("reminder:r1:1")[0]!.silent, true, "the knocked reminder is silent in Telegram");
  const pushed: string[] = [];
  for (let next = f.chat.nextPush(); next; next = f.chat.nextPush()) { pushed.push(next.text); f.chat.finishPush(next.seq, "accepted"); }
  assert.deepEqual(pushed, ["Reminder: Water plants"], "only the reminder the phone did not knock is pushed");
  const answer = async (id: string, body: unknown) => record(await (await companionRequest(request(`/api/device/reminders/${id}/answer`, token, body), f.context))!.json());
  assert.equal((await answer("r1", { version: 1, action: "done" })).answer && f.owner.reminder("r1")!.answer!.outcome, "done");
  const snoozed = await answer("r2", { version: 1, action: "snooze" });
  assert.equal(snoozed.status, "scheduled"); assert.equal(snoozed.version, 2);
  await assert.rejects(companionRequest(request("/api/device/reminders/r2/answer", token, { version: 1, action: "later" }), f.context), /changed after the knock/);
  f.owner.createReminder("r3", "Early", new Date(Date.now() + 30_000).toISOString(), "telegram");
  assert.equal((await answer("r3", { version: 1, action: "later" })).status, "fired", "a knock a few seconds early is answered and fires the reminder once");
  f.owner.fireReminders(Date.now() + 31_000);
  assert.equal(f.owner.deliveries("reminder:r3:1").length, 0, "no second message after the answer");
});
