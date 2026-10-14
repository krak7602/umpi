import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm, symlink, link, stat, readdir, unlink, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCipheriv, createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { gzipSync, gunzipSync } from "node:zlib";
import { once } from "node:events";
import { atomicReplace, readSafeFile, VaultServiceError } from "../src/vault/safety.ts";
import { createWorkspaceArchive, restoreWorkspaceArchive, workspaceConfig, HEADLESS_VERSION, MAX_ARCHIVE_ENTRIES, MAX_ARCHIVE_JSON_BYTES, type WorkspaceArchive } from "../src/vault/archive.ts";
import { SyncMetadata } from "../src/vault/metadata.ts";
import { SyncOutput, VaultRuntime, runHeadlessSync } from "../src/vault/runtime.ts";
import { createVaultService } from "../src/vault/server.ts";
import { DEFAULT_VAULT_SCOPE, MAX_NOTE_BYTES, MAX_WORKSPACE_BYTES, parseVaultApply, vaultNoteRevision } from "../src/shared/vault-planning.ts";

async function temporary(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(await realpath(tmpdir()), "umpi-vault-unit-"));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  return root;
}
interface CheckpointFixtureOptions { text?: string; encryptionVersion?: number }
interface CheckpointFixture { dbPath: string; note: string; text: string }
/** Synthetic provider-shaped SQLite rows exercise the pinned schema reader,
 * NOT a fake sync process or evidence of a remote upload. No test invokes a
 * provider. 0.0.14 uses AES-GCM bodies for versions 0/2/3, a 12-byte nonce,
 * and a 16-byte tag; push leaves zero-length bodies unencrypted.
 */
async function checkpointFixture(root: string, options: CheckpointFixtureOptions = {}): Promise<CheckpointFixture> {
  const directory = join(root, "xdg/obsidian-headless/sync/fixture-vault");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await mkdir(join(root, "vault/journals"), { recursive: true, mode: 0o700 });
  const note = "journals/2026-10-12.md", text = options.text ?? "# Synthetic note\n- [x] Owner fixture\n";
  await writeFile(join(root, "vault", note), text);
  await writeFile(join(root, "xdg/obsidian-headless/auth_token"), "synthetic-unit-test-only");
  await writeFile(join(directory, "config.json"), JSON.stringify({
    vaultId: "fixture-vault", vaultName: "Synthetic fixture", vaultPath: join(root, "vault"),
    host: "example.invalid", encryptionKey: "synthetic-unit-test-only", encryptionSalt: "synthetic-unit-test-only",
    encryptionVersion: options.encryptionVersion ?? 3, conflictStrategy: "conflict", configDir: ".obsidian",
  }));
  const dbPath = join(directory, "state.db");
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT); CREATE TABLE local_files(path TEXT PRIMARY KEY, data TEXT NOT NULL); CREATE TABLE server_files(path TEXT PRIMARY KEY, data TEXT NOT NULL); CREATE TABLE pending_files(uid INTEGER PRIMARY KEY, path TEXT, data TEXT NOT NULL);");
    db.prepare("INSERT INTO meta VALUES (?, ?)").run("initial", "false");
    const info = await stat(join(root, "vault", note));
    const hash = createHash("sha256").update(text).digest("hex");
    const mtime = Math.round(info.mtimeMs), ctime = Math.round(info.birthtimeMs);
    const local = { path: note, previouspath: "", hash, synchash: hash, synctime: Date.now(), folder: false, size: Buffer.byteLength(text), ctime, mtime };
    const nonce = Buffer.alloc(12), cipher = createCipheriv("aes-256-gcm", Buffer.alloc(32), nonce);
    const wireBytes = text.length === 0 ? Buffer.alloc(0) : Buffer.concat([nonce, cipher.update(text, "utf8"), cipher.final(), cipher.getAuthTag()]);
    const server = { path: note, hash, folder: false, size: wireBytes.byteLength, ctime, mtime, uid: 1, deleted: false };
    db.prepare("INSERT INTO local_files VALUES (?, ?)").run(note, JSON.stringify(local));
    db.prepare("INSERT INTO server_files VALUES (?, ?)").run(note, JSON.stringify(server));
  } finally { db.close(); }
  return { dbPath, note, text };
}

