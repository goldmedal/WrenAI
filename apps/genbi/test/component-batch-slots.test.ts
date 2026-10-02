import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { runAiComponentStep } from "../harness/components/ai-step.js";
import { normalizeComponentEvidence } from "../harness/components/normalize.js";
import { ComponentRunner, type ComponentBinding, type ComponentEvidence, type ExecutionPlan, type RunnerHost, type StepRun } from "../harness/components/runner.js";
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
/** The tables a query reads, as the governed transport proves them in `definition.source_tables`. */
const tablesOf = (sql: string) => [...sql.matchAll(/\bFROM (\w+)/g)].map((match) => match[1]!);
const answered = (slot: "a" | "c") => ({ slot_id: slot, columns: ["n"], rows: [[ROWS[SQL[slot]]]], summary: `${slot} answered`, verified: true, definition: { sql: SQL[slot], source_tables: tablesOf(SQL[slot]), filters: [] } });

function plan(options: { repair?: boolean } = {}): ExecutionPlan {
  const tools = [{ name: "query", source: "native" }];
  return { identity: "batch-plan", entries: ["answer_batch"], components: { answer_batch: { id: "answer_batch",
    declaration: { required_capabilities: ["sql_execution:read_only"], effect: { render_blocks: [] }, guardrails: [{ name: "read_only_execution", locked: true }] },
    steps: [
      { name: "resolve_intent", tier: "cheap", prompt: "resolve", consumes: [], produces: "batch_intent", tools, calls: [] },
      { name: "generate_sql", tier: "strong", prompt: "generate", consumes: ["batch_intent"], produces: "batch_result", tools, calls: [] },
      ...(options.repair === false ? [] : [{ name: "repair_sql", tier: "strong", prompt: "repair", consumes: ["batch_result"], produces: "repaired_batch", tools, calls: [], repairOf: "generate_sql" }]),
    ] } } };
}
function host(strong: MockLanguageModelV4, extra: Readonly<Record<string, unknown>> = {}): { host: RunnerHost; executed: string[]; evidence: ComponentEvidence[] } {
  const executed: string[] = [];
  const evidence: ComponentEvidence[] = [];
  const cheap = new MockLanguageModelV4({ doGenerate: async () => text("one intent per slot") });
  const binding: ComponentBinding = {
    tools: [{ name: "query", source: "native", inputSchema: { type: "object", additionalProperties: false, required: ["sql"], properties: { sql: { type: "string" } } },
      async execute(input) {
        const sql = (input as { sql: string }).sql; executed.push(sql);
        if (!(sql in ROWS)) throw new GovernedWrenError("model_not_found");
        return { columns: ["n"], rows: [{ n: ROWS[sql] }], definition: { sql, source_tables: tablesOf(sql), filters: [] }, ...extra };
      } }],
    isCurrent: () => true, async close() {},
    async normalize(observed) { evidence.push(observed); return normalizeComponentEvidence(plan().components.answer_batch!, observed); },
  };
  return { executed, evidence, host: { async prepare() { return binding; }, async runStep(run) { return runAiComponentStep(run, run.tier === "cheap" ? cheap : strong); } } };
}
const slots = (["a", "b", "c"] as const).map((slot) => ({ slot_id: slot, expected_shape: "scalar", question: `question ${slot}` }));

