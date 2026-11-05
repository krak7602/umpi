import { InputError, boundedText, identifier, record, timestamp } from "../shared/protocol.js";
import { MAX_IMAGES_PER_MESSAGE, VoiceNoteError, type TelegramDocument, type TelegramImage } from "../shared/voice-note.js";
import type { ChatLog } from "./chat.js";
import { KNOCK_SNOOZE_MINUTES } from "../shared/knock.js";
import { exactKeys, parsePairClaim } from "../shared/companion.js";
import { CompanionStore, companionHash } from "./companion-store.js";
import { companionRole } from "./companion-routes.js";
import { authorize, readJson, secretEqual, type TelegramConfig } from "./transport.js";
import { StateError, type Operation } from "./store.js";
import { T3Error, type T3Action, type T3CodeStore } from "./t3-code.js";
import { parseAction } from "./t3-actions.js";

export interface CompanionHttpContext {
  companion: CompanionStore;
  config: TelegramConfig & { UMPI_CONTROL_TOKEN?: string; UMPI_EXECUTOR_TOKEN?: string };
  wake(): Promise<void>;
  requireModel(): Promise<void>;
  chat: ChatLog;
  /** Admits an app message to the owner's shared conversation; the reply stays in the app. */
  admitApp(id: string, deviceId: string, message: AppMessage): Promise<Operation>;
  /**
   * Stops a spoken reply the owner cut off by talking, keeping what the phone had read aloud; a finished one is left
   * alone. Returns a note for Umpi about what was heard, or undefined when the operation is not a spoken reply.
   */
  interrupt(operationId: string, heard?: string): Promise<string | undefined>;
  readFile(name: string, bytes: Uint8Array): Promise<TelegramDocument>;
  press(seq: number, data: string): Promise<{ text: string }>;
  /** The day's note (today by default); undefined when no vault is configured. */
  today(day?: string): Promise<object>;
  setTask(day: string, line: number, expected: string, checked: boolean): Promise<object>;
  widget(): Promise<object>;
  setWidgetActions(value: unknown): Promise<object>;
  /** T3 Code machines reached through T3 Connect. */
  t3: T3CodeStore;
  /** Actions Umpi asked the owner to approve, for the app's cards. */
  t3Requests(): object[];
  /** The owner's own action from the app; Umpi follows the thread, and holds it when the Mac does not answer. */
  t3Act(machine: string, action: T3Action, requestId: string): Promise<{ result?: unknown; held?: object }>;
  /** Approves or declines a request the way its message's button does, so Telegram's copy changes too. */
  decideT3(id: string, approve: boolean): Promise<{ text: string }>;
  /** Umpi's cloud machines: wake, sleep, delete. */
  cloud(id: string, action: "wake" | "sleep" | "delete"): Promise<object>;
}
/** What an attachment was, for the history to show: the app sends its preview separately, never through the chat. */
export interface AppMedia { kind: "photos" | "video" | "audio" | "file" | "voice"; name?: string; seconds?: number; count?: number }
/**
 * `spoken`: sent from voice mode, so the reply is read aloud as it is written (a voice message only). `interrupts`: the
 * operation of the spoken reply this message cut off, and `heard` what the phone had read aloud of it by then.
 */
export interface AppMessage { text: string; sentAt?: string; voice?: true; spoken?: true; interrupts?: string; heard?: string; images?: TelegramImage[]; document?: TelegramDocument; context?: string; media?: AppMedia }

