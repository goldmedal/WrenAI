import { describe, expect, it } from "vitest";
import { canonicalUpstream, LocalPiProviderUnsupported, resolveLocalPiEndpoints, type LocalPiCatalog } from "../server/runtime-host/local-pi-endpoint.js";
import { readLocalPiStructuredResult } from "../server/local-pi-structured-ask.js";
import { gateDecisionStep, summarizeResult, toAnswerOrRefusalEvent } from "../server/fold.js";
import { StructuredRuntimeError } from "../server/structured-runtime.js";
import type { RuntimeSettings } from "../server/wire-types.js";

const base: RuntimeSettings = { authMode: "byo", apiKeyAdapter: "anthropic", tierModels: [{ tier: "cheap", model: "claude-cheap" }, { tier: "strong", model: "claude-strong" }], hybrid: false, deployment: "personal" };
const tiers = ["cheap", "strong"];
const catalog: LocalPiCatalog = async (provider, model) => (provider === "openrouter" && model === "m/one" ? { api: "openai-completions", baseUrl: "https://openrouter.ai/api/v1" }
  : provider === "amazon-bedrock" ? { api: "bedrock-converse-stream", baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com" } : provider === "anthropic" ? { api: "anthropic-messages", baseUrl: "https://api.anthropic.com" } : undefined);
const refused = async (settings: RuntimeSettings, over: LocalPiCatalog = catalog) => { const error = await resolveLocalPiEndpoints(settings, tiers, over).then(() => undefined, (reason: unknown) => reason); expect(error).toBeInstanceOf(LocalPiProviderUnsupported); expect((error as LocalPiProviderUnsupported).code).toBe("pi_provider_unsupported"); };

describe("local pi provider mapping", () => {
  it("anthropic maps to the anthropic wire, the vendor endpoint and ANTHROPIC_API_KEY", async () => {
    expect(await resolveLocalPiEndpoints(base, tiers)).toEqual({
      cheap: { api: "anthropic-messages", upstream: "https://api.anthropic.com", credentialEnv: "ANTHROPIC_API_KEY", model: "claude-cheap" },
      strong: { api: "anthropic-messages", upstream: "https://api.anthropic.com", credentialEnv: "ANTHROPIC_API_KEY", model: "claude-strong" } });
  });
  it("a stray base URL on a vendor adapter is ignored, as in-process", async () => {
    expect((await resolveLocalPiEndpoints({ ...base, apiKeyBaseURL: "https://evil.example/v1" }, tiers)).cheap!.upstream).toBe("https://api.anthropic.com");
  });
  it("openai-compatible needs its base URL and uses the chat-completions wire and OPENAI_API_KEY", async () => {
    const settings: RuntimeSettings = { ...base, apiKeyAdapter: "openai-compatible", apiKeyBaseURL: "https://llm.example.test/v1/", tierModels: [{ tier: "cheap", model: "a" }, { tier: "strong", model: "b" }] };
    expect((await resolveLocalPiEndpoints(settings, tiers)).strong).toEqual({ api: "openai-completions", upstream: "https://llm.example.test/v1", credentialEnv: "OPENAI_API_KEY", model: "b" });
    const { apiKeyBaseURL: _removed, ...withoutUrl } = settings; await refused(withoutUrl);
  });
  it("a tier override carries its own adapter and base URL", async () => {
    const settings: RuntimeSettings = { ...base, tierModels: [{ tier: "cheap", model: "a", adapter: "openai-compatible", baseURL: "http://127.0.0.1:9/v1" }, { tier: "strong", model: "b" }] };
    const mapped = await resolveLocalPiEndpoints(settings, tiers);
    expect(mapped.cheap).toMatchObject({ api: "openai-completions", upstream: "http://127.0.0.1:9/v1" }); expect(mapped.strong).toMatchObject({ api: "anthropic-messages" });
  });
  it("gateway: a base URL is the chat-completions wire; a built-in provider comes from the catalogue; GENBI_GATEWAY_API_KEY", async () => {
    const gateway: RuntimeSettings = { ...base, authMode: "gateway", gatewayProvider: "openrouter", tierModels: [{ tier: "cheap", model: "m/one" }, { tier: "strong", model: "m/one" }] };
    expect((await resolveLocalPiEndpoints(gateway, tiers, catalog)).cheap).toEqual({ api: "openai-completions", upstream: "https://openrouter.ai/api/v1", credentialEnv: "GENBI_GATEWAY_API_KEY", model: "m/one" });
    expect((await resolveLocalPiEndpoints({ ...gateway, gatewayBaseURL: "https://gw.example.test/api/v1" }, tiers, async () => undefined)).cheap).toMatchObject({ upstream: "https://gw.example.test/api/v1", api: "openai-completions" });
  });
  it.each([
    ["a SigV4-signed provider (Bedrock)", { ...base, authMode: "gateway", gatewayProvider: "amazon-bedrock", tierModels: [{ tier: "cheap", model: "m" }, { tier: "strong", model: "m" }] }],
    ["a provider the catalogue does not know", { ...base, authMode: "gateway", gatewayProvider: "nope", tierModels: [{ tier: "cheap", model: "m" }, { tier: "strong", model: "m" }] }],
    ["a gateway without a provider", { ...base, authMode: "gateway", tierModels: [{ tier: "cheap", model: "m" }, { tier: "strong", model: "m" }] }],
    ["hybrid", { ...base, hybrid: true }],
    ["a local-model row", { ...base, tierModels: [{ tier: "cheap", model: "a", adapter: "local", baseURL: "http://127.0.0.1:1/v1" }, { tier: "strong", model: "b" }] }],
    ["the subscription mode", { ...base, authMode: "subscription" }],
    ["a missing tier", { ...base, tierModels: [{ tier: "cheap", model: "a" }] }],
    ["an unknown tier", { ...base, tierModels: [...base.tierModels, { tier: "extra", model: "c" }] }],
    ["a duplicated tier", { ...base, tierModels: [{ tier: "cheap", model: "a" }, { tier: "cheap", model: "a" }] }],
    ["a model id pi cannot take", { ...base, tierModels: [{ tier: "cheap", model: "bad model" }, { tier: "strong", model: "b" }] }],
    ["no model", { ...base, tierModels: [{ tier: "cheap" }, { tier: "strong", model: "b" }] }],
    ["an upstream with credentials", { ...base, apiKeyAdapter: "openai-compatible", apiKeyBaseURL: "https://user:pw@x.example/v1", tierModels: [{ tier: "cheap", model: "a" }, { tier: "strong", model: "b" }] }],
    ["an upstream with a query", { ...base, apiKeyAdapter: "openai-compatible", apiKeyBaseURL: "https://x.example/v1?key=1", tierModels: [{ tier: "cheap", model: "a" }, { tier: "strong", model: "b" }] }],
    ["a non-http upstream", { ...base, apiKeyAdapter: "openai-compatible", apiKeyBaseURL: "file:///etc/passwd", tierModels: [{ tier: "cheap", model: "a" }, { tier: "strong", model: "b" }] }],
  ] as [string, RuntimeSettings][])("refuses %s as pi_provider_unsupported", async (_name, settings) => { await refused(settings); });
  it("canonicalises the upstream and refuses traversal", () => {
    expect(canonicalUpstream("https://A.example:443/v1//")).toBe("https://a.example/v1");
    expect(canonicalUpstream("https://x.example/a/../b")).toBe("https://x.example/b");
    expect(canonicalUpstream("https://x.example/%2e%2e/b")).toBe("https://x.example/b");
    for (const bad of ["https://x.example/a%2fb", "ftp://x.example", "not a url", "https://x.example/v1#frag"]) expect(() => canonicalUpstream(bad), bad).toThrow(LocalPiProviderUnsupported);
  });
});

describe("local pi result authority", () => {
  it("a result object nobody registered, or one altered after registration, is never read as an answer", () => {
    const forged = { backend: "pi-local" as const, warnings: [], envelope: { blocks: [], verified: true } };
    expect(() => readLocalPiStructuredResult(forged as never)).toThrow(StructuredRuntimeError);
  });
  it("folding refuses a pi-local result without the host's authority, for the answer, the gate and the summary alike", () => {
    const forged = { backend: "pi-local" as const, warnings: [], envelope: { blocks: [{ type: "table", columns: ["n"], rows: [{ n: 999999 }] }], verified: true } } as never;
    expect(() => toAnswerOrRefusalEvent("e", forged)).toThrow(StructuredRuntimeError);
    expect(() => gateDecisionStep(forged)).toThrow(StructuredRuntimeError);
    expect(() => summarizeResult(forged)).toThrow(StructuredRuntimeError);
  });
});
