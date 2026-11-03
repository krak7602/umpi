import test from "node:test";
import assert from "node:assert/strict";
import { VaultAgent } from "@obsy/agent";
import { initVault, webEnvironment } from "@obsy/core";
import { R2Storage, type R2BucketLike } from "@obsy/storage-r2";
import { ObsyVaultClient } from "../src/worker/obsy-vault.js";
import { DEFAULT_VAULT_SCOPE, parseVaultApply, vaultNoteRevision } from "../src/shared/vault-planning.js";

const PREFIX = "library/", DAY = "2026-10-21", PATH = `journals/${DAY}.md`;
const TEMPLATE = "# {{date:MMM Do, YYYY}}\n\n## Plan\n";

/** The parts of an R2 binding that R2Storage uses, with R2's conditional-put semantics. */
class FakeR2 implements R2BucketLike {
  readonly objects = new Map<string, { bytes: Uint8Array; etag: string }>();
  private next = 0;
  async get(key: string) {
    const object = this.objects.get(key);
    return object ? { etag: object.etag, arrayBuffer: async () => object.bytes.slice().buffer } : null;
  }
  async put(key: string, value: Uint8Array, options?: { onlyIf?: { etagMatches?: string; etagDoesNotMatch?: string } }) {
    const current = this.objects.get(key);
    if (options?.onlyIf?.etagDoesNotMatch === "*" && current) return null;
    if (options?.onlyIf?.etagMatches !== undefined && current?.etag !== options.onlyIf.etagMatches) return null;
    const etag = `etag-${++this.next}`;
    this.objects.set(key, { bytes: value.slice(), etag });
    return { etag };
  }
  async delete(key: string) { this.objects.delete(key); }
  async list(options: { prefix?: string; startAfter?: string; cursor?: string; limit?: number } = {}) {
    const after = options.cursor ?? options.startAfter ?? "", limit = options.limit ?? 1000;
    const keys = [...this.objects.keys()].filter(key => key.startsWith(options.prefix ?? "") && key > after).sort();
    const page = keys.slice(0, limit), truncated = keys.length > limit;
    return { objects: page.map(key => ({ key })), truncated, ...(truncated ? { cursor: page.at(-1)! } : {}) };
  }
}

async function vault(files: Record<string, string>) {
  const bucket = new FakeR2(), storage = new R2Storage(bucket, { prefix: PREFIX });
  await initVault(storage, webEnvironment());
  const device = new VaultAgent({ storage, env: webEnvironment(), actor: { id: "device" }, presence: { mode: "ignore" } });
  for (const [path, text] of Object.entries(files)) assert.equal((await device.createIfAbsent(path, text)).status, "committed");
  return { bucket, device, client: new ObsyVaultClient(bucket, PREFIX, DEFAULT_VAULT_SCOPE) };
}
const intent = (beforeRevision: string, text: string, expiresAt = new Date(Date.now() + 60_000).toISOString()) =>
  ({ intentId: "intent-1", day: DAY, beforeRevision, text, expiresAt });

test("an obsy snapshot reads the day, the template, and the newest three earlier dated notes", async () => {
  const { client } = await vault({
    "templates/date-template.md": TEMPLATE,
    "journals/2026-10-17.md": "17", "journals/2026-10-18.md": "18", "journals/2026-10-19.md": "19", "journals/2026-10-20.md": "20",
    "journals/2026-10-22.md": "future", "journals/old/2026-10-16.md": "nested", "journals/ideas.md": "undated",
  });
  const snapshot = await client.getSnapshot(DAY);
  assert.equal(snapshot.target, null); assert.equal(snapshot.revision, vaultNoteRevision(null)); assert.equal(snapshot.template, TEMPLATE);
  assert.deepEqual(snapshot.recent.map(note => note.path), ["journals/2026-10-20.md", "journals/2026-10-19.md", "journals/2026-10-18.md"]);
  await assert.rejects((await vault({})).client.getSnapshot(DAY), /template is unavailable/);
});

test("an obsy write commits as agent umpi with the intent as run, and a retried intent is already synced", async () => {
  const { client, device } = await vault({ "templates/date-template.md": TEMPLATE, [PATH]: "# Day\n" });
  const before = await client.getSnapshot(DAY);
  const result = await client.applyNote(intent(before.revision, "# Day\n- plan\n"));
  assert.equal(result.status, "synced"); assert.equal(result.revision, vaultNoteRevision("# Day\n- plan\n"));
  assert.equal((await device.read(PATH))?.text, "# Day\n- plan\n");
  const [latest] = await device.history(PATH, 1);
  const actor = latest!.actor;
  assert.ok(actor.kind === "agent"); assert.deepEqual({ id: actor.id, run: actor.run }, { id: "umpi", run: "intent-1" });
  assert.equal((await client.applyNote(intent(before.revision, "# Day\n- plan\n"))).status, "synced");
  assert.equal((await device.history(PATH)).length, 2);
});

