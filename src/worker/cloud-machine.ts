import type { R2Bucket } from "@cloudflare/workers-types";
import { Container, type StopParams } from "@cloudflare/containers";
import type { CloudMachineStart } from "./cloud-machines.js";
import { MachineState, type Digest, type MachineBucket, type SaveResult } from "./cloud-machine-state.js";

export interface CloudMachineEnvironment { CODING_ARCHIVE?: R2Bucket }

/**
 * One cloud machine: a container running T3 Code with the Pi agent. Umpi wakes it (restoring saved state from R2),
 * relays MCP to it, and saves it back to R2 before it sleeps. A machine never starts without its state, so plain
 * fetches to a stopped machine are refused instead of starting it empty. A home that was not restored in full is
 * never saved.
 */
export class CloudMachine extends Container<CloudMachineEnvironment> {
  defaultPort = 8080;
  pingEndpoint = "localhost/ready";
  // A safety net only: Umpi saves and stops idle machines itself. If this expires first, the machine is saved.
  sleepAfter = "3h";
  enableInternet = true;

  private bucket(): R2Bucket {
    if (!this.env.CODING_ARCHIVE) throw new Error("No storage for cloud machines is configured");
    return this.env.CODING_ARCHIVE;
  }

  /**
   * The rules for saved state live in `MachineState`, which tests run without a Durable Object. Its requests go
   * straight to the control port: `containerFetch` would start a stopped container, and an empty home must never be
   * packed or started in place of the saved one.
   */
  private readonly machine = new MachineState({
    storage: this.ctx.storage,
    container: {
      running: () => this.ctx.container?.running === true,
      start: async () => { await this.startAndWaitForPorts({ ports: 8080, cancellationOptions: { portReadyTimeoutMS: 180_000 } }); },
      fetch: async request => {
        if (!this.ctx.container?.running) throw new Error("The machine is not running");
        this.renewActivityTimeout();
        return this.ctx.container.getTcpPort(8080).fetch(request.url, request as never) as unknown as Response;
      },
      destroy: () => this.destroy(),
    },
    bucket: () => this.bucket() as unknown as MachineBucket,
    digest: sha256,
  });

  /** Starts the machine and T3 Code, restoring saved state first; returns Umpi's MCP token for this run. */
  async wake(start: CloudMachineStart, snapshotKey: string, expect?: { saved?: boolean }): Promise<{ token: string; restored: boolean }> {
    return this.machine.wake(start, snapshotKey, expect);
  }

  /** Packs the machine's state into R2 as a new saved state and stops it. See `MachineState.save`. */
  async save(): Promise<SaveResult> { return this.machine.save(); }

  /** For status: the current saved state, and whether the home is the whole of it. */
  async report(): Promise<Awaited<ReturnType<MachineState["report"]>>> { return this.machine.report(); }

  /** Lets the owner's T3 Code apps reach this machine at its public address (and no other). */
  async publish(hostname: string): Promise<void> { await this.ctx.storage.put("publicHost", hostname); }

  /** A one-time pairing link for the owner's T3 Code app, valid 15 minutes. */
  async pairing(baseUrl: string): Promise<{ pairUrl: string; expiresAt?: string }> {
    if (!this.ctx.container?.running) throw new Error("The machine is asleep");
    const response = await this.containerFetch(new Request("http://machine/pairing", { method: "POST", body: JSON.stringify({ baseUrl }), headers: { "content-type": "application/json" } }), 8080);
    const body = await response.json() as { pairUrl?: string; expiresAt?: string; error?: string };
    if (!response.ok || !body.pairUrl) throw new Error(body.error ?? `No pairing link was issued (${response.status})`);
    return { pairUrl: body.pairUrl, ...(body.expiresAt ? { expiresAt: body.expiresAt } : {}) };
  }

  /** Whether the owner's app is connected now: open sockets, and when the app last sent anything. */
  inUse(): { sockets: number; appAt: number } { return { sockets: this.sockets, appAt: this.appAt }; }
  private sockets = 0;
  private appAt = 0;

