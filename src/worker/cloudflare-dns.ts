/**
 * DNS names for cloud machines' public addresses, one proxied record each, through the Cloudflare API with a token
 * limited to the owner's zone (Zone Read and DNS Edit). The record's address is a placeholder: Cloudflare's proxy
 * answers, and the Worker route `*-umpi.<zone>/*` sends the request to Umpi.
 */
export interface MachineDns {
  add(hostname: string): Promise<void>;
  remove(hostname: string): Promise<void>;
}

const API = "https://api.cloudflare.com/client/v4";

export function cloudflareDns(token: string, zoneName: string, fetcher: typeof fetch = (input, init) => fetch(input, init)): MachineDns {
  const call = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
    const response = await fetcher(`${API}${path}`, { ...init, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, signal: AbortSignal.timeout(20_000) });
    const body = await response.json().catch(() => ({})) as { success?: boolean; result?: T; errors?: { message?: string }[] };
    if (!response.ok || body.success !== true) throw new Error(`Cloudflare DNS: ${body.errors?.[0]?.message?.slice(0, 200) ?? `HTTP ${response.status}`}`);
    return body.result as T;
  };
  let zone: string | undefined;
  const zoneId = async (): Promise<string> => {
    if (zone) return zone;
    const found = await call<{ id: string }[]>(`/zones?name=${encodeURIComponent(zoneName)}`);
    if (!found[0]?.id) throw new Error("Cloudflare DNS: the token cannot see the zone");
    return zone = found[0].id;
  };
  const records = async (hostname: string) => call<{ id: string }[]>(`/zones/${await zoneId()}/dns_records?name=${encodeURIComponent(hostname)}`);
  return {
    async add(hostname) {
      if ((await records(hostname)).length) return;
      await call(`/zones/${await zoneId()}/dns_records`, { method: "POST", body: JSON.stringify({ type: "AAAA", name: hostname, content: "100::", proxied: true, ttl: 1, comment: "Umpi cloud machine" }) });
    },
    async remove(hostname) {
      for (const record of await records(hostname)) await call(`/zones/${await zoneId()}/dns_records/${record.id}`, { method: "DELETE" });
    },
  };
}
