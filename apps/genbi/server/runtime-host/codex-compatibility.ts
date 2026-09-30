import { z } from "zod";
import { runtimeNotReady, runtimeReady } from "./policy.js";
import type { RuntimeBackendProbeResult } from "./types.js";

export const CODEX_BASELINE_VERSION = "0.156.1";
export const CODEX_REQUIRED_CONTRACTS = [
  "initialize", "config/read", "thread/start", "turn/start", "turn/interrupt",
  "permissionProfile/list", "thread/start.permissions", "turn/start.permissions", "command/exec.permissionProfile",
  "command/exec", "command/exec/write", "command/exec/resize", "command/exec/terminate",
  "protected_read", "shared_temp_isolation", "network_deny", "timeout_cleanup", "connection_cleanup",
  "account/read", "thread/start.dynamicTools", "item/tool/call", "component_step_isolation",
] as const;
const digest = z.string().regex(/^[a-f0-9]{64}$/);
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
  evidence: z.object({
    deterministicProbesSha256: digest,
    packedAcceptanceSha256: digest,
    releaseApprovalSha256: digest,
  }).strict(),
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
  "evidence": {
    "deterministicProbesSha256": "b9e76d5f6f3ddc68dcaf3c78a080d246d3f838f88158a06311876340f412378c",
    "packedAcceptanceSha256": "06969b1568c79b27751c992798a36a115bc905619cb1be5c21d0ea07d324a95d",
    "releaseApprovalSha256": "0a791a18e6a4a10218180a36c7096b029a8696ba5df492b8d6410f3076344b9d"
  }
}
]);
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
): RuntimeBackendProbeResult<"codex-app-server"> {
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
