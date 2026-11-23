import { normalizeWebUrl } from "./web-search.js";

/**
 * The format of a UI block: a tree of native components that Umpi composes and the apps draw (`show_ui`).
 *
 * A node is an object with a `type` and that type's properties; containers hold `children`. The catalog below is the
 * single source: the validator reads it, and the text that teaches the model the format is generated from it, so the
 * two cannot drift. The apps draw each type with a native view and ignore a type they do not know.
 *
 * Components are low-level on purpose. There is no "flight card" or "price card": a card, a stat, a list, and a
 * button compose into one. A component never runs code on the coordinator. A button can send its own label as the
 * owner's next message, open a link, or copy text; everything else is local to the view.
 */
export const UI_LIMITS = { nodes: 150, depth: 6, chars: 12_000, blocks: 3 } as const;
export const UI_TONES = ["neutral", "accent", "positive", "warning", "critical", "muted"] as const;

type Prop =
  | { kind: "text"; max: number; required?: boolean }
  /** Text, or a number written as text. */
  | { kind: "label"; max: number; required?: boolean }
  | { kind: "enum"; values: readonly string[]; required?: boolean }
  | { kind: "bool" }
  | { kind: "number"; min?: number; max?: number; integer?: boolean; required?: boolean }
  | { kind: "url"; required?: boolean }
  | { kind: "children"; max: number }
  | { kind: "items"; min: number; max: number; of: Record<string, Prop> }
  /** Table rows: arrays of cell text, one cell for each column. */
  | { kind: "rows"; max: number; cell: number };

const text = (max: number, required = false): Prop => ({ kind: "text", max, ...(required ? { required } : {}) });
const oneOf = (values: readonly string[], required = false): Prop => ({ kind: "enum", values, ...(required ? { required } : {}) });
const bool: Prop = { kind: "bool" };
const tone = oneOf(UI_TONES), align = oneOf(["start", "center", "end"]);
const children: Prop = { kind: "children", max: 24 };
const items = (min: number, max: number, of: Record<string, Prop>): Prop => ({ kind: "items", min, max, of });

export const UI_CATALOG: Record<string, { about: string; props: Record<string, Prop> }> = {
  stack: { about: "Children in a column; direction horizontal makes a row.", props: { direction: oneOf(["vertical", "horizontal"]), gap: oneOf(["none", "small", "medium", "large"]), align, children } },
  grid: { about: "Children in equal columns, row by row.", props: { columns: { kind: "number", min: 2, max: 4, integer: true, required: true }, children } },
  card: { about: "A group on its own background, with an optional heading.", props: { title: text(80), subtitle: text(160), icon: text(60), tone, children } },
  section: { about: "A heading with content under it; collapsible lets the owner fold it.", props: { title: text(80, true), collapsible: bool, collapsed: bool, children } },
  tabs: { about: "Panes the owner switches between.", props: { tabs: items(2, 6, { label: text(30, true), children }) } },
  disclosure: { about: "Detail hidden until the owner opens it.", props: { title: text(80, true), children } },
  divider: { about: "A thin line between parts.", props: {} },
  text: { about: "Plain text in one style.", props: { text: text(600, true), style: oneOf(["title", "headline", "body", "caption", "mono"]), tone, align } },
  markdown: { about: "Rich text: emphasis, links, lists, code.", props: { text: text(4_000, true) } },
  icon: { about: "An SF Symbol.", props: { name: text(60, true), tone, size: oneOf(["small", "medium", "large"]) } },
  badge: { about: "A short status label.", props: { label: text(40, true), tone } },
  stat: { about: "One number with its label; delta is a change such as +4%.", props: { label: text(60, true), value: text(40, true), detail: text(120), delta: text(30), tone } },
  keyvalue: { about: "Rows of label and value.", props: { rows: items(1, 30, { label: text(60, true), value: text(200, true), tone }) } },
  list: { about: "Rows with a title and optional detail, icon, and trailing text. A checklist can be ticked, in the view only.", props: { style: oneOf(["plain", "numbered", "checklist"]),
    items: items(1, 40, { title: text(160, true), detail: text(300), icon: text(60), trailing: text(40), tone, checked: bool }) } },
  table: { about: "Columns and rows of text; each row has one cell for each column.", props: { columns: items(1, 8, { title: text(40, true), align }), rows: { kind: "rows", max: 60, cell: 200 } } },
  progress: { about: "A bar from 0 to 1.", props: { value: { kind: "number", min: 0, max: 1, required: true }, label: text(80), detail: text(80), tone } },
  timeline: { about: "Steps or events in order.", props: { items: items(1, 30, { time: text(40), title: text(120, true), detail: text(300), state: oneOf(["done", "current", "upcoming"]) }) } },
  chart: { about: "Numbers as bars, a line, or an area; x is a label such as a date.", props: { kind: oneOf(["bar", "line", "area"], true), title: text(80), unit: text(20),
    series: items(1, 4, { name: text(40, true), points: items(1, 60, { x: { kind: "label", max: 30, required: true }, y: { kind: "number", required: true } }) }) } },
  button: { about: "action send: sends the label as the owner's next message. open: opens url. copy: copies text.", props: { label: text(80, true), action: oneOf(["send", "open", "copy"], true), url: { kind: "url" }, text: text(2_000), style: oneOf(["primary", "secondary", "destructive"]) } },
  link: { about: "A link to a page.", props: { label: text(80, true), url: { kind: "url", required: true } } },
};

