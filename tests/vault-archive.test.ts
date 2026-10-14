import type { R2Bucket, R2Object } from "@cloudflare/workers-types";
import assert from "node:assert/strict";
import test from "node:test";
import { uploadVaultArchive } from "../src/worker/vault-archive.js";
import { MAX_WORKSPACE_BYTES } from "../src/shared/vault-planning.js";
import { StateError } from "../src/worker/store.js";

// Synthetic R2 receipts exercise archive-consumer behavior, not remote Sync.
test("archive upload consumes exact chunked bytes before its known-length R2 write", async () => {
  let ended = false, next = 0;
  const chunks = [new Uint8Array([1, 2]), new Uint8Array([3]), new Uint8Array([4, 5])];
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (next < chunks.length) controller.enqueue(chunks[next++]!);
      else { ended = true; controller.close(); }
    },
  });
  let storedBytes: Uint8Array | undefined;
  const bucket = {
    async put(_key: string, value: ArrayBuffer) {
      assert.equal(ended, true, "R2 must not start while its archive producer is pending");
      assert.ok(value instanceof ArrayBuffer, "R2 receives a completed known-length value, not another native stream");
      storedBytes = new Uint8Array(value).slice();
      return { size: 5 };
    },
  } as unknown as R2Bucket;
  await uploadVaultArchive(bucket, "synthetic-archive", body, 5);
  assert.deepEqual(storedBytes, new Uint8Array([1, 2, 3, 4, 5]));
});

test("archive bytes remain intact until the actual R2 receipt settles", async () => {
  let resolveStored!: (value: R2Object) => void, resolveEntered!: () => void;
  const stored = new Promise<R2Object>(resolve => { resolveStored = resolve; });
  const entered = new Promise<void>(resolve => { resolveEntered = resolve; });
  let submitted: ArrayBuffer | undefined;
  const bucket = {
    put(_key: string, value: ArrayBuffer) { submitted = value; resolveEntered(); return stored; },
  } as unknown as R2Bucket;
  const uploading = uploadVaultArchive(bucket, "synthetic-archive", new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array([7, 8, 9])); controller.close(); },
  }), 3);
  await entered;
  assert.ok(submitted);
  assert.deepEqual(new Uint8Array(submitted), new Uint8Array([7, 8, 9]));
  resolveStored({ size: 3 } as R2Object);
  await uploading;
  assert.deepEqual(new Uint8Array(submitted), new Uint8Array([0, 0, 0]));
});

test("truncated archive rejects without dispatching a partial R2 object", async () => {
  let writes = 0;
  const bucket = { async put() { writes++; return { size: 3 }; } } as unknown as R2Bucket;
  const body = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array([1, 2])); controller.close(); },
  });
  await assert.rejects(uploadVaultArchive(bucket, "synthetic-archive", body, 3), error => error instanceof StateError && error.status === 503);
  assert.equal(writes, 0);
});

test("overlong archive cancels its producer and never dispatches R2", async () => {
  let writes = 0, cancelled = false, sent = false;
  const bucket = { async put() { writes++; return { size: 3 }; } } as unknown as R2Bucket;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) { if (!sent) { sent = true; controller.enqueue(new Uint8Array([1, 2, 3, 4])); } },
    cancel() { cancelled = true; },
  });
  await assert.rejects(uploadVaultArchive(bucket, "synthetic-archive", body, 3), error => error instanceof StateError && error.status === 413);
  assert.equal(cancelled, true);
  assert.equal(writes, 0);
});

test("archive source failure propagates before any R2 dispatch", async () => {
  const failure = new Error("Synthetic archive producer failure");
  let writes = 0;
  const bucket = { async put() { writes++; return { size: 1 }; } } as unknown as R2Bucket;
  const body = new ReadableStream<Uint8Array>({ start(controller) { controller.error(failure); } });
  await assert.rejects(uploadVaultArchive(bucket, "synthetic-archive", body, 1), error => error === failure);
  assert.equal(writes, 0);
});

test("missing or wrong-size R2 receipts do not confirm archive upload", async () => {
  for (const receipt of [null, { size: 1 }, { size: 3 }]) {
    const bucket = { async put() { return receipt; } } as unknown as R2Bucket;
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array([1, 2])); controller.close(); },
    });
    await assert.rejects(uploadVaultArchive(bucket, "synthetic-archive", body, 2), error => error instanceof StateError && error.status === 503);
  }
});

test("R2 write failure propagates and clears the completed private buffer", async () => {
  const failure = new Error("Synthetic R2 write failure");
  let submitted: ArrayBuffer | undefined;
  const bucket = {
    async put(_key: string, value: ArrayBuffer) { submitted = value; throw failure; },
  } as unknown as R2Bucket;
  const body = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array([1, 2])); controller.close(); },
  });
  await assert.rejects(uploadVaultArchive(bucket, "synthetic-archive", body, 2), error => error === failure);
  assert.ok(submitted);
  assert.deepEqual(new Uint8Array(submitted), new Uint8Array([0, 0]));
});

test("archive declared length must be an exact positive integer within32MiB", async () => {
  let writes = 0;
  const bucket = { async put() { writes++; return { size: 1 }; } } as unknown as R2Bucket;
  for (const length of [0, -1, 1.5, NaN, Infinity, MAX_WORKSPACE_BYTES + 1]) {
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } });
    await assert.rejects(uploadVaultArchive(bucket, "synthetic-archive", body, length), error => error instanceof StateError && error.status === 413);
  }
  assert.equal(writes, 0);
});