test("atomic replacement preserves owner changes and rejects an absent-base collision", async t => {
  const root = await temporary(t), path = "journals/2026-10-12.md";
  await atomicReplace(root, path, null, Buffer.from("initial\n"), MAX_NOTE_BYTES);
  const before = await readSafeFile(root, path, MAX_NOTE_BYTES);
  await writeFile(join(root, path), "owner changed\n");
  await assert.rejects(atomicReplace(root, path, before, Buffer.from("proposal\n"), MAX_NOTE_BYTES), /changed/);
  await assert.rejects(atomicReplace(root, path, null, Buffer.from("proposal\n"), MAX_NOTE_BYTES), /changed/);
  assert.equal(await readFile(join(root, path), "utf8"), "owner changed\n");
  assert.deepEqual(await readdir(join(root, "journals")), ["2026-10-12.md"]);
});

test("atomic replacement rechecks explicit expiry before rename and cleans temporary files", async t => {
  const root = await temporary(t), path = "journals/2026-10-12.md";
  await atomicReplace(root, path, null, Buffer.from("owner\n"), MAX_NOTE_BYTES);
  const before = await readSafeFile(root, path, MAX_NOTE_BYTES);
  await assert.rejects(atomicReplace(root, path, before, Buffer.from("proposal\n"), MAX_NOTE_BYTES, Date.now() - 1), /expired/);
  assert.equal(await readFile(join(root, path), "utf8"), "owner\n");
  assert.deepEqual(await readdir(join(root, "journals")), ["2026-10-12.md"]);
  await atomicReplace(root, path, before, Buffer.from("confirmed candidate\n"), MAX_NOTE_BYTES, Date.now() + 60_000);
  assert.equal(await readFile(join(root, path), "utf8"), "confirmed candidate\n");
});

test("scoped reads reject traversal, symlinks, hardlinks and oversized files", async t => {
  const root = await temporary(t);
  await writeFile(join(root, "note.md"), "fixture");
  await symlink(join(root, "note.md"), join(root, "symlink.md"));
  await assert.rejects(readSafeFile(root, "symlink.md", 1024));
  await assert.rejects(readSafeFile(root, "../note.md", 1024));
  await assert.rejects(readSafeFile(root, "note.md", 2));
  await link(join(root, "note.md"), join(root, "hardlink.md"));
  await assert.rejects(readSafeFile(root, "hardlink.md", 1024));
  await symlink(root, join(root, "directory-link"));
  await assert.rejects(readSafeFile(root, "directory-link/note.md", 1024));
});

test("sync markers require an exact completed stdout line and enforce bounded output", () => {
  const capture = new SyncOutput();
  capture.accept(Buffer.from("Uploading file Fully synced\n"), true);
  capture.accept(Buffer.from("Fully synced\n"), false);
  assert.equal(capture.fullySynced, false);
  capture.accept(Buffer.from("Fully sy"), true);
  assert.equal(capture.fullySynced, false);
  capture.accept(Buffer.from("nced\r\nConflicted copy stored journals/fixture.md\n"), true);
  assert.equal(capture.fullySynced, true);
  assert.equal(capture.conflicted, true);
  capture.accept(Buffer.alloc(256 * 1024), false);
  assert.equal(capture.exceeded, true);
});

test("pinned SQLite acknowledgement requires local hash, synchash, remote hash and actual bytes", async t => {
  const root = await temporary(t), fixture = await checkpointFixture(root);
  let metadata = await SyncMetadata.open(root);
  try {
    assert.equal(metadata.confirms(fixture.note, Buffer.from(fixture.text)), true);
    assert.equal(metadata.confirms(fixture.note, Buffer.from("different")), false);
    assert.equal(metadata.confirms("journals/absent.md", null), true);
    assert.equal(metadata.confirms(fixture.note, null), false);
    assert.equal(await metadata.confirmsWorkspace(root), true);
  } finally { metadata.close(); }
  const db = new DatabaseSync(fixture.dbPath);
  try {
    const row = db.prepare("SELECT data FROM local_files WHERE path = ?").get(fixture.note)!;
    const data = JSON.parse(String(row.data)); data.synchash = "0".repeat(64);
    db.prepare("UPDATE local_files SET data = ? WHERE path = ?").run(JSON.stringify(data), fixture.note);
  } finally { db.close(); }
  metadata = await SyncMetadata.open(root);
  try { assert.equal(metadata.confirms(fixture.note, Buffer.from(fixture.text)), false); }
  finally { metadata.close(); }
  await assert.rejects(createWorkspaceArchive(root), /Unconfirmed/);
});

