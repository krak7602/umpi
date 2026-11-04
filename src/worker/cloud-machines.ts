import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolExecutionResult, type ToolRegistration } from "@earendil-works/pi-durable";
import { InputError, boundedText, record } from "../shared/protocol.js";
import { StateError, type Database } from "./store.js";
import { T3Error, type T3CodeStore, type T3Thread } from "./t3-code.js";
import type { T3Watcher } from "./t3-watch.js";

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
}
export interface CloudMachineStub {
  wake(start: CloudMachineStart, snapshotKey: string): Promise<{ token: string; restored: boolean }>;
  isRunning(): Promise<boolean> | boolean;
  save(): Promise<{ size: number }>;
  discard(): Promise<void>;
}
export interface CloudMachineOptions {
  stub(id: string): CloudMachineStub;
  /** Everything a start needs except the machine's own gateway token; undefined when cloud machines are not set up. */
  start(): Omit<CloudMachineStart, "modelToken"> | undefined;
  deleteSaved(key: string): Promise<void>;
}

export const CLOUD_MAX_AWAKE = 6;
export const CLOUD_MAX_MACHINES = 24;
const IDLE_CHECK_MS = 120_000;
const SAVE_LIMIT_MS = 600_000;
const RECENT_USE_MS = 180_000;
const ACTIVE = new Set(["preparing", "queued", "starting", "running", "waiting"]);

