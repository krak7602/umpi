import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { runMemoryCli } from "../src/cli/core-context.ts";
import { readCoreContext, syncVaultContext, VaultContextError, type VaultSyncOptions } from "../src/cli/vault-context.ts";
import { sourceRevision, type CoreBlock, type CoreContext } from "../src/shared/core-context.ts";

const token = "synthetic-control-token-for-vault-tests-only";
const origin = "https://coordinator.example";

async function block(text = "Earlier synthetic value", overrides: Partial<CoreBlock> = {}): Promise<CoreBlock> {
  return {
    id: "preference", kind: "preferences", text, pendingSource: false,
    source: { path: "Context.md", heading: "Preferences", revision: await sourceRevision(text) },
    ...overrides,
  };
}

function coordinator(initial: CoreContext) {
  const state = { context: structuredClone(initial), gets: 0, puts: 0, conflict: false };
  const fetcher: typeof fetch = async (input, init) => {
    assert.equal(String(input), `${origin}/api/core-context`);
    assert.equal(init?.redirect, "error");
    assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${token}`);
    assert.ok(init?.signal);
    if (init?.method === "GET") {
      state.gets++;
      return Response.json(state.context);
    }
    assert.equal(init?.method, "PUT");
    state.puts++;
    const replacement = JSON.parse(String(init?.body)) as { expectedRevision: number; blocks: CoreBlock[] };
    if (state.conflict) { state.conflict = false; state.context.revision++; }
    if (replacement.expectedRevision !== state.context.revision) return new Response("private synthetic error", { status: 409 });
    for (const item of replacement.blocks) {
      assert.equal(item.pendingSource, false);
      assert.equal(item.source.revision, await sourceRevision(item.text));
    }
    state.context = { revision: state.context.revision + 1, blocks: replacement.blocks };
    return Response.json(state.context);
  };
  return { state, fetcher };
}

async function fixture(initial: CoreContext, markdown?: string) {
  const vault = await mkdtemp(join(tmpdir(), "umpi-vault-test-"));
  if (markdown !== undefined) await writeFile(join(vault, "Context.md"), markdown, { mode: 0o640 });
  const server = coordinator(initial);
  const options: VaultSyncOptions = { coordinatorOrigin: origin, controlToken: token, vault, fetch: server.fetcher };
  return { vault, ...server, options, close: async () => { await rm(vault, { recursive: true, force: true }); } };
}

test("bootstrap requires explicit selectors and expected revision zero without discovering other files", async () => {
  const f = await fixture({ revision: 0, blocks: [] }, "# Preferences\n\nSynthetic preference\n\n# Unselected\nDo not import this synthetic section\n");
  try {
    await writeFile(join(f.vault, "Unselected.md"), "# Background\nUnselected synthetic content\n");
    await assert.rejects(syncVaultContext(f.options), VaultContextError);
    await assert.rejects(syncVaultContext({ ...f.options, sources: ["preference:preferences:Context.md#Preferences"] }), VaultContextError);
    const result = await syncVaultContext({ ...f.options, sources: ["preference:preferences:Context.md#Preferences"], expectedRevision: 0 });
    assert.deepEqual(result, { revision: 1, blocks: 1, characters: 20, pending: 0, added: 1, uploaded: 0, downloaded: 0, removed: 0 });
    assert.equal(f.state.context.blocks[0]!.text, "Synthetic preference");
    assert.deepEqual(await readdir(f.vault), ["Context.md", "Unselected.md"]);
  } finally { await f.close(); }
});

test("remote corrections replace only the mapped section, preserving CRLF, headings, unrelated bytes and permissions", async () => {
  const before = "---\r\ntitle: Synthetic fixture\r\n---\r\n\r\n# Outside\r\nuntouched  \r\n\r\n## Preferences ##\r\n\r\nEarlier synthetic value\r\n\r\n## Next\r\nuntouched next\r\n";
  const pending = await block("Earlier synthetic value");
  pending.text = "Corrected synthetic value\nSecond line";
  pending.pendingSource = true;
  const f = await fixture({ revision: 2, blocks: [pending] }, before);
  try {
    const result = await syncVaultContext(f.options);
    assert.equal(result.downloaded, 1);
    assert.equal(result.pending, 0);
    assert.equal(await readFile(join(f.vault, "Context.md"), "utf8"), before.replace("Earlier synthetic value", "Corrected synthetic value\r\nSecond line"));
    assert.equal((await stat(join(f.vault, "Context.md"))).mode & 0o777, 0o640);
    assert.deepEqual(await readdir(f.vault), ["Context.md"]);
  } finally { await f.close(); }
});

test("local edits upload without rewriting Markdown and unchanged sync is idempotent", async () => {
  const f = await fixture({ revision: 3, blocks: [await block()] }, "# Preferences\n\nA local synthetic edit  \n\n# Next\nUntouched\n");
  try {
    const before = await stat(join(f.vault, "Context.md"), { bigint: true });
    const result = await syncVaultContext(f.options);
    assert.equal(result.uploaded, 1);
    assert.equal(f.state.context.blocks[0]!.text, "A local synthetic edit");
    const repeat = await syncVaultContext(f.options);
    assert.equal(repeat.revision, result.revision);
    assert.equal(repeat.uploaded, 0);
    assert.equal(f.state.puts, 1);
    const after = await stat(join(f.vault, "Context.md"), { bigint: true });
    assert.equal(after.ino, before.ino);
    assert.equal(after.mtimeNs, before.mtimeNs);
  } finally { await f.close(); }
});

test("all divergence conflicts are planned before any local write", async () => {
  const first = await block();
  first.text = "Desired remote correction";
  first.pendingSource = true;
  const second = await block("Original workstream", { id: "workstream", kind: "workstreams" });
  second.source = { path: "Work.md", heading: "Active", revision: await sourceRevision(second.text) };
  second.text = "Remote workstream correction";
  second.pendingSource = true;
  const before = "# Preferences\nEarlier synthetic value\n";
  const f = await fixture({ revision: 3, blocks: [first, second] }, before);
  try {
    await writeFile(join(f.vault, "Work.md"), "# Active\nDifferent local workstream edit\n");
    await assert.rejects(syncVaultContext(f.options), VaultContextError);
    assert.equal(await readFile(join(f.vault, "Context.md"), "utf8"), before);
    assert.equal(f.state.puts, 0);
  } finally { await f.close(); }
});

test("missing source files and headings remove synchronized blocks, but pending corrections conflict", async () => {
  for (const markdown of [undefined, "# Different\nSynthetic text\n"]) {
    const f = await fixture({ revision: 4, blocks: [await block()] }, markdown);
    try {
      const result = await syncVaultContext(f.options);
      assert.equal(result.removed, 1);
      assert.deepEqual(f.state.context.blocks, []);
      assert.equal(f.state.puts, 1);
    } finally { await f.close(); }
    const pending = await block("Synthetic desired value", { pendingSource: true });
    const conflict = await fixture({ revision: 4, blocks: [pending] }, markdown);
    try {
      await assert.rejects(syncVaultContext(conflict.options), VaultContextError);
      assert.equal(conflict.state.puts, 0);
    } finally { await conflict.close(); }
  }
});

test("an explicitly added missing selector fails instead of silently ingesting nothing", async () => {
  const f = await fixture({ revision: 0, blocks: [] }, "# Other\nSynthetic text\n");
  try {
    await assert.rejects(syncVaultContext({ ...f.options, expectedRevision: 0, sources: ["preference:preferences:Context.md#Preferences"] }), VaultContextError);
    assert.equal(f.state.puts, 0);
  } finally { await f.close(); }
});

test("headings inside fences do not delimit sections; subordinate headings belong to their parent", async () => {
  const text = "Synthetic lead\n\n```md\n# Not a boundary\n```\n\n### Child\nSynthetic child\n\n~~~\n## Preferences\n~~~";
  const f = await fixture({ revision: 0, blocks: [] }, `## Preferences\n\n${text}\n\n## Next\nUntouched\n`);
  try {
    await syncVaultContext({ ...f.options, expectedRevision: 0, sources: ["preference:preferences:Context.md#Preferences"] });
    assert.equal(f.state.context.blocks[0]!.text, text);
  } finally { await f.close(); }
});

