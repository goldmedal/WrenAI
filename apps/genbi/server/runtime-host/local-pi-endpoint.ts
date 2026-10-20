import { GATEWAY_API_KEY_ENV } from "../env-detect.js";
import { effectiveTierModel } from "../runtime-binding.js";
import type { RuntimeSettings, TierModelBinding } from "../wire-types.js";

/** The wire APIs the key proxy can serve: one static header credential, one JSON POST endpoint. */
export const LOCAL_PI_APIS = ["anthropic-messages", "openai-completions", "openai-responses"] as const;
export type LocalPiApi = (typeof LOCAL_PI_APIS)[number];

/** Everything the proxy needs to forward for one step. No key value is representable here: only the NAME of the env variable. */
export interface LocalPiRoute {
  readonly api: LocalPiApi;
  /** `origin` plus an optional path prefix, no trailing slash, no credentials, query or fragment. */
  readonly upstream: string;
  readonly credentialEnv: string;
}
export interface LocalPiEndpoint extends LocalPiRoute { readonly model: string }

/** A provider pi cannot be pointed at through the proxy. The message is browser-safe by construction. */
export class LocalPiProviderUnsupported extends Error {
  readonly code = "pi_provider_unsupported" as const;
  constructor() { super("pi_provider_unsupported"); this.name = "LocalPiProviderUnsupported"; }
}
const unsupported = (): never => { throw new LocalPiProviderUnsupported(); };

export type LocalPiCatalog = (provider: string, model: string) => Promise<{ readonly api: string; readonly baseUrl: string } | undefined>;

/** pi-ai's offline built-in catalogue (data only, no network, no credential). `undefined` when the optional package cannot load. */
export const piAiCatalog: LocalPiCatalog = async (provider, model) => {
  try {
    const core = await import("@earendil-works/pi-ai");
    const builtins = await import("@earendil-works/pi-ai/providers/all");
    const models = core.createModels({ credentials: new core.InMemoryCredentialStore(), authContext: { env: async () => undefined, fileExists: async () => false } });
    const builtin = builtins.builtinProviders().find((candidate) => candidate.id === provider);
    if (builtin === undefined || builtin.auth.apiKey === undefined) return undefined;
    models.setProvider({ ...builtin, auth: { apiKey: builtin.auth.apiKey } });
    const found = models.getModel(provider, model);
    return found === undefined ? undefined : { api: String(found.api), baseUrl: found.baseUrl };
  } catch { return undefined; }
};

const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const isApi = (value: string): value is LocalPiApi => (LOCAL_PI_APIS as readonly string[]).includes(value);

/** Canonical upstream: http(s) origin and path prefix; credentials, query and fragment are refused. */
export function canonicalUpstream(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { return unsupported(); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.hostname === "") return unsupported();
  const prefix = url.pathname.replace(/\/+$/, "");
  if (prefix.includes("//") || prefix.split("/").some((part) => part === "." || part === "..") || /%2e|%2f|%5c|\\/i.test(prefix)) return unsupported();
  return `${url.origin}${prefix}`;
}

/** Static table: settings adapter -> pi wire api, default upstream, credential variable. */
const ADAPTERS: Readonly<Record<string, { readonly api: LocalPiApi; readonly upstream?: string; readonly credentialEnv: string }>> = Object.freeze({
  anthropic: { api: "anthropic-messages", upstream: "https://api.anthropic.com", credentialEnv: "ANTHROPIC_API_KEY" },
  openai: { api: "openai-responses", upstream: "https://api.openai.com/v1", credentialEnv: "OPENAI_API_KEY" },
  "openai-compatible": { api: "openai-completions", credentialEnv: "OPENAI_API_KEY" },
});

const nonEmpty = (value: string | undefined) => { const trimmed = value?.trim(); return trimmed ? trimmed : undefined; };

async function endpointFor(binding: TierModelBinding, settings: RuntimeSettings, catalog: LocalPiCatalog): Promise<LocalPiEndpoint> {
  const model = effectiveTierModel(binding, settings);
  if (!model || !MODEL.test(model)) return unsupported();
  if (settings.authMode === "gateway") {
    if ((binding.adapter ?? "pi-ai") !== "pi-ai") return unsupported();
    const provider = nonEmpty(settings.gatewayProvider);
    if (!provider) return unsupported();
    const baseUrl = nonEmpty(binding.baseURL) ?? nonEmpty(settings.gatewayBaseURL);
    // A custom base URL is the OpenAI chat-completions wire, as in the in-process adapter; otherwise the catalogue names api and endpoint.
    if (baseUrl !== undefined) return { api: "openai-completions", upstream: canonicalUpstream(baseUrl), credentialEnv: GATEWAY_API_KEY_ENV, model };
    const found = await catalog(provider, model);
    if (!found || !isApi(found.api)) return unsupported();
    return { api: found.api, upstream: canonicalUpstream(found.baseUrl), credentialEnv: GATEWAY_API_KEY_ENV, model };
  }
  if (settings.authMode !== "byo") return unsupported();
  const adapter = binding.adapter ?? settings.apiKeyAdapter ?? "anthropic";
  const entry = Object.hasOwn(ADAPTERS, adapter) ? ADAPTERS[adapter] : undefined;
  if (!entry) return unsupported();
  const baseUrl = nonEmpty(binding.baseURL) ?? (binding.adapter === undefined ? nonEmpty(settings.apiKeyBaseURL) : undefined);
  // A stray base URL is ignored for the vendor adapters, exactly as the in-process adapters ignore it.
  const upstream = adapter === "openai-compatible" ? (baseUrl ?? unsupported()) : entry.upstream!;
  return { api: entry.api, upstream: canonicalUpstream(upstream), credentialEnv: entry.credentialEnv, model };
}

/**
 * Maps the saved Runtime onto one pi endpoint per compiled tier. Everything the proxy cannot serve (hybrid, a local-model row, a Bedrock-style
 * signed provider, an unknown api, a bad url, a missing catalogue entry, a tier the settings do not cover) is `pi_provider_unsupported`.
 */
export async function resolveLocalPiEndpoints(settings: RuntimeSettings, tiers: readonly string[], catalog: LocalPiCatalog = piAiCatalog): Promise<Readonly<Record<string, LocalPiEndpoint>>> {
  if (settings.hybrid || tiers.length === 0) return unsupported();
  const bound = new Map(settings.tierModels.map((binding) => [binding.tier, binding] as const));
  if (bound.size !== settings.tierModels.length || tiers.some((tier) => !bound.has(tier)) || [...bound.keys()].some((tier) => !tiers.includes(tier))) return unsupported();
  const entries = await Promise.all(tiers.map(async (tier) => [tier, await endpointFor(bound.get(tier)!, settings, catalog)] as const));
  return Object.freeze(Object.fromEntries(entries));
}
