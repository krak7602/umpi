import { createServer, type IncomingMessage, type Server } from "node:http";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { VaultRuntime, type VaultRuntimeOptions } from "./runtime.js";
import { VaultServiceError } from "./safety.js";
import { MAX_NOTE_BYTES, MAX_WORKSPACE_BYTES, parseVaultApply, parseVaultScope } from "../shared/vault-planning.js";
import { InputError, record } from "../shared/protocol.js";

async function requestBody(request: IncomingMessage, limit: number): Promise<Buffer> {
  const declared = request.headers["content-length"];
  if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > limit)) throw new VaultServiceError("Request exceeds its size limit", 413);
  const chunks: Buffer[] = []; let total = 0;
  for await (const part of request) {
    const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part);
    total += chunk.length;
    if (total > limit) throw new VaultServiceError("Request exceeds its size limit", 413);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, total);
}
/** Private container endpoint only. No authentication, arbitrary file or process API.
 * The Cloudflare durable-object binding is the caller's security boundary.
 */
export function createVaultService(options: VaultRuntimeOptions = {}): Server {
  const runtime = new VaultRuntime(options);
  let handling = false;
  const server = createServer(async (request, response) => {
    let ownsOperation = false;
    try {
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("Content-Type", "application/json");
      if (request.method === "GET" && request.url === "/ready") {
        response.end(JSON.stringify({ ready: true, initialized: await runtime.initialized() })); return;
      }
      if (!["POST /restore", "POST /snapshot", "POST /apply", "GET /archive"].includes(`${request.method} ${request.url}`)) {
        response.statusCode = 404; response.end(JSON.stringify({ error: "Unknown private vault operation" })); return;
      }
      if (handling) throw new VaultServiceError("Workspace operation already in progress", 409);
      handling = true; ownsOperation = true;
      if (request.method === "POST" && request.url === "/restore") {
        await runtime.restore(await requestBody(request, MAX_WORKSPACE_BYTES));
        response.end(JSON.stringify({ restored: true })); return;
      }
      if (request.method === "GET" && request.url === "/archive") {
        const archive = await runtime.archive();
        response.setHeader("Content-Type", "application/gzip");
        response.setHeader("Content-Length", archive.length);
        response.end(archive); return;
      }
      let parsed: unknown;
      try { parsed = JSON.parse((await requestBody(request, MAX_NOTE_BYTES * 6 + 8192)).toString("utf8")); }
      catch (error) { if (error instanceof VaultServiceError) throw error; throw new VaultServiceError("Invalid operation JSON", 400); }
      const body = record(parsed), scope = parseVaultScope(body.scope);
      if (request.url === "/snapshot") {
        if (Object.keys(body).some(key => !["day", "scope"].includes(key)) || typeof body.day !== "string") throw new VaultServiceError("Invalid snapshot request", 400);
        response.end(JSON.stringify(await runtime.snapshot(body.day, scope)));
      } else {
        if (Object.keys(body).some(key => !["intent", "scope"].includes(key))) throw new VaultServiceError("Invalid apply request", 400);
        response.end(JSON.stringify(await runtime.apply(parseVaultApply(body.intent), scope)));
      }
    } catch (error) {
      response.statusCode = error instanceof VaultServiceError ? error.status : error instanceof InputError ? 400 : 503;
      response.end(JSON.stringify({ error: error instanceof VaultServiceError ? error.message : error instanceof InputError ? "Invalid vault planning request" : "Private vault operation is unavailable" }));
    } finally { if (ownsOperation) handling = false; }
  });
  server.requestTimeout = 150_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.umask(0o077);
  const port = Number(process.env.PORT ?? "8080");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new VaultServiceError("Invalid private service port");
  const server = createVaultService();
  server.on("error", () => { process.exitCode = 1; });
  server.listen(port, "0.0.0.0");
}