test("pinned encryption versions acknowledge ciphertext-sized bodies and unencrypted empty files", async t => {
  const parent = await temporary(t);
  for (const encryptionVersion of [0, 2, 3]) {
    for (const [index, text] of ["", "x", "Résumé\n漢字\n"].entries()) {
      const root = join(parent, `${encryptionVersion}-${index}`);
      const fixture = await checkpointFixture(root, { encryptionVersion, text });
      const db = new DatabaseSync(fixture.dbPath, { readOnly: true });
      try {
        const row = db.prepare("SELECT data FROM server_files WHERE path = ?").get(fixture.note)!;
        const server = JSON.parse(String(row.data));
        assert.equal(server.size, text === "" ? 0 : Buffer.byteLength(text) + 28);
        assert.equal(Object.hasOwn(server, "synchash"), false);
        assert.equal(Object.hasOwn(server, "synctime"), false);
      } finally { db.close(); }
      const metadata = await SyncMetadata.open(root);
      try {
        assert.equal(metadata.confirms(fixture.note, Buffer.from(text)), true);
        assert.equal(metadata.confirms(fixture.note, null), false);
        assert.equal(await metadata.confirmsWorkspace(root), true);
      } finally { metadata.close(); }
    }
  }
});

test("metadata rejects unsupported encryption versions rather than guessing a wire format", async t => {
  const parent = await temporary(t);
  for (const encryptionVersion of [-1, 1, 4]) {
    const root = join(parent, String(encryptionVersion));
    await checkpointFixture(root, { encryptionVersion });
    await assert.rejects(SyncMetadata.open(root), /encryption version is unsupported/);
  }
});

test("acknowledgement retains plaintext hashes and local size while requiring exact encrypted server size", async t => {
  const root = await temporary(t), fixture = await checkpointFixture(root, { text: "Résumé\n漢字\n" });
  const bytes = Buffer.from(fixture.text), db = new DatabaseSync(fixture.dbPath);
  try {
    const originals = {
      local_files: JSON.parse(String(db.prepare("SELECT data FROM local_files WHERE path = ?").get(fixture.note)!.data)),
      server_files: JSON.parse(String(db.prepare("SELECT data FROM server_files WHERE path = ?").get(fixture.note)!.data)),
    };
    const cases: { table: "local_files" | "server_files"; patch: Record<string, unknown> }[] = [
      { table: "local_files", patch: { hash: "0".repeat(64) } },
      { table: "local_files", patch: { synchash: "0".repeat(64) } },
      { table: "local_files", patch: { synchash: undefined } },
      { table: "local_files", patch: { size: bytes.byteLength + 28 } },
      { table: "local_files", patch: { size: fixture.text.length } },
      { table: "server_files", patch: { hash: "0".repeat(64) } },
      { table: "server_files", patch: { size: bytes.byteLength } },
      { table: "server_files", patch: { size: bytes.byteLength + 12 } },
      { table: "server_files", patch: { size: bytes.byteLength + 16 } },
      { table: "server_files", patch: { size: bytes.byteLength + 27 } },
      { table: "server_files", patch: { size: bytes.byteLength + 29 } },
      { table: "server_files", patch: { size: undefined } },
      { table: "server_files", patch: { uid: 0 } },
      { table: "server_files", patch: { deleted: true } },
    ];
    for (const { table, patch } of cases) {
      db.prepare(`UPDATE ${table} SET data = ? WHERE path = ?`).run(JSON.stringify({ ...originals[table], ...patch }), fixture.note);
      const metadata = await SyncMetadata.open(root);
      try { assert.equal(metadata.confirms(fixture.note, bytes), false, `${table}: ${JSON.stringify(patch)}`); }
      finally { metadata.close(); }
      db.prepare(`UPDATE ${table} SET data = ? WHERE path = ?`).run(JSON.stringify(originals[table]), fixture.note);
    }
  } finally { db.close(); }
});

