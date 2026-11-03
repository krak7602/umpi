import { Container } from "@cloudflare/containers";

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
}
