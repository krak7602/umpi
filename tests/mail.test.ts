import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { Buffer } from "node:buffer";
import { GMAIL_SCOPES, MAIL_SYNC_MESSAGE_BATCH_LIMIT, readGmailChanges, type GmailSyncContinuation, type GmailSyncResult, type GmailThreadSnapshot } from "../src/worker/gmail.js";
import { MailStore } from "../src/worker/mail-store.js";
import { MailRuntime } from "../src/worker/mail-runtime.js";
import { enqueueMailControls, handleMailCallback } from "../src/worker/mail-telegram.js";
import { ProactiveStore } from "../src/worker/proactive-store.js";
import { StateError, Store, type Database } from "../src/worker/store.js";
import { authorize } from "../src/worker/transport.js";

const NOW = Date.parse("2027-04-15T12:00:00Z");
const AFTER = "2027-04-01T12:00:00.000Z";
const credentials = JSON.stringify({ clientId: "fixture-client", clientSecret: "fixture-secret", refreshToken: "fixture-refresh" });
function payload(from: string, subject: string, text = "") {
  return { mimeType: "text/plain", headers: [{ name: "From", value: from }, { name: "Subject", value: subject }], body: { data: Buffer.from(text).toString("base64url") } };
}
function message(id: string, threadId: string, time: string, labelIds: string[], from = "Sender <sender@example.test>", subject = "Fixture subject", text = "Fixture body") {
  return { id, threadId, internalDate: String(Date.parse(time)), labelIds, snippet: text, payload: payload(from, subject, text) };
}
interface GmailPage { ids: string[]; nextPageToken?: string; historyId?: string }
function gmailTransport(rows: Record<string, ReturnType<typeof message>>, options: {
  history?: string[]; list?: string[]; historyStatus?: number; nextPageToken?: string;
  listPages?: Record<string, GmailPage>; historyPages?: Record<string, GmailPage>; fullMessageCalls?: string[]; oversizedFullMessageIds?: Set<string>;
} = {}): typeof fetch {
  return async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.hostname === "oauth2.googleapis.com") {
      assert.equal(init.method, "POST");
      return Response.json({ access_token: "fixture-access" });
    }
    assert.equal(url.hostname, "gmail.googleapis.com");
    assert.equal(new Headers(init.headers).get("Authorization"), "Bearer fixture-access");
    if (url.pathname.endsWith("/profile")) return Response.json({ historyId: "200" });
    if (url.pathname.endsWith("/messages")) {
      const page = options.listPages?.[url.searchParams.get("pageToken") ?? "first"];
      return Response.json({ messages: (page?.ids ?? options.list ?? Object.keys(rows)).map(id => ({ id })),
        ...(page?.nextPageToken ?? options.nextPageToken ? { nextPageToken: page?.nextPageToken ?? options.nextPageToken } : {}) });
    }
    if (url.pathname.endsWith("/history")) {
      if (options.historyStatus) return new Response("expired", { status: options.historyStatus });
      const page = options.historyPages?.[url.searchParams.get("pageToken") ?? "first"];
      return Response.json({ history: [{ messagesAdded: (page?.ids ?? options.history ?? []).map(id => ({ message: { id } })) }],
        historyId: page?.historyId ?? "200", ...(page?.nextPageToken ? { nextPageToken: page.nextPageToken } : {}) });
    }
    const threadMatch = /\/threads\/([^/]+)$/.exec(url.pathname);
    if (threadMatch) {
      const threadId = decodeURIComponent(threadMatch[1]!);
      assert.match(url.searchParams.get("fields") ?? "", /^messages\(/);
      return Response.json({ id: threadId, messages: Object.values(rows).filter(row => row.threadId === threadId) });
    }
    const messageMatch = /\/messages\/([^/]+)$/.exec(url.pathname);
    if (messageMatch) {
      const id = decodeURIComponent(messageMatch[1]!);
      if (url.searchParams.get("format") === "full") options.fullMessageCalls?.push(id);
      const row = rows[id];
      if (url.searchParams.get("format") === "full" && options.oversizedFullMessageIds?.has(id)) {
        return Response.json({ ...row, payload: payload(row?.payload.headers[0]?.value ?? "Sender", row?.payload.headers[1]?.value ?? "Subject", "x".repeat(400_000)) });
      }
      return row ? Response.json(row) : new Response("missing", { status: 404 });
    }
    throw new Error(`Unexpected fixture URL ${url.pathname}`);
  };
}

