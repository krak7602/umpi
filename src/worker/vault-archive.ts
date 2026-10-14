import type { R2Bucket } from "@cloudflare/workers-types";
import { MAX_WORKSPACE_BYTES } from "../shared/vault-planning.js";
import { StateError } from "./store.js";

/** One exact, bounded buffer separates archive consumption from the R2 write.
 * A simultaneous native archive -> FixedLengthStream -> R2 pump stalled in the
 * hosted runtime; a fully consumed private archive and known-length PUT passed.
 */
export async function uploadVaultArchive(
  bucket: R2Bucket, key: string, body: ReadableStream<Uint8Array>, length: number,
): Promise<void> {
  if (!Number.isSafeInteger(length) || length < 1 || length > MAX_WORKSPACE_BYTES) {
    throw new StateError(413, "A bounded exact archive length is required");
  }
  const buffer = new ArrayBuffer(length), bytes = new Uint8Array(buffer);
  let offset = 0;
  try {
    await body.pipeTo(new WritableStream<Uint8Array>({
      write(chunk) {
        if (chunk.byteLength > length - offset) throw new StateError(413, "Private workspace archive exceeded its declared length");
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      },
    }));
    if (offset !== length) throw new StateError(503, "Private workspace archive did not match its declared length");
    const stored = await bucket.put(key, buffer, { httpMetadata: { contentType: "application/gzip" } });
    if (!stored || stored.size !== length) throw new StateError(503, "Private workspace archive was not committed");
  } finally {
    // An R2 deadline/error must never erase bytes while its actual PUT is pending.
    bytes.fill(0);
  }
}
