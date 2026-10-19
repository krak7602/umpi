import { spawn } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { GMAIL_SCOPES, parseGmailCredentials } from "../worker/gmail.js";
import { MAIL_ACCOUNT_PATTERN } from "../worker/mail-runtime.js";
import { GoogleOAuthCliError as MailCliError, googleCredentialStatus, loginGoogle } from "./google-oauth.js";

const DEFAULT_CREDENTIALS = join(homedir(), ".config", "umpi", "mail", "credentials.json");
const ACCOUNTS_DIRECTORY = join(homedir(), ".config", "umpi", "mail", "accounts");
const USAGE = `Usage:
  npm run mail -- login --client-config PATH [--account ID] [--credentials PATH]
  npm run mail -- status
  npm run mail -- upload-secret --config wrangler.local.jsonc

The explicit client file must be a Google Desktop app installed-client JSON.
It may belong to the same Google Cloud project as Calendar, but Gmail receives
its own grant and private credential file. Both files and their directories must
be owner-only and outside the repository.
The primary mailbox is stored at ~/.config/umpi/mail/credentials.json. Another
mailbox uses --account ID (lowercase letters, digits, hyphens) and is stored at
~/.config/umpi/mail/accounts/ID.json. In the browser, choose that account.
Login requests only read-only Gmail access. Open the printed loopback URL yourself.
Existing output is never replaced. No account details or tokens are printed.
upload-secret combines every stored mailbox into the UMPI_GMAIL_CREDENTIALS Worker
secret through wrangler's standard input. It changes production; run it only
when you intend to deploy that change.
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
function accountPath(account: string): string {
  if (account === "primary") return DEFAULT_CREDENTIALS;
  if (!MAIL_ACCOUNT_PATTERN.test(account)) throw new MailCliError("Account IDs use lowercase letters, digits, and hyphens, starting with a letter");
  return join(ACCOUNTS_DIRECTORY, `${account}.json`);
}
/** Stored mailboxes, validated through the same protected-file checks as status. Never returns token values to callers that print. */
function storedAccounts(): { id: string; path: string }[] {
  const result: { id: string; path: string }[] = [];
  if (mailCredentialStatus(DEFAULT_CREDENTIALS).configured) result.push({ id: "primary", path: DEFAULT_CREDENTIALS });
  let names: string[] = [];
  try { names = readdirSync(ACCOUNTS_DIRECTORY); } catch { /* no extra mailboxes */ }
  for (const name of names.sort()) {
    const id = name.replace(/\.json$/, "");
    if (!name.endsWith(".json") || id === "primary" || !MAIL_ACCOUNT_PATTERN.test(id)) continue;
    const path = join(ACCOUNTS_DIRECTORY, name);
    if (mailCredentialStatus(path).configured) result.push({ id, path });
  }
  return result;
}
async function uploadSecret(config: string): Promise<number> {
  const accounts = storedAccounts();
  if (!accounts.length) throw new MailCliError("No stored mailbox credentials; run mail login first");
  const body = JSON.stringify({ accounts: accounts.map(account => ({ id: account.id, ...parseGmailCredentials(JSON.parse(readFileSync(account.path, "utf8"))) })) });
  const child = spawn("npx", ["wrangler", "secret", "put", "UMPI_GMAIL_CREDENTIALS", "--config", config], { stdio: ["pipe", "ignore", "inherit"] });
  child.stdin.end(body);
  const code = await new Promise<number>(resolve => child.once("close", value => resolve(value ?? 1)));
  if (code !== 0) throw new MailCliError("wrangler did not confirm the secret upload; the existing secret may be unchanged");
  return accounts.length;
}

export async function runMailCli(args: readonly string[]): Promise<void> {
  const command = args[0];
  if (!command || command === "--help" || command === "-h" || command === "help") { process.stdout.write(USAGE); return; }
  if (!["login", "status", "upload-secret"].includes(command)) throw new MailCliError("Unknown mail command. Use mail --help");
  let values;
  try {
    ({ values } = parseArgs({ args: args.slice(1), options: {
      "client-config": { type: "string" }, credentials: { type: "string" }, account: { type: "string" }, config: { type: "string" }, help: { type: "boolean", short: "h" },
    } }));
  } catch { throw new MailCliError("Invalid mail arguments. Use mail --help; never pass tokens as arguments"); }
  if (values.help) { process.stdout.write(USAGE); return; }
  if (command === "status") {
    if (values["client-config"]) throw new MailCliError("Status does not read OAuth client configuration");
    const accounts = values.credentials ? [{ id: "custom", configured: mailCredentialStatus(values.credentials).configured }] : storedAccounts().map(account => ({ id: account.id, configured: true }));
    process.stdout.write(`${JSON.stringify({ accounts })}\n`);
    return;
  }
  if (command === "upload-secret") {
    if (!values.config) throw new MailCliError("upload-secret requires --config wrangler.local.jsonc for the private installation");
    const count = await uploadSecret(values.config);
    process.stdout.write(`Uploaded ${count} mailbox grant(s) as UMPI_GMAIL_CREDENTIALS. No token values were printed.\n`);
    return;
  }
  const credentials = values.credentials ?? accountPath(values.account ?? "primary");
  if (!values["client-config"]) throw new MailCliError("Login requires --client-config PATH to a protected installed-client JSON file");
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new MailCliError("Mail login requires an interactive terminal");
  const cancellation = new AbortController(), interrupt = () => cancellation.abort();
  process.once("SIGINT", interrupt); process.once("SIGTERM", interrupt);
  try {
    await loginMail({ clientConfig: values["client-config"], credentials, signal: cancellation.signal,
      authorize: url => { process.stdout.write(`Open this local URL to authorize read-only Gmail access${values.account ? ` for the ${values.account} mailbox (choose that Google account)` : ""}:\n${url}\n`); } });
    process.stdout.write("Mail credentials stored privately. Nothing was uploaded or deployed.\n");
  } finally {
    process.removeListener("SIGINT", interrupt); process.removeListener("SIGTERM", interrupt);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runMailCli(process.argv.slice(2)).catch(error => {
    process.stderr.write(`${error instanceof MailCliError ? error.message : "Mail operation failed; private details were not logged"}\n`);
    process.exitCode = 1;
  }).finally(() => {
    // The loopback login server can be held open by an idle browser socket.
    if (process.argv[2] === "login") process.exit();
  });
}
