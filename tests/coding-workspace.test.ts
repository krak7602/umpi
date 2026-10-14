import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { gzipSync } from "node:zlib";
import { captureCodingSnapshot, compareCodingSnapshots, restoreCodingSnapshot } from "../src/coding/workspace.js";
import { MAX_CODING_ARCHIVE_BYTES, MAX_CODING_FILES } from "../src/shared/coding.js";
import { inspectCodingSnapshot, MAX_CODING_CONTENT_BYTES, MAX_CODING_DECODED_BYTES, type CodingSnapshotDocument } from "../src/shared/coding-source.js";

const exec = promisify(execFile);
async function fixture(t: test.TestContext): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "umpi-source-test-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  await exec("git", ["init", "--quiet", "--template=", "--initial-branch=main", root]);
  return root;
}
async function commit(root: string): Promise<void> {
  await exec("git", ["-C", root, "add", "--all"]);
  await exec("git", ["-C", root, "-c", "user.name=Private original author", "-c", "user.email=private@example.invalid", "-c", "core.hooksPath=/dev/null", "commit", "--quiet", "-m", "baseline"]);
}

function archive(files: CodingSnapshotDocument["files"]): Uint8Array {
  return gzipSync(JSON.stringify({ version: 1, capturedAt: "2026-01-01T00:00:00.000Z", baseRevision: null, files, exclusions: [] }));
}

const entry = { path: "source.txt", mode: 0o100644 as const, bytes: 4, digest: createHash("sha256").update("safe").digest("hex"), content: Buffer.from("safe").toString("base64") };

test("snapshot selects changed working-tree bytes and safe untracked source, not HEAD or private/generated files", async t => {
  const root = await fixture(t);
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src", "credentials.ts"), "export const credentialSchema = {};\n");
  await writeFile(join(root, "src", "model-credentials.test.ts"), "// credential behavior regression\n");
  await writeFile(join(root, "tracked.txt"), "committed\n");
  await writeFile(join(root, "deleted.txt"), "remove me\n");
  await writeFile(join(root, ".env"), "TOKEN=synthetic-private\n");
  await writeFile(join(root, "credentials.json"), '{"token":"synthetic-private"}');
  await writeFile(join(root, "wrangler.local.jsonc"), "private deployment config");
  await writeFile(join(root, "signing.p8"), "synthetic private signing material");
  await mkdir(join(root, "node_modules"));
  await writeFile(join(root, "node_modules", "tracked-dependency.js"), "not source");
  await writeFile(join(root, ".gitignore"), "ignored.txt\n");
  await commit(root);
  await writeFile(join(root, "tracked.txt"), "actual local change\n");
  await rm(join(root, "deleted.txt"));
  await writeFile(join(root, "untracked.ts"), "export const local = 42;\n");
  await writeFile(join(root, "ignored.txt"), "ignored private content");
  const index = await readFile(join(root, ".git", "index"));
  const snapshot = await captureCodingSnapshot(root);
  const { document } = await inspectCodingSnapshot(snapshot.bytes);
  assert.equal(Buffer.from(document.files.find(file => file.path === "tracked.txt")!.content, "base64").toString(), "actual local change\n");
  assert.ok(document.files.some(file => file.path === "untracked.ts"));
  assert.ok(document.files.some(file => file.path === "src/credentials.ts"));
  assert.ok(document.files.some(file => file.path === "src/model-credentials.test.ts"));
  assert.ok(!document.files.some(file => [".env", "credentials.json", "wrangler.local.jsonc", "signing.p8", "node_modules/tracked-dependency.js", "ignored.txt", "deleted.txt"].includes(file.path)));
  assert.deepEqual(document.exclusions.map(item => item.path), [".env", "credentials.json", "node_modules/tracked-dependency.js", "signing.p8", "wrangler.local.jsonc"]);
  assert.equal(snapshot.manifest.digest, createHash("sha256").update(snapshot.bytes).digest("hex"));
  assert.deepEqual(await readFile(join(root, ".git", "index")), index);
  assert.equal(await readFile(join(root, ".env"), "utf8"), "TOKEN=synthetic-private\n");
});

