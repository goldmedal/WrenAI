import { Output, ToolLoopAgent, jsonSchema } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildTierBindingFromFlags } from "../harness/cli-args.js";
import { runAiComponentStep } from "../harness/components/ai-step.js";
import type { StepRun } from "../harness/components/runner.js";
import { describeZoneDryRun, formatZoneDryRun } from "../harness/components/zone-dry-run.js";
import {
  createDefaultProviderRegistry,
  OPENAI_ADAPTER_ID,
  parseDisclosurePolicy,
  parseTierBindingDocument,
  resolveTierModel,
  type TierBinding,
} from "../harness/providers/index.js";
import { loadReportPlan } from "./report-fixtures.js";

// Test-process only: never a real key, never written anywhere.
const FAKE_KEY = "fake-openai-key-for-tests";

interface Captured { readonly url: string; readonly authorization: string | null; readonly body: Record<string, unknown> }

const usage = { input_tokens: 11, output_tokens: 3 };
const functionCall = (name: string, args: unknown) => ({ id: "resp_call", created_at: 0, model: "gpt-test",
  output: [{ type: "function_call", id: "fc_1", call_id: "call_1", name, arguments: JSON.stringify(args), status: "completed" }], usage });
const message = (text: string) => ({ id: "resp_text", created_at: 0, model: "gpt-test",
  output: [{ type: "message", role: "assistant", id: "msg_1", content: [{ type: "output_text", text, annotations: [] }] }], usage });

