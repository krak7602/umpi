import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, StateError, type Database, type Delivery, type Job, type Operation } from "../src/worker/store.js";
import { InputError, MAX_COMMAND_LENGTH } from "../src/shared/protocol.js";

function open(path = ":memory:", seed?: (sqlite: DatabaseSync) => void) {
  const sqlite = new DatabaseSync(path);
  seed?.(sqlite);
  let depth = 0;
  const db: Database = {
    all: <T extends object>(query: string, ...bindings: (string | number | null)[]) => sqlite.prepare(query).all(...bindings) as T[],
    transaction: <T>(run: () => T): T => {
      const savepoint = `telegram_${depth++}`;
      sqlite.exec(`SAVEPOINT ${savepoint}`);
      try { const value = run(); sqlite.exec(`RELEASE ${savepoint}`); return value; }
      catch (error) { sqlite.exec(`ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`); throw error; }
      finally { depth--; }
    },
  };
  const store = new Store(db);
  store.setSession("control", "control-session");
  store.setSession("telegram", "telegram-session");
  return { store, db, sqlite, close: () => sqlite.close() };
}
const assignment = (jobId = "job-1") => ({ jobId, command: "printf hello", cwd: "/workspace", timeoutMs: 10_000, createdAt: new Date().toISOString() });

function confirmGroup(store: Store, groupId: string, firstMessageId = 100): Delivery {
  const parts = store.deliveries(groupId);
  assert.ok(parts.length);
  for (const part of parts) {
    assert.ok(store.beginDelivery(part.id));
    store.finishDelivery(part.id, "sent", undefined, firstMessageId + part.part);
  }
  return store.delivery(parts.at(-1)!.id)!;
}
function button(delivery: Delivery, label: string): string {
  const found = delivery.replyMarkup?.inline_keyboard.flat().find(item => item.text === label);
  assert.ok(found, `Missing button ${label}`);
  return found.callback_data;
}

test("choice input bounds reject unusable labels without superseding a valid pending question", t => {
  const { store, close } = open(); t.after(close);
  const original = store.createChoice("original", "Which day?", ["Monday", "Tuesday"], "telegram", "telegram-session");
  for (const options of [[], ["one"], ["a", "b", "c", "d", "e", "f"], ["", "b"], ["   ", "b"], ["a", "a"], ["a", " a "], ["a", "x".repeat(65)], ["a", "b\0"]]) {
    assert.throws(() => store.createChoice("invalid", "Which day?", options, "telegram", "telegram-session"), InputError);
  }
  for (const question of ["", "   ", "x".repeat(1_025)]) {
    assert.throws(() => store.createChoice("invalid", question, ["a", "b"], "telegram", "telegram-session"), InputError);
  }
  assert.throws(() => store.createChoice("x".repeat(129), "Question", ["a", "b"], "telegram", "telegram-session"), InputError);
  assert.throws(() => store.createChoice("original", "Replacement", ["a", "b"], "telegram", "telegram-session"), StateError);
  assert.deepEqual(store.pendingChoice("telegram-session"), original);
  assert.equal(store.deliveries().length, 1);
  const bounded = store.createChoice("x".repeat(128), "q".repeat(1_024), ["a".repeat(64), "b", "c", "d", "e"], "control", "control-session");
  assert.equal(bounded.options.length, 5);
});

test("control questions remain readable local deliveries and tool replay does not duplicate buttons", t => {
  const { store, db, close } = open(); t.after(close);
  const question = store.createChoice("local", "Pick a day", ["Monday", "Tuesday"], "control", "control-session");
  const delivery = store.deliveries("choice:local")[0]!;
  assert.equal(delivery.channel, "control");
  assert.equal(delivery.status, "sent");
  assert.equal(delivery.replyMarkup, undefined);
  assert.ok(delivery.text.includes(question.question));
  assert.equal(store.readyDeliveries().length, 0);
  const first = store.effect("tool:question", () => store.createChoice("remote", "Which format?", ["Text", "Table"], "telegram", "telegram-session"));
  assert.deepEqual(store.effect("tool:question", () => { throw new Error("must not replay"); }), first);
  assert.equal(store.deliveries("choice:remote").length, 1);
  assert.equal(db.all<{ count: number }>("SELECT COUNT(*) AS count FROM umpi_telegram_interactions")[0]!.count, 2);
  store.admit("local-answer", "Monday", "control", "control-session");
  assert.equal(store.pendingChoice("control-session"), undefined);
  assert.equal(store.pendingChoice("telegram-session")?.id, "remote");
});

