import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { BROKER_GRANTS, createComponentBroker, type ComponentIdentity } from "../harness/components/broker.js";
import { normalizeEnrichmentEvidence } from "../harness/components/normalize-enrichment.js";
import { planDigest } from "../harness/components/plan.js";
import { ComponentRunner, type ExecutionPlan, type StepRun } from "../harness/components/runner.js";
import { resolveWarbleBinary } from "../harness/compile/resolve-binary.js";
import { prepareNativeComponentHost, prepareStructuredAskComponentHost, prepareStructuredEnrichComponentHost, type NativeComponentBindings } from "../server/native-component-preparation.js";
import { deriveOpenShellEnrichmentIr } from "../server/openshell-enrichment.js";
import { createNativeComponentRuntimeBindings } from "../server/native-component-runtime.js";
import { produceComponentHostPlan } from "../server/runtime-host/component-host-plan.js";

const pristineDocument = readFileSync(new URL("../profiles/genbi-enrich-context/ir.golden.json", import.meta.url), "utf8");
const enrichDocument = deriveOpenShellEnrichmentIr(pristineDocument);
const askDocument = readFileSync(new URL("../profiles/genbi-default/ir.golden.json", import.meta.url), "utf8");
const enrichContext = JSON.parse(readFileSync(new URL("../profiles/genbi-enrich-context/context/context.json", import.meta.url), "utf8")) as unknown;
let producer: string;
beforeAll(async () => { producer = await resolveWarbleBinary(process.env.WARBLE_TEST_CLI); });

const proposal = { enrichment_proposal: { operations: [{ relative_sink: "knowledge/rules/revenue.md", changeKind: "knowledge_append", summary: "Document revenue", recommended_yaml: "Revenue is net of refunds." }] } };

function bindings(document: string, snapshotFor: (node: { id: string }) => unknown, extra: Partial<NativeComponentBindings> = {}) {
  const ir = JSON.parse(document) as { components: { id: string; context_binding: Record<string, unknown> }[] };
  const identity = { session_id: "synthetic", vendor: "claude" as const, auth_identity: "approved", runtime_generation: "1", binding: { project_identity: "project", generation: "1", revision: "revision" } };
  const steps: StepRun[] = [];
  const access = { async query() { throw new Error("no query grant"); }, async inspect() { return { models: [] }; }, async close() {} };
  const value: NativeComponentBindings = {
    identity, contexts: Object.fromEntries(ir.components.map((node) => [node.id, { binding: node.context_binding, snapshot: snapshotFor(node) }])),
    verifierBinary: producer, currentIdentity: () => identity, assertCurrent() {},
    prepare: vi.fn(async () => access),
    step: vi.fn(async (run: StepRun) => { steps.push(run); return { value: JSON.stringify(run.request.includes("Draft") ? proposal : { enrichment_gaps: [] }) }; }),
    normalize: vi.fn(async (component, evidence) => normalizeEnrichmentEvidence(component, evidence)),
    ...extra,
  };
  return { ir, identity, value, steps };
}
const enrichBindings = (extra: Partial<NativeComponentBindings> = {}) => bindings(enrichDocument, () => enrichContext, extra);
const entry = (verb: string) => ({ kind: "agent", verb, prompt: "synthetic" });

async function run(verb: "inspect_context" | "draft_enrichment", extra: Partial<NativeComponentBindings> = {}) {
  const f = enrichBindings(extra);
  const prepared = prepareStructuredEnrichComponentHost(enrichDocument, { binding: f.identity.binding, entry: entry(verb) }, f.value);
  const controller = new AbortController();
  const { root, plan } = await produceComponentHostPlan({ irDocument: enrichDocument, prepared, producerBinary: producer, signal: controller.signal, assertCurrent() {} });
  const host = await prepared.host(root, plan, controller.signal);
  const result = await new ComponentRunner(plan, host).run(root, { request: verb === "draft_enrichment" ? "Draft now" : "Inspect now" }, controller.signal);
  return { f, prepared, plan, result };
}

