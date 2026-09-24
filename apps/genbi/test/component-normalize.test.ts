import { describe, expect, it } from "vitest";
import { normalizeComponentEvidence } from "../harness/components/normalize.js";
import type { ComponentPlan } from "../harness/components/runner.js";

const definition = { sql: "SELECT n FROM orders WHERE n > 0", source_tables: ["orders"], filters: ["n > 0"] };
function normalize(block: Record<string, unknown>) {
  const component: ComponentPlan = { id: "dashboard", declaration: {
    required_capabilities: ["component_invocation"], effect: { render_blocks: [
      { type: "kpi_card", fields: { label: "string", value: "number|string", unit: "string?", delta: "number?" } },
      { type: "table", fields: { columns: "string[]", rows: "row[]" } },
      { type: "definition", fields: { sql: "string", source_tables: "string[]", filters: "string[]" } },
    ] },
  }, steps: [{ name: "layout", tier: "strong", prompt: "", consumes: [], produces: "result", tools: [], calls: [{ alias: "answer", component: "answer" }] }] };
  return normalizeComponentEvidence(component, { steps: { result: JSON.stringify({ blocks: [block] }) }, tools: [],
    children: [{ status: "ok", output: { kind: "value", value: { columns: ["n"], rows: [{ n: 7 }] } }, provenance: { verified: true, definition } }],
  });
}
describe("observed render provenance", () => {
  it("accepts only the observed KPI column and value", () => {
    expect(normalize({ type: "kpi_card", label: "n", value: 7 }).status).toBe("ok");
    for (const patch of [{ label: "invented" }, { value: 8 }, { unit: "USD" }, { delta: 2 }]) {
      expect(normalize({ type: "kpi_card", label: "n", value: 7, ...patch }).status).toBe("refused");
    }
  });
  it("requires the SQL, source tables and filters to match observed definitions", () => {
    expect(normalize({ type: "definition", ...definition }).status).toBe("ok");
    for (const patch of [{ sql: "SELECT invented" }, { source_tables: ["private"] }, { filters: [] }]) {
      expect(normalize({ type: "definition", ...definition, ...patch }).status).toBe("refused");
    }
  });
  it("rejects fabricated columns, empty rows and invented values", () => {
    expect(normalize({ type: "table", columns: ["n"], rows: [[7]] }).status).toBe("ok");
    for (const rows of [[], [{}], [[8]], [[7, 9]]]) expect(normalize({ type: "table", columns: ["n"], rows }).status).not.toBe("ok");
  });
});

describe("batch-shaped callee normalization (answer_batch)", () => {
  const sqlTotal = "SELECT SUM(amount) AS total_revenue FROM orders";
  const sqlQuarter = "SELECT quarter, SUM(amount) AS revenue FROM orders GROUP BY quarter ORDER BY quarter";
  const sqlStray = "SELECT COUNT(*) AS n FROM orders WHERE status = 'completed'";
  const component: ComponentPlan = { id: "answer_batch", declaration: { required_capabilities: ["sql_execution:read_only"], guardrails: [{ name: "read_only_execution", locked: true }], effect: { render_blocks: [] } },
    steps: [{ name: "generate_sql", tier: "strong", prompt: "", consumes: [], produces: "batch_result", tools: [{ name: "query", source: "native" }], calls: [] }] };
  const tools = [
    { step: "generate_sql", tool: "query", input: { sql: sqlTotal }, output: { columns: ["total_revenue"], rows: [{ total_revenue: 1284500 }] } },
    { step: "generate_sql", tool: "query", input: { sql: sqlQuarter }, output: { columns: ["quarter", "revenue"], rows: [{ quarter: "Q1", revenue: 1 }, { quarter: "Q2", revenue: 2 }],
      definition: { sql: sqlQuarter, source_tables: ["orders"], filters: ["quarter"] } } },
    { step: "generate_sql", tool: "query", input: { sql: sqlStray }, output: { columns: ["n"], rows: [{ n: 67 }] } },
  ];
  const run = (entries: unknown[]) => normalizeComponentEvidence(component, { steps: { batch_result: JSON.stringify(entries) }, tools, children: [] });
  it("returns one entry per slot, rebuilt from the observed query result its SQL names", () => {
    const result = run([
      { slot_id: "total", columns: ["total_revenue"], rows: [[999]], summary: "total revenue", verified: true, definition: { sql: sqlTotal, source_tables: ["orders"], filters: ["fy2025"] } },
      { slot_id: "by_quarter", columns: ["quarter", "revenue"], rows: [["Q1", 1]], summary: "by quarter", verified: true, definition: { sql: sqlQuarter, source_tables: ["invented"], filters: [] } },
      { slot_id: "refunds", status: "unanswerable", reason: "  no refund measure  " },
    ]);
    expect(result.status).toBe("ok");
    if (result.status !== "ok" || result.output.kind !== "value") throw new Error("unreachable");
    expect(result.output.value).toEqual([
      // The model wrote 999; the observed row wins. Lineage strings it claimed are kept when no tool-proven definition exists.
      { slot_id: "total", columns: ["total_revenue"], rows: [{ total_revenue: 1284500 }], verified: true, summary: "total revenue", definition: { sql: sqlTotal, source_tables: ["orders"], filters: ["fy2025"] } },
      // The tool proved this definition itself; the model's "invented" lineage is not read.
      { slot_id: "by_quarter", columns: ["quarter", "revenue"], rows: [{ quarter: "Q1", revenue: 1 }, { quarter: "Q2", revenue: 2 }], verified: true, summary: "by quarter", definition: { sql: sqlQuarter, source_tables: ["orders"], filters: ["quarter"] } },
      { slot_id: "refunds", status: "unanswerable", reason: "no refund measure" },
    ]);
    expect(result.provenance).toEqual({ verified: true });
  });
  it("an entry no executed query backs becomes unanswerable, never a verified number; the stray last table does not displace an answer", () => {
    const result = run([
      { slot_id: "total", columns: ["total_revenue"], rows: [[1284500]], verified: true, definition: { sql: "SELECT 1284500 AS total_revenue" } },
      { slot_id: "count", columns: ["n"], rows: [[99]], verified: true },
      { slot_id: "total", columns: ["total_revenue"], rows: [[1]], verified: true, definition: { sql: sqlTotal } },
    ]);
    if (result.status !== "ok" || result.output.kind !== "value") throw new Error("unreachable");
    expect(result.output.value).toEqual([
      { slot_id: "total", status: "unanswerable", reason: "no executed query backs this answer" },
      { slot_id: "count", status: "unanswerable", reason: "no executed query backs this answer" },
    ]);
    expect(result.provenance).toBeUndefined();
  });
  it("still refuses a batch that executed no query at all", () => {
    expect(normalizeComponentEvidence(component, { steps: { batch_result: JSON.stringify([{ slot_id: "total", status: "unanswerable", reason: "x" }]) }, tools: [], children: [] }).status).toBe("refused");
  });
});

