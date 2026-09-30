import { createAgentEventEmitter, enforceCompliance, type RouteOptions } from "../harness/index.js";
import { CodexBackendError, type CodexAppServerBackend, type CodexLaunchPermit } from "./runtime-host/codex-app-server.js";
import { CodexRpcError } from "./runtime-host/codex-rpc.js";
import type { CodexSessionTools } from "./runtime-host/codex-direct-tools.js";
import { structuredQueryEnvelope, analyticalAskPrompt } from "./structured-query-evidence.js";
import { StructuredRuntimeError, type StructuredAdapter, type StructuredScope } from "./structured-runtime.js";

type OpenInput = Omit<Parameters<CodexAppServerBackend["open"]>[1], "onEvent" | "tools"> & { readonly tools: CodexSessionTools };
export interface CodexStructuredProvisioner {
  readonly backend: Pick<CodexAppServerBackend, "prepareLaunch" | "open" | "probe">;
  /** Own partial allocations on failure; use only captured scope and server-resolved credentials. */
  prepare(input: { readonly options: RouteOptions; readonly scope: StructuredScope; readonly permit: CodexLaunchPermit }): Promise<{
    readonly input: OpenInput;
    /** Delete materialization only after process and scoped tools have confirmed close. */
    dispose(): Promise<void>;
  }>;
}

/** Supported direct composition is analysis only; no Setup producer contract is implied. */
export function createCodexStructuredAdapter(provisioner: CodexStructuredProvisioner): StructuredAdapter {
  return {
    vendor: "codex", backend: "codex-app-server",
    async probe() { return (await provisioner.backend.probe()).readiness; },
    async ask(options, scope) {
      if (options.authChoice.mode !== "subscription" || options.authChoice.provider !== "codex"
        || !["answer_query", "generate_dashboard"].includes(options.agentId ?? "answer_query")
        || options.modelsConfig !== undefined || options.tierBinding !== undefined || options.disclosurePolicy !== undefined || options.zoneRoles !== undefined) throw new StructuredRuntimeError("unsupported");
      scope.assertCurrent();
      const { warnings } = enforceCompliance(options.authChoice, { deployment: options.deployment ?? "personal" });
      const permit = provisioner.backend.prepareLaunch();
      let prepared: Awaited<ReturnType<CodexStructuredProvisioner["prepare"]>> | undefined;
      let driver: Awaited<ReturnType<CodexAppServerBackend["open"]>> | undefined;
      const emitter = createAgentEventEmitter(options.onEvent);
      let closing: Promise<void> | undefined;
      let unconfirmedOpenCleanup = false;
      const close = () => closing ??= (async () => {
        const results = await Promise.allSettled([driver?.close(), prepared?.input.tools.close()]);
        if (unconfirmedOpenCleanup || results.some((result) => result.status === "rejected")) throw new StructuredRuntimeError("cleanup");
        await prepared?.dispose();
      })();
      const abort = () => { void close().catch(() => {}); };
      try {
        permit.assertActive(); scope.assertCurrent();
        prepared = await provisioner.prepare({ options, scope, permit });
        scope.assertCurrent(); permit.assertActive(); prepared.input.tools.assertCurrent();
        const hostGuard = prepared.input.assertScopeActive;
        const hostTools = prepared.input.tools;
        const rootResults: unknown[] = [];
        let toolFailed = false;
        const tools: CodexSessionTools = { ...hostTools, async call(...args) {
          try {
            const value = await hostTools.call(...args);
            scope.assertCurrent(); hostTools.assertCurrent();
            rootResults.push(structuredClone(value));
            return value;
          } catch (error) { toolFailed = true; throw error; }
        } };
        driver = await provisioner.backend.open(permit, { ...prepared.input, tools, assertScopeActive: () => { scope.assertCurrent(); hostGuard(); }, onEvent(event) {
          scope.assertCurrent();
          if ((event.method === "item/started" || event.method === "item/completed") && event.params.item.type === "dynamicToolCall") {
            const item = event.params.item;
            if (event.method === "item/started") emitter.emit({ kind: "tool.call", stepId: "analysis", callId: item.id, tool: "component", depth: 0, status: "running" });
            else emitter.emit({ kind: "tool.result", stepId: "analysis", callId: item.id, tool: "component", status: item.success === false || item.status === "failed" ? "error" : "success" });
          }
        } });
        scope.signal?.addEventListener("abort", abort, { once: true });
        scope.assertCurrent();
        emitter.emit({ kind: "run.start", mode: "B", agentId: options.agentId ?? "answer_query" });
        await driver.startThread(); scope.assertCurrent();
        const result = await driver.runTurn(analyticalAskPrompt(options.question, new Date()), { ...(scope.signal ? { signal: scope.signal } : {}), timeoutMs: options.chatTimeoutMs ?? 300_000 });
        scope.assertCurrent(); prepared.input.tools.assertCurrent();
        if (result.status !== "completed") throw new StructuredRuntimeError("failed");
        const finalText = result.items.filter((item) => item.type === "agentMessage").map((item) => item.text).join("\n");
        if (!finalText.trim() || Buffer.byteLength(finalText) > 1_048_576) throw new StructuredRuntimeError("failed");
        const envelope = toolFailed ? undefined : structuredQueryEnvelope(rootResults, finalText);
        await close(); scope.assertCurrent();
        emitter.emit({ kind: "run.finish", status: "answer" });
        return { backend: "codex-app-server", warnings, finalText, ...(envelope ? { envelope } : {}), dataAttempted: toolFailed || rootResults.length > 0 };
      } catch (error) {
        if (error instanceof CodexBackendError && error.code === "codex_app_server_cleanup_failed") unconfirmedOpenCleanup = true;
        try { await close(); } catch { throw new StructuredRuntimeError("cleanup"); }
        throw error instanceof StructuredRuntimeError ? error : new StructuredRuntimeError(scope.signal?.aborted ? "cancelled"
          : error instanceof CodexRpcError && error.reason === "timeout" ? "timeout" : "failed");
      } finally { scope.signal?.removeEventListener("abort", abort); permit.release(); }
    },
  };
}
