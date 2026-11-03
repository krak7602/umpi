export type CompanionRole = "control" | "device" | "pair";
/** Exact methods and bounded path segments only; prefixes never grant an authentication exemption. */
export function companionRole(path: string, method: string): CompanionRole | undefined {
  if (method === "POST" && path === "/api/device/pair") return "pair";
  if ((method === "GET" && path === "/api/companion/state") ||
      (method === "POST" && ["/api/companion/pairings", "/api/companion/changes", "/api/companion/actions"].includes(path)) ||
      (method === "DELETE" && /^\/api\/companion\/devices\/[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(path))) return "control";
  if ((method === "GET" && ["/api/device/state", "/api/device/chat", "/api/device/chat/settings", "/api/device/chat/socket", "/api/device/today", "/api/device/widget", "/api/device/ideas"].includes(path)) || (method === "PUT" && ["/api/device/chat/settings", "/api/device/widget/actions"].includes(path)) ||
      (method === "DELETE" && path === "/api/device/session") ||
      (method === "POST" && (["/api/device/register", "/api/device/changes", "/api/device/actions", "/api/device/messages", "/api/device/chat/press", "/api/device/chat/test-alert", "/api/device/ideas", "/api/device/knocks", "/api/device/today/task"].includes(path) ||
        /^\/api\/device\/reminders\/[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}\/answer$/.test(path) ||
        /^\/api\/device\/actions\/[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}\/ack$/.test(path) ||
        /^\/api\/device\/jobs\/[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}\/(approve|cancel)$/.test(path) ||
        /^\/api\/device\/choices\/[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}\/answer$/.test(path)))) return "device";
  return undefined;
}
