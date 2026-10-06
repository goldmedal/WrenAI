import type { AuthChoice } from "../harness/index.js";
import { GATEWAY_API_KEY_ENV } from "./env-detect.js";
import type { RuntimeSettings } from "./wire-types.js";

/**
 * Maps the wizard's persisted `RuntimeSettings` to the harness-level `AuthChoice` that should
 * actually be dispatched with. `RuntimeSettings.authMode` is the wire/persisted vocabulary
 * (`"subscription" | "byo" | "local" | "gateway"`); `AuthChoice.mode` is the harness vocabulary
 * (`"subscription" | "api-key" | "local" | "gateway"`) — `"byo"` maps to `"api-key"`.
 *
 * For the `openai-compatible` adapter, the BFF reads `OPENAI_API_KEY` from its own process env
 * and injects it explicitly as `config.apiKey` — that adapter has no env self-read of its own.
 * For `anthropic`, `config.apiKey` is deliberately omitted so the adapter self-reads
 * `ANTHROPIC_API_KEY` from the process env itself (see `harness/providers/adapters/anthropic.ts`).
 * For `gateway` (the `pi-ai` adapter), the BFF reads `GENBI_GATEWAY_API_KEY` and injects it as
 * `config.apiKey` the same way — pi-ai never reads env vars or credential files on its own.
 * The key value is never read into `RuntimeSettings`, SQLite, or any log — only referenced here,
 * transiently, to build the in-memory `AuthChoice` passed straight to the adapter factory.
 */
export function toAuthChoiceFromRuntimeSettings(settings: RuntimeSettings): AuthChoice {
  switch (settings.authMode) {
    case "subscription":
      return { mode: "subscription", provider: settings.subscriptionProvider ?? "claude" };
    case "local":
      return { mode: "local" };
    case "gateway": {
      const config: Record<string, unknown> = {};
      if (settings.gatewayProvider !== undefined) config["provider"] = settings.gatewayProvider;
      if (settings.gatewayModel !== undefined) config["model"] = settings.gatewayModel;
      if (settings.gatewayBaseURL?.trim()) config["baseUrl"] = settings.gatewayBaseURL;
      const apiKey = process.env[GATEWAY_API_KEY_ENV];
      if (apiKey?.trim()) config["apiKey"] = apiKey;
      return { mode: "gateway", config };
    }
    case "byo": {
      const adapter = settings.apiKeyAdapter ?? "anthropic";
      if (adapter === "openai-compatible") {
        const config: Record<string, unknown> = { apiKey: process.env["OPENAI_API_KEY"] ?? "" };
        if (settings.apiKeyModel !== undefined) config["model"] = settings.apiKeyModel;
        if (settings.apiKeyBaseURL !== undefined) config["baseURL"] = settings.apiKeyBaseURL;
        return { mode: "api-key", adapter, config };
      }
      const config: Record<string, unknown> = {};
      if (settings.apiKeyModel !== undefined) config["model"] = settings.apiKeyModel;
      return { mode: "api-key", adapter, ...(Object.keys(config).length > 0 ? { config } : {}) };
    }
  }
}
