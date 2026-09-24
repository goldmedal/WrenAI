import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { normalizeComponentResult, type RenderBlock } from "@warble/claude-agent-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "../harness/events/types.js";
import { runAiComponentStep } from "../harness/components/ai-step.js";
import { buildCapabilityCard } from "../harness/components/capability-card.js";
import { describeComponentPlan } from "../harness/components/display.js";
import type { StepRun } from "../harness/components/runner.js";
import { COMPONENT_LIMITS } from "../harness/components/runner.js";
import { GovernedWrenError, openWrenComponentAccess } from "../harness/components/wren-access.js";
import { ZoneGateError } from "../harness/components/zone-gate.js";
import { parseDisclosurePolicy, type AdapterSpec } from "../harness/providers/index.js";
import { runInProcessDefault } from "../harness/route/in-process.js";
import { loadReportPlan, REPORT_PROFILE } from "./report-fixtures.js";

/**
 * M1, offline: the annual-revenue report end to end on the committed
 * `genbi-report` profile (the released Hub's `plan_report` + `answer_batch`)
 * with fake models on both zones. One batched `ask` call, one child run that
 * answers every slot, egress verification per slot, host materialisation,
 * narration over the verified values, host synthesis with provenance, and
 * the render contract validated. No network, no credentials, no GPU.
 */

const CATALOG = { catalog_version: 1, project: { name: "v5_jaffle", data_source: "duckdb" },
  models: [
    { name: "orders", description: "One row per order.", primary_key: ["id"], columns: [{ name: "id", type: "INTEGER" }, { name: "customer_id", type: "INTEGER" }, { name: "order_date", type: "DATE" }, { name: "amount", type: "DOUBLE", description: "USD" }] },
    { name: "customers", description: "One row per customer.", primary_key: ["id"], columns: [{ name: "id", type: "INTEGER" }, { name: "name", type: "VARCHAR" }] },
  ], relationships: [{ name: "orders_customer", models: ["orders", "customers"], join_type: "MANY_TO_ONE", condition: "orders.customer_id = customers.id" }],
  cubes: [{ name: "order_metrics", base_object: "orders", measures: [{ name: "total_revenue", type: "sum" }, { name: "order_count", type: "count" }], dimensions: [{ name: "customer_id", type: "INTEGER" }],
    time_dimensions: [{ name: "order_date", type: "DATE", granularities: ["month", "quarter", "year"], date_range: ["2025-01-01", "2025-12-31"] }] }], views: [] };

