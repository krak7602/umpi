import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolExecutionResult, type ToolRegistration } from "@earendil-works/pi-durable";
import { InputError, boundedText, record } from "../shared/protocol.js";
import { StateError, type Database } from "./store.js";
import { T3Error, type T3CodeStore, type T3Thread } from "./t3-code.js";
import type { T3Watcher } from "./t3-watch.js";
import type { MachineDns } from "./cloudflare-dns.js";
import { CloudModelBudget, CLOUD_MODEL_REQUESTS_PER_DAY, CLOUD_MODEL_REQUESTS_PER_MINUTE, CLOUD_MODEL_TOKENS_PER_DAY, type CloudModelAdmission } from "./cloud-model.js";
import { RESTORE_FAILED } from "./cloud-machine-state.js";

/** What a cloud machine needs at each start; secrets travel in the request body, never into saved state. */
export interface CloudMachineStart {
  modelUrl: string;
  modelToken: string;
  models: { id: string; name: string; reasoning: boolean; input: string[]; contextWindow: number; maxTokens: number }[];
  defaultModel: string;
  gitKey?: string;
  gitIdentity?: string;
}

/**
 * Umpi's cloud machines: one container per session, each running T3 Code with the Pi agent. A machine wakes when
 * Umpi or the owner uses it, and as soon as none of its threads is working it is saved to R2 and stopped, so a
 * sleeping machine costs nothing. Each is also a T3 Code machine, so every T3 tool and the app work with it.
 */
export interface CloudMachineRecord {
  id: string;
  label: string;
  repo?: string;
  branch?: string;
  status: "starting" | "awake" | "asleep" | "failed";
  createdAt: string;
  wokeAt?: string;
  sleptAt?: string;
  lastUseAt?: string;
  idleChecks: number;
  checkedAt?: string;
  savedBytes?: number;
  threads?: T3Thread[];
  error?: string;
  /** The public address the owner's T3 Code apps use, once opened there. */
  address?: string;
  /** When one of its threads was last seen working. */
  activeAt?: string;
  /** The T3 Code project Umpi made for it: new threads go there unless another project is named. */
  projectId?: string;
  /** When the wake in progress began. A wake still open after `START_LIMIT_MS` is marked failed. */
  startingAt?: string;
  /**
   * A save that is in progress or did not work. It is kept here so that a restart of the coordinator continues it.
   * `running` is set while an attempt runs; `nextTryAt` when the next one is due; `told` once the owner was told.
   */
  save?: { since: string; attempts: number; lastTriedAt: string; running?: true; error?: string; nextTryAt?: string; told?: true };
  /** Wakes in a row that failed because the saved state could not be restored. */
  restoreFailures?: number;
  /** The last notice Umpi sent the owner about this machine, and how many it has sent. */
  notice?: { at: string; text: string };
  notices?: number;
}
export interface CloudMachineStub {
  /** `expect.saved`: the machine was saved before, so it must not start with an empty home. */
  wake(start: CloudMachineStart, snapshotKey: string, expect?: { saved?: boolean }): Promise<{ token: string; restored: boolean }>;
  isRunning(): Promise<boolean> | boolean;
  reachable?(): Promise<boolean>;
  condition(): Promise<{ running: boolean; stopping: boolean }> | { running: boolean; stopping: boolean };
  /** `lost`: the container was gone, and nothing was saved since it last started. */
  save(): Promise<{ size: number; lost?: boolean }>;
  discard(): Promise<void>;
  publish(hostname: string): Promise<void>;
  pairing(baseUrl: string): Promise<{ pairUrl: string; expiresAt?: string }>;
  inUse(): Promise<{ sockets: number; appAt: number }> | { sockets: number; appAt: number };
}
export interface CloudMachineOptions {
  stub(id: string): CloudMachineStub;
  /** Everything a start needs except the machine's own gateway token; undefined when cloud machines are not set up. */
  start(): Omit<CloudMachineStart, "modelToken"> | undefined;
  deleteSaved(key: string): Promise<void>;
  /** The domain whose `<machine>-umpi.<domain>` names reach Umpi, and the DNS to create them; unset when not set up. */
  publicDomain?(): string | undefined;
  dns?(): MachineDns | undefined;
}