test("Gmail bootstrap is read-only, applies the exact local cutoff, and never exposes authorization failures", async () => {
  let calls = 0;
  const unavailable = await readGmailChanges(undefined, { mode: "bootstrap", after: AFTER }, NOW, async () => { calls++; throw new Error("must not fetch"); });
  assert.equal(calls, 0); assert.equal(unavailable.status, "unavailable");
  assert.doesNotMatch(JSON.stringify(unavailable), /fixture|token|account/i);

  const rows = {
    old: message("old", "thread-old", "2027-04-01T11:59:59Z", ["INBOX", "UNREAD"], "Old <old@example.test>", "Before boundary"),
    incoming: message("incoming", "thread-current", "2027-04-10T09:00:00Z", ["INBOX", "UNREAD", "IMPORTANT"], "Current <current@example.test>", "Action needed", "Could you confirm by Friday?"),
    sent: message("sent", "thread-current", "2027-04-09T09:00:00Z", ["SENT"], "Owner <owner@example.test>", "Re: Action needed", "Earlier reply"),
  };
  const fullMessageCalls: string[] = [];
  const result = await readGmailChanges(credentials, { mode: "bootstrap", after: AFTER }, NOW, gmailTransport(rows, { fullMessageCalls }));
  assert.equal(result.status, "complete"); assert.equal(result.historyId, "200"); assert.equal(result.threads.length, 1);
  assert.equal(result.threads[0]?.subject, "Action needed"); assert.equal(result.threads[0]?.awaitingReply, true);
  assert.equal(result.threads[0]?.messages.length, 2); assert.equal(result.threads[0]?.messages[0]?.excerpt, "Earlier reply");
  assert.equal(result.threads[0]?.messages[1]?.excerpt, "Could you confirm by Friday?"); assert.deepEqual(fullMessageCalls, ["incoming"]);
  assert.equal(GMAIL_SCOPES.length, 1); assert.ok(GMAIL_SCOPES[0]?.endsWith("gmail.readonly"));
});
test("oversized latest message bodies retain bounded Gmail snippets instead of blocking cursor progress", async () => {
  const row = message("large", "large-thread", "2027-04-10T09:00:00Z", ["INBOX", "UNREAD"], "Sender <sender@example.test>", "Large fixture", "Bounded provider snippet");
  const result = await readGmailChanges(credentials, { mode: "bootstrap", after: AFTER }, NOW,
    gmailTransport({ large: row }, { oversizedFullMessageIds: new Set(["large"]) }));
  assert.equal(result.status, "complete"); assert.equal(result.historyId, "200");
  assert.equal(result.threads[0]?.messages[0]?.excerpt, "Bounded provider snippet");
});


test("bootstrap and incremental scans durably drain every bounded batch before advancing the history cursor", async () => {
  const rows: Record<string, ReturnType<typeof message>> = {};
  for (let index = 0; index < MAIL_SYNC_MESSAGE_BATCH_LIMIT + 1; index++) {
    const id = `m${index}`, thread = `t${index}`;
    rows[id] = message(id, thread, new Date(NOW - index * 1_000).toISOString(), ["INBOX", "UNREAD"], `Sender ${index} <sender${index}@example.test>`, `Subject ${index}`);
  }
  const firstIds = Object.keys(rows).slice(0, MAIL_SYNC_MESSAGE_BATCH_LIMIT), lastIds = Object.keys(rows).slice(MAIL_SYNC_MESSAGE_BATCH_LIMIT);
  const transport = gmailTransport(rows, { listPages: { first: { ids: firstIds, nextPageToken: "page-2" }, "page-2": { ids: lastIds } } });
  const first = await readGmailChanges(credentials, { mode: "bootstrap", after: AFTER }, NOW, transport);
  assert.equal(first.status, "partial"); assert.equal(first.historyId, null); assert.equal(first.threads.length, MAIL_SYNC_MESSAGE_BATCH_LIMIT);
  assert.equal(first.continuation?.pageToken, "page-2");
  const second = await readGmailChanges(credentials, { mode: "bootstrap", after: AFTER, continuation: first.continuation! }, NOW, transport);
  assert.equal(second.status, "complete"); assert.equal(second.historyId, "200"); assert.equal(second.continuation, null); assert.equal(second.threads.length, 1);
  assert.equal(new Set([...first.threads, ...second.threads].map(thread => thread.id)).size, MAIL_SYNC_MESSAGE_BATCH_LIMIT + 1);

  const incremental = await readGmailChanges(credentials, { mode: "incremental", after: AFTER, historyId: "100" }, NOW,
    gmailTransport(rows, { history: [...Object.keys(rows), "m0"] }));
  assert.equal(incremental.status, "partial"); assert.equal(incremental.historyId, null); assert.equal(incremental.threads.length, MAIL_SYNC_MESSAGE_BATCH_LIMIT);
  assert.equal(incremental.continuation?.pendingMessageIds.length, 1);
  const incrementalFinal = await readGmailChanges(credentials, { mode: "incremental", after: AFTER, historyId: "100", continuation: incremental.continuation! }, NOW,
    gmailTransport(rows));
  assert.equal(incrementalFinal.status, "complete"); assert.equal(incrementalFinal.historyId, "200"); assert.equal(incrementalFinal.threads.length, 1);

  const expired = await readGmailChanges(credentials, { mode: "incremental", after: AFTER, historyId: "100" }, NOW,
    gmailTransport({}, { historyStatus: 404 }));
  assert.equal(expired.status, "cursor_expired"); assert.equal(expired.threads.length, 0);
  assert.match(expired.issues[0]!, /re-bootstrap/);
});