const FY = "WHERE order_date BETWEEN DATE '2025-01-01' AND DATE '2025-12-31'";
const SQL = {
  total_revenue: `SELECT SUM(amount) AS total_revenue FROM orders ${FY}`,
  order_count: `SELECT COUNT(*) AS order_count FROM orders ${FY}`,
  avg_order_value: `SELECT AVG(amount) AS avg_order_value FROM orders ${FY}`,
  revenue_by_quarter: `SELECT quarter, SUM(amount) AS revenue FROM orders ${FY} GROUP BY quarter ORDER BY quarter`,
  revenue_by_month: `SELECT month, SUM(amount) AS revenue FROM orders ${FY} GROUP BY month ORDER BY month`,
  top_customers: `SELECT c.name AS customer, SUM(o.amount) AS revenue FROM orders o JOIN customers c ON o.customer_id = c.id ${FY} GROUP BY c.name ORDER BY revenue DESC LIMIT 5`,
  growth_story: `SELECT quarter, SUM(amount) AS revenue, SUM(amount) / SUM(SUM(amount)) OVER () AS share_of_year FROM orders ${FY} GROUP BY quarter ORDER BY quarter`,
  largest_orders: `SELECT id AS order_id, amount FROM orders ${FY} ORDER BY amount DESC LIMIT 5`,
} as const;
const QUARTERS = [["2025-Q1", 290000], ["2025-Q2", 310500], ["2025-Q3", 322000], ["2025-Q4", 362000]] as const;
const TABLES: Record<string, { columns: string[]; rows: Record<string, unknown>[] }> = {
  [SQL.total_revenue]: { columns: ["total_revenue"], rows: [{ total_revenue: 1284500 }] },
  [SQL.order_count]: { columns: ["order_count"], rows: [{ order_count: 9931 }] },
  [SQL.avg_order_value]: { columns: ["avg_order_value"], rows: [{ avg_order_value: 129.34 }] },
  [SQL.revenue_by_quarter]: { columns: ["quarter", "revenue"], rows: QUARTERS.map(([quarter, revenue]) => ({ quarter, revenue })) },
  [SQL.revenue_by_month]: { columns: ["month", "revenue"], rows: Array.from({ length: 12 }, (_, i) => ({ month: `2025-${String(i + 1).padStart(2, "0")}`, revenue: 100000 + i * 1000 })) },
  [SQL.top_customers]: { columns: ["customer", "revenue"], rows: [["Northwind Traders", 96200], ["Blue Yonder Airlines", 88750], ["Contoso Ltd", 81400], ["Fabrikam Inc", 74900], ["Tailspin Toys", 69300]].map(([customer, revenue]) => ({ customer, revenue })) },
  [SQL.growth_story]: { columns: ["quarter", "revenue", "share_of_year"], rows: QUARTERS.map(([quarter, revenue]) => ({ quarter, revenue, share_of_year: Math.round((revenue / 1284500) * 10000) / 10000 })) },
  // The query returns more rows than the slot's max_rows (5): the egress step refuses this slot on `row_limit`.
  [SQL.largest_orders]: { columns: ["order_id", "amount"], rows: Array.from({ length: 8 }, (_, i) => ({ order_id: 10400 + i, amount: 18400 - i * 300 })) },
};
// A first-shot SQL that queries a cube as a table: the governed transport rejects it as model_not_found.
const CUBE_AS_TABLE = "SELECT avg_order_value FROM order_metrics";
const PREAMBLE = { period: "fiscal year 2025 (2025-01-01 to 2025-12-31)", currency: "USD", filters: ["completed orders only"] };
const SLOTS = [
  { slot_id: "total_revenue", block_type: "kpi_card", expected_shape: "scalar", question: "What was total revenue for the period?", unit: "USD" },
  { slot_id: "order_count", block_type: "kpi_card", expected_shape: "scalar", question: "How many orders were placed in the period?" },
  { slot_id: "avg_order_value", block_type: "kpi_card", expected_shape: "scalar", question: "What was the average order value in the period?", unit: "USD" },
  { slot_id: "revenue_by_quarter", block_type: "chart", expected_shape: "series", question: "What was revenue in each quarter of the period, in quarter order?", unit: "USD", max_rows: 4 },
  { slot_id: "revenue_by_month", block_type: "chart", expected_shape: "series", question: "What was revenue in each month of the period, in month order?", unit: "USD", max_rows: 12 },
  { slot_id: "top_customers", block_type: "table", expected_shape: "table", question: "Which five customers had the highest revenue in the period, and how much did each bring in?", unit: "USD", max_rows: 5 },
  { slot_id: "growth_story", block_type: "narrative", expected_shape: "narrative", question: "How did revenue move across the quarters of the period, and which quarter contributed most?" },
  { slot_id: "largest_orders", block_type: "table", expected_shape: "table", question: "What were the five largest individual orders in the period?", unit: "USD", max_rows: 5 },
  { slot_id: "refund_rate", block_type: "kpi_card", expected_shape: "scalar", question: "What share of completed orders in the period was later refunded?", unit: "%" },
] as const;
const LAYOUT = {
  title: "Fiscal 2025 annual revenue report", preamble: PREAMBLE, slots: SLOTS,
  blocks: [
    { type: "kpi_card", label: "Total revenue", slot_id: "total_revenue" },
    { type: "kpi_card", label: "Orders", slot_id: "order_count" },
    // A planner that copies a number into a placeholder anyway: the host strips it, the value below never appears.
    { type: "kpi_card", label: "Average order value", slot_id: "avg_order_value", value: 999 },
    { type: "chart", title: "Revenue by quarter", chart_type: "line", slot_id: "revenue_by_quarter" },
    { type: "chart", title: "Revenue by month", chart_type: "bar", slot_id: "revenue_by_month" },
    { type: "table", title: "Top customers", slot_id: "top_customers" },
    { type: "narrative", title: "How the year went", slot_id: "growth_story" },
    { type: "table", title: "Largest orders", slot_id: "largest_orders" },
    { type: "kpi_card", label: "Refund rate", slot_id: "refund_rate" },
  ],
  summary_brief: "State the year's total, how it built up across the quarters, and who the largest customers were.",
};

