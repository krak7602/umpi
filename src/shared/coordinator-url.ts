import { InputError } from "./protocol.ts";

/** Return a credential-safe origin. Plain HTTP is limited to local development. */
export function coordinatorUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new InputError("Invalid coordinator URL");
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new InputError("Use HTTPS for a remote coordinator; HTTP is only allowed on loopback");
  }
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new InputError("Use a coordinator origin without credentials, query, fragment, or path");
  }
  return url;
}
