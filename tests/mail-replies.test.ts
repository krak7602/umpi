import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { readGmailChanges, type GmailSyncResult, type GmailThreadSnapshot } from "../src/worker/gmail.js";
import { Decisions, type WorkersAi } from "../src/worker/decisions.js";
import { mailReplies } from "../src/worker/mail-replies.js";
import { MailRuntime } from "../src/worker/mail-runtime.js";
import { MailStore } from "../src/worker/mail-store.js";
import { ProactiveStore } from "../src/worker/proactive-store.js";
import { SituationStore } from "../src/worker/situation-store.js";
import { Store, type Database } from "../src/worker/store.js";

const TZ = "Asia/Kolkata";
const REQUEST_AT = "2026-11-02T03:46:16.000Z", REPLY_AT = "2026-11-04T01:09:03.000Z", NOW = Date.parse("2026-11-04T01:30:00Z");
const localId = (providerId: string) => `mail-${createHash("sha256").update(providerId).digest("hex").slice(0, 32)}`;

/** settled: the probability the decision service gives per fact title; "fail" throws like an unavailable service. */
function fixture(t: TestContext, settled: Record<string, number | "fail"> = {}, decide = true) {
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  const sqlite = new DatabaseSync(":memory:"); let depth = 0; t.after(() => sqlite.close());
  const db: Database = {
    all: <T extends object>(query: string, ...bindings: (string | number | null)[]) => sqlite.prepare(query).all(...bindings) as T[],
    transaction<T>(run: () => T): T {
      const name = `f_${depth++}`; sqlite.exec(`SAVEPOINT ${name}`);
      try { const value = run(); sqlite.exec(`RELEASE ${name}`); return value; }
      catch (error) { sqlite.exec(`ROLLBACK TO ${name}; RELEASE ${name}`); throw error; }
      finally { depth--; }
    },
  };
  const owner = new Store(db); owner.setSession("telegram", "owner");
  const proactive = new ProactiveStore(owner, TZ); proactive.configure({ expectedVersion: 1, enabled: true, quietHours: null }, NOW);
  const situation = new SituationStore(db, TZ), mail = new MailStore(proactive, situation);
  mail.configure({ expectedVersion: 1, enabled: true, lookbackDays: 14, pollMinutes: 30 }, "owner", Date.parse("2026-10-30T00:00:00Z"));
  const asked: { title: string; reply: string }[] = [];
  const ai: WorkersAi = { async run(_model, raw) {
    const input = raw as { state: { item: { title: string }; ownerReply: string } };
    asked.push({ title: input.state.item.title, reply: input.state.ownerReply });
    const answer = settled[input.state.item.title] ?? 0.5;
    if (answer === "fail") throw new Error("service down");
    return { answers: { settled: { type: "noul", noul: answer } }, usage: { input_tokens: 300 } };
  } };
  const decisions = new Decisions(db, ai, () => 1_000);
  const runtime = new MailRuntime(mail, undefined, async () => undefined, undefined, undefined, decide ? mailReplies(decisions) : undefined);
  return { mail, situation, runtime, decisions, asked };
}

const request = (id: string, subject: string): GmailThreadSnapshot => ({
  id, versionKey: `${id}-in:none`, subject, sender: "Registry Desk <noreply@registry.example>", receivedAt: REQUEST_AT, lastIncomingAt: REQUEST_AT, lastOutgoingAt: null,
  unread: true, important: true, starred: false, category: "primary", awaitingReply: true, webUrl: `https://mail.google.com/mail/#all/${id}`,
  messages: [{ id: `${id}-in`, sentAt: REQUEST_AT, direction: "incoming", from: "Registry Desk", subject, excerpt: "Please confirm the details of the company ID request, ref 40000001, within 48 hours." }],
});
const answered = (thread: GmailThreadSnapshot, reply = "I confirm the details are correct."): GmailThreadSnapshot => ({
  ...thread, versionKey: `${thread.id}-in:${thread.id}-out`, lastOutgoingAt: REPLY_AT, awaitingReply: false,
  messages: [...thread.messages, { id: `${thread.id}-out`, sentAt: REPLY_AT, direction: "outgoing", from: "Owner", subject: `Re: ${thread.subject}`, excerpt: reply }],
});
const sync = (threads: GmailThreadSnapshot[], historyId: string, at = NOW): GmailSyncResult =>
  ({ status: "complete", checkedAt: new Date(at).toISOString(), historyId, continuation: null, threads, discovered: threads.length, issues: [] });
