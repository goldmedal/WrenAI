import { createOpenShellClaudeProvider, createOpenShellClaudeProviderForTesting } from "./runtime-host/openshell-claude-provider.js";
import { ClaudeAccountVault } from "./runtime-host/claude-account-vault.js";
import type { OpenShellDuplex, OpenShellIntent, OpenShellDriver } from "./runtime-host/openshell-types.js";
import type { Store } from "./db.js";
import type { StructuredAdapter } from "./structured-runtime.js";
import { OpenShellCliDriver, readOpenShellConfiguration } from "./runtime-host/openshell-driver.js";
import { OpenShellLifecycle } from "./runtime-host/openshell-lifecycle.js";
import { runtimeNotReady } from "./runtime-host/policy.js";
import type { RuntimeBackendId, RuntimeBackendProbeResult } from "./runtime-host/types.js";
import { DockerSnapshotDriver } from "./runtime-host/openshell-snapshot-driver.js";
import { OpenShellProjectSnapshots, snapshotSourceAuthority } from "./runtime-host/openshell-project-snapshots.js";
import { readOpenShellClaudeBoot, verifyRetainedOpenShellClaudeBoot } from "./runtime-host/openshell-claude-boot.js";
import { readOpenShellPiBoot, piProviderConfig, type OpenShellModelVendor, type OpenShellPiBoot } from "./runtime-host/openshell-pi-boot.js";
import { createPiGatewayVerifier, type PiGatewayVerifier } from "./runtime-host/openshell-pi-gateway.js";
import { createPiCertificationGate, requirePiCertification, type PiCertificationGate, type PiGateOptions } from "./runtime-host/openshell-pi-identity.js";
import { createOpenShellPiProvider, type PiProviderOptions } from "./runtime-host/openshell-pi-provider.js";
import { snapshotHash } from "./runtime-host/openshell-snapshot-driver.js";
import { openOpenShellWrenAccess } from "./runtime-host/openshell-wren-access.js";
import { OpenShellError } from "./runtime-host/openshell-types.js";
import { isBackendOffered, type RuntimeSelection } from "./runtime-selection.js";
import { exchangeWithValidator } from "./runtime-host/openshell-validator-client.js";
import type { SnapshotManifest } from "./runtime-host/openshell-snapshot-types.js";

/**
 * One published snapshot plus, on demand, the credential-less validator sandbox over it. Host review reads go through the
 * manifest-verified source; the validator is launched only by `validate`, never by opening the session.
 */
export interface ValidatorSession {
  readonly digest: string;
  readonly manifest: SnapshotManifest;
  readonly validator: { readonly script: string; readonly wheel: string; readonly toolchain: string; readonly architecture: string; readonly protocol: string; readonly image: string; readonly policy: string };
  readSource(relative: string, maxBytes: number): Buffer | undefined;
  validate(request: Buffer, timeoutMs: number): Promise<Buffer>;
  close(): Promise<void>;
}

/** Outcome of the boot-time gateway proof; only a pi boot has one. */
export type PiBootVerification = { readonly ok: boolean; readonly code?: string } | undefined;
/** A pi boot's protected descriptor and the read-only gateway verification bound to it. */
export interface OpenShellPiRuntime {
  readonly boot: OpenShellPiBoot;
  /** Read-only proof; for a boot this module composes it also requires the certified identity, so a mid-run drift revokes the run. */
  readonly verifyGateway: PiGatewayVerifier;
  /** The certification gate readiness reports through. Absent only on the trusted host test seam, which supplies its own `verifyGateway`. */
  readonly certify?: PiCertificationGate;
}