describe("enrichment host preparation", () => {
  it("pins exactly one enrichment stage root and refuses every other entry", () => {
    for (const verb of ["inspect_context", "draft_enrichment"]) {
      const f = enrichBindings();
      const prepared = prepareStructuredEnrichComponentHost(enrichDocument, { binding: f.identity.binding, entry: entry(verb) }, f.value);
      expect(Object.keys(prepared.hostRoots)).toEqual([verb]);
    }
    for (const bad of [entry("apply_enrichment"), entry("answer_query"), { kind: "scope", prompt: "synthetic" }]) {
      const f = enrichBindings();
      expect(() => prepareStructuredEnrichComponentHost(enrichDocument, { binding: f.identity.binding, entry: bad }, f.value)).toThrow();
    }
    const f = enrichBindings();
    expect(() => prepareStructuredEnrichComponentHost(enrichDocument, { binding: f.identity.binding, entry: entry("draft_enrichment") }, { ...f.value, identity: { ...f.identity, vendor: "codex" } })).toThrow();
  });

  it("scopes the propose grant to draft_enrichment and rejects any plain root persistence", () => {
    const persist = vi.fn();
    const f = enrichBindings({ propose: { component: "draft_enrichment", persist } });
    expect(() => prepareStructuredEnrichComponentHost(enrichDocument, { binding: f.identity.binding, entry: entry("draft_enrichment") }, f.value)).not.toThrow();
    expect(() => prepareStructuredEnrichComponentHost(enrichDocument, { binding: f.identity.binding, entry: entry("inspect_context") }, f.value)).toThrow("Invalid enrichment write grant");
    const forged = enrichBindings({ propose: { component: "inspect_context", persist } });
    expect(() => prepareStructuredEnrichComponentHost(enrichDocument, { binding: forged.identity.binding, entry: entry("draft_enrichment") }, forged.value)).toThrow("Invalid enrichment write grant");
    const rooted = enrichBindings({ persistRoot: vi.fn() });
    expect(() => prepareStructuredEnrichComponentHost(enrichDocument, { binding: rooted.identity.binding, entry: entry("draft_enrichment") }, rooted.value)).toThrow("Invalid enrichment write grant");
  });

  it("derives the sandbox-realizable IR by subtraction only", () => {
    const before = JSON.parse(pristineDocument) as { components: { id: string; required_capabilities: string[]; effect: { render_blocks?: unknown[] } }[] };
    const after = JSON.parse(enrichDocument) as typeof before;
    for (const node of after.components) {
      const original = before.components.find((candidate) => candidate.id === node.id)!;
      expect(original.required_capabilities).toEqual(expect.arrayContaining(node.required_capabilities));
      expect(node.required_capabilities).not.toContain("raw_material_read");
      if (node.id === "inspect_context" || node.id === "draft_enrichment") expect(node.effect.render_blocks ?? []).toEqual([]);
    }
    expect(before.components.find((node) => node.id === "inspect_context")!.required_capabilities).toContain("raw_material_read");
    expect(before.components.find((node) => node.id === "apply_enrichment")).toEqual(after.components.find((node) => node.id === "apply_enrichment"));
    expect(() => deriveOpenShellEnrichmentIr("{}")).toThrow();
    const f = bindings(pristineDocument, () => enrichContext);
    expect(() => prepareStructuredEnrichComponentHost(pristineDocument, { binding: f.identity.binding, entry: entry("inspect_context") }, f.value)).toThrow("Unsupported native component capability");
  });

  it("analysis preparations can never carry the propose grant", () => {
    const persist = vi.fn();
    const ask = bindings(askDocument, () => ({ context_version: 2, parseable: true }), { propose: { component: "answer_query", persist } });
    expect(() => prepareStructuredAskComponentHost(askDocument, { binding: ask.identity.binding, entry: { kind: "agent", verb: "answer_query", prompt: "synthetic" } }, ask.value)).toThrow("proposal grant");
    expect(() => prepareNativeComponentHost(askDocument, { binding: ask.identity.binding, entry: { kind: "scope", prompt: "synthetic" } }, ask.value)).toThrow("proposal grant");
  });

  it("the runtime bindings refuse a proposal sink outside the enrichment purpose or beside a root sink", () => {
    const base = { identity: { session_id: "s", vendor: "claude" as const, auth_identity: "a", runtime_generation: "1", binding: { project_identity: "p", generation: "1", revision: "r" } },
      contexts: {}, verifierBinary: "unused", currentIdentity: () => undefined, assertCurrent() {}, vendor: { vendor: "claude", authIdentity: "a", accountEmail: "e", generation: "1", models: {}, assertCurrent() {}, open: vi.fn() },
      wren: { executable: "unused", project: "/synthetic", fingerprint: "f", identity: {} } } as never as Parameters<typeof createNativeComponentRuntimeBindings>[0];
    const propose = { component: "draft_enrichment", persist: vi.fn() };
    expect(() => createNativeComponentRuntimeBindings({ ...base, propose })).toThrow("enrichment purpose");
    expect(() => createNativeComponentRuntimeBindings({ ...base, purpose: "enrichment", propose, persistRoot: vi.fn() })).toThrow("enrichment purpose");
  });
});

