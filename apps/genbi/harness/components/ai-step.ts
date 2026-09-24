import { ToolLoopAgent, isStepCount, jsonSchema, tool, type LanguageModel, type ToolSet } from "ai";
import type { StepResponse, StepRun } from "./runner.js";

/** A fresh AI SDK loop for each host-owned step. No caller history or ambient tools. */
export async function runAiComponentStep(run: StepRun, model: LanguageModel): Promise<StepResponse> {
  const tools: ToolSet = {};
  for (const [name, execute] of Object.entries(run.tools)) {
    const inputSchema = run.toolSchemas[name];
    if (!inputSchema) throw new Error("Component tool has no closed input schema");
    tools[name] = tool({ description: run.toolDescriptions[name] ?? name,
      inputSchema: jsonSchema<Record<string, unknown>>(inputSchema),
      execute: async (input) => execute(input),
    });
  }
  const prompt = JSON.stringify({ request: run.request, input: run.input, consumes: run.consumes });
  const agent = new ToolLoopAgent({ model, tools, stopWhen: isStepCount(12),
    instructions: [run.brief, run.prompt].filter(Boolean).join("\n\n"),
  });
  const result = await agent.generate({ prompt, abortSignal: run.signal });
  const toolErrors = result.steps.some((step) => step.content.some((part) => part.type === "tool-error"));
  // A single-answer step fails on any tool error, so the declared repair step runs and an
  // unrepaired failure ends the child. In a per-slot invocation a tool error is one slot's
  // outcome (the model reports it as `{slot_id, status: "unanswerable"}` and answers the rest);
  // the step itself fails only when the loop did not complete. Normalization still grounds
  // every answered slot in an observed query, so the leniency cannot promote a claim to data.
  return {
    value: result.text,
    failed: result.finishReason !== "stop" || (!run.perSlot && toolErrors),
    usage: { inputTokens: result.totalUsage.inputTokens ?? 0, outputTokens: result.totalUsage.outputTokens ?? 0 },
  };
}