test("maximum-length commands and identifiers keep exact review text and only the last ordered chunk carries opaque buttons", t => {
  const { store, close } = open(); t.after(close);
  const jobId = "j".repeat(128);
  const command = "x" + "😀".repeat(MAX_COMMAND_LENGTH / 2 - 1) + "z";
  const job = store.createJob({ ...assignment(jobId), command }, "telegram", "telegram-session");
  const group = `approval:${jobId}:1`;
  const parts = store.deliveries(group);
  const final = parts.at(-1)!;
  const text = parts.map(part => part.text).join("");
  assert.ok(parts.length > 1);
  assert.ok(text.includes(command));
  assert.ok(text.includes(job.cwd));
  assert.ok(parts.slice(0, -1).every(part => part.replyMarkup === undefined));
  const reviewedCommand = parts.flatMap(part => (part.entities ?? []).filter(entity => entity.type === "pre").map(entity => {
    assert.ok(entity.offset >= 0 && entity.length > 0 && entity.offset + entity.length <= part.text.length);
    const fragment = part.text.slice(entity.offset, entity.offset + entity.length);
    assert.ok(!/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/.test(fragment));
    return fragment;
  })).join("");
  assert.equal(reviewedCommand, command);
  const tokens = final.replyMarkup!.inline_keyboard.flat().map(item => item.callback_data);
  assert.equal(tokens.length, 2);
  assert.notEqual(tokens[0], tokens[1]);
  assert.ok(tokens.every(token => Buffer.byteLength(token, "utf8") <= 64 && !token.includes(jobId)));
  assert.equal(store.beginDelivery(final.id), undefined);
  assert.deepEqual(store.readyDeliveries().map(part => part.id), [parts[0]!.id]);
  for (const part of parts) {
    assert.deepEqual(store.readyDeliveries().map(ready => ready.id), [part.id]);
    assert.ok(store.beginDelivery(part.id));
    assert.equal(store.readyDeliveries().length, 0);
    store.finishDelivery(part.id, "sent", undefined, 100 + part.part);
  }
  assert.throws(() => store.resolveTelegramCallback(tokens[0]!, 100), StateError);
  store.resolveTelegramCallback(tokens[0]!, 100 + final.part);
  assert.equal(store.job(jobId)?.status, "queued");
  store.createJob(assignment("control-job"), "control", "control-session");
  assert.ok(store.deliveries("approval:control-job:1").every(part => part.replyMarkup === undefined && part.status === "sent"));
});

test("unknown, unconfirmed, cross-message and malformed callback bindings cannot mutate a job", t => {
  const { store, close } = open(); t.after(close);
  store.createJob(assignment(), "telegram", "telegram-session");
  const card = store.deliveries("approval:job-1:1")[0]!;
  const token = button(card, "Approve");
  for (const messageId of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1, 101]) {
    assert.throws(() => store.resolveTelegramCallback(token, messageId), StateError);
  }
  assert.throws(() => store.resolveTelegramCallback("unknown", 101), StateError);
  assert.throws(() => store.resolveTelegramCallback("x".repeat(65), 101), StateError);
  store.beginDelivery(card.id);
  assert.throws(() => store.resolveTelegramCallback(token, 101), StateError);
  store.finishDelivery(card.id, "sent");
  assert.throws(() => store.resolveTelegramCallback(token, 101), StateError);
  assert.equal(store.job("job-1")?.status, "pending_approval");

  for (const status of ["failed", "uncertain"] as const) {
    store.createJob(assignment(status), "telegram", "telegram-session");
    const unsent = store.deliveries(`approval:${status}:1`)[0]!;
    store.beginDelivery(unsent.id); store.finishDelivery(unsent.id, status, "Unconfirmed", 102);
    assert.throws(() => store.resolveTelegramCallback(button(unsent, "Approve"), 102), StateError);
    assert.equal(store.job(status)?.status, "pending_approval");
  }
  store.createJob(assignment("confirmed"), "telegram", "telegram-session");
  const confirmed = confirmGroup(store, "approval:confirmed:1", 103);
  assert.throws(() => store.resolveTelegramCallback(button(confirmed, "Approve"), 104), StateError);
  assert.throws(() => store.resolveTelegramCallback(token, 103), StateError);
  store.resolveTelegramCallback(button(confirmed, "Approve"), 103);
  assert.equal(store.job("confirmed")?.status, "queued");
});

