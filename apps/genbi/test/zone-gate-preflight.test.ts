import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { describeComponentPlan } from "../harness/components/display.js";
import type { StepRun } from "../harness/components/runner.js";
import { ZoneGateError } from "../harness/components/zone-gate.js";
import { runInProcessDefault } from "../harness/route/in-process.js";
import { runAiComponentStep } from "../harness/components/ai-step.js";
import { openWrenComponentAccess } from "../harness/components/wren-access.js";
import { generatePreparedContext, generatePreparedContextAndCatalog } from "../harness/compile/context-loader.js";
import { createDefaultProviderRegistry } from "../harness/providers/index.js";
import { policy, reportPlan } from "./zone-fixtures.js";

vi.mock("../harness/components/ai-step.js", () => ({ runAiComponentStep: vi.fn() }));
// The judge model is a bare mock here; a passing judge lets the split run reach its answer. The judge itself is tested in egress-verification.test.ts.
vi.mock("../harness/components/egress-judge.js", () => ({ createModelJudge: () => async () => JSON.stringify({ verdict: "pass", reason_category: "aggregate" }) }));
vi.mock("../harness/components/wren-access.js", async (original) => ({ ...await original<typeof import("../harness/components/wren-access.js")>(), openWrenComponentAccess: vi.fn() }));
vi.mock("../harness/tools/index.js", async (original) => ({ ...await original<typeof import("../harness/tools/index.js")>(), resolveWrenBinary: vi.fn() }));
vi.mock("../harness/compile/context-loader.js", () => ({ resolveContextLoader: () => ({ bin: "synthetic-context-loader" }),
  generatePreparedContext: vi.fn(async (_bin: string, _project: string, output: string) => writeFile(output, JSON.stringify({ context_version: 2, parseable: true }))),
  generatePreparedContextAndCatalog: vi.fn(async (_bin: string, _project: string, output: string, catalog: string) => {
    await writeFile(output, JSON.stringify({ context_version: 2, parseable: true }));
    await writeFile(catalog, JSON.stringify({ catalog_version: 1, project: {}, models: [], relationships: [], cubes: [], views: [] }));
  }),
}));
const created: { adapter: string; config: unknown }[] = [];
vi.mock("../harness/providers/index.js", async (original) => {
  const actual = await original<typeof import("../harness/providers/index.js")>();
  return { ...actual, createDefaultProviderRegistry: () => {
    const registry = actual.createDefaultProviderRegistry();
    return { ...registry, create(adapter: string, config: unknown) { created.push({ adapter, config }); return registry.create(adapter, config); } };
  } };
});

const priv = (modelId: string) => ({ adapter: "mock", config: { modelId }, zone: "private" as const });
const judge = () => priv("nano-judge");
const pub = (modelId: string) => ({ adapter: "mock", config: { modelId }, zone: "public" as const });

beforeEach(() => { vi.resetAllMocks(); created.length = 0; });

describe("zone gate runs before any model, tool or session starts", () => {
  it("a rejected binding constructs no provider, generates no context, opens no wren access and runs no step", async () => {
    const project = await mkdtemp(path.join(os.tmpdir(), "genbi-zone-preflight-"));
    try {
      const plan = { ...reportPlan(), components: Object.fromEntries(Object.entries(reportPlan().components).map(([id, node]) => [id, { ...node, declaration: { ...node.declaration, context_binding: { project } } }])) };
      await expect(runInProcessDefault({ bundle: describeComponentPlan(plan, "synthetic"), userProject: project, profileSource: project, question: "annual revenue report", agentId: "plan_report",
        authChoice: { mode: "api-key", adapter: "openai" },
        tierBinding: { plan: pub("sonnet"), cheap: priv("nano"), strong: pub("cloud-strong"), judge: priv("nano") },
        disclosurePolicy: policy, zoneRoles: { judge: "judge" },
      })).rejects.toThrow(ZoneGateError);
      expect(created).toEqual([]);
      expect(vi.mocked(generatePreparedContext)).not.toHaveBeenCalled();
      expect(vi.mocked(generatePreparedContextAndCatalog)).not.toHaveBeenCalled();
      expect(vi.mocked(openWrenComponentAccess)).not.toHaveBeenCalled();
      expect(vi.mocked(runAiComponentStep)).not.toHaveBeenCalled();
    } finally { await rm(project, { recursive: true, force: true }); }
  });
  it("a valid split binding runs, and a shared tier name binds different models per mount", async () => {
    const project = await mkdtemp(path.join(os.tmpdir(), "genbi-zone-split-"));
    try {
      const base = reportPlan();
      const caller = base.components.plan_report!;
      const plan = { ...base, components: Object.fromEntries(Object.entries({ ...base.components,
        plan_report: { ...caller, steps: caller.steps.map((step) => ({ ...step, tier: "strong" })) } })
        .map(([id, node]) => [id, { ...node, declaration: { ...node.declaration, context_binding: { project } } }])) };
      vi.mocked(openWrenComponentAccess).mockResolvedValue({ query: async () => ({ columns: ["revenue"], rows: [{ revenue: "42" }] }), inspect: async () => ({}), close: async () => {} });
      const seen: { step: string; modelId: string }[] = [];
      const events: unknown[] = [];
      vi.mocked(runAiComponentStep).mockImplementation(async (run: StepRun, model) => {
        seen.push({ step: run.prompt.split("\n")[0]!, modelId: (model as { modelId: string }).modelId });
        if (run.tools.ask) {
          await run.tools.ask({ request: "revenue" });
          return { value: JSON.stringify({ layout: "planned" }) };
        }
        if (run.tools.query) { await run.tools.query({ sql: "SELECT 42 AS revenue" }); return { value: "done" }; }
        return { value: JSON.stringify({ blocks: [{ type: "kpi_card", label: "revenue", value: "42" }] }) };
      });
      const result = await runInProcessDefault({ bundle: describeComponentPlan(plan, "synthetic"), userProject: project, profileSource: project, question: "annual revenue report", agentId: "plan_report",
        authChoice: { mode: "api-key", adapter: "openai" },
        tierBinding: { "plan_report/strong": pub("cloud-strong"), "answer_batch/strong": priv("local-strong"), cheap: priv("nano"), judge: judge() },
        disclosurePolicy: policy, zoneRoles: { judge: "judge" },
        ...(process.env.WARBLE_TEST_CLI ? { warbleBin: process.env.WARBLE_TEST_CLI } : {}),
        onEvent: (event) => events.push(event),
      });
      expect(result.kind).toBe("answer");
      expect(seen.find((entry) => entry.step === "Plan")?.modelId).toBe("cloud-strong");
      expect(seen.find((entry) => entry.step === "Narrate")?.modelId).toBe("cloud-strong");
      expect(seen.find((entry) => entry.step === "Query")?.modelId).toBe("local-strong");
      expect(seen.find((entry) => entry.step === "Resolve")?.modelId).toBe("nano");
      expect(created.map((entry) => (entry.config as { modelId: string }).modelId).sort()).toEqual(["cloud-strong", "local-strong", "nano", "nano-judge"]);
      // The disclosed child value reached the caller without its definition/SQL, and the trace recorded the decision without the payload.
      expect(result.trace?.steps.filter((step) => step.tool === "egress").map((step) => step.detail)).toEqual(["ask/answer: ok"]);
      expect(JSON.stringify(result.trace)).not.toContain("SELECT 42");
    } finally { await rm(project, { recursive: true, force: true }); }
  });
});