test("Setext headings use their complete heading lines and matching-level boundaries", async () => {
  const original = "Preferences\n-----------\n\nEarlier synthetic value\n\nNext\n----\nUntouched\n";
  const pending = await block();
  pending.text = "Desired synthetic value";
  pending.pendingSource = true;
  const f = await fixture({ revision: 1, blocks: [pending] }, original);
  try {
    await syncVaultContext(f.options);
    assert.equal(await readFile(join(f.vault, "Context.md"), "utf8"), original.replace("Earlier synthetic value", pending.text));
  } finally { await f.close(); }
});

test("ambiguous duplicate headings and overlapping selections reject before writes", async () => {
  for (const markdown of ["# Preferences\nOne\n# Preferences\nTwo\n", "# Preferences\nOne\n## Preferences\nTwo\n"]) {
    const f = await fixture({ revision: 0, blocks: [] }, markdown);
    try {
      await assert.rejects(syncVaultContext({ ...f.options, expectedRevision: 0, sources: ["preference:preferences:Context.md#Preferences"] }), VaultContextError);
      assert.equal(f.state.puts, 0);
    } finally { await f.close(); }
  }
  const f = await fixture({ revision: 0, blocks: [] }, "# Preferences\nOne\n## Child\nTwo\n");
  try {
    await assert.rejects(syncVaultContext({ ...f.options, expectedRevision: 0, sources: ["preference:preferences:Context.md#Preferences", "child:background:Context.md#Child"] }), VaultContextError);
    assert.equal(f.state.puts, 0);
  } finally { await f.close(); }
});