/** A fake OpenAI Responses endpoint: replies from a script and records what the adapter sent. */
function fakeOpenAI(script: readonly unknown[]): Captured[] {
  const captured: Captured[] = [];
  let next = 0;
  vi.stubGlobal("fetch", (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    captured.push({ url: String(input), authorization: new Headers(init?.headers).get("authorization"), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
    const reply = script[next++];
    if (reply === undefined) throw new Error("fake OpenAI server: no scripted reply left");
    return new Response(JSON.stringify(reply), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch);
  return captured;
}

const planTier = (): TierBinding => ({ tiers: { "plan_report/strong": { adapter: OPENAI_ADAPTER_ID, config: { model: "gpt-test" }, zone: "public" } } });

function stepRun(tools: StepRun["tools"]): StepRun {
  return { tier: "strong", request: "Plan the report", input: {}, prompt: "Return the plan as JSON.", consumes: {}, children: [], signal: new AbortController().signal,
    tools, toolSchemas: { ask: { type: "object", additionalProperties: false, required: ["request"], properties: { request: { type: "string" } } } },
    toolDescriptions: { ask: "Ask the bound callee" } };
}

describe("openai adapter", () => {
  beforeEach(() => { vi.stubEnv("OPENAI_API_KEY", FAKE_KEY); });
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

  it("resolves a binding with no apiKey, taking the key from OPENAI_API_KEY at call time", async () => {
    const binding = planTier();
    const model = resolveTierModel(binding, "plan_report/strong", createDefaultProviderRegistry());
    expect(typeof model === "object" && model.provider).toMatch(/^openai/);
    expect(typeof model === "object" && model.modelId).toBe("gpt-test");
    const captured = fakeOpenAI([message("ok")]);
    await new ToolLoopAgent({ model }).generate({ prompt: "hi" });
    expect(captured[0]!.url).toBe("https://api.openai.com/v1/responses");
    expect(captured[0]!.authorization).toBe(`Bearer ${FAKE_KEY}`);
    expect(JSON.stringify(binding)).not.toContain(FAKE_KEY);
  });

  it("binds from --tier-adapter and from a tier-binding file without a key in either", () => {
    const fromFlags = buildTierBindingFromFlags(["plan_report/strong=api-key:adapter=openai,model=gpt-test,zone=public"]);
    expect(fromFlags).toEqual({ "plan_report/strong": { adapter: "openai", config: { model: "gpt-test" }, zone: "public" } });
    const fromFile = parseTierBindingDocument({ tiers: { "plan_report/cheap": { adapter: "openai", config: { model: "gpt-test-mini" }, zone: "public" } } });
    expect(fromFile.tiers["plan_report/cheap"]).toEqual({ adapter: "openai", config: { model: "gpt-test-mini" }, zone: "public" });
    expect(JSON.stringify({ fromFlags, fromFile })).not.toContain(FAKE_KEY);
  });

  it("runs a component step's ToolLoopAgent through one tool call and a JSON answer", async () => {
    const captured = fakeOpenAI([functionCall("ask", { request: "total revenue" }), message(JSON.stringify({ title: "Annual revenue", slots: ["total_revenue"] }))]);
    const asked: unknown[] = [];
    const model = resolveTierModel(planTier(), "plan_report/strong", createDefaultProviderRegistry());
    const result = await runAiComponentStep(stepRun({ ask: async (input) => { asked.push(input); return { status: "ok", value: 42 }; } }), model);
    expect(asked).toEqual([{ request: "total revenue" }]);
    expect(result.failed).toBe(false);
    expect(JSON.parse(result.value as string)).toEqual({ title: "Annual revenue", slots: ["total_revenue"] });
    expect(result.usage).toEqual({ inputTokens: 22, outputTokens: 6 });
    // The tool was offered as a function, and its result went back to the model on the second turn.
    expect(captured).toHaveLength(2);
    expect(captured[0]!.body["tools"]).toEqual([expect.objectContaining({ type: "function", name: "ask" })]);
    expect(JSON.stringify(captured[1]!.body["input"])).toContain("function_call_output");
    expect(JSON.stringify(captured[1]!.body["input"])).toContain("42");
    for (const request of captured) expect(JSON.stringify(request.body)).not.toContain(FAKE_KEY);
  });

  it("returns SDK structured output from a ToolLoopAgent as a validated JSON object", async () => {
    const captured = fakeOpenAI([message(JSON.stringify({ verdict: "pass", reason_category: "aggregate" }))]);
    const model = resolveTierModel(planTier(), "plan_report/strong", createDefaultProviderRegistry());
    const schema = jsonSchema<{ verdict: string; reason_category: string }>({ type: "object", additionalProperties: false,
      required: ["verdict", "reason_category"], properties: { verdict: { type: "string" }, reason_category: { type: "string" } } });
    const result = await new ToolLoopAgent({ model, output: Output.object({ schema }) }).generate({ prompt: "Judge this release" });
    expect(result.output).toEqual({ verdict: "pass", reason_category: "aggregate" });
    expect(captured[0]!.body["text"]).toMatchObject({ format: { type: "json_schema", strict: true } });
  });
});

describe("zone dry-run of the genbi-report profile with public tiers on openai", () => {
  const nemotron = { adapter: "openai-compatible", zone: "private" as const,
    config: { baseURL: "https://nim.internal:8443/v1", model: "nvidia/nemotron-3-super", extraBody: { chat_template_kwargs: { enable_thinking: false } } } };
  beforeEach(() => { vi.stubEnv("OPENAI_API_KEY", FAKE_KEY); vi.stubGlobal("fetch", () => { throw new Error("network access during dry-run"); }); });
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

  it("prints each tier's adapter, model and zone, arms the gate, and never shows the key", async () => {
    const { plan } = await loadReportPlan();
    const binding: TierBinding = { tiers: {
      "plan_report/strong": { adapter: "openai", config: { model: "gpt-test" }, zone: "public" },
      "plan_report/cheap": { adapter: "openai", config: { model: "gpt-test-mini" }, zone: "public" },
      "answer_batch/strong": nemotron, "answer_batch/cheap": nemotron, judge: nemotron, render: nemotron,
    }, disclosurePolicy: parseDisclosurePolicy({ max_rows: 50, min_group_size: 1 }), roles: { judge: "judge", render: "render" } };
    const dryRun = describeZoneDryRun(plan, "plan_report", binding);
    const text = formatZoneDryRun(dryRun);
    expect(dryRun.exitCode).toBe(0);
    expect(text).toContain("result: ok");
    expect(text).toMatch(/plan_report\.plan_layout {2}role=caller {2}tier=strong {2}key=plan_report\/strong {2}zone=public .* openai model=gpt-test host=api\.openai\.com \(adapter default\) thinking=unset/);
    expect(text).toMatch(/plan_report\.narrate .*key=plan_report\/cheap {2}zone=public .* openai model=gpt-test-mini host=api\.openai\.com/);
    expect(text).toMatch(/answer_batch\.generate_sql .*key=answer_batch\/strong {2}zone=private .* openai-compatible model=nvidia\/nemotron-3-super host=nim\.internal:8443 thinking=off/);
    expect(text).toContain("judge  key=judge  zone=private  openai-compatible");
    expect(`${text}${JSON.stringify(dryRun)}`).not.toContain(FAKE_KEY);
  });
});
