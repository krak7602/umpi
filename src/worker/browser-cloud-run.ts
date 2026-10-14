/// <reference lib="dom" />
import type { Browser, BrowserContext, ElementHandle, JSHandle, Page } from "@cloudflare/playwright";
import { browserCookieAllowed, browserDisplayUrl, browserOperationPrefix, browserPublicUrl, browserSitePolicyJson, browserUrl, MAX_BROWSER_IMAGE_BYTES, MAX_BROWSER_OBSERVATION_BYTES, MAX_BROWSER_OPERATIONS, MAX_BROWSER_TIMEOUT_MS, parseBrowserAssignment, parseBrowserRequest } from "../shared/browser.js";
import type { BrowserAssignment, BrowserAuthentication, BrowserObservation, BrowserReceipt, BrowserRequest, BrowserSite, BrowserStopped } from "../shared/browser.js";

export interface BrowserCloudClient {
  startRun(assignment: BrowserAssignment, authentication: { siteId: string; state: BrowserAuthentication }[]): Promise<void>;
  invoke(request: BrowserRequest): Promise<BrowserReceipt>;
  inspect(operationId: string): Promise<BrowserReceipt>;
  activity(): Promise<void>;
  stopRun(): Promise<BrowserStopped>;
}
export interface BrowserCloudStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  list<T>(prefix: string): Promise<Map<string, T>>;
}
/** Production uses the BROWSER binding only. Local verification supplies an actual Chromium browser. */
export interface BrowserSessionFactory {
  launch(allowedDomains: string[] | undefined): Promise<{ browser: Browser; sessionId: string }>;
  exists(sessionId: string): Promise<boolean>;
  close(sessionId: string, browser?: Browser): Promise<void>;
}
export interface BrowserCloudOptions {
  storage: BrowserCloudStorage;
  sessions: BrowserSessionFactory;
  scheduleDeadline(deadline: Date): Promise<void>;
  now?: () => number;
  /** Only for isolated loopback fixture installations; the hosted wrapper never sets this. */
  allowLoopback?: boolean;
}
interface Owner {
  assignment: BrowserAssignment;
  actor: string;
  phase: "launching" | "active" | "uncertain" | "stopping" | "stopped";
  sessionId?: string;
  lastActivity: number;
  unknownSession: boolean;
}
interface Journal { digest: string; status: BrowserReceipt["status"]; parts?: number; error?: string }
interface KeyFence { node: HTMLElement; key: string; rejected: boolean; seen: boolean; result: Promise<boolean>; resolve(value: boolean): void; cleanup(): void }
interface KeyboardBridge { arm(token: string, guard: (event: KeyboardEvent) => void): void; disarm(token: string): void }
interface PageSnapshot {
  nodes: Element[];
  document: Document;
  changed: boolean;
  tree: string;
  title: string;
  overflow: boolean;
  observer: MutationObserver;
  keyboard: KeyboardBridge;
  keyboardToken: string;
  fresh(node: Element): boolean;
  credential(node: Element): boolean;
  keyFence?: KeyFence;
}
interface View { page: Page; context: BrowserContext; fenceKey: string; fenceToken: string; snapshotId?: string; snapshot?: JSHandle<PageSnapshot>; refs: Map<string, ElementHandle> }
const OWNER = "browser-owner", OP = "browser-operation:", CHUNK = "browser-receipt:";
const IDLE_MS = 60_000;
const encoder = new TextEncoder();
async function digest(value: string): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value))), byte => byte.toString(16).padStart(2, "0")).join("");
}
function safeHost(host: string): boolean {
  return !/^(?:\d+\.)*\d+$/.test(host) && !host.includes(":") && host !== "localhost" && !host.endsWith(".localhost") && !host.endsWith(".local") && host.includes(".");
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
/** One immutable task/run per durable object; eviction fences execution instead of recovering it. */
export class BrowserCloudRun implements BrowserCloudClient {
  private readonly actor = crypto.randomUUID();
  private readonly now: () => number;
  private gate: Promise<void> = Promise.resolve();
  private browser?: Browser;
  private sessionId?: string;
  private readonly views = new Map<string, View>();
  private dispatching?: string;
  private launching = false;
  constructor(private readonly options: BrowserCloudOptions) { this.now = options.now ?? Date.now; }
  private async locked<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.gate;
    const { promise, resolve: release } = Promise.withResolvers<void>();
    this.gate = promise;
    await previous;
    try { return await fn(); } finally { release(); }
  }
  private async owner(): Promise<Owner | undefined> {
    const owner = await this.options.storage.get<Owner>(OWNER);
    if (owner && owner.actor !== this.actor && (owner.phase === "active" || owner.phase === "launching")) {
      owner.phase = "uncertain"; await this.writeOwner(owner);
    }
    return owner;
  }
  private async writeOwner(owner: Owner): Promise<void> { await this.options.storage.put(OWNER, owner); }
  private async bounded<T>(pending: Promise<T>, milliseconds = 10_000): Promise<T> {
    const timeout = Promise.withResolvers<never>();
    const timer = setTimeout(() => timeout.reject(new Error("Browser provider transport deadline expired")), Math.max(1, milliseconds));
    try { return await Promise.race([pending, timeout.promise]); } finally { clearTimeout(timer); }
  }
  private async active(): Promise<Owner> {
    const owner = await this.owner();
    if (!owner || owner.phase !== "active" || owner.actor !== this.actor || !this.browser) throw new Error("Browser session was lost or no longer admits work; automatic restart is forbidden");
    if (this.now() >= Date.parse(owner.assignment.deadlineAt) || this.now() >= owner.lastActivity + IDLE_MS) throw new Error("Browser lease expired");
    try {
      if (!await this.bounded(this.options.sessions.exists(owner.sessionId!), Math.min(10_000, Date.parse(owner.assignment.deadlineAt) - this.now(), owner.lastActivity + IDLE_MS - this.now()))) throw new Error("Owned browser session was lost");
    } catch {
      owner.phase = "uncertain"; await this.writeOwner(owner);
      throw new Error("Owned browser session was lost or its transport became uncertain");
    }
    if (this.now() >= Date.parse(owner.assignment.deadlineAt) || this.now() >= owner.lastActivity + IDLE_MS) throw new Error("Browser lease expired");
    return owner;
  }
  private async schedule(owner: Owner): Promise<void> {
    await this.options.scheduleDeadline(new Date(Math.min(Date.parse(owner.assignment.deadlineAt), owner.lastActivity + IDLE_MS)));
  }
  async startRun(input: BrowserAssignment, authentication: { siteId: string; state: BrowserAuthentication }[]): Promise<void> {
    const assignment = parseBrowserAssignment(input, this.options.allowLoopback);
    const deadline = Date.parse(assignment.deadlineAt);
    if (deadline <= this.now() || deadline > this.now() + MAX_BROWSER_TIMEOUT_MS) throw new Error("Invalid browser deadline");
    const domains = new Set<string>();
    const publicResources = assignment.sites.some(scope => scope.site.resources === "public");
    for (const { site } of assignment.sites) {
      if (await digest(browserSitePolicyJson(site)) !== site.policyDigest) throw new Error("Browser site policy digest mismatch");
      for (const origin of site.origins) domains.add(new URL(origin).hostname);
      for (const host of site.resourceHosts) domains.add(host);
      if (site.domain) { domains.add(site.domain); domains.add(`*.${site.domain}`); }
    }
    if ((!publicResources && domains.size > 50) || (!this.options.allowLoopback && [...domains].some(host => !safeHost(host)))) throw new Error("Browser network policy exceeds provider bounds or includes private hosts");
    if (!Array.isArray(authentication) || authentication.length !== assignment.sites.length) throw new Error("Authentication must match exactly the selected sites");
    const authenticated = new Set<string>();
    for (const item of authentication as unknown[]) {
      if (!record(item) || typeof item.siteId !== "string" || authenticated.has(item.siteId) || !record(item.state)) throw new Error("Invalid selected site authentication");
      authenticated.add(item.siteId);
      const site = assignment.sites.find(scope => scope.site.siteId === item.siteId)?.site;
      if (!site || item.state.version !== 1 || !Array.isArray(item.state.cookies) || item.state.cookies.length > 2048) throw new Error("Invalid selected site authentication");
      if (encoder.encode(JSON.stringify(item.state)).byteLength > 2 * 1024 * 1024) throw new Error("Browser authentication exceeds its byte bound");
      for (const cookie of item.state.cookies as unknown[]) {
        if (!record(cookie) || Object.keys(cookie).some(key => !["name", "value", "domain", "path", "expires", "secure", "httpOnly", "sameSite", "partitionKey"].includes(key))
          || typeof cookie.name !== "string" || typeof cookie.domain !== "string" || typeof cookie.value !== "string" || typeof cookie.path !== "string" || !cookie.path.startsWith("/")
          || typeof cookie.expires !== "number" || !Number.isFinite(cookie.expires) || typeof cookie.secure !== "boolean" || typeof cookie.httpOnly !== "boolean"
          || (cookie.sameSite !== undefined && (typeof cookie.sameSite !== "string" || !["Strict", "Lax", "None"].includes(cookie.sameSite)))
          || (cookie.partitionKey !== undefined && typeof cookie.partitionKey !== "string")
          || !browserCookieAllowed(cookie.name, cookie.domain, site)) throw new Error("Authentication is outside the approved cookie policy");
        if (cookie.partitionKey !== undefined && new URL(browserUrl(cookie.partitionKey, site.origins, this.options.allowLoopback, site.domain)).origin !== cookie.partitionKey) throw new Error("Cookie partition is outside the selected site");
      }
    }
    await this.locked(async () => {
      if (await this.options.storage.get<boolean>("browser-prestart-stop")) throw new Error("Browser run was stopped before startup");
      const previous = await this.owner();
      if (previous) {
        if (JSON.stringify(previous.assignment) !== JSON.stringify(assignment)) throw new Error("Browser owner is immutable");
        if (previous.phase === "active" && previous.actor === this.actor && this.browser) { await this.active(); return; }
        throw new Error("Browser start is already admitted or stopped; reimport is forbidden");
      }
      if (this.launching) throw new Error("Browser launch is already admitted");
      this.launching = true;
      await this.writeOwner({ assignment, actor: this.actor, phase: "launching", lastActivity: this.now(), unknownSession: false });
      await this.options.scheduleDeadline(new Date(Math.min(deadline, this.now() + IDLE_MS)));
    });
    // A successful duplicate active start does not import new authentication or allocate.
    const admitted = await this.owner();
    if (admitted?.phase === "active") return;
    try {
      let launch!: Promise<{ browser: Browser; sessionId: string }>;
      await this.locked(async () => {
        const owner = await this.owner();
        if (owner?.phase !== "launching" || owner.actor !== this.actor || this.now() >= deadline || this.now() >= owner.lastActivity + IDLE_MS) throw new Error("Browser launch was cancelled or expired");
        owner.unknownSession = true; await this.writeOwner(owner);
        launch = this.options.sessions.launch(publicResources ? undefined : [...domains]);
      });
      const launched = await launch;
      this.browser = launched.browser; this.sessionId = launched.sessionId;
      await this.locked(async () => {
        const owner = await this.owner();
        if (!owner || owner.actor !== this.actor) throw new Error("Browser launch ownership was lost");
        owner.sessionId = launched.sessionId; owner.unknownSession = false;
        await this.writeOwner(owner);
        if (owner.phase !== "launching") throw new Error("Browser launch was cancelled");
      });
      for (const scope of assignment.sites) {
        const owner = await this.owner();
        if (owner?.phase !== "launching" || this.now() >= deadline || this.now() >= owner.lastActivity + IDLE_MS) throw new Error("Browser startup lease expired or cancelled");
        const context = await launched.browser.newContext({ serviceWorkers: "block", acceptDownloads: false, viewport: { width: 1280, height: 800 } });
        const view: View = { context, fenceKey: `__umpi_keyboard_${crypto.randomUUID()}`, fenceToken: crypto.randomUUID(), page: undefined as unknown as Page, refs: new Map() };
        this.views.set(scope.site.siteId, view);
        context.setDefaultTimeout(Math.min(10_000, deadline - this.now()));
        // Register before site scripts, so the generation fence precedes site capture
        // handlers as well as target handlers. Only our fixed callback is armed.
        await context.addInitScript(({ key, token }) => {
          let guard: ((event: KeyboardEvent) => void) | undefined;
          // The page may discover the broker, but cannot replace it or arm/disarm
          // it without the token retained only by our trusted execution closure.
          const bridge: KeyboardBridge = Object.freeze({
            arm(candidate: string, callback: (event: KeyboardEvent) => void) { if (candidate === token) guard = callback; },
            disarm(candidate: string) { if (candidate === token) guard = undefined; },
          });
          for (const kind of ["keydown", "keypress", "keyup"]) window.addEventListener(kind, event => guard?.(event as KeyboardEvent), true);
          Object.defineProperty(window, key, { value: bridge, configurable: false, writable: false });
        }, { key: view.fenceKey, token: view.fenceToken });
        const hosts = new Set([...scope.site.resourceHosts, ...scope.site.origins.map(origin => new URL(origin).hostname)]);
        await context.route("**/*", async route => {
          const request = route.request();
          let allowed = false;
          try {
            const url = new URL(request.url());
            if (request.isNavigationRequest()) {
              browserUrl(request.url(), scope.site.origins, this.options.allowLoopback, scope.site.domain);
              allowed = request.frame().page() === view.page;
            } else if (scope.site.resources === "public") {
              // Hostname/public-suffix validation is not DNS pinning or rebinding isolation.
              browserPublicUrl(request.url());
              allowed = ["document", "stylesheet", "image", "media", "font", "script", "texttrack", "xhr", "fetch", "manifest", "other"].includes(request.resourceType());
            } else {
              const scheme = url.protocol === "https:" || (this.options.allowLoopback === true && url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname));
              allowed = scheme && !url.username && !url.password && hosts.has(url.hostname);
            }
            const current = await this.owner();
            allowed = allowed && current?.actor === this.actor && ["launching", "active"].includes(current.phase) && this.now() < deadline && this.now() < current.lastActivity + IDLE_MS;
          } catch { allowed = false; }
          if (allowed) await route.continue(); else await route.abort("blockedbyclient");
        });
        // WebSocket handshakes are not ordinary route requests. Disable them rather than leak outside policy.
        await context.routeWebSocket(/.*/, socket => socket.close());
        context.on("page", page => { if (view.page && page !== view.page) void page.close().catch(() => {}); });
        await context.addCookies(authentication.find(item => item.siteId === scope.site.siteId)!.state.cookies);
        view.page = await context.newPage();
        view.page.on("framenavigated", frame => { if (frame === view.page.mainFrame()) view.snapshotId = undefined; });
        await view.page.goto(scope.startUrl, { waitUntil: "domcontentloaded", timeout: Math.min(15_000, deadline - this.now()) });
      }
      await this.locked(async () => {
        const owner = await this.owner();
        if (owner?.phase !== "launching" || owner.actor !== this.actor || this.now() >= deadline || this.now() >= owner.lastActivity + IDLE_MS) throw new Error("Browser startup was cancelled or expired");
        owner.phase = "active"; await this.writeOwner(owner); await this.schedule(owner);
      });
    } catch {
      await this.locked(async () => { const owner = await this.owner(); if (owner && owner.phase !== "stopped" && owner.phase !== "stopping") { owner.phase = "uncertain"; await this.writeOwner(owner); } });
      await this.stopRun();
      throw new Error("Browser launch/import was interrupted; automatic restart or reimport is forbidden");
    } finally { this.launching = false; }
  }
  private key(id: string): string { return OP + id; }
  private async receipt(id: string, journal: Journal): Promise<BrowserReceipt> {
    if (journal.parts === undefined) return { operationId: id, status: journal.status, ...(journal.error ? { error: journal.error } : {}) };
    let text = "";
    for (let index = 0; index < journal.parts; index++) {
      const part = await this.options.storage.get<string>(`${CHUNK}${id}:${index}`);
      if (part === undefined) return { operationId: id, status: "uncertain", error: "Browser receipt persistence was interrupted" };
      text += part;
    }
    return JSON.parse(text) as BrowserReceipt;
  }
  private async save(id: string, journal: Journal, receipt: BrowserReceipt): Promise<void> {
    const text = JSON.stringify(receipt), parts = Math.ceil(text.length / 16_000);
    for (let index = 0; index < parts; index++) await this.options.storage.put(`${CHUNK}${id}:${index}`, text.slice(index * 16_000, (index + 1) * 16_000));
    await this.options.storage.put(this.key(id), { digest: journal.digest, status: receipt.status, parts } satisfies Journal);
  }
  async inspect(operationId: string): Promise<BrowserReceipt> {
    return this.locked(async () => {
      const owner = await this.owner();
      if (!owner || !operationId.startsWith(browserOperationPrefix(owner.assignment.taskId, owner.assignment.runId))) throw new Error("Browser operation belongs to another owner");
      const journal = await this.options.storage.get<Journal>(this.key(operationId));
      if (!journal) throw new Error("Unknown browser operation");
      if (journal.status === "running" && (owner.actor !== this.actor || this.dispatching !== operationId || owner.phase !== "active")) {
        const uncertain: BrowserReceipt = { operationId, status: "uncertain", error: "Browser dispatch was interrupted; replay is forbidden" };
        await this.save(operationId, journal, uncertain); return uncertain;
      }
      return this.receipt(operationId, journal);
    });
  }
  async invoke(input: BrowserRequest): Promise<BrowserReceipt> {
    const request = parseBrowserRequest(input), requestDigest = await digest(JSON.stringify(request));
    let journal!: Journal, view!: View, site!: BrowserSite, replay: BrowserReceipt | undefined;
    await this.locked(async () => {
      const owner = await this.owner();
      if (!owner || !request.operationId.startsWith(browserOperationPrefix(owner.assignment.taskId, owner.assignment.runId))) throw new Error("Browser operation belongs to another owner");
      const existing = await this.options.storage.get<Journal>(this.key(request.operationId));
      if (existing) {
        if (existing.digest !== requestDigest) throw new Error("Browser operation reused with different arguments");
        if (existing.status === "running" && (owner.actor !== this.actor || owner.phase !== "active" || this.dispatching !== request.operationId)) {
          replay = { operationId: request.operationId, status: "uncertain", error: "Browser dispatch was interrupted; replay is forbidden" }; await this.save(request.operationId, existing, replay);
        } else replay = await this.receipt(request.operationId, existing);
        return;
      }
      const live = await this.active();
      if (this.dispatching) throw new Error("Browser already has an admitted operation");
      if ((await this.options.storage.list<Journal>(OP)).size >= MAX_BROWSER_OPERATIONS) throw new Error("Browser operation bound exceeded");
      const scope = live.assignment.sites.find(scope => scope.site.siteId === request.action.siteId);
      if (!scope) throw new Error("Browser action is outside the approved sites");
      site = scope.site; view = this.views.get(site.siteId)!;
      if (!view || view.page.isClosed()) throw new Error("Owned browser page was lost");
      if (request.action.kind === "navigate") browserUrl(request.action.url, site.origins, this.options.allowLoopback, site.domain);
      if ("ref" in request.action && (view.snapshotId !== request.action.snapshotId || !view.refs.has(request.action.ref))) throw new Error("Stale browser observation reference");
      journal = { digest: requestDigest, status: "running" };
      await this.options.storage.put(this.key(request.operationId), journal);
      this.dispatching = request.operationId;
    });
    if (replay) return replay;
    let receipt: BrowserReceipt;
    let effected = false;
    const dispatch = async <T>(effect: () => Promise<T>): Promise<T> => {
      let pending!: Promise<T>;
      await this.locked(async () => {
        const owner = await this.active();
        view.page.setDefaultTimeout(Math.min(10_000, Date.parse(owner.assignment.deadlineAt) - this.now(), owner.lastActivity + IDLE_MS - this.now()));
        browserUrl(view.page.url(), site.origins, this.options.allowLoopback, site.domain);
        effected = true; pending = effect();
      });
      return pending;
    };
    try {
      const action = request.action;
      if ("ref" in action) {
        const snapshot = view.snapshot, element = view.refs.get(action.ref);
        if (!snapshot || !element) throw new Error("Stale browser observation reference");
        // Dispatch first resolves the provider/session fence. The trusted callback then
        // checks this exact document/generation and performs the primitive in one turn.
        const rejection = await dispatch(() => snapshot.evaluate((state, { node, action }) => {
          if (!(node instanceof Element) || !state.fresh(node)) return "Stale browser observation reference";
          if (!(node instanceof HTMLElement) || node.hasAttribute("disabled") || node.getAttribute("aria-disabled") === "true") return "Browser control is not actionable";
          if (action.kind === "press") {
            node.focus();
            if (!state.fresh(node)) return "Stale browser observation reference";
            const outcome = Promise.withResolvers<boolean>();
            const fence: KeyFence = { node, key: action.key, rejected: false, seen: false, result: outcome.promise, resolve: outcome.resolve, cleanup() { outcome.resolve(false); } };
            // Keep the real Playwright keyboard primitive. This capture fence remains
            // active through its auto-wait/transport gap and cancels stale key defaults
            // and target handlers before they can operate on a changed control.
            const guard = (event: KeyboardEvent) => {
              if (event.key !== fence.key) return;
              if (event.type === "keydown" && !fence.seen) {
                fence.seen = true;
                fence.rejected = event.target !== node || !state.fresh(node);
                fence.resolve(!fence.rejected);
              }
              if (fence.rejected) {
                event.preventDefault(); event.stopImmediatePropagation();
              }
            };
            state.keyboard.arm(state.keyboardToken, guard);
            fence.cleanup = () => { outcome.resolve(false); state.keyboard.disarm(state.keyboardToken); };
            state.keyFence = fence;
            return undefined;
          }
          if (action.kind === "click") { node.click(); return undefined; }
          const fillable = () => {
            if (state.credential(node)) return "Credential fields cannot be filled by the browser model";
            if (!state.fresh(node)) return "Stale browser observation reference";
            if (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement) {
              if (node.disabled || node.readOnly || (node instanceof HTMLInputElement && !["text", "email", "search", "tel", "url", "number"].includes(node.type))) return "Browser field is not an editable input";
            } else if (!node.isContentEditable) return "Browser field is not an editable input";
            return undefined;
          };
          const before = fillable(); if (before) return before;
          node.focus();
          // Focus handlers execute synchronously: recheck immediately before assignment.
          const after = fillable(); if (after) return after;
          if (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement) {
            const prototype = node instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
            const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
            if (!setter) return "Browser input setter is unavailable";
            setter.call(node, action.text);
          } else node.textContent = action.text;
          node.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: action.text }));
          node.dispatchEvent(new Event("change", { bubbles: true }));
          return undefined;
        }, { node: element, action }));
        if (rejection) { effected = false; throw new Error(rejection); }
        view.snapshotId = undefined;
        if (action.kind === "press") {
          // Start receiving the keydown decision before dispatch. A valid Enter may
          // navigate and destroy the old document immediately after this decision.
          const acceptance = snapshot.evaluate(state => state.keyFence!.result);
          void acceptance.catch(() => {});
          try {
            await dispatch(() => element.press(action.key));
            if (!await acceptance) { effected = false; throw new Error("Stale browser observation reference"); }
          } finally { await snapshot.evaluate(state => { state.keyFence?.cleanup(); state.keyFence = undefined; }).catch(() => {}); }
        }
      } else if (action.kind === "navigate") {
        view.snapshotId = undefined;
        await dispatch(() => view.page.goto(browserUrl(action.url, site.origins, this.options.allowLoopback, site.domain), { waitUntil: "domcontentloaded" }));
      }
      browserUrl(view.page.url(), site.origins, this.options.allowLoopback, site.domain);
      if (action.kind === "screenshot") {
        const bytes = await dispatch(() => view.page.screenshot({ type: "png", fullPage: false }));
        if (bytes.byteLength > MAX_BROWSER_IMAGE_BYTES) throw new Error("Browser screenshot exceeds its byte bound");
        receipt = { operationId: request.operationId, status: "done", image: { siteId: site.siteId, url: browserDisplayUrl(view.page.url()), mimeType: "image/png", data: bytes.toString("base64") } };
      } else {
        receipt = { operationId: request.operationId, status: "done", observation: await dispatch(() => this.observe(view, site)) };
      }
    } catch (error) {
      const issue = error instanceof Error && /Stale browser|Credential fields|exceeds its byte bound|outside its approved/.test(error.message) ? error.message : "Browser action or transport was interrupted";
      receipt = { operationId: request.operationId, status: effected ? "uncertain" : "failed", error: issue };
    }
    return this.locked(async () => {
      try {
        const owner = await this.owner();
        if (owner?.phase !== "active" || owner.actor !== this.actor || this.now() >= Date.parse(owner.assignment.deadlineAt) || this.now() >= owner.lastActivity + IDLE_MS) receipt = { operationId: request.operationId, status: "uncertain", error: "Browser stop or deadline fenced the in-flight action" };
        if (receipt.status === "uncertain" && owner?.phase === "active") { owner.phase = "uncertain"; await this.writeOwner(owner); }
        await this.save(request.operationId, journal, receipt); return receipt;
      } catch {
        const owner = await this.owner();
        if (owner?.phase === "active") { owner.phase = "uncertain"; await this.writeOwner(owner).catch(() => {}); }
        return { operationId: request.operationId, status: "uncertain", error: "Browser receipt persistence was interrupted; replay is forbidden" };
      }
      finally { this.dispatching = undefined; }
    });
  }
  private async observe(view: View, site: BrowserSite): Promise<BrowserObservation> {
    if (view.snapshot) { await view.snapshot.evaluate((snapshot: { observer: MutationObserver }) => snapshot.observer.disconnect()).catch(() => {}); await view.snapshot.dispose().catch(() => {}); }
    for (const handle of view.refs.values()) await handle.dispose().catch(() => {});
    view.snapshotId = undefined; view.refs.clear();
    browserUrl(view.page.url(), site.origins, this.options.allowLoopback, site.domain);
    const snapshot = await view.page.evaluateHandle(({ maximum, fenceKey, fenceToken, origins, domain, allowLoopback }) => {
      const pageUrl = location.href;
      const scoped = () => {
        const url = new URL(location.href);
        if (url.username || url.password) return false;
        if (domain) return url.protocol === "https:" && !url.port && (url.hostname === domain || url.hostname.endsWith(`.${domain}`));
        const scheme = url.protocol === "https:" || (allowLoopback && url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname));
        return scheme && origins.includes(url.origin);
      };
      if (!scoped()) throw new Error("Browser URL is outside its approved site");
      const bytes = new TextEncoder(), labelMaximum = 2048, nodeMaximum = 512, visitMaximum = 20_000;
      const excluded = "input,textarea,select,[contenteditable]:not([contenteditable='false']),script,style,noscript,template";
      let overflow = false, total = 0;
      const bounded = (text: string, limit: number) => {
        if (text.length > limit || bytes.encode(text).byteLength > limit) { overflow = true; return ""; }
        return text;
      };
      const append = (text: string) => {
        const value = bounded(text, maximum), size = bytes.encode(value).byteLength;
        if (total + size > maximum) { overflow = true; return ""; }
        total += size; return value;
      };
      // Never extract editable contents, including through an ancestor's text/label.
      // Walking text nodes also avoids materializing an unbounded body.innerText.
      const safeText = (root: Element, limit: number, editableRoot = false) => {
        if (root.closest(excluded) && !editableRoot) return "";
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        const parts: string[] = []; let size = 0, visited = 0;
        while (!overflow) {
          const node = walker.nextNode(); if (!node) break;
          if (++visited > visitMaximum) { overflow = true; break; }
          const parent = node.parentElement;
          if (!parent) continue;
          const exclusion = parent.closest(excluded);
          if (exclusion && !(editableRoot && exclusion === root)) continue;
          const style = getComputedStyle(parent);
          if (style.display === "none" || style.visibility === "hidden" || !parent.getClientRects().length) continue;
          const value = bounded(node.nodeValue ?? "", limit);
          size += bytes.encode(value).byteLength;
          if (size > limit) { overflow = true; break; }
          parts.push(value);
        }
        return parts.join(" ").replace(/\s+/g, " ").trim();
      };
      const associatedLabels = (element: Element) => {
        if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement)) return [];
        if ((element.labels?.length ?? 0) > 16) { overflow = true; return []; }
        return Array.from(element.labels ?? []);
      };
      const credential = (element: Element) => {
        const labels = associatedLabels(element);
        const description = [element.getAttribute("type"), element.getAttribute("autocomplete"), element.getAttribute("name"), element.id, element.getAttribute("aria-label"), element.getAttribute("placeholder"), ...labels.map(label => safeText(label, labelMaximum))];
        // Oversized credential metadata fails closed rather than hiding a suffix.
        if (overflow || description.some(value => value !== null && value.length > labelMaximum)) return true;
        return /password|passwd|passphrase|secret|token|api.?key|access.?key|private.?key|one.time|otp|verification.code|security.code|credit.card|cc.number|cc.csc/i.test(description.join(" "));
      };
      const nodes: Element[] = [], lines: string[] = [];
      const text = document.body ? append(safeText(document.body, maximum)) : "";
      append("\n\nInteractive references:\n");
      const walker = document.createTreeWalker(document, NodeFilter.SHOW_ELEMENT);
      let visited = 0;
      while (!overflow) {
        const element = walker.nextNode(); if (!element) break;
        if (++visited > visitMaximum) { overflow = true; break; }
        if (!(element instanceof Element) || !element.matches("a,button,input,textarea,select,[role],[tabindex],[contenteditable]:not([contenteditable='false']),summary") || element.parentElement?.closest(excluded)) continue;
        const rect = element.getBoundingClientRect(), style = getComputedStyle(element);
        if (!rect.width || !rect.height || style.visibility === "hidden" || style.display === "none") continue;
        if (nodes.length >= nodeMaximum) { overflow = true; break; }
        const labels = associatedLabels(element);
        const labelParts = [element.getAttribute("aria-label"), element.getAttribute("placeholder"), safeText(element, labelMaximum), ...labels.map(label => safeText(label, labelMaximum))].filter((value): value is string => value !== null);
        let labelSize = 0;
        for (const part of labelParts) { bounded(part, labelMaximum); labelSize += part.length; }
        if (labelSize > labelMaximum) { overflow = true; break; }
        const label = bounded(labelParts.join(" ").replace(/\s+/g, " ").trim(), labelMaximum);
        const type = bounded(element.getAttribute("type") ?? "", labelMaximum);
        const role = bounded(element.getAttribute("role") ?? element.tagName.toLowerCase(), labelMaximum);
        const disabled = element.hasAttribute("disabled") || element.getAttribute("aria-disabled") === "true";
        const sensitive = credential(element);
        const valueText = sensitive ? undefined : element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement
          ? bounded(element.value, labelMaximum) : element instanceof HTMLElement && element.isContentEditable ? safeText(element, labelMaximum, true) : undefined;
        const value = valueText === undefined ? "" : ` value=${JSON.stringify(valueText)}`;
        const checked = element instanceof HTMLInputElement && ["checkbox", "radio"].includes(element.type) ? ` checked=${element.checked}` : "";
        const line = append(`e${nodes.length + 1} ${role}${type ? ` type=${type}` : ""}${disabled ? " disabled" : ""}${checked}${value} ${label}\n`);
        nodes.push(element); lines.push(line);
      }
      const title = bounded(document.title, 1000);
      const signatures = new Map(nodes.map(node => [node, {
        click: node instanceof HTMLElement ? node.onclick : null,
        keydown: node instanceof HTMLElement ? node.onkeydown : null,
        keypress: node instanceof HTMLElement ? node.onkeypress : null,
        keyup: node instanceof HTMLElement ? node.onkeyup : null,
        value: !credential(node) && (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement || node instanceof HTMLSelectElement) ? node.value : undefined,
      }]));
      const state: PageSnapshot = {
        nodes: overflow ? [] : nodes, document, changed: false, overflow,
        tree: overflow ? "" : `${text}\n\nInteractive references:\n${lines.join("")}`, title: overflow ? "" : title,
        observer: undefined as unknown as MutationObserver, credential, keyboard: (window as unknown as Record<string, KeyboardBridge>)[fenceKey]!, keyboardToken: fenceToken,
        fresh(node) {
          if (state.observer.takeRecords().length) state.changed = true;
          if (state.changed || location.href !== pageUrl || !scoped() || state.document !== document || node.ownerDocument !== document || !node.isConnected || !state.nodes.includes(node)) return false;
          const signature = signatures.get(node);
          return Boolean(signature && (!(node instanceof HTMLElement) || (signature.click === node.onclick && signature.keydown === node.onkeydown && signature.keypress === node.onkeypress && signature.keyup === node.onkeyup))
            && (signature.value === undefined || ((node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement || node instanceof HTMLSelectElement) && signature.value === node.value)));
        },
      };
      state.observer = new MutationObserver(() => { state.changed = true; });
      state.observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
      return state;
    }, { maximum: MAX_BROWSER_OBSERVATION_BYTES, fenceKey: view.fenceKey, fenceToken: view.fenceToken, origins: site.origins, domain: site.domain, allowLoopback: this.options.allowLoopback === true });
    view.snapshot = snapshot;
    const data = await snapshot.evaluate(value => value.overflow ? { overflow: true, tree: "", title: "", count: 0 } : { overflow: false, tree: value.tree, title: value.title, count: value.nodes.length });
    if (data.overflow || encoder.encode(data.tree).byteLength > MAX_BROWSER_OBSERVATION_BYTES || encoder.encode(data.title).byteLength > 1000) throw new Error("Browser observation exceeds its byte bound");
    const nodes = await snapshot.getProperty("nodes");
    try {
      for (let index = 0; index < data.count; index++) {
        const handle = (await nodes.getProperty(String(index))).asElement();
        if (handle) view.refs.set(`e${index + 1}`, handle);
      }
    } finally { await nodes.dispose(); }
    const snapshotId = crypto.randomUUID(); view.snapshotId = snapshotId;
    return { siteId: site.siteId, snapshotId, url: browserDisplayUrl(view.page.url()), title: data.title, tree: data.tree };
  }
  async activity(): Promise<void> {
    try {
      await this.locked(async () => {
        const owner = await this.active();
        const session = await this.bounded(this.browser!.newBrowserCDPSession());
        try { await this.bounded(session.send("Browser.getVersion")); } finally { await this.bounded(session.detach()); }
        if (this.now() >= Date.parse(owner.assignment.deadlineAt) || this.now() >= owner.lastActivity + IDLE_MS) throw new Error("Browser lease expired");
        owner.lastActivity = this.now(); await this.writeOwner(owner); await this.schedule(owner);
      });
    } catch { await this.stopRun(); throw new Error("Browser activity lease or owned session was lost"); }
  }
  async enforceDeadline(): Promise<void> {
    const owner = await this.owner();
    if (!owner || owner.phase === "stopped") return;
    if (owner.phase === "stopping" || owner.phase === "uncertain" || owner.actor !== this.actor || this.now() >= Date.parse(owner.assignment.deadlineAt) || this.now() >= owner.lastActivity + IDLE_MS) { await this.stopRun(); return; }
    await this.schedule(owner);
  }
  async stopRun(): Promise<BrowserStopped> {
    let owner: Owner | undefined;
    const settled = await this.locked(async () => {
      owner = await this.owner();
      if (!owner) {
        // A pre-start stop is a durable admission fence, even without an assignment.
        await this.options.storage.put("browser-prestart-stop", true); return { stopped: true, uncertain: false };
      }
      if (owner.phase === "stopped") return { stopped: true, uncertain: false };
      if (!owner.unknownSession && !owner.sessionId) { owner.phase = "stopped"; await this.writeOwner(owner); return { stopped: true, uncertain: false }; }
      owner.phase = "stopping"; await this.writeOwner(owner);
      return undefined;
    });
    if (settled) return settled;
    try {
      const sessionId = owner!.sessionId ?? this.sessionId;
      if (!sessionId) return { stopped: false, uncertain: true };
      // Destruction is asynchronous at the provider. Spend one transport budget
      // on the request and absence observation, never retry the task or close.
      const stopDeadline = Date.now() + 10_000;
      const absent = await this.bounded((async () => {
        if (await this.options.sessions.exists(sessionId)) {
          if (Date.now() >= stopDeadline) return false;
          await this.options.sessions.close(sessionId, this.browser);
        }
        while (Date.now() < stopDeadline) {
          if (!await this.options.sessions.exists(sessionId)) return Date.now() < stopDeadline;
          const remaining = stopDeadline - Date.now();
          if (remaining <= 0) return false;
          await new Promise<void>(resolve => setTimeout(resolve, Math.min(100, remaining)));
        }
        return false;
      })(), Math.max(1, stopDeadline - Date.now()));
      if (!absent) return { stopped: false, uncertain: true };
      return await this.locked(async () => {
        const current = await this.owner();
        if (Date.now() >= stopDeadline || !current || (current.sessionId !== undefined && current.sessionId !== sessionId)) return { stopped: false, uncertain: true };
        current.sessionId = sessionId; current.unknownSession = false; current.phase = "stopped";
        await this.writeOwner(current); this.browser = undefined; this.sessionId = undefined; this.views.clear();
        return { stopped: true, uncertain: false };
      });
    } catch { return { stopped: false, uncertain: true }; }
  }
}
