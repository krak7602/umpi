import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes } from "node:crypto";
import { MAX_BROWSER_IMAGE_BYTES, MAX_BROWSER_OBSERVATION_BYTES, browserDisplayUrl, browserUrl } from "../shared/browser.js";
import type { BrowserStopped, BrowserAction, BrowserAssignment, BrowserImage, BrowserObservation } from "../shared/browser.js";
import { record } from "../shared/protocol.js";

export class AsideConnectionLost extends Error {
  constructor() { super("Aside browser connection was lost; dispatched effects were not replayed"); }
}
export class BrowserActionRejected extends Error {
  constructor() { super("Browser action was rejected by its current observation or site boundary"); }
}
export interface BrowserTab { siteId: string; targetId: string }
export interface NativeBrowserBridge {
  openTab(siteId: string, marker: string): Promise<string>;
  configureTab(tab: BrowserTab, assignment: BrowserAssignment): Promise<void>;
  invoke(tab: BrowserTab, action: BrowserAction): Promise<{ observation?: BrowserObservation; image?: BrowserImage }>;
  disconnect(): Promise<void>;
  stopTabs(targetIds: readonly string[]): Promise<BrowserStopped>;
  setPopupUncertaintyHandler?(handler: () => void): void;
}
interface Pending { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }
export interface AsideTransportOptions { command?: string; args?: string[]; timeoutMs?: number }

/** Private newline-JSONRPC transport. Never forwards MCP/page output or stderr to logs. */
export class AsideMcpTransport {
  private child: ChildProcessWithoutNullStreams | undefined;
  private pending = new Map<number, Pending>();
  private sequence = 0;
  private buffer = "";
  private lost = false;
  private opening: Promise<void> | undefined;
  private exited: Promise<void> = Promise.resolve();
  constructor(private readonly options: AsideTransportOptions = {}) {}

  private fail(): void {
    if (this.lost) return;
    this.lost = true;
    for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(new AsideConnectionLost()); }
    this.pending.clear();
    this.child?.kill("SIGKILL");
  }
  private receive(chunk: string): void {
    this.buffer += chunk;
    if (Buffer.byteLength(this.buffer) > 4 * 1024 * 1024) { this.fail(); return; }
    for (;;) {
      const end = this.buffer.indexOf("\n");
      if (end < 0) break;
      const line = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 1);
      if (!line.trim()) continue;
      let response: Record<string, unknown>;
      try { response = record(JSON.parse(line)); } catch { this.fail(); return; }
      if (typeof response.id !== "number") continue;
      const pending = this.pending.get(response.id);
      if (!pending) continue;
      clearTimeout(pending.timer); this.pending.delete(response.id);
      if (response.error !== undefined || response.result === undefined) pending.reject(new AsideConnectionLost());
      else pending.resolve(response.result);
    }
  }
  private rpc(method: string, params: unknown): Promise<unknown> {
    if (this.lost || !this.child) return Promise.reject(new AsideConnectionLost());
    const id = ++this.sequence;
    const { promise, resolve, reject } = Promise.withResolvers<unknown>();
    const timer = setTimeout(() => this.fail(), this.options.timeoutMs ?? 125_000);
    this.pending.set(id, { resolve, reject, timer });
    this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n", error => { if (error) this.fail(); });
    return promise;
  }
  private initialize(): Promise<void> {
    return this.opening ??= (async () => {
      if (this.lost) throw new AsideConnectionLost();
      this.child = spawn(this.options.command ?? "aside", this.options.args ?? ["mcp", "--host", "local"], { stdio: "pipe", shell: false, env: { ...process.env } });
      const exit = Promise.withResolvers<void>();
      this.exited = exit.promise;
      this.child.once("close", () => { this.fail(); exit.resolve(); });
      this.child.on("error", () => this.fail());
      this.child.stdin.on("error", () => this.fail());
      this.child.stdout.setEncoding("utf8").on("data", (chunk: string) => this.receive(chunk));
      this.child.stderr.resume();
      const response = record(await this.rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "umpi-browser", version: "1" } }));
      if (response.protocolVersion !== "2025-03-26") throw new AsideConnectionLost();
      this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
      const tools = record(await this.rpc("tools/list", {}));
      if (!Array.isArray(tools.tools) || !tools.tools.some(tool => record(tool).name === "repl")) throw new AsideConnectionLost();
    })().catch(error => { this.fail(); throw error; });
  }
  /** Callers generate code; this API is never offered to a model or coordinator. */
  async generated(body: string): Promise<Record<string, unknown>> {
    await this.initialize();
    const tag = `UMPI_${randomBytes(24).toString("hex")}:`;
    const code = `{ var umpiDispatched=false; try { ${body}\nconsole.log(${JSON.stringify(tag)} + JSON.stringify({ok:true,value:umpiResult})); } catch (umpiError) { console.log(${JSON.stringify(tag)} + JSON.stringify({ok:false,rejected:!umpiDispatched && umpiError && umpiError.message === 'UMPI_REJECTED'})); } }`;
    const result = record(await this.rpc("tools/call", { name: "repl", arguments: { title: "Task-owned browser operation", code } }));
    if (result.isError || !Array.isArray(result.content)) throw new AsideConnectionLost();
    const matches: string[] = [];
    for (const content of result.content) {
      const item = record(content);
      if (item.type !== "text" || typeof item.text !== "string") continue;
      for (const line of item.text.split("\n")) { const at = line.indexOf(tag); if (at >= 0) matches.push(line.slice(at + tag.length)); }
    }
    if (matches.length !== 1) throw new AsideConnectionLost();
    let response: Record<string, unknown>;
    try { response = record(JSON.parse(matches[0]!)); } catch { throw new AsideConnectionLost(); }
    if (response.ok !== true) { if (response.rejected === true) throw new BrowserActionRejected(); throw new AsideConnectionLost(); }
    return record(response.value);
  }
  async disconnect(): Promise<void> { this.fail(); await this.exited; }
}

