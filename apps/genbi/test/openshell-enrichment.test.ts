import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ComponentInvocationResult } from "@warble/claude-agent-sdk";
import { DEFAULT_COMPONENT_LIMITS } from "../harness/components/runner.js";
import { createApp } from "../server/app.js";
import { Store } from "../server/db.js";
import { canonicalizeProposal, NATIVE_ENRICHMENT_SUBMIT_MCP_TOOL_NAME, resolveEnrichmentBinding, type EnrichmentMode } from "../server/enrichment.js";
import type { ValidatedReview } from "../server/enrichment-validation.js";
import type { OpenShellEnrichmentValidator } from "../server/openshell-enrichment-validation.js";
import { composeInspectPrompt } from "../server/enrichment-runner.js";
import { NativeArtifactService } from "../server/native-artifacts.js";
import { createOpenShellStructuredProvisioner } from "../server/openshell-structured-provisioner.js";
import { createOpenShellStructuredAdapter, type OpenShellEnrichmentPreparation, type OpenShellPreparedHost, type OpenShellStructuredProvisioner } from "../server/openshell-structured-ask.js";
import { OpenShellNativeSessions } from "../server/openshell-native-sessions.js";
import { readOpenShellEnrichmentResult } from "../server/openshell-enrichment.js";
import { runtimeNotReady, runtimeReady } from "../server/runtime-host/policy.js";
import { StructuredRuntime, StructuredRuntimeError, type EnrichmentValidationRequest, type EnrichmentValidationResult, type StructuredAdapter, type StructuredScope } from "../server/structured-runtime.js";
import type { TurnDeps } from "../server/turn.js";
import { resolveRuntimeSelection } from "../server/runtime-selection.js";
const openshellClaude = resolveRuntimeSelection({ GENBI_RUNTIME: "openshell", GENBI_BACKEND: "claude" });
const localSelection = resolveRuntimeSelection({ GENBI_RUNTIME: "local" });

const dirs: string[] = [];
const stores: Store[] = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); while (stores.length) stores.pop()!.close(); vi.useRealTimers(); });

const goodOperation = { relative_sink: "knowledge/rules/revenue.md", changeKind: "knowledge_append", summary: "Document revenue", recommended_yaml: "Revenue is net of refunds." };
const proposalValue = (operations: unknown[] = [goodOperation]) => ({ enrichment_proposal: { operations } });
const okValue = (value: unknown): Extract<ComponentInvocationResult, { status: "ok" }> => ({ status: "ok", output: { kind: "value", value }, provenance: { verified: false } });
const claude = { mode: "subscription", provider: "claude" } as const;

function project(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "genbi-openshell-enrich-")); dirs.push(dir);
  mkdirSync(path.join(dir, "target")); writeFileSync(path.join(dir, "wren_project.yml"), "name: demo\n"); writeFileSync(path.join(dir, "target", "mdl.json"), '{"models":[{"name":"orders"}]}');
  return dir;
}

interface Script {
  /** Draft-stage behaviour; defaults to persisting one valid operation through the granted sink. */
  draft?(input: OpenShellEnrichmentPreparation, state: { current: boolean }): Promise<unknown>;
  inspect?(input: OpenShellEnrichmentPreparation): Promise<unknown>;
  ready?: boolean;
  disposeFails?: boolean;
  approved?: readonly string[];
}
const SLICE5_APPROVED_FILES = ["data/synthetic.duckdb", "knowledge/metrics/revenue.md", "models/orders/metadata.yml", "target/mdl.json", "wren_project.yml"];
function provisionerFixture(script: Script = {}) {
  const state = { current: true };
  const inputs: OpenShellEnrichmentPreparation[] = [];
  const disposed = vi.fn(async () => { if (script.disposeFails) throw Error("private cleanup detail"); });
  const prepareEnrichment = vi.fn(async (input: OpenShellEnrichmentPreparation): Promise<OpenShellPreparedHost> => {
    inputs.push(input);
    const assertCurrent = () => { input.scope.signal?.throwIfAborted(); input.scope.assertCurrent(); };
    return { assertCurrent, async run() {
      assertCurrent();
      if (input.stage === "inspect_context") return okValue(await (script.inspect?.(input) ?? { enrichment_gaps: [{ kind: "coverage" }] }));
      const value = okValue(await (script.draft ? script.draft(input, state) : proposalValue()));
      await input.propose!.persist(value, { isCurrent: () => state.current } as never, input.scope.signal!);
      return value;
    }, dispose: disposed };
  });
  const provisioner: OpenShellStructuredProvisioner = {
    probe: async () => script.ready === false ? runtimeNotReady("openshell", "unavailable", "openshell_unavailable") : runtimeReady("synthetic", []),
    prepare: vi.fn(async () => { throw Error("analysis preparation is not an enrichment path"); }), prepareEnrichment,
    enrichmentApprovedFiles: () => script.approved ?? SLICE5_APPROVED_FILES,
  };
  return { provisioner, prepareEnrichment, inputs, disposed, state };
}

const sha = (char: string) => `sha256:${char.repeat(64)}`;
/** A structurally complete review a fake validator can return; real review content is covered by the validation tests. */
const syntheticReview = (request: EnrichmentValidationRequest): ValidatedReview => ({ version: 1, account: "synthetic-account", mdlContent: "{}",
  binding: { generation: request.binding.generation, revision: request.binding.revision, projectIdentity: request.binding.identity },
  snapshot: { digest: sha("a"), project: sha("b"), bindingGeneration: String(request.binding.generation), bindingRevision: request.binding.revision, context: sha("c"), files: [] },
  diff: [], diffSha256: sha("d"), receipt: { image: sha("1"), policy: sha("2"), script: sha("3"), wheel: sha("4"), toolchain: sha("5"), architecture: "linux-arm64", protocol: "genbi-validate/1",
    checks: [], mdl: { sha256: "e".repeat(64), size: 2 }, changeSetSha256: sha("f") } });
