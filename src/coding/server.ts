import { randomUUID } from "node:crypto";
import { mkdir, open, readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { MAX_CODING_ARCHIVE_BYTES, MAX_CODING_TIMEOUT_MS, parseCodingAssignment, type CodingAssignment } from "../shared/coding.js";
import { codingOperationPrefix, MAX_CODING_RPC_BYTES, parseCodingRpcRequest } from "../shared/coding-rpc.js";
import { codingSourceDigest } from "../shared/coding-source.js";
import { InputError, record } from "../shared/protocol.js";
import { CodingNodeSession } from "./rpc.js";
import { restoreCodingSnapshot } from "./workspace.js";

export interface CodingServiceOptions {
  workspace?: string;
  stateDirectory?: string;
  idleTimeoutMs?: number;
  /** Production exits the whole container; tests can observe without terminating their host. */
  terminate?: () => void;
}
class ServiceError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
async function body(request: IncomingMessage, maximum: number): Promise<Buffer> {
  const declared = request.headers["content-length"];
  if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > maximum)) throw new ServiceError(413, "Coding request exceeds its bound");
  const chunks: Buffer[] = []; let size = 0;
  for await (const part of request) {
    const chunk: Buffer = Buffer.isBuffer(part) ? part : Buffer.from(part);
    size += chunk.length;
    if (size > maximum) throw new ServiceError(413, "Coding request exceeds its bound");
    chunks.push(chunk);
  }
  if (declared !== undefined && size !== Number(declared)) throw new ServiceError(400, "Incomplete coding request");
  return Buffer.concat(chunks, size);
}
function send(response: ServerResponse, value: unknown, status = 200): void {
  const bytes = Buffer.from(JSON.stringify(value));
  response.writeHead(status, { "content-type": "application/json", "content-length": bytes.length });
  response.end(bytes);
}

