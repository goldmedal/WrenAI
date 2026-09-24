import type { LanguageModel } from "ai";
import { UnknownTierError } from "./errors.js";
import type { ProviderRegistry } from "./registry.js";
import type { DisclosurePolicy, Zone, ZoneRoles } from "./zone.js";

/**
 * Names an adapter id + the config to realize it with, plus the deployment
 * zone the realized model runs in. `zone` is a fact about where the endpoint
 * is deployed and who may see private data through it; it is declared by the
 * operator on the binding and never inferred from the endpoint URL, the model
 * id or the adapter kind.
 */
export interface AdapterSpec<Config = unknown> {
  readonly adapter: string;
  readonly config: Config;
  readonly zone?: Zone;
}

/**
 * Runtime-injected tier -> adapter binding. This is a plain object supplied
 * by the caller at run time — it is never read from a bundle and must never
 * be committed to a bundle fixture. `tier` names are open strings owned by
 * the bundle's steps; the binding only needs to cover the tiers a given run
 * actually uses.
 *
 * Keys are either a bare tier name (`strong`), shared by every mount that
 * names that tier, or a mount-qualified `<mount>/<tier>` key
 * (`answer_query/strong`) that wins for that one mount. Resolution is keyed on
 * (mount, tier): the exact mount-qualified key first, then the bare tier. A
 * flat map with no `/` keys is therefore still a complete, valid binding.
 */
export interface TierBinding {
  readonly tiers: Readonly<Record<string, AdapterSpec>>;
  /** The egress disclosure policy the verification step enforces (hybrid split only). */
  readonly disclosurePolicy?: DisclosurePolicy;
  /** Named non-step tiers (judge, render) the zone gate must also check. */
  readonly roles?: ZoneRoles;
}

/** The binding key a `(mount, tier)` pair is looked up under before falling back to the bare tier. */
export function tierBindingKey(mount: string, tier: string): string {
  return `${mount}/${tier}`;
}

/** Splits a binding key into its mount (when qualified) and tier. */
export function parseTierBindingKey(key: string): { readonly mount?: string; readonly tier: string } {
  const slash = key.indexOf("/");
  if (slash <= 0 || slash === key.length - 1) return { tier: key };
  return { mount: key.slice(0, slash), tier: key.slice(slash + 1) };
}

/**
 * Resolves the `AdapterSpec` for a tier as seen from one mount: the exact
 * `<mount>/<tier>` key wins, otherwise the bare tier key. Returns the key that
 * matched so callers (the zone gate, the dry-run) can report which entry
 * actually bound the step.
 */
export function resolveTierSpec(
  binding: TierBinding,
  tier: string,
  mount?: string,
): { readonly key: string; readonly spec: AdapterSpec } | undefined {
  if (mount !== undefined) {
    const qualified = tierBindingKey(mount, tier);
    const exact = binding.tiers[qualified];
    if (exact) return { key: qualified, spec: exact };
  }
  const shared = binding.tiers[tier];
  return shared ? { key: tier, spec: shared } : undefined;
}

/** Resolve an open-string tier name to a concrete language model instance, keyed on (mount, tier). */
export function resolveTierModel(
  binding: TierBinding,
  tier: string,
  registry: ProviderRegistry,
  mount?: string,
): LanguageModel {
  const resolved = resolveTierSpec(binding, tier, mount);
  if (!resolved) {
    throw new UnknownTierError(mount !== undefined ? tierBindingKey(mount, tier) : tier);
  }
  return registry.create(resolved.spec.adapter, resolved.spec.config);
}

/** Convenience: resolve the model for a bundle step via its `tier` field. */
export function resolveStepModel(
  step: { readonly tier: string },
  binding: TierBinding,
  registry: ProviderRegistry,
  mount?: string,
): LanguageModel {
  return resolveTierModel(binding, step.tier, registry, mount);
}

/**
 * Whether a binding carries any zone information at all. A binding with no
 * `zone` on any spec, no disclosure policy and no roles is the pre-existing
 * single-zone binding; the zone gate is armed only for zone-aware bindings.
 */
export function isZoneAwareBinding(binding: TierBinding): boolean {
  return binding.disclosurePolicy !== undefined || binding.roles !== undefined
    || Object.values(binding.tiers).some((spec) => spec.zone !== undefined);
}
