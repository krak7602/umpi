// Forwards one HTTPS request to a host in the owner's tailnet (name.tailnet.ts.net), through tailscaled's proxy.
// Only Umpi's Durable Object can reach this port; the target allowlist keeps it from becoming a general proxy.
import { createServer } from "node:http";
import { Readable } from "node:stream";

const TAILNET_HOST = /^[a-z0-9-]{1,63}\.[a-z0-9-]{1,63}\.ts\.net$/i;
const DROP_REQUEST = new Set(["host", "connection", "keep-alive", "transfer-encoding", "upgrade", "content-length", "x-umpi-target", "proxy-authorization", "proxy-connection"]);
// Umpi itself waits 20 seconds for a tailnet machine.
const UPSTREAM_MS = 60_000;
const DROP_RESPONSE = new Set(["connection", "keep-alive", "transfer-encoding", "content-encoding", "content-length"]);

function fail(res, status, message) {
  res.writeHead(status, { "content-type": "application/json", "x-umpi-bridge": "error" });
  res.end(JSON.stringify({ error: message }));
}

createServer(async (req, res) => {
  if (req.url === "/ready") { res.writeHead(200); res.end("ok"); return; }
  if (req.url !== "/forward") return fail(res, 404, "Not found");
  let target;
  try { target = new URL(String(req.headers["x-umpi-target"] ?? "")); } catch { return fail(res, 400, "Invalid target"); }
  if (target.protocol !== "https:" || !TAILNET_HOST.test(target.hostname) || (target.port && target.port !== "443") || target.username || target.password) {
    return fail(res, 403, "Only https://<name>.<tailnet>.ts.net is reachable through the bridge");
  }
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (!DROP_REQUEST.has(key) && value !== undefined) headers.set(key, Array.isArray(value) ? value.join(", ") : value);
  }
  const abort = new AbortController();
  res.on("close", () => abort.abort());
  let response;
  try {
    // An offline machine may never answer. A request that never ends keeps the bridge awake, so each one has a limit.
    response = await fetch(target, { method: req.method, headers, redirect: "manual", signal: AbortSignal.any([abort.signal, AbortSignal.timeout(UPSTREAM_MS)]),
      ...(req.method === "GET" || req.method === "HEAD" ? {} : { body: Readable.toWeb(req), duplex: "half" }) });
  } catch (error) {
    const cause = error?.cause?.code ?? error?.cause?.message ?? error?.message ?? "unknown";
    return fail(res, 502, `The machine did not answer through the tailnet (${String(cause).slice(0, 120)})`);
  }
  const out = {};
  response.headers.forEach((value, key) => { if (!DROP_RESPONSE.has(key)) out[key] = value; });
  res.writeHead(response.status, out);
  if (!response.body) { res.end(); return; }
  Readable.fromWeb(response.body).on("error", () => res.destroy()).pipe(res);
}).listen(8080, "0.0.0.0");

// As the container's main process, Node ignores stop signals unless it handles them; without this the bridge never sleeps.
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => process.exit(0));