test("job callbacks are version-bound even on replay and cancellation feedback is admitted once", t => {
  const { store, close } = open(); t.after(close);
  store.createJob(assignment(), "telegram", "telegram-session");
  const first = confirmGroup(store, "approval:job-1:1", 110);
  const approve = button(first, "Approve");
  const cancel = button(first, "Cancel");
  const approved = store.resolveTelegramCallback(approve, 110);
  assert.deepEqual(approved.replyMarkup.inline_keyboard.flat().map(item => item.callback_data), [cancel]);
  const approvedAt = store.job("job-1")?.approvedAt;
  assert.deepEqual(store.resolveTelegramCallback(approve, 110), approved);
  assert.equal(store.job("job-1")?.approvedAt, approvedAt);
  store.updateJob("job-1", 1, { command: "printf corrected", cwd: "/workspace", timeoutMs: 12_000 });
  assert.throws(() => store.resolveTelegramCallback(approve, 110), StateError);
  assert.throws(() => store.resolveTelegramCallback(cancel, 110), StateError);
  assert.equal(store.job("job-1")?.status, "pending_approval");
  assert.equal(store.job("job-1")?.approvedAt, undefined);
  const second = confirmGroup(store, "approval:job-1:2", 111);
  assert.notEqual(button(second, "Approve"), approve);
  const cancelled = store.resolveTelegramCallback(button(second, "Cancel"), 111);
  assert.deepEqual(cancelled.replyMarkup, { inline_keyboard: [] });
  assert.deepEqual(store.resolveTelegramCallback(button(second, "Cancel"), 111), cancelled);
  assert.throws(() => store.resolveTelegramCallback(button(second, "Approve"), 111), StateError);
  assert.equal(store.pendingOperations().filter(op => op.id === "job:job-1:completion").length, 1);
  assert.equal(store.poll({ executorId: "mac", workspaces: ["/workspace"] }).job, null);
});

test("running cancellation keeps executor ownership and waits for truthful completion across repeated clicks", t => {
  const { store, close } = open(); t.after(close);
  store.createJob(assignment(), "telegram", "telegram-session");
  const card = confirmGroup(store, "approval:job-1:1", 120);
  store.resolveTelegramCallback(button(card, "Approve"), 120);
  store.poll({ executorId: "mac", workspaces: ["/workspace"] });
  const result = store.resolveTelegramCallback(button(card, "Cancel"), 120);
  assert.deepEqual(result.replyMarkup, { inline_keyboard: [] });
  assert.deepEqual(store.resolveTelegramCallback(button(card, "Cancel"), 120), result);
  assert.equal(store.job("job-1")?.status, "running");
  assert.equal(store.job("job-1")?.executorId, "mac");
  assert.equal(store.job("job-1")?.cancelRequested, true);
  assert.equal(store.operation("job:job-1:completion"), undefined);
  assert.deepEqual(store.poll({ executorId: "mac", workspaces: ["/workspace"] }).cancelJobIds, ["job-1"]);
  store.complete({ executorId: "mac", jobId: "job-1", status: "succeeded", exitCode: 0, output: "hello", truncated: false, finishedAt: new Date().toISOString() });
  assert.equal(store.job("job-1")?.status, "succeeded");
  assert.equal(store.job("job-1")?.cancelRequested, false);
  assert.deepEqual(store.resolveTelegramCallback(button(card, "Approve"), 120).replyMarkup, { inline_keyboard: [] });
  assert.deepEqual(store.resolveTelegramCallback(button(card, "Cancel"), 120).replyMarkup, { inline_keyboard: [] });
  assert.equal(store.pendingOperations().filter(op => op.id === "job:job-1:completion").length, 1);
});

