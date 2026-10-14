import type { OAuthCredential } from "@earendil-works/pi-ai";

export const ASSISTANT_PROVIDERS = ["openai", "openai-codex"] as const;
export type AssistantProvider = (typeof ASSISTANT_PROVIDERS)[number];

/** Safe to display; never includes the rejected value or a provider response. */
export class AuthInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthInputError";
  }
}

export function assertAssistantProvider(providerId: string): asserts providerId is AssistantProvider {
  if (!(ASSISTANT_PROVIDERS as readonly string[]).includes(providerId)) {
    throw new AuthInputError("Supported OAuth providers: openai, openai-codex");
  }
}

function text(value: unknown, limit: number): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > limit || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new AuthInputError("Invalid OAuth credential field");
  }
  return value;
}

/** Accept only the fields used by the installed OpenAI OAuth implementations. */
export function parseAssistantCredential(providerId: string, value: unknown): OAuthCredential {
  assertAssistantProvider(providerId);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AuthInputError("Expected an OAuth credential");
  }
  const input = value as Record<string, unknown>;
  if (input.type !== "oauth" || typeof input.expires !== "number" || !Number.isSafeInteger(input.expires) || input.expires <= 0) {
    throw new AuthInputError("Expected an OAuth credential with a millisecond expiry");
  }
  const credential: OAuthCredential = {
    type: "oauth",
    access: text(input.access, 65_536),
    refresh: input.refresh === "" ? "" : text(input.refresh, 65_536),
    expires: input.expires,
  };
  if (providerId === "openai") {
    credential.clientId = text(input.clientId, 1_024);
    if (!Array.isArray(input.scopes) || input.scopes.length > 64 || !input.scopes.includes("chatgpt.tokens.use.direct")) {
      throw new AuthInputError("OpenAI requires a Sign in with ChatGPT grant; Codex credentials cannot be relabeled");
    }
    credential.scopes = input.scopes.map(scope => text(scope, 256));
  } else if (input.accountId !== undefined) {
    credential.accountId = text(input.accountId, 1_024);
  }
  return credential;
}
