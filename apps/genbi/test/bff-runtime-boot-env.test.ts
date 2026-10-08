import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../server/app.js";
import { Store } from "../server/db.js";
import type { TurnDeps } from "../server/turn.js";
import { buildExplicitAuthChoice } from "../harness/cli-args.js";
import type { AuthChoice, RouteOptions, RouteResult } from "../harness/index.js";
import type { RuntimeSettings } from "../server/wire-types.js";

const BOOT_KEY = "boot-key-must-never-be-echoed";

function buildApp(boot: AuthChoice, store = new Store(":memory:")) {
  let live = boot;
  const route = async (): Promise<RouteResult> => ({
    backend: "agent",
    warnings: [],
    kind: "answer",
    envelope: { blocks: [], summary: "ok" },
    trace: { steps: [] },
  });
  const baseRouteOptions: Omit<RouteOptions, "question" | "onEvent"> = {
    authChoice: boot,
    profileSource: "/fixture/profile",
    userProject: "/fixture/project",
  };
  const deps: TurnDeps = {
    store,
    route,
    baseRouteOptions,
    getAuthChoice: () => live,
    setAuthChoice: (choice) => {
      live = choice;
    },
    getRuntimeTierNames: async () => ["cheap", "strong"],
  };
  return { app: createApp(deps), store };
}

async function getRuntime(app: ReturnType<typeof createApp>): Promise<{ status: number; text: string; body: RuntimeSettings }> {
  const res = await app.request("/api/config/runtime");
  const text = await res.text();
  return { status: res.status, text, body: JSON.parse(text) as RuntimeSettings };
}

async function put(app: ReturnType<typeof createApp>, body: unknown): Promise<Response> {
  return await app.request("/api/config/runtime", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

afterEach(() => vi.unstubAllEnvs());

describe("GET /api/config/runtime reports the boot auth env until the user saves", () => {
  it("gateway boot: reports gateway with provider/model/base URL, never the key", async () => {
    const boot = buildExplicitAuthChoice("gateway", {
      provider: "openai",
      model: "org/model-a",
      endpoint: "https://gateway.example/v1",
      apiKey: BOOT_KEY,
    });
    const { app, store } = buildApp(boot);
    const { body, text } = await getRuntime(app);
    expect(body).toMatchObject({
      authMode: "gateway",
      gatewayProvider: "openai",
      gatewayModel: "org/model-a",
      gatewayBaseURL: "https://gateway.example/v1",
    });
    expect(text).not.toContain(BOOT_KEY);
    expect(store.hasExplicitRuntimeSettings()).toBe(false);
    expect(store.getRuntimeSettings().authMode).toBe("subscription");
  });

  it("api-key boot (openai-compatible): reports byo with adapter and model, never the key", async () => {
    const boot = buildExplicitAuthChoice("api-key", { adapter: "openai-compatible", model: "m-1", apiKey: BOOT_KEY });
    const { app } = buildApp(boot);
    const { body, text } = await getRuntime(app);
    expect(body).toMatchObject({ authMode: "byo", apiKeyAdapter: "openai-compatible", apiKeyModel: "m-1" });
    expect(text).not.toContain(BOOT_KEY);
  });

  it("api-key boot (anthropic): reports byo with the anthropic adapter", async () => {
    const { app } = buildApp(buildExplicitAuthChoice("api-key", { adapter: "anthropic" }));
    expect((await getRuntime(app)).body).toMatchObject({ authMode: "byo", apiKeyAdapter: "anthropic" });
  });

  it("local boot: reports local", async () => {
    const { app } = buildApp(buildExplicitAuthChoice("local", { endpoint: "http://127.0.0.1:11434" }));
    expect((await getRuntime(app)).body.authMode).toBe("local");
  });

  it("subscription boot: reports the booted provider", async () => {
    const { app } = buildApp(buildExplicitAuthChoice("subscription", { provider: "codex" }));
    expect((await getRuntime(app)).body).toMatchObject({ authMode: "subscription", subscriptionProvider: "codex" });
  });

  it("an unmappable boot adapter leaves the store default untouched", async () => {
    const { app } = buildApp({ mode: "api-key", adapter: "mock" });
    expect((await getRuntime(app)).body.authMode).toBe("subscription");
  });

  it("keeps the store's tier rows and non-auth fields", async () => {
    const { app, store } = buildApp(buildExplicitAuthChoice("gateway", { provider: "openai", model: "m" }));
    const stored = store.getRuntimeSettings();
    const { body } = await getRuntime(app);
    expect(body.tierModels).toEqual(stored.tierModels);
    expect(body.deployment).toBe(stored.deployment);
    expect(body.hybrid).toBe(stored.hybrid);
  });

  it("a saved user choice wins over the boot env", async () => {
    vi.stubEnv("OPENAI_API_KEY", "k");
    const boot = buildExplicitAuthChoice("gateway", { provider: "openai", model: "m" });
    const { app, store } = buildApp(boot);
    const res = await put(app, {
      authMode: "byo",
      apiKeyAdapter: "openai-compatible",
      apiKeyModel: "user-model",
      apiKeyBaseURL: "https://api.example/v1",
      tierModels: [{ tier: "cheap" }, { tier: "strong" }],
    });
    expect(res.status).toBe(200);
    expect(store.hasExplicitRuntimeSettings()).toBe(true);
    expect((await getRuntime(app)).body).toMatchObject({ authMode: "byo", apiKeyModel: "user-model" });
  });

  it("a saved choice equal to the default still wins (explicit marker, not value comparison)", async () => {
    const boot = buildExplicitAuthChoice("gateway", { provider: "openai", model: "m" });
    const store = new Store(":memory:");
    store.setRuntimeSettings(store.getRuntimeSettings());
    const { app } = buildApp(boot, store);
    expect((await getRuntime(app)).body.authMode).toBe("subscription");
  });
});

describe("PUT /api/config/runtime never answers 500 for a well-formed body", () => {
  it("a valid gateway PUT succeeds", async () => {
    vi.stubEnv("GENBI_GATEWAY_API_KEY", "gw-key");
    const { app } = buildApp(buildExplicitAuthChoice("gateway", { provider: "openai", model: "m" }));
    const res = await put(app, {
      authMode: "gateway",
      gatewayProvider: "openai",
      gatewayModel: "org/model-a",
      tierModels: [{ tier: "cheap" }, { tier: "strong" }],
    });
    expect(res.status).toBe(200);
  });

  it.each([
    ["unknown authMode", { authMode: "bogus" }],
    ["null authMode", { authMode: null }],
    ["numeric authMode", { authMode: 7 }],
    ["array body", []],
    ["string body", "\"gateway\""],
    ["null body", "null"],
    ["malformed json", "{nope"],
  ])("rejects %s with a 4xx, not a 500", async (_label, body) => {
    const { app, store } = buildApp(buildExplicitAuthChoice("gateway", { provider: "openai", model: "m" }));
    const res = await put(app, body);
    if (body === "null" || (Array.isArray(body) && body.length === 0) || body === "\"gateway\"" || body === "{nope") {
      expect(res.status).toBeLessThan(500);
    } else {
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toMatch(/authMode/);
    }
    expect(store.hasExplicitRuntimeSettings()).toBe(false);
  });
});
