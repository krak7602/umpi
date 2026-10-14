export interface MarkdownHeading { label: string; level: number; start: number; bodyStart: number; newline: string }
export interface MarkdownLine { text: string; start: number; end: number; newline: string; content: boolean }

/** Shared section boundaries. Frontmatter and fenced examples are never active content. */
export function scanMarkdown(markdown: string): { headings: MarkdownHeading[]; lines: MarkdownLine[] } {
  const lines: MarkdownLine[] = [];
  const pattern = /([^\n]*)(\n|$)/g;
  for (const match of markdown.matchAll(pattern)) {
    if (match[0] === "") break;
    const raw = match[1]!;
    const newline = match[2] === "\n" ? (raw.endsWith("\r") ? "\r\n" : "\n") : "";
    lines.push({ text: newline === "\r\n" ? raw.slice(0, -1) : raw, start: match.index, end: match.index + match[0].length, newline, content: false });
  }
  const headings: MarkdownHeading[] = [];
  let firstContentLine = 0;
  if (lines[0]?.text.replace(/^\uFEFF/, "") === "---") {
    const closing = lines.findIndex((line, index) => index > 0 && /^(?:---|\.\.\.)[ \t]*$/.test(line.text));
    if (closing < 0) throw new Error("A selected Markdown file has unclosed frontmatter; reconcile it before sync");
    firstContentLine = closing + 1;
  }
  let fence: { marker: string; length: number } | undefined;
  for (let index = firstContentLine; index < lines.length; index++) {
    const line = lines[index]!;
    if (fence) {
      const closing = /^ {0,3}(`+|~+)[ \t]*$/.exec(line.text);
      if (closing && closing[1]![0] === fence.marker && closing[1]!.length >= fence.length) fence = undefined;
      continue;
    }
    const opening = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line.text);
    if (opening && !(opening[1]![0] === "`" && opening[2]!.includes("`"))) {
      fence = { marker: opening[1]![0]!, length: opening[1]!.length };
      continue;
    }
    line.content = true;
    const atx = /^ {0,3}(#{1,6})(?:[ \t]+(.*)|[ \t]*)$/.exec(line.text);
    if (atx) {
      const label = (atx[2] ?? "").replace(/[ \t]+#+[ \t]*$/, "").trim();
      headings.push({ label, level: atx[1]!.length, start: line.start, bodyStart: line.end, newline: line.newline });
      continue;
    }
    // Setext headings have a plain, unindented label followed by an underline.
    const next = lines[index + 1];
    const underline = next && /^ {0,3}(=+|-+)[ \t]*$/.exec(next.text);
    if (next && underline && /^ {0,3}\S/.test(line.text) && !/^ {0,3}(?:>|[-+*][ \t]|\d+[.)][ \t])/.test(line.text)) {
      headings.push({ label: line.text.trim(), level: underline[1]![0] === "=" ? 1 : 2, start: line.start, bodyStart: next.end, newline: next.newline });
      next.content = true;
      index++;
    }
  }
  if (fence) throw new Error("A selected Markdown file has an unclosed code fence; reconcile section boundaries before sync");
  return { headings, lines };
}
