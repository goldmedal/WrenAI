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
import type { StepRun, StepUsage } from "../harness/components/runner.js";
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
// Each judge call reports its usage the way the real judge does (egress-verification.test.ts covers the real wiring).
// A test may script the judge to redact one column wherever an answer carries it; otherwise it passes everything.
const judgeScript = vi.hoisted(() => ({ redactColumn: undefined as string | undefined }));
vi.mock("../harness/components/egress-judge.js", () => ({ createModelJudge: (_model: unknown, onUsage?: (usage: { inputTokens: number; outputTokens: number }) => void) => async (input: { answer: { columns: readonly string[] } }) => {
  onUsage?.({ inputTokens: 21, outputTokens: 3 });
  if (judgeScript.redactColumn !== undefined && input.answer.columns.includes(judgeScript.redactColumn)) {
    return JSON.stringify({ verdict: "redact", reason_category: "individual_level", redact_columns: [judgeScript.redactColumn] });
  }
  return JSON.stringify({ verdict: "pass", reason_category: "aggregate" });
} }));
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

/** How the batch child fails as a whole: its steps exhaust their loop cap (it fails), or its terminal is backed by no executed query (it is refused). */
type ChildFailure = "loop_cap" | "zero_queries";
/** Child model text no public-tier surface may ever receive. */
const CHILD_MARKER = "CHILD-MODEL-TEXT-7f3a9c";

interface Captured { readonly step: string; readonly tier: string; readonly modelId: string; readonly brief?: string; readonly prompt: string; readonly request: string; readonly input: unknown; readonly consumes: unknown; readonly output: string }

/** The fake models, one behaviour per step, dispatched on what the host hands the step (tools, consumes). */
function installFakeModels(options: { mutateNarration: boolean; toolErrorSlot?: string; namingSummary?: boolean; brokenTerminal?: "repaired" | "still"; childFailure?: ChildFailure; usage?: Readonly<Record<string, StepUsage>> }) {
  const calls: Captured[] = [];
  // The entries generate_sql meant to write, kept so a repair can re-emit them by query id.
  let intended: unknown[] = [];
  const askRequests: unknown[] = [];
  const askResults: unknown[] = [];
  vi.mocked(runAiComponentStep).mockImplementation(async (run: StepRun, model) => {
    const modelId = (model as { modelId: string }).modelId;
    const usage = options.usage?.[modelId];
    const record = (step: string, output: string) => { calls.push({ step, tier: run.tier, modelId, ...(run.brief !== undefined ? { brief: run.brief } : {}), prompt: run.prompt, request: run.request, input: run.input, consumes: run.consumes, output }); return { value: output, ...(usage ? { usage } : {}) }; };
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
      if (options.childFailure === "loop_cap") {
        // The model keeps querying until the step's loop cap stops it: one observed query, then no terminal.
        await run.tools["query"]!({ sql: SQL.total_revenue });
        return { ...record("generate_sql", `Still working on ${CHILD_MARKER}`), failed: true };
      }
      if (options.childFailure === "zero_queries") {
        // A terminal that claims every slot without running a single query.
        return record("generate_sql", JSON.stringify(SLOTS.map((slot) => ({ slot_id: slot.slot_id, columns: ["value"], rows: [[1]], summary: `${CHILD_MARKER} for ${slot.slot_id}`, verified: true }))));
      }
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
        const observed = await run.tools["query"]!({ sql }) as { columns: string[]; rows: unknown[]; query_id: string };
        // The model's own copy of the rows is deliberately wrong for one slot: the observed rows must win.
        const rows = slot.slot_id === "total_revenue" ? [[999]] : observed.rows;
        // The callee's model may also write the customers it saw into its free text, not only into the rows.
        const naming = options.namingSummary && slot.slot_id === "top_customers";
        const summary = naming ? `The top five were ${(observed.rows as { customer: string; revenue: number }[]).map((row) => `${row.customer} (${row.revenue} USD)`).join(", ")}.`
          : `Answer for ${slot.slot_id}: ${slot.slot_id === "growth_story" ? "revenue rose every quarter of fiscal 2025, from 290,000 USD in Q1 to 362,000 USD in Q4; Q4 contributed the most at 28% of the year." : "see rows"}`;
        entries.push({ slot_id: slot.slot_id, columns: observed.columns, rows, summary, ...(naming ? { highlight: `${(observed.rows[0] as { customer: string }).customer} led the year` } : {}),
          verified: true, definition: { sql, source_tables: sql.includes("customers") ? ["orders", "customers"] : ["orders"], filters: ["fiscal year 2025", "completed orders only"] }, cites: observed.query_id });
      }
      // A terminal that re-types a quoted predicate without escaping it: the JSON breaks inside `filters`.
      if (options.brokenTerminal) {
        intended = entries.map((entry) => { const { cites, definition: _definition, ...rest } = entry as Record<string, unknown>; return cites === undefined ? rest : { ...rest, definition: { query_id: cites, source_tables: (_definition as { source_tables: string[] }).source_tables } }; });
        return record("generate_sql", JSON.stringify(entries).replace('"completed orders only"', '"status = "completed""'));
      }
      return record("generate_sql", JSON.stringify(entries.map((entry) => { const { cites: _cites, ...rest } = entry as Record<string, unknown>; return rest; })));
    }
    if (Object.hasOwn(run.consumes, "batch_result")) {
      // The repair step uses its whole loop cap too.
      if (options.childFailure === "loop_cap") return { ...record("repair_sql", `Repair still working on ${CHILD_MARKER}`), failed: true };
      if (options.brokenTerminal === "repaired") return record("repair_sql", JSON.stringify(intended));
      if (options.brokenTerminal === "still") return record("repair_sql", `Repaired:\n${JSON.stringify(intended).replace('"slot_id":"order_count"', '"slot_id":"order_count""')}`);
      return record("repair_sql", "[]");
    }
    return record("resolve_intent", JSON.stringify(SLOTS.map((slot) => ({ slot_id: slot.slot_id, compute: slot.question, expected_shape: slot.expected_shape }))));
  });
  return { calls, askRequests, askResults };
}

