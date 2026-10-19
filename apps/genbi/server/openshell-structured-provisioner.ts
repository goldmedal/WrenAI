import { structuredTimingForObserver, measureStructuredTiming } from "./structured-timing.js";
import { observeStructured, observeStructuredAsync, type StructuredDiagnosticObserver } from "./structured-diagnostics.js";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { compileProfile } from "../harness/compile/index.js";
import { resolveContextLoaderBinary } from "../harness/compile/context-loader.js";
import { planDigest } from "../harness/components/plan.js";
import { ComponentRunner, type ComponentLimits } from "../harness/components/runner.js";
import type { Store } from "./db.js";
import type { EnrichmentBinding } from "./enrichment.js";
import type { NativeComponentVendor } from "./native-component-runtime.js";
import { deriveOpenShellEnrichmentIr } from "./openshell-enrichment.js";
import { prepareCapturedStructuredAskHost, prepareCapturedStructuredEnrichHost } from "./native-component-context.js";
import type { createOpenShellRuntimeComposition } from "./openshell-runtime-composition.js";
import type { OpenShellEnrichmentPreparation, OpenShellPreparedHost, OpenShellStructuredProvisioner } from "./openshell-structured-ask.js";
import { assertNativeExecutableIdentity, attestNativeExecutable } from "./native-runtime-spec.js";
import { assertRuntimeSettingsDispatchable, collectIrTierNames, effectiveTierModel, PI_BOOT_AUTH_MODE, resolvePiTierModels, RuntimeBindingError, validatePiRuntimeBindings, validateRuntimeTierBindings, writeClaudeModelsConfig } from "./runtime-binding.js";
import { produceComponentHostPlan } from "./runtime-host/component-host-plan.js";
import { runtimeNotReady } from "./runtime-host/policy.js";
import type { RuntimeSettings } from "./wire-types.js";
import { StructuredRuntimeError } from "./structured-runtime.js";
import { createStructuredQueryFailureTracker, observeStructuredQueryAccess } from "./structured-error-feedback.js";
import { isClaudeQueryAbort } from "./runtime-host/claude-component-step.js";
import { launchOpenShellModelSession } from "./runtime-host/openshell-model-session.js";
import { isPiQueryAbort, type PiComponentRuntime } from "./runtime-host/pi-component-step.js";
import { piAccountLabel } from "./runtime-host/openshell-pi-provider.js";
import { piProviderConfig, type OpenShellModelVendor } from "./runtime-host/openshell-pi-boot.js";
import { OpenShellError } from "./runtime-host/openshell-types.js";

type FullComposition = Awaited<ReturnType<typeof createOpenShellRuntimeComposition>>;
type Composition = Pick<FullComposition, "lifecycle" | "claudeVault" | "claudeProvider" | "probe" | "bindDataContext" | "dataWorkerAvailable">
  & Partial<Pick<FullComposition, "piProvider" | "piBoot" | "verifyPiGateway" | "applyInventory">> & { readonly modelVendor?: OpenShellModelVendor };
type ModelScope = Parameters<Composition["claudeProvider"]>[0]["scope"];
/** Gateway objects are re-verified on this cadence while a pi run is active; a change cancels the run as stale. */
const PI_GATEWAY_POLL_MS = 2000;
interface Options {
  readonly componentLimits?: ComponentLimits;
  /** Live resolver (deployer env plus operator override), read per provisioning; wins over `componentLimits`. */
  readonly getComponentLimits?: () => ComponentLimits;
  readonly diagnostics?: StructuredDiagnosticObserver;
  readonly composition: Composition;
  readonly store: Store;
  readonly producerBinary: string;
  readonly wrenBinary: string;
  readonly profileSource: string;
  /** The `genbi-enrich-context` profile; without it the provisioner cannot admit an enrichment stage. */
  readonly enrichmentProfileSource?: string;
  readonly hostHome: string;
  readonly sourceWrenHome: () => string;
  readonly getBinding: () => EnrichmentBinding | undefined;
  /** Captured server runtime aliases resolve through explicit protected host pins. */
  modelsFor(settings: RuntimeSettings): Readonly<Record<string, string>>;
  assertConfigurationCurrent(): void;
  /** Cadence of the read-only gateway proof while a pi run is active; production uses the default. */
  readonly gatewayPollMs?: number;
}
const unavailable = () => new StructuredRuntimeError("unavailable");
type AskInput = Parameters<OpenShellStructuredProvisioner["prepare"]>[0];

