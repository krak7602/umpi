import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import type { Browser, BrowserContext, Page, Route, WebSocketRoute } from "@cloudflare/playwright";
import { browserOperationPrefix, browserSitePolicyJson, requestedBrowserSite } from "../src/shared/browser.js";
import type { BrowserAssignment, BrowserAuthentication, BrowserObservation, BrowserRequest, BrowserSitePolicy } from "../src/shared/browser.js";
import { BrowserCloudRun } from "../src/worker/browser-cloud-run.js";
import type { BrowserCloudOptions, BrowserCloudStorage } from "../src/worker/browser-cloud-run.js";

class MemoryStorage implements BrowserCloudStorage {
  readonly values = new Map<string, unknown>();
  failAdmission = false;
  failReceipt = false;
  failSession = false;
  async get<T>(key: string): Promise<T | undefined> { return structuredClone(this.values.get(key)) as T | undefined; }
  async put<T>(key: string, value: T): Promise<void> {
    if (this.failSession && key === "browser-owner" && value && typeof value === "object" && "sessionId" in value && value.sessionId) { this.failSession = false; throw new Error("Lost session identity write"); }
    if (this.failReceipt && key.startsWith("browser-receipt:")) { this.failReceipt = false; throw new Error("Lost receipt write"); }
    assert.ok(Buffer.byteLength(JSON.stringify(value)) < 128 * 1024, "Every durable value is below the provider per-value bound");
    this.values.set(key, structuredClone(value));
    if (this.failAdmission && key.startsWith("browser-operation:")) { this.failAdmission = false; throw new Error("Actor lost after admission"); }
  }
  async list<T>(prefix: string): Promise<Map<string, T>> { return new Map([...this.values].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => [key, structuredClone(value) as T])); }
}
/** Deterministic session boundary simulator only. DOM behavior is exercised by the separate real Chromium fixture. */
async function fixture(policy: BrowserSitePolicy = { siteId: "account", title: "Account", origins: ["https://account.example.com"], cookieHosts: ["account.example.com"], cookieNames: ["session"], resourceHosts: ["assets.example.com"] }) {
  let now = Date.parse("2026-10-13T12:00:00Z");
  const policyDigest = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(browserSitePolicyJson(policy)))).toString("hex");
  const assignment: BrowserAssignment = { taskId: "task", runId: "run", deadlineAt: new Date(now + 120_000).toISOString(), sites: [{ site: { ...policy, version: 1, policyDigest }, startUrl: `${policy.origins[0]}/home` }] };
  const authentication: { siteId: string; state: BrowserAuthentication }[] = [{ siteId: policy.siteId, state: { version: 1, cookies: [{ name: "session", value: "synthetic-cookie-never-persist", domain: new URL(policy.origins[0]!).hostname, path: "/", expires: -1, secure: true, httpOnly: true, sameSite: "Lax" }] } }];
  const storage = new MemoryStorage();
  const state = {
    launches: 0, closes: 0, screenshots: 0, activity: 0, imports: [] as BrowserAuthentication["cookies"][], domains: undefined as string[] | undefined,
    contexts: [] as BrowserContext[], routes: [] as ((route: Route) => Promise<void>)[], sockets: [] as ((socket: WebSocketRoute) => void)[],
    contextOptions: [] as unknown[], currentUrl: assignment.sites[0]!.startUrl,
    alive: false, closedPage: false, failLaunch: false, failScreenshot: false, refuseClose: false,
    launchWait: undefined as Promise<void> | undefined, screenshotWait: undefined as Promise<void> | undefined,
    launchEntered: undefined as (() => void) | undefined, screenshotEntered: undefined as (() => void) | undefined, size: 200_000,
    closeEntered: undefined as (() => void) | undefined,
  };
  const page = {
    on() {}, mainFrame() { return {}; }, isClosed() { return state.closedPage; }, setDefaultTimeout() {},
    async goto(value: string) { state.currentUrl = value; }, url() { return state.currentUrl; }, async close() { state.closedPage = true; },
    async screenshot() {
      state.screenshots++; state.screenshotEntered?.();
      await state.screenshotWait;
      if (state.failScreenshot) throw new Error("Transport gone after dispatch");
      return Buffer.alloc(state.size, 42);
    },
  } as unknown as Page;
  const context = {
    setDefaultTimeout() {}, async route(_pattern: string, handler: (route: Route) => Promise<void>) { state.routes.push(handler); },
    async routeWebSocket(_pattern: RegExp, handler: (socket: WebSocketRoute) => void) { state.sockets.push(handler); }, async addInitScript() {}, on() {},
    async addCookies(cookies: BrowserAuthentication["cookies"]) { state.imports.push(structuredClone(cookies)); }, async newPage() { return page; },
  } as unknown as BrowserContext;
  const browser = {
    async newContext(options: unknown) { state.contextOptions.push(options); const created = { ...context }; state.contexts.push(created); return created; },
    async newBrowserCDPSession() { return { async send() { state.activity++; }, async detach() {} }; },
  } as unknown as Browser;
  const alarms: number[] = [];
  const options: BrowserCloudOptions = {
    storage, now: () => now,
    sessions: {
      async launch(domains) { state.launches++; state.domains = domains; state.alive = true; state.launchEntered?.(); await state.launchWait; if (state.failLaunch) throw new Error("Launch response lost"); return { browser, sessionId: "owned-session" }; },
      async exists(id) { assert.equal(id, "owned-session"); return state.alive; },
      async close(id) { assert.equal(id, "owned-session"); state.closes++; state.closeEntered?.(); if (!state.refuseClose) { state.alive = false; state.closedPage = true; } },
    },
    async scheduleDeadline(deadline) { alarms.push(deadline.getTime()); },
  };
  return {
    assignment, authentication, storage, state, options, alarms, run: new BrowserCloudRun(options), advance(ms: number) { now += ms; },
    async request(url: string, navigation = false, resourceType = "image", ownedPage = true) {
      let decision = "unhandled";
      await state.routes[0]!({
        request() { return { url() { return url; }, isNavigationRequest() { return navigation; }, resourceType() { return resourceType; }, frame() { return { page() { return ownedPage ? page : {}; } }; } }; },
        async continue() { decision = "continue"; }, async abort() { decision = "abort"; },
      } as unknown as Route);
      return decision;
    },
  };
}
function screenshot(sequence = 1): BrowserRequest { return { operationId: `${browserOperationPrefix("task", "run")}tool:${sequence}`, action: { kind: "screenshot", siteId: "account" } }; }

