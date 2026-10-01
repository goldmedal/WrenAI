import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { runtimeNotReady, runtimeReady } from "./policy.js";
import type { RuntimeBackendDiagnostic, RuntimeBackendReadiness } from "./types.js";

export const CODEX_BASELINE_VERSION = "0.156.1";
export const CODEX_REQUIRED_CONTRACTS = [
  "initialize", "config/read", "thread/start", "turn/start", "turn/interrupt",
  "permissionProfile/list", "thread/start.permissions", "turn/start.permissions", "command/exec.permissionProfile",
  "command/exec", "command/exec/write", "command/exec/resize", "command/exec/terminate",
  "protected_read", "shared_temp_isolation", "network_deny", "timeout_cleanup", "connection_cleanup",
  "account/read", "thread/start.dynamicTools", "item/tool/call", "component_step_isolation",
] as const;
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const exactVersion = z.string().regex(/^[0-9]+\.[0-9]+\.[0-9]+$/);
export const codexCertificationSchema = z.object({
  state: z.literal("certified_row"),
  platform: z.literal("darwin-arm64"),
  version: z.literal(CODEX_BASELINE_VERSION),
  executableSha256: digest,
  source: z.string().url().refine((value) => value.startsWith("https://")),
  protocolSha256: digest,
  executionScope: z.object({ models: z.array(z.string().min(1)).min(1), entries: z.array(z.enum(["answer_query", "generate_dashboard"])).min(1) }).strict(),
  contracts: z.array(z.enum(CODEX_REQUIRED_CONTRACTS)).refine((values) =>
    values.length === CODEX_REQUIRED_CONTRACTS.length && new Set(values).size === values.length),
  terminal: z.object({
    transport: z.literal("remote-tui-v1"),
    deterministicProbesSha256: digest,
    packedAcceptanceSha256: digest,
    releaseApprovalSha256: digest,
  }).strict().optional(),
  evidence: z.object({
    deterministicProbesSha256: digest,
    packedAcceptanceSha256: digest,
    releaseApprovalSha256: digest,
  }).strict(),
  /** The component versions the acceptance records were produced with; drift denies the row. */
  dependencies: z.object({ warble: exactVersion, ir: exactVersion, "context-loader": exactVersion }).strict(),
}).strict();
export type CodexCertification = z.infer<typeof codexCertificationSchema>;

// Tested baseline evidence is not a production execution grant. Release
// engineering must add an exact reviewed row, never a minimum-version range.
export const CODEX_CERTIFIED_ROWS: readonly CodexCertification[] = Object.freeze([
{
  "state": "certified_row",
  "platform": "darwin-arm64",
  "version": "0.156.1",
  "executableSha256": "0196e89fe5a7598f816ee54232c3d7c26d75e502ab5cfe2c9240e81d90f7255a",
  "source": "https://registry.npmjs.org/@openai/codex/-/codex-0.156.1-darwin-arm64.tgz",
  "protocolSha256": "655adafa0ccea3d84f30bcbdc74e201fa14511c51e08d0cd024a0280daa8bc60",
  "executionScope": { "models": ["gpt-5.5"], "entries": ["answer_query"] },
  "contracts": [...CODEX_REQUIRED_CONTRACTS],
  "terminal": {"transport": "remote-tui-v1", "deterministicProbesSha256": "9abc4615a9a6020d8d0a2efbeaf36306a48cf3675020e3d43039c6b3505be60f", "packedAcceptanceSha256": "e3a8080db623e4695fba916c1ba4b0da53559ada529de13ba594da7ab5350f71", "releaseApprovalSha256": "322145f63432c3c2751877f30bfc059e7af14af93818c176d50f99182546b0aa"},
  "evidence": {"deterministicProbesSha256": "5ad42e18f831e1688bc76665224c627b3cb25919383717ade7d7107548e1ce90", "packedAcceptanceSha256": "d15692acec5557e41e5b4eed5ced697d5fed5c2aaf8f0c231ac7afca503f7ca0", "releaseApprovalSha256": "c9eb86e98e18fd5ebe6f3f21865facda6bf8b7beb4f2c6f200db9611dbecf88f"},
  "dependencies": {"warble": "0.15.2", "ir": "0.8.0", "context-loader": "0.1.1"}
}
]);
const CODEX_DEPENDENCY_PACKAGES = {
  "@warble/cli": "warble",
  "@warble/codex-local": "warble",
  "@warble/claude-agent-sdk": "warble",
  "@warble/ir-spec": "ir",
  "@wrenai/context-loader": "context-loader",
} as const satisfies Record<string, keyof CodexCertification["dependencies"]>;
export type CodexDependencyPackage = keyof typeof CODEX_DEPENDENCY_PACKAGES;
export type CodexInstalledDependencies = Readonly<Partial<Record<CodexDependencyPackage, string | undefined>>>;

function packageRoot(): string {
  const server = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const parent = path.resolve(server, "..");
  return path.basename(parent) === "dist-server" ? path.resolve(parent, "..") : parent;
}
function declaredPin(name: CodexDependencyPackage): string | undefined {
  try {
    const value = (JSON.parse(readFileSync(path.join(packageRoot(), "package.json"), "utf8")) as { dependencies?: Record<string, unknown> }).dependencies?.[name];
    return typeof value === "string" ? value : undefined;
  } catch { return undefined; }
}

export interface CodexDependencyReaders {
  /** Manifest path, or undefined only when Node cannot resolve the package at all. */
  readonly resolve?: (name: CodexDependencyPackage) => string | undefined;
  readonly read?: (file: string) => string;
  readonly declared?: (name: CodexDependencyPackage) => string | undefined;
}

