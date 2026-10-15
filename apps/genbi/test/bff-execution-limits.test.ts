import { describe, expect, it, vi } from "vitest";
import { createApp } from "../server/app.js";
import { Store } from "../server/db.js";
import { resolveExecutionLimitsConfig } from "../server/execution-limits.js";
import { effectiveRouteOptions } from "../server/turn.js";
import type { TurnDeps } from "../server/turn.js";
import type { RouteOptions, RouteResult } from "../harness/index.js";
import type { ExecutionLimitsDto } from "../server/wire-types.js";

const BASE_ROUTE_OPTIONS: Omit<RouteOptions, "question" | "onEvent"> = {
  authChoice: { mode: "api-key", adapter: "mock" },
  profileSource: "/fixture/profile",
  userProject: "/fixture/project",
};

function build(env: Record<string, string> = {}, deployment: "personal" | "hosted" = "personal") {
  const store = new Store(":memory:");
  const route = async (): Promise<RouteResult> => ({ backend: "agent", warnings: [], kind: "answer", envelope: { blocks: [], summary: "ok" }, trace: { steps: [] } });
  const revokeInteractiveTerminals = vi.fn();
  const deps: TurnDeps = {
    store, route, baseRouteOptions: BASE_ROUTE_OPTIONS,
    executionLimits: resolveExecutionLimitsConfig(env, deployment),
    revokeInteractiveTerminals,
  };
  return { app: createApp(deps), store, deps, revokeInteractiveTerminals };
}

async function put(app: ReturnType<typeof createApp>, body: unknown): Promise<{ status: number; json: ExecutionLimitsDto & { error?: string } }> {
  const res = await app.request("/api/config/limits", { method: "PUT", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
  return { status: res.status, json: await res.json() as ExecutionLimitsDto & { error?: string } };
}

describe("GET/PUT /api/config/limits", () => {
  it("reports the deployer value and its bounds before any override", async () => {
    const { app } = build({ WREN_HARNESS_COMPONENT_TIMEOUT_MS: "240000" });
    const res = await app.request("/api/config/limits");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ componentTimeoutMs: 240_000, componentTimeoutSource: "env", deployerTimeoutMs: 240_000, ceilingMs: 1_800_000, minMs: 30_000, editable: true });
  });

  it("saves an operator override that the next turn's route options use, without revoking anything", async () => {
    const { app, store, deps, revokeInteractiveTerminals } = build();
    const generation = store.getRuntimeGeneration();
    const settings = store.getRuntimeSettings();
    expect(effectiveRouteOptions(deps).componentLimits?.timeoutMs).toBe(120_000);

    const saved = await put(app, { componentTimeoutMs: 300_000 });
    expect(saved.status).toBe(200);
    expect(saved.json).toMatchObject({ componentTimeoutMs: 300_000, componentTimeoutSource: "operator", operatorTimeoutMs: 300_000, deployerTimeoutMs: 120_000 });
    expect(store.getExecutionLimitSettings()).toEqual({ componentTimeoutMs: 300_000 });
    expect(effectiveRouteOptions(deps).componentLimits).toMatchObject({ timeoutMs: 300_000, depth: 8, steps: 40 });

    expect(store.getRuntimeGeneration()).toBe(generation);
    expect(store.getRuntimeSettings()).toEqual(settings);
    expect(store.hasExplicitRuntimeSettings()).toBe(false);
    expect(revokeInteractiveTerminals).not.toHaveBeenCalled();

    const cleared = await put(app, { componentTimeoutMs: null });
    expect(cleared.json).toMatchObject({ componentTimeoutMs: 120_000, componentTimeoutSource: "default" });
    expect(cleared.json.operatorTimeoutMs).toBeUndefined();
    expect(effectiveRouteOptions(deps).componentLimits?.timeoutMs).toBe(120_000);
  });

  it("rejects out-of-range, malformed and over-ceiling values with the range named", async () => {
    const { app, store } = build({ WREN_HARNESS_MAX_COMPONENT_TIMEOUT_MS: "600000" });
    for (const body of [{ componentTimeoutMs: 1000 }, { componentTimeoutMs: 600_001 }, { componentTimeoutMs: "300000" }, { componentTimeoutMs: 5.5 }]) {
      const res = await put(app, body);
      expect(res.status).toBe(400);
      expect(res.json.error).toMatch(/between 30000 and 600000 \(the ceiling set by WREN_HARNESS_MAX_COMPONENT_TIMEOUT_MS\)/);
    }
    expect((await put(app, {})).status).toBe(400);
    expect((await put(app, "garbage")).status).toBe(400);
    expect(store.getExecutionLimitSettings()).toBeUndefined();
  });

  it("refuses operator overrides on a hosted deployment without an explicit ceiling", async () => {
    const { app, store } = build({}, "hosted");
    const res = await put(app, { componentTimeoutMs: 300_000 });
    expect(res.status).toBe(403);
    expect(res.json.error).toMatch(/hosted deployment/);
    expect(store.getExecutionLimitSettings()).toBeUndefined();
    const info = await (await app.request("/api/config/limits")).json() as ExecutionLimitsDto;
    expect(info).toMatchObject({ editable: false });

    const unlocked = build({ WREN_HARNESS_MAX_COMPONENT_TIMEOUT_MS: "900000" }, "hosted");
    expect((await put(unlocked.app, { componentTimeoutMs: 300_000 })).status).toBe(200);
  });

  it("is read-only when the BFF has no execution-limit config", async () => {
    const store = new Store(":memory:");
    const route = async (): Promise<RouteResult> => ({ backend: "agent", warnings: [], kind: "answer", envelope: { blocks: [], summary: "ok" }, trace: { steps: [] } });
    const app = createApp({ store, route, baseRouteOptions: BASE_ROUTE_OPTIONS });
    expect(await (await app.request("/api/config/limits")).json()).toMatchObject({ componentTimeoutMs: 120_000, editable: false });
    expect((await put(app, { componentTimeoutMs: 300_000 })).status).toBe(503);
  });
});

