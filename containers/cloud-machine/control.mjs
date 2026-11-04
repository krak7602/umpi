// The control server of a cloud machine. Only the machine's Durable Object reaches this port.
//   POST /restore   unpack saved state (tar.zst) into the home folder
//   POST /start     write credentials and settings for this run, start T3 Code, return Umpi's MCP token
//   /t3/*           relay to T3 Code's server on 127.0.0.1:3773
//   POST /snapshot  stop T3 Code and pack the home folder (without credentials or rebuildable folders)
import { createServer } from "node:http";
import { spawn, execFile } from "node:child_process";
import { mkdir, writeFile, readFile, rm, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { promisify } from "node:util";
import { createHash, randomBytes } from "node:crypto";

const HOME = "/home/agent";
const run = promisify(execFile);
let t3;
/** Where Umpi is, and this machine's own token for it; known once Umpi starts the machine. */
let umpi;
let stopping = false;

const json = (res, status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
const readBody = async req => { const parts = []; for await (const chunk of req) parts.push(chunk); return Buffer.concat(parts).toString("utf8"); };

async function configure(input) {
  await mkdir(`${HOME}/.ssh`, { recursive: true, mode: 0o700 });
  await mkdir(`${HOME}/.pi/agent`, { recursive: true });
  await mkdir(`${HOME}/.umpi`, { recursive: true, mode: 0o700 });
  await mkdir(`${HOME}/work`, { recursive: true });
  if (input.gitKey) {
    const key = input.gitKey.includes("BEGIN") ? input.gitKey : Buffer.from(input.gitKey, "base64").toString("utf8");
    await writeFile(`${HOME}/.ssh/id_ed25519`, key.endsWith("\n") ? key : `${key}\n`, { mode: 0o600 });
    await writeFile(`${HOME}/.ssh/config`, "Host github.com\n  IdentityFile ~/.ssh/id_ed25519\n  IdentitiesOnly yes\n  StrictHostKeyChecking yes\n", { mode: 0o600 });
  }
  // Commit identity: a default, and per-remote emails chosen by Git's hasconfig:remote.*.url rule.
  if (input.gitIdentity) {
    const identity = typeof input.gitIdentity === "string"
      ? JSON.parse(input.gitIdentity.trim().startsWith("{") ? input.gitIdentity : Buffer.from(input.gitIdentity, "base64").toString("utf8"))
      : input.gitIdentity;
    const quote = value => String(value).replace(/["\\\n]/g, "");
    let config = `[user]\n\tname = ${quote(identity.name)}\n\temail = ${quote(identity.email)}\n[init]\n\tdefaultBranch = main\n[push]\n\tautoSetupRemote = true\n`;
    await mkdir(`${HOME}/.config/umpi`, { recursive: true });
    for (const [index, rule] of (identity.byRemote ?? []).entries()) {
      const file = `${HOME}/.config/umpi/git-identity-${index}.inc`;
      await writeFile(file, `[user]\n\temail = ${quote(rule.email)}\n`);
      config += `[includeIf "hasconfig:remote.*.url:${quote(rule.remote)}"]\n\tpath = ${file}\n`;
    }
    await writeFile(`${HOME}/.gitconfig`, config);
  }
  // Pi: one provider, Umpi's gateway; no cache warming, which would spend the subscription between turns.
  const models = (input.models ?? []).map(model => ({ id: model.id, name: model.name ?? model.id, reasoning: model.reasoning !== false,
    input: model.input ?? ["text", "image"], contextWindow: model.contextWindow ?? 200000, maxTokens: model.maxTokens ?? 32000 }));
  await writeFile(`${HOME}/.pi/agent/models.json`, JSON.stringify({ providers: { umpi: { name: "Umpi", baseUrl: input.modelUrl, api: "pi-messages", apiKey: input.modelToken, models } } }, null, 2), { mode: 0o600 });
  await writeFile(`${HOME}/.pi/agent/settings.json`, JSON.stringify({ defaultProvider: "umpi", defaultModel: input.defaultModel ?? models[0]?.id, cacheWarming: "off" }, null, 2));
}

/**
 * Umpi's MCP credential at full access. T3 Code grants full access only through its OAuth approval, so the machine
 * approves Umpi itself over loopback: a one-time pairing code minted here, a full-access decision, and the code
 * exchange. T3 Code's tokens last about 30 days; a start renews one with less than three days left.
 */
async function token() {
  const file = `${HOME}/.umpi/mcp.json`;
  try {
    const saved = JSON.parse(await readFile(file, "utf8"));
    if (saved.token && saved.expiresAt - Date.now() > 3 * 86_400_000) return saved.token;
  } catch {}
  const base = "http://127.0.0.1:3773", redirect = "http://127.0.0.1/umpi-callback";
  const { stdout } = await run("t3", ["auth", "pairing", "create", "--json", "--label", "Umpi", "--ttl", "5m"], { cwd: HOME, timeout: 60_000 });
  const code = JSON.parse(stdout.slice(stdout.indexOf("{"))).credential;
  if (!code) throw new Error("T3 Code did not issue a pairing code");
  const post = async (path, body, form = false) => {
    const res = await fetch(`${base}${path}`, { method: "POST", headers: { "content-type": form ? "application/x-www-form-urlencoded" : "application/json" }, body: form ? new URLSearchParams(body) : JSON.stringify(body) });
    const text = await res.text();
    if (!res.ok) throw new Error(`${path} ${res.status}: ${text.slice(0, 200)}`);
    return JSON.parse(text);
  };
  const client = await post("/oauth/mcp/register", { client_name: "Umpi", redirect_uris: [redirect], token_endpoint_auth_method: "none", grant_types: ["authorization_code"], response_types: ["code"] });
  const verifier = randomBytes(32).toString("base64url");
  const authorization = { response_type: "code", client_id: client.client_id, redirect_uri: redirect, state: randomBytes(16).toString("base64url"),
    code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256", resource: `${base}/mcp` };
  const decided = await post("/oauth/mcp/decision", { authorization, decision: { _tag: "pairing-code", access: "full-access", code } });
  const granted = new URL(decided.redirectTo).searchParams.get("code");
  if (!granted) throw new Error("T3 Code did not approve Umpi");
  const issued = await post("/oauth/mcp/token", { grant_type: "authorization_code", code: granted, redirect_uri: redirect, client_id: client.client_id, code_verifier: verifier, resource: `${base}/mcp` }, true);
  await writeFile(file, JSON.stringify({ token: issued.access_token, expiresAt: Date.now() + (issued.expires_in ?? 2_592_000) * 1000 }), { mode: 0o600 });
  return issued.access_token;
}

/** T3 Code's own settings: Pi is the agent here, and Umpi's models are offered for it. */
async function settings(input) {
  const file = `${HOME}/.t3/userdata/settings.json`;
  let current = {};
  try { current = JSON.parse(await readFile(file, "utf8")); } catch {}
  current.providers = { ...(current.providers ?? {}), pi: { ...(current.providers?.pi ?? {}), enabled: true } };
  await mkdir(`${HOME}/.t3/userdata`, { recursive: true });
  await writeFile(file, JSON.stringify(current, null, 2));
}

async function startT3() {
  if (t3 && t3.exitCode === null) return;
  // All interfaces: the machine's Durable Object reaches T3 Code on this port for the owner's T3 Code apps. Nothing
  // else can reach a container port, and T3 Code asks every client for its own pairing.
  t3 = spawn("t3", ["serve", "--host", "0.0.0.0", "--port", "3773"], { cwd: HOME, stdio: ["ignore", "ignore", "ignore"], detached: false });
  for (let attempt = 0; attempt < 120; attempt++) {
    try { const res = await fetch("http://127.0.0.1:3773/mcp", { method: "POST", signal: AbortSignal.timeout(2000) }); if (res.status) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error("T3 Code did not start within two minutes");
}

async function stopT3() {
  if (!t3 || t3.exitCode !== null) return;
  t3.kill("SIGTERM");
  for (let attempt = 0; attempt < 30 && t3.exitCode === null; attempt++) await new Promise(resolve => setTimeout(resolve, 500));
  if (t3.exitCode === null) t3.kill("SIGKILL");
}

// Rebuildable or secret paths stay out of saved state.
const EXCLUDE = ["./.ssh", "./.umpi/mcp.json", "./.pi/agent/models.json", "./.t3/runtime", "./.t3/caches", "./.npm", "./.cache",
  "node_modules", ".next", ".turbo", "target", ".venv", "__pycache__"];

/**
 * A stop signal (an image rollout or a platform restart) gives 15 minutes before the machine is killed. Work since the
 * last save would be lost, so the machine asks Umpi to save it now: Umpi takes its usual last look, packs the state
 * through /snapshot, stores it, and stops the machine. T3 Code keeps running until then. If Umpi never comes, the
 * machine stops T3 Code cleanly and exits before the deadline.
 */
const GRACE_MS = Number(process.env.UMPI_STOP_GRACE_MS ?? 13 * 60_000);
async function stop() {
  if (stopping) return;
  stopping = true;
  if (!umpi) { await stopT3().catch(() => {}); process.exit(0); }
  setTimeout(async () => { await stopT3().catch(() => {}); process.exit(0); }, GRACE_MS).unref?.();
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const res = await fetch(`${umpi.origin}/api/cloud/stopping`, { method: "POST", headers: { authorization: `Bearer ${umpi.token}` }, signal: AbortSignal.timeout(15_000) });
      if (res.ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 20_000));
  }
  // Umpi also notices a stopping machine on its own two-minute check.
}
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => { void stop(); });

createServer(async (req, res) => {
  try {
    const path = (req.url ?? "/").split("?")[0];
    if (path === "/ready") return json(res, 200, { ok: true, t3: !!t3 && t3.exitCode === null, stopping });
    if (path === "/restore" && req.method === "POST") {
      const tar = spawn("tar", ["--zstd", "-xf", "-", "-C", HOME], { stdio: ["pipe", "ignore", "pipe"] });
      let errors = ""; tar.stderr.on("data", chunk => { errors += chunk; });
      req.pipe(tar.stdin);
      const code = await new Promise(resolve => tar.on("close", resolve));
      return code === 0 ? json(res, 200, { restored: true }) : json(res, 500, { error: `restore failed: ${errors.slice(0, 300)}` });
    }
    if (path === "/start" && req.method === "POST") {
      if (stopping) return json(res, 503, { error: "This machine is stopping" });
      const input = JSON.parse(await readBody(req));
      if (typeof input.modelUrl === "string" && typeof input.modelToken === "string") umpi = { origin: new URL(input.modelUrl).origin, token: input.modelToken };
      await configure(input);
      await settings(input);
      await startT3();
      const issued = await token();
      return json(res, 200, { token: issued });
    }
    if (path === "/snapshot" && req.method === "POST") {
      await stopT3();
      const file = "/tmp/state.tar.zst";
      await rm(file, { force: true });
      await run("tar", ["--zstd", "-cf", file, ...EXCLUDE.flatMap(item => ["--exclude", item]), "-C", HOME, "."], { timeout: 600_000, maxBuffer: 1 << 20 });
      const { size } = await stat(file);
      res.writeHead(200, { "content-type": "application/zstd", "content-length": String(size) });
      return void createReadStream(file).pipe(res);
    }
    if (path === "/pairing" && req.method === "POST") {
      // A one-time link for the owner's T3 Code app, at the machine's public address.
      const { baseUrl } = JSON.parse(await readBody(req));
      if (typeof baseUrl !== "string" || !/^https:\/\/[a-z0-9.-]+$/.test(baseUrl)) return json(res, 400, { error: "baseUrl must be https://host" });
      const { stdout } = await run("t3", ["auth", "pairing", "create", "--json", "--label", "T3 mobile", "--ttl", "15m", "--base-url", baseUrl], { cwd: HOME, timeout: 60_000 });
      const issued = JSON.parse(stdout.slice(stdout.indexOf("{")));
      if (typeof issued.pairUrl !== "string") throw new Error("T3 Code did not issue a pairing link");
      return json(res, 200, { pairUrl: issued.pairUrl, expiresAt: issued.expiresAt });
    }
    if (path.startsWith("/t3/")) {
      const target = `http://127.0.0.1:3773${req.url.slice(3)}`;
      const headers = {};
      for (const [key, value] of Object.entries(req.headers)) if (!["host", "connection", "content-length"].includes(key) && value !== undefined) headers[key] = Array.isArray(value) ? value.join(", ") : value;
      const abort = new AbortController(); res.on("close", () => abort.abort());
      const upstream = await fetch(target, { method: req.method, headers, signal: abort.signal,
        ...(req.method === "GET" || req.method === "HEAD" ? {} : { body: Readable.toWeb(req), duplex: "half" }) });
      const out = {}; upstream.headers.forEach((value, key) => { if (!["content-encoding", "content-length", "transfer-encoding", "connection"].includes(key)) out[key] = value; });
      res.writeHead(upstream.status, out);
      if (!upstream.body) return void res.end();
      return void Readable.fromWeb(upstream.body).on("error", () => res.destroy()).pipe(res);
    }
    json(res, 404, { error: "not found" });
  } catch (error) {
    if (!res.headersSent) json(res, 500, { error: String(error?.message ?? error).slice(0, 500) });
    else res.destroy();
  }
}).listen(8080, "0.0.0.0");
