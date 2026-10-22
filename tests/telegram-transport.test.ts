import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { InputError } from "../src/shared/protocol.js";
import { StateError, type Choice, type Delivery, type Job, type Reminder } from "../src/worker/store.js";
import { answerTelegramCallback, editTelegramKeyboard, sendTelegram, telegramUpdate } from "../src/worker/transport.js";
import { formatTelegramStatus } from "../src/worker/telegram-view.js";

const config = { TELEGRAM_OWNER_ID: "123", TELEGRAM_CHAT_ID: "123", TELEGRAM_BOT_TOKEN: "test-only-token" };
const callback = {
  update_id: 42,
  callback_query: {
    id: "query-42", from: { id: 123, is_bot: false }, data: "opaque-token",
    message: { message_id: 7, date: 1_790_000_000, from: { id: 987, is_bot: true }, chat: { id: 123, type: "private" } },
  },
};

test("only the human callback sender in the exact private chat can act on a bot message", () => {
  const parsed = telegramUpdate(callback, config);
  assert.equal(parsed?.kind, "callback");
  if (parsed?.kind !== "callback") assert.fail("Expected an admitted callback");
  const forgeries = [
    { ...callback.callback_query, from: { id: 456, is_bot: false }, message: { ...callback.callback_query.message, from: { id: 123, is_bot: false } } },
    { ...callback.callback_query, from: { id: 123, is_bot: true } },
    { ...callback.callback_query, from: { id: "123", is_bot: false } },
    { ...callback.callback_query, message: { ...callback.callback_query.message, chat: { id: 456, type: "private" } } },
    { ...callback.callback_query, message: { ...callback.callback_query.message, chat: { id: 123, type: "group" } } },
    { ...callback.callback_query, message: { ...callback.callback_query.message, chat: { id: "123", type: "private" } } },
  ];
  for (const query of forgeries) {
    assert.throws(() => telegramUpdate({ ...callback, callback_query: query }, config), (error: unknown) => error instanceof StateError && error.status === 403);
  }
  assert.throws(() => telegramUpdate(callback, {}), (error: unknown) => error instanceof StateError && error.status === 403);
});

test("callback payload bounds reject inaccessible, inline, ambiguous, and oversized updates", () => {
  const invalidQueries = [
    null, [],
    { ...callback.callback_query, message: undefined, inline_message_id: "inline" },
    { ...callback.callback_query, inline_message_id: "inline" },
    ...[0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "7", null].map(message_id => ({ ...callback.callback_query, message: { ...callback.callback_query.message, message_id } })),
    ...[0, undefined, -1, "1790000000"].map(date => ({ ...callback.callback_query, message: { ...callback.callback_query.message, date } })),
    ...["", "x".repeat(65), "é".repeat(33), "😀".repeat(17), "bad\0token", null, 7].map(data => ({ ...callback.callback_query, data })),
    ...["", "x".repeat(257), "bad\0id", null, 7].map(id => ({ ...callback.callback_query, id })),
  ];
  for (const query of invalidQueries) assert.throws(() => telegramUpdate({ ...callback, callback_query: query }, config), InputError);
  for (const update_id of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, "42", null]) {
    assert.throws(() => telegramUpdate({ ...callback, update_id }, config), InputError);
  }
  assert.throws(() => telegramUpdate({ ...callback, message: {} }, config), InputError);
  for (const data of ["x".repeat(64), "é".repeat(32), "😀".repeat(16), "approve:arbitrary:999"]) {
    const parsed = telegramUpdate({ ...callback, callback_query: { ...callback.callback_query, data, id: "q".repeat(256) } }, config);
    assert.equal(parsed?.kind, "callback"); // Token meaning and message binding belong to Store, not the adapter.
  }
  assert.equal(telegramUpdate({ update_id: 0, edited_message: {} }, config), undefined);
});

