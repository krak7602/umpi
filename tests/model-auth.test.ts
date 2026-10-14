import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test, { type TestContext } from "node:test";
import { InMemoryCredentialStore, type OAuthCredential } from "@earendil-works/pi-ai";
import { AuthInputError, parseAssistantCredential } from "../src/model/credentials.js";
import { AuthStorageError, FileCredentialStore } from "../src/model/file-store.js";
import { createAssistantModels, DEFAULT_MODEL, DEFAULT_PROVIDER, selectAssistantModel } from "../src/model/provider.js";
import { syncCredential } from "../src/model/sync.js";

function codex(overrides: Partial<OAuthCredential> = {}): OAuthCredential {
  return { type: "oauth", access: "synthetic-access", refresh: "synthetic-refresh", expires: Date.now() + 3_600_000, accountId: "synthetic-account", ...overrides };
}

function chatgpt(): OAuthCredential {
  return { ...codex(), clientId: "synthetic-client", scopes: ["openid", "chatgpt.tokens.use.direct"] };
}

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(join(tmpdir(), "umpi-auth-test-"));
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  const directory = join(root, "auth");
  return { root, directory, store: new FileCredentialStore(directory) };
}

test("installed real catalogs provide the selected subscription model on both transports without paid fallback", async t => {
  const original = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "synthetic-paid-key-must-never-be-used";
  t.after(() => {
    if (original === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = original;
  });
  const credentials = new InMemoryCredentialStore();
  const models = createAssistantModels(credentials);
  const selected = selectAssistantModel(models);
  assert.equal(DEFAULT_PROVIDER, "openai");
  assert.equal(DEFAULT_MODEL, "gpt-5.6-sol");
  assert.equal(selected.provider, DEFAULT_PROVIDER);
  assert.equal(selected.id, DEFAULT_MODEL);
  assert.equal(selected.api, "openai-responses");
  assert.equal(selectAssistantModel(models, "openai-codex").api, "openai-codex-responses");
  assert.deepEqual(models.getProviders().map(provider => provider.id).sort(), ["openai", "openai-codex"]);
  assert.equal(await models.getAuth("openai"), undefined);
  await credentials.modify("openai", async () => ({ type: "api_key", key: "synthetic-paid-key" }));
  assert.equal(await models.getAuth("openai"), undefined);
  assert.throws(() => selectAssistantModel(models, "openai", "unlisted-model"), AuthInputError);
  assert.throws(() => selectAssistantModel(models, "unregistered-provider"), AuthInputError);
});

test("access-only credentials retain real expiry and resolve through the real OAuth provider", async () => {
  const credentials = new InMemoryCredentialStore();
  const accessOnly = codex({ refresh: "" });
  const parsed = parseAssistantCredential("openai-codex", accessOnly);
  assert.deepEqual(parsed, accessOnly);
  await credentials.modify("openai-codex", async () => parsed);
  const models = createAssistantModels(credentials);
  const auth = await models.getAuth("openai-codex");
  assert.equal(auth?.source, "OAuth");
  assert.equal(auth?.auth.apiKey, accessOnly.access);
  assert.deepEqual(await credentials.read("openai-codex"), accessOnly);
});

test("expired access-only OAuth fails closed without replacing credentials or using paid auth", async t => {
  const credentials = new InMemoryCredentialStore();
  const expired = codex({ refresh: "", expires: Date.now() - 60_000 });
  await credentials.modify("openai-codex", async () => expired);
  const requests: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    requests.push(String(input));
    return new Response('{"error":"invalid_grant"}', { status: 400 });
  });
  const models = createAssistantModels(credentials);
  await assert.rejects(models.getAuth("openai-codex"), error => error instanceof Error && "code" in error && error.code === "oauth");
  assert.deepEqual(requests, ["https://auth.openai.com/oauth/token"]);
  assert.deepEqual(await credentials.read("openai-codex"), expired);
});

test("credential boundary rejects paid keys and provider relabeling, strips request overrides", () => {
  assert.throws(() => parseAssistantCredential("openai", codex()), AuthInputError);
  assert.throws(() => parseAssistantCredential("openai-codex", { type: "api_key", key: "synthetic" }), AuthInputError);
  assert.throws(() => parseAssistantCredential("other-provider", codex()), AuthInputError);
  assert.throws(() => parseAssistantCredential("openai-codex", codex({ expires: Number.NaN })), AuthInputError);
  assert.throws(() => parseAssistantCredential("openai-codex", { ...codex(), refresh: undefined }), AuthInputError);
  const expected = chatgpt();
  const { accountId: _unused, ...canonical } = expected;
  assert.deepEqual(parseAssistantCredential("openai", { ...expected, headers: { authorization: "synthetic" }, baseUrl: "https://untrusted.invalid" }), canonical);
});

