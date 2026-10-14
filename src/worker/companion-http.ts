import { InputError, boundedText, identifier, record } from "../shared/protocol.js";
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
  admit(id: string, text: string, deviceId: string): Promise<Operation>;
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
  if (path === "/api/device/session") {
    await context.wake(); companion.requireDevice(device.id); companion.revoke(device.id);
    return Response.json({ ok: true });
  }
  const body = await readJson(request);
  // Recheck after asynchronous boundaries. Revocation can race a body read or a lifecycle write.
  await context.wake();
  companion.requireDevice(device.id);
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
    const input = record(body); exactKeys(input, ["id", "text"]);
    const id = identifier(input.id, "message ID");
    const text = boundedText(input.text, 16_384, "message");
    // Fixed-size, device-scoped identity also fits the existing 128-character message ID contract.
    return Response.json(await context.admit(`device:${companionHash(JSON.stringify([device.id, id]))}`, text, device.id), { status: 202 });
  }
  throw new StateError(404, "Not found");
}