vi.mock("../harness/components/ai-step.js", () => ({ runAiComponentStep: vi.fn() }));
vi.mock("../harness/components/egress-judge.js", () => ({ createModelJudge: () => async () => JSON.stringify({ verdict: "pass", reason_category: "aggregate" }) }));
vi.mock("../harness/components/wren-access.js", async (original) => ({ ...await original<typeof import("../harness/components/wren-access.js")>(), openWrenComponentAccess: vi.fn() }));
vi.mock("../harness/tools/index.js", async (original) => ({ ...await original<typeof import("../harness/tools/index.js")>(), resolveWrenBinary: vi.fn() }));
const SNAPSHOT_PATH = path.join(REPORT_PROFILE, "context", "context.json");
vi.mock("../harness/compile/context-loader.js", () => ({ resolveContextLoader: () => ({ bin: "synthetic-context-loader" }),
  generatePreparedContext: vi.fn(async () => { throw new Error("a zone-aware run must generate the catalog too"); }),
  generatePreparedContextAndCatalog: vi.fn(async (_bin: string, _project: string, output: string, catalog: string) => {
    await writeFile(output, await readFile(SNAPSHOT_PATH));
    await writeFile(catalog, JSON.stringify(CATALOG));
  }),
}));

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const priv = (modelId: string): AdapterSpec => ({ adapter: "mock", config: { modelId }, zone: "private" });
const pub = (modelId: string): AdapterSpec => ({ adapter: "mock", config: { modelId }, zone: "public" });
const policy = parseDisclosurePolicy({ max_rows: 50, min_group_size: 1, sensitive_column_patterns: ["email", "phone"] });
const binding = {
  "plan_report/strong": pub("cloud-planner"), "plan_report/cheap": pub("cloud-narrator"),
  "answer_batch/strong": priv("local-super"), "answer_batch/cheap": priv("local-super-cheap"),
  judge: priv("local-judge"), render: priv("local-render"),
};
const roles = { judge: "judge", render: "render" };

interface Captured { readonly step: string; readonly tier: string; readonly modelId: string; readonly brief?: string; readonly prompt: string; readonly request: string; readonly input: unknown; readonly consumes: unknown; readonly output: string }

/** The fake models, one behaviour per step, dispatched on what the host hands the step (tools, consumes). */
function installFakeModels(options: { mutateNarration: boolean; toolErrorSlot?: string }) {
  const calls: Captured[] = [];
  const askRequests: unknown[] = [];
  const askResults: unknown[] = [];
  vi.mocked(runAiComponentStep).mockImplementation(async (run: StepRun, model) => {
    const modelId = (model as { modelId: string }).modelId;
    const record = (step: string, output: string) => { calls.push({ step, tier: run.tier, modelId, ...(run.brief !== undefined ? { brief: run.brief } : {}), prompt: run.prompt, request: run.request, input: run.input, consumes: run.consumes, output }); return { value: output }; };
    if (run.tools["ask"]) {
      const request = { request: "Answer every question in input.questions for the fiscal 2025 annual revenue report under input.preamble; one entry per slot_id.", input: { preamble: PREAMBLE, questions: SLOTS } };
      askRequests.push(request);
      askResults.push(await run.tools["ask"](request));
      return record("plan_layout", JSON.stringify(LAYOUT));
    }
    if (Object.hasOwn(run.consumes, "report_plan")) {
      const view = run.consumes["report_plan"] as { blocks: Record<string, unknown>[]; summary_brief?: string };
      const blocks = view.blocks.map((block) => {
        if (block.status === "unavailable") return { type: "unavailable", label: block.label, block_type: block.type, reason_category: block.reason_category, slot_id: block.slot_id, note: `Not shown (${String(block.reason_category)}).` };
        const copied: Record<string, unknown> = { ...block, note: `Reading of ${String(block.slot_id)}.` };
        if (options.mutateNarration && block.slot_id === "total_revenue") copied.value = 999;
        if (options.mutateNarration && block.slot_id === "top_customers") copied.rows = [["Invented Corp", 1]];
        if (block.slot_id === "top_customers") copied.title = "Top five customers";
        return copied;
      });
      if (options.mutateNarration) blocks.push({ type: "kpi_card", label: "Invented", value: 42, slot_id: "invented" });
      return record("narrate", JSON.stringify({ blocks, summary: "Fiscal 2025 revenue from completed orders totalled 1,284,500 USD across 9,931 orders, building every quarter. Refund rate and order-level detail are unavailable.", verified: true }));
    }
    if (Object.hasOwn(run.consumes, "batch_intent")) {
      const entries: unknown[] = [];
      for (const slot of SLOTS) {
        const sql = (SQL as Record<string, string>)[slot.slot_id];
        if (sql === undefined) { entries.push({ slot_id: slot.slot_id, status: "unanswerable", reason: "the semantic context defines no refund measure" }); continue; }
        if (slot.slot_id === options.toolErrorSlot) {
          // The model sees the tool error, gives up on this one slot and keeps answering the rest.
          const error = await run.tools["query"]!({ sql: CUBE_AS_TABLE }).then(() => undefined, (rejection: unknown) => rejection);
          if (!(error instanceof GovernedWrenError)) throw new Error("expected the governed transport to reject the cube-as-table query");
          entries.push({ slot_id: slot.slot_id, status: "unanswerable", reason: `${error.errorClass}: order_metrics is a cube, not a model` });
          continue;
        }
        const observed = await run.tools["query"]!({ sql }) as { columns: string[]; rows: unknown[] };
        // The model's own copy of the rows is deliberately wrong for one slot: the observed rows must win.
        const rows = slot.slot_id === "total_revenue" ? [[999]] : observed.rows;
        entries.push({ slot_id: slot.slot_id, columns: observed.columns, rows, summary: `Answer for ${slot.slot_id}: ${slot.slot_id === "growth_story" ? "revenue rose every quarter of fiscal 2025, from 290,000 USD in Q1 to 362,000 USD in Q4; Q4 contributed the most at 28% of the year." : "see rows"}`,
          verified: true, definition: { sql, source_tables: sql.includes("customers") ? ["orders", "customers"] : ["orders"], filters: ["fiscal year 2025", "completed orders only"] } });
      }
      return record("generate_sql", JSON.stringify(entries));
    }
    if (Object.hasOwn(run.consumes, "batch_result")) return record("repair_sql", "[]");
    return record("resolve_intent", JSON.stringify(SLOTS.map((slot) => ({ slot_id: slot.slot_id, compute: slot.question, expected_shape: slot.expected_shape }))));
  });
  return { calls, askRequests, askResults };
}

