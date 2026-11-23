import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { MachineState, RESTORE_FAILED, type HomeState, type MachineBucket, type SavedState } from "../src/worker/cloud-machine-state.js";
import type { CloudMachineStart } from "../src/worker/cloud-machines.js";

const PLACE = "cloud-machines/cloud-0123456789/state.tar.zst";
const FOLDER = "cloud-machines/cloud-0123456789/";
const START = { modelUrl: "https://umpi.example/api/cloud/model", modelToken: "model-token", models: [], defaultModel: "claude-x" } satisfies CloudMachineStart;
const bytes = (text: string) => new TextEncoder().encode(text);
const text = (data: Uint8Array | undefined) => data === undefined ? undefined : new TextDecoder().decode(data);
const sha = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");

/** R2, as far as saved states use it. Like R2, it refuses parts of unequal size. */
function fakeBucket() {
  const objects = new Map<string, Uint8Array>();
  const faults: { part?: number; complete?: boolean; shortHead?: boolean } = {};
  const log: string[] = [];
  const bucket: MachineBucket = {
    async get(key) { const data = objects.get(key); return data ? { body: new Response(data.slice().buffer).body, size: data.byteLength } : null; },
    async head(key) { const data = objects.get(key); return data ? { size: faults.shortHead ? data.byteLength - 1 : data.byteLength } : null; },
    async put(key, value, options) {
      if (options?.sha256) assert.equal(options.sha256, sha(value), "R2 checks the SHA-256 it is given");
      objects.set(key, value); log.push(`put ${key}`);
    },
    async delete(keys) { for (const key of [keys].flat()) { if (objects.delete(key)) log.push(`delete ${key}`); } },
    async list({ prefix }) { return { objects: [...objects.keys()].filter(key => key.startsWith(prefix)).map(key => ({ key })), truncated: false }; },
    async createMultipartUpload(key) {
      const parts = new Map<number, Uint8Array>();
      return {
        async uploadPart(partNumber, value) {
          if (faults.part === partNumber) throw new Error("part upload failed");
          parts.set(partNumber, value);
          return { partNumber, etag: `etag-${partNumber}` };
        },
        async complete(receipts) {
          if (faults.complete) throw new Error("complete failed");
          const sizes = receipts.map(receipt => parts.get(receipt.partNumber)!.byteLength);
          assert.ok(sizes.slice(0, -1).every(size => size === sizes[0]), "every part but the last is the same size");
          const joined = new Uint8Array(sizes.reduce((sum, size) => sum + size, 0));
          let offset = 0;
          for (const receipt of receipts) { joined.set(parts.get(receipt.partNumber)!, offset); offset += parts.get(receipt.partNumber)!.byteLength; }
          objects.set(key, joined); log.push(`complete ${key} parts:${receipts.length}`);
          return { size: joined.byteLength };
        },
        async abort() { log.push(`abort ${key}`); },
      };
    },
  };
  return { bucket, objects, faults, log };
}

