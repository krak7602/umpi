// Publishable-tree check. Run it with `npm run check:publishable`.
//
// AGENTS.md treats the source tree as publishable. This check looks for content that must not be published:
// secret shapes, private identifiers, real-looking deployment origins, and the owner's private deny-list.
//
//   node scripts/check-publishable.ts            the files that `git commit` would commit, read from the index
//   node scripts/check-publishable.ts --all      every tracked file and every untracked file that git does not ignore
//   node scripts/check-publishable.ts --preview  also print a masked form of each generic hit (first 4 characters)
//
// Output is one line per hit as `path:line: category: message`. The matched text is never printed in full, and a
// deny-list hit never prints any of it. Exit code 1 means that there is at least one hit.
//
// Private deny-list: `.publishable-deny.local` in the repository root, ignored by git. One regular expression
// per line, matched without regard to case. Blank lines and lines that start with `#` are skipped. Put names,
// handles, and private domains there. A deny-list hit cannot be allowed with a marker; change the pattern instead.
//
// Allow marker: a generic hit is accepted when its line contains `publishable-ok`, or when the line before it
// contains `publishable-ok-next-line`. Use the marker only for an intended, invented example.
//
// File safety: the check opens only paths that git lists and does not ignore. It never opens a path that
// `isPrivatePath` names (private Wrangler, `.dev.vars`, signing, and key files), never follows a symbolic link,
// and never reads below `.git/` or `.wrangler/`. A private or ignored path in the commit set is reported by name.
//
// The script is TypeScript that Node 24 runs directly. It uses erasable syntax only and has no dependencies.

import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type Finding = { line: number; category: string; message: string; value: string };
export type DenyPattern = { line: number; pattern: RegExp };

export const DENY_FILE = ".publishable-deny.local";
const MAX_FILE_BYTES = 4 * 1024 * 1024;

/** Third-party data files that hold other people's public contact data. Only the deny-list applies to them. */
const THIRD_PARTY_DATA = new Set([
  "src/browser/aside-export-system/public_suffix_list.dat",
  "src/browser/aside-export-system/public-suffixes.h",
  "package-lock.json",
  "ios/Umpi/Resources/Highlight/highlight.min.js",
]);

/**
 * True for a path that can hold private configuration or key material. Such a path is never opened. The
 * `.example` forms are publishable templates, so they are not private.
 */
export function isPrivatePath(path: string): boolean {
  const segments = path.split("/"), name = segments.at(-1) ?? "";
  if (segments.some((segment) => segment === ".git" || segment === ".wrangler" || segment === "..")) return true;
  if (name === DENY_FILE) return true;
  if (/^\.(?:dev\.vars|env)(?:\..*)?$/.test(name)) return !/^\.(?:dev\.vars|env)\.example$/.test(name);
  if (/^wrangler\.(?:local|private)\./.test(name)) return true;
  if (/\.(?:local|private)\.xcconfig(?:\..*)?$/.test(name)) return true;
  return /\.(?:p8|p12|pfx|pem|key|cer|der|mobileprovision|provisionprofile)$/i.test(name);
}

/**
 * True for a value that is clearly made up: few different characters, a short repeated unit, a counting run,
 * or a word such as "example". Such a value is not reported, so invented test data needs no marker.
 */
export function looksInvented(value: string): boolean {
  const lower = value.toLowerCase();
  if (new Set(lower).size <= 4) return true;
  if (/(?:example|placeholder|invented|synthetic|fixture|dummy|fake|sample|redacted|xxxx|test)/.test(lower)) return true;
  if (/(?:0123456|1234567|7654321|abcdefg|deadbeef|a1b2c3)/.test(lower)) return true;
  // A readable phrase such as "not-a-real-token-with-32-characters": words and short numbers only.
  const parts = lower.split(/[-_.]/);
  if (parts.length >= 3 && parts.every((part) => /^(?:[a-z]+|\d{1,4})$/.test(part))) return true;
  for (let period = 1; period <= 16 && period * 2 <= lower.length; period += 1) {
    if (lower === lower.slice(0, period).repeat(Math.ceil(lower.length / period)).slice(0, lower.length)) return true;
  }
  return false;
}

/** True for a value that has the mix of characters of a generated credential. */
export function looksRandom(value: string): boolean {
  return /\d/.test(value) && /[A-Za-z]/.test(value) && new Set(value).size >= 12 && !looksInvented(value);
}