interface ValidatorScript { available?: boolean; validate?(request: EnrichmentValidationRequest, scope: StructuredScope): Promise<EnrichmentValidationResult> }
function fakeValidator(script: ValidatorScript = {}) {
  const validate = vi.fn(async (request: EnrichmentValidationRequest, scope: StructuredScope): Promise<EnrichmentValidationResult> => {
    scope.assertCurrent();
    return script.validate ? script.validate(request, scope) : { status: "validated", review: syntheticReview(request) };
  });
  const validator: OpenShellEnrichmentValidator = { available: () => script.available !== false, validate };
  return { validator, validate };
}
interface Options { script?: Script; adapter?: StructuredAdapter | "none"; selected?: "openshell" | "local"; withApply?: boolean; validator?: ValidatorScript | "none" }
function build(options: Options = {}) {
  const projectDir = project(); const store = new Store(":memory:"); stores.push(store);
  store.setSetupSteps(store.getSetupSteps().map((step) => step.key === "bind" ? { ...step, state: "done" } : step));
  const binding = store.activateEnrichmentBinding(resolveEnrichmentBinding(projectDir));
  const prov = provisionerFixture(options.script);
  const fake = fakeValidator(options.validator === "none" ? {} : options.validator);
  const adapter = options.adapter === "none" ? undefined : options.adapter ?? createOpenShellStructuredAdapter(prov.provisioner, undefined, "claude", options.validator === "none" ? undefined : fake.validator);
  const localRunner = { draft: vi.fn(async () => ({ operations: [{ sink: "knowledge/rules/local.md", changeKind: "knowledge_append", summary: "Local draft", draft: "x" }] })) };
  const verify = vi.fn(async (proposal: { hash: string; projectRevision: string }) => ({ status: "verified" as const, proposalHash: proposal.hash, projectRevision: proposal.projectRevision, stepsRun: [] }));
  const apply = vi.fn(async () => ({ validationDigest: "validate:ok", buildDigest: "build:ok" }));
  const startInteractiveTerminal = vi.fn(); const prepareInteractiveTerminal = vi.fn();
  const runtime = new StructuredRuntime({ selection: options.selected === "local" ? localSelection : openshellClaude,
    localRoute: vi.fn(async () => { throw Error("local fallback forbidden"); }), localSetupFor: () => undefined, ...(adapter ? { adapters: { claude: adapter } } : {}) });
  const deps = { store, structuredRuntime: runtime, baseRouteOptions: { authChoice: claude, profileSource: "fixture", userProject: projectDir },
    route: async () => { throw Error("not used"); }, enrichmentRunner: localRunner, verifyEnrichmentProposal: verify,
    startInteractiveTerminal, prepareInteractiveTerminal,
    ...(options.withApply ? { enrichmentApplyRunner: { apply, reconcile: async () => ({ state: "not_applied" as const }) },
      enrichmentApprovalProvider: { attest: async (input: { runId: string; binding: unknown; proposalHash: string; operation: { id: string; hash: string } }) => ({ evidenceRef: `evidence-${input.runId}`, nonce: `nonce-${input.runId}`, expiresAt: new Date(Date.now() + 60_000).toISOString(), binding: input.binding, proposalHash: input.proposalHash, operationHash: input.operation.hash }) } } : {}),
  } as unknown as TurnDeps;
  const app = createApp(deps);
  const start = (mode: EnrichmentMode = "grill", signal?: AbortSignal) => app.request("/api/context/enrichment/start", { method: "POST", body: JSON.stringify({ mode }), ...(signal ? { signal } : {}) });
  return { app, store, runtime, prov, localRunner, verify, apply, startInteractiveTerminal, prepareInteractiveTerminal, projectDir, binding, start, deps, validate: fake.validate };
}
/** A recorded proposal that is still awaiting its validator, created through the ledger exactly as the route does. */
function pendingRun(f: ReturnType<typeof build>) {
  const created = f.store.createDraftingEnrichmentRun({ id: "enrichment-pending-fixture", mode: "grill", binding: f.binding, backend: "openshell" });
  const proposal = canonicalizeProposal({ operations: [{ sink: "knowledge/rules/revenue.md", changeKind: "knowledge_append", summary: "Document revenue", draft: "Revenue is net of refunds." }] }, f.binding.revision);
  expect(f.store.finalizeEnrichmentDraft({ runId: created.id, expectedVersion: created.version, proposalId: proposal.id, proposalHash: proposal.hash, operations: proposal.operations, pendingValidation: true })).toBe(true);
  const run = f.store.getEnrichmentRun(created.id)!;
  return { id: run.id, version: run.version, proposalHash: run.proposalHash, projectRevision: run.projectRevision, operations: f.store.listEnrichmentOperations(run.id).map((operation) => ({ id: operation.id })) };
}
const noEnrichAdapter = (): StructuredAdapter => ({ vendor: "claude", backend: "openshell", nativeSessions: true, probe: async () => runtimeReady("synthetic", []), ask: vi.fn(async () => { throw Error("not used"); }) });

describe("slice 0: OpenShell enrichment fails closed", () => {
  it.each([["no adapter", "none"], ["an adapter without an enrich operation", "no-enrich"]] as const)("start refuses with a typed 503 before any ledger row (%s)", async (_label, kind) => {
    const f = build({ adapter: kind === "none" ? "none" : noEnrichAdapter() });
    const response = await f.start();
    expect(response.status).toBe(503); expect(await response.json()).toMatchObject({ code: "unsupported" });
    expect(f.store.getLatestEnrichmentRun()).toBeUndefined();
    expect(f.localRunner.draft).not.toHaveBeenCalled(); expect(f.verify).not.toHaveBeenCalled();
    expect(f.prov.prepareEnrichment).not.toHaveBeenCalled();
  });
  it("start refuses an unready OpenShell adapter before any ledger row", async () => {
    const f = build({ script: { ready: false } });
    const response = await f.start();
    expect(response.status).toBe(503); expect(await response.json()).toMatchObject({ code: "unavailable" });
    expect(f.store.getLatestEnrichmentRun()).toBeUndefined(); expect(f.localRunner.draft).not.toHaveBeenCalled(); expect(f.prov.prepareEnrichment).not.toHaveBeenCalled();
  });
  it.each(["/api/context/terminal/sessions", "/api/context/terminal/prepare"])("refuses the host-local interactive enrichment entry %s", async (url) => {
    const f = build();
    const response = await f.app.request(url, { method: "POST", body: JSON.stringify({ target: "claude-code:interactive" }) });
    expect(response.status).toBe(503); expect(await response.json()).toMatchObject({ code: "unsupported" });
    expect(f.startInteractiveTerminal).not.toHaveBeenCalled(); expect(f.prepareInteractiveTerminal).not.toHaveBeenCalled();
  });
  it("refuses the native submit_context_proposal tool before any ledger row", async () => {
    const f = build({ adapter: noEnrichAdapter() });
    const binding = f.store.getEnrichmentBinding()!;
    const row = f.store.createNativeSession({ id: "native-enrich", purpose: "context_enrichment", vendor: "claude", agent: "draft_enrichment", scopeKind: "bound_project", scopeId: "scope",
      projectIdentity: binding.identity, bindingGeneration: binding.generation, projectRevision: binding.revision });
    f.store.transitionNativeSession(row.id, "running", { started: true });
    const url = "http://127.0.0.1:4787/api/native-sessions/mcp";
    const service = new NativeArtifactService({ store: f.store, artifactsRoot: path.join(f.projectDir, "out"), expectedMcpUrl: url, mcpUrl: url, getBinding: () => f.store.getEnrichmentBinding() });
    const { credential } = service.issue(f.store.getNativeSession(row.id)!, binding);
    const app = createApp({ ...f.deps, nativeArtifacts: service } as TurnDeps);
    const response = await app.request("/api/native-sessions/mcp", { method: "POST", headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: NATIVE_ENRICHMENT_SUBMIT_MCP_TOOL_NAME, arguments: { operations: [{ sink: "knowledge/rules/x.md", changeKind: "knowledge_append", summary: "s", draft: "d" }] } } }) });
    expect(response.status).toBe(503); expect(f.store.getLatestEnrichmentRun()).toBeUndefined();
  });
  it("keeps the interactive context_enrichment native purpose refused", async () => {
    const f = build();
    const sessions = new OpenShellNativeSessions({ store: f.store, provisioner: { ...f.prov.provisioner, assertSessionCleaned() {} }, runtime: () => f.runtime, getBinding: () => f.store.getEnrichmentBinding(), routeOptions: () => ({ authChoice: claude, profileSource: "fixture", userProject: f.projectDir }) });
    await expect(sessions.open({ purpose: "context_enrichment" })).rejects.toMatchObject({ code: "unsupported" });
    expect(f.store.getLatestEnrichmentRun()).toBeUndefined();
  });
  it("reports draft capability truthfully from the OpenShell adapter, not from the host-local runner", async () => {
    const capability = async (f: ReturnType<typeof build>) => ((await (await f.app.request("/api/context/enrichment")).json()) as { capabilities: { draft: unknown } }).capabilities.draft;
    expect(await capability(build({ adapter: noEnrichAdapter() }))).toEqual({ available: false, reason: "openshell_enrichment_unsupported" });
    expect(await capability(build({ script: { ready: false } }))).toEqual({ available: false, reason: "openshell_not_ready" });
    expect(await capability(build())).toEqual({ available: true });
    // Fail closed: an adapter that cannot validate cannot draft either (no model spend for a proposal that could never be reviewed).
    expect(await capability(build({ validator: { available: false } }))).toEqual({ available: false, reason: "openshell_validator_unavailable" });
    expect(await capability(build({ validator: "none" }))).toEqual({ available: false, reason: "openshell_validator_unavailable" });
  });
  it("reports structured readiness for enrichment on OpenShell vendors only", async () => {
    const withEnrich = (await build().runtime.readiness({ mode: "subscription", provider: "claude" })) as { claude: Record<string, unknown> };
    expect(withEnrich.claude).toMatchObject({ backend: "openshell", ask: true, enrich: true, supportedAgents: ["answer_query", "inspect_context", "draft_enrichment"] });
    const without = (await build({ adapter: noEnrichAdapter() }).runtime.readiness()) as { claude: Record<string, unknown> };
    expect(without.claude).toMatchObject({ enrich: false, supportedAgents: ["answer_query"] });
    expect(((await build({ script: { ready: false } }).runtime.readiness()) as { claude: Record<string, unknown> }).claude).toMatchObject({ enrich: false });
    expect(((await build({ selected: "local" }).runtime.readiness()) as { claude: Record<string, unknown> }).claude).not.toHaveProperty("enrich");
  });
  it("leaves the local backend path unchanged: the host-local runner and the shadow ladder still run", async () => {
    const f = build({ selected: "local" });
    const response = await f.start();
    expect(response.status).toBe(201);
    expect(f.localRunner.draft).toHaveBeenCalledOnce(); expect(f.verify).toHaveBeenCalledOnce();
    expect(f.store.getLatestEnrichmentRun()).toMatchObject({ status: "awaiting_decision" });
    expect(f.prov.prepareEnrichment).not.toHaveBeenCalled();
  });
});

