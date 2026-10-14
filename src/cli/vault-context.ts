import { constants, type BigIntStats } from "node:fs";
import { lstat, open, realpath, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { coordinatorUrl } from "../shared/coordinator-url.ts";
import {
  normalizeSourceText, parseCoreBlock, parseCoreBlocks, parseCoreContext, sourceRevision,
  type CoreBlock, type CoreContext,
} from "../shared/core-context.ts";
import { scanMarkdown } from "../shared/markdown.ts";

export class VaultContextError extends Error {
  constructor(message: string, readonly kind: "input" | "conflict" | "network" | "storage" = "input") {
    super(message);
    this.name = "VaultContextError";
  }
}

export interface CoreContextConnection {
  coordinatorOrigin: string;
  controlToken: string | undefined;
  fetch?: typeof fetch;
  signal?: AbortSignal;
}

export interface VaultSyncOptions extends CoreContextConnection {
  vault: string;
  sources?: readonly string[];
  expectedRevision?: number;
}

export interface CoreContextMetadata {
  revision: number;
  blocks: number;
  characters: number;
  pending: number;
}

export interface VaultSyncResult extends CoreContextMetadata {
  added: number;
  uploaded: number;
  downloaded: number;
  removed: number;
}

export function coreContextMetadata(context: CoreContext): CoreContextMetadata {
  return {
    revision: context.revision,
    blocks: context.blocks.length,
    characters: context.blocks.reduce((sum, block) => sum + block.text.length, 0),
    pending: context.blocks.filter(block => block.pendingSource).length,
  };
}

async function requestContext(options: CoreContextConnection, replacement?: { expectedRevision: number; blocks: CoreBlock[] }): Promise<CoreContext> {
  let origin: URL;
  try { origin = coordinatorUrl(options.coordinatorOrigin); }
  catch { throw new VaultContextError("Use an HTTPS coordinator origin, or loopback HTTP, without credentials, path, query, or fragment"); }
  if (!options.controlToken || options.controlToken.length < 32 || /[\u0000-\u0020\u007f]/.test(options.controlToken)) {
    throw new VaultContextError("Set a strong UMPI_CONTROL_TOKEN of at least 32 characters in the environment; never pass it as an argument");
  }
  const signal = options.signal
    ? AbortSignal.any([options.signal, AbortSignal.timeout(30_000)])
    : AbortSignal.timeout(30_000);
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(new URL("/api/core-context", origin), {
      method: replacement ? "PUT" : "GET",
      redirect: "error",
      headers: {
        authorization: `Bearer ${options.controlToken}`,
        ...(replacement ? { "content-type": "application/json" } : {}),
      },
      ...(replacement ? { body: JSON.stringify(replacement) } : {}),
      signal,
    });
  } catch {
    throw new VaultContextError("Core context request failed or was cancelled; no redirects or response details were accepted", "network");
  }
  if (!response.ok) {
    try { await response.body?.cancel(); } catch { /* Never expose transport details. */ }
    if (response.status === 409) {
      throw new VaultContextError("Core context revision conflict; no newer remote version was overwritten. Local section writes may already be present; review and run sync again", "conflict");
    }
    throw new VaultContextError(`Coordinator rejected core context request (HTTP ${response.status}); response contents were not displayed`, "network");
  }
  let value: unknown;
  try { value = await response.json(); }
  catch { throw new VaultContextError("Coordinator returned an unreadable core context response; response contents were not displayed", "network"); }
  try { return parseCoreContext(value); }
  catch { throw new VaultContextError("Coordinator returned an invalid core context document; response contents were not displayed", "network"); }
}

export async function readCoreContext(options: CoreContextConnection): Promise<CoreContext> {
  return requestContext(options);
}

interface Section { headingStart: number; start: number; end: number; body: string; newline: string }

function markdownHeadings(markdown: string) {
  try { return scanMarkdown(markdown).headings; }
  catch (error) {
    throw new VaultContextError(error instanceof Error ? error.message : "Invalid Markdown section boundaries", "conflict");
  }
}

function findSection(markdown: string, label: string): Section | undefined {
  const headings = markdownHeadings(markdown);
  const matches = headings.filter(heading => heading.label === label);
  if (matches.length > 1) throw new VaultContextError("A selected heading is ambiguous; duplicate heading labels must be resolved before sync", "conflict");
  const heading = matches[0];
  if (!heading) return undefined;
  const next = headings.find(candidate => candidate.start > heading.start && candidate.level <= heading.level);
  const end = next?.start ?? markdown.length;
  return { headingStart: heading.start, start: heading.bodyStart, end, body: markdown.slice(heading.bodyStart, end), newline: heading.newline || "\n" };
}

