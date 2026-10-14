import { DurableObject } from "cloudflare:workers";
import { launch, sessions } from "@cloudflare/playwright";
import type { Browser, BrowserWorker as BrowserBinding } from "@cloudflare/playwright";
import type { BrowserAssignment, BrowserAuthentication, BrowserReceipt, BrowserRequest, BrowserStopped } from "../shared/browser.js";
import { BrowserCloudRun } from "./browser-cloud-run.js";
import type { BrowserCloudClient, BrowserSessionFactory } from "./browser-cloud-run.js";
export { BrowserCloudRun } from "./browser-cloud-run.js";
export type { BrowserCloudClient, BrowserCloudOptions, BrowserCloudStorage, BrowserSessionFactory } from "./browser-cloud-run.js";

export interface BrowserWorkerEnvironment { BROWSER: BrowserBinding }
/** A trusted binding, never an endpoint supplied by a page, model, or RPC caller. */
export function cloudflareBrowserSessions(binding: BrowserBinding): BrowserSessionFactory {
  return {
    async launch(allowedDomains) {
      const browser = await launch(binding, { keep_alive: 60_000, recording: false, ...(allowedDomains === undefined ? {} : { guardrails: { allowedDomains } }) });
      const sessionId = browser.sessionId();
      if (!sessionId) throw new Error("Browser provider did not return a session identity");
      return { browser, sessionId };
    },
    async exists(sessionId) { return (await sessions(binding)).some(session => session.sessionId === sessionId); },
    async close(sessionId, ownedBrowser?: Browser) {
      if (ownedBrowser && ownedBrowser.sessionId() !== sessionId) throw new Error("Browser close identity mismatch");
      if (!(await sessions(binding)).some(session => session.sessionId === sessionId)) return;
      // The SDK's public binding type only exposes fetch. Use the documented,
      // session-targeted destruction endpoint, not a CDP connection/target close.
      const response = await binding.fetch(`http://fake.host/v1/devtools/browser/${encodeURIComponent(sessionId)}`, { method: "DELETE" });
      if (!response.ok) throw new Error("Owned browser destruction request failed");
      const result: unknown = await response.json();
      if (!result || typeof result !== "object" || !("status" in result) || (result.status !== "closing" && result.status !== "closed")) throw new Error("Invalid browser destruction response");
      // "closing" is asynchronous, and even "closed" is not an absence check.
      // BrowserCloudRun observes the exact session absent within its stop budget.
    },
  };
}
/** RPC-only actor: does not read account/model/vault/crypto bindings; no public proxy. The shared Worker environment is not capability isolation. */
export class BrowserWorker extends DurableObject<BrowserWorkerEnvironment> implements BrowserCloudClient {
  private readonly run: BrowserCloudRun;
  constructor(ctx: DurableObjectState, env: BrowserWorkerEnvironment) {
    super(ctx, env);
    if (!env.BROWSER) throw new Error("Browser Run binding is not configured");
    this.run = new BrowserCloudRun({
      storage: {
        get: <T>(key: string) => ctx.storage.get<T>(key),
        put: <T>(key: string, value: T) => ctx.storage.put(key, value),
        list: <T>(prefix: string) => ctx.storage.list<T>({ prefix }),
      },
      sessions: cloudflareBrowserSessions(env.BROWSER),
      scheduleDeadline: deadline => ctx.storage.setAlarm(deadline),
    });
    // A reconstructed actor can only inspect receipts and close its persisted session.
    // It never reconnects to execute operations or reimports authentication.
    ctx.blockConcurrencyWhile(() => this.run.enforceDeadline());
  }
  startRun(assignment: BrowserAssignment, authentication: { siteId: string; state: BrowserAuthentication }[]): Promise<void> { return this.run.startRun(assignment, authentication); }
  invoke(request: BrowserRequest): Promise<BrowserReceipt> { return this.run.invoke(request); }
  inspect(operationId: string): Promise<BrowserReceipt> { return this.run.inspect(operationId); }
  activity(): Promise<void> { return this.run.activity(); }
  stopRun(): Promise<BrowserStopped> { return this.run.stopRun(); }
  async alarm(): Promise<void> { await this.run.enforceDeadline(); }
  override async fetch(): Promise<Response> { return new Response("Not found", { status: 404 }); }
}
