import type { R2Bucket } from "@cloudflare/workers-types";
import { Container } from "@cloudflare/containers";
import { randomUUID } from "node:crypto";
import { MAX_WORKSPACE_BYTES, parseVaultApply, parseVaultScope, type VaultPlanningApply, type VaultPlanningResult, type VaultPlanningScope, type VaultPlanningSnapshot } from "../shared/vault-planning.js";
import { shiftPlanningDay } from "../shared/daily-planning.js";
import { record } from "../shared/protocol.js";
import { readJson } from "./transport.js";
import { StateError } from "./store.js";
import { uploadVaultArchive } from "./vault-archive.js";

export interface VaultSyncEnvironment { VAULT_ARCHIVE?: R2Bucket }
interface Checkpoint { key: string; revision: number; scope: VaultPlanningScope; updatedAt: string }
export interface VaultConfiguration { configured: boolean; revision: number; scope?: VaultPlanningScope }


/** Dedicated credential-bearing adapter: never shared with model-controlled shell/code containers. */
export class VaultSync extends Container<VaultSyncEnvironment> {
  defaultPort = 8080;
  pingEndpoint = "localhost/ready";
  sleepAfter = "5m";
  envVars = { UMPI_VAULT_STATE: "/state", UMPI_HEADLESS_CLI: "/opt/headless/node_modules/obsidian-headless/cli.js" };
  private queue: Promise<unknown> = Promise.resolve();

