import { Temporal } from "@js-temporal/polyfill";
import { scanMarkdown, type MarkdownHeading, type MarkdownLine } from "./markdown.ts";

export type PlanSection = "schedule" | "tasks" | "links" | "done" | "notes";
/** Sections the planner model may target. "done" and "notes" are owner sections that only code-owned journal writes use. */
export const PLANNER_SECTIONS = ["schedule", "tasks", "links"] as const;
/** IDs are opaque source identities, not wording or personal data. Text is one Markdown inline line. */
export interface PlanEntry { id: string; section: PlanSection; text: string; certainty?: "confirmed" | "target" | "tentative" }
/** Persist the entire returned array, including unchanged baselines for owner-edited/removed entries. */
export interface AppliedPlanEntry { id: string; section: PlanSection; line: string }
export interface DailyPlanPatch { entries: PlanEntry[]; coverage: string[] }
export interface DailyMergeResult {
  text: string;
  applied: AppliedPlanEntry[];
  skipped: { id: string; reason: "owner_edited" | "owner_removed" | "already_present" }[];
}

function parseDay(day: string): Temporal.PlainDate {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error("Planning day must be an ISO calendar date");
  return Temporal.PlainDate.from(day, { overflow: "reject" });
}

function validateTimezone(timezone: string): void {
  // Temporal also accepts fixed offsets, which are not an IANA timezone configuration.
  if (!timezone || /^[+\-\u2212]/.test(timezone)) throw new Error("Planning timezone must be an IANA timezone");
  new Intl.DateTimeFormat("en", { timeZone: timezone });
}

/** Resolve folds to the first occurrence and gaps to the transition, not the shifted wall time. */
function localInstant(local: Temporal.PlainDateTime, timezone: string): Temporal.ZonedDateTime {
  const earlier = local.toZonedDateTime(timezone, { disambiguation: "earlier" });
  if (earlier.toPlainDateTime().equals(local)) return earlier;
  const later = local.toZonedDateTime(timezone, { disambiguation: "later" });
  const transition = earlier.getTimeZoneTransition("next");
  if (!transition || transition.epochMilliseconds > later.epochMilliseconds) throw new Error("Cannot resolve planning wall time");
  return transition;
}

export function planningDay(now: number, timezone: string): string {
  validateTimezone(timezone);
  return Temporal.Instant.fromEpochMilliseconds(now).toZonedDateTimeISO(timezone).toPlainDate().toString();
}

export function shiftPlanningDay(day: string, delta: number): string {
  if (!Number.isSafeInteger(delta)) throw new Error("Planning day shift must be an integer");
  const shifted = parseDay(day).add({ days: delta }).toString();
  parseDay(shifted);
  return shifted;
}

export function nextPlanningTime(now: number, timezone: string, time: string): number {
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error("Planning time must be HH:mm");
  let day = parseDay(planningDay(now, timezone));
  const wallTime = Temporal.PlainTime.from(time);
  for (;;) {
    const next = localInstant(day.toPlainDateTime(wallTime), timezone).epochMilliseconds;
    if (next > now) return next;
    day = day.add({ days: 1 });
  }
}

export function planningDayBounds(day: string, timezone: string): { start: string; end: string } {
  validateTimezone(timezone);
  const date = parseDay(day);
  return {
    start: localInstant(date.toPlainDateTime(), timezone).toInstant().toString(),
    end: localInstant(date.add({ days: 1 }).toPlainDateTime(), timezone).toInstant().toString(),
  };
}

