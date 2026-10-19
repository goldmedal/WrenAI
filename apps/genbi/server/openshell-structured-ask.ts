import { structuredTimingForObserver, markStructuredTiming, recordStructuredTimingTimer, recordStructuredTimingAbort } from "./structured-timing.js";
import { observeStructured, observeStructuredAsync, type StructuredDiagnosticObserver } from "./structured-diagnostics.js";
import { isDeepStrictEqual } from "node:util";
import type { ComponentInvocationResult } from "@warble/claude-agent-sdk";
import { createAgentEventEmitter, enforceCompliance, type RouteOptions, type RouteResult } from "../harness/index.js";
import type { ComponentEvent, RunnerHost } from "../harness/components/runner.js";
import type { RuntimeBackendReadiness } from "./runtime-host/types.js";
import { structuredQueryEnvelope } from "./structured-query-evidence.js";
import { StructuredRuntimeError, type EnrichOptions, type EnrichmentValidationRequest, type StructuredAdapter, type StructuredScope } from "./structured-runtime.js";
import { isStructuredQueryFailure } from "./structured-error-feedback.js";
import type { OpenShellModelSession } from "./runtime-host/openshell-model-session.js";
import type { OpenShellIdentity } from "./runtime-host/openshell-types.js";
import { runOpenShellEnrichment } from "./openshell-enrichment.js";
import type { OpenShellEnrichmentValidator } from "./openshell-enrichment-validation.js";

type RootResult = Extract<ComponentInvocationResult, { status: "ok" }>;
type OpenShellResult = Extract<RouteResult, { backend: "openshell" }>;
const results = new WeakMap<object, { readonly snapshot: OpenShellResult; assertCurrent(): void }>();

/** Only a root collected after the governed runner has settled can authorize the BFF answer. */
export function readOpenShellStructuredResult(result: OpenShellResult): OpenShellResult {
  const proof = results.get(result);
  if (!proof || !isDeepStrictEqual(result, proof.snapshot)) throw new StructuredRuntimeError("failed");
  proof.assertCurrent();
  return structuredClone(proof.snapshot);
}

export interface OpenShellPreparedHost {
  assertCurrent(): void;
  /** Actual OpenShell preparation supplies a full executable checkpoint. */
  assertExecutableCurrent?(): void;
  sessionIdentity?(): Extract<OpenShellIdentity, { purpose: "model_session" }>;
  run(request: string): Promise<ComponentInvocationResult>;
  /** Complete all host/worker cleanup before returning an answer. */
  dispose(): Promise<void>;
}
export interface OpenShellEnrichmentPreparation {
  readonly options: EnrichOptions;
  readonly scope: StructuredScope;
  /** One governed stage root; only `draft_enrichment` may carry the proposal sink. */
  readonly stage: "inspect_context" | "draft_enrichment";
  readonly request: string;
  readonly propose?: { readonly component: string; readonly persist: NonNullable<RunnerHost["persistRoot"]> };
  readonly onEvent: (event: ComponentEvent) => void;
}
export interface OpenShellStructuredProvisioner {
  probe(): Promise<RuntimeBackendReadiness>;
  /** Server-owned cleanup proof for one session, never a global idle requirement. */
  assertSessionCleaned?(sessionId: string): void;
  reserveSession?(input: { readonly options: RouteOptions; readonly scope: StructuredScope }): Promise<OpenShellModelSession>;
  prepare(input: { readonly options: RouteOptions; readonly scope: StructuredScope;
    readonly modelSession?: OpenShellModelSession;
    readonly persistRoot: NonNullable<RunnerHost["persistRoot"]>; readonly onEvent: (event: ComponentEvent) => void }): Promise<OpenShellPreparedHost>;
  /** The enrichment purpose has its own admission entry point; `prepare` can never produce an enrichment host. */
  prepareEnrichment?(input: OpenShellEnrichmentPreparation): Promise<OpenShellPreparedHost>;
  /** The operator-approved snapshot file list (the published snapshot's file set), or undefined when no inventory is configured. Prompt hint only. */
  enrichmentApprovedFiles?(): readonly string[] | undefined;
}