interface Fixture { owner: Store; proactive: ProactiveStore; mail: MailStore; runtime: MailRuntime; readonly wakes: number; time(now: number): void }
function fixture(t: TestContext, enableMail = true, beforeMail?: (db: Database, proactive: ProactiveStore) => void): Fixture {
  const sqlite = new DatabaseSync(":memory:"); let depth = 0;
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  const db: Database = {
    all: <T extends object>(query: string, ...bindings: (string | number | null)[]) => sqlite.prepare(query).all(...bindings) as T[],
    transaction<T>(run: () => T): T {
      const name = `mail_${depth++}`; sqlite.exec(`SAVEPOINT ${name}`);
      try { const value = run(); sqlite.exec(`RELEASE ${name}`); return value; }
      catch (error) { sqlite.exec(`ROLLBACK TO ${name}; RELEASE ${name}`); throw error; }
      finally { depth--; }
    },
  };
  const owner = new Store(db); owner.setSession("telegram", "mail-owner"); owner.registerBackgroundSession("mail-review", "telegram");
  const proactive = new ProactiveStore(owner, "UTC"); proactive.configure({ expectedVersion: 1, enabled: true, quietHours: null }, NOW);
  beforeMail?.(db, proactive);
  const mail = new MailStore(proactive);
  if (enableMail) mail.configure({ expectedVersion: 1, enabled: true, lookbackDays: 14, pollMinutes: 30 }, "mail-owner", NOW);
  let wakes = 0; const runtime = new MailRuntime(mail, undefined, async () => { wakes++; });
  t.after(() => sqlite.close());
  return { owner, proactive, mail, runtime, get wakes() { return wakes; }, time(now) { t.mock.timers.setTime(now); } };
}
function snapshot(changes: Partial<GmailThreadSnapshot> = {}): GmailThreadSnapshot {
  return {
    id: "provider-thread", versionKey: "incoming-1:none", subject: "Fixture action", sender: "Sender <sender@example.test>",
    receivedAt: "2027-04-10T09:00:00.000Z", lastIncomingAt: "2027-04-10T09:00:00.000Z", lastOutgoingAt: null,
    unread: true, important: true, awaitingReply: true, webUrl: "https://mail.google.com/mail/u/0/#all/provider-thread",
    messages: [{ id: "incoming-1", sentAt: "2027-04-10T09:00:00.000Z", direction: "incoming", from: "Sender <sender@example.test>", subject: "Fixture action", excerpt: "Please confirm." }],
    ...changes,
  };
}
function syncResult(thread: GmailThreadSnapshot, historyId = "200"): GmailSyncResult {
  return { status: "complete", checkedAt: new Date(Date.now()).toISOString(), historyId, continuation: null, threads: [thread], discovered: 1, issues: [] };
}
function openReview(f: Fixture) {
  f.proactive.drive(Date.now(), false, { telegram: "mail-review" });
  const run = f.proactive.runForSession("mail-review")!;
  f.owner.submitted(run.operationId);
  const input = f.mail.reviewInputs("mail-review") as { threads: { id: string; version: number; subject: string }[] };
  return { run, input };
}

