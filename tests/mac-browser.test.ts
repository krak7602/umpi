import assert from "node:assert/strict";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { closeSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { setImmediate as immediate } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";
import { browserOperationPrefix, browserSitePolicyJson, MAX_BROWSER_OPERATIONS, requestedBrowserSite } from "../src/shared/browser.ts";
import type { BrowserAction, BrowserAssignment, BrowserExecutorPollResult, BrowserExecutorReport, BrowserReceipt, BrowserRequest, BrowserSitePolicy, BrowserStopped } from "../src/shared/browser.ts";
import { parseConfig, privateFile } from "../src/mac/config.ts";
import type { MacConfig } from "../src/mac/config.ts";
import { BrowserJournal, MacBrowserExecutor, parseBrowserPollResult, readBrowserJournalStatus } from "../src/mac/browser.ts";
import { AsideBrowserBridge, AsideConnectionLost, AsideMcpTransport, BrowserActionRejected } from "../src/mac/browser-aside.ts";
import type { BrowserTab, NativeBrowserBridge } from "../src/mac/browser-aside.ts";

const policy: BrowserSitePolicy = { siteId: "fixture", title: "Controlled fixture", origins: ["https://fixture.example"], cookieHosts: [], cookieNames: [], resourceHosts: ["fixture.example"] };
function assignment(runId = "run", site = policy): BrowserAssignment {
  return { taskId: "task", runId, deadlineAt: new Date(Date.now() + 60_000).toISOString(), sites: [{ site: { ...site, version: 1, policyDigest: createHash("sha256").update(browserSitePolicyJson(site)).digest("hex") }, startUrl: `${site.origins[0]}/fixture` }] };
}
function request(grant: BrowserAssignment, action: BrowserAction = { kind: "observe", siteId: "fixture" }, suffix = "read"): BrowserRequest { return { operationId: browserOperationPrefix(grant.taskId, grant.runId) + suffix, action }; }
function poll(grant: BrowserAssignment, requests: BrowserRequest[] = [], cancel = false): BrowserExecutorPollResult { return { assignment: grant, requests, cancel }; }
function fixture(t: TestContext, overrides: Partial<MacConfig> = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "umpi-browser-test-")));
  const config: MacConfig = { executorId: "executor-test", executorToken: "not-a-real-token-with-at-least-32-characters", serverUrl: "https://coordinator.example", workspaces: [root], pollIntervalMs: 100, coding: { enabled: false }, browser: { enabled: true, allSites: false, sites: [policy] }, ...overrides };
  const journal = new BrowserJournal(join(root, "state"), config);
  const cleanup: (() => void | Promise<void>)[] = [];
  t.after(async () => { for (const close of cleanup) await close(); journal.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, config, journal, cleanup };
}
async function until(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const limit = performance.now() + 10_000;
  while (!await predicate()) { if (performance.now() > limit) throw new Error("Browser fixture did not settle"); await immediate(); }
}
async function reports(executor: MacBrowserExecutor): Promise<BrowserExecutorReport[]> {
  const result: BrowserExecutorReport[] = [];
  await executor.flushReports(async report => { result.push(report); });
  return result;
}
async function terminal(executor: MacBrowserExecutor, operationId: string): Promise<BrowserReceipt> {
  let result: BrowserReceipt | undefined;
  await until(async () => { for (const report of await reports(executor)) if (report.kind === "receipt" && report.receipt.operationId === operationId && report.receipt.status !== "running") result = report.receipt; return !!result; });
  return result!;
}

