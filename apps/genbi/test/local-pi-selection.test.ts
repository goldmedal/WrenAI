import { describe, expect, it, vi } from "vitest";
import { authOffer, BACKENDS, inProcessAuthOffer, isBackendOffered, localPiServes, localSubscriptionVendorOffered, NOT_LISTED_REASON, RUNTIME_SUPPORT, resolveRuntimeSelection, UNSUPPORTED_REASON, type BackendName } from "../server/runtime-selection.js";
import { StructuredRuntime, type StructuredAdapter, type StructuredScope } from "../server/structured-runtime.js";
import { runtimeNotReady, runtimeReady } from "../server/runtime-host/policy.js";
import type { RouteOptions } from "../harness/index.js";

const scope = (): StructuredScope => ({ sessionId: "session", turnId: "turn", assertCurrent: vi.fn() });
const request = (authChoice: RouteOptions["authChoice"], agentId?: string): RouteOptions => ({ authChoice, profileSource: "fixture", userProject: "/fixture/project", question: "count", ...(agentId ? { agentId } : {}) });
const claude = { mode: "subscription", provider: "claude" } as const;
const apiKey = { mode: "api-key", adapter: "anthropic" } as const;
const gateway = { mode: "gateway", config: { provider: "synthetic" } } as const;
const localMode = { mode: "local" } as const;

const piAdapter = (over: Partial<StructuredAdapter> = {}): StructuredAdapter & { ask: ReturnType<typeof vi.fn> } => {
  const ask = vi.fn(async () => ({ backend: "pi-local" as const, warnings: [], envelope: { blocks: [], verified: true } }));
  return { vendor: "pi", backend: "pi-local", probe: async () => runtimeReady("1.0.4", []), ask: ask as never, ...over } as never;
};
function runtimeFor(env: NodeJS.ProcessEnv, adapters: Record<string, StructuredAdapter> = {}) {
  const localRoute = vi.fn(async () => ({ backend: "codex-local" as const, warnings: [], finalText: "local" }));
  const localSetup = { run: vi.fn(async () => ({ finalText: "local setup" })) };
  const runtime = new StructuredRuntime({ selection: resolveRuntimeSelection(env), localRoute, localSetupFor: () => localSetup, adapters });
  return { runtime, localRoute, localSetup };
}

describe("local pi: selection", () => {
  it("is supported on the local runtime, opt-in, and unchanged for OpenShell", () => {
    expect(RUNTIME_SUPPORT.local.backends.pi).toBe("supported");
    expect(RUNTIME_SUPPORT.local.inProcessAuth).toBe(true);
    expect(RUNTIME_SUPPORT.openshell).toEqual({ backends: { claude: "supported", codex: "unsupported", pi: "supported" }, inProcessAuth: { via: "pi" }, localModeAuth: false });
  });
  it("is never offered by default: the default local list stays claude and codex", () => {
    const selection = resolveRuntimeSelection({});
    expect(selection.listed).toEqual(["claude", "codex"]);
    expect(selection.offers.pi).toEqual({ offered: false, reason: NOT_LISTED_REASON });
    expect(selection.warnings).toEqual([]);
    for (const mode of ["api-key", "gateway", "local"]) expect(localPiServes(selection, { mode }, "ask")).toBe(false);
  });
  const subsets = (items: readonly BackendName[]): BackendName[][] => items.reduce<BackendName[][]>((all, item) => [...all, ...all.map((set) => [...set, item])], [[]]).filter((set) => set.length > 0);
  it.each(subsets(BACKENDS))("local BACKEND=%s offers exactly the listed backends, with no warning", (...listed) => {
    const selection = resolveRuntimeSelection({ GENBI_BACKEND: listed.join(",") });
    for (const backend of BACKENDS) expect(isBackendOffered(selection, backend)).toBe(listed.includes(backend));
    expect(selection.warnings).toEqual([]);
    // Every auth mode stays offered on local whatever the list says; the list only decides which purposes route to pi.
    for (const mode of ["api-key", "gateway", "local"]) expect(authOffer(selection, { mode }).offered).toBe(true);
    expect(inProcessAuthOffer(selection).offered).toBe(true);
    expect(localSubscriptionVendorOffered(selection)).toBe(listed.includes("claude") || listed.includes("codex"));
  });
  it("routes only the ask purpose of api-key and gateway to pi, and only on a local boot that lists it", () => {
    const withPi = resolveRuntimeSelection({ GENBI_BACKEND: "claude,pi" });
    for (const mode of ["api-key", "gateway"]) { expect(localPiServes(withPi, { mode }, "ask")).toBe(true); expect(localPiServes(withPi, { mode }, "other")).toBe(false); }
    for (const mode of ["local", "subscription"]) expect(localPiServes(withPi, { mode }, "ask")).toBe(false);
    expect(localPiServes(resolveRuntimeSelection({ GENBI_BACKEND: "claude" }), { mode: "api-key" }, "ask")).toBe(false);
    // OpenShell has its own seam; the local predicate never claims it.
    expect(localPiServes(resolveRuntimeSelection({ GENBI_RUNTIME: "openshell", GENBI_BACKEND: "pi" }), { mode: "api-key" }, "ask")).toBe(false);
  });
  it("OpenShell still refuses api-key, gateway and local-mode auth without pi and behaves as before", () => {
    const openshell = resolveRuntimeSelection({ GENBI_RUNTIME: "openshell", GENBI_BACKEND: "claude" });
    for (const mode of ["api-key", "gateway", "local"]) expect(authOffer(openshell, { mode })).toEqual({ offered: false, reason: UNSUPPORTED_REASON });
  });
});

