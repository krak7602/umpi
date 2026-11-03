import type { ToolRegistration } from "@earendil-works/pi-durable";
import { InputError } from "../shared/protocol.js";
import { StateError } from "./store.js";
import { ProactiveStore } from "./proactive-store.js";

/** Foreground tools a background review may use; everything else is left out of its tool list. */
export const backgroundTools = new Set([
  "current_time", "list_reminders", "job_status", "read_core_context", "read_core_context_history", "read_companion_state", "request_mac_command",
  "decide", "extract_fields",
  // T3 Code: reading is harmless; an action Umpi decides on is only requested, and the owner approves it.
  "t3_code_threads", "t3_code_read_thread", "t3_code_search", "t3_code_questions", "request_t3_action", "cloud_machines",
]);

/** A timer is not permission to ring a phone, edit memory or mutate unrelated app state. */
/** `extra` widens the list for one review, such as web search and history for the nightly run. */
export function guardBackgroundTools(tools: ToolRegistration[], proactive: ProactiveStore, extra: (sessionId: string, tool: string) => boolean = () => false): ToolRegistration[] {
  return tools.map(tool => ({ ...tool, async execute(args, api, context) {
    if (proactive.owner.isBackgroundSession(String(api.conversationId))) {
      try {
        proactive.assertRunCurrent(String(api.conversationId));
        if (proactive.owner.hasForegroundInput()) throw new StateError(409, "Foreground work takes priority. Defer this review; do not repeat actions.");
        if (!backgroundTools.has(tool.name) && !extra(String(api.conversationId), tool.name)) throw new StateError(403, "This background review does not authorize that action. Record the blocker; request explicit owner action if needed.");
        if ((tool.name === "request_mac_command" || tool.name === "request_t3_action") && !proactive.mayInterrupt(String(api.conversationId))) throw new StateError(403, "Command approval would interrupt the owner. This review is silent or within quiet hours; defer it instead.");
      } catch (error) {
        return { isError: true, content: [{ type: "text" as const, text: error instanceof StateError || error instanceof InputError ? error.message : "Background review is no longer actionable. Stop this turn." }] };
      }
    }
    return tool.execute(args, api, context);
  } }));
}