/** True for a documented example host: reserved names, loopback, or a placeholder label. */
export function isExampleHost(host: string): boolean {
  const lower = host.toLowerCase().replace(/\.$/, "");
  if (/(?:^|\.)(?:example|test|invalid|localhost|local|internal)$/.test(lower)) return true;
  if (/(?:^|\.)example\.(?:com|org|net)$/.test(lower)) return true;
  return lower.split(".").some((label) => /^(?:example|placeholder|subdomain|account|tailnet|name|your-.*|my-.*|.*-example|example-.*)$/.test(label));
}

type Rule = {
  category: string; message: string; pattern: RegExp;
  /** The capture group that holds the value. Default: the whole match. */
  group?: number;
  /** When set, text near the match must contain this. */
  near?: RegExp;
  /** `before` is the text before the match on its line. `previous` is the two lines above. */
  accept?: (value: string, before: string, previous: string) => boolean;
};

// The provider shapes come from the code: Anthropic keys and OAuth tokens (src/model), ChatGPT and Google OAuth
// tokens (src/model, src/cli/google-oauth.ts), Telegram, and APNs (src/worker/companion-push.ts). The Parallel and
// Cloudflare tokens have no fixed shape in the code; the bearer and assigned-secret rules cover a pasted literal.
const RULES: Rule[] = [
  { category: "anthropic-credential", message: "Anthropic API key or OAuth token shape", pattern: /\bsk-ant-[a-z]+\d*-[A-Za-z0-9_-]{20,}/g, accept: (value) => !looksInvented(value.replace(/^sk-ant-[a-z]+\d*-/, "")) },
  { category: "openai-credential", message: "OpenAI API key shape", pattern: /\bsk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{20,}|\bsk-[A-Za-z0-9]{40,}\b/g, accept: (value) => !looksInvented(value.replace(/^sk-(?:[a-z]+-)?/, "")) },
  { category: "jwt", message: "JSON Web Token shape (OAuth access or identity token)", pattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, accept: (value) => !looksInvented(value) },
  { category: "google-credential", message: "Google OAuth token, client secret, or client ID shape", pattern: /\bya29\.[A-Za-z0-9_-]{20,}|(?<![A-Za-z0-9:])1\/\/[A-Za-z0-9_-]{30,}|\bGOCSPX-[A-Za-z0-9_-]{20,}|\b\d{8,}-[a-z0-9]{20,}\.apps\.googleusercontent\.com/g, accept: (value) => !looksInvented(value) },
  { category: "telegram-bot-token", message: "Telegram bot token shape", pattern: /(?<![A-Za-z0-9])\d{8,10}:[A-Za-z0-9_-]{35}(?![A-Za-z0-9_-])/g, accept: (value) => !looksInvented(value.slice(value.indexOf(":") + 1)) },
  { category: "bearer-token", message: "literal bearer token", pattern: /\bBearer\s+([A-Za-z0-9._~+/=-]{24,})/g, group: 1, accept: looksRandom },
  { category: "assigned-secret", message: "literal value assigned to a token, secret, key, or password name", pattern: /(?:token|secret|password|passwd|api[_-]?key|private[_-]?key)\w*["']?\s*[:=]\s*["'`]([A-Za-z0-9_+/=.-]{32,})["'`]/gi, group: 1, accept: looksRandom },
  { category: "assigned-secret", message: "literal value assigned to a token, secret, key, or password variable", pattern: /^\s*(?:export\s+)?[A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|KEY)[A-Z0-9_]*=([A-Za-z0-9_+/=.-]{32,})\s*$/g, group: 1, accept: looksRandom },
  { category: "apple-identifier", message: "10-character identifier next to team, key, or bundle (Apple team ID or APNs key ID shape)", pattern: /(?<![A-Za-z0-9_-])(?=[A-Z0-9]{0,9}\d)(?=[A-Z0-9]{0,9}[A-Z])[A-Z0-9]{10}(?![A-Za-z0-9_-])/g, near: /team|key|bundle/i, accept: (value) => !looksInvented(value) },
  { category: "bundle-identifier", message: "reverse-DNS app identifier that is not an example", pattern: /(?<![A-Za-z0-9.@/_-])(?:group\.|iCloud\.)?(?:com|org|net|io|dev|app|me|co|ai)\.[a-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g, near: /bundle|identifier|topic|apns|subsystem|app[ _-]?group|container/i, accept: (value) => !/^(?:group\.|iCloud\.)?(?:(?:com|org|net)\.example|com\.apple)\./.test(value) },
  { category: "device-token", message: "64 hexadecimal characters (push device token shape)", pattern: /(?<![0-9A-Za-z])[0-9a-fA-F]{64}(?![0-9A-Za-z])/g, accept: (value, before, previous) => !looksInvented(value) && !/sha-?256|digest|checksum|integrity|hash/i.test(`${previous}\n${before}`) },
  { category: "cloudflare-identifier", message: "account, zone, database, or namespace ID value", pattern: /(?:account|zone|database|namespace)[_-]?id["']?\s*[:=]\s*["']?([0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/gi, group: 1, accept: (value) => !looksInvented(value) },
  { category: "telegram-identifier", message: "numeric owner, chat, or user ID value", pattern: /(?:owner|chat|user)[_-]?id["']?\s*[:=]\s*["']?(-?\d{8,})\b/gi, group: 1, accept: (value) => !looksInvented(value) && !/0{4}/.test(value) },
  { category: "deployment-origin", message: "host on a deployment platform that is not a documented example", pattern: /(?<![A-Za-z0-9.-])((?:[a-z0-9-]+\.)+(?:workers\.dev|pages\.dev|r2\.dev|trycloudflare\.com|cloudflareaccess\.com|ts\.net|fly\.dev|ngrok\.io|ngrok\.app|ngrok-free\.app))(?![A-Za-z0-9-])/gi, group: 1, accept: (value) => !isExampleHost(value) },
  { category: "deployment-origin", message: "Umpi host name that is not a documented example", pattern: /\b(?:https?|wss?):\/\/((?:[a-z0-9-]+\.)*[a-z0-9-]*umpi[a-z0-9-]*(?:\.[a-z0-9-]+)+)/gi, group: 1, accept: (value) => !isExampleHost(value) },
  { category: "email", message: "email address that is not an example or no-reply address", pattern: /(?<![A-Za-z0-9._%+-])([A-Za-z0-9._%+-]+)@((?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,})(?![A-Za-z0-9-])/g, accept: isReportableEmail },
];

function isReportableEmail(value: string, before: string): boolean {
  if (/[a-z][a-z0-9+.-]*:\/\/[^\s/@"'`]*$/i.test(before)) return false; // `scheme://user:password@host` is URL user information.
  const at = value.lastIndexOf("@"), local = value.slice(0, at).toLowerCase(), domain = value.slice(at + 1).toLowerCase();
  if (isExampleHost(domain) || /no-?reply/.test(local) || /no-?reply/.test(domain)) return false;
  if (local === "git") return false; // `git@host:path` is an SSH remote, not a mailbox.
  return !/\.(?:png|jpe?g|gif|svg|webp|pdf|json|js|ts|swift)$/.test(domain); // `icon@2x.png` is a file name.
}

