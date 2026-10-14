import { MAX_CODING_ARCHIVE_BYTES, MAX_CODING_FILES } from "./coding.js";

// Leaves room for gzip/JSON/base64 representations inside a 128 MiB Worker heap.
export const MAX_CODING_DECODED_BYTES = 12 * 1024 * 1024;
export const MAX_CODING_CONTENT_BYTES = 8 * 1024 * 1024;
export interface CodingSnapshotFile {
  path: string;
  mode: 0o100644 | 0o100755;
  bytes: number;
  digest: string;
}
export interface CodingSnapshotExclusion { path: string; reason: "private" | "generated" }
export interface CodingSnapshotManifest {
  version: 1;
  capturedAt: string;
  baseRevision: string | null;
  /** SHA-256 of the exact compressed archive, not a reconstructed document. */
  digest: string;
  fileCount: number;
  files: CodingSnapshotFile[];
  exclusions: CodingSnapshotExclusion[];
}
export interface CodingSnapshotDocument {
  version: 1;
  capturedAt: string;
  baseRevision: string | null;
  files: (CodingSnapshotFile & { content: string })[];
  exclusions: CodingSnapshotExclusion[];
}

/** Portable path subset: avoids traversal, Git metadata and filesystem aliases. */
export function codingSourcePath(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 1024 || /[\\\x00-\x1f\x7f:]/.test(value) || value.normalize("NFC") !== value || value.split("/").some(part => !part || part === "." || part === ".." || /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part))) throw new Error("Unsafe coding source path");
  return value;
}

/** Deliberately independent of .gitignore: tracked private files are not exportable. */
export function codingSourceExclusion(path: string): CodingSnapshotExclusion["reason"] | null {
  const parts = path.toLowerCase().split("/");
  if (parts.some(part => /^(?:\.git|\.ssh|\.aws|\.azure|\.config|\.gnupg|\.kube|\.npmrc|\.pypirc|\.netrc|\.git-credentials|\.docker|\.wrangler|\.dev\.vars(?:\..*)?|\.env(?:\..*)?|id_rsa|id_dsa|id_ecdsa|id_ed25519)$/.test(part)
    || /(?:^|[._-])(?:credentials?|secrets?|tokens?|keychain|signing|private[-_]?key|accounts?(?:[-_]?snapshot)?|auth|service[-_]?account)(?:[._-][^.]+)*\.(?:jsonc?|ya?ml|toml|ini|conf|env|db|sqlite3?|bak|gz|zip)$/.test(part)
    || /^(?:credentials?|secrets?|tokens?|keychain|private[-_]?key)$/.test(part)
    || /\.local(?:\.|$)/.test(part) || /\.(?:pem|key|p8|pkcs8|ppk|p12|pfx|keystore|mobileprovision)$/.test(part))) return "private";
  if (parts.some(part => /^(?:node_modules|vendor|\.venv|venv|__pycache__|\.cache|\.next|\.nuxt|\.turbo|\.parcel-cache|coverage|dist|build|target|\.ds_store)$/.test(part))) return "generated";
  return null;
}

export async function codingSourceDigest(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid coding source document");
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, expected: string[]): void {
  if (Object.keys(value).length !== expected.length || expected.some(key => !Object.hasOwn(value, key))) throw new Error("Invalid coding source fields");
}

/** Validates the entire archive before callers create or mutate any filesystem path. */
export async function inspectCodingSnapshot(bytes: Uint8Array): Promise<{ document: CodingSnapshotDocument; manifest: CodingSnapshotManifest }> {
  if (!bytes.byteLength || bytes.byteLength > MAX_CODING_ARCHIVE_BYTES) throw new Error("Coding source compressed size exceeds limit");
  const stream = new Blob([bytes as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream("gzip"));
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > MAX_CODING_DECODED_BYTES) throw new Error("Coding source decoded size exceeds limit");
      chunks.push(next.value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  const decoded = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { decoded.set(chunk, offset); offset += chunk.length; }
  chunks.length = 0;
  const input = object(JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(decoded)));
  keys(input, ["version", "capturedAt", "baseRevision", "files", "exclusions"]);
  if (input.version !== 1 || typeof input.capturedAt !== "string" || !Number.isFinite(Date.parse(input.capturedAt)) || new Date(input.capturedAt).toISOString() !== input.capturedAt || !(input.baseRevision === null || typeof input.baseRevision === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(input.baseRevision)) || !Array.isArray(input.files) || input.files.length > MAX_CODING_FILES || !Array.isArray(input.exclusions) || input.files.length + input.exclusions.length > MAX_CODING_FILES) throw new Error("Invalid coding source manifest");
  const names = new Set<string>();
  let contentBytes = 0;
  const files: CodingSnapshotDocument["files"] = [];
  for (const entry of input.files) {
    const file = object(entry);
    keys(file, ["path", "mode", "bytes", "digest", "content"]);
    const path = codingSourcePath(file.path);
    const folded = path.toLowerCase();
    if (codingSourceExclusion(path) || names.has(folded) || file.mode !== 0o100644 && file.mode !== 0o100755 || typeof file.bytes !== "number" || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || typeof file.digest !== "string" || !/^[a-f0-9]{64}$/.test(file.digest) || typeof file.content !== "string" || file.content.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(file.content)) throw new Error("Unsafe coding source entry");
    names.add(folded);
    contentBytes += file.bytes;
    if (contentBytes > MAX_CODING_CONTENT_BYTES || file.content.length !== 4 * Math.ceil(file.bytes / 3)) throw new Error("Coding source content size exceeds limit");
    const binary = atob(file.content);
    if (binary.length !== file.bytes || btoa(binary) !== file.content) throw new Error("Invalid coding source encoding");
    const content = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) content[index] = binary.charCodeAt(index);
    if (await codingSourceDigest(content) !== file.digest) throw new Error("Coding source content digest mismatch");
    files.push({ path, mode: file.mode, bytes: file.bytes, digest: file.digest, content: file.content });
  }
  for (const name of names) {
    const parts = name.split("/");
    parts.pop();
    while (parts.length) { if (names.has(parts.join("/"))) throw new Error("Coding source file/directory conflict"); parts.pop(); }
  }
  const exclusions: CodingSnapshotExclusion[] = input.exclusions.map(entry => {
    const exclusion = object(entry);
    keys(exclusion, ["path", "reason"]);
    const path = codingSourcePath(exclusion.path);
    if (exclusion.reason !== "private" && exclusion.reason !== "generated" || codingSourceExclusion(path) !== exclusion.reason) throw new Error("Invalid coding source exclusion");
    if (names.has(path.toLowerCase())) throw new Error("Duplicate coding source exclusion");
    names.add(path.toLowerCase());
    return { path, reason: exclusion.reason };
  });
  const document: CodingSnapshotDocument = { version: 1, capturedAt: input.capturedAt, baseRevision: input.baseRevision as string | null, files, exclusions };
  const manifest: CodingSnapshotManifest = { version: 1, capturedAt: document.capturedAt, baseRevision: document.baseRevision, digest: await codingSourceDigest(bytes), fileCount: files.length, files: files.map(({ content: _, ...file }) => file), exclusions };
  return { document, manifest };
}
