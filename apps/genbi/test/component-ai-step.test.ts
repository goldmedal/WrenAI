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
});
