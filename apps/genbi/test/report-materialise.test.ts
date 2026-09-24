import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ComponentInvocationResult } from "@warble/claude-agent-sdk";
import { verifyEgress } from "../harness/components/egress.js";
import { buildSlotTable, isReportComponent, materialiseReportPlan, normalizeReportEvidence, parseReportPlan, readNarratorText, synthesiseReport } from "../harness/components/report.js";
import type { ComponentPlan } from "../harness/components/runner.js";
import { parseDisclosurePolicy } from "../harness/providers/index.js";

/**
 * Warble's public conformance fixture for the Hub report pair (Apache-2.0,
 * `dispatcher/conformance-fixtures/report-composition.json` at v0.15.0):
 * the layout, the batched call, the callee's answers and the narrator's
 * report, all pinned. This suite drives the host's materialisation and
 * synthesis with it, so the contract the harness implements is the one the
 * compiler and both dispatchers assert.
 */
const fixture = JSON.parse(readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "report-composition.json"), "utf8")) as {
  report_plan: unknown; batch_request: { request: string; input: Record<string, unknown> }; batch_answers: unknown[]; materialised_plan: { blocks: Record<string, unknown>[] }; report: { blocks: Record<string, unknown>[]; summary: string };
};
const policy = parseDisclosurePolicy({ max_rows: 50, min_group_size: 1, sensitive_column_patterns: [] });
/** The fixture's post-processing refuses `largest_orders` (order-level rows with customer names): the judge plays that role here. */
const judge = async (input: { untrusted_question: string }) => JSON.stringify(input.untrusted_question.includes("individual orders") ? { verdict: "refuse", reason_category: "individual_level_data" } : { verdict: "pass" });
const ok = (value: unknown): ComponentInvocationResult => ({ status: "ok", output: { kind: "value", value } });

async function disclosed() {
  const outcome = await verifyEgress(fixture.batch_request, ok(fixture.batch_answers), { policy, judge });
  return { children: [outcome.disclosed], provenance: outcome.provenance, decisions: outcome.decisions };
}