describe("slice 1: the OpenShell enrichment purpose", () => {
  it("drafts through two governed stages, records the proposal validation-pending until the independent validator settles it, and never runs the host ladder or the local runner", async () => {
    let seenPending: string | undefined;
    const f = build({ validator: { validate: async (request) => { seenPending = f.store.getLatestEnrichmentRun()?.status; return { status: "validated", review: syntheticReview(request) }; } } });
    const response = await f.start("grill");
    expect(response.status).toBe(201);
    const run = await response.json() as { id: string; status: string; operations: { id: string; sink: string }[] };
    expect(seenPending).toBe("validation_pending");
    expect(run.status).toBe("awaiting_decision");
    expect(run.operations).toEqual([expect.objectContaining({ sink: "knowledge/rules/revenue.md" })]);
    expect(f.store.getEnrichmentRun(run.id)).toMatchObject({ status: "awaiting_decision", backend: "openshell", bindingGeneration: f.binding.generation });
    expect(f.store.listEnrichmentOperations(run.id)).toEqual([expect.objectContaining({ state: "awaiting_decision", decision: null, completed: false })]);
    expect(f.verify).not.toHaveBeenCalled(); expect(f.localRunner.draft).not.toHaveBeenCalled();
    expect(f.prov.inputs.map((input) => input.stage)).toEqual(["inspect_context", "draft_enrichment"]);
    expect(f.prov.inputs[0]!.propose).toBeUndefined(); expect(f.prov.inputs[1]!.propose).toMatchObject({ component: "draft_enrichment" });
    expect(f.prov.inputs[0]!.request).toBe(composeInspectPrompt("grill"));
    expect(f.prov.inputs[1]!.request).toContain(f.binding.revision); expect(f.prov.inputs[1]!.request).toContain("coverage");
    expect(f.prov.disposed).toHaveBeenCalledTimes(2);
    expect(f.prov.provisioner.prepare).not.toHaveBeenCalled();
  });

  it.each(["decision", "edit", "approval", "apply"] as const)("refuses to %s a validation-pending proposal", async (action) => {
    const f = build({ withApply: true });
    const run = pendingRun(f);
    const body = { operationId: run.operations[0]!.id, expectedVersion: run.version, proposalHash: run.proposalHash, projectRevision: run.projectRevision,
      decision: "accept", sink: "knowledge/rules/revenue.md", changeKind: "knowledge_append", summary: "x", draft: "y" };
    const response = await f.app.request(`/api/context/enrichment/${run.id}/${action}`, { method: "POST", body: JSON.stringify(body) });
    expect(response.status).toBe(409); expect(JSON.stringify(await response.json())).toContain("awaits sandbox validation");
    expect(f.apply).not.toHaveBeenCalled();
    expect(f.store.getEnrichmentRun(run.id)).toMatchObject({ status: "validation_pending", version: run.version });
    expect(f.store.listEnrichmentOperations(run.id)[0]).toMatchObject({ state: "validation_pending", decision: null, completed: false });
  });

  it("never auto-applies an OpenShell autopilot proposal, validated or not", async () => {
    const f = build({ withApply: true, script: { draft: async () => proposalValue() } });
    const response = await f.start("autopilot");
    expect(response.status).toBe(201); expect(await response.json()).toMatchObject({ status: "awaiting_decision" });
    expect(f.apply).not.toHaveBeenCalled();
  });

  it.each([
    ["an out-of-allowlist sink", [{ ...goodOperation, relative_sink: "src/evil.ts" }]],
    ["path traversal", [{ ...goodOperation, relative_sink: "knowledge/rules/../../wren_project.yml" }]],
    ["a sink for the wrong change kind", [{ ...goodOperation, changeKind: "new_cube" }]],
    ["an oversize draft", [{ ...goodOperation, recommended_yaml: "x".repeat(5000) }]],
    ["more than twenty operations", Array.from({ length: 21 }, (_v, index) => ({ ...goodOperation, relative_sink: `knowledge/rules/r${index}.md`, summary: `s${index}` }))],
    ["duplicate operations", [goodOperation, goodOperation]],
    ["no operations", []],
  ])("rejects %s as a 400 contract error and leaves a terminal failed run with no operations", async (_label, operations) => {
    const f = build({ script: { draft: async () => proposalValue(operations) } });
    const response = await f.start();
    expect(response.status).toBe(400);
    expect(f.validate).not.toHaveBeenCalled();
    const run = f.store.getLatestEnrichmentRun()!;
    expect(run.status).toBe("failed"); expect(f.store.listEnrichmentOperations(run.id)).toEqual([]);
  });

  it("rejects a prose or refused draft terminal and persists nothing", async () => {
    // Both are the model's draft failing the host contract: 400 as on the local path, not a runtime failure.
    for (const draft of ["I could not draft anything.", { status: "refused", message: "no" }]) {
      const f = build({ script: { draft: async () => draft } });
      expect((await f.start()).status).toBe(400);
      const run = f.store.getLatestEnrichmentRun()!;
      expect(run.status).toBe("failed"); expect(f.store.listEnrichmentOperations(run.id)).toEqual([]);
    }
  });

  it("drops model-authored ids, hashes and risk before they reach the ledger", async () => {
    const f = build({ script: { draft: async () => proposalValue([{ ...goodOperation, id: "forged", hash: "forged", risk: "low", projectRevision: "forged" }]) } });
    const run = await (await f.start()).json() as { id: string; proposalHash: string; projectRevision: string; operations: { id: string; risk: string }[] };
    expect(run.operations[0]!.id).not.toBe("forged"); expect(run.proposalHash).not.toBe("forged"); expect(run.projectRevision).toBe(f.binding.revision);
  });

  it("cancellation mid-draft leaves a terminal failed run, disposes every stage and persists no proposal", async () => {
    const controller = new AbortController();
    const f = build({ script: { draft: async (input) => { controller.abort(); input.scope.signal!.throwIfAborted(); throw Error("cancellation was not observed"); } } });
    await Promise.resolve(f.start("grill", controller.signal)).catch(() => undefined);
    await vi.waitFor(() => expect(f.store.getLatestEnrichmentRun()?.status).toBe("failed"));
    const run = f.store.getLatestEnrichmentRun()!;
    expect(run.errorMessage).toMatch(/cancelled/); expect(f.store.listEnrichmentOperations(run.id)).toEqual([]); expect(f.prov.disposed).toHaveBeenCalledTimes(2);
  });

  it("a binding generation change during drafting fails the run and persists no proposal", async () => {
    const f = build({ script: { draft: async () => { f.store.activateEnrichmentBinding(resolveEnrichmentBinding(f.projectDir)); return proposalValue(); } } });
    const response = await f.start();
    expect([409, 503]).toContain(response.status);
    const run = f.store.getLatestEnrichmentRun()!;
    expect(run.status).toBe("failed"); expect(f.store.listEnrichmentOperations(run.id)).toEqual([]);
    expect(f.prov.disposed).toHaveBeenCalled();
  });

  it("a runtime settings change during drafting fails the run and persists no proposal", async () => {
    const f = build({ script: { draft: async () => { f.store.setRuntimeSettings({ ...f.store.getRuntimeSettings(), subscriptionProvider: "codex" }); return proposalValue(); } } });
    expect((await f.start()).status).toBe(503);
    const run = f.store.getLatestEnrichmentRun()!;
    expect(run.status).toBe("failed"); expect(f.store.listEnrichmentOperations(run.id)).toEqual([]);
  });

  it("a cleanup failure fails the run and returns no proposal", async () => {
    const f = build({ script: { disposeFails: true } });
    expect((await f.start()).status).toBe(503);
    const run = f.store.getLatestEnrichmentRun()!;
    expect(run.status).toBe("failed"); expect(f.store.listEnrichmentOperations(run.id)).toEqual([]);
  });
});

