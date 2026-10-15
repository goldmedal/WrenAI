import { describe, expect, it } from "vitest";
import { createApp } from "../server/app.js";
import { Store } from "../server/db.js";
import type { TurnDeps } from "../server/turn.js";
import type { Bundle, RouteOptions, RouteResult } from "../harness/index.js";
import { COMPONENT_FAILURE_CODES, ComponentExecutionError } from "../harness/components/runner.js";
import { parseSse } from "./bff-sse-helpers.js";

const BASE_ROUTE_OPTIONS: Omit<RouteOptions, "question" | "onEvent"> = {
  authChoice: { mode: "api-key", adapter: "mock" },
  profileSource: "/fixture/profile",
  userProject: "/fixture/project",
};
const BUNDLE: Bundle = { vercel_bundle_version: "0.1", compat: { min_ir_version: "0.4", max_ir_version: "0.4" }, profile: "genbi-default", target: "vercel:headless", agents: [] };

async function errorFrames(route: (options: RouteOptions) => Promise<RouteResult>) {
  const app = createApp({ store: new Store(":memory:"), route, baseRouteOptions: BASE_ROUTE_OPTIONS, describeBundle: async () => BUNDLE } as TurnDeps);
  const session = (await (await app.request("/api/sessions", { method: "POST", body: "{}" })).json()) as { id: string };
  const { turnId } = (await (await app.request(`/api/sessions/${session.id}/turns`, { method: "POST", body: JSON.stringify({ question: "How many customers per plan?" }) })).json()) as { turnId: string };
  const stream = async () => parseSse(await (await app.request(`/api/sessions/${session.id}/stream?turn=${turnId}`)).text());
  const live = await stream(), replay = await stream();
  const hydrated = await (await app.request(`/api/sessions/${session.id}`)).json();
  return { live, replay, hydrated };
}

describe("a failed component run reaches the client with its code", () => {
  it.each(COMPONENT_FAILURE_CODES)("code %s is carried on the live and the replayed error frame", async (code) => {
    const { live, replay, hydrated } = await errorFrames(async () => { throw new ComponentExecutionError(code); });
    const expected = { event: "error", data: { message: new ComponentExecutionError(code).message, code } };
    expect(live.at(-1)).toEqual(expected);
    expect(replay.at(-1)).toEqual(expected);
    expect(hydrated).toMatchObject({ error: { message: expected.data.message, code, kind: "runtime" } });
    expect(live.some((frame) => frame.event === "done")).toBe(false);
  });

  it("an unrelated live failure remains message-only, while replay uses safe feedback and logs are redacted", async () => {
    const logged: string[] = [];
    const original = console.error;
    console.error = (line: unknown) => { logged.push(String(line)); };
    try {
      const { live, replay } = await errorFrames(async () => { throw new Error("upstream said api_key=sk-secret-123456 is bad"); });
      expect(live.at(-1)).toMatchObject({ event: "error" });
      expect((live.at(-1)!.data as { code?: string }).code).toBeUndefined();
      expect(replay.at(-1)).toMatchObject({ event: "error", data: { code: "runtime.failed", kind: "runtime" } });
      expect(JSON.stringify(replay)).not.toContain("sk-secret-123456");
      expect(JSON.stringify(replay)).not.toContain("upstream said");
    } finally { console.error = original; }
    const line = logged.find((entry) => entry.startsWith("[turn-failure]"));
    expect(line).toBeDefined();
    expect(line).toContain("upstream said");
    expect(line).not.toContain("sk-secret-123456");
  });
});