test("review patch applies exact binary, text, executable, added and deleted bytes to selected baseline", async t => {
  const root = await fixture(t);
  await writeFile(join(root, "text.txt"), "original\r\nno newline");
  await writeFile(join(root, "binary.dat"), Buffer.from([0, 255, 1, 128]));
  await writeFile(join(root, "invalid-utf8.dat"), Buffer.from([255, 254, 128]));
  await writeFile(join(root, "remove.txt"), "delete\n");
  await writeFile(join(root, "executable.sh"), "#!/bin/sh\necho hello\n");
  await writeFile(join(root, "odd [name] ü.txt"), "old\n");
  await writeFile(join(root, ".gitattributes"), "* text eol=crlf\n*.dat diff\n");
  await commit(root);
  const before = await captureCodingSnapshot(root);
  await writeFile(join(root, "text.txt"), "updated\r\nno newline");
  await writeFile(join(root, "binary.dat"), Buffer.from([0, 253, 8, 129, 5]));
  await writeFile(join(root, "invalid-utf8.dat"), Buffer.from([255, 250, 129]));
  await rm(join(root, "remove.txt"));
  await chmod(join(root, "executable.sh"), 0o755);
  await writeFile(join(root, "odd [name] ü.txt"), "new\n");
  await writeFile(join(root, "added.bin"), Buffer.from([0, 1, 2, 255]));
  await writeFile(join(root, "empty.txt"), "");
  const after = await captureCodingSnapshot(root);
  const artifacts = await compareCodingSnapshots(before.bytes, after.bytes);
  assert.equal(artifacts.baseDigest, before.manifest.digest);
  assert.equal(artifacts.finalDigest, after.manifest.digest);
  assert.equal(artifacts.patchDigest, createHash("sha256").update(artifacts.patch).digest("hex"));
  assert.match(artifacts.patch, /GIT binary patch/);
  assert.match(artifacts.patch, /old mode 100644\nnew mode 100755/);
  assert.match(artifacts.patch, /-original/);
  const target = join(root, "scratch");
  await restoreCodingSnapshot(before.bytes, target);
  const author = await exec("git", ["-C", target, "show", "-s", "--format=%an <%ae>"]);
  assert.equal(author.stdout.trim(), "Coding snapshot <snapshot@invalid>");
  assert.equal((await exec("git", ["-C", target, "remote"])).stdout, "");
  const patchFile = join(root, "review.patch");
  await writeFile(patchFile, artifacts.patch);
  await exec("git", ["-C", target, "-c", "core.autocrlf=false", "apply", "--binary", "--whitespace=nowarn", patchFile]);
  const { document } = await inspectCodingSnapshot(after.bytes);
  for (const file of document.files) {
    assert.deepEqual(await readFile(join(target, file.path)), Buffer.from(file.content, "base64"), file.path);
    assert.equal((await lstat(join(target, file.path))).mode & 0o111 ? 0o100755 : 0o100644, file.mode, file.path);
  }
  await assert.rejects(readFile(join(target, "remove.txt")), { code: "ENOENT" });
});

test("restore rejects corruption, traversals, duplicates, invalid modes and file-directory aliases before any extraction", async t => {
  const root = await fixture(t);
  const destination = join(root, "restore");
  await mkdir(destination, { mode: 0o700 });
  const inputs = [
    Buffer.from("not gzip"), archive([entry]).slice(0, -4),
    archive([{ ...entry, path: "../outside" }]), archive([{ ...entry, path: "/absolute" }]),
    archive([{ ...entry, path: "dir\\escape" }]), archive([{ ...entry, path: ".git/config" }]),
    archive([{ ...entry, path: "credentials.json" }]), archive([{ ...entry, path: "dir/.env" }]),
    archive([entry, entry]), archive([entry, { ...entry, path: "SOURCE.txt" }]),
    archive([entry, { ...entry, path: "source.txt/nested" }]),
    archive([{ ...entry, mode: 0o120000 as 0o100644 }]),
    archive([{ ...entry, digest: "0".repeat(64) }]), archive([{ ...entry, bytes: 5 }]),
    new Uint8Array(MAX_CODING_ARCHIVE_BYTES + 1),
    gzipSync(Buffer.alloc(MAX_CODING_DECODED_BYTES + 1, 32)),
    archive([{ ...entry, bytes: MAX_CODING_CONTENT_BYTES + 1 }]),
    archive(Array.from({ length: MAX_CODING_FILES + 1 }, (_, index) => ({ ...entry, path: `file-${index}` }))),
  ];
  for (const input of inputs) {
    await assert.rejects(restoreCodingSnapshot(input, destination));
    assert.deepEqual(await readdir(destination), []);
    assert.ok(!(await readdir(root)).some(name => name.startsWith(".coding-restore-")));
  }
});

test("capture rejects symlink entries and directory escapes, and restore refuses existing nonempty destinations", async t => {
  const root = await fixture(t);
  await writeFile(join(root, "file.txt"), "safe\n");
  await commit(root);
  const before = await captureCodingSnapshot(root);
  await symlink("file.txt", join(root, "link.txt"));
  await assert.rejects(captureCodingSnapshot(root), /regular|symlink/);
  await rm(join(root, "link.txt"));
  await mkdir(join(root, "dir"));
  await writeFile(join(root, "dir", "source.txt"), "safe\n");
  await exec("git", ["-C", root, "add", "dir/source.txt"]);
  await rm(join(root, "dir"), { recursive: true });
  await symlink(tmpdir(), join(root, "dir"));
  await assert.rejects(captureCodingSnapshot(root));
  await assert.rejects(restoreCodingSnapshot(before.bytes, root), /fresh owned empty/);
  assert.equal(await readFile(join(root, "file.txt"), "utf8"), "safe\n");
});

test("content-identical snapshots compare independently of capture timestamp and revision", async () => {
  const original = archive([entry]);
  const { document } = await inspectCodingSnapshot(original);
  const newer = gzipSync(JSON.stringify({ ...document, capturedAt: "2026-01-02T00:00:00.000Z", baseRevision: "a".repeat(40) }));
  const result = await compareCodingSnapshots(original, newer);
  assert.notEqual(result.baseDigest, result.finalDigest);
  assert.deepEqual(result.changes, []);
  assert.equal(result.patch, "");
});

test("oversize exact binary review patch rejects instead of returning truncated artifacts", async () => {
  const snapshots = [0, 1].map(() => {
    const bytes = randomBytes(4 * 1024 * 1024);
    return archive([{ path: "binary.dat", mode: 0o100644, bytes: bytes.length, digest: createHash("sha256").update(bytes).digest("hex"), content: bytes.toString("base64") }]);
  });
  await assert.rejects(compareCodingSnapshots(snapshots[0]!, snapshots[1]!), /exceeded its bound/);
});