  /**
   * The owner's T3 Code app, at the machine's public address: straight to T3 Code (port 3773), never to the control
   * port. T3 Code asks every client for its own pairing. A sleeping machine is not woken from outside: its address is
   * public, so only the owner wakes it, from Umpi.
   */
  private async publicFetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (await this.ctx.storage.get<string>("publicHost") !== url.hostname) return new Response("Not found", { status: 404 });
    if (!this.ctx.container?.running) return new Response("This cloud machine is asleep. Wake it from Umpi (Work, or ask in the chat), then try again.", { status: 503, headers: { "content-type": "text/plain; charset=utf-8", "retry-after": "30" } });
    this.appAt = Date.now();
    const headers = new Headers(request.headers);
    headers.set("x-forwarded-proto", "https"); headers.set("x-forwarded-host", url.host);
    const response = await this.containerFetch(new Request(request, { headers }), 3773);
    const upstream = response.webSocket;
    if (!upstream) return response;
    // Its own relay, so the app's connection is counted apart from Umpi's own reads.
    const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket];
    upstream.accept(); server.accept();
    this.sockets++;
    let open = true;
    const end = (code: number, reason: string) => {
      if (open) { open = false; this.sockets--; }
      const safe = code === 1005 || code === 1006 ? 1000 : code;
      for (const socket of [upstream, server]) { try { socket.close(safe, reason); } catch { /* already closed */ } }
    };
    server.addEventListener("message", event => { this.appAt = Date.now(); try { upstream.send(event.data as string | ArrayBuffer); } catch { end(1011, "upstream"); } });
    upstream.addEventListener("message", event => { try { server.send(event.data as string | ArrayBuffer); } catch { end(1011, "client"); } });
    server.addEventListener("close", event => end(event.code, event.reason));
    upstream.addEventListener("close", event => end(event.code, event.reason));
    server.addEventListener("error", () => end(1011, "client error"));
    upstream.addEventListener("error", () => end(1011, "upstream error"));
    return new Response(null, { status: 101, webSocket: client });
  }

  /** Stops the machine without saving and deletes its saved states, before it is deleted. */
  async discard(): Promise<void> { await this.machine.discard(); }

  isRunning(): boolean { return this.ctx.container?.running === true; }

  /** Whether the container answers on its control port, asked directly, so nothing is started. */
  async reachable(): Promise<boolean> {
    try { return (await this.ctx.container!.getTcpPort(8080).fetch("http://machine/ready", { signal: AbortSignal.timeout(5_000) })).ok; }
    catch { return false; }
  }

  /** Sends the stop signal a rollout or platform restart sends, to check that the machine is saved first. */
  async signalStop(): Promise<void> { if (this.ctx.container?.running) await this.stop(15); }

  override onStop(params: StopParams): void {
    console.log(JSON.stringify({ event: "cloud-machine-stopped", exitCode: params.exitCode, reason: params.reason }));
  }

  /** Running, and whether it is stopping (it got a stop signal and waits for Umpi to save it). */
  async condition(): Promise<{ running: boolean; stopping: boolean }> {
    if (!this.ctx.container?.running) return { running: false, stopping: false };
    try {
      const response = await this.containerFetch(new Request("http://machine/ready"), 8080);
      const body = await response.json() as { stopping?: boolean };
      return { running: true, stopping: body.stopping === true };
    } catch { return { running: true, stopping: false }; }
  }

  /** MCP relay to T3 Code for Umpi (host `machine`), or the owner's app at the public address. */
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.hostname !== "machine") return this.publicFetch(request);
    const path = url.pathname;
    if (!path.startsWith("/t3/")) return new Response("Not found", { status: 404 });
    if (!this.ctx.container?.running) return Response.json({ error: "machine_asleep" }, { status: 503 });
    this.renewActivityTimeout();
    return this.containerFetch(request, 8080);
  }

  /** The library calls this again after each further `sleepAfter`, so a machine it could not save is tried again. */
  override async onActivityExpired(): Promise<void> {
    console.log(JSON.stringify({ event: "cloud-machine-expired", outcome: await this.machine.expired() }));
  }
}

/** A running SHA-256 from the runtime's `crypto.DigestStream`; undefined where that does not exist. */
function sha256(): Digest | undefined {
  const Stream = (crypto as unknown as { DigestStream?: new (algorithm: string) => WritableStream<Uint8Array> & { digest: Promise<ArrayBuffer> } }).DigestStream;
  if (!Stream) return undefined;
  const stream = new Stream("SHA-256"), writer = stream.getWriter();
  return {
    update: chunk => writer.write(chunk),
    hex: async () => { await writer.close(); return [...new Uint8Array(await stream.digest)].map(byte => byte.toString(16).padStart(2, "0")).join(""); },
  };
}
