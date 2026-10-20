import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { spawn } from "node:child_process";
import { compileProfile } from "../harness/compile/index.js";
import { resolveContextLoaderBinary } from "../harness/compile/context-loader.js";
import { hashDirectory } from "../harness/compile/fingerprint.js";
import { ComponentRunner, type ComponentLimits } from "../harness/components/runner.js";
import { openWrenComponentAccess } from "../harness/components/wren-access.js";
import type { Store } from "./db.js";
import type { EnrichmentBinding } from "./enrichment.js";
import { prepareCapturedStructuredAskHost } from "./native-component-context.js";
import { assertNativeExecutableIdentity, attestNativeExecutable } from "./native-runtime-spec.js";
import { collectIrTierNames, compileUnboundProfileTierNames } from "./runtime-binding.js";
import { produceComponentHostPlan } from "./runtime-host/component-host-plan.js";
import { LocalPiProviderUnsupported, piAiCatalog, resolveLocalPiEndpoints, type LocalPiCatalog } from "./runtime-host/local-pi-endpoint.js";
import { resolveGenbiStateDir, verifyLocalPi, type LocalPiVerification } from "./runtime-host/local-pi-install.js";
import { LocalPiKeyProxy } from "./runtime-host/local-pi-key-proxy.js";
import { createLocalPiProvider } from "./runtime-host/local-pi-provider.js";
import { defaultStepsRoot, ensureStepsRoot, type LocalPiCleanupReport, type ProcessRow } from "./runtime-host/local-pi-step.js";
import type { InstalledComponents } from "./runtime-host/openshell-vendor-certification.js";
import { runtimeNotReady, runtimeReady } from "./runtime-host/policy.js";
import type { RuntimeBackendReadiness, RuntimeReasonFamily } from "./runtime-host/types.js";
import { createStructuredQueryFailureTracker, observeStructuredQueryAccess } from "./structured-error-feedback.js";
import { isPiQueryAbort } from "./runtime-host/pi-component-step.js";
import { createLocalPiStructuredAdapter, type LocalPiPreparedHost, type LocalPiStructuredProvisioner } from "./local-pi-structured-ask.js";
import { StructuredRuntimeError, type StructuredAdapter } from "./structured-runtime.js";
import type { RuntimeSettings } from "./wire-types.js";

export interface LocalPiCompositionOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly store: Store;
  readonly producerBinary: string;
  /** The `wren` the boot's local native sessions use; queries run through its governed worker. */
  readonly wrenBinary: string;
  readonly profileSource: string;
  readonly hostHome: string;
  readonly sourceWrenHome: () => string;
  readonly getBinding: () => EnrichmentBinding | undefined;
  readonly getComponentLimits?: () => ComponentLimits;
  /** Test and live-run seams; production passes none of them. */
  readonly stateDir?: string;
  /** Test seam: without it only the packaged rows count. No environment variable or file can supply a row. */
  readonly rows?: readonly unknown[];
  readonly installed?: InstalledComponents;
  readonly host?: { readonly platform: string; readonly arch: string };
  readonly catalog?: LocalPiCatalog;
  readonly proxy?: LocalPiKeyProxy;
  readonly stepsRoot?: string;
  readonly list?: () => Promise<ProcessRow[]>;
  readonly spawn?: typeof spawn;
  readonly tiers?: () => Promise<readonly string[]>;
  /** Cadence of the currentness check while a run is active (settings, binding, key change); production uses the default. */
  readonly watchMs?: number;
  onCleanup?(report: LocalPiCleanupReport): void;
}
export interface LocalPiRuntimeComposition {
  readonly adapter: StructuredAdapter;
  readonly proxy: LocalPiKeyProxy;
  /** Revokes every proxy grant; running steps then fail as cancelled and run their cleanup. */
  revoke(): void;
  shutdown(): Promise<void>;
}

const WATCH_MS = 1000;
const unavailable = () => new StructuredRuntimeError("unavailable");
const AUTH_MODE = { "api-key": "byo", gateway: "gateway" } as const;