function observe(situation: SituationStore, threadId: string, fact: { kind: string; key: string; title: string; state: string; dueAt?: string }, at = REQUEST_AT) {
  return situation.observe({ sourceId: threadId, ...fact, happenedAt: at }, { account: "primary", threadId, webUrl: "https://mail.google.com/mail/#all/x", receivedAt: at }, NOW);
}

test("the owner's reply settles the request it answered, and only that; Umpi can see the reply", async t => {
  const f = fixture(t, { "Company ID request": 0.92 });
  const version = f.mail.settings().version, reg = request("reg", "Example Corp (40000001)"), other = request("bill", "Card statement");
  f.mail.applySync("primary", version, sync([reg, other], "100", Date.parse(REQUEST_AT)), Date.parse(REQUEST_AT));
  const thread = localId("reg");
  const req = observe(f.situation, thread, { kind: "update", key: "registry 40000001", title: "Company ID request", state: "awaiting_confirmation" });
  const call = observe(f.situation, thread, { kind: "job", key: "registry verification call", title: "Verification call", state: "interview", dueAt: "2026-11-06T10:00:00+05:30" });
  const bill = observe(f.situation, localId("bill"), { kind: "update", key: "card statement nov", title: "Card statement", state: "pending" });

  // The next sync carries the owner's reply in the same thread.
  f.mail.applySync("primary", version, sync([answered(reg)], "101"), NOW);
  assert.equal(f.mail.thread(thread)?.status, "resolved", "the mail item closes by itself");
  assert.deepEqual(f.mail.thread(thread)?.replyCheck?.factIds, [req.id], "only the open request is checked; the job keeps its state");
  assert.equal(f.situation.fact(call.id)?.ownerReplyAt, REPLY_AT);
  assert.equal(f.situation.fact(bill.id)?.ownerReplyAt, undefined, "facts from other threads are untouched");

  await f.runtime.drive(NOW);
  const settled = f.situation.fact(req.id)!;
  assert.equal(settled.state, "replied");
  assert.deepEqual(settled.history.map(entry => entry.state), ["awaiting_confirmation", "replied"]);
  assert.equal(settled.observedAt, REPLY_AT, "the new state is dated at the reply");
  assert.equal(f.situation.fact(call.id)?.state, "interview", "a reply never changes a job, bill, or booking");
  assert.equal(f.situation.fact(bill.id)?.state, "pending");
  assert.equal(f.mail.thread(thread)?.replyCheck, undefined);
  assert.deepEqual(f.asked, [{ title: "Company ID request", reply: "I confirm the details are correct." }]);

  // The conversation sees the reply in both places it looks.
  const view = (f.situation.read() as { facts: { id: string; ownerRepliedAt?: string; state: string }[] }).facts;
  assert.equal(view.find(fact => fact.id === req.id)?.ownerRepliedAt, REPLY_AT);
  assert.deepEqual(f.mail.recentReplies(NOW), [{ subject: "Example Corp (40000001)", sender: "Registry Desk", repliedAt: REPLY_AT }]);

  // Older mail cannot bring the request back; newer mail from them still moves it on.
  observe(f.situation, thread, { kind: "update", key: "registry 40000001", title: "Company ID request", state: "awaiting_confirmation" });
  assert.equal(f.situation.fact(req.id)?.state, "replied");
  observe(f.situation, thread, { kind: "update", key: "registry 40000001", title: "Company ID request", state: "number_issued" }, "2026-11-06T05:00:00.000Z");
  assert.equal(f.situation.fact(req.id)?.state, "number_issued");
});

