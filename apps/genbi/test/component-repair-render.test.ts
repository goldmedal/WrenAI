import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { describeComponentPlan } from "../harness/components/display.js";
import type { ExecutionPlan, StepRun } from "../harness/components/runner.js";
import { runInProcessDefault } from "../harness/route/in-process.js";
import { runAiComponentStep } from "../harness/components/ai-step.js";
import { openWrenComponentAccess } from "../harness/components/wren-access.js";

vi.mock("../harness/components/ai-step.js", () => ({ runAiComponentStep: vi.fn() }));
vi.mock("../harness/components/wren-access.js", async (original) => ({ ...await original<typeof import("../harness/components/wren-access.js")>(), openWrenComponentAccess: vi.fn() }));
vi.mock("../harness/tools/index.js", async (original) => ({ ...await original<typeof import("../harness/tools/index.js")>(), resolveWrenBinary: vi.fn() }));
vi.mock("../harness/compile/context-loader.js", () => ({ resolveContextLoader: () => ({ bin: "synthetic-context-loader" }),
  generatePreparedContext: async (_bin: string, _project: string, output: string) => writeFile(output, JSON.stringify({ context_version: 2, parseable: true })),
}));

const PLAN_SQL = "SELECT plan, COUNT(*) AS customers FROM customers GROUP BY plan";
const PLAN_ROWS = [{ plan: "free", customers: 3 }, { plan: "pro", customers: 5 }];
const COLUMNS = ["plan", "customers"];

/** A dashboard component shaped like generate_dashboard; `repair` adds a repair step after the layout step. */
function plan(project: string, repair: boolean): ExecutionPlan {
  const declaration = { verb: "answer", type: "analytical", realization_kind: "skill", required_capabilities: ["sql_execution:read_only"],
    context_binding: { project }, guardrails: [{ name: "read_only_execution", locked: true }], effect: { render_blocks: [] } };
  return { identity: "synthetic-dashboard", entries: ["generate_dashboard"], systemPrompt: "Profile instructions", components: {
    generate_dashboard: { id: "generate_dashboard", declaration: { ...declaration, required_capabilities: ["component_invocation", "render_contract"],
      effect: { render_blocks: [
        { type: "kpi_card", fields: { label: "string", value: "number|string", unit: "string?", delta: "number?" } },
        { type: "chart", fields: { chart_type: "bar|line|pie|area|scatter", x: "string", series: "string[]", rows: "row[]" } },
        { type: "definition", fields: { sql: "string", source_tables: "string[]", filters: "string[]?" } },
      ] } },
      steps: [
        { name: "compose_layout", tier: "cheap", prompt: "Compose", consumes: [], produces: "dashboard", tools: [], calls: [{ alias: "answer", component: "answer" }] },
        ...(repair ? [{ name: "repair_layout", tier: "cheap", prompt: "Repair", consumes: ["dashboard"], produces: "repaired_dashboard", tools: [], calls: [], repairOf: "compose_layout" }] : []),
      ] },
    answer: { id: "answer", declaration,
      steps: [{ name: "query", tier: "cheap", prompt: "Read data", consumes: [], produces: "data", tools: [{ name: "query", source: "native" }], calls: [] }] },
  } };
}

const chart = (overrides: Record<string, unknown> = {}) => ({ type: "chart", chart_type: "bar", x: "plan", series: ["customers"], rows: PLAN_ROWS.map((row) => [row.plan, row.customers]), ...overrides });
const definition = () => ({ type: "definition", sql: PLAN_SQL, source_tables: ["customers"], filters: [] });
const kpi = (fields: Record<string, unknown>) => ({ type: "kpi_card", value: 5, ...fields });
const envelope = (blocks: unknown[]) => JSON.stringify({ blocks, summary: "Customers by plan." });
const good = () => envelope([chart(), definition()]);
const badLabel = () => envelope([kpi({ label: { text: "model-secret-77" } }), definition()]);

let project: string;
let logged: string[];
let calls: { step: string; consumes: Record<string, unknown> }[];
beforeEach(async () => {
  vi.resetAllMocks();
  project = await mkdtemp(path.join(os.tmpdir(), "genbi-repair-render-"));
  logged = [];
  calls = [];
  vi.spyOn(console, "error").mockImplementation((line: unknown) => { logged.push(String(line)); });
});
afterEach(async () => { vi.restoreAllMocks(); await rm(project, { recursive: true, force: true }); });