test("owned session imports once, exact replay survives eviction, bounded chunks never persist cookies", async () => {
  const f = await fixture();
  await f.run.startRun(f.assignment, f.authentication);
  await f.run.startRun(f.assignment, f.authentication);
  assert.equal(f.state.launches, 1); assert.equal(f.state.imports.length, 1);
  assert.deepEqual(f.state.domains, ["account.example.com", "assets.example.com"]);
  const receipt = await f.run.invoke(screenshot());
  assert.equal(receipt.status, "done"); assert.equal(Buffer.from(receipt.image!.data, "base64").length, 200_000);
  assert.deepEqual(await f.run.invoke(screenshot()), receipt); assert.equal(f.state.screenshots, 1);
  const restored = new BrowserCloudRun(f.options);
  assert.deepEqual(await restored.inspect(screenshot().operationId), receipt);
  assert.deepEqual(await restored.invoke(screenshot()), receipt);
  await assert.rejects(restored.invoke(screenshot(2)), /lost|restart/);
  assert.equal(JSON.stringify([...f.storage.values]).includes("synthetic-cookie-never-persist"), false);
  assert.ok([...f.storage.values.keys()].filter(key => key.startsWith("browser-receipt:")).length > 1);
  assert.deepEqual(await restored.stopRun(), { stopped: true, uncertain: false });
  assert.equal(f.state.closes, 1); assert.equal(f.state.launches, 1);
});

test("each selected site has a distinct context and only its selected cookie version is imported", async () => {
  const f = await fixture();
  const original = f.assignment.sites[0]!.site;
  const policy = { ...original, siteId: "other-account" };
  const policyDigest = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(browserSitePolicyJson(policy)))).toString("hex");
  const assignment = { ...f.assignment, sites: [...f.assignment.sites, { site: { ...policy, policyDigest }, startUrl: f.assignment.sites[0]!.startUrl }] };
  const second = { siteId: "other-account", state: { version: 1 as const, cookies: [{ ...f.authentication[0]!.state.cookies[0]!, value: "second-selected-version" }] } };
  await f.run.startRun(assignment, [...f.authentication, second]);
  assert.equal(f.state.contexts.length, 2); assert.notEqual(f.state.contexts[0], f.state.contexts[1]);
  assert.deepEqual(f.state.imports, [f.authentication[0]!.state.cookies, second.state.cookies]);
  await f.run.startRun(assignment, [f.authentication[0]!, { ...second, state: { ...second.state, cookies: [{ ...second.state.cookies[0]!, value: "changed-later" }] } }]);
  assert.equal(f.state.imports.length, 2); assert.equal(f.state.launches, 1); await f.run.stopRun();
});

test("unspecified SameSite is imported unchanged; explicit supported attributes retain their semantics", async () => {
  for (const sameSite of [undefined, "Strict", "Lax", "None"] as const) {
    const f = await fixture();
    const cookie = { ...f.authentication[0]!.state.cookies[0]! };
    delete cookie.sameSite;
    if (sameSite !== undefined) cookie.sameSite = sameSite;
    await f.run.startRun(f.assignment, [{ siteId: "account", state: { version: 1, cookies: [cookie] } }]);
    assert.deepEqual(f.state.imports[0], [cookie]);
    assert.equal(Object.hasOwn(f.state.imports[0]![0]!, "sameSite"), sameSite !== undefined);
    await f.run.stopRun();
  }
});

