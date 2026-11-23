// Documentation check. Run it with `npm run check:docs`. Add `-- --strict` to make warnings fail.
//
// The rules come from docs/TAXONOMY.md and AGENTS.md. The check reads README.md, AGENTS.md, and every
// Markdown file under docs/. It reports one line per problem as `path:line: level: message`.
//
// Errors:   a relative link or `#anchor` that does not resolve; a docs/ page that README.md does not reach;
//           missing or invalid front matter; `updated:` in the future or earlier than the newest History
//           entry; AGENTS.md at 200 lines or more.
// Warnings: `updated:` older than the last commit that changed the page (or older than today for a page
//           with uncommitted changes other than the date itself); a repository path in backticks that does
//           not exist.
//
// The script is TypeScript that Node 24 runs directly. It uses erasable syntax only and has no dependencies.
// The pure functions are exported for tests/check-docs.test.ts; the check runs only when this file is the
// program entry point.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type Level = "error" | "warning";
export type Problem = { path: string; line: number; level: Level; message: string };
export type Heading = { line: number; level: number; text: string; slug: string };
export type Link = { line: number; target: string };
/** An inline code span. `history` is true inside a `## History` section, where a path can name a removed file. */
export type CodeSpan = { line: number; text: string; history: boolean };
export type FrontMatter = { endLine: number; keys: Map<string, { value: string; line: number }> };
export type Page = {
  lineCount: number; frontMatter: FrontMatter | null; headings: Heading[]; links: Link[]; codeSpans: CodeSpan[];
  /** Dates at the start of the list items under `## History`. */
  historyDates: string[];
};

const ENTRY_POINT = "README.md";
const AGENTS_FILE = "AGENTS.md";
const AGENTS_LINE_LIMIT = 200;
const DOCS_DIR = "docs";
const REQUIRED_KEYS = ["title", "aliases", "updated"];
const DECISION_KEYS = [...REQUIRED_KEYS, "status"];

/**
 * The heading text as GitHub renders it: link and image syntax becomes its text, and `_emphasis_` loses its
 * underscores. Other Markdown punctuation (backticks, asterisks) is removed later with all punctuation.
 */
function renderedHeadingText(raw: string): string {
  return raw
    .replace(/!?\[((?:[^\]\\]|\\.)*)\]\((?:[^)]*)\)/g, "$1")
    .replace(/!?\[((?:[^\]\\]|\\.)*)\]\[[^\]]*\]/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/(?<![\p{L}\p{N}_])_+([^_]+?)_+(?![\p{L}\p{N}_])/gu, "$1")
    .trim();
}

/**
 * GitHub's heading anchor: lower case, remove everything except letters, marks, digits, connector punctuation,
 * hyphens, and spaces, then change each space to a hyphen. Runs of spaces or hyphens are not collapsed, so
 * "A & B" gives "a--b". This function does not add the `-1`, `-2` suffix for a repeated heading;
 * `scanMarkdown` does.
 */
export function headingAnchor(raw: string): string {
  return renderedHeadingText(raw).toLowerCase().replace(/[^\p{L}\p{M}\p{N}\p{Pc}\- ]/gu, "").replace(/ /g, "-");
}

/** Reads the leading `---` block as flat `key: value` lines. Returns null when the page has no closed block. */
export function parseFrontMatter(text: string): FrontMatter | null {
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trimEnd() !== "---") return null;
  const keys = new Map<string, { value: string; line: number }>();
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line.trimEnd() === "---") return { endLine: index + 1, keys };
    const match = /^([A-Za-z_][\w-]*):\s*(.*?)\s*$/.exec(line);
    if (match) keys.set(match[1]!, { value: match[2]!, line: index + 1 });
  }
  return null;
}

