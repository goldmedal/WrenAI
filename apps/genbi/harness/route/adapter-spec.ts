import type { AuthChoice } from "../auth/index.js";
import type { AdapterSpec } from "../providers/index.js";
import { OPENAI_COMPATIBLE_ADAPTER_ID, PI_AI_ADAPTER_ID } from "../providers/index.js";

/** Default local endpoint used when a `LocalAuthChoice` omits `endpoint` (Ollama's default OpenAI-compatible port). */
export const DEFAULT_LOCAL_ENDPOINT = "http://localhost:11434/v1";

/**
 * Default local model used when neither `LocalAuthChoice` (which has no
 * `model` field of its own — see the API-surface mismatch note in this
 * ticket's report) nor `InProcessOptions.model` supplies one.
 */
export const DEFAULT_LOCAL_MODEL = "llama3.1";

export interface DeriveAdapterSpecOptions {
  /** Only consulted for `authChoice.mode === "local"`. See `DEFAULT_LOCAL_MODEL`. */
  readonly model?: string;
}

/**
 * Derives a concrete `AdapterSpec` (adapter id + config) for in-process's three
 * `AuthChoice` variants:
 *
 * - `api-key` — passed straight through: `authChoice.adapter`/`config` already
 *   name a `ProviderRegistry` adapter id and its config (70a's `toAuthChoice`
 *   only emits a placeholder `adapter: ""`; a real choice is expected to name
 *   a registered adapter such as `"anthropic"`).
 * - `local` — mapped onto the built-in `openai-compatible` adapter, since
 *   "a model served on the local machine/network" (70a's doc comment) is
 *   exactly what that adapter targets. `endpoint` becomes `baseURL`; `model`
 *   comes from `options.model` (falling back to `DEFAULT_LOCAL_MODEL`) since
 *   `LocalAuthChoice` itself carries no model field.
 * - `gateway` — mapped onto the `pi-ai` adapter, pi-ai's unified client for
 *   an operator-chosen provider (a built-in pi-ai provider id such as
 *   `openrouter` or `amazon-bedrock`, or a custom OpenAI-compatible endpoint
 *   when `baseUrl` is set). `authChoice.config` must carry `provider` and
 *   `model`, and may carry `apiKey`, `baseUrl` and `headers`
 *   (`PiAiAdapterConfig`). `gateway` has no sensible default, so a
 *   missing/empty `provider`/`model` is a loud `wren-harness`-level error here
 *   rather than a failure deep inside the adapter on the first call.
 */
export function deriveAdapterSpec(
  authChoice: Extract<AuthChoice, { mode: "api-key" | "local" | "gateway" }>,
  options: DeriveAdapterSpecOptions = {},
): AdapterSpec {
  switch (authChoice.mode) {
    case "api-key":
      return { adapter: authChoice.adapter, config: authChoice.config ?? {} };
    case "local":
      return {
        adapter: OPENAI_COMPATIBLE_ADAPTER_ID,
        config: {
          baseURL: authChoice.endpoint ?? DEFAULT_LOCAL_ENDPOINT,
          model: options.model ?? DEFAULT_LOCAL_MODEL,
        },
      };
    case "gateway": {
      const config = authChoice.config ?? {};
      const missing: string[] = [];
      if (!isNonEmptyString(config["provider"])) missing.push("provider");
      if (!isNonEmptyString(config["model"])) missing.push("model");
      if (missing.length > 0) {
        throw new Error(
          `gateway mode requires provider and model in config, missing ${missing.join(" and ")} (pass --provider and --model)`,
        );
      }
      return { adapter: PI_AI_ADAPTER_ID, config };
    }
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
