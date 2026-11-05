import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolExecutionResult, type ToolRegistration } from "@earendil-works/pi-durable";
import { InputError, boundedText, record } from "../shared/protocol.js";
import { StateError, type Database, type Store, type TelegramMarkup } from "./store.js";
import { T3Error, type T3Action, type T3CodeStore } from "./t3-code.js";
import type { T3Watcher } from "./t3-watch.js";

/**
 * Actions on the owner's T3 Code threads. When the owner asked for an action in the conversation, Umpi acts at once.
 * When Umpi decided on its own (a background review), it asks first: a message with Approve and Decline buttons, in
 * Telegram and the app. Approve runs the action in code, not through another model turn, and posts the outcome.
 */
export interface T3ActionRequest {
  id: string;
  machineId: string;
  machineLabel: string;
  action: T3Action;
  summary: string;
  threadTitle?: string;
  why?: string;
  status: "pending" | "done" | "failed" | "declined" | "expired";
  createdAt: string;
  decidedAt?: string;
  outcome?: string;
}

const REQUEST_HOURS = 24;
const PREFIX = "t3a:";

export function describe(action: T3Action, machine: string, threadTitle?: string): string {
  const quote = (text: string) => text.length > 600 ? `${text.slice(0, 600)}…` : text;
  const thread = (id: string) => threadTitle ? `"${threadTitle}"` : `thread ${id}`;
  switch (action.kind) {
    case "send": return `Send to ${thread(action.threadId)} on ${machine}:\n\n${quote(action.message)}`;
    case "start": return `Start a thread "${action.title}" on ${machine}${action.project ? ` in ${action.project}` : ""}${action.branch ? ` on a new branch ${action.branch}` : action.worktree ? " in a new worktree" : ""}:\n\n${quote(action.message)}`;
    case "stop": return `Stop ${thread(action.threadId)} on ${machine}${action.reason ? ` (${action.reason})` : ""}.`;
    case "answer": return `Answer the question in ${thread(action.threadId)} on ${machine}:\n\n${quote(JSON.stringify(action.answers))}`;
  }
}

/** Checks a model's action input and returns the typed action. */
export function parseAction(input: Record<string, unknown>): T3Action {
  const kind = input.kind;
  const thread = () => boundedText(input.threadId, 100, "thread ID");
  if (kind === "send") {
    const mode = input.mode === undefined ? undefined : ["auto", "queue", "steer", "restart"].includes(String(input.mode)) ? input.mode as "auto" : (() => { throw new InputError("mode must be auto, queue, steer, or restart"); })();
    return { kind, threadId: thread(), message: boundedText(input.message, 60_000, "message"), ...(mode ? { mode } : {}) };
  }
  if (kind === "stop") return { kind, threadId: thread(), ...(input.reason ? { reason: boundedText(input.reason, 500, "reason") } : {}), ...(input.whole === false ? { whole: false } : {}) };
  if (kind === "answer") {
    const answers = record(input.answers);
    if (!Object.keys(answers).length || JSON.stringify(answers).length > 20_000) throw new InputError("answers must name each question's answer");
    return { kind, threadId: thread(), requestId: boundedText(input.requestId, 200, "request ID"), answers };
  }
  if (kind === "start") {
    return { kind, title: boundedText(input.title, 120, "title").trim(), message: boundedText(input.message, 60_000, "task"),
      ...(input.project ? { project: boundedText(input.project, 100, "project") } : {}), ...(input.projectId ? { projectId: boundedText(input.projectId, 100, "project ID") } : {}),
      ...(input.branch ? { branch: boundedText(input.branch, 120, "branch") } : {}), ...(input.baseRef ? { baseRef: boundedText(input.baseRef, 120, "base") } : {}),
      ...(input.worktree === true ? { worktree: true } : {}), ...(input.plan === true ? { plan: true } : {}) };
  }
  throw new InputError("kind must be send, start, stop, or answer");
}

export class T3ActionRequests {
  /** Follows the thread an approved action touched, and holds it when the Mac does not answer. */
  watcher?: T3Watcher;
  constructor(private readonly db: Database, private readonly owner: Store, private readonly t3: T3CodeStore, private readonly now = () => Date.now()) {
    db.all("CREATE TABLE IF NOT EXISTS umpi_t3_requests (id TEXT PRIMARY KEY, approve TEXT NOT NULL, decline TEXT NOT NULL, data TEXT NOT NULL)");
  }

