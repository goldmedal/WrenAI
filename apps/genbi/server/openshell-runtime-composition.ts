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
import { snapshotHash } from "./runtime-host/openshell-snapshot-driver.js";
import { openOpenShellWrenAccess } from "./runtime-host/openshell-wren-access.js";
import { OpenShellError } from "./runtime-host/openshell-types.js";

/** BFF-owned lifecycle seam. Deliberately supplies no model operation or browser command API. */
export async function createOpenShellRuntimeComposition(options: { env: NodeJS.ProcessEnv; store: Store; stateRoot: string; driver?: OpenShellDriver; currentProject?: () => string | undefined; currentContext?: () => string | undefined; claude?: { vaultRoot: string; duplex(intent: OpenShellIntent, argv: readonly string[], signal: AbortSignal): Promise<OpenShellDuplex> } }) {
  const config = readOpenShellConfiguration(options.env);
  const boot = !options.claude && config.configuration && config.selected ? readOpenShellClaudeBoot(options.env) : undefined;
  const claude = options.claude ?? (boot ? { vaultRoot: boot.descriptor.vaultRoot, duplex: boot.duplex } : undefined);
  const vault = claude ? new ClaudeAccountVault({ root: claude.vaultRoot }) : undefined;
  const composition = await compose({ ...options, ...(claude ? { claude } : {}) }, vault);
  if (boot && vault) {
    try { await verifyRetainedOpenShellClaudeBoot(vault, boot); }
    catch { /* Exact opt-in failure remains fenced/unready; never report private diagnostics. */ }
  }
  return { ...composition, claudeBoot: boot };
}

type CompositionOptions = Parameters<typeof createOpenShellRuntimeComposition>[0];
/** Trusted host test seam; no environment, browser or API chooses synthetic identity. */
export async function createOpenShellRuntimeCompositionForTesting(options: Omit<CompositionOptions, "claude"> & { claude: { vault: ClaudeAccountVault; sdkQueryForTesting?: import("./runtime-host/claude-component-step.js").ClaudeComponentRuntime["query"]; duplex: NonNullable<CompositionOptions["claude"]>["duplex"] } }) {
  return compose(options, options.claude.vault, options.claude.sdkQueryForTesting);
}
async function compose(options: Omit<CompositionOptions, "claude"> & { claude?: { duplex: NonNullable<CompositionOptions["claude"]>["duplex"] } }, vault: ClaudeAccountVault | undefined, sdkQueryForTesting?: import("./runtime-host/claude-component-step.js").ClaudeComponentRuntime["query"]) {
  const configuration = readOpenShellConfiguration(options.env);
  let lifecycle: OpenShellLifecycle | undefined;
  let snapshots: OpenShellProjectSnapshots | undefined;
  let runtimeEpoch = 0;
  const dataApprovals = new Map<string, () => void>();
  const approvalKey = (scope: import("./runtime-host/openshell-types.js").OpenShellIdentity) => JSON.stringify([scope.session, "turn" in scope ? scope.turn : null, scope.binding, scope.bindingGeneration, scope.bindingRevision, scope.context, scope.plan]);
  if (configuration.configuration) {
    const config = configuration.configuration;
    const driver = options.driver ?? new OpenShellCliDriver(config, (intent) => { if (!snapshots) throw new Error("Snapshot authority unavailable"); return snapshots.mount(intent); }, options.claude?.duplex);
    lifecycle = new OpenShellLifecycle({ driver, journal: options.store,
      stateRoot: options.stateRoot, exclusive: configuration.configuration.exclusive });
    if (config.snapshotCapture && config.dataPolicy && config.dataPolicyDigest) {
      snapshots = new OpenShellProjectSnapshots({ lifecycle, journal: options.store, driver: new DockerSnapshotDriver(config, (publication, name, id) => snapshots!.recordHelper(publication, name, id)), stateRoot: options.stateRoot,
        currentSource: snapshotSourceAuthority({ store: options.store, currentProject: options.currentProject ?? (() => undefined), approvedFiles: config.snapshotCapture.approvedFiles, currentContext: scope => { const approval = dataApprovals.get(approvalKey(scope)); if (!approval) return undefined; try { approval(); return options.currentContext ? options.currentContext() : scope.context; } catch { return undefined; } }, preserveProjectConfig: !!config.dataWorker }) });
      lifecycle.attachOwnedResources(snapshots);
    }
    try { await lifecycle.initialize(); } catch { /* startup ownership uncertainty remains unavailable */ }
  }
  const probe = (): Promise<RuntimeBackendProbeResult<"openshell">> => lifecycle?.probe() ?? Promise.resolve({
    readiness: runtimeNotReady("openshell", "unprovisioned", "openshell_configuration_invalid"), diagnostic: { phase: "provisioning" },
  });
  const adapter: StructuredAdapter = { vendor: "claude", backend: "openshell", probe: async () => (await probe()).readiness };
  return { selected: configuration.selected, lifecycle, snapshots, adapter, probe,
    dataWorkerAvailable: !!(configuration.configuration?.dataWorker && snapshots && options.claude),
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
    claudeProvider: (input: Omit<Parameters<typeof createOpenShellClaudeProvider>[0], "lifecycle" | "vault">) => {
      if (!lifecycle || !options.claude) throw new Error("OpenShell Claude unavailable");
      const epoch = runtimeEpoch;
      const assertCurrent = () => { if (epoch !== runtimeEpoch) throw new OpenShellError("openshell_scope_invalid"); input.assertCurrent(); };
      const guarded = { ...input, assertCurrent, lifecycle, vault: vault! };
      return sdkQueryForTesting ? createOpenShellClaudeProviderForTesting(guarded, sdkQueryForTesting) : createOpenShellClaudeProvider(guarded);
    },
    /** Ordinary runtime/binding changes fence owned work without deleting retained login. */
    revokeRuntime: () => { runtimeEpoch++; lifecycle?.revoke(); },
    /** Explicit account disconnection remains destructive credential revocation. */
    revoke: () => { runtimeEpoch++; try { vault?.disconnect(); } finally { lifecycle?.revoke(); } }, shutdown: async () => { runtimeEpoch++; try { await lifecycle?.shutdown(); } finally { vault?.close(); } } };
}

/** Resolve server-owned native selection against the active vendor binding. */
export function selectNativeRuntimeBackend(options: { vendor: "codex" | "claude" | undefined; codexBackend: "local" | "codex-app-server"; claudeOpenShell: boolean }): RuntimeBackendId {
  return options.claudeOpenShell && options.vendor !== "codex" ? "openshell" : options.codexBackend;
}
