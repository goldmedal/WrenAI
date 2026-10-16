import { describe, expect, it, vi } from "vitest";
import { StructuredRuntime, StructuredRuntimeError, type StructuredAdapter, type StructuredScope } from "../server/structured-runtime.js";
import { runtimeNotReady, runtimeReady } from "../server/runtime-host/policy.js";
import { resolveRuntimeSelection } from "../server/runtime-selection.js";
import type { AuthChoice, RouteOptions, RouteResult } from "../harness/index.js";

const scope = (): StructuredScope => ({ sessionId: "session", turnId: "turn", assertCurrent: vi.fn() });
const apiKey: AuthChoice = { mode: "api-key", adapter: "openai-compatible" };
const gateway: AuthChoice = { mode: "gateway", config: { provider: "vendor" } };
const subscription: AuthChoice = { mode: "subscription", provider: "claude" };
const request = (authChoice: AuthChoice): RouteOptions => ({ authChoice, profileSource: "fixture", userProject: "/fixture/project", question: "count" });
const answer = { backend: "openshell", warnings: [], envelope: { type: "synthetic" } } as unknown as RouteResult;

function piHost(options: { ready?: boolean; omitAdapter?: boolean; adapterVendor?: StructuredAdapter["vendor"]; ask?: StructuredAdapter["ask"] | null } = {}) {
  const ask = vi.fn(async () => answer);
  const probe = vi.fn(async () => options.ready === false ? runtimeNotReady("openshell", "unprovisioned", "openshell_identity_mismatch") : runtimeReady("0.0.117", []));
  const adapter: StructuredAdapter = { vendor: options.adapterVendor ?? "pi", backend: "openshell", probe, ...(options.ask === null ? {} : { ask: options.ask ?? ask }) };
  const localRoute = vi.fn(async () => { throw new Error("in-process fallback forbidden"); });
  const localSetup = { run: vi.fn(async () => { throw new Error("local setup forbidden"); }) };
  const runtime = new StructuredRuntime({ selection: resolveRuntimeSelection({ GENBI_RUNTIME: "openshell", GENBI_BACKEND: "pi" }), localRoute, localSetupFor: () => localSetup as never,
    adapters: options.omitAdapter ? {} : { pi: adapter } });
  return { runtime, ask, probe, localRoute, localSetup };
}
const noBoot = () => {
  const localRoute = vi.fn(async () => ({ backend: "in-process", warnings: [] }) as unknown as RouteResult);
  const runtime = new StructuredRuntime({ selection: resolveRuntimeSelection({}), localRoute, localSetupFor: () => undefined });
  return { runtime, localRoute };
};

describe("pi OpenShell boot: boot x auth mode routing", () => {
  it.each([["api-key", apiKey], ["gateway", gateway]] as const)("routes %s Ask to the pi OpenShell adapter and never to the in-process route", async (_name, auth) => {
    const f = piHost();
    expect(f.runtime.keyIsolated()).toBe(true);
    await expect(f.runtime.route(request(auth), scope())).resolves.toBe(answer);
    expect(f.ask).toHaveBeenCalledOnce(); expect(f.probe).toHaveBeenCalled(); expect(f.localRoute).not.toHaveBeenCalled();
  });
  it("does not offer a subscription Ask, and runs nothing", async () => {
    const f = piHost();
    await expect(f.runtime.route(request(subscription), scope())).rejects.toMatchObject({ code: "unavailable" });
    expect(() => f.runtime.assertOperationSupported(subscription, "ask")).toThrow(StructuredRuntimeError);
    expect(f.ask).not.toHaveBeenCalled(); expect(f.localRoute).not.toHaveBeenCalled();
  });
  it("does not offer the local auth mode instead of running it in-process", async () => {
    const f = piHost();
    await expect(f.runtime.route(request({ mode: "local" }), scope())).rejects.toMatchObject({ code: "unavailable" });
    expect(() => f.runtime.assertOperationSupported({ mode: "local" }, "ask")).toThrow(expect.objectContaining({ code: "unavailable" }));
    expect(f.ask).not.toHaveBeenCalled(); expect(f.localRoute).not.toHaveBeenCalled();
  });
  it.each(["setup", "native"] as const)("refuses %s for api-key and gateway auth through the same operation gate Claude uses", async operation => {
    const f = piHost();
    for (const auth of [apiKey, gateway]) expect(() => f.runtime.assertOperationSupported(auth, operation)).toThrow(expect.objectContaining({ code: "unsupported" }));
    expect(() => f.runtime.assertOperationSupported(apiKey, "ask")).not.toThrow();
    await expect(f.runtime.setup({ prompt: "connect", workspaceRoot: "/fixture", authChoice: apiKey }, scope())).rejects.toMatchObject({ code: "unsupported" });
    expect(f.localSetup.run).not.toHaveBeenCalled(); expect(f.localRoute).not.toHaveBeenCalled();
  });
  it("refuses Ask when the pi adapter has no ask, is absent or is registered for another vendor, without any fallback", async () => {
    for (const f of [piHost({ ask: null }), piHost({ omitAdapter: true }), piHost({ adapterVendor: "claude" })]) {
      expect(() => f.runtime.assertOperationSupported(apiKey, "ask")).toThrow(expect.objectContaining({ code: "unsupported" }));
      await expect(f.runtime.route(request(apiKey), scope())).rejects.toBeInstanceOf(StructuredRuntimeError);
      expect(f.localRoute).not.toHaveBeenCalled();
    }
  });
  it("fails closed when the pi backend is not ready: unavailable, the adapter never asks, nothing runs locally", async () => {
    const f = piHost({ ready: false });
    await expect(f.runtime.route(request(apiKey), scope())).rejects.toMatchObject({ code: "unavailable" });
    expect(f.ask).not.toHaveBeenCalled(); expect(f.localRoute).not.toHaveBeenCalled();
  });
  it("reports an adapter failure as a structured failure and never retries in-process", async () => {
    const f = piHost({ ask: vi.fn(async () => { throw new Error("private detail"); }) });
    await expect(f.runtime.route(request(apiKey), scope())).rejects.toMatchObject({ code: "failed" });
    expect(f.localRoute).not.toHaveBeenCalled();
  });
  it("is revoked with the runtime and never serves a later Ask", async () => {
    const f = piHost(); f.runtime.revoke(); await f.runtime.shutdown();
    await expect(f.runtime.route(request(apiKey), scope())).rejects.toMatchObject({ code: "cancelled" });
    expect(f.ask).not.toHaveBeenCalled();
  });
});