/** Scans one Markdown page. Fenced code blocks and the front matter are skipped; inline code holds no links. */
export function scanMarkdown(text: string): Page {
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  const frontMatter = parseFrontMatter(text);
  const page: Page = { lineCount: lines.length, frontMatter, headings: [], links: [], codeSpans: [], historyDates: [] };
  const seen = new Map<string, number>();
  let fence: { char: string; length: number } | null = null;
  let history = false;
  for (let index = frontMatter?.endLine ?? 0; index < lines.length; index += 1) {
    const raw = lines[index]!, line = index + 1;
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(raw);
    if (fence) {
      if (marker && marker[1]![0] === fence.char && marker[1]!.length >= fence.length && marker[2]!.trim() === "") fence = null;
      continue;
    }
    if (marker) { fence = { char: marker[1]![0]!, length: marker[1]!.length }; continue; }

    const heading = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/.exec(raw);
    if (heading) {
      const level = heading[1]!.length, headingText = heading[2]!, base = headingAnchor(headingText);
      const count = seen.get(base) ?? 0;
      seen.set(base, count + 1);
      page.headings.push({ line, level, text: headingText, slug: count === 0 ? base : `${base}-${count}` });
      if (level <= 2) history = level === 2 && headingText.trim().toLowerCase() === "history";
    } else if (history) {
      const entry = /^\s*[-*+]\s+(\d{4}-\d{2}-\d{2})\b/.exec(raw);
      if (entry) page.historyDates.push(entry[1]!);
    }

    // Blank each code span so that link syntax inside code is not read as a link.
    const prose = raw.replace(/(`+)(.+?)\1(?!`)/g, (span: string, _ticks: string, body: string) => {
      page.codeSpans.push({ line, text: body.trim(), history });
      return " ".repeat(span.length);
    });
    for (const match of prose.matchAll(/!?\[(?:[^\]\\]|\\.)*\]\(\s*(<[^>]*>|[^)\s]+)(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g)) {
      page.links.push({ line, target: match[1]!.replace(/^<|>$/g, "") });
    }
    const definition = /^ {0,3}\[[^\]]+\]:\s*(<[^>]*>|\S+)/.exec(prose);
    if (definition) page.links.push({ line, target: definition[1]!.replace(/^<|>$/g, "") });
  }
  return page;
}

export function extractHeadings(text: string): Heading[] { return scanMarkdown(text).headings; }
export function extractLinks(text: string): Link[] { return scanMarkdown(text).links; }

/** Splits a link target. `external` is true for a URL with a scheme (`https:`, `mailto:`) or a `//host` form. */
export function splitTarget(target: string): { external: boolean; path: string; anchor: string | null } {
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) || target.startsWith("//")) return { external: true, path: target, anchor: null };
  const hash = target.indexOf("#");
  const path = (hash < 0 ? target : target.slice(0, hash)).replace(/\?.*$/, "");
  return { external: false, path: safeDecode(path), anchor: hash < 0 ? null : safeDecode(target.slice(hash + 1)) };
}

function safeDecode(value: string): string {
  try { return decodeURIComponent(value); } catch { return value; }
}

/** Resolves a link path against the page that holds it. Returns null when the path leaves the repository. */
export function resolveLinkPath(fromPage: string, linkPath: string): string | null {
  const joined = linkPath.startsWith("/") ? posix.normalize(linkPath.slice(1)) : posix.normalize(posix.join(posix.dirname(fromPage), linkPath));
  if (joined === ".." || joined.startsWith("../")) return null;
  return joined === "." ? "" : joined.replace(/\/$/, "");
}

export function isValidDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.toISOString().slice(0, 10) === value;
}

/**
 * The `updated:` rule. `lastCommit` is the date of the last commit that changed the page. `uncommitted` is true
 * when the working tree differs from that commit; the page is then compared against `today`. ISO dates compare
 * correctly as strings.
 */
export function checkUpdated(input: { updated: string; historyDates: string[]; today: string; lastCommit?: string; uncommitted?: boolean }): Array<{ level: Level; message: string }> {
  const { updated, today } = input;
  if (!isValidDate(updated)) return [{ level: "error", message: `\`updated: ${updated}\` is not a valid YYYY-MM-DD date` }];
  const problems: Array<{ level: Level; message: string }> = [];
  if (updated > today) problems.push({ level: "error", message: `\`updated: ${updated}\` is in the future (today is ${today})` });
  const newest = input.historyDates.filter(isValidDate).sort().at(-1);
  if (newest && updated < newest) problems.push({ level: "error", message: `\`updated: ${updated}\` is earlier than the newest History entry (${newest})` });
  if (input.uncommitted) {
    if (updated < today) problems.push({ level: "warning", message: `the page has uncommitted changes but \`updated: ${updated}\` is not today (${today})` });
  } else if (input.lastCommit && updated < input.lastCommit) {
    problems.push({ level: "warning", message: `\`updated: ${updated}\` is older than the last commit that changed the page (${input.lastCommit})` });
  }
  return problems;
}