test("remote corrections cannot inject section boundaries or unclosed fences", async () => {
  for (const replacement of ["New synthetic text\n# Escape\nInjected", "New synthetic text\n## Escape\nInjected", "New synthetic text\n```\nunclosed", "New synthetic text\n~~~\nunclosed"]) {
    const original = "## Preferences\n\nEarlier synthetic value\n\n## Next\nUntouched\n";
    const pending = await block();
    pending.text = replacement;
    pending.pendingSource = true;
    const f = await fixture({ revision: 1, blocks: [pending] }, original);
    try {
      await assert.rejects(syncVaultContext(f.options), VaultContextError);
      assert.equal(await readFile(join(f.vault, "Context.md"), "utf8"), original);
      assert.equal(f.state.puts, 0);
    } finally { await f.close(); }
  }
});

test("multiple disjoint sections in one file are replaced together", async () => {
  const first = await block();
  const second = await block("Original background", { id: "background", kind: "background" });
  second.source.heading = "Background";
  first.text = "Desired preference";
  first.pendingSource = true;
  second.text = "Desired background";
  second.pendingSource = true;
  const original = "## Preferences\n\nEarlier synthetic value\n\n## Background\n\nOriginal background\n\n## Other\nUnchanged\n";
  const f = await fixture({ revision: 1, blocks: [first, second] }, original);
  try {
    const result = await syncVaultContext(f.options);
    assert.equal(result.downloaded, 2);
    assert.equal(await readFile(join(f.vault, "Context.md"), "utf8"), original.replace("Earlier synthetic value", first.text).replace("Original background", second.text));
    assert.deepEqual(await readdir(f.vault), ["Context.md"]);
  } finally { await f.close(); }
});