test("text admission retains owner boundaries and does not silently accept invalid messages", () => {
  const message = { text: "Pick the second option", from: { id: 123, is_bot: false }, chat: { id: 123, type: "private" } };
  assert.equal(telegramUpdate({ update_id: 1, message }, config)?.kind, "message");
  for (const text of ["", "x".repeat(16_385), "bad\0text"]) {
    assert.throws(() => telegramUpdate({ update_id: 1, message: { ...message, text } }, config), InputError);
  }
  // A message with no text or attachment (a service message) is ignored, so Telegram does not redeliver it.
  assert.equal(telegramUpdate({ update_id: 1, message: { ...message, text: undefined } }, config), undefined);
  assert.throws(() => telegramUpdate({ update_id: 1, message: { ...message, from: callback.callback_query.message.from } }, config), StateError);
});

const voiceMessage = {
  message_id: 9, date: 1_790_000_000, from: { id: 123, is_bot: false }, chat: { id: 123, type: "private" },
  voice: { file_id: "opaque-file", file_unique_id: "opaque-unique", duration: 12, file_size: 90, mime_type: "audio/ogg" },
  caption: "A spoken request",
};


test("voice parsing authorizes the exact human owner before malformed media and rejects ambiguous messages", () => {
  for (const forged of [
    { from: { id: 456, is_bot: false } }, { from: { id: 123, is_bot: true } },
    { from: { id: "123", is_bot: false } }, { chat: { id: 456, type: "private" } },
    { chat: { id: 123, type: "group" } },
  ]) assert.throws(() => telegramUpdate({ update_id: 43, message: { ...voiceMessage, ...forged, voice: null } }, config),
    (error: unknown) => error instanceof StateError && error.status === 403);
  const invalid = [
    { voice: null }, { text: "ambiguous" }, { audio: {} }, { document: {} },
    ...[0, -1, 1.5, "9"].map(message_id => ({ message_id })),
    ...[undefined, 0, -1, "1790000000", 253_402_300_800, Number.MAX_SAFE_INTEGER].map(date => ({ date })),
    ...[-1, 1.5, "12", undefined].map(duration => ({ voice: { ...voiceMessage.voice, duration } })),
    ...[0, -1, 1.5, "90"].map(file_size => ({ voice: { ...voiceMessage.voice, file_size } })),
    ...["", "bad\0id", "bad\nid", " leading"].map(file_id => ({ voice: { ...voiceMessage.voice, file_id } })),
    { voice: { ...voiceMessage.voice, file_unique_id: undefined } },
    { voice: { ...voiceMessage.voice, mime_type: "audio/ogg\nsecret" } }, { caption: "x".repeat(1025) },
  ];
  for (const change of invalid) assert.throws(() => telegramUpdate({ update_id: 43, message: { ...voiceMessage, ...change } }, config), InputError);
});


