import type { CredentialStore } from "@earendil-works/pi-ai";
import { coordinatorUrl } from "../shared/coordinator-url.js";
import { assertAssistantProvider, AuthInputError, parseAssistantCredential } from "./credentials.js";

export interface AuthSyncOptions {
  providerId: string;
  coordinatorOrigin: string;
  controlToken: string | undefined;
  signal?: AbortSignal;
  fetch?: typeof fetch;
}

/** Explicit transfer only: does not login, refresh, retry, or inspect other stores. */
export async function syncCredential(store: CredentialStore, options: AuthSyncOptions): Promise<void> {
  assertAssistantProvider(options.providerId);
  const origin = coordinatorUrl(options.coordinatorOrigin);
  if (!options.controlToken || options.controlToken.length < 32 || /[\u0000-\u0020\u007f]/.test(options.controlToken)) {
    throw new AuthInputError("Set a strong UMPI_CONTROL_TOKEN of at least 32 characters in the environment");
  }
  const signal = options.signal
    ? AbortSignal.any([options.signal, AbortSignal.timeout(30_000)])
    : AbortSignal.timeout(30_000);
  // Keep a local refresh/login from replacing the credential while it is sent.
  await store.modify(options.providerId, async current => {
    if (current === undefined) throw new AuthInputError("No local credential for this provider; run auth login first");
    const credential = parseAssistantCredential(options.providerId, current);
    let response: Response;
    try {
      response = await (options.fetch ?? fetch)(new URL("/api/auth", origin), {
        method: "POST",
        redirect: "error",
        headers: {
          authorization: `Bearer ${options.controlToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ providerId: options.providerId, credential }),
        signal,
      });
    } catch {
      throw new AuthInputError("Auth sync did not return a trusted response. Check coordinator status before retrying; no redirects or automatic retries are allowed");
    }
    await response.body?.cancel();
    if (!response.ok) throw new AuthInputError(`Coordinator rejected auth sync (HTTP ${response.status}); response contents were not displayed`);
    return undefined;
  }, { signal });
}
