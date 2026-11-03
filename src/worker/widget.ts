import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolExecutionResult, type ToolRegistration } from "@earendil-works/pi-durable";
import { InputError, boundedText, record } from "../shared/protocol.js";
import { StateError, type Database } from "./store.js";

/**
 * What the phone's home-screen widgets show. Umpi can choose the items (set_widget); otherwise the coordinator builds
 * them from today's open tasks, the next reminders, and what is waiting on the owner. A small widget shows the first
 * item, a medium one four, a large one eight.
 */
export interface WidgetItem { title: string; detail?: string; symbol?: string; link?: "chat" | "today" | "work" }
export interface WidgetContent { items: WidgetItem[]; source: "umpi" | "default"; updatedAt: string; note?: string; actions: WidgetAction[] }
/** The widget's buttons: what each opens in the app. */
export const WIDGET_ACTIONS = ["voice", "today", "chat", "work", "remind"] as const;
export type WidgetAction = (typeof WIDGET_ACTIONS)[number];
export const DEFAULT_WIDGET_ACTIONS: WidgetAction[] = ["voice", "today", "chat", "work"];
export function parseWidgetActions(value: unknown): WidgetAction[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 4) throw new InputError("actions must be a list of 1 to 4");
  const actions = value.map(action => {
    if (!(WIDGET_ACTIONS as readonly string[]).includes(String(action))) throw new InputError(`Unknown widget action; use ${WIDGET_ACTIONS.join(", ")}`);
    return action as WidgetAction;
  });
  if (new Set(actions).size !== actions.length) throw new InputError("Each widget action can appear once");
  return actions;
}
const MAX_ITEMS = 8;
const SYMBOL = /^[a-z0-9.]{1,40}$/;

export function parseWidgetItems(value: unknown): WidgetItem[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_ITEMS) throw new InputError(`items must be a list of 1 to ${MAX_ITEMS}`);
  return value.map(item => {
    const input = record(item);
    if (Object.keys(input).some(key => !["title", "detail", "symbol", "link"].includes(key))) throw new InputError("Unknown widget item field");
    if (input.symbol !== undefined && (typeof input.symbol !== "string" || !SYMBOL.test(input.symbol))) throw new InputError("symbol must be an SF Symbol name");
    if (input.link !== undefined && !["chat", "today", "work"].includes(String(input.link))) throw new InputError("link must be chat, today, or work");
    return { title: boundedText(input.title, 80, "widget title").trim(),
      ...(input.detail !== undefined ? { detail: boundedText(input.detail, 120, "widget detail").trim() } : {}),
      ...(input.symbol !== undefined ? { symbol: input.symbol as string } : {}),
      ...(input.link !== undefined ? { link: input.link as WidgetItem["link"] } : {}) };
  });
}

export class WidgetStore {
  constructor(private readonly db: Database, private readonly now = () => Date.now()) {
    // Row 1 holds the items Umpi chose; row 2 the buttons.
    db.all("CREATE TABLE IF NOT EXISTS umpi_widget (id INTEGER PRIMARY KEY, data TEXT NOT NULL)");
  }
  /** Umpi's chosen items while they have not expired. */
  current(): { items: WidgetItem[]; setAt: string; expiresAt: string; note?: string } | undefined {
    const row = this.db.all<{ data: string }>("SELECT data FROM umpi_widget WHERE id=1")[0];
    if (!row) return undefined;
    const value = JSON.parse(row.data) as { items: WidgetItem[]; setAt: string; expiresAt: string; note?: string };
    return Date.parse(value.expiresAt) > this.now() ? value : undefined;
  }
  set(input: unknown): { items: WidgetItem[]; setAt: string; expiresAt: string } {
    const body = record(input);
    if (Object.keys(body).some(key => !["items", "hours", "note"].includes(key))) throw new InputError("Unknown widget field");
    const hours = body.hours === undefined ? 12 : typeof body.hours === "number" && body.hours > 0 && body.hours <= 48 ? body.hours : (() => { throw new InputError("hours must be between 0 and 48"); })();
    const value = { items: parseWidgetItems(body.items), setAt: new Date(this.now()).toISOString(), expiresAt: new Date(this.now() + hours * 3_600_000).toISOString(),
      ...(body.note !== undefined ? { note: boundedText(body.note, 200, "widget note").trim() } : {}) };
    this.db.all("INSERT INTO umpi_widget VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET data=excluded.data", JSON.stringify(value));
    return value;
  }
  clear(): void { this.db.all("DELETE FROM umpi_widget WHERE id=1"); }
  /** The widget's buttons, in order: the first is the small widget's only button. */
  actions(): WidgetAction[] {
    const row = this.db.all<{ data: string }>("SELECT data FROM umpi_widget WHERE id=2")[0];
    if (!row) return DEFAULT_WIDGET_ACTIONS;
    // The earlier "idea" button is now "voice"; "ideas" is gone.
    const stored = (JSON.parse(row.data) as string[]).map(action => action === "idea" ? "voice" : action)
      .filter((action, index, all): action is WidgetAction => (WIDGET_ACTIONS as readonly string[]).includes(action) && all.indexOf(action) === index);
    return stored.length ? stored : DEFAULT_WIDGET_ACTIONS;
  }
  setActions(value: unknown): WidgetAction[] {
    const actions = parseWidgetActions(value);
    this.db.all("INSERT INTO umpi_widget VALUES (2, ?) ON CONFLICT(id) DO UPDATE SET data=excluded.data", JSON.stringify(actions));
    return actions;
  }
}