describe("local pi: routing, readiness and no fallback", () => {
  it("routes an api-key or gateway answer_query Ask to the pi adapter and never to the in-process route", async () => {
    const adapter = piAdapter(); const f = runtimeFor({ GENBI_BACKEND: "pi" }, { pi: adapter });
    for (const auth of [apiKey, gateway]) {
      await expect(f.runtime.route(request(auth), scope())).resolves.toMatchObject({ backend: "pi-local" });
      await expect(f.runtime.route(request(auth, "answer_query"), scope())).resolves.toMatchObject({ backend: "pi-local" });
    }
    expect(adapter.ask).toHaveBeenCalledTimes(4); expect(f.localRoute).not.toHaveBeenCalled();
  });
  it("keeps every other purpose and auth mode on the exact in-process route", async () => {
    const adapter = piAdapter(); const f = runtimeFor({ GENBI_BACKEND: "claude,codex,pi" }, { pi: adapter });
    await expect(f.runtime.route(request(apiKey, "generate_dashboard"), scope())).resolves.toMatchObject({ finalText: "local" });
    await expect(f.runtime.route(request(gateway, "explain_change"), scope())).resolves.toMatchObject({ finalText: "local" });
    await expect(f.runtime.route(request(localMode), scope())).resolves.toMatchObject({ finalText: "local" });
    await expect(f.runtime.route(request(claude), scope())).resolves.toMatchObject({ finalText: "local" });
    await expect(f.runtime.setup({ prompt: "p", workspaceRoot: "/fixture", authChoice: apiKey }, scope())).resolves.toMatchObject({ finalText: "local setup" });
    await expect(f.runtime.setup({ prompt: "p", workspaceRoot: "/fixture", authChoice: gateway }, scope())).resolves.toMatchObject({ finalText: "local setup" });
    await expect(f.runtime.enrich({ authChoice: apiKey, mode: "x", projectRevision: "r" } as never, scope())).rejects.toMatchObject({ code: "unsupported" });
    expect(adapter.ask).not.toHaveBeenCalled(); expect(f.localRoute).toHaveBeenCalledTimes(4); expect(f.localSetup.run).toHaveBeenCalledTimes(2);
  });
  it("a boot that does not list pi behaves exactly as before: in-process Ask, pi not offered, nothing routed", async () => {
    const adapter = piAdapter(); const f = runtimeFor({}, { pi: adapter });
    for (const auth of [apiKey, gateway, localMode]) await expect(f.runtime.route(request(auth), scope())).resolves.toMatchObject({ finalText: "local" });
    expect(adapter.ask).not.toHaveBeenCalled();
    const readiness = await f.runtime.readiness(apiKey);
    expect(readiness.backends.pi).toEqual({ offered: false, state: "not_offered", ask: false, setup: false, reason: NOT_LISTED_REASON });
    expect(readiness.active).toMatchObject({ offered: true, backend: "in-process", state: "ready", ask: true });
    expect(JSON.stringify(readiness)).not.toContain("pi-local");
  });
  it("fails closed when pi is listed but not ready, missing, mismatched or throwing: no in-process fallback, ever", async () => {
    const notReady = runtimeNotReady("pi-local", "unprovisioned", "pi_not_installed");
    const cases: [string, Record<string, StructuredAdapter>][] = [
      ["no adapter", {}],
      ["not ready", { pi: piAdapter({ probe: async () => notReady }) }],
      ["probe throws", { pi: piAdapter({ probe: async () => { throw new Error("x"); } }) }],
      ["wrong backend id", { pi: piAdapter({ backend: "openshell" }) }],
      ["wrong vendor", { pi: piAdapter({ vendor: "claude" }) }],
    ];
    for (const [name, adapters] of cases) for (const auth of [apiKey, gateway]) {
      const f = runtimeFor({ GENBI_BACKEND: "pi" }, adapters);
      await expect(f.runtime.route(request(auth), scope()), name).rejects.toMatchObject({ code: "unavailable" });
      expect(f.localRoute, name).not.toHaveBeenCalled();
    }
    const adapter = piAdapter({ ask: vi.fn(async () => { throw new Error("boom"); }) as never });
    const f = runtimeFor({ GENBI_BACKEND: "pi" }, { pi: adapter });
    await expect(f.runtime.route(request(apiKey), scope())).rejects.toMatchObject({ code: "failed" });
    expect(f.localRoute).not.toHaveBeenCalled();
  });
  it("reports pi on this machine: backend, state, reason and a fixed code only; Ask on, setup off; active follows pi for api-key and gateway", async () => {
    const f = runtimeFor({ GENBI_BACKEND: "pi" }, { pi: piAdapter() });
    const ready = await f.runtime.readiness(apiKey);
    expect(ready.backends.pi).toEqual({ offered: true, backend: "pi-local", state: "ready", ask: true, setup: false, reason: "Structured Ask runs through pi for API key and gateway; every other purpose runs in-process." });
    expect(ready.active).toBe(ready.backends.pi); expect((await f.runtime.readiness(gateway)).active).toMatchObject({ backend: "pi-local" });
    expect((await f.runtime.readiness(localMode)).active).toMatchObject({ backend: "in-process" });
    const down = runtimeFor({ GENBI_BACKEND: "pi" }, { pi: piAdapter({ probe: async () => runtimeNotReady("pi-local", "incompatible", "pi_identity_mismatch") }) });
    const shown = (await down.runtime.readiness(apiKey)).backends.pi;
    expect(shown).toEqual({ offered: true, backend: "pi-local", state: "unavailable", ask: false, setup: false, reason: "Selected vendor backend is not ready.", code: "pi_identity_mismatch" });
    expect(Object.keys(shown).sort()).toEqual(["ask", "backend", "code", "offered", "reason", "setup", "state"]);
  });
  it("does not hide the other backends: claude and codex readiness are unchanged by a pi listing", async () => {
    const f = runtimeFor({ GENBI_BACKEND: "claude,codex,pi" }, { pi: piAdapter() });
    const readiness = await f.runtime.readiness(claude);
    expect(readiness.claude).toMatchObject({ offered: true, backend: "local", state: "ready", ask: true, setup: true, reason: "Explicit local execution; vendor isolation is not claimed." });
    expect(readiness.codex).toMatchObject({ offered: true, backend: "local" });
  });
});