test("a discrete selection admits one contextual operation, rejects conflicts and never authorizes execution", t => {
  const { store, close } = open(); t.after(close);
  store.createJob(assignment(), "telegram", "telegram-session");
  const choice = store.createChoice("decision", "How should I describe the action?", ["Approve", "Cancel"], "telegram", "telegram-session");
  const card = confirmGroup(store, "choice:decision", 130);
  const selected = store.resolveTelegramCallback(button(card, "Approve"), 130);
  assert.equal(selected.operationId, "choice:decision:answer");
  assert.deepEqual(selected.replyMarkup, { inline_keyboard: [] });
  const op = store.operation(selected.operationId!)!;
  assert.equal(op.status, "admitted");
  assert.ok(op.text.includes(choice.question) && op.text.includes("Approve"));
  assert.deepEqual(store.resolveTelegramCallback(button(card, "Approve"), 130), selected);
  assert.throws(() => store.resolveTelegramCallback(button(card, "Cancel"), 130), StateError);
  assert.equal(store.pendingOperations().filter(item => item.id === op.id).length, 1);
  assert.equal(store.job("job-1")?.status, "pending_approval");
  store.settle(op.id, "Noted");
  store.resolveTelegramCallback(button(card, "Approve"), 130);
  assert.equal(store.operation(op.id)?.status, "done");
  assert.equal(store.deliveries(`answer:${op.id}`).length, 1);
});

test("free text answers preserve admission identity and carry durable question context without a second operation", t => {
  const { store, close } = open(); t.after(close);
  const earlier = store.admit("earlier", "hello", "telegram", "telegram-session");
  store.createChoice("day", "Which day should I use?", ["Monday", "Tuesday"], "telegram", "telegram-session");
  const card = confirmGroup(store, "choice:day", 140);
  assert.deepEqual(store.admit("earlier", "hello", "telegram", "telegram-session"), earlier);
  assert.throws(() => store.admit("earlier", "changed", "telegram", "telegram-session"), StateError);
  assert.equal(store.pendingChoice("telegram-session")?.id, "day");
  const text = "  Tuesday, but after lunch.\nPlease use local time.  ";
  const op = store.admit("answer", text, "telegram", "telegram-session");
  assert.equal(op.text, text);
  assert.ok(op.modelInput?.includes("Which day should I use?"));
  assert.ok(op.modelInput?.includes("Monday") && op.modelInput.includes("Tuesday"));
  assert.ok(op.modelInput?.endsWith(text));
  assert.equal(store.choices().find(choice => choice.id === "day")?.answer, text);
  assert.equal(store.pendingChoice("telegram-session"), undefined);
  assert.equal(store.operation("choice:day:answer"), undefined);
  assert.throws(() => store.resolveTelegramCallback(button(card, "Tuesday"), 140), StateError);
  assert.deepEqual(store.admit("answer", text, "telegram", "telegram-session"), op);
  store.createChoice("time", "Which time?", ["One", "Two"], "telegram", "telegram-session");
  assert.deepEqual(store.admit("answer", text, "telegram", "telegram-session"), op);
  assert.equal(store.pendingChoice("telegram-session")?.id, "time");
  assert.equal(store.pendingOperations().length, 2);
});

test("slash commands, other sessions and job completion events do not consume pending questions", t => {
  const { store, close } = open(); t.after(close);
  store.createChoice("question", "Which project?", ["First", "Second"], "telegram", "telegram-session");
  const card = confirmGroup(store, "choice:question", 150);
  const slash = store.admit("slash", " /status", "telegram", "telegram-session");
  assert.equal(slash.modelInput, undefined);
  store.admit("other", "First", "control", "control-session");
  store.createJob(assignment(), "telegram", "telegram-session");
  store.cancelJob("job-1", 1);
  assert.equal(store.operation("job:job-1:completion")?.status, "admitted");
  assert.equal(store.pendingChoice("telegram-session")?.id, "question");
  store.admit("answer", "First", "telegram", "telegram-session");
  assert.throws(() => store.resolveTelegramCallback(button(card, "First"), 150), StateError);
});

test("new questions invalidate prior buttons including duplicate answers and isolate sessions", t => {
  const { store, close } = open(); t.after(close);
  store.createChoice("old", "Original question?", ["Yes", "No"], "telegram", "telegram-session");
  const old = confirmGroup(store, "choice:old", 160);
  store.createChoice("local", "Local question?", ["One", "Two"], "control", "control-session");
  assert.equal(store.pendingChoice("telegram-session")?.id, "old");
  store.createChoice("new", "New question?", ["A", "B"], "telegram", "telegram-session");
  assert.equal(store.choices().find(choice => choice.id === "old")?.status, "superseded");
  assert.throws(() => store.resolveTelegramCallback(button(old, "Yes"), 160), StateError);
  const latest = confirmGroup(store, "choice:new", 161);
  store.resolveTelegramCallback(button(latest, "A"), 161);
  store.createChoice("newest", "Another question?", ["C", "D"], "telegram", "telegram-session");
  assert.throws(() => store.resolveTelegramCallback(button(latest, "A"), 161), StateError);
  assert.equal(store.pendingChoice("telegram-session")?.id, "newest");
  assert.equal(store.pendingChoice("control-session")?.id, "local");
});