export const CLOUD_MAX_AWAKE = 6;
export const CLOUD_MAX_MACHINES = 24;
/** Cloud machines run one agent, pi, which uses the models Umpi gives it; T3 Code needs the choice named. */
const CLOUD_MODEL = { provider: "pi", model: "default" };
const IDLE_CHECK_MS = 120_000;
const SAVE_LIMIT_MS = 600_000;
/** A failed save is tried again after one, five, and fifteen minutes: four attempts. A stopping machine has 13 minutes. */
export const SAVE_RETRY_MS = [60_000, 5 * 60_000, 15 * 60_000];
export const SAVE_ATTEMPTS = SAVE_RETRY_MS.length + 1;
/** After those, the owner is told, the machine stays awake with its work, and Umpi tries once an hour. */
export const SAVE_SLOW_RETRY_MS = 3_600_000;
/** A wake starts the container (3 minutes at most), restores, and starts T3 Code (2 minutes at most). */
export const START_LIMIT_MS = 15 * 60_000;
/** While a check or a save runs in the background, the coordinator looks again this often. */
const BUSY_POLL_MS = 30_000;
/** One question to a machine's Durable Object in a check. */
const ASK_LIMIT_MS = 30_000;
const RECENT_USE_MS = 180_000;
/** A connected T3 Code app keeps a machine awake while it sends anything, up to two hours after a thread last worked. */
const APP_QUIET_MS = 10 * 60_000;
const APP_AWAKE_MS = 2 * 3_600_000;
const ACTIVE = new Set(["preparing", "queued", "starting", "running", "waiting"]);

/** `owner/name`, or a GitHub SSH or HTTPS address, as an SSH address. */
export function githubRemote(value: string): { remote: string; name: string } {
  const text = value.trim().replace(/\.git$/, "");
  const match = /^(?:git@github\.com:|https:\/\/github\.com\/|ssh:\/\/git@github\.com\/)?([A-Za-z0-9_.-]{1,100})\/([A-Za-z0-9_.-]{1,100})$/.exec(text);
  if (!match) throw new InputError("repo must be owner/name or a GitHub address");
  return { remote: `git@github.com:${match[1]}/${match[2]}.git`, name: match[2]! };
}

/**
 * When a machine next needs the coordinator, or the reason it needs nothing. The rule: every state that is not final
 * has a finite time, or a reason the owner can see. `busy`: its check or save runs now, in this process.
 */
export function machineDue(machine: CloudMachineRecord, now: number, busy = false): { at: number } | { reason: string } {
  const at = (value: string | undefined, plus = 0): number => { const time = value ? Date.parse(value) : NaN; return Number.isFinite(time) ? time + plus : now; };
  if (busy) return { at: now + BUSY_POLL_MS };
  switch (machine.status) {
    case "starting": return { at: at(machine.startingAt ?? machine.createdAt, START_LIMIT_MS) };
    // A save marked running with nothing running it was cut off by a restart: it is due now.
    case "awake": return { at: machine.save ? at(machine.save.running ? undefined : machine.save.nextTryAt) : at(machine.checkedAt, machine.checkedAt ? IDLE_CHECK_MS : 0) };
    case "asleep": return { reason: machine.error ?? "It is asleep with its state saved" };
    case "failed": return { reason: machine.error || "It did not start" };
  }
}

/** What is wrong with a machine, in words for the owner; undefined when nothing is. */
export function machineProblem(machine: CloudMachineRecord): string | undefined {
  const save = machine.save;
  if (machine.status === "awake" && save?.error) {
    return `awake, could not save; ${save.attempts} ${save.attempts === 1 ? "attempt" : "attempts"}; last tried at ${save.lastTriedAt}${save.nextTryAt ? `; next try at ${save.nextTryAt}` : ""}: ${save.error}`;
  }
  return machine.error;
}

