import { LifecycleCapability } from "agents/lifecycle";
import { isChatSocketUpgrade } from "./transport.js";
import { StateError } from "./store.js";

export const CHAT_SOCKET_TAG = "umpi-chat";
interface ChatAttachment { kind: typeof CHAT_SOCKET_TAG; deviceId: string }

/**
 * A paired phone's live view of the shared conversation. The socket carries {"type":"chat","latest":N} when the
 * conversation grows; the app then reads the new entries through the authenticated chat route. While a spoken reply
 * is written it also carries that reply's text as `speech` frames (see speech-relay.ts). Nothing the app sends is read.
 */
export class ChatSocket extends LifecycleCapability {
  constructor(private readonly options: { authenticate(request: Request): Promise<string>; active(deviceId: string): boolean; latest(): number }) { super("umpi-chat-socket"); }

  private sockets(): WebSocket[] { return [...this.lifecycle.sockets.get(CHAT_SOCKET_TAG)]; }
  private attachment(socket: WebSocket): ChatAttachment | undefined {
    try {
      const value = socket.deserializeAttachment() as ChatAttachment | null;
      return value?.kind === CHAT_SOCKET_TAG ? value : undefined;
    } catch { return undefined; }
  }
  async onWebSocketUpgrade({ request }: { request: Request }): Promise<Response | undefined> {
    if (!isChatSocketUpgrade(request)) return undefined;
    let deviceId: string;
    try { deviceId = await this.options.authenticate(request); }
    catch (error) { return Response.json({ error: error instanceof StateError ? error.message : "Invalid chat socket request" }, { status: error instanceof StateError ? error.status : 401 }); }
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.lifecycle.sockets.accept(server, [CHAT_SOCKET_TAG]);
    server.serializeAttachment({ kind: CHAT_SOCKET_TAG, deviceId } satisfies ChatAttachment);
    try { server.send(JSON.stringify({ type: "chat", latest: this.options.latest() })); } catch { /* The app reconnects. */ }
    return new Response(null, { status: 101, webSocket: client });
  }
  onWebSocketMessage(socket: WebSocket): boolean { return this.attachment(socket) !== undefined; }
  onWebSocketClose(socket: WebSocket): boolean {
    if (!this.attachment(socket)) return false;
    try { socket.close(1000, "closed"); } catch { /* Already closed. */ }
    return true;
  }
  onWebSocketError(socket: WebSocket): boolean { return this.onWebSocketClose(socket); }
  /** Tells every open app the conversation's newest position. */
  changed(latest: number): number {
    let sent = 0;
    for (const socket of this.sockets()) {
      const attachment = this.attachment(socket);
      if (!attachment) continue;
      // A revoked device's socket is closed, not told.
      if (!this.options.active(attachment.deviceId)) { try { socket.close(1008, "revoked"); } catch { /* Already closed. */ } continue; }
      try { socket.send(JSON.stringify({ type: "chat", latest })); sent++; } catch { /* The app reconnects and reads. */ }
    }
    return sent;
  }
  /** Sends a spoken reply's frame to every open app; each app speaks only the replies to its own messages. */
  broadcast(frame: object): number {
    const text = JSON.stringify(frame);
    let sent = 0;
    for (const socket of this.sockets()) {
      const attachment = this.attachment(socket);
      if (!attachment || !this.options.active(attachment.deviceId)) continue;
      try { socket.send(text); sent++; } catch { /* The app falls back to the finished reply in the chat. */ }
    }
    return sent;
  }
  count(): number { return this.sockets().length; }
}
