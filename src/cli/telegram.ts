import { pathToFileURL } from "node:url";

// Only argument-free commands belong in the menu. Job actions remain contextual buttons.
const commands = [
  { command: "pair", description: "Connect the Umpi phone app" },
  { command: "status", description: "Show current activity" },
  { command: "memory", description: "Review memory changes and history" },
  { command: "schedule", description: "Manage proactive reviews and wake-ups" },
  { command: "plan", description: "Prepare today and control daily preparation" },
  { command: "mail", description: "Review read-only mail follow-through" },
  { command: "code", description: "Review coding tasks and execution controls" },
  { command: "browse", description: "Review browser tasks and approved site scope" },
];

export class TelegramMenuError extends Error {}

export async function syncTelegramMenu(env: NodeJS.ProcessEnv = process.env, fetcher: typeof fetch = fetch): Promise<void> {
  const token = env.TELEGRAM_BOT_TOKEN;
  const chat = env.TELEGRAM_CHAT_ID;
  if (!token || !chat || !/^\d+$/.test(chat) || !Number.isSafeInteger(Number(chat)) || Number(chat) <= 0 ||
      String(Number(chat)) !== chat || chat !== env.TELEGRAM_OWNER_ID) {
    throw new TelegramMenuError("Configure TELEGRAM_BOT_TOKEN and matching positive TELEGRAM_OWNER_ID/TELEGRAM_CHAT_ID for the owner's private chat");
  }
  async function request(method: string, body: unknown): Promise<unknown> {
    let response: Response;
    try {
      response = await fetcher(`https://api.telegram.org/bot${token}/${method}`, {
        method: "POST", redirect: "error", headers: { "content-type": "application/json" },
        body: JSON.stringify(body), signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new TelegramMenuError(`Telegram ${method} did not return a confirmed response; rerun menu sync to reconcile`);
    }
    if (!response.ok) throw new TelegramMenuError(`Telegram ${method} failed (HTTP ${response.status})`);
    let result: unknown;
    try { result = await response.json(); }
    catch { throw new TelegramMenuError(`Telegram ${method} returned an unreadable response`); }
    if (typeof result !== "object" || result === null || !("ok" in result) || result.ok !== true || !("result" in result)) {
      throw new TelegramMenuError(`Telegram ${method} did not confirm success`);
    }
    return result.result;
  }
  const scope = { type: "chat", chat_id: chat };
  const selection = { scope, language_code: "" };
  if (await request("setMyCommands", { ...selection, commands }) !== true) throw new TelegramMenuError("Telegram did not accept the command list");
  if (await request("setChatMenuButton", { chat_id: chat, menu_button: { type: "commands" } }) !== true) {
    throw new TelegramMenuError("Telegram did not accept the command menu button");
  }
  const saved = await request("getMyCommands", selection);
  const button = await request("getChatMenuButton", { chat_id: chat });
  if (!Array.isArray(saved) || saved.length !== commands.length || !commands.every((command, index) =>
    saved[index]?.command === command.command && saved[index]?.description === command.description) ||
    typeof button !== "object" || button === null || !("type" in button) || button.type !== "commands") {
    throw new TelegramMenuError("Telegram menu readback differs from the requested configuration; rerun menu sync to reconcile");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args.length === 1 && ["--help", "-h", "help"].includes(args[0]!)) {
    console.log("Usage: npm run telegram -- sync-menu\nReads private Telegram configuration from the environment. Updates and verifies only the owner's chat menu; sends no messages and does not change the webhook.");
  } else if (args.length !== 1 || args[0] !== "sync-menu") {
    console.error("Use telegram --help for supported arguments. Never pass credentials as arguments.");
    process.exitCode = 1;
  } else {
    syncTelegramMenu().then(() => {
      console.log("Telegram command menu verified for the configured owner chat.");
    }).catch(error => {
      console.error(error instanceof TelegramMenuError ? error.message : "Telegram menu sync failed; private response details were withheld");
      process.exitCode = 1;
    });
  }
}
