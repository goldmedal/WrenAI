import {
  REASON_FAMILIES,
  type RuntimeReasonFamily,
  RUNTIME_BACKEND_REASON_CODES,
  RUNTIME_CAPABILITIES,
  type RuntimeBackendDiagnostic,
  type RuntimeBackendId,
  type RuntimeBackendNotReady,
  type RuntimeBackendReadiness,
  type RuntimeBackendReasonCode,
  type RuntimeBackendReady,
  type RuntimeCapability,
  type RuntimeReadinessState,
} from "./types.js";

const MESSAGES: Record<RuntimeBackendReasonCode<RuntimeReasonFamily>, string> = {
  pi_not_installed: "pi is not installed for this GenBI release; run genbi-local-pi install.",
  pi_node_unsupported: "The Node.js running this server is older than the minimum pi supports; run GenBI on Node.js 22.19 or newer.",
  pi_provider_unsupported: "The saved Runtime names a provider that the local pi key proxy cannot serve.",
  openshell_unavailable: "The OpenShell lifecycle backend is unavailable.",
  openshell_configuration_invalid: "The OpenShell host configuration is unavailable or invalid.",
  openshell_exclusivity_required: "OpenShell requires an exclusive GenBI gateway, workspace and state owner.",
  openshell_gateway_unavailable: "The configured OpenShell gateway is unavailable or incompatible.",
  openshell_version_mismatch: "The OpenShell version does not match the configured identity.",
  openshell_identity_mismatch: "The OpenShell image, policy or host identity does not match.",
  openshell_protocol_invalid: "OpenShell returned an incomplete or invalid lifecycle response.",
  openshell_scope_invalid: "The OpenShell launch authority is stale, invalid or already used.",
  openshell_cancelled: "The OpenShell operation was cancelled.",
  openshell_journal_failed: "OpenShell ownership state could not be saved or read.",
  openshell_ownership_mismatch: "OpenShell resource ownership could not be verified.",
  openshell_remote_unknown: "The OpenShell remote state is unknown; cleanup reconciliation is required.",
  openshell_cleanup_pending: "OpenShell cleanup is pending; new launch admission is closed.",
  pi_uncertified: "The pi runtime on this OpenShell build has no certified identity row, so it is not enabled.",
  pi_identity_mismatch: "The installed pi image or its policy and profile do not match the certified identity.",
  pi_dependencies_drifted: "pi is certified for other Warble, IR or context-loader versions than this install uses; re-certify pi on the installed versions to enable it.",
  local_runtime_disabled: "The local development runtime is disabled by server policy.",
  local_runtime_host_unavailable: "The local development runtime cannot start a terminal host on this machine.",
  local_runtime_production_forbidden: "The local development runtime is not available in production.",
  runtime_probe_failed: "The runtime readiness probe could not complete.",
  codex_app_server_unprovisioned: "The Codex app-server runtime has not been provisioned by this GenBI release.",
  codex_cli_missing: "The required Codex CLI is not available.",
  codex_cli_version_malformed: "The installed Codex CLI version is invalid.",
  codex_cli_version_unsupported: "The installed Codex CLI version is not supported by this GenBI release.",
  codex_identity_uncertified: "This Codex version has test evidence, but this installed identity is not certified.",
  codex_dependencies_drifted: "Codex native is certified for other Warble, IR or context-loader versions than this install uses; re-certify Codex on the installed versions to enable it.",
  codex_app_server_unreachable: "The Codex app-server runtime is unavailable.",
  codex_app_server_cleanup_failed: "Codex runtime cleanup could not be confirmed. The runtime generation has been retained.",
  codex_app_server_protocol_incompatible: "The Codex app-server protocol is incompatible with this GenBI release.",
  codex_sandbox_policy_unavailable: "The required Codex sandbox policy is unavailable.",
  codex_permission_profile_unavailable: "The required Codex permission profile is unavailable.",
  codex_wren_manifest_missing: "The managed Wren runtime manifest is unavailable.",
  codex_wren_manifest_invalid: "The managed Wren runtime manifest is invalid.",
  codex_wren_platform_unsupported: "The managed Wren runtime does not support this platform.",
  codex_wren_runtime_unprovisioned: "The managed Wren runtime has not been provisioned.",
  codex_wren_provision_failed: "The managed Wren runtime could not be provisioned.",
  codex_wren_interpreter_mismatch: "The managed Wren interpreter identity does not match this GenBI release.",
  codex_wren_launcher_mismatch: "The managed Wren launcher identity does not match this GenBI release.",
  codex_wren_package_mismatch: "The managed Wren package identity does not match this GenBI release.",
  codex_wren_closure_mismatch: "The managed Wren runtime closure does not match this GenBI release.",
  codex_wren_profile_unavailable: "The bound Wren profile is unavailable to this session.",
  codex_wren_secret_unavailable: "A secret required by the bound Wren profile is unavailable.",
  codex_wren_session_home_unavailable: "The private Wren session home is unavailable.",
  codex_wren_child_env_invalid: "The managed Wren child environment is invalid.",
  claude_sandbox_runtime_unprovisioned: "The Claude sandbox runtime has not been provisioned by this GenBI release.",
  claude_cli_missing: "The required Claude CLI is not available.",
  claude_cli_version_malformed: "The installed Claude CLI version is invalid.",
  claude_cli_version_unsupported: "The installed Claude CLI version is not supported by this GenBI release.",
  claude_identity_uncertified: "This Claude runtime version has test evidence, but this installed identity is not certified.",
  claude_sandbox_runtime_missing: "The required Claude sandbox runtime is unavailable.",
  claude_sandbox_runtime_version_malformed: "The installed Claude sandbox runtime version is invalid.",
  claude_sandbox_runtime_version_unsupported: "The installed Claude sandbox runtime version is not supported by this GenBI release.",
  claude_sandbox_capability_missing: "The required Claude sandbox capability is unavailable.",
  runtime_platform_unsupported: "This runtime backend is not supported on this platform.",
  runtime_policy_unavailable: "The runtime policy required by this backend is unavailable.",
};

