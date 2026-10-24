import { LifecycleCapability } from "agents/lifecycle";
import { identifier } from "../shared/protocol.js";
import { isExecutorWakeUpgrade } from "./transport.js";
import { StateError } from "./store.js";
import { EXECUTOR_WAKE_TAG, WAKE_SOCKET_STALE_MS, type ExecutorPresence } from "./executor-presence.js";

interface WakeAttachment { kind: typeof EXECUTOR_WAKE_TAG; executorId: string; connectedAt: number }

/**
 * Owns the executor's hibernatable wake socket. The socket carries only "wake"; all work still moves
 * through the authenticated poll and report routes. The Mac's "ping" is answered by the runtime.
 */
export class ExecutorWake extends LifecycleCapability {
  constructor(private readonly options: {
    presence: ExecutorPresence;
    authorize(request: Request): Promise<void>;
    pingAt(socket: WebSocket): Date | null;
  }) { super("umpi-executor-wake"); }

  private sockets(): WebSocket[] { return [...this.lifecycle.sockets.get(EXECUTOR_WAKE_TAG)]; }
  private attachment(socket: WebSocket): WakeAttachment | undefined {
    try {
      const value = socket.deserializeAttachment() as WakeAttachment | null;
      return value?.kind === EXECUTOR_WAKE_TAG ? value : undefined;
    } catch { return undefined; }
  }

  async onWebSocketUpgrade({ request }: { request: Request }): Promise<Response | undefined> {
    if (!isExecutorWakeUpgrade(request)) return undefined;
    let executorId: string;
    try {
      await this.options.authorize(request);
      executorId = identifier(new URL(request.url).searchParams.get("executorId"), "executor ID");
    } catch (error) {
      return Response.json({ error: error instanceof StateError ? error.message : "Invalid executor wake request" }, { status: error instanceof StateError ? error.status : 400 });
    }
    // A reconnecting executor replaces its earlier socket; a half-open one would otherwise linger.
    for (const socket of this.sockets()) {
      if (this.attachment(socket)?.executorId === executorId) try { socket.close(1000, "replaced"); } catch { /* Already closed. */ }
    }
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.lifecycle.sockets.accept(server, [EXECUTOR_WAKE_TAG]);
    const now = Date.now();
    server.serializeAttachment({ kind: EXECUTOR_WAKE_TAG, executorId, connectedAt: now } satisfies WakeAttachment);
    this.options.presence.connected(now);
    return new Response(null, { status: 101, webSocket: client });
  }
  onWebSocketMessage(socket: WebSocket, message: string | ArrayBuffer): boolean {
    if (!this.attachment(socket)) return false;
    // "ping" is answered by the runtime. "hello" proves this object still holds the socket.
    if (message === "hello") try { socket.send("ready"); } catch { /* The executor reconnects. */ }
    return true;
  }
  onWebSocketClose(socket: WebSocket): boolean {
    if (!this.attachment(socket)) return false;
    this.options.presence.disconnected();
    try { socket.close(1000, "closed"); } catch { /* Already closed. */ }
    return true;
  }
  onWebSocketError(socket: WebSocket): boolean { return this.onWebSocketClose(socket); }

  /** Live sockets have pinged recently. Stale ones are closed. */
  live(now = Date.now()): WebSocket[] {
    return this.sockets().filter(socket => {
      const attachment = this.attachment(socket);
      if (!attachment) return false;
      const last = Math.max(attachment.connectedAt, this.options.pingAt(socket)?.getTime() ?? 0);
      if (now - last < WAKE_SOCKET_STALE_MS) return true;
      try { socket.close(1001, "stale"); } catch { /* Already closed. */ }
      return false;
    });
  }
  /** Sends "wake" when the demand has a new item. */
  wake(demand: readonly string[]): number {
    if (!this.options.presence.shouldWake(demand)) return 0;
    let sent = 0;
    for (const socket of this.live()) {
      try { socket.send("wake"); sent++; } catch { /* The executor reconnects and polls. */ }
    }
    return sent;
  }
}