async function runReport(project: string, options: { mutateNarration?: boolean; toolErrorSlot?: string; namingSummary?: boolean; brokenTerminal?: "repaired" | "still"; childFailure?: ChildFailure; usage?: Record<string, StepUsage>; zoneRoles?: Record<string, string>; tierBinding?: Record<string, AdapterSpec> } = {}) {
  const { plan, ir } = await loadReportPlan(project);
  const fakes = installFakeModels({ mutateNarration: options.mutateNarration ?? false, ...(options.toolErrorSlot ? { toolErrorSlot: options.toolErrorSlot } : {}),
    ...(options.brokenTerminal ? { brokenTerminal: options.brokenTerminal } : {}), ...(options.childFailure ? { childFailure: options.childFailure } : {}),
    ...(options.namingSummary ? { namingSummary: true } : {}), ...(options.usage ? { usage: options.usage } : {}) });
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

beforeEach(() => { vi.resetAllMocks(); judgeScript.redactColumn = undefined; });

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

  it("an unparseable generate_sql terminal runs repair_sql once with the raw text and the parse error, and a repair citing queries by id fills the report", async () => {
    const project = await mkdtemp(path.join(os.tmpdir(), "genbi-report-repair-"));
    try {
      const { result, events, calls, contract } = await runReport(project, { brokenTerminal: "repaired" });
      expect(result.kind).toBe("answer");
      if (result.kind !== "answer") throw new Error("unreachable");
      const childSteps = events.filter((event): event is Extract<AgentEvent, { kind: "step.start" }> => event.kind === "step.start" && event.depth === 1);
      expect(childSteps.map((event) => event.name)).toEqual(["resolve_intent", "generate_sql", "repair_sql"]);
      const repair = calls.find((call) => call.step === "repair_sql")!;
      const generated = calls.find((call) => call.step === "generate_sql")!.output;
      expect((repair.consumes as { batch_result: unknown }).batch_result).toEqual({ status: "error", code: "step_failed", reason: expect.stringMatching(/^terminal_unparseable: /), text: generated });
      const envelope = result.envelope as { blocks: Record<string, unknown>[]; verified: boolean };
      const data = envelope.blocks.filter((block) => block.type !== "definition");
      expect(data.map((block) => [block.type, block.slot_id])).toEqual([
        ["kpi_card", "total_revenue"], ["kpi_card", "order_count"], ["kpi_card", "avg_order_value"], ["chart", "revenue_by_quarter"], ["chart", "revenue_by_month"],
        ["table", "top_customers"], ["narrative", "growth_story"], ["unavailable", "largest_orders"], ["unavailable", "refund_rate"]]);
      expect(data[0]).toMatchObject({ value: 1284500 });
      // The SQL comes from the executed query the id names. This fake tool proves no lineage, so the claimed
      // source tables are kept for the definition block, and an id-cited entry contributes no filters.
      expect(envelope.blocks.find((block) => block.type === "definition" && block.slot_id === "top_customers")).toEqual({ type: "definition", sql: SQL.top_customers, source_tables: ["orders", "customers"], filters: [], slot_id: "top_customers" });
      expect(envelope.verified).toBe(true);
      expect(normalizeComponentResult(JSON.stringify(envelope), contract).value.status).toBe("ok");
    } finally { await rm(project, { recursive: true, force: true }); }
  });

  it("a repair whose terminal still does not parse leaves every cell unavailable instead of failing the child", async () => {
    const project = await mkdtemp(path.join(os.tmpdir(), "genbi-report-unparseable-"));
    try {
      const { result, events, askResults, contract } = await runReport(project, { brokenTerminal: "still" });
      expect(result.kind).toBe("answer");
      if (result.kind !== "answer") throw new Error("unreachable");
      const childSteps = events.filter((event): event is Extract<AgentEvent, { kind: "step.start" }> => event.kind === "step.start" && event.depth === 1);
      expect(childSteps.map((event) => event.name)).toEqual(["resolve_intent", "generate_sql", "repair_sql"]);
      const disclosed = askResults[0] as { status: string; output: { value: { answers: { slot_id: string; status: string; reason_category?: string }[] } } };
      expect(disclosed.status).toBe("ok");
      expect(disclosed.output.value.answers.map((answer) => [answer.slot_id, answer.status, answer.reason_category])).toEqual(SLOTS.map((slot) => [slot.slot_id, "refused", "unanswerable"]));
      expect(JSON.stringify(disclosed)).not.toContain("terminal_unparseable");
      const envelope = result.envelope as { blocks: Record<string, unknown>[] };
      expect(envelope.blocks.map((block) => [block.type, block.slot_id])).toEqual(SLOTS.map((slot) => ["unavailable", slot.slot_id]));
      expect(normalizeComponentResult(JSON.stringify(envelope), contract).value.status).toBe("ok");
    } finally { await rm(project, { recursive: true, force: true }); }
  });

  it.each([
    ["loop_cap", "callee_error", "generate_sql and its repair both use their whole loop cap, so the child fails", ["resolve_intent", "generate_sql", "repair_sql"]],
    ["zero_queries", "callee_refused", "generate_sql finishes without executing a single query, so normalization refuses the child", ["resolve_intent", "generate_sql"]],
  ] as const)("a batch child that fails or is refused as a whole (%s) still renders the report: every slot unavailable with %s, unverified (%s)", async (failure, category, _how, childStepNames) => {
    const project = await mkdtemp(path.join(os.tmpdir(), `genbi-report-callee-failed-${failure}-`));
    try {
      const { result, events, calls, askResults, contract } = await runReport(project, { childFailure: failure, usage: {
        "cloud-planner": { inputTokens: 1200, outputTokens: 300 }, "local-super-cheap": { inputTokens: 40, outputTokens: 4 }, "local-super": { inputTokens: 5000, outputTokens: 700 } } });
      expect(result.kind).toBe("answer");
      if (result.kind !== "answer") throw new Error("unreachable");
      // The child's own steps ran: on the loop cap the last of them failed; with no query they finished and normalization refused the child.
      const childFinishes = events.filter((event): event is Extract<AgentEvent, { kind: "step.finish" }> => event.kind === "step.finish" && childStepNames.includes(event.name as never) && event.name !== "resolve_intent");
      expect(childFinishes.map((event) => [event.name, event.status])).toEqual(failure === "loop_cap" ? [["generate_sql", "error"], ["repair_sql", "error"]] : [["generate_sql", "ok"]]);
      // No child model text reaches the public planner: not its ask result, not its own or the narrator's inputs.
      expect(calls.filter((call) => childStepNames.includes(call.step as never)).some((call) => call.output.includes(CHILD_MARKER))).toBe(true);
      expect(JSON.stringify(askResults)).not.toContain(CHILD_MARKER);
      for (const call of calls.filter((call) => call.step === "plan_layout" || call.step === "narrate")) expect(JSON.stringify(call)).not.toContain(CHILD_MARKER);
      expect(JSON.stringify(result)).not.toContain(CHILD_MARKER);
      // The planner's ask resolved with every declared slot refused on the category of what happened, and nothing else.
      expect(askResults).toHaveLength(1);
      expect(askResults[0]).toStrictEqual({ status: "ok", output: { kind: "value", value: { answers: SLOTS.map((slot) => ({ slot_id: slot.slot_id, status: "refused", reason_category: category })) } }, provenance: { verified: false } });
      // The planner still laid the report out, and the narrator ran over the all-unavailable slot table.
      expect(calls.map((call) => call.step)).toEqual([...childStepNames, "plan_layout", "narrate"]);
      const envelope = result.envelope as { blocks: Record<string, unknown>[]; verified: boolean };
      expect(envelope.blocks.map((block) => [block.type, block.slot_id, block.reason_category])).toEqual(SLOTS.map((slot) => ["unavailable", slot.slot_id, category]));
      expect(envelope.verified).toBe(false);
      expect(normalizeComponentResult(JSON.stringify(envelope), contract).value.status).toBe("ok");
      // The trace keeps the failed child: its egress decisions, its tool calls, and the usage of each of its steps.
      expect(result.trace?.steps.filter((step) => step.tool === "egress").map((step) => step.detail)).toEqual(SLOTS.map((slot) => `ask/${slot.slot_id}: refused (${category})`));
      expect(result.trace?.steps.filter((step) => step.tool === "query").map((step) => step.outcome)).toEqual(failure === "loop_cap" ? ["success"] : []);
      const at = (step: string, tier: string, model: string, inputTokens: number, outputTokens: number) => ({ component: "answer_batch", step, tier, depth: 1, zone: "private", adapter: "mock", model, inputTokens, outputTokens });
      expect(result.trace?.usage?.steps.filter((step) => step.component === "answer_batch")).toStrictEqual([
        at("resolve_intent", "cheap", "local-super-cheap", 40, 4), at("generate_sql", "strong", "local-super", 5000, 700),
        ...(failure === "loop_cap" ? [at("repair_sql", "strong", "local-super", 5000, 700)] : [])]);
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

  it("a judge redact removes the named column from the rows and every model-written text: no redacted value reaches a public-tier surface", async () => {
    const project = await mkdtemp(path.join(os.tmpdir(), "genbi-report-redact-"));
    try {
      judgeScript.redactColumn = "customer";
      const { result, calls, askResults } = await runReport(project, { namingSummary: true });
      if (result.kind !== "answer") throw new Error("expected an answer");
      const names = TABLES[SQL.top_customers]!.rows.map((row) => String(row["customer"]));
      const withoutNames = (label: string, value: unknown) => { const text = JSON.stringify(value); for (const name of names) expect(text, `${label}: ${name}`).not.toContain(name); };
      // The planner's tool result (the disclosed alias-call result) is what reaches the public model inside plan_layout.
      withoutNames("disclosed alias-call result", askResults);
      const disclosed = askResults[0] as { output: { value: { answers: Record<string, unknown>[] } } };
      expect(disclosed.output.value.answers.find((answer) => answer["slot_id"] === "top_customers")).toEqual({
        slot_id: "top_customers", status: "partial", shape: "table", columns: ["revenue"], rows: [{ revenue: 96200 }, { revenue: 88750 }, { revenue: 81400 }, { revenue: 74900 }, { revenue: 69300 }],
        unit: "USD", summary: "5 rows; columns: revenue." });
      expect(result.trace?.steps.filter((step) => step.tool === "egress").map((step) => step.detail)).toContain("ask/top_customers: partial");
      // Every recorded public-tier surface audits exactly the texts the model received, and none of those texts names a customer.
      const publicSurfaces = (result.trace?.surfaces ?? []).filter((record) => record.zone === "public");
      expect(publicSurfaces.map((record) => record.step)).toEqual(["plan_layout", "narrate"]);
      for (const record of publicSurfaces) {
        const call = calls.find((candidate) => candidate.step === record.step)!;
        expect(record.surfaces["input"]).toBe(sha(JSON.stringify({ request: call.request, input: call.input })));
        expect(record.surfaces["consumes"]).toBe(sha(JSON.stringify(call.consumes)));
        expect(record.surfaces["brief"]).toBe(sha(call.brief!));
        withoutNames(record.step, { brief: call.brief, prompt: call.prompt, request: call.request, input: call.input, consumes: call.consumes, output: call.output });
      }
      // The report still renders the surviving column, and the final envelope names no customer either.
      const envelope = result.envelope as { blocks: Record<string, unknown>[] };
      expect(envelope.blocks.find((block) => block.type === "table" && block.slot_id === "top_customers")).toMatchObject({ columns: ["revenue"], rows: [[96200], [88750], [81400], [74900], [69300]] });
      withoutNames("envelope", envelope);
    } finally { await rm(project, { recursive: true, force: true }); }
  });

  it("usage: every root step, child step and judge call is attributed to the provider and zone that served it, counts only", async () => {
    const project = await mkdtemp(path.join(os.tmpdir(), "genbi-report-usage-"));
    try {
      // Distinct counts per model so a record attributed to the wrong tier or zone shows up in the totals. The narrator reports nothing.
      const { result } = await runReport(project, { usage: {
        "cloud-planner": { inputTokens: 1200, outputTokens: 300 },
        "local-super-cheap": { inputTokens: 40, outputTokens: 4 },
        "local-super": { inputTokens: 5000, outputTokens: 700 },
      } });
      if (result.kind !== "answer") throw new Error("expected an answer");
      const usage = result.trace?.usage;
      if (!usage) throw new Error("expected usage on the trace");
      const judged = result.trace!.steps.filter((step) => step.tool === "egress" && step.outcome === "success").length;
      expect(judged).toBe(7);
      const at = (component: string, step: string, tier: string, depth: number, zone: string, model: string, inputTokens: number, outputTokens: number) =>
        ({ component, step, tier, depth, zone, adapter: "mock", model, inputTokens, outputTokens });
      // In completion order: the child's two steps, the judge on each slot that reached it, then the planner and the narrator.
      expect(usage.steps).toStrictEqual([
        at("answer_batch", "resolve_intent", "cheap", 1, "private", "local-super-cheap", 40, 4),
        at("answer_batch", "generate_sql", "strong", 1, "private", "local-super", 5000, 700),
        ...Array.from({ length: judged }, () => at("answer_batch", "egress_judge", "judge", 1, "private", "local-judge", 21, 3)),
        at("plan_report", "plan_layout", "strong", 0, "public", "cloud-planner", 1200, 300),
        // An adapter that reports no usage is recorded as explicit zeros, not left out.
        at("plan_report", "narrate", "cheap", 0, "public", "cloud-narrator", 0, 0),
      ]);
      expect(usage.providers).toStrictEqual([
        { zone: "private", adapter: "mock", model: "local-super-cheap", calls: 1, inputTokens: 40, outputTokens: 4 },
        { zone: "private", adapter: "mock", model: "local-super", calls: 1, inputTokens: 5000, outputTokens: 700 },
        { zone: "private", adapter: "mock", model: "local-judge", calls: judged, inputTokens: 21 * judged, outputTokens: 3 * judged },
        { zone: "public", adapter: "mock", model: "cloud-planner", calls: 1, inputTokens: 1200, outputTokens: 300 },
        { zone: "public", adapter: "mock", model: "cloud-narrator", calls: 1, inputTokens: 0, outputTokens: 0 },
      ]);
      // Per zone, the totals are exactly the zone's own models: nothing private is charged to public or the reverse.
      const zoneTotal = (zone: string) => usage.providers.filter((provider) => provider.zone === zone)
        .reduce((sum, provider) => [sum[0]! + provider.inputTokens, sum[1]! + provider.outputTokens], [0, 0]);
      expect(zoneTotal("public")).toEqual([1200, 300]);
      expect(zoneTotal("private")).toEqual([5040 + 21 * judged, 704 + 3 * judged]);
      // Counts and identities only: no question, preamble, slot text, SQL, row value or model output in the records.
      const text = JSON.stringify(usage);
      for (const sql of Object.values(SQL)) expect(text).not.toContain(sql);
      for (const slot of SLOTS) expect(text).not.toContain(slot.question);
      expect(text).not.toMatch(/SELECT|fiscal|Northwind|revenue|USD|verdict/i);
    } finally { await rm(project, { recursive: true, force: true }); }
  });

  it("public tiers bound to the native openai adapter take the key from the environment, and it appears nowhere in the result or trace", async () => {
    const project = await mkdtemp(path.join(os.tmpdir(), "genbi-report-openai-"));
    const key = "fake-openai-key-for-tests";
    vi.stubEnv("OPENAI_API_KEY", key);
    try {
      const openai = (model: string): AdapterSpec => ({ adapter: "openai", config: { model }, zone: "public" });
      const tierBinding = { ...binding, "plan_report/strong": openai("gpt-planner"), "plan_report/cheap": openai("gpt-narrator") };
      const { result, calls } = await runReport(project, { tierBinding });
      expect(result.kind).toBe("answer");
      expect(calls.filter((call) => call.tier === "strong" || call.tier === "cheap").map((call) => [call.step, call.modelId]))
        .toEqual([["resolve_intent", "local-super-cheap"], ["generate_sql", "local-super"], ["plan_layout", "gpt-planner"], ["narrate", "gpt-narrator"]]);
      expect(JSON.stringify(result)).not.toContain(key);
      expect(JSON.stringify(tierBinding)).not.toContain(key);
    } finally { vi.unstubAllEnvs(); await rm(project, { recursive: true, force: true }); }
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
