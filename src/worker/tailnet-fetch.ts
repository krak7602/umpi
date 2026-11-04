/** Routing for the tailnet bridge, kept apart from the container class so it loads outside Workers. */
const TAILNET_HOST = /^[a-z0-9-]{1,63}\.[a-z0-9-]{1,63}\.ts\.net$/i;
export function isTailnetUrl(url: URL): boolean { return url.protocol === "https:" && TAILNET_HOST.test(url.hostname); }

/**
 * A fetch that sends tailnet addresses through the bridge and everything else directly. The target travels in a
 * header; the container checks it again.
 */
export function tailnetFetch(bridge: (() => { fetch(request: Request): Promise<Response> }) | undefined, direct: typeof fetch = (input, init) => fetch(input, init)): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (!isTailnetUrl(url)) return direct(request);
    if (!bridge) throw new Error("This address is in a tailnet, and Umpi's tailnet bridge is not configured");
    const headers = new Headers(request.headers);
    headers.set("x-umpi-target", url.href);
    const body = request.method === "GET" || request.method === "HEAD" ? null : await request.arrayBuffer();
    return bridge().fetch(new Request("http://bridge/forward", { method: request.method, headers, body, signal: request.signal }));
  };
}

/**
 * Routes Umpi's own cloud machines (<id>.cloud.umpi.internal) to their Durable Object, which relays MCP into the
 * container; everything else goes to `next`.
 */
export function cloudFetch(machine: ((id: string) => { fetch(request: Request): Promise<Response> }) | undefined, next: typeof fetch): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const id = /^(cloud-[a-z0-9]{6,20})\.cloud\.umpi\.internal$/.exec(url.hostname)?.[1];
    if (!id) return next(request);
    if (!machine) throw new Error("Cloud machines are not configured");
    const body = request.method === "GET" || request.method === "HEAD" ? null : await request.arrayBuffer();
    return machine(id).fetch(new Request(`http://machine/t3${url.pathname}${url.search}`, { method: request.method, headers: request.headers, body, signal: request.signal }));
  };
}

/** The forwarder's answer to a request it did not forward because it is shutting down. */
export const BRIDGE_DRAINING = "draining";

/**
 * Sends one request to the bridge, past a shutdown. A stopping bridge (a deploy replaces it) finishes what it is
 * forwarding and answers anything new with "draining" without forwarding it. Such a request never reached the tailnet,
 * so it is safe to send again, even when it acts: once the old container has exited, it goes to a fresh one. A request
 * that fails any other way may have been delivered and is never sent again.
 */
export async function sendPastDrain(send: () => Promise<Response>, bridge: { running(): boolean; wait(ms: number): Promise<void>; signal?: AbortSignal }, limitMs = 75_000): Promise<Response> {
  const first = await send();
  if (first.headers.get("x-umpi-bridge") !== BRIDGE_DRAINING) return first;
  const until = Date.now() + limitMs;
  while (bridge.running() && Date.now() < until && !bridge.signal?.aborted) await bridge.wait(250);
  if (bridge.running()) return first;
  await first.body?.cancel();
  return send();
}