function reason(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message.slice(0, 300) : fallback;
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export class CloudMachines {
  private waking = new Map<string, Promise<void>>();
  /** Machines that a check or a save talks to now. */
  private own = new Set<string>();
  private async direct<T>(id: string, run: () => Promise<T>): Promise<T> {
    this.own.add(id);
    try { return await run(); } finally { this.own.delete(id); }
  }
  /** A last look at a machine's followed threads before it sleeps. */
  beforeSleep?: (id: string) => Promise<void>;
  /** Sends the owner a notice. Unset, a notice is only kept on the machine, where status and `cloud_machines` show it. */
  notice?: (group: string, text: string) => void;
  /** Keeps background checks and saves alive past the coordinator's run, and runs the coordinator again after them. */
  background?: { track(work: Promise<unknown>): void; wake(): unknown };
  /** Each machine's model budget; see `cloud-model.ts`. */
  readonly budget: CloudModelBudget;
  constructor(private readonly db: Database, private readonly t3: T3CodeStore, private readonly options: CloudMachineOptions, private readonly now = () => Date.now()) {
    db.all("CREATE TABLE IF NOT EXISTS umpi_cloud_machines (id TEXT PRIMARY KEY, token TEXT NOT NULL UNIQUE, data TEXT NOT NULL)");
    this.budget = new CloudModelBudget(db, now);
    t3.cloud = {
      // Umpi's own calls in a check or a save go to the machine as it is.
      prepare: async id => { if (!this.own.has(id)) await this.ensureAwake(id); },
      asleep: id => { const machine = this.find(id); return machine && machine.status !== "awake" ? { ...(machine.threads ? { threads: machine.threads } : {}) } : undefined; },
      defaults: id => { const projectId = this.find(id)?.projectId; return { ...(projectId ? { projectId } : {}), modelSelection: CLOUD_MODEL }; },
    };
  }

  private find(id: string): CloudMachineRecord | undefined {
    const row = this.db.all<{ data: string }>("SELECT data FROM umpi_cloud_machines WHERE id=?", id)[0];
    return row ? JSON.parse(row.data) as CloudMachineRecord : undefined;
  }
  private get(id: string): CloudMachineRecord {
    const machine = this.find(id);
    if (!machine) throw new StateError(404, "No cloud machine with that ID");
    return machine;
  }
  private save(machine: CloudMachineRecord): void { this.db.all("UPDATE umpi_cloud_machines SET data=? WHERE id=?", JSON.stringify(machine), machine.id); }
  private token(id: string): string { return this.db.all<{ token: string }>("SELECT token FROM umpi_cloud_machines WHERE id=?", id)[0]!.token; }
  /** Gives the machine a new gateway token; the one before stops working at once. */
  private rotate(id: string): string {
    const token = randomToken();
    this.db.all("UPDATE umpi_cloud_machines SET token=? WHERE id=?", token, id);
    return token;
  }
  private iso(at = this.now()): string { return new Date(at).toISOString(); }
  /** Records a notice on the machine (the caller saves it) and sends it to the owner when a sender is set. */
  private tell(machine: CloudMachineRecord, kind: string, text: string): void {
    machine.notices = (machine.notices ?? 0) + 1;
    machine.notice = { at: this.iso(), text };
    try { this.notice?.(`cloud-machine:${machine.id}:${kind}:${machine.notices}`, text); } catch { /* the notice stays on the machine */ }
  }
  private key(id: string): string { return `cloud-machines/${id}/state.tar.zst`; }

  list(): CloudMachineRecord[] {
    return this.db.all<{ data: string }>("SELECT data FROM umpi_cloud_machines").map(row => JSON.parse(row.data) as CloudMachineRecord)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  /** The machine a gateway token belongs to. */
  machineFor(token: string): string | undefined {
    return this.db.all<{ id: string }>("SELECT id FROM umpi_cloud_machines WHERE token=?", token)[0]?.id;
  }
  /**
   * One model request from a machine, for the gateway. A machine that Umpi does not run now has no use for the
   * gateway, so its token is refused: a copy of a token is worth nothing while the machine sleeps. The request is
   * counted against the machine's budget (`CloudModelRefused` over it) and noted as use.
   */
  used(id: string): CloudModelAdmission {
    const machine = this.find(id);
    if (!machine || (machine.status !== "awake" && machine.status !== "starting")) throw new StateError(401, "This cloud machine is not awake; its model access works only while Umpi runs it");
    const admission = this.budget.admit(id);
    this.touch(id);
    return admission;
  }
  private touch(id: string): void {
    const machine = this.find(id);
    if (machine) { machine.lastUseAt = this.iso(); machine.idleChecks = 0; this.save(machine); }
  }
  /** Finds a machine by ID or name. */
  pick(value: unknown): CloudMachineRecord {
    const name = String(value ?? "").trim().toLowerCase();
    const machines = this.list();
    const found = machines.find(item => item.id === value) ?? machines.find(item => item.label.toLowerCase() === name) ?? machines.find(item => item.label.toLowerCase().includes(name));
    if (!name || !found) throw new T3Error(`No cloud machine called "${String(value ?? "").slice(0, 60)}". Cloud machines: ${machines.map(item => item.label).join(", ") || "none"}`);
    return found;
  }

  /** Wakes a machine (restoring its saved state) unless it is already awake; concurrent callers share one wake. */
  async ensureAwake(id: string): Promise<void> {
    // A save in progress finishes first: a saved machine then wakes, and one that could not be saved is taken up again.
    const saving = this.sleeping.get(id);
    if (saving) await saving.catch(() => undefined);
    const machine = this.get(id);
    if (machine.status === "awake") {
      // A failed save stopped T3 Code. The machine is wanted again, so the wake below starts T3 Code on it.
      if (await this.options.stub(id).isRunning()) { if (!machine.save) return; }
      else await this.lost(id, "wake");
    }
    const pending = this.waking.get(id);
    if (pending) return pending;
    const work = this.wake(id).finally(() => this.waking.delete(id));
    this.waking.set(id, work);
    return work;
  }
  private async wake(id: string): Promise<void> {
    const start = this.options.start();
    if (!start) throw new T3Error("Cloud machines are not set up on this Umpi");
    const awake = this.list().filter(item => item.id !== id && (item.status === "awake" || item.status === "starting")).length;
    if (awake >= CLOUD_MAX_AWAKE) throw new T3Error(`${awake} cloud machines are already awake; let one finish or put one to sleep first`);
    const machine = this.get(id), stub = this.options.stub(id);
    // It was saved before: it must come back with that state, never with an empty home.
    const saved = (machine.savedBytes ?? 0) > 0;
    // Awake with a save that failed: only T3 Code is started again. If that fails, the save stays due.
    const unsaved = machine.status === "awake" ? machine.save : undefined;
    machine.status = "starting"; machine.startingAt = this.iso(); delete machine.error; this.save(machine);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // Each run of the container gets its own gateway token: one copied out of an earlier run no longer works.
      const modelToken = await stub.isRunning() ? this.token(id) : this.rotate(id);
      const { token } = await Promise.race([stub.wake({ ...start, modelToken }, this.key(id), { saved }),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("It did not finish starting in 15 minutes")), START_LIMIT_MS); })]);
      this.t3.registerCloud(id, machine.label, token);
      const latest = this.get(id);
      Object.assign(latest, { status: "awake", wokeAt: this.iso(), lastUseAt: this.iso(), idleChecks: 0 });
      delete latest.startingAt; delete latest.save; delete latest.restoreFailures; delete latest.checkedAt;
      this.save(latest);
    } catch (error) {
      const latest = this.get(id);
      delete latest.startingAt;
      if (unsaved && await Promise.resolve(stub.isRunning()).catch(() => false)) {
        Object.assign(latest, { status: "awake", save: unsaved });
        this.save(latest);
        throw new T3Error(`${machine.label} is awake but T3 Code did not start on it again: ${reason(error, "no answer")}`);
      }
      latest.status = "failed"; latest.error = reason(error, "It did not start");
      delete latest.save;
      if (latest.error.includes(RESTORE_FAILED)) {
        latest.restoreFailures = (latest.restoreFailures ?? 0) + 1;
        // Told once for each run of failures, not at every try.
        if (latest.restoreFailures === 1) this.tell(latest, "restore", `${machine.label} did not wake: ${latest.error}. It was stopped, and its saved state is unchanged. Waking it again tries the restore again.`);
      }
      this.save(latest);
      throw new T3Error(`${machine.label} did not start: ${latest.error}`);
    } finally { clearTimeout(timer); }
  }

  /** A machine marked awake whose container is gone: it wakes again from its last save. */
  private async lost(id: string, where: string): Promise<void> {
    const reachable = await this.options.stub(id).reachable?.().catch(() => false);
    console.log(JSON.stringify({ event: "cloud-machine-lost", id, where, reachable }));
    const machine = this.get(id);
    Object.assign(machine, { status: "asleep", idleChecks: 0, error: "It stopped unexpectedly; work since its last save was lost" });
    delete machine.save;
    this.tell(machine, "lost", `${machine.label} stopped unexpectedly. Work since its last save was lost; work that was pushed is safe. It wakes again from that save.`);
    this.save(machine);
  }

  private sleeping = new Map<string, Promise<CloudMachineRecord>>();
  /** Saves a machine to R2 and stops it; concurrent callers share one save. */
  async sleep(id: string): Promise<CloudMachineRecord> {
    const pending = this.sleeping.get(id);
    if (pending) return pending;
    const work = this.save_(id).finally(() => this.sleeping.delete(id));
    this.sleeping.set(id, work);
    return work;
  }

  /**
   * A machine that got a stop signal (an image rollout or a platform restart) asks to be saved, with its own token.
   * It has 15 minutes; the save starts at once. Returns the machine, or undefined for an unknown token.
   */
  stopping(token: string): { id: string; save: Promise<unknown> } | undefined {
    const id = this.machineFor(token);
    if (!id) return undefined;
    return { id, save: this.sleep(id).catch(() => undefined) };
  }

  /**
   * One attempt to save. Before it starts, the attempt is written to the machine, so a restart continues it. When it
   * fails, the machine stays awake with its work and the next attempt is set: `SAVE_RETRY_MS`, then once an hour.
   * After `SAVE_ATTEMPTS` the owner is told. Umpi never stops a machine that it could not save.
   */
  private async save_(id: string): Promise<CloudMachineRecord> {
    const machine = this.get(id);
    if (machine.status !== "awake") return machine;
    const attempts = (machine.save?.attempts ?? 0) + 1, since = machine.save?.since ?? this.iso(), told = machine.save?.told;
    machine.save = { since, attempts, lastTriedAt: this.iso(), running: true, ...(told ? { told } : {}) };
    this.save(machine);
    // A failed attempt has stopped T3 Code already, so only the first attempt can look at threads.
    if (attempts === 1) {
      try { await this.direct(id, async () => this.beforeSleep?.(id)); } catch { /* sleeping matters more than one notice */ }
      // Its threads, as they were, so lists show them while it sleeps.
      try { const { threads } = await this.direct(id, () => this.t3.threads(id, { limit: 20 })); this.save({ ...this.get(id), threads }); } catch { /* keep the last list */ }
    }
    try {
      // A save that never finishes must not hold up Umpi's other work.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const result = await Promise.race([this.options.stub(id).save(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new T3Error("Saving took longer than ten minutes")), SAVE_LIMIT_MS); })])
        .finally(() => clearTimeout(timer));
      // The container was gone and held nothing saved: that is lost work, not a sleep.
      if (result.lost) { await this.lost(id, "save"); return this.get(id); }
      const latest = this.get(id);
      Object.assign(latest, { status: "asleep", sleptAt: this.iso(), savedBytes: result.size, idleChecks: 0 });
      delete latest.save; delete latest.error;
      if (told) this.tell(latest, "saved", `${latest.label} is saved now and asleep.`);
      this.save(latest);
      return latest;
    } catch (error) {
      const latest = this.get(id), why = reason(error, "The save failed"), last = attempts >= SAVE_ATTEMPTS;
      latest.save = { since, attempts, lastTriedAt: latest.save?.lastTriedAt ?? this.iso(), error: why, nextTryAt: this.iso(this.now() + (SAVE_RETRY_MS[attempts - 1] ?? SAVE_SLOW_RETRY_MS)), ...(told || last ? { told: true } : {}) };
      if (last && !told) this.tell(latest, "unsaved", `${latest.label} is awake and could not be saved after ${attempts} attempts: ${why}. It keeps running with its work, and Umpi tries again every hour and when you ask it to sleep. Push work you need. Deleting the machine loses work that is not pushed.`);
      this.save(latest);
      // The machine stays awake from here on, so T3 Code, which the save stopped, is started again.
      if (last) await this.resume(id).catch(() => undefined);
      throw new T3Error(`${latest.label} could not be saved (attempt ${attempts}): ${why}. It stays awake with its work; Umpi tries again at ${latest.save.nextTryAt}.`);
    }
  }

  /** Starts T3 Code again on a running machine that a failed save left without it. */
  private async resume(id: string): Promise<void> {
    const start = this.options.start(), stub = this.options.stub(id);
    if (!start || !await stub.isRunning()) return;
    const { token } = await stub.wake({ ...start, modelToken: this.token(id) }, this.key(id), { saved: true });
    this.t3.registerCloud(id, this.get(id).label, token);
  }

  /** Creates a machine for one task: clones the repository, makes it a T3 Code project, and starts a Pi thread. */
  async create(input: { title: string; task: string; repo?: string; branch?: string; plan?: boolean }): Promise<{ machine: CloudMachineRecord; threadId?: string }> {
    if (!this.options.start()) throw new T3Error("Cloud machines are not set up on this Umpi");
    if (this.list().length >= CLOUD_MAX_MACHINES) throw new T3Error(`There are already ${CLOUD_MAX_MACHINES} cloud machines; delete finished ones first`);
    const awake = this.list().filter(item => item.status === "awake" || item.status === "starting").length;
    if (awake >= CLOUD_MAX_AWAKE) throw new T3Error(`${awake} cloud machines are already awake; let one finish or put one to sleep first`);
    const repo = input.repo ? githubRemote(input.repo) : undefined;
    const id = `cloud-${crypto.randomUUID().replace(/-/g, "").slice(0, 10)}`;
    const machine: CloudMachineRecord = { id, label: input.title.slice(0, 60), ...(repo ? { repo: repo.remote } : {}), ...(input.branch ? { branch: input.branch } : {}),
      status: "starting", createdAt: new Date(this.now()).toISOString(), idleChecks: 0 };
    this.db.all("INSERT INTO umpi_cloud_machines VALUES (?, ?, ?)", id, randomToken(), JSON.stringify(machine));
    await this.ensureAwake(id);
    const folder = `/home/agent/work/${repo?.name ?? "scratch"}`;
    if (repo) await this.t3.call(id, "t3_project_clone", { destinationPath: folder, remoteUrl: repo.remote, protocol: "ssh" });
    const project = record(await this.t3.call(id, "t3_project_create", { title: repo?.name ?? input.title.slice(0, 60), workspaceRoot: folder, createWorkspaceRootIfMissing: true,
      defaultModelSelection: CLOUD_MODEL }));
    const projectId = typeof project.id === "string" ? project.id : typeof project.projectId === "string" ? project.projectId : undefined;
    if (projectId) this.save({ ...this.get(id), projectId });
    const launched = record(await this.t3.call(id, "t3_thread_launch", { title: input.title.slice(0, 120), message: input.task, clientRequestId: `umpi-${id}-first`,
      ...(projectId ? { projectId } : { scratch: true }), modelSelection: CLOUD_MODEL, runtimeMode: "full-access",
      ...(input.branch ? { workspaceStrategy: { type: "worktree", branch: input.branch } } : {}), ...(input.plan ? { interactionMode: "plan" } : {}) }));
    const created = Array.isArray(launched.threads) && launched.threads.length ? record(launched.threads[0]) : launched;
    return { machine: this.get(id), ...(typeof created.threadId === "string" ? { threadId: created.threadId } : {}) };
  }

  /** Deletes a machine and its saved state. */
  async remove(id: string): Promise<{ removed: true; note?: string }> {
    const machine = this.get(id);
    // First, so the token is dead even when a later step fails and the machine stays listed.
    this.rotate(id);
    let note: string | undefined;
    if (machine.address) {
      try { await this.options.dns?.()?.remove(new URL(machine.address).hostname); }
      catch (error) { note = `Its address could not be removed (${error instanceof Error ? error.message.slice(0, 150) : "unknown"}); it now leads nowhere.`; }
    }
    await this.options.stub(id).discard();
    await this.options.deleteSaved(this.key(id));
    try { this.t3.remove(id); } catch { /* never registered */ }
    this.db.all("DELETE FROM umpi_cloud_machines WHERE id=?", id);
    this.budget.forget(id);
    return { removed: true, ...(note ? { note } : {}) };
  }

  /**
   * Opens a machine in the owner's T3 Code app: wakes it, gives it its public address (a DNS name the first time), and
   * returns a one-time pairing link for that address. Pairing is once per machine; it survives sleep, for 30 days.
   */
  async open(id: string): Promise<{ address: string; pairUrl: string; expiresAt?: string; firstTime: boolean }> {
    const domain = this.options.publicDomain?.(), dns = this.options.dns?.();
    if (!domain || !dns) throw new T3Error("Opening cloud machines in T3 Code's app is not set up on this Umpi");
    const hostname = `${id.replace(/^cloud-/, "")}-umpi.${domain}`, address = `https://${hostname}`;
    const firstTime = this.get(id).address !== address;
    const step = async <T>(what: string, run: () => Promise<T>): Promise<T> => {
      try { return await run(); }
      catch (error) { throw error instanceof T3Error ? error : new T3Error(`${what}: ${error instanceof Error ? error.message.slice(0, 200) : "failed"}`); }
    };
    if (firstTime) {
      await step("Its address could not be made", () => dns.add(hostname));
      const machine = this.get(id); machine.address = address; this.save(machine);
    }
    await this.ensureAwake(id);
    const stub = this.options.stub(id);
    await step("It could not be published", () => stub.publish(hostname));
    const pairing = await step("T3 Code did not issue a pairing link", () => stub.pairing(address));
    this.touch(id);
    return { address, ...pairing, firstTime };
  }

  private checks = new Map<string, Promise<void>>();
  private busy(id: string): boolean { return this.checks.has(id) || this.sleeping.has(id); }

  /**
   * Starts what is due and returns at once. A check asks the machine and T3 Code, and a save can take ten minutes, so
   * each machine's work runs in the background, one job for each machine. What a job has begun is on the machine's
   * record (`save`, `startingAt`): after a restart, the next drive continues from there.
   */
  drive(): void {
    const now = this.now();
    for (const machine of this.list()) {
      if (this.busy(machine.id) || this.waking.has(machine.id)) continue;
      const due = machineDue(machine, now);
      // The coordinator runs often; each machine is checked at most every two minutes.
      if (!("at" in due) || due.at - 5_000 > now) continue;
      const work = this.check(machine.id).catch(() => undefined).finally(() => { this.checks.delete(machine.id); void this.background?.wake(); });
      this.checks.set(machine.id, work);
      this.background?.track(work);
    }
  }
  /** Resolves when no background check or save is running. */
  async settled(): Promise<void> {
    while (this.checks.size || this.sleeping.size) await Promise.allSettled([...this.checks.values(), ...this.sleeping.values()]);
  }

  /** One machine's check: a machine with nothing working for two checks is saved and stopped. */
  private async check(id: string): Promise<void> {
    const machine = this.get(id), stub = this.options.stub(id);
    const ask = async <T>(question: Promise<T> | T): Promise<T> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      return Promise.race([Promise.resolve(question), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new T3Error("The machine did not answer")), ASK_LIMIT_MS); })]).finally(() => clearTimeout(timer));
    };
    if (machine.status === "starting") {
      // A wake with nothing running it: the coordinator restarted during it. The machine's own timer saves or stops
      // whatever the wake left running.
      Object.assign(machine, { status: "failed", error: "It did not finish starting. Wake it to try again; its saved state is unchanged." });
      delete machine.startingAt;
      this.save(machine);
      return;
    }
    if (machine.status !== "awake") return;
    const state = await ask(stub.condition());
    if (!state.running) {
      // A save that was cut off may have finished: the machine's own answer says whether it did.
      if (machine.save) await this.sleep(id); else await this.lost(id, "check");
      return;
    }
    if (machine.save) {
      // After the owner was told, T3 Code runs again. Work that started since then is not interrupted by a save.
      if (machine.save.told && !state.stopping && await this.inUse(id, ask).catch(() => false)) {
        const latest = this.get(id);
        if (latest.save) { latest.save.nextTryAt = this.iso(this.now() + SAVE_SLOW_RETRY_MS); this.save(latest); }
        return;
      }
      await this.sleep(id);
      return;
    }
    // It got a stop signal and its request to be saved did not arrive: save it now, within its 15 minutes.
    if (state.stopping) { await this.sleep(id); return; }
    const used = await this.inUse(id, ask);
    const latest = this.get(id);
    latest.idleChecks = used ? 0 : latest.idleChecks + 1;
    this.save(latest);
    if (latest.idleChecks >= 2) await this.sleep(id);
  }

  /** Lists the machine's threads and notes the check. In use: a thread works, the gateway was used lately, or the owner's app is. */
  private async inUse(id: string, ask: <T>(question: Promise<T> | T) => Promise<T>): Promise<boolean> {
    const { threads } = await this.direct(id, () => this.t3.threads(id, { limit: 20 }));
    const latest = this.get(id);
    latest.threads = threads;
    latest.checkedAt = this.iso();
    const recent = latest.lastUseAt ? this.now() - Date.parse(latest.lastUseAt) < RECENT_USE_MS : false;
    const working = threads.some(thread => ACTIVE.has(thread.status) && thread.status !== "waiting");
    if (working) latest.activeAt = latest.checkedAt;
    this.save(latest);
    // The owner's T3 Code app, while connected and in use, keeps it awake, but not for ever.
    const app = latest.address ? await ask(this.options.stub(id).inUse()) : undefined;
    const since = Math.max(latest.activeAt ? Date.parse(latest.activeAt) : 0, latest.wokeAt ? Date.parse(latest.wokeAt) : 0);
    const appInUse = !!app && app.sockets > 0 && this.now() - app.appAt < APP_QUIET_MS && this.now() - since < APP_AWAKE_MS;
    return working || recent || appInUse;
  }

  /** The soonest time a machine needs the coordinator: never now, and never missing while a machine is not final. */
  nextDue(): number | undefined {
    const now = this.now();
    const due = this.list().flatMap(machine => {
      const next = machineDue(machine, now, this.busy(machine.id));
      if (!("at" in next)) return [];
      // A wake that runs now ends by itself; until then the coordinator only looks again.
      return [next.at <= now && this.waking.has(machine.id) ? now + BUSY_POLL_MS : next.at];
    });
    return due.length ? Math.max(now + 1_000, Math.min(...due)) : undefined;
  }

  status(): object {
    const machines = this.list(), now = this.now();
    return { machines: machines.length, awake: machines.filter(item => item.status === "awake").length, asleep: machines.filter(item => item.status === "asleep").length, failed: machines.filter(item => item.status === "failed").length,
      unsaved: machines.filter(item => item.status === "awake" && item.save?.error).length,
      modelLimits: { requestsPerMinute: CLOUD_MODEL_REQUESTS_PER_MINUTE, requestsPerDay: CLOUD_MODEL_REQUESTS_PER_DAY, tokensPerDay: CLOUD_MODEL_TOKENS_PER_DAY },
      list: machines.map(item => {
        const next = machineDue(item, now, this.busy(item.id));
        return { id: item.id, status: item.status, idleChecks: item.idleChecks, checkedAt: item.checkedAt, lastUseAt: item.lastUseAt, wokeAt: item.wokeAt, sleptAt: item.sleptAt, savedBytes: item.savedBytes, error: item.error,
          problem: machineProblem(item), save: item.save, startingAt: item.startingAt, notice: item.notice, nextAt: "at" in next ? this.iso(next.at) : null, model: this.budget.status(item.id) };
      }) };
  }
}