class ControlledBridge implements NativeBrowserBridge {
  opened: string[] = [];
  closed: string[][] = [];
  effects: BrowserAction[] = [];
  openingGate: PromiseWithResolvers<string> | undefined;
  effectGate: PromiseWithResolvers<{ observation: { siteId: string; snapshotId: string; url: string; title: string; tree: string } }> | undefined;
  locations: Record<string, string> = {};
  stopResult: BrowserStopped = { stopped: true, uncertain: false };
  beforeEffect: ((action: BrowserAction) => void) | undefined;
  failInvoke = false;
  sequence = 0;
  async openTab(siteId: string, marker: string): Promise<string> { assert.match(marker, /^about:blank#umpi-browser-[a-f0-9]{64}$/); this.opened.push(siteId); return this.openingGate ? this.openingGate.promise : `owned-${siteId}`; }
  async configureTab(tab: BrowserTab, assignment: BrowserAssignment): Promise<void> { this.locations[tab.siteId] = assignment.sites.find(scope => scope.site.siteId === tab.siteId)!.startUrl; }
  async invoke(tab: BrowserTab, action: BrowserAction) {
    this.beforeEffect?.(action); this.effects.push(action);
    if (this.failInvoke) throw new AsideConnectionLost();
    if (this.effectGate) return this.effectGate.promise;
    return { observation: { siteId: tab.siteId, snapshotId: `snapshot-${++this.sequence}`, url: this.locations[tab.siteId]!, title: "fixture", tree: "button Action [ref=e1]" } };
  }
  async disconnect(): Promise<void> { this.openingGate?.reject(new AsideConnectionLost()); this.effectGate?.reject(new AsideConnectionLost()); await immediate(); }
  async stopTabs(targetIds: readonly string[]): Promise<BrowserStopped> { this.closed.push([...targetIds]); return this.stopResult; }
}
function executorFixture(t: TestContext) {
  const f = fixture(t), bridge = new ControlledBridge();
  const executor = new MacBrowserExecutor(f.config, f.journal, { bridgeFactory: () => bridge });
  f.cleanup.push(() => executor.shutdown());
  return { ...f, bridge, executor };
}

test("browser journal is private, exclusive and bound to executor and coordinator origin", t => {
  const f = fixture(t);
  assert.equal(statSync(f.journal.directory).mode & 0o777, 0o700);
  closeSync(privateFile(join(f.journal.directory, "browser.sqlite")));
  assert.throws(() => new BrowserJournal(f.journal.directory, f.config), /already in use/);
  assert.throws(() => new MacBrowserExecutor({ ...f.config, executorId: "another" }, f.journal), /identity/);
  f.journal.close();
  assert.throws(() => new BrowserJournal(join(f.root, "state"), { ...f.config, executorId: "another" }), /another executor/);
  assert.throws(() => new BrowserJournal(join(f.root, "state"), { ...f.config, serverUrl: "https://different.example" }), /coordinator/);
  const reopened = new BrowserJournal(join(f.root, "state"), { ...f.config, serverUrl: "https://coordinator.example/" });
  reopened.close();
});

test("operation admission precedes dispatch, exact replay is immutable and mismatched reuse is refused", t => {
  const f = fixture(t), grant = assignment(), input = request(grant);
  f.journal.accept(grant);
  assert.equal(f.journal.admit(grant, input).fresh, true);
  assert.equal(f.journal.result(input.operationId)?.status, "running");
  assert.equal(f.journal.admit(grant, input).fresh, false);
  assert.throws(() => f.journal.admit(grant, { ...input, action: { kind: "screenshot", siteId: "fixture" } }), /different input/);
  assert.throws(() => f.journal.admit({ ...grant, deadlineAt: new Date(Date.now() + 120_000).toISOString() }, input), /immutable grant/);
  f.journal.dispatch(grant, input.operationId);
  assert.throws(() => f.journal.dispatch(grant, input.operationId), /unused admission/);
  const done: BrowserReceipt = { operationId: input.operationId, status: "done", observation: { siteId: "fixture", snapshotId: "snapshot", url: "https://fixture.example/fixture", title: "fixture", tree: "button [ref=e1]" } };
  f.journal.receipt(grant, done);
  assert.deepEqual(f.journal.admit(grant, input), { fresh: false, receipt: done });
  assert.throws(() => f.journal.receipt(grant, { operationId: input.operationId, status: "failed", error: "changed" }), /immutable/);
  f.journal.stopped(grant, true, false);
  assert.deepEqual(f.journal.admit(grant, input).receipt, done);
  assert.equal(f.journal.admit(grant, request(grant, { kind: "observe", siteId: "fixture" }, "new")).receipt.status, "failed");
});

test("journal restart never dispatches admitted work and preserves dispatched uncertainty and owner confirmation", t => {
  const f = fixture(t), grant = assignment();
  f.journal.accept(grant);
  const admitted = request(grant, undefined, "admitted"), dispatched = request(grant, undefined, "dispatched");
  f.journal.admit(grant, admitted); f.journal.admit(grant, dispatched); f.journal.dispatch(grant, dispatched.operationId);
  const marker = f.journal.openingTab(grant, "fixture"); assert.match(marker, /^about:blank#/);
  f.journal.ownedTab(grant.runId, "fixture", "only-owned-target");
  f.journal.close();
  const restarted = new BrowserJournal(join(f.root, "state"), f.config);
  f.cleanup.push(() => restarted.close());
  assert.equal(restarted.result(admitted.operationId)?.status, "failed");
  assert.equal(restarted.result(dispatched.operationId)?.status, "uncertain");
  assert.equal(restarted.recoveryPaused, true);
  assert.equal(restarted.snapshot().outstanding[0]?.ownedTabs, 1);
  const interruptedStop = restarted.pendingReports().map(item => JSON.parse(item.payload) as BrowserExecutorReport).find(report => report.kind === "stopped");
  assert.equal(interruptedStop?.kind === "stopped" && interruptedStop.stopped, false);
  assert.throws(() => restarted.accept(assignment("next")), /unreconciled/);
  const before = restarted.result(dispatched.operationId);
  restarted.confirmStopped(); restarted.confirmStopped();
  assert.deepEqual(restarted.result(dispatched.operationId), before);
  const ownerReports = restarted.pendingReports().map(item => JSON.parse(item.payload) as BrowserExecutorReport).filter(report => report.kind === "stopped" && report.ownerConfirmedStopped);
  assert.equal(ownerReports.length, 1);
  assert.equal(ownerReports[0]?.kind === "stopped" && ownerReports[0].stopped, true);
  assert.equal(restarted.recoveryPaused, false);
  for (const pending of restarted.pendingReports()) restarted.acknowledge(pending);
  assert.equal(restarted.activeRunId, null);
  assert.equal(restarted.accept(assignment("next")), "new");
});

test("old running report acknowledgement cannot acknowledge a newer terminal receipt", t => {
  const f = fixture(t), grant = assignment(), input = request(grant);
  f.journal.accept(grant); f.journal.admit(grant, input);
  const old = f.journal.pendingReports()[0]!;
  f.journal.dispatch(grant, input.operationId);
  f.journal.receipt(grant, { operationId: input.operationId, status: "failed", error: "controlled refusal" });
  f.journal.acknowledge(old);
  assert.equal(f.journal.pendingReports().length, 1);
  const pending = JSON.parse(f.journal.pendingReports()[0]!.payload) as Extract<BrowserExecutorReport, { kind: "receipt" }>;
  assert.equal(pending.receipt.status, "failed");
});

test("operation capacity and task-run identities are bounded before effects", t => {
  const f = fixture(t), grant = assignment(); f.journal.accept(grant);
  assert.throws(() => f.journal.admit(grant, { ...request(grant), operationId: "browser:other-run:read" }), /task run/);
  assert.throws(() => f.journal.admit(grant, request(grant, { kind: "observe", siteId: "not-approved" })), /assigned sites/);
  for (let i = 0; i < MAX_BROWSER_OPERATIONS; i++) f.journal.admit(grant, request(grant, undefined, `read-${i}`));
  assert.throws(() => f.journal.admit(grant, request(grant, undefined, "overflow")), /limit/);
  assert.equal(f.journal.snapshot().recordedOperations, MAX_BROWSER_OPERATIONS);
});

test("poll parser rejects arbitrary operations, unassigned work, duplicates and hosted loopback", () => {
  const grant = assignment(), input = request(grant);
  assert.deepEqual(parseBrowserPollResult(poll(grant, [input])), poll(grant, [input]));
  assert.throws(() => parseBrowserPollResult({ assignment: null, requests: [input], cancel: false }));
  assert.throws(() => parseBrowserPollResult(poll(grant, [input, input])));
  assert.throws(() => parseBrowserPollResult(poll(grant, [{ ...input, action: { kind: "eval", siteId: "fixture", code: "process.exit()" } } as unknown as BrowserRequest])));
  assert.throws(() => parseBrowserPollResult({ ...poll(grant), shell: "echo" }));
  const local = assignment("local", { ...policy, origins: ["http://127.0.0.1:12345"] });
  assert.throws(() => parseBrowserPollResult(poll(local)));
  assert.equal(parseBrowserPollResult(poll(local), true).assignment?.runId, "local");
});

test("native consumer is asynchronous and durably admits effects independently from coding or shell lanes", async t => {
  const f = executorFixture(t), grant = assignment(), input = request(grant);
  f.bridge.beforeEffect = () => {
    const database = new DatabaseSync(join(f.journal.directory, "browser.sqlite"), { readOnly: true });
    try { const row = database.prepare("SELECT phase,request_digest FROM operations WHERE operation_id=?").get(input.operationId); assert.equal(row?.phase, "dispatched"); assert.match(String(row?.request_digest), /^[a-f0-9]{64}$/); }
    finally { database.close(); }
  };
  await f.executor.handlePoll(poll(grant, [input]));
  const result = await terminal(f.executor, input.operationId);
  assert.equal(result.status, "done"); assert.equal(f.bridge.effects.length, 1);
  await f.executor.handlePoll(poll(grant, [input]));
  assert.deepEqual(await terminal(f.executor, input.operationId), result);
  assert.equal(f.bridge.effects.length, 1);
  assert.equal(f.executor.activeRunId, grant.runId);
  await f.executor.handlePoll({ assignment: null, requests: [], cancel: false });
  assert.equal(f.executor.activeRunId, grant.runId);
  await f.executor.shutdown();
  assert.deepEqual(f.bridge.closed, [["owned-fixture"]]);
  const stopped = (await reports(f.executor)).find(report => report.kind === "stopped");
  assert.equal(stopped?.kind === "stopped" && stopped.uncertain, false);
  assert.equal(stopped?.kind === "stopped" && stopped.stopped, true);
  assert.equal(f.executor.activeRunId, null);
});

test("assignment policy digests must match both the local approval and assigned policy", async t => {
  const f = executorFixture(t), grant = assignment();
  grant.sites[0]!.site.origins = ["https://not-approved.example"];
  grant.sites[0]!.startUrl = "https://not-approved.example/";
  await f.executor.handlePoll(poll(grant));
  assert.deepEqual(f.bridge.opened, []);
  assert.equal((await reports(f.executor)).some(report => report.kind === "stopped" && !report.uncertain), true);
  const advertised = f.executor.advertisedSites(); advertised[0]!.policyDigest = "tampered";
  assert.notEqual(f.executor.advertisedSites()[0]!.policyDigest, "tampered");
});

test("disabled or unavailable browser starts no tab and does not advertise grants", async t => {
  const f = fixture(t, { browser: { enabled: false, allSites: false, sites: [policy] } }), bridge = new ControlledBridge();
  const executor = new MacBrowserExecutor(f.config, f.journal, { bridgeFactory: () => bridge });
  assert.equal(executor.shouldPoll, false); assert.equal(executor.available, false); assert.deepEqual(executor.advertisedSites(), []);
  await executor.handlePoll(poll(assignment()));
  assert.equal(bridge.opened.length, 0); assert.equal(executor.shouldPoll, true);
  await reports(executor); assert.equal(executor.shouldPoll, false);
});

test("browser config defaults closed and guards the explicit all-site opt-in", t => {
  const f = fixture(t);
  assert.deepEqual(parseConfig({ ...f.config, browser: undefined }).browser, { enabled: false, allSites: false, sites: [] });
  assert.equal(parseConfig({ ...f.config, browser: { enabled: true, sites: [policy] } }).browser.allSites, false);
  assert.deepEqual(parseConfig({ ...f.config, browser: { enabled: true, allSites: true, sites: [] } }).browser, { enabled: true, allSites: true, sites: [] });
  for (const allSites of ["true", 1, null, {}]) assert.throws(() => parseConfig({ ...f.config, browser: { enabled: true, allSites, sites: [] } }));
  assert.throws(() => parseConfig({ ...f.config, browser: { enabled: true, sites: [] } }));
});

test("all-site opt-in accepts a previously unknown public domain without a manual grant and retains operation boundaries", async t => {
  const f = fixture(t, { browser: { enabled: true, allSites: true, sites: [] } }), bridge = new ControlledBridge();
  const executor = new MacBrowserExecutor(f.config, f.journal, { bridgeFactory: () => bridge });
  f.cleanup.push(() => executor.shutdown());
  const site = requestedBrowserSite("https://shop.example.com/cart"), grant = assignment("unknown-public", site);
  grant.sites[0]!.startUrl = "https://shop.example.com/cart";
  const read = request(grant, { kind: "observe", siteId: site.siteId });
  await executor.handlePoll(poll(grant, [read]));
  assert.equal((await terminal(executor, read.operationId)).status, "done");
  assert.deepEqual(bridge.opened, [site.siteId]); assert.deepEqual(executor.advertisedSites(), []);
  const crossDomain = request(grant, { kind: "navigate", siteId: site.siteId, url: "https://example.org/" }, "cross-domain");
  const privateHost = request(grant, { kind: "navigate", siteId: site.siteId, url: "https://127.0.0.1/" }, "private");
  await executor.handlePoll(poll(grant, [crossDomain]));
  assert.equal((await terminal(executor, crossDomain.operationId)).status, "failed");
  await executor.handlePoll(poll(grant, [privateHost]));
  assert.equal((await terminal(executor, privateHost.operationId)).status, "failed");
  assert.equal(bridge.effects.length, 1);
});

test("all-site eligibility never overrides disabled execution, canonical digests or public host scope", async t => {
  for (const boundary of ["disabled", "restricted", "digest", "private", "private-policy", "cross-domain"]) {
    const f = fixture(t, { browser: { enabled: boundary !== "disabled", allSites: boundary !== "restricted", sites: boundary === "restricted" ? [policy] : [] } }), bridge = new ControlledBridge();
    const executor = new MacBrowserExecutor(f.config, f.journal, { bridgeFactory: () => bridge });
    f.cleanup.push(() => executor.shutdown());
    const site = boundary === "private-policy" ? { ...policy, origins: ["https://127.0.0.1"], resourceHosts: [] } : requestedBrowserSite("https://example.com/");
    const grant = assignment(boundary, site);
    if (boundary === "digest") grant.sites[0]!.site.policyDigest = "0".repeat(64);
    if (boundary === "private" || boundary === "cross-domain") grant.sites[0]!.startUrl = boundary === "private" ? "https://127.0.0.1/" : "https://example.org/";
    if (boundary === "private" || boundary === "cross-domain") await assert.rejects(executor.handlePoll(poll(grant)));
    else {
      await executor.handlePoll(poll(grant));
      assert((await reports(executor)).some(report => report.kind === "stopped" && report.stopped && !report.uncertain));
    }
    assert.deepEqual(bridge.opened, []); assert.deepEqual(bridge.effects, []);
  }
});

test("cancel interrupts in-flight RPC without replay or falsely resolving action uncertainty", async t => {
  const f = executorFixture(t), grant = assignment(), input = request(grant, { kind: "click", siteId: "fixture", snapshotId: "snapshot", ref: "e1" });
  f.bridge.effectGate = Promise.withResolvers();
  await f.executor.handlePoll(poll(grant, [input]));
  await until(() => f.bridge.effects.length === 1);
  await f.executor.handlePoll(poll(grant, [input], true));
  const output = await reports(f.executor);
  assert.equal(f.journal.result(input.operationId)?.status, "uncertain");
  assert.equal(output.some(report => report.kind === "stopped" && report.uncertain), true);
  assert.deepEqual(f.bridge.closed, [["owned-fixture"]]);
  assert.equal(f.executor.available, false); assert.equal(f.executor.recoveryPaused, true);
  await f.executor.handlePoll(poll(grant, [input]));
  assert.equal(f.bridge.effects.length, 1);
  assert.equal(f.journal.result(input.operationId)?.status, "uncertain");
});

test("lost effect response closes only known targets but retains immutable uncertain stop", async t => {
  const f = executorFixture(t), grant = assignment(), input = request(grant);
  f.bridge.failInvoke = true;
  await f.executor.handlePoll(poll(grant, [input]));
  assert.equal((await terminal(f.executor, input.operationId)).status, "uncertain");
  await until(() => f.bridge.closed.length === 1);
  assert.deepEqual(f.bridge.closed[0], ["owned-fixture"]);
  await reports(f.executor);
  assert.equal(f.executor.recoveryPaused, true);
  f.journal.confirmStopped(); await reports(f.executor);
  assert.equal(f.executor.available, true);
  assert.equal(f.journal.result(input.operationId)?.status, "uncertain");
});

test("lost openTab ownership is never guessed, and failed close cannot acknowledge safe stop", async t => {
  const f = executorFixture(t), grant = assignment();
  f.bridge.openingGate = Promise.withResolvers();
  await f.executor.handlePoll(poll(grant));
  await until(() => f.bridge.opened.length === 1);
  await f.executor.shutdown();
  assert.deepEqual(f.bridge.closed, []);
  assert.equal(f.journal.snapshot().outstanding[0]?.unknownTabs, 1);
  assert.equal((await reports(f.executor)).some(report => report.kind === "stopped" && !report.stopped && report.uncertain), true);
  assert.equal(f.executor.recoveryPaused, true);
});

test("a disconnected close proof cannot turn an owned live tab into a safe stop", async t => {
  const f = executorFixture(t), grant = assignment();
  f.bridge.stopResult = { stopped: false, uncertain: true };
  await f.executor.handlePoll(poll(grant));
  await until(() => f.journal.tabs(grant.runId)[0]?.phase === "ready");
  await f.executor.shutdown();
  assert.equal(f.journal.tabs(grant.runId)[0]?.phase, "ready");
  assert.equal((await reports(f.executor)).some(report => report.kind === "stopped" && !report.stopped && report.uncertain), true);
});

test("hard deadline closes owned tabs without an additional coordinator poll", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
  const f = executorFixture(t), grant = assignment();
  await f.executor.handlePoll(poll(grant));
  await until(() => f.journal.tabs(grant.runId)[0]?.phase === "ready");
  t.mock.timers.tick(60_001);
  await until(() => f.bridge.closed.length === 1);
  await until(() => f.journal.snapshot().outstanding[0]?.phase === "stopped");
  assert.deepEqual(f.bridge.closed[0], ["owned-fixture"]);
  const output = await reports(f.executor);
  assert.equal(output.some(report => report.kind === "stopped" && !report.uncertain), true);
  t.mock.timers.reset();
});

test("recovery closes exact durable targets, never resumes effects or clears uncertainty", async t => {
  const f = fixture(t), grant = assignment();
  f.journal.accept(grant); f.journal.openingTab(grant, "fixture"); f.journal.ownedTab(grant.runId, "fixture", "old-owned-target"); f.journal.close();
  const recovered = new BrowserJournal(join(f.root, "state"), f.config), bridge = new ControlledBridge();
  const executor = new MacBrowserExecutor(f.config, recovered, { bridgeFactory: () => bridge });
  f.cleanup.push(() => recovered.close());
  await reports(executor);
  assert.deepEqual(bridge.closed, [["old-owned-target"]]); assert.deepEqual(bridge.effects, []);
  assert.equal(executor.recoveryPaused, true);
  assert.equal(readBrowserJournalStatus(join(f.root, "state"))?.recoveryPaused, true);
});

// Executed generated operations against a controlled page/MCP fixture, not a
// source-text assertion or a live logged-in browser. Only test temp files exist.
const mcpFixture = String.raw`
const vm=require('node:vm'); const readline=require('node:readline'); const fs=require('node:fs');
const statePath=process.argv[2]; const saved=statePath && fs.existsSync(statePath)?JSON.parse(fs.readFileSync(statePath,'utf8')):{pages:[],fields:{}}; let counter=0; const pages=new Map();
const closeCalls=saved.closeCalls||{}, closePolls=saved.closePolls||{};
const fields={ e1:{tag:'INPUT',type:'text',name:'message',value:''}, e2:{tag:'INPUT',type:'password',name:'password'}, e3:{tag:'A',href:'https://outside.example/'}, e4:{tag:'BUTTON',name:'action'}, e5:{tag:'INPUT',autocomplete:'one-time-code'}, e6:{tag:'A',href:'https://fixture.example/next',target:'_blank'}, e7:{tag:'INPUT',type:'text',name:'note',focusChanges:{type:'password'}}, e8:{tag:'INPUT',type:'text',name:'note',focusChanges:{name:'api_key'}}, e9:{tag:'INPUT',type:'text',name:'note',focusChanges:{autocomplete:'one-time-code'}}, e10:{tag:'INPUT',type:'text',name:'note',focusChanges:{origin:'https://outside.example'}}, e11:{tag:'INPUT',type:'text',name:'note',focusChanges:{connected:false}}, e12:{tag:'DIV',editable:true}, e13:{tag:'TEXTAREA',name:'message'}, f1e1:{tag:'INPUT',type:'text',name:'frame-message'} };
Object.assign(fields,saved.fields);
function save(){if(statePath){const temporary=statePath+'.next';fs.writeFileSync(temporary,JSON.stringify({pages:Array.from(pages.values(),p=>({targetId:p.targetId,url:p.location})),fields,closeCalls,closePolls}),{mode:0o600});fs.renameSync(temporary,statePath);}}
class FixtureElement {
  constructor(field){this.field=field;this.ownerDocument={location:{get origin(){return field.origin||'https://fixture.example';}},defaultView:view};this.labels=[];this.form=null;}
  get tagName(){return this.field.tag;} get id(){return this.field.id||'';} get isConnected(){return this.field.connected!==false;} get isContentEditable(){return this.field.editable===true;}
  get disabled(){return this.field.disabled===true;} get readOnly(){return this.field.readonly===true;}
  getAttribute(name){return this.field[name]||null;}
  closest(){return this.field.href?{href:this.field.href,target:this.field.target||'',hasAttribute:()=>false}:null;}
  focus(){this.field.focused=(this.field.focused||0)+1;if(this.field.focusChanges)Object.assign(this.field,this.field.focusChanges);this.onFocus?.();save();}
  dispatchEvent(event){(this.field.events??=[]).push(event.type);save();return true;}
  get textContent(){return this.field.textContent||'';} set textContent(value){this.field.textContent=value;save();}
}
class FixtureInput extends FixtureElement {get value(){this.field.valueReads=(this.field.valueReads||0)+1;return this.field.value||'';}set value(text){this.field.value=text;save();}}
class FixtureTextarea extends FixtureElement {get value(){this.field.valueReads=(this.field.valueReads||0)+1;return this.field.value||'';}set value(text){this.field.value=text;save();}}
const view={HTMLElement:FixtureElement,HTMLInputElement:FixtureInput,HTMLTextAreaElement:FixtureTextarea,Event:class{constructor(type){this.type=type;}}};
function element(field){return new (field.tag==='INPUT'?FixtureInput:field.tag==='TEXTAREA'?FixtureTextarea:FixtureElement)(field);}
function newPage(url,targetId,owned=false) {
  const listeners=new Map();
  const p={
    targetId:targetId||'owned-'+(++counter),location:url,closed:false,owned,
    on(event,handler){listeners.set(event,handler);},
    popup(){newPage('https://fixture.example/child?private=popup','popup-target');listeners.get('popup')?.({url:'https://fixture.example/child?private=popup',windowName:'fixture-popup'});},
    url(){if(this.closed)throw Error('closed');return this.location;},
    async title(){return 'Fixture';},
    async goto(url){this.location=url.includes('redirect-private')?'https://127.0.0.1/':url;if(url.includes('popup-navigation'))this.popup();save();if(url.includes('inflight'))await Promise.withResolvers().promise;},
    locator(ref){const field=fields[ref];if(!field)throw Error('ref');const node=element(field);if(p.location.includes('popup-focus'))node.onFocus=()=>p.popup();return {
      async evaluate(fn,args){return fn(node,args);},
      async click(){field.clicks=(field.clicks||0)+1;if(p.location.includes('popup-action'))p.popup();save();},
      async press(key){field.key=key;save();}
    };},
    async screenshot(){return this.location.includes('big-image')?Buffer.alloc(1048577):Buffer.from([137,80,78,71,13,10,26,10,0]);}
  };
  pages.set(p.targetId,p);save();return p;
}
if(saved.pages.length){for(const page of saved.pages)newPage(page.url,page.targetId);}else{newPage('https://private-user.example/','user-target');}
const context=vm.createContext({Buffer,URL,sleep:async()=>{},console:{log(value){context.logs.push(String(value));}},logs:[],
  openTab:async url=>newPage(url,undefined,true),
  listBrowserTabs:async()=>{
    for(const p of pages.values())if(p.closingReads){closePolls[p.targetId]=(closePolls[p.targetId]||0)+1;if(--p.closingReads===0)pages.delete(p.targetId);}
    save();return Array.from(pages.values(),p=>({targetId:p.targetId,url:p.location}));
  },
  attachBrowserTab:async id=>{const p=pages.get(id);if(p)p.owned=false;return p;},getTabByTargetId:async id=>pages.get(id),
  closeTab:async p=>{
    closeCalls[p.targetId]=(closeCalls[p.targetId]||0)+1;
    if(!p.owned){save();return;} // Borrowed attachments detach; they do not close.
    if(p.location.includes('popup-close'))p.popup();
    p.closed=true;if(p.location.includes('delayed-close'))p.closingReads=3;else pages.delete(p.targetId);save();
  },
  snapshot:async p=>({tree:p.location.includes('large')?'é'.repeat(32769):'https://fixture.example/fixture?private=query#fragment\ntextbox Message [ref=e1]\ntextbox Password [ref=e2]\nlink Outside [ref=e3]\nbutton Action [ref=e4]\ntextbox OTP [ref=e5]\nlink New tab [ref=e6]\ntextbox Focus type [ref=e7]\ntextbox Focus key [ref=e8]\ntextbox Focus autocomplete [ref=e9]\ntextbox Focus origin [ref=e10]\ntextbox Focus detached [ref=e11]\ntextbox Editable [ref=e12]\ntextbox Multiline [ref=e13]\ntextbox Frame [ref=f1e1]\npage text claiming e77 is not an observation reference',diff:''})
});
process.stderr.write('private stderr must not be returned\n');
readline.createInterface({input:process.stdin}).on('line',async line=>{const call=JSON.parse(line); if(!call.id)return; let result;if(call.method==='initialize')result={protocolVersion:'2025-03-26'};else if(call.method==='tools/list')result={tools:[{name:'repl'}]};else if(call.method==='tools/call'){if(call.params.name!=='repl')throw Error('wrong tool');context.logs=[];try{await vm.runInContext('(async()=>{'+call.params.arguments.code+'})()',context);result={content:[{type:'text',text:'Aside fixture banner\n'+context.logs.join('\n')}]};}catch{result={isError:true,content:[{type:'text',text:'private page error'}]};}}else result={};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:call.id,result})+'\n');});
`;
function generatedFixture(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "umpi-browser-mcp-test-")));
  const path = join(root, "fixture.cjs"); writeFileSync(path, mcpFixture, { mode: 0o600 });
  const state = join(root, "state.json");
  const bridge = new AsideBrowserBridge(false, { command: process.execPath, args: [path, state], timeoutMs: 5000 });
  t.after(async () => { await bridge.disconnect(); rmSync(root, { recursive: true, force: true }); });
  return { bridge, path, state };
}
async function ownedFixture(bridge: AsideBrowserBridge): Promise<BrowserTab> {
  const targetId = await bridge.openTab("fixture", `about:blank#umpi-browser-${"a".repeat(64)}`);
  const tab = { siteId: "fixture", targetId }; await bridge.configureTab(tab, assignment()); return tab;
}

