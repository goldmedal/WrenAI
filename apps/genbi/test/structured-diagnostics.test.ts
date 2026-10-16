import { describe, expect, it, vi } from "vitest";
import { observeStructured, observeStructuredAsync, structuredDiagnosticReason, type StructuredDiagnosticRecord } from "../server/structured-diagnostics.js";
import { StructuredRuntime, StructuredRuntimeError } from "../server/structured-runtime.js";
import { createOpenShellStructuredAdapter } from "../server/openshell-structured-ask.js";
import { runtimeReady } from "../server/runtime-host/policy.js";
import { Store } from "../server/db.js";
import { createApp } from "../server/app.js";
import { streamTurn } from "../server/turn.js";
import { resolveRuntimeSelection } from "../server/runtime-selection.js";
const openshellClaude = resolveRuntimeSelection({ GENBI_RUNTIME: "openshell", GENBI_BACKEND: "claude" });

const request = { authChoice: { mode: "subscription", provider: "claude" } as const, profileSource: "fixture", userProject: "/fixture", question: "count" };
const scope = { sessionId: "session", turnId: "turn", signal: new AbortController().signal, assertCurrent() {} };
const secret = "sk-ant-private-secret /private/path SELECT secret@example.test";
describe("host-only structured diagnostics", () => {
  it.each([null, secret, Error(secret), { message: secret, stack: secret, code: secret }, Object.create(null)])("closes unknown reason %j", error => expect(structuredDiagnosticReason(error)).toBe("unknown"));
  it("does not invoke accessors, proxy traps or revoked proxies", () => {
    let reads = 0;
    const accessor = Object.defineProperty(Error(secret), "code", { get() { reads++; throw secret; } });
    const proxy = new Proxy(Error(secret), { getPrototypeOf() { reads++; throw secret; }, get() { reads++; throw secret; } });
    const revoked = Proxy.revocable({}, {}); revoked.revoke();
    for (const value of [accessor, proxy, revoked.proxy, Object.create(proxy), Object.create(Object.create(proxy))]) expect(structuredDiagnosticReason(value)).toBe("unknown");
    expect(reads).toBe(0);
  });
  it.each(["unavailable", "unsupported", "stale", "cancelled", "failed", "cleanup", "timeout"] as const)("classifies fixed structured %s without payload", code => {
    const e = new StructuredRuntimeError(code); e.message = secret; e.stack = secret;
    expect(structuredDiagnosticReason(e)).toBe("structured_" + code);
  });
  it("preserves success values/functions and the exact thrown error while observers fail", async () => {
    const value = { fn() {}, signal: scope.signal }, error = Error(secret), observer = () => { throw secret; };
    expect(observeStructured(observer, "configuration", () => value)).toBe(value);
    expect(await observeStructuredAsync(observer, "host_plan", async () => value)).toBe(value);
    try { observeStructured(observer, "ir_tiers", () => { throw error; }); throw Error(); } catch (actual) { expect(actual).toBe(error); }
    await expect(observeStructuredAsync(observer, "context_capture", async () => { throw error; })).rejects.toBe(error);
    expect(await observeStructuredAsync(async () => { throw secret; }, "adapter_run", async () => value)).toBe(value);
  });
  it("emits only immutable fixed keys before error wrapping", async () => {
    const records: StructuredDiagnosticRecord[] = [];
    await expect(observeStructuredAsync(r => { expect(Object.isFrozen(r)).toBe(true); records.push(r); }, "compile_profile", async () => { throw { code: "ENOENT", message: secret, stack: secret }; })).rejects.toMatchObject({ code: "ENOENT" });
    expect(records).toEqual([{ stage: "compile_profile", state: "entered", reason: "none" }, { stage: "compile_profile", state: "failed", reason: "system_enoent" }]);
    expect(JSON.stringify(records)).not.toContain(secret);
  });
  it.each(["before_adapter", "preparation"])("actual HTTP Ask preserves %s diagnostic while public failure stays generic", async stage => {
    const store = new Store(":memory:"), records: StructuredDiagnosticRecord[] = [], diagnostics = (r: StructuredDiagnosticRecord) => records.push(r);
    store.setRuntimeSettings({ authMode: "subscription", subscriptionProvider: "claude", subscriptionDriverModel: "synthetic", tierModels: [{ tier: "cheap", model: "haiku" }], hybrid: false, deployment: "personal" });
    const prepare = vi.fn(async () => { throw Error(secret); });
    const adapter = createOpenShellStructuredAdapter({ probe: async () => { if (stage === "before_adapter") throw Error(secret); return runtimeReady("synthetic", []); }, prepare }, diagnostics);
    const local = vi.fn(async () => { throw Error(secret); });
    const runtime = new StructuredRuntime({ selection: openshellClaude, adapters: { claude: adapter }, localRoute: local, localSetupFor: () => undefined, diagnostics });
    const app = createApp({ store, structuredRuntime: runtime, route: local, baseRouteOptions: request });
    try {
      const session = store.createSession("analysis");
      const created = await app.request(`/api/sessions/${session.id}/turns`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ question: "count" }) });
      expect(created.status).toBe(200); const { turnId } = await created.json() as { turnId: string };
      const response = await app.request(`/api/sessions/${session.id}/stream?turn=${encodeURIComponent(turnId)}`);
      const text = await response.text();
      expect(store.getTurn(turnId)).toMatchObject({ backend: null, resultKind: "error", answerSummary: null });
      expect(records).toContainEqual({ stage: stage === "before_adapter" ? "runtime_readiness" : "adapter_preparation", state: "failed", reason: "unknown" });
      expect(JSON.stringify(records) + text).not.toContain(secret);
      expect(local).not.toHaveBeenCalled(); expect(prepare).toHaveBeenCalledTimes(stage === "before_adapter" ? 0 : 1);
    } finally { await runtime.shutdown(); store.close(); }
  });
  it("observer failure cannot suppress cancellation/currentness or start preparation", async () => {
    const prepare = vi.fn(async () => { throw Error(); });
    const adapter = createOpenShellStructuredAdapter({ probe: async () => runtimeReady("synthetic", []), prepare }, () => { throw secret; });
    const runtime = new StructuredRuntime({ selection: openshellClaude, localRoute: async () => { throw Error(); }, localSetupFor: () => undefined, adapters: { claude: adapter }, diagnostics: () => { throw secret; } });
    await expect(runtime.route(request, { ...scope, assertCurrent() { throw Error(secret); } })).rejects.toMatchObject({ code: "stale" });
    const controller = new AbortController(); controller.abort();
    await expect(runtime.route(request, { ...scope, signal: controller.signal })).rejects.toMatchObject({ code: "cancelled" });
    expect(prepare).not.toHaveBeenCalled(); await runtime.shutdown();
  });
});
