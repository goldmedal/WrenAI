import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { describeComponentPlan } from "../harness/components/display.js";
import {
  COMPONENT_FAILURE_CODES, ComponentExecutionError, ComponentRunner, componentFailureCodeOf, componentFailureMessage, redactForLog,
  type ExecutionPlan, type RunnerHost, type StepRun,
} from "../harness/components/runner.js";
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
const MONTH_SQL = "SELECT month, customers FROM monthly_customers";
const PLAN_ROWS = [{ plan: "free", customers: 3 }, { plan: "pro", customers: 5 }];
const MONTH_ROWS = [{ month: "2025-01-01 00:00:00", customers: 4 }, { month: "2025-02-01 00:00:00", customers: 6 }];
const RESULTS: Record<string, { columns: string[]; rows: Record<string, unknown>[]; tables: string[] }> = {
  [PLAN_SQL]: { columns: ["plan", "customers"], rows: PLAN_ROWS, tables: ["customers"] },
  [MONTH_SQL]: { columns: ["month", "customers"], rows: MONTH_ROWS, tables: ["monthly_customers"] },
};

/** The generate_dashboard shape: a strong planning step, then a cheap layout step that calls `answer` once per panel. */
function plan(project: string): ExecutionPlan {
  const declaration = { verb: "answer", type: "analytical", realization_kind: "skill", required_capabilities: ["sql_execution:read_only"],
    context_binding: { project }, guardrails: [{ name: "read_only_execution", locked: true }], effect: { render_blocks: [] } };
  return { identity: "synthetic-dashboard", entries: ["generate_dashboard"], systemPrompt: "Profile instructions", components: {
    generate_dashboard: { id: "generate_dashboard", declaration: { ...declaration, required_capabilities: ["component_invocation", "render_contract"],
      effect: { render_blocks: [
        { type: "kpi_card", fields: { label: "string", value: "number|string", unit: "string?", delta: "number?" } },
        { type: "table", fields: { columns: "string[]", rows: "row[]" } },
        { type: "chart", fields: { chart_type: "bar|line|pie|area|scatter", x: "string", series: "string[]", rows: "row[]" } },
        { type: "definition", fields: { sql: "string", source_tables: "string[]", filters: "string[]?" } },
      ] } },
      steps: [
        { name: "plan_dashboard", tier: "strong", prompt: "Plan panels", consumes: [], produces: "dashboard_plan", tools: [], calls: [] },
        { name: "compose_layout", tier: "cheap", prompt: "Compose", consumes: ["dashboard_plan"], produces: "dashboard", tools: [], calls: [{ alias: "answer", component: "answer" }] },
      ] },
    answer: { id: "answer", declaration,
      steps: [{ name: "query", tier: "cheap", prompt: "Read data", consumes: [], produces: "data", tools: [{ name: "query", source: "native" }], calls: [] }] },
  } };
}

const chart = (sql: string, overrides: Record<string, unknown> = {}) => {
  const result = RESULTS[sql]!;
  return { type: "chart", chart_type: "bar", x: result.columns[0], series: [result.columns[1]], rows: result.rows.map((row) => result.columns.map((c) => row[c])), ...overrides };
};
const definition = (sql: string) => ({ type: "definition", sql, source_tables: RESULTS[sql]!.tables, filters: [] });
const goodBlocks = () => [chart(PLAN_SQL), definition(PLAN_SQL), chart(MONTH_SQL, { chart_type: "line" }), definition(MONTH_SQL)];
const asEnvelope = (blocks: unknown[]) => JSON.stringify({ blocks, summary: "Customers by plan and month." });

let project: string;
let logged: string[];
beforeEach(async () => {
  vi.resetAllMocks();
  project = await mkdtemp(path.join(os.tmpdir(), "genbi-dashboard-failure-"));
  logged = [];
  vi.spyOn(console, "error").mockImplementation((line: unknown) => { logged.push(String(line)); });
});
afterEach(async () => { vi.restoreAllMocks(); await rm(project, { recursive: true, force: true }); });