const PRIVATE_KEY_HEADER = /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/;

function allowed(lines: readonly string[], index: number): boolean {
  return /publishable-ok(?!-next-line)/.test(lines[index]!) || (index > 0 && /publishable-ok-next-line/.test(lines[index - 1]!));
}

/** Applies the generic rules to one text. A hit on an allowed line is not returned. */
export function scanText(text: string): Finding[] {
  const findings: Finding[] = [], lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line.length < 8 || allowed(lines, index)) continue;
    // A key header counts only when key material follows it; a header alone is a parser or a description.
    const header = PRIVATE_KEY_HEADER.exec(line);
    if (header) {
      const after = `${line.slice(header.index + header[0].length)}\n${lines[index + 1] ?? ""}`.replace(/\\[nr]|[\s"'`+]/g, "");
      const material = /^[A-Za-z0-9+/=]{40,}/.exec(after);
      if (material && !looksInvented(material[0])) findings.push({ line: index + 1, category: "private-key", message: "private key block with key material", value: material[0] });
    }
    for (const rule of RULES) {
      rule.pattern.lastIndex = 0;
      for (const match of line.matchAll(rule.pattern)) {
        const value = rule.group === undefined ? match[0] : match[rule.group];
        if (value === undefined) continue;
        const start = match.index + match[0].lastIndexOf(value), before = line.slice(Math.max(0, start - 48), start);
        if (rule.near && !rule.near.test(`${before}${line.slice(start + value.length, start + value.length + 24)}`)) continue;
        if (rule.accept && !rule.accept(value, before, `${lines[index - 2] ?? ""}\n${lines[index - 1] ?? ""}`)) continue;
        // One line per category is enough to send a reader to the line.
        if (findings.some((finding) => finding.line === index + 1 && finding.category === rule.category)) continue;
        findings.push({ line: index + 1, category: rule.category, message: rule.message, value });
      }
    }
  }
  return findings;
}

