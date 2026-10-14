import { MAX_BROWSER_IMAGE_BYTES, MAX_BROWSER_OBSERVATION_BYTES, MAX_BROWSER_SITES, MAX_BROWSER_SNAPSHOT_BYTES } from "../shared/browser.js";
import type { BrowserExecutorPoll, BrowserExecutorReport } from "../shared/browser.js";
import { identifier, InputError, record } from "../shared/protocol.js";
import { readCodingBody } from "./coding-cloud.js";
import type { BrowserRuntime } from "./browser-runtime.js";
import { enqueueBrowserApproval } from "./browser-telegram.js";
import { StateError } from "./store.js";
import { readJson } from "./transport.js";
function only(input: Record<string, unknown>, keys: string[]): void { if (Object.keys(input).some(key => !keys.includes(key))) throw new InputError("Invalid browser request fields"); }
export async function browserSyncRequest(request: Request, runtime: BrowserRuntime): Promise<Response | undefined> {
  const path = new URL(request.url).pathname;
  if (path === "/api/browser/snapshot-key" && request.method === "GET") return Response.json(await runtime.snapshots.publicKey());
  if (path === "/api/browser/snapshot-requests" && request.method === "GET") {
    const after = new URL(request.url).searchParams.get("after") ?? "0";
    if (!/^(?:0|[1-9][0-9]*)$/.test(after)) throw new InputError("Invalid browser snapshot request cursor");
    return Response.json(runtime.store.snapshotRequests(Number(after)));
  }
  const requested = /^\/api\/browser\/snapshot-requests\/([A-Za-z0-9_.:-]+)$/.exec(path);
  if (requested && request.method === "GET") {
    const site = runtime.store.requestedSnapshotSite(identifier(requested[1], "browser site"));
    if (!site) throw new StateError(404, "Browser snapshot request is no longer approved");
    return Response.json({ site });
  }
  const match = /^\/api\/browser\/snapshots\/([A-Za-z0-9_.:-]+)$/.exec(path);
  if (!match || request.method !== "POST") return;
  if (request.headers.get("content-type")?.toLowerCase() !== "application/json" || request.headers.has("content-encoding")) throw new StateError(415, "Upload raw encrypted browser JSON without Content-Encoding");
  const length = request.headers.get("content-length"); if (!length || !/^[1-9][0-9]*$/.test(length)) throw new InputError("Encrypted browser upload needs an exact Content-Length");
  const bytes = await readCodingBody(request.body, Number(length), MAX_BROWSER_SNAPSHOT_BYTES);
  try {
    return Response.json(await runtime.snapshots.upload(identifier(match[1], "browser snapshot"), bytes));
  } finally {
    // Failed first PUTs also own a cleanup candidate; no later Mac upload is required.
    if (runtime.snapshots.nextDue() !== undefined) await runtime.wake();
  }
}
export async function browserRequest(request: Request, runtime: BrowserRuntime, controlSession: () => Promise<string>): Promise<Response | undefined> {
  const path = new URL(request.url).pathname, store = runtime.store;
  if (path === "/api/browser" && request.method === "GET") return Response.json(runtime.status());
  if (path === "/api/browser/settings" && request.method === "GET") return Response.json(store.settings());
  if (path === "/api/browser/settings" && request.method === "PUT") {
    const input = record(await readJson(request)); only(input, ["expectedVersion", "allSites"]);
    return Response.json(store.configure(input.expectedVersion, input.allSites));
  }
  if (path === "/api/browser/sites" && request.method === "GET") return Response.json({ sites: store.sites() });
  const site = /^\/api\/browser\/sites\/([A-Za-z0-9_.:-]+)$/.exec(path);
  if (site && request.method === "PUT") {
    const input = record(await readJson(request)); only(input, ["expectedVersion", "policy"]);
    const policy = record(input.policy); if (policy.siteId !== site[1]) throw new StateError(409, "Browser site identity changed");
    return Response.json(store.owner.db.transaction(() => store.registerSite(policy, input.expectedVersion)));
  }
  if (path === "/api/browser/snapshots" && request.method === "GET") return Response.json({ snapshots: store.snapshots() });
  if (path === "/api/browser/tasks" && request.method === "GET") return Response.json(store.tasks().map(task => runtime.read(task.taskId)));
  if (path === "/api/browser/tasks" && request.method === "POST") {
    const requestBody = await readJson(request), session = await controlSession(), task = store.owner.db.transaction(() => { const task = store.create(requestBody, "control", session); enqueueBrowserApproval(runtime, task); return task; });
    await runtime.wake(); return Response.json(runtime.read(task.taskId), { status: 201 });
  }
  const route = /^\/api\/browser\/tasks\/([A-Za-z0-9_.:-]+)(?:\/(approve|cancel|correct|cloud|reconcile|runs))?$/.exec(path);
  if (!route) return;
  const taskId = identifier(route[1], "browser task"), action = route[2];
  if (request.method === "GET" && !action) return Response.json(runtime.read(taskId));
  if (request.method === "GET" && action === "runs") return Response.json(store.runs(taskId));
  if (request.method !== "POST" || !action || action === "runs") return;
  const input = record(await readJson(request)); only(input, ["expectedVersion", ...(action === "correct" ? ["text"] : action === "cloud" ? ["snapshotIds"] : action === "reconcile" ? ["confirmStopped"] : [])]);
  if (action === "reconcile") await runtime.reconcile(taskId, input.expectedVersion, input.confirmStopped);
  else store.owner.db.transaction(() => {
    const task = action === "approve" ? store.approve(taskId, input.expectedVersion) : action === "cancel" ? store.cancel(taskId, input.expectedVersion) : action === "correct" ? store.correct(taskId, input.expectedVersion, input.text) : (() => { if (!runtime.cloudAvailable()) throw new StateError(503, "Cloud browser is unavailable"); return store.requestCloud(taskId, input.expectedVersion, input.snapshotIds); })();
    enqueueBrowserApproval(runtime, task);
  });
  await runtime.wake(); return Response.json(runtime.read(taskId));
}
export async function browserExecutorRequest(request: Request, runtime: BrowserRuntime): Promise<Response | undefined> {
  const path = new URL(request.url).pathname;
  if (request.method !== "POST" || !["/api/executor/browser/poll", "/api/executor/browser/report"].includes(path)) return;
  const input = record(await readJson(request, 2 * MAX_BROWSER_IMAGE_BYTES + MAX_BROWSER_OBSERVATION_BYTES));
  if (path.endsWith("/poll")) {
    only(input, ["executorId", "available", "activeRunId", "sites", "allSites"]);
    if (typeof input.available !== "boolean" || input.allSites !== undefined && typeof input.allSites !== "boolean" || !Array.isArray(input.sites) || input.sites.length > MAX_BROWSER_SITES) throw new InputError("Invalid browser executor advertisement");
    const poll: BrowserExecutorPoll = { executorId: identifier(input.executorId, "browser executor"), available: input.available, activeRunId: input.activeRunId === null ? null : identifier(input.activeRunId, "browser run"), allSites: input.allSites === true, sites: input.sites.map(value => { const site = record(value); only(site, ["siteId", "policyDigest"]); if (typeof site.policyDigest !== "string" || !/^[a-f0-9]{64}$/.test(site.policyDigest)) throw new InputError("Invalid browser executor policy"); return { siteId: identifier(site.siteId, "browser site"), policyDigest: site.policyDigest }; }) };
    const shouldClaim = !poll.activeRunId && poll.available && runtime.store.active().some(task => task.status === "queued" && task.target === "mac");
    if (shouldClaim) await runtime.wake();
    return Response.json(runtime.store.poll(poll));
  }
  only(input, ["kind", "executorId", "taskId", "runId", ...(input.kind === "receipt" ? ["receipt"] : input.kind === "stopped" ? ["stopped", "uncertain", "issue", "ownerConfirmedStopped"] : [])]);
  const executorId = identifier(input.executorId, "browser executor"), taskId = identifier(input.taskId, "browser task"), runId = identifier(input.runId, "browser run"), run = runtime.store.ownedRun(taskId, runId);
  if (run.target !== "mac" || run.executorId !== executorId) throw new StateError(403, "Browser report has a different execution owner");
  const current = runtime.store.requireTask(taskId);
  if (current.run?.runId !== runId) { if (!run.stoppedAt) throw new StateError(409, "Prior browser ownership has not stopped"); return Response.json({ acknowledged: true }); }
  if (input.kind === "ready") runtime.store.ready(taskId, runId);
  else if (input.kind === "receipt") runtime.store.receipt(taskId, runId, input.receipt);
  else if (input.kind === "stopped") {
    if (typeof input.stopped !== "boolean" || typeof input.uncertain !== "boolean" || !input.stopped && (!input.uncertain || input.ownerConfirmedStopped === true) || input.ownerConfirmedStopped !== undefined && input.ownerConfirmedStopped !== true || input.issue !== undefined && (typeof input.issue !== "string" || input.issue.length > 1000)) throw new InputError("Invalid browser stop receipt");
    const report: Extract<BrowserExecutorReport, { kind: "stopped" }> = { kind: "stopped", executorId, taskId, runId, stopped: input.stopped, uncertain: input.uncertain, ...(input.ownerConfirmedStopped === true ? { ownerConfirmedStopped: true } : {}), ...(typeof input.issue === "string" ? { issue: input.issue } : {}) };
    if (report.stopped) runtime.store.stopped(taskId, runId, report.uncertain, report.issue, report.ownerConfirmedStopped);
    else runtime.store.uncertain(taskId, report.issue ?? "Owned Aside tabs are not confirmed closed; review the retained Mac owner before reconciliation");
  } else throw new InputError("Unknown browser executor report");
  await runtime.wake(); return Response.json({ acknowledged: true });
}