test("immutable owner, operation arguments, exact cookie policy and navigation scope reject without effects", async () => {
  const f = await fixture();
  await assert.rejects(f.run.startRun(f.assignment, [{ siteId: "account", state: { version: 1, cookies: [{ ...f.authentication[0]!.state.cookies[0]!, domain: ".example.com" }] } }]), /cookie policy/);
  assert.equal(f.state.launches, 0);
  await f.run.startRun(f.assignment, f.authentication);
  await assert.rejects(f.run.startRun({ ...f.assignment, runId: "other" }, f.authentication), /immutable/);
  await assert.rejects(f.run.invoke({ ...screenshot(), operationId: `${browserOperationPrefix("other", "run")}tool:1` }), /another owner/);
  await assert.rejects(f.run.invoke({ ...screenshot(), action: { kind: "navigate", siteId: "account", url: "https://attacker.example.com" } }), /outside/);
  await assert.rejects(f.run.invoke({ ...screenshot(), action: { kind: "click", siteId: "account", snapshotId: "stale", ref: "e1" } }), /Stale/);
  await f.run.invoke(screenshot());
  await assert.rejects(f.run.invoke({ ...screenshot(), action: { kind: "observe", siteId: "account" } }), /different arguments/);
  assert.equal(f.state.screenshots, 1);
  await f.run.stopRun();
});

test("requested domain imports only first-party cookies and permits its HTTPS subdomains without changing ownership", async () => {
  const f = await fixture({ ...requestedBrowserSite("https://docs.example.co.uk/start"), siteId: "account" });
  const cookie = f.authentication[0]!.state.cookies[0]!;
  const cookies = [
    { ...cookie, name: "session", domain: ".example.co.uk" },
    { ...cookie, name: "preferences", domain: "docs.example.co.uk", partitionKey: "https://docs.example.co.uk" },
  ];
  await f.run.startRun(f.assignment, [{ siteId: "account", state: { version: 1, cookies } }]);
  assert.deepEqual(f.state.imports, [cookies]);
  assert.equal(f.state.domains, undefined, "Public assets must not inherit an exact provider host list");
  for (const url of ["https://example.co.uk/path", "https://docs.example.co.uk/path", "https://deep.docs.example.co.uk/path"]) {
    assert.equal(await f.request(url, true), "continue", url);
    f.state.currentUrl = url;
    assert.equal((await f.run.invoke(screenshot(f.state.screenshots + 1))).status, "done");
  }
  for (const url of ["https://example.co.uk.attacker.com", "https://evilexample.co.uk", "https://elsewhere.co.uk", "http://example.co.uk", "https://example.co.uk:8443"]) {
    assert.equal(await f.request(url, true), "abort", url);
    await assert.rejects(f.run.invoke({ ...screenshot(10), action: { kind: "navigate", siteId: "account", url } }));
  }
  assert.equal(await f.request("https://docs.example.co.uk/popup", true, "document", false), "abort");
  const mutated = structuredClone(f.assignment);
  mutated.sites[0]!.startUrl = "https://docs.example.co.uk/later";
  await assert.rejects(f.run.startRun(mutated, f.authentication), /immutable/);
  assert.equal(f.state.launches, 1);
  await f.run.stopRun();
});

test("private-suffix tenants cannot import sibling or parent cookies or navigate to another tenant", async () => {
  const policy = { ...requestedBrowserSite("https://docs.alice.github.io"), siteId: "account" };
  assert.equal(policy.domain, "alice.github.io");
  for (const domain of [".github.io", "github.io", "bob.github.io", ".bob.github.io", "evilalice.github.io", "alice.github.io.attacker.com"]) {
    const f = await fixture(policy), cookie = { ...f.authentication[0]!.state.cookies[0]!, domain };
    await assert.rejects(f.run.startRun(f.assignment, [{ siteId: "account", state: { version: 1, cookies: [cookie] } }]), /cookie policy/);
    assert.equal(f.state.launches, 0, domain); assert.deepEqual(f.state.imports, []);
  }
  const f = await fixture(policy);
  const cookies = ["alice.github.io", ".alice.github.io", "docs.alice.github.io"].map(domain => ({ ...f.authentication[0]!.state.cookies[0]!, domain }));
  await f.run.startRun(f.assignment, [{ siteId: "account", state: { version: 1, cookies } }]);
  assert.deepEqual(f.state.imports, [cookies]);
  assert.equal(await f.request("https://docs.alice.github.io/page", true), "continue");
  for (const url of ["https://github.io", "https://bob.github.io", "https://alice.github.io.attacker.com"]) assert.equal(await f.request(url, true), "abort", url);
  await f.run.stopRun();
});