test("typed generated bridge uses current snapshots, rejects credential fields and unknown destinations", async t => {
  const { bridge, state } = generatedFixture(t), tab = await ownedFixture(bridge);
  const observation = (await bridge.invoke(tab, { kind: "observe", siteId: "fixture" })).observation!;
  assert.equal(observation.url, "https://fixture.example/fixture");
  assert.doesNotMatch(observation.tree, /private=query|fragment/);
  for (const ref of ["e2", "e5"]) await assert.rejects(bridge.invoke(tab, { kind: "fill", siteId: "fixture", snapshotId: observation.snapshotId, ref, text: "must-not-fill" }), BrowserActionRejected);
  await assert.rejects(bridge.invoke(tab, { kind: "press", siteId: "fixture", snapshotId: observation.snapshotId, ref: "e2", key: "Enter" }), BrowserActionRejected);
  for (const ref of ["e3", "e6"]) await assert.rejects(bridge.invoke(tab, { kind: "click", siteId: "fixture", snapshotId: observation.snapshotId, ref }), BrowserActionRejected);
  await assert.rejects(bridge.invoke(tab, { kind: "click", siteId: "fixture", snapshotId: observation.snapshotId, ref: "e77" }), BrowserActionRejected);
  const text = `'); throw new Error('model source'); //`;
  const filled = (await bridge.invoke(tab, { kind: "fill", siteId: "fixture", snapshotId: observation.snapshotId, ref: "e1", text })).observation!;
  assert.notEqual(filled.snapshotId, observation.snapshotId);
  const saved = JSON.parse(readFileSync(state, "utf8")) as { fields: { e1: { value: string }; e2: { value?: string }; e5: { value?: string } } };
  assert.equal(saved.fields.e1.value, text); assert.equal(saved.fields.e2.value, undefined); assert.equal(saved.fields.e5.value, undefined);
  await assert.rejects(bridge.invoke(tab, { kind: "click", siteId: "fixture", snapshotId: observation.snapshotId, ref: "e4" }), BrowserActionRejected);
  const clicked = (await bridge.invoke(tab, { kind: "click", siteId: "fixture", snapshotId: filled.snapshotId, ref: "e4" })).observation!;
  assert.equal(clicked.siteId, "fixture");
  await bridge.invoke(tab, { kind: "press", siteId: "fixture", snapshotId: clicked.snapshotId, ref: "e1", key: "Tab" });
  const afterPress = JSON.parse(readFileSync(state, "utf8")) as { fields: { e1: { key: string } } };
  assert.equal(afterPress.fields.e1.key, "Tab");
  await assert.rejects(bridge.invoke({ ...tab, targetId: "user-target" }, { kind: "observe", siteId: "fixture" }), BrowserActionRejected);
  await assert.rejects(bridge.invoke(tab, { kind: "observe", siteId: "other" }), BrowserActionRejected);
});