test("choice history bounds do not hide old pending questions from resolution or supersession", t => {
  const { store, close } = open(); t.after(close);
  store.createChoice("old-pending", "Old pending question?", ["A", "B"], "telegram", "telegram-session");
  for (let index = 0; index < 101; index++) store.createChoice(`other-${index}`, "Another session?", ["C", "D"], "control", "control-session");
  assert.equal(store.choices().length, 100);
  assert.equal(store.pendingChoice("telegram-session")?.id, "old-pending");
  const answer = store.admit("old-answer", "A", "telegram", "telegram-session");
  assert.ok(answer.modelInput?.includes("Old pending question?"));
  assert.equal(store.pendingChoice("telegram-session"), undefined);
  store.createChoice("supersede-me", "Pending again?", ["A", "B"], "telegram", "telegram-session");
  const oldCard = confirmGroup(store, "choice:supersede-me", 170);
  for (let index = 101; index < 202; index++) store.createChoice(`other-${index}`, "Another session?", ["C", "D"], "control", "control-session");
  store.createChoice("replacement", "Replacement?", ["E", "F"], "telegram", "telegram-session");
  assert.throws(() => store.resolveTelegramCallback(button(oldCard, "A"), 170), StateError);
  assert.equal(store.pendingChoice("telegram-session")?.id, "replacement");
});

test("callback admission and free-text admission roll back choice resolution when operation persistence fails", t => {
  const { store, sqlite, close } = open(); t.after(close);
  store.createChoice("atomic", "Choose one", ["A", "B"], "telegram", "telegram-session");
  const card = confirmGroup(store, "choice:atomic", 180);
  sqlite.exec("CREATE TRIGGER reject_operation BEFORE INSERT ON umpi_operations BEGIN SELECT RAISE(ABORT, 'injected failure'); END");
  assert.throws(() => store.resolveTelegramCallback(button(card, "A"), 180));
  assert.equal(store.pendingChoice("telegram-session")?.id, "atomic");
  assert.equal(store.operation("choice:atomic:answer"), undefined);
  assert.throws(() => store.admit("text", "A", "telegram", "telegram-session"));
  assert.equal(store.pendingChoice("telegram-session")?.id, "atomic");
  sqlite.exec("DROP TRIGGER reject_operation");
  const result = store.resolveTelegramCallback(button(card, "B"), 180);
  assert.equal(store.operation(result.operationId!)?.status, "admitted");
  assert.equal(store.choices()[0]?.answer, "B");
  assert.throws(() => store.resolveTelegramCallback(button(card, "A"), 180), StateError);
});

test("card creation atomically commits job or choice state, tokens and every outbox chunk", t => {
  const { store, db, sqlite, close } = open(); t.after(close);
  store.createChoice("original", "Original?", ["A", "B"], "telegram", "telegram-session");
  sqlite.exec("CREATE TRIGGER reject_card BEFORE INSERT ON umpi_outbox WHEN NEW.group_id != 'choice:original' BEGIN SELECT RAISE(ABORT, 'injected failure'); END");
  assert.throws(() => store.createJob(assignment(), "telegram", "telegram-session"));
  assert.throws(() => store.createChoice("replacement", "Replacement?", ["C", "D"], "telegram", "telegram-session"));
  assert.equal(store.job("job-1"), undefined);
  assert.equal(store.pendingChoice("telegram-session")?.id, "original");
  assert.equal(store.choices().length, 1);
  assert.equal(store.deliveries().length, 1);
  assert.equal(db.all<{ count: number }>("SELECT COUNT(*) AS count FROM umpi_telegram_interactions")[0]!.count, 2);
  sqlite.exec("DROP TRIGGER reject_card");
  store.createJob(assignment(), "telegram", "telegram-session");
  assert.equal(store.deliveries("approval:job-1:1").length, 1);
  sqlite.exec("CREATE TRIGGER reject_later_chunk BEFORE INSERT ON umpi_outbox WHEN NEW.part > 0 BEGIN SELECT RAISE(ABORT, 'injected failure'); END");
  assert.throws(() => store.updateJob("job-1", 1, { command: "x".repeat(8_000), cwd: "/workspace", timeoutMs: 10_000 }));
  assert.equal(store.job("job-1")?.version, 1);
  assert.equal(store.deliveries("approval:job-1:2").length, 0);
  assert.equal(db.all<{ count: number }>("SELECT COUNT(*) AS count FROM umpi_telegram_interactions")[0]!.count, 4);
});