test("raw cookie attributes fail closed before provider allocation, including alternate URL and partition scopes", async () => {
  const policy = { ...requestedBrowserSite("https://docs.example.com"), siteId: "account" };
  for (const attributes of [
    { name: 1 }, { name: "bad;cookie" }, { domain: null }, { domain: ".com" }, { domain: ".other.com" },
    { value: {} }, { path: 1 }, { path: "relative" }, { expires: "forever" }, { expires: Infinity },
    { secure: 1 }, { httpOnly: "true" }, { sameSite: {} }, { sameSite: "Unsupported" },
    { url: "https://attacker.com" }, { partitionKey: 1 }, { partitionKey: "https://attacker.com" },
    { partitionKey: "https://docs.example.com/path" }, { partitionKey: "http://docs.example.com" },
  ]) {
    const f = await fixture(policy);
    const state = { version: 1, cookies: [{ ...f.authentication[0]!.state.cookies[0]!, ...attributes }] } as unknown as BrowserAuthentication;
    await assert.rejects(f.run.startRun(f.assignment, [{ siteId: "account", state }]));
    assert.equal(f.state.launches, 0, JSON.stringify(attributes)); assert.deepEqual(f.state.imports, []);
  }
  for (const entry of [null, {}, { siteId: "account", state: null }, { siteId: "account", state: { version: 1, cookies: [null] } }]) {
    const f = await fixture(policy);
    await assert.rejects(f.run.startRun(f.assignment, [entry] as unknown as { siteId: string; state: BrowserAuthentication }[]));
    assert.equal(f.state.launches, 0);
  }
});

test("anonymous requested site loads public cross-CDN assets but denies private targets and long-lived transports", async t => {
  const f = await fixture({ ...requestedBrowserSite("https://newsite.example.com"), siteId: "account" });
  await f.run.startRun(f.assignment, [{ siteId: "account", state: { version: 1, cookies: [] } }]);
  assert.deepEqual(f.state.imports, [[]]); assert.equal(f.state.domains, undefined);
  for (const [url, type] of [
    ["https://cdn.jsdelivr.net/library.js", "script"], ["https://fonts.googleapis.com/css", "stylesheet"],
    ["https://fonts.gstatic.com/font.woff2", "font"], ["https://images.unsplash.com/photo", "image"],
    ["https://api.example.net:443/data", "fetch"], ["https://video.example.org/clip", "media"],
  ]) assert.equal(await f.request(url!, false, type!), "continue", url);
  for (const url of [
    "https://127.0.0.1", "https://[::1]", "https://169.254.169.254/latest", "https://10.0.0.1",
    "https://localhost", "https://internal.local", "https://router.internal", "https://intranet",
    "https://cdn.jsdelivr.net:8443/asset", "https://user:secret@cdn.jsdelivr.net/asset",
    "http://cdn.jsdelivr.net/asset", "ftp://cdn.jsdelivr.net/asset", "data:text/plain,asset", "wss://cdn.jsdelivr.net/live",
  ]) assert.equal(await f.request(url), "abort", url);
  assert.equal(await f.request("https://cdn.jsdelivr.net/other-page", true), "abort", "CDN is a resource permission, not navigation");
  for (const type of ["websocket", "eventsource", "serviceworker", "unsupported"]) assert.equal(await f.request("https://cdn.jsdelivr.net/live", false, type), "abort", type);
  let closed = 0;
  f.state.sockets[0]!({ close() { closed++; } } as unknown as WebSocketRoute);
  assert.equal(closed, 1);
  assert.deepEqual(f.state.contextOptions[0], { serviceWorkers: "block", acceptDownloads: false, viewport: { width: 1280, height: 800 } });
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
  f.state.refuseClose = true;
  const entered = Promise.withResolvers<void>(); f.state.closeEntered = entered.resolve;
  const stopping = f.run.stopRun(); await entered.promise; t.mock.timers.tick(10_000);
  assert.deepEqual(await stopping, { stopped: false, uncertain: true });
  assert.equal(await f.request("https://cdn.jsdelivr.net/asset"), "abort", "Stop still fences allowed assets");
  f.state.refuseClose = false;
  assert.deepEqual(await f.run.stopRun(), { stopped: true, uncertain: false });
});

test("domain navigation without public assets retains bounded wildcard provider guardrails; exact mode remains exact", async () => {
  const policy = { ...requestedBrowserSite("https://docs.example.com"), siteId: "account" };
  delete policy.resources;
  const domain = await fixture(policy); await domain.run.startRun(domain.assignment, domain.authentication);
  assert.deepEqual(domain.state.domains, ["example.com", "*.example.com"]);
  assert.equal(await domain.request("https://docs.example.com/page", true), "continue");
  assert.equal(await domain.request("https://cdn.jsdelivr.net/image"), "abort"); await domain.run.stopRun();
  const exact = await fixture(); await exact.run.startRun(exact.assignment, exact.authentication);
  assert.deepEqual(exact.state.domains, ["account.example.com", "assets.example.com"]);
  assert.equal(await exact.request("https://account.example.com/page", true), "continue");
  assert.equal(await exact.request("https://other.account.example.com/page", true), "abort");
  assert.equal(await exact.request("https://assets.example.com/image"), "continue");
  assert.equal(await exact.request("https://cdn.jsdelivr.net/image"), "abort");
  assert.equal(await exact.request("https://assets.example.com/page", true), "abort"); await exact.run.stopRun();
});