async function run(composeText: string, repairText: string, withRepair = true) {
  vi.mocked(openWrenComponentAccess).mockResolvedValue({
    query: async (input: { sql: string }) => ({ columns: COLUMNS, rows: PLAN_ROWS, definition: { sql: input.sql, source_tables: ["customers"], filters: [] } }),
    inspect: async () => ({}), close: async () => {},
  });
  vi.mocked(runAiComponentStep).mockImplementation(async (step: StepRun) => {
    calls.push({ step: step.prompt, consumes: step.consumes as Record<string, unknown> });
    if (step.tools.answer) { await step.tools.answer({ request: "panel", input: { sql: PLAN_SQL } }); return { value: composeText }; }
    if (step.tools.query) { await step.tools.query({ sql: PLAN_SQL }); return { value: "done" }; }
    return { value: repairText };
  });
  const outcome = await runInProcessDefault({ bundle: describeComponentPlan(plan(project, withRepair), "synthetic"), userProject: project, question: "build dashboard",
    agentId: "generate_dashboard", authChoice: { mode: "api-key", adapter: "openai" }, profileSource: project,
    tierBinding: { strong: { adapter: "mock", config: {} }, cheap: { adapter: "mock", config: {} } },
    ...(process.env.WARBLE_TEST_CLI ? { warbleBin: process.env.WARBLE_TEST_CLI } : {}),
  }).then((result) => ({ result, error: undefined as unknown }), (error: unknown) => ({ result: undefined, error }));
  const lines = logged.filter((line) => line.startsWith("[component-failure]")).map((line) => JSON.parse(line.slice("[component-failure] ".length)) as Record<string, string>);
  return { ...outcome, lines, repairCalls: calls.filter((call) => "dashboard" in call.consumes) };
}

describe("a repair step fixes a render-contract violation in the terminal step", () => {
  it("runs the repair step with the violation and returns the repaired blocks", async () => {
    const out = await run(badLabel(), good());
    expect(out.error).toBeUndefined();
    expect(out.repairCalls).toHaveLength(1);
    const consumed = out.repairCalls[0]!.consumes["dashboard"] as { status: string; code: string; reason: string; text: string };
    expect(consumed).toMatchObject({ status: "error", code: "step_failed", text: badLabel() });
    expect(consumed.reason).toMatch(/^render_contract_violation: block 1 \(kpi_card\): field `label` must be string$/);
    expect(consumed.reason).not.toContain("model-secret-77");
    expect(out.result).toMatchObject({ kind: "answer", envelope: { verified: true } });
    expect(JSON.stringify(out.result)).toContain("definition");
    expect(out.lines.find((line) => line.site === "step_render_check")).toMatchObject({ component: "generate_dashboard", step: "compose_layout", field: "label", value: "object{text}", block_keys: "type,value,label" });
    expect(JSON.stringify(logged)).not.toContain("model-secret-77");
  });
  it("a repair that still violates ends in a render-contract refusal from the post-run check", async () => {
    const out = await run(badLabel(), badLabel());
    expect(out.error).toBeUndefined();
    expect(out.repairCalls).toHaveLength(1);
    expect(out.result).toMatchObject({ kind: "refusal" });
    expect((out.result as { reason: string }).reason).toMatch(/^The result did not match the render contract: .*field `label` must be string/);
    expect(out.lines.filter((line) => line.site === "step_render_check")).toHaveLength(1);
    expect(out.lines.filter((line) => line.site === "normalize_refused").length).toBeGreaterThan(0);
  });
  it("skips the repair step when the terminal output conforms", async () => {
    const out = await run(good(), good());
    expect(out.error).toBeUndefined();
    expect(out.repairCalls).toHaveLength(0);
    expect(out.result).toMatchObject({ kind: "answer" });
    expect(out.lines).toEqual([]);
  });
  it("coerces object rows and canonical chart_type casing first, so they do not trigger the repair", async () => {
    const out = await run(envelope([chart({ chart_type: "BAR", rows: PLAN_ROWS }), definition()]), good());
    expect(out.repairCalls).toHaveLength(0);
    expect(out.result).toMatchObject({ kind: "answer" });
  });
  it("a chart_type synonym is not guessed: it triggers the repair step", async () => {
    const out = await run(envelope([chart({ chart_type: "column" }), definition()]), good());
    expect(out.repairCalls).toHaveLength(1);
    expect((out.repairCalls[0]!.consumes["dashboard"] as { reason: string }).reason).toMatch(/field `chart_type`/);
    expect(out.result).toMatchObject({ kind: "answer" });
  });
  it("runs the repair step for unparseable terminal text", async () => {
    const out = await run("Here is your dashboard, enjoy", good());
    expect(out.repairCalls).toHaveLength(1);
    expect((out.repairCalls[0]!.consumes["dashboard"] as { reason: string }).reason).toMatch(/^terminal_unparseable: /);
    expect(out.result).toMatchObject({ kind: "answer" });
  });
  it("a component without a repair step still refuses after the run, with no step-level check", async () => {
    const out = await run(badLabel(), good(), false);
    expect(out.error).toBeUndefined();
    expect(out.repairCalls).toHaveLength(0);
    expect(out.result).toMatchObject({ kind: "refusal" });
    expect(out.lines.some((line) => line.site === "step_render_check")).toBe(false);
    expect(out.lines.some((line) => line.site === "normalize_refused")).toBe(true);
  });
});