describe("slice 1: the adapter authority boundary", () => {
  const scope = (): StructuredScope => ({ sessionId: "enrichment-run", turnId: "enrichment-draft", assertCurrent() {} });
  const options = { authChoice: claude, userProject: "/fixture", mode: "grill" as const, projectRevision: "sha256:rev" };
  it("the analysis ask cannot be pointed at an enrichment stage and never receives a proposal sink", async () => {
    const f = provisionerFixture(); const adapter = createOpenShellStructuredAdapter(f.provisioner);
    for (const agentId of ["inspect_context", "draft_enrichment"]) await expect(adapter.ask!({ ...options, profileSource: "fixture", question: "q", agentId }, scope())).rejects.toMatchObject({ code: "unsupported" });
    expect(f.provisioner.prepare).not.toHaveBeenCalled(); expect(f.prepareEnrichment).not.toHaveBeenCalled();
  });
  it("enrich refuses non-Claude-subscription auth and any widening option", async () => {
    const f = provisionerFixture(); const adapter = createOpenShellStructuredAdapter(f.provisioner);
    await expect(adapter.enrich!({ ...options, authChoice: { mode: "gateway", config: { provider: "openrouter", model: "synthetic", apiKey: "synthetic" } } }, scope())).rejects.toMatchObject({ code: "unsupported" });
    await expect(adapter.enrich!({ ...options, mcpServers: {} } as never, scope())).rejects.toMatchObject({ code: "unsupported" });
    expect(f.prepareEnrichment).not.toHaveBeenCalled();
  });
  it("only an adapter whose provisioner has an enrichment entry point offers enrich", () => {
    expect(createOpenShellStructuredAdapter({ probe: async () => runtimeReady("synthetic", []), prepare: vi.fn() }).enrich).toBeUndefined();
    expect(createOpenShellStructuredAdapter(provisionerFixture().provisioner).enrich).toBeTypeOf("function");
  });
  it("a result without the host proof is never readable", async () => {
    const f = provisionerFixture(); const adapter = createOpenShellStructuredAdapter(f.provisioner);
    const result = await adapter.enrich!(options, scope());
    expect(readOpenShellEnrichmentResult(result)).toEqual(result);
    expect(() => readOpenShellEnrichmentResult({ ...result })).toThrow();
    expect(() => readOpenShellEnrichmentResult({ backend: "openshell", draft: { operations: [] } })).toThrow();
  });
  it("a proof is revoked when the scope goes stale after the result is built", async () => {
    let current = true; const f = provisionerFixture(); const adapter = createOpenShellStructuredAdapter(f.provisioner);
    const result = await adapter.enrich!(options, { ...scope(), assertCurrent() { if (!current) throw Error("stale"); } });
    current = false; expect(() => readOpenShellEnrichmentResult(result)).toThrow();
  });
  it("accepts the sink once: a second proposal in the same run is refused", async () => {
    const f = provisionerFixture({ draft: async (input) => { const value = okValue(proposalValue()); await input.propose!.persist(value, { isCurrent: () => true } as never, input.scope.signal!); return proposalValue(); } });
    const adapter = createOpenShellStructuredAdapter(f.provisioner);
    await expect(adapter.enrich!(options, scope())).rejects.toMatchObject({ code: "failed" });
  });
  it("refuses a stale sink binding", async () => {
    const f = provisionerFixture(); const adapter = createOpenShellStructuredAdapter(f.provisioner);
    f.state.current = false;
    await expect(adapter.enrich!(options, scope())).rejects.toMatchObject({ code: "failed" });
  });
});

