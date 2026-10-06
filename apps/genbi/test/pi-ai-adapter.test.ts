import type { LanguageModelV4, LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { generateText, jsonSchema, Output, ToolLoopAgent, tool } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDefaultProviderRegistry,
  createPiAiAdapter,
  PI_AI_ADAPTER_ID,
  resolveTierModel,
  type PiAiAdapterConfig,
  type TierBinding,
} from "../harness/providers/index.js";
import { fakePiGateway } from "./pi-ai-fake-gateway.js";

// Test-process only: never a real key, never written anywhere.
const FAKE_KEY = "fake-gateway-key-for-tests";
const BASE_URL = "https://gateway.test/v1";

function customEndpoint(gateway: ReturnType<typeof fakePiGateway>, extra: Partial<PiAiAdapterConfig> = {}): PiAiAdapterConfig {
  return { provider: "org-gateway", model: "org/model-a", baseUrl: BASE_URL, apiKey: FAKE_KEY, fetch: gateway.fetch, ...extra };
}

async function collect(stream: ReadableStream<LanguageModelV4StreamPart>): Promise<LanguageModelV4StreamPart[]> {
  const parts: LanguageModelV4StreamPart[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return parts;
    parts.push(value);
  }
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("pi-ai adapter", () => {
  it("is registered in the default registry and realizes an AI SDK v4 language model", () => {
    const registry = createDefaultProviderRegistry();
    expect(registry.has(PI_AI_ADAPTER_ID)).toBe(true);
    const binding: TierBinding = { tiers: { strong: { adapter: PI_AI_ADAPTER_ID, config: { provider: "groq", model: "llama-3.1-8b-instant" } } } };
    const model = resolveTierModel(binding, "strong", registry) as LanguageModelV4;
    expect(model.specificationVersion).toBe("v4");
    expect(model.provider).toBe("pi-ai.groq");
    expect(model.modelId).toBe("llama-3.1-8b-instant");
  });

  it("loud-fails at construction when provider or model is missing", () => {
    expect(() => createPiAiAdapter({ provider: "", model: "m" })).toThrow(/provider/);
    expect(() => createPiAiAdapter({ provider: "groq", model: " " })).toThrow(/model/);
  });

  it("sends a text turn to a custom endpoint with the explicit key and returns text, usage and cost metadata", async () => {
    const gateway = fakePiGateway([{ text: "hello from the gateway" }]);
    const model = createPiAiAdapter(customEndpoint(gateway, { headers: { "x-org-tenant": "acme" } }));
    const result = await generateText({ model, system: "be terse", prompt: "hi", maxOutputTokens: 64 });

    expect(result.text).toBe("hello from the gateway");
    expect(result.finishReason).toBe("stop");
    expect(result.usage.inputTokens).toBe(11);
    expect(result.usage.outputTokens).toBe(3);
    expect(result.providerMetadata?.["pi-ai"]).toMatchObject({ cost: { total: 0 } });

    expect(gateway.requests).toHaveLength(1);
    const request = gateway.requests[0]!;
    expect(request.url).toBe(`${BASE_URL}/chat/completions`);
    expect(request.headers.get("authorization")).toBe(`Bearer ${FAKE_KEY}`);
    expect(request.headers.get("x-org-tenant")).toBe("acme");
    expect(request.body["model"]).toBe("org/model-a");
    expect(JSON.stringify(request.body["messages"])).toContain("be terse");
    expect(JSON.stringify(request.body)).not.toContain(FAKE_KEY);
  });

  it("round-trips a tool call: the tool runs with the parsed input and its result goes back on the next turn", async () => {
    const gateway = fakePiGateway([
      { toolCall: { id: "call_1", name: "lookup", input: { city: "Taipei", days: 3 } } },
      { text: "It will be sunny." },
    ]);
    const seen: unknown[] = [];
    const agent = new ToolLoopAgent({
      model: createPiAiAdapter(customEndpoint(gateway)),
      tools: {
        lookup: tool({
          description: "Look up a forecast",
          inputSchema: jsonSchema<{ city: string; days: number }>({
            type: "object",
            additionalProperties: false,
            required: ["city", "days"],
            properties: { city: { type: "string" }, days: { type: "integer" } },
          }),
          execute: async (input) => {
            seen.push(input);
            return { forecast: "sunny" };
          },
        }),
      },
    });
    const result = await agent.generate({ prompt: "weather?" });

    expect(seen).toEqual([{ city: "Taipei", days: 3 }]);
    expect(result.text).toBe("It will be sunny.");
    expect(gateway.requests).toHaveLength(2);
    const offered = gateway.requests[0]!.body["tools"] as { function: { name: string; parameters: unknown } }[];
    expect(offered[0]!.function.name).toBe("lookup");
    expect(offered[0]!.function.parameters).toMatchObject({ required: ["city", "days"] });
    const followUp = JSON.stringify(gateway.requests[1]!.body["messages"]);
    expect(followUp).toContain("call_1");
    expect(followUp).toContain("sunny");
  });

  it("maps the pi-ai event stream onto v4 stream parts, tool input and tool call included", async () => {
    const gateway = fakePiGateway([{ toolCall: { id: "call_9", name: "lookup", input: { city: "Taipei" } } }]);
    const model = createPiAiAdapter(customEndpoint(gateway));
    const { stream } = await model.doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "weather?" }] }],
      tools: [{ type: "function", name: "lookup", inputSchema: { type: "object", properties: { city: { type: "string" } } } }],
    });
    const parts = await collect(stream);
    const types = parts.map((part) => part.type);

    expect(types[0]).toBe("stream-start");
    expect(types).toEqual(expect.arrayContaining(["tool-input-start", "tool-input-delta", "tool-input-end", "tool-call", "finish"]));
    expect(types.indexOf("tool-input-start")).toBeLessThan(types.indexOf("tool-input-end"));
    expect(types.indexOf("tool-input-end")).toBeLessThan(types.indexOf("tool-call"));
    const call = parts.find((part) => part.type === "tool-call");
    expect(call).toMatchObject({ toolCallId: "call_9", toolName: "lookup" });
    expect(JSON.parse((call as { input: string }).input)).toEqual({ city: "Taipei" });
    const deltas = parts.filter((part) => part.type === "tool-input-delta").map((part) => (part as { delta: string }).delta).join("");
    expect(JSON.parse(deltas)).toEqual({ city: "Taipei" });
    const finish = parts.find((part) => part.type === "finish");
    expect(finish).toMatchObject({ finishReason: { unified: "tool-calls", raw: "toolUse" }, usage: { inputTokens: { total: 11 } } });
  });

  it("asks for JSON through the system prompt when the caller requests structured output", async () => {
    const gateway = fakePiGateway([{ text: JSON.stringify({ verdict: "pass" }) }]);
    const schema = jsonSchema<{ verdict: string }>({ type: "object", required: ["verdict"], properties: { verdict: { type: "string" } } });
    const result = await new ToolLoopAgent({ model: createPiAiAdapter(customEndpoint(gateway)), output: Output.object({ schema }) }).generate({ prompt: "judge" });
    expect(result.output).toEqual({ verdict: "pass" });
    expect(JSON.stringify(gateway.requests[0]!.body["messages"])).toContain("JSON schema");
  });

  it("calls a built-in provider's catalogued endpoint with only the per-request key", async () => {
    const gateway = fakePiGateway([{ text: "ok" }]);
    const model = createPiAiAdapter({ provider: "groq", model: "llama-3.1-8b-instant", apiKey: FAKE_KEY, fetch: gateway.fetch });
    await generateText({ model, prompt: "hi" });
    expect(gateway.requests[0]!.url).toBe("https://api.groq.com/openai/v1/chat/completions");
    expect(gateway.requests[0]!.headers.get("authorization")).toBe(`Bearer ${FAKE_KEY}`);
  });

  it("never falls back to the provider's environment variable when no key is configured", async () => {
    const envKey = "env-key-that-must-not-be-used";
    vi.stubEnv("GROQ_API_KEY", envKey);
    const gateway = fakePiGateway([{ text: "ok" }]);
    const model = createPiAiAdapter({ provider: "groq", model: "llama-3.1-8b-instant", fetch: gateway.fetch });
    await expect(generateText({ model, prompt: "hi", maxRetries: 0 })).rejects.toThrow(/Provider is not configured: groq/);
    expect(gateway.requests).toHaveLength(0);
    for (const request of gateway.requests) {
      expect(request.headers.get("authorization") ?? "").not.toContain(envKey);
    }
  });

  it("refuses OAuth-only providers, unknown providers and uncatalogued models", async () => {
    await expect(generateText({ model: createPiAiAdapter({ provider: "openai-codex", model: "gpt-5.3-codex-spark" }), prompt: "hi" })).rejects.toThrow(/OAuth/);
    await expect(generateText({ model: createPiAiAdapter({ provider: "no-such-provider", model: "x" }), prompt: "hi" })).rejects.toThrow(/no built-in provider "no-such-provider"/);
    await expect(generateText({ model: createPiAiAdapter({ provider: "groq", model: "not-a-groq-model" }), prompt: "hi" })).rejects.toThrow(/no model "not-a-groq-model"/);
  });

  it("surfaces a provider error without echoing the key", async () => {
    const gateway = fakePiGateway([{ status: 401, error: `invalid key ${FAKE_KEY}` }], { repeatLast: true });
    const model = createPiAiAdapter(customEndpoint(gateway));
    const failure = await generateText({ model, prompt: "hi", maxRetries: 0 }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(Error);
    expect(String((failure as Error).message)).toMatch(/request failed/);
    expect(String((failure as Error).message)).not.toContain(FAKE_KEY);
  });
});

describe("pi-ai adapter lazy loading", () => {
  afterEach(() => {
    vi.doUnmock("@earendil-works/pi-ai");
    vi.resetModules();
  });

  it("builds the model without loading pi-ai, and names the optional dependency when it cannot be loaded", async () => {
    vi.resetModules();
    vi.doMock("@earendil-works/pi-ai", () => {
      throw new Error("Cannot find package '@earendil-works/pi-ai'");
    });
    const { createPiAiAdapter: create } = await import("../harness/providers/adapters/pi-ai.js");
    const model = create({ provider: "groq", model: "llama-3.1-8b-instant" });
    expect(model.modelId).toBe("llama-3.1-8b-instant");
    await expect(model.doGenerate({ prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }] })).rejects.toThrow(
      /optional dependency @earendil-works\/pi-ai.*Node\.js >= 22\.19/,
    );
  });
});