test("uncertain earlier chunks block the final keyboard even through direct delivery admission", t => {
  const { store, close } = open(); t.after(close);
  store.createJob({ ...assignment(), command: "x".repeat(8_000) }, "telegram", "telegram-session");
  const parts = store.deliveries("approval:job-1:1");
  store.beginDelivery(parts[0]!.id);
  store.recoverDeliveries();
  assert.equal(store.delivery(parts[0]!.id)?.status, "uncertain");
  assert.equal(store.readyDeliveries().length, 0);
  assert.equal(store.beginDelivery(parts.at(-1)!.id), undefined);
  assert.throws(() => store.resolveTelegramCallback(button(parts.at(-1)!, "Approve"), 190), StateError);
  assert.equal(store.job("job-1")?.status, "pending_approval");
});

test("restart retains message-bound tokens, choices, replay results and contextual free-text operations", t => {
  const directory = mkdtempSync(join(tmpdir(), "umpi-telegram-store-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "state.sqlite");
  let opened = open(path);
  opened.store.createJob(assignment(), "telegram", "telegram-session");
  const jobCard = confirmGroup(opened.store, "approval:job-1:1", 200);
  opened.store.createChoice("persist", "Which day?", ["Monday", "Tuesday"], "telegram", "telegram-session");
  const choiceCard = confirmGroup(opened.store, "choice:persist", 201);
  opened.close();
  opened = open(path);
  assert.equal(opened.store.pendingChoice("telegram-session")?.id, "persist");
  opened.store.resolveTelegramCallback(button(jobCard, "Approve"), 200);
  const selected = opened.store.resolveTelegramCallback(button(choiceCard, "Tuesday"), 201);
  opened.close();
  opened = open(path);
  assert.deepEqual(opened.store.resolveTelegramCallback(button(choiceCard, "Tuesday"), 201), selected);
  assert.equal(opened.store.pendingOperations().filter(op => op.id === selected.operationId).length, 1);
  assert.equal(opened.store.job("job-1")?.status, "queued");
  opened.store.createChoice("text", "Which time?", ["Morning", "Evening"], "telegram", "telegram-session");
  const textCard = confirmGroup(opened.store, "choice:text", 202);
  const answer = opened.store.admit("free-text", "After sunset", "telegram", "telegram-session");
  opened.close();
  opened = open(path); t.after(opened.close);
  assert.deepEqual(opened.store.operation(answer.id), answer);
  assert.deepEqual(opened.store.admit("free-text", "After sunset", "telegram", "telegram-session"), answer);
  assert.throws(() => opened.store.resolveTelegramCallback(button(textCard, "Evening"), 202), StateError);
  assert.throws(() => opened.store.resolveTelegramCallback(button(choiceCard, "Tuesday"), 201), StateError);
  assert.equal(opened.store.pendingChoice("telegram-session"), undefined);
});

test("existing pre-interaction job, operation and delivery records remain usable without rewriting old state", t => {
  const legacyJob: Job = { ...assignment("legacy"), channel: "telegram", sessionId: "telegram-session", version: 1, status: "pending_approval", cancelRequested: false };
  const legacyOperation: Operation = { id: "message:telegram:legacy", requestId: "legacy", text: "hello", channel: "telegram", sessionId: "telegram-session", status: "admitted", createdAt: legacyJob.createdAt };
  const legacyDelivery: Delivery = { id: "approval:legacy:1:0", groupId: "approval:legacy:1", part: 0, channel: "telegram", text: "Use /approve legacy 1", status: "sent", messageId: 210, createdAt: legacyJob.createdAt };
  const { store, close } = open(":memory:", sqlite => {
    sqlite.exec("CREATE TABLE umpi_jobs (id TEXT PRIMARY KEY, status TEXT NOT NULL, executor TEXT, cwd TEXT NOT NULL, data TEXT NOT NULL)");
    sqlite.exec("CREATE TABLE umpi_operations (id TEXT PRIMARY KEY, status TEXT NOT NULL, data TEXT NOT NULL)");
    sqlite.exec("CREATE TABLE umpi_outbox (id TEXT PRIMARY KEY, group_id TEXT NOT NULL, part INTEGER NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL)");
    sqlite.prepare("INSERT INTO umpi_jobs VALUES (?, ?, ?, ?, ?)").run(legacyJob.jobId, legacyJob.status, null, legacyJob.cwd, JSON.stringify(legacyJob));
    sqlite.prepare("INSERT INTO umpi_operations VALUES (?, ?, ?)").run(legacyOperation.id, legacyOperation.status, JSON.stringify(legacyOperation));
    sqlite.prepare("INSERT INTO umpi_outbox VALUES (?, ?, ?, ?, ?)").run(legacyDelivery.id, legacyDelivery.groupId, legacyDelivery.part, legacyDelivery.status, JSON.stringify(legacyDelivery));
  });
  t.after(close);
  assert.deepEqual(store.job("legacy"), legacyJob);
  assert.deepEqual(store.admit("legacy", "hello", "telegram", "telegram-session"), legacyOperation);
  assert.deepEqual(store.delivery(legacyDelivery.id), legacyDelivery);
  assert.deepEqual(store.choices(), []);
  assert.throws(() => store.resolveTelegramCallback("legacy", 210), StateError);
  store.approveJob("legacy", 1);
  assert.equal(store.poll({ executorId: "mac", workspaces: ["/workspace"] }).job?.jobId, "legacy");
  store.createChoice("first-new", "New question?", ["Yes", "No"], "telegram", "telegram-session");
  assert.equal(store.pendingChoice("telegram-session")?.id, "first-new");
});

test("bounded status collections prioritize old active jobs and scheduled reminders over newer history", t => {
  const { store, close } = open(); t.after(close);
  store.createJob(assignment("pending"), "control", "control-session");
  store.createJob(assignment("running"), "control", "control-session");
  store.approveJob("running", 1);
  store.poll({ executorId: "mac", workspaces: ["/workspace"] });
  store.createJob(assignment("queued"), "control", "control-session");
  store.approveJob("queued", 1);
  const now = Date.now();
  store.createReminder("later", "Later active reminder", new Date(now + 7_200_000).toISOString(), "control");
  store.createReminder("sooner", "Sooner active reminder", new Date(now + 3_600_000).toISOString(), "control");
  for (let index = 0; index < 101; index++) {
    const id = `history-${index}`;
    store.createJob(assignment(id), "control", "control-session");
    store.cancelJob(id, 1);
    store.createReminder(id, "Historical reminder", new Date(now + 60_000 + index).toISOString(), "control");
  }
  store.fireReminders(now + 120_000);
  const jobs = store.jobs();
  assert.equal(jobs.length, 100);
  assert.deepEqual(jobs.slice(0, 3).map(job => job.jobId).sort(), ["pending", "queued", "running"]);
  assert.ok(jobs.slice(3).every(job => job.status === "cancelled"));
  const reminders = store.reminders();
  assert.equal(reminders.length, 100);
  assert.deepEqual(reminders.slice(0, 2).map(reminder => reminder.id), ["sooner", "later"]);
  assert.ok(reminders.slice(2).every(reminder => reminder.status === "fired"));
});

test("failed callback bookkeeping or cancellation feedback cannot leave a partially applied job action", t => {
  const { store, sqlite, close } = open(); t.after(close);
  store.createJob(assignment(), "telegram", "telegram-session");
  const card = confirmGroup(store, "approval:job-1:1", 220);
  sqlite.exec("CREATE TRIGGER reject_used_token BEFORE UPDATE ON umpi_telegram_interactions BEGIN SELECT RAISE(ABORT, 'injected failure'); END");
  assert.throws(() => store.resolveTelegramCallback(button(card, "Approve"), 220));
  assert.equal(store.job("job-1")?.status, "pending_approval");
  assert.equal(store.job("job-1")?.approvedAt, undefined);
  sqlite.exec("DROP TRIGGER reject_used_token");
  store.resolveTelegramCallback(button(card, "Approve"), 220);
  sqlite.exec("CREATE TRIGGER reject_feedback BEFORE INSERT ON umpi_operations BEGIN SELECT RAISE(ABORT, 'injected failure'); END");
  assert.throws(() => store.resolveTelegramCallback(button(card, "Cancel"), 220));
  assert.equal(store.job("job-1")?.status, "queued");
  assert.equal(store.operation("job:job-1:completion"), undefined);
  sqlite.exec("DROP TRIGGER reject_feedback");
  store.resolveTelegramCallback(button(card, "Cancel"), 220);
  assert.equal(store.job("job-1")?.status, "cancelled");
  assert.equal(store.operation("job:job-1:completion")?.status, "admitted");
});

test("tool-only success settles without a second message while empty failures remain visible", t => {
  const { store, close } = open(); t.after(close);
  const op = store.admit("ask", "Help me choose", "telegram", "telegram-session");
  store.createChoice("question-only", "Which option?", ["A", "B"], "telegram", "telegram-session");
  store.settle(op.id, "");
  assert.equal(store.operation(op.id)?.status, "done");
  assert.equal(store.pendingChoice("telegram-session")?.id, "question-only");
  assert.equal(store.deliveries(`answer:${op.id}`).length, 0);
  store.settle(op.id, "A late duplicate must not add another reply.");
  assert.equal(store.deliveries(`answer:${op.id}`).length, 0);
  const answer = store.admit("answer", "A", "telegram", "telegram-session");
  store.settle(answer.id, "", true);
  assert.equal(store.operation(answer.id)?.status, "failed");
  const failure = store.deliveries(`answer:${answer.id}`);
  assert.equal(failure.length, 1);
  assert.equal(failure[0]?.status, "pending");
  assert.equal(failure[0]?.replyMarkup, undefined);
});

test("a delayed voice request cannot be re-dated, re-captioned, or answer a later choice on replay", t => {
  const { store, close } = open(); t.after(close);
  const source = { kind: "telegram-voice" as const, sentAt: "2026-01-05T23:59:00+05:30", caption: "Keep the evening free" };
  const original = store.admit("night-voice", "Plan tomorrow", "telegram", "telegram-session", source);
  store.createChoice("later-day", "Which day?", ["Monday", "Tuesday"], "telegram", "telegram-session");
  assert.deepEqual(store.admit("night-voice", "Plan tomorrow", "telegram", "telegram-session", { ...source }), original);
  for (const changed of [
    { ...source, sentAt: "2026-01-06T00:01:00+05:30" },
    { ...source, caption: "Fill the evening" },
    { ...source, kind: "telegram-text" as const, caption: undefined },
  ]) {
    assert.throws(() => store.admit("night-voice", "Plan tomorrow", "telegram", "telegram-session", changed), StateError);
    assert.deepEqual(store.operation(original.id), original);
    assert.equal(store.pendingChoice("telegram-session")?.id, "later-day");
  }
});

test("voice source cannot repurpose prior text or cross channel authority and invalid source never consumes a choice", t => {
  const { store, close } = open(); t.after(close);
  const legacy = store.admit("prior-text", "Plan tomorrow", "telegram", "telegram-session");
  const source = { kind: "telegram-voice" as const, sentAt: "2026-01-06T00:30:00+05:30" };
  assert.throws(() => store.admit("prior-text", "Plan tomorrow", "telegram", "telegram-session", source), StateError);
  assert.deepEqual(store.operation(legacy.id), legacy);
  store.createChoice("pending", "Which time?", ["Morning", "Evening"], "telegram", "telegram-session");
  assert.throws(() => store.admit("wrong-channel", "Morning", "control", "control-session", source), InputError);
  assert.throws(() => store.admit("invalid-date", "Morning", "telegram", "telegram-session", { ...source, sentAt: "2026-02-30T00:30:00Z" }), InputError);
  assert.throws(() => store.admit("invalid-caption", "Morning", "telegram", "telegram-session", { ...source, caption: "x".repeat(1_025) }), InputError);
  assert.equal(store.operation("message:control:wrong-channel"), undefined);
  assert.equal(store.operation("message:telegram:invalid-date"), undefined);
  assert.equal(store.operation("message:telegram:invalid-caption"), undefined);
  assert.equal(store.pendingChoice("telegram-session")?.id, "pending");
});
