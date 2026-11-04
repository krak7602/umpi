import { Container } from "@cloudflare/containers";
import { sendPastDrain } from "./tailnet-fetch.js";

/** Longer than the forwarder's own 60-second limit, so the forwarder normally answers first. */
const REQUEST_LIMIT_MS = 90_000;

export interface TailnetBridgeEnvironment { UMPI_TAILSCALE_AUTHKEY?: string }

/**
 * Umpi's door into the owner's tailnet. The container starts on the first request, joins the tailnet as a temporary
 * tag:umpi device with the Tailscale OAuth client secret, forwards HTTPS requests to <name>.<tailnet>.ts.net hosts,
 * and sleeps after five idle minutes; the ephemeral device then leaves the tailnet. Nothing runs on the machines.
 */
export class TailnetBridge extends Container<TailnetBridgeEnvironment> {
  defaultPort = 8080;
  pingEndpoint = "localhost/ready";
  sleepAfter = "5m";
  // It reaches Tailscale's coordination and relay servers; the tailnet policy limits what it can reach inside.
  enableInternet = true;

  constructor(ctx: DurableObjectState<{}>, env: TailnetBridgeEnvironment) {
    super(ctx, env);
    this.envVars = { TS_AUTHKEY: env.UMPI_TAILSCALE_AUTHKEY ?? "" };
  }

  /**
   * The library counts the bridge as busy while any request is open, and a request to an offline machine may never
   * end; Umpi's own 20-second limit does not reach in here. A limit on each request lets the bridge become idle.
   * A request a stopping bridge answered "draining" was not forwarded, so it goes to the next bridge (sendPastDrain).
   */
  override async fetch(request: Request): Promise<Response> {
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(REQUEST_LIMIT_MS)]);
    // Kept, so a request a stopping bridge did not forward can go to the next one.
    const body = request.method === "GET" || request.method === "HEAD" ? null : await request.arrayBuffer();
    return sendPastDrain(() => super.fetch(new Request(request, { body, signal })),
      { running: () => this.ctx.container?.running === true, wait: ms => new Promise(resolve => setTimeout(resolve, ms)), signal });
  }

  /**
   * The bridge keeps nothing, so idle means stop outright. The default only sends a stop signal, and a container
   * that ignores it keeps running (and billing) with the library asking again every five minutes.
   */
  override async onActivityExpired(): Promise<void> {
    if (this.ctx.container?.running) await this.destroy();
  }
}
