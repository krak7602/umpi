import { MAX_CODING_ARCHIVE_BYTES, MAX_CODING_PATCH_BYTES, codingPath, parseCodingExecutorPoll, parseCodingRequest, type CodingExecutorReport, type CodingSource } from "../shared/coding.js";
import { MAX_CODING_RPC_BYTES, parseCodingRpcState } from "../shared/coding-rpc.js";
import { codingSourceDigest, inspectCodingSnapshot } from "../shared/coding-source.js";
import { InputError, boundedText, identifier, record } from "../shared/protocol.js";
import { CodingCloudError, readCodingBody } from "./coding-cloud.js";
import type { CodingRuntime } from "./coding-runtime.js";
import { enqueueCodingApproval } from "./coding-telegram.js";
import { StateError } from "./store.js";
import { readJson } from "./transport.js";

function fields(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  const body = record(value);
  if (Object.keys(body).some(key => !allowed.includes(key))) throw new InputError("Unknown coding field");
  return body;
}
function version(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new InputError("Invalid expected coding version");
  return value;
}
function uploadPath(header: string | null): string {
  if (!header || header.length > 24_000 || !/^[A-Za-z0-9_-]+$/.test(header)) throw new InputError("Invalid coding workspace header");
  let path: string;
  try {
    const bytes = Uint8Array.from(atob(header.replaceAll("-", "+").replaceAll("_", "/")), character => character.charCodeAt(0));
    path = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    const canonical = btoa(String.fromCharCode(...new TextEncoder().encode(path))).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
    if (canonical !== header) throw new Error("Noncanonical encoding");
  } catch { throw new InputError("Coding workspace must use canonical base64url UTF-8"); }
  if (path.includes("//") || /[\u0000-\u001f\u007f]/.test(path)) throw new InputError("Invalid canonical coding workspace");
  return codingPath(path);
}
async function bodyBytes(body: Parameters<typeof readCodingBody>[0], size: number, maximum: number): Promise<Uint8Array<ArrayBuffer>> {
  try { return await readCodingBody(body, size, maximum); }
  catch (error) { if (error instanceof CodingCloudError) throw new StateError(error.status, error.message); throw error; }
}
function sameSource(left: CodingSource, right: CodingSource): boolean {
  return left.sourceId === right.sourceId && left.cwd === right.cwd && left.capturedAt === right.capturedAt && left.digest === right.digest
    && left.bytes === right.bytes && left.fileCount === right.fileCount && left.baseRevision === right.baseRevision;
}

async function upload(request: Request, runtime: CodingRuntime, sourceId: string): Promise<Response> {
  const archive = runtime.archive(), cwd = uploadPath(request.headers.get("x-umpi-coding-cwd"));
  if (request.headers.get("content-type")?.toLowerCase() !== "application/gzip" || request.headers.has("content-encoding")) throw new StateError(415, "Send a raw application/gzip snapshot without Content-Encoding");
  const length = request.headers.get("content-length");
  if (!length || !/^[1-9][0-9]*$/.test(length)) throw new InputError("A strict Content-Length is required for coding source uploads");
  const bytes = await bodyBytes(request.body, Number(length), MAX_CODING_ARCHIVE_BYTES);
  let manifest;
  try { ({ manifest } = await inspectCodingSnapshot(bytes)); }
  catch { throw new InputError("Invalid or unsafe coding source snapshot"); }
  const source: CodingSource = { sourceId, cwd, capturedAt: manifest.capturedAt, digest: manifest.digest, bytes: bytes.length, fileCount: manifest.fileCount, baseRevision: manifest.baseRevision };
  const prior = runtime.store.source(sourceId);
  if (prior && !sameSource(prior, source)) throw new StateError(409, "Source identity already contains different immutable bytes or metadata");
  await runtime.wake();
  // Freeze metadata before asynchronous PUT: concurrent uploads or receipt loss may
  // never let the same source/digest key acquire a different workspace binding.
  const intent = runtime.store.owner.effect(`coding-source-upload:${sourceId}`, () => source);
  if (!sameSource(intent, source)) throw new StateError(409, "Source upload identity already belongs to another snapshot");
  const key = `coding/uploads/${sourceId}/${source.digest}.gz`;
  const receipt = await archive.put(key, bytes, { sha256: source.digest, httpMetadata: { contentType: "application/gzip" }, customMetadata: { cwd, digest: source.digest } });
  const checksum = receipt?.checksums?.sha256;
  if (!receipt || receipt.key !== key || receipt.size !== bytes.length || receipt.customMetadata?.cwd !== cwd || receipt.customMetadata.digest !== source.digest
    || !checksum || Array.from(new Uint8Array(checksum), byte => byte.toString(16).padStart(2, "0")).join("") !== source.digest) throw new StateError(503, "Coding source retention was not confirmed by a matching R2 receipt");
  return Response.json(runtime.store.saveSource(source, key));
}

