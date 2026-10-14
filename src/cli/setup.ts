import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, open, realpath, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { assertOutsideRepository } from "../mac/config.ts";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../model/provider.ts";
import { coordinatorUrl } from "../shared/coordinator-url.ts";

const help = `Usage: npm run setup -- local [options]

  --vars-file PATH      Local Worker secrets (default: .dev.vars)
  --config PATH         Mac configuration (default: ~/.config/umpi/mac/config.json)
  --workspace PATH      Approved working-directory root; repeat for more roots
  --server-url URL      Coordinator origin (default: http://127.0.0.1:8787)
  --provider PROVIDER   openai or openai-codex
  --timezone ZONE       IANA timezone (default: this computer's timezone)

Creates new owner-only files. Refuses to replace existing configuration.
Does not log in, start an executor, register a bot, or deploy anything.
`;

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command === "--help" || command === "-h") { console.log(help); return; }
  if (command !== "local") throw new Error(help);
  const { values } = parseArgs({
    args: process.argv.slice(3),
    options: {
      "vars-file": { type: "string" },
      config: { type: "string" },
      workspace: { type: "string", multiple: true },
      "server-url": { type: "string" },
      provider: { type: "string" },
      timezone: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) { console.log(help); return; }
  const envPath = resolve(values["vars-file"] ?? ".dev.vars");
  const configPath = resolve(values.config ?? join(homedir(), ".config", "umpi", "mac", "config.json"));
  if (envPath === configPath) throw new Error("Worker and Mac configuration must use different files");
  assertOutsideRepository(configPath);
  if (envPath !== fileURLToPath(new URL("../../.dev.vars", import.meta.url))) assertOutsideRepository(envPath);
  const serverUrl = coordinatorUrl(values["server-url"] ?? "http://127.0.0.1:8787").origin;
  const provider = values.provider ?? DEFAULT_PROVIDER;
  if (provider !== "openai" && provider !== "openai-codex") throw new Error("Unsupported subscription provider");
  const timezone = values.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  new Intl.DateTimeFormat("en", { timeZone: timezone }).format(new Date());
  const workspaces = [...new Set(await Promise.all((values.workspace ?? [process.cwd()]).map(path => realpath(resolve(path)))))];
  if (workspaces.length === 0 || workspaces.length > 32) throw new Error("Select between one and 32 workspaces");
  for (const path of workspaces) if (!(await stat(path)).isDirectory()) throw new Error("A workspace must be an existing directory");

  const controlToken = randomBytes(32).toString("hex");
  const executorToken = randomBytes(32).toString("hex");
  const webhookSecret = randomBytes(32).toString("hex");
  const env = Object.entries({
    UMPI_CONTROL_TOKEN: controlToken,
    UMPI_EXECUTOR_TOKEN: executorToken,
    UMPI_TIMEZONE: timezone,
    UMPI_MODEL_PROVIDER: provider,
    UMPI_MODEL_ID: DEFAULT_MODEL,
    TELEGRAM_WEBHOOK_SECRET: webhookSecret,
    TELEGRAM_BOT_TOKEN: "",
    TELEGRAM_OWNER_ID: "",
    TELEGRAM_CHAT_ID: "",
  }).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join("\n") + "\n";
  const config = JSON.stringify({ serverUrl, executorToken, executorId: `mac-${randomUUID()}`, workspaces }, null, 2) + "\n";
  const created: string[] = [];
  try {
    for (const [path, contents] of [[envPath, env], [configPath, config]] as const) {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const handle = await open(path, "wx", 0o600);
      created.push(path);
      try { await handle.writeFile(contents, "utf8"); await handle.sync(); }
      finally { await handle.close(); }
    }
  } catch (error) {
    for (const path of created) await unlink(path);
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("Configuration already exists; nothing was replaced");
    throw error;
  }
  console.log(`Worker configuration: ${envPath}`);
  console.log(`Mac configuration: ${configPath}`);
  console.log("Secrets were written to owner-only files, not printed. No service was started or deployed.");
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : "Local setup failed");
  process.exitCode = 1;
});