/** A container with a home folder: `/restore` fills it, `/snapshot` packs it, `/start` starts T3 Code. */
function fixture(options: { partBytes?: number } = {}) {
  const store = new Map<string, unknown>();
  const r2 = fakeBucket();
  const machine = { running: false, home: undefined as string | undefined, starts: 0, destroyed: 0 };
  const faults: { restore?: string; restoreBytes?: number; start?: string; snapshot?: "fail" | "short" | "wrong-sha" } = {};
  let now = Date.parse("2026-11-20T09:00:00Z");
  const state = new MachineState({
    storage: { async get<T>(key: string) { return store.get(key) as T | undefined; }, async put(key, value) { store.set(key, value); }, async deleteAll() { store.clear(); } },
    container: {
      running: () => machine.running,
      async start() { machine.running = true; machine.home = ""; machine.starts++; },
      async destroy() { machine.running = false; machine.home = undefined; machine.destroyed++; },
      async fetch(request) {
        assert.ok(machine.running, "the control port is asked only while the container runs");
        const path = new URL(request.url).pathname;
        if (path === "/restore") {
          const data = new Uint8Array(await request.arrayBuffer());
          // A failed restore leaves part of the saved home behind.
          if (faults.restore) { machine.home = text(data)!.slice(0, 3); return Response.json({ error: faults.restore }, { status: 500 }); }
          machine.home = text(data);
          return Response.json({ restored: true, bytes: faults.restoreBytes ?? data.byteLength });
        }
        if (path === "/start") return faults.start ? Response.json({ error: faults.start }, { status: 500 }) : Response.json({ token: "mcp-token" });
        if (path === "/snapshot") {
          if (faults.snapshot === "fail") return Response.json({ error: "tar failed" }, { status: 500 });
          const data = bytes(machine.home!);
          return new Response(faults.snapshot === "short" ? data.slice(0, data.byteLength - 2) : data,
            { headers: { "content-length": String(data.byteLength), "x-umpi-sha256": faults.snapshot === "wrong-sha" ? sha(bytes("other")) : sha(data) } });
        }
        return new Response("not found", { status: 404 });
      },
    },
    bucket: () => r2.bucket,
    now: () => now,
    digest: () => { const hash = createHash("sha256"); return { update: chunk => { hash.update(chunk); }, hex: async () => hash.digest("hex") }; },
    ...(options.partBytes ? { partBytes: options.partBytes } : {}),
  });
  const saved = () => store.get("saved") as SavedState | undefined;
  const home = () => store.get("home") as HomeState | undefined;
  return { state, store, r2, machine, faults, saved, home, advance: (ms: number) => { now += ms; } };
}

test("a save writes a new saved state, checks it, makes it current, and only then removes the one before", async () => {
  const { state, r2, machine, saved, advance } = fixture();
  assert.deepEqual(await state.wake(START, PLACE), { token: "mcp-token", restored: false }, "a new machine starts with an empty home");
  machine.home = "first work";
  const first = await state.save();
  assert.equal(first.size, 10);
  assert.match(first.key!, /^cloud-machines\/cloud-0123456789\/state-\d{8}T\d{9}Z-[0-9a-f]{8}\.tar\.zst$/);
  assert.equal(machine.running, false, "saved, so stopped");
  assert.deepEqual(saved(), { key: first.key, size: 10, parts: 1, savedAt: "2026-11-20T09:00:00.000Z", sha256: sha(bytes("first work")) });
  assert.deepEqual([...r2.objects.keys()], [first.key]);

  advance(60_000);
  assert.deepEqual(await state.wake(START, PLACE, { saved: true }), { token: "mcp-token", restored: true });
  assert.equal(machine.home, "first work");
  machine.home = "second work";
  r2.log.length = 0;
  const second = await state.save();
  assert.notEqual(second.key, first.key, "never written over the current saved state");
  assert.deepEqual(r2.log, [`put ${second.key}`, `delete ${first.key}`], "the old one goes after the new one is current");
  assert.equal(text(r2.objects.get(second.key!)), "second work");
});

test("a saved state from before this scheme is restored, and replaced by the first new save", async () => {
  const { state, r2, machine, saved } = fixture();
  r2.objects.set(PLACE, bytes("old home"));
  assert.equal((await state.wake(START, PLACE, { saved: true })).restored, true);
  assert.equal(machine.home, "old home");
  machine.home = "old home, more work";
  const { key } = await state.save();
  assert.deepEqual([...r2.objects.keys()], [key]);
  assert.equal(saved()!.key, key);
});