test("generated fill rechecks focus-time credential metadata and origin before assigning or returning values", async t => {
  const { bridge, state } = generatedFixture(t), tab = await ownedFixture(bridge);
  for (const ref of ["e7", "e8", "e9", "e10", "e11"]) {
    const observation = (await bridge.invoke(tab, { kind: "observe", siteId: "fixture" })).observation!;
    await assert.rejects(bridge.invoke(tab, { kind: "fill", siteId: "fixture", snapshotId: observation.snapshotId, ref, text: "never-assign-this-value" }), error => error instanceof BrowserActionRejected && !error.message.includes("never-assign"));
    await assert.rejects(bridge.invoke(tab, { kind: "click", siteId: "fixture", snapshotId: observation.snapshotId, ref: "e4" }), BrowserActionRejected);
  }
  const saved = JSON.parse(readFileSync(state, "utf8")) as { fields: Record<string, { focused?: number; value?: string; valueReads?: number; events?: string[] }> };
  for (const ref of ["e7", "e8", "e9", "e10", "e11"]) {
    assert.equal(saved.fields[ref]?.focused, 1);
    assert.equal(saved.fields[ref]?.value, undefined);
    assert.equal(saved.fields[ref]?.valueReads, undefined);
    assert.equal(saved.fields[ref]?.events, undefined);
  }
});