test("empty-file acknowledgement rejects encrypted framing and remains distinct from deletion", async t => {
  const root = await temporary(t), fixture = await checkpointFixture(root, { text: "" });
  const db = new DatabaseSync(fixture.dbPath);
  try {
    const row = db.prepare("SELECT data FROM server_files WHERE path = ?").get(fixture.note)!;
    const server = JSON.parse(String(row.data));
    for (const size of [12, 16, 28]) {
      db.prepare("UPDATE server_files SET data = ? WHERE path = ?").run(JSON.stringify({ ...server, size }), fixture.note);
      const metadata = await SyncMetadata.open(root);
      try { assert.equal(metadata.confirms(fixture.note, Buffer.alloc(0)), false); }
      finally { metadata.close(); }
    }
    db.prepare("UPDATE server_files SET data = ? WHERE path = ?").run(JSON.stringify({ ...server, deleted: true }), fixture.note);
    db.prepare("DELETE FROM local_files WHERE path = ?").run(fixture.note);
  } finally { db.close(); }
  const metadata = await SyncMetadata.open(root);
  try {
    assert.equal(metadata.confirms(fixture.note, null), true);
    assert.equal(metadata.confirms(fixture.note, Buffer.alloc(0)), false);
  } finally { metadata.close(); }
});

test("normal-file mtime acknowledgement follows nearest-millisecond provider rounding", async t => {
  const root = await temporary(t), fixture = await checkpointFixture(root);
  const base = 1_700_000_000_000, db = new DatabaseSync(fixture.dbPath);
  const timestamps: [number, number][] = [[0, base], [0.2, base], [0.49, base], [0.5, base + 1], [0.8, base + 1]];
  try {
    const row = db.prepare("SELECT data FROM local_files WHERE path = ?").get(fixture.note)!;
    const local = JSON.parse(String(row.data));
    for (const [fraction, rounded] of timestamps) {
      db.prepare("UPDATE local_files SET data = ? WHERE path = ?").run(JSON.stringify({ ...local, mtime: rounded }), fixture.note);
      const metadata = await SyncMetadata.open(root);
      try {
        assert.equal(metadata.confirms(fixture.note, Buffer.from(fixture.text), base + fraction), true);
        assert.equal(metadata.confirms(fixture.note, Buffer.from(fixture.text), base + fraction + 1), false);
      } finally { metadata.close(); }
    }
  } finally { db.close(); }
});

test("pending remote rows and untracked local files prevent authoritative checkpoints", async t => {
  const root = await temporary(t), fixture = await checkpointFixture(root);
  await writeFile(join(root, "vault/journals/untracked.md"), "not synchronized");
  await assert.rejects(createWorkspaceArchive(root), /Unconfirmed/);
  await unlink(join(root, "vault/journals/untracked.md"));
  const db = new DatabaseSync(fixture.dbPath);
  try { db.prepare("INSERT INTO pending_files VALUES (?, ?, ?)").run(2, fixture.note, "{}"); }
  finally { db.close(); }
  await assert.rejects(SyncMetadata.open(root), /incomplete/);
});

test("archive round-trip remaps only portable config, retains file bytes and mtime, and cannot overwrite", async t => {
  const parent = await temporary(t), root = join(parent, "source"), destination = join(parent, "restored");
  const fixture = await checkpointFixture(root);
  const archive = await createWorkspaceArchive(root);
  const decoded = JSON.parse(gunzipSync(archive).toString("utf8")) as WorkspaceArchive;
  assert.equal(decoded.headlessVersion, HEADLESS_VERSION);
  const config = decoded.files.find(file => file.path.endsWith("/config.json"))!;
  assert.equal(JSON.parse(Buffer.from(config.data, "base64").toString()).vaultPath, "@umpi/vault");
  await restoreWorkspaceArchive(destination, archive);
  assert.equal((await workspaceConfig(destination)).config.vaultPath, join(destination, "vault"));
  assert.equal((await workspaceConfig(destination)).config.conflictStrategy, "conflict");
  assert.equal(await readFile(join(destination, "vault", fixture.note), "utf8"), fixture.text);
  const original = await stat(join(root, "vault", fixture.note)), restored = await stat(join(destination, "vault", fixture.note));
  assert.ok(Math.abs(original.mtimeMs - restored.mtimeMs) < 1);
  assert.equal((await stat(join(destination, "xdg/obsidian-headless/auth_token"))).mode & 0o777, 0o600);
  await assert.rejects(restoreWorkspaceArchive(destination, archive), /already initialized/);
});

