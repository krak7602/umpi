import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { pathToFileURL } from "node:url";
import type { AuthInteraction, AuthPrompt } from "@earendil-works/pi-ai";
import { InputError } from "../shared/protocol.js";
import { ASSISTANT_PROVIDERS, assertAssistantProvider, AuthInputError } from "./credentials.js";
import { FileCredentialStore, AuthStorageError } from "./file-store.js";
import { createAssistantModels, DEFAULT_MODEL, DEFAULT_PROVIDER } from "./provider.js";
import { syncCredential } from "./sync.js";

const USAGE = `Usage:
  npm run auth -- login [anthropic|openai|openai-codex]
  npm run auth -- status
  npm run auth -- sync <https-origin-or-loopback> [anthropic|openai|openai-codex]

State is private to Umpi under ~/.config/umpi/auth and is not imported from another application.
Login stores credentials locally only. Sync explicitly transfers the selected
credential to /api/auth using UMPI_CONTROL_TOKEN from the environment.
Anthropic is Claude Pro/Max sign-in; OpenAI is Sign in with ChatGPT;
openai-codex is the legacy subscription route used for voice transcription.
None uses a paid API key. No token arguments are accepted.
`;

function terminalInteraction(signal: AbortSignal) {
  let hidden = false;
  const output = new Writable({
    write(chunk, _encoding, callback) {
      if (!hidden) process.stdout.write(chunk);
      callback();
    },
  });
  const readline = createInterface({ input: process.stdin, output, terminal: true });
  const cancellation = new AbortController();
  readline.on("SIGINT", () => cancellation.abort());
  readline.on("close", () => cancellation.abort());
  const combined = AbortSignal.any([signal, cancellation.signal]);

  const interaction: AuthInteraction = {
    signal: combined,
    async prompt(prompt: AuthPrompt) {
      const promptSignal = prompt.signal ? AbortSignal.any([combined, prompt.signal]) : combined;
      promptSignal.throwIfAborted();
      process.stdout.write(`${prompt.message}\n`);
      if (prompt.type === "select") {
        prompt.options.forEach((option, index) => process.stdout.write(`  ${index + 1}. ${option.label}\n`));
      }
      hidden = prompt.type === "secret" || prompt.type === "manual_code";
      process.stdout.write(hidden ? "> (input hidden) " : "> ");
      let answer: string;
      try {
        answer = (await readline.question("", { signal: promptSignal })).trim();
      } finally {
        if (hidden) process.stdout.write("\n");
        hidden = false;
      }
      if (prompt.type === "select") {
        const selected = prompt.options.find(option => option.id === answer)
          ?? prompt.options[answer === "" ? 0 : Number(answer) - 1];
        if (!selected) throw new AuthInputError("Invalid login method selection");
        return selected.id;
      }
      return answer;
    },
    notify(event) {
      switch (event.type) {
        case "auth_url":
          process.stdout.write(`Open this URL in your browser:\n${event.url}\n`);
          if (event.instructions) process.stdout.write(`${event.instructions}\n`);
          break;
        case "device_code":
          process.stdout.write(`Open ${event.verificationUri}\nEnter device code: ${event.userCode}\n`);
          break;
        case "info":
          process.stdout.write(`${event.message}\n`);
          for (const link of event.links ?? []) process.stdout.write(`${link.label ?? "More information"}: ${link.url}\n`);
          break;
        case "progress":
          process.stdout.write(`${event.message}\n`);
          break;
      }
    },
  };
  return { interaction, close: () => { readline.close(); output.end(); } };
}

export async function runAuthCli(args: readonly string[]): Promise<void> {
  const [command, first, second, ...extra] = args;
  if (command === "--help" || command === "help" || command === undefined) {
    process.stdout.write(USAGE);
    return;
  }
  if (extra.length || (command === "status" && first !== undefined) || (command === "login" && second !== undefined)) {
    throw new AuthInputError("Unexpected arguments. Use auth --help; tokens must never be passed as arguments");
  }
  if (!["login", "status", "sync"].includes(command)) throw new AuthInputError("Unknown auth command. Use auth --help");
  const store = new FileCredentialStore();
  if (command === "status") {
    const credentials = [];
    for (const providerId of ASSISTANT_PROVIDERS) {
      const credential = await store.read(providerId);
      credentials.push({
        providerId,
        present: credential !== undefined,
        type: credential?.type,
        expired: credential?.type === "oauth" ? credential.expires <= Date.now() : undefined,
      });
    }
    process.stdout.write(`${JSON.stringify({ defaultProvider: DEFAULT_PROVIDER, defaultModel: DEFAULT_MODEL, credentials }, null, 2)}\n`);
    return;
  }
  const providerId = (command === "sync" ? second : first) ?? DEFAULT_PROVIDER;
  assertAssistantProvider(providerId);
  if (command === "sync") {
    if (!first) throw new AuthInputError("Auth sync requires the coordinator origin");
    await syncCredential(store, { providerId, coordinatorOrigin: first, controlToken: process.env.UMPI_CONTROL_TOKEN });
    process.stdout.write(`Synced ${providerId} to the coordinator. No credential contents were displayed.\n`);
    return;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new AuthInputError("OAuth login requires an interactive terminal");
  // Do not allow an ambient setting to expose the provider callback on a public interface.
  if (process.env.PI_OAUTH_CALLBACK_HOST && !["127.0.0.1", "localhost", "::1"].includes(process.env.PI_OAUTH_CALLBACK_HOST)) {
    throw new AuthInputError("PI_OAUTH_CALLBACK_HOST must be loopback for interactive login");
  }
  const deviceId = await store.deviceId();
  const cancellation = new AbortController();
  const interrupt = () => cancellation.abort();
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  const terminal = terminalInteraction(AbortSignal.any([cancellation.signal, AbortSignal.timeout(15 * 60_000)]));
  try {
    const models = createAssistantModels(store);
    await models.login(providerId, "oauth", terminal.interaction, { getDeviceId: () => deviceId, agentName: "umpi" });
    process.stdout.write(`Stored ${providerId} credentials privately on this Mac. Nothing was uploaded to the coordinator.\n`);
  } finally {
    terminal.close();
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runAuthCli(process.argv.slice(2)).catch(error => {
    // SDK/provider exceptions can include raw token-response bodies. Never print them.
    const message = error instanceof AuthInputError || error instanceof AuthStorageError || error instanceof InputError
      ? error.message
      : "Authentication operation failed or was cancelled. Retry login if needed; for OpenAI browser login, local port 1455 must be free. Provider details were not logged";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }).finally(() => {
    // A browser can keep an idle socket open to Pi's closed loopback callback server, which keeps
    // Node alive. Login requires a TTY, so its output is already written and the credential synced.
    if (process.argv[2] === "login") process.exit();
  });
}
