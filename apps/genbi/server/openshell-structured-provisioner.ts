import { structuredTimingForObserver, measureStructuredTiming } from "./structured-timing.js";
import { observeStructured, observeStructuredAsync, type StructuredDiagnosticObserver } from "./structured-diagnostics.js";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { compileProfile } from "../harness/compile/index.js";
import { resolveContextLoaderBinary } from "../harness/compile/context-loader.js";
import { planDigest } from "../harness/components/plan.js";
import { ComponentRunner } from "../harness/components/runner.js";
import type { Store } from "./db.js";
import type { EnrichmentBinding } from "./enrichment.js";
import type { NativeComponentVendor } from "./native-component-runtime.js";
import { prepareCapturedStructuredAskHost } from "./native-component-context.js";
import type { createOpenShellRuntimeComposition } from "./openshell-runtime-composition.js";
import type { OpenShellStructuredProvisioner } from "./openshell-structured-ask.js";
import { assertNativeExecutableIdentity, attestNativeExecutable } from "./native-runtime-spec.js";
import { assertRuntimeSettingsDispatchable, collectIrTierNames, effectiveTierModel, validateRuntimeTierBindings, writeClaudeModelsConfig } from "./runtime-binding.js";
import { produceComponentHostPlan } from "./runtime-host/component-host-plan.js";
import { runtimeNotReady } from "./runtime-host/policy.js";
import type { RuntimeSettings } from "./wire-types.js";
import { StructuredRuntimeError } from "./structured-runtime.js";

type Composition = Pick<Awaited<ReturnType<typeof createOpenShellRuntimeComposition>>, "lifecycle" | "claudeVault" | "claudeProvider" | "probe">;
type ModelScope = Parameters<Composition["claudeProvider"]>[0]["scope"];
interface Options {
  readonly diagnostics?: StructuredDiagnosticObserver;
  readonly composition: Composition;
  readonly store: Store;
  readonly producerBinary: string;
  readonly wrenBinary: string;
  readonly profileSource: string;
  readonly hostHome: string;
  readonly sourceWrenHome: () => string;
  readonly getBinding: () => EnrichmentBinding | undefined;
  /** Captured server runtime aliases resolve through explicit protected host pins. */
  modelsFor(settings: RuntimeSettings): Readonly<Record<string, string>>;
  assertConfigurationCurrent(): void;
}
const unavailable = () => new StructuredRuntimeError("unavailable");

