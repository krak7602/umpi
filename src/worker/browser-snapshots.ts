import { randomUUID } from "node:crypto";
import type { R2Bucket } from "@cloudflare/workers-types";
import { BROWSER_SNAPSHOT_MAX_AGE_MS, MAX_BROWSER_SNAPSHOT_BYTES, browserCookieAllowed, browserEnvelopeAad } from "../shared/browser.js";
import type { BrowserAuthentication, BrowserCookie, BrowserSnapshotEnvelope, BrowserSnapshotMetadata, BrowserSnapshotPublicKey } from "../shared/browser.js";
import { identifier, record } from "../shared/protocol.js";
import type { BrowserStore } from "./browser-store.js";
import { StateError } from "./store.js";

const required = ["version", "snapshotId", "siteId", "policyDigest", "keyId", "capturedAt", "expiresAt", "wrappedKey", "nonce", "ciphertext"];
function binary(value: unknown, maximum: number): Uint8Array<ArrayBuffer> {
  if (typeof value !== "string" || !value.length || value.length > Math.ceil(maximum / 3) * 4 || value.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new StateError(400, "Invalid encrypted browser field");
  const decoded = atob(value), bytes = Uint8Array.from(decoded, char => char.charCodeAt(0));
  if (bytes.length > maximum || btoa(decoded) !== value) throw new StateError(400, "Invalid encrypted browser encoding");
  return bytes;
}
async function digest(bytes: Uint8Array<ArrayBuffer>): Promise<string> { return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), value => value.toString(16).padStart(2, "0")).join(""); }
function envelope(value: unknown): BrowserSnapshotEnvelope {
  const input = record(value);
  if (Object.keys(input).length !== required.length || required.some(key => !Object.hasOwn(input, key)) || input.version !== 1) throw new StateError(400, "Invalid encrypted browser envelope");
  const snapshotId = identifier(input.snapshotId, "browser snapshot"), siteId = identifier(input.siteId, "browser site"), keyId = identifier(input.keyId, "browser encryption key");
  if (typeof input.policyDigest !== "string" || !/^[a-f0-9]{64}$/.test(input.policyDigest)) throw new StateError(400, "Invalid encrypted browser policy");
  if (typeof input.capturedAt !== "string" || typeof input.expiresAt !== "string" || !/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(input.capturedAt) || !/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(input.expiresAt)) throw new StateError(400, "Invalid browser capture timestamps");
  const captured = Date.parse(input.capturedAt), expires = Date.parse(input.expiresAt);
  if (!Number.isFinite(captured) || !Number.isFinite(expires) || captured > Date.now() + 60_000 || expires <= Date.now() || expires <= captured || expires - captured > BROWSER_SNAPSHOT_MAX_AGE_MS) throw new StateError(400, "Browser capture is outside its retention bound");
  if (typeof input.wrappedKey !== "string" || typeof input.nonce !== "string" || typeof input.ciphertext !== "string") throw new StateError(400, "Invalid encrypted browser fields");
  const wrapped = binary(input.wrappedKey, 512), nonce = binary(input.nonce, 12), ciphertext = binary(input.ciphertext, MAX_BROWSER_SNAPSHOT_BYTES);
  if (wrapped.length !== 256 || nonce.length !== 12 || ciphertext.length < 16) throw new StateError(400, "Invalid encrypted browser payload dimensions");
  return { version: 1, snapshotId, siteId, policyDigest: input.policyDigest, keyId, capturedAt: input.capturedAt, expiresAt: input.expiresAt, wrappedKey: input.wrappedKey, nonce: input.nonce, ciphertext: input.ciphertext };
}

