import { InputError, identifier, record } from "../shared/protocol.js";
import { PlanningRuntime } from "./planning-runtime.js";
import { StateError } from "./store.js";
import { readJson } from "./transport.js";

function fields(value: unknown, allowed: string[]): Record<string, unknown> {
  const body = record(value);
  if (Object.keys(body).some(key => !allowed.includes(key))) throw new InputError("Unknown daily-planning field");
  return body;
}

/** The parent router must authenticate the owner control credential before calling this. */
export async function planningRequest(request: Request, runtime: PlanningRuntime, wake: () => Promise<void>, controlSession: () => Promise<string>): Promise<Response | undefined> {
  const path = new URL(request.url).pathname, { store } = runtime;
  if (path === "/api/planning" && request.method === "GET") return Response.json(runtime.status());
  if (path === "/api/planning/settings" && request.method === "PUT") {
    const body = fields(await readJson(request, 4_096), ["expectedVersion", "enabled", "time"]);
    await wake();
    return Response.json(store.configure(body));
  }
  if (path === "/api/planning/prepare" && request.method === "POST") {
    if (request.body !== null) fields(await readJson(request, 4_096), []);
    const sessionId = await controlSession();
    await wake();
    const plan = runtime.request(sessionId);
    return Response.json(runtime.read(plan.day), { status: 202 });
  }
  const dated = /^\/api\/planning\/(days|briefs)\/(\d{4}-\d{2}-\d{2})(\/cancel)?$/.exec(path);
  if (dated) {
    const [, family, value, cancel] = dated, day = runtime.day(value!);
    if (family === "days" && !cancel && request.method === "GET") return Response.json(runtime.read(day));
    if (family === "briefs" && !cancel && request.method === "PUT") {
      const body = fields(await readJson(request, 32_768), ["expectedVersion", "text"]);
      await wake();
      return Response.json(store.setBrief({ day, ...body }));
    }
    if (family === "days" && cancel && request.method === "POST") {
      const body = fields(await readJson(request, 4_096), ["expectedVersion"]);
      await wake();
      store.cancel(day, body.expectedVersion as number);
      return Response.json(runtime.read(day));
    }
    return;
  }
  const write = /^\/api\/planning\/writes\/([A-Za-z0-9_.:-]+)(\/abandon)?$/.exec(path);
  if (!write) return;
  const intentId = identifier(write[1], "write intent");
  if (!write[2] && request.method === "GET") {
    const intent = store.intent(intentId);
    if (!intent) throw new StateError(404, "Daily-note write not found");
    // The complete frozen before/after belongs only on this authenticated owner review route.
    return Response.json(intent);
  }
  if (write[2] && request.method === "POST") {
    const body = fields(await readJson(request, 4_096), ["expectedStatus"]);
    if (body.expectedStatus !== "prepared" && body.expectedStatus !== "unconfirmed") throw new InputError("Only an unresolved retained write can be abandoned");
    await wake();
    const intent = store.abandonIntent(intentId, body.expectedStatus);
    return Response.json({ intentId: intent.intentId, day: intent.day, status: intent.status, notice: "The retained write was released after owner review. This does not undo any remote note change or confirm an upload." });
  }
}