test("source changes during planning abort the preflight before any replacement", async t => {
  const pending = await block();
  pending.text = "Desired synthetic value";
  pending.pendingSource = true;
  const original = "# Preferences\nEarlier synthetic value\n";
  const f = await fixture({ revision: 2, blocks: [pending] }, original);
  const digest = globalThis.crypto.subtle.digest.bind(globalThis.crypto.subtle);
  let changed = false;
  try {
    t.mock.method(globalThis.crypto.subtle, "digest", async (algorithm: AlgorithmIdentifier, data: BufferSource) => {
      if (!changed) {
        changed = true;
        await writeFile(join(f.vault, "Context.md"), "# Preferences\nConcurrent synthetic edit\n");
      }
      return digest(algorithm, data);
    });
    await assert.rejects(syncVaultContext(f.options), VaultContextError);
    assert.equal(await readFile(join(f.vault, "Context.md"), "utf8"), "# Preferences\nConcurrent synthetic edit\n");
    assert.equal(f.state.puts, 0);
  } finally { t.mock.restoreAll(); await f.close(); }
});

test("remote CAS conflict after local write fails visibly and the next sync acknowledges already-written text", async () => {
  const pending = await block();
  pending.text = "Desired synthetic value";
  pending.pendingSource = true;
  const f = await fixture({ revision: 7, blocks: [pending] }, "# Preferences\nEarlier synthetic value\n");
  try {
    f.state.conflict = true;
    await assert.rejects(syncVaultContext(f.options), VaultContextError);
    assert.equal(f.state.context.revision, 8);
    assert.equal(f.state.context.blocks[0]!.pendingSource, true);
    assert.equal(await readFile(join(f.vault, "Context.md"), "utf8"), "# Preferences\nDesired synthetic value\n");
    const before = await stat(join(f.vault, "Context.md"), { bigint: true });
    const result = await syncVaultContext(f.options);
    assert.equal(result.downloaded, 0);
    assert.equal(result.pending, 0);
    assert.equal(result.revision, 9);
    assert.equal((await stat(join(f.vault, "Context.md"), { bigint: true })).ino, before.ino);
  } finally { await f.close(); }
});

test("explicit stale revisions are rejected before attempting any source read", async () => {
  const server = coordinator({ revision: 5, blocks: [await block()] });
  await assert.rejects(syncVaultContext({ coordinatorOrigin: origin, controlToken: token, fetch: server.fetcher, vault: "/synthetic/nonexistent/vault", expectedRevision: 4 }), VaultContextError);
  assert.equal(server.state.puts, 0);
});

test("source selectors prohibit traversal, absolute paths, hidden directories and non-Markdown ingestion", async () => {
  const f = await fixture({ revision: 0, blocks: [] });
  try {
    for (const path of ["../Outside.md", "/Outside.md", "folder/../../Outside.md", ".obsidian/config.md", "folder/.private/Context.md", "folder\\Context.md", "Context.txt"]) {
      await assert.rejects(syncVaultContext({ ...f.options, expectedRevision: 0, sources: [`preference:preferences:${path}#Preferences`] }), VaultContextError);
    }
    assert.equal(f.state.puts, 0);
  } finally { await f.close(); }
});

test("symlink files and directories cannot read or overwrite outside the vault", async () => {
  const outside = await mkdtemp(join(tmpdir(), "umpi-vault-outside-test-"));
  const pending = await block();
  pending.pendingSource = true;
  pending.text = "Desired synthetic value";
  const f = await fixture({ revision: 1, blocks: [pending] });
  try {
    await writeFile(join(outside, "Context.md"), "# Preferences\nEarlier synthetic value\n");
    await symlink(join(outside, "Context.md"), join(f.vault, "Context.md"));
    await assert.rejects(syncVaultContext(f.options), VaultContextError);
    await rm(join(f.vault, "Context.md"));
    await symlink(outside, join(f.vault, "Linked"));
    f.state.context.blocks[0]!.source.path = "Linked/Context.md";
    await assert.rejects(syncVaultContext(f.options), VaultContextError);
    assert.equal(await readFile(join(outside, "Context.md"), "utf8"), "# Preferences\nEarlier synthetic value\n");
    assert.equal(f.state.puts, 0);
  } finally { await f.close(); await rm(outside, { recursive: true, force: true }); }
});

