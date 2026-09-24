import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { runAiComponentStep } from "../harness/components/ai-step.js";
import { normalizeComponentEvidence } from "../harness/components/normalize.js";
import { ComponentRunner, type ComponentBinding, type ExecutionPlan, type RunnerHost } from "../harness/components/runner.js";
import { GovernedWrenError } from "../harness/components/wren-access.js";

/**
 * Per-slot failure isolation, end to end through the real runner, the real AI SDK step and
 * the real normalizer; only the model and the database are synthetic. The plan has the
 * batch-shaped callee's three steps (resolve → generate → conditional repair), and the
 * database rejects one slot's query the way the governed transport reports it.
 */
const usage = { inputTokens: { total: 2, noCache: 2, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
const text = (value: unknown) => ({ content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value) }], finishReason: { unified: "stop" as const, raw: "stop" }, usage, warnings: [] });
const query = (sql: string, id: string) => ({ content: [{ type: "tool-call" as const, toolName: "query", toolCallId: id, input: JSON.stringify({ sql }) }], finishReason: { unified: "tool-calls" as const, raw: "tool-calls" }, usage, warnings: [] });
const SQL = { a: "SELECT SUM(amount) AS n FROM orders", b: "SELECT total_revenue FROM revenue", c: "SELECT COUNT(*) AS n FROM customers" };
const ROWS: Record<string, number> = { [SQL.a]: 1672, [SQL.c]: 100 };
const answered = (slot: "a" | "c") => ({ slot_id: slot, columns: ["n"], rows: [[ROWS[SQL[slot]]]], summary: `${slot} answered`, verified: true, definition: { sql: SQL[slot], source_tables: [], filters: [] } });

function plan(): ExecutionPlan {
  const tools = [{ name: "query", source: "native" }];
  return { identity: "batch-plan", entries: ["answer_batch"], components: { answer_batch: { id: "answer_batch",
    declaration: { required_capabilities: ["sql_execution:read_only"], effect: { render_blocks: [] }, guardrails: [{ name: "read_only_execution", locked: true }] },
    steps: [
      { name: "resolve_intent", tier: "cheap", prompt: "resolve", consumes: [], produces: "batch_intent", tools, calls: [] },
      { name: "generate_sql", tier: "strong", prompt: "generate", consumes: ["batch_intent"], produces: "batch_result", tools, calls: [] },
      { name: "repair_sql", tier: "strong", prompt: "repair", consumes: ["batch_result"], produces: "repaired_batch", tools, calls: [], repairOf: "generate_sql" },
    ] } } };
}
function host(strong: MockLanguageModelV4): { host: RunnerHost; executed: string[] } {
  const executed: string[] = [];
  const cheap = new MockLanguageModelV4({ doGenerate: async () => text("one intent per slot") });
  const binding: ComponentBinding = {
    tools: [{ name: "query", source: "native", inputSchema: { type: "object", additionalProperties: false, required: ["sql"], properties: { sql: { type: "string" } } },
      async execute(input) {
        const sql = (input as { sql: string }).sql; executed.push(sql);
        if (!(sql in ROWS)) throw new GovernedWrenError("model_not_found");
        return { columns: ["n"], rows: [{ n: ROWS[sql] }], definition: { sql, source_tables: [], filters: [] } };
      } }],
    isCurrent: () => true, async close() {},
    async normalize(evidence) { return normalizeComponentEvidence(plan().components.answer_batch!, evidence); },
  };
  return { executed, host: { async prepare() { return binding; }, async runStep(run) { return runAiComponentStep(run, run.tier === "cheap" ? cheap : strong); } } };
}
const slots = (["a", "b", "c"] as const).map((slot) => ({ slot_id: slot, expected_shape: "scalar", question: `question ${slot}` }));

describe("per-slot failure isolation in a batch-shaped child", () => {
  it("returns the failed slot as unanswerable and answers the other slots", async () => {
    const strong = new MockLanguageModelV4({ doGenerate: [query(SQL.a, "a"), query(SQL.b, "b"), query(SQL.c, "c"),
      text([answered("a"), { slot_id: "b", status: "unanswerable", reason: "model_not_found: revenue is a cube, not a model" }, answered("c")])] });
    const f = host(strong);
    const result = await new ComponentRunner(plan(), f.host).run("answer_batch", { request: "fill the report", input: { preamble: "FY2025", slots } });
    expect(result).toEqual({ status: "ok", output: { kind: "value", value: [
      { slot_id: "a", columns: ["n"], rows: [{ n: 1672 }], summary: "a answered", verified: true, definition: { sql: SQL.a, source_tables: [], filters: [] } },
      { slot_id: "b", status: "unanswerable", reason: "model_not_found: revenue is a cube, not a model" },
      { slot_id: "c", columns: ["n"], rows: [{ n: 100 }], summary: "c answered", verified: true, definition: { sql: SQL.c, source_tables: [], filters: [] } },
    ] }, provenance: { verified: true } });
    // The tool error reached the model as a bounded class, and no repair step ran.
    expect(JSON.stringify(strong.doGenerateCalls[2]!.prompt)).toContain("model_not_found");
    expect(strong.doGenerateCalls).toHaveLength(4);
    expect(f.executed).toEqual([SQL.a, SQL.b, SQL.c]);
  });
  it("keeps the single-answer rule for a request without slots: an unrepaired tool error is callee_failed", async () => {
    const strong = new MockLanguageModelV4({ doGenerate: [query(SQL.b, "b1"), text("gave up"), query(SQL.b, "b2"), text("still nothing")] });
    const f = host(strong);
    const result = await new ComponentRunner(plan(), f.host).run("answer_batch", { request: "one question" });
    expect(result).toMatchObject({ status: "error", code: "callee_failed" });
    // generate_sql failed on the tool error, repair_sql ran and failed the same way.
    expect(strong.doGenerateCalls).toHaveLength(4);
    expect(f.executed).toEqual([SQL.b, SQL.b]);
  });
  it("a single-answer request whose repair recovers is answered from the observed table", async () => {
    const strong = new MockLanguageModelV4({ doGenerate: [query(SQL.b, "b1"), text("gave up"), query(SQL.a, "a"),
      text({ columns: ["n"], rows: [[0]], verified: true, definition: { sql: SQL.a } })] });
    const result = await new ComponentRunner(plan(), host(strong).host).run("answer_batch", { request: "one question" });
    expect(result).toMatchObject({ status: "ok", output: { kind: "value", value: { rows: [{ n: 1672 }], verified: true, definition: { sql: SQL.a } } } });
  });
  it("a malformed slot declaration does not buy per-slot leniency", async () => {
    const strong = new MockLanguageModelV4({ doGenerate: [query(SQL.b, "b1"), text("gave up"), query(SQL.b, "b2"), text("still nothing")] });
    const result = await new ComponentRunner(plan(), host(strong).host).run("answer_batch", { request: "batch", input: { slots: [{ slot_id: "a" }] } });
    expect(result).toMatchObject({ status: "error", code: "callee_failed" });
  });
});
