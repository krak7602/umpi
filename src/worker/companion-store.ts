import { createHash, randomBytes } from "node:crypto";
import { InputError, boundedText, identifier, record } from "../shared/protocol.js";
import { credential, exactKeys, parseAck, parseAction, parseMutation, parsePairClaim, parseRegistration, type ActionRequest, type Device, type DeviceAction, type DeviceRegistration, type MutationReceipt, type Workflow } from "../shared/companion.js";
import { StateError, Store, type Database, type Operation, type Job, type Reminder, type Choice } from "./store.js";

export class CompanionConflict extends StateError {
  constructor(message: string, readonly current?: Workflow) { super(409, message); }
}
export interface PushTarget extends DeviceRegistration { deviceId: string }
interface SnapshotState {
  protocolVersion: 1; revision: number; serverTime: string; workflows: Workflow[]; actions: DeviceAction[];
  jobs: Job[]; reminders: Reminder[]; choices: Choice[]; operations: Operation[];
  pushDeliveries: { deviceId: string; status: string }[];
}
export interface DeviceSnapshot extends SnapshotState { device: Device }
export interface CompanionSnapshot extends SnapshotState { devices: Device[] }
interface DeviceRow { id: string; token_hash: string; data: string; push: string }
interface PairingRow { hash: string; expires: number; claim_hash: string | null; device_id: string | null }
const iso = () => new Date().toISOString();
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new InputError("Invalid companion request value");
  return encoded;
}
export const companionHash = (value: string): string => createHash("sha256").update(value).digest("hex");
const fingerprint = (value: unknown): string => companionHash(canonical(value));
const activityJobIds = (registration: DeviceRegistration): Set<string> => new Set([
  ...(registration.activityJobIds ?? []), ...(registration.activityTokens ?? []).map(activity => activity.jobId),
]);
const includeJobs = (jobs: Job[], tracked: Job[]): Job[] => [...new Map([...jobs, ...tracked].map(job => [job.jobId, job])).values()];

