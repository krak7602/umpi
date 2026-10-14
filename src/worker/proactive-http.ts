import { record } from "../shared/protocol.js";
import { ProactiveStore } from "./proactive-store.js";
import { readJson } from "./transport.js";
import { StateError } from "./store.js";

/** Called only after the narrow router verifies the owner control credential. */
export async function scheduleRequest(request: Request, proactive: ProactiveStore, wake: () => Promise<void>, controlSession: () => Promise<string>, plannerOwns: (id: string) => boolean): Promise<Response | undefined> {
  function editable(commitmentId: unknown): void {
    if (typeof commitmentId === "string" && plannerOwns(commitmentId)) throw new StateError(403, "Use daily-planning controls for this responsibility; generic scheduler routes cannot change its ownership");
  }
  const path = new URL(request.url).pathname;
  if (path === "/api/schedule" && request.method === "GET") return Response.json(proactive.status());
  if (path === "/api/schedule/settings" && request.method === "PUT") {
    const body = await readJson(request, 4_096);
    await wake();
    return Response.json(proactive.configure(body));
  }
  const target = /^\/api\/schedule\/(commitments|wakeups)(?:\/([A-Za-z0-9_.:-]+)(\/cancel)?)?$/.exec(path);
  if (!target) return;
  const [, family, id, cancel] = target;
  if (!id && request.method === "GET") return Response.json(family === "commitments" ? { commitments: proactive.commitments() } : { wakeups: proactive.wakeups() });
  if (!id && request.method === "POST") {
    const body = record(await readJson(request, 32_768));
    editable(family === "commitments" ? body.id : body.commitmentId);
    const sessionId = family === "commitments" ? await controlSession() : undefined;
    await wake();
    return Response.json(family === "commitments" ? proactive.createCommitment(body, "control", sessionId!) : proactive.scheduleWakeup(body), { status: 201 });
  }
  if (id && !cancel && request.method === "PUT") {
    const body = await readJson(request, 32_768);
    editable(family === "commitments" ? id : proactive.wakeup(id)?.commitmentId);
    await wake();
    return Response.json(family === "commitments" ? proactive.updateCommitment(id, body) : proactive.updateWakeup(id, body));
  }
  if (id && cancel && family === "wakeups" && request.method === "POST") {
    const body = record(await readJson(request, 4_096));
    editable(proactive.wakeup(id)?.commitmentId);
    await wake();
    return Response.json(proactive.cancelWakeup(id, body.expectedVersion as number));
  }
}
