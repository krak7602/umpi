import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolExecutionResult, type ToolRegistration } from "@earendil-works/pi-durable";
import { InputError, boundedText, record } from "../shared/protocol.js";
import { StateError, type Database, type Store, type TelegramMarkup } from "./store.js";
import { T3Error, type T3Action, type T3CodeStore } from "./t3-code.js";
import type { T3Watcher } from "./t3-watch.js";

/**
 * Actions on the owner's T3 Code threads. When the owner asked for an action in the conversation, Umpi acts at once.
 * When Umpi decided on its own (a background review), it asks first: a message with Approve and Decline buttons, in
 * Telegram and the app. The message shows the whole action; an action too long to show in full is refused. Approve
 * runs the stored action in code, not through another model turn, only while it still matches the message, and posts
 * the outcome.
 */
export interface T3ActionRequest {
  id: string;
  machineId: string;
  machineLabel: string;
  machineHost?: string;
  machineKind?: "cloud";
  action: T3Action;
  /** The whole card, as `approvalCard` wrote it. Telegram shows exactly this under the question. */
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
const QUESTION = "T3 Code: may Umpi do this?\n\n";
/**
 * The longest message, task, reason, or set of answers an approval can carry. With every other field at its own
 * maximum the card then stays under `CARD_LIMIT`, so the owner reads all of it in one message, above the buttons.
 */
export const T3_APPROVAL_TEXT_LIMIT = 2_000;
/** One Telegram message, as the outbox cuts them (`splitTelegram`). An approval card never has a second part. */
const CARD_LIMIT = 4_000;
/**
 * Characters a card cannot show: controls other than tab and line feed, invisible format and tag characters (the zero
 * width joiner inside emoji is allowed), private-use and broken code points, and the Unicode line separators.
 */
const UNSEEN = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u2028\u2029\u{E0100}-\u{E01EF}]|(?!\u200D)\p{Cf}|\p{Co}|\p{Cs}/u;
/** More than two blank lines in a row, which can push text out of sight. */
const GAP = /\n(?:[^\S\n]*\n){3}/;

function unseen(text: string, label: string): void {
  const found = UNSEEN.exec(text)?.[0];
  if (found !== undefined) throw new InputError(`The ${label} contains a character the approval card cannot show (U+${found.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}). Remove it and ask again.`);
}
/** A field shown on one line of the card, exactly as the machine gets it. */
function line(value: string, label: string): string {
  unseen(value, label);
  if (/[\n\t]/.test(value) || value !== value.trim()) throw new InputError(`The ${label} must be one line, with no space before or after it.`);
  return value;
}
/** The long text of an action, shown whole at the end of the card. */
function whole(text: string, label: string): string {
  if (text.length > T3_APPROVAL_TEXT_LIMIT) throw new InputError(`The ${label} is ${text.length} characters. An action that needs approval can carry at most ${T3_APPROVAL_TEXT_LIMIT}, so that the owner reads all of it on the card. Shorten it, or split the work into smaller requests.`);
  unseen(text, label);
  if (GAP.test(text)) throw new InputError(`The ${label} has more than two blank lines in a row, which can hide text on the card. Remove them and ask again.`);
  return text;
}
/** Umpi's own words about the action (a thread title, the reason). The machine never gets them, so they are tidied, not refused. */
function note(text: string): string {
  return text.replace(new RegExp(UNSEEN.source, "gu"), "").replace(/\s+/g, " ").trim();
}

/**
 * The approval card for an action: everything the machine will get, and nothing cut. The machine and the thread ID
 * come first, from the coordinator. Text the model wrote is labelled as Umpi's, and the long text is last, so nothing
 * in it can pass for another field. Throws `InputError` when the action cannot be shown in full.
 */