import { ComponentExecutionError } from "../harness/components/runner.js";
import { parseSse } from "./bff-sse-helpers.js";
import type { Bundle } from "../harness/index.js";

const BUNDLE: Bundle = { vercel_bundle_version: "0.1", compat: { min_ir_version: "0.4", max_ir_version: "0.4" }, profile: "genbi-default", target: "vercel:headless", agents: [] };

describe("a cancelled run's error frame names the budget it ran out of", () => {
  it("states the budget and where to raise it, with the code still in the suffix", async () => {
    const store = new Store(":memory:");
    store.setExecutionLimitSettings({ componentTimeoutMs: 300_000 });
    const route = async (): Promise<RouteResult> => { throw new ComponentExecutionError("cancelled"); };
    const app = createApp({ store, route, baseRouteOptions: BASE_ROUTE_OPTIONS, describeBundle: async () => BUNDLE,
      executionLimits: resolveExecutionLimitsConfig({}, "personal") } as TurnDeps);
    const session = (await (await app.request("/api/sessions", { method: "POST", body: "{}" })).json()) as { id: string };
    const { turnId } = (await (await app.request(`/api/sessions/${session.id}/turns`, { method: "POST", body: JSON.stringify({ question: "build a dashboard" }) })).json()) as { turnId: string };
    const stream = async () => parseSse(await (await app.request(`/api/sessions/${session.id}/stream?turn=${turnId}`)).text());
    const expected = { event: "error", data: {
      message: "The component run was cancelled or timed out; the run budget was 300 s (set on the Harness page); raise it on the Harness page (cancelled).",
      code: "cancelled",
    } };
    expect((await stream()).at(-1)).toEqual(expected);
    // The replayed frame recovers the code from the stored message despite the appended budget.
    expect((await stream()).at(-1)).toEqual(expected);
  });
});