/** The same code can need different words per family: the OpenShell wording names an image the local runtime does not have. */
const FAMILY_MESSAGES: Partial<Record<RuntimeReasonFamily, Partial<Record<string, string>>>> = {
  "pi-local": {
    pi_uncertified: "The installed pi has no certified identity row for this machine and Node major version, so it is not enabled.",
    pi_identity_mismatch: "The installed pi, its pins or the packaged relay do not match the certified identity.",
    pi_dependencies_drifted: "pi is certified for other Warble, IR or context-loader versions than this install uses; re-certify pi on the installed versions to enable it.",
    runtime_probe_failed: "The local pi readiness probe could not complete.",
  },
};

const SAFE_VERSION = /^(?:[0-9]+(?:\.[0-9]+){1,3}(?:[-+._][A-Za-z0-9][A-Za-z0-9.+_-]{0,95})?|development-local)$/;
const SAFE_IDENTITY = /^sha256:[a-f0-9]{64}$/;

export function isRuntimeReasonCode<B extends RuntimeReasonFamily>(backend: B, code: string): code is RuntimeBackendReasonCode<B> {
  return (REASON_FAMILIES[backend] as readonly string[]).includes(code);
}

export function runtimeNotReady<B extends RuntimeReasonFamily>(
  backend: B,
  state: Exclude<RuntimeReadinessState, "ready">,
  code: RuntimeBackendReasonCode<B>,
): RuntimeBackendNotReady<B> {
  return { state, code, message: FAMILY_MESSAGES[backend]?.[code] ?? MESSAGES[code] };
}

export function runtimeReady(version: string, capabilities: readonly RuntimeCapability[]): RuntimeBackendReady {
  return {
    state: "ready",
    version: SAFE_VERSION.test(version) ? version : "development-local",
    capabilities: capabilities.filter((capability): capability is RuntimeCapability => (RUNTIME_CAPABILITIES as readonly string[]).includes(capability)),
  };
}

/** Rebuild a probe result so server-only probe seams cannot leak custom text. */
export function sanitizeRuntimeReadiness<B extends RuntimeReasonFamily>(backend: B, readiness: RuntimeBackendReadiness<B>): RuntimeBackendReadiness<B> {
  if (readiness.state === "ready") return runtimeReady(readiness.version, readiness.capabilities);
  return isRuntimeReasonCode(backend, readiness.code)
    ? runtimeNotReady(backend, readiness.state, readiness.code)
    : runtimeNotReady(backend, "unavailable", "runtime_probe_failed" as RuntimeBackendReasonCode<B>);
}

/** Keep only parsed support evidence. This return value is never an API DTO. */
export function sanitizeRuntimeDiagnostic(diagnostic: RuntimeBackendDiagnostic): RuntimeBackendDiagnostic {
  return {
    phase: diagnostic.phase,
    ...(diagnostic.observedVersion && SAFE_VERSION.test(diagnostic.observedVersion) ? { observedVersion: diagnostic.observedVersion } : {}),
    ...(diagnostic.requiredCapability && (RUNTIME_CAPABILITIES as readonly string[]).includes(diagnostic.requiredCapability)
      ? { requiredCapability: diagnostic.requiredCapability }
      : {}),
    ...(diagnostic.attestedIdentity && SAFE_IDENTITY.test(diagnostic.attestedIdentity)
      ? { attestedIdentity: diagnostic.attestedIdentity }
      : {}),
  };
}
