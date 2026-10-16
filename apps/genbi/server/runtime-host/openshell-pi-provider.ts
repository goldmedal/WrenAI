import { randomBytes, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { StepRun } from "../../harness/components/runner.js";
import type { NativeComponentVendor } from "../native-component-runtime.js";
import type { OpenShellLease, OpenShellLifecycle } from "./openshell-lifecycle.js";
import { openShellIdentitySchema, type OpenShellIdentity } from "./openshell-types.js";
import { PiStepChannel, type PiCleanupReason } from "./pi-json-process.js";
import type { PiComponentRuntime } from "./pi-component-step.js";
import { PI_PROC_CHECK_ARGV, PI_WORKER_ARGV, PiProtocolFault, PiStepProtocol, buildPiBootstrap, piEndpointSchema, sha256Hex, type PiEndpointConfig, type PiStepSpec, type PiThinking } from "./pi-protocol.js";

/** Host configuration for the API-key vendor. No secret value is representable here: the key lives in the OpenShell provider. */
export interface PiProviderConfig {
  /** OpenShell provider name, as attached to the sandbox with `--provider`. */
  readonly provider: string;
  /** Fixed non-secret label surfaced as the account label. */
  readonly displayLabel: string;
  /** `sha256:` digest identifying the imported provider profile: the canonical form of the gateway's exported profile (see `canonicalGatewayProfileDigest`). */
  readonly profileDigest: string;
  /** Operator-owned credential generation token; bump it when the key is rotated. */
  readonly generation: string;
  readonly endpoint: PiEndpointConfig;
  readonly thinking?: PiThinking | undefined;
}
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const configSchema = z.object({ provider: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/), displayLabel: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/), profileDigest: digest,
  generation: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/), endpoint: piEndpointSchema, thinking: z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]).optional() }).strict();

/** Host-computed identity digest. Built from names and digests only; key bytes are never an input. */
export function piAccountDigest(config: Pick<PiProviderConfig, "provider" | "profileDigest" | "generation">): string {
  return `sha256:${sha256Hex(JSON.stringify({ v: 1, provider: config.provider, profileDigest: config.profileDigest, generation: config.generation }))}`;
}
export const piAccountLabel = (config: Pick<PiProviderConfig, "displayLabel">) => `pi (${config.displayLabel})`;

type Scope = Omit<Extract<OpenShellIdentity, { purpose: "model" }>, "purpose" | "operation" | "snapshot" | "invocation" | "step" | "attempt" | "model" | "tier">;
export interface PiCleanupReport { readonly reason: PiCleanupReason; readonly processes: "clear" | "residue" | "unavailable" | "timeout" | "not_checked"; readonly teardown: "proven" | "failed" }
export interface PiProviderOptions {
  lifecycle: OpenShellLifecycle;
  config: PiProviderConfig;
  /** Captured tier map; the step model must be one of its values. */
  models: Readonly<Record<string, string>>;
  scope: Scope;
  currentScope(): Scope | undefined;
  assertCurrent(): void;
  assertExecutableCurrent?(): void;
  /** Observation only: lets tests and probes record what cleanup proved. */
  onCleanup?(report: PiCleanupReport): void;
}
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
/** The check must leave most of the 15 s cleanup budget to the teardown, which is the hard proof. */
export const PI_PROC_CHECK_BUDGET_MS = 5000;

/** The ps-equivalent proof: reads /proc inside the sandbox through a non-duplex exec. Never throws; returns what it could establish. */
async function checkNoPiProcesses(lease: OpenShellLease): Promise<"clear" | "residue" | "unavailable" | "timeout"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<"timeout">(resolve => { timer = setTimeout(() => resolve("timeout"), PI_PROC_CHECK_BUDGET_MS); });
  try { return await Promise.race([scanProcesses(lease), expired]); } finally { clearTimeout(timer); }
}
async function scanProcesses(lease: OpenShellLease): Promise<"clear" | "residue" | "unavailable"> {
  const deadline = Date.now() + PI_PROC_CHECK_BUDGET_MS - 1000;
  let last: "residue" | "unavailable" = "unavailable";
  while (Date.now() < deadline) {
    try {
      const parsed = z.object({ type: z.literal("genbi.pi.procs"), version: z.literal(1), remaining: z.number().int().min(0) }).strict().parse(JSON.parse(await lease.exec([...PI_PROC_CHECK_ARGV])));
      if (parsed.remaining === 0) return "clear";
      last = "residue";
    } catch { return last; }
    await sleep(250);
  }
  return last;
}