test("archive refuses dirty operations, live lockfiles and linked state", async t => {
  const root = await temporary(t); await checkpointFixture(root);
  await writeFile(join(root, ".unconfirmed"), "in progress\n");
  await assert.rejects(createWorkspaceArchive(root), /Unconfirmed/);
  await unlink(join(root, ".unconfirmed"));
  await mkdir(join(root, "vault/.obsidian"));
  await writeFile(join(root, "vault/.obsidian/.sync.lock"), "fixture");
  await assert.rejects(createWorkspaceArchive(root), /stopped checkpoint/);
  await unlink(join(root, "vault/.obsidian/.sync.lock"));
  await symlink(join(root, "xdg/obsidian-headless/auth_token"), join(root, "vault/linked.md"));
  await assert.rejects(createWorkspaceArchive(root), /links/);
});

test("restore rejects traversal, duplicate paths, wrong versions, link fields and nonportable config before writing", async t => {
  const parent = await temporary(t), source = join(parent, "source"); await checkpointFixture(source);
  const original = JSON.parse(gunzipSync(await createWorkspaceArchive(source)).toString()) as WorkspaceArchive;
  const mutations: ((archive: WorkspaceArchive) => void)[] = [
    archive => { archive.files[0]!.path = "../outside"; },
    archive => { archive.files[0]!.path = "/absolute"; },
    archive => { archive.files[0]!.path = "vault/../escape"; },
    archive => { archive.files[0]!.path = "vault\\escape"; },
    archive => { archive.files.push({ ...archive.files[0]! }); },
    archive => { Object.assign(archive, { headlessVersion: "uninspected" }); },
    archive => { Object.assign(archive.files[0]!, { type: "symlink", target: "/outside" }); },
    archive => { archive.files[0]!.data = "invalid base64"; },
    archive => { archive.files[0]!.mtimeMs = -1; },
    archive => { const config = archive.files.find(file => file.path.endsWith("/config.json"))!; const value = JSON.parse(Buffer.from(config.data, "base64").toString()); value.vaultPath = "/desktop/vault"; config.data = Buffer.from(JSON.stringify(value)).toString("base64"); },
    archive => { archive.files.push({ path: "vault/journals", data: "", mtimeMs: 0 }); },
  ];
  for (let i = 0; i < mutations.length; i++) {
    const archive = structuredClone(original); mutations[i]!(archive);
    const destination = join(parent, `invalid-${i}`);
    await assert.rejects(restoreWorkspaceArchive(destination, gzipSync(JSON.stringify(archive))));
    await assert.rejects(stat(destination), { code: "ENOENT" });
  }
});

test("restore bounds gzip expansion, compressed bytes and entry count", async t => {
  const root = await temporary(t);
  await assert.rejects(restoreWorkspaceArchive(join(root, "compressed"), Buffer.alloc(MAX_WORKSPACE_BYTES + 1)), /size limit/);
  await assert.rejects(restoreWorkspaceArchive(join(root, "expansion"), gzipSync(Buffer.alloc(MAX_ARCHIVE_JSON_BYTES + 1))), /Invalid/);
  const files = Array.from({ length: MAX_ARCHIVE_ENTRIES + 1 }, (_, i) => ({ path: `vault/${i}`, data: "", mtimeMs: 0 }));
  await assert.rejects(restoreWorkspaceArchive(join(root, "entries"), gzipSync(JSON.stringify({ version: 1, headlessVersion: HEADLESS_VERSION, files }))), /schema/);
});

test("runtime serializes restores and does not export an unverified restored checkpoint", async t => {
  const root = await temporary(t), source = join(root, "source"); await checkpointFixture(source);
  const archive = await createWorkspaceArchive(source);
  const runtime = new VaultRuntime({ stateRoot: join(root, "service"), cliPath: join(root, "missing-cli.js") });
  const first = runtime.restore(archive);
  await assert.rejects(runtime.restore(archive), /in progress/);
  await first;
  assert.equal(await runtime.initialized(), true);
  await assert.rejects(runtime.archive(), /confirmed sync/);
  await assert.rejects(runHeadlessSync(runtime.workspaceRoot, join(root, "missing-cli.js")), VaultServiceError);
});

