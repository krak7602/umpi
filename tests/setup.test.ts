import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const entry = resolve("src/cli/setup.ts");

function setup(directory: string, config = join(directory, "mac.json")) {
  return spawnSync(process.execPath, ["--import", "tsx", entry, "local", "--vars-file", join(directory, ".dev.vars"), "--config", config, "--workspace", directory], { encoding: "utf8" });
}

test("local setup protects credentials and refuses to replace an existing installation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "umpi-setup-test-"));
  try {
    const first = setup(directory);
    assert.equal(first.status, 0, first.stderr);
    const envPath = join(directory, ".dev.vars");
    const configPath = join(directory, "mac.json");
    assert.equal((await stat(envPath)).mode & 0o777, 0o600);
    assert.equal((await stat(configPath)).mode & 0o777, 0o600);
    const envBefore = await readFile(envPath, "utf8");
    const configBefore = await readFile(configPath, "utf8");
    const credential = JSON.parse(configBefore).executorToken as string;
    assert.ok(!first.stdout.includes(credential) && !first.stderr.includes(credential), "Setup must not print transport credentials");
    const second = setup(directory);
    assert.notEqual(second.status, 0);
    assert.ok(await readFile(envPath, "utf8") === envBefore, "Existing Worker configuration changed");
    assert.ok(await readFile(configPath, "utf8") === configBefore, "Existing Mac configuration changed");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("a Mac configuration collision rolls back only newly created Worker configuration", async () => {
  const directory = await mkdtemp(join(tmpdir(), "umpi-setup-collision-"));
  try {
    const configPath = join(directory, "mac.json");
    await writeFile(configPath, "user-owned configuration", { mode: 0o600 });
    const result = setup(directory, configPath);
    assert.notEqual(result.status, 0);
    assert.equal(await readFile(configPath, "utf8"), "user-owned configuration");
    await assert.rejects(stat(join(directory, ".dev.vars")), { code: "ENOENT" });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
