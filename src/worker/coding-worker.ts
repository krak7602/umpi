import type { R2Bucket } from "@cloudflare/workers-types";
import { Container } from "@cloudflare/containers";
import type { CodingAssignment } from "../shared/coding.js";
import type { CodingRpcRequest, CodingRpcState } from "../shared/coding-rpc.js";
import { CodingCloudError, CodingCloudRun, type CodingCheckpoint, type CodingStopResult } from "./coding-cloud.js";

export interface CodingWorkerEnvironment { CODING_ARCHIVE?: R2Bucket }

/** Source-only coding scratch. Never shares a class, image, bucket, or credentials with vault sync. */
export class CodingWorker extends Container<CodingWorkerEnvironment> {
  defaultPort = 8080;
  pingEndpoint = "localhost/ready";
  sleepAfter = "90s";
  // Approved source can fetch public dependencies. There are no model/account credentials here.
  enableInternet = true;
  envVars = {};
  private run: CodingCloudRun | undefined;

  private runtime(): CodingCloudRun {
    if (this.run) return this.run;
    if (!this.env.CODING_ARCHIVE) throw new CodingCloudError("Coding archive binding is not configured", 503);
    this.run = new CodingCloudRun({
      storage: {
        get: <T>(key: string) => this.ctx.storage.get<T>(key),
        put: <T>(key: string, value: T) => this.ctx.storage.put(key, value),
        list: <T>(prefix: string) => this.ctx.storage.list<T>({ prefix }),
      },
      bucket: this.env.CODING_ARCHIVE,
      startContainer: () => this.startAndWaitForPorts({ ports: 8080, cancellationOptions: { portReadyTimeoutMS: 45_000 }, startOptions: { envVars: {}, enableInternet: true } }),
      request: async (path, init) => {
        if (!this.ctx.container?.running) throw new CodingCloudError("Coding process was lost; automatic restart is forbidden", 503);
        this.renewActivityTimeout();
        // Use the same HTTP transport as Container.containerFetch, but deliberately omit
        // its automatic-start branch. Neither exec beta nor arbitrary public proxying is used.
        return this.ctx.container.getTcpPort(8080).fetch(`http://localhost${path}`, init);
      },
      destroyContainer: async () => { if (this.ctx.container?.running) await this.destroy(); },
      scheduleDeadline: async deadline => { await this.schedule(deadline, "enforceCodingDeadline"); },
    });
    return this.run;
  }
  // Distinct names preserve the pinned Container.start/stop lifecycle signatures.
  startRun(assignment: CodingAssignment, sourceKey: string): Promise<void> { return this.runtime().startRun(assignment, sourceKey); }
  invoke(request: CodingRpcRequest): Promise<CodingRpcState> { return this.runtime().invoke(request); }
  inspect(operationId: string): Promise<CodingRpcState> { return this.runtime().inspect(operationId); }
  activity(): Promise<void> { return this.runtime().activity(); }
  cancel(operationId?: string): Promise<void> { return this.runtime().cancel(operationId); }
  checkpoint(): Promise<CodingCheckpoint> { return this.runtime().checkpoint(); }
  stopRun(): Promise<CodingStopResult> { return this.runtime().stopRun(); }
  async enforceCodingDeadline(): Promise<void> { await this.stopRun(); }
  override async onActivityExpired(): Promise<void> { await this.stopRun(); }
  override async onStop(): Promise<void> { await this.runtime().lost(); }
  override onError(): never { throw new CodingCloudError("Coding container runtime became unavailable", 503); }
  override async fetch(): Promise<Response> { return new Response("Not found", { status: 404 }); }
}
