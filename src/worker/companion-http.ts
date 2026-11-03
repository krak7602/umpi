import { InputError, boundedText, identifier, record, timestamp } from "../shared/protocol.js";
import { MAX_IMAGES_PER_MESSAGE, VoiceNoteError, type TelegramDocument, type TelegramImage } from "../shared/voice-note.js";
import type { ChatLog } from "./chat.js";
import { exactKeys, parsePairClaim } from "../shared/companion.js";
import { CompanionStore, companionHash } from "./companion-store.js";
import { companionRole } from "./companion-routes.js";
import { authorize, readJson, secretEqual, type TelegramConfig } from "./transport.js";
import { StateError, type Operation } from "./store.js";

export interface CompanionHttpContext {
  companion: CompanionStore;
  config: TelegramConfig & { UMPI_CONTROL_TOKEN?: string; UMPI_EXECUTOR_TOKEN?: string };
  wake(): Promise<void>;
  requireModel(): Promise<void>;
  chat: ChatLog;
  /** Admits an app message to the owner's shared conversation; the reply stays in the app. */
  admitApp(id: string, deviceId: string, message: AppMessage): Promise<Operation>;
  readFile(name: string, bytes: Uint8Array): Promise<TelegramDocument>;
  press(seq: number, data: string): Promise<{ text: string }>;
}
export interface AppMessage { text: string; sentAt?: string; images?: TelegramImage[]; document?: TelegramDocument }

const MAX_APP_MESSAGE_BYTES = 15_000_000;
function chatPosition(value: string | null): number | undefined {
  if (value === null) return undefined;
  if (!/^\d{1,15}$/.test(value)) throw new InputError("Invalid chat position");
  return Number(value);
}
async function appMessage(body: unknown, readFile: CompanionHttpContext["readFile"]): Promise<{ id: string; message: AppMessage }> {
  const input = record(body); exactKeys(input, ["id", "text", "sentAt", "images", "file"]);
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
  if (!text.trim() && !images && !document) throw new InputError("Message needs text, images, or a file");
  return { id, message: { text, ...(sentAt ? { sentAt } : {}), ...(images ? { images } : {}), ...(document ? { document } : {}) } };
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
  if (path === "/api/device/chat/press") {
    const input = record(body); exactKeys(input, ["seq", "data"]);
    if (typeof input.seq !== "number" || !Number.isSafeInteger(input.seq) || input.seq < 1) throw new InputError("Invalid chat position");
    const result = await context.press(input.seq, boundedText(input.data, 64, "button"));
    return Response.json({ text: result.text });
  }
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
    // Fixed-size, device-scoped identity also fits the existing 128-character message ID contract.
    return Response.json(await context.admitApp(`app:${companionHash(JSON.stringify([device.id, id]))}`, device.id, message), { status: 202 });
  }
  throw new StateError(404, "Not found");
}