/**
 * The installed package manifests are authoritative: what Node resolves is what runs, and a
 * consumer's overrides can make it differ from this package's declared pin. Every npm package
 * ships its own package.json and all of these resolve `<name>/package.json`, so a packed install
 * can read them. This package's declared exact pin is the fallback only when a package cannot be
 * resolved at all; a resolved manifest that cannot be read or carries no version is "unreadable"
 * and therefore drifts, as does a dependency found in neither place.
 */
export function installedCodexDependencies({
  resolve = (name) => { try { return createRequire(import.meta.url).resolve(`${name}/package.json`); } catch { return undefined; } },
  read = (file) => readFileSync(file, "utf8"),
  declared = declaredPin,
}: CodexDependencyReaders = {}): CodexInstalledDependencies {
  const installedVersion = (name: CodexDependencyPackage): string | undefined => {
    const manifest = resolve(name);
    if (manifest === undefined) return declared(name);
    try {
      const version = (JSON.parse(read(manifest)) as { version?: unknown }).version;
      return typeof version === "string" ? version : "unreadable";
    } catch { return "unreadable"; }
  };
  return Object.fromEntries((Object.keys(CODEX_DEPENDENCY_PACKAGES) as CodexDependencyPackage[])
    .map((name) => [name, installedVersion(name)]));
}

/** Each entry names one drifted package as `name: certified X, installed Y`. */
export function codexDependencyDrift(certified: CodexCertification["dependencies"], installed: CodexInstalledDependencies): readonly string[] {
  return (Object.entries(CODEX_DEPENDENCY_PACKAGES) as [CodexDependencyPackage, keyof CodexCertification["dependencies"]][])
    .filter(([name, key]) => installed[name] !== certified[key])
    .map(([name, key]) => `${name}: certified ${certified[key]}, installed ${installed[name] ?? "unresolved"}`);
}

/** Host-only diagnostic; `drift` details `codex_dependencies_drifted` and never enters readiness text. */
export type CodexIdentityDiagnostic = RuntimeBackendDiagnostic & { readonly drift?: readonly string[] };
export type CodexIdentityVerdict = { readonly readiness: RuntimeBackendReadiness<"codex-app-server">; readonly diagnostic: CodexIdentityDiagnostic };

export interface CodexObservedIdentity {
  readonly platform: string;
  readonly versionOutput: string;
  readonly executableSha256: string;
  readonly source: string;
  readonly protocolSha256: string;
  readonly contracts: readonly string[];
}

/** Pure comparison for release verification; only the packaged rows grant execution. */
export function evaluateCodexIdentity(
  observed: CodexObservedIdentity,
  rows: readonly unknown[] = CODEX_CERTIFIED_ROWS,
  installed: CodexInstalledDependencies = installedCodexDependencies(),
): CodexIdentityVerdict {
  const deny = (code: Parameters<typeof runtimeNotReady<"codex-app-server">>[2], phase: "platform" | "version" | "identity" | "capability") => ({
    readiness: runtimeNotReady("codex-app-server", "incompatible", code), diagnostic: { phase },
  } as const);
  if (observed.platform !== "darwin-arm64") return deny("runtime_platform_unsupported", "platform");
  const match = /^codex-cli ([0-9]+\.[0-9]+\.[0-9]+)\r?\n?$/.exec(observed.versionOutput);
  if (!match) return deny("codex_cli_version_malformed", "version");
  if (match[1] !== CODEX_BASELINE_VERSION) return deny("codex_cli_version_unsupported", "version");
  const valid = rows.map((row) => codexCertificationSchema.safeParse(row)).filter((row) => row.success).map((row) => row.data!);
  const row = valid.find((candidate) =>
    candidate.executableSha256 === observed.executableSha256 && candidate.source === observed.source);
  if (!row) return deny("codex_identity_uncertified", "identity");
  if (row.protocolSha256 !== observed.protocolSha256) return deny("codex_app_server_protocol_incompatible", "capability");
  if (CODEX_REQUIRED_CONTRACTS.some((name) => !observed.contracts.includes(name))) {
    return deny("codex_sandbox_policy_unavailable", "capability");
  }
  // The row's evidence was accepted with exact component versions; a matching binary running
  // other components is not what was certified, so it stays denied until re-certification.
  const drift = codexDependencyDrift(row.dependencies, installed);
  if (drift.length > 0) {
    const denied = deny("codex_dependencies_drifted", "identity");
    return { ...denied, diagnostic: { ...denied.diagnostic, drift } };
  }
  return {
    readiness: runtimeReady(row.version, ["app_server_rpc", "sandbox_policy", "filesystem_isolation", "network_isolation", "pty", "terminal_resize", "terminal_terminate"]),
    diagnostic: { phase: "capability", observedVersion: row.version },
  };
}

/** Application admission is narrower than the vendor protocol capability probe. */
export function isCodexExecutionCertified(source: string, executableSha256: string, models: readonly string[], entry: string,
  rows: readonly unknown[] = CODEX_CERTIFIED_ROWS): boolean {
  return models.length > 0 && rows.some((value) => {
    const row = codexCertificationSchema.safeParse(value);
    return row.success && row.data.source === source && row.data.executableSha256 === executableSha256
      && row.data.executionScope.entries.some((allowed) => allowed === entry)
      && models.every((model) => row.data.executionScope.models.includes(model));
  });
}

/** A driver certification alone never admits the remote CLI renderer. */
export function isCodexTerminalCertified(source: string, executableSha256: string, models: readonly string[], entry: string,
  rows: readonly unknown[] = CODEX_CERTIFIED_ROWS): boolean {
  return rows.some((value) => {
    const row = codexCertificationSchema.safeParse(value);
    return row.success && row.data.terminal?.transport === "remote-tui-v1"
      && isCodexExecutionCertified(source, executableSha256, models, entry, [row.data]);
  });
}
