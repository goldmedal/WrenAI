import { isDeepStrictEqual } from "node:util";
import type { ComponentInvocationResult } from "@warble/claude-agent-sdk";
import { createAgentEventEmitter, enforceCompliance, type RouteOptions, type RouteResult } from "../harness/index.js";
import type { ComponentEvent, RunnerHost } from "../harness/components/runner.js";
import { RUNTIME_BUDGETS_MS } from "../harness/runtime-budgets.js";
import type { RuntimeBackendReadiness, RuntimeReasonFamily } from "./runtime-host/types.js";
import { structuredQueryEnvelope } from "./structured-query-evidence.js";
import { isStructuredQueryFailure } from "./structured-error-feedback.js";
import { StructuredRuntimeError, type StructuredAdapter, type StructuredScope } from "./structured-runtime.js";

type RootResult = Extract<ComponentInvocationResult, { status: "ok" }>;
type LocalPiResult = Extract<RouteResult, { backend: "pi-local" }>;
const results = new WeakMap<object, { readonly snapshot: LocalPiResult; assertCurrent(): void }>();

/** Only a root collected after the governed runner has settled can authorize the BFF answer. */
export function readLocalPiStructuredResult(result: LocalPiResult): LocalPiResult {
  const proof = results.get(result);
  if (!proof || !isDeepStrictEqual(result, proof.snapshot)) throw new StructuredRuntimeError("failed");
  proof.assertCurrent();
  return structuredClone(proof.snapshot);
}

export interface LocalPiPreparedHost {
  assertCurrent(): void;
  assertExecutableCurrent?(): void;
  run(request: string): Promise<ComponentInvocationResult>;
  /** Complete all host and step cleanup before returning an answer. */
  dispose(): Promise<void>;
}
export interface LocalPiStructuredProvisioner {
  probe(): Promise<RuntimeBackendReadiness<RuntimeReasonFamily>>;
  prepare(input: { readonly options: RouteOptions; readonly scope: StructuredScope;
    readonly persistRoot: NonNullable<RunnerHost["persistRoot"]>; readonly onEvent: (event: ComponentEvent) => void }): Promise<LocalPiPreparedHost>;
}

/**
 * One server-selected analytical root served by pi on this machine. As with Codex and pi on OpenShell: the system prompt is the host's, success is
 * judged from events and the governed root, only a verified root is persisted (once), and final text never completes an answer.
 */
export function createLocalPiStructuredAdapter(provisioner: LocalPiStructuredProvisioner): StructuredAdapter {
  return {
    vendor: "pi", backend: "pi-local", probe: () => provisioner.probe(),
    async ask(options, scope) {
      const authorized = (options.authChoice.mode === "api-key" || options.authChoice.mode === "gateway")
        && (options.agentId ?? "answer_query") === "answer_query"
        && options.disclosurePolicy === undefined && options.zoneRoles === undefined && options.mcpServers === undefined
        && options.bundle === undefined && options.inProcess === undefined && options.dispatched === undefined && options.codexAsk === undefined;
      if (!authorized) throw new StructuredRuntimeError("unsupported");
      const componentTimeoutMs = options.componentLimits?.timeoutMs ?? RUNTIME_BUDGETS_MS.defaultComponentTimeout;
      const timeoutMs = options.chatTimeoutMs ?? componentTimeoutMs;
      if (!Number.isSafeInteger(componentTimeoutMs) || componentTimeoutMs <= 0 || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new StructuredRuntimeError("unsupported");
      const timeout = new AbortController();
      const signal = AbortSignal.any([timeout.signal, ...(scope.signal ? [scope.signal] : [])]);
      const timer = setTimeout(() => timeout.abort(), Math.min(timeoutMs, componentTimeoutMs, 2_147_483_647));
      const assertCurrent = () => { signal.throwIfAborted(); scope.assertCurrent(); };
      const guarded = { ...scope, signal, assertCurrent };
      const emitter = createAgentEventEmitter(options.onEvent);
      const { warnings } = enforceCompliance(options.authChoice, { deployment: options.deployment ?? "personal" });
      let prepared: LocalPiPreparedHost | undefined;
      let root: RootResult | undefined;
      let closing: Promise<void> | undefined;
      const close = () => closing ??= prepared?.dispose() ?? Promise.resolve();
      const abort = () => { void close().catch(() => {}); };
      try {
        assertCurrent();
        prepared = await provisioner.prepare({ options, scope: guarded,
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
          } });
        signal.addEventListener("abort", abort, { once: true });
        assertCurrent(); prepared.assertCurrent();
        emitter.emit({ kind: "run.start", mode: "B", agentId: "answer_query" });
        const value = await prepared.run(options.question);
        assertCurrent(); prepared.assertCurrent();
        if (!root || !isDeepStrictEqual(value, root)) throw new StructuredRuntimeError("failed");
        const envelope = structuredQueryEnvelope([root], "");
        if (!envelope) throw new StructuredRuntimeError("failed");
        await close(); assertCurrent(); prepared.assertCurrent(); prepared.assertExecutableCurrent?.();
        const result: LocalPiResult = { backend: "pi-local", warnings, envelope };
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
      } finally { clearTimeout(timer); signal.removeEventListener("abort", abort); }
    },
  };
}