/** Reads deny-list text. A line that is not a valid regular expression is returned in `invalid` by line number. */
export function parseDenyList(text: string): { patterns: DenyPattern[]; invalid: number[] } {
  const patterns: DenyPattern[] = [], invalid: number[] = [];
  text.split(/\r?\n/).forEach((raw, index) => {
    const source = raw.trim();
    if (source === "" || source.startsWith("#")) return;
    try { patterns.push({ line: index + 1, pattern: new RegExp(source, "i") }); } catch { invalid.push(index + 1); }
  });
  return { patterns, invalid };
}

/** Applies the deny-list to one text. The result names the text line and the pattern line, never the match. */
export function scanDenyList(text: string, patterns: readonly DenyPattern[]): Array<{ line: number; patternLine: number }> {
  const hits: Array<{ line: number; patternLine: number }> = [];
  const active = patterns.filter((entry) => entry.pattern.test(text));
  if (active.length === 0) return hits;
  text.split(/\r?\n/).forEach((line, index) => {
    for (const entry of active) if (entry.pattern.test(line)) hits.push({ line: index + 1, patternLine: entry.line });
  });
  return hits;
}

/** A masked form for `--preview`: the first four characters and the length. */
export function mask(value: string): string {
  return `${value.slice(0, 4)}… (${value.length} characters)`;
}

// ---- The check itself: git and the file system ----

function git(root: string, args: string[], input?: string): Buffer | null {
  try {
    return execFileSync("git", ["-c", "core.quotepath=off", ...args], { cwd: root, input, stdio: ["pipe", "pipe", "ignore"], maxBuffer: 256 * 1024 * 1024 });
  } catch { return null; }
}

function nulList(buffer: Buffer | null): string[] { return (buffer?.toString("utf8") ?? "").split("\0").filter(Boolean); }

function isText(content: Buffer): boolean { return !content.subarray(0, 8000).includes(0); }

/** Reads a working-tree file that git listed. Returns null for a link, a non-file, a large file, or a path that resolves elsewhere. */
function readWorkingFile(root: string, path: string): Buffer | null {
  try {
    const full = join(root, path), status = lstatSync(full);
    if (!status.isFile() || status.size > MAX_FILE_BYTES) return null;
    if (realpathSync(full) !== join(realpathSync(root), path)) return null;
    return readFileSync(full);
  } catch { return null; }
}

/** Reads the staged content of the given paths from the index with one `git cat-file --batch`. */
function readStaged(root: string, paths: string[]): Map<string, Buffer> {
  const contents = new Map<string, Buffer>(), entries: Array<{ path: string; oid: string }> = [];
  for (const record of nulList(git(root, ["ls-files", "-s", "-z", "--", ...paths]))) {
    const match = /^(\d+) ([0-9a-f]+) \d\t(.*)$/s.exec(record);
    if (match && match[1] !== "120000" && match[1] !== "160000") entries.push({ path: match[3]!, oid: match[2]! }); // Not a link, not a submodule.
  }
  const output = entries.length === 0 ? null : git(root, ["cat-file", "--batch"], entries.map((entry) => entry.oid).join("\n") + "\n");
  let offset = 0;
  for (const entry of entries) {
    if (!output) break;
    const end = output.indexOf(10, offset);
    if (end < 0) break;
    const size = Number(output.subarray(offset, end).toString("utf8").split(" ")[2]);
    if (!Number.isFinite(size)) break;
    if (size <= MAX_FILE_BYTES) contents.set(entry.path, output.subarray(end + 1, end + 1 + size));
    offset = end + 1 + size + 1;
  }
  return contents;
}

export type Hit = { path: string; line: number; category: string; message: string };
export type CheckResult = { hits: Hit[]; files: number; skipped: number; denyPatterns: number };