/** Local pi: the managed install, the loopback key proxy and the governed Structured Ask, composed for one boot. */
export function createLocalPiRuntimeComposition(options: LocalPiCompositionOptions): LocalPiRuntimeComposition {
  const proxy = options.proxy ?? new LocalPiKeyProxy({ env: () => options.env });
  const stateDir = () => options.stateDir ?? resolveGenbiStateDir(options.env);
  const verify = (): LocalPiVerification => verifyLocalPi({ stateDir: stateDir(), ...(options.rows ? { rows: options.rows } : {}),
    ...(options.installed ? { installed: options.installed } : {}), ...(options.host ? { host: options.host } : {}) });
  const catalog = options.catalog ?? piAiCatalog;
  const tierNames = options.tiers ?? (() => compileUnboundProfileTierNames({ profileSource: options.profileSource }));
  let epoch = 0;

  const probe = async (): Promise<RuntimeBackendReadiness<RuntimeReasonFamily>> => {
    try {
      const verification = verify();
      if (!verification.verdict.ready) {
        const code = verification.verdict.code;
        return runtimeNotReady("pi-local", code === "pi_not_installed" || code === "pi_uncertified" ? "unprovisioned" : "incompatible", code);
      }
      const settings = options.store.getRuntimeSettings();
      if (options.store.hasExplicitRuntimeSettings() && (settings.authMode === "byo" || settings.authMode === "gateway")) {
        let tiers: readonly string[] | undefined;
        try { tiers = await tierNames(); } catch { tiers = undefined; }
        if (tiers) {
          try { await resolveLocalPiEndpoints(settings, tiers, catalog); }
          catch (error) { if (error instanceof LocalPiProviderUnsupported) return runtimeNotReady("pi-local", "unavailable", "pi_provider_unsupported"); throw error; }
        }
      }
      attestNativeExecutable("producer", options.producerBinary); attestNativeExecutable("wren", options.wrenBinary); resolveContextLoaderBinary();
      return runtimeReady(verification.verdict.version, []);
    } catch { return runtimeNotReady("pi-local", "unavailable", "runtime_probe_failed"); }
  };

  const prepare: LocalPiStructuredProvisioner["prepare"] = async (input) => {
    const signal = input.scope.signal;
    if (!signal) throw unavailable();
    signal.throwIfAborted(); input.scope.assertCurrent();
    const startEpoch = epoch;
    const verification = verify();
    if (!verification.verdict.ready || !verification.launcher || !verification.pins) throw unavailable();
    const pins = structuredClone(verification.pins);
    const authMode = AUTH_MODE[input.options.authChoice.mode as keyof typeof AUTH_MODE];
    const settings: RuntimeSettings = structuredClone(options.store.getRuntimeSettings());
    const binding = options.getBinding();
    if (!options.store.hasExplicitRuntimeSettings() || authMode === undefined || settings.authMode !== authMode || !binding) throw unavailable();
    if (path.resolve(input.options.userProject) !== binding.path || input.options.profileSource !== options.profileSource) throw new StructuredRuntimeError("unsupported");
    const capturedBinding = structuredClone(binding);
    const runtimeGeneration = options.store.getNativeRuntimeBinding().generation;
    const sourceHome = options.sourceWrenHome();
    const compiledExecutables = () => ({
      producer: attestNativeExecutable("producer", options.producerBinary), loader: attestNativeExecutable("producer", resolveContextLoaderBinary()),
      wren: attestNativeExecutable("wren", options.wrenBinary), node: attestNativeExecutable("node", process.execPath) });
    const { producer, loader, wren, node } = compiledExecutables();
    const compiled = await compileProfile({ profileSource: options.profileSource, userProject: capturedBinding.path, mode: "native", warbleBin: producer.executable });
    const irDocument = await readFile(compiled.irPath, "utf8");
    const tiers = collectIrTierNames(JSON.parse(irDocument));
    let endpoints;
    try { endpoints = await resolveLocalPiEndpoints(settings, tiers, catalog); }
    catch (error) { throw error instanceof LocalPiProviderUnsupported ? new StructuredRuntimeError("unsupported") : error; }
    const credentialEnvs = [...new Set(Object.values(endpoints).map((endpoint) => endpoint.credentialEnv))].sort();
    for (const name of credentialEnvs) if (!proxy.hasKey(name)) throw unavailable();
    const keys = credentialEnvs.map((name) => proxy.keyFingerprint(name));
    const authIdentity = `local-pi:${createHash("sha256").update(JSON.stringify({ pins, endpoints, authMode })).digest("hex").slice(0, 48)}`;
    const identity = { session_id: input.scope.sessionId, vendor: "pi" as const, auth_identity: authIdentity, runtime_generation: String(runtimeGeneration),
      binding: { project_identity: capturedBinding.identity, generation: String(capturedBinding.generation), revision: capturedBinding.revision } };
    const check = () => {
      signal.throwIfAborted(); input.scope.assertCurrent();
      if (epoch !== startEpoch || !isDeepStrictEqual(options.getBinding(), capturedBinding) || !isDeepStrictEqual(options.store.getRuntimeSettings(), settings)
        || options.store.getNativeRuntimeBinding().generation !== runtimeGeneration || sourceHome !== options.sourceWrenHome()
        || !isDeepStrictEqual(credentialEnvs.map((name) => proxy.keyFingerprint(name)), keys)) throw new StructuredRuntimeError("stale");
    };
    const verifyIdentity = () => {
      const current = verify();
      if (!current.verdict.ready || !current.launcher || !isDeepStrictEqual(current.pins, pins)) throw unavailable();
      return current.launcher;
    };
    const assertExecutableCurrent = () => { check(); for (const executable of [producer, loader, wren, node]) assertNativeExecutableIdentity(executable); verifyIdentity(); };
    assertExecutableCurrent();
    const root = await realpath(os.tmpdir());
    const steps = options.stepsRoot ?? defaultStepsRoot(root);
    ensureStepsRoot(steps);
    const queryFailure = createStructuredQueryFailureTracker();
    const vendor = createLocalPiProvider({ proxy, endpoints, authIdentity, generation: String(runtimeGeneration), accountLabel: "pi (this machine)", verifyIdentity,
      assertCurrent: check, assertExecutableCurrent, stepsRoot: steps,
      ...(options.list ? { list: options.list } : {}), ...(options.spawn ? { spawn: options.spawn } : {}), ...(options.onCleanup ? { onCleanup: options.onCleanup } : {}) });
    const wrenEnvironment = { PATH: [path.dirname(wren.executable), path.dirname(node.executable), "/usr/bin", "/bin"].join(path.delimiter), HOME: options.hostHome,
      WREN_HOME: sourceHome, WREN_PROJECT_HOME: capturedBinding.path, PYTHONNOUSERSITE: "1", PYTHONUTF8: "1", PYTHONDONTWRITEBYTECODE: "1" };
    const componentLimits = options.getComponentLimits?.();
    const prepared = await prepareCapturedStructuredAskHost(irDocument, { binding: identity.binding, entry: { kind: "agent", verb: "answer_query", prompt: input.options.question } }, {
      identity, currentIdentity: () => { check(); return identity; }, assertCurrent: check, verifierBinary: producer.executable, contextLoaderBinary: loader.executable,
      wrenBinary: wren.executable, project: capturedBinding.path, signal, assertExecutableCurrent, wrenEnvironment,
      // The local governed Wren path: the same `governed-stdio` worker local Codex and native `query` use; no OpenShell data worker is involved.
      openDataAccess: async (parent) => observeStructuredQueryAccess(await openWrenComponentAccess({ executable: wren.executable, project: capturedBinding.path,
        fingerprint: await hashDirectory(capturedBinding.path), signal: parent, environment: wrenEnvironment, assertExecutableCurrent }), queryFailure.record),
      ...(componentLimits ? { componentLimits } : {}),
      vendor, persistRoot: input.persistRoot, onEvent: (event) => {
        if (event.kind === "step.start") queryFailure.start();
        if (event.kind === "step.finish") queryFailure.finish(event.status);
        input.onEvent(event);
      },
    });
    check();
    const { root: rootId, plan } = await produceComponentHostPlan({ irDocument, prepared, producerBinary: producer.executable, signal, assertCurrent: check, assertExecutableCurrent });
    let runner: ComponentRunner | undefined; let active: Promise<unknown> | undefined; let started = false; let closing: Promise<void> | undefined;
    const host: LocalPiPreparedHost = {
      assertCurrent: check, assertExecutableCurrent,
      async run(request) {
        assertExecutableCurrent(); if (started || closing) throw new StructuredRuntimeError("failed"); started = true;
        const broker = await prepared.host(rootId, plan, signal);
        check();
        runner = new ComponentRunner(plan, { ...broker, async runStep(...args) {
          try { const response = await broker.runStep(...args); queryFailure.providerReturned(response.failed === true); return response; }
          catch (error) { if (isPiQueryAbort(error)) queryFailure.providerQueryAborted(); else queryFailure.providerRejected(); throw error; }
        } }, componentLimits);
        const pending = runner.run(rootId, { request }, signal); active = pending;
        // A change that nothing announces (a saved setting, a binding, a rotated key) is noticed within one tick and cancels the run as stale.
        let fault: unknown;
        const watch = setInterval(() => {
          if (fault !== undefined || signal.aborted) return;
          try { check(); } catch (error) { fault = error; runner?.cancel(); }
        }, options.watchMs ?? WATCH_MS);
        try {
          let result: Awaited<typeof pending>;
          try { result = await pending; } catch (error) { if (fault !== undefined) throw fault instanceof StructuredRuntimeError ? fault : new StructuredRuntimeError("stale"); throw error; }
          check();
          const failure = queryFailure.terminalFailure();
          if (result.status === "error" && result.code === "callee_failed" && failure && !runner.cleanupFailed) throw failure;
          return result;
        } finally { clearInterval(watch); active = undefined; }
      },
      dispose() {
        return closing ??= (async () => {
          if (active) runner?.cancel();
          await active?.catch(() => {});
          // Step cleanup (process proof, directory, grant) outlives a cancelled run: the Ask returns only after every step has proven it.
          try { await vendor.drain(); } catch { throw new StructuredRuntimeError("cleanup"); }
          if (runner?.cleanupFailed) throw new StructuredRuntimeError("cleanup");
        })();
      },
    };
    return host;
  };

  const adapter = createLocalPiStructuredAdapter({ probe, prepare });
  return {
    adapter, proxy,
    revoke() { epoch++; proxy.revokeAll(); },
    async shutdown() { epoch++; await proxy.close(); },
  };
}