/** Drives generate_dashboard end to end with a scripted model: the layout step asks `answer` for both panels, then ends with `composeText`. */
async function runDashboard(composeText: string, options: { readonly rows?: Record<string, Record<string, unknown>[]> } = {}) {
  vi.mocked(openWrenComponentAccess).mockResolvedValue({
    query: async (input: { sql: string }) => {
      const known = RESULTS[input.sql]!;
      return { columns: known.columns, rows: options.rows?.[input.sql] ?? known.rows, definition: { sql: input.sql, source_tables: known.tables, filters: [] } };
    },
    inspect: async () => ({}), close: async () => {},
  });
  vi.mocked(runAiComponentStep).mockImplementation(async (step: StepRun) => {
    if (step.tools.answer) {
      for (const sql of [PLAN_SQL, MONTH_SQL]) await step.tools.answer({ request: `panel for ${sql}`, input: { sql } });
      return { value: composeText };
    }
    if (step.tools.query) {
      const sql = String((step.input as { sql?: string }).sql ?? PLAN_SQL);
      await step.tools.query({ sql });
      return { value: "done" };
    }
    return { value: "plan: counts by plan, customers by month" };
  });
  const events: { kind: string; message?: string }[] = [];
  const outcome = await runInProcessDefault({ bundle: describeComponentPlan(plan(project), "synthetic"), userProject: project, question: "build dashboard for them",
    agentId: "generate_dashboard", authChoice: { mode: "api-key", adapter: "openai" }, profileSource: project,
    tierBinding: { strong: { adapter: "mock", config: {} }, cheap: { adapter: "mock", config: {} } },
    ...(process.env.WARBLE_TEST_CLI ? { warbleBin: process.env.WARBLE_TEST_CLI } : {}), onEvent: (event) => events.push(event as { kind: string }),
  }).then((result) => ({ result, error: undefined as unknown }), (error: unknown) => ({ result: undefined, error }));
  return { ...outcome, events, failureLines: logged.filter((line) => line.startsWith("[component-failure]")).map((line) => JSON.parse(line.slice("[component-failure] ".length)) as Record<string, string | number>) };
}

describe("generate_dashboard failure points (scripted model, no live calls)", () => {
  it("baseline: a well-formed layout assembles", async () => {
    const run = await runDashboard(asEnvelope(goodBlocks()));
    expect(run.error).toBeUndefined();
    expect(run.result).toMatchObject({ kind: "answer", envelope: { verified: true } });
    expect(run.failureLines).toEqual([]);
  });
  it("fenced JSON assembles", async () => {
    const run = await runDashboard("```json\n" + asEnvelope(goodBlocks()) + "\n```");
    expect(run.error).toBeUndefined();
    expect(run.result).toMatchObject({ kind: "answer" });
  });
  it("a chart with no title assembles (title is not part of the contract)", async () => {
    const run = await runDashboard(asEnvelope([chart(PLAN_SQL, { title: undefined }), definition(PLAN_SQL)]));
    expect(run.error).toBeUndefined();
  });
  it("a timestamp column copied verbatim assembles", async () => {
    const run = await runDashboard(asEnvelope(goodBlocks()));
    expect(run.result).toMatchObject({ kind: "answer" });
    expect(JSON.stringify(run.result)).toContain("2025-01-01 00:00:00");
  });

  const failing: readonly [string, string, string, RegExp][] = [
    ["plain text instead of JSON", "Here is the dashboard: two charts, customers by plan and by month.", "invalid_result", /non-JSON/],
    ["JSON wrapped in prose (not fenced)", `Here is your dashboard:\n${asEnvelope(goodBlocks())}\nLet me know!`, "invalid_result", /non-JSON/],
    ["chart rows as objects instead of positional rows", asEnvelope([chart(PLAN_SQL, { rows: PLAN_ROWS }), definition(PLAN_SQL)]), "invalid_result", /render contract/],
    ["chart without its x field", asEnvelope([chart(PLAN_SQL, { x: undefined }), definition(PLAN_SQL)]), "invalid_result", /render contract/],
    ["chart_type outside the contract", asEnvelope([chart(PLAN_SQL, { chart_type: "donut" }), definition(PLAN_SQL)]), "invalid_result", /render contract/],
    ["a block type outside the contract", asEnvelope([{ type: "heading", text: "Overview" }]), "invalid_result", /render contract/],
    ["numbers as strings are fine for a cell but a string series is not", asEnvelope([chart(PLAN_SQL, { series: "customers" }), definition(PLAN_SQL)]), "invalid_result", /render contract/],
  ];
  it.each(failing)("%s ends in an error result with all sub-steps done", async (_name, text, code, detail) => {
    const run = await runDashboard(text);
    expect(run.error).toBeInstanceOf(ComponentExecutionError);
    expect((run.error as ComponentExecutionError).code).toBe(code);
    const finished = run.events.filter((event) => event.kind === "step.finish").map((event) => (event as { status?: string }).status);
    expect(finished.length).toBeGreaterThanOrEqual(4);
    expect(finished.every((status) => status === "ok")).toBe(true);
    expect(run.failureLines).toHaveLength(1);
    expect(run.failureLines[0]).toMatchObject({ site: "normalize", code, component: "generate_dashboard", step: "compose_layout", depth: 0 });
    expect(run.failureLines[0]!.detail).toMatch(detail);
  });

  const refusing: readonly [string, string][] = [
    ["chart fields not in the query columns", asEnvelope([chart(PLAN_SQL, { x: "tier" }), definition(PLAN_SQL)])],
    ["a timestamp the model rewrote", asEnvelope([chart(MONTH_SQL, { rows: [["2025-01", 4], ["2025-02", 6]] }), definition(MONTH_SQL)])],
    ["a definition citing SQL that never ran", asEnvelope([chart(PLAN_SQL), { type: "definition", sql: "SELECT 1", source_tables: ["customers"], filters: [] }])],
  ];
  it.each(refusing)("%s is a refusal, not an error", async (_name, text) => {
    const run = await runDashboard(text);
    expect(run.error).toBeUndefined();
    expect(run.result).toMatchObject({ kind: "refusal" });
    expect(run.failureLines).toEqual([]);
  });

  it("a query result over the byte cap fails the tool call with invalid_result and says so in the log", async () => {
    const huge = Array.from({ length: 6000 }, (_, i) => ({ plan: `plan-${i}-${"x".repeat(200)}`, customers: i }));
    const run = await runDashboard(asEnvelope(goodBlocks()), { rows: { [PLAN_SQL]: huge } });
    expect((run.error as ComponentExecutionError).code).toBe("invalid_result");
    expect(run.failureLines.at(-1)).toMatchObject({ code: "invalid_result" });
    expect(run.failureLines.at(-1)!.detail).toMatch(/byte cap/);
  });
});