describe("pi OpenShell boot: readiness is reported for pi alone", () => {
  it("has its own pi entry with OpenShell execution and only answer_query, and active follows the auth mode", async () => {
    const f = piHost();
    const readiness = await f.runtime.readiness(apiKey);
    expect(readiness.runtime).toBe("openshell");
    expect(readiness.backends.pi).toMatchObject({ offered: true, backend: "openshell", state: "ready", ask: true, setup: false, modelExecution: "openshell", queryExecution: "openshell", supportedAgents: ["answer_query"] });
    expect(readiness.active).toEqual(readiness.backends.pi); expect((await f.runtime.readiness(gateway)).active).toEqual(readiness.backends.pi);
    expect((await f.runtime.readiness(subscription)).active).toMatchObject({ offered: false, state: "not_offered", ask: false });
    expect((await f.runtime.readiness({ mode: "local" })).active).toMatchObject({ offered: false, state: "not_offered", ask: false });
  });
  it("never lets local readiness stand in for pi readiness", async () => {
    const f = piHost({ ready: false });
    const readiness = await f.runtime.readiness(apiKey);
    expect(readiness.backends.pi).toMatchObject({ offered: true, backend: "openshell", state: "unavailable", ask: false, code: "openshell_identity_mismatch" });
    expect(readiness.active).toMatchObject({ ask: false, state: "unavailable" });
    expect(readiness.backends.codex).toMatchObject({ offered: false, state: "not_offered" });
    const missing = await piHost({ omitAdapter: true }).runtime.readiness(apiKey);
    expect(missing.backends.pi).toMatchObject({ offered: true, state: "unavailable", ask: false });
  });
});

describe("no pi boot: routing is unchanged", () => {
  it("keeps api-key and gateway Ask on the in-process route and reports no pi entry", async () => {
    const f = noBoot();
    expect(f.runtime.keyIsolated()).toBe(false);
    await expect(f.runtime.route(request(apiKey), scope())).resolves.toMatchObject({ backend: "in-process" });
    await expect(f.runtime.route(request(gateway), scope())).resolves.toMatchObject({ backend: "in-process" });
    await expect(f.runtime.route(request({ mode: "local" }), scope())).resolves.toMatchObject({ backend: "in-process" });
    expect(f.localRoute).toHaveBeenCalledTimes(3);
    for (const auth of [apiKey, gateway, { mode: "local" } as AuthChoice]) for (const operation of ["ask", "setup", "native"] as const) expect(() => f.runtime.assertOperationSupported(auth, operation)).not.toThrow();
    const readiness = await f.runtime.readiness(apiKey);
    expect(readiness.backends.pi).toMatchObject({ offered: false, state: "not_offered" }); expect(readiness.runtime).toBe("local");
    expect(readiness.active).toMatchObject({ backend: "in-process", state: "ready", ask: true });
  });
});