/** A callee returning reusable data: the value is the observed table the terminal value names. */
const answerComponent: ComponentPlan = { id: "answer", declaration: { required_capabilities: ["sql_execution:read_only"], effect: { render_blocks: [] } },
  steps: [{ name: "generate_sql", tier: "strong", prompt: "", consumes: [], produces: "query_result", tools: [{ name: "query", source: "native" }], calls: [] }] };
const CORRECT = "SELECT COUNT(*) AS n FROM orders";
const STRAY = "SELECT COUNT(*) AS n FROM orders WHERE status = 'completed'";
function observed(sql: string, n: number) {
  return { step: "generate_sql", tool: "query", input: { sql }, output: { columns: ["n"], rows: [{ n }], definition: { sql, source_tables: ["orders"], filters: [] } } };
}
function answer(terminal: unknown, tools: ReturnType<typeof observed>[]) {
  return normalizeComponentEvidence(answerComponent, { steps: { query_result: typeof terminal === "string" ? terminal : JSON.stringify(terminal) }, tools, children: [] });
}
describe("the answering query is the one the terminal value names, not the last table", () => {
  const twoQueries = [observed(CORRECT, 99), observed(STRAY, 67)];
  it("a correct query followed by a stray second query still answers with the correct table", () => {
    const result = answer({ columns: ["n"], rows: [[99]], summary: "99 orders", verified: true, definition: { sql: CORRECT, source_tables: ["orders"], filters: [] } }, twoQueries);
    expect(result).toMatchObject({ status: "ok", output: { kind: "value", value: { rows: [{ n: 99 }], verified: true, definition: { sql: CORRECT } } }, provenance: { verified: true, definition: { sql: CORRECT } } });
  });
  it("matches the named query up to whitespace and a trailing terminator, and takes the rows from the observation", () => {
    const result = answer({ columns: ["n"], rows: [[12345]], verified: true, definition: { sql: `${CORRECT.replace(" AS ", "\n  AS ")};` } }, twoQueries);
    expect(result).toMatchObject({ status: "ok", output: { value: { rows: [{ n: 99 }] } } });
  });
  it("refuses a terminal value that names a query which never ran, rather than answering with another table", () => {
    expect(answer({ columns: ["n"], rows: [[5]], verified: true, definition: { sql: "SELECT COUNT(*) AS n FROM customers" } }, twoQueries).status).toBe("refused");
  });
  it("keeps the last observation only for a value that names no query at all", () => {
    expect(answer("done", twoQueries)).toMatchObject({ status: "ok", output: { value: { rows: [{ n: 67 }], definition: { sql: STRAY } } } });
  });
});
