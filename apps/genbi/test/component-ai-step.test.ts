import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { runAiComponentStep } from "../harness/components/ai-step.js";
import { GovernedWrenError } from "../harness/components/wren-access.js";
import type { StepRun } from "../harness/components/runner.js";

const usage = { inputTokens: { total: 2, noCache: 2, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
const text = (value: string) => ({ content: [{ type: "text" as const, text: value }], finishReason: { unified: "stop" as const, raw: "stop" }, usage, warnings: [] });
const call = (name: string, id = "call") => ({ content: [{ type: "tool-call" as const, toolName: name, toolCallId: id, input: JSON.stringify({ request: "child" }) }], finishReason: { unified: "tool-calls" as const, raw: "tool-calls" }, usage, warnings: [] });
function run(): StepRun {
  return { tier: "strong", request: "root-only question", input: {}, prompt: "compose", consumes: {}, children: [], signal: new AbortController().signal,
    tools: { answer: async () => ({ status: "ok", output: { kind: "value", value: 7 } }) },
    toolSchemas: { answer: { type: "object", additionalProperties: false, required: ["request"], properties: { request: { type: "string" } } } }, toolDescriptions: { answer: "Bound answer" } };
}

describe("fresh AI SDK governed steps", () => {
  it("runs only the supplied alias and keeps the next step's history fresh", async () => {
    const model = new MockLanguageModelV4({ doGenerate: [call("answer"), text("first-completion"), text("second-completion")] });
    const result = await runAiComponentStep(run(), model);
    expect(result).toMatchObject({ value: "first-completion", failed: false, usage: { inputTokens: 4, outputTokens: 2 } });
    expect(model.doGenerateCalls[0]!.tools?.map((tool) => tool.type === "function" ? tool.name : tool.id)).toEqual(["answer"]);
    await runAiComponentStep({ ...run(), request: "fresh", tools: {}, toolSchemas: {}, consumes: { exact: "product" } }, model);
    expect(JSON.stringify(model.doGenerateCalls[2]!.prompt)).not.toContain("root-only question");
    expect(JSON.stringify(model.doGenerateCalls[2]!.prompt)).not.toContain("first-completion");
    expect(JSON.stringify(model.doGenerateCalls[2]!.prompt)).toContain("product");
  });
  it("does not turn an undeclared SQL tool into data access", async () => {
    const model = new MockLanguageModelV4({ doGenerate: [call("query"), text("forged result")] });
    const result = await runAiComponentStep(run(), model);
    expect(result.failed).toBe(true);
  });
  it("bounds a nonterminating model tool loop and refuses its partial result", async () => {
    let count = 0;
    const model = new MockLanguageModelV4({ doGenerate: async () => call("answer", `call-${count++}`) });
    const result = await runAiComponentStep(run(), model);
    expect(count).toBe(12); expect(result.failed).toBe(true);
  });
  it("passes cancellation into the model transport", async () => {
    const controller = new AbortController();
    const model = new MockLanguageModelV4({ doGenerate: async ({ abortSignal }) => {
      expect(abortSignal).toBeDefined(); controller.abort(); abortSignal!.throwIfAborted(); return text("late");
    } });
    await expect(runAiComponentStep({ ...run(), signal: controller.signal }, model)).rejects.toThrow();
  });
  it("shows the model the governed error class, and only the class", async () => {
    const model = new MockLanguageModelV4({ doGenerate: [call("answer"), text("recovered")] });
    const failing = { ...run(), tools: { answer: async () => { throw new GovernedWrenError("model_not_found"); } } };
    const result = await runAiComponentStep(failing, model);
    expect(result.failed).toBe(true);
    const shown = JSON.stringify(model.doGenerateCalls[1]!.prompt);
    expect(shown).toContain("model_not_found");
    expect(shown).toContain("not a model in the bound semantic context");
    expect(shown).not.toMatch(/\/Users|\/private|Traceback|password/);
  });
  it("treats a tool error as one slot's outcome in a per-slot run, and as a step failure otherwise", async () => {
    const script = () => new MockLanguageModelV4({ doGenerate: [call("answer", "a"), call("answer", "b"), text(JSON.stringify([{ slot_id: "a" }, { slot_id: "b", status: "unanswerable", reason: "model_not_found" }]))] });
    let calls = 0;
    const tools = { answer: async () => { calls++; if (calls % 2 === 0) throw new GovernedWrenError("policy_rejected"); return { ok: true }; } };
    const perSlot = await runAiComponentStep({ ...run(), tools, perSlot: true }, script());
    expect(perSlot.failed).toBe(false);
    expect(JSON.parse(perSlot.value as string)).toHaveLength(2);
    const single = await runAiComponentStep({ ...run(), tools }, script());
    expect(single.failed).toBe(true);
    // The loop itself not completing still fails a per-slot step.
    let count = 0;
    const runaway = new MockLanguageModelV4({ doGenerate: async () => call("answer", `call-${count++}`) });
    expect((await runAiComponentStep({ ...run(), perSlot: true }, runaway)).failed).toBe(true);
  });
  describe("a single-answer step that recovers from a tool error", () => {
    const SQL = "SELECT COUNT(*) AS n FROM orders";
    const queryCall = (sql: string, id: string) => ({ content: [{ type: "tool-call" as const, toolName: "query", toolCallId: id, input: JSON.stringify({ sql }) }], finishReason: { unified: "tool-calls" as const, raw: "tool-calls" }, usage, warnings: [] });
    const proven = (sources: string[]) => async (input: unknown) => {
      const sql = (input as { sql: string }).sql;
      if (sql.includes("missing")) throw new GovernedWrenError("model_not_found");
      return { columns: ["n"], rows: [{ n: 1 }], definition: { sql, source_tables: sources, filters: [] }, query_id: "q1" };
    };
    const withQuery = (execute: (input: unknown) => Promise<unknown>): StepRun => ({ ...run(), tools: { query: execute },
      toolSchemas: { query: { type: "object", additionalProperties: false, required: ["sql"], properties: { sql: { type: "string" } } } }, toolDescriptions: { query: "Run SQL" } });
    it("is not failed when a proven query result followed the error", async () => {
      const model = new MockLanguageModelV4({ doGenerate: [queryCall("SELECT 1 FROM missing", "bad"), queryCall(SQL, "good"), text("answered")] });
      const result = await runAiComponentStep(withQuery(proven(["orders"])), model);
      expect(result).toMatchObject({ value: "answered", failed: false });
    });
    it("is failed when the errors were never followed by a query that reads a table", async () => {
      const onlyErrors = new MockLanguageModelV4({ doGenerate: [queryCall("SELECT 1 FROM missing", "bad"), text("gave up")] });
      expect((await runAiComponentStep(withQuery(proven(["orders"])), onlyErrors)).failed).toBe(true);
      // A result whose definition reads no table is an unproven observation and never recovers the step.
      const unproven = new MockLanguageModelV4({ doGenerate: [queryCall("SELECT 1 FROM missing", "bad"), queryCall(SQL, "empty"), text("answered")] });
      expect((await runAiComponentStep(withQuery(proven([])), unproven)).failed).toBe(true);
      // A definition proven for other SQL than the one executed does not count either.
      const mismatched = new MockLanguageModelV4({ doGenerate: [queryCall("SELECT 1 FROM missing", "bad"), queryCall(SQL, "other"), text("answered")] });
      const other = withQuery(async (input) => ({ ...(await proven(["orders"])(input)) as object, definition: { sql: "SELECT 2", source_tables: ["orders"], filters: [] } }));
      expect((await runAiComponentStep(other, mismatched)).failed).toBe(true);
    });
    it("is still failed when the loop did not complete, whatever it observed", async () => {
      let count = 0;
      const runaway = new MockLanguageModelV4({ doGenerate: async () => queryCall(count++ === 0 ? "SELECT 1 FROM missing" : SQL, `call-${count}`) });
      const result = await runAiComponentStep(withQuery(proven(["orders"])), runaway);
      expect(count).toBe(12); expect(result.failed).toBe(true);
    });
  });
  it("sizes the loop cap to the batch: six slots with one retry each still reach the final answer", async () => {
    const questions = ["a", "b", "c", "d", "e", "f"].map((slot) => ({ slot_id: slot, expected_shape: "scalar", question: `question ${slot}` }));
    const turns = [...questions.flatMap(({ slot_id }) => [call("answer", `${slot_id}-1`), call("answer", `${slot_id}-2`)]), text("[]")];
    const batch = new MockLanguageModelV4({ doGenerate: turns });
    const result = await runAiComponentStep({ ...run(), input: { questions }, perSlot: true }, batch);
    expect(result).toMatchObject({ value: "[]", failed: false });
    expect(batch.doGenerateCalls).toHaveLength(13);
    // The cap is still a bound: 2 per slot plus 4 for these six slots, and a single-answer step keeps 12.
    let count = 0;
    const runaway = () => new MockLanguageModelV4({ doGenerate: async () => call("answer", `call-${count++}`) });
    expect((await runAiComponentStep({ ...run(), input: { questions }, perSlot: true }, runaway())).failed).toBe(true);
    expect(count).toBe(16);
    count = 0;
    expect((await runAiComponentStep({ ...run(), input: { questions } }, runaway())).failed).toBe(true);
    expect(count).toBe(12);
  });
});
