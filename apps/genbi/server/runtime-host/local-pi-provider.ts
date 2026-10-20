import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { spawn } from "node:child_process";
import type { StepRun } from "../../harness/components/runner.js";
import type { NativeComponentVendor } from "../native-component-runtime.js";
import type { LocalPiLauncher } from "./local-pi-install.js";
import type { LocalPiEndpoint } from "./local-pi-endpoint.js";
import type { LocalPiKeyProxy, ProxyGrant } from "./local-pi-key-proxy.js";
import { LocalPiStep, ensureStepSupport, type LocalPiCleanupReport, type ProcessRow } from "./local-pi-step.js";
import { PiStepChannel } from "./pi-json-process.js";
import type { PiComponentRuntime } from "./pi-component-step.js";
import { registerPiHostRuntime } from "./openshell-pi-provider.js";
import { PiProtocolFault, PiStepProtocol, buildPiBootstrap, PI_TRANSPORT_LIMITS, type PiStepSpec, type PiThinking } from "./pi-protocol.js";

/** The one environment variable pi reads its "API key" from. It carries the per-step proxy token and nothing else. */
export const LOCAL_PI_TOKEN_ENV = "GENBI_PI_STEP_TOKEN";
export const LOCAL_PI_PROVIDER_ID = "genbi-local";
export const PACKAGED_SHIM = fileURLToPath(new URL("../../runtime-assets/pi-worker/pi-mcp-shim.mjs", import.meta.url));

export interface LocalPiProviderOptions {
  readonly proxy: LocalPiKeyProxy;
  /** One endpoint per compiled tier, resolved from the saved Runtime when the Ask was prepared. */
  readonly endpoints: Readonly<Record<string, LocalPiEndpoint>>;
  readonly authIdentity: string;
  readonly generation: string;
  readonly accountLabel: string;
  /** Re-verifies the managed install and its certification; returns the launcher. Throws when anything differs. */
  verifyIdentity(): LocalPiLauncher;
  assertCurrent(): void;
  assertExecutableCurrent(): void;
  readonly stepsRoot: string;
  /** The node executable and the packaged relay to run pi's tool server with; they are exposed to pi through safe paths under the steps root. */
  readonly node?: string;
  readonly shim?: string;
  readonly thinking?: PiThinking;
  readonly list?: () => Promise<ProcessRow[]>;
  readonly spawn?: typeof spawn;
  onCleanup?(report: LocalPiCleanupReport): void;
}

export type LocalPiVendor = NativeComponentVendor & { vendor: "pi"; drain(): Promise<void> };
const DRAIN_MS = 20_000;