export function approvalCard(action: T3Action, machine: { label: string; host?: string; kind?: "cloud" }, threadTitle?: string, why?: string): string {
  const head: string[] = [], title = threadTitle ? note(threadTitle) : "", reason = why ? note(why) : "";
  const thread = (id: string) => {
    head.push(`Thread ID: ${line(id, "thread ID")}`);
    if (title) head.push(`Thread title, as Umpi gave it (not checked): ${title}`);
  };
  let what: string, last: [string, string] | undefined;
  switch (action.kind) {
    case "send":
      what = "Send a message to a thread."; thread(action.threadId);
      head.push(`Mode: ${action.mode ?? "auto"}`);
      last = ["The message", whole(action.message, "message")];
      break;
    case "stop":
      what = "Stop a thread."; thread(action.threadId);
      head.push(action.whole === false ? "Scope: only the running turn" : "Scope: the whole thread, like T3 Code's Stop button");
      if (action.reason) last = ["The reason sent with it", whole(action.reason, "reason")];
      break;
    case "answer": {
      what = "Answer an agent's question in a thread."; thread(action.threadId);
      head.push(`Question request ID: ${line(action.requestId, "request ID")}`);
      last = ["The answers, by question ID", whole(Object.entries(action.answers).map(([id, answer]) => `${JSON.stringify(id)}: ${JSON.stringify(answer)}`).join("\n"), "answer text")];
      break;
    }
    case "start":
      what = "Start a new thread.";
      head.push(`Title: ${line(action.title, "title")}`);
      if (action.projectId) head.push(`Project ID: ${line(action.projectId, "project ID")}`);
      if (action.project) head.push(`Project, by name: ${line(action.project, "project")}${action.projectId ? " (not used; the ID decides)" : ""}`);
      if (!action.projectId && !action.project) head.push(machine.kind === "cloud" ? "Project: none named; the machine's own project" : "Project: none named; a scratch folder");
      if (action.branch) head.push(`New branch, in its own worktree: ${line(action.branch, "branch")}`);
      else if (action.worktree) head.push("Workspace: a new worktree");
      if (action.baseRef) head.push(`Base: ${line(action.baseRef, "base")}${action.branch || action.worktree ? "" : " (not used without a new branch or worktree)"}`);
      if (action.plan) head.push("Plan mode: yes");
      last = ["The task", whole(action.message, "task")];
      break;
  }
  const where = `Machine: ${note(machine.label)}${machine.host ? ` (${machine.host})` : ""}`;
  return [[what, where, ...head, ...(reason ? [`Why, in Umpi's words: ${reason}`] : [])].join("\n"),
    ...(last ? [`${last[0]}, complete (${last[1].length} characters):`, last[1]] : [])].join("\n\n");
}

/** A short summary for notices about held actions. Not an approval card: it cuts long text and may leave out the thread ID. */
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

  /**
   * Asks the owner to approve an action Umpi decided on. The card shows the whole action; an action that cannot be
   * shown in full, in one message, is refused with an `InputError` that says what to change.
   */
  request(machine: unknown, action: T3Action, why: string | undefined, threadTitle?: string): T3ActionRequest {
    const target = this.t3.pick(machine);
    const id = `t3r-${crypto.randomUUID()}`;
    // The card is written from the action as it is stored, so the two cannot differ.
    const stored = JSON.parse(JSON.stringify(action)) as T3Action;
    const request: T3ActionRequest = { id, machineId: target.id, machineLabel: target.label, ...(target.host ? { machineHost: target.host } : {}), ...(target.kind ? { machineKind: target.kind } : {}),
      action: stored, summary: "", ...(threadTitle ? { threadTitle } : {}), ...(why ? { why } : {}), status: "pending", createdAt: new Date(this.now()).toISOString() };
    request.summary = this.card(request);
    const text = `${QUESTION}${request.summary}`;
    if (text.length > CARD_LIMIT) throw new InputError("This action is too long to show on one approval card. Shorten its text and ask again.");
    const approve = `${PREFIX}${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`, decline = `${PREFIX}${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
    this.db.all("INSERT INTO umpi_t3_requests VALUES (?, ?, ?, ?)", id, approve, decline, JSON.stringify(request));
    const markup: TelegramMarkup = { inline_keyboard: [[{ text: "Approve", callback_data: approve }, { text: "Decline", callback_data: decline }]] };
    this.owner.enqueue(this.group(id), "telegram", text, markup);
    return request;
  }
  private group(id: string): string { return `t3-request:${id}`; }
  /** The card a stored request must have. */
  private card(request: T3ActionRequest): string {
    return approvalCard(request.action, { label: request.machineLabel, ...(request.machineHost ? { host: request.machineHost } : {}), ...(request.machineKind ? { kind: request.machineKind } : {}) }, request.threadTitle, request.why);
  }
  /** Whether the message the owner got is the card of the action that is stored now. */
  private shown(request: T3ActionRequest): boolean {
    let card: string;
    try { card = `${QUESTION}${this.card(request)}`; } catch { return false; }
    return card.length <= CARD_LIMIT && card === this.owner.deliveries(this.group(request.id)).filter(delivery => delivery.channel === "telegram").map(delivery => delivery.text).join("");
  }

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
    // Approve runs what was shown. A stored action that no longer matches its card is never run.
    if (!this.shown(request)) {
      request.status = "failed"; request.outcome = "The stored action did not match its card."; this.save(request);
      return { text: "This request no longer matches the card you were shown. Nothing was done; ask Umpi again.", replyMarkup: empty };
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
    defineTool({ name: "request_t3_action", description: `Ask the owner to approve a T3 Code action you decided on yourself (not one they asked for): send a message to a thread, start a thread, stop one, or answer an agent's question. Posts the whole action with Approve and Decline buttons; Approve runs it. Fields as in t3_code_send, t3_code_start, t3_code_stop, and t3_code_answer, plus kind and why (one sentence the owner reads). The owner must read all of it on one card, so the message, task, reason, or answers can be at most ${T3_APPROVAL_TEXT_LIMIT} characters; shorten longer text or split the work.`,
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