test("unreadable sources are not interpreted as source removals", { skip: typeof process.getuid === "function" && process.getuid() === 0 }, async () => {
  const f = await fixture({ revision: 1, blocks: [await block()] }, "# Preferences\nEarlier synthetic value\n");
  try {
    await chmod(join(f.vault, "Context.md"), 0);
    await assert.rejects(syncVaultContext(f.options), VaultContextError);
    assert.equal(f.state.puts, 0);
  } finally { await chmod(join(f.vault, "Context.md"), 0o600); await f.close(); }
});

test("document limits are checked before any local replacement", async () => {
  const pending = await block();
  pending.text = "Desired synthetic value";
  pending.pendingSource = true;
  const large = await block("Original", { id: "large", kind: "background" });
  large.source.path = "Large.md";
  const original = "# Preferences\nEarlier synthetic value\n";
  const f = await fixture({ revision: 1, blocks: [pending, large] }, original);
  try {
    await writeFile(join(f.vault, "Large.md"), `# Preferences\n${"x".repeat(6001)}\n`);
    await assert.rejects(syncVaultContext(f.options), VaultContextError);
    assert.equal(await readFile(join(f.vault, "Context.md"), "utf8"), original);
    assert.equal(f.state.puts, 0);
  } finally { await f.close(); }
});

test("insecure URLs and token arguments never reach the network", async () => {
  let calls = 0;
  const fetcher: typeof fetch = async () => { calls++; throw new Error("Must not be called"); };
  for (const url of ["http://remote.example", "ftp://remote.example", "https://user:secret@remote.example", "https://remote.example/private", "https://remote.example/?secret=value"]) {
    await assert.rejects(readCoreContext({ coordinatorOrigin: url, controlToken: token, fetch: fetcher }), VaultContextError);
  }
  await assert.rejects(runMemoryCli(["status", origin, "--token", token], { fetch: fetcher }), error => error instanceof VaultContextError && !error.message.includes(token));
  assert.equal(calls, 0);
});

test("redirects, network errors and response bodies cannot leak secrets", async () => {
  const secret = "synthetic-sensitive-response-content";
  for (const fetcher of [
    (async () => { throw new Error(`${token} ${secret}`); }) as typeof fetch,
    (async () => new Response(`${token} ${secret}`, { status: 302, headers: { location: "https://outside.example" } })) as typeof fetch,
    (async () => new Response(`${token} ${secret}`, { status: 500 })) as typeof fetch,
    (async () => new Response(`${token} ${secret}`, { status: 200 })) as typeof fetch,
    (async () => Response.json({ private: secret })) as typeof fetch,
  ]) {
    await assert.rejects(readCoreContext({ coordinatorOrigin: origin, controlToken: token, fetch: fetcher }), error => {
      assert.ok(error instanceof VaultContextError);
      assert.ok(!error.message.includes(token) && !error.message.includes(secret));
      return true;
    });
  }
});

test("status prints metadata only, never context text, source paths, headings, or token", async () => {
  const item = await block("Synthetic private body");
  item.source.path = "Synthetic-private-file.md";
  item.source.heading = "Synthetic private heading";
  const server = coordinator({ revision: 11, blocks: [item] });
  let output = "";
  await runMemoryCli(["status", origin], { env: { UMPI_CONTROL_TOKEN: token }, fetch: server.fetcher, stdout: text => { output += text; } });
  assert.deepEqual(JSON.parse(output), { revision: 11, blocks: 1, characters: item.text.length, pending: 0 });
  for (const value of [item.text, item.source.path, item.source.heading, token]) assert.ok(!output.includes(value));
});

