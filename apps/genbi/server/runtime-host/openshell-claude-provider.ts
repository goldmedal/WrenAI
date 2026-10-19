import { createStructuredComponentTiming, recordAdmittedTimingResult, type StructuredComponentTiming, type StructuredTimingRecorder } from "../structured-timing.js";
import { query, type SpawnOptions } from "@anthropic-ai/claude-agent-sdk";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { StepRun } from "../../harness/components/runner.js";
import type { NativeComponentVendor } from "../native-component-runtime.js";
import type { ClaudeComponentRuntime } from "./claude-component-step.js";
import { assertActualVault, assertVaultLeaseAfterClose, assertVaultLease, type ClaudeAccountLease, type ClaudeAccountVault } from "./claude-account-vault.js";
import { openShellIdentitySchema, type OpenShellIdentity } from "./openshell-types.js";
import type { OpenShellLifecycle, OpenShellLease } from "./openshell-lifecycle.js";
import { claimOpenShellSessionStep, type OpenShellModelSession } from "./openshell-model-session.js";
import { ClaudeDuplexProcess } from "./claude-duplex-process.js";
import { ClaudeRawProtocol, ClaudeProtocolFault } from "./claude-protocol.js";

const environment = Object.freeze({ PATH: "/usr/local/bin:/usr/bin:/bin", HOME: "/sandbox/home", CLAUDE_CONFIG_DIR: "/sandbox/config", TMPDIR: "/sandbox/tmp", LANG: "C.UTF-8" });
function admitSpawn(spawn: SpawnOptions, model: string, run: StepRun, cwd = "/sandbox", env: Readonly<Record<string, string>> = environment): void {
  if (spawn.command !== "/opt/genbi/claude" || spawn.cwd !== cwd || !isDeepStrictEqual(spawn.env, { ...env, CLAUDE_CODE_ENTRYPOINT: "sdk-ts", CLAUDE_AGENT_SDK_VERSION: "0.3.259" })) throw new ClaudeProtocolFault("protocol");
  const expected = new Map<string, string>([["--output-format", "stream-json"], ["--input-format", "stream-json"], ["--max-turns", "12"], ["--model", model], ["--tools", ""], ["--permission-mode", "default"]]);
  const single = new Set(["--verbose", "--setting-sources=", "--no-session-persistence", "--strict-mcp-config", "--disable-slash-commands"]);
  const seen = new Set<string>();
  for (let index = 0; index < spawn.args.length; index++) {
    const flag = spawn.args[index]!; if (seen.has(flag)) throw new ClaudeProtocolFault("protocol"); seen.add(flag);
    if (single.has(flag)) continue;
    const value = spawn.args[++index]; if (value === undefined) throw new ClaudeProtocolFault("protocol");
    if (expected.has(flag)) { if (value !== expected.get(flag)) throw new ClaudeProtocolFault("protocol"); }
    else if (flag === "--permission-prompt-tool") { if (value !== "stdio") throw new ClaudeProtocolFault("protocol"); }
    else if (flag === "--system-prompt") { if (value !== [run.brief, run.prompt].filter(Boolean).join("\n\n")) throw new ClaudeProtocolFault("protocol"); }
    else if (flag === "--allowedTools") { if (value !== Object.keys(run.tools).map(name => `mcp__component__${name}`).join(",")) throw new ClaudeProtocolFault("protocol"); }
    else if (flag === "--mcp-config") { if (!isDeepStrictEqual(JSON.parse(value), { mcpServers: { component: { type: "sdk", name: "component" } } })) throw new ClaudeProtocolFault("protocol"); }
    else throw new ClaudeProtocolFault("protocol");
  }
  for (const flag of [...single, ...expected.keys()]) if (!seen.has(flag)) throw new ClaudeProtocolFault("protocol");
}
/** Internal provider; scope and tier map come from the server, never worker correlation. */
type ProviderOptions =  { lifecycle: OpenShellLifecycle; vault: ClaudeAccountVault; models: Readonly<Record<string, string>>;
  timing?: StructuredTimingRecorder;
  modelSession?: OpenShellModelSession;
  scope: Omit<Extract<OpenShellIdentity, { purpose: "model" }>, "purpose" | "operation" | "snapshot" | "invocation" | "step" | "attempt" | "model" | "tier">;
  currentScope(): ProviderOptions["scope"] | undefined; assertCurrent(): void;
  /** Full native executable check at server-owned execution boundaries. */
  assertExecutableCurrent?(): void;
};
export function createOpenShellClaudeProvider(options: ProviderOptions): NativeComponentVendor & { vendor: "claude" } { return providerWithQuery(options, query); }
/** Explicit trusted direct SDK instrumentation seam; never selected by production input. */
export function createOpenShellClaudeProviderForTesting(options: ProviderOptions, sdkQuery: ClaudeComponentRuntime["query"]): NativeComponentVendor & { vendor: "claude" } { return providerWithQuery(options, sdkQuery); }
function providerWithQuery(options: ProviderOptions, sdkQuery: ClaudeComponentRuntime["query"]): NativeComponentVendor & { vendor: "claude" } {
  assertActualVault(options.vault);
  const scope = Object.freeze(structuredClone(options.scope)); const models = Object.freeze({ ...options.models });
  const status = options.vault.status();
  if (status.state !== "verified" || status.fingerprint !== scope.account || status.generation !== scope.generation) throw new ClaudeProtocolFault("protocol");
  // Test/non-OpenShell callers retain their existing currentness contract.
  const assertExecutableCurrent = options.assertExecutableCurrent ?? options.assertCurrent;
  const check = () => { options.assertCurrent(); if (!isDeepStrictEqual(scope, options.currentScope()) || !isDeepStrictEqual(options.vault.status(), status)) throw new ClaudeProtocolFault("cancelled"); };
  const provider: NativeComponentVendor & { vendor: "claude" } = { vendor: "claude", authIdentity: scope.account, generation: scope.generation, accountEmail: options.vault.verifiedIdentity().email, models, assertCurrent: check,
    openStep(model: string, tier: string, signal: AbortSignal) { return provider.open(model, signal, tier); },
    async open(model: string, signal: AbortSignal, requestedTier?: string): Promise<ClaudeComponentRuntime> {
      check(); signal.throwIfAborted();
      const tier = requestedTier ?? Object.keys(models).find(tier => models[tier] === model); if (!tier || models[tier] !== model) throw new ClaudeProtocolFault("protocol");
      const step = randomUUID(); const invocation = randomUUID();
      const identity = Object.freeze(openShellIdentitySchema.parse({ ...scope, purpose: "model", operation: "step", snapshot: "none", invocation, step, attempt: 1, model, tier })) as Extract<OpenShellIdentity, { purpose: "model" }>;
      const account = await options.vault.lease(scope.account, scope.generation);
      const authoritySignal = AbortSignal.any([signal, account.signal]);
      let lease: OpenShellLease | undefined; let sessionStep: ReturnType<typeof claimOpenShellSessionStep> | undefined; let process: ClaudeDuplexProcess | undefined; let protocol: ClaudeRawProtocol | undefined; let run: StepRun | undefined;
      const current = () => { try { check(); account.assertCurrent(); return identity; } catch { return undefined; } };
      const assertCurrent = () => { authoritySignal.throwIfAborted(); check(); account.assertCurrent(); lease?.assertActive(); sessionStep?.assertActive(); };
      let closing: Promise<void> | undefined;
      const close = () => closing ??= (async () => { try { if (process) await process.close(); else if (sessionStep) await sessionStep.close(); else await lease?.close(); } finally { account.release(); } })();
      try {
        assertExecutableCurrent();
        if (options.modelSession) sessionStep = claimOpenShellSessionStep(options.modelSession, identity);
        else {
          const permit = await options.lifecycle.prepareLaunch(identity, current, authoritySignal);
          try { lease = await options.lifecycle.launch(permit); } catch (error) { permit.release(); throw error; }
        }
        assertCurrent();
        const timing = createStructuredComponentTiming(options.timing);
        const stepRoot = `/sandbox/steps/${step}`;
        const cwd = sessionStep ? `${stepRoot}/work` : "/sandbox";
        const env = sessionStep ? Object.freeze({ ...environment, HOME: `${stepRoot}/home`, CLAUDE_CONFIG_DIR: `${stepRoot}/config`, TMPDIR: `${stepRoot}/tmp` }) : environment;
        const runtime: ClaudeComponentRuntime = { ...(timing ? { timing } : {}), cwd, executable: "/opt/genbi/claude", model, signal: AbortSignal.any([authoritySignal, (sessionStep ?? lease!).signal]), account: Object.freeze({ email: account.identity.email, tokenSource: "CLAUDE_CODE_OAUTH_TOKEN", subscriptionType: labels[account.identity.subscription] }), environment: env, query: sdkQuery,
          assertExecutableCurrent,
          admitStep(value) { assertExecutableCurrent(); if (value.signal.aborted || value.tier !== tier) throw new ClaudeProtocolFault("protocol"); if (run) throw new ClaudeProtocolFault("protocol"); run = value; protocol = new ClaudeRawProtocol({ run, model, cwd, check: assertCurrent, secret: account.accessCredential() });
            if (timing) { const originalWorker = protocol.worker; protocol.worker = function(value) { const result = Reflect.apply(originalWorker, this, [value]); recordAdmittedTimingResult(timing, value); return result; }; } },
          claimTool(name, input) { if (!protocol) throw new ClaudeProtocolFault("protocol"); protocol.claim(name, input); },
          assertSettled() { protocol?.settled(); }, faultSite: () => process?.faultSite, faultCounts: () => process?.faultCounts, assertCurrent, close,
          spawn(spawn) {
            assertCurrent(); assertExecutableCurrent(); if (process || !run || !protocol) throw new ClaudeProtocolFault("protocol"); admitSpawn(spawn, model, run, cwd, env);
            const boot = Buffer.from(JSON.stringify({ protocol: 1, scope: step, generation: account.credentialGeneration, expiresAt: account.expiresAt, access: account.accessCredential(), argv: spawn.args }));
            const prefix = Buffer.alloc(4); prefix.writeUInt32BE(boot.length);
            process = new ClaudeDuplexProcess({ signal: AbortSignal.any([signal, run.signal, account.signal]), protocol, bootstrap: Buffer.concat([prefix, boot]), check: assertCurrent,
              connect: () => sessionStep ? sessionStep.duplex() : lease!.duplex(["/usr/local/bin/node", "/opt/genbi/claude-worker.mjs"]),
              ...(sessionStep ? { admitPrelude: sessionStep.admitPrelude } : {}), cleanup: () => sessionStep ? sessionStep.close() : lease!.close() });
            return process;
          },
        };
        register(runtime, options.vault, account, identity, assertCurrent, () => { signal.throwIfAborted(); check(); assertVaultLeaseAfterClose(account); });
        return Object.freeze(runtime);
      } catch { await close(); throw new ClaudeProtocolFault("protocol"); }
    },
  };
  return Object.freeze(provider);
}


