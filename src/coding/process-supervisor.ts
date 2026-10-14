import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

export const LINUX_CODING_SUPERVISOR_PATH = "/usr/local/libexec/umpi-coding-supervisor";

export interface CodingProcessLaunch {
  executable: string;
  args: string[];
  ownership: "linux-descendants" | "mac-foreground-group";
}

// The live group leader is an anchor, not the user command: its group ID cannot
// be recycled before normal cleanup. Command fd 3 is closed, so user output does
// not enter the status protocol. The leader reports the actual command status,
// then signals its own still-owned group and dies with it. This is deliberately
// NOT descendant containment: macOS services that create a separate group escape.
const MAC_FOREGROUND_ANCHOR = `
timeout=$1
shift
owner=$$
exec 4<&0
(
  read -r ignored <&4
  printf 'UMPI_SUPERVISOR_V1 GROUP_ABORT 0 0\\n' >&3
  kill -KILL -- -"$owner"
) &
(
  exec 4<&-
  /bin/sleep "$timeout"
  printf 'UMPI_SUPERVISOR_V1 GROUP_TIMEOUT 0 0\\n' >&3
  kill -KILL -- -"$owner"
) &
"$@" 0</dev/null 3>&- 4<&- &
command=$!
wait "$command"
code=$?
printf 'UMPI_SUPERVISOR_V1 GROUP %d 0\\n' "$code" >&3
kill -KILL -- -"$owner"
exit 125
`;

/** No compiler, private SDK access, process-table guessing, or Mac sandbox claim. */
export function codingProcessLaunch(argv: readonly string[], cwd: string, deadlineAtMs: number): CodingProcessLaunch {
  if (process.platform === "darwin") {
    return { executable: "/bin/bash", args: ["-c", MAC_FOREGROUND_ANCHOR, "umpi-coding-foreground", String(Math.max(0, deadlineAtMs - Date.now()) / 1000), ...argv], ownership: "mac-foreground-group" };
  }
  if (process.platform !== "linux") throw new Error("Exact coding process supervision is unavailable on this platform");
  // Only trusted host configuration can select this public helper; command env
  // overrides are not consulted. The container pins the default root-owned path.
  const path = process.env.UMPI_CODING_SUPERVISOR ?? LINUX_CODING_SUPERVISOR_PATH;
  const workspace = realpathSync(cwd);
  if (!isAbsolute(path) || path !== resolve(path) || path === workspace || path.startsWith(`${workspace}/`)) throw new Error("Coding supervisor must be an absolute path outside the approved workspace");
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || realpathSync(path) !== path || (stat.mode & 0o022) !== 0 || (stat.mode & 0o111) === 0 || ![0, process.getuid?.()].includes(stat.uid)) throw new Error("Coding supervisor must be an owned, non-writable public executable");
  return { executable: path, args: ["--deadline-at-ms", String(Math.floor(deadlineAtMs)), "--", ...argv], ownership: "linux-descendants" };
}
