import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { privateDirectory } from "../mac/config.ts";

function main(): void {
  let values;
  try {
    ({ values } = parseArgs({ options: {
      "state-dir": { type: "string" },
      config: { type: "string" },
      port: { type: "string" },
      "inspector-port": { type: "string" },
      help: { type: "boolean" },
    } }));
  } catch { throw new Error("Invalid arguments. Use dev --help; credentials must never be passed as arguments"); }
  if (values.help) {
    console.log("Usage: npm run dev -- [--state-dir PATH] [--config PATH] [--port N] [--inspector-port N]\nLocal-only Worker, bound to 127.0.0.1. State defaults to ~/.config/umpi/worker and must be outside the repository in an owner-only directory.");
    return;
  }
  process.umask(0o077);
  const state = privateDirectory(values["state-dir"] ?? join(homedir(), ".config", "umpi", "worker"));
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const args = [join(root, "node_modules", "wrangler", "bin", "wrangler.js"), "dev", "--local", "--ip", "127.0.0.1",
    "--config", resolve(values.config ?? join(root, "wrangler.jsonc")), "--persist-to", state];
  if (values.port) args.push("--port", values.port);
  if (values["inspector-port"]) args.push("--inspector-port", values["inspector-port"]);
  const child = spawn(process.execPath, args, { cwd: root, stdio: "inherit", env: { ...process.env, WRANGLER_LOG_PATH: join(state, "wrangler.log") } });
  const interrupt = () => { child.kill("SIGINT"); };
  const terminate = () => { child.kill("SIGTERM"); };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  child.once("error", () => { console.error("Cannot start Wrangler; check the Node installation and run npm ci"); process.exitCode = 1; });
  child.once("exit", (code, signal) => {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", terminate);
    process.exitCode = code ?? (signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 1);
  });
}

try { main(); }
catch (error) { console.error(error instanceof Error ? error.message : "Cannot prepare private Worker storage"); process.exitCode = 1; }
