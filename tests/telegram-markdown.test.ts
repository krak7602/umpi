import assert from "node:assert/strict";
import test from "node:test";
import { renderTelegramMarkdown } from "../src/worker/telegram-markdown.js";

function textFor(markdown: string, type: string): string[] {
  const rendered = renderTelegramMarkdown(markdown);
  return rendered.entities.filter(entity => entity.type === type)
    .map(entity => rendered.text.slice(entity.offset, entity.offset + entity.length));
}

test("ordinary model Markdown becomes readable Telegram lists and native emphasis", () => {
  const markdown = `That suggests a workable parallel setup:

- **Background lane:** Keep Connection running.
- **Primary lane:** Alternate between **LLMs from Scratch** and solving *CAT questions*.
- **Low-energy lane:** Watch system design videos.`;
  const rendered = renderTelegramMarkdown(markdown);
  assert.equal(rendered.text, `That suggests a workable parallel setup:

• Background lane: Keep Connection running.
• Primary lane: Alternate between LLMs from Scratch and solving CAT questions.
• Low-energy lane: Watch system design videos.`);
  assert.deepEqual(textFor(markdown, "bold"), ["Background lane:", "Primary lane:", "LLMs from Scratch", "Low-energy lane:"]);
  assert.deepEqual(textFor(markdown, "italic"), ["CAT questions"]);
  assert.doesNotMatch(rendered.text, /\*\*|^- /m);
});

test("code, links, quotations and raw HTML stay bounded and Telegram-safe", () => {
  const markdown = `# Plan

Use \`x < y\` and [the docs](https://example.test/guide?q=1).

> **Important:** inspect the result.

\`\`\`ts
const value = 1;
\`\`\`

<script>alert("literal")</script>

[unsafe](javascript:alert(1))`;
  const rendered = renderTelegramMarkdown(markdown);
  assert.match(rendered.text, /^Plan\n\nUse x < y and the docs\./);
  assert.match(rendered.text, /<script>alert\("literal"\)<\/script>/);
  assert.deepEqual(textFor(markdown, "code"), ["x < y"]);
  assert.deepEqual(textFor(markdown, "text_link"), ["the docs"]);
  assert.deepEqual(textFor(markdown, "blockquote"), ["Important: inspect the result."]);
  const pre = rendered.entities.find(entity => entity.type === "pre");
  assert.ok(pre?.type === "pre");
  assert.equal(pre.language, "ts");
  assert.equal(rendered.text.slice(pre.offset, pre.offset + pre.length), "const value = 1;");
  assert.equal(rendered.entities.some(entity => entity.type === "text_link" && entity.url.startsWith("javascript:")), false);
});
