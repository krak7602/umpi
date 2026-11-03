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
