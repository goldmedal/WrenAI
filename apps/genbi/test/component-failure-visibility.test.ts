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
  generatePreparedContextAndCatalog: async (_bin: string, _project: string, output: string, catalog: string) => {
    await writeFile(output, JSON.stringify({ context_version: 2, parseable: true }));
    await writeFile(catalog, JSON.stringify({ catalog_version: 1, project: {}, models: [], relationships: [], cubes: [], views: [] }));
  },
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

  it("plain text instead of JSON stays a hard invalid_result error with all sub-steps done", async () => {
    const run = await runDashboard("Here is the dashboard: two charts, customers by plan and by month.");
    expect(run.error).toBeInstanceOf(ComponentExecutionError);
    expect((run.error as ComponentExecutionError).code).toBe("invalid_result");
    const finished = run.events.filter((event) => event.kind === "step.finish").map((event) => (event as { status?: string }).status);
    expect(finished.length).toBeGreaterThanOrEqual(4);
    expect(finished.every((status) => status === "ok")).toBe(true);
    expect(run.failureLines).toHaveLength(1);
    expect(run.failureLines[0]).toMatchObject({ site: "normalize", code: "invalid_result", component: "generate_dashboard", step: "compose_layout", depth: 0 });
    expect(run.failureLines[0]!.detail).toMatch(/non-JSON/);
  });

  it.each([
    ["JSON wrapped in prose", `Here is your dashboard:\n${asEnvelope(goodBlocks())}\nLet me know!`],
    ["JSON after reasoning tags and a fence", `<think>plan the charts</think>\n\`\`\`json\n${asEnvelope(goodBlocks())}\n\`\`\`\nDone.`],
  ])("%s assembles exactly like bare JSON", async (_name, text) => {
    const run = await runDashboard(text);
    expect(run.error).toBeUndefined();
    expect(run.result).toMatchObject({ kind: "answer", envelope: { verified: true } });
    expect(run.failureLines).toEqual([]);
  });

  it("prose-wrapped JSON is still grounded as strictly: an invented value is refused", async () => {
    const forged = chart(PLAN_SQL, { rows: [["free", 999], ["pro", 5]] });
    const run = await runDashboard(`Here you go:\n${asEnvelope([forged, definition(PLAN_SQL)])}`);
    expect(run.error).toBeUndefined();
    expect(run.result).toMatchObject({ kind: "refusal" });
  });

  const table = (sql: string, rows: unknown[]) => ({ type: "table", columns: RESULTS[sql]!.columns, rows });
  it.each([
    ["a chart", () => [chart(PLAN_SQL, { rows: PLAN_ROWS }), definition(PLAN_SQL)], ["free", 3]],
    ["a table", () => [table(MONTH_SQL, MONTH_ROWS), definition(MONTH_SQL)], ["2025-01-01 00:00:00", 4]],
    ["a table in a different key order", () => [table(PLAN_SQL, PLAN_ROWS.map((row) => ({ customers: row.customers, plan: row.plan }))), definition(PLAN_SQL)], ["free", 3]],
  ] as const)("object-shaped rows in %s that match the declared columns assemble as positional rows", async (_name, blocks, first) => {
    const run = await runDashboard(asEnvelope(blocks()));
    expect(run.error).toBeUndefined();
    expect(run.result).toMatchObject({ kind: "answer", envelope: { verified: true } });
    const rows = (run.result as { envelope: { blocks: { rows?: unknown[][] }[] } }).envelope.blocks[0]!.rows!;
    expect(rows[0]).toEqual(first);
    expect(rows.every((row) => Array.isArray(row))).toBe(true);
    expect(run.failureLines).toEqual([]);
  });
  it("object rows with an invented value are coerced, then refused by grounding", async () => {
    const run = await runDashboard(asEnvelope([chart(PLAN_SQL, { rows: [{ plan: "free", customers: 999 }, { plan: "pro", customers: 5 }] }), definition(PLAN_SQL)]));
    expect(run.error).toBeUndefined();
    expect(run.result).toMatchObject({ kind: "refusal" });
  });

  it("a missing chart_type becomes bar and assembles", async () => {
    const run = await runDashboard(asEnvelope([chart(PLAN_SQL, { chart_type: undefined }), definition(PLAN_SQL)]));
    expect(run.error).toBeUndefined();
    expect(run.result).toMatchObject({ kind: "answer", envelope: { verified: true } });
    expect((run.result as { envelope: { blocks: { chart_type?: string }[] } }).envelope.blocks[0]!.chart_type).toBe("bar");
  });
  it.each(["BAR", " Line ", "Pie", "AREA", "scatter"])("canonical chart_type %j is read in its canonical casing", async (written) => {
    const run = await runDashboard(asEnvelope([chart(PLAN_SQL, { chart_type: written }), definition(PLAN_SQL)]));
    expect(run.error).toBeUndefined();
    expect(run.result).toMatchObject({ kind: "answer" });
    expect((run.result as { envelope: { blocks: { chart_type?: string }[] } }).envelope.blocks[0]!.chart_type).toBe(written.trim().toLowerCase());
  });
  it.each(["column", "donut", "histogram", "bubble"])("chart_type %j is not guessed: it is refused and the value is logged", async (written) => {
    const run = await runDashboard(asEnvelope([chart(PLAN_SQL, { chart_type: written }), definition(PLAN_SQL)]));
    expect(run.result).toMatchObject({ kind: "refusal" });
    expect(run.failureLines.find((line) => line["field"] === "chart_type")).toMatchObject({ site: "normalize_refused", value: written });
  });
  it("a normalized chart with an invented value is still refused by grounding", async () => {
    const run = await runDashboard(asEnvelope([chart(PLAN_SQL, { chart_type: "BAR", rows: [["free", 999], ["pro", 5]] }), definition(PLAN_SQL)]));
    expect(run.result).toMatchObject({ kind: "refusal" });
  });
  it("an unrecognised chart_type is refused, and only the log line names the value", async () => {
    const run = await runDashboard(asEnvelope([chart(PLAN_SQL, { chart_type: "  Radar\n chart " }), definition(PLAN_SQL)]));
    expect(run.result).toMatchObject({ kind: "refusal" });
    const shown = (run.result as { reason: string }).reason;
    expect(shown).toContain("field `chart_type` must be bar|line|pie|area|scatter");
    expect(shown).not.toMatch(/radar/i);
    const line = logged.map((entry) => entry.slice("[component-failure] ".length)).filter((entry) => entry.startsWith("{")).map((entry) => JSON.parse(entry) as Record<string, string>).find((entry) => entry["field"]);
    expect(line).toMatchObject({ site: "normalize_refused", field: "chart_type", value: "Radar chart", component: "generate_dashboard", step: "compose_layout" });
    expect(JSON.stringify(logged)).not.toMatch(/free|pro|customers"?:\s*[0-9]/);
  });
  const kpi = (fields: Record<string, unknown>) => ({ type: "kpi_card", value: 5, ...fields });
  const valueLine = async (blocks: unknown[]) => {
    logged.length = 0;
    const run = await runDashboard(asEnvelope(blocks));
    expect(run.result).toMatchObject({ kind: "refusal" });
    return { run, line: run.failureLines.find((line) => line["field"] !== undefined) };
  };
  it("a long structural string is capped in the log", async () => {
    const { line } = await valueLine([chart(PLAN_SQL, { chart_type: "z".repeat(200) }), definition(PLAN_SQL)]);
    expect((line!["value"] as string).length).toBeLessThanOrEqual(67);
  });
  it("a missing label logs (missing)", async () => {
    const { line } = await valueLine([kpi({}), definition(PLAN_SQL)]);
    expect(line).toMatchObject({ site: "normalize_refused", field: "label", value: "(missing)" });
  });
  it("a label given as an object logs its key names only", async () => {
    const { line } = await valueLine([kpi({ label: { text: "Customers", n: 12345 } }), definition(PLAN_SQL)]);
    expect(line).toMatchObject({ field: "label", value: "object{text,n}" });
  });
  it("a kpi_card with title but no label logs label=(missing) and the block's key names", async () => {
    const { line } = await valueLine([kpi({ title: "Customers" }), definition(PLAN_SQL)]);
    expect(line).toMatchObject({ field: "label", value: "(missing)", block_keys: "type,value,title" });
  });
  it("a data field is described by its type only, and no data value reaches any log line", async () => {
    const { run } = await valueLine([chart(PLAN_SQL, { series: "customers-secret-77" }), definition(PLAN_SQL)]);
    const line = run.failureLines.find((entry) => entry["field"] === "series");
    expect(line).toMatchObject({ field: "series", value: "string" });
    const wrongRows = await valueLine([chart(PLAN_SQL, { rows: "free-pro-secret-99" }), definition(PLAN_SQL)]);
    expect(wrongRows.line).toMatchObject({ field: "rows", value: "string" });
    const numericX = await valueLine([chart(PLAN_SQL, { x: 424242 }), definition(PLAN_SQL)]);
    expect(numericX.line).toMatchObject({ field: "x", value: "number" });
    expect(JSON.stringify([run.failureLines, wrongRows.run.failureLines, numericX.run.failureLines])).not.toMatch(/secret|424242|"free"|"pro"/);
  });
  it("an unknown block type logs the type string, capped", async () => {
    const { line } = await valueLine([{ type: "heading", text: "Overview" }]);
    expect(line).toMatchObject({ field: "type", value: "heading" });
  });

  const violations: readonly [string, string, RegExp][] = [
    ["object rows with an extra key", asEnvelope([chart(PLAN_SQL, { rows: PLAN_ROWS.map((row) => ({ ...row, note: "x" })) }), definition(PLAN_SQL)]), /block 1 \(chart\): field `rows` must be row\[\]/],
    ["object rows missing a declared column", asEnvelope([chart(PLAN_SQL, { rows: PLAN_ROWS.map((row) => ({ plan: row.plan })) }), definition(PLAN_SQL)]), /block 1 \(chart\): field `rows` must be row\[\]/],
    ["one object row among positional rows", asEnvelope([chart(PLAN_SQL, { rows: [["free", 3], { plan: "pro", customers: 5 }] }), definition(PLAN_SQL)]), /block 1 \(chart\): field `rows` must be row\[\]/],
    ["chart without its x field", asEnvelope([chart(PLAN_SQL, { x: undefined }), definition(PLAN_SQL)]), /block 1 \(chart\): field `x` must be string/],
    ["chart_type outside the contract", asEnvelope([chart(PLAN_SQL, { chart_type: "radar" }), definition(PLAN_SQL)]), /block 1 \(chart\): field `chart_type`/],
    ["a block type outside the contract", asEnvelope([{ type: "heading", text: "Overview" }]), /block 1 has a type that is not allowed \(allowed: kpi_card, table, chart, definition\)/],
    ["a string series", asEnvelope([chart(PLAN_SQL, { series: "customers" }), definition(PLAN_SQL)]), /block 1 \(chart\): field `series` must be string\[\]/],
    ["a second block violating after a good one", asEnvelope([chart(PLAN_SQL), definition(PLAN_SQL), chart(MONTH_SQL, { rows: MONTH_ROWS.map((row) => ({ ...row, extra: 1 })) })]), /block 3 \(chart\): field `rows`/],
    ["no blocks array", JSON.stringify({ summary: "nothing" }), /no `blocks` array/],
  ];
  it.each(violations)("%s is a refusal that says why, and is logged", async (_name, text, reason) => {
    const run = await runDashboard(text);
    expect(run.error).toBeUndefined();
    expect(run.result).toMatchObject({ kind: "refusal" });
    const shown = (run.result as { reason: string }).reason;
    expect(shown).toMatch(/^The result did not match the render contract: /);
    expect(shown).toMatch(reason);
    expect(shown).not.toMatch(/heading|radar/);
    const reasonLines = run.failureLines.filter((line) => line["field"] === undefined);
    expect(reasonLines).toHaveLength(1);
    expect(reasonLines[0]).toMatchObject({ site: "normalize_refused", code: "callee_refused", component: "generate_dashboard", step: "compose_layout" });
    expect(reasonLines[0]!.detail).toMatch(reason);
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
    expect(run.failureLines.every((line) => line.site === "normalize_refused")).toBe(true);
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