test("generated domain checks allow HTTPS subdomains and preserve credential, focus, destination and redirected-page protections", async t => {
  const { bridge, state } = generatedFixture(t);
  writeFileSync(state, JSON.stringify({ pages: [], fields: {
    e1: { tag: "INPUT", type: "text", name: "message", origin: "https://shop.example.com" },
    e2: { tag: "INPUT", type: "password", name: "password", origin: "https://shop.example.com" },
    e3: { tag: "A", href: "https://example.org/", origin: "https://shop.example.com" },
    e7: { tag: "INPUT", type: "text", name: "note", origin: "https://shop.example.com", focusChanges: { type: "password" } },
    e10: { tag: "INPUT", type: "text", name: "note", origin: "https://shop.example.com", focusChanges: { origin: "https://example.org" } },
  } }), { mode: 0o600 });
  const site = requestedBrowserSite("https://shop.example.com/"), grant = assignment("generated-domain", site);
  grant.sites[0]!.startUrl = "https://shop.example.com/";
  const targetId = await bridge.openTab(site.siteId, `about:blank#umpi-browser-${"a".repeat(64)}`), tab = { siteId: site.siteId, targetId };
  await bridge.configureTab(tab, grant);
  const initial = (await bridge.invoke(tab, { kind: "observe", siteId: site.siteId })).observation!;
  await assert.rejects(bridge.invoke(tab, { kind: "fill", siteId: site.siteId, snapshotId: initial.snapshotId, ref: "e2", text: "never" }), BrowserActionRejected);
  await assert.rejects(bridge.invoke(tab, { kind: "click", siteId: site.siteId, snapshotId: initial.snapshotId, ref: "e3" }), BrowserActionRejected);
  const filled = (await bridge.invoke(tab, { kind: "fill", siteId: site.siteId, snapshotId: initial.snapshotId, ref: "e1", text: "safe message" })).observation!;
  assert.equal(filled.url, "https://shop.example.com/");
  for (const ref of ["e7", "e10"]) {
    const observed = (await bridge.invoke(tab, { kind: "observe", siteId: site.siteId })).observation!;
    await assert.rejects(bridge.invoke(tab, { kind: "fill", siteId: site.siteId, snapshotId: observed.snapshotId, ref, text: "never-assign" }), BrowserActionRejected);
  }
  const saved = JSON.parse(readFileSync(state, "utf8")) as { fields: Record<string, { value?: string; focused?: number; valueReads?: number; events?: string[] }> };
  assert.equal(saved.fields.e1?.value, "safe message");
  for (const ref of ["e7", "e10"]) {
    assert.equal(saved.fields[ref]?.focused, 1); assert.equal(saved.fields[ref]?.value, undefined);
    assert.equal(saved.fields[ref]?.valueReads, undefined); assert.equal(saved.fields[ref]?.events, undefined);
  }
  assert.equal((await bridge.invoke(tab, { kind: "navigate", siteId: site.siteId, url: "https://other.example.com/next" })).observation?.url, "https://other.example.com/next");
  for (const url of ["http://example.com/", "https://example.com:444/", "https://example.com.evil.org/", "https://user@example.com/", "https://127.0.0.1/"]) await assert.rejects(bridge.invoke(tab, { kind: "navigate", siteId: site.siteId, url }), BrowserActionRejected);
  await assert.rejects(bridge.invoke(tab, { kind: "navigate", siteId: site.siteId, url: "https://example.com/redirect-private" }), AsideConnectionLost);
  await assert.rejects(bridge.invoke(tab, { kind: "observe", siteId: site.siteId }), BrowserActionRejected);
});