/** Open checklist items of a Markdown note, in order. */
export function openTasks(text: string | null): string[] {
  // Widgets show plain text: Markdown marks such as backticks, emphasis, highlights, and wiki-link brackets are removed.
  const plain = (task: string) => task.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, target: string, alias?: string) => alias ?? target).replace(/==|[`*_~]/g, "").trim();
  return (text ?? "").split("\n").map(line => /^\s*[-*+] \[ \] (.+)$/.exec(line)?.[1]).filter((task): task is string => !!task).map(plain).filter(Boolean);
}

export function widgetTools(store: WidgetStore, wake: () => Promise<void>): ToolRegistration[] {
  const result = async (run: () => unknown): Promise<ToolExecutionResult> => {
    try { await wake(); return { content: [{ type: "text", text: JSON.stringify(run()) }] }; }
    catch (error) { return { isError: true, content: [{ type: "text", text: error instanceof InputError || error instanceof StateError ? error.message : "The widget could not be changed." }] }; }
  };
  return [
    defineTool({ name: "set_widget", description: "Choose what the owner's phone widgets show, when something deserves a glance: the one thing to do next, today's key items, what is waiting on them. 1 to 8 items, most important first: a small widget shows the first, a medium one four, a large one eight. Each item: title (short), optional detail, optional SF Symbol name, optional link (chat, today, or work). Lasts `hours` (default 12, at most 48), then the default view returns: open tasks from today's note, the next reminders, and what is waiting. Do not repeat what the default already shows.",
      parameters: Type.Object({
        items: Type.Array(Type.Object({ title: Type.String({ maxLength: 80 }), detail: Type.Optional(Type.String({ maxLength: 120 })), symbol: Type.Optional(Type.String({ maxLength: 40 })),
          link: Type.Optional(Type.Union([Type.Literal("chat"), Type.Literal("today"), Type.Literal("work")])) }, { additionalProperties: false }), { minItems: 1, maxItems: 8 }),
        hours: Type.Optional(Type.Number({ minimum: 0.25, maximum: 48 })), note: Type.Optional(Type.String({ maxLength: 200 })),
      }, { additionalProperties: false }), replay: "safe",
      async execute(input) { return result(() => store.set(input)); } }),
    defineTool({ name: "set_widget_actions", description: `Set the buttons on the owner's phone widget, in order, when they ask to change them: 1 to 4 of ${WIDGET_ACTIONS.join(", ")}. voice records a voice message to Umpi; today, chat, and work open those views; remind opens the chat ready to set a reminder. The first is the small widget's button.`,
      parameters: Type.Object({ actions: Type.Array(Type.Union(WIDGET_ACTIONS.map(action => Type.Literal(action))), { minItems: 1, maxItems: 4 }) }, { additionalProperties: false }), replay: "safe",
      async execute(input) { return result(() => ({ actions: store.setActions(record(input).actions) })); } }),
    defineTool({ name: "clear_widget", description: "Return the owner's phone widgets to the default view (today's open tasks, next reminders, what is waiting).",
      parameters: Type.Object({}, { additionalProperties: false }), replay: "safe",
      async execute() { return result(() => { store.clear(); return { cleared: true }; }); } }),
  ];
}
