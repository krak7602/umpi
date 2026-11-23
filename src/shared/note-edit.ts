/**
 * One owner-requested change to one existing line of a Markdown note: reword it, remove it, or tick or untick its
 * checkbox. The line is found by what it says, so a note edited meanwhile on another device is matched again, not
 * overwritten by position. Everything else in the note is kept byte for byte.
 */
export type NoteLineAction = "replace" | "remove" | "check" | "uncheck";
export interface NoteLineEdit { line: string; action: NoteLineAction; text?: string }
export type NoteLineResult =
  | { status: "edited"; text: string; before: string; after: string | null }
  /** The line already reads as asked: an edit made twice changes nothing. */
  | { status: "unchanged"; before: string }
  | { status: "not_found" }
  | { status: "ambiguous"; matches: string[] }
  | { status: "invalid"; issue: string };

export const MAX_NOTE_LINE_LENGTH = 240;
const MAX_MATCHES_SHOWN = 6;

interface Parsed { index: number; indent: string; bullet: string; box: string; content: string; trail: string }

/** Lower case, one space between words, without Markdown emphasis marks: how a line is compared with what was asked. */
function plain(text: string): string {
  return text.normalize("NFC").replace(/[*_`~]/g, "").replace(/\s+/g, " ").trim().toLocaleLowerCase("en");
}
/** A plan mark such as `[tentative]` is drawn as a tag, so a line is also known without it. */
function unmarked(text: string): string { return text.replace(/^\[(?:target|tentative|confirmed)\]\s*/i, ""); }

/** The body lines an edit may touch: not frontmatter, headings, blank lines, code fences and their contents, or comment-only lines. */
function editable(text: string): Parsed[] {
  const lines = text.split("\n"), found: Parsed[] = [];
  let start = 0;
  if (lines[0]?.trim() === "---") {
    const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
    if (end > 0) start = end + 1;
  }
  let fence: string | undefined;
  for (let index = start; index < lines.length; index++) {
    const raw = lines[index]!.replace(/\r$/, "");
    const marker = /^\s*(`{3,}|~{3,})/.exec(raw)?.[1];
    if (marker) { if (!fence) fence = marker[0]; else if (marker[0] === fence) fence = undefined; continue; }
    if (fence || !raw.trim() || /^\s*#{1,6}(?:\s|$)/.test(raw)) continue;
    const match = /^(\s*)((?:[-+*]|\d+[.)])\s+)?(\[[ xX]\]\s+)?(.*?)((?:\s*<!--.*?-->)*)\s*$/.exec(raw);
    if (!match || !match[4]!.trim()) continue;
    found.push({ index, indent: match[1]!, bullet: match[2] ?? "", box: match[3] ?? "", content: match[4]!, trail: match[5] ?? "" });
  }
  return found;
}

/** New text for a line: one readable line that cannot start a heading, list, or comment of its own. */
function cleaned(text: string): string | undefined {
  const value = text.normalize("NFC").replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").replace(/<!--|-->/g, "").replace(/\s+/g, " ").trim()
    .replace(/^(?:#{1,6}\s+|[-+*>]\s+|\d+[.)]\s+|\[[ xX]\]\s+)+/, "").trim();
  return value && value.length <= MAX_NOTE_LINE_LENGTH && !/umpi-plan:/i.test(value) ? value : undefined;
}

function find(lines: Parsed[], wanted: string): Parsed[] {
  const target = plain(wanted.replace(/<!--.*?-->/g, "").replace(/^\s*(?:[-+*]|\d+[.)])\s+/, "").replace(/^\[[ xX]\]\s+/, ""));
  if (!target) return [];
  const same = lines.filter(line => plain(line.content) === target || plain(unmarked(line.content)) === plain(unmarked(target)));
  if (same.length) return same;
  // Not the whole line: the one line that contains the words.
  return target.length >= 4 ? lines.filter(line => plain(line.content).includes(target)) : [];
}

export function editNoteLine(note: string, edit: NoteLineEdit): NoteLineResult {
  const lines = editable(note);
  let replacement: string | undefined;
  if (edit.action === "replace") {
    replacement = edit.text === undefined ? undefined : cleaned(edit.text);
    if (!replacement) return { status: "invalid", issue: `The new text must be one readable line of at most ${MAX_NOTE_LINE_LENGTH} characters` };
  } else if (edit.text !== undefined) return { status: "invalid", issue: "Only replace takes new text" };
  const matches = find(lines, edit.line);
  if (!matches.length) {
    // The same replace asked twice: the line already has the new text.
    const done = replacement ? find(lines, replacement) : [];
    return done.length === 1 ? { status: "unchanged", before: done[0]!.content } : { status: "not_found" };
  }
  if (matches.length > 1) return { status: "ambiguous", matches: matches.slice(0, MAX_MATCHES_SHOWN).map(line => `${line.box}${line.content}`) };
  const line = matches[0]!, all = note.split("\n");
  const carriage = all[line.index]!.endsWith("\r") ? "\r" : "";
  const before = `${line.box}${line.content}`;
  if (edit.action === "remove") {
    all.splice(line.index, 1);
    return { status: "edited", text: all.join("\n"), before, after: null };
  }
  let box = line.box, content = line.content;
  if (edit.action === "replace") content = replacement!;
  else {
    if (!line.box) return { status: "invalid", issue: "That line is not a task with a checkbox" };
    box = line.box.replace(/\[[ xX]\]/, edit.action === "check" ? "[x]" : "[ ]");
  }
  const after = `${box}${content}`;
  if (after === before) return { status: "unchanged", before };
  all[line.index] = `${line.indent}${line.bullet}${box}${content}${line.trail}${carriage}`;
  return { status: "edited", text: all.join("\n"), before, after };
}