test("durable mail state fixes the bootstrap boundary, deduplicates evidence, and reopens only for new incoming mail", t => {
  const f = fixture(t), settingsVersion = f.mail.settings().version;
  const tooOld = snapshot({ id: "old-provider", versionKey: "old:none", receivedAt: "2027-03-20T09:00:00.000Z", lastIncomingAt: "2027-03-20T09:00:00.000Z" });
  assert.deepEqual(f.mail.applySync(settingsVersion, syncResult(tooOld), NOW), { changed: 0, pending: 0 });
  assert.equal(f.mail.meta().bootstrapAfter, "2027-04-01T12:00:00.000Z");

  assert.deepEqual(f.mail.applySync(settingsVersion, syncResult(snapshot()), NOW), { changed: 1, pending: 1 });
  assert.deepEqual(f.mail.applySync(settingsVersion, syncResult(snapshot()), NOW), { changed: 0, pending: 1 });
  const { run, input } = openReview(f), item = input.threads[0]!;
  f.mail.commitReview("mail-review", [{ id: item.id, expectedVersion: item.version, outcome: "notify", summary: "A reply is requested.", reason: "The sender asked for confirmation.", suggestedAction: "Review and answer." }]);
  const finish = f.mail.finishInput("mail-review", { outcome: "completed", note: "model text is not authoritative" });
  const notification = String(finish.notification);
  assert.equal(finish.outcome, "advanced"); assert.match(notification, /^1 email may need you/);
  assert.match(notification, /Sender • Apr 10, 9:00 AM/); assert.match(notification, /Review and answer\./); assert.match(notification, /Open \/mail/);
  assert.doesNotMatch(notification, /sender@example|From:|Received:|Why:|Next:/);
  f.proactive.report("mail-review", finish); f.owner.settle(run.operationId, "");
  assert.equal(f.owner.deliveries().filter(delivery => delivery.groupId.startsWith("proactive:")).length, 1, "one digest, not one alert per message");

  const attention = f.mail.attention()[0]!; f.mail.markHandled(attention.id, attention.version);
  assert.deepEqual(f.mail.applySync(settingsVersion, syncResult(snapshot()), NOW), { changed: 0, pending: 0 });
  const later = snapshot({ versionKey: "incoming-2:none", receivedAt: "2027-04-15T13:00:00.000Z", lastIncomingAt: "2027-04-15T13:00:00.000Z",
    messages: [{ ...snapshot().messages[0]!, id: "incoming-2", sentAt: "2027-04-15T13:00:00.000Z", excerpt: "Following up." }] });
  assert.deepEqual(f.mail.applySync(settingsVersion, syncResult(later, "201"), NOW), { changed: 1, pending: 1 });
  const resolved = { ...later, versionKey: "incoming-2:sent-2", lastOutgoingAt: "2027-04-15T13:05:00.000Z", awaitingReply: false,
    messages: [...later.messages, { id: "sent-2", sentAt: "2027-04-15T13:05:00.000Z", direction: "outgoing" as const, from: "Owner", subject: "Re: Fixture action", excerpt: "Confirmed." }] };
  assert.deepEqual(f.mail.applySync(settingsVersion, syncResult(resolved, "202"), NOW), { changed: 1, pending: 0 });
});
test("legacy capped state reuses its fixed boundary and restarts as a resumable scan", t => {
  const f = fixture(t, false, db => {
    db.all("CREATE TABLE umpi_mail_meta (id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL)");
    db.all("INSERT INTO umpi_mail_meta VALUES (1,?)", JSON.stringify({
      settings: { version: 2, enabled: true, lookbackDays: 7, pollMinutes: 30 }, bootstrapAfter: AFTER,
      historyId: "200", bootstrapped: true, nextSyncAt: NOW + 60_000, lastSyncAt: new Date(NOW).toISOString(),
      lastStatus: "partial", issue: "legacy capped scan", truncated: true,
    }));
  });
  const meta = f.mail.meta();
  assert.equal(meta.scanVersion, 2); assert.equal(meta.bootstrapAfter, AFTER);
  assert.equal(meta.historyId, null); assert.equal(meta.continuation, null); assert.equal(meta.bootstrapped, false);
  assert.equal(meta.nextSyncAt, NOW); assert.equal(meta.issue, null);
});