test("failed real client startup leaves an unconfirmed intent and blocks checkpoint export", async t => {
  const root = await temporary(t), source = join(root, "source"), fixture = await checkpointFixture(source);
  const runtime = new VaultRuntime({ stateRoot: join(root, "service"), cliPath: join(root, "missing-cli.js") });
  await runtime.restore(await createWorkspaceArchive(source));
  const result = await runtime.apply({ intentId: "fixture-intent", day: "2026-10-12", beforeRevision: vaultNoteRevision(fixture.text), text: "candidate", expiresAt: new Date(Date.now() + 60_000).toISOString() }, DEFAULT_VAULT_SCOPE);
  assert.equal(result.status, "unconfirmed");
  assert.equal(await readFile(join(runtime.workspaceRoot, "vault", fixture.note), "utf8"), fixture.text);
  assert.ok(await readSafeFile(runtime.workspaceRoot, ".unconfirmed", 1024));
  await assert.rejects(runtime.archive(), /confirmed sync/);
  await assert.rejects(createWorkspaceArchive(runtime.workspaceRoot), /Unconfirmed/);
});

test("apply contract requires explicit expiry and cannot smuggle a path or command", () => {
  const intent = { intentId: "fixture-intent", day: "2026-10-12", beforeRevision: vaultNoteRevision(null), text: "candidate" };
  assert.throws(() => parseVaultApply(intent));
  assert.throws(() => parseVaultApply({ ...intent, expiresAt: "2026-10-13T00:00:00.000Z", path: "another.md" }));
  assert.throws(() => parseVaultApply({ ...intent, expiresAt: "2026-10-13T00:00:00.000Z", command: "anything" }));
});

test("real HTTP service exposes only readiness and narrow private operations without raw errors", async t => {
  const root = await temporary(t), server = createVaultService({ stateRoot: join(root, "service") });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); const closed = once(server, "close"); server.close(); await closed; });
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const ready = await fetch(`${origin}/ready`);
  assert.deepEqual(await ready.json(), { ready: true, initialized: false });
  assert.equal((await fetch(`${origin}/read?path=anything`)).status, 404);
  const snapshot = await fetch(`${origin}/snapshot`, { method: "POST", body: JSON.stringify({ day: "2026-10-12", scope: DEFAULT_VAULT_SCOPE }) });
  assert.equal(snapshot.status, 503);
  assert.equal((await snapshot.text()).includes(root), false);
  const invalid = await fetch(`${origin}/apply`, { method: "POST", body: JSON.stringify({ scope: DEFAULT_VAULT_SCOPE, intent: { path: "outside" } }) });
  assert.equal(invalid.status, 400);
  assert.equal((await fetch(`${origin}/archive`)).status, 409);
});

test("owner export reads separate native client roots without copying or rewriting source state", async t => {
  const root = await temporary(t), original = join(root, "initial"), fixture = await checkpointFixture(original);
  await mkdir(join(root, "isolated-home"), { mode: 0o700 });
  const configRoot = join(root, "isolated-home/.obsidian-headless"), vaultRoot = join(root, "dedicated-vault");
  await rename(join(original, "xdg/obsidian-headless"), configRoot);
  await rename(join(original, "vault"), vaultRoot);
  const configPath = join(configRoot, "sync/fixture-vault/config.json");
  const config = JSON.parse(await readFile(configPath, "utf8")); config.vaultPath = vaultRoot;
  await writeFile(configPath, JSON.stringify(config));
  const configBefore = await readFile(configPath), vaultBefore = await stat(join(vaultRoot, fixture.note));
  const archive = await createWorkspaceArchive(root, { configRoot, vaultRoot });
  assert.deepEqual(await readFile(configPath), configBefore);
  assert.equal((await stat(join(vaultRoot, fixture.note))).ino, vaultBefore.ino);
  const destination = join(root, "restored");
  await restoreWorkspaceArchive(destination, archive);
  assert.equal(await readFile(join(destination, "vault", fixture.note), "utf8"), fixture.text);
  assert.equal((await workspaceConfig(destination)).config.vaultPath, join(destination, "vault"));
  await assert.rejects(createWorkspaceArchive(root, { configRoot, vaultRoot: configRoot }), /separate/);
  await symlink(vaultRoot, join(root, "vault-link"));
  await assert.rejects(createWorkspaceArchive(root, { configRoot, vaultRoot: join(root, "vault-link") }));
});
