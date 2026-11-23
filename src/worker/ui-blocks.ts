import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolExecutionResult, type ToolRegistration } from "@earendil-works/pi-durable";
import type { ChatLog } from "./chat.js";
import { StateError, type Store } from "./store.js";
import { UI_LIMITS, UI_TONES, uiCatalogText, validateUiSpec } from "./ui-spec.js";

/**
 * `show_ui`: Umpi adds a UI block to the reply it is writing. The block is checked against the catalog in
 * `ui-spec.ts`, kept for the running turn, and written into the reply's chat entry, where the apps draw it under the
 * text with native components.
 *
 * What a block cannot do is the point of the checks here. It holds no code action: Approve and Decline exist only on
 * cards that code writes from a stored request. A link or an open button takes only an address the conversation
 * already has (a search result, a page link, or the owner's own), like `read_web_page`, so a block cannot carry
 * private text out in an address the owner taps. A send button sends its own label, so the owner sends exactly the
 * words they see.
 */
export interface UiToolOptions {
  /** Throws for a conversation that may not show UI (background reviews, subagents). */
  foreground(conversationId: string): void;
  /** True when this address (in comparison form) is already readable in the conversation. */
  known(url: string, conversationId: string): Promise<boolean>;
}

export const UI_INSTRUCTIONS = `UI blocks: show_ui adds native components under your reply in the apps. Use it when a layout says it better than prose: a comparison, a schedule or timeline, a status with numbers, a checklist, options to choose from, or values over time. Do not use it for an answer that is one or two sentences. Compose from the low-level components; there are no ready-made cards. The layout adapts by itself: a horizontal stack of buttons, badges, or links wraps as whole items, a grid uses fewer columns on a narrow screen, a label and a long value stack, and a wide table scrolls. So do not design for one screen size. Keep a button or badge label to a few words and put explanation in text.
Your reply text must stand without the block: voice, notifications, and Telegram show the text only. Put the conclusion in the text and the detail in the block, and do not repeat the block's content in the text.
A send button sends its label as the owner's next message, so offer choices with it and write each label as the words the owner would say. Never draw Approve, Decline, or anything that looks like an approval card: actions that need approval go through their request tools, which show their own cards. Up to ${UI_LIMITS.blocks} blocks for one reply.`;

function result(run: () => Promise<unknown>): Promise<ToolExecutionResult> {
  return run().then(value => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }] }),
    error => ({ isError: true, content: [{ type: "text" as const, text: error instanceof StateError ? error.message : "The block could not be shown. Say what you wanted to show in text." }] }));
}

export function uiTools(store: Store, chat: ChatLog, options: UiToolOptions): ToolRegistration[] {
  return [
    defineTool({ name: "show_ui", description: `Add one UI block under the reply you are writing. spec is one component: an object with a type and that type's properties; containers take children. A property with ? is optional. tone is one of ${UI_TONES.join(", ")}; align is start, center, or end; icon and name take an SF Symbol name. At most ${UI_LIMITS.nodes} components, ${UI_LIMITS.depth} levels deep. A url must be one web_search returned, a link on a page you read, or one the owner wrote.\n${uiCatalogText()}\nExample: {"type":"card","title":"Trains to the coast","children":[{"type":"table","columns":[{"title":"Leaves"},{"title":"Arrives"},{"title":"Fare","align":"end"}],"rows":[["07:10","09:25","420"],["09:40","11:50","380"]]},{"type":"button","label":"Remind me at 6:30 for the 07:10","action":"send"}]}`,
      parameters: Type.Object({ spec: Type.Record(Type.String(), Type.Unknown(), { description: "The root component" }) }, { additionalProperties: false }), replay: "unsafe",
      async execute(input, api) { return result(async () => {
        const conversationId = String(api.conversationId);
        options.foreground(conversationId);
        const turn = store.turnInFlight(conversationId);
        if (!turn) throw new StateError(409, "No reply is being written in this conversation, so there is nothing to attach a block to.");
        const checked = validateUiSpec(input.spec);
        if (!checked.ok) throw new StateError(400, `The block does not fit the format. Fix these and call show_ui again:\n${checked.errors.join("\n")}`);
        const unknown: string[] = [];
        for (const url of checked.urls) if (!await options.known(url, conversationId)) unknown.push(url);
        if (unknown.length) throw new StateError(403, `Not shown: ${unknown.join(", ")}. A block takes an address only when web_search returned it in this conversation, when it is a link on a page read here, or when the owner wrote it. Leave the link out, or ask for it with request_web_links first.`);
        const position = chat.attachUi(turn.id, checked.spec, UI_LIMITS.blocks);
        if (position === undefined) throw new StateError(409, `This reply already has ${UI_LIMITS.blocks} blocks. Put the rest in text.`);
        return { shown: true, position, note: "The block appears under your reply. Write the reply text now; it must stand without the block." };
      }); } }),
  ];
}