const MAX_APP_MESSAGE_BYTES = 15_000_000;
function chatPosition(value: string | null): number | undefined {
  if (value === null) return undefined;
  if (!/^\d{1,15}$/.test(value)) throw new InputError("Invalid chat position");
  return Number(value);
}
async function appMessage(body: unknown, readFile: CompanionHttpContext["readFile"]): Promise<{ id: string; message: AppMessage }> {
  const input = record(body); exactKeys(input, ["id", "text", "sentAt", "voice", "spoken", "interrupts", "heard", "images", "file", "context", "media"]);
  // Text for Umpi only, such as a video's frames note and transcript; the history shows the owner's own words.
  const context = input.context === undefined ? undefined : boundedText(input.context, 13_000, "message context");
  let media: AppMedia | undefined;
  if (input.media !== undefined) {
    const value = record(input.media); exactKeys(value, ["kind", "name", "seconds", "count"]);
    if (!["photos", "video", "audio", "file", "voice"].includes(String(value.kind))) throw new InputError("Unknown media kind");
    media = { kind: value.kind as AppMedia["kind"],
      ...(value.name !== undefined ? { name: boundedText(value.name, 120, "media name") } : {}),
      ...(value.seconds !== undefined ? { seconds: typeof value.seconds === "number" && value.seconds >= 0 && value.seconds <= 86_400 ? Math.round(value.seconds) : (() => { throw new InputError("Invalid media length"); })() } : {}),
      ...(value.count !== undefined ? { count: Number.isSafeInteger(value.count) && Number(value.count) > 0 && Number(value.count) <= 10 ? Number(value.count) : (() => { throw new InputError("Invalid media count"); })() } : {}) };
  }
  if (input.voice !== undefined && input.voice !== true) throw new InputError("voice must be true when present");
  if (input.spoken !== undefined && (input.spoken !== true || input.voice !== true)) throw new InputError("spoken must be true, and only on a voice message");
  if (input.interrupts !== undefined && input.spoken !== true) throw new InputError("Only a spoken message interrupts a reply");
  const interrupts = input.interrupts === undefined ? undefined : identifier(input.interrupts, "interrupted operation");
  if (input.heard !== undefined && !interrupts) throw new InputError("heard goes with interrupts");
  const heard = input.heard === undefined || input.heard === "" ? undefined : boundedText(input.heard, 16_384, "heard text");
  const id = identifier(input.id, "message ID");
  const text = input.text === undefined || input.text === "" ? "" : boundedText(input.text, 16_384, "message");
  const sentAt = input.sentAt === undefined ? undefined : timestamp(input.sentAt, "sent time");
  let images: TelegramImage[] | undefined;
  if (input.images !== undefined) {
    if (!Array.isArray(input.images) || !input.images.length || input.images.length > MAX_IMAGES_PER_MESSAGE) throw new InputError(`Send 1 to ${MAX_IMAGES_PER_MESSAGE} images`);
    images = input.images.map(item => { const image = record(item); exactKeys(image, ["data", "mimeType"]);
      return { data: boundedText(image.data, 1_500_000, "image data"), mimeType: boundedText(image.mimeType, 32, "image type") as TelegramImage["mimeType"] }; });
  }
  let document: TelegramDocument | undefined;
  if (input.file !== undefined) {
    const file = record(input.file); exactKeys(file, ["name", "data"]);
    const name = boundedText(file.name, 120, "file name").replace(/[\u0000-\u001f\u007f<>"]/g, "").trim() || "file";
    let bytes: Uint8Array;
    try { bytes = Uint8Array.from(atob(boundedText(file.data, 14_000_000, "file data")), character => character.charCodeAt(0)); }
    catch { throw new InputError("File data must be base64"); }
    try { document = await readFile(name, bytes); }
    catch (error) {
      if (error instanceof VoiceNoteError) throw new InputError(error.code === "file_too_large" ? "The file is larger than 10 MB" : "The file could not be read as text");
      throw error;
    }
  }
  if (images && document) throw new InputError("Send images and a file as separate messages");
  if (!text.trim() && !images && !document && !context) throw new InputError("Message needs text, images, or a file");
  if (input.voice === true && (!text.trim() || images || document)) throw new InputError("A voice message is its transcript only");
  return { id, message: { text, ...(sentAt ? { sentAt } : {}), ...(context ? { context } : {}), ...(media ? { media } : {}), ...(input.voice === true ? { voice: true as const } : {}), ...(input.spoken === true ? { spoken: true as const } : {}), ...(interrupts ? { interrupts } : {}), ...(heard ? { heard } : {}), ...(images ? { images } : {}), ...(document ? { document } : {}) } };
}
/** Returns undefined only for routes outside the narrow companion surface. Auth precedes every body read. */
export async function companionRequest(request: Request, context: CompanionHttpContext): Promise<Response | undefined> {
  const path = new URL(request.url).pathname;
  const role = companionRole(path, request.method);
  if (!role) return undefined;
  const { companion, config } = context;
  await authorize(request, config, authorization => companion.authenticate(authorization));
  if (role === "pair") {
    const input = parsePairClaim(await readJson(request, 8_192));
    for (const secret of [config.UMPI_CONTROL_TOKEN, config.UMPI_EXECUTOR_TOKEN]) {
      if (secret && await secretEqual(input.token, secret)) throw new InputError("Device token must be independently generated");
    }
    await context.wake();
    return Response.json(companion.claimPairing(input));
  }
  if (role === "control") {
    if (path === "/api/companion/state") return Response.json(companion.snapshot());
    if (path === "/api/companion/pairings") return Response.json(companion.createPairing(await readJson(request, 1_024)));
    if (request.method === "DELETE") {
      await context.wake(); return Response.json(companion.revoke(path.slice("/api/companion/devices/".length)));
    }
    const body = await readJson(request);
    await context.wake();
    return Response.json(path === "/api/companion/changes" ? companion.mutate(body, "control") : companion.requestAction(body));
  }
  const device = companion.authenticate(request.headers.get("authorization"));
  if (path === "/api/device/state") { companion.seen(device.id); return Response.json(companion.snapshot(device.id)); }
  if (path === "/api/device/chat") {
    const query = new URL(request.url).searchParams;
    const limit = query.get("limit");
    if (limit !== null && !/^\d{1,3}$/.test(limit)) throw new InputError("Invalid chat limit");
    companion.seen(device.id);
    return Response.json(context.chat.page({ ...(chatPosition(query.get("before")) !== undefined ? { before: chatPosition(query.get("before"))! } : {}),
      ...(chatPosition(query.get("after")) !== undefined ? { after: chatPosition(query.get("after"))! } : {}), ...(limit !== null ? { limit: Number(limit) } : {}) }));
  }
  if (path === "/api/device/widget") return Response.json(await context.widget());
  if (path === "/api/device/today" && request.method === "GET") {
    const day = new URL(request.url).searchParams.get("day");
    if (day !== null && !/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new InputError("Invalid day");
    return Response.json(await context.today(day ?? undefined));
  }
  if (path === "/api/device/t3") return Response.json({ machines: context.t3.list() });
  if (path === "/api/device/t3/threads") return Response.json(await context.t3.overview());
  if (path === "/api/device/t3/thread") {
    const query = new URL(request.url).searchParams;
    const machine = identifier(query.get("machine"), "machine ID"), thread = identifier(query.get("id"), "thread ID"), after = query.get("after");
    if (after !== null && !/^\d{1,9}$/.test(after)) throw new InputError("Invalid position");
    try { return Response.json(await context.t3.read(machine, thread, after === null ? { latest: true, limit: 40, maxChars: 8_000 } : { afterPosition: Number(after), limit: 40, maxChars: 8_000 })); }
    catch (error) { if (error instanceof T3Error) throw new StateError(502, error.message); throw error; }
  }
  if (path === "/api/device/t3/requests") return Response.json({ requests: context.t3Requests() });
  if (path === "/api/device/t3/questions") {
    const query = new URL(request.url).searchParams;
    try { return Response.json(await context.t3.questions(identifier(query.get("machine"), "machine ID"), identifier(query.get("id"), "thread ID"))); }
    catch (error) { if (error instanceof T3Error) throw new StateError(502, error.message); throw error; }
  }
  const cloudDelete = /^\/api\/device\/cloud\/([^/]+)$/.exec(path);
  if (cloudDelete && request.method === "DELETE") { await context.wake(); companion.requireDevice(device.id); return Response.json(await context.cloud(cloudDelete[1]!, "delete")); }
  const t3Machine = /^\/api\/device\/t3\/machines\/([^/]+)$/.exec(path);
  if (t3Machine && request.method === "DELETE") { await context.wake(); companion.requireDevice(device.id); return Response.json(context.t3.remove(t3Machine[1]!)); }
  if (path === "/api/device/chat/socket") throw new StateError(426, "Open the chat socket as a WebSocket");
  if (path === "/api/device/chat/settings" && request.method === "GET") return Response.json(context.chat.settings());
  if (path === "/api/device/session") {
    await context.wake(); companion.requireDevice(device.id); companion.revoke(device.id);
    return Response.json({ ok: true });
  }
  const body = await readJson(request, path === "/api/device/messages" ? MAX_APP_MESSAGE_BYTES : undefined);
  // Recheck after asynchronous boundaries. Revocation can race a body read or a lifecycle write.
  await context.wake();
  companion.requireDevice(device.id);
  if (path === "/api/device/chat/settings") return Response.json(context.chat.configure(body));
  if (path === "/api/device/widget/actions") return Response.json(await context.setWidgetActions(record(body).actions));
  if (path === "/api/device/chat/test-alert") { const entry = context.chat.testAlert(); await context.wake(); return Response.json({ seq: entry.seq }); }
  if (path === "/api/device/chat/press") {
    const input = record(body); exactKeys(input, ["seq", "data"]);
    if (typeof input.seq !== "number" || !Number.isSafeInteger(input.seq) || input.seq < 1) throw new InputError("Invalid chat position");
    const result = await context.press(input.seq, boundedText(input.data, 64, "button"));
    return Response.json({ text: result.text });
  }
  if (path === "/api/device/today/task") {
    const input = record(body); exactKeys(input, ["day", "line", "text", "checked"]);
    if (typeof input.day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(input.day)) throw new InputError("Invalid day");
    if (typeof input.line !== "number" || !Number.isSafeInteger(input.line) || input.line < 0 || input.line > 20_000) throw new InputError("Invalid line");
    if (typeof input.checked !== "boolean") throw new InputError("checked must be true or false");
    return Response.json(await context.setTask(input.day, input.line, boundedText(input.text, 4_000, "task line"), input.checked));
  }
  if (path === "/api/device/t3/machines") return Response.json(await context.t3.add(body, new URL(request.url).origin));
  if (path === "/api/device/t3/act") {
    // The owner's own action from the app: it runs at once. The request ID makes a retried send act once.
    const input = record(body); exactKeys(input, ["machine", "requestId", "kind", "threadId", "message", "mode", "reason", "whole", "question", "answers"]);
    if (input.kind !== "send" && input.kind !== "stop" && input.kind !== "answer") throw new InputError("The app can send to, stop, or answer a thread");
    // requestId is this app action's own ID; an answer names the agent's question as `question`.
    const action = parseAction(input.kind === "answer" ? { kind: "answer", threadId: input.threadId, requestId: input.question, answers: input.answers } : input);
    try { const ran = await context.t3Act(identifier(input.machine, "machine ID"), action, `app-${identifier(input.requestId, "request ID")}`); return Response.json(ran.held ? { result: { held: true } } : { result: ran.result }); }
    catch (error) { if (error instanceof T3Error) throw new StateError(502, error.message); throw error; }
  }
  const cloudAction = /^\/api\/device\/cloud\/([^/]+)\/(wake|sleep)$/.exec(path);
  if (cloudAction) {
    try { return Response.json(await context.cloud(cloudAction[1]!, cloudAction[2] as "wake" | "sleep")); }
    catch (error) { if (error instanceof T3Error) throw new StateError(502, error.message); throw error; }
  }
  const t3Decision = /^\/api\/device\/t3\/requests\/([^/]+)\/(approve|decline)$/.exec(path);
  if (t3Decision) return Response.json(await context.decideT3(t3Decision[1]!, t3Decision[2] === "approve"));
  const t3Connect = /^\/api\/device\/t3\/machines\/([^/]+)\/connect$/.exec(path);
  if (t3Connect) return Response.json(await context.t3.connect(t3Connect[1]!, new URL(request.url).origin));
  if (path === "/api/device/knocks") return Response.json(companion.owner.recordPhoneKnocks(device.id, body));
  const knock = /^\/api\/device\/reminders\/([^/]+)\/answer$/.exec(path);
  if (knock) return Response.json(companion.owner.answerPhoneKnock(knock[1]!, body, KNOCK_SNOOZE_MINUTES));
  if (path === "/api/device/register") return Response.json(companion.register(device.id, body));
  if (path === "/api/device/changes") return Response.json(companion.mutate(body, `device:${device.id}`));
  if (path === "/api/device/actions") return Response.json(companion.requestAction(body, device.id));
  const ack = /^\/api\/device\/actions\/([^/]+)\/ack$/.exec(path);
  if (ack) return Response.json(companion.acknowledge(device.id, ack[1]!, body));
  const job = /^\/api\/device\/jobs\/([^/]+)\/(approve|cancel)$/.exec(path);
  if (job) {
    const input = record(body); exactKeys(input, ["version"]);
    if (typeof input.version !== "number" || !Number.isSafeInteger(input.version) || input.version < 1) throw new InputError("Invalid reviewed job version");
    return Response.json(job[2] === "approve" ? companion.owner.approveJob(job[1]!, input.version) : companion.owner.cancelJob(job[1]!, input.version));
  }
  const choice = /^\/api\/device\/choices\/([^/]+)\/answer$/.exec(path);
  if (choice) {
    await context.requireModel();
    return Response.json(companion.answerChoice(device.id, choice[1]!, body), { status: 202 });
  }
  if (path === "/api/device/messages") {
    const { id, message } = await appMessage(body, context.readFile);
    companion.requireDevice(device.id);
    // Stop the reply being talked over first, so this message does not wait behind it.
    const note = message.interrupts ? await context.interrupt(message.interrupts, message.heard) : undefined;
    if (note) message.context = message.context ? `${note}\n\n${message.context}` : note;
    // Fixed-size, device-scoped identity also fits the existing 128-character message ID contract.
    return Response.json(await context.admitApp(`app:${companionHash(JSON.stringify([device.id, id]))}`, device.id, message), { status: 202 });
  }
  throw new StateError(404, "Not found");
}