describe("enrichment broker grants", () => {
  const plan: ExecutionPlan = { identity: "plan", entries: ["draft"], components: { draft: { id: "draft", declaration: { context_binding: {}, required_capabilities: [], effect: {}, guardrails: [{ name: "read_only_execution", locked: true }] },
    steps: [{ name: "draft", tier: "strong", prompt: "p", consumes: [], produces: "out", tools: [], calls: [] }] } } };
  const contexts = {};
  const identity: ComponentIdentity = { session: "s", vendor: "claude", account: "a", generation: "1", project: "p", bindingRevision: "r", contextDigest: planDigest(contexts), planDigest: "plan" };
  const options = { plan, contexts, verifierBinary: "unused", identity, currentIdentity: () => identity, prepare: vi.fn(), step: vi.fn(), normalize: vi.fn() };
  it("fixes the grant set per purpose", () => {
    expect(BROKER_GRANTS.analysis).toEqual(["query", "inspect"]);
    expect(BROKER_GRANTS.enrichment).toEqual(["query", "inspect", "propose"]);
  });
  it("refuses propose to the analysis purpose (default and explicit) and to a component outside the plan", () => {
    const propose = { component: "draft", persist: vi.fn() };
    expect(() => createComponentBroker({ ...options, propose })).toThrow("Proposal grant");
    expect(() => createComponentBroker({ ...options, purpose: "analysis", propose })).toThrow("Proposal grant");
    expect(() => createComponentBroker({ ...options, purpose: "enrichment", propose: { component: "other", persist: vi.fn() } })).toThrow("Proposal grant");
    expect(() => createComponentBroker({ ...options, purpose: "enrichment", propose, persistRoot: vi.fn() })).toThrow();
    expect(() => createComponentBroker({ ...options, purpose: "enrichment", persistRoot: vi.fn() })).toThrow("no root persistence");
    expect(() => createComponentBroker({ ...options, purpose: "enrichment", propose })).not.toThrow();
  });
});