/** The same governed native component host, without an outer vendor orchestration session. */
export function createOpenShellStructuredProvisioner(options: Options): OpenShellStructuredProvisioner {
  const composition = options.composition;
  const resolveComponentLimits = () => {
    const limits = options.getComponentLimits?.() ?? options.componentLimits;
    return limits ? Object.freeze({ ...limits }) : undefined;
  };
  const pi = composition.modelVendor === "pi";
  /** The single model vendor this boot serves: its identity, as the provider and the scope see it. */
  const currentStatus = (): { readonly state?: string; readonly fingerprint?: string; readonly generation?: string } | undefined =>
    pi ? (composition.piBoot ? { state: "verified", fingerprint: composition.piBoot.account, generation: composition.piBoot.descriptor.generation } : undefined) : composition.claudeVault?.status();
  /** Host-pinned model id per tier; a mismatch is `unsupported` before any sandbox exists. */
  const piModels = (settings: RuntimeSettings) => {
    try { return resolvePiTierModels(settings, composition.piBoot!.descriptor.models); }
    catch (error) { throw error instanceof RuntimeBindingError ? new StructuredRuntimeError("unsupported") : error; }
  };
  const modelsFor = (settings: RuntimeSettings) => pi ? piModels(settings) : options.modelsFor(settings);
  const checkPiConfiguration = () => {
    const boot = composition.piBoot;
    if (!boot || !composition.piProvider || !composition.lifecycle?.modelIdentity) throw unavailable();
    const settings = options.store.getRuntimeSettings();
    if (!options.store.hasExplicitRuntimeSettings() || settings.hybrid || settings.authMode !== PI_BOOT_AUTH_MODE[boot.descriptor.auth]) throw unavailable();
    modelsFor(settings);
    if (!options.getBinding() || !composition.dataWorkerAvailable) throw unavailable();
    return { state: "verified", fingerprint: boot.account, generation: boot.descriptor.generation };
  };
  /** Read-only gateway proof (provider, profile, endpoint, binary, credential name); a mismatch is stale, never a fallback. */
  const verifyGateway = async (signal?: AbortSignal) => {
    if (!composition.verifyPiGateway) throw unavailable();
    try { await composition.verifyPiGateway(signal); }
    catch (error) { if (signal?.aborted) throw new StructuredRuntimeError("cancelled"); throw error instanceof OpenShellError ? error : unavailable(); }
  };
  /** The same proof at a run boundary: a mismatch revokes the Ask as stale, a cancellation stays a cancellation. */
  const assertGatewayCurrent = async (signal: AbortSignal) => {
    try { await verifyGateway(signal); }
    catch (error) { throw error instanceof StructuredRuntimeError ? error : new StructuredRuntimeError("stale"); }
  };
  const checkConfiguration = () => {
    options.assertConfigurationCurrent();
    if (pi) return checkPiConfiguration();
    const status = composition.claudeVault?.status();
    if (status?.state !== "verified" || !status.fingerprint || !status.generation || !composition.lifecycle?.modelIdentity) throw unavailable();
    const settings = options.store.getRuntimeSettings();
    if (!options.store.hasExplicitRuntimeSettings() || settings.authMode !== "subscription" || settings.subscriptionProvider !== "claude" || settings.hybrid) throw unavailable();
    assertRuntimeSettingsDispatchable(settings); modelsFor(settings);
    if (!options.getBinding() || !composition.dataWorkerAvailable) throw unavailable();
    return status;
  };
  /** Poll the read-only gateway proof while a run is active; a failure that is not a cancellation revokes it at once. */
  const watchGateway = (signal: AbortSignal, onFault: () => void) => {
    let stopped = false, running = false;
    const timer = setInterval(() => {
      if (running || stopped || signal.aborted) return;
      running = true;
      verifyGateway(signal).catch(() => { if (!stopped && !signal.aborted) onFault(); }).finally(() => { running = false; });
    }, options.gatewayPollMs ?? PI_GATEWAY_POLL_MS);
    return { stop() { stopped = true; clearInterval(timer); } };
  };
  /** The purpose is set by the typed `prepare` / `prepareEnrichment` entry points below, never inferred from the input's shape. */
  type Tagged = { readonly purpose: "analysis"; readonly input: AskInput } | { readonly purpose: "enrichment"; readonly input: OpenShellEnrichmentPreparation };
  const prepareScoped = async (tagged: Tagged): Promise<OpenShellPreparedHost> => {
      const input = tagged.input;
      const enrich = tagged.purpose === "enrichment" ? tagged.input : undefined;
      const ask = tagged.purpose === "analysis" ? tagged.input : undefined;
      // Enrichment drafts are Claude-subscription only; a pi boot never admits one.
      if (!input.scope.signal || (enrich ? pi || options.enrichmentProfileSource === undefined : ask!.options.profileSource !== options.profileSource)) throw unavailable();
      const signal = input.scope.signal;
      signal.throwIfAborted(); input.scope.assertCurrent();
      const status = observeStructured(options.diagnostics, "configuration", checkConfiguration);
      if (pi) await assertGatewayCurrent(signal);
      const binding = structuredClone(options.getBinding()!);
      const settings = structuredClone(options.store.getRuntimeSettings());
      const runtimeGeneration = options.store.getNativeRuntimeBinding().generation;
      const models = Object.freeze({ ...modelsFor(settings) });
      const sourceHome = options.sourceWrenHome();
      if (path.resolve(input.options.userProject) !== binding.path
        || input.options.model !== undefined
        || (pi ? input.options.modelsConfig !== undefined || input.options.tierBinding !== undefined || input.options.authChoice.mode !== composition.piBoot!.descriptor.auth
          : input.options.modelsConfig !== writeClaudeModelsConfig(settings, settings.tierModels.map(tier => tier.tier)))) throw new StructuredRuntimeError("unsupported");
      const { producer, loader, wren, node } = observeStructured(options.diagnostics, "executable_capture", () => {
      const producer = attestNativeExecutable("producer", options.producerBinary);
      const loader = attestNativeExecutable("producer", resolveContextLoaderBinary());
      const wren = attestNativeExecutable("wren", options.wrenBinary);
      const node = attestNativeExecutable("node", process.execPath);
      return { producer, loader, wren, node };
      });
      let gatewayFault = false;
      const identity = { session_id: input.scope.sessionId, vendor: (pi ? "pi" : "claude") as "claude" | "pi", auth_identity: status.fingerprint!, runtime_generation: status.generation!,
        binding: { project_identity: binding.identity, generation: String(binding.generation), revision: binding.revision } };
      const timing = structuredTimingForObserver(options.diagnostics);
      const check = () => {
        let signalAbortedAtCheck = false;
        return measureStructuredTiming(timing, "currentness", () => observeStructured(options.diagnostics, "currentness", () => {
        signalAbortedAtCheck = signal.aborted;
        signal.throwIfAborted(); input.scope.assertCurrent(); options.assertConfigurationCurrent();
        if (gatewayFault || !isDeepStrictEqual(options.getBinding(), binding) || !isDeepStrictEqual(options.store.getRuntimeSettings(), settings)
          || options.store.getNativeRuntimeBinding().generation !== runtimeGeneration || sourceHome !== options.sourceWrenHome()
          || !isDeepStrictEqual(currentStatus(), status) || !isDeepStrictEqual(modelsFor(settings), models)) throw new StructuredRuntimeError("stale");
        }, () => signalAbortedAtCheck ? "scope_signal_aborted" : undefined));
      };
      /** Progress checks stay cheap; full executable hashes run only at execution/effect boundaries. */
      const assertExecutableCurrent = () => { check(); for (const executable of [producer, loader, wren, node]) measureStructuredTiming(timing, "exact_bytes", () => assertNativeExecutableIdentity(executable)); };
      assertExecutableCurrent();
      const compiled = await observeStructuredAsync(options.diagnostics, "compile_profile", () => { assertExecutableCurrent(); return compileProfile({ profileSource: enrich ? options.enrichmentProfileSource! : options.profileSource, userProject: binding.path, mode: "native", warbleBin: producer.executable }); });
      check();
      const irDocument = await observeStructuredAsync(options.diagnostics, "ir_tiers", async () => {
        const document = enrich ? deriveOpenShellEnrichmentIr(await readFile(compiled.irPath, "utf8")) : await readFile(compiled.irPath, "utf8");
        const tiers = collectIrTierNames(JSON.parse(document));
        if (!pi) validateRuntimeTierBindings(settings, tiers);
        else {
          try { validatePiRuntimeBindings(settings, tiers, composition.piBoot!.descriptor.models, composition.piBoot!.descriptor.auth); }
          catch (error) { throw error instanceof RuntimeBindingError ? new StructuredRuntimeError("unsupported") : error; }
        }
        return document;
      });
      check();
      let modelScope: ModelScope | undefined;
      let dataAccess: ReturnType<Composition["bindDataContext"]> | undefined;
      const queryFailure = createStructuredQueryFailureTracker();
      const openPiStep = async (model: string, tier: string, parent: AbortSignal): Promise<PiComponentRuntime> => {
        check(); parent.throwIfAborted();
        if (!modelScope) throw unavailable();
        const captured = modelScope;
        // Every step sandbox is preceded by the read-only gateway proof; a changed provider or profile never reaches a launch.
        await assertGatewayCurrent(parent); check();
        const provider = observeStructured(options.diagnostics, "provider_setup", () => composition.piProvider!({ ...(ask?.modelSession ? { modelSession: ask.modelSession } : {}), scope: captured, currentScope: () => { try { check(); return captured; } catch { return undefined; } }, models, assertCurrent: check, assertExecutableCurrent }));
        return observeStructuredAsync(options.diagnostics, "provider_open", () => provider.openStep!(model, tier, parent));
      };
      const openStep = async (model: string, tier: string, parent: AbortSignal) => {
        check(); parent.throwIfAborted();
        if (!modelScope) throw unavailable();
        const captured = modelScope;
        const provider = observeStructured(options.diagnostics, "provider_setup", () => composition.claudeProvider({ ...(timing ? { timing } : {}), ...(ask?.modelSession ? { modelSession: ask.modelSession } : {}), scope: captured, currentScope: () => { try { check(); return captured; } catch { return undefined; } }, models, assertCurrent: check, assertExecutableCurrent }));
        return observeStructuredAsync(options.diagnostics, "provider_open", () => provider.openStep!(model, tier, parent));
      };
      const vendor: NativeComponentVendor = pi
        ? { vendor: "pi", authIdentity: status.fingerprint!, generation: status.generation!,
          accountEmail: observeStructured(options.diagnostics, "vendor_identity", () => piAccountLabel(piProviderConfig(composition.piBoot!.descriptor))), models, assertCurrent: check, openStep: openPiStep,
          open(model, parent, tier) { const selected = tier ?? Object.keys(models).find(key => models[key] === model); if (!selected) throw unavailable(); return openPiStep(model, selected, parent); } }
        : { vendor: "claude", authIdentity: status.fingerprint!, generation: status.generation!,
        accountEmail: observeStructured(options.diagnostics, "vendor_identity", () => composition.claudeVault!.verifiedIdentity().email), models, assertCurrent: check, openStep,
        open(model, parent, tier) { const selected = tier ?? Object.keys(models).find(key => models[key] === model); if (!selected) throw unavailable(); return openStep(model, selected, parent); } };
      const componentLimits = resolveComponentLimits();
      const prepared = await observeStructuredAsync(options.diagnostics, "context_capture", () => { assertExecutableCurrent(); return (enrich ? prepareCapturedStructuredEnrichHost : prepareCapturedStructuredAskHost)(irDocument, { binding: identity.binding, entry: enrich ? { kind: "agent", verb: enrich.stage, prompt: enrich.request } : { kind: "agent", verb: "answer_query", prompt: ask!.options.question } }, {
        identity, currentIdentity: () => { check(); return identity; }, assertCurrent: check,
        verifierBinary: producer.executable, contextLoaderBinary: loader.executable, wrenBinary: wren.executable, project: binding.path, signal, assertExecutableCurrent,
        wrenEnvironment: { PATH: [path.dirname(wren.executable), path.dirname(node.executable), "/usr/bin", "/bin"].join(path.delimiter), HOME: options.hostHome,
          WREN_HOME: sourceHome, WREN_PROJECT_HOME: binding.path, PYTHONNOUSERSITE: "1", PYTHONUTF8: "1", PYTHONDONTWRITEBYTECODE: "1" },
        openDataAccess: async parent => { if (!dataAccess || !modelScope) throw unavailable(); return observeStructuredQueryAccess(await dataAccess(modelScope, parent), queryFailure.record); },
        ...(componentLimits ? { componentLimits } : {}),
        vendor, ...(ask ? { persistRoot: ask.persistRoot } : enrich?.propose ? { propose: enrich.propose } : {}), onEvent: event => {
          if (event.kind === "step.start") queryFailure.start();
          if (event.kind === "step.finish") queryFailure.finish(event.status);
          input.onEvent(event);
        }, ...(options.diagnostics ? { diagnostics: options.diagnostics } : {}),
      }); });
      check();
      const { root, plan } = await observeStructuredAsync(options.diagnostics, "host_plan", () => { assertExecutableCurrent(); return produceComponentHostPlan({ irDocument, prepared, producerBinary: producer.executable, signal, assertCurrent: check, assertExecutableCurrent }); });
      modelScope = observeStructured(options.diagnostics, "model_scope", () => Object.freeze({ backend: "openshell", account: status.fingerprint!, generation: status.generation!, session: input.scope.sessionId, turn: input.scope.turnId,
        binding: binding.identity, bindingGeneration: String(binding.generation), bindingRevision: binding.revision,
        context: planDigest(prepared.contexts), plan: enrich ? planDigest({ purpose: "enrichment", stage: enrich.stage, plan: plan.identity }) : plan.identity, ...composition.lifecycle!.modelIdentity! }));
      dataAccess = composition.bindDataContext(modelScope.context, check);
      check();
      let runner: ComponentRunner | undefined;
      let active: Promise<unknown> | undefined;
      let started = false;
      let closing: Promise<void> | undefined;
      return {
        assertCurrent: check,
        assertExecutableCurrent,
        sessionIdentity() { check(); if (!modelScope) throw unavailable(); const { turn: _turn, ...scope } = modelScope; return { ...scope, purpose: "model_session", operation: "session", snapshot: "none" }; },
        async run(request) {
          assertExecutableCurrent(); if (started || closing) throw new StructuredRuntimeError("failed"); started = true;
          const host = await observeStructuredAsync(options.diagnostics, "broker_host", () => prepared.host(root, plan, signal));
          check(); runner = new ComponentRunner(plan, { ...host, async runStep(...args) {
            try { const response = await host.runStep(...args); queryFailure.providerReturned(response.failed === true); return response; }
            catch (error) { if ((pi ? isPiQueryAbort : isClaudeQueryAbort)(error)) queryFailure.providerQueryAborted(); else queryFailure.providerRejected(); throw error; }
          } }, componentLimits);
          const pending = runner.run(root, { request }, signal); active = pending;
          const watch = pi ? watchGateway(signal, () => { gatewayFault = true; runner?.cancel(); }) : undefined;
          try {
            let result: Awaited<typeof pending>;
            try { result = await pending; } catch (error) { if (gatewayFault) throw new StructuredRuntimeError("stale"); throw error; }
            check();
            if (pi) { watch?.stop(); await assertGatewayCurrent(signal); check(); }
            const failure = queryFailure.terminalFailure(); if (result.status === "error" && result.code === "callee_failed" && failure && !runner.cleanupFailed) throw failure; return result;
          } finally { watch?.stop(); active = undefined; }
        },
        dispose() { return closing ??= (async () => { if (active) runner?.cancel(); await active?.catch(() => {}); if (runner?.cleanupFailed) throw new StructuredRuntimeError("cleanup"); })(); },
      };
  };
  const provisioner: OpenShellStructuredProvisioner = {
    assertSessionCleaned(sessionId) {
      const intents = options.store.listOpenShellIntents().filter(row => row.identity.session === sessionId);
      const publications = options.store.listSnapshotPublications().filter(row => row.identity.session === sessionId);
      const references = options.store.listSnapshotReferences().filter(row => row.identity.session === sessionId);
      if (intents.some(row => row.phase !== "cleaned") || publications.some(row => row.phase !== "cleaned") || references.some(row => row.phase !== "released")) throw new StructuredRuntimeError("cleanup");
    },
    async probe() {
      try {
        return await observeStructuredAsync(options.diagnostics, "runtime_readiness", async () => {
          observeStructured(options.diagnostics, "configuration", checkConfiguration);
          observeStructured(options.diagnostics, "executable_capture", () => { attestNativeExecutable("producer", options.producerBinary); attestNativeExecutable("wren", options.wrenBinary); resolveContextLoaderBinary(); });
          if (pi) await verifyGateway();
          return (await composition.probe()).readiness;
        });
      } catch (error) { return runtimeNotReady("openshell", "unprovisioned", pi && error instanceof OpenShellError ? error.code : "openshell_configuration_invalid"); }
    },
    prepare: (input) => prepareScoped({ purpose: "analysis", input }),
    ...(pi ? {} : {
      prepareEnrichment: (input: OpenShellEnrichmentPreparation) => prepareScoped({ purpose: "enrichment", input }),
      enrichmentApprovedFiles: () => composition.applyInventory?.()?.approvedFiles,
    }),
  };
  provisioner.reserveSession = async input => {
    const signal = input.scope.signal;
    if (!signal || !composition.lifecycle?.modelIdentity) throw unavailable();
    const status = structuredClone(checkConfiguration()), binding = structuredClone(options.getBinding()!), settings = structuredClone(options.store.getRuntimeSettings());
    const generation = options.store.getNativeRuntimeBinding().generation, home = options.sourceWrenHome();
    const check = () => { signal.throwIfAborted(); input.scope.assertCurrent(); options.assertConfigurationCurrent();
      if (!isDeepStrictEqual(status, currentStatus()) || !isDeepStrictEqual(binding, options.getBinding())
        || !isDeepStrictEqual(settings, options.store.getRuntimeSettings()) || generation !== options.store.getNativeRuntimeBinding().generation || home !== options.sourceWrenHome()) throw new StructuredRuntimeError("stale"); };
    check();
    // The gateway objects are proven before any session sandbox is reserved, as they are before every step sandbox.
    if (pi) { await assertGatewayCurrent(signal); check(); }
    const preparationScope = { backend: "openshell" as const, account: status.fingerprint!, generation: status.generation!, session: input.scope.sessionId, turn: input.scope.turnId,
      binding: binding.identity, bindingGeneration: String(binding.generation), bindingRevision: binding.revision,
      context: planDigest({ binding: binding.revision }), plan: planDigest({ purpose: "analysis", entry: "answer_query", profile: options.profileSource }),
      ...composition.lifecycle.identity, purpose: "lifecycle" as const, operation: "worker" as const, snapshot: "none" as const };
    // Authorize ephemeral context/plan materialization before mkdir or producer execution.
    const permission = await composition.lifecycle.prepareLaunch(preparationScope, () => { try { check(); return preparationScope; } catch { return undefined; } }, signal);
    const effect = composition.lifecycle.claimEffect(permission);
    let captured: Awaited<ReturnType<OpenShellStructuredProvisioner["prepare"]>> | undefined;
    try {
      effect.assertActive(); check();
      captured = await provisioner.prepare({ ...input, scope: { ...input.scope, signal: AbortSignal.any([signal, effect.signal]), assertCurrent() { effect.assertActive(); check(); } }, persistRoot: async () => { throw new StructuredRuntimeError("failed"); }, onEvent() {} });
      const identity = captured.sessionIdentity!(); captured.assertCurrent(); check();
      const permit = await composition.lifecycle.prepareLaunch(identity, () => { try { check(); return identity; } catch { return undefined; } }, signal);
      let session: Awaited<ReturnType<typeof launchOpenShellModelSession>>;
      try { check(); session = await launchOpenShellModelSession(composition.lifecycle, permit, identity, pi ? "pi" : "claude"); } catch (error) { permit.release(); throw error; }
      if (pi) {
        // A gateway change between turns revokes the live session at once: its sandbox is destroyed, which interrupts it. The proof is read-only.
        const watch = watchGateway(session.signal, () => { void session.close().catch(() => {}); });
        session.signal.addEventListener("abort", watch.stop, { once: true }); if (session.signal.aborted) watch.stop();
      }
      return session;
    } finally { await captured?.dispose(); effect.release(); }
  };
  return provisioner;
}

/** Only Anthropic subscription tiers enter the isolated Claude component provider. */
export function resolveStructuredClaudeModels(settings: RuntimeSettings, resolve: (model: string, driver: string) => string) {
  if (settings.hybrid || !settings.subscriptionDriverModel?.trim()) throw unavailable();
  const models: Record<string, string> = {};
  for (const binding of settings.tierModels) {
    if (!binding.tier || Object.hasOwn(models, binding.tier) || binding.baseURL !== undefined
      || (binding.adapter ?? settings.apiKeyAdapter ?? "anthropic") !== "anthropic") throw new StructuredRuntimeError("unsupported");
    const value = effectiveTierModel(binding, settings);
    if (!value) throw unavailable();
    models[binding.tier] = resolve(value, settings.subscriptionDriverModel);
  }
  if (!Object.keys(models).length) throw unavailable();
  return Object.freeze(models);
}