describe("slice 1: timeouts", () => {
  const scope = (): StructuredScope => ({ sessionId: "enrichment-run", turnId: "enrichment-draft", assertCurrent() {} });
  const options = { authChoice: claude, userProject: "/fixture", mode: "grill" as const, projectRevision: "sha256:rev" };
  function slow() {
    let release!: () => void; const held = new Promise<void>((resolve) => { release = resolve; });
    const f = provisionerFixture({ inspect: async (input) => { await Promise.race([held, new Promise((_r, reject) => input.scope.signal!.addEventListener("abort", () => reject(input.scope.signal!.reason), { once: true }))]); return { enrichment_gaps: [] }; } });
    return { f, release };
  }
  it("honours the live deployer component budget beyond the old default, across both stages", async () => {
    vi.useFakeTimers();
    const { f, release } = slow(); const adapter = createOpenShellStructuredAdapter(f.provisioner, undefined);
    const pending = new StructuredRuntime({ selection: openshellClaude, localRoute: vi.fn(), localSetupFor: () => undefined, adapters: { claude: adapter } })
      .enrich({ ...options, componentLimits: { ...DEFAULT_COMPONENT_LIMITS, timeoutMs: 300_000 } }, scope());
    await vi.advanceTimersByTimeAsync(200_000);
    expect(f.inputs[0]!.scope.signal?.aborted).toBe(false);
    release(); expect(await pending).toMatchObject({ backend: "openshell" });
  });
  it("the whole enrichment is bounded by the two stage budgets", async () => {
    vi.useFakeTimers();
    const { f } = slow(); const adapter = createOpenShellStructuredAdapter(f.provisioner);
    const pending = adapter.enrich!({ ...options, componentLimits: { ...DEFAULT_COMPONENT_LIMITS, timeoutMs: 1_000 } }, scope());
    const rejected = expect(pending).rejects.toMatchObject({ code: "timeout" });
    await vi.advanceTimersByTimeAsync(2_001); await rejected;
    expect(f.disposed).toHaveBeenCalled();
  });
  it("an explicit shorter chat budget wins and the independent step, call and byte caps are passed through untouched", async () => {
    vi.useFakeTimers();
    const { f } = slow(); const adapter = createOpenShellStructuredAdapter(f.provisioner);
    const limits = { ...DEFAULT_COMPONENT_LIMITS, timeoutMs: 300_000, steps: 3, calls: 4, childSteps: 2, requestBytes: 1_000, resultBytes: 2_000, depth: 2 };
    const pending = adapter.enrich!({ ...options, componentLimits: limits, chatTimeoutMs: 10 }, scope());
    const rejected = expect(pending).rejects.toMatchObject({ code: "timeout" });
    await vi.advanceTimersByTimeAsync(10); await rejected;
    expect(f.inputs[0]!.options.componentLimits).toEqual(limits);
  });
});