describe("enrichment tool authority", () => {
  const component = (tools: { name: string; source: string }[]) => ({ id: "draft", declaration: { context_binding: {}, required_capabilities: [], effect: {}, guardrails: [{ name: "read_only_execution", locked: true }] },
    steps: [{ name: "draft", tier: "strong", prompt: "p", consumes: [], produces: "out", tools, calls: [] }] });
  const contexts = {};
  const identity: ComponentIdentity = { session: "s", vendor: "claude", account: "a", generation: "1", project: "p", bindingRevision: "r", contextDigest: planDigest(contexts), planDigest: "plan" };
  const brokerFor = (tools: { name: string; source: string }[]) => {
    const node = component(tools); const prepare = vi.fn();
    const broker = createComponentBroker({ plan: { identity: "plan", entries: ["draft"], components: { draft: node } }, contexts, verifierBinary: "unused", purpose: "enrichment",
      propose: { component: "draft", persist: vi.fn() }, identity, currentIdentity: () => identity, prepare, step: vi.fn(), normalize: vi.fn() });
    return { broker, node, prepare };
  };
  it.each([["propose", "native"], ["write_file", "native"], ["query", "mcp:ambient/query"], ["propose", "host:propose"], ["exec", "host:shell"]])("refuses the %s grant from %s before opening any access", async (name, source) => {
    const f = brokerFor([{ name, source }]);
    await expect(f.broker.prepare(f.node, new AbortController().signal)).rejects.toThrow("Unsupported component tool binding");
    expect(f.prepare).not.toHaveBeenCalled();
  });
});

describe("enrichment stages through the real producer plan and the governed runner", () => {
  it("runs draft_enrichment with only governed introspection, no render contract, and persists only via the propose grant", async () => {
    const persist = vi.fn(async () => {});
    const { f, plan, result } = await run("draft_enrichment", { propose: { component: "draft_enrichment", persist } });
    expect(result).toMatchObject({ status: "ok", output: { kind: "value", value: proposal } });
    expect(persist).toHaveBeenCalledOnce();
    const step = f.steps[0]!;
    expect(Object.keys(step.tools)).toEqual(expect.arrayContaining([]));
    expect(Object.keys(step.tools).every((name) => name !== "propose" && name !== "query")).toBe(true);
    expect(step.prompt).not.toContain("Render output");
    expect(plan.entries).toEqual(["draft_enrichment"]);
  });
  it("runs inspect_context with no write sink at all", async () => {
    const { result, f } = await run("inspect_context");
    expect(result).toMatchObject({ status: "ok", output: { kind: "value" } });
    expect(f.steps).toHaveLength(1);
  });
  it("refuses the proposal sink for a root that is not the granted component and never leaks a refusal as a result", async () => {
    const persist = vi.fn(async () => {});
    const refusal = enrichBindings({ propose: { component: "draft_enrichment", persist }, step: vi.fn(async () => ({ value: JSON.stringify({ status: "refused", message: "no" }) })) });
    const prepared = prepareStructuredEnrichComponentHost(enrichDocument, { binding: refusal.identity.binding, entry: entry("draft_enrichment") }, refusal.value);
    const controller = new AbortController();
    const { root, plan } = await produceComponentHostPlan({ irDocument: enrichDocument, prepared, producerBinary: producer, signal: controller.signal, assertCurrent() {} });
    const result = await new ComponentRunner(plan, await prepared.host(root, plan, controller.signal)).run(root, { request: "x" }, controller.signal);
    expect(result.status).toBe("refused"); expect(persist).not.toHaveBeenCalled();
  });
  it("revokes the sink when the captured identity changes before persistence", async () => {
    const persist = vi.fn(async () => {});
    let live = true;
    const f = enrichBindings({ propose: { component: "draft_enrichment", persist }, step: vi.fn(async () => { live = false; return { value: JSON.stringify(proposal) }; }) });
    const original = f.value.currentIdentity;
    (f.value as { currentIdentity: NativeComponentBindings["currentIdentity"] }).currentIdentity = () => (live ? original() : { ...f.identity, runtime_generation: "changed" });
    const prepared = prepareStructuredEnrichComponentHost(enrichDocument, { binding: f.identity.binding, entry: entry("draft_enrichment") }, f.value);
    const controller = new AbortController();
    const { root, plan } = await produceComponentHostPlan({ irDocument: enrichDocument, prepared, producerBinary: producer, signal: controller.signal, assertCurrent() {} });
    const result = await new ComponentRunner(plan, await prepared.host(root, plan, controller.signal)).run(root, { request: "Draft now" }, controller.signal);
    expect(result.status).not.toBe("ok"); expect(persist).not.toHaveBeenCalled();
  });
});