export function createOpenShellPiProvider(options: PiProviderOptions): NativeComponentVendor & { vendor: "pi" } {
  const config = Object.freeze(configSchema.parse(structuredClone(options.config))) as Readonly<PiProviderConfig>;
  const scope = Object.freeze(structuredClone(options.scope)); const models = Object.freeze({ ...options.models });
  if (scope.account !== piAccountDigest(config) || scope.generation !== config.generation) throw new PiProtocolFault("protocol");
  const modelIdentity = options.lifecycle.modelIdentity;
  if (!modelIdentity || !isDeepStrictEqual({ image: scope.image, policy: scope.policy, gateway: scope.gateway, workspace: scope.workspace, configuration: scope.configuration }, modelIdentity)) throw new PiProtocolFault("protocol");
  const assertExecutableCurrent = options.assertExecutableCurrent ?? options.assertCurrent;
  const check = () => { options.assertCurrent(); if (!isDeepStrictEqual(scope, options.currentScope())) throw new PiProtocolFault("cancelled"); };
  const provider: NativeComponentVendor & { vendor: "pi" } = { vendor: "pi", authIdentity: scope.account, generation: scope.generation, accountEmail: piAccountLabel(config), models, assertCurrent: check,
    openStep(model: string, tier: string, signal: AbortSignal) { return provider.open(model, signal, tier); },
    async open(model: string, signal: AbortSignal, requestedTier?: string): Promise<PiComponentRuntime> {
      check(); signal.throwIfAborted();
      const tier = requestedTier ?? Object.keys(models).find(name => models[name] === model); if (!tier || models[tier] !== model) throw new PiProtocolFault("protocol");
      const step = randomUUID(), invocation = randomUUID();
      const identity = Object.freeze(openShellIdentitySchema.parse({ ...scope, purpose: "model", operation: "step", snapshot: "none", invocation, step, attempt: 1, model, tier })) as Extract<OpenShellIdentity, { purpose: "model" }>;
      let lease: OpenShellLease | undefined; let channel: PiStepChannel | undefined; let run: StepRun | undefined;
      const current = () => { try { check(); return identity; } catch { return undefined; } };
      const assertCurrent = () => { signal.throwIfAborted(); check(); lease?.assertActive(); };
      let closing: Promise<void> | undefined;
      const close = () => closing ??= channel ? channel.close() : (lease?.close() ?? Promise.resolve());
      try {
        assertExecutableCurrent();
        const permit = await options.lifecycle.prepareLaunch(identity, current, signal);
        try { lease = await options.lifecycle.launch(permit); } catch (error) { permit.release(); throw error; }
        assertCurrent();
        const owned = lease;
        const runtime: PiComponentRuntime = { vendor: "pi", model, tier, signal: AbortSignal.any([signal, owned.signal]), assertCurrent, assertExecutableCurrent,
          openStep(value, hooks) {
            assertCurrent(); assertExecutableCurrent(); if (run || channel || value.signal.aborted || value.tier !== tier || proofs.get(runtime)?.claimedRun !== value) throw new PiProtocolFault("protocol");
            run = value;
            const shimToken = randomBytes(16).toString("hex");
            const spec: PiStepSpec = { scope: step, model, ...(config.thinking ? { thinking: config.thinking } : {}), endpoint: config.endpoint,
              systemPrompt: [value.brief, value.prompt].filter(Boolean).join("\n\n"), tools: Object.keys(value.tools) };
            const protocol = new PiStepProtocol({ run: value, spec, token: shimToken, check: assertCurrent });
            const bootstrap = buildPiBootstrap(spec, shimToken);
            channel = new PiStepChannel({ signal: AbortSignal.any([signal, value.signal, owned.signal, hooks.signal]), protocol, bootstrap, check: assertCurrent,
              connect: () => owned.duplex([...PI_WORKER_ARGV]), onCall: hooks.onCall, onSettled: hooks.onSettled,
              async cleanup(reason) {
                // Cancellation proves absence twice: /proc inside the sandbox while it is still reachable (bounded, a hung exec is reported as a timeout and proves nothing), then the sandbox teardown itself.
                const processes = reason === "cancelled" ? await checkNoPiProcesses(owned) : "not_checked";
                try { await owned.close(); } catch (error) { options.onCleanup?.({ reason, processes, teardown: "failed" }); throw error; }
                options.onCleanup?.({ reason, processes, teardown: "proven" });
              } });
            return { channel, protocol };
          },
          close };
        proofs.set(runtime, { identity, claimed: false, check: assertCurrent, snapshot: fields(runtime) });
        return Object.freeze(runtime);
      } catch { await close(); throw new PiProtocolFault("protocol"); }
    },
  };
  return Object.freeze(provider);
}

type Proof = { identity: Readonly<Extract<OpenShellIdentity, { purpose: "model" }>>; claimed: boolean; claimedRun?: StepRun; check(): void; snapshot: readonly unknown[] };
const proofs = new WeakMap<PiComponentRuntime, Proof>();
const fields = (runtime: PiComponentRuntime) => [runtime.model, runtime.tier, runtime.signal, runtime.assertCurrent, runtime.assertExecutableCurrent, runtime.openStep, runtime.close] as const;
const fingerprint = (run: StepRun) => JSON.stringify({ tier: run.tier, request: run.request, brief: run.brief ?? null, prompt: run.prompt, input: run.input, consumes: run.consumes, schemas: run.toolSchemas, descriptions: run.toolDescriptions, names: Object.keys(run.tools), perSlot: run.perSlot ?? null });
const functions = (run: StepRun) => Object.values(run.tools);
/** Claims an exact provider-minted runtime once for one exact StepRun. No structural proof is accepted. */
export function claimPiHostRuntime(runtime: PiComponentRuntime, run: StepRun): { check(): void; afterClose(): void } {
  const proof = proofs.get(runtime); if (!proof || proof.claimed) throw new PiProtocolFault("protocol");
  proof.claimed = true; proof.claimedRun = run;
  const baseline = fingerprint(run), baselineFunctions = functions(run);
  const intact = () => fingerprint(run) === baseline && isDeepStrictEqual(functions(run), baselineFunctions) && fields(runtime).every((entry, index) => entry === proof.snapshot[index]);
  const check = () => { if (!intact() || run.tier !== proof.identity.tier || run.signal.aborted) throw new PiProtocolFault("protocol"); proof.check(); };
  check();
  return { check, afterClose() { if (!intact() || run.signal.aborted) throw new PiProtocolFault("protocol"); } };
}