/** BFF-owned lifecycle seam. Deliberately supplies no model operation or browser command API. The selection names the one model backend this boot serves. */
export async function createOpenShellRuntimeComposition(options: { env: NodeJS.ProcessEnv; selection: RuntimeSelection; store: Store; stateRoot: string; driver?: OpenShellDriver; currentProject?: () => string | undefined; currentContext?: () => string | undefined; claude?: { vaultRoot: string; duplex(intent: OpenShellIntent, argv: readonly string[], signal: AbortSignal): Promise<OpenShellDuplex> };
  /** Trusted host test seam; no environment, browser or API chooses it. */
  pi?: OpenShellPiRuntime;
  /** Trusted host test seam for the certification gate's rows, host tuple and readers; production passes nothing. */
  piCertification?: Partial<Pick<PiGateOptions, "rows" | "installed" | "host" | "readPins" | "readFile" | "run">>;
  /** Trusted host test seam for the read-only gateway proof; production passes nothing and the real verifier runs. The certification requirement wraps it either way. */
  piGatewayProof?: PiGatewayVerifier }) {
  const config = readOpenShellConfiguration(options.env, options.selection);
  if (options.selection.runtime === "openshell" && isBackendOffered(options.selection, "pi")) return composePi(options, config);
  const boot = !options.claude && config.configuration && config.selected ? readOpenShellClaudeBoot(options.env, options.selection) : undefined;
  const claude = options.claude ?? (boot ? { vaultRoot: boot.descriptor.vaultRoot, duplex: boot.duplex } : undefined);
  const vault = claude ? new ClaudeAccountVault({ root: claude.vaultRoot }) : undefined;
  const composition = await compose({ ...options, ...(claude ? { claude } : {}) }, vault);
  if (boot && vault) {
    try { await verifyRetainedOpenShellClaudeBoot(vault, boot); }
    catch { /* Exact opt-in failure remains fenced/unready; never report private diagnostics. */ }
  }
  return { ...composition, claudeBoot: boot, bootVerification: undefined as PiBootVerification };
}

/** A pi boot reads only the pi descriptor; no Claude descriptor, vault or SDK session is opened. */
async function composePi(options: CompositionOptions, config: ReturnType<typeof readOpenShellConfiguration>) {
  const driverConfiguration = config.configuration;
  // The driver is single-vendor: a pi boot needs the pi block and no Claude model block, or `modelIdentity` would name the wrong image.
  const usable = !!driverConfiguration?.pi && !driverConfiguration.model;
  const runtime: OpenShellPiRuntime | undefined = !usable ? undefined : options.pi ?? (() => {
    const boot = readOpenShellPiBoot(options.env, options.selection);
    if (!boot || boot.descriptor.provider !== driverConfiguration!.pi!.provider) return undefined;
    const verifyGateway = options.piGatewayProof ?? createPiGatewayVerifier({ configuration: driverConfiguration!, descriptor: boot.descriptor });
    const certify = createPiCertificationGate({ configuration: driverConfiguration!, descriptor: boot.descriptor, ...options.piCertification });
    return { boot, certify, verifyGateway: requirePiCertification(verifyGateway, certify) };
  })();
  const composition = await compose({ ...options, env: usable ? options.env : { ...options.env, GENBI_OPENSHELL_CONFIG: "" } }, undefined, undefined, { vendor: "pi", ...(runtime ? { pi: runtime } : {}) });
  let bootVerification: PiBootVerification = { ok: false, code: "openshell_configuration_invalid" };
  if (runtime) {
    try { await runtime.verifyGateway(); bootVerification = { ok: true }; }
    catch (error) {
      bootVerification = { ok: false, code: error instanceof OpenShellError ? error.code : "openshell_configuration_invalid" };
      process.stderr.write(`warning: pi OpenShell gateway verification failed at boot (${bootVerification.code})\n`);
    }
  }
  return { ...composition, claudeBoot: undefined, bootVerification };
}