async function runReport(project: string, options: { mutateNarration?: boolean; toolErrorSlot?: string; zoneRoles?: Record<string, string>; tierBinding?: Record<string, AdapterSpec> } = {}) {
  const { plan, ir } = await loadReportPlan(project);
  const fakes = installFakeModels({ mutateNarration: options.mutateNarration ?? false, ...(options.toolErrorSlot ? { toolErrorSlot: options.toolErrorSlot } : {}) });
  vi.mocked(openWrenComponentAccess).mockResolvedValue({
    async query(input) { if (input.sql === CUBE_AS_TABLE) throw new GovernedWrenError("model_not_found"); const table = TABLES[input.sql]; if (!table) throw new Error(`unexpected SQL: ${input.sql}`); return structuredClone(table); },
    async inspect() { return {}; }, async close() {},
  });
  const events: AgentEvent[] = [];
  const started = Date.now();
  const result = await runInProcessDefault({ bundle: describeComponentPlan(plan, "genbi-report"), userProject: project, profileSource: project, question: "Build the fiscal 2025 annual revenue report", agentId: "plan_report",
    authChoice: { mode: "api-key", adapter: "openai" }, tierBinding: options.tierBinding ?? binding, disclosurePolicy: policy, zoneRoles: options.zoneRoles ?? roles,
    onEvent: (event) => events.push(event) });
  const elapsedMs = Date.now() - started;
  const contract = (ir.components.find((node) => node.id === "plan_report")!["effect"] as { render_blocks: RenderBlock[] }).render_blocks;
  return { result, events, elapsedMs, contract, ...fakes };
}

beforeEach(() => vi.resetAllMocks());