/** The same governed native component host, without an outer vendor orchestration session. */
export function createOpenShellStructuredProvisioner(options: Options): OpenShellStructuredProvisioner {
  const composition = options.composition;
  const checkConfiguration = () => {
    options.assertConfigurationCurrent();
    const status = composition.claudeVault?.status();
    if (status?.state !== "verified" || !status.fingerprint || !status.generation || !composition.lifecycle?.modelIdentity) throw unavailable();
    const settings = options.store.getRuntimeSettings();
    if (!options.store.hasExplicitRuntimeSettings() || settings.authMode !== "subscription" || settings.subscriptionProvider !== "claude" || settings.hybrid) throw unavailable();
    assertRuntimeSettingsDispatchable(settings); options.modelsFor(settings);
    if (!options.getBinding()) throw unavailable();
    return status;
  };
  return {
    async probe() {
      try {
        return await observeStructuredAsync(options.diagnostics, "runtime_readiness", async () => {
          observeStructured(options.diagnostics, "configuration", checkConfiguration);
          observeStructured(options.diagnostics, "executable_capture", () => { attestNativeExecutable("producer", options.producerBinary); attestNativeExecutable("wren", options.wrenBinary); resolveContextLoaderBinary(); });
          return (await composition.probe()).readiness;
        });
      } catch { return runtimeNotReady("openshell", "unprovisioned", "openshell_configuration_invalid"); }
    },
    async prepare(input) {
      if (!input.scope.signal || input.options.profileSource !== options.profileSource) throw unavailable();
      const signal = input.scope.signal;
      signal.throwIfAborted(); input.scope.assertCurrent();
      const status = observeStructured(options.diagnostics, "configuration", checkConfiguration);
      const binding = structuredClone(options.getBinding()!);
      const settings = structuredClone(options.store.getRuntimeSettings());
      const runtimeGeneration = options.store.getNativeRuntimeBinding().generation;
      const models = Object.freeze({ ...options.modelsFor(settings) });
      const sourceHome = options.sourceWrenHome();
      if (path.resolve(input.options.userProject) !== binding.path
        || input.options.model !== undefined || input.options.modelsConfig !== writeClaudeModelsConfig(settings, settings.tierModels.map(tier => tier.tier))) throw new StructuredRuntimeError("unsupported");
      const { producer, loader, wren, node } = observeStructured(options.diagnostics, "executable_capture", () => {
      const producer = attestNativeExecutable("producer", options.producerBinary);
      const loader = attestNativeExecutable("producer", resolveContextLoaderBinary());
      const wren = attestNativeExecutable("wren", options.wrenBinary);
      const node = attestNativeExecutable("node", process.execPath);
      return { producer, loader, wren, node };
      });
      const identity = { session_id: input.scope.sessionId, vendor: "claude" as const, auth_identity: status.fingerprint!, runtime_generation: status.generation!,
        binding: { project_identity: binding.identity, generation: String(binding.generation), revision: binding.revision } };
      const timing = structuredTimingForObserver(options.diagnostics);
      const check = () => {
        let signalAbortedAtCheck = false;
        return measureStructuredTiming(timing, "currentness", () => observeStructured(options.diagnostics, "currentness", () => {
        signalAbortedAtCheck = signal.aborted;
        signal.throwIfAborted(); input.scope.assertCurrent(); options.assertConfigurationCurrent();
        if (!isDeepStrictEqual(options.getBinding(), binding) || !isDeepStrictEqual(options.store.getRuntimeSettings(), settings)
          || options.store.getNativeRuntimeBinding().generation !== runtimeGeneration || sourceHome !== options.sourceWrenHome()
          || !isDeepStrictEqual(composition.claudeVault?.status(), status) || !isDeepStrictEqual(options.modelsFor(settings), models)) throw new StructuredRuntimeError("stale");
        }, () => signalAbortedAtCheck ? "scope_signal_aborted" : undefined));
      };
      /** Progress checks stay cheap; full executable hashes run only at execution/effect boundaries. */
      const assertExecutableCurrent = () => { check(); for (const executable of [producer, loader, wren, node]) measureStructuredTiming(timing, "exact_bytes", () => assertNativeExecutableIdentity(executable)); };
      assertExecutableCurrent();
      const compiled = await observeStructuredAsync(options.diagnostics, "compile_profile", () => { assertExecutableCurrent(); return compileProfile({ profileSource: options.profileSource, userProject: binding.path, mode: "native", warbleBin: producer.executable }); });
      check();
      const irDocument = await observeStructuredAsync(options.diagnostics, "ir_tiers", async () => {
        const document = await readFile(compiled.irPath, "utf8");
        validateRuntimeTierBindings(settings, collectIrTierNames(JSON.parse(document)));
        return document;
      });
      check();
      let modelScope: ModelScope | undefined;
      const openStep = async (model: string, tier: string, parent: AbortSignal) => {
        check(); parent.throwIfAborted();
        if (!modelScope) throw unavailable();
        const captured = modelScope;
        const provider = observeStructured(options.diagnostics, "provider_setup", () => composition.claudeProvider({ ...(timing ? { timing } : {}), scope: captured, currentScope: () => { try { check(); return captured; } catch { return undefined; } }, models, assertCurrent: check, assertExecutableCurrent }));
        return observeStructuredAsync(options.diagnostics, "provider_open", () => provider.openStep!(model, tier, parent));
      };
      const vendor: NativeComponentVendor = { vendor: "claude", authIdentity: status.fingerprint!, generation: status.generation!,
        accountEmail: observeStructured(options.diagnostics, "vendor_identity", () => composition.claudeVault!.verifiedIdentity().email), models, assertCurrent: check, openStep,
        open(model, parent, tier) { const selected = tier ?? Object.keys(models).find(key => models[key] === model); if (!selected) throw unavailable(); return openStep(model, selected, parent); } };
      const prepared = await observeStructuredAsync(options.diagnostics, "context_capture", () => { assertExecutableCurrent(); return prepareCapturedStructuredAskHost(irDocument, { binding: identity.binding, entry: { kind: "agent", verb: "answer_query", prompt: input.options.question } }, {
        identity, currentIdentity: () => { check(); return identity; }, assertCurrent: check,
        verifierBinary: producer.executable, contextLoaderBinary: loader.executable, wrenBinary: wren.executable, project: binding.path, signal, assertExecutableCurrent,
        wrenEnvironment: { PATH: [path.dirname(wren.executable), path.dirname(node.executable), "/usr/bin", "/bin"].join(path.delimiter), HOME: options.hostHome,
          WREN_HOME: sourceHome, WREN_PROJECT_HOME: binding.path, PYTHONNOUSERSITE: "1", PYTHONUTF8: "1", PYTHONDONTWRITEBYTECODE: "1" },
        vendor, persistRoot: input.persistRoot, onEvent: input.onEvent, ...(options.diagnostics ? { diagnostics: options.diagnostics } : {}),
      }); });
      check();
      const { root, plan } = await observeStructuredAsync(options.diagnostics, "host_plan", () => { assertExecutableCurrent(); return produceComponentHostPlan({ irDocument, prepared, producerBinary: producer.executable, signal, assertCurrent: check, assertExecutableCurrent }); });
      modelScope = observeStructured(options.diagnostics, "model_scope", () => Object.freeze({ backend: "openshell", account: status.fingerprint!, generation: status.generation!, session: input.scope.sessionId, turn: input.scope.turnId,
        binding: binding.identity, bindingGeneration: String(binding.generation), bindingRevision: binding.revision,
        context: planDigest(prepared.contexts), plan: plan.identity, ...composition.lifecycle!.modelIdentity! }));
      check();
      let runner: ComponentRunner | undefined;
      let active: Promise<unknown> | undefined;
      let started = false;
      let closing: Promise<void> | undefined;
      return {
        assertCurrent: check,
        assertExecutableCurrent,
        async run(request) {
          assertExecutableCurrent(); if (started || closing) throw new StructuredRuntimeError("failed"); started = true;
          const host = await observeStructuredAsync(options.diagnostics, "broker_host", () => prepared.host(root, plan, signal));
          check(); runner = new ComponentRunner(plan, host);
          const pending = runner.run(root, { request }, signal); active = pending;
          try { const result = await pending; check(); return result; } finally { active = undefined; }
        },
        dispose() { return closing ??= (async () => { if (active) runner?.cancel(); await active?.catch(() => {}); if (runner?.cleanupFailed) throw new StructuredRuntimeError("cleanup"); })(); },
      };
    },
  };
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
