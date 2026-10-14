import { identifier, InputError, record } from "../shared/protocol.js";
import type { SubagentRuntime } from "./subagent-runtime.js";
import { readJson } from "./transport.js";

export async function subagentRequest(request: Request, runtime: SubagentRuntime): Promise<Response | undefined> {
  const path = new URL(request.url).pathname;
  if (path === "/api/subagents" && request.method === "GET") return Response.json(await runtime.status());
  const match = /^\/api\/subagents\/([A-Za-z0-9_.:-]+)(?:\/(cancel))?$/.exec(path);
  if (!match) return;
  const id = identifier(match[1], "subagent");
  if (!match[2] && request.method === "GET") return Response.json(await runtime.read(id));
  if (match[2] !== "cancel" || request.method !== "POST") return;
  const body = record(await readJson(request));
  if (Object.keys(body).some(key => key !== "expectedVersion")) throw new InputError("Invalid subagent cancellation fields");
  return Response.json(await runtime.cancel(id, body.expectedVersion));
}
