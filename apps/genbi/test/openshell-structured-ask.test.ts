import { DEFAULT_COMPONENT_LIMITS } from "../harness/components/runner.js";
import { describe, expect, it, vi } from "vitest";
import type { ComponentInvocationResult } from "@warble/claude-agent-sdk";
import type { RouteOptions } from "../harness/index.js";
import { createOpenShellStructuredAdapter, readOpenShellStructuredResult, type OpenShellStructuredProvisioner } from "../server/openshell-structured-ask.js";
import { StructuredRuntime, type StructuredScope } from "../server/structured-runtime.js";
import { runtimeReady } from "../server/runtime-host/policy.js";
import { toAnswerOrRefusalEvent } from "../server/fold.js";
import { GovernedWrenError } from "../harness/components/wren-access.js";
import { observeStructuredQueryAccess, structuredFailureFeedback } from "../server/structured-error-feedback.js";
import { resolveRuntimeSelection } from "../server/runtime-selection.js";
const openshellClaude = resolveRuntimeSelection({ GENBI_RUNTIME: "openshell", GENBI_BACKEND: "claude" });

const request: RouteOptions = { authChoice: { mode: "subscription", provider: "claude" }, profileSource: "fixture", userProject: "/fixture", question: "count" };
const root = (): ComponentInvocationResult => ({ status: "ok", output: { kind: "value", value: { columns: ["n"], rows: [{ n: 7 }] } }, provenance: { verified: true, definition: { sql: "SELECT COUNT(*) AS n FROM orders" } } });
function fixture() {
  let current = true;
  let preparedInput!: Parameters<OpenShellStructuredProvisioner["prepare"]>[0];
  const controller = new AbortController();
  const scope: StructuredScope = { sessionId: "session", turnId: "turn", signal: controller.signal, assertCurrent() { if (!current) throw Error("private stale details"); } };
  const run = vi.fn(async () => {
    const value = root();
    await preparedInput.persistRoot(value as Extract<ComponentInvocationResult, { status: "ok" }>, { isCurrent: () => current } as never, preparedInput.scope.signal!);
    return value;
  });
  const dispose = vi.fn(async () => {});
  const prepared = { assertCurrent: scope.assertCurrent, run, dispose };
  const prepare = vi.fn(async (input: Parameters<OpenShellStructuredProvisioner["prepare"]>[0]) => { preparedInput = input; return prepared; });
  const adapter = createOpenShellStructuredAdapter({ probe: async () => runtimeReady("synthetic", []), prepare });
  const local = vi.fn(async () => { throw Error("local fallback forbidden"); });
  const runtime = new StructuredRuntime({ selection: openshellClaude, localRoute: local, localSetupFor: () => undefined, adapters: { claude: adapter } });
  return { adapter, runtime, scope, controller, run, dispose, prepare, local, preparedInput: () => preparedInput, revoke() { current = false; } };
}