test("an obsy write creates a missing note and never replaces a note changed after planning", async () => {
  const { client, device } = await vault({ "templates/date-template.md": TEMPLATE });
  const empty = await client.getSnapshot(DAY);
  assert.equal((await client.applyNote(intent(empty.revision, "# New\n"))).status, "synced");
  const planned = await client.getSnapshot(DAY);
  const read = (await device.read(PATH))!;
  assert.equal((await device.replaceIfUnchanged(PATH, "# New\n- owner line\n", { baseRev: read.rev })).status, "committed");
  const result = await client.applyNote({ ...intent(planned.revision, "# New\n- plan\n"), intentId: "intent-2" });
  assert.equal(result.status, "conflict"); assert.equal((await device.read(PATH))?.text, "# New\n- owner line\n");
});

test("an expired obsy write is unconfirmed and writes nothing", async () => {
  const { client, device } = await vault({ "templates/date-template.md": TEMPLATE, [PATH]: "# Day\n" });
  const before = await client.getSnapshot(DAY);
  const result = await client.applyNote(intent(before.revision, "# Day\n- late\n", new Date(Date.now() - 1).toISOString()));
  assert.equal(result.status, "unconfirmed"); assert.equal((await device.read(PATH))?.text, "# Day\n");
});

test("the apply contract requires explicit expiry and cannot smuggle a path or command", () => {
  const intent = { intentId: "fixture-intent", day: "2026-10-12", beforeRevision: vaultNoteRevision(null), text: "candidate" };
  assert.throws(() => parseVaultApply(intent));
  assert.throws(() => parseVaultApply({ ...intent, expiresAt: "2026-10-13T00:00:00.000Z", path: "another.md" }));
  assert.throws(() => parseVaultApply({ ...intent, expiresAt: "2026-10-13T00:00:00.000Z", command: "anything" }));
});

test("the app's Today view reads the day's note and ticks one checklist line without touching other edits", async () => {
  const note = "# Nov 3\n\n## Tasks\n- [ ] Buy oats\n- [x] Buy dal\nPlain line\n";
  const { client, device } = await vault({ [PATH]: note });
  const read = await client.readDay(DAY);
  assert.equal(read.text, note); assert.equal(read.revision, vaultNoteRevision(note));
  assert.equal((await client.readDay("2026-10-22")).text, null, "a day without a note");
  const ticked = await client.setTask(DAY, 3, "- [ ] Buy oats", true, "tick-1");
  assert.equal(ticked.status, "synced");
  assert.equal((await device.read(PATH))!.text, note.replace("- [ ] Buy oats", "- [x] Buy oats"));
  // An edit in Obsidian elsewhere in the note survives the next tick.
  const edited = (await device.read(PATH))!;
  assert.equal((await device.replaceIfUnchanged(PATH, edited.text!.replace("Plain line", "Edited on the Mac"), { baseRev: edited.rev })).status, "committed");
  assert.equal((await client.setTask(DAY, 4, "- [x] Buy dal", false, "tick-2")).status, "synced");
  assert.match((await device.read(PATH))!.text!, /- \[ \] Buy dal\nEdited on the Mac/);
  assert.equal((await client.setTask(DAY, 3, "- [ ] Buy oats", false, "tick-3")).status, "conflict", "a line that no longer reads as shown is not changed");
  assert.equal((await client.setTask(DAY, 5, "Edited on the Mac", true, "tick-4")).status, "conflict", "only checklist lines can be ticked");
});

test("a kept reader still sees edits made elsewhere since its last read", async () => {
  const { client, device } = await vault({ [PATH]: "# Day\n- [ ] One\n" });
  assert.equal((await client.readDay(DAY)).text, "# Day\n- [ ] One\n");
  const current = (await device.read(PATH))!;
  assert.equal((await device.replaceIfUnchanged(PATH, "# Day\n- [ ] One\n- [ ] Two\n", { baseRev: current.rev })).status, "committed");
  assert.equal((await client.readDay(DAY)).text, "# Day\n- [ ] One\n- [ ] Two\n", "the next read catches up");
});