function renderTemplate(template: string, day: string): string {
  const date = parseDay(day);
  const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const weekdays = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
  const suffix = date.day % 100 >= 11 && date.day % 100 <= 13 ? "th" : ({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[date.day % 10] ?? "th";
  const values: Record<string, string> = {
    YYYY: day.slice(0, 4), YY: day.slice(2, 4), MMMM: months[date.month - 1]!, MMM: months[date.month - 1]!.slice(0, 3),
    MM: day.slice(5, 7), M: String(date.month), DD: day.slice(8, 10), D: String(date.day), Do: `${date.day}${suffix}`,
    dddd: weekdays[date.dayOfWeek - 1]!, ddd: weekdays[date.dayOfWeek - 1]!.slice(0, 3),
  };
  const rendered = template.replace(/\{\{([^{}]*)\}\}/g, (_token, expression: string) => {
    if (expression === "date") return day;
    if (!expression.startsWith("date:")) throw new Error("Unsupported daily template token");
    const format = expression.slice(5);
    if (!format) throw new Error("Unsupported daily template date format");
    return format.replace(/\[[^\]]*\]|YYYY|MMMM|dddd|MMM|ddd|YY|MM|Do|DD|M|D|[A-Za-z]+/g, token => {
      if (token.startsWith("[")) return token.slice(1, -1);
      if (!Object.hasOwn(values, token)) throw new Error("Unsupported daily template date format");
      return values[token]!;
    });
  });
  if (rendered.includes("{{") || rendered.includes("}}")) throw new Error("Malformed daily template token");
  return rendered;
}

const coverageId = "umpi-coverage";
const sectionLabels: Record<PlanSection, string> = { schedule: "Schedule", tasks: "Tasks", links: "Links", done: "Done / changed", notes: "Notes" };
const OWNER_SECTION = /^(?:notes|done(?:\s*\/\s*changed)?)$/i;
const OWNER_LABELS: Record<string, RegExp> = { "Done / changed": /^done(?:\s*\/\s*changed)?$/i, Notes: /^notes$/i };

function validateId(id: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id) || id.includes("--")) throw new Error("Invalid daily plan identity");
}

/** True when text can be written as one planner line. Journal writers drop lines that fail instead of failing the write. */
export function isPlanInline(text: string): boolean {
  try { validateInline(text); return true; } catch { return false; }
}