test("current page moving outside a requested domain fails before screenshot effects", async () => {
  const f = await fixture({ ...requestedBrowserSite("https://docs.example.com"), siteId: "account" });
  await f.run.startRun(f.assignment, f.authentication);
  f.state.currentUrl = "https://attacker.com";
  const denied = await f.run.invoke(screenshot());
  assert.equal(denied.status, "failed"); assert.equal(f.state.screenshots, 0);
  await f.run.stopRun();
});

test("pre-start stop survives eviction and permanently rejects late allocation", async () => {
  const f = await fixture();
  assert.deepEqual(await f.run.stopRun(), { stopped: true, uncertain: false });
  await assert.rejects(new BrowserCloudRun(f.options).startRun(f.assignment, f.authentication), /stopped before/);
  assert.equal(f.state.launches, 0);
});

test("admission write loss is uncertain without effect or automatic replay", async () => {
  const f = await fixture(); await f.run.startRun(f.assignment, f.authentication);
  f.storage.failAdmission = true;
  await assert.rejects(f.run.invoke(screenshot()), /Actor lost/);
  const recovered = new BrowserCloudRun(f.options);
  assert.equal((await recovered.inspect(screenshot().operationId)).status, "uncertain");
  assert.equal((await recovered.invoke(screenshot())).status, "uncertain");
  assert.equal(f.state.screenshots, 0); await recovered.stopRun();
});

test("in-flight exact replay returns running, other dispatch rejected, stop fences completion", async () => {
  const f = await fixture(); await f.run.startRun(f.assignment, f.authentication);
  const wait = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>();
  f.state.screenshotWait = wait.promise; f.state.screenshotEntered = entered.resolve;
  const invocation = f.run.invoke(screenshot()); await entered.promise;
  assert.equal((await f.run.invoke(screenshot())).status, "running");
  await assert.rejects(f.run.invoke(screenshot(2)), /already has/);
  assert.deepEqual(await f.run.stopRun(), { stopped: true, uncertain: false });
  wait.resolve(); assert.equal((await invocation).status, "uncertain");
  assert.equal((await f.run.inspect(screenshot().operationId)).status, "uncertain");
  await assert.rejects(f.run.invoke(screenshot(2)), /no longer admits/);
  assert.equal(f.state.screenshots, 1); assert.equal(f.state.closes, 1);
});

test("reconstructed actor durably fences a lost in-flight reply and late completion cannot restore certainty", async () => {
  const f = await fixture(); await f.run.startRun(f.assignment, f.authentication);
  const wait = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>();
  f.state.screenshotWait = wait.promise; f.state.screenshotEntered = entered.resolve;
  const invocation = f.run.invoke(screenshot()); await entered.promise;
  const recovered = new BrowserCloudRun(f.options);
  assert.equal((await recovered.inspect(screenshot().operationId)).status, "uncertain");
  await assert.rejects(recovered.invoke(screenshot(2)), /lost|restart/);
  wait.resolve(); assert.equal((await invocation).status, "uncertain");
  assert.equal((await recovered.invoke(screenshot())).status, "uncertain");
  assert.equal(f.state.screenshots, 1); await recovered.stopRun();
});

test("transport or receipt loss never redispatches the admitted operation", async () => {
  for (const failure of ["transport", "receipt"] as const) {
    const f = await fixture(); await f.run.startRun(f.assignment, f.authentication);
    if (failure === "transport") f.state.failScreenshot = true; else f.storage.failReceipt = true;
    assert.equal((await f.run.invoke(screenshot())).status, "uncertain");
    assert.equal((await f.run.invoke(screenshot())).status, "uncertain");
    assert.equal(f.state.screenshots, 1); await f.run.stopRun();
  }
});

test("lost launch response remains uncertain, never closes an unowned session or restarts", async () => {
  const f = await fixture(); f.state.failLaunch = true;
  await assert.rejects(f.run.startRun(f.assignment, f.authentication), /interrupted/);
  assert.deepEqual(await f.run.stopRun(), { stopped: false, uncertain: true });
  await assert.rejects(new BrowserCloudRun(f.options).startRun(f.assignment, f.authentication), /already admitted/);
  assert.equal(f.state.launches, 1); assert.equal(f.state.closes, 0);
});

