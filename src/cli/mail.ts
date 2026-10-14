import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { GMAIL_SCOPES, parseGmailCredentials } from "../worker/gmail.js";
import { GoogleOAuthCliError as MailCliError, googleCredentialStatus, loginGoogle } from "./google-oauth.js";

const DEFAULT_CREDENTIALS = join(homedir(), ".config", "umpi", "mail", "credentials.json");
const USAGE = `Usage:
  npm run mail -- login --client-config PATH [--credentials PATH]
  npm run mail -- status [--credentials PATH]

The explicit client file must be a Google Desktop app installed-client JSON.
It may belong to the same Google Cloud project as Calendar, but Gmail receives
its own grant and private credential file. Both files and their directories must
be owner-only and outside the repository. Credentials default to
~/.config/umpi/mail/credentials.json (mode 0600).
Login requests only read-only Gmail access. Open the printed loopback URL yourself.
Existing output is never replaced. No account details or tokens are printed or uploaded.
`;

export function mailCredentialStatus(path: string): { configured: boolean } {
  return googleCredentialStatus(path, "mail", parseGmailCredentials);
}
export async function loginMail(options: {
  clientConfig: string;
  credentials: string;
  authorize: (loopbackUrl: string) => void | Promise<void>;
  signal?: AbortSignal;
  fetcher?: typeof fetch;
}): Promise<void> {
  return loginGoogle({ ...options, service: "mail", scopes: GMAIL_SCOPES, parseCredential: parseGmailCredentials });
}

export async function runMailCli(args: readonly string[]): Promise<void> {
  const command = args[0];
  if (!command || command === "--help" || command === "-h" || command === "help") { process.stdout.write(USAGE); return; }
  if (command !== "login" && command !== "status") throw new MailCliError("Unknown mail command. Use mail --help");
  let values;
  try {
    ({ values } = parseArgs({ args: args.slice(1), options: {
      "client-config": { type: "string" }, credentials: { type: "string" }, help: { type: "boolean", short: "h" },
    } }));
  } catch { throw new MailCliError("Invalid mail arguments. Use mail --help; never pass tokens as arguments"); }
  if (values.help) { process.stdout.write(USAGE); return; }
  const credentials = values.credentials ?? DEFAULT_CREDENTIALS;
  if (command === "status") {
    if (values["client-config"]) throw new MailCliError("Status does not read OAuth client configuration");
    process.stdout.write(`${JSON.stringify(mailCredentialStatus(credentials))}\n`);
    return;
  }
  if (!values["client-config"]) throw new MailCliError("Login requires --client-config PATH to a protected installed-client JSON file");
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new MailCliError("Mail login requires an interactive terminal");
  const cancellation = new AbortController(), interrupt = () => cancellation.abort();
  process.once("SIGINT", interrupt); process.once("SIGTERM", interrupt);
  try {
    await loginMail({ clientConfig: values["client-config"], credentials, signal: cancellation.signal,
      authorize: url => { process.stdout.write(`Open this local URL to authorize read-only Gmail access:\n${url}\n`); } });
    process.stdout.write("Mail credentials stored privately. Nothing was uploaded or deployed.\n");
  } finally {
    process.removeListener("SIGINT", interrupt); process.removeListener("SIGTERM", interrupt);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runMailCli(process.argv.slice(2)).catch(error => {
    process.stderr.write(`${error instanceof MailCliError ? error.message : "Mail operation failed; private details were not logged"}\n`);
    process.exitCode = 1;
  });
}