function quoted(value: unknown): string { return JSON.stringify(value); }
const targetIdPattern = /^[A-Za-z0-9_.:-]{1,256}$/;

// Policy domains are validated by the shared parser before this fixed callback
// runs. Exact mode retains its explicitly approved origins, including local tests.
const nativeUrlAllowed = String.raw`function(value,origins,domain) {
  try {
    var url=new URL(value);
    if (url.username || url.password) return false;
    if (!domain) return origins.includes(url.origin);
    return url.protocol==='https:' && !url.port &&
      (url.hostname===domain || url.hostname.endsWith('.'+domain));
  } catch { return false; }
}`;

// Fixed page callbacks inspect only control metadata, never existing values.
const nativeFieldMetadata = String.raw`function(element) {
  var link=element.closest('a'), form=element.form;
  return {
    origin:element.ownerDocument.location.origin, tag:element.tagName, editable:element.isContentEditable,
    type:element.getAttribute('type') || '', autocomplete:element.getAttribute('autocomplete') || '',
    name:element.getAttribute('name') || '', id:element.id || '',
    label:(element.getAttribute('aria-label') || '') + ' ' + Array.from(element.labels || [],function(label){return label.textContent || '';}).join(' '),
    placeholder:element.getAttribute('placeholder') || '', disabled:element.disabled===true, readonly:element.readOnly===true,
    controlText:['BUTTON','A'].includes(element.tagName) ? (element.textContent || '') : '',
    href:link ? link.href : '', target:(link && link.target) || element.getAttribute('formtarget') || (form && form.target) || '',
    download:!!(link && link.hasAttribute('download')), formAction:form ? (element.getAttribute('formaction') || form.action) : '',
    credentialForm:form ? !!form.querySelector('input[type="password"],input[autocomplete~="username"],input[autocomplete~="current-password"],input[autocomplete~="new-password"],input[autocomplete~="one-time-code"]') : false
  };
}`;
const nativeFieldForbidden = String.raw`function(field,origins,domain) {
  var allowed=${nativeUrlAllowed};
  return !allowed(field.origin,origins,domain) || ['password','hidden','file'].includes(field.type.toLowerCase()) ||
    /(?:^|\s)(?:username|current-password|new-password|one-time-code|cc-[^ ]+)(?:$|\s)/i.test(field.autocomplete) ||
    /password|passphrase|secret|token|username|login|sign[ -]?in|api[ _-]?key|access[ _-]?key|private[ _-]?key|recovery|one[ -]?time|verification|security[ -]?code|\botp\b|\bpin\b|\bcvv\b|\bcvc\b/i.test([field.name,field.id,field.label,field.placeholder].join(' '));
}`;