/** The local pi vendor: every step is a fresh host `pi --mode json` behind a per-step proxy grant. */
export function createLocalPiProvider(options: LocalPiProviderOptions): LocalPiVendor {
  const models = Object.freeze(Object.fromEntries(Object.entries(options.endpoints).map(([tier, endpoint]) => [tier, endpoint.model])));
  const nodeSource = options.node ?? process.execPath;
  const shimSource = options.shim ?? PACKAGED_SHIM;
  /** One entry per opened step until its cleanup has completed: a cancelled run returns before its step's cleanup, so the Ask waits here. */
  const lifetimes = new Set<Promise<void>>();
  const provider: LocalPiVendor = {
    async drain() {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const outcomes = await Promise.race([Promise.allSettled([...lifetimes]), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new PiProtocolFault("cleanup")), DRAIN_MS); })]);
        if (outcomes.some((outcome) => outcome.status === "rejected")) throw new PiProtocolFault("cleanup");
      } finally { clearTimeout(timer); }
    },
    vendor: "pi", authIdentity: options.authIdentity, generation: options.generation, accountEmail: options.accountLabel, models, assertCurrent: options.assertCurrent,
    openStep(model: string, tier: string, signal: AbortSignal) { return provider.open(model, signal, tier); },
    async open(model: string, signal: AbortSignal, requestedTier?: string): Promise<PiComponentRuntime> {
      options.assertCurrent(); signal.throwIfAborted();
      const tier = requestedTier ?? Object.keys(models).find((name) => models[name] === model);
      const endpoint = tier !== undefined && Object.hasOwn(options.endpoints, tier) ? options.endpoints[tier] : undefined;
      if (!tier || !endpoint || endpoint.model !== model || models[tier] !== model) throw new PiProtocolFault("protocol");
      let grant: ProxyGrant | undefined; let step: LocalPiStep | undefined; let channel: PiStepChannel | undefined; let run: StepRun | undefined;
      let closing: Promise<void> | undefined;
      let settle!: { resolve(): void; reject(error: unknown): void };
      const lifetime = new Promise<void>((resolve, reject) => { settle = { resolve, reject }; });
      lifetime.catch(() => {}); lifetimes.add(lifetime); void lifetime.then(() => lifetimes.delete(lifetime), () => {});
      const assertCurrent = () => { signal.throwIfAborted(); options.assertCurrent(); if (grant && !grant.active) throw new PiProtocolFault("cancelled"); };
      const close = () => closing ??= (async () => {
        if (channel) { await channel.close(); return; }
        try { if (step) { const report = await step.cleanup("cancelled"); options.onCleanup?.(report); } } finally { grant?.revoke(); }
      })().then(settle.resolve, (error: unknown) => { settle.reject(error); throw error; });
      try {
        options.assertExecutableCurrent();
        if (!options.proxy.hasKey(endpoint.credentialEnv)) throw new PiProtocolFault("protocol");
        const launcher = options.verifyIdentity();
        const { node, shim } = ensureStepSupport(options.stepsRoot, nodeSource, shimSource);
        grant = await options.proxy.grant({ api: endpoint.api, upstream: endpoint.upstream, credentialEnv: endpoint.credentialEnv }, PI_TRANSPORT_LIMITS.deadlineMs + 30_000);
        assertCurrent();
        const scopeId = randomUUID();
        const runtime: PiComponentRuntime = { vendor: "pi", model, tier, signal, assertCurrent, assertExecutableCurrent: () => { options.assertExecutableCurrent(); options.verifyIdentity(); },
          openStep(value, hooks) {
            assertCurrent(); runtime.assertExecutableCurrent!();
            if (run || channel || value.signal.aborted || value.tier !== tier) throw new PiProtocolFault("protocol");
            run = value;
            const shimToken = randomBytes(16).toString("hex");
            const spec: PiStepSpec = { scope: scopeId, model, ...(options.thinking ? { thinking: options.thinking } : {}),
              endpoint: { providerId: LOCAL_PI_PROVIDER_ID, api: endpoint.api, baseUrl: grant!.baseUrl, credentialEnv: LOCAL_PI_TOKEN_ENV },
              systemPrompt: [value.brief, value.prompt].filter(Boolean).join("\n\n"), tools: Object.keys(value.tools), stepsRoot: options.stepsRoot, runtime: { node, shim } };
            const protocol = new PiStepProtocol({ run: value, spec, token: shimToken, check: assertCurrent });
            const bootstrap = buildPiBootstrap(spec, shimToken);
            step = new LocalPiStep({ stepsRoot: options.stepsRoot, launcher, node, shim, token: grant!.token, revokeGrant: () => grant!.revoke(),
              ...(options.list ? { list: options.list } : {}), ...(options.spawn ? { spawn: options.spawn } : {}) });
            const owned = step;
            channel = new PiStepChannel({ signal: AbortSignal.any([signal, value.signal, hooks.signal]), protocol, bootstrap, check: assertCurrent,
              connect: async () => owned.duplex, onCall: hooks.onCall, onSettled: hooks.onSettled,
              async cleanup(reason) { const report = await owned.cleanup(reason); options.onCleanup?.(report); } });
            return { channel, protocol };
          },
          close };
        registerPiHostRuntime(runtime, { tier, check: assertCurrent });
        return Object.freeze(runtime);
      } catch (error) { await close().catch(() => {}); throw error instanceof PiProtocolFault ? error : new PiProtocolFault("protocol"); }
    },
  };
  return Object.freeze(provider);
}