test("resumable scan waits for completion and multi-batch triage emits one aggregate digest", t => {
  const f = fixture(t), settingsVersion = f.mail.settings().version;
  const threads = Array.from({ length: MAIL_SYNC_MESSAGE_BATCH_LIMIT + 1 }, (_, index) => snapshot({
    id: `provider-${index}`, versionKey: `incoming-${index}:none`, subject: `Fixture action ${index}`,
    messages: [{ ...snapshot().messages[0]!, id: `incoming-${index}`, subject: `Fixture action ${index}` }],
  }));
  const continuation: GmailSyncContinuation = {
    mode: "bootstrap", startHistoryId: "200", resultHistoryId: "200", pageToken: "next-page", pendingMessageIds: [],
  };
  f.mail.applySync(settingsVersion, { status: "partial", checkedAt: new Date(NOW).toISOString(), historyId: null,
    continuation, threads: threads.slice(0, MAIL_SYNC_MESSAGE_BATCH_LIMIT), discovered: MAIL_SYNC_MESSAGE_BATCH_LIMIT,
    issues: ["Gmail scan has more bounded batches; durable progress will continue."] }, NOW);
  assert.equal(f.mail.meta().continuation?.pageToken, "next-page"); assert.equal(f.mail.meta().historyId, null);
  assert.equal(f.mail.meta().nextSyncAt, NOW + 60_000);
  f.mail.applySync(settingsVersion, { status: "unavailable", checkedAt: new Date(NOW + 500).toISOString(), historyId: null,
    continuation: null, threads: [], discovered: 0, issues: ["Gmail is temporarily unavailable."] }, NOW + 500);
  assert.equal(f.mail.meta().continuation?.pageToken, "next-page");
  assert.equal(f.mail.meta().nextSyncAt, NOW + 500 + 5 * 60_000);
  f.proactive.drive(NOW, false, { telegram: "mail-review" });
  assert.equal(f.proactive.runForSession("mail-review"), undefined, "partial provider coverage must not start triage");

  f.mail.applySync(settingsVersion, { status: "complete", checkedAt: new Date(NOW + 1_000).toISOString(), historyId: "200",
    continuation: null, threads: threads.slice(MAIL_SYNC_MESSAGE_BATCH_LIMIT), discovered: 1, issues: [] }, NOW + 1_000);
  f.time(NOW + 1_000);
  const first = openReview(f);
  const firstSubject = first.input.threads[0]!.subject;
  const firstDecisions = first.input.threads.map((item, index) => ({ id: item.id, expectedVersion: item.version,
    outcome: index === 0 ? "notify" as const : "ignore" as const, summary: `Summary ${index}`, reason: `Reason ${index}`, suggestedAction: `Action ${index}` }));
  const firstCommit = f.mail.commitReview("mail-review", firstDecisions) as { morePending: boolean };
  assert.equal(firstCommit.morePending, true);
  const firstFinish = f.mail.finishInput("mail-review", { outcome: "advanced", note: "Triaged batch." });
  assert.equal(firstFinish.notification, undefined);
  f.proactive.report("mail-review", firstFinish); f.owner.settle(first.run.operationId, "");
  assert.equal(f.owner.deliveries().filter(delivery => delivery.groupId.startsWith("proactive:")).length, 0);

  const second = openReview(f), last = second.input.threads[0]!;
  f.mail.commitReview("mail-review", [{ id: last.id, expectedVersion: last.version, outcome: "notify", summary: "Last summary", reason: "Last reason", suggestedAction: "Last action" }]);
  const finalFinish = f.mail.finishInput("mail-review", { outcome: "advanced", note: "Triaged final batch." });
  assert.match(String(finalFinish.notification), new RegExp(firstSubject)); assert.match(String(finalFinish.notification), new RegExp(last.subject));
  f.proactive.report("mail-review", finalFinish); f.owner.settle(second.run.operationId, "");
  assert.equal(f.owner.deliveries().filter(delivery => delivery.groupId.startsWith("proactive:")).length, 1);
});