test("an unsure answer, a failed or missing decision service, or a newer owner correction leaves the state", async t => {
  for (const [label, settled, decide] of [["unsure", 0.4, true], ["failed", "fail", true], ["no service", 0.99, false]] as const) {
    await t.test(label, async t => {
      const f = fixture(t, { "Company ID request": settled }, decide);
      const version = f.mail.settings().version, reg = request("reg", "Example Corp (40000001)");
      f.mail.applySync("primary", version, sync([reg], "100", Date.parse(REQUEST_AT)), Date.parse(REQUEST_AT));
      const req = observe(f.situation, localId("reg"), { kind: "update", key: "registry 40000001", title: "Company ID request", state: "awaiting_confirmation" });
      f.mail.applySync("primary", version, sync([answered(reg, "Will check and get back to you.")], "101"), NOW);
      await f.runtime.drive(NOW);
      const fact = f.situation.fact(req.id)!;
      assert.equal(fact.state, "awaiting_confirmation");
      assert.equal(fact.ownerReplyAt, REPLY_AT, "the reply is still visible");
      assert.equal(f.mail.thread(localId("reg"))?.replyCheck, undefined, "the check runs once");
    });
  }
  await t.test("owner correction after the reply", async t => {
    const f = fixture(t, { "Company ID request": 0.95 });
    const req = observe(f.situation, localId("reg"), { kind: "update", key: "registry 40000001", title: "Company ID request", state: "awaiting_confirmation" });
    f.situation.correct({ id: req.id, expectedVersion: req.version, state: "on_hold" }, Date.parse(REPLY_AT) + 60_000);
    assert.equal(f.situation.settleByReply(req.id, REPLY_AT, NOW), undefined, "the owner's later word stands");
    assert.equal(f.situation.fact(req.id)?.state, "on_hold");
  });
});

test("Gmail reads the owner's reply in full when it answers the thread, without quoted history", async () => {
  const body = (text: string) => ({ mimeType: "text/plain", headers: [], body: { data: Buffer.from(text).toString("base64url") } });
  const row = (id: string, time: string, labelIds: string[], from: string, text: string) => ({ id, threadId: "reg", internalDate: String(Date.parse(time)), labelIds, snippet: text.slice(0, 40),
    payload: { ...body(text), headers: [{ name: "From", value: from }, { name: "Subject", value: "Example Corp (40000001)" }] } });
  const rows: Record<string, ReturnType<typeof row>> = {
    in: row("in", REQUEST_AT, ["INBOX"], "Registry Desk <noreply@registry.example>", "Please confirm the details."),
    out: row("out", REPLY_AT, ["SENT"], "Owner <owner@example.test>", "I confirm the details are correct.\n\nOn Mon, 2 Nov 2026, Registry Desk wrote:\n> Please confirm the details."),
  };
  const full: string[] = [];
  const fetcher: typeof fetch = async input => {
    const url = new URL(String(input));
    if (url.hostname === "oauth2.googleapis.com") return Response.json({ access_token: "fixture" });
    // Only the reply is new since the cursor: the check sees sent mail through Gmail's history.
    if (url.pathname.endsWith("/history")) return Response.json({ history: [{ messagesAdded: [{ message: { id: "out" } }] }], historyId: "101" });
    if (url.pathname.endsWith("/threads/reg")) return Response.json({ messages: Object.values(rows) });
    const id = decodeURIComponent(url.pathname.split("/").pop()!);
    if (url.searchParams.get("format") === "full") full.push(id);
    return Response.json(rows[id]);
  };
  const result = await readGmailChanges(JSON.stringify({ clientId: "c", clientSecret: "s", refreshToken: "r" }), { mode: "incremental", after: "2026-10-30T00:00:00Z", historyId: "100" }, NOW, fetcher);
  assert.equal(result.status, "complete");
  const thread = result.threads[0]!;
  assert.equal(thread.awaitingReply, false); assert.equal(thread.lastOutgoingAt, REPLY_AT);
  assert.deepEqual(full, ["out"], "the reply is read in full, not the request it answered");
  assert.equal(thread.messages.at(-1)?.direction, "outgoing");
  assert.equal(thread.messages.at(-1)?.excerpt, "I confirm the details are correct.");
});