function replaceSection(section: Section, text: string): string {
  const leading = /^\s*/.exec(section.body)![0];
  const trailing = /\s*$/.exec(section.body)![0];
  const body = normalizeSourceText(text).replace(/\n/g, section.newline);
  if (leading.length === section.body.length) {
    // An empty section still needs a line break before the next heading.
    return `${body ? section.newline : ""}${body}${leading || section.newline}`;
  }
  return `${leading}${body}${trailing || (body ? section.newline : "")}`;
}

interface VaultRoot { path: string; stat: BigIntStats }
interface FileSnapshot { path: string; sourcePath: string; bytes: Buffer; text: string; stat: BigIntStats }
interface SourceFile { snapshot: FileSnapshot | undefined; sections: { block: CoreBlock; section: Section }[]; replacements: { section: Section; text: string }[] }

function contained(root: string, path: string): boolean {
  const suffix = relative(root, path);
  return suffix !== "" && suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix);
}

function sameFile(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs && a.mode === b.mode;
}

async function openVault(value: string): Promise<VaultRoot> {
  try {
    const requested = resolve(value);
    if (requested.split(sep).some(part => part.toLowerCase() === ".obsidian")) throw new VaultContextError("The Obsidian configuration directory cannot be used as a vault root");
    if ((await lstat(requested)).isSymbolicLink()) throw new VaultContextError("The vault root must not be a symlink");
    const path = await realpath(requested);
    if (path.split(sep).some(part => part.toLowerCase() === ".obsidian")) throw new VaultContextError("The Obsidian configuration directory cannot be used as a vault root");
    const stat = await lstat(path, { bigint: true });
    if (!stat.isDirectory()) throw new VaultContextError("The vault must be an existing directory");
    return { path, stat };
  } catch (error) {
    if (error instanceof VaultContextError) throw error;
    throw new VaultContextError("Cannot open the selected vault; filesystem details were not displayed", "storage");
  }
}