/** Checks the front matter keys. Decision records also need `status`. */
export function checkFrontMatter(path: string, frontMatter: FrontMatter | null): Array<{ line: number; message: string }> {
  if (!frontMatter) return [{ line: 1, message: "the page has no front matter block" }];
  const required = path.startsWith(`${DOCS_DIR}/decisions/`) ? DECISION_KEYS : REQUIRED_KEYS;
  const problems: Array<{ line: number; message: string }> = [];
  for (const key of required) {
    const entry = frontMatter.keys.get(key);
    if (!entry) problems.push({ line: 1, message: `front matter has no \`${key}:\`` });
    else if (entry.value === "" || entry.value === "[]") problems.push({ line: entry.line, message: `front matter \`${key}:\` is empty` });
  }
  return problems;
}

/**
 * Returns the repository path that a code span names, or null. A span counts only when it is one token, starts
 * with a real top-level directory, and has no wildcard or placeholder. A trailing `:line` reference is removed.
 */
export function repositoryPathIn(span: string, topLevelDirectories: ReadonlySet<string>): string | null {
  const candidate = span.replace(/:\d+(?:[:-]\d+)?$/, "");
  if (!/^[A-Za-z0-9_.@+-]+(?:\/[A-Za-z0-9_.@+-]+)+\/?$/.test(candidate)) return null;
  const segments = candidate.replace(/\/$/, "").split("/");
  if (!topLevelDirectories.has(segments[0]!)) return null;
  if (segments.some((segment) => /^\.+$/.test(segment) || /YYYY|XXX|NNN/.test(segment))) return null;
  return segments.join("/");
}

/** Every page that the entry point reaches through relative links to pages in `links`. */
export function reachablePages(entry: string, links: ReadonlyMap<string, readonly string[]>): Set<string> {
  const reached = new Set<string>([entry]), queue = [entry];
  for (let page = queue.shift(); page !== undefined; page = queue.shift()) {
    for (const target of links.get(page) ?? []) if (links.has(target) && !reached.has(target)) { reached.add(target); queue.push(target); }
  }
  return reached;
}

// ---- The check itself: file system and git ----

function git(root: string, args: string[], input?: string): string | null {
  try {
    return execFileSync("git", ["-c", "core.quotepath=off", ...args], { cwd: root, input, encoding: "utf8", stdio: ["pipe", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 });
  } catch { return null; }
}

function markdownFilesUnder(root: string, directory: string): string[] {
  if (!existsSync(join(root, directory))) return [];
  return readdirSync(join(root, directory), { recursive: true, encoding: "utf8" })
    .map((name) => `${directory}/${name.split(/[\\/]/).join("/")}`).filter((name) => name.endsWith(".md")).sort();
}

/** The last commit date of each path, from one `git log`. The first date seen for a path is its newest. */
function lastCommitDates(root: string, paths: string[]): Map<string, string> {
  const dates = new Map<string, string>();
  let current = "";
  for (const line of (git(root, ["log", "--format=@%cs", "--name-only", "--", ...paths]) ?? "").split("\n")) {
    if (line.startsWith("@")) current = line.slice(1);
    else if (line && !dates.has(line)) dates.set(line, current);
  }
  return dates;
}

/**
 * The paths in a `git diff -U0` whose only changed lines are `updated:` lines. A correction of the date alone
 * is not a change to the page's content, so such a page is still compared against its last commit.
 */
export function dateOnlyChanges(diff: string): Set<string> {
  const dateOnly = new Set<string>();
  let path = "", inHunk = false;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) { path = ""; inHunk = false; }
    else if (!inHunk && line.startsWith("+++ ")) { path = line.slice(4).replace(/^b\//, ""); dateOnly.add(path); }
    else if (line.startsWith("@@")) inHunk = true;
    else if (inHunk && /^[+-]/.test(line) && !/^[+-]updated:\s*\S*\s*$/.test(line)) dateOnly.delete(path);
  }
  dateOnly.delete("/dev/null");
  return dateOnly;
}

/** Paths whose content differs from the last commit in the working tree or the index, and untracked paths. */
function uncommittedPaths(root: string, paths: string[]): Set<string> {
  const entries = (git(root, ["status", "--porcelain=v1", "-z", "--", ...paths]) ?? "").split("\0");
  const changed = new Set<string>();
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    if (entry.length < 4) continue;
    changed.add(entry.slice(3));
    if (/[RC]/.test(entry.slice(0, 2))) index += 1; // The next entry is the old name of a rename.
  }
  if (changed.size > 0) for (const path of dateOnlyChanges(git(root, ["diff", "HEAD", "-U0", "--no-color", "--", ...changed]) ?? "")) changed.delete(path);
  return changed;
}