describe("M1: the annual revenue report end to end, offline", () => {
  it("runs one batched call, verifies every slot, materialises, narrates, synthesises with provenance, and validates the envelope", async () => {
    const project = await mkdtemp(path.join(os.tmpdir(), "genbi-report-e2e-"));
    try {
      const { result, events, elapsedMs, contract, calls, askRequests, askResults } = await runReport(project);
      expect(result.kind).toBe("answer");
      if (result.kind !== "answer") throw new Error("unreachable");
      const envelope = result.envelope as { blocks: Record<string, unknown>[]; summary?: string; verified: boolean };
      // Per-mount binding: the planner and the narrator ran on public models, the callee on private ones.
      expect(calls.map((call) => [call.step, call.modelId])).toEqual([
        ["resolve_intent", "local-super-cheap"], ["generate_sql", "local-super"], ["plan_layout", "cloud-planner"], ["narrate", "cloud-narrator"]]);
      // Exactly one batched alias call carried every slot and the preamble; one child run answered them all.
      expect(askRequests).toHaveLength(1);
      expect(result.trace?.steps.filter((step) => step.tool === "ask")).toHaveLength(1);
      const childSteps = events.filter((event): event is Extract<AgentEvent, { kind: "step.start" }> => event.kind === "step.start" && event.depth === 1);
      expect(childSteps.map((event) => event.name)).toEqual(["resolve_intent", "generate_sql"]);
      expect(new Set(childSteps.map((event) => event.parent)).size).toBe(1);
      // The caller saw disclosed answers only: no definition, no SQL, one entry per slot with a status.
      const disclosed = askResults[0] as { output: { value: { answers: { slot_id: string; status: string; reason_category?: string }[] } } };
      expect(JSON.stringify(disclosed)).not.toMatch(/SELECT|definition|source_tables/);
      expect(disclosed.output.value.answers.map((answer) => [answer.slot_id, answer.status, answer.reason_category])).toEqual([
        ["total_revenue", "ok", undefined], ["order_count", "ok", undefined], ["avg_order_value", "ok", undefined], ["revenue_by_quarter", "ok", undefined],
        ["revenue_by_month", "ok", undefined], ["top_customers", "ok", undefined], ["growth_story", "ok", undefined],
        ["largest_orders", "refused", "row_limit"], ["refund_rate", "refused", "unanswerable"]]);
      // Verification ran on every slot and was traced without payload.
      expect(result.trace?.steps.filter((step) => step.tool === "egress").map((step) => step.detail)).toEqual([
        "ask/total_revenue: ok", "ask/order_count: ok", "ask/avg_order_value: ok", "ask/revenue_by_quarter: ok", "ask/revenue_by_month: ok",
        "ask/top_customers: ok", "ask/growth_story: ok", "ask/largest_orders: refused (row_limit)", "ask/refund_rate: refused (unanswerable)"]);
      expect(JSON.stringify(result.trace)).not.toContain("SELECT");
      // The envelope: values from the slot table, notes from the narrator, unavailable cells with their category, provenance attached by the host.
      const data = envelope.blocks.filter((block) => block.type !== "definition");
      expect(data.map((block) => [block.type, block.slot_id])).toEqual([
        ["kpi_card", "total_revenue"], ["kpi_card", "order_count"], ["kpi_card", "avg_order_value"], ["chart", "revenue_by_quarter"], ["chart", "revenue_by_month"],
        ["table", "top_customers"], ["narrative", "growth_story"], ["unavailable", "largest_orders"], ["unavailable", "refund_rate"]]);
      expect(data[0]).toEqual({ type: "kpi_card", label: "Total revenue", slot_id: "total_revenue", value: 1284500, unit: "USD", note: "Reading of total_revenue." });
      expect(data[2]).toMatchObject({ value: 129.34 });
      expect(data[3]).toMatchObject({ chart_type: "line", x: "quarter", series: ["revenue"], rows: QUARTERS.map((row) => [...row]) });
      expect((data[4] as { rows: unknown[] }).rows).toHaveLength(12);
      expect(data[5]).toMatchObject({ title: "Top five customers", columns: ["customer", "revenue"], rows: [["Northwind Traders", 96200], ["Blue Yonder Airlines", 88750], ["Contoso Ltd", 81400], ["Fabrikam Inc", 74900], ["Tailspin Toys", 69300]] });
      expect(data[6]).toMatchObject({ type: "narrative", text: expect.stringContaining("Q4 contributed the most") });
      expect(data[7]).toEqual({ type: "unavailable", label: "Largest orders", block_type: "table", reason_category: "row_limit", slot_id: "largest_orders", note: "Not shown (row_limit)." });
      expect(data[8]).toMatchObject({ type: "unavailable", block_type: "kpi_card", reason_category: "unanswerable", slot_id: "refund_rate" });
      expect(envelope.summary).toContain("1,284,500 USD");
      expect(envelope.verified).toBe(true);
      // The report never carries the planner's copied number or the callee model's wrong copy of a row.
      expect(JSON.stringify(envelope)).not.toContain("999");
      // The envelope validates against the component's declared render contract.
      const validated = normalizeComponentResult(JSON.stringify(envelope), contract).value;
      expect(validated.status).toBe("ok");
      if (validated.status === "ok" && validated.output.kind === "render") expect(validated.output.blocks).toHaveLength(envelope.blocks.length);
      // AC 4: definition blocks carry SQL and source tables attached by the host from the child run, one per filled slot.
      const definitions = envelope.blocks.filter((block) => block.type === "definition");
      expect(definitions.map((block) => block.slot_id)).toEqual(["total_revenue", "order_count", "avg_order_value", "revenue_by_quarter", "revenue_by_month", "top_customers", "growth_story"]);
      expect(definitions[5]).toEqual({ type: "definition", sql: SQL.top_customers, source_tables: ["orders", "customers"], filters: ["fiscal year 2025", "completed orders only"], slot_id: "top_customers" });
      // ...and neither public-tier step's input or output ever contained them.
      const publicCalls = calls.filter((call) => call.step === "plan_layout" || call.step === "narrate");
      const publicText = publicCalls.map((call) => JSON.stringify(call)).join("\n");
      for (const sql of Object.values(SQL)) expect(publicText).not.toContain(sql);
      expect(publicText).not.toMatch(/SELECT /);
      // The data surfaces (request, consumed artifacts, the step's own output) name no definition at all; the prompt may
      // describe the render contract's `definition` block type, which is a field list, not provenance.
      const publicData = publicCalls.map((call) => JSON.stringify({ request: call.request, input: call.input, consumes: call.consumes, output: call.output })).join("\n");
      expect(publicData).not.toMatch(/source_tables|"definition"|"sql"/);
      // AC 10: the shared admission ledger, measured on this report.
      const rootSteps = events.filter((event) => event.kind === "step.start").length;
      const requestBytes = Buffer.byteLength(JSON.stringify(askRequests[0]));
      const resultBytes = Buffer.byteLength(JSON.stringify(askResults[0]));
      const budget = { step_starts: rootSteps, child_step_starts: childSteps.length, call_attempts: askRequests.length, request_bytes: requestBytes, disclosed_result_bytes: resultBytes, host_wall_clock_ms_fake_models: elapsedMs, limits: COMPONENT_LIMITS };
      console.info(`report budget ${JSON.stringify(budget)}`);
      expect(rootSteps).toBeLessThanOrEqual(COMPONENT_LIMITS.steps);
      expect(childSteps.length).toBeLessThanOrEqual(COMPONENT_LIMITS.childSteps);
      expect(requestBytes).toBeLessThanOrEqual(COMPONENT_LIMITS.requestBytes);
      expect(resultBytes).toBeLessThanOrEqual(COMPONENT_LIMITS.resultBytes);
    } finally { await rm(project, { recursive: true, force: true }); }
  });

  it("mutation: a narrator that retypes a number, rewrites rows or invents a block changes nothing in the final envelope", async () => {
    const project = await mkdtemp(path.join(os.tmpdir(), "genbi-report-mutation-"));
    try {
      const { result, calls } = await runReport(project, { mutateNarration: true });
      if (result.kind !== "answer") throw new Error("expected an answer");
      const narration = JSON.parse(calls.find((call) => call.step === "narrate")!.output) as { blocks: Record<string, unknown>[] };
      expect(narration.blocks.find((block) => block.slot_id === "total_revenue")).toMatchObject({ value: 999 });
      const blocks = (result.envelope as { blocks: Record<string, unknown>[] }).blocks;
      expect(blocks.find((block) => block.slot_id === "total_revenue")).toMatchObject({ value: 1284500, note: "Reading of total_revenue." });
      expect(blocks.find((block) => block.slot_id === "top_customers")).toMatchObject({ rows: [["Northwind Traders", 96200], ["Blue Yonder Airlines", 88750], ["Contoso Ltd", 81400], ["Fabrikam Inc", 74900], ["Tailspin Toys", 69300]] });
      expect(blocks.find((block) => block.slot_id === "invented")).toBeUndefined();
      expect(JSON.stringify(result.envelope)).not.toMatch(/999|Invented/);
      expect((result.envelope as { verified: boolean }).verified).toBe(true);
    } finally { await rm(project, { recursive: true, force: true }); }
  });

  it("a tool error on one slot of the batch child fails that slot only: it crosses as refused, renders unavailable with its category, and the rest of the report is filled", async () => {
    const project = await mkdtemp(path.join(os.tmpdir(), "genbi-report-tool-error-"));
    try {
      const { result, events, contract, askResults } = await runReport(project, { toolErrorSlot: "avg_order_value" });
      // The child is not callee_failed and the run succeeds.
      expect(result.kind).toBe("answer");
      if (result.kind !== "answer") throw new Error("unreachable");
      const envelope = result.envelope as { blocks: Record<string, unknown>[]; verified: boolean };
      // The tool error happened inside the child, and no repair step ran for it.
      const childTools = events.filter((event): event is Extract<AgentEvent, { kind: "tool.result" }> => event.kind === "tool.result" && event.tool === "query");
      expect(childTools.filter((event) => event.status === "error")).toHaveLength(1);
      expect(childTools.filter((event) => event.status === "success")).toHaveLength(7);
      const childSteps = events.filter((event): event is Extract<AgentEvent, { kind: "step.start" }> => event.kind === "step.start" && event.depth === 1);
      expect(childSteps.map((event) => event.name)).toEqual(["resolve_intent", "generate_sql"]);
      // The failed slot crosses the egress step as refused with a reason category; its reason text and SQL stay host-side.
      const disclosed = askResults[0] as { status: string; output: { value: { answers: { slot_id: string; status: string; reason_category?: string }[] } } };
      expect(disclosed.status).toBe("ok");
      expect(disclosed.output.value.answers.map((answer) => [answer.slot_id, answer.status, answer.reason_category])).toEqual([
        ["total_revenue", "ok", undefined], ["order_count", "ok", undefined], ["avg_order_value", "refused", "unanswerable"], ["revenue_by_quarter", "ok", undefined],
        ["revenue_by_month", "ok", undefined], ["top_customers", "ok", undefined], ["growth_story", "ok", undefined],
        ["largest_orders", "refused", "row_limit"], ["refund_rate", "refused", "unanswerable"]]);
      expect(JSON.stringify(disclosed)).not.toMatch(/order_metrics|model_not_found|SELECT/);
      expect(result.trace?.steps.filter((step) => step.tool === "egress").map((step) => step.detail)).toContain("ask/avg_order_value: refused (unanswerable)");
      // The envelope: that cell is unavailable with its category, every other answerable cell is filled.
      const data = envelope.blocks.filter((block) => block.type !== "definition");
      expect(data.map((block) => [block.type, block.slot_id])).toEqual([
        ["kpi_card", "total_revenue"], ["kpi_card", "order_count"], ["unavailable", "avg_order_value"], ["chart", "revenue_by_quarter"], ["chart", "revenue_by_month"],
        ["table", "top_customers"], ["narrative", "growth_story"], ["unavailable", "largest_orders"], ["unavailable", "refund_rate"]]);
      expect(data[2]).toMatchObject({ type: "unavailable", label: "Average order value", block_type: "kpi_card", reason_category: "unanswerable", slot_id: "avg_order_value" });
      expect(data[0]).toMatchObject({ value: 1284500 });
      expect(data[5]).toMatchObject({ rows: [["Northwind Traders", 96200], ["Blue Yonder Airlines", 88750], ["Contoso Ltd", 81400], ["Fabrikam Inc", 74900], ["Tailspin Toys", 69300]] });
      // Provenance is attached to the filled cells only.
      expect(envelope.blocks.filter((block) => block.type === "definition").map((block) => block.slot_id)).toEqual([
        "total_revenue", "order_count", "revenue_by_quarter", "revenue_by_month", "top_customers", "growth_story"]);
      expect(JSON.stringify(envelope)).not.toMatch(/order_metrics|model_not_found|129\.34/);
      expect(envelope.verified).toBe(true);
      expect(normalizeComponentResult(JSON.stringify(envelope), contract).value.status).toBe("ok");
    } finally { await rm(project, { recursive: true, force: true }); }
  });

  it("AC 3: every public-tier prompt is fingerprinted per surface, and those surfaces carry no SQL, no definition, no oversize row set and no wren brief, but do carry the capability card", async () => {
    const project = await mkdtemp(path.join(os.tmpdir(), "genbi-report-audit-"));
    try {
      const { result, calls } = await runReport(project);
      if (result.kind !== "answer") throw new Error("expected an answer");
      const card = buildCapabilityCard(CATALOG);
      // The host re-serialises the parsed snapshot, so the digest is over the compact form, not the pretty-printed file.
      const snapshotDigest = sha(`Host semantic context:\n${JSON.stringify(JSON.parse(await readFile(SNAPSHOT_PATH, "utf8")))}`);
      const surfaces = result.trace?.surfaces ?? [];
      // Recorded when each step starts: the planner first, then the child it called, then the narrator.
      expect(surfaces.map((record) => [record.component, record.step, record.zone, record.context])).toEqual([
        ["plan_report", "plan_layout", "public", "card"], ["answer_batch", "resolve_intent", "private", "snapshot"],
        ["answer_batch", "generate_sql", "private", "snapshot"], ["plan_report", "narrate", "public", "card"]]);
      for (const record of surfaces.filter((record) => record.zone === "public")) {
        const call = calls.find((candidate) => candidate.step === record.step)!;
        // The record is an audit of exactly the texts the model received: request/input, consumed artifacts, brief and context.
        expect(record.algorithm).toBe("sha256");
        expect(Object.keys(record.surfaces).sort()).toEqual(["brief", "consumes", "context", "input", "prompt", ...(record.step === "narrate" ? ["render"] : [])]);
        expect(record.surfaces["input"]).toBe(sha(JSON.stringify({ request: call.request, input: call.input })));
        expect(record.surfaces["consumes"]).toBe(sha(JSON.stringify(call.consumes)));
        expect(record.surfaces["brief"]).toBe(sha(call.brief!));
        expect(record.surfaces["context"]).toBe(card.digest);
        expect(Object.values(record.surfaces)).not.toContain(snapshotDigest);
        // What those texts contain: no SQL anywhere; no definition, source tables or sql on the data surfaces
        // (the prompt names the render contract's `definition` block type, a field list, not provenance); no wren brief.
        const text = JSON.stringify({ brief: call.brief, prompt: call.prompt, request: call.request, input: call.input, consumes: call.consumes });
        expect(text).not.toMatch(/SELECT /);
        for (const sql of Object.values(SQL)) expect(text).not.toContain(sql);
        expect(JSON.stringify({ brief: call.brief, request: call.request, input: call.input, consumes: call.consumes })).not.toMatch(/"definition"|source_tables|\bsql\b/i);
        expect(text).not.toMatch(/wren/i);
        expect(call.prompt).toContain("# Capability card");
        expect(call.prompt).not.toContain("Host semantic context");
      }
      // The narrator's consumed layout is the host-materialised view: values present, rows within every bound, no provenance.
      const view = calls.find((call) => call.step === "narrate")!.consumes as { report_plan: { blocks: Record<string, unknown>[] } };
      const rowsOf = (id: string) => (view.report_plan.blocks.find((block) => block.slot_id === id) as { rows: unknown[] }).rows;
      expect(rowsOf("revenue_by_quarter")).toHaveLength(4);
      expect(rowsOf("revenue_by_month")).toHaveLength(12);
      expect(rowsOf("top_customers")).toHaveLength(5);
      for (const block of view.report_plan.blocks) if (Array.isArray(block.rows)) expect(block.rows.length).toBeLessThanOrEqual(policy.max_rows);
      expect(view.report_plan.blocks.find((block) => block.slot_id === "largest_orders")).toMatchObject({ status: "unavailable", reason_category: "row_limit" });
      expect(view.report_plan.blocks.find((block) => block.slot_id === "avg_order_value")).toMatchObject({ value: 129.34 });
      // Private steps: the wren brief and the snapshot are exactly what stays private.
      for (const record of surfaces.filter((record) => record.zone === "private")) {
        const call = calls.find((candidate) => candidate.step === record.step)!;
        expect(record.surfaces["context"]).toBe(snapshotDigest);
        expect(call.brief).toContain("wren -q");
        expect(Object.values(record.surfaces)).not.toContain(card.digest);
      }
    } finally { await rm(project, { recursive: true, force: true }); }
  });

  it("AC 6: the render stage must be bound to a private tier explicitly; leaving it on the narrator's public tier or binding it public is rejected before any model runs", async () => {
    const project = await mkdtemp(path.join(os.tmpdir(), "genbi-report-render-gate-"));
    try {
      await expect(runReport(project, { zoneRoles: { judge: "judge" } })).rejects.toThrow(ZoneGateError);
      await expect(runReport(project, { zoneRoles: { judge: "judge" } })).rejects.toThrow(/roles\.render names no tier.*plan_report\.narrate \(tier cheap, zone public\)/);
      await expect(runReport(project, { tierBinding: { ...binding, render: pub("cloud-render") } })).rejects.toThrow(/render tier "render" is zone: public/);
      expect(vi.mocked(runAiComponentStep)).not.toHaveBeenCalled();
      expect(vi.mocked(openWrenComponentAccess)).not.toHaveBeenCalled();
    } finally { await rm(project, { recursive: true, force: true }); }
  });
});