test("watch enforces its minimum interval and cancellation exits without overlapping work", async () => {
  const f = await fixture({ revision: 1, blocks: [await block()] }, "# Preferences\nEarlier synthetic value\n");
  try {
    await assert.rejects(runMemoryCli(["watch", origin, "--vault", f.vault, "--interval-ms", "1"]), VaultContextError);
    const cancellation = new AbortController();
    let output = "";
    await runMemoryCli(["watch", origin, "--vault", f.vault, "--interval-ms", "5000"], {
      env: { UMPI_CONTROL_TOKEN: token }, fetch: f.fetcher, signal: cancellation.signal,
      stdout: text => { output += text; cancellation.abort(); },
    });
    assert.equal(f.state.gets, 1);
    assert.equal(JSON.parse(output).revision, 1);
  } finally { await f.close(); }
});

test("CLI entry point sanitizes argument parser errors instead of echoing private arguments", () => {
  const result = spawnSync(process.execPath, ["--import", "tsx", resolve("src/cli/core-context.ts"), "sync", origin, "--token", token], { encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.ok(!result.stdout.includes(token));
  assert.ok(!result.stderr.includes(token));
  assert.match(result.stderr, /Tokens must never be passed as arguments/);
});

test("real loopback HTTP rejects redirects before forwarding the control token", async () => {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(request.url ?? "");
    response.writeHead(302, { location: "/credential-sink" });
    response.end("Synthetic response that must not be printed");
  });
  await new Promise<void>(resolve => { server.listen(0, "127.0.0.1", resolve); });
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    await assert.rejects(readCoreContext({ coordinatorOrigin: `http://127.0.0.1:${address.port}`, controlToken: token }), VaultContextError);
    assert.deepEqual(requests, ["/api/core-context"]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => { server.close(error => { if (error) reject(error); else resolve(); }); });
  }
});

test("empty mapped sections can receive a correction and later clear their facts", async () => {
  const pending = await block("");
  pending.pendingSource = true;
  pending.text = "Synthetic replacement";
  const original = "# Preferences\n\n# Other\nUntouched\n";
  const f = await fixture({ revision: 1, blocks: [pending] }, original);
  try {
    await syncVaultContext(f.options);
    assert.equal(await readFile(join(f.vault, "Context.md"), "utf8"), "# Preferences\n\nSynthetic replacement\n# Other\nUntouched\n");
    f.state.context.blocks[0]!.text = "";
    f.state.context.blocks[0]!.pendingSource = true;
    f.state.context.revision++;
    await syncVaultContext(f.options);
    assert.equal(f.state.context.blocks[0]!.text, "");
    assert.equal(f.state.context.blocks[0]!.pendingSource, false);
    assert.ok((await readFile(join(f.vault, "Context.md"), "utf8")).endsWith("# Other\nUntouched\n"));
  } finally { await f.close(); }
});

test("a fully removed document remains empty on later synchronization", async () => {
  const f = await fixture({ revision: 1, blocks: [await block()] });
  try {
    await syncVaultContext(f.options);
    const result = await syncVaultContext(f.options);
    assert.equal(result.blocks, 0);
    assert.equal(result.removed, 0);
    assert.equal(f.state.puts, 1);
    assert.deepEqual(await readdir(f.vault), []);
  } finally { await f.close(); }
});

test("the Obsidian configuration directory cannot bypass source guards by becoming the vault root", async () => {
  const f = await fixture({ revision: 1, blocks: [await block()] });
  try {
    await assert.rejects(syncVaultContext({ ...f.options, vault: join(f.vault, ".obsidian") }), VaultContextError);
    assert.equal(f.state.puts, 0);
  } finally { await f.close(); }
});

test("frontmatter cannot masquerade as a selected source section", async () => {
  const markdown = "---\ntitle: Synthetic fixture\nsummary: |\n  # Preferences\n  Metadata, not the selected context\n---\n\n# Preferences\n\nConfirmed synthetic preference\n";
  const f = await fixture({ revision: 0, blocks: [] }, markdown);
  try {
    await syncVaultContext({ ...f.options, expectedRevision: 0, sources: ["preference:preferences:Context.md#Preferences"] });
    assert.equal(f.state.context.blocks[0]!.text, "Confirmed synthetic preference");
    assert.equal(await readFile(join(f.vault, "Context.md"), "utf8"), markdown);
  } finally { await f.close(); }
});
