import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ToolExecutionApi, ToolExecutionResult } from "@earendil-works/pi-durable";
import { parseDefinition, parseMutation, parseCapabilities, parseRegistration, type Workflow, type Capability, type WorkflowDefinition } from "../src/shared/companion.js";
import { InputError, record } from "../src/shared/protocol.js";
import { Store, StateError, type Database } from "../src/worker/store.js";
import { CompanionStore, CompanionConflict, companionHash } from "../src/worker/companion-store.js";
import { companionRequest, type CompanionHttpContext } from "../src/worker/companion-http.js";
import { companionTools } from "../src/worker/companion-tools.js";
import { sendCompanionPush } from "../src/worker/companion-push.js";
import { authorize, telegramUpdate } from "../src/worker/transport.js";

const capabilities: Capability[] = [{ id: "notification.schedule", version: 1, status: "available" }, { id: "notification.cancel", version: 1, status: "available" }];
const definition: WorkflowDefinition = { id: "morning", title: "Morning", fields: [{ id: "note", label: "Note", kind: "text" }, { id: "done", label: "Done", kind: "toggle" }], actions: [] };
const creation = (operationId = "create-morning") => ({ operationId, workflowId: definition.id, expectedRevision: 0, kind: "create", definition, values: { note: "Keep my input", done: false } });
const config = { UMPI_CONTROL_TOKEN: "control-".repeat(8), UMPI_EXECUTOR_TOKEN: "executor-".repeat(8) };
function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "umpi-companion-"));
  const path = join(directory, "state.sqlite");
  let sqlite = new DatabaseSync(path);
  let depth = 0;
  const db: Database = {
    all: <T extends object>(query: string, ...bindings: (string | number | null)[]) => sqlite.prepare(query).all(...bindings) as T[],
    transaction: <T>(run: () => T): T => {
      const savepoint = `companion_${depth++}`; sqlite.exec(`SAVEPOINT ${savepoint}`);
      try { const result = run(); sqlite.exec(`RELEASE ${savepoint}`); return result; }
      catch (error) { sqlite.exec(`ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`); throw error; }
      finally { depth--; }
    },
  };
  const owner = new Store(db); owner.setSession("control", "1"); owner.setSession("telegram", "2");
  const companion = new CompanionStore(owner);
  t.after(() => { sqlite.close(); rmSync(directory, { recursive: true, force: true }); });
  const context: CompanionHttpContext = { companion, config, async wake() {}, async requireModel() {},
    async admit(id, text, deviceId) { companion.requireDevice(deviceId); return owner.admit(id, text, "control", "1"); } };
  return { db, owner, companion, context, reopen() { sqlite.close(); sqlite = new DatabaseSync(path); return new CompanionStore(new Store(db)); } };
}
function paired(companion: CompanionStore, deviceId = "phone-1") {
  const token = randomBytes(32).toString("base64url");
  const code = companion.createPairing()!.code;
  const claim = { code, token, deviceId, label: "Phone", capabilities };
  companion.claimPairing(claim);
  return { token, code, claim };
}
function request(path: string, token?: string, body?: unknown, method = body === undefined ? "GET" : "POST") {
  return new Request(`https://coordinator.example${path}`, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
function decoded(result: ToolExecutionResult): unknown {
  const item = result.content?.[0]; assert.equal(item?.type, "text");
  return JSON.parse(item && "text" in item ? item.text : "null") as unknown;
}

test("workflow CAS preserves independent values and hidden fields; exact receipts survive restart and newer edits", t => {
  const f = fixture(t);
  const created = f.companion.mutate(creation(), "control") as Workflow;
  const edit = { operationId: "edit-note", workflowId: "morning", expectedRevision: 1, kind: "set_values", values: { note: "Owner changed this" } };
  const updated = f.companion.mutate(edit, "control") as Workflow;
  assert.equal(updated.revision, 2); assert.equal(updated.values.done, false);
  assert.throws(() => f.companion.mutate({ ...edit, operationId: "stale", values: { done: true } }, "model"), (error: unknown) => error instanceof CompanionConflict && error.current?.values.note === "Owner changed this");
  assert.deepEqual(f.companion.mutate(creation(), "control"), created);
  assert.throws(() => f.companion.mutate({ ...edit, values: { note: "Changed replay" } }, "control"), CompanionConflict);
  assert.throws(() => f.companion.mutate(edit, "model"), CompanionConflict);
  const migrated = f.companion.mutate({ operationId: "layout", workflowId: "morning", expectedRevision: 2, kind: "define", definition: { ...definition, fields: [definition.fields[1]] } }, "model") as Workflow;
  assert.equal(migrated.values.note, "Owner changed this"); assert.equal(migrated.values.done, false);
  const clear = f.companion.mutate({ operationId: "clear", workflowId: "morning", expectedRevision: 3, kind: "set_values", values: { note: null } }, "control") as Workflow;
  assert.equal(clear.values.note, null); assert.equal(clear.values.done, false);
  const reopened = f.reopen();
  assert.deepEqual(reopened.mutate(edit, "control"), updated);
  assert.deepEqual(reopened.workflow("morning"), clear);
});

test("archive/restore/removal are explicit and tombstones prevent stale recreation", t => {
  const { companion } = fixture(t); companion.mutate(creation(), "control");
  const change = (operationId: string, kind: string, expectedRevision: number) => companion.mutate({ operationId, workflowId: "morning", kind, expectedRevision }, "control");
  assert.equal(record(change("archive", "archive", 1)).archived, true);
  assert.equal(companion.workflows().length, 1);
  assert.equal(record(change("restore", "restore", 2)).archived, false);
  const removed = change("remove", "remove", 3);
  assert.equal("removed" in removed && removed.removed, true); assert.equal(removed.revision, 4);
  assert.deepEqual(change("remove", "remove", 3), removed);
  assert.equal(companion.workflows().length, 0);
  assert.throws(() => companion.mutate(creation("recreate"), "control"), CompanionConflict);
  assert.throws(() => change("late-edit", "restore", 3), CompanionConflict);
});

test("invalid writes roll back both revisions and receipts, allowing a corrected same-ID request", t => {
  const { companion, db } = fixture(t); companion.mutate(creation(), "control");
  const change = { operationId: "bad", workflowId: "morning", kind: "set_values", expectedRevision: 1, values: { missing: "bad" } };
  const before = companion.revision();
  assert.throws(() => companion.mutate(change, "control"), InputError);
  assert.equal(companion.revision(), before);
  assert.equal(db.all("SELECT id FROM umpi_companion_receipts WHERE id='bad'").length, 0);
  const corrected = companion.mutate({ ...change, values: { done: true } }, "control");
  assert.ok("values" in corrected); assert.equal(corrected.values.done, true);
});

test("bounded definitions reject executable/approval kinds, dangling references, duplicates and malformed values", () => {
  for (const bad of [
    { ...definition, fields: [...definition.fields, definition.fields[0]] },
    { ...definition, actions: [{ id: "approve", title: "Approve", steps: [{ kind: "approve_job", jobId: "job-1" }] }] },
    { ...definition, actions: [{ id: "set", title: "Set", steps: [{ kind: "set_value", fieldId: "missing", value: true }] }] },
    { ...definition, actions: [{ id: "message", title: "Message", steps: [{ kind: "message", text: "Hello", when: { fieldId: "missing", equals: true } }] }] },
    { ...definition, fields: Array.from({ length: 33 }, (_, i) => ({ id: `field-${i}`, label: "Field", kind: "text" })) },
    { ...definition, script: "fetch('https://example.com')" },
  ]) assert.throws(() => parseDefinition(bad), InputError);
  for (const bad of [
    { ...creation(), expectedRevision: -1 }, { ...creation(), expectedRevision: Number.MAX_SAFE_INTEGER + 1 },
    { ...creation(), values: { note: { nested: true } } }, { ...creation(), values: { note: "x".repeat(16_385) } },
    { ...creation(), definition: { ...definition, id: "other" } },
    { operationId: "bad", workflowId: "morning", expectedRevision: 1, kind: "define", definition, values: { note: "erase" } },
  ]) assert.throws(() => parseMutation(bad), InputError);
  assert.throws(() => parseCapabilities([{ id: "arbitrary.execute", version: 1, status: "available" }]), InputError);
  assert.throws(() => parseCapabilities([capabilities[0], capabilities[0]]), InputError);
  assert.throws(() => parseRegistration({ capabilities, apnsToken: "secret" }), InputError);
});

test("pairing stores only hashes, exact lost-reply claims recover, and concurrent claims have one winner", async t => {
  const f = fixture(t);
  const code = f.companion.createPairing()!.code;
  const first = { code, token: randomBytes(32).toString("hex"), deviceId: "first", label: "Phone", capabilities };
  const second = { ...first, deviceId: "second", token: randomBytes(32).toString("hex") };
  const claims = await Promise.allSettled([Promise.resolve().then(() => f.companion.claimPairing(first)), Promise.resolve().then(() => f.companion.claimPairing(second))]);
  assert.equal(claims.filter(result => result.status === "fulfilled").length, 1);
  assert.deepEqual(f.companion.claimPairing(first), { deviceId: "first" });
  assert.throws(() => f.companion.claimPairing({ ...first, label: "Changed claim" }), StateError);
  const database = JSON.stringify([f.db.all("SELECT * FROM umpi_companion_devices"), f.db.all("SELECT * FROM umpi_companion_pairings")]);
  assert.equal(database.includes(first.token), false); assert.equal(database.includes(code), false);
  const reopened = f.reopen();
  assert.equal(reopened.authenticate(`Bearer ${first.token}`).id, "first");
  assert.deepEqual(reopened.claimPairing(first), { deviceId: "first" });
  reopened.revoke("first");
  assert.throws(() => reopened.authenticate(`Bearer ${first.token}`), StateError);
  assert.throws(() => reopened.claimPairing(first), StateError);
});

test("pairing codes expire, remain bounded, and Telegram update replay never reissues a plaintext code", t => {
  const { companion, db } = fixture(t);
  const code = companion.createPairing({}, "telegram:tg:1")!.code;
  assert.equal(companion.createPairing({}, "telegram:tg:1"), undefined);
  db.all("UPDATE umpi_companion_pairings SET expires=0 WHERE hash=?", companionHash(code));
  assert.throws(() => companion.claimPairing({ code, token: randomBytes(32).toString("hex"), deviceId: "expired", label: "Phone", capabilities }), (error: unknown) => error instanceof StateError && error.status === 401);
  for (let i = 0; i < 8; i++) companion.createPairing();
  assert.throws(() => companion.createPairing(), (error: unknown) => error instanceof StateError && error.status === 429);
  assert.throws(() => companion.claimPairing({ code: "123456", token: "123456", deviceId: "short", label: "Phone", capabilities }), InputError);
});

test("device action acknowledgements are isolated, immutable and independent of push acceptance", t => {
  const { companion } = fixture(t); const first = paired(companion); paired(companion, "phone-2");
  const request = { id: "notify-1", deviceId: "phone-1", capability: "notification.schedule", input: { notificationId: "note-1", title: "Reminder", body: "", date: "2030-01-01T10:00:00Z" } };
  const action = companion.requestAction(request);
  assert.equal(action.status, "pending"); assert.deepEqual(companion.requestAction(request), action);
  assert.throws(() => companion.requestAction({ ...request, input: { ...request.input, title: "Changed replay" } }), StateError);
  assert.throws(() => companion.acknowledge("phone-2", action.id, { status: "applied" }), (error: unknown) => error instanceof StateError && error.status === 404);
  assert.equal(companion.actions("phone-2").length, 0);
  companion.register("phone-1", { capabilities, apnsToken: "ab".repeat(32), apnsEnvironment: "sandbox" });
  const push = companion.nextPush()!; companion.beginPush(push.target.deviceId, push.hash); companion.finishPush(push.target.deviceId, push.hash, "accepted");
  assert.equal(companion.actions("phone-1")[0]!.status, "pending");
  const ack = companion.acknowledge("phone-1", action.id, { status: "applied", result: "Registered" });
  assert.deepEqual(companion.acknowledge("phone-1", action.id, { status: "applied", result: "Registered" }), ack);
  assert.throws(() => companion.acknowledge("phone-1", action.id, { status: "failed" }), StateError);
  const snapshot = JSON.stringify(companion.snapshot("phone-1"));
  assert.equal(snapshot.includes(first.token), false); assert.equal(snapshot.includes("ab".repeat(32)), false);
  assert.equal(snapshot.includes("token_hash"), false);
  companion.revoke("phone-1");
  assert.throws(() => companion.acknowledge("phone-1", action.id, { status: "applied", result: "Registered" }), StateError);
});

test("unsupported capability and nonexistent activity jobs never become fake successes", t => {
  const { companion } = fixture(t); paired(companion);
  assert.throws(() => companion.requestAction({ id: "unsupported", deviceId: "phone-1", capability: "alarm.cancel", input: { alarmId: "00000000-0000-0000-0000-000000000001" } }), StateError);
  companion.register("phone-1", { capabilities: [{ id: "activity.track", version: 1, status: "available" }] });
  assert.throws(() => companion.requestAction({ id: "missing-job", deviceId: "phone-1", capability: "activity.track", input: { jobId: "missing" } }), InputError);
  assert.equal(companion.actions().length, 0);
});

test("HTTP authorization rejects cross-role tokens and prefix bypasses before reading bodies", async t => {
  const f = fixture(t); const { token } = paired(f.companion);
  for (const [path, method, bearer] of [
    ["/api/companion/state", "GET", token], ["/api/companion/pairings", "POST", config.UMPI_EXECUTOR_TOKEN],
    ["/api/device/state", "GET", config.UMPI_CONTROL_TOKEN], ["/api/device/state", "GET", config.UMPI_EXECUTOR_TOKEN],
    ["/api/auth", "POST", token], ["/api/core-context", "PUT", token], ["/api/executor/poll", "POST", token],
    ["/api/core-context/reviews", "GET", token], ["/api/core-context/history/1", "GET", token],
    ["/api/core-context/reviews/proposal/approve", "POST", token], ["/api/core-context/restore", "POST", token],
    ["/api/device/auth", "POST", token], ["/api/device/jobs/one/approve/extra", "POST", token],
    ["/api/device/pair/extra", "POST", token], ["/api/device/pair", "GET", token],
  ]) {
    await assert.rejects(authorize(request(path!, bearer, undefined, method), config, auth => f.companion.authenticate(auth)), StateError);
  }
  const bad = new Request("https://coordinator.example/api/device/changes", { method: "POST", headers: { authorization: "Bearer invalid", "content-type": "application/json" }, body: "not JSON" });
  await assert.rejects(companionRequest(bad, f.context), (error: unknown) => error instanceof StateError && error.status === 401);
  assert.equal(bad.bodyUsed, false);
  await assert.rejects(authorize(new Request("http://coordinator.example/api/device/state", { headers: { authorization: `Bearer ${token}` } }), config, auth => f.companion.authenticate(auth)), StateError);
  await authorize(request("/api/device/state", token), config, auth => f.companion.authenticate(auth));
  await authorize(request("/api/device/state", token), config, "forward-device");
  await assert.rejects(authorize(request("/api/device/state", token), config), StateError);
});

test("real companion handlers pair, mutate and expose state; device messages are scoped and never approve jobs", async t => {
  const f = fixture(t);
  const pairing = await companionRequest(request("/api/companion/pairings", config.UMPI_CONTROL_TOKEN, {}), f.context);
  const code = record(await pairing!.json()).code;
  const token = randomBytes(32).toString("hex");
  const pair = await companionRequest(request("/api/device/pair", undefined, { code, token, deviceId: "phone-1", label: "Phone", capabilities }), f.context);
  assert.equal(record(await pair!.json()).deviceId, "phone-1");
  const created = await companionRequest(request("/api/device/changes", token, creation()), f.context);
  assert.equal(record(await created!.json()).revision, 1);
  f.owner.createJob({ jobId: "job-1", command: "printf safe", cwd: "/workspace", timeoutMs: 1_000, createdAt: new Date().toISOString() }, "control", "1");
  const message = await companionRequest(request("/api/device/messages", token, { id: "ask-1", text: "Approve job-1" }), f.context);
  assert.equal(message!.status, 202); assert.equal(f.owner.job("job-1")!.status, "pending_approval");
  const again = await companionRequest(request("/api/device/messages", token, { id: "ask-1", text: "Approve job-1" }), f.context);
  assert.deepEqual(await message!.json(), await again!.json());
  await assert.rejects(companionRequest(request("/api/device/messages", token, { id: "ask-1", text: "Different" }), f.context), StateError);
  await assert.rejects(companionRequest(request("/api/device/jobs/job-1/approve", token, {}), f.context), InputError);
  await companionRequest(request("/api/device/jobs/job-1/approve", token, { version: 1 }), f.context);
  assert.equal(f.owner.job("job-1")!.status, "queued");
  const state = await companionRequest(request("/api/device/state", token), f.context);
  const snapshot = await state!.json() as { device: { id: string }; jobs: unknown[]; operations: unknown[]; workflows: Workflow[] };
  assert.equal(snapshot.device.id, "phone-1"); assert.equal(snapshot.jobs.length, 1); assert.equal(snapshot.operations.length, 1); assert.equal(snapshot.workflows.length, 1);
  await companionRequest(request("/api/device/session", token, undefined, "DELETE"), f.context);
  await assert.rejects(companionRequest(request("/api/device/state", token), f.context), StateError);
});

test("device routes recheck revocation after lifecycle waits and cannot target another phone", async t => {
  const f = fixture(t); const { token } = paired(f.companion); paired(f.companion, "phone-2");
  await assert.rejects(companionRequest(request("/api/device/actions", token, { id: "target-other", deviceId: "phone-2", capability: "notification.cancel", input: { notificationId: "notification" } }), f.context), InputError);
  await assert.rejects(companionRequest(request("/api/device/changes", token, creation()), { ...f.context, async wake() { f.companion.revoke("phone-1"); } }), StateError);
  assert.equal(f.companion.workflows().length, 0);
});

test("choice answers preserve original conversation semantics, replay once, and never grant approval", t => {
  const { companion, owner } = fixture(t); paired(companion);
  owner.createJob({ jobId: "job-1", command: "printf safe", cwd: "/workspace", timeoutMs: 1_000, createdAt: new Date().toISOString() }, "telegram", "2");
  owner.createChoice("which", "Which task?", ["First", "Second"], "telegram", "2");
  const op = companion.answerChoice("phone-1", "which", { answer: "First" });
  assert.equal(op.channel, "telegram"); assert.equal(op.sessionId, "2"); assert.match(op.modelInput!, /Which task/);
  assert.equal(owner.job("job-1")!.status, "pending_approval");
  assert.deepEqual(companion.answerChoice("phone-1", "which", { answer: "First" }), op);
  assert.throws(() => companion.answerChoice("phone-1", "which", { answer: "Second" }), StateError);
  assert.equal(owner.pendingOperations().length, 1);
  owner.createChoice("old", "Old?", ["One", "Two"], "control", "1");
  owner.createChoice("new", "New?", ["One", "Two"], "control", "1");
  assert.throws(() => companion.answerChoice("phone-1", "old", { answer: "One" }), StateError);
  assert.throws(() => companion.answerChoice("phone-1", "new", { answer: "/approve job-1 1" }), InputError);
});

test("Pi companion tool replays preserve real SQLite state and reject changed effects", async t => {
  const { companion } = fixture(t); paired(companion);
  const tools = companionTools(companion, async () => {});
  const api = { conversationId: "1", taskId: 1 } as unknown as ToolExecutionApi;
  const update = tools.find(tool => tool.name === "update_companion")!;
  const first = await update.execute(creation(), api, BACKGROUND_CONTEXT);
  assert.equal(first.isError, undefined);
  assert.deepEqual(decoded(await update.execute(creation(), api, BACKGROUND_CONTEXT)), decoded(first));
  const altered = await update.execute(creation("different-operation"), api, BACKGROUND_CONTEXT);
  assert.equal(altered.isError, true); assert.equal(companion.workflows().length, 1);
  const read = await tools.find(tool => tool.name === "read_companion_state")!.execute({}, api, BACKGROUND_CONTEXT);
  const state = record(decoded(read));
  assert.ok(Array.isArray(state.workflows));
  assert.equal(record(record(state.workflows[0]).values).note, "Keep my input");
  const action = await tools.find(tool => tool.name === "request_device_action")!.execute({ id: "cancel", deviceId: "phone-1", capability: "notification.cancel", input: { notificationId: "notification" } }, { ...api, taskId: 2 as ToolExecutionApi["taskId"] }, BACKGROUND_CONTEXT);
  assert.equal(action.isError, undefined); assert.equal(record(decoded(action)).status, "pending");
});

test("Telegram pair commands are admitted only for the exact configured human owner/private chat", () => {
  const config = { TELEGRAM_OWNER_ID: "123", TELEGRAM_CHAT_ID: "456" };
  const message = { from: { id: 123, is_bot: false }, chat: { id: 456, type: "private" }, text: "/pair" };
  assert.deepEqual(telegramUpdate({ update_id: 1, message }, config), { kind: "message", id: "tg:1", text: "/pair" });
  for (const invalid of [{ ...message, from: { id: 124, is_bot: false } }, { ...message, from: { id: 123, is_bot: true } }, { ...message, chat: { id: 456, type: "group" } }, { ...message, chat: { id: 457, type: "private" } }]) {
    assert.throws(() => telegramUpdate({ update_id: 1, message: invalid }, config), StateError);
  }
});

test("racing revision writers retain the winner and expose the losing current state", async t => {
  const { companion } = fixture(t); companion.mutate(creation(), "control");
  const results = await Promise.allSettled(["First", "Second"].map((note, index) => Promise.resolve().then(() =>
    companion.mutate({ operationId: `race-${index}`, workflowId: "morning", expectedRevision: 1, kind: "set_values", values: { note } }, "control"))));
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  const rejected = results.find(result => result.status === "rejected");
  assert.ok(rejected?.status === "rejected" && rejected.reason instanceof CompanionConflict);
  assert.ok(rejected.reason.current);
  assert.equal(rejected.reason.current.revision, 2);
  assert.equal(companion.workflow("morning")!.values.done, false);
});

test("snapshot revisions reflect real job transitions and unchanged registration does not create a push loop", t => {
  const { companion, owner } = fixture(t); paired(companion);
  const before = companion.snapshot().revision;
  owner.createJob({ jobId: "job-1", command: "printf safe", cwd: "/workspace", timeoutMs: 1_000, createdAt: new Date().toISOString() }, "control", "1");
  const created = companion.snapshot().revision;
  assert.ok(created > before);
  owner.approveJob("job-1", 1);
  assert.ok(companion.snapshot().revision > created);
  const registration = { capabilities, apnsToken: "ab".repeat(32), apnsEnvironment: "sandbox" };
  companion.register("phone-1", registration);
  const first = companion.nextPush()!;
  companion.beginPush(first.target.deviceId, first.hash);
  companion.recoverPushes();
  assert.equal(companion.nextPush(), undefined);
  const revision = companion.snapshot().revision;
  companion.register("phone-1", registration);
  assert.equal(companion.snapshot().revision, revision);
  assert.equal(companion.nextPush(), undefined);
  const delivery = companion.snapshot().pushDeliveries.find(item => item.deviceId === "phone-1");
  assert.equal(delivery?.status, "uncertain");
});

test("pair claim rejects credential-role reuse and anonymous callers cannot manufacture changes", async t => {
  const f = fixture(t);
  const secret = randomBytes(32).toString("hex");
  const context = { ...f.context, config: { ...config, UMPI_CONTROL_TOKEN: secret } };
  const code = f.companion.createPairing()!.code;
  await assert.rejects(companionRequest(request("/api/device/pair", undefined, { code, token: secret, deviceId: "phone-1", label: "Phone", capabilities }), context), InputError);
  assert.equal(f.companion.devices().length, 0);
  await assert.rejects(companionRequest(request("/api/device/changes", undefined, creation()), f.context), StateError);
  assert.equal(f.companion.workflows().length, 0);
});

test("device message identities cannot collide across colon-delimited identifiers", async t => {
  const f = fixture(t);
  const first = paired(f.companion, "phone:a");
  const second = paired(f.companion, "phone");
  const left = await companionRequest(request("/api/device/messages", first.token, { id: "b", text: "Hello" }), f.context);
  const right = await companionRequest(request("/api/device/messages", second.token, { id: "a:b", text: "Hello" }), f.context);
  const leftOperation = record(await left!.json());
  const rightOperation = record(await right!.json());
  assert.notEqual(leftOperation.id, rightOperation.id);
});

test("separate device choice answers cannot replay a different question", t => {
  const { companion, owner } = fixture(t);
  paired(companion, "phone:a"); paired(companion, "phone");
  owner.createChoice("b", "First question", ["Yes", "No"], "control", "1");
  const first = companion.answerChoice("phone:a", "b", { answer: "Yes" });
  owner.createChoice("a:b", "Second question", ["Yes", "No"], "control", "1");
  const second = companion.answerChoice("phone", "a:b", { answer: "Yes" });
  assert.notEqual(first.id, second.id);
  assert.equal(owner.choices().find(choice => choice.id === "a:b")?.status, "answered");
});

test("pending device actions remain visible beyond completed history", async t => {
  const { companion } = fixture(t); paired(companion);
  companion.requestAction({ id: "retained", deviceId: "phone-1", capability: "notification.cancel", input: { notificationId: "retained" } });
  for (let index = 0; index < 300; index++) {
    const id = `finished-${index}`;
    companion.requestAction({ id, deviceId: "phone-1", capability: "notification.cancel", input: { notificationId: id } });
    companion.acknowledge("phone-1", id, { status: "applied" });
  }
  assert.equal(companion.snapshot().actions.find(action => action.id === "retained")?.status, "pending");
  assert.equal(companion.snapshot("phone-1").actions.find(action => action.id === "retained")?.status, "pending");
  assert.equal(companion.snapshot().actions.filter(action => action.status !== "pending").length, 256);
  assert.equal(companion.snapshot("phone-1").actions.filter(action => action.status !== "pending").length, 256);
  const tool = companionTools(companion, async () => {}).find(tool => tool.name === "read_companion_state")!;
  const result = await tool.execute({}, { conversationId: "1", taskId: 1 } as unknown as ToolExecutionApi, BACKGROUND_CONTEXT);
  const actions = record(decoded(result)).actions as { id: string; status: string }[];
  assert.equal(actions.find(action => action.id === "retained")?.status, "pending");
});

test("registered activity jobs survive the recent-job display limit and send a terminal APNs event", async t => {
  const { companion, owner } = fixture(t); paired(companion);
  const createJob = (jobId: string) => owner.createJob({ jobId, command: "printf safe", cwd: "/workspace", timeoutMs: 1_000, createdAt: new Date().toISOString() }, "control", "1");
  createJob("tracked");
  companion.register("phone-1", { capabilities, apnsEnvironment: "sandbox", activityTokens: [{ jobId: "tracked", token: "ab".repeat(32) }] });
  for (let index = 0; index < 100; index++) createJob(`other-${index}`);
  assert.equal(owner.jobs().some(job => job.jobId === "tracked"), false);
  const first = companion.nextPush()!;
  assert.equal(first.jobs.find(job => job.jobId === "tracked")?.status, "pending_approval");
  companion.beginPush(first.target.deviceId, first.hash);
  companion.finishPush(first.target.deviceId, first.hash, "accepted");
  assert.equal(companion.nextPush(), undefined);
  owner.cancelJob("tracked", 1);
  assert.equal(companion.snapshot("phone-1").jobs.find(job => job.jobId === "tracked")?.status, "cancelled");
  const push = companion.nextPush()!;
  assert.ok(push.revision > first.revision);
  assert.deepEqual(push.jobs.map(job => [job.jobId, job.status]), [["tracked", "cancelled"]]);
  const bodies: Record<string, unknown>[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", chunk => { body += chunk; });
    request.on("end", () => {
      bodies.push(JSON.parse(body) as Record<string, unknown>);
      response.writeHead(200, { "apns-id": "00000000-0000-4000-8000-000000000000" });
      response.end();
    });
  });
  server.listen(0, "127.0.0.1");
  t.after(() => { server.closeAllConnections(); server.close(); });
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const keys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  companion.beginPush(push.target.deviceId, push.hash);
  const result = await sendCompanionPush(push.target, { revision: push.revision, jobs: push.jobs }, {
    APNS_TEAM_ID: "TESTTEAM00", APNS_KEY_ID: "TESTKEY000", APNS_BUNDLE_ID: "com.example.umpi",
    APNS_PRIVATE_KEY: keys.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
  }, { fetch: (_url, init) => fetch(`http://127.0.0.1:${address.port}`, init) });
  companion.finishPush(push.target.deviceId, push.hash, result.status);
  assert.equal(result.status, "accepted");
  assert.equal(bodies.length, 1);
  assert.equal(record(bodies[0]!.aps).event, "end");
  assert.equal(record(record(bodies[0]!.aps)["content-state"]).status, "cancelled");
  assert.equal(JSON.stringify(bodies).includes("printf safe"), false);
  assert.equal(companion.nextPush(), undefined);
  assert.equal(JSON.stringify(companion.snapshot()).includes("ab".repeat(32)), false);
});

test("global action snapshots retain every device's pending queue while enforcing its own cap", t => {
  const { companion } = fixture(t);
  for (const deviceId of ["phone-1", "phone-2", "phone-3"]) {
    paired(companion, deviceId);
    for (let index = 0; index < 128; index++) {
      const id = `${deviceId}-${index}`;
      companion.requestAction({ id, deviceId, capability: "notification.cancel", input: { notificationId: id } });
    }
    assert.throws(() => companion.requestAction({
      id: `${deviceId}-overflow`, deviceId, capability: "notification.cancel", input: { notificationId: "overflow" },
    }), (error: unknown) => error instanceof StateError && error.status === 409);
    assert.equal(companion.snapshot(deviceId).actions.length, 128);
    assert.ok(companion.snapshot(deviceId).actions.every(action => action.deviceId === deviceId && action.status === "pending"));
  }
  assert.equal(companion.snapshot().actions.length, 384);
  assert.ok(companion.snapshot().actions.every(action => action.status === "pending"));
  companion.acknowledge("phone-1", "phone-1-0", { status: "applied" });
  companion.requestAction({ id: "replacement", deviceId: "phone-1", capability: "notification.cancel", input: { notificationId: "replacement" } });
  assert.equal(companion.snapshot().actions.filter(action => action.status === "pending").length, 384);
});

test("activity job registration is bounded, validates real jobs, and preserves registration on rejection", t => {
  const { companion, owner } = fixture(t); paired(companion);
  const jobIds = Array.from({ length: 17 }, (_, index) => `job:${index}`);
  for (const jobId of jobIds) owner.createJob({ jobId, command: "printf safe", cwd: "/workspace", timeoutMs: 1_000, createdAt: new Date().toISOString() }, "control", "1");
  const activityJobIds = jobIds.slice(0, 16);
  assert.deepEqual(parseRegistration({ capabilities, activityJobIds }).activityJobIds, activityJobIds);
  assert.deepEqual(companion.register("phone-1", { capabilities, activityJobIds }), { ok: true });
  const revision = companion.revision();
  for (const invalid of [null, "job:0", ["job:0", "job:0"], ["bad/id"], [1], jobIds, ["missing"]]) {
    assert.throws(() => companion.register("phone-1", { capabilities, activityJobIds: invalid }), InputError);
    assert.equal(companion.revision(), revision);
  }
  assert.throws(() => companion.register("phone-1", {
    capabilities, activityJobIds: [], apnsEnvironment: "sandbox", activityTokens: [{ jobId: "missing", token: "ab".repeat(32) }],
  }), InputError);
  assert.equal(companion.revision(), revision);
  assert.equal(companion.nextPush(), undefined);
  companion.register("phone-1", {
    capabilities, activityJobIds: ["job:0"], apnsEnvironment: "sandbox", activityTokens: [{ jobId: "job:1", token: "ab".repeat(32) }],
  });
  assert.deepEqual(companion.nextPush()!.jobs.map(job => job.jobId), ["job:0", "job:1"]);
  companion.register("phone-1", { capabilities, activityJobIds: ["job:1"] });
  assert.deepEqual(companion.nextPush()!.jobs.map(job => job.jobId), ["job:1"]);
  companion.register("phone-1", { capabilities, activityJobIds: [] });
  assert.deepEqual(companion.nextPush()!.jobs.map(job => job.jobId), ["job:1"]);
});

test("tokenless activity tracking survives restart and old-job transitions without cross-device hash loops", async t => {
  const f = fixture(t);
  const first = paired(f.companion);
  paired(f.companion, "phone-2");
  const createJob = (jobId: string) => f.owner.createJob({ jobId, command: "printf safe", cwd: "/workspace", timeoutMs: 1_000, createdAt: new Date().toISOString() }, "control", "1");
  createJob("local-tracked"); createJob("remote-tracked");
  const registered = await companionRequest(request("/api/device/register", first.token, {
    capabilities, activityJobIds: ["local-tracked"],
  }), f.context);
  assert.deepEqual(await registered!.json(), { ok: true });
  f.companion.register("phone-2", {
    capabilities, apnsEnvironment: "sandbox", activityTokens: [{ jobId: "remote-tracked", token: "ab".repeat(32) }],
  });
  for (let index = 0; index < 100; index++) createJob(`recent-${index}`);
  const companion = f.reopen();
  assert.equal(companion.owner.jobs().some(job => job.jobId === "local-tracked" || job.jobId === "remote-tracked"), false);
  const local = companion.snapshot("phone-1");
  assert.equal(local.jobs.find(job => job.jobId === "local-tracked")?.status, "pending_approval");
  assert.equal(local.jobs.some(job => job.jobId === "remote-tracked"), false);
  const remote = companion.snapshot("phone-2");
  assert.equal(remote.jobs.find(job => job.jobId === "remote-tracked")?.status, "pending_approval");
  assert.equal(remote.jobs.some(job => job.jobId === "local-tracked"), false);
  assert.equal(remote.revision, local.revision);
  const admin = companion.snapshot();
  assert.equal(admin.jobs.length, 102);
  assert.equal(admin.revision, local.revision);
  assert.equal(JSON.stringify(admin).includes("ab".repeat(32)), false);
  const initial = companion.nextPush()!;
  assert.equal(initial.target.deviceId, "phone-2");
  assert.deepEqual(initial.jobs.map(job => job.jobId), ["remote-tracked"]);
  companion.beginPush(initial.target.deviceId, initial.hash);
  companion.finishPush(initial.target.deviceId, initial.hash, "accepted");
  for (const deviceId of ["phone-2", "phone-1", "phone-2"]) {
    assert.equal(companion.snapshot(deviceId).revision, local.revision);
    assert.equal(companion.nextPush(), undefined);
  }
  companion.register("phone-1", { capabilities });
  assert.equal(companion.snapshot("phone-1").revision, local.revision);
  assert.equal(companion.snapshot("phone-1").jobs.some(job => job.jobId === "local-tracked"), true);
  companion.owner.cancelJob("local-tracked", 1);
  const terminal = companion.snapshot("phone-1");
  assert.equal(terminal.jobs.find(job => job.jobId === "local-tracked")?.status, "cancelled");
  assert.ok(terminal.revision > local.revision);
  assert.equal(companion.snapshot("phone-2").revision, terminal.revision);
  const changed = companion.nextPush()!;
  assert.equal(changed.target.deviceId, "phone-2");
  assert.deepEqual(changed.jobs.map(job => job.jobId), ["remote-tracked"]);
  companion.beginPush(changed.target.deviceId, changed.hash);
  companion.finishPush(changed.target.deviceId, changed.hash, "accepted");
  assert.equal(companion.nextPush(), undefined);
  companion.register("phone-1", { capabilities, activityJobIds: [] });
  assert.equal(companion.snapshot("phone-1").jobs.some(job => job.jobId === "local-tracked"), false);
  assert.equal(companion.snapshot().jobs.some(job => job.jobId === "local-tracked"), false);
  assert.equal(companion.snapshot("phone-2").jobs.some(job => job.jobId === "remote-tracked"), true);
});