test("a focus-time popup is persisted even when credential mutation rejects the fill", async t => {
  const { bridge, state } = generatedFixture(t), tab = await ownedFixture(bridge);
  let unknown = 0; bridge.setPopupUncertaintyHandler(() => { unknown++; });
  const observation = (await bridge.invoke(tab, { kind: "navigate", siteId: "fixture", url: "https://fixture.example/popup-focus" })).observation!;
  await assert.rejects(bridge.invoke(tab, { kind: "fill", siteId: "fixture", snapshotId: observation.snapshotId, ref: "e7", text: "never-assign-this-value" }), BrowserActionRejected);
  assert.equal(unknown, 1);
  const beforeStop = JSON.parse(readFileSync(state, "utf8")) as { fields: Record<string, { value?: string; valueReads?: number }> };
  assert.equal(beforeStop.fields.e7?.value, undefined);
  assert.equal(beforeStop.fields.e7?.valueReads, undefined);
  assert.deepEqual(await bridge.stopTabs([tab.targetId]), { stopped: true, uncertain: true });
  const saved = JSON.parse(readFileSync(state, "utf8")) as { pages: { targetId: string }[] };
  assert.deepEqual(saved.pages.map(page => page.targetId).sort(), ["popup-target", "user-target"]);
});

test("atomic generated fill preserves textarea, editable and iframe observation references", async t => {
  const { bridge, state } = generatedFixture(t), tab = await ownedFixture(bridge);
  for (const ref of ["e12", "e13", "f1e1"]) {
    const observation = (await bridge.invoke(tab, { kind: "observe", siteId: "fixture" })).observation!;
    assert.equal((await bridge.invoke(tab, { kind: "fill", siteId: "fixture", snapshotId: observation.snapshotId, ref, text: `assigned-${ref}` })).observation?.siteId, "fixture");
  }
  const saved = JSON.parse(readFileSync(state, "utf8")) as { fields: Record<string, { textContent?: string; value?: string; valueReads?: number; events?: string[] }> };
  assert.equal(saved.fields.e12?.textContent, "assigned-e12");
  assert.equal(saved.fields.e13?.value, "assigned-e13");
  assert.equal(saved.fields.f1e1?.value, "assigned-f1e1");
  for (const ref of ["e12", "e13", "f1e1"]) {
    assert.equal(saved.fields[ref]?.valueReads, undefined);
    assert.deepEqual(saved.fields[ref]?.events, ["input", "change"]);
  }
});

