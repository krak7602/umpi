/**
 * The executor's outbound wake socket. It carries only "wake" from the coordinator and this client's
 * "ping"; all work still moves through the authenticated poll and report requests. The coordinator's
 * runtime answers "ping" without waking its Durable Object, so an idle connection costs nothing there.
 */
export const WAKE_PING_MS = 60_000;
export const WAKE_PONG_TIMEOUT_MS = 15_000;
/**
 * The runtime answers "ping" even for a socket its object no longer holds, which can happen when a
 * deploy restarts the coordinator just after connecting. So the first keepalive, and every tenth,
 * is "hello", which only the coordinator itself answers with "ready".
 */
export const WAKE_CHECK_EVERY = 10;
const MAX_RECONNECT_MS = 60_000;

export interface WakeSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open" | "message" | "close" | "error", listener: (event: { data?: unknown }) => void): void;
}
export type WakeSocketFactory = (url: string, headers: Record<string, string>) => WakeSocket;

/** Node's WebSocket (undici) accepts request headers, so the executor token never enters the URL. */
const nodeSocket: WakeSocketFactory = (url, headers) => new (WebSocket as unknown as new (url: string, init: { headers: Record<string, string> }) => WakeSocket)(url, { headers });

export interface WakeChannelOptions {
  origin: URL;
  token: string;
  executorId: string;
  onWake(): void;
  onState?(connected: boolean): void;
  connect?: WakeSocketFactory;
  now?(): number;
  random?(): number;
}

export class WakeChannel {
  private socket: WakeSocket | undefined;
  private open = false;
  private stopped = false;
  private attempt = 0;
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private pong: ReturnType<typeof setTimeout> | undefined;
  private pings = 0;

  constructor(private readonly options: WakeChannelOptions) {}

  get connected(): boolean { return this.open; }
  private now(): number { return this.options.now?.() ?? Date.now(); }
  private later(ms: number, run: () => void): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => { this.timers.delete(timer); run(); }, ms);
    this.timers.add(timer);
    return timer;
  }
  private clear(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear(); this.pong = undefined;
  }

  start(): void { this.stopped = false; this.connect(); }
  stop(): void {
    this.stopped = true; this.clear();
    const socket = this.socket; this.socket = undefined;
    this.setOpen(false);
    try { socket?.close(1000, "executor stopping"); } catch { /* Already closed. */ }
  }

  private setOpen(open: boolean): void {
    if (this.open === open) return;
    this.open = open;
    this.options.onState?.(open);
  }

  private connect(): void {
    if (this.stopped) return;
    const url = new URL(`/api/executor/wake?executorId=${encodeURIComponent(this.options.executorId)}`, this.options.origin);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    let socket: WakeSocket;
    try { socket = (this.options.connect ?? nodeSocket)(url.href, { authorization: `Bearer ${this.options.token}` }); }
    catch { this.retry(); return; }
    this.socket = socket;
    socket.addEventListener("open", () => {
      if (socket !== this.socket) return;
      this.attempt = 0; this.pings = 0;
      this.setOpen(true);
      // Anything queued while disconnected is collected now.
      this.options.onWake();
      this.schedulePing();
    });
    socket.addEventListener("message", event => {
      if (socket !== this.socket) return;
      const data = String(event.data);
      if (data === "pong" || data === "ready") { if (this.pong) { clearTimeout(this.pong); this.timers.delete(this.pong); this.pong = undefined; } }
      else if (data === "wake") this.options.onWake();
    });
    const lost = () => {
      if (socket !== this.socket) return;
      this.socket = undefined; this.clear();
      this.setOpen(false);
      this.retry();
    };
    socket.addEventListener("close", lost);
    socket.addEventListener("error", lost);
  }

  private retry(): void {
    if (this.stopped) return;
    const base = Math.min(MAX_RECONNECT_MS, 1_000 * 2 ** this.attempt++);
    this.later(base * (0.5 + (this.options.random?.() ?? Math.random()) / 2), () => this.connect());
  }

  /** Drops the current socket and connects again at once. */
  private reset(): void {
    const socket = this.socket; this.socket = undefined; this.clear();
    this.setOpen(false);
    try { socket?.close(4000, "keepalive lost"); } catch { /* Already closed. */ }
    this.attempt = 0;
    this.connect();
  }

  private schedulePing(): void {
    const expected = this.now() + WAKE_PING_MS;
    this.later(WAKE_PING_MS, () => {
      // A timer that fires far too late means the Mac slept; that socket is probably dead.
      if (this.now() - expected > WAKE_PING_MS) { this.reset(); return; }
      try { this.socket?.send(this.pings++ % WAKE_CHECK_EVERY === 0 ? "hello" : "ping"); } catch { this.reset(); return; }
      this.pong = this.later(WAKE_PONG_TIMEOUT_MS, () => this.reset());
      this.schedulePing();
    });
  }
}
