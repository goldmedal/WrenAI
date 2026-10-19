/**
 * Closed native-session dispatch contract.  The browser supplies a product
 * purpose only; this module resolves the fixed Warble profile plus the one
 * interactive target selected by the saved Runtime configuration.
 */
import type { InteractiveTarget } from "./interactive-terminal.js";
import type { RuntimeSettings, SubscriptionProvider } from "./wire-types.js";

export const NATIVE_PURPOSES = ["analysis", "setup", "context_enrichment"] as const;
export type NativePurpose = (typeof NATIVE_PURPOSES)[number];
export type NativeVendor = SubscriptionProvider;
/** pi never runs in a host terminal: it exists only as an OpenShell scoped session, so it is a session vendor and not a PTY `NativeVendor`. */
export type NativeScopedVendor = NativeVendor | "pi";
/** Provenance label of a pi scoped session row. Deliberately not an `InteractiveTarget`: the host PTY routes can never accept it. */
export const PI_SCOPED_TARGET = "pi:scoped-events" as const;
export type NativeScopedTarget = typeof PI_SCOPED_TARGET;

export interface NativeDispatchDefinition {
  readonly purpose: NativePurpose;
  readonly profile: "genbi-default" | "genbi-setup" | "genbi-enrich-context";
  readonly scopeKind: "bootstrap" | "bound_project";
}

export const NATIVE_DISPATCH_REGISTRY: Readonly<Record<NativePurpose, NativeDispatchDefinition>> = {
  setup: { purpose: "setup", profile: "genbi-setup", scopeKind: "bootstrap" },
  analysis: { purpose: "analysis", profile: "genbi-default", scopeKind: "bound_project" },
  context_enrichment: { purpose: "context_enrichment", profile: "genbi-enrich-context", scopeKind: "bound_project" },
};

/** Stable, read-only response for a source or compiled-bundle identity mismatch. */
export const HARNESS_PROFILE_IDENTITY_ERROR = "harness profile identity does not match the requested read-only purpose";

/**
 * Every Harness source and emitted bundle must retain the fixed identity for
 * the closed purpose chosen by the BFF. This is deliberately independent of
 * browser input: callers choose a purpose, never a profile authority.
 */
export function assertHarnessPurposeProfile(purpose: NativePurpose, profile: string): void {
  if (profile !== NATIVE_DISPATCH_REGISTRY[purpose].profile) {
    throw new Error(HARNESS_PROFILE_IDENTITY_ERROR);
  }
}

export interface NativeRuntimeBinding {
  readonly configured: boolean;
  readonly generation: number;
  readonly provider?: NativeScopedVendor;
  readonly target?: InteractiveTarget | NativeScopedTarget;
  readonly targetLabel?: "Claude CLI" | "Codex CLI" | "pi";
}

export function targetForProvider(provider: NativeVendor): InteractiveTarget {
  return provider === "claude" ? "claude-code:interactive" : "codex:interactive";
}

export function nativeTargetLabel(provider: NativeVendor): "Claude CLI" | "Codex CLI" {
  return provider === "claude" ? "Claude CLI" : "Codex CLI";
}

/**
 * Explicit marker, not seed/default settings, is the authority. A boot that serves pi as its one scoped vendor (OpenShell + pi) binds an explicit
 * api-key or gateway setting to pi; without that boot fact the result is exactly the subscription-derived binding.
 */
export function resolveNativeRuntimeBinding(settings: RuntimeSettings, explicit: boolean, generation: number, scopedVendor?: "pi"): NativeRuntimeBinding {
  if (scopedVendor === "pi") {
    return explicit && !settings.hybrid && (settings.authMode === "byo" || settings.authMode === "gateway")
      ? { configured: true, generation, provider: "pi", target: PI_SCOPED_TARGET, targetLabel: "pi" }
      : { configured: false, generation };
  }
  if (!explicit || settings.authMode !== "subscription" || (settings.subscriptionProvider !== "claude" && settings.subscriptionProvider !== "codex")) {
    return { configured: false, generation };
  }
  const provider = settings.subscriptionProvider;
  return { configured: true, generation, provider, target: targetForProvider(provider), targetLabel: nativeTargetLabel(provider) };
}

/** A launch may proceed only while the whole captured Runtime authority remains current. */
export function sameNativeRuntimeBinding(left: NativeRuntimeBinding, right: NativeRuntimeBinding): boolean {
  return left.configured === right.configured
    && left.generation === right.generation
    && left.provider === right.provider
    && left.target === right.target
    && left.targetLabel === right.targetLabel;
}

/** The host-terminal target of a binding. pi's scoped target is never one, so a pi binding has none and no PTY route can act on it. */
export function interactiveTargetOf(binding: NativeRuntimeBinding): InteractiveTarget | undefined {
  return binding.target === "claude-code:interactive" || binding.target === "codex:interactive" ? binding.target : undefined;
}

/** Host-terminal dispatch only: a pi binding resolves to nothing here, because pi holds scoped sessions and never a terminal. */
export function dispatchForPurpose(purpose: NativePurpose, binding: NativeRuntimeBinding): NativeDispatchDefinition & { readonly provider: NativeVendor; readonly target: InteractiveTarget; readonly targetLabel: "Claude CLI" | "Codex CLI" } | undefined {
  const target = interactiveTargetOf(binding);
  if (!binding.configured || !binding.provider || binding.provider === "pi" || !target || !binding.targetLabel || binding.targetLabel === "pi") return undefined;
  return { ...NATIVE_DISPATCH_REGISTRY[purpose], provider: binding.provider, target, targetLabel: binding.targetLabel };
}