/** One server-selected analytical root; final text and vendor artifacts have no answer authority. The vendor is the boot's single model vendor. Enrichment and its validator are Claude-only. */
export function createOpenShellStructuredAdapter(provisioner: OpenShellStructuredProvisioner, diagnostics?: StructuredDiagnosticObserver, vendor: "claude" | "pi" = "claude", validator?: OpenShellEnrichmentValidator): StructuredAdapter {
  return {
    vendor, backend: "openshell", nativeSessions: !!provisioner.reserveSession, probe: () => provisioner.probe(),
    ...(vendor === "claude" && provisioner.prepareEnrichment ? { enrich: (options: EnrichOptions, scope: StructuredScope) => runOpenShellEnrichment(provisioner, options, scope, diagnostics) } : {}),
    ...(vendor === "claude" && validator ? { validateEnrichment: (request: EnrichmentValidationRequest, scope: StructuredScope) => validator.validate(request, scope), enrichmentValidationAvailable: () => validator.available() } : {}),
    async ask(options, scope) {
      const timing = structuredTimingForObserver(diagnostics);
      markStructuredTiming(timing, "adapter_enter");
      observeStructured(diagnostics, "adapter_validation", () => {
      const authorized = vendor === "claude" ? options.authChoice.mode === "subscription" && options.authChoice.provider === "claude"
        : (options.authChoice.mode === "api-key" || options.authChoice.mode === "gateway")
          && options.modelsConfig === undefined && options.model === undefined && options.codexModels === undefined;
      if (!authorized
        || (options.agentId ?? "answer_query") !== "answer_query" || options.tierBinding !== undefined
        || options.disclosurePolicy !== undefined || options.zoneRoles !== undefined || options.mcpServers !== undefined
        || options.bundle !== undefined || options.inProcess !== undefined || options.dispatched !== undefined || options.codexAsk !== undefined)
        throw new StructuredRuntimeError("unsupported");
      });
      const componentTimeoutMs = options.componentLimits?.timeoutMs ?? 120_000;
      const timeoutMs = options.chatTimeoutMs ?? componentTimeoutMs;
      if (!Number.isSafeInteger(componentTimeoutMs) || componentTimeoutMs <= 0 || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new StructuredRuntimeError("unsupported");
      const timeout = new AbortController();
      const signal = AbortSignal.any([timeout.signal, ...(scope.signal ? [scope.signal] : [])]);
      const deadline = Math.min(timeoutMs, componentTimeoutMs, 2_147_483_647);
      recordStructuredTimingTimer(timing, "registering", deadline);
      const timer = setTimeout(() => { recordStructuredTimingTimer(timing, "callback"); recordStructuredTimingAbort(timing, "adapter_timeout"); timeout.abort(); }, deadline);
      recordStructuredTimingTimer(timing, "registered", deadline);
      const timedAbort = () => recordStructuredTimingAbort(timing, timeout.signal.aborted ? "adapter_timeout" : scope.signal?.aborted ? "scope" : "unknown");
      if (signal.aborted) timedAbort(); else signal.addEventListener("abort", timedAbort, { once: true });
      const assertCurrent = () => { signal.throwIfAborted(); scope.assertCurrent(); };
      const guarded = { ...scope, signal, assertCurrent };
      const emitter = createAgentEventEmitter(options.onEvent);
      const { warnings } = enforceCompliance(options.authChoice, { deployment: options.deployment ?? "personal" });
      let prepared: OpenShellPreparedHost | undefined;
      let root: RootResult | undefined;
      let closing: Promise<void> | undefined;
      const close = () => closing ??= observeStructuredAsync(diagnostics, "adapter_cleanup", () => prepared?.dispose() ?? Promise.resolve());
      const abort = () => { void close().catch(() => {}); };
      try {
        assertCurrent();
        markStructuredTiming(timing, "adapter_prepare");
        prepared = await observeStructuredAsync(diagnostics, "adapter_preparation", () => provisioner.prepare({ options, scope: guarded, ...(scope.modelSession ? { modelSession: scope.modelSession } : {}),
          async persistRoot(value, binding, parent) {
            parent.throwIfAborted(); assertCurrent();
            prepared?.assertExecutableCurrent?.();
            if (root || !binding.isCurrent() || !structuredQueryEnvelope([value], "")) throw new StructuredRuntimeError("failed");
            root = structuredClone(value);
          },
          onEvent(event) {
            assertCurrent();
            if (event.kind === "tool.start") emitter.emit({ kind: "tool.call", stepId: event.step ?? "analysis", callId: event.callId ?? event.invocation, tool: event.tool ?? "component", depth: event.depth, status: "running" });
            else if (event.kind === "tool.finish") emitter.emit({ kind: "tool.result", stepId: event.step ?? "analysis", callId: event.callId ?? event.invocation, tool: event.tool ?? "component", status: event.status === "ok" ? "success" : "error" });
          } }));
        markStructuredTiming(timing, "adapter_prepare", "completed");
        signal.addEventListener("abort", abort, { once: true });
        assertCurrent(); prepared.assertCurrent();
        emitter.emit({ kind: "run.start", mode: "B", agentId: "answer_query" });
        markStructuredTiming(timing, "adapter_run");
        const value = await observeStructuredAsync(diagnostics, "adapter_run", () => prepared!.run(options.question));
        assertCurrent(); prepared.assertCurrent();
        const envelope = observeStructured(diagnostics, "adapter_result", () => {
        if (!root || !isDeepStrictEqual(value, root)) throw new StructuredRuntimeError("failed");
        const envelope = structuredQueryEnvelope([root], "");
        if (!envelope) throw new StructuredRuntimeError("failed");
        return envelope;
        });
        await close(); assertCurrent(); prepared.assertCurrent(); prepared.assertExecutableCurrent?.();
        const result: OpenShellResult = { backend: "openshell", warnings, envelope };
        emitter.emit({ kind: "run.finish", status: "answer" });
        assertCurrent(); prepared.assertCurrent(); prepared.assertExecutableCurrent?.();
        results.set(result, { snapshot: structuredClone(result), assertCurrent: () => { assertCurrent(); prepared!.assertCurrent(); prepared!.assertExecutableCurrent?.(); } });
        return result;
      } catch (error) {
        try { await close(); } catch { throw new StructuredRuntimeError("cleanup"); }
        if (isStructuredQueryFailure(error)) {
          if (timeout.signal.aborted) throw new StructuredRuntimeError("timeout");
          if (scope.signal?.aborted) throw new StructuredRuntimeError("cancelled");
          try { scope.assertCurrent(); } catch { throw new StructuredRuntimeError("stale"); }
        }
        throw error instanceof StructuredRuntimeError ? error : new StructuredRuntimeError(timeout.signal.aborted ? "timeout" : scope.signal?.aborted ? "cancelled" : "failed");
      } finally { clearTimeout(timer); recordStructuredTimingTimer(timing, "cleared"); signal.removeEventListener("abort", abort); signal.removeEventListener("abort", timedAbort); }
    },
  };
}