describe("per-slot failure isolation in a batch-shaped child", () => {
  it("returns the failed slot as unanswerable and answers the other slots", async () => {
    const strong = new MockLanguageModelV4({ doGenerate: [query(SQL.a, "a"), query(SQL.b, "b"), query(SQL.c, "c"),
      text([answered("a"), { slot_id: "b", status: "unanswerable", reason: "model_not_found: revenue is a cube, not a model" }, answered("c")])] });
    const f = host(strong);
    const result = await new ComponentRunner(plan(), f.host).run("answer_batch", { request: "fill the report", input: { preamble: "FY2025", slots } });
    expect(result).toEqual({ status: "ok", output: { kind: "value", value: [
      { slot_id: "a", columns: ["n"], rows: [{ n: 1672 }], summary: "a answered", verified: true, definition: { sql: SQL.a, source_tables: tablesOf(SQL.a), filters: [] } },
      { slot_id: "b", status: "unanswerable", reason: "model_not_found: revenue is a cube, not a model" },
      { slot_id: "c", columns: ["n"], rows: [{ n: 100 }], summary: "c answered", verified: true, definition: { sql: SQL.c, source_tables: tablesOf(SQL.c), filters: [] } },
    ] }, provenance: { verified: true } });
    // The tool error reached the model as a bounded class, and no repair step ran.
    expect(JSON.stringify(strong.doGenerateCalls[2]!.prompt)).toContain("model_not_found");
    expect(strong.doGenerateCalls).toHaveLength(4);
    expect(f.executed).toEqual([SQL.a, SQL.b, SQL.c]);
  });
  it("a six-slot batch with one failed attempt per slot is answered, not cut off by the step's loop cap", async () => {
    const six = ["s1", "s2", "s3", "s4", "s5", "s6"];
    const good = (slot: string) => `SELECT COUNT(*) AS n FROM orders_${slot}`;
    for (const [index, slot] of six.entries()) ROWS[good(slot)] = index + 1;
    const turns = six.flatMap((slot) => [query(`SELECT COUNT(*) AS n FROM missing_${slot}`, `${slot}-1`), query(good(slot), `${slot}-2`)]);
    const final = six.map((slot) => ({ slot_id: slot, columns: ["n"], rows: [[0]], verified: true, definition: { sql: good(slot), source_tables: tablesOf(good(slot)), filters: [] } }));
    const strong = new MockLanguageModelV4({ doGenerate: [...turns, text(final)] });
    const f = host(strong);
    const prompts: string[] = [];
    const recording: RunnerHost = { ...f.host, async runStep(run, binding) { prompts.push(run.prompt); return f.host.runStep(run, binding); } };
    const questions = six.map((slot) => ({ slot_id: slot, expected_shape: "scalar", question: `question ${slot}` }));
    const result = await new ComponentRunner(plan(), recording).run("answer_batch", { request: "fill the report", input: { questions } });
    expect(result).toMatchObject({ status: "ok", output: { kind: "value", value: six.map((slot, index) => ({ slot_id: slot, rows: [{ n: index + 1 }], verified: true })) } });
    // generate_sql took twelve tool turns and the answer; repair_sql never ran.
    expect(prompts).toEqual(["resolve", "generate"]);
    expect(strong.doGenerateCalls).toHaveLength(13);
    expect(f.executed).toHaveLength(12);
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

/** The query ids on the tool results the model received, by tool call id, in prompt order. */
function receivedQueryIds(prompt: unknown): [string, unknown][] {
  const messages = prompt as { role: string; content: unknown }[];
  return messages.filter((message) => message.role === "tool")
    .flatMap((message) => message.content as { type: string; toolCallId: string; output: { value?: { query_id?: unknown } } }[])
    .filter((part) => part.type === "tool-result").map((part) => [part.toolCallId, part.output.value?.query_id]);
}

describe("executed queries are cited by the id the host attaches to each result", () => {
  it("the model receives q1, q2 in execution order, the evidence carries the same ids, and a terminal citing q2 is grounded on that query", async () => {
    const strong = new MockLanguageModelV4({ doGenerate: [query(SQL.a, "a"), query(SQL.c, "c"),
      text([{ slot_id: "a", summary: "a by sql", definition: { sql: SQL.a } }, { slot_id: "b", definition: { query_id: "q9" } }, { slot_id: "c", summary: "c by id", definition: { query_id: "q2" } }])] });
    const f = host(strong);
    const result = await new ComponentRunner(plan(), f.host).run("answer_batch", { request: "fill the report", input: { slots } });
    expect(receivedQueryIds(strong.doGenerateCalls[2]!.prompt)).toEqual([["a", "q1"], ["c", "q2"]]);
    expect(f.evidence[0]!.tools.map((call) => [(call.input as { sql: string }).sql, (call.output as { query_id?: unknown }).query_id])).toEqual([[SQL.a, "q1"], [SQL.c, "q2"]]);
    expect(result).toEqual({ status: "ok", output: { kind: "value", value: [
      { slot_id: "a", columns: ["n"], rows: [{ n: 1672 }], summary: "a by sql", verified: true, definition: { sql: SQL.a, source_tables: tablesOf(SQL.a), filters: [] } },
      { slot_id: "b", status: "unanswerable", reason: "no executed query backs this answer" },
      { slot_id: "c", columns: ["n"], rows: [{ n: 100 }], summary: "c by id", verified: true, definition: { sql: SQL.c, source_tables: tablesOf(SQL.c), filters: [] } },
    ] }, provenance: { verified: true } });
  });
  it("a tool result that already carries a query_id gets the host id, in evidence and at the model", async () => {
    const strong = new MockLanguageModelV4({ doGenerate: [query(SQL.a, "a"), text([{ slot_id: "a", definition: { query_id: "q1" } }])] });
    const f = host(strong, { query_id: "q9" });
    const result = await new ComponentRunner(plan(), f.host).run("answer_batch", { request: "fill the report", input: { slots } });
    expect(receivedQueryIds(strong.doGenerateCalls[1]!.prompt)).toEqual([["a", "q1"]]);
    expect(f.evidence[0]!.tools.map((call) => (call.output as { query_id?: unknown }).query_id)).toEqual(["q1"]);
    expect(result).toMatchObject({ status: "ok", output: { value: [{ slot_id: "a", rows: [{ n: 1672 }] }] } });
  });
  it("a failed query takes no id: ids count successful results only", async () => {
    const strong = new MockLanguageModelV4({ doGenerate: [query(SQL.b, "b"), query(SQL.c, "c"), text([{ slot_id: "c", definition: { query_id: "q1" } }])] });
    const f = host(strong);
    const result = await new ComponentRunner(plan(), f.host).run("answer_batch", { request: "fill the report", input: { slots } });
    expect(receivedQueryIds(strong.doGenerateCalls[2]!.prompt)).toEqual([["b", undefined], ["c", "q1"]]);
    expect(result).toMatchObject({ status: "ok", output: { value: [{ slot_id: "c", rows: [{ n: 100 }], definition: { sql: SQL.c } }] } });
  });
});

describe("an unparseable batch terminal", () => {
  // Unescaped quotes inside a quoted predicate, the shape a model breaks when it re-types filters.
  const broken = `[{"slot_id":"a","definition":{"query_id":"q1","filters":["status = "completed""]}}, {"slot_id":"c","summary":"c`;
  const repaired = [{ slot_id: "a", summary: "a repaired", definition: { query_id: "q1" } }, { slot_id: "b", status: "unanswerable", reason: "no revenue model" }, { slot_id: "c", summary: "c repaired", definition: { query_id: "q2" } }];
  function recording(f: ReturnType<typeof host>) {
    const runs: StepRun[] = [];
    return { runs, host: { ...f.host, async runStep(run, binding) { runs.push(run); return f.host.runStep(run, binding); } } as RunnerHost };
  }
  it("fails the step so the declared repair runs once, with the raw text and the parse error, and a repaired terminal is normalised", async () => {
    const strong = new MockLanguageModelV4({ doGenerate: [query(SQL.a, "a"), text(broken), query(SQL.c, "c"), text(repaired)] });
    const f = host(strong);
    const r = recording(f);
    const result = await new ComponentRunner(plan(), r.host).run("answer_batch", { request: "fill the report", input: { slots } });
    expect(r.runs.map((run) => run.prompt)).toEqual(["resolve", "generate", "repair"]);
    const consumed = r.runs[2]!.consumes["batch_result"] as { status: string; code: string; reason: string; text: string };
    expect(consumed).toEqual({ status: "error", code: "step_failed", reason: expect.stringMatching(/^terminal_unparseable: \S/), text: broken });
    // Ids keep counting across the invocation's steps, so the repair may cite the first step's queries.
    expect(receivedQueryIds(strong.doGenerateCalls[3]!.prompt)).toEqual([["c", "q2"]]);
    expect(result).toEqual({ status: "ok", output: { kind: "value", value: [
      { slot_id: "a", columns: ["n"], rows: [{ n: 1672 }], summary: "a repaired", verified: true, definition: { sql: SQL.a, source_tables: tablesOf(SQL.a), filters: [] } },
      { slot_id: "b", status: "unanswerable", reason: "no revenue model" },
      { slot_id: "c", columns: ["n"], rows: [{ n: 100 }], summary: "c repaired", verified: true, definition: { sql: SQL.c, source_tables: tablesOf(SQL.c), filters: [] } },
    ] }, provenance: { verified: true } });
  });
  it("a repair whose terminal still does not parse yields every declared slot unanswerable, not callee_failed", async () => {
    const strong = new MockLanguageModelV4({ doGenerate: [query(SQL.a, "a"), text(broken), text(`Here is the fix: ${broken}`)] });
    const f = host(strong);
    const r = recording(f);
    const result = await new ComponentRunner(plan(), r.host).run("answer_batch", { request: "fill the report", input: { slots } });
    expect(r.runs.map((run) => run.prompt)).toEqual(["resolve", "generate", "repair"]);
    expect(result).toEqual({ status: "ok", output: { kind: "value", value: ["a", "b", "c"].map((slot_id) => ({ slot_id, status: "unanswerable", reason: "terminal_unparseable" })) } });
    expect(strong.doGenerateCalls).toHaveLength(3);
  });
  it("with no repair step declared, the unparseable terminal yields every slot unanswerable directly", async () => {
    const strong = new MockLanguageModelV4({ doGenerate: [query(SQL.a, "a"), text("I ran the query; the total is 1672.")] });
    const f = host(strong);
    const r = recording(f);
    const result = await new ComponentRunner(plan({ repair: false }), r.host).run("answer_batch", { request: "fill the report", input: { slots } });
    expect(r.runs.map((run) => run.prompt)).toEqual(["resolve", "generate"]);
    expect(result).toMatchObject({ status: "ok", output: { kind: "value", value: [{ slot_id: "a", status: "unanswerable" }, { slot_id: "b", status: "unanswerable" }, { slot_id: "c", status: "unanswerable" }] } });
  });
  it("a request without slots keeps prose terminals: no repair, the last observation answers", async () => {
    const strong = new MockLanguageModelV4({ doGenerate: [query(SQL.a, "a"), text("The total is 1672.")] });
    const f = host(strong);
    const r = recording(f);
    const result = await new ComponentRunner(plan(), r.host).run("answer_batch", { request: "one question" });
    expect(r.runs.map((run) => run.prompt)).toEqual(["resolve", "generate"]);
    expect(result).toMatchObject({ status: "ok", output: { kind: "value", value: { rows: [{ n: 1672 }], definition: { sql: SQL.a } } } });
  });
});