describe("report materialisation from the slot table", () => {
  it("fills every layout block from the disclosed answers and marks refused or unanswerable cells unavailable with their category", async () => {
    const plan = parseReportPlan(fixture.report_plan)!;
    expect(plan.blocks.map((block) => block.slot_id)).toEqual(["total_revenue", "refund_rate", "revenue_by_quarter", "top_customers", "largest_orders", "growth_story"]);
    const { children, provenance, decisions } = await disclosed();
    expect(decisions.map((decision) => [decision.slot_id, decision.status, decision.reason_category])).toEqual([
      ["total_revenue", "ok", undefined], ["revenue_by_quarter", "ok", undefined], ["top_customers", "ok", undefined], ["growth_story", "ok", undefined],
      ["largest_orders", "refused", "judge_refused"], ["refund_rate", "refused", "unanswerable"]]);
    const view = materialiseReportPlan(plan, buildSlotTable(children, provenance));
    // Every filled cell carries exactly the fixture's materialised value; unavailable cells carry the category.
    const expected = fixture.materialised_plan.blocks.filter((block) => block.type !== "definition");
    expect(view.blocks.map((block) => "status" in block ? { slot_id: block.slot_id, status: block.status } : { slot_id: block.slot_id, ...pick(block) }))
      .toEqual(expected.map((block) => block.status === "unavailable" ? { slot_id: block.slot_id, status: "unavailable" } : { slot_id: block.slot_id, ...pick(block) }));
    // The narrator's view carries no provenance: no definition block, no SQL.
    expect(JSON.stringify(view)).not.toMatch(/SELECT|definition|source_tables/);
    // The unavailable reasons are the egress categories, not the callee's reason text.
    expect(view.blocks.filter((block) => "status" in block)).toMatchObject([
      { slot_id: "refund_rate", reason_category: "unanswerable" }, { slot_id: "largest_orders", reason_category: "judge_refused" }]);
    expect(JSON.stringify(view)).not.toContain("defines no refund measure");
  });
  it("synthesises the report from the slot table plus the narrator's text only, and attaches provenance from the child run", async () => {
    const plan = parseReportPlan(fixture.report_plan)!;
    const { children, provenance } = await disclosed();
    const narrator = readNarratorText(fixture.report)!;
    const report = synthesiseReport(plan, buildSlotTable(children, provenance), narrator);
    expect(report.summary).toBe(fixture.report.summary);
    expect(report.verified).toBe(true);
    const dataBlocks = report.blocks.filter((block) => block.type !== "definition");
    expect(dataBlocks.map((block) => [block.type, block.slot_id])).toEqual([
      ["kpi_card", "total_revenue"], ["unavailable", "refund_rate"], ["chart", "revenue_by_quarter"], ["table", "top_customers"], ["unavailable", "largest_orders"], ["narrative", "growth_story"]]);
    // Narrator text is overlaid: notes, and the retitled table ("Top five customers"); the values are the fixture's.
    expect(dataBlocks[0]).toMatchObject({ value: 1284500, unit: "USD", note: "The year closed at 1,284,500 USD from completed orders." });
    expect(dataBlocks[3]).toMatchObject({ title: "Top five customers", columns: ["customer", "revenue"], rows: [["Northwind Traders", 96200], ["Blue Yonder Airlines", 88750], ["Contoso Ltd", 81400], ["Fabrikam Inc", 74900], ["Tailspin Toys", 69300]] });
    expect(dataBlocks[1]).toMatchObject({ type: "unavailable", block_type: "kpi_card", reason_category: "unanswerable", label: "Refund rate" });
    // One definition per filled slot, from the callee's own definitions (the narrator never saw them).
    const definitions = report.blocks.filter((block) => block.type === "definition");
    expect(definitions.map((block) => block.slot_id)).toEqual(["total_revenue", "revenue_by_quarter", "top_customers", "growth_story"]);
    expect(definitions[0]).toMatchObject({ sql: expect.stringContaining("SELECT SUM(total_revenue)"), source_tables: ["orders", "payments"], filters: ["status = 'completed'", "fiscal year 2025"] });
  });
  it("mutation: a value the narrator retyped never reaches the report", async () => {
    const plan = parseReportPlan(fixture.report_plan)!;
    const { children, provenance } = await disclosed();
    const mutated = structuredClone(fixture.report);
    mutated.blocks[0]!.value = 999;
    (mutated.blocks[2] as { rows: unknown[] }).rows = [["2025-Q1", 1]];
    mutated.blocks.push({ type: "kpi_card", label: "Invented", value: 42, slot_id: "invented" });
    mutated.blocks[1] = { ...mutated.blocks[1]!, type: "kpi_card", value: 0.07 };
    const report = synthesiseReport(plan, buildSlotTable(children, provenance), readNarratorText(mutated));
    const byslot = Object.fromEntries(report.blocks.filter((block) => block.type !== "definition").map((block) => [block.slot_id, block]));
    expect(byslot["total_revenue"]).toMatchObject({ value: 1284500 });
    expect(byslot["revenue_by_quarter"]).toMatchObject({ rows: [["2025-Q1", 290000], ["2025-Q2", 310500], ["2025-Q3", 322000], ["2025-Q4", 362000]] });
    expect(byslot["refund_rate"]).toMatchObject({ type: "unavailable" });
    expect(byslot["invented"]).toBeUndefined();
    expect(JSON.stringify(report.blocks)).not.toContain("999");
  });
  it("normalizeReportEvidence validates the synthesised envelope against the component's render contract", async () => {
    const { children, provenance } = await disclosed();
    const component: ComponentPlan = { id: "plan_report", declaration: { required_capabilities: ["component_invocation", "render_contract"], effect: { render_blocks: [
      { type: "kpi_card", fields: { label: "string", value: "number|string", unit: "string?", note: "string?", slot_id: "string?" } },
      { type: "table", fields: { title: "string?", columns: "string[]", rows: "row[]", note: "string?", slot_id: "string?" } },
      { type: "chart", fields: { title: "string?", chart_type: "bar|line|pie|area|scatter", x: "string", series: "string[]", rows: "row[]", note: "string?", slot_id: "string?" } },
      { type: "narrative", fields: { title: "string?", text: "string", slot_id: "string?" } },
      { type: "unavailable", fields: { label: "string", block_type: "kpi_card|table|chart|narrative", reason_category: "string", note: "string?", slot_id: "string?" } },
      { type: "definition", fields: { sql: "string", source_tables: "string[]", filters: "string[]" } },
    ] } }, steps: [
      { name: "plan_layout", tier: "strong", prompt: "", consumes: [], produces: "report_plan", tools: [], calls: [{ alias: "ask", component: "answer_batch" }] },
      { name: "narrate", tier: "cheap", prompt: "", consumes: ["report_plan"], produces: "report", tools: [], calls: [] },
    ] };
    expect(isReportComponent(component)).toBe(true);
    const result = normalizeReportEvidence(component, { steps: { report_plan: JSON.stringify(fixture.report_plan), report: JSON.stringify(fixture.report) }, tools: [], children, egress: provenance });
    expect(result.status).toBe("ok");
    if (result.status !== "ok" || result.output.kind !== "render") throw new Error("unreachable");
    expect(result.output.blocks).toHaveLength(6 + 4);
    expect(result.output.summary).toBe(fixture.report.summary);
    expect(result.provenance).toEqual({ verified: true });
    // Fail closed: no layout, or a narrator that produced no report.
    expect(normalizeReportEvidence(component, { steps: { report_plan: "not a layout", report: JSON.stringify(fixture.report) }, tools: [], children, egress: provenance })).toMatchObject({ status: "refused" });
    expect(normalizeReportEvidence(component, { steps: { report_plan: JSON.stringify(fixture.report_plan), report: "I could not write it" }, tools: [], children, egress: provenance })).toMatchObject({ status: "refused" });
  });
});

function pick(block: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of ["type", "value", "unit", "x", "series", "rows", "columns", "text"]) if (block[key] !== undefined) out[key] = block[key];
  return out;
}
