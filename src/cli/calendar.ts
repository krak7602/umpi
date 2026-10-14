import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { CALENDAR_SCOPES, parseCalendarCredentials } from "../worker/calendar.js";
import { GoogleOAuthCliError as CalendarCliError, googleCredentialStatus, loginGoogle } from "./google-oauth.js";

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

/** No network or refresh: only protected local credential presence and schema validity. */
export function calendarCredentialStatus(path: string): { configured: boolean } {
  return googleCredentialStatus(path, "calendar", parseCalendarCredentials);
}

/** Test seams replace transport/authorization only; production always uses fixed Google endpoints. */
export async function loginCalendar(options: {
  clientConfig: string;
  credentials: string;
  authorize: (loopbackUrl: string) => void | Promise<void>;
  signal?: AbortSignal;
  fetcher?: typeof fetch;
}): Promise<void> {
  return loginGoogle({ ...options, service: "calendar", scopes: CALENDAR_SCOPES, parseCredential: parseCalendarCredentials });
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