// ------------------------------------------------------------------------------------------------
describe("enrichment validation settles the recorded proposal", () => {
  const json = async (response: Response) => await response.json() as Record<string, any>;
  const failedVerdict = (code = "validator_failed"): EnrichmentValidationResult => ({ status: "failed", failure: { version: 1, stage: "validator", code, message: "Validation failed at dry_run: column not found", checks: [{ check: "dry_run", status: "fail", code: "dry_run_error", message: "column not found" }] } });

  it("S2-1: a validated proposal reaches awaiting_decision with its review record and a receipt the host can bind to", async () => {
    const f = build();
    const response = await f.start("grill");
    expect(response.status).toBe(201);
    const run = await json(response);
    expect(run).toMatchObject({ status: "awaiting_decision", backend: "openshell", review: { diffSha256: sha("d"), receipt: { protocol: "genbi-validate/1" }, binding: { generation: f.binding.generation } } });
    expect(run).not.toHaveProperty("review.snapshot.files");
    expect(f.validate).toHaveBeenCalledOnce();
    const request = f.validate.mock.calls[0]![0];
    expect(request.proposal).toMatchObject({ hash: run.proposalHash, projectRevision: f.binding.revision }); expect(request.binding).toEqual(f.binding);
    expect(f.store.getEnrichmentValidation(run.id)).toMatchObject({ outcome: "validated", review: { version: 1 } });
    expect(f.store.listEnrichmentOperations(run.id)).toEqual([expect.objectContaining({ state: "awaiting_decision" })]);
    expect(f.store.listEnrichmentEvents(run.id).map((event) => event.kind)).toEqual(expect.arrayContaining(["drafted", "validated"]));
  });

  it("S2-2: a failed verdict ends terminal validation_failed with sanitized evidence and no operation is approvable", async () => {
    const f = build({ withApply: true, validator: { validate: async () => failedVerdict() } });
    const response = await f.start();
    expect(response.status).toBe(422);
    const body = await json(response); expect(body).toMatchObject({ code: "validation_failed" }); expect(JSON.stringify(body)).not.toMatch(/\/srv|\/sandbox/);
    const run = f.store.getLatestEnrichmentRun()!;
    expect(run).toMatchObject({ status: "validation_failed", backend: "openshell" });
    expect(f.store.listEnrichmentOperations(run.id)).toEqual([expect.objectContaining({ state: "validation_failed", decision: null, completed: false })]);
    expect(f.store.getEnrichmentValidation(run.id)).toMatchObject({ outcome: "failed", failure: { stage: "validator", code: "validator_failed" } });
    const dto = await json(await f.app.request("/api/context/enrichment")); expect(JSON.stringify(dto)).toContain("validator_failed");
  });

  it.each([["unavailable", 503, "validator_unavailable"], ["unsupported", 503, "validator_unavailable"], ["stale", 409, "stale"], ["cancelled", 409, "cancelled"], ["timeout", 503, "timeout"], ["cleanup", 503, "cleanup"], ["failed", 503, "failed"]] as const)(
    "S2-5: a validation that ends %s is terminal validation_failed and never awaiting_decision", async (code, status, reason) => {
      const f = build({ validator: { validate: async () => { throw new StructuredRuntimeError(code); } } });
      const response = await f.start();
      expect(response.status).toBe(status);
      const run = f.store.getLatestEnrichmentRun()!;
      expect(run.status).toBe("validation_failed");
      expect(f.store.getEnrichmentValidation(run.id)).toMatchObject({ outcome: "failed", failure: { stage: "runtime", code: reason } });
      expect(f.store.listEnrichmentOperations(run.id).every((operation) => operation.state === "validation_failed")).toBe(true);
    });
  it("an unexpected throw from the validator also ends validation_failed", async () => {
    const f = build({ validator: { validate: async () => { throw new Error("private detail at /srv/secret"); } } });
    expect((await f.start()).status).toBe(503);
    const run = f.store.getLatestEnrichmentRun()!;
    expect(run.status).toBe("validation_failed"); expect(JSON.stringify(f.store.getEnrichmentValidation(run.id))).not.toContain("/srv");
  });
  it("S2-5: cancelling the request during validation ends validation_failed(cancelled)", async () => {
    const controller = new AbortController();
    const f = build({ validator: { validate: async (_request, scope) => { controller.abort(); scope.signal!.throwIfAborted(); throw Error("cancellation was not observed"); } } });
    await Promise.resolve(f.start("grill", controller.signal)).catch(() => undefined);
    await vi.waitFor(() => expect(f.store.getLatestEnrichmentRun()?.status).toBe("validation_failed"));
    expect(f.store.getEnrichmentValidation(f.store.getLatestEnrichmentRun()!.id)).toMatchObject({ failure: { code: "cancelled" } });
  });
  it("S2-5: a binding generation change during validation ends validation_failed(stale)", async () => {
    const f = build({ validator: { validate: async (_request, scope) => { f.store.activateEnrichmentBinding(resolveEnrichmentBinding(f.projectDir)); scope.assertCurrent(); return failedVerdict(); } } });
    expect([409, 503]).toContain((await f.start()).status);
    const run = f.store.getLatestEnrichmentRun()!;
    expect(run.status).toBe("validation_failed"); expect(f.store.getEnrichmentValidation(run.id)).toMatchObject({ failure: { code: "stale" } });
  });
  it("S2-5: a runtime settings change during validation ends validation_failed(stale)", async () => {
    const f = build({ validator: { validate: async (_request, scope) => { f.store.setRuntimeSettings({ ...f.store.getRuntimeSettings(), subscriptionProvider: "codex" }); scope.assertCurrent(); return failedVerdict(); } } });
    await f.start();
    expect(f.store.getLatestEnrichmentRun()!.status).toBe("validation_failed");
  });
  it("S2-5: a run cancelled through its route while validating can never become validated, even if the validator then reports success", async () => {
    let cancelled = 0;
    const f = build({ validator: { validate: async (request) => {
      const run = f.store.getLatestEnrichmentRun()!;
      cancelled = (await f.app.request(`/api/context/enrichment/${run.id}/cancel`, { method: "POST", body: JSON.stringify({ expectedVersion: run.version }) })).status;
      return { status: "validated", review: syntheticReview(request) };
    } } });
    await f.start();
    const run = f.store.getLatestEnrichmentRun()!;
    expect(cancelled).toBe(200); expect(run.status).toBe("cancelled"); expect(f.store.getEnrichmentValidation(run.id)).toBeUndefined();
    expect(f.store.listEnrichmentOperations(run.id).every((operation) => operation.state === "validation_pending")).toBe(true);
  });
  it("S2-5: the validation settles exactly once (a second settle of the same version is refused)", async () => {
    const f = build();
    const run = await json(await f.start());
    expect(f.store.settleEnrichmentValidation({ runId: run.id, expectedVersion: run.version - 1, outcome: { kind: "failed", failure: { version: 1, stage: "runtime", code: "failed", message: "x" } } })).toBe(false);
    expect(f.store.getEnrichmentRun(run.id)!.status).toBe("awaiting_decision");
  });

  it.each(["decision", "edit", "approval", "apply"] as const)("S2-6: validation_failed is never approvable: %s is refused and nothing is applied", async (action) => {
    const f = build({ withApply: true, validator: { validate: async () => failedVerdict() } });
    await f.start();
    const run = f.store.getLatestEnrichmentRun()!; const operation = f.store.listEnrichmentOperations(run.id)[0]!;
    const body = { operationId: operation.id, expectedVersion: run.version, proposalHash: run.proposalHash, projectRevision: run.projectRevision, decision: "accept", sink: operation.sink, changeKind: operation.changeKind, summary: "x", draft: "y" };
    const response = await f.app.request(`/api/context/enrichment/${run.id}/${action}`, { method: "POST", body: JSON.stringify(body) });
    expect(response.status).toBe(409); expect(JSON.stringify(await response.json())).toContain("failed sandbox validation");
    expect(f.apply).not.toHaveBeenCalled();
    expect(f.store.getEnrichmentRun(run.id)).toMatchObject({ status: "validation_failed", version: run.version });
    expect(f.store.listEnrichmentOperations(run.id)[0]).toMatchObject({ state: "validation_failed", decision: null, completed: false });
  });
  it("S2-6 / M2: a validated OpenShell run takes no per-operation decision or approval and is never applied by the local apply path", async () => {
    const f = build({ withApply: true });
    // autopilot + a low-risk knowledge append would reach `ready` on accept, which is where the local path calls the apply runner.
    const run = await json(await f.start("autopilot"));
    expect(run.status).toBe("awaiting_decision");
    const operation = run.operations[0];
    const body = { operationId: operation.id, decision: "accept", expectedVersion: run.version, proposalHash: run.proposalHash, projectRevision: run.projectRevision };
    for (const route of ["decision", "approval", "retry", "reapply"]) {
      const response = await f.app.request(`/api/context/enrichment/${run.id}/${route}`, { method: "POST", body: JSON.stringify(body) });
      expect(response.status, route).toBe(409); expect(JSON.stringify(await response.json())).toContain("one unit");
    }
    expect(f.apply).not.toHaveBeenCalled();
    expect(f.store.listEnrichmentOperations(run.id)[0]).toMatchObject({ state: "awaiting_decision", decision: null, completed: false });
    expect(f.store.getEnrichmentRun(run.id)).toMatchObject({ status: "awaiting_decision", version: run.version });
    expect(f.store.hasExactEnrichmentAttestation(run.id, operation.id)).toBe(false);
    // The per-operation apply body is not apply-all: no apply host is configured here, so it is unavailable, and the local runner is untouched.
    const direct = await f.app.request(`/api/context/enrichment/${run.id}/apply`, { method: "POST", body: JSON.stringify({ operationId: operation.id, expectedVersion: run.version }) });
    expect(direct.status).toBe(503); expect(f.apply).not.toHaveBeenCalled();
    const pending = build({ withApply: true }); const p = pendingRun(pending);
    expect((await pending.app.request(`/api/context/enrichment/${p.id}/apply`, { method: "POST", body: JSON.stringify({ operationId: p.operations[0]!.id, expectedVersion: p.version }) })).status).toBe(409);
    expect(pending.apply).not.toHaveBeenCalled();
  });
  it("a validated OpenShell proposal cannot be edited until it can be validated again (decision edit and the edit route are refused)", async () => {
    const f = build({ withApply: true });
    const run = await json(await f.start("grill"));
    const decision = await f.app.request(`/api/context/enrichment/${run.id}/decision`, { method: "POST", body: JSON.stringify({ operationId: run.operations[0].id, decision: "edit", expectedVersion: run.version, proposalHash: run.proposalHash, projectRevision: run.projectRevision }) });
    expect(decision.status).toBe(409);
    const edit = await f.app.request(`/api/context/enrichment/${run.id}/edit`, { method: "POST", body: JSON.stringify({ operationId: run.operations[0].id, expectedVersion: run.version, sink: "knowledge/rules/revenue.md", changeKind: "knowledge_append", summary: "s", draft: "d" }) });
    expect(edit.status).toBe(409); expect(f.store.getEnrichmentRun(run.id)).toMatchObject({ status: "awaiting_decision", version: run.version });
  });
  it("the local backend keeps its host ladder, its status and its apply path untouched", async () => {
    const f = build({ selected: "local", withApply: true });
    const run = await json(await f.start("autopilot"));
    expect(f.store.getEnrichmentRun(run.id)).toMatchObject({ backend: "local" });
    expect(f.validate).not.toHaveBeenCalled(); expect(f.verify).toHaveBeenCalledOnce(); expect(f.apply).toHaveBeenCalled();
  });
  it("S2-4: an adapter with no verified validator refuses a run before any ledger row, and StructuredRuntime.validateEnrichment is unavailable", async () => {
    const f = build({ validator: { available: false } });
    const response = await f.start();
    expect(response.status).toBe(503); expect(await response.json()).toMatchObject({ code: "unavailable" });
    expect(f.store.getLatestEnrichmentRun()).toBeUndefined(); expect(f.prov.prepareEnrichment).not.toHaveBeenCalled();
    await expect(f.runtime.validateEnrichment({ authChoice: claude, proposal: { id: "p", hash: "h", projectRevision: "r", operations: [] }, binding: f.binding }, { sessionId: "s", turnId: "t", assertCurrent() {} })).rejects.toMatchObject({ code: "unavailable" });
    expect(f.validate).not.toHaveBeenCalled();
  });
  it("a validator that becomes unavailable after drafting still ends the run terminal validation_failed (analysis readiness is not involved)", async () => {
    let available = true;
    const f = build({ validator: { get available() { return available; }, validate: async () => { available = false; throw new StructuredRuntimeError("unavailable"); } } as ValidatorScript });
    expect((await f.start()).status).toBe(503);
    expect(f.store.getLatestEnrichmentRun()!.status).toBe("validation_failed");
  });
  it("S2-5: a BFF restart mid-validation marks the run validation_failed(interrupted) and never resumes it", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "genbi-validation-restart-")); dirs.push(directory); const file = path.join(directory, "genbi.sqlite");
    const projectDir = project();
    const first = new Store(file);
    first.setSetupSteps(first.getSetupSteps().map((step) => step.key === "bind" ? { ...step, state: "done" } : step));
    const binding = first.activateEnrichmentBinding(resolveEnrichmentBinding(projectDir));
    const created = first.createDraftingEnrichmentRun({ id: "enrichment-restart", mode: "grill", binding, backend: "openshell" });
    const proposal = canonicalizeProposal({ operations: [{ sink: "knowledge/rules/revenue.md", changeKind: "knowledge_append", summary: "s", draft: "d" }] }, binding.revision);
    first.finalizeEnrichmentDraft({ runId: created.id, expectedVersion: created.version, proposalId: proposal.id, proposalHash: proposal.hash, operations: proposal.operations, pendingValidation: true });
    const drafting = first.createDraftingEnrichmentRun({ id: "enrichment-restart-drafting", mode: "grill", binding, backend: "openshell" });
    first.close();
    const second = new Store(file); stores.push(second);
    expect(second.getEnrichmentRun(created.id)).toMatchObject({ status: "validation_failed", backend: "openshell" });
    expect(second.getEnrichmentRun(created.id)!.errorMessage).toMatch(/interrupted/);
    expect(second.getEnrichmentRun(drafting.id)).toMatchObject({ status: "failed" });
    expect(second.listEnrichmentOperations(created.id).every((operation) => operation.state === "validation_failed")).toBe(true);
    expect(second.getEnrichmentValidation(created.id)).toMatchObject({ outcome: "failed", failure: { stage: "runtime", code: "interrupted" } });
    expect(second.settleEnrichmentValidation({ runId: created.id, expectedVersion: second.getEnrichmentRun(created.id)!.version, outcome: { kind: "validated", review: {} as never } })).toBe(false);
  });
});