  override onError(): never { throw new StateError(503, "The private vault container could not start"); }
  override async fetch(): Promise<Response> { return new Response("Not found", { status: 404 }); }
  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const guarded = async () => {
      await this.cleanupArchives();
      try { return await operation(); }
      finally {
        try { await this.cleanupArchives(); }
        catch { console.warn("Private archive cleanup could not finish; its durable ledger is retained"); }
      }
    };
    const result = this.queue.then(guarded, guarded);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }
  private bucket(): R2Bucket {
    if (!this.env.VAULT_ARCHIVE) throw new StateError(503, "The private vault archive binding is not configured");
    return this.env.VAULT_ARCHIVE;
  }
  private checkpoint(): Promise<Checkpoint | undefined> { return this.ctx.storage.get<Checkpoint>("checkpoint"); }
  private async retainArchiveCandidates(...keys: string[]): Promise<void> {
    const pending = await this.ctx.storage.get<string[]>("archive-cleanup") ?? [];
    const retained = [...new Set([...pending, ...keys])];
    if (retained.length > 64) throw new StateError(503, "Private archive cleanup requires attention before another upload");
    await this.ctx.storage.put("archive-cleanup", retained);
  }
  private async cleanupArchives(): Promise<void> {
    // Held inside the RPC queue: a candidate cannot become authoritative while
    // cleanup checks its pointer. The ledger precedes R2 PUT and survives crashes.
    const pending = await this.ctx.storage.get<string[]>("archive-cleanup") ?? [];
    if (!pending.length) return;
    const current = await this.checkpoint(), retained: string[] = [];
    for (const key of pending) {
      if (key === current?.key) continue;
      try { await this.bucket().delete(key); }
      catch { retained.push(key); }
    }
    await this.ctx.storage.put("archive-cleanup", retained);
    if (retained.length) console.warn("Uncommitted private archive cleanup remains pending");
  }
  async configuration(): Promise<VaultConfiguration> {
    return this.serialize(async () => {
      const checkpoint = await this.checkpoint();
      return checkpoint ? { configured: true, revision: checkpoint.revision, scope: checkpoint.scope } : { configured: false, revision: 0 };
    });
  }
  private async request(path: string, init?: RequestInit): Promise<Response> {
    const response = await this.containerFetch(`http://localhost${path}`, { ...init, signal: AbortSignal.timeout(180_000) });
    if (!response.ok) {
      await response.body?.cancel();
      throw new StateError(response.status === 409 ? 409 : 503, "The private vault operation was not confirmed; inspect configuration or the retained write before retrying");
    }
    return response;
  }
  private async restore(checkpoint: Checkpoint): Promise<void> {
    const archive = await this.bucket().get(checkpoint.key);
    if (!archive || archive.size > MAX_WORKSPACE_BYTES) throw new StateError(503, "The committed private workspace archive is unavailable");
    // R2 and DOM declarations differ at reader EOF; this is the same native Worker byte stream.
    const response = await this.request("/restore", { method: "POST", headers: { "content-type": "application/gzip" }, body: archive.body as unknown as ReadableStream<Uint8Array> });
    await response.body?.cancel();
  }
  private async restoreWorkspace(checkpoint: Checkpoint): Promise<void> {
    // A prior actor may have died between restoring a candidate and committing its
    // pointer. Never trust an already initialized container as the authorized root.
    await this.destroy();
    await this.restore(checkpoint);
  }
  private async stopWorkspace(): Promise<void> {
    try { await this.destroy(); }
    catch { console.warn("Private vault shutdown was not confirmed; idle shutdown remains configured"); }
  }
  private async persist(checkpoint: Checkpoint): Promise<void> {
    const response = await this.request("/archive");
    if (!response.body) throw new StateError(503, "The vault runtime did not return a recoverable checkpoint");
    const key = `workspace/${randomUUID()}.gz`;
    await this.retainArchiveCandidates(key, checkpoint.key);
    await uploadVaultArchive(this.bucket(), key, response.body, Number(response.headers.get("content-length")));
    // The old checkpoint remains authoritative until the replacement pointer is durable.
    await this.ctx.storage.put("checkpoint", { ...checkpoint, key, updatedAt: new Date().toISOString() } satisfies Checkpoint);
  }
  async provision(body: ReadableStream<Uint8Array>, scopeValue: VaultPlanningScope, expectedRevision: number, length: number): Promise<VaultConfiguration> {
    const scope = parseVaultScope(scopeValue);
    return this.serialize(async () => {
      const previous = await this.checkpoint();
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== (previous?.revision ?? 0)) throw new StateError(409, "Vault provisioning changed; inspect its current revision");
      const key = `workspace/${randomUUID()}.gz`;
      await this.retainArchiveCandidates(key, ...(previous ? [previous.key] : []));
      await uploadVaultArchive(this.bucket(), key, body, length);
      const candidate: Checkpoint = { key, scope, revision: (previous?.revision ?? 0) + 1, updatedAt: new Date().toISOString() };
      try {
        await this.destroy();
        await this.restore(candidate);
        await this.ctx.storage.put("checkpoint", candidate);
        return { configured: true, revision: candidate.revision, scope };
      } finally { await this.stopWorkspace(); }
    });
  }
  async getSnapshot(day: string, expectedRevision: number): Promise<VaultPlanningSnapshot> {
    shiftPlanningDay(day, 0);
    return this.serialize(async () => {
      const checkpoint = await this.checkpoint();
      if (!checkpoint) throw new StateError(503, "Obsidian Headless Sync has not been provisioned");
      if (checkpoint.revision !== expectedRevision) throw new StateError(409, "Private vault authorization changed; collect current planning inputs");
      try {
        await this.restoreWorkspace(checkpoint);
        const response = await this.request("/snapshot", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ day, scope: checkpoint.scope }) });
        const snapshot = await readJson(response, 1_100_000) as VaultPlanningSnapshot;
        await this.persist(checkpoint);
        return snapshot;
      } finally { await this.stopWorkspace(); }
    });
  }
  async applyNote(value: VaultPlanningApply, expectedRevision: number): Promise<VaultPlanningResult> {
    const intent = parseVaultApply(value);
    return this.serialize(async () => {
      const checkpoint = await this.checkpoint();
      if (!checkpoint) throw new StateError(503, "Obsidian Headless Sync has not been provisioned");
      if (checkpoint.revision !== expectedRevision) throw new StateError(409, "Private vault authorization changed; the old note write was not dispatched");
      try {
        await this.restoreWorkspace(checkpoint);
        const response = await this.request("/apply", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ intent, scope: checkpoint.scope }) });
        const result = await readJson(response, 8_192) as VaultPlanningResult;
        if (result.status === "synced") await this.persist(checkpoint);
        // On ambiguity/conflict, discard only the scratch workspace, never the SQL intent or last committed archive.
        return result;
      } finally { await this.stopWorkspace(); }
    });
  }
}