const labels = Object.freeze({ pro: "Claude Pro", max: "Claude Max", team: "Claude Team", enterprise: "Claude Enterprise" });
type Proof = { vault: ClaudeAccountVault; account: ClaudeAccountLease; identity: Readonly<Extract<OpenShellIdentity, { purpose: "model" }>>; check(): void; afterClose(): void; owner: { claimed?: StepRun }; snapshot: readonly unknown[] };
const proofs = new WeakMap<ClaudeComponentRuntime, Proof>();
const fields = (runtime: ClaudeComponentRuntime) => [runtime.cwd, runtime.executable, runtime.model, runtime.signal, runtime.account, runtime.environment, runtime.query, runtime.spawn, runtime.assertCurrent, runtime.admitStep, runtime.claimTool, runtime.assertSettled, runtime.close, runtime.timing, runtime.assertExecutableCurrent] as const;
/** The runner uses both plain and null-prototype JSON maps. Keep that identity in the proof. */
function snapshotStepData<T>(value: T): T {
  if (value === null || typeof value !== "object") {
    if (!["string", "number", "boolean", "undefined"].includes(typeof value) || (typeof value === "number" && !Number.isFinite(value))) throw new ClaudeProtocolFault("protocol");
    return value;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== null && prototype !== Object.prototype && !(Array.isArray(value) && prototype === Array.prototype)) throw new ClaudeProtocolFault("protocol");
  if (Object.getOwnPropertySymbols(value).length) throw new ClaudeProtocolFault("protocol");
  const copy = Array.isArray(value) ? new Array(value.length) : Object.create(prototype);
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (Array.isArray(value) && key === "length") continue;
    if (!Object.hasOwn(descriptor, "value") || !descriptor.enumerable) throw new ClaudeProtocolFault("protocol");
    Object.defineProperty(copy, key, { value: snapshotStepData(descriptor.value), enumerable: true, configurable: true, writable: true });
  }
  return Object.freeze(copy) as T;
}
function snapshotStepTools(tools: StepRun["tools"]): StepRun["tools"] {
  const prototype = Object.getPrototypeOf(tools);
  if ((prototype !== null && prototype !== Object.prototype) || Object.getOwnPropertySymbols(tools).length) throw new ClaudeProtocolFault("protocol");
  const copy = Object.create(prototype);
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(tools))) {
    if (!Object.hasOwn(descriptor, "value") || !descriptor.enumerable || typeof descriptor.value !== "function") throw new ClaudeProtocolFault("protocol");
    Object.defineProperty(copy, key, { value: descriptor.value, enumerable: true });
  }
  return Object.freeze(copy);
}
function register(runtime: ClaudeComponentRuntime, vault: ClaudeAccountVault, account: ClaudeAccountLease, identity: Proof["identity"], check: () => void, afterClose: () => void): void {
  assertVaultLease(account, vault); check(); proofs.set(runtime, { vault, account, identity, check, afterClose, owner: {}, snapshot: fields(runtime) });
}
/** Claims exact registered runtime once for one exact StepRun. No structural proof is accepted. */
export function claimClaudeHostRuntime(runtime: ClaudeComponentRuntime, run: StepRun): { observe(value: unknown): void; check(): void; afterClose(): void } | undefined {
  const proof = proofs.get(runtime);
  if (!proof) { if (runtime.executable === "/opt/genbi/claude" || runtime.cwd === "/sandbox") throw new ClaudeProtocolFault("protocol"); return undefined; }
  const runSnapshot = Object.freeze({ ...run, input: snapshotStepData(run.input), consumes: snapshotStepData(run.consumes), children: snapshotStepData(run.children), tools: snapshotStepTools(run.tools), toolSchemas: snapshotStepData(run.toolSchemas), toolDescriptions: snapshotStepData(run.toolDescriptions) });
  const check = () => { if (!isDeepStrictEqual(run, runSnapshot) || !fields(runtime).every((value, index) => value === proof.snapshot[index]) || run.tier !== proof.identity.tier || run.signal.aborted) throw new ClaudeProtocolFault("protocol"); assertVaultLease(proof.account, proof.vault); proof.check(); };
  check(); if (proof.owner.claimed) throw new ClaudeProtocolFault("protocol"); proof.owner.claimed = run;
  return {
    check, afterClose() { if (run.signal.aborted || !isDeepStrictEqual(run, runSnapshot) || !fields(runtime).every((value, index) => value === proof.snapshot[index])) throw new ClaudeProtocolFault("protocol"); assertVaultLeaseAfterClose(proof.account); proof.afterClose(); },
    observe(value) {
      check(); if (!value || typeof value !== "object" || Array.isArray(value)) throw new ClaudeProtocolFault("protocol");
      const observed = value as Record<string, unknown>;
      if (observed.tokenSource !== "CLAUDE_CODE_OAUTH_TOKEN" || observed.apiProvider !== "firstParty" || (observed.apiKeySource !== undefined && observed.apiKeySource !== "none")
        || (observed.email !== undefined && observed.email !== proof.account.identity.email) || (observed.subscriptionType !== undefined && observed.subscriptionType !== labels[proof.account.identity.subscription])
        || (observed.organization !== undefined && (proof.account.organizationName === undefined || observed.organization !== proof.account.organizationName))) throw new ClaudeProtocolFault("protocol");
    },
  };
}
/** Narrow native adapter owns the wrapper it creates; arbitrary spread copies never inherit authority. */
export function deriveClaudeNativeRuntime(runtime: ClaudeComponentRuntime, checkBinding: () => void, close: () => Promise<void>): ClaudeComponentRuntime {
  const originalCheck = runtime.assertCurrent.bind(runtime);
  const originalExecutableCheck = runtime.assertExecutableCurrent?.bind(runtime);
  const proof = proofs.get(runtime);
  const wrapper: ClaudeComponentRuntime = { ...runtime, query: runtime.query.bind(runtime), close: proof ? async () => { try { await close(); } finally { await runtime.close(); } } : close,
    assertCurrent() { checkBinding(); originalCheck(); },
    ...(originalExecutableCheck ? { assertExecutableCurrent() { checkBinding(); originalExecutableCheck(); } } : {}),
  };
  if (proof) { assertVaultLease(proof.account, proof.vault); proof.check(); proofs.set(wrapper, { ...proof, check() { checkBinding(); proof.check(); }, afterClose() { checkBinding(); proof.afterClose(); }, snapshot: fields(wrapper) }); }
  return Object.freeze(wrapper);
}

/** Diagnostic identity is retrieved only from the actual registered host proof. */
export function readClaudeRuntimeTiming(runtime: ClaudeComponentRuntime): StructuredComponentTiming | undefined { return proofs.get(runtime)?.snapshot[13] as StructuredComponentTiming | undefined; }