export function checkPublishable(root: string, options: { all?: boolean; preview?: boolean } = {}): CheckResult {
  const hits: Hit[] = [];
  const listed = nulList(options.all ? git(root, ["ls-files", "-co", "--exclude-standard", "-z"]) : git(root, ["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"]));
  // A tracked or staged path that an ignore rule matches was added with force. Report it by name; do not open it.
  const ignored = new Set(listed.length === 0 ? [] : nulList(git(root, ["check-ignore", "--no-index", "--stdin", "-z"], listed.join("\0"))));
  const open = listed.filter((path) => {
    if (!isPrivatePath(path) && !ignored.has(path)) return true;
    hits.push({ path, line: 1, category: "private-file", message: "private or ignored file is in the commit set; it was not opened" });
    return false;
  });

  let deny: DenyPattern[] = [];
  if (existsSync(join(root, DENY_FILE))) {
    const parsed = parseDenyList(readFileSync(join(root, DENY_FILE), "utf8"));
    deny = parsed.patterns;
    for (const line of parsed.invalid) hits.push({ path: DENY_FILE, line, category: "deny-list", message: "this line is not a valid regular expression" });
  }
  const denied = (path: string, line: number, patternLine: number, where: string): void => {
    hits.push({ path, line, category: "deny-list", message: `${where} matches the pattern on line ${patternLine} of ${DENY_FILE}` });
  };

  const staged = options.all ? null : readStaged(root, open);
  let files = 0, skipped = 0;
  for (const path of open) {
    for (const entry of deny) if (entry.pattern.test(path)) denied(path, 1, entry.line, "the file path");
    const content = staged ? staged.get(path) ?? null : readWorkingFile(root, path);
    if (!content || !isText(content)) { skipped += 1; continue; }
    files += 1;
    const text = content.toString("utf8");
    for (const hit of scanDenyList(text, deny)) denied(path, hit.line, hit.patternLine, "the line");
    if (THIRD_PARTY_DATA.has(path)) continue;
    for (const finding of scanText(text)) hits.push({ path, line: finding.line, category: finding.category, message: options.preview ? `${finding.message} [${mask(finding.value)}]` : finding.message });
  }

  // A commit also publishes the author and committer identity.
  for (const role of ["AUTHOR", "COMMITTER"]) {
    const identity = (git(root, ["var", `GIT_${role}_IDENT`])?.toString("utf8") ?? "").replace(/\s+\d+\s+[+-]\d{4}\s*$/, "");
    const where = `git ${role.toLowerCase()} identity`;
    for (const entry of deny) if (entry.pattern.test(identity)) denied(where, 0, entry.line, "the identity");
    for (const finding of scanText(identity)) if (finding.category === "email") hits.push({ path: where, line: 0, category: "email", message: finding.message });
  }

  hits.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
  return { hits, files, skipped, denyPatterns: deny.length };
}

function main(argv: string[]): number {
  const unknown = argv.filter((argument) => !["--all", "--preview"].includes(argument));
  if (unknown.length > 0) { console.error(`check-publishable: unknown argument ${unknown[0]}\nusage: node scripts/check-publishable.ts [--all] [--preview]`); return 2; }
  const started = performance.now(), all = argv.includes("--all");
  const root = resolve(fileURLToPath(import.meta.url), "../..");
  const result = checkPublishable(root, { all, preview: argv.includes("--preview") });
  for (const hit of result.hits) console.log(`${hit.path}:${hit.line}: ${hit.category}: ${hit.message}`);
  const counts = new Map<string, number>();
  for (const hit of result.hits) counts.set(hit.category, (counts.get(hit.category) ?? 0) + 1);
  const byCategory = [...counts].sort((a, b) => b[1] - a[1]).map(([category, count]) => `${category} ${count}`).join(", ");
  const scope = all ? "tracked and unignored files" : "staged files";
  console.log(`check-publishable: ${result.files} ${scope} read, ${result.skipped} binary or large skipped, ${result.denyPatterns} deny-list pattern${result.denyPatterns === 1 ? "" : "s"}, ${result.hits.length} hit${result.hits.length === 1 ? "" : "s"}${byCategory ? ` (${byCategory})` : ""}, ${Math.round(performance.now() - started)} ms`);
  return result.hits.length > 0 ? 1 : 0;
}

function isEntryPoint(): boolean {
  try { return process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
}

if (isEntryPoint()) process.exitCode = main(process.argv.slice(2));
