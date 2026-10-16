import { lexer, type Token, type Tokens } from "marked";
import type { TelegramEntity } from "./store.js";

export interface TelegramRichText {
  text: string;
  entities: TelegramEntity[];
}

interface RenderBuffer extends TelegramRichText {}
type Style = "bold" | "italic" | "strikethrough" | "code" | "blockquote";

function append(buffer: RenderBuffer, text: string): void { buffer.text += text; }
function appendRich(buffer: RenderBuffer, value: TelegramRichText): void {
  const offset = buffer.text.length;
  buffer.text += value.text;
  buffer.entities.push(...value.entities.map(entity => ({ ...entity, offset: entity.offset + offset })));
}
function newlines(buffer: RenderBuffer, count: number): void {
  const trailing = /\n*$/.exec(buffer.text)?.[0].length ?? 0;
  if (trailing < count) append(buffer, "\n".repeat(count - trailing));
}
function style(buffer: RenderBuffer, type: Style, render: () => void): void {
  const offset = buffer.text.length;
  render();
  const length = buffer.text.length - offset;
  if (length) buffer.entities.push({ type, offset, length });
}
function pre(buffer: RenderBuffer, text: string, language?: string): void {
  const offset = buffer.text.length;
  append(buffer, text);
  if (text.length) buffer.entities.push({ type: "pre", offset, length: text.length, ...(language ? { language } : {}) });
}
function link(buffer: RenderBuffer, href: string, render: () => void): void {
  const offset = buffer.text.length;
  render();
  const length = buffer.text.length - offset, url = safeUrl(href);
  if (length && url) buffer.entities.push({ type: "text_link", offset, length, url });
}
function safeUrl(value: string): string | undefined {
  if (value.length > 2_048) return;
  try {
    const url = new URL(value);
    return ["http:", "https:", "mailto:"].includes(url.protocol) ? value : undefined;
  } catch { return; }
}
function children(token: Token): Token[] {
  return "tokens" in token && Array.isArray(token.tokens) ? token.tokens : [];
}
function value(token: Token): string {
  return "text" in token && typeof token.text === "string" ? token.text : token.raw;
}
function inline(tokens: Token[], buffer: RenderBuffer): void {
  for (const token of tokens) {
    switch (token.type) {
      case "text": {
        const nested = children(token);
        if (nested.length) inline(nested, buffer); else append(buffer, value(token));
        break;
      }
      case "escape": append(buffer, value(token)); break;
      case "strong": style(buffer, "bold", () => inline(children(token), buffer)); break;
      case "em": style(buffer, "italic", () => inline(children(token), buffer)); break;
      case "del": style(buffer, "strikethrough", () => inline(children(token), buffer)); break;
      case "codespan": style(buffer, "code", () => append(buffer, value(token))); break;
      case "link": {
        const item = token as Tokens.Link;
        link(buffer, item.href, () => inline(item.tokens, buffer));
        break;
      }
      case "image": {
        const item = token as Tokens.Image;
        link(buffer, item.href, () => append(buffer, item.text || item.href));
        break;
      }
      case "br": append(buffer, "\n"); break;
      case "checkbox": append(buffer, (token as Tokens.Checkbox).checked ? "[x] " : "[ ] "); break;
      case "html": append(buffer, value(token)); break;
      default: {
        const nested = children(token);
        if (nested.length) inline(nested, buffer); else append(buffer, value(token));
      }
    }
  }
}
function trimmed(value: TelegramRichText): TelegramRichText {
  const length = value.text.replace(/\n+$/, "").length;
  return {
    text: value.text.slice(0, length),
    entities: value.entities.flatMap(entity => {
      if (entity.offset >= length) return [];
      return [{ ...entity, length: Math.min(entity.length, length - entity.offset) }];
    }),
  };
}
function blockFragment(tokens: Token[], compact = false): TelegramRichText {
  const buffer: RenderBuffer = { text: "", entities: [] };
  blocks(tokens, buffer, compact);
  return trimmed(buffer);
}
function table(token: Tokens.Table): string {
  const rows = [token.header, ...token.rows];
  return rows.map(row => row.map(cell => {
    const rendered: RenderBuffer = { text: "", entities: [] };
    inline(cell.tokens, rendered);
    return rendered.text.replace(/\s+/g, " ").trim();
  }).join(" | ")).join("\n");
}
function blocks(tokens: Token[], buffer: RenderBuffer, compact = false): void {
  for (const token of tokens) {
    switch (token.type) {
      case "space":
      case "def":
        break;
      case "paragraph":
        inline(children(token), buffer);
        if (!compact) newlines(buffer, 2);
        break;
      case "text": {
        const nested = children(token);
        if (nested.length) inline(nested, buffer); else append(buffer, value(token));
        if (!compact) newlines(buffer, 1);
        break;
      }
      case "heading":
        style(buffer, "bold", () => inline(children(token), buffer));
        newlines(buffer, compact ? 1 : 2);
        break;
      case "code": {
        const item = token as Tokens.Code;
        pre(buffer, item.text, item.lang?.trim().split(/\s+/)[0]);
        newlines(buffer, compact ? 1 : 2);
        break;
      }
      case "blockquote": {
        const value = blockFragment(children(token), compact);
        const offset = buffer.text.length;
        appendRich(buffer, { ...value, entities: value.entities.filter(entity => entity.type !== "blockquote") });
        if (value.text.length) buffer.entities.push({ type: "blockquote", offset, length: value.text.length });
        newlines(buffer, compact ? 1 : 2);
        break;
      }
      case "list": {
        const list = token as Tokens.List, start = typeof list.start === "number" ? list.start : 1;
        list.items.forEach((item: Tokens.ListItem, index: number) => {
          append(buffer, list.ordered ? `${start + index}. ` : "• ");
          if (item.task) append(buffer, item.checked ? "[x] " : "[ ] ");
          appendRich(buffer, blockFragment(item.tokens, true));
          newlines(buffer, 1);
        });
        if (!compact) newlines(buffer, 2);
        break;
      }
      case "table":
        pre(buffer, table(token as Tokens.Table));
        newlines(buffer, compact ? 1 : 2);
        break;
      case "hr":
        append(buffer, "────────");
        newlines(buffer, compact ? 1 : 2);
        break;
      case "html":
        append(buffer, value(token));
        newlines(buffer, compact ? 1 : 2);
        break;
      default: {
        const nested = children(token);
        if (nested.length) blocks(nested, buffer, compact);
        else {
          append(buffer, value(token));
          if (!compact) newlines(buffer, 1);
        }
      }
    }
  }
}

/** Converts common Markdown to Telegram-native text entities; source Markdown remains untouched for other channels. */
export function renderTelegramMarkdown(markdown: string): TelegramRichText {
  try {
    const rendered = blockFragment(lexer(markdown, { gfm: true, breaks: false }));
    rendered.entities.sort((left, right) => left.offset - right.offset || right.length - left.length);
    return rendered.text ? rendered : { text: markdown, entities: [] };
  } catch {
    return { text: markdown, entities: [] };
  }
}
