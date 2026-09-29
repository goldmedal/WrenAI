import type { CodexAppServerBackend, CodexLaunchPermit } from "./runtime-host/codex-app-server.js";
import type { CodexSessionTools } from "./runtime-host/codex-direct-tools.js";
import type { EnrichmentBinding } from "./enrichment.js";
import type { NativeSessionRow } from "./db.js";

/** Server-only provisioner. A ready probe alone never authorizes materialization. */
export interface DirectCodexProvisioner {
  readonly backend: Pick<CodexAppServerBackend, "prepareLaunch" | "open">;
  /** Own and clean partial allocations on failure. Never receives browser paths or credentials. */
  prepare(input: {
    readonly session: NativeSessionRow;
    readonly binding: EnrichmentBinding;
    readonly permit: CodexLaunchPermit;
    readonly signal: AbortSignal;
    readonly assertActive: () => void;
  }): Promise<{
    readonly input: Omit<Parameters<CodexAppServerBackend["open"]>[1], "onEvent" | "tools"> & { readonly tools: CodexSessionTools };
    /** Runs after the conversation and scoped tools have closed. */
    dispose(): Promise<void>;
  }>;
}
