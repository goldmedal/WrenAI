import { observeStructuredAsync, type StructuredDiagnosticObserver } from "./structured-diagnostics.js";
import { enforceCompliance, type AuthChoice, type RouteOptions, type RouteResult, type SetupStepRunner, type SetupStepRunOptions, type SetupStepRunResult } from "../harness/index.js";
import type { RuntimeBackendReadiness, RuntimeReasonFamily } from "./runtime-host/types.js";
import type { OpenShellModelSession } from "./runtime-host/openshell-model-session.js";
import { authOffer, BACKENDS, inProcessAuthOffer, inProcessAuthViaBackend, localModeAuthOffer, localPiServes, type BackendName, type RuntimeSelection } from "./runtime-selection.js";
import type { EnrichmentBinding, EnrichmentMode, EnrichmentProposal } from "./enrichment.js";
import type { ValidatedReview, ValidationFailure } from "./enrichment-validation.js";

export type StructuredVendor = "codex" | "claude" | "pi";
export type StructuredBackend = "local" | "codex-app-server" | "claude-sandbox-runtime" | "openshell" | "pi-local";
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
  /** `detail` is host-authored (a contract refusal's own message), never sandbox or model text; only the `contract` code carries one. */
  constructor(readonly code: "unavailable" | "unsupported" | "stale" | "cancelled" | "failed" | "cleanup" | "timeout" | "contract", readonly detail?: string) {
    super(`Structured runtime ${code}.`);
  }
}
/** One context-enrichment draft request: the server pins profile, stages and sinks, never the caller. */
export type EnrichOptions = Omit<RouteOptions, "question" | "onEvent" | "profileSource" | "agentId"> & {
  readonly mode: EnrichmentMode;
  readonly projectRevision: string;
};
/** The untrusted proposal document; the host still canonicalizes it before any ledger write. */
export interface EnrichResult { readonly backend: "openshell"; readonly draft: unknown }
/** An independent validation request for an already recorded (canonical) proposal. */
export interface EnrichmentValidationRequest {
  readonly authChoice: RouteOptions["authChoice"];
  readonly deployment?: RouteOptions["deployment"];
  readonly proposal: EnrichmentProposal;
  readonly binding: EnrichmentBinding;
}
/** `failed` is a verdict with sanitized evidence; cancel, stale state, timeout and cleanup uncertainty throw instead and can never be `validated`. */
export type EnrichmentValidationResult = { readonly status: "validated"; readonly review: ValidatedReview } | { readonly status: "failed"; readonly failure: ValidationFailure };
/** Operations a server-selected backend can be asked to run; `local_enrichment` has no OpenShell realization. */
export type StructuredOperation = "ask" | "setup" | "native" | "enrich" | "local_enrichment";
export interface StructuredAdapter {
  readonly vendor: StructuredVendor;
  readonly backend: Exclude<StructuredBackend, "local">;
  readonly nativeSessions?: boolean;
  probe(): Promise<RuntimeBackendReadiness<RuntimeReasonFamily>>;
  ask?(options: RouteOptions, scope: StructuredScope): Promise<RouteResult>;
  setup?(options: SetupStepRunOptions, scope: StructuredScope): Promise<SetupStepRunResult>;
  enrich?(options: EnrichOptions, scope: StructuredScope): Promise<EnrichResult>;
  /** Independent sandbox validation of a recorded proposal; absent or unavailable means enrichment drafts are refused (fail closed). */
  validateEnrichment?(request: EnrichmentValidationRequest, scope: StructuredScope): Promise<EnrichmentValidationResult>;
  enrichmentValidationAvailable?(): boolean;
}
/**
 * What a pi boot lets the browser see of its operator configuration: a non-secret label, the authentication mode and one pinned model id per tier.
 * Never the endpoint, credential name, profile, image, generation or any path or digest.
 */