  private row(id: string): T3ActionRequest | undefined {
    const row = this.db.all<{ data: string }>("SELECT data FROM umpi_t3_requests WHERE id=?", id)[0];
    return row ? JSON.parse(row.data) as T3ActionRequest : undefined;
  }
  private save(request: T3ActionRequest): void { this.db.all("UPDATE umpi_t3_requests SET data=? WHERE id=?", JSON.stringify(request), request.id); }
  private expire(request: T3ActionRequest): T3ActionRequest {
    if (request.status === "pending" && this.now() - Date.parse(request.createdAt) > REQUEST_HOURS * 3_600_000) {
      request.status = "expired"; request.decidedAt = new Date(this.now()).toISOString(); this.save(request);
    }
    return request;
  }

  /** Asks the owner to approve an action Umpi decided on. */
  request(machine: unknown, action: T3Action, why: string | undefined, threadTitle?: string): T3ActionRequest {
    const target = this.t3.pick(machine);
    const id = `t3r-${crypto.randomUUID()}`;
    const request: T3ActionRequest = { id, machineId: target.id, machineLabel: target.label, action, summary: describe(action, target.label, threadTitle), ...(threadTitle ? { threadTitle } : {}),
      ...(why ? { why } : {}), status: "pending", createdAt: new Date(this.now()).toISOString() };
    const approve = `${PREFIX}${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`, decline = `${PREFIX}${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
    this.db.all("INSERT INTO umpi_t3_requests VALUES (?, ?, ?, ?)", id, approve, decline, JSON.stringify(request));
    const markup: TelegramMarkup = { inline_keyboard: [[{ text: "Approve", callback_data: approve }, { text: "Decline", callback_data: decline }]] };
    this.owner.enqueue(this.group(id), "telegram", `T3 Code: may Umpi do this?\n\n${request.summary}${why ? `\n\nWhy: ${why}` : ""}`, markup);
    return request;
  }
  private group(id: string): string { return `t3-request:${id}`; }

  /**
   * A press on Approve or Decline. A Telegram press must come from the message that carried the button; an app press
   * names that message's group. Returns undefined for buttons that are not T3 requests.
   */
  async press(data: string, messageId: number | undefined, groupId?: string): Promise<{ text: string; replyMarkup: TelegramMarkup } | undefined> {
    if (!data.startsWith(PREFIX)) return undefined;
    const found = this.db.all<{ id: string; approve: string }>("SELECT id, approve FROM umpi_t3_requests WHERE approve=? OR decline=?", data, data)[0];
    if (!found) throw new StateError(409, "This request is no longer available");
    const group = this.group(found.id);
    const carried = this.owner.deliveries(group).some(delivery => delivery.channel === "telegram" && delivery.replyMarkup?.inline_keyboard.some(row => row.some(button => button.callback_data === data))
      && (messageId === undefined ? groupId === group : delivery.status === "sent" && delivery.messageId === messageId));
    if (!carried) throw new StateError(409, "This button does not belong to that message");
    const request = this.expire(this.row(found.id)!);
    const empty: TelegramMarkup = { inline_keyboard: [] };
    if (request.status !== "pending") return { text: request.status === "expired" ? "This request expired." : `Already ${request.status}.`, replyMarkup: empty };
    request.decidedAt = new Date(this.now()).toISOString();
    if (data !== found.approve) {
      request.status = "declined"; this.save(request);
      return { text: "Declined. Nothing was changed.", replyMarkup: empty };
    }
    // Claim it before the network call, so a second press cannot run it twice.
    request.status = "done"; request.outcome = "running"; this.save(request);
    let text: string;
    try {
      const ran = this.watcher
        ? await this.watcher.run(request.machineId, request.action, `umpi-${request.id}`, "approval", request.threadTitle)
        : { result: await this.t3.act(request.machineId, request.action, `umpi-${request.id}`) };
      request.outcome = JSON.stringify(ran.held ? { held: true } : ran.result ?? {}).slice(0, 1_000);
      text = ran.held ? `${request.machineLabel} did not answer. Umpi holds it and sends it when the machine is back.` : `Done on ${request.machineLabel}.`;
    } catch (error) {
      request.status = "failed";
      request.outcome = error instanceof Error ? error.message.slice(0, 500) : "failed";
      text = `It did not work: ${request.outcome}`;
    }
    this.save(request);
    this.owner.enqueue(`${group}:outcome`, "telegram", `T3 Code: ${text}`, undefined, undefined, undefined, { quiet: true });
    return { text, replyMarkup: empty };
  }

  /** The Approve or Decline button of a request, and the message group that carries it. */
  button(id: string, approve: boolean): { data: string; groupId: string } {
    const row = this.db.all<{ approve: string; decline: string }>("SELECT approve, decline FROM umpi_t3_requests WHERE id=?", id)[0];
    if (!row) throw new StateError(404, "No such request");
    return { data: approve ? row.approve : row.decline, groupId: this.group(id) };
  }

  /** The latest requests, newest first, for the app's cards: what is asked, and what became of it. */
  recent(limit = 30): (T3ActionRequest & { expiresAt: string })[] {
    return this.db.all<{ data: string }>("SELECT data FROM umpi_t3_requests ORDER BY rowid DESC LIMIT ?", limit)
      .map(row => this.expire(JSON.parse(row.data) as T3ActionRequest))
      .map(request => ({ ...request, expiresAt: new Date(Date.parse(request.createdAt) + REQUEST_HOURS * 3_600_000).toISOString() }));
  }

  pending(): T3ActionRequest[] {
    return this.db.all<{ data: string }>("SELECT data FROM umpi_t3_requests").map(row => this.expire(JSON.parse(row.data) as T3ActionRequest)).filter(item => item.status === "pending");
  }
}

const machine = Type.Optional(Type.String({ maxLength: 100, description: "Machine name or ID; needed only when more than one is connected" }));
const ActionFields = {
  threadId: Type.Optional(Type.String({ maxLength: 100 })),
  threadTitle: Type.Optional(Type.String({ maxLength: 200, description: "The thread's title, shown to the owner" })),
  message: Type.Optional(Type.String({ maxLength: 60_000, description: "send: the message; start: the task" })),
  mode: Type.Optional(Type.Union([Type.Literal("auto"), Type.Literal("queue"), Type.Literal("steer"), Type.Literal("restart")])),
  title: Type.Optional(Type.String({ maxLength: 120 })),
  project: Type.Optional(Type.String({ maxLength: 100, description: "start: project name; without one, a scratch folder" })),
  branch: Type.Optional(Type.String({ maxLength: 120, description: "start: work on this new branch in its own worktree" })),
  worktree: Type.Optional(Type.Boolean()),
  plan: Type.Optional(Type.Boolean({ description: "start: begin in plan mode" })),
  reason: Type.Optional(Type.String({ maxLength: 500 })),
  requestId: Type.Optional(Type.String({ maxLength: 200 })),
  answers: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
};

/** Umpi's tools that change T3 Code threads, and the request tool for actions Umpi decided on itself. */
export function t3ActionTools(t3: T3CodeStore, requests: T3ActionRequests, watcher?: T3Watcher): ToolRegistration[] {
  const result = async (run: () => Promise<unknown>): Promise<ToolExecutionResult> => {
    try { return { content: [{ type: "text", text: JSON.stringify(await run()) }] }; }
    catch (error) { return { isError: true, content: [{ type: "text", text: error instanceof T3Error || error instanceof InputError || error instanceof StateError ? error.message : "T3 Code did not complete the action." }] }; }
  };
  const owned = "Use only for what the owner asked for in this conversation. When you decide on an action yourself, use request_t3_action, which asks the owner first. Umpi then follows the thread and tells the owner when it finishes or waits on them; a machine that does not answer gets it when it is back.";
  const act = (kind: T3Action["kind"]) => async (input: unknown, api: { callId: string }) => result(async () => {
    const body = record(input);
    const target = t3.pick(body.machine), action = parseAction({ ...body, kind }), title = typeof body.threadTitle === "string" && body.threadTitle.trim() ? body.threadTitle.trim().slice(0, 200) : undefined;
    if (!watcher) return { machine: target.label, ...record(await t3.act(target.id, action, `umpi-${api.callId}`)) };
    const ran = await watcher.run(target.id, action, `umpi-${api.callId}`, "chat", title);
    if (ran.held) return { machine: target.label, held: true, note: `${target.label} did not answer (asleep or offline). Umpi holds this and sends it when the machine is back, then tells the owner. Say so in a few words; do not retry.` };
    return { machine: target.label, ...record(ran.result), ...(kind === "stop" ? {} : { following: true }) };
  });
  return [
    defineTool({ name: "t3_code_send", description: `Send a message to a T3 Code thread on the owner's machine: a follow-up, a correction, or "commit and push". mode auto (default) starts an idle thread, steers a running turn, or queues; queue, steer, and restart force one. ${owned}`,
      parameters: Type.Object({ machine, threadId: Type.String({ maxLength: 100 }), threadTitle: ActionFields.threadTitle, message: Type.String({ minLength: 1, maxLength: 60_000 }), mode: ActionFields.mode }, { additionalProperties: false }),
      replay: "safe", async execute(input, api) { return act("send")(input, api); } }),
    defineTool({ name: "t3_code_start", description: `Start a new T3 Code thread on the owner's machine with a task. project names the repository (from t3_code_threads); branch puts the work on a new branch in its own worktree, so it does not disturb the main checkout. The machine's defaults choose the agent and model. On a cloud machine, no project means the machine's own project. ${owned}`,
      parameters: Type.Object({ machine, title: Type.String({ minLength: 1, maxLength: 120 }), message: Type.String({ minLength: 1, maxLength: 60_000 }), project: ActionFields.project,
        branch: ActionFields.branch, worktree: ActionFields.worktree, plan: ActionFields.plan }, { additionalProperties: false }),
      replay: "safe", async execute(input, api) { return act("start")(input, api); } }),
    defineTool({ name: "t3_code_stop", description: `Stop a T3 Code thread like its Stop button: interrupt the running turn, hold queued messages, and stop its delegated tasks. whole false only interrupts the current turn. ${owned}`,
      parameters: Type.Object({ machine, threadId: Type.String({ maxLength: 100 }), reason: ActionFields.reason, whole: Type.Optional(Type.Boolean()) }, { additionalProperties: false }),
      replay: "safe", async execute(input, api) { return act("stop")(input, api); } }),
    defineTool({ name: "t3_code_questions", description: "Read the questions an agent in a T3 Code thread is waiting on, with their IDs and choices. Permission requests (run a command, apply an edit) are not listed; the owner answers those in T3 Code. Read-only.",
      parameters: Type.Object({ machine, threadId: Type.String({ maxLength: 100 }) }, { additionalProperties: false }),
      replay: "safe", async execute(input) { return result(async () => { const body = record(input); const target = t3.pick(body.machine); return { machine: target.label, ...record(await t3.questions(target.id, boundedText(body.threadId, 100, "thread ID"))) }; }); } }),
    defineTool({ name: "t3_code_answer", description: `Answer a question an agent in a T3 Code thread is waiting on: requestId and answers keyed by question ID, from t3_code_questions. ${owned}`,
      parameters: Type.Object({ machine, threadId: Type.String({ maxLength: 100 }), threadTitle: ActionFields.threadTitle, requestId: Type.String({ maxLength: 200 }), answers: Type.Record(Type.String(), Type.Unknown()) }, { additionalProperties: false }),
      replay: "safe", async execute(input, api) { return act("answer")(input, api); } }),
    defineTool({ name: "request_t3_action", description: "Ask the owner to approve a T3 Code action you decided on yourself (not one they asked for): send a message to a thread, start a thread, stop one, or answer an agent's question. Posts the action with Approve and Decline buttons; Approve runs it. Fields as in t3_code_send, t3_code_start, t3_code_stop, and t3_code_answer, plus kind and why (one sentence the owner reads).",
      parameters: Type.Object({ kind: Type.Union([Type.Literal("send"), Type.Literal("start"), Type.Literal("stop"), Type.Literal("answer")]), machine, why: Type.String({ minLength: 1, maxLength: 300 }), ...ActionFields }, { additionalProperties: false }),
      replay: "safe", async execute(input) {
        return result(async () => {
          const body = record(input);
          const request = requests.request(body.machine, parseAction(body), boundedText(body.why, 300, "why"), typeof body.threadTitle === "string" && body.threadTitle.trim() ? body.threadTitle.trim().slice(0, 200) : undefined);
          return { requested: true, id: request.id, machine: request.machineLabel, note: "The owner sees Approve and Decline. Do not repeat the request." };
        });
      } }),
  ];
}