async function safePath(root: VaultRoot, sourcePath: string): Promise<string | undefined> {
  const currentRoot = await lstat(root.path, { bigint: true });
  if (!currentRoot.isDirectory() || currentRoot.dev !== root.stat.dev || currentRoot.ino !== root.stat.ino || await realpath(root.path) !== root.path) {
    throw new VaultContextError("The vault root changed during sync; no further writes are allowed", "conflict");
  }
  const parts = sourcePath.split("/");
  if (isAbsolute(sourcePath) || sourcePath.includes("\\") || sourcePath.includes(":") || parts.some(part => !part || part.startsWith(".")) || !sourcePath.endsWith(".md")) {
    throw new VaultContextError("Sources must be vault-relative Markdown files without traversal, hidden directories, or symlinks");
  }
  let path = root.path;
  for (let index = 0; index < parts.length; index++) {
    path = join(path, parts[index]!);
    if (!contained(root.path, path)) throw new VaultContextError("Source path is outside the selected vault");
    let info: BigIntStats;
    try { info = await lstat(path, { bigint: true }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    if (info.isSymbolicLink() || !contained(root.path, await realpath(path))) throw new VaultContextError("Symlink and outside-vault sources are prohibited");
    if (index < parts.length - 1 && !info.isDirectory()) throw new VaultContextError("A source parent must be a directory");
    if (index === parts.length - 1 && (!info.isFile() || info.nlink !== 1n)) throw new VaultContextError("A source must be a regular, unlinked Markdown file");
  }
  return path;
}

async function readSource(root: VaultRoot, sourcePath: string): Promise<FileSnapshot | undefined> {
  try {
    const path = await safePath(root, sourcePath);
    if (path === undefined) return undefined;
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = await handle.stat({ bigint: true });
      if (!before.isFile() || before.nlink !== 1n) throw new VaultContextError("Source file changed during sync", "conflict");
      const bytes = await handle.readFile();
      const after = await handle.stat({ bigint: true });
      if (!sameFile(before, after) || await safePath(root, sourcePath) !== path || !sameFile(after, await lstat(path, { bigint: true }))) {
        throw new VaultContextError("Source file changed during sync", "conflict");
      }
      const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
      return { path, sourcePath, bytes, text, stat: after };
    } finally { await handle.close(); }
  } catch (error) {
    if (error instanceof VaultContextError) throw error;
    throw new VaultContextError("Cannot safely read a selected Markdown source; filesystem details were not displayed", "storage");
  }
}

async function assertUnchanged(root: VaultRoot, sourcePath: string, before: FileSnapshot | undefined): Promise<void> {
  const current = await readSource(root, sourcePath);
  if ((!before !== !current) || (before && current && (!sameFile(before.stat, current.stat) || !before.bytes.equals(current.bytes)))) {
    throw new VaultContextError("A selected source changed after planning; no further writes are allowed. Review and run sync again", "conflict");
  }
}

async function replaceFile(root: VaultRoot, before: FileSnapshot, text: string): Promise<FileSnapshot> {
  let temporary: string | undefined;
  try {
    await assertUnchanged(root, before.sourcePath, before);
    const directory = await realpath(dirname(before.path));
    if (directory !== root.path && !contained(root.path, directory)) throw new VaultContextError("Source parent moved outside the vault", "conflict");
    temporary = join(directory, `.umpi-memory-${randomUUID()}.tmp`);
    const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      if (!contained(root.path, await realpath(temporary))) throw new VaultContextError("Source parent moved outside the vault", "conflict");
      await handle.writeFile(text, "utf8");
      await handle.chmod(Number(before.stat.mode & 0o7777n));
      await handle.sync();
    } finally { await handle.close(); }
    // Compare bytes and file identity again immediately before atomic replacement.
    await assertUnchanged(root, before.sourcePath, before);
    if (await realpath(dirname(before.path)) !== directory) throw new VaultContextError("Source parent changed during sync", "conflict");
    await rename(temporary, before.path);
    temporary = undefined;
    const written = await readSource(root, before.sourcePath);
    if (!written || written.text !== text) throw new VaultContextError("Source changed after local replacement; remote acknowledgement was not sent", "conflict");
    return written;
  } catch (error) {
    if (error instanceof VaultContextError) throw error;
    throw new VaultContextError("Cannot safely replace a selected Markdown source; remote acknowledgement was not sent", "storage");
  } finally {
    if (temporary) {
      try { await unlink(temporary); } catch { /* Never print a private path or raw filesystem error. */ }
    }
  }
}