test("credentials and installation identity persist in owner-only independent files across restart", async t => {
  const { directory, store } = await fixture(t);
  const first = codex();
  const second = chatgpt();
  await store.modify("openai-codex", async () => first);
  await store.modify("openai", async () => second);
  const deviceId = await store.deviceId();
  const restarted = new FileCredentialStore(directory);
  assert.deepEqual(await restarted.read("openai-codex"), first);
  assert.deepEqual(await restarted.read("openai"), parseAssistantCredential("openai", second));
  assert.equal(await restarted.deviceId(), deviceId);
  assert.deepEqual(await restarted.list(), [{ providerId: "openai", type: "oauth" }, { providerId: "openai-codex", type: "oauth" }]);
  assert.equal((await fs.stat(directory)).mode & 0o777, 0o700);
  for (const name of ["openai.json", "openai-codex.json", "installation.json"]) {
    assert.equal((await fs.stat(join(directory, name))).mode & 0o777, 0o600);
  }
  assert.deepEqual((await fs.readdir(directory)).sort(), ["installation.json", "openai-codex.json", "openai.json"]);
});

test("async read-modify-write is serialized across independent store instances", async t => {
  const { directory, store } = await fixture(t);
  await store.modify("openai-codex", async () => codex({ access: "0" }));
  const writers = Array.from({ length: 8 }, () => new FileCredentialStore(directory));
  await Promise.all(writers.map(writer => writer.modify("openai-codex", async current => {
    assert.equal(current?.type, "oauth");
    if (current?.type !== "oauth") throw new Error("Missing synthetic credential");
    await delay(5);
    return { ...current, access: String(Number(current.access) + 1) };
  })));
  const final = await store.read("openai-codex");
  assert.equal(final?.type === "oauth" && final.access, "8");
});