test("known launch whose identity write fails can close only its locally owned session", async () => {
  const f = await fixture(); f.storage.failSession = true;
  await assert.rejects(f.run.startRun(f.assignment, f.authentication), /interrupted/);
  assert.deepEqual(await f.run.stopRun(), { stopped: true, uncertain: false });
  assert.equal(f.state.launches, 1); assert.equal(f.state.closes, 1); assert.equal(f.state.imports.length, 0);
});

test("stop during launch preserves uncertainty until the late owned identity is actually closed", async () => {
  const f = await fixture(); const launch = Promise.withResolvers<void>(); f.state.launchWait = launch.promise;
  const entered = Promise.withResolvers<void>(); f.state.launchEntered = entered.resolve;
  const starting = f.run.startRun(f.assignment, f.authentication);
  await entered.promise;
  assert.deepEqual(await f.run.stopRun(), { stopped: false, uncertain: true });
  launch.resolve(); await assert.rejects(starting, /interrupted/);
  assert.deepEqual(await f.run.stopRun(), { stopped: true, uncertain: false });
  assert.equal(f.state.imports.length, 0); assert.equal(f.state.closes, 1);
});

test("idle and hard deadlines are bounded; activity sends an actual session command and cannot extend hard limit", async () => {
  const f = await fixture(); await f.run.startRun(f.assignment, f.authentication);
  assert.equal(f.alarms.at(-1), Date.parse(f.assignment.deadlineAt) - 60_000);
  f.advance(30_000); await f.run.activity(); assert.equal(f.state.activity, 1);
  assert.equal(f.alarms.at(-1), Date.parse(f.assignment.deadlineAt) - 30_000);
  f.advance(30_000); await f.run.activity(); assert.equal(f.alarms.at(-1), Date.parse(f.assignment.deadlineAt));
  f.advance(60_000); await f.run.enforceDeadline(); assert.equal(f.state.closes, 1);
  await assert.rejects(f.run.invoke(screenshot()), /no longer admits/);
  const idle = await fixture(); await idle.run.startRun(idle.assignment, idle.authentication); idle.advance(60_000);
  await assert.rejects(idle.run.activity(), /lease/); assert.equal(idle.state.closes, 1);
});

test("absence confirms stop, while provider-present session never gets a fake stop acknowledgement", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
  const f = await fixture(); await f.run.startRun(f.assignment, f.authentication); f.state.refuseClose = true;
  const entered = Promise.withResolvers<void>(); f.state.closeEntered = entered.resolve;
  const stopping = f.run.stopRun(); await entered.promise; t.mock.timers.tick(10_000);
  assert.deepEqual(await stopping, { stopped: false, uncertain: true });
  await assert.rejects(f.run.invoke(screenshot()), /no longer admits/);
  f.state.refuseClose = false; assert.deepEqual(await f.run.stopRun(), { stopped: true, uncertain: false });
  assert.deepEqual(await f.run.stopRun(), { stopped: true, uncertain: false }); assert.equal(f.state.closes, 2);
  const gone = await fixture(); await gone.run.startRun(gone.assignment, gone.authentication); gone.state.alive = false;
  await assert.rejects(gone.run.invoke(screenshot()), /session was lost/);
  assert.deepEqual(await gone.run.stopRun(), { stopped: true, uncertain: false }); assert.equal(gone.state.closes, 0);
});

test("asynchronous destruction waits for owned-session absence without admitting work or issuing another close", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
  const f = await fixture(); await f.run.startRun(f.assignment, f.authentication);
  f.state.refuseClose = true;
  const entered = Promise.withResolvers<void>(); f.state.closeEntered = entered.resolve;
  let settled = false;
  const stopping = f.run.stopRun().then(result => { settled = true; return result; });
  await entered.promise;
  await assert.rejects(f.run.invoke(screenshot()), /no longer admits/);
  assert.equal(settled, false, "A destruction request is not a stopped acknowledgement");
  assert.equal(f.state.screenshots, 0);
  f.state.alive = false; f.state.closedPage = true;
  t.mock.timers.tick(100);
  assert.deepEqual(await stopping, { stopped: true, uncertain: false });
  assert.equal(f.state.closes, 1);
  await assert.rejects(new BrowserCloudRun(f.options).startRun(f.assignment, f.authentication), /already admitted/);
  assert.equal(f.state.launches, 1);
});

