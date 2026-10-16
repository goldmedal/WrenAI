import {
  runtimeNotReady,
  runtimeReady,
  sanitizeRuntimeDiagnostic,
  sanitizeRuntimeReadiness,
} from "./policy.js";
import type {
  RuntimeBackendDiagnostic,
  RuntimeBackendId,
  RuntimeBackendProbeResult,
  RuntimeBackendReadiness,
  RuntimeDiagnostics,
  RuntimeReadiness,
} from "./types.js";

export type RuntimeDeployment = "development" | "production";

export interface VendorRuntimeProbes {
  readonly openshell?: () => Promise<RuntimeBackendProbeResult<"openshell">>;
  readonly "codex-app-server"?: () => Promise<RuntimeBackendProbeResult<"codex-app-server">>;
  readonly "claude-sandbox-runtime"?: () => Promise<RuntimeBackendProbeResult<"claude-sandbox-runtime">>;
}

export interface RuntimeHostOptions {
  /** Server-owned selection. Browser input is deliberately absent from this type. */
  readonly selected: RuntimeBackendId | ((vendor?: "codex" | "claude") => RuntimeBackendId);
  readonly deployment: RuntimeDeployment;
  /** Receives the vendor under probe, so a boot that does not offer that vendor locally can say so. */
  readonly localAvailable: (vendor?: "codex" | "claude") => boolean | Promise<boolean>;
  /** Internal test/adaptor seam. Future vendor adapters must supply this server-side. */
  readonly vendorProbes?: VendorRuntimeProbes;
}

const fixedCodexProbe = (): RuntimeBackendProbeResult<"codex-app-server"> => ({
  // Phase 2A has no managed-runtime record/provisioner yet. This is the first
  // blocking link for every Codex launch, even while the development-local
  // PTY host itself is healthy.
  readiness: runtimeNotReady("codex-app-server", "unprovisioned", "codex_wren_runtime_unprovisioned"),
  diagnostic: { phase: "provisioning" },
});

const fixedClaudeProbe = (): RuntimeBackendProbeResult<"claude-sandbox-runtime"> => ({
  readiness: runtimeNotReady("claude-sandbox-runtime", "unprovisioned", "claude_sandbox_runtime_unprovisioned"),
  diagnostic: { phase: "provisioning" },
});

/**
 * Phase 1 read-only runtime boundary. It does not launch vendor processes;
 * production adapters will replace only their own probe seam in later phases.
 */
export class RuntimeHost {
  private diagnostics?: RuntimeDiagnostics;

  constructor(private readonly options: RuntimeHostOptions) {}

  private async probeLocal(vendor?: "codex" | "claude"): Promise<RuntimeBackendProbeResult<"local">> {
    if (this.options.deployment === "production") {
      return {
        readiness: runtimeNotReady("local", "unavailable", "local_runtime_production_forbidden"),
        diagnostic: { phase: "policy" },
      };
    }
    try {
      if (await this.options.localAvailable(vendor)) {
        return {
          readiness: runtimeReady("development-local", ["pty", "terminal_replay", "terminal_resize", "terminal_terminate"]),
          diagnostic: { phase: "capability", requiredCapability: "pty" },
        };
      }
    } catch {
      // The browser gets the same fixed result as a false host probe.
    }
    return {
      readiness: runtimeNotReady("local", "unavailable", "local_runtime_host_unavailable"),
      diagnostic: { phase: "capability", requiredCapability: "pty" },
    };
  }

  private async probeCodex(): Promise<RuntimeBackendProbeResult<"codex-app-server">> {
    try {
      return await (this.options.vendorProbes?.["codex-app-server"]?.() ?? Promise.resolve(fixedCodexProbe()));
    } catch {
      return {
        readiness: runtimeNotReady("codex-app-server", "unavailable", "runtime_probe_failed"),
        diagnostic: { phase: "probe" },
      };
    }
  }

  private async probeClaude(): Promise<RuntimeBackendProbeResult<"claude-sandbox-runtime">> {
    try {
      return await (this.options.vendorProbes?.["claude-sandbox-runtime"]?.() ?? Promise.resolve(fixedClaudeProbe()));
    } catch {
      return {
        readiness: runtimeNotReady("claude-sandbox-runtime", "unavailable", "runtime_probe_failed"),
        diagnostic: { phase: "probe" },
      };
    }
  }

  async probe(vendor?: "codex" | "claude"): Promise<RuntimeReadiness> {
    const [local, codex, claude, openshell] = await Promise.all([
      this.probeLocal(vendor),
      this.probeCodex(),
      this.probeClaude(),
      this.options.vendorProbes?.openshell?.().catch(() => ({ readiness: runtimeNotReady("openshell", "unavailable", "runtime_probe_failed"), diagnostic: { phase: "probe" as const } })) ?? Promise.resolve({ readiness: runtimeNotReady("openshell", "unprovisioned", "openshell_configuration_invalid"), diagnostic: { phase: "provisioning" as const } }),
    ]);
    const backends: Readonly<Record<RuntimeBackendId, RuntimeBackendReadiness>> = {
      openshell: sanitizeRuntimeReadiness("openshell", openshell.readiness),
      local: sanitizeRuntimeReadiness("local", local.readiness),
      "codex-app-server": sanitizeRuntimeReadiness("codex-app-server", codex.readiness),
      "claude-sandbox-runtime": sanitizeRuntimeReadiness("claude-sandbox-runtime", claude.readiness),
    };
    this.diagnostics = {
      openshell: sanitizeRuntimeDiagnostic(openshell.diagnostic),
      local: sanitizeRuntimeDiagnostic(local.diagnostic),
      "codex-app-server": sanitizeRuntimeDiagnostic(codex.diagnostic),
      "claude-sandbox-runtime": sanitizeRuntimeDiagnostic(claude.diagnostic),
    };
    const selected = typeof this.options.selected === "function" ? this.options.selected(vendor) : this.options.selected;
    return { selected, selectedReadiness: backends[selected], backends };
  }

  /** Host-only support evidence; never include this object in an API response. */
  serverDiagnostics(): RuntimeDiagnostics | undefined {
    return this.diagnostics;
  }
}
