import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";

export const OPENAI_ADAPTER_ID = "openai";

// OpenAI's own API. Unlike `openai-compatible`, the key can stay out of the
// binding: when `apiKey` is absent the provider reads OPENAI_API_KEY itself.
export interface OpenAIAdapterConfig {
  readonly model: string;
  readonly apiKey?: string;
}

export function createOpenAIAdapter(config: OpenAIAdapterConfig): LanguageModel {
  const provider = createOpenAI(
    config.apiKey !== undefined ? { apiKey: config.apiKey } : {},
  );
  return provider.languageModel(config.model);
}