test("refresh lock spans processes and the entire callback, so rotated credentials are not lost", { timeout: 15_000 }, async t => {
  const { directory, store } = await fixture(t);
  await store.modify("openai-codex", async () => codex());
  const moduleUrl = new URL("../src/model/file-store.ts", import.meta.url).href;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", `
    import { FileCredentialStore } from ${JSON.stringify(moduleUrl)};
    import { once } from 'node:events';
    const store = new FileCredentialStore(process.env.UMPI_TEST_AUTH_DIR);
    await store.modify('openai-codex', async credential => {
      process.send('locked');
      await once(process, 'message');
      return { ...credential, access: 'rotated-access', refresh: 'rotated-refresh' };
    });
    process.disconnect();
  `], { env: { ...process.env, UMPI_TEST_AUTH_DIR: directory }, stdio: ["ignore", "ignore", "pipe", "ipc"] });
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  const exited = once(child, "exit");
  const firstEvent = await Promise.race([once(child, "message"), exited.then(() => { throw new Error("Credential test child exited before acquiring lock"); })]);
  assert.equal(firstEvent[0], "locked");
  let entered = false;
  const localWrite = store.modify("openai-codex", async current => {
    entered = true;
    assert.equal(current?.type === "oauth" && current.refresh, "rotated-refresh");
    return undefined;
  });
  await delay(100);
  assert.equal(entered, false);
  child.send("release");
  await localWrite;
  assert.equal((await exited)[0], 0);
  const stored = await store.read("openai-codex");
  assert.equal(stored?.type === "oauth" && stored.access, "rotated-access");
});

test("undefined callback results and rejected mutations preserve the durable credential", async t => {
  const { store } = await fixture(t);
  const credential = codex();
  await store.modify("openai-codex", async () => credential);
  const result = await store.modify("openai-codex", async current => {
    if (current?.type === "oauth") current.access = "must-not-persist";
    return undefined;
  });
  assert.deepEqual(result, credential);
  await assert.rejects(store.modify("openai-codex", async () => { throw new Error("synthetic callback failure"); }));
  assert.deepEqual(await store.read("openai-codex"), credential);
  await store.delete("openai-codex");
  assert.equal(await store.read("openai-codex"), undefined);
});

test("waiting cancellation cannot enter or release another writer's lock", async t => {
  const { directory, store } = await fixture(t);
  let release!: () => void;
  let entered!: () => void;
  const holding = new Promise<void>(resolve => { entered = resolve; });
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const writer = store.modify("openai-codex", async () => { entered(); await barrier; return codex(); });
  await holding;
  let called = false;
  try {
    await assert.rejects(new FileCredentialStore(directory).modify("openai-codex", async () => { called = true; return codex(); }, { signal: AbortSignal.timeout(30) }));
    assert.equal(called, false);
    assert.equal((await fs.stat(join(directory, "openai-codex.lock"))).isDirectory(), true);
  } finally {
    release();
    await writer;
  }
  assert.equal((await store.read("openai-codex"))?.type, "oauth");
});

test("cancellation after token rotation does not discard the returned credential", async t => {
  const { store } = await fixture(t);
  const controller = new AbortController();
  const rotated = codex({ access: "rotated-access", refresh: "rotated-refresh" });
  await store.modify("openai-codex", async () => {
    controller.abort();
    return rotated;
  }, { signal: controller.signal });
  assert.deepEqual(await store.read("openai-codex"), rotated);
});

test("logout serializes behind refresh and cannot resurrect a deleted credential", async t => {
  const { directory, store } = await fixture(t);
  let release!: () => void;
  let acquired!: () => void;
  const holding = new Promise<void>(resolve => { acquired = resolve; });
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const refresh = store.modify("openai-codex", async () => {
    acquired();
    await barrier;
    return codex({ refresh: "rotated-refresh" });
  });
  await holding;
  const logout = new FileCredentialStore(directory).delete("openai-codex");
  release();
  await Promise.all([refresh, logout]);
  assert.equal(await store.read("openai-codex"), undefined);
});

test("corrupt files are not treated as missing or overwritten", async t => {
  const { directory, store } = await fixture(t);
  await store.read("openai-codex");
  const path = join(directory, "openai-codex.json");
  const invalid = '{"version":1,"credential":"synthetic-private-fragment"';
  await fs.writeFile(path, invalid, { mode: 0o600 });
  let called = false;
  await assert.rejects(store.modify("openai-codex", async () => { called = true; return codex(); }), error => error instanceof AuthStorageError && !error.message.includes("synthetic-private-fragment"));
  assert.equal(called, false);
  assert.equal(await fs.readFile(path, "utf8"), invalid);
  await assert.rejects(store.delete("openai-codex"), AuthStorageError);
  assert.equal(await fs.readFile(path, "utf8"), invalid);
});

test("broad permissions, symlinks, and repository-local state are refused", async t => {
  const { root, directory, store } = await fixture(t);
  await store.modify("openai-codex", async () => codex());
  const path = join(directory, "openai-codex.json");
  await fs.chmod(path, 0o644);
  await assert.rejects(store.read("openai-codex"), AuthStorageError);
  await fs.chmod(path, 0o600);
  await fs.chmod(directory, 0o755);
  await assert.rejects(store.list(), AuthStorageError);
  await fs.chmod(directory, 0o700);
  const linkedDirectory = join(root, "linked-auth");
  await fs.symlink(directory, linkedDirectory);
  await assert.rejects(new FileCredentialStore(linkedDirectory).read("openai-codex"), AuthStorageError);
  const externalFile = join(root, "external.json");
  await fs.rename(path, externalFile);
  await fs.symlink(externalFile, path);
  await assert.rejects(store.read("openai-codex"), AuthStorageError);
  assert.throws(() => new FileCredentialStore(new URL("../.test-auth", import.meta.url).pathname), AuthStorageError);
});

test("sync enforces origin and bearer boundaries before reading or sending credentials", async () => {
  const store = new InMemoryCredentialStore();
  let requests = 0;
  const fetcher: typeof fetch = async () => { requests++; return new Response(null, { status: 204 }); };
  for (const origin of ["http://example.com", "https://user:pass@example.com", "https://example.com/path", "https://example.com?token=synthetic", "https://example.com/#fragment", "file:///tmp/auth"]) {
    await assert.rejects(syncCredential(store, { providerId: "openai-codex", coordinatorOrigin: origin, controlToken: "x".repeat(32), fetch: fetcher }));
  }
  for (const token of [undefined, "short", `${"x".repeat(32)}\nheader`]) {
    await assert.rejects(syncCredential(store, { providerId: "openai-codex", coordinatorOrigin: "https://example.com", controlToken: token, fetch: fetcher }));
  }
  await assert.rejects(syncCredential(store, { providerId: "openai-codex", coordinatorOrigin: "https://example.com", controlToken: "x".repeat(32), fetch: fetcher }));
  assert.equal(requests, 0);
});

test("explicit sync sends only the selected canonical credential and never follows redirects or refreshes", async () => {
  const store = new InMemoryCredentialStore();
  const credential = codex({ refresh: "" });
  await store.modify("openai-codex", async () => credential);
  await store.modify("openai", async () => chatgpt());
  let requests = 0;
  const fetcher: typeof fetch = async (input, init) => {
    requests++;
    assert.equal(String(input), "http://127.0.0.1:8787/api/auth");
    assert.equal(init?.method, "POST");
    assert.equal(init?.redirect, "error");
    assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${"x".repeat(32)}`);
    assert.deepEqual(JSON.parse(String(init?.body)), { providerId: "openai-codex", credential });
    return new Response(null, { status: 204 });
  };
  await syncCredential(store, { providerId: "openai-codex", coordinatorOrigin: "http://127.0.0.1:8787", controlToken: "x".repeat(32), fetch: fetcher });
  assert.equal(requests, 1);
  assert.deepEqual(await store.read("openai-codex"), credential);
});

test("sync rejects failure responses without disclosing bodies or retrying", async () => {
  const store = new InMemoryCredentialStore();
  await store.modify("openai-codex", async () => codex());
  for (const status of [302, 401, 500]) {
    let requests = 0;
    await assert.rejects(syncCredential(store, {
      providerId: "openai-codex", coordinatorOrigin: "https://example.com", controlToken: "x".repeat(32),
      fetch: async () => { requests++; return new Response("synthetic-private-server-body", { status }); },
    }), error => error instanceof AuthInputError && !error.message.includes("synthetic-private-server-body"));
    assert.equal(requests, 1);
  }
});