function localDate(now: Date): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

export type CheckResult = { problems: Problem[]; pages: number; links: number; notes: string[] };

export function checkDocs(root: string, options: { today?: string } = {}): CheckResult {
  const today = options.today ?? localDate(new Date());
  const problems: Problem[] = [], notes: string[] = [];
  const report = (path: string, line: number, level: Level, message: string): void => { problems.push({ path, line, level, message }); };

  const pagePaths = [ENTRY_POINT, AGENTS_FILE, ...markdownFilesUnder(root, DOCS_DIR)].filter((path) => existsSync(join(root, path)));
  const pages = new Map<string, Page>();
  for (const path of pagePaths) pages.set(path, scanMarkdown(readFileSync(join(root, path), "utf8")));

  // Files that git tracks or would add. An ignored file is not a valid link target: a public clone does not have it.
  const listed = git(root, ["ls-files", "-co", "--exclude-standard", "-z"]);
  const files = listed === null ? null : new Set(listed.split("\0").filter(Boolean));
  const directories = new Set<string>([""]);
  for (const file of files ?? []) for (let cut = file.lastIndexOf("/"); cut > 0; cut = file.lastIndexOf("/", cut - 1)) directories.add(file.slice(0, cut));
  if (!files) notes.push("git is not available here: link targets were checked on disk, and the commit-date and path checks were skipped");
  const known = (path: string): boolean => files ? files.has(path) || directories.has(path) : existsSync(join(root, path));

  // Links and anchors.
  const pageLinks = new Map<string, string[]>();
  let linkCount = 0;
  for (const [path, page] of pages) {
    const targets: string[] = [];
    pageLinks.set(path, targets);
    for (const link of page.links) {
      const target = splitTarget(link.target);
      if (target.external) continue;
      linkCount += 1;
      const resolved = target.path === "" ? path : resolveLinkPath(path, target.path);
      if (resolved === null) { report(path, link.line, "error", `link \`${link.target}\` leaves the repository`); continue; }
      if (!known(resolved)) {
        report(path, link.line, "error", existsSync(join(root, resolved)) ? `link target \`${resolved}\` exists here but git ignores it` : `link target \`${resolved}\` does not exist`);
        continue;
      }
      targets.push(resolved);
      if (target.anchor === null || target.anchor === "" || !resolved.endsWith(".md")) continue;
      const headings = (pages.get(resolved) ?? (existsSync(join(root, resolved)) ? scanMarkdown(readFileSync(join(root, resolved), "utf8")) : null))?.headings ?? [];
      if (headings.some((heading) => heading.slug === target.anchor)) continue;
      const lower = target.anchor.toLowerCase();
      report(path, link.line, "error", headings.some((heading) => heading.slug === lower)
        ? `anchor \`#${target.anchor}\` differs in case from the heading anchor \`#${lower}\` in \`${resolved}\``
        : `anchor \`#${target.anchor}\` matches no heading in \`${resolved}\``);
    }
  }

  // Reachability. The taxonomy states no exclusion, so every page under docs/ must be reached.
  if (pages.has(ENTRY_POINT)) {
    const reached = reachablePages(ENTRY_POINT, pageLinks);
    for (const path of pages.keys()) if (path.startsWith(`${DOCS_DIR}/`) && !reached.has(path)) report(path, 1, "error", `the page is not reachable from ${ENTRY_POINT} through relative links`);
  } else report(ENTRY_POINT, 1, "error", "the repository entry point does not exist");

  // Front matter and the `updated:` rule.
  const docPaths = [...pages.keys()].filter((path) => path.startsWith(`${DOCS_DIR}/`));
  const commitDates = files ? lastCommitDates(root, docPaths) : new Map<string, string>();
  const uncommitted = files ? uncommittedPaths(root, docPaths) : new Set<string>();
  for (const path of docPaths) {
    const page = pages.get(path)!;
    for (const problem of checkFrontMatter(path, page.frontMatter)) report(path, problem.line, "error", problem.message);
    const updated = page.frontMatter?.keys.get("updated");
    if (!updated || updated.value === "") continue;
    const value = updated.value.replace(/^(["'])(.*)\1$/, "$2");
    for (const problem of checkUpdated({ updated: value, historyDates: page.historyDates, today, lastCommit: commitDates.get(path), uncommitted: uncommitted.has(path) })) {
      report(path, updated.line, problem.level, problem.message);
    }
  }

  // AGENTS.md states its own limit.
  const agents = pages.get(AGENTS_FILE);
  if (agents && agents.lineCount >= AGENTS_LINE_LIMIT) report(AGENTS_FILE, AGENTS_LINE_LIMIT, "error", `the file has ${agents.lineCount} lines; it must stay below ${AGENTS_LINE_LIMIT}`);

  // Repository paths in backticks. A History entry can name a file that a later change removed, so it is skipped.
  if (files) {
    const topLevel = new Set([...directories].filter((directory) => directory !== "" && !directory.includes("/")));
    const missing: Array<{ path: string; line: number; named: string }> = [];
    for (const [path, page] of pages) for (const span of page.codeSpans) {
      if (span.history) continue;
      const named = repositoryPathIn(span.text, topLevel);
      if (named !== null && !known(named)) missing.push({ path, line: span.line, named });
    }
    // An ignored path (private configuration, build output) is expected to be absent from the tracked tree.
    const ignored = new Set(missing.length === 0 ? [] : (git(root, ["check-ignore", "--stdin", "-z"], [...new Set(missing.map((entry) => entry.named))].join("\0")) ?? "").split("\0"));
    for (const entry of missing) if (!ignored.has(entry.named)) report(entry.path, entry.line, "warning", `path \`${entry.named}\` does not exist`);
  }

  problems.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
  return { problems, pages: pages.size, links: linkCount, notes };
}

function main(argv: string[]): number {
  const unknown = argv.filter((argument) => argument !== "--strict");
  if (unknown.length > 0) { console.error(`check-docs: unknown argument ${unknown[0]}\nusage: node scripts/check-docs.ts [--strict]`); return 2; }
  const strict = argv.includes("--strict"), started = performance.now();
  const root = resolve(fileURLToPath(import.meta.url), "../..");
  const result = checkDocs(root);
  for (const problem of result.problems) console.log(`${problem.path}:${problem.line}: ${problem.level}: ${problem.message}`);
  for (const note of result.notes) console.log(`note: ${note}`);
  const errors = result.problems.filter((problem) => problem.level === "error").length, warnings = result.problems.length - errors;
  const elapsed = Math.round(performance.now() - started);
  console.log(`check-docs: ${result.pages} pages, ${result.links} relative links, ${errors} error${errors === 1 ? "" : "s"}, ${warnings} warning${warnings === 1 ? "" : "s"}${strict ? " (strict: warnings fail)" : ""}, ${elapsed} ms`);
  return errors > 0 || (strict && warnings > 0) ? 1 : 0;
}

function isEntryPoint(): boolean {
  try { return process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
}

if (isEntryPoint()) process.exitCode = main(process.argv.slice(2));