describe("enrichment review follow-ups", () => {
  const scope = (signal?: AbortSignal): StructuredScope => ({ sessionId: "enrichment-run", turnId: "enrichment-draft", ...(signal ? { signal } : {}), assertCurrent() {} });
  const options = { authChoice: claude, userProject: "/fixture", mode: "grill" as const, projectRevision: "sha256:rev" };
  it("finding 1: the abort listener is not live during preparation: an abort during stage-2 preparation still disposes the freshly prepared host", async () => {
    const controller = new AbortController(); const disposed = [vi.fn(async () => {}), vi.fn(async () => {})]; let stage = 0;
    const prepareEnrichment = vi.fn(async (input: OpenShellEnrichmentPreparation): Promise<OpenShellPreparedHost> => {
      const index = stage++; if (index === 1) controller.abort();
      return { assertCurrent() {}, async run() { return okValue({ enrichment_gaps: [] }); }, dispose: disposed[index]! };
    });
    const adapter = createOpenShellStructuredAdapter({ probe: async () => runtimeReady("synthetic", []), prepare: vi.fn(), prepareEnrichment, enrichmentApprovedFiles: () => SLICE5_APPROVED_FILES });
    await expect(adapter.enrich!(options, scope(controller.signal))).rejects.toMatchObject({ code: "cancelled" });
    expect(prepareEnrichment).toHaveBeenCalledTimes(2);
    expect(disposed[1]).toHaveBeenCalledTimes(1); expect(disposed[0]).toHaveBeenCalledTimes(1);
  });
  it("finding 4: the purpose is set by the typed entry points, never inferred from an input's shape (an Ask input carrying `stage` is still analysis)", async () => {
    const assertCurrent = vi.fn(); const askInput = { options: { profileSource: "analysis-profile", userProject: "/fixture" }, scope: { sessionId: "s", turnId: "t", signal: new AbortController().signal, assertCurrent }, persistRoot: async () => {}, onEvent() {}, stage: "draft_enrichment" };
    const provisioner = createOpenShellStructuredProvisioner({ composition: {} as never, store: {} as never, producerBinary: "", wrenBinary: "", profileSource: "analysis-profile", hostHome: "", sourceWrenHome: () => "", getBinding: () => undefined, modelsFor: () => ({}), assertConfigurationCurrent() {} });
    await expect(provisioner.prepare(askInput as never)).rejects.toMatchObject({ code: "unavailable" });
    // Analysis admission reached its currentness checks; an enrichment admission (no enrichment profile configured) would have refused before them.
    expect(assertCurrent).toHaveBeenCalled();
    assertCurrent.mockClear();
    await expect(provisioner.prepareEnrichment!({ ...askInput, stage: "draft_enrichment", request: "r", options: { ...askInput.options, mode: "grill", projectRevision: "r" } } as never)).rejects.toMatchObject({ code: "unavailable" });
    expect(assertCurrent).not.toHaveBeenCalled();
  });
  it("finding 7: a contract refusal from the sink is a 400 contract_error with a terminal failed run (as locally), not a 503 runtime error", async () => {
    const f = build({ script: { draft: async () => proposalValue([{ ...goodOperation, relative_sink: "src/evil.ts" }]) } });
    const response = await f.start();
    expect(response.status).toBe(400); expect(JSON.stringify(await response.json())).toContain("sink");
    expect(f.store.getLatestEnrichmentRun()).toMatchObject({ status: "failed" });
  });
  it("a refusal that is not a contract error (a timeout, a cleanup failure) stays a runtime failure", async () => {
    const f = build({ script: { disposeFails: true } });
    expect((await f.start()).status).toBe(503);
  });
});

