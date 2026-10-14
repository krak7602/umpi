import type { Choice, Job, Reminder, TelegramEntity } from "./store.js";

export interface TelegramStatus {
  jobs: readonly Job[];
  reminders: readonly Reminder[];
  executors: readonly object[];
  choices?: readonly Choice[];
  timezone: string;
}

export function formatTelegramApproval(job: Job): { text: string; entities: TelegramEntity[] } {
  const title = "Run on your Mac?";
  const commandOffset = title.length + 2;
  const folderPrefix = "\n\nFolder\n";
  const folderOffset = commandOffset + job.command.length + folderPrefix.length;
  const folderNameOffset = job.cwd === "/" ? 0 : job.cwd.lastIndexOf("/") + 1;
  const minutes = Math.floor(job.timeoutMs / 60_000);
  const seconds = (job.timeoutMs % 60_000) / 1_000;
  const duration = minutes ? `${minutes}m${seconds ? ` ${seconds}s` : ""}` : `${seconds}s`;
  return {
    text: `${title}\n\n${job.command}${folderPrefix}${job.cwd}\n${duration} limit · Not sandboxed.`,
    entities: [
      { type: "bold", offset: 0, length: title.length },
      { type: "pre", offset: commandOffset, length: job.command.length },
      { type: "blockquote", offset: folderOffset, length: job.cwd.length },
      { type: "bold", offset: folderOffset + folderNameOffset, length: job.cwd.length - folderNameOffset },
    ],
  };
}

function excerpt(text: string, limit: number): string {
  const clean = text.replace(/[\s\u0000-\u001f\u007f]+/g, " ").trim();
  if (clean.length <= limit) return clean;
  let end = limit - 1;
  if (/[\uD800-\uDBFF]/.test(clean[end - 1]!)) end--;
  return clean.slice(0, end) + "…";
}

function section(title: string, rows: string[], total: number, maxRows: number, rowLimit: number): string {
  const shown = rows.slice(0, maxRows).map(row => `• ${excerpt(row, rowLimit)}`);
  if (total > shown.length) shown.push(`• ${total - shown.length} more`);
  return `${title}\n${shown.length ? shown.join("\n") : "None."}`;
}

/** A single Telegram-sized summary; active work has its own space, independent of history. */
export function formatTelegramStatus(input: TelegramStatus, now = Date.now()): string {
  let timezone = input.timezone;
  let clock: Intl.DateTimeFormat;
  let fallback = false;
  const options: Intl.DateTimeFormatOptions = {
    year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
    hourCycle: "h23", timeZoneName: "short",
  };
  try { clock = new Intl.DateTimeFormat("en-GB", { ...options, timeZone: timezone }); }
  catch {
    timezone = "UTC"; fallback = true;
    clock = new Intl.DateTimeFormat("en-GB", { ...options, timeZone: timezone });
  }
  const date = (value: string): string => {
    const instant = Date.parse(value);
    return Number.isFinite(instant) ? clock.format(instant) : "time unavailable";
  };

  const groups = [
    { label: "Cancel requested (still running)", jobs: input.jobs.filter(job => job.status === "running" && job.cancelRequested) },
    { label: "Running", jobs: input.jobs.filter(job => job.status === "running" && !job.cancelRequested) },
    { label: "Queued for Mac", jobs: input.jobs.filter(job => job.status === "queued") },
    { label: "Needs approval", jobs: input.jobs.filter(job => job.status === "pending_approval") },
  ];
  const activeRows: string[] = [];
  for (const group of groups) {
    if (!group.jobs.length) continue;
    activeRows.push(`${group.label}: ${group.jobs.length}`);
    for (const job of group.jobs.slice(0, 2)) activeRows.push(`  ${excerpt(job.command, 100)}`);
  }
  const active = `Mac work\n${activeRows.length ? activeRows.join("\n") : "No active commands."}`;

  const pending = (input.choices ?? []).filter(choice => choice.status === "pending");
  const questions = section("Waiting for your answer", pending.slice(0, 2).map(choice =>
    `${excerpt(choice.question, 120)} — ${choice.options.map((option, index) => `${index + 1}. ${excerpt(option, 26)}`).join(" / ")}`),
  pending.length, 2, 290);

  const scheduled = input.reminders.filter(reminder => reminder.status === "scheduled")
    .sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt));
  const reminders = section("Scheduled reminders", scheduled.slice(0, 4).map(reminder =>
    `${date(reminder.dueAt)}${Date.parse(reminder.dueAt) <= now ? " (due)" : ""} — ${excerpt(reminder.text, 115)}`),
  scheduled.length, 4, 175);

  const recent = input.jobs.filter(job => !["pending_approval", "queued", "running"].includes(job.status))
    .sort((a, b) => Date.parse(b.completion?.finishedAt ?? b.createdAt) - Date.parse(a.completion?.finishedAt ?? a.createdAt));
  const completions = section("Recent command outcomes", recent.slice(0, 3).map(job => {
    const result = job.status === "uncertain" ? "Outcome unknown" : job.status;
    const exit = job.completion?.exitCode != null ? `, exit ${job.completion.exitCode}` : "";
    const finished = job.completion ? ` — ${date(job.completion.finishedAt)}` : "";
    return `${result}${exit}: ${excerpt(job.command, 85)}${finished}`;
  }), recent.length, 3, 155);

  // The persisted Store API deliberately returns object[]; do not assume an executor shape.
  let lastSeen = -Infinity;
  let seenCount = 0;
  for (const value of input.executors) {
    if (!value || typeof value !== "object" || Array.isArray(value) ||
        !("executorId" in value) || typeof value.executorId !== "string" || !value.executorId ||
        !("lastSeenAt" in value) || typeof value.lastSeenAt !== "string") continue;
    const instant = Date.parse(value.lastSeenAt);
    if (!Number.isFinite(instant)) continue;
    seenCount++;
    lastSeen = Math.max(lastSeen, instant);
  }
  let mac = "Mac last seen: no recorded check-in. This does not establish whether the Mac is online.";
  if (seenCount) {
    const minutes = Math.floor((now - lastSeen) / 60_000);
    const age = minutes < 0 ? "recorded clock is ahead" : minutes < 1 ? "less than a minute ago" :
      minutes < 60 ? `${minutes} min ago` : minutes < 1_440 ? `${Math.floor(minutes / 60)} h ago` : `${Math.floor(minutes / 1_440)} d ago`;
    mac = `Mac last seen: ${date(new Date(lastSeen).toISOString())} (${age}). ${seenCount} executor${seenCount === 1 ? "" : "s"} recorded; not a guarantee of being online.`;
  }

  // Section limits keep the complete summary below 4,000 UTF-16 units, without hiding later sections.
  return [`Status · ${excerpt(timezone, 80)}${fallback ? " (configured timezone invalid)" : ""}`, active, questions, reminders, completions, mac].join("\n\n");
}
