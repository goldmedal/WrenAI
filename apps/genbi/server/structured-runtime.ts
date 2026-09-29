import { enforceCompliance, type AuthChoice, type RouteOptions, type RouteResult, type SetupStepRunner, type SetupStepRunOptions, type SetupStepRunResult } from "../harness/index.js";
import type { RuntimeBackendReadiness } from "./runtime-host/types.js";

export type StructuredVendor = "codex" | "claude";
export type StructuredBackend = "local" | "codex-app-server" | "claude-sandbox-runtime";
export interface StructuredScope {
  readonly sessionId: string;
  readonly turnId: string;
  readonly signal?: AbortSignal;
  /** Captured host state, rechecked before/after preparation, tools, events and results. */
  assertCurrent(): void;
}
export class StructuredRuntimeError extends Error {
  constructor(readonly code: "unavailable" | "unsupported" | "stale" | "cancelled" | "failed" | "cleanup") {
    super(`Structured runtime ${code}.`);
  }
}
export interface StructuredAdapter {
  readonly vendor: StructuredVendor;
  readonly backend: Exclude<StructuredBackend, "local">;
  probe(): Promise<RuntimeBackendReadiness>;
  ask?(options: RouteOptions, scope: StructuredScope): Promise<RouteResult>;
  setup?(options: SetupStepRunOptions, scope: StructuredScope): Promise<SetupStepRunResult>;
}
interface Options {
  readonly selected: { readonly codex: "local" | "codex-app-server"; readonly claude: "local" | "claude-sandbox-runtime" };
  /** Explicit compatibility opt-in, never proof of vendor sandboxing. */
  readonly allowLocal: boolean;
  readonly deployment?: RouteOptions["deployment"];
  readonly localRoute: (options: RouteOptions) => Promise<RouteResult>;
  readonly localSetupFor: (auth: AuthChoice) => SetupStepRunner | undefined;
  readonly adapters?: Readonly<Partial<Record<StructuredVendor, StructuredAdapter>>>;
}

