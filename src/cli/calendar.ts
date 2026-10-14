import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { closeSync, fstatSync, readFileSync } from "node:fs";
import { open, unlink, type FileHandle } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { privateDirectory, privateFile } from "../mac/config.js";
import { CALENDAR_SCOPES, parseCalendarCredentials } from "../worker/calendar.js";

const DEFAULT_CREDENTIALS = join(homedir(), ".config", "umpi", "calendar", "credentials.json");
const USAGE = `Usage:
  npm run calendar -- login --client-config PATH [--credentials PATH]
  npm run calendar -- status [--credentials PATH]

The explicit client file must be a Google Desktop app installed-client JSON.
Both files and their directories must be owner-only and outside the repository.
Credentials default to ~/.config/umpi/calendar/credentials.json (mode 0600).
Login requests only read-only calendar list and event access. Open the printed
loopback URL yourself to authorize a new independent grant. Existing output is
never replaced. No account details or tokens are printed or uploaded.
`;

class CalendarCliError extends Error {}

function readPrivateJson(path: string): unknown {
  const absolute = resolve(path);
  privateDirectory(dirname(absolute), false);
  const fd = privateFile(absolute);
  try {
    if (fstatSync(fd).size > 65_536) throw new CalendarCliError("Private calendar configuration is too large");
    return JSON.parse(readFileSync(fd, "utf8"));
  } finally { closeSync(fd); }
}

/** No network or refresh: only protected local credential presence and schema validity. */
export function calendarCredentialStatus(path: string): { configured: boolean } {
  try {
    parseCalendarCredentials(readPrivateJson(path));
    return { configured: true };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { configured: false };
    throw new CalendarCliError("Cannot read private calendar credentials; check file safety and format");
  }
}

/** Test seams replace transport/authorization only; production always uses fixed Google endpoints. */
export async function loginCalendar(options: {
  clientConfig: string;
  credentials: string;
  authorize: (loopbackUrl: string) => void | Promise<void>;
  signal?: AbortSignal;
  fetcher?: typeof fetch;
}): Promise<void> {
  let client: { clientId: string; clientSecret: string };
  let destination: string;
  let output: FileHandle;
  try {
    const config = readPrivateJson(options.clientConfig) as { installed?: { client_id?: unknown; client_secret?: unknown } } | null;
    // Ignore configurable endpoints and account metadata from the downloaded file.
    const clientId = config?.installed?.client_id;
    const clientSecret = config?.installed?.client_secret;
    if (typeof clientId !== "string" || typeof clientSecret !== "string" || !clientId || !clientSecret || clientId.length > 16_384 || clientSecret.length > 16_384 || /\s/.test(clientId + clientSecret)) throw new Error();
    client = { clientId, clientSecret };
    const absolute = resolve(options.credentials);
    const directory = privateDirectory(dirname(absolute));
    destination = join(directory, basename(absolute));
    output = await open(destination, "wx", 0o600);
  } catch {
    throw new CalendarCliError("Cannot prepare calendar login: use a protected installed-client file and a new credential path outside the repository");
  }
  let persisted = false;
  const server = createServer();
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  const state = randomBytes(32).toString("base64url");
  const verifier = randomBytes(32).toString("base64url");
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
    const origin = `http://127.0.0.1:${address.port}`;
    const redirectUri = `${origin}/callback`;
    const authorization = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    authorization.search = new URLSearchParams({
      client_id: client.clientId, redirect_uri: redirectUri, response_type: "code",
      scope: CALENDAR_SCOPES.join(" "), state, code_challenge: challenge, code_challenge_method: "S256",
      access_type: "offline", prompt: "consent", include_granted_scopes: "false",
    }).toString();
    let received = false;
    const codePromise = new Promise<string>((resolve, reject) => {
      abort = () => reject(new Error());
      signal.addEventListener("abort", abort, { once: true });
      server.once("error", reject);
      server.on("request", (request, response) => {
        response.setHeader("Cache-Control", "no-store");
        response.setHeader("Referrer-Policy", "no-referrer");
        response.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
        response.setHeader("Content-Type", "text/plain; charset=utf-8");
        const deny = () => { response.writeHead(400); response.end("Invalid authorization request."); };
        if (request.method !== "GET" || request.headers.host !== `127.0.0.1:${address.port}` || !request.url?.startsWith("/")) { deny(); return; }
        let url: URL;
        try { url = new URL(request.url, origin); } catch { deny(); return; }
        if (url.origin !== origin) { deny(); return; }
        if (url.pathname === "/authorize" && !received) {
          response.writeHead(302, { Location: authorization.href }); response.end(); return;
        }
        const incomingState = url.searchParams.get("state");
        if (url.pathname !== "/callback" || received || url.searchParams.getAll("state").length !== 1 || !incomingState || !/^[A-Za-z0-9_-]{43}$/.test(incomingState) || !timingSafeEqual(Buffer.from(incomingState), Buffer.from(state))) { deny(); return; }
        const code = url.searchParams.get("code");
        received = true;
        if (url.searchParams.has("error") || !code || code.length > 8192 || url.searchParams.getAll("code").length !== 1) {
          response.writeHead(400); response.end("Calendar authorization was not completed."); reject(new Error()); return;
        }
        response.end("Authorization received. Return to the terminal for storage status.");
        resolve(code);
      });
      if (signal.aborted) abort();
    });
    // Observe the callback promise even when the authorization UI itself fails.
    const [code] = await Promise.all([codePromise, Promise.resolve().then(() => options.authorize(`${origin}/authorize`))]);
    const response = await (options.fetcher ?? fetch)("https://oauth2.googleapis.com/token", {
      method: "POST", redirect: "error", signal,
      body: new URLSearchParams({
        client_id: client.clientId, client_secret: client.clientSecret, code, code_verifier: verifier,
        redirect_uri: redirectUri, grant_type: "authorization_code",
      }),
    });
    if (!response.ok) throw new Error();
    const token = await response.json() as { refresh_token?: unknown; scope?: unknown };
    if (typeof token.scope !== "string") throw new Error();
    const granted = new Set(token.scope.split(/\s+/).filter(Boolean));
    if (granted.size !== CALENDAR_SCOPES.length || !CALENDAR_SCOPES.every(scope => granted.has(scope))) throw new Error();
    const credential = parseCalendarCredentials({ ...client, refreshToken: token.refresh_token });
    await output.writeFile(`${JSON.stringify(credential)}\n`, "utf8");
    await output.sync();
    const directory = await open(dirname(destination), "r");
    try { await directory.sync(); } finally { await directory.close(); }
    persisted = true;
  } catch {
    throw new CalendarCliError("Calendar authorization failed or was cancelled; no credential was stored and provider details were not logged");
  } finally {
    if (abort) signal.removeEventListener("abort", abort);
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await output.close();
    if (!persisted) await unlink(destination);
  }
}

