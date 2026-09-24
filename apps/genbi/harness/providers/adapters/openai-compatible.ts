import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";

export const OPENAI_COMPATIBLE_ADAPTER_ID = "openai-compatible";

// Covers any `/v1` OpenAI-compatible endpoint (vLLM, Ollama's compat API, NIM, ...)
// without depending on a community package for either.
export interface OpenAICompatibleAdapterConfig {
  readonly baseURL: string;
  readonly model: string;
  readonly apiKey?: string;
  /** Provider name reported in telemetry/errors. Defaults to the adapter id. */
  readonly name?: string;
  /**
   * Extra fields merged into every chat-completions request body, for serving
   * runtimes whose switches live in the body rather than in a header or the
   * model id — e.g. Nemotron's reasoning toggle
   * `{ chat_template_kwargs: { enable_thinking: true } }` on NIM/vLLM. Merged
   * deeply over the SDK-built body; a key the SDK also sets is overridden by
   * the operator's value, since the operator declared it on purpose.
   */
  readonly extraBody?: Readonly<Record<string, unknown>>;
  /** Test seam: a fetch replacement so the serialized request can be inspected offline. */
  readonly fetch?: typeof fetch;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Deep-merges `extra` into `base`; arrays and scalars in `extra` replace, objects merge. */
export function mergeRequestBody(base: Record<string, unknown>, extra: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(extra)) {
    const existing = out[key];
    out[key] = isPlainObject(existing) && isPlainObject(value) ? mergeRequestBody(existing, value) : value;
  }
  return out;
}

export function createOpenAICompatibleAdapter(
  config: OpenAICompatibleAdapterConfig,
): LanguageModel {
  const extraBody = config.extraBody;
  const provider = createOpenAICompatible({
    name: config.name ?? OPENAI_COMPATIBLE_ADAPTER_ID,
    baseURL: config.baseURL,
    ...(config.apiKey !== undefined ? { apiKey: config.apiKey } : {}),
    ...(config.fetch !== undefined ? { fetch: config.fetch } : {}),
    ...(extraBody !== undefined && Object.keys(extraBody).length > 0
      ? { transformRequestBody: (body: Record<string, unknown>) => mergeRequestBody(body, extraBody) }
      : {}),
  });
  return provider.languageModel(config.model);
}
