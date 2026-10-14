import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { closeSync, fstatSync, readFileSync } from "node:fs";
import { open, unlink, type FileHandle } from "node:fs/promises";
import { createServer } from "node:http";
import { basename, dirname, join, resolve } from "node:path";
import { privateDirectory, privateFile } from "../mac/config.js";

export class GoogleOAuthCliError extends Error {}

function readPrivateJson(path: string, service: string): unknown {
  const absolute = resolve(path);
  privateDirectory(dirname(absolute), false);
  const fd = privateFile(absolute);
  try {
    if (fstatSync(fd).size > 65_536) throw new GoogleOAuthCliError(`Private ${service} configuration is too large`);
    return JSON.parse(readFileSync(fd, "utf8"));
  } finally { closeSync(fd); }
}

export function googleCredentialStatus<T>(path: string, service: string, parse: (value: unknown) => T): { configured: boolean } {
  try { parse(readPrivateJson(path, service)); return { configured: true }; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { configured: false };
    throw new GoogleOAuthCliError(`Cannot read private ${service} credentials; check file safety and format`);
  }
}

/** Installed-app OAuth with fixed Google endpoints, loopback state, PKCE, exact scopes, and exclusive private output. */
export async function loginGoogle<T>(options: {
  service: string;
  clientConfig: string;
  credentials: string;
  scopes: readonly string[];
  parseCredential: (value: unknown) => T;
  authorize: (loopbackUrl: string) => void | Promise<void>;
  signal?: AbortSignal;
  fetcher?: typeof fetch;
}): Promise<void> {
  const title = `${options.service[0]!.toUpperCase()}${options.service.slice(1)}`;
  let client: { clientId: string; clientSecret: string };
  let destination: string;
  let output: FileHandle;
  try {
    const config = readPrivateJson(options.clientConfig, options.service) as { installed?: { client_id?: unknown; client_secret?: unknown } } | null;
    const clientId = config?.installed?.client_id, clientSecret = config?.installed?.client_secret;
    if (typeof clientId !== "string" || typeof clientSecret !== "string" || !clientId || !clientSecret || clientId.length > 16_384 || clientSecret.length > 16_384 || /\s/.test(clientId + clientSecret)) throw new Error();
    client = { clientId, clientSecret };
    const absolute = resolve(options.credentials), directory = privateDirectory(dirname(absolute));
    destination = join(directory, basename(absolute));
    output = await open(destination, "wx", 0o600);
  } catch {
    throw new GoogleOAuthCliError(`Cannot prepare ${options.service} login: use a protected installed-client file and a new credential path outside the repository`);
  }
  let persisted = false;
  const server = createServer();
  server.requestTimeout = 10_000; server.headersTimeout = 10_000;
  const state = randomBytes(32).toString("base64url"), verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const signal = AbortSignal.any([options.signal ?? new AbortController().signal, AbortSignal.timeout(5 * 60_000)]);
  let abort: (() => void) | undefined;
  try {
    signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => { server.removeListener("error", reject); resolve(); });
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error();
    const origin = `http://127.0.0.1:${address.port}`, redirectUri = `${origin}/callback`;
    const authorization = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    authorization.search = new URLSearchParams({ client_id: client.clientId, redirect_uri: redirectUri, response_type: "code",
      scope: options.scopes.join(" "), state, code_challenge: challenge, code_challenge_method: "S256", access_type: "offline", prompt: "consent", include_granted_scopes: "false" }).toString();
    let received = false;
    const codePromise = new Promise<string>((resolve, reject) => {
      abort = () => reject(new Error());
      signal.addEventListener("abort", abort, { once: true });
      server.once("error", reject);
      server.on("request", (request, response) => {
        response.setHeader("Cache-Control", "no-store"); response.setHeader("Referrer-Policy", "no-referrer");
        response.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'"); response.setHeader("Content-Type", "text/plain; charset=utf-8");
        const deny = () => { response.writeHead(400); response.end("Invalid authorization request."); };
        if (request.method !== "GET" || request.headers.host !== `127.0.0.1:${address.port}` || !request.url?.startsWith("/")) { deny(); return; }
        let url: URL;
        try { url = new URL(request.url, origin); } catch { deny(); return; }
        if (url.origin !== origin) { deny(); return; }
        if (url.pathname === "/authorize" && !received) { response.writeHead(302, { Location: authorization.href }); response.end(); return; }
        const incomingState = url.searchParams.get("state");
        if (url.pathname !== "/callback" || received || url.searchParams.getAll("state").length !== 1 || !incomingState || !/^[A-Za-z0-9_-]{43}$/.test(incomingState) || !timingSafeEqual(Buffer.from(incomingState), Buffer.from(state))) { deny(); return; }
        const code = url.searchParams.get("code"); received = true;
        if (url.searchParams.has("error") || !code || code.length > 8192 || url.searchParams.getAll("code").length !== 1) {
          response.writeHead(400); response.end(`${title} authorization was not completed.`); reject(new Error()); return;
        }
        response.end("Authorization received. Return to the terminal for storage status."); resolve(code);
      });
      if (signal.aborted) abort();
    });
    const [code] = await Promise.all([codePromise, Promise.resolve().then(() => options.authorize(`${origin}/authorize`))]);
    const response = await (options.fetcher ?? fetch)("https://oauth2.googleapis.com/token", { method: "POST", redirect: "error", signal,
      body: new URLSearchParams({ client_id: client.clientId, client_secret: client.clientSecret, code, code_verifier: verifier, redirect_uri: redirectUri, grant_type: "authorization_code" }) });
    if (!response.ok) throw new Error();
    const token = await response.json() as { refresh_token?: unknown; scope?: unknown };
    if (typeof token.scope !== "string") throw new Error();
    const granted = new Set(token.scope.split(/\s+/).filter(Boolean));
    if (granted.size !== options.scopes.length || !options.scopes.every(scope => granted.has(scope))) throw new Error();
    const credential = options.parseCredential({ ...client, refreshToken: token.refresh_token });
    await output.writeFile(`${JSON.stringify(credential)}\n`, "utf8"); await output.sync();
    const directory = await open(dirname(destination), "r");
    try { await directory.sync(); } finally { await directory.close(); }
    persisted = true;
  } catch {
    throw new GoogleOAuthCliError(`${title} authorization failed or was cancelled; no credential was stored and provider details were not logged`);
  } finally {
    if (abort) signal.removeEventListener("abort", abort);
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await output.close(); if (!persisted) await unlink(destination);
  }
}
