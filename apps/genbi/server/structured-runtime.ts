import { observeStructuredAsync, type StructuredDiagnosticObserver } from "./structured-diagnostics.js";
import { enforceCompliance, type AuthChoice, type RouteOptions, type RouteResult, type SetupStepRunner, type SetupStepRunOptions, type SetupStepRunResult } from "../harness/index.js";
import type { RuntimeBackendReadiness } from "./runtime-host/types.js";
import type { OpenShellModelSession } from "./runtime-host/openshell-model-session.js";
import { authOffer, BACKENDS, inProcessAuthOffer, localModeAuthOffer, type BackendName, type RuntimeSelection } from "./runtime-selection.js";

export type StructuredVendor = "codex" | "claude";
export type StructuredBackend = "local" | "codex-app-server" | "claude-sandbox-runtime" | "openshell";
export interface StructuredScope {
  readonly sessionId: string;
  readonly turnId: string;
  readonly signal?: AbortSignal;
  /** Opaque server-owned sandbox capability; never decoded from a browser request. */
  readonly modelSession?: OpenShellModelSession;
  /** Captured host state, rechecked before/after preparation, tools, events and results. */
  assertCurrent(): void;
}
export class StructuredRuntimeError extends Error {
  constructor(readonly code: "unavailable" | "unsupported" | "stale" | "cancelled" | "failed" | "cleanup" | "timeout") {
    super(`Structured runtime ${code}.`);
  }
}
export interface StructuredAdapter {
  readonly vendor: StructuredVendor;
  readonly backend: Exclude<StructuredBackend, "local">;
  readonly nativeSessions?: boolean;
  probe(): Promise<RuntimeBackendReadiness>;
  ask?(options: RouteOptions, scope: StructuredScope): Promise<RouteResult>;
  setup?(options: SetupStepRunOptions, scope: StructuredScope): Promise<SetupStepRunResult>;
}
interface Options {
  readonly diagnostics?: StructuredDiagnosticObserver;
  /** Where agents run and which backends this boot offers; the only source of backend choice. */
  readonly selection: RuntimeSelection;
  readonly onRevoke?: () => void;
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
    this.options = { ...options, adapters: Object.freeze({ ...options.adapters }) };
  }
  /** The backend a vendor runs on, or undefined when this boot does not offer the vendor at all. */
  private backendFor(vendor: StructuredVendor): StructuredBackend | undefined {
    const { selection } = this.options;
    if (!selection.offers[vendor].offered) return undefined;
    if (selection.runtime === "openshell") return "openshell";
    return vendor === "codex" && selection.codexMode === "app-server" ? "codex-app-server" : "local";
  }
  private adapter(vendor: StructuredVendor): StructuredAdapter | undefined {
    const candidate = this.options.adapters?.[vendor];
    return candidate?.vendor === vendor && candidate.backend === this.backendFor(vendor) ? candidate : undefined;
  }
  /** Pure gate used before operation-owned durable writes. */
  assertOperationSupported(auth: AuthChoice, operation: "ask" | "setup" | "native"): void {
    this.assertActive();
    if (!authOffer(this.options.selection, auth).offered) throw new StructuredRuntimeError("unavailable");
    if (auth.mode === "subscription" && this.backendFor(auth.provider) === "openshell"
      && (operation === "setup" || operation === "ask" && !this.adapter(auth.provider)?.ask || operation === "native" && !this.adapter(auth.provider)?.nativeSessions)) throw new StructuredRuntimeError("unsupported");
  }
  private notOffered(reason: string | undefined, extra: Record<string, unknown> = {}) {
    return { offered: false, state: "not_offered", ask: false, setup: false, reason: reason ?? "Not offered.", ...extra } as const;
  }
  async readiness(auth?: AuthChoice) {
    const { selection } = this.options;
    const entries = await Promise.all(BACKENDS.map(async (name: BackendName) => {
      const offer = selection.offers[name];
      if (!offer.offered) return [name, this.notOffered(offer.reason)] as const;
      if (name === "pi") return [name, { offered: true, state: "unavailable", ask: false, setup: false, reason: "Selected vendor backend is not configured." }] as const;
      const vendor: StructuredVendor = name;
      const backend = this.backendFor(vendor)!;
      if (backend === "local") {
        const localReady = !this.lifetime.signal.aborted;
        return [name, { offered: true, backend, state: localReady ? "ready" : "unavailable", ask: localReady, setup: localReady && !!this.options.localSetupFor({ mode: "subscription", provider: vendor }), reason: "Explicit local execution; vendor isolation is not claimed." }] as const;
      }
      const adapter = this.adapter(vendor);
      let probe: RuntimeBackendReadiness | undefined;
      try { probe = await adapter?.probe(); } catch { /* fixed public failure below */ }
      const ready = !this.lifetime.signal.aborted && probe?.state === "ready";
      return [name, { offered: true, backend, state: ready ? "ready" : "unavailable", ask: ready && !!adapter?.ask, setup: ready && !!adapter?.setup,
        reason: !adapter ? "Selected vendor backend is not configured." : !ready ? "Selected vendor backend is not ready." : "Only explicitly supported operations are available.",
        ...(backend === "openshell" ? { modelExecution: "openshell", queryExecution: "openshell", supportedAgents: ["answer_query"] } : {}),
        ...(probe && probe.state !== "ready" ? { code: probe.code } : {}) }] as const;
    }));
    const backends = Object.fromEntries(entries) as Record<BackendName, (typeof entries)[number][1]>;
    const inProcess = (offer: ReturnType<typeof inProcessAuthOffer>) => offer.offered
      ? { offered: true, backend: "in-process", state: this.lifetime.signal.aborted ? "unavailable" : "ready", ask: !this.lifetime.signal.aborted, reason: "Configured in-process execution." }
      : this.notOffered(offer.reason, { backend: "in-process" });
    return { runtime: selection.runtime, backends, codex: backends.codex, claude: backends.claude,
      ...(auth ? { active: auth.mode === "subscription" ? backends[auth.provider] : inProcess(auth.mode === "local" ? localModeAuthOffer(selection) : inProcessAuthOffer(selection)) } : {}) };
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
    const diagnostics = auth.mode === "subscription" && this.backendFor(auth.provider) === "openshell" ? this.options.diagnostics : undefined;
    const pending = observeStructuredAsync(diagnostics, "runtime_admission", async () => {
      assertCurrent(); enforceCompliance(auth, { deployment: this.options.deployment ?? deployment });
      // Admission is the no-fallback gate: a backend or auth path the runtime does not offer never reaches an adapter or the local route.
      if (!authOffer(this.options.selection, auth).offered) throw new StructuredRuntimeError("unavailable");
      let adapter: StructuredAdapter | undefined;
      if (auth.mode === "subscription" && this.backendFor(auth.provider) !== "local") {
        adapter = this.adapter(auth.provider);
        if (!adapter) throw new StructuredRuntimeError("unavailable");
        let ready: RuntimeBackendReadiness;
        try { ready = await observeStructuredAsync(diagnostics, "runtime_readiness", () => adapter!.probe()); } catch { throw new StructuredRuntimeError("unavailable"); }
        assertCurrent();
        if (ready.state !== "ready") throw new StructuredRuntimeError("unavailable");
      }
      let result: T;
      try { result = await observeStructuredAsync(diagnostics, "adapter_dispatch", () => operation(adapter, { sessionId: scope.sessionId, turnId: scope.turnId, signal, assertCurrent, ...(scope.modelSession ? { modelSession: scope.modelSession } : {}) })); }
      catch (error) {
        if (adapter && !(error instanceof StructuredRuntimeError)) throw new StructuredRuntimeError(signal.aborted ? "cancelled" : "failed");
        throw error;
      }
      assertCurrent(); return result;
    });
    this.active.add(pending);
    void pending.catch((error) => { if (error instanceof StructuredRuntimeError && error.code === "cleanup") this.cleanupFailed = true; }).finally(() => { this.active.delete(pending); this.controllers.delete(controller); });
    return pending;
  }
  assertActive(): void { if (this.lifetime.signal.aborted) throw new StructuredRuntimeError("cancelled"); }
  revoke(): void { try { this.options.onRevoke?.(); } finally { for (const controller of this.controllers) controller.abort(); } }
  async shutdown(): Promise<void> {
    this.lifetime.abort();
    await Promise.allSettled([...this.active]);
    if (this.cleanupFailed) throw new StructuredRuntimeError("cleanup");
  }
}
