import { createModels, type Api, type CredentialStore, type Model, type Models, type MutableModels } from "@earendil-works/pi-ai";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { assertAssistantProvider, AuthInputError } from "./credentials.js";

export const DEFAULT_PROVIDER = "openai";
export const DEFAULT_MODEL = "gpt-5.6-sol";

/** Uses Pi's installed catalogs and transports, with subscription OAuth only. */
export function createAssistantModels(credentials: CredentialStore): MutableModels {
  const models = createModels({
    credentials,
    // Never consult an ambient paid API key, key command, or another app's files.
    authContext: { env: async () => undefined, fileExists: async () => false },
  });
  for (const provider of [openaiProvider(), openaiCodexProvider()]) {
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