test("generated bridge returns bounded PNGs, rejects oversized trees and does not leak private errors", async t => {
  const { bridge, path } = generatedFixture(t), tab = await ownedFixture(bridge);
  const image = (await bridge.invoke(tab, { kind: "screenshot", siteId: "fixture" })).image!;
  assert.equal(image.mimeType, "image/png"); assert.equal(Buffer.from(image.data, "base64").length, 9);
  await assert.rejects(bridge.invoke(tab, { kind: "navigate", siteId: "fixture", url: "https://fixture.example/large" }), AsideConnectionLost);
  const transport = new AsideMcpTransport({ command: process.execPath, args: [path], timeoutMs: 5000 });
  try { await assert.rejects(transport.generated("throw new Error('private page error');"), error => error instanceof AsideConnectionLost && !error.message.includes("private page")); }
  finally { await transport.disconnect(); }
});

test("generated close verifies exact owned target absence and never closes a user tab", async t => {
  const { bridge, state } = generatedFixture(t), tab = await ownedFixture(bridge);
  await bridge.disconnect();
  assert.deepEqual(await bridge.stopTabs([tab.targetId]), { stopped: true, uncertain: false });
  const saved = JSON.parse(readFileSync(state, "utf8")) as { pages: { targetId: string }[] };
  assert.deepEqual(saved.pages.map(page => page.targetId), ["user-target"]);
  assert.deepEqual(await bridge.stopTabs(["unsafe target with spaces"]), { stopped: false, uncertain: true });
});

test("native popup events cannot be mapped by URL and remain uncertain while original tabs close", async t => {
  const f = fixture(t), generated = generatedFixture(t), grant = assignment();
  const executor = new MacBrowserExecutor(f.config, f.journal, { bridgeFactory: () => generated.bridge });
  f.cleanup.push(() => executor.shutdown());
  const navigate = request(grant, { kind: "navigate", siteId: "fixture", url: "https://fixture.example/popup-action" }, "popup-navigation");
  await executor.handlePoll(poll(grant, [navigate]));
  const observed = await terminal(executor, navigate.operationId);
  assert(observed.observation);
  const click = request(grant, { kind: "click", siteId: "fixture", snapshotId: observed.observation.snapshotId, ref: "e4" }, "popup-click");
  await executor.handlePoll(poll(grant, [click]));
  assert.equal((await terminal(executor, click.operationId)).status, "done");
  assert.equal(f.journal.hasPopupUncertainty(grant.runId), true);
  await executor.shutdown();
  assert.equal(f.journal.tabs(grant.runId)[0]?.phase, "closed");
  assert.equal(f.journal.snapshot().outstanding[0]?.unknownTabs, 1);
  assert.equal(f.journal.recoveryPaused, true);
  const stopped = (await reports(executor)).find(report => report.kind === "stopped");
  assert.equal(stopped?.kind === "stopped" && stopped.uncertain, true);
  assert.equal(stopped?.kind === "stopped" && stopped.stopped, true);
  const saved = JSON.parse(readFileSync(generated.state, "utf8")) as { pages: { targetId: string }[]; closeCalls: Record<string, number> };
  assert.deepEqual(saved.pages.map(page => page.targetId).sort(), ["popup-target", "user-target"]);
  assert.equal(saved.closeCalls["popup-target"], undefined);
  assert.equal(saved.closeCalls["user-target"], undefined);
  f.journal.close();
  const recovered = new BrowserJournal(f.journal.directory, f.config);
  f.cleanup.push(() => recovered.close());
  assert.equal(recovered.hasPopupUncertainty(grant.runId), true);
  assert.equal(recovered.recoveryPaused, true);
  recovered.confirmStopped();
  assert.equal(recovered.hasPopupUncertainty(grant.runId), true); // Evidence is immutable.
});

