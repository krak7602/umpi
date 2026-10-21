/** Why a model request failed, from the provider's own error text. Code decides the category; no model is involved. */
export type ModelFailureKind = "limit" | "overloaded" | "auth" | "network" | "context" | "other";
export interface ModelFailure { kind: ModelFailureKind; summary: string; detail: string }

const SUMMARIES: Record<ModelFailureKind, string> = {
  limit: "Claude rate or usage limit reached (HTTP 429)",
  overloaded: "Claude was overloaded or had a server error",
  auth: "Claude rejected the sign-in or permission",
  network: "Claude could not be reached over the network",
  context: "The conversation was too long for the model",
  other: "The model request failed",
};

/** Removes anything shaped like a credential before the text is stored or shown. */
export function redactProviderText(text: string): string {
  return text
    .replace(/sk-ant-[A-Za-z0-9_-]+/g, "sk-ant-…")
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 …")
    .replace(/\s+/g, " ").trim().slice(0, 400);
}

export function classifyModelError(message: string | undefined): ModelFailure {
  const text = message ?? "";
  const kind: ModelFailureKind =
    /\b429\b|rate.?limit|usage.?limit|too many requests|quota/i.test(text) ? "limit"
    : /\b401\b|\b403\b|authentication|unauthori[sz]ed|permission|invalid.?(api.?key|token|x-api-key)|oauth/i.test(text) ? "auth"
    : /context|too long|prompt is too long|max.?tokens|overflow/i.test(text) ? "context"
    : /overloaded|\b5\d\d\b|server.?error|internal.?error|service.?unavailable|server_busy/i.test(text) ? "overloaded"
    : /network|fetch failed|connection|ECONN|ENOTFOUND|EAI_AGAIN|socket|timed? ?out|upstream/i.test(text) ? "network"
    : "other";
  return { kind, summary: SUMMARIES[kind], detail: redactProviderText(text) };
}

export function describeModelFailure(failure: ModelFailure): string {
  return failure.detail ? `${failure.summary}: ${failure.detail}` : failure.summary;
}
