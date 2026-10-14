import { InputError, record, timestamp } from "../shared/protocol.js";
import { MailRuntime } from "./mail-runtime.js";
import { StateError } from "./store.js";
import { readJson } from "./transport.js";

function fields(value: unknown, allowed: string[]): Record<string, unknown> {
  const body = record(value);
  if (Object.keys(body).some(key => !allowed.includes(key))) throw new InputError("Unknown mail field");
  return body;
}
function publicItem(item: ReturnType<MailRuntime["store"]["attention"]>[number]): object {
  const { id, version, status, subject, sender, receivedAt, summary, reason, suggestedAction, snoozeUntil, webUrl } = item;
  return { id, version, status, subject, sender, receivedAt, summary, reason, suggestedAction, snoozeUntil: snoozeUntil ?? null, webUrl };
}

/** The parent router authenticates the owner control credential before calling this. */
export async function mailRequest(request: Request, runtime: MailRuntime, telegramSession: () => string | undefined): Promise<Response | undefined> {
  const path = new URL(request.url).pathname, { store } = runtime;
  if (path === "/api/mail" && request.method === "GET") return Response.json(runtime.status());
  if (path === "/api/mail/items" && request.method === "GET") return Response.json({ items: store.attention(50).map(publicItem) });
  if (path === "/api/mail/settings" && request.method === "PUT") {
    const body = fields(await readJson(request, 8_192), ["expectedVersion", "enabled", "lookbackDays", "pollMinutes", "bootstrapAfter"]);
    const sessionId = telegramSession();
    if (!sessionId) throw new StateError(409, "Open the owner Telegram conversation before enabling mail follow-through");
    const settings = store.configure(body, sessionId);
    await runtime.wake();
    return Response.json(settings);
  }
  if (path === "/api/mail/check" && request.method === "POST") {
    const body = request.body === null ? {} : fields(await readJson(request, 4_096), ["rebootstrap"]);
    if (body.rebootstrap !== undefined && typeof body.rebootstrap !== "boolean") throw new InputError("rebootstrap must be a boolean");
    await runtime.check(body.rebootstrap === true);
    return Response.json(runtime.status(), { status: 202 });
  }
  const action = /^\/api\/mail\/items\/(mail-[a-f0-9]{32})\/(handled|snooze)$/.exec(path);
  if (!action || request.method !== "POST") return;
  const body = fields(await readJson(request, 4_096), action[2] === "handled" ? ["expectedVersion"] : ["expectedVersion", "until"]);
  if (!Number.isSafeInteger(body.expectedVersion)) throw new InputError("expectedVersion must be an integer");
  const item = action[2] === "handled" ? store.markHandled(action[1]!, body.expectedVersion as number)
    : store.snooze(action[1]!, body.expectedVersion as number, timestamp(body.until, "mail snooze time"));
  await runtime.wake();
  return Response.json(publicItem(item));
}