async function download(runtime: CodingRuntime, taskId: string, kind: "patch" | "checkpoint", runId?: string): Promise<Response> {
  const task = runtime.store.requireTask(taskId), run = runId ? runtime.store.ownedRun(taskId, runId) : task.run;
  const key = kind === "patch" ? run?.patchKey : run?.checkpointKey;
  if (!key || !run || kind === "patch" && !run.result) throw new StateError(404, "No retained coding artifact is available");
  const object = await runtime.archive().get(key);
  if (!object || object.key !== key) throw new StateError(404, "The retained coding artifact is unavailable");
  const maximum = kind === "patch" ? MAX_CODING_PATCH_BYTES : MAX_CODING_ARCHIVE_BYTES;
  let bytes: Uint8Array<ArrayBuffer>;
  if (kind === "patch" && object.size === 0) {
    const reader = object.body.getReader();
    try {
      for (;;) { const chunk = await reader.read(); if (chunk.done) break; if (chunk.value.length) throw new StateError(409, "Coding patch size changed"); }
    } finally { await reader.cancel(); }
    bytes = new Uint8Array(0);
  } else bytes = await bodyBytes(object.body, object.size, maximum);
  const digest = await codingSourceDigest(bytes);
  const headers = new Headers({ "content-type": kind === "patch" ? "text/x-diff; charset=utf-8" : "application/gzip", "content-length": String(bytes.length),
    "cache-control": "private, no-store", "x-content-type-options": "nosniff", "content-disposition": `attachment; filename="coding-${kind}.${kind === "patch" ? "patch" : "gz"}"` });
  if (kind === "patch") {
    const artifacts = run.result!.artifacts;
    if (digest !== artifacts.patchDigest) throw new StateError(409, "The retained patch no longer matches its recorded result");
    headers.set("x-umpi-coding-patch-digest", artifacts.patchDigest);
    headers.set("x-umpi-coding-base-digest", artifacts.baseDigest);
    headers.set("x-umpi-coding-final-digest", artifacts.finalDigest);
  } else {
    const source = run.checkpointSourceId ? runtime.store.source(run.checkpointSourceId) : undefined;
    if (!source || runtime.store.sourceKey(source.sourceId) !== key || source.cwd !== task.cwd || source.bytes !== bytes.length || source.digest !== digest) throw new StateError(409, "The retained checkpoint no longer matches its recorded source");
    headers.set("x-umpi-coding-source-digest", digest);
  }
  return new Response(bytes, { headers });
}

/** Caller must authenticate the owner role before dispatching any of these routes. */
export async function codingRequest(request: Request, runtime: CodingRuntime, controlSession: () => Promise<string>): Promise<Response | undefined> {
  const path = new URL(request.url).pathname, { store } = runtime;
  if (path === "/api/coding" && request.method === "GET") return Response.json(runtime.status());
  if (path === "/api/coding/sources" && request.method === "GET") return Response.json(store.sources());
  const source = /^\/api\/coding\/sources\/([A-Za-z0-9_.:-]+)$/.exec(path);
  if (source && request.method === "POST") return upload(request, runtime, identifier(source[1], "coding source"));
  if (path === "/api/coding/tasks") {
    if (request.method === "GET") return Response.json(store.tasks().map(task => runtime.read(task.taskId)));
    if (request.method === "POST") {
      const input = parseCodingRequest(await readJson(request, 131_072)), parentSessionId = await controlSession();
      await runtime.wake();
      const task = store.owner.db.transaction(() => {
        const task = store.create(input, "control", parentSessionId); enqueueCodingApproval(runtime, task); return task;
      });
      return Response.json(runtime.read(task.taskId), { status: 202 });
    }
    return;
  }
  const history = /^\/api\/coding\/tasks\/([A-Za-z0-9_.:-]+)\/runs(?:\/([A-Za-z0-9_.:-]+)\/(patch|checkpoint))?$/.exec(path);
  if (history && request.method === "GET") {
    const taskId = identifier(history[1], "coding task");
    if (history[2]) return download(runtime, taskId, history[3] as "patch" | "checkpoint", identifier(history[2], "coding run"));
    return Response.json(store.runs(taskId));
  }
  const taskRoute = /^\/api\/coding\/tasks\/([A-Za-z0-9_.:-]+)(?:\/(approve|cancel|correct|cloud|reconcile|patch|checkpoint))?$/.exec(path);
  if (!taskRoute) return;
  const taskId = identifier(taskRoute[1], "coding task"), action = taskRoute[2];
  if (request.method === "GET") {
    if (!action) return Response.json(runtime.read(taskId));
    if (action === "patch" || action === "checkpoint") return download(runtime, taskId, action);
    return;
  }
  if (request.method !== "POST" || !action || action === "patch" || action === "checkpoint") return;
  const body = fields(await readJson(request, 65_536), ["expectedVersion", ...(action === "correct" ? ["text"] : action === "cloud" ? ["sourceId"] : action === "reconcile" ? ["confirmStopped"] : [])]);
  const expectedVersion = version(body.expectedVersion);
  if (action === "approve") { runtime.archive(); if (store.requireTask(taskId).target === "cloud" && !runtime.cloudAvailable()) throw new StateError(503, "Cloud coding is unavailable"); }
  if (action === "cloud" && !runtime.cloudAvailable()) throw new StateError(503, "Cloud coding is unavailable");
  if (action === "reconcile" && body.confirmStopped !== true) throw new InputError("Explicit confirmStopped:true is required");
  await runtime.wake();
  if (action === "reconcile") { await runtime.reconcile(taskId, expectedVersion); return Response.json(runtime.read(taskId)); }
  store.owner.db.transaction(() => {
    const task = action === "approve" ? store.approve(taskId, expectedVersion) : action === "cancel" ? store.cancel(taskId, expectedVersion)
      : action === "correct" ? store.correct(taskId, expectedVersion, body.text) : store.requestCloud(taskId, expectedVersion, identifier(body.sourceId, "coding source"));
    enqueueCodingApproval(runtime, task);
  });
  return Response.json(runtime.read(taskId));
}