/** Authentication plaintext lives only during validation/import, never in R2 or model state. */
export class BrowserSnapshots {
  private openingKey?: Promise<BrowserSnapshotPublicKey>;
  private pruning?: Promise<void>;
  constructor(readonly store: BrowserStore, private readonly archive: () => R2Bucket | undefined) {}
  available(): boolean { return this.archive() !== undefined; }
  private bucket(): R2Bucket { const bucket = this.archive(); if (!bucket) throw new StateError(503, "Encrypted browser snapshot storage is not configured"); return bucket; }
  async publicKey(): Promise<BrowserSnapshotPublicKey> {
    const existing = this.store.snapshotKey(); if (existing) return { keyId: existing.keyId, publicKey: existing.publicKey };
    if (this.openingKey) return this.openingKey;
    const work = (async () => {
      const pair = await crypto.subtle.generateKey({ name: "RSA-OAEP", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["encrypt", "decrypt"]);
      const [privateKey, publicKey] = await Promise.all([crypto.subtle.exportKey("jwk", pair.privateKey), crypto.subtle.exportKey("jwk", pair.publicKey)]);
      this.store.saveSnapshotKey({ keyId: `browser-key:${randomUUID()}`, privateKey, publicKey });
      const saved = this.store.snapshotKey()!; return { keyId: saved.keyId, publicKey: saved.publicKey };
    })().finally(() => { this.openingKey = undefined; });
    this.openingKey = work; return work;
  }
  private async decrypt(value: BrowserSnapshotEnvelope): Promise<BrowserAuthentication> {
    const saved = this.store.snapshotKey(); if (!saved || saved.keyId !== value.keyId) throw new StateError(409, "Browser snapshot encryption key is unavailable");
    const site = this.store.site(value.siteId); if (!site || site.policyDigest !== value.policyDigest) throw new StateError(409, "Browser snapshot site policy changed");
    if (site.domain && this.store.requestedSnapshotSite(site.siteId)?.policyDigest !== site.policyDigest) throw new StateError(403, "This domain has no current owner-approved snapshot request");
    const key = await crypto.subtle.importKey("jwk", saved.privateKey, { name: "RSA-OAEP", hash: "SHA-256" }, false, ["decrypt"]);
    const rawKey = new Uint8Array(await crypto.subtle.decrypt({ name: "RSA-OAEP" }, key, binary(value.wrappedKey, 512)));
    let plaintext: Uint8Array<ArrayBuffer> | undefined;
    try {
      if (rawKey.length !== 32) throw new StateError(400, "Invalid wrapped browser key");
      const symmetric = await crypto.subtle.importKey("raw", rawKey, { name: "AES-GCM" }, false, ["decrypt"]);
      plaintext = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: binary(value.nonce, 12), additionalData: browserEnvelopeAad(value) as Uint8Array<ArrayBuffer>, tagLength: 128 }, symmetric, binary(value.ciphertext, MAX_BROWSER_SNAPSHOT_BYTES)));
      if (plaintext.length > MAX_BROWSER_SNAPSHOT_BYTES) throw new StateError(413, "Browser authentication exceeds its bound");
      const input = record(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plaintext)));
      if (Object.keys(input).length !== 2 || input.version !== 1 || !Array.isArray(input.cookies) || input.cookies.length > 256) throw new StateError(400, "Invalid site authentication format");
      const cookies: BrowserCookie[] = input.cookies.map(value => {
        const cookie = record(value), keys = ["name", "value", "domain", "path", "expires", "secure", "httpOnly"];
        if (keys.some(key => !Object.hasOwn(cookie, key)) || Object.keys(cookie).some(key => ![...keys, "sameSite"].includes(key))) throw new StateError(400, "Unsupported browser authentication attributes");
        if (typeof cookie.name !== "string" || typeof cookie.domain !== "string" || !browserCookieAllowed(cookie.name, cookie.domain, site) || typeof cookie.value !== "string" || new TextEncoder().encode(cookie.value).length > 8192) throw new StateError(400, "Browser authentication exceeded its requested cookie scope");
        if (typeof cookie.path !== "string" || !cookie.path.startsWith("/") || cookie.path.length > 2048 || typeof cookie.expires !== "number" || !Number.isFinite(cookie.expires) || cookie.expires !== -1 && cookie.expires <= 0 || typeof cookie.secure !== "boolean" || typeof cookie.httpOnly !== "boolean" || cookie.sameSite !== undefined && cookie.sameSite !== "Strict" && cookie.sameSite !== "Lax" && cookie.sameSite !== "None") throw new StateError(400, "Invalid browser cookie attributes");
        return { name: cookie.name, value: cookie.value, domain: cookie.domain, path: cookie.path, expires: cookie.expires, secure: cookie.secure, httpOnly: cookie.httpOnly, ...(cookie.sameSite !== undefined ? { sameSite: cookie.sameSite } : {}) };
      });
      if (new Set(cookies.map(cookie => JSON.stringify([cookie.name, cookie.domain, cookie.path]))).size !== cookies.length) throw new StateError(400, "Duplicate authentication cookie identities");
      return { version: 1, cookies };
    } catch (error) {
      if (error instanceof StateError) throw error;
      throw new StateError(400, "Encrypted browser authentication could not be verified");
    } finally { rawKey.fill(0); plaintext?.fill(0); }
  }
  async upload(snapshotId: string, bytes: Uint8Array<ArrayBuffer>): Promise<BrowserSnapshotMetadata> {
    if (!bytes.length || bytes.length > MAX_BROWSER_SNAPSHOT_BYTES) throw new StateError(413, "Encrypted browser snapshot exceeds its bound");
    let value: BrowserSnapshotEnvelope;
    try { value = envelope(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))); }
    catch (error) { if (error instanceof StateError) throw error; throw new StateError(400, "Invalid encrypted browser snapshot"); }
    if (value.snapshotId !== snapshotId) throw new StateError(409, "Browser snapshot upload identity changed");
    // Verify scope and authentication before admitting an immutable ciphertext upload.
    await this.decrypt(value);
    const metadata: BrowserSnapshotMetadata = { snapshotId, siteId: value.siteId, policyDigest: value.policyDigest, keyId: value.keyId, capturedAt: value.capturedAt, expiresAt: value.expiresAt, bytes: bytes.length, digest: await digest(bytes) };
    const previous = this.store.admitSnapshot(metadata); if (previous) return previous;
    const candidate = this.store.snapshotCandidate(snapshotId)!;
    let confirmed = false;
    try {
      const receipt = await this.bucket().put(candidate.key, bytes, { sha256: metadata.digest, httpMetadata: { contentType: "application/json" }, customMetadata: { digest: metadata.digest, siteId: metadata.siteId, policyDigest: metadata.policyDigest } });
      if (!receipt || receipt.key !== candidate.key || receipt.size !== bytes.length || receipt.customMetadata?.digest !== metadata.digest || !receipt.checksums?.sha256 || Array.from(new Uint8Array(receipt.checksums.sha256), byte => byte.toString(16).padStart(2, "0")).join("") !== metadata.digest) throw new StateError(503, "Encrypted browser snapshot receipt was not confirmed; provider or late-write outcome remains uncertain");
      confirmed = true;
      return this.store.saveSnapshot(metadata);
    } catch (error) {
      this.store.quarantineSnapshot(snapshotId, !confirmed);
      if (error instanceof StateError) throw error;
      throw new StateError(503, "Encrypted browser upload was not confirmed; its ciphertext is quarantined and provider or late-write outcome remains uncertain");
    }
  }
  async authentication(metadata: BrowserSnapshotMetadata): Promise<BrowserAuthentication> {
    const saved = this.store.snapshot(metadata.snapshotId);
    if (!saved || this.store.owner.effectResult(`browser-delete:${metadata.snapshotId}`) || JSON.stringify(saved) !== JSON.stringify(metadata) || Date.parse(saved.expiresAt) <= Date.now()) throw new StateError(409, "The approved browser snapshot is no longer available");
    const object = await this.bucket().get(this.store.snapshotObjectKey(saved.snapshotId));
    if (!object || object.size !== saved.bytes || object.size > MAX_BROWSER_SNAPSHOT_BYTES) throw new StateError(409, "Encrypted browser snapshot is unavailable");
    const bytes = new Uint8Array(await object.arrayBuffer());
    if (bytes.length !== saved.bytes || await digest(bytes) !== saved.digest) throw new StateError(409, "Encrypted browser snapshot checksum changed");
    const authentication = await this.decrypt(envelope(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))));
    if (!this.store.snapshot(saved.snapshotId) || this.store.owner.effectResult(`browser-delete:${saved.snapshotId}`) || Date.parse(saved.expiresAt) <= Date.now()) throw new StateError(409, "The approved browser snapshot changed while authentication was prepared");
    return authentication;
  }
  nextDue(now = Date.now()): number | undefined {
    if (!this.available()) return undefined;
    const candidates = this.store.snapshotCandidates(), snapshots = this.store.snapshots();
    if (!candidates.length && !snapshots.length) return undefined;
    let due = this.store.snapshotPruneDue() ?? now;
    for (const candidate of candidates) due = Math.min(due, candidate.nextAttemptAt);
    return Math.max(now, due);
  }
  drivePrune(now = Date.now()): Promise<void> {
    const due = this.nextDue(now);
    return due !== undefined && due <= now ? this.prune(now) : Promise.resolve();
  }
  /** Ciphertext housekeeping never acquires a browser, model, login or crypto key. */
  prune(now = Date.now()): Promise<void> {
    if (this.pruning) return this.pruning;
    const work = this.pruneBatch(now).finally(() => { this.pruning = undefined; });
    this.pruning = work; return work;
  }
  private async pruneBatch(now: number): Promise<void> {
    if (!this.available()) return;
    // Persist the retry clock before dispatch so restart/provider failure cannot spin.
    this.store.saveSnapshotPruneDue(now + 15 * 60_000);
    let remaining = 16, deferred = false;
    const counts = new Map<string, number>();
    for (const snapshot of this.store.snapshots()) {
      const count = (counts.get(snapshot.siteId) ?? 0) + 1; counts.set(snapshot.siteId, count);
      if (count <= 2 && Date.parse(snapshot.expiresAt) > now || this.store.snapshotPinned(snapshot.snapshotId)) continue;
      if (remaining <= 0) { deferred = true; continue; }
      // Pin checking and the immutable deletion fence share a SQL transaction.
      if (this.store.beginSnapshotDelete(snapshot.snapshotId, now)) remaining--;
    }
    remaining = 16;
    for (const pending of this.store.snapshotCandidates()) {
      if (pending.nextAttemptAt > now) continue;
      if (remaining <= 0) { this.store.deferSnapshotCleanup(pending.metadata.snapshotId, now + 2_000); deferred = true; continue; }
      const id = pending.metadata.snapshotId;
      if (pending.status === "uploading") this.store.quarantineSnapshot(id, true, now);
      const candidate = this.store.snapshotCandidate(id);
      if (!candidate || this.store.snapshotPinned(id)) continue;
      remaining--;
      let deleted = false;
      try { await this.bucket().delete(candidate.key); deleted = true; } catch { /* Durable ledger retains a failed or uncertain DELETE. */ }
      this.store.finishSnapshotDelete(id, deleted, now);
    }
    // Additional bounded batches need an alarm even when the Mac is offline.
    if (deferred) this.store.saveSnapshotPruneDue(now + 2_000);
  }
}
