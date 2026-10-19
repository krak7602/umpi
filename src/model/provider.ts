import { createModels, type Api, type CredentialStore, type Model, type Models, type MutableModels } from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { assertAssistantProvider, AuthInputError, isClaudeSubscriptionToken } from "./credentials.js";

export const DEFAULT_PROVIDER = "anthropic";
export const DEFAULT_MODEL = "claude-opus-5-5";

/** Pi treats a non-OAuth Anthropic token as an API key, which bills API credits instead of the plan. */
function claudeSubscriptionOnly(provider: ReturnType<typeof anthropicProvider>): typeof provider {
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
      if (!isClaudeSubscriptionToken(credential.access)) throw new AuthInputError("Anthropic requires a Claude subscription OAuth token; API-key billing is disabled");
      return oauth.toAuth(credential);
    },
  };
  return provider;
}

/** Uses Pi's installed catalogs and transports, with subscription OAuth only. */
export function createAssistantModels(credentials: CredentialStore): MutableModels {
  const models = createModels({
    credentials,
    // Never consult an ambient paid API key, key command, or another app's files.
    authContext: { env: async () => undefined, fileExists: async () => false },
  });
  for (const provider of [claudeSubscriptionOnly(anthropicProvider()), openaiProvider(), openaiCodexProvider()]) {
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