describe("M3: a failure while recording a validation failure never leaves the run validation_pending", () => {
  const failed = (): EnrichmentValidationResult => ({ status: "failed", failure: { version: 1, stage: "validator", code: "validator_failed", message: "Validation failed at dry_run." } });
  const flaky = (f: ReturnType<typeof build>, failures: number) => {
    const original = f.store.settleEnrichmentValidation.bind(f.store); let calls = 0;
    vi.spyOn(f.store, "settleEnrichmentValidation").mockImplementation((params) => { if (++calls <= failures) throw new Error("database is locked"); return original(params); });
    return () => calls;
  };
  it("a failed verdict whose settle throws twice is retried against the live version and still ends validation_failed", async () => {
    const f = build({ validator: { validate: async () => failed() } }); const calls = flaky(f, 2);
    const response = await f.start(); expect(response.status).toBe(422);
    expect(f.store.getLatestEnrichmentRun()).toMatchObject({ status: "validation_failed" }); expect(calls()).toBe(3);
    expect(f.store.getEnrichmentValidation(f.store.getLatestEnrichmentRun()!.id)).toMatchObject({ outcome: "failed", failure: { code: "validator_failed" } });
  });
  it("the catch path (the validator itself threw) survives a failing settle", async () => {
    const f = build({ validator: { validate: async () => { throw new StructuredRuntimeError("timeout"); } } }); const calls = flaky(f, 1);
    const response = await f.start(); expect(response.status).toBe(503);
    expect(f.store.getLatestEnrichmentRun()).toMatchObject({ status: "validation_failed" }); expect(calls()).toBe(2);
  });
  it("a settle that throws on a validated verdict is recorded as a failure instead of leaving the run pending", async () => {
    const f = build(); const calls = flaky(f, 1);
    const response = await f.start(); expect(response.status).toBeGreaterThanOrEqual(409);
    expect(f.store.getLatestEnrichmentRun()).toMatchObject({ status: "validation_failed" }); expect(calls()).toBe(2);
  });
  it("a database that never recovers still answers with a failure response (no unhandled 500) and never reports success", async () => {
    const f = build({ validator: { validate: async () => failed() } }); flaky(f, 99);
    const response = await f.start(); expect([422, 503]).toContain(response.status); expect(await response.json()).toMatchObject({ code: "validation_failed" });
  });
});

describe("the OpenShell draft prompt note", () => {
  it("lists exactly the allowed change kinds, each with one example shape, and no host-local kind", async () => {
    const { composeDraftPrompt, OPENSHELL_DRAFT_NOTE, OPENSHELL_CHANGE_KINDS } = await import("../server/enrichment-runner.js");
    expect([...OPENSHELL_CHANGE_KINDS]).toEqual(["knowledge_append", "description_append", "new_relationship"]);
    const { selectEditableFiles } = await import("../server/enrichment-runner.js");
    const prompt = composeDraftPrompt("grill", "sha256:rev", "gaps", { runtime: "openshell", editableFiles: selectEditableFiles(SLICE5_APPROVED_FILES) });
    expect(prompt).toContain("exactly one of: knowledge_append, description_append, new_relationship;");
    expect(OPENSHELL_DRAFT_NOTE).toContain("exactly one of: knowledge_append, description_append, new_relationship.");
    expect(OPENSHELL_DRAFT_NOTE).toContain('Every operation MUST carry a "changeKind"');
    const example = /\{"enrichment_proposal":\{"operation":\{[^]*?\}\}\}/.exec(prompt)![0];
    expect(JSON.parse(example)).toEqual({ enrichment_proposal: { operation: { changeKind: "knowledge_append", relative_sink: "knowledge/metrics/revenue.md", summary: "Document revenue", recommended_yaml: "Revenue is net of refunds." } } });
    for (const refused of ["new_cube", "new_view", "calculated_column", "mdl_metric", "conflict", "ambiguous"]) expect(prompt.slice(prompt.indexOf("exactly one of"), prompt.indexOf("; and a"))).not.toContain(refused);
    expect(composeDraftPrompt("grill", "sha256:rev", "gaps")).toContain("knowledge_append, new_cube, new_view, new_relationship, mdl_metric, calculated_column, conflict, ambiguous");
    expect(composeDraftPrompt("grill", "sha256:rev", "gaps")).not.toContain("description_append");
  });
});

describe("draft terminal translation", () => {
  it("translates a singular operation, an operations array and the flat form identically", async () => {
    const { translateDraftTerminal } = await import("../server/enrichment-runner.js");
    const op = { relative_sink: "knowledge/rules/revenue.md", change_kind: "knowledge_append", summary: "s", recommended_yaml: "text", confidence: "high" };
    const expected = { operations: [{ sink: "knowledge/rules/revenue.md", changeKind: "knowledge_append", summary: "s", draft: "text", confidence: "high" }] };
    for (const proposal of [{ operation: op }, { operations: [op] }, op]) expect(translateDraftTerminal(JSON.stringify({ enrichment_proposal: proposal }))).toEqual(expected);
  });
  it("refuses both operation and operations, and a non-object operation", async () => {
    const { translateDraftTerminal } = await import("../server/enrichment-runner.js");
    const op = { relative_sink: "knowledge/rules/revenue.md", changeKind: "knowledge_append", summary: "s", recommended_yaml: "t" };
    for (const proposal of [{ operation: op, operations: [op] }, { operation: "text" }, { operation: [op] }, { operation: null }]) expect(() => translateDraftTerminal(JSON.stringify({ enrichment_proposal: proposal }))).toThrow();
  });
  it("copies only the five fields by name, dropping forged hash, id, risk and revision", async () => {
    const { translateDraftTerminal } = await import("../server/enrichment-runner.js");
    const out = translateDraftTerminal(JSON.stringify({ enrichment_proposal: { hash: "x", operation: { relative_sink: "knowledge/rules/a.md", changeKind: "knowledge_append", summary: "s", recommended_yaml: "t", hash: "forged", id: "forged", risk: "low", projectRevision: "forged" } } }));
    expect(Object.keys((out as { operations: object[] }).operations[0]!).sort()).toEqual(["changeKind", "confidence", "draft", "sink", "summary"]);
    expect(JSON.stringify(out)).not.toContain("forged");
  });
  it("describes a refused terminal with allowlisted key names and an other-count only, even with hostile keys", async () => {
    const { describeDraftShape } = await import("../server/enrichment-runner.js");
    const hostile = "secret-key-/home/user/x";
    const shape = describeDraftShape(JSON.stringify({ enrichment_proposal: { operation: { relative_sink: "a", [hostile]: "v", recommended_yaml: "t", private_thing: 1 }, [hostile + "2"]: 1, impact: "high" } }));
    expect(shape).toEqual({ proposal: { keys: ["operation", "impact"], other: 1 }, operations: [{ keys: ["relative_sink", "recommended_yaml"], other: 2 }] });
    expect(JSON.stringify(shape)).not.toMatch(/secret|home|private_thing/);
    expect(describeDraftShape("not json")).toEqual({ operations: [] });
  });
});