function selectorBlock(value: string): CoreBlock {
  const match = /^([^:]+):([^:]+):([^#]+)#(.+)$/.exec(value);
  if (!match) throw new VaultContextError("Use --source 'id:kind:relative/path.md#Exact heading'");
  try {
    return parseCoreBlock({
      id: match[1], kind: match[2], text: "", pendingSource: false,
      source: { path: match[3], heading: match[4], revision: "0".repeat(64) },
    });
  } catch { throw new VaultContextError("Invalid source selector; use an approved kind, unique identifier, safe Markdown path, and exact plain heading"); }
}

/** A fetched version owns the complete plan. No filesystem write precedes conflict and cap checks. */
export async function syncVaultContext(options: VaultSyncOptions): Promise<VaultSyncResult> {
  if (options.expectedRevision !== undefined && (!Number.isSafeInteger(options.expectedRevision) || options.expectedRevision < 0)) {
    throw new VaultContextError("Expected revision must be a nonnegative safe integer");
  }
  const current = await readCoreContext(options);
  if (options.expectedRevision !== undefined && options.expectedRevision !== current.revision) {
    throw new VaultContextError("Expected revision does not match the fetched core context; no sources were read or written", "conflict");
  }
  const selected = (options.sources ?? []).map(selectorBlock);
  if (current.revision === 0 && !current.blocks.length && !selected.length) throw new VaultContextError("Empty core context requires explicit --source selectors; no vault discovery is performed");
  if (current.revision === 0 && !current.blocks.length && options.expectedRevision !== 0) {
    throw new VaultContextError("Initial bootstrap requires explicit --source selectors and --expected-revision 0");
  }
  const tracked = [...current.blocks];
  const addedIds = new Set<string>();
  for (const block of selected) {
    const existing = tracked.find(candidate => candidate.id === block.id);
    if (existing) {
      if (existing.kind !== block.kind || existing.source.path !== block.source.path || existing.source.heading !== block.source.heading) {
        throw new VaultContextError("A selector cannot replace an existing source mapping; reconcile the core document explicitly", "conflict");
      }
      continue;
    }
    if (tracked.some(candidate => candidate.source.path === block.source.path && candidate.source.heading === block.source.heading)) {
      throw new VaultContextError("A source heading cannot be selected under more than one identifier", "conflict");
    }
    tracked.push(block);
    addedIds.add(block.id);
  }
  const root = await openVault(options.vault);
  const files = new Map<string, SourceFile>();
  const next: CoreBlock[] = [];
  let uploaded = 0;
  let downloaded = 0;
  let removed = 0;
  for (const block of tracked) {
    options.signal?.throwIfAborted();
    let file = files.get(block.source.path);
    if (!file) {
      const snapshot = await readSource(root, block.source.path);
      for (const existing of files.values()) {
        if (snapshot && existing.snapshot && existing.snapshot.stat.dev === snapshot.stat.dev && existing.snapshot.stat.ino === snapshot.stat.ino) {
          throw new VaultContextError("Multiple source paths resolve to the same Markdown file; use one canonical mapping", "conflict");
        }
      }
      file = { snapshot, sections: [], replacements: [] };
      files.set(block.source.path, file);
    }
    const section = file.snapshot && findSection(file.snapshot.text, block.source.heading);
    if (!section) {
      if (addedIds.has(block.id)) throw new VaultContextError("An explicitly selected source file or heading is missing; nothing was synchronized", "conflict");
      if (block.pendingSource) throw new VaultContextError("A source with a pending remote correction is missing; restore or reconcile it before sync", "conflict");
      removed++;
      continue;
    }
    if (file.sections.some(existing => section.headingStart < existing.section.end && existing.section.headingStart < section.end)) {
      throw new VaultContextError("Selected sections overlap; select disjoint headings rather than both a heading and its descendant", "conflict");
    }
    file.sections.push({ block, section });
    const text = normalizeSourceText(section.body);
    const revision = await sourceRevision(text);
    if (block.pendingSource) {
      const desired = normalizeSourceText(block.text);
      if (text !== desired && revision !== block.source.revision) {
        throw new VaultContextError("A source and its pending remote correction both changed differently; no files or remote blocks were overwritten", "conflict");
      }
      if (text !== desired) {
        file.replacements.push({ section, text: desired });
        downloaded++;
      }
      next.push({ ...block, text: desired, source: { ...block.source, revision: await sourceRevision(desired) }, pendingSource: false });
    } else {
      if (revision !== block.source.revision && !addedIds.has(block.id)) uploaded++;
      next.push({ ...block, text, source: { ...block.source, revision }, pendingSource: false });
    }
  }
  let validated: CoreBlock[];
  try { validated = parseCoreBlocks(next); }
  catch { throw new VaultContextError("Selected context exceeds document limits or contains an invalid block; no writes were performed"); }
  const replacements = new Map<string, string>();
  for (const [sourcePath, file] of files) {
    if (!file.replacements.length || !file.snapshot) continue;
    let text = file.snapshot.text;
    for (const replacement of file.replacements.sort((a, b) => b.section.start - a.section.start)) {
      text = text.slice(0, replacement.section.start) + replaceSection(replacement.section, replacement.text) + text.slice(replacement.section.end);
    }
    // Remote headings must not escape their approved section or change another mapping.
    for (const { block } of file.sections) {
      const section = findSection(text, block.source.heading);
      const desired = validated.find(candidate => candidate.id === block.id)!;
      if (!section || normalizeSourceText(section.body) !== desired.text) {
        throw new VaultContextError("A pending correction changes Markdown section boundaries; reconcile its headings before sync", "conflict");
      }
    }
    replacements.set(sourcePath, text);
  }
  for (const [path, file] of files) await assertUnchanged(root, path, file.snapshot);
  for (const [path, text] of replacements) {
    options.signal?.throwIfAborted();
    const file = files.get(path)!;
    file.snapshot = await replaceFile(root, file.snapshot!, text);
  }
  // Source uploads must still describe the files on disk, including files not replaced locally.
  for (const [path, file] of files) await assertUnchanged(root, path, file.snapshot);
  options.signal?.throwIfAborted();
  const changed = JSON.stringify(validated) !== JSON.stringify(current.blocks);
  const result = changed ? await requestContext(options, { expectedRevision: current.revision, blocks: validated }) : current;
  return { ...coreContextMetadata(result), added: addedIds.size, uploaded, downloaded, removed };
}
