import type { AdapterEnvStatus } from "./wire-types.js";

/**
 * The one credential env var for `"gateway"` mode, whatever pi-ai provider it
 * targets. The BFF reads it and passes it to the adapter per request; pi-ai's
 * own provider env vars are never consulted.
 */
export const GATEWAY_API_KEY_ENV = "GENBI_GATEWAY_API_KEY";

/** True iff the named env var is set to a non-empty (non-whitespace-only) value. */
function isNonEmptyEnv(name: string): boolean {
  const value = process.env[name];
  return value !== undefined && value.trim().length > 0;
}

/**
 * Reports which api-key adapters have their required credential env var present on the BFF
 * process — booleans only. The key values themselves (or any prefix/suffix/length derived
 * from them) must never be exposed to the frontend; this is the only shape `GET
 * /api/config/env-detect` (`server/app.ts`) is allowed to return.
 */
export function detectAdapterEnv(): AdapterEnvStatus {
  return {
    anthropic: isNonEmptyEnv("ANTHROPIC_API_KEY"),
    openaiCompatible: isNonEmptyEnv("OPENAI_API_KEY"),
    gateway: isNonEmptyEnv(GATEWAY_API_KEY_ENV),
  };
}