/** Server composition owns backend choice. No browser paths/configuration select a backend. */
export class StructuredRuntime {
  private readonly options: Options;
  private readonly lifetime = new AbortController();
  private readonly controllers = new Set<AbortController>();
  private readonly active = new Set<Promise<unknown>>();
  private cleanupFailed = false;
  constructor(options: Options) {
    this.options = { ...options, selected: Object.freeze({ ...options.selected }), adapters: Object.freeze({ ...options.adapters }) };
  }
  private adapter(vendor: StructuredVendor): StructuredAdapter | undefined {
    const candidate = this.options.adapters?.[vendor];
    return candidate?.vendor === vendor && candidate.backend === this.options.selected[vendor] ? candidate : undefined;
  }
  async readiness() {
    const entries = await Promise.all((["codex", "claude"] as const).map(async (vendor) => {
      const backend = this.options.selected[vendor];
      const localReady = this.options.allowLocal && !this.lifetime.signal.aborted;
      if (backend === "local") return [vendor, { backend, state: localReady ? "ready" : "unavailable", ask: localReady, setup: localReady && !!this.options.localSetupFor({ mode: "subscription", provider: vendor }), reason: this.options.allowLocal ? "Explicit local execution; vendor isolation is not claimed." : "Local execution is disabled." }] as const;
      const adapter = this.adapter(vendor);
      let probe: RuntimeBackendReadiness | undefined;
      try { probe = await adapter?.probe(); } catch { /* fixed public failure below */ }
      const ready = !this.lifetime.signal.aborted && probe?.state === "ready";
      return [vendor, { backend, state: ready ? "ready" : "unavailable", ask: ready && !!adapter?.ask, setup: ready && !!adapter?.setup,
        reason: !adapter ? "Selected vendor backend is not configured." : !ready ? "Selected vendor backend is not ready." : "Only explicitly supported operations are available.",
        ...(probe && probe.state !== "ready" ? { code: probe.code } : {}) }] as const;
    }));
    return Object.fromEntries(entries);
  }
  async route(options: RouteOptions, scope: StructuredScope): Promise<RouteResult> {
    return this.run(options.authChoice, scope, async (adapter, guarded) => {
      const request = { ...options, signal: guarded.signal!, onEvent: (event: Parameters<NonNullable<RouteOptions["onEvent"]>>[0]) => { guarded.assertCurrent(); options.onEvent?.(event); } };
      if (!adapter) return this.options.localRoute(request);
      if (!adapter.ask) throw new StructuredRuntimeError("unsupported");
      return adapter.ask(request, guarded);
    }, options.deployment);
  }
  async setup(options: SetupStepRunOptions, scope: StructuredScope): Promise<SetupStepRunResult> {
    return this.run(options.authChoice, scope, async (adapter, guarded) => {
      const request = { ...options, signal: guarded.signal!, onEvent: (event: Parameters<NonNullable<SetupStepRunOptions["onEvent"]>>[0]) => { guarded.assertCurrent(); options.onEvent?.(event); } };
      if (!adapter) {
        const runner = this.options.localSetupFor(options.authChoice);
        if (!runner) throw new StructuredRuntimeError("unavailable");
        return runner.run(request);
      }
      if (!adapter.setup || options.resumeSessionId !== undefined) throw new StructuredRuntimeError("unsupported");
      // Isolated runners must not mint legacy provider-resume anchors.
      const result = await adapter.setup(request, guarded);
      return { finalText: result.finalText };
    });
  }
  private run<T>(auth: AuthChoice, scope: StructuredScope, operation: (adapter: StructuredAdapter | undefined, scope: StructuredScope) => Promise<T>, deployment: RouteOptions["deployment"] = "personal"): Promise<T> {
    const controller = new AbortController(); this.controllers.add(controller);
    const signal = AbortSignal.any([controller.signal, this.lifetime.signal, ...(scope.signal ? [scope.signal] : [])]);
    const assertCurrent = () => {
      if (signal.aborted) throw new StructuredRuntimeError("cancelled");
      try { scope.assertCurrent(); } catch { throw new StructuredRuntimeError("stale"); }
    };
    const pending = (async () => {
      assertCurrent(); enforceCompliance(auth, { deployment: this.options.deployment ?? deployment });
      let adapter: StructuredAdapter | undefined;
      if (auth.mode === "subscription" && this.options.selected[auth.provider] !== "local") {
        adapter = this.adapter(auth.provider);
        if (!adapter) throw new StructuredRuntimeError("unavailable");
        let ready: RuntimeBackendReadiness;
        try { ready = await adapter.probe(); } catch { throw new StructuredRuntimeError("unavailable"); }
        assertCurrent();
        if (ready.state !== "ready") throw new StructuredRuntimeError("unavailable");
      } else if (auth.mode === "subscription" && !this.options.allowLocal) throw new StructuredRuntimeError("unavailable");
      let result: T;
      try { result = await operation(adapter, { sessionId: scope.sessionId, turnId: scope.turnId, signal, assertCurrent }); }
      catch (error) {
        if (adapter && !(error instanceof StructuredRuntimeError)) throw new StructuredRuntimeError(signal.aborted ? "cancelled" : "failed");
        throw error;
      }
      assertCurrent(); return result;
    })();
    this.active.add(pending);
    void pending.catch((error) => { if (error instanceof StructuredRuntimeError && error.code === "cleanup") this.cleanupFailed = true; }).finally(() => { this.active.delete(pending); this.controllers.delete(controller); });
    return pending;
  }
  assertActive(): void { if (this.lifetime.signal.aborted) throw new StructuredRuntimeError("cancelled"); }
  revoke(): void { for (const controller of this.controllers) controller.abort(); }
  async shutdown(): Promise<void> {
    this.lifetime.abort();
    await Promise.allSettled([...this.active]);
    if (this.cleanupFailed) throw new StructuredRuntimeError("cleanup");
  }
}
