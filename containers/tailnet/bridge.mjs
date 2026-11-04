// Umpi's tailnet bridge: runs tailscaled and forwards HTTPS requests to hosts in the owner's tailnet
// (name.tailnet.ts.net) through tailscaled's proxy. Only Umpi's Durable Object can reach this port; the target allowlist
// keeps it from becoming a general proxy.
//
// The two processes live and die together. The port opens only after Tailscale is running, so a started bridge can
// reach the tailnet; if tailscaled exits, the bridge exits too, so a broken bridge never keeps answering, and the next
// request starts a fresh one. A stop signal ends both.
import { spawn, execFile } from "node:child_process";
import { openSync } from "node:fs";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { promisify } from "node:util";

// Tailscale reaches its own servers directly; the proxy settings are for the forwarder only.
const direct = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(https?_proxy|no_proxy|node_use_env_proxy|ts_authkey)$/i.test(name)));
const execute = promisify(execFile);
const run = (file, args) => execute(file, args, { env: direct });
const SOCKET = "/tmp/tailscale/tailscaled.sock";
// The forwarder reaches the tailnet through this proxy (HTTPS_PROXY in the image).
const PROXY = "127.0.0.1:1055";
const TAILNET_HOST = /^[a-z0-9-]{1,63}\.[a-z0-9-]{1,63}\.ts\.net$/i;
const DROP_REQUEST = new Set(["host", "connection", "keep-alive", "transfer-encoding", "upgrade", "content-length", "x-umpi-target", "proxy-authorization", "proxy-connection"]);
const DROP_RESPONSE = new Set(["connection", "keep-alive", "transfer-encoding", "content-encoding", "content-length"]);
// Umpi itself waits 20 seconds for a tailnet machine.
const UPSTREAM_MS = 60_000;

let stopping = false;
let tailscaled;
function stop(code, why) {
  if (stopping) return;
  stopping = true;
  if (why) console.error(why);
  tailscaled?.kill("SIGTERM");
  process.exit(code);
}
// As the container's main process, Node ignores stop signals unless it handles them; without this the bridge never sleeps.
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => stop(0));

const key = process.env.TS_AUTHKEY;
delete process.env.TS_AUTHKEY;
if (!key) stop(1, "No Tailscale credential is configured");

const log = openSync("/tmp/tailscale/tailscaled.log", "a");
tailscaled = spawn("tailscaled", ["--tun=userspace-networking", "--state=mem:", "--statedir=/tmp/tailscale", `--socket=${SOCKET}`,
  `--outbound-http-proxy-listen=${PROXY}`], { stdio: ["ignore", log, log], env: direct });
tailscaled.on("exit", (code, signal) => stop(1, `tailscaled exited (${signal ?? code}); the bridge stops with it`));
tailscaled.on("error", error => stop(1, `tailscaled did not start: ${error.message}`));

// An OAuth client secret works as an auth key when the device asks for a tag; ephemeral devices leave the tailnet on their own.
const authKey = key.startsWith("tskey-client-") ? `${key}?ephemeral=true&preauthorized=true` : key;
try {
  const status = async () => JSON.parse((await run("tailscale", [`--socket=${SOCKET}`, "status", "--json"])).stdout).BackendState;
  await waitFor(async () => Boolean(await status()), 15_000, "tailscaled did not start");
  await run("tailscale", [`--socket=${SOCKET}`, "up", `--auth-key=${authKey}`, `--advertise-tags=${process.env.TS_TAGS ?? "tag:umpi"}`,
    `--hostname=${process.env.TS_HOSTNAME ?? "umpi-bridge"}`, "--timeout=40s"]);
  await waitFor(async () => await status() === "Running", 30_000,
    "Tailscale did not reach the running state");
} catch (error) {
  stop(1, `The bridge could not join the tailnet: ${String(error?.stderr || error?.message || error).slice(0, 300)}`);
}

async function waitFor(check, ms, message) {
  const until = Date.now() + ms;
  for (;;) {
    try { if (await check()) return; } catch { /* not yet */ }
    if (Date.now() > until) throw new Error(message);
    await new Promise(resolve => setTimeout(resolve, 200));
  }
}

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
  for (const [name, value] of Object.entries(req.headers)) {
    if (!DROP_REQUEST.has(name) && value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
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
  response.headers.forEach((value, name) => { if (!DROP_RESPONSE.has(name)) out[name] = value; });
  res.writeHead(response.status, out);
  if (!response.body) { res.end(); return; }
  Readable.fromWeb(response.body).on("error", () => res.destroy()).pipe(res);
}).listen(8080, "0.0.0.0");