// Aside closeTab can return before the target disappears. Absence polling is
// read-only and bounded; it never repeats the close action or guesses targets.
const nativeTargetAbsence = String.raw`
  var umpiStopped=false;
  for (var umpiAttempt=0; umpiAttempt<50; umpiAttempt++) {
    var umpiTabs=await listBrowserTabs();
    if (!umpiTabs.some(function(tab){return umpiTargets.includes(tab.targetId);})) { umpiStopped=true; break; }
    await sleep(100);
  }
  var umpiResult={stopped:umpiStopped};
`;

/** Only this fixed generator has access to the Aside repl; no supplied source is evaluated. */
export class AsideBrowserBridge implements NativeBrowserBridge {
  private readonly name = `globalThis.umpiBrowser_${randomBytes(16).toString("hex")}`;
  private initialized = false;
  private readonly transport: AsideMcpTransport;
  private inFlight = 0;
  private disconnecting: Promise<void> | undefined;
  private popupUncertain = false;
  private popupUncertaintyHandler: (() => void) | undefined;
  constructor(private readonly allowLoopback = false, private readonly options: AsideTransportOptions = {}) { this.transport = new AsideMcpTransport(options); }
  setPopupUncertaintyHandler(handler: () => void): void {
    this.popupUncertaintyHandler = handler;
    if (this.popupUncertain) handler();
  }
  private markPopupUncertain(): void {
    if (this.popupUncertain) return;
    this.popupUncertain = true;
    this.popupUncertaintyHandler?.();
  }
  private async generated(body: string): Promise<Record<string, unknown>> {
    if (this.disconnecting) throw new AsideConnectionLost();
    this.inFlight++;
    try {
      const result = await this.transport.generated(body + `\numpiResult.popupUncertain=${this.name}.popupUncertain;`);
      if (result.popupUncertain !== false && result.popupUncertain !== true) throw new AsideConnectionLost();
      if (result.popupUncertain) this.markPopupUncertain();
      return result;
    } catch (error) {
      if (error instanceof BrowserActionRejected && !this.disconnecting) {
        // A rejected fill can still run a focus handler that opens a popup.
        // Drain only watcher metadata; never retry the rejected primitive.
        try {
          const watcher = await this.transport.generated(`var umpiResult={popupUncertain:${this.name}.popupUncertain};`);
          if (watcher.popupUncertain !== false) this.markPopupUncertain();
        } catch { this.markPopupUncertain(); }
      } else this.markPopupUncertain();
      throw error;
    } finally { this.inFlight--; }
  }
  private async initialize(): Promise<void> {
    if (this.initialized) return;
    await this.generated(`${this.name} = { tabs: new Map(), sites: new Map(), popupUncertain:false }; var umpiResult = {};`);
    this.initialized = true;
  }
  async openTab(siteId: string, marker: string): Promise<string> {
    if (!/^about:blank#umpi-browser-[a-f0-9]{64}$/.test(marker)) throw new BrowserActionRejected();
    await this.initialize();
    // Aside's public popup event exposes URL/windowName, not a descendant
    // target ID. Register before site navigation; discard its untrusted payload.
    const result = await this.generated(`var umpiTab = await openTab(${quoted(marker)}); var umpiTarget = umpiTab.targetId; if (typeof umpiTarget !== 'string') throw new Error('ownership'); ${this.name}.tabs.set(${quoted(siteId)}, { page:umpiTab, targetId:umpiTarget, snapshotId:null, refs:new Set() }); if (typeof umpiTab.on !== 'function') throw new Error('popup monitoring'); umpiTab.on('popup',function(){${this.name}.popupUncertain=true;}); var umpiResult = {targetId:umpiTarget};`);
    if (typeof result.targetId !== "string" || !targetIdPattern.test(result.targetId)) throw new AsideConnectionLost();
    return result.targetId;
  }
  async configureTab(tab: BrowserTab, assignment: BrowserAssignment): Promise<void> {
    const scope = assignment.sites.find(scope => scope.site.siteId === tab.siteId);
    if (!scope) throw new BrowserActionRejected();
    browserUrl(scope.startUrl, scope.site.origins, this.allowLoopback, scope.site.domain);
    // Aside exposes no page.route. This is an approved-action/origin boundary,
    // not a local network sandbox; ordinary page subresources use its profile.
    await this.generated(`var umpiOwned = ${this.name}.tabs.get(${quoted(tab.siteId)}); if (!umpiOwned || umpiOwned.targetId !== ${quoted(tab.targetId)}) throw new Error('UMPI_REJECTED'); var umpiPolicy = ${quoted(scope.site)}; var umpiAllowed=${nativeUrlAllowed}; ${this.name}.sites.set(${quoted(tab.siteId)}, umpiPolicy); umpiDispatched=true; await umpiOwned.page.goto(${quoted(scope.startUrl)}, { waitUntil:'domcontentloaded', timeout:30000 }); if (!umpiAllowed(umpiOwned.page.url(),umpiPolicy.origins,umpiPolicy.domain)) throw new Error('ownership'); var umpiResult = {};`);
  }
  async invoke(tab: BrowserTab, action: BrowserAction): Promise<{ observation?: BrowserObservation; image?: BrowserImage }> {
    if (action.siteId !== tab.siteId) throw new BrowserActionRejected();
    const snapshotId = randomBytes(24).toString("hex");
    const prelude = `var umpiOwned = ${this.name}.tabs.get(${quoted(tab.siteId)}); var umpiPolicy = ${this.name}.sites.get(${quoted(tab.siteId)}); if (!umpiOwned || umpiOwned.targetId !== ${quoted(tab.targetId)} || !umpiPolicy) throw new Error('UMPI_REJECTED'); var umpiAllowed=${nativeUrlAllowed}; if (!umpiAllowed(umpiOwned.page.url(),umpiPolicy.origins,umpiPolicy.domain)) throw new Error('UMPI_REJECTED'); var umpiAction = ${quoted(action)};`;
    let operation = "";
    if (action.kind === "navigate") {
      operation = `if (!umpiAllowed(umpiAction.url,umpiPolicy.origins,umpiPolicy.domain)) throw new Error('UMPI_REJECTED'); umpiOwned.snapshotId=null; umpiOwned.refs.clear(); umpiDispatched=true; await umpiOwned.page.goto(umpiAction.url,{waitUntil:'domcontentloaded',timeout:30000});`;
    } else if (action.kind === "click" || action.kind === "fill" || action.kind === "press") {
      // Fixed metadata-only DOM read; no values, credentials, cookies or storage.
      operation = `if (umpiOwned.snapshotId !== umpiAction.snapshotId || !umpiOwned.refs.has(umpiAction.ref)) throw new Error('UMPI_REJECTED'); var umpiLocator = umpiOwned.page.locator(umpiAction.ref); var umpiField = await umpiLocator.evaluate(${nativeFieldMetadata}); if ((${nativeFieldForbidden})(umpiField,umpiPolicy.origins,umpiPolicy.domain)) throw new Error('UMPI_REJECTED');`;
      if (action.kind === "fill") {
        operation += `if ((!['INPUT','TEXTAREA'].includes(umpiField.tag) && !umpiField.editable) || umpiField.disabled || umpiField.readonly) throw new Error('UMPI_REJECTED');
          umpiOwned.snapshotId=null; umpiOwned.refs.clear(); umpiDispatched=true;
          var umpiFilled=await umpiLocator.evaluate(function(element,args) {
            var read=${nativeFieldMetadata}, forbidden=${nativeFieldForbidden};
            var document=element.ownerDocument, view=document.defaultView, field=read(element);
            if (!view || !element.isConnected || forbidden(field,args.origins,args.domain) || field.disabled || field.readonly) return {rejected:true};
            var input=element instanceof view.HTMLInputElement, textarea=element instanceof view.HTMLTextAreaElement;
            if (!input && !textarea && !element.isContentEditable) return {rejected:true};
            var descriptor=input || textarea ? Object.getOwnPropertyDescriptor(input ? view.HTMLInputElement.prototype : view.HTMLTextAreaElement.prototype,'value') : null;
            if ((input || textarea) && (!descriptor || typeof descriptor.set!=='function')) return {rejected:true};
            view.HTMLElement.prototype.focus.call(element);
            field=read(element);
            if (!element.isConnected || element.ownerDocument!==document || document.defaultView!==view ||
                forbidden(field,args.origins,args.domain) || field.disabled || field.readonly ||
                (!input && !textarea && !element.isContentEditable)) return {rejected:true};
            // No await, autowait or second browser call between this check and assignment.
            if (descriptor) descriptor.set.call(element,args.text); else element.textContent=args.text;
            element.dispatchEvent(new view.Event('input',{bubbles:true}));
            element.dispatchEvent(new view.Event('change',{bubbles:true}));
            return {rejected:false};
          },{origins:umpiPolicy.origins,domain:umpiPolicy.domain,text:umpiAction.text});
          if (umpiFilled.rejected) { umpiDispatched=false; throw new Error('UMPI_REJECTED'); }`;
      } else {
        operation += `if (umpiField.credentialForm || /log[ -]?in|sign[ -]?in|authenticate|reauthenticate/i.test(umpiField.controlText) || umpiField.download || (umpiField.target && umpiField.target !== '_self')) throw new Error('UMPI_REJECTED'); for (var umpiDestination of [umpiField.href,umpiField.formAction]) { if (!umpiDestination) continue; var umpiNext=new URL(umpiDestination,umpiOwned.page.url()); if (!umpiAllowed(umpiNext.href,umpiPolicy.origins,umpiPolicy.domain)) throw new Error('UMPI_REJECTED'); } umpiOwned.snapshotId=null; umpiOwned.refs.clear(); umpiDispatched=true; await umpiLocator.${action.kind === "click" ? "click({timeout:30000})" : "press(umpiAction.key,{timeout:30000})"};`;
      }
    }
    const output = action.kind === "screenshot"
      ? `var umpiPng=await umpiOwned.page.screenshot({type:'png',fullPage:false}); if (!umpiAllowed(umpiOwned.page.url(),umpiPolicy.origins,umpiPolicy.domain)) throw new Error('ownership'); if (umpiPng.length > ${MAX_BROWSER_IMAGE_BYTES}) throw new Error('UMPI_REJECTED'); var umpiResult={image:{siteId:${quoted(tab.siteId)},url:umpiOwned.page.url(),mimeType:'image/png',data:Buffer.from(umpiPng).toString('base64')}};`
      : `if (!umpiAllowed(umpiOwned.page.url(),umpiPolicy.origins,umpiPolicy.domain)) throw new Error('ownership'); var umpiSnapshot=await snapshot(umpiOwned.page,{interactive:true}); if (!umpiAllowed(umpiOwned.page.url(),umpiPolicy.origins,umpiPolicy.domain)) throw new Error('ownership'); var umpiTree=umpiSnapshot.tree; if (typeof umpiTree !== 'string' || Buffer.byteLength(umpiTree,'utf8') > ${MAX_BROWSER_OBSERVATION_BYTES}) { umpiOwned.snapshotId=null; umpiOwned.refs.clear(); throw new Error('UMPI_REJECTED'); } umpiTree=umpiTree.replace(/https?:\\/\\/[^\\s"<>]+/g,function(value){try { var url=new URL(value); return url.origin+url.pathname; } catch { return '[location]'; }}); umpiOwned.snapshotId=${quoted(snapshotId)}; umpiOwned.refs=new Set(Array.from(umpiTree.matchAll(/\\[ref=((?:f\\d+)?e\\d+)\\]/g),function(match){return match[1];})); var umpiResult={observation:{siteId:${quoted(tab.siteId)},snapshotId:umpiOwned.snapshotId,url:umpiOwned.page.url(),title:(await umpiOwned.page.title()) || '(untitled)',tree:umpiTree || '(empty page)'}};`;
    const result = await this.generated(prelude + operation + output);
    if (result.observation !== undefined) {
      const value = record(result.observation);
      if (typeof value.url !== "string" || typeof value.title !== "string" || typeof value.tree !== "string" || value.snapshotId !== snapshotId || Buffer.byteLength(value.tree) > MAX_BROWSER_OBSERVATION_BYTES || value.title.length > 1000) throw new AsideConnectionLost();
      return { observation: { siteId: tab.siteId, snapshotId, url: browserDisplayUrl(value.url), title: value.title, tree: value.tree } };
    }
    const value = record(result.image);
    if (typeof value.url !== "string" || typeof value.data !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(value.data) || value.data.length % 4) throw new AsideConnectionLost();
    const png = Buffer.from(value.data, "base64");
    if (png.length > MAX_BROWSER_IMAGE_BYTES || !png.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) throw new AsideConnectionLost();
    return { image: { siteId: tab.siteId, url: browserDisplayUrl(value.url), mimeType: "image/png", data: value.data } };
  }
  async disconnect(): Promise<void> {
    if (this.disconnecting) return this.disconnecting;
    const completion = Promise.withResolvers<void>();
    this.disconnecting = completion.promise; // Fence before any awaited cleanup.
    void (async () => {
      try {
        if (this.inFlight) {
          // Interrupt immediately. A lost listener cannot prove popup absence,
          // including when navigation was still configuring the first page.
          this.markPopupUncertain();
        } else if (this.initialized) {
          // Keep popup watchers alive while closing pages in their original
          // owning REPL. Reattached pages are borrowed: closeTab only detaches.
          const result = await this.transport.generated(`var umpiTargets=Array.from(${this.name}.tabs.values(),function(tab){return tab.targetId;}); for (var umpiOwned of ${this.name}.tabs.values()) { var umpiTabs=await listBrowserTabs(); if (umpiTabs.some(function(tab){return tab.targetId===umpiOwned.targetId;})) await closeTab(umpiOwned.page); } ${nativeTargetAbsence} umpiResult.popupUncertain=${this.name}.popupUncertain;`);
          if (result.stopped !== true || result.popupUncertain !== false) this.markPopupUncertain();
        }
      } catch { this.markPopupUncertain(); }
      finally { await this.transport.disconnect(); }
    })().then(completion.resolve, completion.reject);
    return completion.promise;
  }
  async stopTabs(targetIds: readonly string[]): Promise<BrowserStopped> {
    await this.disconnect();
    if (targetIds.some(id => !targetIdPattern.test(id))) return { stopped: false, uncertain: true };
    // Lost-REPL recovery cannot close reattached pages: closeTab only detaches
    // borrowed targets, and window.close is not supported for general recovery.
    // Keep exact ownership until absence is proved or the owner reconciles it;
    // unknown popup IDs are never guessed from a URL or tab difference.
    const recovery = new AsideMcpTransport(this.options);
    try {
      const result = await recovery.generated(`var umpiTargets=${quoted([...new Set(targetIds)])}; ${nativeTargetAbsence}`);
      return { stopped: result.stopped === true, uncertain: result.stopped !== true || this.popupUncertain };
    } catch { return { stopped: false, uncertain: true }; }
    finally { await recovery.disconnect(); }
  }
}