test("popup watcher precedes navigation and covers popups emitted during original closure", async t => {
  for (const location of ["popup-navigation", "popup-close"]) {
    const { bridge, state } = generatedFixture(t);
    let unknown = 0; bridge.setPopupUncertaintyHandler(() => { unknown++; });
    const targetId = await bridge.openTab("fixture", `about:blank#umpi-browser-${"a".repeat(64)}`);
    const tab = { siteId: "fixture", targetId }, grant = assignment();
    grant.sites[0]!.startUrl = `https://fixture.example/${location}`;
    await bridge.configureTab(tab, grant);
    assert.deepEqual(await bridge.stopTabs([targetId]), { stopped: true, uncertain: true });
    assert.equal(unknown, 1);
    const saved = JSON.parse(readFileSync(state, "utf8")) as { pages: { targetId: string }[] };
    assert.deepEqual(saved.pages.map(page => page.targetId).sort(), ["popup-target", "user-target"]);
  }
});

test("owned close is dispatched once and target absence is awaited without borrowed close guesses", async t => {
  const { bridge, state } = generatedFixture(t), tab = await ownedFixture(bridge);
  await bridge.invoke(tab, { kind: "navigate", siteId: "fixture", url: "https://fixture.example/delayed-close" });
  assert.deepEqual(await bridge.stopTabs([tab.targetId]), { stopped: true, uncertain: false });
  const saved = JSON.parse(readFileSync(state, "utf8")) as { pages: { targetId: string }[]; closeCalls: Record<string, number>; closePolls: Record<string, number> };
  assert.deepEqual(saved.pages.map(page => page.targetId), ["user-target"]);
  assert.equal(saved.closeCalls[tab.targetId], 1);
  assert.equal(saved.closePolls[tab.targetId], 3);
});

test("restart inspection cannot claim that an extant borrowed target was closed", async t => {
  const { state, path } = generatedFixture(t);
  writeFileSync(state, JSON.stringify({ pages: [{ targetId: "user-target", url: "https://private-user.example/" }, { targetId: "old-owned-target", url: "https://fixture.example/fixture" }], fields: {} }), { mode: 0o600 });
  const bridge = new AsideBrowserBridge(false, { command: process.execPath, args: [path, state], timeoutMs: 5000 });
  try {
    assert.deepEqual(await bridge.stopTabs(["old-owned-target"]), { stopped: false, uncertain: true });
    const saved = JSON.parse(readFileSync(state, "utf8")) as { pages: { targetId: string }[]; closeCalls: Record<string, number> };
    assert.deepEqual(saved.pages.map(page => page.targetId).sort(), ["old-owned-target", "user-target"]);
    assert.deepEqual(saved.closeCalls, {});
  } finally { await bridge.disconnect(); }
});

test("durable unknown-popup evidence cannot be downgraded to a certain stop", t => {
  const f = fixture(t), grant = assignment();
  f.journal.accept(grant);
  f.journal.notePopupUncertainty(grant);
  assert.equal(f.journal.snapshot().outstanding[0]?.uncertain, true);
  assert.equal(f.journal.snapshot().outstanding[0]?.unknownTabs, 1);
  f.journal.stopped(grant, true, false);
  const stopped = f.journal.pendingReports().map(item => JSON.parse(item.payload) as BrowserExecutorReport).find(report => report.kind === "stopped");
  assert.equal(stopped?.kind === "stopped" && stopped.uncertain, true);
  assert.equal(f.journal.recoveryPaused, true);
});

test("interrupting native navigation retains popup-monitoring uncertainty and original target ownership", async t => {
  const { bridge, state } = generatedFixture(t), tab = await ownedFixture(bridge);
  let unknown = 0; bridge.setPopupUncertaintyHandler(() => { unknown++; });
  const pending = bridge.invoke(tab, { kind: "navigate", siteId: "fixture", url: "https://fixture.example/inflight" });
  const rejected = assert.rejects(pending, AsideConnectionLost);
  await until(() => {
    const saved: unknown = JSON.parse(readFileSync(state, "utf8"));
    return typeof saved === "object" && saved !== null && "pages" in saved && Array.isArray(saved.pages) &&
      saved.pages.some((page: unknown) => typeof page === "object" && page !== null && "url" in page && typeof page.url === "string" && page.url.endsWith("/inflight"));
  });
  await bridge.disconnect(); await rejected;
  assert.equal(unknown, 1);
  assert.deepEqual(await bridge.stopTabs([tab.targetId]), { stopped: false, uncertain: true });
  const saved = JSON.parse(readFileSync(state, "utf8")) as { pages: { targetId: string }[]; closeCalls: Record<string, number> };
  assert.deepEqual(saved.pages.map(page => page.targetId).sort(), [tab.targetId, "user-target"].sort());
  assert.deepEqual(saved.closeCalls, {});
});

test("cancellation durably refuses requests not yet seen, including late stopped-run requests", async t => {
  const f = executorFixture(t), grant = assignment(), input = request(grant);
  await f.executor.handlePoll(poll(grant, [input], true));
  assert.equal(f.bridge.opened.length, 0);
  assert.equal(f.journal.result(input.operationId)?.status, "failed");
  const late = request(grant, { kind: "click", siteId: "fixture", snapshotId: "unused", ref: "e1" }, "late");
  await f.executor.handlePoll(poll(grant, [late], true));
  assert.equal(f.journal.result(late.operationId)?.status, "failed");
  assert.equal(f.bridge.effects.length, 0);
  assert.equal((await reports(f.executor)).some(report => report.kind === "stopped" && !report.uncertain), true);
});

test("screenshots larger than the PNG byte limit are refused without returning image bytes", async t => {
  const { bridge } = generatedFixture(t), tab = await ownedFixture(bridge);
  await bridge.invoke(tab, { kind: "navigate", siteId: "fixture", url: "https://fixture.example/big-image" });
  await assert.rejects(bridge.invoke(tab, { kind: "screenshot", siteId: "fixture" }), BrowserActionRejected);
});