test("Telegram UI failures do not retry or redirect, and acknowledgements respect text bounds", async t => {
  const requests = new Map<string, number>();
  const server = createServer((request, response) => {
    const path = request.url!;
    requests.set(path, (requests.get(path) ?? 0) + 1);
    let body = "";
    request.setEncoding("utf8");
    request.on("data", chunk => { body += chunk; });
    request.on("end", () => {
      if (path === "/redirect") { response.writeHead(307, { location: "/leaked" }); response.end(); return; }
      if (path === "/disconnect") { request.socket.destroy(); return; }
      if (path === "/malformed") { response.writeHead(200, { "content-type": "application/json" }); response.end("{"); return; }
      if (path === "/unbound") { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ ok: true, result: { message_id: 0 } })); return; }
      const payload = JSON.parse(body) as { text?: string };
      const accepted = path === "/answer" && typeof payload.text === "string" && payload.text.length <= 200 && !/[\uD800-\uDBFF]$/.test(payload.text);
      response.writeHead(accepted ? 200 : 400, { "content-type": "application/json" });
      response.end(JSON.stringify(accepted ? { ok: true, result: true } : { ok: false, description: "private failure", error_code: 400 }));
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address();
  assert(address && typeof address !== "string");
  const route = (path: string): typeof fetch => (_url, init) => fetch(`http://127.0.0.1:${address.port}${path}`, init);
  assert.equal(await answerTelegramCallback("query-42", "x".repeat(199) + "😀long", config, route("/answer")), true);
  const delivery: Delivery = { id: "d", groupId: "d", part: 0, channel: "telegram", text: "Review command", status: "sending", createdAt: new Date().toISOString(), replyMarkup: { inline_keyboard: [[{ text: "Approve", callback_data: "opaque" }]] } };
  assert.equal((await sendTelegram(delivery, config, route("/unbound"))).status, "uncertain");
  assert.equal(requests.get("/unbound"), 1);
  for (const path of ["/rejected", "/malformed", "/redirect", "/disconnect"]) {
    assert.equal(await answerTelegramCallback("query-42", "Handled", config, route(path)), false);
    assert.equal(await editTelegramKeyboard(7, { inline_keyboard: [] }, config, route(path)), false);
    assert.equal(requests.get(path), 2);
  }
  assert.equal(requests.get("/leaked"), undefined);
  assert.equal(await answerTelegramCallback("", "Handled", config, route("/invalid")), false);
  assert.equal(await editTelegramKeyboard(0, { inline_keyboard: [] }, config, route("/invalid")), false);
  assert.equal(await editTelegramKeyboard(7, { inline_keyboard: [] }, {}, route("/invalid")), false);
  assert.equal(requests.get("/invalid"), undefined);
});

const now = Date.parse("2026-10-11T12:00:00Z");
const baseJob: Job = { jobId: "37b406c0-7cdc-4f74-9710-2397a674ec64", command: "inspect production logs", cwd: "/workspace", timeoutMs: 10_000, createdAt: "2026-10-10T10:00:00Z", channel: "telegram", sessionId: "2", version: 1, status: "pending_approval", cancelRequested: false };
const baseReminder: Reminder = { id: "r", text: "Call the dentist", dueAt: "2026-10-11T12:00:00Z", version: 1, channel: "telegram", status: "scheduled", createdAt: "2026-10-10T10:00:00Z" };

test("active commands, questions and due reminders remain visible behind abundant newer history", () => {
  const jobs: Job[] = Array.from({ length: 100 }, (_, index) => ({ ...baseJob, jobId: `smoke-${index}`, command: `historical smoke ${index} ` + "x".repeat(16_000), createdAt: "2026-10-11T10:00:00Z", status: "succeeded" }));
  jobs.push(
    { ...baseJob, command: "waiting-review-command" },
    { ...baseJob, command: "queued-backup-command", status: "queued" },
    { ...baseJob, command: "running-report-command", status: "running" },
    { ...baseJob, command: "stopping-sync-command", status: "running", cancelRequested: true },
  );
  const choices: Choice[] = [{ id: "question-id", question: "Select deployment region", options: ["Mumbai", "Frankfurt"], status: "pending", channel: "telegram", sessionId: "2", createdAt: "2026-10-10T10:00:00Z" }];
  const output = formatTelegramStatus({ jobs, reminders: [baseReminder], choices, executors: [{ executorId: "secret-machine-id", lastSeenAt: "2026-10-11T11:00:00Z" }], timezone: "Asia/Kolkata" }, now);
  for (const meaningful of ["waiting-review-command", "queued-backup-command", "running-report-command", "stopping-sync-command", "Call the dentist", "Select deployment region", "Mumbai", "Frankfurt", "17:30", "16:30"]) assert.ok(output.includes(meaningful), meaningful);
  assert.ok(output.length <= 4_000);
  assert.ok(!output.includes(baseJob.jobId));
  assert.ok(!output.includes("secret-machine-id"));
  assert.ok(!output.includes('"status":'));
  assert.ok(output.indexOf("running-report-command") < output.indexOf("historical smoke"));
});

test("status stays within one message even when every section is full and preserves Unicode", () => {
  const jobs: Job[] = [];
  for (const status of ["pending_approval", "queued", "running", "succeeded", "failed", "uncertain", "cancelled"] as const) {
    for (let i = 0; i < 20; i++) jobs.push({ ...baseJob, status, command: "😀".repeat(8_000), cancelRequested: status === "running" && i % 2 === 0 });
  }
  const choices: Choice[] = Array.from({ length: 100 }, (_, index) => ({ id: `choice-${index}`, question: "😀".repeat(512), options: Array.from({ length: 5 }, (_, i) => `${i}${"😀".repeat(30)}`), status: "pending", channel: "telegram", sessionId: "2", createdAt: "2026-10-10T10:00:00Z" }));
  const output = formatTelegramStatus({ jobs, choices, reminders: Array.from({ length: 100 }, () => ({ ...baseReminder, text: "😀".repeat(2_000) })), executors: [{ executorId: "mac", lastSeenAt: "2026-10-11T11:00:00Z" }], timezone: "Asia/Kolkata" }, now);
  assert.ok(output.length <= 4_000);
  assert.equal(output, new TextDecoder().decode(new TextEncoder().encode(output)));
  assert.ok(output.includes("16:30")); // The final section survives full active/history sections.
});

test("status uses owner timezone across daylight-saving changes and rejects bad executor timestamps", () => {
  const input = { jobs: [], reminders: [baseReminder], executors: [{ executorId: "mac", lastSeenAt: "not-a-date" }, { lastSeenAt: "2026-10-11T11:00:00Z" }], timezone: "America/New_York" };
  const winter = formatTelegramStatus({ ...input, reminders: [{ ...baseReminder, dueAt: "2026-01-15T12:00:00Z" }] }, now);
  const summer = formatTelegramStatus({ ...input, reminders: [{ ...baseReminder, dueAt: "2026-07-15T12:00:00Z" }] }, now);
  assert.ok(winter.includes("07:00"));
  assert.ok(summer.includes("08:00"));
  const offset = formatTelegramStatus({ ...input, timezone: "Asia/Kolkata", reminders: [{ ...baseReminder, dueAt: "2026-10-11T23:30:00Z" }] }, now);
  assert.ok(offset.includes("12 Oct 2026"));
  assert.ok(offset.includes("05:00"));
  const fallback = formatTelegramStatus({ ...input, timezone: "Not/A_Timezone" }, now);
  assert.ok(fallback.includes("UTC"));
  assert.ok(fallback.includes("12:00"));
  assert.ok(!fallback.includes("NaN"));
  assert.ok(!fallback.includes("not-a-date"));
});

test("status selects actual latest completions and nearest scheduled reminder without stale questions", () => {
  const jobs: Job[] = [
    { ...baseJob, command: "old-result", status: "succeeded" },
    { ...baseJob, command: "latest-result", status: "failed", completion: { executorId: "mac", jobId: baseJob.jobId, status: "failed", exitCode: 9, output: "private output", truncated: false, finishedAt: "2026-10-11T11:59:00Z" } },
  ];
  const reminders = [{ ...baseReminder, text: "later-reminder", dueAt: "2026-12-11T12:00:00Z" }, { ...baseReminder, text: "near-reminder" }, { ...baseReminder, text: "cancelled-reminder", status: "cancelled" as const }];
  const choices: Choice[] = [{ id: "old", question: "stale-question", options: ["A", "B"], status: "answered", channel: "telegram", sessionId: "2", createdAt: "2026-10-10T10:00:00Z" }];
  const output = formatTelegramStatus({ jobs, reminders, choices, executors: [], timezone: "UTC" }, now);
  assert.ok(output.indexOf("latest-result") < output.indexOf("old-result"));
  assert.ok(output.indexOf("near-reminder") < output.indexOf("later-reminder"));
  assert.ok(!output.includes("cancelled-reminder"));
  assert.ok(!output.includes("stale-question"));
  assert.ok(!output.includes("private output"));
});
