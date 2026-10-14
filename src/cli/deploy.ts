import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { syncTelegramMenu, TelegramMenuError } from "./telegram.ts";

async function main(): Promise<void> {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const args = process.argv.slice(2);
  const dryRunIndex = args.findLastIndex(arg => arg === "--dry-run" || arg.startsWith("--dry-run=") || arg === "--no-dry-run");
  const dryRun = dryRunIndex >= 0 && args[dryRunIndex] !== "--no-dry-run" && args[dryRunIndex] !== "--dry-run=false" &&
    !(args[dryRunIndex] === "--dry-run" && args[dryRunIndex + 1] === "false");
  const child = spawn(process.execPath, [join(root, "node_modules", "wrangler", "bin", "wrangler.js"),
    "deploy", "--config", "wrangler.local.jsonc", ...args], { cwd: root, stdio: "inherit" });
  const interrupt = () => { child.kill("SIGINT"); };
  const terminate = () => { child.kill("SIGTERM"); };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  let code: number;
  try {
    code = await new Promise<number>((resolve, reject) => {
      child.once("error", () => { reject(new Error("Cannot start Wrangler; check Node and run npm ci")); });
      child.once("exit", (status, signal) => { resolve(status ?? (signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 1)); });
    });
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", terminate);
  }
  if (code !== 0) { process.exitCode = code; return; }
  if (dryRun || args.includes("--help") || args.includes("-h")) return;
  try {
    await syncTelegramMenu();
    console.log("Telegram command menu verified for the configured owner chat.");
  } catch (error) {
    console.error("Worker deployment succeeded, but Telegram menu sync did not complete. Run npm run telegram -- sync-menu; another deployment is not required.");
    if (error instanceof TelegramMenuError) console.error(error.message);
    process.exitCode = 1;
  }
}

main().catch(() => {
  console.error("Deployment could not complete; private error details were withheld");
  process.exitCode = 1;
});