/** `owner/name`, or a GitHub SSH or HTTPS address, as an SSH address. */
export function githubRemote(value: string): { remote: string; name: string } {
  const text = value.trim().replace(/\.git$/, "");
  const match = /^(?:git@github\.com:|https:\/\/github\.com\/|ssh:\/\/git@github\.com\/)?([A-Za-z0-9_.-]{1,100})\/([A-Za-z0-9_.-]{1,100})$/.exec(text);
  if (!match) throw new InputError("repo must be owner/name or a GitHub address");
  return { remote: `git@github.com:${match[1]}/${match[2]}.git`, name: match[2]! };
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export class CloudMachines {
  private waking = new Map<string, Promise<void>>();
  /** A last look at a machine's followed threads before it sleeps. */
  beforeSleep?: (id: string) => Promise<void>;
  constructor(private readonly db: Database, private readonly t3: T3CodeStore, private readonly options: CloudMachineOptions, private readonly now = () => Date.now()) {
    db.all("CREATE TABLE IF NOT EXISTS umpi_cloud_machines (id TEXT PRIMARY KEY, token TEXT NOT NULL UNIQUE, data TEXT NOT NULL)");
    t3.cloud = {
      prepare: id => this.ensureAwake(id),
      asleep: id => { const machine = this.find(id); return machine && machine.status !== "awake" ? { ...(machine.threads ? { threads: machine.threads } : {}) } : undefined; },
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
  private key(id: string): string { return `cloud-machines/${id}/state.tar.zst`; }

  list(): CloudMachineRecord[] {
    return this.db.all<{ data: string }>("SELECT data FROM umpi_cloud_machines").map(row => JSON.parse(row.data) as CloudMachineRecord)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  /** The machine a gateway token belongs to. */
  machineFor(token: string): string | undefined {
    return this.db.all<{ id: string }>("SELECT id FROM umpi_cloud_machines WHERE token=?", token)[0]?.id;
  }
  used(id: string): void {
    const machine = this.find(id);
    if (machine) { machine.lastUseAt = new Date(this.now()).toISOString(); machine.idleChecks = 0; this.save(machine); }
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
    const machine = this.get(id);
    if (machine.status === "awake") {
      if (await this.options.stub(id).isRunning()) return;
      this.lost(id);
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
    const machine = this.get(id);
    machine.status = "starting"; delete machine.error; this.save(machine);
    try {
      const { token } = await this.options.stub(id).wake({ ...start, modelToken: this.token(id) }, this.key(id));
      this.t3.registerCloud(id, machine.label, token);
      const latest = this.get(id);
      Object.assign(latest, { status: "awake", wokeAt: new Date(this.now()).toISOString(), lastUseAt: new Date(this.now()).toISOString(), idleChecks: 0 });
      this.save(latest);
    } catch (error) {
      const latest = this.get(id);
      latest.status = "failed"; latest.error = error instanceof Error ? error.message.slice(0, 300) : "It did not start";
      this.save(latest);
      throw new T3Error(`${machine.label} did not start: ${latest.error}`);
    }
  }

  /** A machine marked awake whose container is gone: it wakes again from its last save. */
  private lost(id: string): void {
    const machine = this.get(id);
    Object.assign(machine, { status: "asleep", idleChecks: 0, error: "It stopped unexpectedly; work since its last save was lost" });
    this.save(machine);
  }

  /** Saves a machine to R2 and stops it. */
  async sleep(id: string): Promise<CloudMachineRecord> {
    const machine = this.get(id);
    if (machine.status !== "awake") return machine;
    try { await this.beforeSleep?.(id); } catch { /* sleeping matters more than one notice */ }
    // Its threads, as they were, so lists show them while it sleeps.
    try { machine.threads = (await this.t3.threads(id, { limit: 20 })).threads; } catch { /* keep the last list */ }
    // A save that never finishes must not hold up Umpi's other work.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const { size } = await Promise.race([this.options.stub(id).save(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new T3Error("Saving took longer than ten minutes")), SAVE_LIMIT_MS); })])
      .finally(() => clearTimeout(timer));
    Object.assign(machine, { status: "asleep", sleptAt: new Date(this.now()).toISOString(), savedBytes: size, idleChecks: 0 });
    this.save(machine);
    return machine;
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
      defaultModelSelection: { provider: "pi", model: "default" } }));
    const projectId = typeof project.id === "string" ? project.id : typeof project.projectId === "string" ? project.projectId : undefined;
    const launched = record(await this.t3.call(id, "t3_thread_launch", { title: input.title.slice(0, 120), message: input.task, clientRequestId: `umpi-${id}-first`,
      ...(projectId ? { projectId } : { scratch: true }), modelSelection: { provider: "pi", model: "default" }, runtimeMode: "full-access",
      ...(input.branch ? { workspaceStrategy: { type: "worktree", branch: input.branch } } : {}), ...(input.plan ? { interactionMode: "plan" } : {}) }));
    const created = Array.isArray(launched.threads) && launched.threads.length ? record(launched.threads[0]) : launched;
    return { machine: this.get(id), ...(typeof created.threadId === "string" ? { threadId: created.threadId } : {}) };
  }

  /** Deletes a machine and its saved state. */
  async remove(id: string): Promise<{ removed: true }> {
    this.get(id);
    await this.options.stub(id).discard();
    await this.options.deleteSaved(this.key(id));
    try { this.t3.remove(id); } catch { /* never registered */ }
    this.db.all("DELETE FROM umpi_cloud_machines WHERE id=?", id);
    return { removed: true };
  }

  /** Every two minutes while a machine is awake: a machine with nothing working for two checks is saved and stopped. */
  async drive(): Promise<void> {
    for (const machine of this.list().filter(item => item.status === "awake")) {
      // The coordinator runs often; each machine is checked at most every two minutes.
      if (machine.checkedAt && this.now() - Date.parse(machine.checkedAt) < IDLE_CHECK_MS - 5_000) continue;
      try {
        if (!(await this.options.stub(machine.id).isRunning())) { this.lost(machine.id); continue; }
        const { threads } = await this.t3.threads(machine.id, { limit: 20 });
        const latest = this.get(machine.id);
        latest.threads = threads;
        latest.checkedAt = new Date(this.now()).toISOString();
        const recent = latest.lastUseAt ? this.now() - Date.parse(latest.lastUseAt) < RECENT_USE_MS : false;
        latest.idleChecks = threads.some(thread => ACTIVE.has(thread.status) && thread.status !== "waiting") || recent ? 0 : latest.idleChecks + 1;
        this.save(latest);
        if (latest.idleChecks >= 2) await this.sleep(machine.id);
      } catch { /* the next check tries again */ }
    }
  }
  nextDue(): number | undefined {
    const due = this.list().filter(item => item.status === "awake").map(item => item.checkedAt ? Date.parse(item.checkedAt) + IDLE_CHECK_MS : this.now());
    return due.length ? Math.max(this.now() + 1_000, Math.min(...due)) : undefined;
  }

  status(): { machines: number; awake: number; asleep: number; failed: number; list: object[] } {
    const machines = this.list();
    return { machines: machines.length, awake: machines.filter(item => item.status === "awake").length, asleep: machines.filter(item => item.status === "asleep").length, failed: machines.filter(item => item.status === "failed").length,
      list: machines.map(item => ({ id: item.id, status: item.status, idleChecks: item.idleChecks, checkedAt: item.checkedAt, lastUseAt: item.lastUseAt, wokeAt: item.wokeAt, sleptAt: item.sleptAt, savedBytes: item.savedBytes, error: item.error })) };
  }
}

/** Umpi's tools for cloud machines. Threads on them are read and acted on with the T3 Code tools. */
export function cloudMachineTools(machines: CloudMachines, watcher?: T3Watcher): ToolRegistration[] {
  const result = async (run: () => Promise<unknown>): Promise<ToolExecutionResult> => {
    try { return { content: [{ type: "text", text: JSON.stringify(await run()) }] }; }
    catch (error) { return { isError: true, content: [{ type: "text", text: error instanceof T3Error || error instanceof InputError || error instanceof StateError ? error.message : "The cloud machine did not respond." }] }; }
  };
  const view = (machine: CloudMachineRecord) => ({ id: machine.id, name: machine.label, status: machine.status, repo: machine.repo, branch: machine.branch,
    sleptAt: machine.sleptAt, threads: machine.threads?.map(thread => ({ threadId: thread.threadId, title: thread.title, status: thread.status })), error: machine.error });
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
    defineTool({ name: "cloud_machines", description: "List the owner's cloud machines: awake or asleep, repository, and their threads as last seen. Read-only; does not wake anything.",
      parameters: Type.Object({}, { additionalProperties: false }), replay: "safe",
      async execute() { return result(async () => ({ machines: machines.list().map(view) })); } }),
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