test("a restore that fails stops the machine, keeps the saved state, and is tried again by the next wake", async () => {
  const { state, r2, machine, faults, home, saved } = fixture();
  await state.wake(START, PLACE); machine.home = "good work"; const { key } = await state.save();
  const before = { ...saved()! };

  faults.restore = "restore failed: unexpected end of data";
  await assert.rejects(state.wake(START, PLACE, { saved: true }), new RegExp(`^Error: ${RESTORE_FAILED}: .*unexpected end of data`));
  assert.equal(machine.running, false, "a machine with part of a home does not run on");
  assert.equal(home()!.state, "incomplete");
  assert.match(home()!.error!, /unexpected end of data/);
  assert.deepEqual(saved(), before);
  assert.equal(text(r2.objects.get(key!)), "good work");

  delete faults.restore;
  assert.equal((await state.wake(START, PLACE, { saved: true })).restored, true, "the next wake restores again");
  assert.equal(machine.home, "good work");
  assert.equal(home()!.state, "complete");
});

test("a home that was not restored in full is never saved, by a request or by the safety net", async () => {
  const { state, store, r2, machine, saved } = fixture();
  await state.wake(START, PLACE); machine.home = "good work"; const { key } = await state.save();
  // The object stopped in the middle of a restore, and the container still runs with part of the home.
  machine.running = true; machine.home = "goo";
  store.set("home", { state: "restoring", at: "2026-11-20T09:01:00.000Z" } satisfies HomeState);
  await assert.rejects(state.save(), /not restored in full/);
  assert.equal(text(r2.objects.get(key!)), "good work");
  assert.equal(await state.expired(), "discarded");
  assert.equal(machine.running, false);
  assert.deepEqual([...r2.objects.keys()], [key]);
  assert.equal(saved()!.key, key);

  // The same container, found by a wake instead: it is stopped and restored again.
  machine.running = true; machine.home = "goo";
  store.set("home", { state: "incomplete", at: "2026-11-20T09:02:00.000Z", error: "cut short" } satisfies HomeState);
  const starts = machine.starts;
  assert.equal((await state.wake(START, PLACE, { saved: true })).restored, true);
  assert.equal(machine.starts, starts + 1);
  assert.equal(machine.home, "good work");
});

test("a restore counts as complete only when every byte arrived", async () => {
  const { state, r2, machine, faults, store } = fixture();
  await state.wake(START, PLACE); machine.home = "good work"; await state.save();
  faults.restoreBytes = 4;
  await assert.rejects(state.wake(START, PLACE, { saved: true }), /the machine received 4 bytes of 9/);
  assert.equal(machine.running, false);
  delete faults.restoreBytes;
  // Storage holds less than was saved.
  const saved = store.get("saved") as SavedState;
  r2.objects.set(saved.key, bytes("good"));
  await assert.rejects(state.wake(START, PLACE, { saved: true }), /storage holds 4 bytes of 9/);
  // Storage holds nothing: a machine that was saved does not start empty.
  r2.objects.clear();
  await assert.rejects(state.wake(START, PLACE, { saved: true }), /it is not in storage/);
  store.delete("saved");
  await assert.rejects(state.wake(START, PLACE, { saved: true }), new RegExp(`${RESTORE_FAILED}: it is not in storage`));
  assert.equal(machine.running, false);
});

test("a save that fails leaves the current saved state as it was, and the machine running with its work", async () => {
  for (const fault of ["fail", "short", "wrong-sha", "head", "part", "complete"] as const) {
    const { state, r2, machine, faults, saved } = fixture({ partBytes: 8 });
    await state.wake(START, PLACE); machine.home = "good work"; const { key } = await state.save();
    const before = { ...saved()! };
    await state.wake(START, PLACE, { saved: true });
    machine.home = "good work and a long afternoon of more";
    if (fault === "head") r2.faults.shortHead = true;
    else if (fault === "part") r2.faults.part = 2;
    else if (fault === "complete") r2.faults.complete = true;
    else faults.snapshot = fault;
    await assert.rejects(state.save(), Error, fault);
    assert.equal(machine.running, true, `${fault}: not stopped unsaved`);
    assert.deepEqual(saved(), before, `${fault}: the current saved state is unchanged`);
    assert.deepEqual([...r2.objects.keys()], [key], `${fault}: nothing is left beside it`);
    assert.equal(text(r2.objects.get(key!)), "good work");
    // The fault passes, and the same machine saves.
    r2.faults.shortHead = false; delete r2.faults.part; delete r2.faults.complete; delete faults.snapshot;
    const next = await state.save();
    assert.equal(text(r2.objects.get(next.key!)), "good work and a long afternoon of more");
    assert.deepEqual([...r2.objects.keys()], [next.key]);
  }
});