export interface PiPinnedProjection {
  readonly provider: string;
  readonly auth: "byo" | "gateway";
  readonly models: Readonly<Record<string, string>>;
}
interface Options {
  readonly diagnostics?: StructuredDiagnosticObserver;
  /** The pi boot's pinned models for read-only display; absent when this boot has no pi descriptor. */
  readonly piPins?: () => PiPinnedProjection | undefined;
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
    if (vendor === "pi") return "pi-local";
    return vendor === "codex" && selection.codexMode === "app-server" ? "codex-app-server" : "local";
  }
  /** True when api-key and gateway Ask runs through the pi backend on OpenShell: the BFF then reads and holds no vendor key for it. */
  keyIsolated(): boolean { return inProcessAuthViaBackend(this.options.selection) === "pi"; }
  /** The backend that executes an auth choice on an agent adapter: the subscription's vendor, or pi for api-key/gateway via the seam. */
  private vendorFor(auth: AuthChoice, localPi = false): StructuredVendor | undefined {
    if (auth.mode === "subscription") return auth.provider;
    // Local pi serves one purpose per call site (Ask); a caller that does not pass the hint keeps the in-process route.
    if (localPi && localPiServes(this.options.selection, auth, "ask")) return "pi";
    return auth.mode !== "local" && inProcessAuthViaBackend(this.options.selection) === "pi" ? "pi" : undefined;
  }
  private adapter(vendor: StructuredVendor): StructuredAdapter | undefined {
    const candidate = this.options.adapters?.[vendor];
    return candidate?.vendor === vendor && candidate.backend === this.backendFor(vendor) ? candidate : undefined;
  }
  /** Pure gate used before operation-owned durable writes. */
  assertOperationSupported(auth: AuthChoice, operation: StructuredOperation): void {
    this.assertActive();
    if (!authOffer(this.options.selection, auth).offered) throw new StructuredRuntimeError("unavailable");
    const vendor = this.vendorFor(auth);
    if (vendor !== undefined && this.backendFor(vendor) === "openshell"
      && (operation === "setup" || operation === "local_enrichment" || operation === "ask" && !this.adapter(vendor)?.ask
        || operation === "native" && !this.adapter(vendor)?.nativeSessions || operation === "enrich" && !this.adapter(vendor)?.enrich)) throw new StructuredRuntimeError("unsupported");
  }
  /** True when the server selected OpenShell for this auth; enrichment must then never use a host-local runner. Subscription Claude only. */
  usesOpenShell(auth: AuthChoice): boolean { return auth.mode === "subscription" && this.backendFor(auth.provider) === "openshell"; }
  /** Live enrichment availability for an OpenShell-selected auth, else undefined (the local runner reports its own). */
  async enrichmentReadiness(auth: AuthChoice): Promise<{ readonly available: boolean; readonly reason?: string } | undefined> {
    if (!this.usesOpenShell(auth) || auth.mode !== "subscription") return undefined;
    const adapter = this.adapter(auth.provider);
    if (!adapter?.enrich) return { available: false, reason: "openshell_enrichment_unsupported" };
    if (!adapter.validateEnrichment || adapter.enrichmentValidationAvailable?.() !== true) return { available: false, reason: "openshell_validator_unavailable" };
    let probe: RuntimeBackendReadiness<RuntimeReasonFamily> | undefined;
    try { probe = await adapter.probe(); } catch { /* reported as not ready below */ }
    return !this.lifetime.signal.aborted && probe?.state === "ready" ? { available: true } : { available: false, reason: "openshell_not_ready" };
  }
  private notOffered(reason: string | undefined, extra: Record<string, unknown> = {}) {
    return { offered: false, state: "not_offered", ask: false, setup: false, reason: reason ?? "Not offered.", ...extra } as const;
  }
  async readiness(auth?: AuthChoice) {
    const { selection } = this.options;
    const entries = await Promise.all(BACKENDS.map(async (name: BackendName) => {
      const offer = selection.offers[name];
      if (!offer.offered) return [name, this.notOffered(offer.reason)] as const;
      const vendor: StructuredVendor = name;
      const backend = this.backendFor(vendor)!;
      if (backend === "local" && vendor !== "pi") {
        const localReady = !this.lifetime.signal.aborted;
        return [name, { offered: true, backend, state: localReady ? "ready" : "unavailable", ask: localReady, setup: localReady && !!this.options.localSetupFor({ mode: "subscription", provider: vendor }), reason: "Explicit local execution; vendor isolation is not claimed." }] as const;
      }
      const adapter = this.adapter(vendor);
      const pins = name === "pi" && backend === "openshell" ? this.options.piPins?.() : undefined;
      let probe: RuntimeBackendReadiness<RuntimeReasonFamily> | undefined;
      try { probe = await adapter?.probe(); } catch { /* fixed public failure below */ }
      const ready = !this.lifetime.signal.aborted && probe?.state === "ready";
      return [name, { offered: true, backend, state: ready ? "ready" : "unavailable", ask: ready && !!adapter?.ask, setup: ready && !!adapter?.setup,
        reason: !adapter ? "Selected vendor backend is not configured." : !ready ? "Selected vendor backend is not ready."
          : backend === "pi-local" ? "Structured Ask runs through pi for API key and gateway; every other purpose runs in-process." : "Only explicitly supported operations are available.",
        ...(backend === "openshell" ? { modelExecution: "openshell", queryExecution: "openshell", enrich: ready && !!adapter?.enrich,
          supportedAgents: ["answer_query", ...(adapter?.enrich ? ["inspect_context", "draft_enrichment"] : [])] } : {}),
        ...(probe && probe.state !== "ready" ? { code: probe.code } : {}),
        ...(pins ? { pinned: { provider: pins.provider, auth: pins.auth, models: { ...pins.models } } } : {}) }] as const;
    }));
    const backends = Object.fromEntries(entries) as Record<BackendName, (typeof entries)[number][1]>;
    const inProcess = (offer: ReturnType<typeof inProcessAuthOffer>) => offer.offered
      ? { offered: true, backend: "in-process", state: this.lifetime.signal.aborted ? "unavailable" : "ready", ask: !this.lifetime.signal.aborted, reason: "Configured in-process execution." }
      : this.notOffered(offer.reason, { backend: "in-process" });
    return { runtime: selection.runtime, backends, codex: backends.codex, claude: backends.claude,
      ...(auth ? { active: auth.mode === "subscription" ? backends[auth.provider]
        : auth.mode === "local" ? inProcess(localModeAuthOffer(selection)) : this.keyIsolated() || localPiServes(selection, auth, "ask") ? backends.pi : inProcess(inProcessAuthOffer(selection)) } : {}) };
  }
  async route(options: RouteOptions, scope: StructuredScope): Promise<RouteResult> {
    return this.run(options.authChoice, scope, async (adapter, guarded) => {
      const request = { ...options, signal: guarded.signal!, onEvent: (event: Parameters<NonNullable<RouteOptions["onEvent"]>>[0]) => { guarded.assertCurrent(); options.onEvent?.(event); } };
      if (!adapter) return this.options.localRoute(request);
      if (!adapter.ask) throw new StructuredRuntimeError("unsupported");
      return adapter.ask(request, guarded);
    }, options.deployment, (options.agentId ?? "answer_query") === "answer_query");
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
  async enrich(options: EnrichOptions, scope: StructuredScope): Promise<EnrichResult> {
    return this.run(options.authChoice, scope, async (adapter, guarded) => {
      if (!adapter?.enrich) throw new StructuredRuntimeError("unsupported");
      return adapter.enrich({ ...options, signal: guarded.signal! }, guarded);
    }, options.deployment);
  }
  async validateEnrichment(request: EnrichmentValidationRequest, scope: StructuredScope): Promise<EnrichmentValidationResult> {
    return this.run(request.authChoice, scope, async (adapter, guarded) => {
      if (!adapter?.validateEnrichment || adapter.enrichmentValidationAvailable?.() !== true) throw new StructuredRuntimeError("unavailable");
      return adapter.validateEnrichment(request, guarded);
    }, request.deployment);
  }
  private run<T>(auth: AuthChoice, scope: StructuredScope, operation: (adapter: StructuredAdapter | undefined, scope: StructuredScope) => Promise<T>, deployment: RouteOptions["deployment"] = "personal", localPi = false): Promise<T> {
    const controller = new AbortController(); this.controllers.add(controller);
    const signal = AbortSignal.any([controller.signal, this.lifetime.signal, ...(scope.signal ? [scope.signal] : [])]);
    const assertCurrent = () => {
      if (signal.aborted) throw new StructuredRuntimeError("cancelled");
      try { scope.assertCurrent(); } catch { throw new StructuredRuntimeError("stale"); }
    };
    const vendor = this.vendorFor(auth, localPi);
    const diagnostics = vendor !== undefined && this.backendFor(vendor) === "openshell" ? this.options.diagnostics : undefined;
    const pending = observeStructuredAsync(diagnostics, "runtime_admission", async () => {
      assertCurrent(); enforceCompliance(auth, { deployment: this.options.deployment ?? deployment });
      // Admission is the no-fallback gate: a backend or auth path the runtime does not offer never reaches an adapter or the local route.
      if (!authOffer(this.options.selection, auth).offered) throw new StructuredRuntimeError("unavailable");
      let adapter: StructuredAdapter | undefined;
      // A purpose routed to pi never reaches the local route: a missing or not-ready adapter refuses here.
      if (vendor !== undefined && this.backendFor(vendor) !== "local") {
        adapter = this.adapter(vendor);
        if (!adapter) throw new StructuredRuntimeError("unavailable");
        let ready: RuntimeBackendReadiness<RuntimeReasonFamily>;
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
