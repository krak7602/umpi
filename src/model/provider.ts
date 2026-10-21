import { createModels, type Api, type CredentialStore, type Model, type Models, type MutableModels } from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { assertAssistantProvider, AuthInputError, isClaudeSubscriptionToken } from "./credentials.js";
import { classifyModelError } from "./failure.js";

export const DEFAULT_PROVIDER = "anthropic";
export const DEFAULT_MODEL = "claude-opus-5-5";

/**
 * The one sanctioned use of an Anthropic API key: while the Claude subscription is at its rate or usage limit.
 * The subscription stays the default; the key bills API credits only for requests made while `active()`.
 */
export interface SubscriptionFallback {
  key(): string | undefined;
  active(): boolean;
  /** A subscription request was refused for a rate or usage limit. */
  limited(): void;
  /** A request is about to bill the API key. */
  used(): void;
}
export function isAnthropicApiKey(value: string): boolean { return /^sk-ant-api\d{2}-[A-Za-z0-9_-]{20,}$/.test(value); }

/** Pi treats a non-OAuth Anthropic token as an API key, which bills API credits instead of the plan. */
function claudeSubscriptionOnly(provider: ReturnType<typeof anthropicProvider>, fallback?: SubscriptionFallback): typeof provider {
  const oauth = provider.auth.oauth;
  if (!oauth) throw new AuthInputError("The installed Anthropic provider has no subscription OAuth flow");
  provider.auth.oauth = {
    ...oauth,
    refresh: async (credential, signal) => {
      const refreshed = await oauth.refresh(credential, signal);
      if (!isClaudeSubscriptionToken(refreshed.access)) throw new AuthInputError("Anthropic refresh did not return a Claude subscription OAuth token");
      return refreshed;
    },
    toAuth: async credential => {
      const key = fallback?.active() ? fallback.key() : undefined;
      if (key && isAnthropicApiKey(key)) { fallback!.used(); return { apiKey: key }; }
      if (!isClaudeSubscriptionToken(credential.access)) throw new AuthInputError("Anthropic requires a Claude subscription OAuth token; API-key billing is disabled");
      return oauth.toAuth(credential);
    },
  };
  if (!fallback) return provider;
  // Pi retries a 429 after a short delay. Marking the limit here lets that retry, in the same turn, use the key.
  const watch = <T extends { result(): Promise<{ stopReason: string; errorMessage?: string }> }>(stream: T, apiKey: string | undefined): T => {
    if (apiKey && isClaudeSubscriptionToken(apiKey)) {
      stream.result().then(message => {
        if (message.stopReason === "error" && classifyModelError(message.errorMessage).kind === "limit") fallback.limited();
      }, () => undefined);
    }
    return stream;
  };
  return {
    ...provider,
    stream: (model, context, options) => watch(provider.stream(model, context, options), options?.apiKey),
    streamSimple: (model, context, options) => watch(provider.streamSimple(model, context, options), options?.apiKey),
  };
}

/** Uses Pi's installed catalogs and transports, with subscription OAuth, plus the optional limit-only API-key fallback. */
export function createAssistantModels(credentials: CredentialStore, fallback?: SubscriptionFallback): MutableModels {
  const models = createModels({
    credentials,
    // Never consult an ambient paid API key, key command, or another app's files.
    authContext: { env: async () => undefined, fileExists: async () => false },
  });
  for (const provider of [claudeSubscriptionOnly(anthropicProvider(), fallback), openaiProvider(), openaiCodexProvider()]) {
    delete provider.auth.apiKey;
    models.setProvider(provider);
  }
  return models;
}

export function selectAssistantModel(
  models: Models,
  providerId: string = DEFAULT_PROVIDER,
  modelId: string = DEFAULT_MODEL,
): Model<Api> {
  assertAssistantProvider(providerId);
  const model = models.getModel(providerId, modelId);
  if (!model) throw new AuthInputError("Model is not present in the installed provider catalog");
  return model;
}
