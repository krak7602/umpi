import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { runCodingCli } from "../src/cli/coding.js";
import { codingSourceDigest, inspectCodingSnapshot } from "../src/shared/coding-source.js";

const exec = promisify(execFile);
async function fixture(t: test.TestContext): Promise<{ root: string; workspace: string; privateDir: string }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "umpi-coding-cli-test-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace"), privateDir = join(root, "private");
  await mkdir(workspace, { mode: 0o700 });
  await mkdir(privateDir, { mode: 0o700 });
  await exec("git", ["init", "--quiet", "--template=", workspace]);
  await writeFile(join(workspace, "code.ts"), "export const result = 42;\n");
  return { root, workspace, privateDir };
}
const env = { UMPI_CONTROL_TOKEN: "synthetic-control-token-".repeat(3), UMPI_COORDINATOR_URL: "https://coordinator.example" };

test("snapshot is private local-only, nonoverwriting, and redacts file bodies", async t => {
  const { workspace, privateDir } = await fixture(t);
  const output = join(privateDir, "snapshot.gz");
  let stdout = "";
  await runCodingCli(["snapshot", "--workspace", workspace, "--output", output], { stdout: value => { stdout += value; }, fetch: async () => { throw new Error("Snapshot must never make network requests"); } });
  assert.equal((await lstat(output)).mode & 0o777, 0o600);
  const bytes = await readFile(output);
  const { manifest } = await inspectCodingSnapshot(bytes);
  assert.equal(JSON.parse(stdout).digest, manifest.digest);
  assert.equal(JSON.parse(stdout).fileCount, 1);
  assert.doesNotMatch(stdout, /export const|code\.ts|control-token/);
  await assert.rejects(runCodingCli(["snapshot", "--workspace", workspace, "--output", output], { stdout() {} }));
  assert.deepEqual(await readFile(output), bytes);
  const inside = join(workspace, "private", "snapshot.gz");
  await assert.rejects(runCodingCli(["snapshot", "--workspace", workspace, "--output", inside], { stdout() {} }), /outside/);
  await assert.rejects(lstat(join(workspace, "private")), { code: "ENOENT" });
});

test("upload sends only explicit exact gzip and requires matching immutable receipt", async t => {
  const { workspace, privateDir } = await fixture(t);
  const file = join(privateDir, "snapshot.gz");
  await runCodingCli(["snapshot", "--workspace", workspace, "--output", file], { stdout() {} });
  const bytes = await readFile(file);
  const { manifest } = await inspectCodingSnapshot(bytes);
  let calls = 0, stdout = "";
  await runCodingCli(["upload", "--workspace", workspace, "--file", file, "--source-id", "source-one"], {
    env, stdout: value => { stdout += value; }, fetch: async (url, init) => {
      calls++;
      assert.equal(String(url), "https://coordinator.example/api/coding/sources/source-one");
      assert.equal(init?.method, "POST");
      assert.equal(init?.redirect, "error");
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("authorization"), `Bearer ${env.UMPI_CONTROL_TOKEN}`);
      assert.equal(headers.get("content-length"), String(bytes.length));
      assert.equal(Buffer.from(headers.get("x-umpi-coding-cwd")!, "base64url").toString(), workspace);
      assert.deepEqual(Buffer.from(init?.body as Uint8Array), bytes);
      return Response.json({ sourceId: "source-one", cwd: workspace, capturedAt: manifest.capturedAt, digest: manifest.digest, bytes: bytes.length, fileCount: manifest.fileCount, baseRevision: manifest.baseRevision });
    },
  });
  assert.equal(calls, 1);
  assert.equal(JSON.parse(stdout).digest, manifest.digest);
  assert.doesNotMatch(stdout, /control-token|export const/);
  await assert.rejects(runCodingCli(["upload", "--workspace", workspace, "--file", file, "--source-id", "source-one"], {
    env, stdout() {}, fetch: async () => Response.json({ sourceId: "source-one", digest: "0".repeat(64), bytes: bytes.length }),
  }), /receipt/);
  await chmod(file, 0o644);
  await assert.rejects(runCodingCli(["upload", "--workspace", workspace, "--file", file, "--source-id", "source-one"], {
    env, stdout() {}, fetch: async () => { throw new Error("Unsafe file must not be uploaded"); },
  }), /Private file/);
});

test("download validates digest and bounds, writes exact private bytes and never applies patch", async t => {
  const { workspace, privateDir } = await fixture(t);
  const patch = new TextEncoder().encode("diff --git a/file b/file\nsynthetic patch bytes\n");
  const digest = await codingSourceDigest(patch);
  const output = join(privateDir, "review.patch");
  let stdout = "";
  await runCodingCli(["download", "--task", "task-one", "--output", output], { env, stdout: value => { stdout += value; }, fetch: async (url, init) => {
    assert.equal(String(url), "https://coordinator.example/api/coding/tasks/task-one/patch");
    assert.equal(init?.redirect, "error");
    return new Response(patch, { headers: { "x-umpi-coding-patch-digest": digest, "x-umpi-coding-base-digest": "a".repeat(64), "x-umpi-coding-final-digest": "b".repeat(64), "content-length": String(patch.length) } });
  } });
  assert.deepEqual(await readFile(output), Buffer.from(patch));
  assert.equal((await lstat(output)).mode & 0o777, 0o600);
  assert.equal(JSON.parse(stdout).patchDigest, digest);
  assert.equal(JSON.parse(stdout).baseDigest, "a".repeat(64));
  assert.equal(JSON.parse(stdout).finalDigest, "b".repeat(64));
  assert.doesNotMatch(stdout, /synthetic patch/);
  assert.equal(await readFile(join(workspace, "code.ts"), "utf8"), "export const result = 42;\n");
  const bad = join(privateDir, "bad.patch");
  await assert.rejects(runCodingCli(["download", "--task", "task-one", "--output", bad], { env, stdout() {}, fetch: async () => new Response(patch, { headers: { "x-umpi-coding-patch-digest": "0".repeat(64) } }) }), /digest/);
  await assert.rejects(lstat(bad), { code: "ENOENT" });
  await assert.rejects(runCodingCli(["download", "--task", "task-one", "--output", bad], { env, stdout() {}, fetch: async () => new Response(patch, { headers: { "content-length": String(8 * 1024 * 1024 + 1) } }) }), /size limit/);
  await assert.rejects(lstat(bad), { code: "ENOENT" });
});

test("remote artifact requests reject unsafe origins and missing owner credentials before transport", async t => {
  const { privateDir } = await fixture(t);
  for (const supplied of [{ ...env, UMPI_COORDINATOR_URL: "http://remote.example" }, { UMPI_COORDINATOR_URL: env.UMPI_COORDINATOR_URL }]) {
    await assert.rejects(runCodingCli(["download", "--task", "task-one", "--output", join(privateDir, "output.patch")], {
      env: supplied, stdout() {}, fetch: async () => { assert.fail("Invalid auth/origin must not dispatch"); },
    }));
  }
});