describe("OpenShell structured root authority", () => {
  it("does not admit a gateway or pi-ai execution into the protected Claude OpenShell adapter", async () => {
    const f = fixture();
    await expect(f.adapter.ask!({ ...request, authChoice: { mode: "gateway", config: { provider: "openrouter", model: "synthetic", apiKey: "synthetic-request-key" } } }, f.scope)).rejects.toMatchObject({ code: "unsupported" });
    expect(f.prepare).not.toHaveBeenCalled(); expect(f.local).not.toHaveBeenCalled();
  });
  it("honors the deployer root budget beyond the old default while retaining stricter chat cancellation", async () => {
    vi.useFakeTimers();
    try {
      const f = fixture(); const original = f.run.getMockImplementation()!;
      let release!: () => void;
      const held = new Promise<void>(resolve => { release = resolve; });
      f.run.mockImplementation(async () => { await held; return original(); });
      const pending = f.runtime.route({ ...request, componentLimits: { ...DEFAULT_COMPONENT_LIMITS, timeoutMs: 300_000 } }, f.scope);
      await vi.advanceTimersByTimeAsync(120_001);
      expect(f.preparedInput().scope.signal?.aborted).toBe(false);
      release(); expect(await pending).toMatchObject({ backend: "openshell", envelope: { verified: true } });
      const shorter = fixture(); shorter.run.mockImplementation(() => new Promise((_resolve, reject) => { const signal = shorter.preparedInput().scope.signal!; signal.addEventListener("abort", () => reject(signal.reason), { once: true }); }));
      const cancelled = shorter.runtime.route({ ...request, componentLimits: { ...DEFAULT_COMPONENT_LIMITS, timeoutMs: 300_000 }, chatTimeoutMs: 10 }, shorter.scope);
      const rejected = expect(cancelled).rejects.toMatchObject({ code: "timeout" });
      await vi.advanceTimersByTimeAsync(10); await rejected;
      expect(shorter.dispose).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });
  it.each(["query", "cleanup", "stale", "cancel"])("preserves the actual %s cause over a captured query error", async kind => {
    const f = fixture();
    let captured: Error | undefined;
    const access = observeStructuredQueryAccess({ async query() { throw new GovernedWrenError("execution_failed"); }, async inspect() {}, async close() {} }, value => { captured = value; });
    await access.query({ sql: "SELECT unavailable", limit: 1 }, new AbortController().signal).catch(() => {});
    f.run.mockImplementation(async () => { if (kind === "stale") f.revoke(); if (kind === "cancel") f.controller.abort(); throw captured; });
    if (kind === "cleanup") f.dispose.mockRejectedValue(Error("private details"));
    const error = await f.runtime.route(request, f.scope).catch(error => error);
    expect(structuredFailureFeedback(error).code).toBe(kind === "query" ? "query.execution_failed" : `runtime.${kind === "cancel" ? "cancelled" : kind}`);
    expect(f.dispose).toHaveBeenCalledOnce(); expect(f.local).not.toHaveBeenCalled();
  });
  it("returns a host-root answer only after settlement and cleanup, with truthful readiness", async () => {
    const f = fixture(); let close!: () => void;
    f.dispose.mockImplementation(() => new Promise<void>(resolve => { close = resolve; }));
    let returned = false;
    const pending = f.runtime.route(request, f.scope).then(result => { returned = true; return result; });
    await vi.waitFor(() => expect(close).toBeDefined()); expect(returned).toBe(false);
    close(); const result = await pending;
    expect(result).toMatchObject({ backend: "openshell", envelope: { verified: true, verificationScope: "query-results", blocks: [{ type: "table", rows: [{ n: 7 }] }, { type: "definition" }] } });
    expect(result).not.toHaveProperty("finalText"); expect(f.dispose).toHaveBeenCalledOnce(); expect(f.local).not.toHaveBeenCalled();
    expect(toAnswerOrRefusalEvent("answer", result)).toMatchObject({ answer: { form: "rich", envelope: { verified: true } } });
    expect(await f.runtime.readiness(request.authChoice)).toMatchObject({ active: { backend: "openshell", ask: true, setup: false, modelExecution: "openshell", queryExecution: "openshell", supportedAgents: ["answer_query"] } });
  });
  it.each(["missing-root", "unverified", "different-result", "duplicate-root", "cleanup", "stale", "cancel"])("does not promote %s into an answer", async kind => {
    const f = fixture(); const original = f.run.getMockImplementation()!;
    f.run.mockImplementation(async () => {
      const input = f.preparedInput();
      if (kind === "missing-root") return root();
      if (kind === "unverified") { const value = root(); if (value.status === "ok") value.provenance = { verified: false }; await input.persistRoot(value as never, { isCurrent: () => true } as never, input.scope.signal!); return value; }
      const value = await original();
      if (kind === "different-result") return { ...root(), output: { kind: "value", value: { columns: ["n"], rows: [{ n: 999 }] } } } as ComponentInvocationResult;
      if (kind === "duplicate-root") await input.persistRoot(value as never, { isCurrent: () => true } as never, input.scope.signal!);
      if (kind === "stale") f.revoke();
      if (kind === "cancel") f.controller.abort();
      return value;
    });
    if (kind === "cleanup") f.dispose.mockRejectedValue(Error("private worker stderr"));
    const events = vi.fn();
    await expect(f.runtime.route({ ...request, onEvent: events }, f.scope)).rejects.toThrow(/Structured runtime/);
    expect(events.mock.calls.some(([event]) => event.kind === "run.finish" && event.status === "answer")).toBe(false);
    expect(f.dispose).toHaveBeenCalledOnce(); expect(f.local).not.toHaveBeenCalled();
  });
  it("does not trust a forged result, cloned proof, mutated envelope or expired proof", async () => {
    const f = fixture(); const value = await f.runtime.route(request, f.scope);
    if (value.backend !== "openshell") throw Error();
    expect(() => readOpenShellStructuredResult(structuredClone(value))).toThrow();
    expect(() => toAnswerOrRefusalEvent("forged", { ...value, envelope: { blocks: [{ type: "chart", query: "DELETE FROM orders" }], verified: true } })).toThrow();
    (value.envelope as { verified: boolean }).verified = false; expect(() => readOpenShellStructuredResult(value)).toThrow();
    const other = fixture(); const current = await other.runtime.route(request, other.scope); other.revoke();
    expect(() => toAnswerOrRefusalEvent("late", current)).toThrow();
  });
  it.each(["generate_dashboard", "connect_source", "enrich_project"])("rejects unsupported %s without opening work", async agentId => {
    const f = fixture(); await expect(f.runtime.route({ ...request, agentId }, f.scope)).rejects.toMatchObject({ code: "unsupported" });
    expect(f.prepare).not.toHaveBeenCalled(); expect(f.local).not.toHaveBeenCalled();
  });
  it("keeps Setup and native unsupported; Ask requires the matching adapter", async () => {
    const f = fixture(); expect(() => f.runtime.assertOperationSupported(request.authChoice, "ask")).not.toThrow();
    for (const operation of ["setup", "native"] as const) expect(() => f.runtime.assertOperationSupported(request.authChoice, operation)).toThrow();
    await expect(f.runtime.setup({ prompt: "setup", workspaceRoot: "/fixture", authChoice: request.authChoice }, f.scope)).rejects.toMatchObject({ code: "unsupported" });
    expect(f.prepare).not.toHaveBeenCalled();
    const empty = new StructuredRuntime({ selection: openshellClaude, localRoute: f.local, localSetupFor: () => undefined });
    expect(() => empty.assertOperationSupported(request.authChoice, "ask")).toThrow(); await expect(empty.route(request, f.scope)).rejects.toMatchObject({ code: "unavailable" });
  });
  it("aborts active work synchronously on runtime revocation and cannot emit a late root", async () => {
    const f = fixture(); let release!: () => void;
    f.run.mockImplementation(async () => { await new Promise<void>(resolve => { release = resolve; }); const input = f.preparedInput(); await input.persistRoot(root() as never, { isCurrent: () => true } as never, input.scope.signal!); return root(); });
    const pending = f.runtime.route(request, f.scope); const rejected = expect(pending).rejects.toMatchObject({ code: "cancelled" });
    await vi.waitFor(() => expect(release).toBeDefined()); f.runtime.revoke();
    expect(f.preparedInput().scope.signal!.aborted).toBe(true); release(); await rejected;
    expect(f.dispose).toHaveBeenCalledOnce();
  });
  it("aborts a stuck step at the bounded operation deadline without returning a root", async () => {
    const f = fixture();
    f.run.mockImplementation(() => new Promise((_resolve, reject) => { const signal = f.preparedInput().scope.signal!; signal.addEventListener("abort", () => reject(signal.reason), { once: true }); }));
    await expect(f.runtime.route({ ...request, chatTimeoutMs: 10 }, f.scope)).rejects.toMatchObject({ code: "timeout" });
    expect(f.preparedInput().scope.signal!.aborted).toBe(true); expect(f.dispose).toHaveBeenCalledOnce(); expect(f.local).not.toHaveBeenCalled();
  });
});

describe("Claude clean non-ok runner result classification", () => {
  const cases: [string, ComponentInvocationResult, string][] = [
    ["callee_refused", { status: "refused", code: "callee_refused", message: "synthetic" } as never, "unaccepted"],
    ["invalid_result", { status: "error", code: "invalid_result", message: "synthetic" } as never, "unaccepted"],
    ["callee_failed", { status: "error", code: "callee_failed", message: "synthetic" } as never, "failed"],
    ["transient_transport", { status: "error", code: "transient_transport", message: "synthetic" } as never, "failed"],
    ["cancelled", { status: "error", code: "cancelled", message: "synthetic" } as never, "failed"],
    ["budget_exhausted", { status: "error", code: "budget_exhausted", message: "synthetic" } as never, "failed"],
    ["invalid_request", { status: "error", code: "invalid_request", message: "synthetic" } as never, "failed"],
    ["unsupported_callee", { status: "error", code: "unsupported_callee", message: "synthetic" } as never, "failed"],
    ["an unclassified refusal code", { status: "refused", code: "something_else", message: "synthetic" } as never, "failed"],
  ];
  it.each(cases)("maps %s through the closed code only", async (_name, result, code) => {
    const f = fixture(); f.run.mockImplementation(async () => result);
    const error = await f.runtime.route(request, f.scope).catch(value => value);
    expect(error).toMatchObject({ code }); expect(f.dispose).toHaveBeenCalledOnce(); expect(f.local).not.toHaveBeenCalled();
    expect(structuredFailureFeedback(error).code).toBe(`runtime.${code}`);
  });
  it.each(["cleanup", "stale", "cancel"])("never keeps an unaccepted result when %s also failed", async kind => {
    const f = fixture(); f.run.mockImplementation(async () => { if (kind === "stale") f.revoke(); if (kind === "cancel") f.controller.abort(); return { status: "refused", code: "callee_refused", message: "synthetic" } as never; });
    if (kind === "cleanup") f.dispose.mockRejectedValue(Error("private"));
    const error = await f.runtime.route(request, f.scope).catch(value => value);
    expect(error).toMatchObject({ code: kind === "cancel" ? "cancelled" : kind }); expect(structuredFailureFeedback(error).code).not.toBe("runtime.unaccepted");
  });
});
