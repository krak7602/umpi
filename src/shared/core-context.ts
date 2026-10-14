import { InputError, identifier, record } from "./protocol.js";

export const MAX_CORE_BLOCKS = 16;
export const MAX_CORE_TEXT_LENGTH = 12_000;
export const MAX_CORE_BLOCK_TEXT_LENGTH = 6_000;
export type CoreBlockKind = "background" | "preferences" | "workstreams";
export type CoreBlock = {
  id: string;
  kind: CoreBlockKind;
  text: string;
  source: { path: string; heading: string; revision: string };
  pendingSource: boolean;
};
export type CoreContext = { revision: number; blocks: CoreBlock[] };
export type ReplaceCoreContextInput = { expectedRevision: number; blocks: CoreBlock[] };

export function normalizeSourceText(text: string): string {
  return text.replace(/\r\n/g, "\n").trim();
}

export async function sourceRevision(text: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(normalizeSourceText(text)));
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, "0")).join("");
}

export function coreRevision(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new InputError("Invalid core context revision");
  }
  return value;
}

export function coreText(value: unknown): string {
  if (typeof value !== "string" || value.length > MAX_CORE_BLOCK_TEXT_LENGTH || /[\0\r]/.test(value.replace(/\r\n/g, "\n"))) {
    throw new InputError("Invalid core context text; each block is limited to 6000 characters");
  }
  return normalizeSourceText(value);
}

export function parseCoreBlock(value: unknown): CoreBlock {
  const input = record(value);
  if (input.kind !== "background" && input.kind !== "preferences" && input.kind !== "workstreams") {
    throw new InputError("Invalid core context kind");
  }
  if (typeof input.pendingSource !== "boolean") throw new InputError("Invalid core context source status");
  const source = record(input.source);
  if (typeof source.path !== "string" || source.path.length > 1_024 || !source.path.endsWith(".md") ||
      /[\\:#\x00-\x1f\x7f]/.test(source.path) || source.path.split("/").some(part => !part || part.startsWith(".") || part.trim() !== part)) {
    throw new InputError("Invalid core context source path; use a vault-relative Markdown path without dot directories");
  }
  if (typeof source.heading !== "string" || !source.heading || source.heading.length > 256 ||
      source.heading.trim() !== source.heading || /[\x00-\x1f\x7f]/.test(source.heading)) {
    throw new InputError("Invalid core context source heading; use exact single-line heading text");
  }
  if (typeof source.revision !== "string" || !/^[a-f0-9]{64}$/.test(source.revision)) {
    throw new InputError("Invalid core context source revision; use a lowercase SHA-256 hash");
  }
  return {
    id: identifier(input.id, "core context block ID"),
    kind: input.kind,
    text: coreText(input.text),
    source: { path: source.path, heading: source.heading, revision: source.revision },
    pendingSource: input.pendingSource,
  };
}

export function parseCoreBlocks(value: unknown): CoreBlock[] {
  if (!Array.isArray(value) || value.length > MAX_CORE_BLOCKS) {
    throw new InputError("Core context is limited to 16 selected blocks");
  }
  const blocks = value.map(parseCoreBlock);
  const ids = new Set<string>();
  const sources = new Set<string>();
  let length = 0;
  for (const block of blocks) {
    const source = JSON.stringify([block.source.path, block.source.heading]);
    if (ids.has(block.id) || sources.has(source)) throw new InputError("Core context block IDs and source sections must be unique");
    ids.add(block.id);
    sources.add(source);
    length += block.text.length;
  }
  if (length > MAX_CORE_TEXT_LENGTH) throw new InputError("Core context is limited to 12000 text characters");
  return blocks;
}

export function parseCoreContext(value: unknown): CoreContext {
  const input = record(value);
  return { revision: coreRevision(input.revision), blocks: parseCoreBlocks(input.blocks) };
}

export function parseReplaceCoreContext(value: unknown): ReplaceCoreContextInput {
  const input = record(value);
  return { expectedRevision: coreRevision(input.expectedRevision), blocks: parseCoreBlocks(input.blocks) };
}