function executorReport(value: unknown): CodingExecutorReport {
  const raw = record(value), type = raw.type;
  if (type !== "ready" && type !== "operation" && type !== "stopped") throw new InputError("Unknown coding executor report");
  const body = fields(raw, ["executorId", "taskId", "runId", "type", ...(type === "ready" ? ["executionCwd"] : type === "operation" ? ["state"] : type === "stopped" ? ["uncertain", "issue", "ownerConfirmedStopped"] : [])]);
  const identity = { executorId: identifier(body.executorId, "executor"), taskId: identifier(body.taskId, "coding task"), runId: identifier(body.runId, "coding run") };
  if (type === "ready") return { ...identity, type, executionCwd: codingPath(body.executionCwd) };
  if (type === "operation") return { ...identity, type, state: parseCodingRpcState(body.state) };
  if (typeof body.uncertain !== "boolean" || body.ownerConfirmedStopped !== undefined && body.ownerConfirmedStopped !== true) throw new InputError("Invalid stopped coding receipt");
  return { ...identity, type, uncertain: body.uncertain, ...(body.issue === undefined ? {} : { issue: boundedText(body.issue, 2_000, "coding stop issue") }), ...(body.ownerConfirmedStopped === true ? { ownerConfirmedStopped: true } : {}) };
}

/** Caller must authenticate ONLY the executor credential, never an owner credential. */
export async function codingExecutorRequest(request: Request, runtime: CodingRuntime): Promise<Response | undefined> {
  const path = new URL(request.url).pathname;
  if (request.method !== "POST" || path !== "/api/executor/coding/poll" && path !== "/api/executor/coding/report") return;
  if (path.endsWith("/poll")) {
    const poll = parseCodingExecutorPoll(fields(await readJson(request, 131_072), ["executorId", "workspaces", "available", "activeRunId"]));
    if (poll.available && poll.activeRunId === null && runtime.store.active().some(task => task.target === "mac" && task.status === "queued" && poll.workspaces.includes(task.cwd) && (!task.run || task.run.executorId === poll.executorId))) await runtime.wake();
    return Response.json(runtime.store.poll(poll));
  }
  const report = executorReport(await readJson(request, MAX_CODING_RPC_BYTES + 8_192)), { store } = runtime;
  const run = store.ownedRun(report.taskId, report.runId);
  if (run.target !== "mac" || run.executorId !== report.executorId) throw new StateError(403, "This executor does not own the native coding run");
  await runtime.wake();
  store.owner.db.transaction(() => {
    const current = store.requireTask(report.taskId), owned = store.ownedRun(report.taskId, report.runId);
    if (report.type !== "stopped") {
      if (current.run?.runId !== report.runId || owned.stoppedAt) throw new StateError(409, "This coding run no longer accepts executor reports");
      if (report.type === "ready") store.ready(report.taskId, report.runId, report.executionCwd); else store.receipt(report.taskId, report.runId, report.state);
      return;
    }
    store.owner.db.all("CREATE TABLE IF NOT EXISTS umpi_coding_stop_receipts (run_id TEXT PRIMARY KEY,data TEXT NOT NULL)");
    const previous = store.owner.db.all<{ data: string }>("SELECT data FROM umpi_coding_stop_receipts WHERE run_id=?", report.runId)[0];
    const serialized = JSON.stringify(report);
    if (previous?.data === serialized && (current.run?.runId === report.runId || owned.stoppedAt)) return;
    if (current.run?.runId !== report.runId || owned.stoppedAt && !(report.ownerConfirmedStopped === true && current.status === "uncertain" && !owned.reconciledAt)) throw new StateError(409, "A stopped historical coding receipt cannot alter another run");
    store.stopped(report.taskId, report.runId, report.uncertain, report.issue, { ownerConfirmedStopped: report.ownerConfirmedStopped === true });
    store.owner.db.all("INSERT INTO umpi_coding_stop_receipts VALUES (?,?) ON CONFLICT(run_id) DO UPDATE SET data=excluded.data", report.runId, serialized);
  });
  return Response.json({ accepted: true });
}
