import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runVaultCli, VaultCliError } from "../src/cli/vault.js";
import { VaultServiceError } from "../src/vault/safety.js";

test("partial setup cannot sync; finishing it uses the real pinned client and disables attachment defaults", async t => {
  const root = await mkdtemp(join(await realpath(tmpdir()), "umpi-vault-cli-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "source"), client = join(root, "client"), vault = join(client, "workspace/vault");
  const configRoot = process.platform === "linux" ? join(client, "workspace/xdg/obsidian-headless") : join(client, "home/.obsidian-headless");
  const configFile = join(configRoot, "sync/fixture-vault/config.json");
  for (const directory of [source, join(source, "journals"), join(source, "templates"), join(source, "unrelated"), vault, join(configRoot, "sync/fixture-vault")]) await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(configFile, JSON.stringify({ vaultId: "fixture-vault", vaultName: "Fixture", vaultPath: vault, host: "example.invalid", encryptionVersion: 3, encryptionKey: "synthetic-test-only", encryptionSalt: "synthetic-test-only", conflictStrategy: "merge" }), { mode: 0o600 });
  await assert.rejects(runVaultCli(["sync", "--root", client]), VaultCliError);
  // No provider request: sync-config operates on the already prepared synthetic
  // configuration. This exercises the actual pinned command's default handling.
  await runVaultCli(["setup", "--root", client, "--vault-id", "fixture-vault", "--source-vault", source]);
  const config = JSON.parse(await readFile(configFile, "utf8"));
  assert.equal(config.conflictStrategy, "conflict");
  assert.ok(config.syncMode === undefined || config.syncMode === "bidirectional");
  assert.deepEqual(config.allowTypes, []);
  assert.deepEqual(config.ignoreFolders, ["unrelated"]);
  assert.equal((await stat(join(client, "setup.json"))).mode & 0o777, 0o600);
  const output = join(root, "archive.gz");
  await assert.rejects(runVaultCli(["export", "--root", client, "--output", output]), VaultServiceError);
  await assert.rejects(stat(output), { code: "ENOENT" });
  // A later private configuration edit must invalidate the setup receipt before
  // an export can copy that changed configuration into an uploadable archive.
  await writeFile(configFile, JSON.stringify({ ...config, allowTypes: ["image"] }));
  await assert.rejects(runVaultCli(["export", "--root", client, "--output", output]), VaultCliError);
  await assert.rejects(stat(output), { code: "ENOENT" });
});
