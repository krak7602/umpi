import type { R2Bucket } from "@cloudflare/workers-types";
import { Container } from "@cloudflare/containers";
import type { CloudMachineStart } from "./cloud-machines.js";

export interface CloudMachineEnvironment { CODING_ARCHIVE?: R2Bucket }

/**
 * One cloud machine: a container running T3 Code with the Pi agent. Umpi wakes it (restoring saved state from R2),
 * relays MCP to it, and saves it back to R2 before it sleeps. A machine never starts without its state, so plain
 * fetches to a stopped machine are refused instead of starting it empty.
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

  /** Starts the machine and T3 Code, restoring saved state first; returns Umpi's MCP token for this run. */
  async wake(start: CloudMachineStart, snapshotKey: string): Promise<{ token: string; restored: boolean }> {
    let restored = false;
    if (!this.ctx.container?.running) {
      await this.startAndWaitForPorts({ ports: 8080, cancellationOptions: { portReadyTimeoutMS: 180_000 } });
      const saved = await this.bucket().get(snapshotKey);
      if (saved) {
        const response = await this.containerFetch(new Request("http://machine/restore", { method: "POST", body: saved.body as unknown as ReadableStream, duplex: "half" } as RequestInit), 8080);
        if (!response.ok) throw new Error(`Saved state could not be restored: ${(await response.text()).slice(0, 200)}`);
        restored = true;
      }
    }
    await this.ctx.storage.put("snapshotKey", snapshotKey);
    const response = await this.containerFetch(new Request("http://machine/start", { method: "POST", body: JSON.stringify(start), headers: { "content-type": "application/json" } }), 8080);
    const body = await response.json() as { token?: string; error?: string };
    if (!response.ok || !body.token) throw new Error(body.error ?? `The machine did not start (${response.status})`);
    return { token: body.token, restored };
  }

  /** Packs the machine's state into R2 and stops it. Returns the saved size, or 0 when it was not running. */
  async save(): Promise<{ size: number }> {
    if (!this.ctx.container?.running) return { size: 0 };
    const key = await this.ctx.storage.get<string>("snapshotKey");
    if (!key) throw new Error("This machine has no place to save to");
    const response = await this.containerFetch(new Request("http://machine/snapshot", { method: "POST" }), 8080);
    const size = Number(response.headers.get("content-length"));
    if (!response.ok || !response.body || !Number.isSafeInteger(size) || size <= 0) throw new Error(`The machine's state could not be packed (${response.status})`);
    await this.upload(key, response.body as unknown as ReadableStream<Uint8Array>, size);
    // The state is safe in R2: stop the container outright, so a sleeping machine never keeps running.
    await this.destroy();
    return { size };
  }

  /**
   * Streams the packed state into R2 in parts, so any size fits in bounded memory: parts of 16 MB (R2 needs at
   * least 5 MB for all but the last), one object when it is small.
   */
  private async upload(key: string, body: ReadableStream<Uint8Array>, size: number): Promise<void> {
    const PART = 16 * 1024 * 1024;
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let buffered = 0, total = 0;
    const take = (): Uint8Array => {
      const out = new Uint8Array(buffered); let offset = 0;
      for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.byteLength; }
      chunks.length = 0; buffered = 0; return out;
    };
    let upload: Awaited<ReturnType<R2Bucket["createMultipartUpload"]>> | undefined;
    const parts: { partNumber: number; etag: string }[] = [];
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (value) { chunks.push(value); buffered += value.byteLength; total += value.byteLength; }
        if (buffered >= PART || (done && upload && buffered > 0)) {
          upload ??= await this.bucket().createMultipartUpload(key);
          parts.push(await upload.uploadPart(parts.length + 1, take()));
        }
        if (done) break;
      }
      if (total !== size) throw new Error(`The machine's state was cut short (${total} of ${size} bytes)`);
      if (upload) await upload.complete(parts);
      else await this.bucket().put(key, take());
    } catch (error) {
      await upload?.abort().catch(() => undefined);
      throw error;
    }
  }

  /** Stops the machine without saving, before it is deleted. */
  async discard(): Promise<void> {
    if (this.ctx.container?.running) await this.destroy();
    await this.ctx.storage.deleteAll();
  }

  isRunning(): boolean { return this.ctx.container?.running === true; }

  /** MCP relay to T3 Code. A stopped machine answers 503; Umpi wakes it first. */
  override async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (!path.startsWith("/t3/")) return new Response("Not found", { status: 404 });
    if (!this.ctx.container?.running) return Response.json({ error: "machine_asleep" }, { status: 503 });
    this.renewActivityTimeout();
    return this.containerFetch(request, 8080);
  }

  override async onActivityExpired(): Promise<void> {
    try { await this.save(); } catch { await this.destroy(); }
  }
}