function validateInline(text: string): void {
  if (!text.trim() || text !== text.trim() || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(text)
    || /<!--|-->|umpi-plan:/i.test(text) || /^(?:#{1,6}(?:\s|$)|[-+*>](?:\s|$)|\d+[.)]\s|\[[ xX]\](?:\s|$)|`{3,}|~{3,})/.test(text)) {
    throw new Error("Daily plan text must be a readable Markdown inline line without markers or block prefixes");
  }
}

interface SectionBounds { heading: MarkdownHeading; end: number }

function sectionBounds(headings: MarkdownHeading[], heading: MarkdownHeading, length: number): SectionBounds {
  return { heading, end: headings.find(next => next.start > heading.start && next.level <= heading.level)?.start ?? length };
}

function findHeading(headings: MarkdownHeading[], label: string, length: number): SectionBounds | undefined {
  const owner = OWNER_LABELS[label];
  if (owner) {
    // An owner section is addressed directly; the first top-most match wins so a nested "Notes" under Done is not used.
    const matches = headings.filter(heading => owner.test(heading.label));
    const top = matches.length ? Math.min(...matches.map(heading => heading.level)) : 0;
    const first = matches.find(heading => heading.level === top);
    return first ? sectionBounds(headings, first, length) : undefined;
  }
  const protectedSections = headings.filter(heading => /^(?:notes|done(?:\s*\/\s*changed)?)$/i.test(heading.label))
    .map(heading => sectionBounds(headings, heading, length));
  const matches = headings.filter(heading => heading.label.toLowerCase() === label.toLowerCase()
    && !protectedSections.some(section => heading.start >= section.heading.start && heading.start < section.end));
  if (matches.length > 1) throw new Error("Daily planning heading is ambiguous");
  return matches[0] ? sectionBounds(headings, matches[0], length) : undefined;
}

/**
 * Per-line compare-and-swap, never section replacement. Previous baselines also act as
 * tombstones. Coverage alone has a transient lifecycle: reserved ID umpi-coverage,
 * section=tasks in storage, rendered directly under Plan as a non-checkbox warning.
 * Resolution removes only an unchanged warning; owner edits/removals remain protected.
 */
export function mergeDailyPlan(input: {
  day: string; current: string | null; template: string; previous: AppliedPlanEntry[]; patch: DailyPlanPatch;
}): DailyMergeResult {
  parseDay(input.day);
  let text = input.current ?? renderTemplate(input.template, input.day);
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  const parsed = scanMarkdown(text);
  const applied = new Map<string, AppliedPlanEntry>();
  for (const previous of input.previous) {
    validateId(previous.id);
    if (!Object.hasOwn(sectionLabels, previous.section) || /[\r\n]/.test(previous.line) || !previous.line.endsWith(`<!-- umpi-plan:${previous.id} -->`)) {
      throw new Error("Invalid previous daily plan baseline");
    }
    if (applied.has(previous.id)) throw new Error("Duplicate previous daily plan identity");
    applied.set(previous.id, { ...previous });
  }
  const proposals: PlanEntry[] = [];
  const proposedIds = new Set<string>();
  for (const entry of input.patch.entries) {
    validateId(entry.id);
    validateInline(entry.text);
    if (!Object.hasOwn(sectionLabels, entry.section) || (entry.certainty !== undefined && !["confirmed", "target", "tentative"].includes(entry.certainty))) {
      throw new Error("Invalid daily plan entry");
    }
    if (entry.id === coverageId || proposedIds.has(entry.id)) throw new Error("Duplicate or reserved daily plan identity");
    if (applied.has(entry.id) && applied.get(entry.id)!.section !== entry.section) throw new Error("Daily plan identity cannot change section");
    proposedIds.add(entry.id);
    proposals.push(entry);
  }
  for (const issue of input.patch.coverage) validateInline(issue);
  if (input.patch.coverage.length) proposals.push({ id: coverageId, section: "tasks", text: `Coverage: ${[...new Set(input.patch.coverage)].join("; ")}` });
  else if (applied.has(coverageId)) proposals.push({ id: coverageId, section: "tasks", text: "" });

  const skipped: DailyMergeResult["skipped"] = [];
  const edits: { start: number; end: number; replacement: string }[] = [];
  const additions = new Map<string, string[]>();
  const marked = new Map<string, MarkdownLine[]>();
  for (const line of parsed.lines) {
    if (!line.content) continue;
    for (const match of line.text.matchAll(/<!-- umpi-plan:([A-Za-z0-9._:-]+) -->/g)) {
      const lines = marked.get(match[1]!) ?? [];
      lines.push(line);
      marked.set(match[1]!, lines);
    }
  }
  const locations = new Map<string, SectionBounds | undefined>();
  for (const label of ["Plan", ...Object.values(sectionLabels)]) locations.set(label, findHeading(parsed.headings, label, text.length));
  const ownerSection = (section: PlanSection) => section === "done" || section === "notes";
  for (const entry of proposals) {
    const coverage = entry.id === coverageId;
    const label = coverage ? "Plan" : sectionLabels[entry.section];
    const section = locations.get(label);
    const marker = `<!-- umpi-plan:${entry.id} -->`;
    const certainty = entry.section === "schedule" && entry.certainty && entry.certainty !== "confirmed" ? `[${entry.certainty}] ` : "";
    const visible = `${certainty}${entry.text}`;
    const line = `${entry.section === "tasks" && !coverage ? "- [ ] " : "- "}${visible} ${marker}`;
    const previous = applied.get(entry.id);
    const existing = marked.get(entry.id) ?? [];
    if (previous) {
      if (!existing.length) { skipped.push({ id: entry.id, reason: "owner_removed" }); continue; }
      const owned = existing[0]!;
      const protectedHeading = !ownerSection(entry.section) && parsed.headings.some(heading => OWNER_SECTION.test(heading.label)
        && owned.start >= heading.start && owned.start < sectionBounds(parsed.headings, heading, text.length).end);
      if (existing.length !== 1 || owned.text !== previous.line || /^\s*[-+*]\s+\[[^ ]\]/.test(owned.text)
        || !section || owned.start < section.heading.bodyStart || owned.start >= section.end || protectedHeading) {
        skipped.push({ id: entry.id, reason: "owner_edited" }); continue;
      }
      if (coverage && !entry.text) {
        edits.push({ start: owned.start, end: owned.end, replacement: "" });
        applied.delete(entry.id);
      } else {
        edits.push({ start: owned.start, end: owned.end - owned.newline.length, replacement: line });
        applied.set(entry.id, { id: entry.id, section: entry.section, line });
      }
      continue;
    }
    if (existing.length) { skipped.push({ id: entry.id, reason: "already_present" }); continue; }
    const identical = section && parsed.lines.some(candidate => candidate.content && candidate.start >= section.heading.bodyStart && candidate.start < section.end
      && candidate.text.replace(/\s*<!-- umpi-plan:[A-Za-z0-9._:-]+ -->\s*$/, "").replace(/^\s*(?:[-+*]\s+)?(?:\[[ xX]\]\s+)?/, "").trim() === visible);
    if (identical) { skipped.push({ id: entry.id, reason: "already_present" }); continue; }
    const pending = additions.get(label) ?? [];
    if (pending.some(candidate => candidate.slice(0, candidate.lastIndexOf(" <!--")) === line.slice(0, line.lastIndexOf(" <!--")))) {
      skipped.push({ id: entry.id, reason: "already_present" }); continue;
    }
    pending.push(line);
    additions.set(label, pending);
    applied.set(entry.id, { id: entry.id, section: entry.section, line });
  }
  for (const edit of edits.sort((a, b) => b.start - a.start)) text = text.slice(0, edit.start) + edit.replacement + text.slice(edit.end);
  for (const [label, lines] of additions) {
    let headings = scanMarkdown(text).headings;
    let section = findHeading(headings, label, text.length);
    if (!section && OWNER_LABELS[label]) {
      // A missing owner section is appended at the end, at the level of the note's other top sections.
      const level = headings.find(heading => /^(?:plan|notes|done(?:\s*\/\s*changed)?|links)$/i.test(heading.label))?.level ?? (headings.some(heading => heading.level === 1) ? 2 : 1);
      const prefix = text && !text.endsWith(newline) ? newline + newline : text && !text.endsWith(newline + newline) ? newline : "";
      text = `${text}${prefix}${"#".repeat(level)} ${label}${newline}${newline}`;
      headings = scanMarkdown(text).headings;
      section = findHeading(headings, label, text.length)!;
    }
    if (!section) {
      let plan = findHeading(headings, "Plan", text.length);
      if (!plan) {
        const rootLevel = headings.find(heading => /^(?:notes|done(?:\s*\/\s*changed)?|links)$/i.test(heading.label))?.level
          ?? (headings.some(heading => heading.level === 1) ? 2 : 1);
        const before = headings.find(heading => heading.level === rootLevel && /^(?:notes|done(?:\s*\/\s*changed)?|links)$/i.test(heading.label))?.start ?? text.length;
        const headingText = `${"#".repeat(rootLevel)} Plan${newline}${newline}`;
        text = text.slice(0, before) + (before && !text.slice(0, before).endsWith(newline + newline) ? newline : "") + headingText + text.slice(before);
        headings = scanMarkdown(text).headings;
        plan = findHeading(headings, "Plan", text.length)!;
      }
      if (label === "Plan") section = plan;
      else {
        if (plan.heading.level >= 6) throw new Error("Daily Plan heading cannot contain a subsection");
        const before = plan.end;
        const prefix = before && !text.slice(0, before).endsWith(newline + newline) ? newline : "";
        text = text.slice(0, before) + prefix + `${"#".repeat(plan.heading.level + 1)} ${label}${newline}${newline}` + text.slice(before);
        headings = scanMarkdown(text).headings;
        section = findHeading(headings, label, text.length)!;
      }
    }
    // Append before descendants so entries never become part of an owner's Notes or Done section.
    const bodyEnd = headings.find(heading => heading.start >= section.heading.bodyStart && heading.start < section.end)?.start ?? section.end;
    if (OWNER_LABELS[label]) {
      // Owner sections read as one list: follow the owner's last line directly instead of after a blank line.
      const body = text.slice(section.heading.bodyStart, bodyEnd), trimmed = body.replace(/\s+$/, "");
      const position = section.heading.bodyStart + trimmed.length;
      // After the owner's last line, or a blank line after an empty section's heading.
      const lead = position ? newline : "";
      const rest = text.slice(position).replace(/^[ \t]*(?:\r?\n)?/, "");
      text = text.slice(0, position) + lead + lines.join(newline) + newline + (rest ? newline : "") + rest.replace(/^(?:[ \t]*\r?\n)+/, "");
      continue;
    }
    const position = label === "Plan" ? section.heading.bodyStart : bodyEnd;
    const prefix = position && !text.slice(0, position).endsWith(newline) ? newline : "";
    text = text.slice(0, position) + prefix + lines.join(newline) + newline + (position < text.length ? newline : "") + text.slice(position);
  }
  return { text, applied: [...applied.values()], skipped };
}