test("a large state goes up in equal parts, with a receipt for each and a checksum over all of it", async () => {
  const { state, r2, machine, saved } = fixture({ partBytes: 8 });
  await state.wake(START, PLACE);
  const home = "a home folder of thirty-seven bytes..";
  machine.home = home;
  const { key } = await state.save();
  assert.deepEqual(r2.log, [`complete ${key} parts:5`]);
  assert.deepEqual(saved(), { key, size: 37, parts: 5, savedAt: "2026-11-20T09:00:00.000Z", sha256: sha(bytes(home)) });
  assert.equal(text(r2.objects.get(key!)), home);
});

test("two saves at once are one save; a save of a stopped machine reports what became of its work", async () => {
  const { state, r2, machine, advance } = fixture();
  await state.wake(START, PLACE); machine.home = "work";
  const [one, two] = await Promise.all([state.save(), state.save()]);
  assert.equal(one.key, two.key);
  assert.equal(r2.objects.size, 1);
  // Stopped after that save: the save stands.
  assert.deepEqual(await state.save(), { size: 4, key: one.key, savedAt: one.savedAt });
  // Started again, then gone without a save: what ran since is lost, and the caller is told so.
  advance(1_000);
  await state.wake(START, PLACE, { saved: true });
  machine.running = false;
  assert.deepEqual(await state.save(), { size: 0, lost: true });
});

test("the safety net saves a complete home, and keeps a machine it could not save", async () => {
  const { state, machine, faults, store } = fixture();
  assert.equal(await state.expired(), "stopped");
  await state.wake(START, PLACE); machine.home = "work";
  faults.snapshot = "fail";
  assert.equal(await state.expired(), "kept");
  assert.equal(machine.running, true, "work that could not be saved is not thrown away");
  assert.match((store.get("saveFailure") as { error: string }).error, /could not be packed/);
  delete faults.snapshot;
  assert.equal(await state.expired(), "saved");
  assert.equal(machine.running, false);
});

test("a machine whose T3 Code does not start is stopped when this wake started it, and kept when it ran before", async () => {
  const { state, machine, faults } = fixture();
  faults.start = "T3 Code did not start within two minutes";
  await assert.rejects(state.wake(START, PLACE), /T3 Code did not start/);
  assert.equal(machine.running, false);
  delete faults.start;
  await state.wake(START, PLACE); machine.home = "unsaved work";
  faults.start = "This machine is stopping";
  await assert.rejects(state.wake(START, PLACE), /stopping/);
  assert.equal(machine.running, true);
  assert.equal(machine.home, "unsaved work");
});

test("deleting a machine removes every saved state in its folder and nothing else", async () => {
  const { state, r2, machine, store } = fixture();
  r2.objects.set("cloud-machines/cloud-aaaaaaaaaa/state.tar.zst", bytes("another machine"));
  r2.objects.set(PLACE, bytes("old"));
  r2.objects.set(`${FOLDER}state-left-over.tar.zst`, bytes("left over"));
  await state.wake(START, PLACE, { saved: true }); machine.home = "work"; await state.save();
  await state.wake(START, PLACE, { saved: true });
  await state.discard();
  assert.equal(machine.running, false);
  assert.deepEqual([...r2.objects.keys()], ["cloud-machines/cloud-aaaaaaaaaa/state.tar.zst"]);
  assert.equal(store.size, 0);
});
