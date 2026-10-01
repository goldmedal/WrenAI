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
  describe("a terminal that wraps exactly one JSON value in prose", () => {
    const entries = [
      { slot_id: "total", columns: ["total_revenue"], rows: [[999]], summary: "total revenue", verified: true, definition: { sql: sqlTotal } },
      { slot_id: "refunds", status: "unanswerable", reason: "no refund measure" },
    ];
    const json = JSON.stringify(entries);
    const perSlot = [
      { slot_id: "total", columns: ["total_revenue"], rows: [{ total_revenue: 1284500 }], verified: true, summary: "total revenue", definition: { sql: sqlTotal, source_tables: [], filters: [] } },
      { slot_id: "refunds", status: "unanswerable", reason: "no refund measure" },
    ];
    const terminal = (text: string) => normalizeComponentEvidence(component, { steps: { batch_result: text }, tools, children: [] });
    const prose = terminal("I could not find the answer.");
    it.each([
      ["a prose prefix", `Here are the answers for all slots:\n${json}`],
      ["a Markdown fence", `\`\`\`json\n${json}\n\`\`\``],
      ["a reasoning tag holding a draft", `<think>Draft: [{"slot_id":"total","definition":{"sql":"${sqlStray}"}}]</think>\n${json}`],
      ["a lone closing reasoning tag", `Let me check [{"slot_id":"draft"}] first.\n</think>\n\n${json}`],
      ["prose on both sides", `Answers below.\n\`\`\`\n${json}\n\`\`\`\nLet me know if you need more [detail].`],
    ])("normalises per slot through %s", (_, text) => {
      const result = terminal(text);
      expect(result).toEqual({ status: "ok", output: { kind: "value", value: perSlot }, provenance: { verified: true } });
    });
    it.each([
      ["zero JSON values", "The totals are listed above (see [notes])."],
      ["two JSON values", `First try: ${JSON.stringify([{ ...entries[0], definition: { sql: sqlStray } }])}\nFinal: ${json}`],
    ])("keeps %s as prose, exactly as an unparseable terminal is handled today", (_, text) => {
      const result = terminal(text);
      expect(result).toEqual(prose);
      if (result.status === "ok" && result.output.kind === "value") expect(Array.isArray(result.output.value)).toBe(false);
    });
    it("does not widen grounding: a tolerantly parsed entry no executed query backs is unanswerable", () => {
      const unbacked = [{ slot_id: "total", columns: ["total_revenue"], rows: [[1284500]], verified: true, definition: { sql: "SELECT 1284500 AS total_revenue" } }];
      const result = terminal(`Sure! Here you go:\n\`\`\`json\n${JSON.stringify(unbacked)}\n\`\`\``);
      expect(result).toEqual({ status: "ok", output: { kind: "value", value: [{ slot_id: "total", status: "unanswerable", reason: "no executed query backs this answer" }] } });
    });
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
  it("an incidental array in a single-answer prose terminal stays prose and answers with the last observation", () => {
    expect(answer("Orders by year [2024, 2025] were 1 and 0.", [observed(CORRECT, 99)]))
      .toEqual({ status: "ok", output: { kind: "value", value: { columns: ["n"], rows: [{ n: 99 }], verified: true, summary: "Query completed.", definition: { sql: CORRECT, source_tables: ["orders"], filters: [] } } },
        provenance: { verified: true, definition: { sql: CORRECT, source_tables: ["orders"], filters: [] } } });
  });
});