/** Separate application tables, sharing the existing synchronous SQLite transaction adapter. */
export class CompanionStore {
  readonly db: Database;
  constructor(readonly owner: Store) {
    this.db = owner.db;
    for (const statement of [
      "CREATE TABLE IF NOT EXISTS umpi_companion_meta (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL)",
      "INSERT OR IGNORE INTO umpi_companion_meta VALUES (1,0)",
      "CREATE TABLE IF NOT EXISTS umpi_companion_owner_revision (id INTEGER PRIMARY KEY CHECK(id=1), hash TEXT NOT NULL)",
      "CREATE TABLE IF NOT EXISTS umpi_companion_workflows (id TEXT PRIMARY KEY, removed INTEGER NOT NULL, data TEXT NOT NULL)",
      "CREATE TABLE IF NOT EXISTS umpi_companion_receipts (id TEXT PRIMARY KEY, actor TEXT NOT NULL, hash TEXT NOT NULL, data TEXT NOT NULL)",
      "CREATE TABLE IF NOT EXISTS umpi_companion_pairings (hash TEXT PRIMARY KEY, expires INTEGER NOT NULL, claim_hash TEXT, device_id TEXT, source TEXT UNIQUE)",
      "CREATE TABLE IF NOT EXISTS umpi_companion_devices (id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, data TEXT NOT NULL, push TEXT NOT NULL)",
      "CREATE TABLE IF NOT EXISTS umpi_companion_actions (id TEXT PRIMARY KEY, device_id TEXT NOT NULL, hash TEXT NOT NULL, data TEXT NOT NULL)",
      "CREATE INDEX IF NOT EXISTS umpi_companion_device_actions ON umpi_companion_actions(device_id)",
      "CREATE TABLE IF NOT EXISTS umpi_companion_acknowledgements (id TEXT PRIMARY KEY, hash TEXT NOT NULL, data TEXT NOT NULL)",
      "CREATE TABLE IF NOT EXISTS umpi_companion_choice_answers (id TEXT PRIMARY KEY, answer TEXT NOT NULL, operation_id TEXT NOT NULL)",
      "CREATE TABLE IF NOT EXISTS umpi_companion_push (id TEXT PRIMARY KEY, hash TEXT NOT NULL, status TEXT NOT NULL)",
    ]) this.db.all(statement);
  }
  private rows<T>(query: string, ...bindings: (string | number | null)[]): T[] {
    return this.db.all<{ data: string }>(query, ...bindings).map(row => JSON.parse(row.data) as T);
  }
  revision(): number { return this.db.all<{ revision: number }>("SELECT revision FROM umpi_companion_meta WHERE id=1")[0]!.revision; }
  private changed(): void {
    if (this.revision() >= Number.MAX_SAFE_INTEGER) throw new StateError(409, "Companion revision limit reached");
    this.db.all("UPDATE umpi_companion_meta SET revision=revision+1 WHERE id=1");
  }
  workflows(): Workflow[] { return this.rows("SELECT data FROM umpi_companion_workflows WHERE removed=0 ORDER BY rowid"); }
  workflow(id: string): Workflow | undefined { return this.rows<Workflow>("SELECT data FROM umpi_companion_workflows WHERE id=? AND removed=0", identifier(id))[0]; }
  private requireActor(actor: string): void { if (actor.startsWith("device:")) this.requireDevice(actor.slice(7)); }
  mutate(value: unknown, actor: string): MutationReceipt {
    const input = parseMutation(value);
    const hash = fingerprint(input);
    return this.db.transaction(() => {
      this.requireActor(actor);
      const previous = this.db.all<{ actor: string; hash: string; data: string }>("SELECT actor,hash,data FROM umpi_companion_receipts WHERE id=?", input.operationId)[0];
      if (previous) {
        if (previous.actor !== actor || previous.hash !== hash) throw new CompanionConflict("Operation ID already contains a different request");
        return JSON.parse(previous.data) as MutationReceipt;
      }
      const current = this.workflow(input.workflowId);
      const existing = this.db.all("SELECT id FROM umpi_companion_workflows WHERE id=?", input.workflowId).length > 0;
      let result: MutationReceipt;
      if (input.kind === "create") {
        if (existing) throw new CompanionConflict("Workflow ID already exists or was explicitly removed", current);
        if (this.workflows().length >= 32) throw new StateError(409, "At most 32 workflows may be retained; removal must be explicit");
        result = { id: input.workflowId, revision: 1, definition: input.definition!, values: input.values ?? {}, archived: false, updatedAt: iso() };
      } else {
        if (!current) throw new CompanionConflict(existing ? "Workflow was explicitly removed" : "Workflow does not exist");
        if (current.revision !== input.expectedRevision) throw new CompanionConflict("Workflow changed; resolve against the current revision", current);
        if (current.revision >= Number.MAX_SAFE_INTEGER) throw new CompanionConflict("Workflow revision limit reached", current);
        result = input.kind === "remove" ? { id: current.id, revision: current.revision + 1, removed: true, updatedAt: iso() }
          : { ...current, revision: current.revision + 1, updatedAt: iso(),
            ...(input.kind === "define" ? { definition: input.definition! } : {}),
            ...(input.kind === "set_values" ? { values: { ...current.values, ...input.values } } : {}),
            ...(input.kind === "archive" ? { archived: true } : {}), ...(input.kind === "restore" ? { archived: false } : {}) };
      }
      if (!("removed" in result)) {
        if (Object.keys(result.values).length > 128) throw new InputError("Too many retained workflow values");
        for (const key of Object.keys(input.values ?? {})) {
          if (!result.definition.fields.some(field => field.id === key) && !Object.hasOwn(current?.values ?? {}, key)) throw new InputError("Value references an unknown field");
        }
      }
      const data = JSON.stringify(result);
      this.db.all("INSERT INTO umpi_companion_workflows VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET removed=excluded.removed,data=excluded.data", result.id, "removed" in result ? 1 : 0, data);
      this.db.all("INSERT INTO umpi_companion_receipts VALUES (?,?,?,?)", input.operationId, actor, hash, data);
      this.changed(); return result;
    });
  }
  createPairing(value: unknown = {}, source?: string): { code: string; expiresAt: string } | undefined {
    const input = record(value); exactKeys(input, ["label"]);
    if (input.label !== undefined) boundedText(input.label, 128, "pairing label");
    return this.db.transaction(() => {
      // Telegram retries cannot mint/send another credential. Raw codes never enter durable outboxes or task receipts.
      if (source && this.db.all("SELECT hash FROM umpi_companion_pairings WHERE source=?", source).length) return undefined;
      const now = Date.now();
      const active = this.db.all<{ count: number }>("SELECT count(*) AS count FROM umpi_companion_pairings WHERE expires>? AND claim_hash IS NULL", now)[0]!.count;
      if (active >= 8) throw new StateError(429, "Too many active pairing codes; wait for a code to expire");
      const code = randomBytes(32).toString("base64url");
      const expires = now + 600_000;
      this.db.all("INSERT INTO umpi_companion_pairings VALUES (?,?,NULL,NULL,?)", companionHash(code), expires, source ?? null);
      return { code, expiresAt: new Date(expires).toISOString() };
    });
  }
  claimPairing(value: unknown): { deviceId: string } {
    const input = parsePairClaim(value);
    const hash = fingerprint(input);
    return this.db.transaction(() => {
      const pairing = this.db.all<PairingRow>("SELECT * FROM umpi_companion_pairings WHERE hash=?", companionHash(input.code))[0];
      if (!pairing || pairing.expires <= Date.now()) throw new StateError(401, "Pairing code is invalid or expired");
      if (pairing.claim_hash !== null) {
        if (pairing.claim_hash !== hash || pairing.device_id !== input.deviceId) throw new StateError(409, "Pairing code has already been claimed");
        this.requireDevice(input.deviceId); return { deviceId: input.deviceId };
      }
      if (this.device(input.deviceId) || this.db.all("SELECT id FROM umpi_companion_devices WHERE token_hash=?", companionHash(input.token)).length) throw new StateError(409, "Device identity already exists; use a new device identity");
      if (this.devices().filter(device => !device.revoked).length >= 16) throw new StateError(409, "Device limit reached; revoke an unused device explicitly");
      const device: Device = { id: input.deviceId, label: input.label, capabilities: input.capabilities, revoked: false, lastSeenAt: iso() };
      this.db.all("INSERT INTO umpi_companion_devices VALUES (?,?,?,?)", device.id, companionHash(input.token), JSON.stringify(device), "{}");
      this.db.all("UPDATE umpi_companion_pairings SET claim_hash=?,device_id=? WHERE hash=? AND claim_hash IS NULL", hash, device.id, pairing.hash);
      this.changed(); return { deviceId: device.id };
    });
  }
  device(id: string): Device | undefined { return this.rows<Device>("SELECT data FROM umpi_companion_devices WHERE id=?", identifier(id, "device ID"))[0]; }
  devices(): Device[] { return this.rows("SELECT data FROM umpi_companion_devices ORDER BY rowid"); }
  requireDevice(id: string): Device {
    const device = this.device(id);
    if (!device || device.revoked) throw new StateError(401, "Device session is invalid or revoked");
    return device;
  }
  authenticate(authorization: string | null): Device {
    const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
    try { credential(token); } catch { throw new StateError(401, "Unauthorized device session"); }
    const row = this.db.all<DeviceRow>("SELECT * FROM umpi_companion_devices WHERE token_hash=?", companionHash(token))[0];
    if (!row) throw new StateError(401, "Unauthorized device session");
    return this.requireDevice(row.id);
  }
  seen(id: string): Device {
    const device = { ...this.requireDevice(id), lastSeenAt: iso() };
    this.db.all("UPDATE umpi_companion_devices SET data=? WHERE id=?", JSON.stringify(device), id); return device;
  }
  register(id: string, value: unknown): { ok: true } {
    const input = parseRegistration(value);
    return this.db.transaction(() => {
      const device = this.requireDevice(id);
      for (const jobId of activityJobIds(input)) if (!this.owner.job(jobId)) throw new InputError("Live Activity requires an existing job");
      const prior = JSON.parse(this.db.all<DeviceRow>("SELECT * FROM umpi_companion_devices WHERE id=?", id)[0]!.push) as DeviceRegistration;
      const push = { ...prior, ...input };
      if ((push.apnsToken || push.activityTokens?.length) && !push.apnsEnvironment) throw new InputError("Push registration requires its APNs environment");
      this.db.all("UPDATE umpi_companion_devices SET data=?,push=? WHERE id=?", JSON.stringify({ ...device, capabilities: input.capabilities, lastSeenAt: iso() }), JSON.stringify(push), id);
      if (fingerprint(prior) !== fingerprint(push)) {
        this.db.all("DELETE FROM umpi_companion_push WHERE id=?", id);
        this.changed();
      }
      return { ok: true };
    });
  }
  revoke(id: string): Device {
    return this.db.transaction(() => {
      const device = this.device(id);
      if (!device) throw new StateError(404, "Device not found");
      if (device.revoked) return device;
      const result = { ...device, revoked: true };
      this.db.all("UPDATE umpi_companion_devices SET data=?,push='{}' WHERE id=?", JSON.stringify(result), id);
      this.changed(); return result;
    });
  }
  actions(deviceId?: string): DeviceAction[] {
    const scope = deviceId === undefined ? "" : "device_id=? AND ";
    const bindings = deviceId === undefined ? [] : [deviceId];
    const pending = this.rows<DeviceAction>(`SELECT data FROM umpi_companion_actions WHERE ${scope}json_extract(data,'$.status')='pending' ORDER BY rowid DESC`, ...bindings);
    const completed = this.rows<DeviceAction>(`SELECT data FROM umpi_companion_actions WHERE ${scope}json_extract(data,'$.status')!='pending' ORDER BY rowid DESC LIMIT 256`, ...bindings);
    return [...pending, ...completed];
  }
  requestAction(value: unknown, deviceId?: string): DeviceAction {
    const input = parseAction(value, deviceId);
    return this.persistAction(input);
  }
  private persistAction(input: ActionRequest): DeviceAction {
    const hash = fingerprint(input);
    return this.db.transaction(() => {
      const device = this.requireDevice(input.deviceId);
      const previous = this.db.all<{ hash: string; data: string }>("SELECT hash,data FROM umpi_companion_actions WHERE id=?", input.id)[0];
      if (previous) {
        if (previous.hash !== hash) throw new StateError(409, "Action ID already contains a different request");
        return JSON.parse(previous.data) as DeviceAction;
      }
      const capability = device.capabilities.find(item => item.id === input.capability);
      if (!capability || capability.status === "unsupported") throw new StateError(409, "Device does not advertise support for this capability");
      if (input.capability === "activity.track" && !this.owner.job(String(input.input.jobId))) throw new InputError("Live Activity requires an existing job");
      if (this.actions(device.id).filter(action => action.status === "pending").length >= 128) throw new StateError(409, "Too many pending device actions");
      const action: DeviceAction = { ...input, status: "pending", createdAt: iso(), updatedAt: iso() };
      this.db.all("INSERT INTO umpi_companion_actions VALUES (?,?,?,?)", action.id, action.deviceId, hash, JSON.stringify(action));
      this.changed(); return action;
    });
  }
  acknowledge(deviceId: string, id: string, value: unknown): DeviceAction {
    identifier(id, "action ID");
    const input = parseAck(value); const hash = fingerprint(input);
    return this.db.transaction(() => {
      this.requireDevice(deviceId);
      const action = this.rows<DeviceAction>("SELECT data FROM umpi_companion_actions WHERE id=? AND device_id=?", id, deviceId)[0];
      if (!action) throw new StateError(404, "Device action not found");
      const previous = this.db.all<{ hash: string; data: string }>("SELECT hash,data FROM umpi_companion_acknowledgements WHERE id=?", id)[0];
      if (previous) {
        if (previous.hash !== hash) throw new StateError(409, "Action already has a different acknowledgement");
        return JSON.parse(previous.data) as DeviceAction;
      }
      const result: DeviceAction = { ...action, ...input, updatedAt: iso() };
      this.db.all("UPDATE umpi_companion_actions SET data=? WHERE id=?", JSON.stringify(result), id);
      this.db.all("INSERT INTO umpi_companion_acknowledgements VALUES (?,?,?)", id, hash, JSON.stringify(result));
      this.changed(); return result;
    });
  }
  private ownerState() {
    const recentJobs = this.owner.jobs();
    const jobs = new Map(recentJobs.map(job => [job.jobId, job]));
    const trackedByDevice = new Map<string, Job[]>();
    for (const row of this.db.all<DeviceRow>("SELECT * FROM umpi_companion_devices ORDER BY rowid")) {
      if ((JSON.parse(row.data) as Device).revoked) continue;
      const tracked: Job[] = [];
      for (const id of activityJobIds(JSON.parse(row.push) as DeviceRegistration)) {
        const job = jobs.get(id) ?? this.owner.job(id);
        if (job) { jobs.set(id, job); tracked.push(job); }
      }
      trackedByDevice.set(row.id, tracked);
    }
    const state = { jobs: [...jobs.values()], reminders: this.owner.reminders(), choices: this.owner.choices(), operations: this.owner.recentOperations(false) };
    // One owner-wide hash includes every active device's tracked jobs, regardless of which device reads first.
    const hash = fingerprint(state);
    this.db.transaction(() => {
      const previous = this.db.all<{ hash: string }>("SELECT hash FROM umpi_companion_owner_revision WHERE id=1")[0];
      if (previous?.hash === hash) return;
      this.db.all("INSERT INTO umpi_companion_owner_revision VALUES (1,?) ON CONFLICT(id) DO UPDATE SET hash=excluded.hash", hash);
      this.changed();
    });
    return { state, recentJobs, trackedByDevice };
  }
  snapshot(deviceId: string): DeviceSnapshot;
  snapshot(): CompanionSnapshot;
  snapshot(deviceId?: string): DeviceSnapshot | CompanionSnapshot {
    const { state, recentJobs, trackedByDevice } = this.ownerState();
    return { protocolVersion: 1, revision: this.revision(), serverTime: iso(),
      ...(deviceId ? { device: this.requireDevice(deviceId) } : { devices: this.devices() }),
      workflows: this.workflows(), actions: this.actions(deviceId), ...state,
      jobs: deviceId ? includeJobs(recentJobs, trackedByDevice.get(deviceId) ?? []) : state.jobs,
      pushDeliveries: this.db.all<{ deviceId: string; status: string }>(deviceId ? "SELECT id AS deviceId,status FROM umpi_companion_push WHERE id=?" : "SELECT id AS deviceId,status FROM umpi_companion_push", ...(deviceId ? [deviceId] : [])) };
  }
  answerChoice(deviceId: string, id: string, value: unknown): Operation {
    identifier(id, "choice ID"); const input = record(value); exactKeys(input, ["answer"]);
    const answer = boundedText(input.answer, 16_384, "choice answer");
    return this.db.transaction(() => {
      this.requireDevice(deviceId);
      const choice = this.owner.choices().find(choice => choice.id === id);
      if (!choice || choice.status === "superseded") throw new StateError(409, "Question is no longer available");
      const previous = this.db.all<{ answer: string; operation_id: string }>("SELECT answer,operation_id FROM umpi_companion_choice_answers WHERE id=?", id)[0];
      if (previous) {
        if (previous.answer !== answer) throw new StateError(409, "Question already has a different answer");
        return this.owner.operation(previous.operation_id)!;
      }
      if (choice.status !== "pending" || this.owner.pendingChoice(choice.sessionId)?.id !== id) throw new StateError(409, "Question is no longer pending");
      // Store.admit owns the existing free-text semantics, model input, and atomic choice transition.
      // Slash commands must not be interpreted as approval or evade consuming the chosen question.
      if (answer.trimStart().startsWith("/")) throw new InputError("A choice answer must be ordinary text, not a command");
      const operation = this.owner.admit(`device-choice:${companionHash(JSON.stringify([deviceId, id]))}`, answer, choice.channel, choice.sessionId);
      this.db.all("INSERT INTO umpi_companion_choice_answers VALUES (?,?,?)", id, answer, operation.id);
      return operation;
    });
  }
  recoverPushes(): void { this.db.all("UPDATE umpi_companion_push SET status='uncertain' WHERE status='sending'"); }
  nextPush(): { target: PushTarget; hash: string; revision: number; jobs: Job[] } | undefined {
    const { state: ownerState, trackedByDevice } = this.ownerState();
    const state = { revision: this.revision(), ...ownerState };
    const hash = fingerprint(state);
    for (const row of this.db.all<DeviceRow>("SELECT * FROM umpi_companion_devices ORDER BY rowid")) {
      const device = JSON.parse(row.data) as Device; const push = JSON.parse(row.push) as DeviceRegistration;
      if (device.revoked || (!push.apnsToken && !push.activityTokens?.length)) continue;
      if (this.db.all("SELECT id FROM umpi_companion_push WHERE id=? AND hash=?", row.id, hash).length) continue;
      return { target: { ...push, deviceId: row.id }, hash, revision: state.revision, jobs: trackedByDevice.get(row.id) ?? [] };
    }
    return undefined;
  }
  beginPush(deviceId: string, hash: string): void {
    this.requireDevice(deviceId);
    this.db.all("INSERT INTO umpi_companion_push VALUES (?,?,'sending') ON CONFLICT(id) DO UPDATE SET hash=excluded.hash,status=excluded.status", deviceId, hash);
  }
  finishPush(deviceId: string, hash: string, status: string): void { this.db.all("UPDATE umpi_companion_push SET status=? WHERE id=? AND hash=?", status, deviceId, hash); }
}