type CompositionOptions = Parameters<typeof createOpenShellRuntimeComposition>[0];
/** Trusted host test seam; no environment, browser or API chooses synthetic identity. */
export async function createOpenShellRuntimeCompositionForTesting(options: Omit<CompositionOptions, "claude"> & { claude: { vault: ClaudeAccountVault; sdkQueryForTesting?: import("./runtime-host/claude-component-step.js").ClaudeComponentRuntime["query"]; duplex: NonNullable<CompositionOptions["claude"]>["duplex"] } }) {
  return compose(options, options.claude.vault, options.claude.sdkQueryForTesting);
}
async function compose(options: Omit<CompositionOptions, "claude"> & { claude?: { duplex: NonNullable<CompositionOptions["claude"]>["duplex"] } }, vault: ClaudeAccountVault | undefined, sdkQueryForTesting?: import("./runtime-host/claude-component-step.js").ClaudeComponentRuntime["query"],
  model: { readonly vendor: OpenShellModelVendor; readonly pi?: OpenShellPiRuntime } = { vendor: "claude" }) {
  const configuration = readOpenShellConfiguration(options.env, options.selection);
  const pi = model.pi;
  const duplex = options.claude?.duplex ?? pi?.boot.duplex;
  let lifecycle: OpenShellLifecycle | undefined;
  let snapshots: OpenShellProjectSnapshots | undefined;
  let runtimeEpoch = 0;
  const dataApprovals = new Map<string, () => void>();
  const approvalKey = (scope: import("./runtime-host/openshell-types.js").OpenShellIdentity) => JSON.stringify([scope.session, "turn" in scope ? scope.turn : null, scope.binding, scope.bindingGeneration, scope.bindingRevision, scope.context, scope.plan]);
  if (configuration.configuration) {
    const config = configuration.configuration;
    const driver = options.driver ?? new OpenShellCliDriver(config, (intent) => { if (!snapshots) throw new Error("Snapshot authority unavailable"); return snapshots.mount(intent); }, duplex);
    lifecycle = new OpenShellLifecycle({ driver, journal: options.store,
      stateRoot: options.stateRoot, exclusive: configuration.configuration.exclusive });
    if (config.snapshotCapture && config.dataPolicy && config.dataPolicyDigest) {
      snapshots = new OpenShellProjectSnapshots({ lifecycle, journal: options.store, driver: new DockerSnapshotDriver(config, (publication, name, id) => snapshots!.recordHelper(publication, name, id)), stateRoot: options.stateRoot,
        currentSource: snapshotSourceAuthority({ store: options.store, currentProject: options.currentProject ?? (() => undefined), approvedFiles: config.snapshotCapture.approvedFiles, currentContext: scope => { const approval = dataApprovals.get(approvalKey(scope)); if (!approval) return undefined; try { approval(); return options.currentContext ? options.currentContext() : scope.context; } catch { return undefined; } }, preserveProjectConfig: !!config.dataWorker }) });
      lifecycle.attachOwnedResources(snapshots);
    }
    try { await lifecycle.initialize(); } catch { /* startup ownership uncertainty remains unavailable */ }
  }
  const probe = async (): Promise<RuntimeBackendProbeResult<"openshell">> => {
    if (!((model.vendor === "claude" || pi) && lifecycle)) return { readiness: runtimeNotReady("openshell", "unprovisioned", "openshell_configuration_invalid"), diagnostic: { phase: "provisioning" } };
    const result = await lifecycle.probe();
    if (result.readiness.state !== "ready" || !pi?.certify) return result;
    // A pi boot is ready only with a certified row for the exact image, policy, profile and OpenShell build; Claude's readiness is not gated here.
    let verdict: Awaited<ReturnType<PiCertificationGate>>;
    try { verdict = await pi.certify(); } catch { verdict = { ready: false, code: "runtime_probe_failed" }; }
    if (verdict.ready) return result;
    return { readiness: runtimeNotReady("openshell", verdict.code === "runtime_probe_failed" ? "unavailable" : "incompatible", verdict.code),
      diagnostic: { phase: "identity", ...("drift" in verdict && verdict.drift ? { drift: verdict.drift } : {}) } as RuntimeBackendProbeResult<"openshell">["diagnostic"] };
  };
  const adapter: StructuredAdapter = { vendor: model.vendor, backend: "openshell", probe: async () => (await probe()).readiness };
  return { selected: configuration.selected, modelVendor: model.vendor, piBoot: pi?.boot, verifyPiGateway: pi?.verifyGateway, lifecycle, snapshots, adapter, probe,
    dataWorkerAvailable: !!(configuration.configuration?.dataWorker && snapshots && (options.claude || pi)),
    /** Fail closed: the validator needs the protected data worker, snapshot authority and a verified validator descriptor. */
    validatorAvailable: () => !!(configuration.configuration?.dataWorker?.validator && snapshots && lifecycle?.validatorReady && lifecycle.dataIdentity),
    /** Read-only copy of the operator's approved snapshot file list, so Apply can prove the tree still equals what was reviewed. Never widens it. */
    applyInventory: (): { readonly approvedFiles: readonly string[]; readonly preserveProjectConfig: boolean } | undefined => {
      const capture = configuration.configuration?.snapshotCapture;
      return capture ? { approvedFiles: Object.freeze([...capture.approvedFiles]), preserveProjectConfig: !!configuration.configuration?.dataWorker } : undefined;
    },
    /** Explicit protected operator call, never an HTTP/browser enrollment route. */
    claudeVault: vault,
    /** Host-captured component preparation alone calls this; no browser tool exposes it. */
    bindDataContext(context: string, assertCurrent: () => void) {
      assertCurrent(); const epoch = runtimeEpoch;
      return async (scope: Omit<Extract<import("./runtime-host/openshell-types.js").OpenShellIdentity, { purpose: "lifecycle" }>, "purpose" | "operation" | "snapshot" | "image" | "policy" | "gateway" | "workspace" | "configuration">, signal: AbortSignal) => {
        const config = configuration.configuration;
        if (!snapshots || !lifecycle || !config?.dataWorker || !lifecycle.dataIdentity) throw new OpenShellError("openshell_unavailable");
        const check = () => { signal.throwIfAborted(); assertCurrent(); if (epoch !== runtimeEpoch || scope.context !== context) throw new OpenShellError("openshell_scope_invalid"); };
        check();
        const identity = { ...scope, binding: snapshotHash(scope.binding), ...lifecycle.identity, purpose: "lifecycle" as const, operation: "worker" as const, snapshot: "none" as const };
        const current = () => { try { check(); return identity; } catch { return undefined; } };
        const key = approvalKey(identity);
        if (dataApprovals.has(key)) throw new OpenShellError("openshell_scope_invalid");
        dataApprovals.set(key, check);
        let publicationPermit: Awaited<ReturnType<OpenShellProjectSnapshots["preparePublication"]>>;
        try { publicationPermit = await snapshots.preparePublication(identity, current, signal); } catch (error) { dataApprovals.delete(key); throw error; }
        let publication: Awaited<ReturnType<typeof snapshots.publish>> | undefined;
        let delivery: Awaited<ReturnType<OpenShellProjectSnapshots["prepareDelivery"]>> | undefined;
        let lease: Awaited<ReturnType<typeof snapshots.deliver>> | undefined;
        try {
          publication = await snapshots.publish(publicationPermit); check();
          delivery = await snapshots.prepareDelivery(publication, identity, current, signal);
          lease = await snapshots.deliver(delivery);
          check();
          const expected = { worker: "genbi-wren-worker/1" as const, snapshot: publication.digest, script: config.dataWorker.script, wheel: config.dataWorker.wheel, toolchain: config.dataWorker.toolchain, architecture: config.dataWorker.architecture, protocol: config.dataWorker.protocol };
          const access = await openOpenShellWrenAccess({ lease, expected, signal, assertCurrent: check });
          let closing: Promise<void> | undefined;
          return { ...access, close: () => closing ??= (async () => { try { await access.close(); await snapshots!.remove(publication!.id); } finally { delivery!.release(); dataApprovals.delete(key); } })() };
        } catch (error) {
          delivery?.release(); dataApprovals.delete(key); await lease?.close(); if (publication) await snapshots.remove(publication.id); throw error;
        } finally { publicationPermit.release(); }
      };
    },
    /**
     * Enrichment validation context (host only, never a browser or model tool). Publishes the current snapshot, then lets the host
     * review it and, only if the host check passes, launch the credential-less validator over that same published snapshot.
     */
    bindValidatorContext(context: string, assertCurrent: () => void) {
      assertCurrent(); const epoch = runtimeEpoch;
      return async (scope: Omit<Extract<import("./runtime-host/openshell-types.js").OpenShellIdentity, { purpose: "lifecycle" }>, "purpose" | "operation" | "snapshot" | "image" | "policy" | "gateway" | "workspace" | "configuration">, signal: AbortSignal): Promise<ValidatorSession> => {
        const config = configuration.configuration;
        if (!snapshots || !lifecycle || !config?.dataWorker?.validator || !lifecycle.dataIdentity || !lifecycle.validatorReady) throw new OpenShellError("openshell_unavailable");
        const worker = config.dataWorker, descriptor = worker.validator!;
        const check = () => { signal.throwIfAborted(); assertCurrent(); if (epoch !== runtimeEpoch || scope.context !== context) throw new OpenShellError("openshell_scope_invalid"); };
        check();
        const identity = { ...scope, binding: snapshotHash(scope.binding), ...lifecycle.identity, purpose: "lifecycle" as const, operation: "worker" as const, snapshot: "none" as const };
        const current = () => { try { check(); return identity; } catch { return undefined; } };
        const key = approvalKey(identity);
        if (dataApprovals.has(key)) throw new OpenShellError("openshell_scope_invalid");
        dataApprovals.set(key, check);
        let publicationPermit: Awaited<ReturnType<OpenShellProjectSnapshots["preparePublication"]>>;
        try { publicationPermit = await snapshots.preparePublication(identity, current, signal); } catch (error) { dataApprovals.delete(key); throw error; }
        let publication: Awaited<ReturnType<typeof snapshots.publish>> | undefined;
        let delivery: Awaited<ReturnType<OpenShellProjectSnapshots["prepareValidatorDelivery"]>> | undefined;
        let lease: Awaited<ReturnType<typeof snapshots.deliverValidator>> | undefined;
        let closing: Promise<void> | undefined;
        const release = () => closing ??= (async () => {
          try { await lease?.close(); if (publication) await snapshots!.remove(publication.id); } finally { delivery?.release(); dataApprovals.delete(key); }
        })();
        try {
          publication = await snapshots.publish(publicationPermit); check();
          const published = publication, manifest = snapshots.manifest(published);
          return { digest: published.digest, manifest,
            validator: { script: descriptor.script, wheel: worker.wheel, toolchain: worker.toolchain, architecture: worker.architecture, protocol: descriptor.protocol, image: lifecycle.dataIdentity.image, policy: lifecycle.dataIdentity.policy },
            readSource: (relative, maxBytes) => { check(); return snapshots!.readSource(published, relative, maxBytes); },
            async validate(request, timeoutMs) {
              check();
              if (delivery || lease) throw new OpenShellError("openshell_scope_invalid");
              delivery = await snapshots!.prepareValidatorDelivery(published, identity, current, signal);
              lease = await snapshots!.deliverValidator(delivery); check();
              const expected = { worker: "genbi-wren-validator/1" as const, snapshot: published.digest, script: descriptor.script, wheel: worker.wheel, toolchain: worker.toolchain, architecture: worker.architecture, protocol: descriptor.protocol };
              return exchangeWithValidator({ lease, expected, request, signal, assertCurrent: check, timeoutMs });
            },
            close: release };
        } catch (error) {
          try { await release(); } catch { /* durable cleanup retry owns uncertainty */ }
          throw error;
        } finally { publicationPermit.release(); }
      };
    },
    claudeProvider: (input: Omit<Parameters<typeof createOpenShellClaudeProvider>[0], "lifecycle" | "vault">) => {
      if (!lifecycle || !options.claude) throw new Error("OpenShell Claude unavailable");
      const epoch = runtimeEpoch;
      const assertCurrent = () => { if (epoch !== runtimeEpoch) throw new OpenShellError("openshell_scope_invalid"); input.assertCurrent(); };
      const guarded = { ...input, assertCurrent, lifecycle, vault: vault! };
      return sdkQueryForTesting ? createOpenShellClaudeProviderForTesting(guarded, sdkQueryForTesting) : createOpenShellClaudeProvider(guarded);
    },
    /** Host-captured pi step provider; the operator-provisioned provider and profile are only named here, never created. */
    piProvider: (input: Omit<PiProviderOptions, "lifecycle" | "config">) => {
      if (!lifecycle || !pi) throw new Error("OpenShell pi unavailable");
      const epoch = runtimeEpoch;
      const assertCurrent = () => { if (epoch !== runtimeEpoch) throw new OpenShellError("openshell_scope_invalid"); input.assertCurrent(); };
      return createOpenShellPiProvider({ ...input, assertCurrent, lifecycle, config: piProviderConfig(pi.boot.descriptor) });
    },
    /** Ordinary runtime/binding changes fence owned work without deleting retained login. */
    revokeRuntime: () => { runtimeEpoch++; lifecycle?.revoke(); },
    /** Explicit account disconnection remains destructive credential revocation. */
    revoke: () => { runtimeEpoch++; try { vault?.disconnect(); } finally { lifecycle?.revoke(); } }, shutdown: async () => { runtimeEpoch++; try { await lifecycle?.shutdown(); } finally { vault?.close(); } } };
}

/** Resolve server-owned native selection: the runtime decides, and an OpenShell boot never falls back to a host backend. */
export function selectNativeRuntimeBackend(options: { selection: RuntimeSelection; codexBackend: "local" | "codex-app-server" }): RuntimeBackendId {
  return options.selection.runtime === "openshell" ? "openshell" : options.codexBackend;
}