test("triage is exact and version-bound; owner snooze and handled actions are reversible operational state", t => {
  const f = fixture(t), settingsVersion = f.mail.settings().version;
  f.mail.applySync(settingsVersion, syncResult(snapshot()), NOW);
  const { run, input } = openReview(f), item = input.threads[0]!;
  assert.throws(() => f.mail.commitReview("mail-review", []), /every thread/);
  assert.throws(() => f.mail.commitReview("mail-review", [{ id: item.id, expectedVersion: item.version + 1, outcome: "notify", summary: "Summary", reason: "Reason", suggestedAction: "Action" }]), StateError);
  f.mail.commitReview("mail-review", [{ id: item.id, expectedVersion: item.version, outcome: "notify", summary: "Summary", reason: "Reason", suggestedAction: "Action" }]);
  f.proactive.report("mail-review", f.mail.finishInput("mail-review", { outcome: "advanced", note: "Triaged." }));
  f.owner.settle(run.operationId, "");
  const attention = f.mail.attention()[0]!, snoozed = f.mail.snooze(attention.id, attention.version, new Date(NOW + 86_400_000).toISOString(), NOW);
  assert.equal(snoozed.status, "snoozed"); assert.throws(() => f.mail.markHandled(snoozed.id, attention.version), StateError);
  f.time(NOW + 86_400_000); assert.equal(f.mail.releaseSnoozes(Date.now()), 1);
  const { input: next } = openReview(f), reopened = next.threads[0]!;
  f.mail.commitReview("mail-review", [{ id: reopened.id, expectedVersion: reopened.version, outcome: "notify", summary: "Summary", reason: "Still due", suggestedAction: "Handle it" }]);
  const current = f.mail.attention()[0]!; assert.equal(f.mail.markHandled(current.id, current.version).status, "handled");
  assert.equal(f.mail.attention().length, 0);
});

test("Telegram mail controls bind the confirmed message and exact settings version", async t => {
  const f = fixture(t, false); enqueueMailControls(f.runtime, "mail-menu-fixture");
  const delivery = f.owner.deliveries("mail-menu:mail-menu-fixture")[0]!;
  const start = delivery.replyMarkup?.inline_keyboard.flat().find(button => button.text === "Start with 14 days");
  assert.ok(start);
  await assert.rejects(handleMailCallback(f.runtime, start.callback_data, 7), StateError);
  f.owner.beginDelivery(delivery.id); f.owner.finishDelivery(delivery.id, "sent", undefined, 42);
  const result = await handleMailCallback(f.runtime, start.callback_data, 42);
  assert.match(result?.text ?? "", /fixed 14-day boundary/); assert.deepEqual(result?.replyMarkup, { inline_keyboard: [] });
  assert.equal(f.mail.settings().enabled, true); assert.equal(f.mail.meta().bootstrapAfter, "2027-04-01T12:00:00.000Z");
  assert.ok(f.wakes > 0);
});

test("mail control routes are owner-only and exact-method", async () => {
  const env = { UMPI_CONTROL_TOKEN: "c".repeat(32), UMPI_EXECUTOR_TOKEN: "e".repeat(32) };
  for (const [method, path] of [["GET", "/api/mail"], ["GET", "/api/mail/items"], ["PUT", "/api/mail/settings"], ["POST", "/api/mail/check"],
    ["POST", `/api/mail/items/mail-${"a".repeat(32)}/handled`], ["POST", `/api/mail/items/mail-${"a".repeat(32)}/snooze`]]) {
    await authorize(new Request(`https://example.test${path}`, { method, headers: { authorization: `Bearer ${env.UMPI_CONTROL_TOKEN}` } }), env);
    await assert.rejects(authorize(new Request(`https://example.test${path}`, { method, headers: { authorization: `Bearer ${env.UMPI_EXECUTOR_TOKEN}` } }), env), { status: 401 });
  }
  for (const [method, path] of [["DELETE", "/api/mail"], ["POST", "/api/mail/settings"], ["GET", "/api/mail/check"], ["POST", "/api/mail/items/arbitrary/handled"]]) {
    await assert.rejects(authorize(new Request(`https://example.test${path}`, { method, headers: { authorization: `Bearer ${env.UMPI_CONTROL_TOKEN}` } }), env), { status: 404 });
  }
});

test("mail review waits until quiet hours end instead of creating an expiring digest", t => {
  const f = fixture(t), settings = f.proactive.settings();
  f.proactive.configure({ expectedVersion: settings.version, enabled: true, quietHours: { start: "00:00", end: "13:00" } }, NOW);
  f.mail.applySync(f.mail.settings().version, syncResult(snapshot()), NOW);
  f.proactive.drive(NOW, false, { telegram: "mail-review" });
  assert.equal(f.proactive.runForSession("mail-review"), undefined);
  f.time(Date.parse("2027-04-15T13:00:00Z"));
  f.proactive.drive(Date.now(), false, { telegram: "mail-review" });
  assert.equal(f.proactive.runForSession("mail-review")?.trigger, "event");
});