describe("a terminal cites an executed query by the id the host attached to its result", () => {
  const withId = (call: ReturnType<typeof observed>, id: string) => ({ ...call, output: { ...call.output, query_id: id } });
  const ran = [withId(observed(CORRECT, 99), "q1"), withId(observed(STRAY, 67), "q2")];
  const batch: ComponentPlan = { id: "answer_batch", declaration: { required_capabilities: ["sql_execution:read_only"], effect: { render_blocks: [] } },
    steps: [{ name: "generate_sql", tier: "strong", prompt: "", consumes: [], produces: "batch_result", tools: [{ name: "query", source: "native" }], calls: [] }] };
  const runBatch = (entries: unknown[], tools = ran) => normalizeComponentEvidence(batch, { steps: { batch_result: JSON.stringify(entries) }, tools, children: [] });
  it("grounds each entry on the observation carrying that id, with provenance from that query", () => {
    const result = runBatch([
      { slot_id: "stray", summary: "67 completed", definition: { query_id: "q2" } },
      { slot_id: "all", summary: "99 orders", definition: { query_id: "q1" } },
    ]);
    expect(result).toEqual({ status: "ok", output: { kind: "value", value: [
      { slot_id: "stray", columns: ["n"], rows: [{ n: 67 }], verified: true, summary: "67 completed", definition: { sql: STRAY, source_tables: ["orders"], filters: [] } },
      { slot_id: "all", columns: ["n"], rows: [{ n: 99 }], verified: true, summary: "99 orders", definition: { sql: CORRECT, source_tables: ["orders"], filters: [] } },
    ] }, provenance: { verified: true } });
  });
  const definitionOf = (result: ReturnType<typeof runBatch>) => result.status === "ok" && result.output.kind === "value" ? (result.output.value as { definition?: unknown }[])[0]?.definition : undefined;
  it("an id-cited entry over a tool output with no lineage keeps the claimed source tables, takes the SQL from the observation and carries no filters", () => {
    const bare = [{ step: "generate_sql", tool: "query", input: { sql: STRAY }, output: { columns: ["n"], rows: [{ n: 67 }], query_id: "q1" } }];
    const result = runBatch([{ slot_id: "s", definition: { query_id: "q1", sql: "SELECT invented", source_tables: ["orders"], filters: ["status = 'x'"] } }], bare as typeof ran);
    expect(result).toMatchObject({ status: "ok", output: { value: [{ slot_id: "s", rows: [{ n: 67 }] }] } });
    expect(definitionOf(result)).toEqual({ sql: STRAY, source_tables: ["orders"] });
  });
  it("an id-cited entry over a tool-proven definition takes the proven lineage, not the claimed one", () => {
    const result = runBatch([{ slot_id: "s", definition: { query_id: "q2", source_tables: ["private"], filters: ["invented"] } }]);
    expect(definitionOf(result)).toEqual({ sql: STRAY, source_tables: ["orders"], filters: [] });
  });
  it("an id no executed query carries is unanswerable, even when its SQL matches one that ran; unknown SQL stays unanswerable", () => {
    const result = runBatch([
      { slot_id: "missing", definition: { query_id: "q9" } },
      { slot_id: "missing_with_sql", definition: { query_id: "q9", sql: CORRECT } },
      { slot_id: "never_ran", definition: { sql: "SELECT COUNT(*) AS n FROM customers" } },
      { slot_id: "by_sql", definition: { sql: CORRECT } },
    ]);
    if (result.status !== "ok" || result.output.kind !== "value") throw new Error("unreachable");
    expect(result.output.value).toEqual([
      { slot_id: "missing", status: "unanswerable", reason: "no executed query backs this answer" },
      { slot_id: "missing_with_sql", status: "unanswerable", reason: "no executed query backs this answer" },
      { slot_id: "never_ran", status: "unanswerable", reason: "no executed query backs this answer" },
      { slot_id: "by_sql", columns: ["n"], rows: [{ n: 99 }], verified: true, summary: "Query completed.", definition: { sql: CORRECT, source_tables: ["orders"], filters: [] } },
    ]);
  });
  it("the single-answer path selects the cited query, and refuses an id that never ran", () => {
    expect(answer({ summary: "99 orders", definition: { query_id: "q1" } }, ran)).toMatchObject({ status: "ok", output: { value: { rows: [{ n: 99 }], definition: { sql: CORRECT } } } });
    expect(answer({ definition: { query_id: "q9", sql: STRAY } }, ran).status).toBe("refused");
  });
});

describe("lineage when the tool proves no definition, and optional filters on a composed definition block", () => {
  const bare = [{ step: "generate_sql", tool: "query", input: { sql: CORRECT }, output: { columns: ["n"], rows: [{ n: 99 }], query_id: "q1" } }];
  it("a single answer over a tool output without lineage keeps the claimed source tables and carries no filters", () => {
    const result = answer({ summary: "99 orders", definition: { query_id: "q1", source_tables: ["orders"], filters: ["invented"] } }, bare as unknown as ReturnType<typeof observed>[]);
    expect(result).toMatchObject({ status: "ok", provenance: { definition: { sql: CORRECT, source_tables: ["orders"] } } });
    if (result.status !== "ok") throw new Error("unreachable");
    expect(result.provenance?.definition).toEqual({ sql: CORRECT, source_tables: ["orders"] });
    expect((result.output as { value: { definition: unknown } }).value.definition).toEqual({ sql: CORRECT, source_tables: ["orders"] });
  });
  it("a single answer over a tool-proven definition takes the proven one", () => {
    const proven = [{ ...observed(CORRECT, 99), output: { ...observed(CORRECT, 99).output, query_id: "q1" } }];
    const result = answer({ definition: { query_id: "q1", source_tables: ["private"] } }, proven);
    if (result.status !== "ok") throw new Error("unreachable");
    expect(result.provenance?.definition).toEqual({ sql: CORRECT, source_tables: ["orders"], filters: [] });
  });
  const lenient = (block: Record<string, unknown>, childDefinition: Record<string, unknown>) => {
    const component: ComponentPlan = { id: "dashboard", declaration: { required_capabilities: ["component_invocation"], effect: { render_blocks: [
      { type: "definition", fields: { sql: "string", source_tables: "string[]", filters: "string[]?" } },
    ] } }, steps: [{ name: "layout", tier: "strong", prompt: "", consumes: [], produces: "result", tools: [], calls: [{ alias: "answer", component: "answer" }] }] };
    return normalizeComponentEvidence(component, { steps: { result: JSON.stringify({ blocks: [block] }) }, tools: [],
      children: [{ status: "ok", output: { kind: "value", value: { columns: ["n"], rows: [{ n: 7 }] } }, provenance: { verified: true, definition: childDefinition } }] });
  };
  it("a definition block without filters matches a child definition carrying filters, and one carrying filters must match them exactly", () => {
    const child = { sql: CORRECT, source_tables: ["orders"], filters: [] };
    expect(lenient({ type: "definition", sql: CORRECT, source_tables: ["orders"] }, child).status).toBe("ok");
    expect(lenient({ type: "definition", sql: CORRECT, source_tables: ["orders"], filters: [] }, child).status).toBe("ok");
    expect(lenient({ type: "definition", sql: CORRECT, source_tables: ["orders"], filters: ["n > 0"] }, child).status).toBe("refused");
    expect(lenient({ type: "definition", sql: CORRECT, source_tables: ["invented"] }, child).status).toBe("refused");
  });
  it("a child definition without filters (no tool lineage) still grounds a definition block", () => {
    expect(lenient({ type: "definition", sql: CORRECT, source_tables: ["orders"] }, { sql: CORRECT, source_tables: ["orders"] }).status).toBe("ok");
  });
});
