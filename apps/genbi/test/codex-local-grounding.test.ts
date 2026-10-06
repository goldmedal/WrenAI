import { describe, expect, it } from "vitest";
import type { RouteResult } from "../harness/index.js";
import type { HostQueryObservation } from "../harness/route/host-query.js";
import { truncationNote } from "../server/host-evidence-grounding.js";
import { toAnswerOrRefusalEvent, withHostVerification } from "../server/fold.js";
import type { AnswerEvent } from "../server/wire-types.js";

const SQL = "SELECT COUNT(*) AS order_count FROM orders";
const observed = (sql: string, queryId: string, sourceTables: string[] = ["orders"], count = 42): HostQueryObservation => ({
  tool: "run_sql",
  input: { sql, limit: 1000 },
  output: { columns: ["order_count"], rows: [{ order_count: count }], definition: { sql, source_tables: sourceTables, filters: [] }, query_id: queryId },
});
const codex = (answer: unknown, hostObservations: HostQueryObservation[]): RouteResult =>
  ({ backend: "codex-local", warnings: [], finalText: JSON.stringify(answer), hostObservations });
function envelope(result: RouteResult) {
  const event = toAnswerOrRefusalEvent("evt", result) as AnswerEvent;
  if (event.answer.form !== "rich") throw new Error("expected a rich answer");
  return event.answer.envelope;
}

describe("codex:local grounding", () => {
  it("rebuilds a cited answer from the observation and keeps only the model's summary", () => {
    const result = codex({ columns: ["order_count"], rows: [[41]], summary: "42 orders", note: "model prose", definition: { sql: SQL } }, [observed(SQL, "q1-aa")]);
    expect(envelope(result)).toEqual({
      blocks: [
        { type: "table", columns: ["order_count"], rows: [{ order_count: 42 }] },
        { type: "definition", sql: SQL, source_tables: ["orders"], filters: [], query_id: "q1-aa" },
      ],
      summary: "42 orders",
      verified: true,
    });
  });

  it("grounds a blocks answer through its definition blocks, and grounding again changes nothing", () => {
    const result = codex({ blocks: [
      { type: "table", columns: ["order_count"], rows: [[40]] },
      { type: "definition", sql: SQL, query_id: "q1-aa" },
    ] }, [observed(SQL, "q1-aa"), observed(SQL, "q2-aa", ["orders"], 7)]);
    const grounded = envelope(result);
    expect(grounded.verified).toBe(true);
    expect(grounded.blocks).toEqual([
      { type: "table", columns: ["order_count"], rows: [{ order_count: 42 }] },
      { type: "definition", sql: SQL, source_tables: ["orders"], filters: [], query_id: "q1-aa" },
    ]);
    expect(withHostVerification(result, grounded)).toEqual(grounded);
  });

  it("stays unverified when it cites nothing, a query not run, or a query that read no table", () => {
    expect(envelope(codex({ columns: ["order_count"], rows: [[42]], verified: true }, [observed(SQL, "q1-aa")])).verified).toBe(false);
    expect(envelope(codex({ columns: ["order_count"], rows: [[42]], definition: { sql: `${SQL} WHERE 1 = 1` } }, [observed(SQL, "q1-aa")])).verified).toBe(false);
    expect(envelope(codex({ columns: ["order_count"], rows: [[42]], definition: { query_id: "q9-aa", sql: SQL } }, [observed(SQL, "q1-aa")])).verified).toBe(false);
    expect(envelope(codex({ columns: ["order_count"], rows: [[42]], definition: { sql: SQL } }, [observed(SQL, "q1-aa", [])])).verified).toBe(false);
    expect(envelope(codex({ columns: ["order_count"], rows: [[42]], definition: { sql: SQL } }, [])).verified).toBe(false);
  });

  it("stays unverified when any citation fails or a chart / KPI cannot be rebuilt", () => {
    const other = "SELECT status FROM orders";
    expect(envelope(codex({ blocks: [
      { type: "definition", sql: SQL }, { type: "definition", sql: other },
    ] }, [observed(SQL, "q1-aa")])).verified).toBe(false);
    const dashboard = codex({ blocks: [
      { type: "kpi_card", label: "order_count", value: 42 },
      { type: "definition", sql: SQL },
    ] }, [observed(SQL, "q1-aa")]);
    expect(envelope(dashboard)).toEqual({ blocks: [
      { type: "kpi_card", label: "order_count", value: 42 },
      { type: "definition", sql: SQL },
    ], verified: false });
  });

  it("grounds the rows a truncated result shows and appends a host note to the model's summary, once", () => {
    const truncated: HostQueryObservation = { tool: "run_sql", input: { sql: SQL, limit: 1 },
      output: { columns: ["order_count"], rows: [{ order_count: 42 }], row_count: 1, truncated: true, definition: { sql: SQL, source_tables: ["orders"], filters: [] }, query_id: "q1-aa" } };
    const result = codex({ columns: ["order_count"], rows: [[42]], summary: "There are 42.", definition: { sql: SQL } }, [truncated]);
    const grounded = envelope(result);
    expect(grounded.verified).toBe(true);
    expect(grounded.summary).toBe(`There are 42.\n\n${truncationNote(1)}`);
    expect(withHostVerification(result, grounded)).toEqual(grounded);
    expect(envelope(codex({ columns: ["order_count"], rows: [[42]], definition: { sql: SQL } }, [observed(SQL, "q1-aa")])).summary).toBeUndefined();
  });

  it("keeps agent-sdk unverified whatever its text claims", () => {
    const result: RouteResult = { backend: "agent-sdk", warnings: [], finalText: JSON.stringify({ columns: ["order_count"], rows: [[42]], definition: { sql: SQL }, verified: true }) };
    expect(envelope(result).verified).toBe(false);
  });
});
