import type { ToolRegistration } from "@earendil-works/pi-durable";
import { InputError } from "../shared/protocol.js";
import { StateError } from "./store.js";
import { ProactiveStore } from "./proactive-store.js";

const backgroundTools = new Set([
  "current_time", "list_reminders", "job_status", "read_core_context", "read_core_context_history", "read_companion_state", "request_mac_command",
]);

/** A timer is not permission to ring a phone, edit memory or mutate unrelated app state. */
export function guardBackgroundTools(tools: ToolRegistration[], proactive: ProactiveStore): ToolRegistration[] {
  return tools.map(tool => ({ ...tool, async execute(args, api, context) {
    if (proactive.owner.isBackgroundSession(String(api.conversationId))) {
      try {
        proactive.assertRunCurrent(String(api.conversationId));
        if (proactive.owner.hasForegroundInput()) throw new StateError(409, "Foreground work takes priority. Defer this review; do not repeat actions.");
        if (!backgroundTools.has(tool.name)) throw new StateError(403, "This background review does not authorize that action. Record the blocker; request explicit owner action if needed.");
        if (tool.name === "request_mac_command" && !proactive.mayInterrupt(String(api.conversationId))) throw new StateError(403, "Command approval would interrupt the owner. This review is silent or within quiet hours; defer it instead.");
      } catch (error) {
        return { isError: true, content: [{ type: "text" as const, text: error instanceof StateError || error instanceof InputError ? error.message : "Background review is no longer actionable. Stop this turn." }] };
      }
    }
    return tool.execute(args, api, context);
  } }));
}
