import type { LanguageModelV4CallOptions, LanguageModelV4GenerateResult, LanguageModelV4Usage } from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";
import { loadBundle } from "../harness/bundle/loader.js";
import { executeAgent } from "../harness/loop/index.js";
import { createDefaultProviderRegistry, MOCK_ADAPTER_ID, PI_AI_ADAPTER_ID } from "../harness/providers/index.js";
import type { TierBinding } from "../harness/providers/index.js";
import { resolveTools } from "../harness/tools/index.js";
import { mockWrenServerConfig } from "./mock-mcp-server.js";
import { fakePiGateway } from "./pi-ai-fake-gateway.js";
import { buildSyntheticBundle } from "./synthetic-bundle.js";

const EMPTY_USAGE: LanguageModelV4Usage = {
  inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: undefined, text: undefined, reasoning: undefined },
};

function textResult(text: string): LanguageModelV4GenerateResult {
  return {
    content: [{ type: "text", text }],
    finishReason: { unified: "stop", raw: "stop" },
    usage: EMPTY_USAGE,
    warnings: [],
  };
}

function toolCallResult(toolName: string, toolCallId: string, input: unknown): LanguageModelV4GenerateResult {
  return {
    // `LanguageModelV4ToolCall.input` is a stringified JSON payload (parsed
    // against the tool's inputSchema by the loop), not the raw object.
    content: [{ type: "tool-call", toolCallId, toolName, input: JSON.stringify(input) }],
    finishReason: { unified: "tool-calls", raw: "tool-calls" },
    usage: EMPTY_USAGE,
    warnings: [],
  };
}

describe("resolveTools -> executeAgent wiring (end-to-end)", () => {
  it("resolves mcp:sample/query against the hermetic mock MCP server and lets the tool loop call it for real", async () => {
    const bundle = loadBundle(
      buildSyntheticBundle({ tools: [{ name: "query", source: "mcp:sample/query" }] }),
    );
    const agent = bundle.agents[0]!;

    const resolved = await resolveTools(agent, { mcpServers: { sample: mockWrenServerConfig() } });
    try {
      const calls: LanguageModelV4CallOptions[] = [];
      const results = [
        toolCallResult("query", "call-1", { sql: "select * from customers" }),
        textResult("done — top customer is Acme"),
      ];
      let callIndex = 0;

      const registry = createDefaultProviderRegistry();
      const binding: TierBinding = {
        tiers: {
          cheap: {
            adapter: MOCK_ADAPTER_ID,
            config: {
              doGenerate: async (options: LanguageModelV4CallOptions) => {
                calls.push(options);
                const result = results[callIndex]!;
                callIndex += 1;
                return result;
              },
            },
          },
        },
      };

      const artifacts = await executeAgent(agent, {
        binding,
        registry,
        tools: resolved.tools,
        userInput: "who is our top customer?",
      });

      // Two model turns: the tool-call turn, then the finishing turn — and the
      // tool call in between actually reached the mock MCP server subprocess
      // (no LLM involved in producing the canned rows).
      expect(calls).toHaveLength(2);
      expect(artifacts.get("result")).toBe("done — top customer is Acme");
    } finally {
      await resolved.close();
    }
  });

  it("runs the same tool loop through the pi-ai adapter against a scripted gateway", async () => {
    const bundle = loadBundle(
      buildSyntheticBundle({ tools: [{ name: "query", source: "mcp:sample/query" }] }),
    );
    const agent = bundle.agents[0]!;

    const resolved = await resolveTools(agent, { mcpServers: { sample: mockWrenServerConfig() } });
    try {
      const gateway = fakePiGateway([
        { toolCall: { id: "call-1", name: "query", input: { sql: "select * from customers" } } },
        { text: "done — top customer is Acme" },
      ]);
      const binding: TierBinding = {
        tiers: {
          cheap: {
            adapter: PI_AI_ADAPTER_ID,
            config: { provider: "org-gateway", model: "org/model-a", baseUrl: "https://gateway.test/v1", apiKey: "fake-gateway-key", fetch: gateway.fetch },
          },
        },
      };

      const artifacts = await executeAgent(agent, {
        binding,
        registry: createDefaultProviderRegistry(),
        tools: resolved.tools,
        userInput: "who is our top customer?",
      });

      expect(gateway.requests).toHaveLength(2);
      expect(JSON.stringify(gateway.requests[0]!.body["tools"])).toContain("query");
      // The real tool result (rows from the mock MCP server) was sent back on the follow-up turn.
      const followUp = gateway.requests[1]!.body["messages"] as { role: string; tool_call_id?: string; content?: unknown }[];
      const toolMessage = followUp.find((message) => message.role === "tool");
      expect(toolMessage?.tool_call_id).toBe("call-1");
      expect(JSON.stringify(toolMessage?.content)).toContain("Acme");
      expect(artifacts.get("result")).toBe("done — top customer is Acme");
    } finally {
      await resolved.close();
    }
  });
});