describe("failure visibility", () => {
  it("carries every failure code to the thrown error with a generic message that names the code", () => {
    for (const code of COMPONENT_FAILURE_CODES) {
      const error = new ComponentExecutionError(code);
      expect(error.code).toBe(code);
      expect(error.message).toBe(componentFailureMessage(code));
      expect(error.message).toContain(`(${code})`);
      expect(componentFailureCodeOf(error.message)).toBe(code);
      expect(error.message).not.toMatch(/stack|at .*\.ts|\//);
    }
    expect(componentFailureCodeOf("Something else (invalid_result).")).toBeUndefined();
    expect(componentFailureCodeOf("The model service failed.")).toBeUndefined();
  });

  it("redacts secrets and truncates log detail", () => {
    const line = redactForLog(`failed with api_key=sk-abcdef123456 and Authorization: Bearer abc.def.ghi\nnext ${"y".repeat(500)}`);
    expect(line).not.toMatch(/sk-abcdef|abc\.def\.ghi|\n/);
    expect(line.length).toBeLessThanOrEqual(310);
  });

  const hostFor = (overrides: Partial<RunnerHost> = {}): RunnerHost => ({
    prepare: async () => ({ tools: [], isCurrent: () => true, close: async () => {}, normalize: async () => ({ status: "ok", output: { kind: "value", value: 1 } }) }),
    runStep: async () => ({ value: "x" }),
    ...overrides,
  });
  const single = (): ExecutionPlan => ({ identity: "t", entries: ["root"], components: { root: { id: "root", declaration: { effect: { render_blocks: [] } },
    steps: [{ name: "only", tier: "cheap", prompt: "p", consumes: [], produces: "out", tools: [], calls: [] }] } } });

  it("logs a thrown step exception with component, step, class and message, and returns only the generic result", async () => {
    const host = hostFor({ runStep: async () => { throw new TypeError("boom with token=abc123 inside"); } });
    const result = await new ComponentRunner(single(), host).run("root", { request: "go" });
    expect(result).toMatchObject({ status: "error", code: "callee_failed", message: "Component execution did not complete." });
    const line = JSON.parse(logged.find((entry) => entry.startsWith("[component-failure]"))!.slice("[component-failure] ".length));
    expect(line).toMatchObject({ site: "run", code: "callee_failed", component: "root", step: "only", error: "TypeError" });
    expect(line.detail).toContain("boom");
    expect(line.detail).not.toContain("abc123");
  });
  it("logs the reason of a host-authored failure", async () => {
    const host = hostFor({ runStep: async () => ({ value: "x".repeat(1_100_000) }) });
    const result = await new ComponentRunner(single(), host).run("root", { request: "go" });
    expect(result).toMatchObject({ status: "error", code: "invalid_result" });
    const line = JSON.parse(logged.find((entry) => entry.startsWith("[component-failure]"))!.slice("[component-failure] ".length));
    expect(line).toMatchObject({ code: "invalid_result", component: "root", step: "only" });
    expect(line.detail).toMatch(/byte cap/);
  });
});