test("provider close and absence share one ten-second stop budget, and late destruction cannot restore certainty", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
  const f = await fixture(); await f.run.startRun(f.assignment, f.authentication);
  const entered = Promise.withResolvers<void>(), closeReply = Promise.withResolvers<void>();
  f.options.sessions.close = async id => {
    assert.equal(id, "owned-session"); f.state.closes++; entered.resolve(); await closeReply.promise;
  };
  const stopping = f.run.stopRun(); await entered.promise;
  t.mock.timers.tick(9_000);
  closeReply.resolve();
  await assert.rejects(f.run.invoke(screenshot()), /no longer admits/);
  t.mock.timers.tick(1_000);
  assert.deepEqual(await stopping, { stopped: false, uncertain: true });
  assert.equal(f.state.closes, 1);
  f.state.alive = false; f.state.closedPage = true;
  t.mock.timers.tick(100);
  const owner = f.storage.values.get("browser-owner");
  assert.ok(owner && typeof owner === "object" && "phase" in owner);
  assert.equal(owner.phase, "stopping");
  await assert.rejects(new BrowserCloudRun(f.options).startRun(f.assignment, f.authentication), /already admitted/);
  assert.equal(f.state.launches, 1);
  assert.deepEqual(await f.run.stopRun(), { stopped: true, uncertain: false });
  assert.equal(f.state.closes, 1);
});

test("screenshots exceeding the bound return explicit failure rather than truncated success", async () => {
  const f = await fixture(); await f.run.startRun(f.assignment, f.authentication); f.state.size = 1_048_577;
  const receipt = await f.run.invoke(screenshot()); assert.equal(receipt.status, "uncertain"); assert.match(receipt.error!, /byte bound/); assert.equal(receipt.image, undefined);
  await f.run.stopRun();
});