export type UiNode = { type: string; [key: string]: unknown };
export type UiCheck = { ok: true; spec: UiNode; urls: string[] } | { ok: false; errors: string[] };

const MAX_ERRORS = 12;

/**
 * Checks a UI block against the catalog and returns its cleaned form with the web addresses it holds, in comparison
 * form, or what to change. An unknown type or property is an error, so the model learns the format instead of losing
 * content without notice.
 */
export function validateUiSpec(value: unknown): UiCheck {
  const errors: string[] = [], urls: string[] = [];
  let nodes = 0;
  const fail = (path: string, issue: string) => { if (errors.length < MAX_ERRORS) errors.push(`${path}: ${issue}`); };
  const object = (item: unknown): item is Record<string, unknown> => typeof item === "object" && item !== null && !Array.isArray(item);

  const prop = (path: string, rule: Prop, raw: unknown, depth: number): unknown => {
    switch (rule.kind) {
      case "text": case "label": {
        const given = rule.kind === "label" && typeof raw === "number" && Number.isFinite(raw) ? String(raw) : raw;
        if (typeof given !== "string" || !given.trim()) return fail(path, "must be text");
        if (given.length > rule.max) return fail(path, `is ${given.length} characters; the limit is ${rule.max}`);
        return given;
      }
      case "enum": return typeof raw === "string" && rule.values.includes(raw) ? raw : fail(path, `must be one of ${rule.values.join(", ")}`);
      case "bool": return typeof raw === "boolean" ? raw : fail(path, "must be true or false");
      case "number":
        if (typeof raw !== "number" || !Number.isFinite(raw) || rule.integer && !Number.isInteger(raw)) return fail(path, rule.integer ? "must be a whole number" : "must be a number");
        if (rule.min !== undefined && raw < rule.min || rule.max !== undefined && raw > rule.max) return fail(path, `must be from ${rule.min} to ${rule.max}`);
        return raw;
      case "url": {
        const url = typeof raw === "string" ? normalizeWebUrl(raw) : undefined;
        if (!url || !url.startsWith("https://")) return fail(path, "must be an https address");
        urls.push(url);
        return url;
      }
      case "children": {
        if (!Array.isArray(raw) || !raw.length) return fail(path, "must be a list of at least one component");
        if (raw.length > rule.max) return fail(path, `has ${raw.length} components; the limit is ${rule.max}`);
        return raw.map((child, index) => node(`${path}[${index}]`, child, depth + 1));
      }
      case "items": {
        if (!Array.isArray(raw) || raw.length < rule.min) return fail(path, `must be a list of at least ${rule.min}`);
        if (raw.length > rule.max) return fail(path, `has ${raw.length} entries; the limit is ${rule.max}`);
        return raw.map((item, index) => object(item) ? fields(`${path}[${index}]`, rule.of, item, depth) : fail(`${path}[${index}]`, "must be an object"));
      }
      case "rows": {
        if (!Array.isArray(raw) || !raw.length) return fail(path, "must be a list of rows");
        if (raw.length > rule.max) return fail(path, `has ${raw.length} rows; the limit is ${rule.max}`);
        return raw.map((row, index) => Array.isArray(row)
          ? row.map((cell, column) => typeof cell === "number" && Number.isFinite(cell) ? String(cell) : typeof cell === "string" && cell.length <= rule.cell ? cell : fail(`${path}[${index}][${column}]`, `must be text of at most ${rule.cell} characters`))
          : fail(`${path}[${index}]`, "must be a list of cells"));
      }
    }
  };
  const fields = (path: string, rules: Record<string, Prop>, given: Record<string, unknown>, depth: number, skip?: string): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(given)) if (key !== skip && !(key in rules)) fail(`${path}.${key}`, `is not a property here; use ${Object.keys(rules).join(", ") || "none"}`);
    for (const [key, rule] of Object.entries(rules)) {
      if (given[key] === undefined || given[key] === null) { if ("required" in rule && rule.required || rule.kind === "children" || rule.kind === "items" || rule.kind === "rows") fail(`${path}.${key}`, "is required"); continue; }
      const checked = prop(`${path}.${key}`, rule, given[key], depth);
      if (checked !== undefined) out[key] = checked;
    }
    return out;
  };
  const node = (path: string, raw: unknown, depth: number): UiNode | undefined => {
    if (!object(raw) || typeof raw.type !== "string") return void fail(path, "must be a component: an object with a type");
    const entry = Object.hasOwn(UI_CATALOG, raw.type) ? UI_CATALOG[raw.type]! : undefined;
    if (!entry) return void fail(path, `"${raw.type.slice(0, 40)}" is not a component; use ${Object.keys(UI_CATALOG).join(", ")}`);
    if (++nodes > UI_LIMITS.nodes) return void fail(path, `more than ${UI_LIMITS.nodes} components`);
    if (depth > UI_LIMITS.depth) return void fail(path, `nested deeper than ${UI_LIMITS.depth} levels`);
    const here = `${path}(${raw.type})`, out = fields(here, entry.props, raw, depth, "type");
    if (raw.type === "button") {
      if (out.action === "open" && out.url === undefined) fail(`${here}.url`, "is required for action open");
      if (out.action === "copy" && out.text === undefined) fail(`${here}.text`, "is required for action copy");
      if (out.action === "send" && (out.url !== undefined || out.text !== undefined)) fail(here, "a send button sends its label; it takes no url or text");
    }
    if (raw.type === "table" && Array.isArray(out.columns) && Array.isArray(out.rows)) {
      const width = out.columns.length;
      (out.rows as unknown[]).forEach((row, index) => { if (Array.isArray(row) && row.length !== width) fail(`${here}.rows[${index}]`, `has ${row.length} cells for ${width} columns`); });
    }
    return { type: raw.type, ...out };
  };

  const spec = node("ui", value, 1);
  if (!errors.length && spec && JSON.stringify(spec).length > UI_LIMITS.chars) fail("ui", `is larger than ${UI_LIMITS.chars} characters; show less, or split it into two blocks`);
  return errors.length || !spec ? { ok: false, errors } : { ok: true, spec, urls: [...new Set(urls)] };
}

/** The catalog as text for the model: one line for each component, written from the same table the validator reads. */
export function uiCatalogText(): string {
  const sign = (rule: Prop): string => rule.kind === "enum" ? rule.values.join("|") : rule.kind === "items" ? `[{${names(rule.of)}}]` : rule.kind === "rows" ? "[[cell]]" : rule.kind === "children" ? "[…]" : rule.kind;
  const required = (rule: Prop) => "required" in rule && rule.required === true || rule.kind === "children" || rule.kind === "items" || rule.kind === "rows";
  const names = (props: Record<string, Prop>): string => Object.entries(props).map(([key, rule]) => {
    // `tone` and `align` take the same values everywhere; the tool description names them once.
    const plain = key === "tone" || key === "align" || rule.kind === "text" || rule.kind === "label" || rule.kind === "bool" || rule.kind === "url" || rule.kind === "number" || rule.kind === "children";
    return `${key}${required(rule) ? "" : "?"}${plain ? "" : `: ${sign(rule)}`}`;
  }).join(", ");
  return Object.entries(UI_CATALOG).map(([type, entry]) => `- ${type}(${names(entry.props)}): ${entry.about}`).join("\n");
}