/** Private HTTP only: one immutable run, one boot, no credential/config/model API. */
export function createCodingService(options: CodingServiceOptions = {}): Server {
  const workspace = options.workspace ?? "/workspace/project", stateDirectory = options.stateDirectory ?? "/state";
  const bootId = randomUUID(), idleTimeoutMs = options.idleTimeoutMs ?? 120_000;
  const terminate = options.terminate ?? (() => process.exit(1));
  let assignment: CodingAssignment | undefined, session: CodingNodeSession | undefined;
  let initialized = false, uncertain = false, starting = false, frozen = false, closing = false;
  let lastActivity = Date.now(), hardExitAt = Infinity;
  const ownership = (async () => {
    await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
    try { await readFile(join(stateDirectory, "cloud-owner.json")); uncertain = true; frozen = true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  })();
  const freeze = async () => {
    frozen = true;
    if (session) await session.close();
  };
  const supervisor = setInterval(() => {
    const now = Date.now();
    if (now >= hardExitAt) { clearInterval(supervisor); terminate(); return; }
    const expired = assignment !== undefined && now >= Date.parse(assignment.deadlineAt);
    if (!closing && (expired || now - lastActivity >= idleTimeoutMs)) {
      closing = true; frozen = true;
      // Stop effects now; retain a short frozen window for the actor's final R2 receipt.
      hardExitAt = now + 30_000;
      void freeze().catch(() => { uncertain = true; });
    }
  }, Math.min(1000, idleTimeoutMs));
  supervisor.unref();
  const server = createServer(async (request, response) => {
    response.setHeader("cache-control", "no-store");
    response.setHeader("x-umpi-coding-boot", bootId);
    try {
      await ownership;
      if (request.method === "GET" && request.url === "/ready") {
        send(response, { bootId, initialized, uncertain: uncertain || (session?.uncertain ?? false), taskId: assignment?.taskId ?? null, runId: assignment?.runId ?? null, frozen }); return;
      }
      const operationRoute = request.method === "GET" && /^\/operations\/[A-Za-z0-9_.:%-]+$/.test(request.url ?? "");
      if (!["POST /start", "POST /rpc", "POST /cancel", "GET /snapshot", "GET /activity"].includes(`${request.method} ${request.url}`) && !operationRoute) throw new ServiceError(404, "Unknown private coding operation");
      if (request.headers["x-umpi-coding-boot"] !== bootId) throw new ServiceError(409, "Coding process identity changed");
      if (request.method === "POST" && request.url === "/start") {
        if (starting || initialized || uncertain || frozen) throw new ServiceError(409, "Coding process cannot be initialized again");
        starting = true;
        try {
          const encoded = request.headers["x-umpi-coding-assignment"], expectedDigest = request.headers["x-umpi-coding-source-digest"];
          if (typeof encoded !== "string" || encoded.length > 16_384 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || typeof expectedDigest !== "string" || !/^[a-f0-9]{64}$/.test(expectedDigest)) throw new ServiceError(400, "Invalid coding source authorization");
          const value = record(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(encoded, "base64"))));
          if (Object.keys(value).some(key => !["taskId", "runId", "cwd", "deadlineAt"].includes(key))) throw new ServiceError(400, "Invalid coding assignment fields");
          const approved = parseCodingAssignment(value), remaining = Date.parse(approved.deadlineAt) - Date.now();
          if (remaining <= 0 || remaining > MAX_CODING_TIMEOUT_MS) throw new ServiceError(409, "Coding deadline is outside its approved bound");
          if (request.headers["x-umpi-coding-task"] !== approved.taskId || request.headers["x-umpi-coding-run"] !== approved.runId) throw new ServiceError(409, "Coding run ownership mismatch");
          const archive = await body(request, MAX_CODING_ARCHIVE_BYTES);
          if (await codingSourceDigest(archive) !== expectedDigest) throw new ServiceError(409, "Coding source digest mismatch");
          assignment = approved;
          // Never adopt this scratch after a process restart, even before first tool dispatch.
          const marker = await open(join(stateDirectory, "cloud-owner.json"), "wx", 0o600);
          try { await marker.writeFile(JSON.stringify({ assignment, bootId, sourceDigest: expectedDigest })); await marker.sync(); }
          finally { await marker.close(); }
          const directory = await open(stateDirectory, "r");
          try { await directory.sync(); } finally { await directory.close(); }
          await restoreCodingSnapshot(archive, workspace);
          session = await CodingNodeSession.open({ assignment: { ...approved, cwd: workspace }, stateDirectory: join(stateDirectory, "journal"), baselineArchive: archive });
          if (frozen || Date.now() >= Date.parse(approved.deadlineAt)) { await freeze(); throw new ServiceError(409, "Coding deadline expired during preparation"); }
          initialized = true; lastActivity = Date.now();
          send(response, { initialized: true, bootId });
        } catch (error) {
          if (assignment) { uncertain = true; frozen = true; }
          throw error;
        } finally { starting = false; }
        return;
      }
      if (!assignment || !session || !initialized) throw new ServiceError(409, "Coding run is not initialized");
      if (request.headers["x-umpi-coding-task"] !== assignment.taskId || request.headers["x-umpi-coding-run"] !== assignment.runId) throw new ServiceError(409, "Coding run ownership mismatch");
      if (request.method === "GET" && request.url === "/activity") {
        if (frozen || uncertain || Date.now() >= Date.parse(assignment.deadlineAt)) throw new ServiceError(409, "Coding run is no longer active");
        lastActivity = Date.now(); send(response, { active: true }); return;
      }
      lastActivity = Date.now();
      if (request.method === "POST" && request.url === "/rpc") {
        if (frozen || uncertain || Date.now() >= Date.parse(assignment.deadlineAt)) throw new ServiceError(409, "Coding run no longer admits operations");
        const rpc = parseCodingRpcRequest(JSON.parse((await body(request, MAX_CODING_RPC_BYTES)).toString("utf8")));
        if (!rpc.operationId.startsWith(codingOperationPrefix(assignment.taskId, assignment.runId))) throw new ServiceError(409, "Coding operation belongs to another run");
        await session.submit(rpc);
        const state = session.state(rpc.operationId);
        if (!state) throw new ServiceError(503, "Coding operation admission was not confirmed");
        send(response, state); return;
      }
      if (operationRoute) {
        const operationId = decodeURIComponent(request.url!.slice("/operations/".length));
        if (!operationId.startsWith(codingOperationPrefix(assignment.taskId, assignment.runId))) throw new ServiceError(409, "Coding operation belongs to another run");
        const state = session.state(operationId);
        if (!state) throw new ServiceError(404, "Unknown coding operation");
        send(response, state); return;
      }
      if (request.method === "POST" && request.url === "/cancel") {
        const input = record(JSON.parse((await body(request, 2048)).toString("utf8")));
        if (Object.keys(input).some(key => key !== "operationId")) throw new ServiceError(400, "Invalid coding cancellation");
        if (input.operationId !== undefined) {
          if (typeof input.operationId !== "string" || !/^[A-Za-z0-9_.:-]{1,512}$/.test(input.operationId) || !input.operationId.startsWith(codingOperationPrefix(assignment.taskId, assignment.runId))) throw new ServiceError(409, "Coding operation belongs to another run");
          await session.cancel(input.operationId);
        } else { await freeze(); }
        send(response, { cancelled: true, uncertain: session.uncertain }); return;
      }
      if (!frozen || session.states().some(state => state.status === "running")) throw new ServiceError(409, "Coding checkpoint requires settled frozen work");
      const archive = await session.snapshot();
      if (!archive.length || archive.length > MAX_CODING_ARCHIVE_BYTES) throw new ServiceError(413, "Coding checkpoint exceeds its bound");
      response.writeHead(200, { "content-type": "application/gzip", "content-length": archive.length });
      response.end(archive);
    } catch (error) {
      send(response, { error: error instanceof ServiceError ? error.message : error instanceof InputError ? "Invalid coding request" : "Private coding operation could not be confirmed" }, error instanceof ServiceError ? error.status : error instanceof InputError || error instanceof SyntaxError ? 400 : 503);
    }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.on("close", () => { clearInterval(supervisor); void freeze().catch(() => {}); });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.umask(0o077);
  const server = createCodingService();
  server.on("error", () => { process.exitCode = 1; });
  server.listen(8080, "0.0.0.0");
}
