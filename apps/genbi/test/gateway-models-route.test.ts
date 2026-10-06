import { describe, expect, it, vi } from "vitest";
import { createApp, GATEWAY_CATALOG_UNAVAILABLE } from "../server/app.js";
import { Store } from "../server/db.js";
import type { TurnDeps } from "../server/turn.js";

// Node's real resolution error names local paths; the route must not pass it on.
const LOCAL_PATH = "/home/operator/private-checkout/node_modules";
vi.mock("@earendil-works/pi-ai", () => {
  throw new Error(`Cannot find package '${LOCAL_PATH}/@earendil-works/pi-ai/index.js'`);
});

describe("GET /api/harness/gateway-models without pi-ai", () => {
  it("reports a fixed unavailable reason that names the dependency and never a local path", async () => {
    const deps: TurnDeps = {
      store: new Store(":memory:"),
      route: async () => {
        throw new Error("not used");
      },
      baseRouteOptions: { authChoice: { mode: "api-key", adapter: "mock" }, profileSource: "/fixture/profile", userProject: "/fixture/project" },
    };
    const res = await createApp(deps).request("/api/harness/gateway-models?provider=groq");

    expect(res.status).toBe(200);
    const body = await res.text();
    expect(JSON.parse(body)).toEqual({ status: "unavailable", reason: GATEWAY_CATALOG_UNAVAILABLE });
    expect(body).toContain("@earendil-works/pi-ai");
    expect(body).not.toContain(LOCAL_PATH);
    expect(body).not.toContain("Cannot find package");
  });
});
