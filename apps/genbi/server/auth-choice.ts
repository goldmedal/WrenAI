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

const RUNTIME_AUTH_MODES: ReadonlySet<string> = new Set(["subscription", "byo", "local", "gateway"]);

/** True for the wire `authMode` values `toAuthChoiceFromRuntimeSettings` can map. */
export function isRuntimeAuthMode(value: unknown): value is RuntimeSettings["authMode"] {
  return typeof value === "string" && RUNTIME_AUTH_MODES.has(value);
}

function stringField(config: Readonly<Record<string, unknown>> | undefined, key: string): string | undefined {
  const value = config?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

/**
 * The inverse of `toAuthChoiceFromRuntimeSettings`, for reporting the auth the BFF booted with
 * (`WREN_HARNESS_MODE` / `MODEL` / `ENDPOINT` / flags) before the user has saved a runtime.
 * Overlays only the auth-selection fields onto `base`; tier rows, deployment and hybrid stay the
 * store's. Credentials never appear in the result. A boot adapter the wizard cannot represent
 * leaves `base` untouched.
 */
export function runtimeSettingsFromAuthChoice(choice: AuthChoice, base: RuntimeSettings): RuntimeSettings {
  switch (choice.mode) {
    case "subscription":
      return { ...base, authMode: "subscription", subscriptionProvider: choice.provider };
    case "local":
      return { ...base, authMode: "local" };
    case "gateway": {
      const provider = stringField(choice.config, "provider");
      const model = stringField(choice.config, "model");
      const baseURL = stringField(choice.config, "baseUrl");
      return {
        ...base,
        authMode: "gateway",
        ...(provider !== undefined ? { gatewayProvider: provider } : {}),
        ...(model !== undefined ? { gatewayModel: model } : {}),
        ...(baseURL !== undefined ? { gatewayBaseURL: baseURL } : {}),
      };
    }
    case "api-key": {
      if (choice.adapter !== "anthropic" && choice.adapter !== "openai-compatible") return base;
      const model = stringField(choice.config, "model");
      const baseURL = choice.adapter === "openai-compatible" ? stringField(choice.config, "baseURL") : undefined;
      return {
        ...base,
        authMode: "byo",
        apiKeyAdapter: choice.adapter,
        ...(model !== undefined ? { apiKeyModel: model } : {}),
        ...(baseURL !== undefined ? { apiKeyBaseURL: baseURL } : {}),
      };
    }
  }
}