/** Umpi's tools for cloud machines. Threads on them are read and acted on with the T3 Code tools. */
export function cloudMachineTools(machines: CloudMachines, watcher?: T3Watcher): ToolRegistration[] {
  const result = async (run: () => Promise<unknown>): Promise<ToolExecutionResult> => {
    try { return { content: [{ type: "text", text: JSON.stringify(await run()) }] }; }
    catch (error) { return { isError: true, content: [{ type: "text", text: error instanceof T3Error || error instanceof InputError || error instanceof StateError ? error.message : "The cloud machine did not respond." }] }; }
  };
  const view = (machine: CloudMachineRecord) => ({ id: machine.id, name: machine.label, status: machine.status, repo: machine.repo, branch: machine.branch,
    sleptAt: machine.sleptAt, threads: machine.threads?.map(thread => ({ threadId: thread.threadId, title: thread.title, status: thread.status })), error: machine.error, problem: machineProblem(machine) });
  return [
    defineTool({ name: "cloud_machine_start", description: "Start a new cloud machine for one coding task when the owner asks for work in the cloud: a fresh container with T3 Code and the Pi agent, which clones the GitHub repository (owner/name), optionally works on a new branch, and starts a thread with the task. Pi uses Umpi's own model login. The machine sleeps by itself once nothing is working and wakes when used. Follow it with the T3 Code tools, naming the machine.",
      parameters: Type.Object({ title: Type.String({ minLength: 1, maxLength: 60 }), task: Type.String({ minLength: 1, maxLength: 60_000 }), repo: Type.Optional(Type.String({ maxLength: 200 })),
        branch: Type.Optional(Type.String({ maxLength: 120 })), plan: Type.Optional(Type.Boolean()) }, { additionalProperties: false }),
      replay: "unsafe",
      async execute(input) {
        return result(async () => {
          const body = record(input);
          const created = await machines.create({ title: boundedText(body.title, 60, "title"), task: boundedText(body.task, 60_000, "task"),
            ...(typeof body.repo === "string" && body.repo ? { repo: body.repo } : {}), ...(typeof body.branch === "string" && body.branch ? { branch: body.branch } : {}), ...(body.plan === true ? { plan: true } : {}) });
          if (created.threadId) watcher?.arm(created.machine.id, created.threadId, "cloud", created.machine.label);
          return { machine: view(created.machine), threadId: created.threadId, ...(created.threadId && watcher ? { following: true } : {}) };
        });
      } }),
    defineTool({ name: "cloud_machines", description: "List the owner's cloud machines: awake or asleep, repository, and their threads as last seen. `problem` says what is wrong with one, such as a machine that is awake because it could not be saved; tell the owner. Read-only; does not wake anything.",
      parameters: Type.Object({}, { additionalProperties: false }), replay: "safe",
      async execute() { return result(async () => ({ machines: machines.list().map(view) })); } }),
    defineTool({ name: "cloud_machine_open", description: "When the owner wants to open a cloud machine in T3 Code's own app (phone or desktop): wakes it and returns its address and a one-time pairing link, valid 15 minutes. Give the owner the pairLink exactly as returned, and say: copy it, then in T3 Code add an environment and paste it. Pairing is needed once per machine (firstTime); after that the app finds it at its address whenever it is awake, for 30 days. A sleeping machine is not reachable from the app: it is woken from Umpi.",
      parameters: Type.Object({ machine: Type.String({ maxLength: 100 }) }, { additionalProperties: false }), replay: "safe",
      async execute(input) {
        return result(async () => {
          const machine = machines.pick(record(input).machine);
          const opened = await machines.open(machine.id);
          return { machine: machine.label, address: opened.address, pairLink: opened.pairUrl, expiresAt: opened.expiresAt, firstTime: opened.firstTime };
        });
      } }),
    defineTool({ name: "cloud_machine_wake", description: "Wake a sleeping cloud machine, restoring its saved state, so the owner can continue in T3 Code. Messaging one of its threads wakes it too.",
      parameters: Type.Object({ machine: Type.String({ maxLength: 100 }) }, { additionalProperties: false }), replay: "safe",
      async execute(input) { return result(async () => { const machine = machines.pick(record(input).machine); await machines.ensureAwake(machine.id); return { awake: true, machine: machine.label }; }); } }),
    defineTool({ name: "cloud_machine_sleep", description: "Save a cloud machine and stop it now, when the owner asks. Machines also sleep by themselves once nothing is working.",
      parameters: Type.Object({ machine: Type.String({ maxLength: 100 }) }, { additionalProperties: false }), replay: "safe",
      async execute(input) { return result(async () => view(await machines.sleep(machines.pick(record(input).machine).id))); } }),
    defineTool({ name: "cloud_machine_delete", description: "Delete a cloud machine and its saved state, when the owner asks. Unpushed work on it is lost.",
      parameters: Type.Object({ machine: Type.String({ maxLength: 100 }) }, { additionalProperties: false }), replay: "unsafe",
      async execute(input) { return result(async () => machines.remove(machines.pick(record(input).machine).id)); } }),
  ];
}
