import { generateText } from "ai";
import { describe, expect, it } from "vitest";
import { createOpenAICompatibleAdapter, mergeRequestBody } from "../harness/providers/index.js";

function completion(): Response {
  return new Response(JSON.stringify({ id: "chatcmpl-1", object: "chat.completion", created: 0, model: "nemotron",
    choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }), { status: 200, headers: { "content-type": "application/json" } });
}

async function capture(extraBody?: Record<string, unknown>): Promise<Record<string, unknown>> {
  const bodies: Record<string, unknown>[] = [];
  const fetchStub: typeof fetch = async (_input, init) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return completion();
  };
  const model = createOpenAICompatibleAdapter({ baseURL: "http://nim.test/v1", model: "nemotron", fetch: fetchStub, ...(extraBody ? { extraBody } : {}) });
  await generateText({ model, prompt: "hi" });
  expect(bodies).toHaveLength(1);
  return bodies[0]!;
}

describe("openai-compatible adapter extra request body", () => {
  it("forwards the configured extra fields on the serialized request body", async () => {
    const body = await capture({ chat_template_kwargs: { enable_thinking: true } });
    expect(body["model"]).toBe("nemotron");
    expect(body["chat_template_kwargs"]).toEqual({ enable_thinking: true });
    expect(Array.isArray(body["messages"])).toBe(true);
  });
  it("sends no such field when extraBody is omitted", async () => {
    const body = await capture();
    expect(body).not.toHaveProperty("chat_template_kwargs");
    expect(body["model"]).toBe("nemotron");
  });
  it("merges nested objects and lets the operator override an SDK-set key", () => {
    expect(mergeRequestBody({ model: "a", chat_template_kwargs: { x: 1 } }, { chat_template_kwargs: { enable_thinking: false }, temperature: 0 }))
      .toEqual({ model: "a", chat_template_kwargs: { x: 1, enable_thinking: false }, temperature: 0 });
    expect(mergeRequestBody({ stop: ["a"] }, { stop: ["b"] })).toEqual({ stop: ["b"] });
  });
});