export async function runCalendarCli(args: readonly string[]): Promise<void> {
  const command = args[0];
  if (!command || command === "--help" || command === "-h" || command === "help") { process.stdout.write(USAGE); return; }
  if (command !== "login" && command !== "status") throw new CalendarCliError("Unknown calendar command. Use calendar --help");
  let values;
  try {
    ({ values } = parseArgs({ args: args.slice(1), options: {
      "client-config": { type: "string" }, credentials: { type: "string" }, help: { type: "boolean", short: "h" },
    } }));
  } catch { throw new CalendarCliError("Invalid calendar arguments. Use calendar --help; never pass tokens as arguments"); }
  if (values.help) { process.stdout.write(USAGE); return; }
  const credentials = values.credentials ?? DEFAULT_CREDENTIALS;
  if (command === "status") {
    if (values["client-config"]) throw new CalendarCliError("Status does not read OAuth client configuration");
    process.stdout.write(`${JSON.stringify(calendarCredentialStatus(credentials))}\n`);
    return;
  }
  if (!values["client-config"]) throw new CalendarCliError("Login requires --client-config PATH to a protected installed-client JSON file");
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new CalendarCliError("Calendar login requires an interactive terminal");
  const cancellation = new AbortController();
  const interrupt = () => cancellation.abort();
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  try {
    await loginCalendar({ clientConfig: values["client-config"], credentials, signal: cancellation.signal,
      authorize: url => { process.stdout.write(`Open this local URL to authorize read-only calendar access:\n${url}\n`); },
    });
    process.stdout.write("Calendar credentials stored privately. Nothing was uploaded or deployed.\n");
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCalendarCli(process.argv.slice(2)).catch(error => {
    process.stderr.write(`${error instanceof CalendarCliError ? error.message : "Calendar operation failed; private details were not logged"}\n`);
    process.exitCode = 1;
  });
}