test("real Chromium excludes credential contents, fences changed controls, preserves real Enter, and rejects oversized observations", { skip: !process.env.PLAYWRIGHT_MODULE }, async () => {
  // Test-only runtime-selected isolated driver supplied by integration, not an
  // author-known production import or fallback; the runner pins its module/version.
  const driver: { chromium: { launch(options: { executablePath?: string; headless: boolean; args: string[] }): Promise<Browser> } } = await import(process.env.PLAYWRIGHT_MODULE!);
  let html = "", submits = 0;
  const server = createServer((request, response) => {
    if (request.url === "/submit") { submits++; response.end("submitted"); return; }
    response.setHeader("Content-Type", "text/html"); response.end(`<!doctype html><title>Fixture</title><body>${html}</body>`);
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const activeRuns: BrowserCloudRun[] = [];
  const open = async (content: string) => {
    html = content;
    const f = await fixture(), policy = { ...f.assignment.sites[0]!.site, origins: [origin], cookieHosts: ["127.0.0.1"], resourceHosts: [] };
    policy.policyDigest = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(browserSitePolicyJson(policy)))).toString("hex");
    const assignment: BrowserAssignment = { ...f.assignment, sites: [{ site: policy, startUrl: origin }] };
    let browser: Browser | undefined, lookups = 0;
    let onLookup: ((count: number, page: Page) => Promise<void>) | undefined;
    const run = new BrowserCloudRun({
      ...f.options, allowLoopback: true,
      sessions: {
        async launch() { browser = await driver.chromium.launch({ executablePath: process.env.CHROMIUM_PATH, headless: true, args: ["--no-sandbox"] }); return { browser, sessionId: "isolated-regression" }; },
        async exists(id) { assert.equal(id, "isolated-regression"); if (browser?.isConnected()) await onLookup?.(++lookups, browser.contexts()[0]!.pages()[0]!); return browser?.isConnected() ?? false; },
        async close(id) { assert.equal(id, "isolated-regression"); await browser?.close(); },
      },
    });
    activeRuns.push(run);
    await run.startRun(assignment, [{ siteId: "account", state: { version: 1, cookies: [] } }]);
    let sequence = 0;
    const invoke = (action: BrowserRequest["action"]) => run.invoke({ operationId: `${browserOperationPrefix("task", "run")}dom:${++sequence}`, action });
    const observed = await invoke({ kind: "observe", siteId: "account" });
    return { run, invoke, observed, page: browser!.contexts()[0]!.pages()[0]!, arm(hook: (count: number, page: Page) => Promise<void>) { lookups = 0; onLookup = hook; } };
  };
  const ref = (observation: BrowserObservation, label: string) => {
    const line = observation.tree.split("\n").find(value => /^e\d+ /.test(value) && value.includes(label)); assert.ok(line, label);
    return { siteId: "account", snapshotId: observation.snapshotId, ref: line.split(" ")[0]! };
  };
  try {
    const secret = await open(`<label>API key <input name="api_key" aria-label="API key" value="api-secret"></label>
      <textarea name="token" aria-label="Token">textarea-secret</textarea>
      <div contenteditable="true" aria-label="Private key"><span>editable-secret</span><button>nested-secret</button></div>
      <input name="access_key" aria-label="Access key" value="access-secret"><input name="private_key" aria-label="Private key input" value="private-secret">
      <button aria-label="Wrapper">Visible <textarea name="token">ancestor-secret</textarea></button>`);
    assert.equal(secret.observed.status, "done", secret.observed.error);
    for (const value of ["api-secret", "textarea-secret", "editable-secret", "nested-secret", "access-secret", "private-secret", "ancestor-secret"]) {
      assert.equal(secret.observed.observation!.tree.includes(value), false, value);
    }
    for (const label of ["API key", "Token", "Private key", "Access key", "Private key input"]) {
      const result = await secret.invoke({ kind: "fill", ...ref(secret.observed.observation!, label), text: "forbidden-model-value" });
      assert.equal(result.status, "failed"); assert.match(result.error!, /Credential/);
    }
    assert.equal(await secret.page.locator("input[name=api_key]").inputValue(), "api-secret");
    await secret.run.stopRun();

    for (const control of [
      `<input id="field" aria-label="Focus race" onfocus="this.type='password';this.name='api_key'">`,
      `<textarea id="field" aria-label="Focus race" onfocus="this.name='access_key'"></textarea>`,
      `<div id="field" contenteditable="true" aria-label="Focus race" onfocus="this.setAttribute('aria-label','Private key')"></div>`,
    ]) {
      const focused = await open(control);
      const denied = await focused.invoke({ kind: "fill", ...ref(focused.observed.observation!, "Focus race"), text: "forbidden-model-value" });
      assert.equal(denied.status, "failed"); assert.match(denied.error!, /Credential/);
      assert.equal(await focused.page.locator("#field").evaluate(node => node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement ? node.value : node.textContent), "");
      await focused.run.stopRun();
    }

    const movedOnFocus = await open(`<input id="field" aria-label="Focus history" onfocus="history.pushState(null,'','/changed-on-focus')">`);
    const focusDenied = await movedOnFocus.invoke({ kind: "fill", ...ref(movedOnFocus.observed.observation!, "Focus history"), text: "not-written" });
    assert.equal(focusDenied.status, "failed"); assert.match(focusDenied.error!, /Stale/);
    assert.equal(await movedOnFocus.page.locator("#field").inputValue(), "");
    assert.equal(new URL(movedOnFocus.page.url()).pathname, "/changed-on-focus");
    await movedOnFocus.run.stopRun();

    for (const kind of ["click", "fill", "press"] as const) {
      const changed = await open(`<input id="field" aria-label="Field"><button id="button" onclick="document.body.dataset.clicked='yes'">Commit</button>`);
      changed.arm(async (count, page) => {
        if (count === (kind === "press" ? 3 : 2)) await page.evaluate(() => {
          document.querySelector("#button")!.textContent = "Changed target";
          document.querySelector("#field")!.setAttribute("aria-label", "Changed field");
        });
      });
      const target = ref(changed.observed.observation!, kind === "click" ? "Commit" : "Field");
      const result = await changed.invoke(kind === "click" ? { kind, ...target } : kind === "fill" ? { kind, ...target, text: "not-written" } : { kind, ...target, key: "Enter" });
      assert.equal(result.status, "failed"); assert.match(result.error!, /Stale/);
      assert.equal(await changed.page.locator("#field").inputValue(), "");
      assert.equal(await changed.page.getAttribute("body", "data-clicked"), null); await changed.run.stopRun();
    }

    for (const kind of ["click", "fill", "press"] as const) {
      const moved = await open(`<input id="field" aria-label="Field"><button onclick="document.body.dataset.clicked='yes'">Commit</button>`);
      moved.arm(async (count, page) => {
        if (count === (kind === "press" ? 3 : 2)) await page.evaluate(() => history.replaceState(null, "", "/changed-generation"));
      });
      const target = ref(moved.observed.observation!, kind === "click" ? "Commit" : "Field");
      const denied = await moved.invoke(kind === "click" ? { kind, ...target } : kind === "fill" ? { kind, ...target, text: "not-written" } : { kind, ...target, key: "Enter" });
      assert.equal(denied.status, "failed"); assert.match(denied.error!, /Stale/);
      assert.equal(await moved.page.locator("#field").inputValue(), "");
      assert.equal(await moved.page.getAttribute("body", "data-clicked"), null);
      await moved.run.stopRun();
    }

    const enter = await open(`<form action="/submit" method="post"><input aria-label="Search" name="q"><button>Submit</button></form>`);
    const submission = enter.page.waitForURL(`${origin}/submit`);
    const result = await enter.invoke({ kind: "press", ...ref(enter.observed.observation!, "Search"), key: "Enter" });
    await submission; assert.equal(result.status, "done", result.error); assert.equal(submits, 1); await enter.run.stopRun();

    for (const content of ["x".repeat(2_000_000), `<button aria-label="${"l".repeat(100_000)}">Short</button>`, "<button>Node</button>".repeat(513)]) {
      const oversized = await open(content);
      assert.notEqual(oversized.observed.status, "done"); assert.match(oversized.observed.error!, /byte bound/);
      assert.equal(oversized.observed.observation, undefined); await oversized.run.stopRun();
    }
  } finally {
    for (const run of activeRuns) await run.stopRun();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
