import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { CodexRpcError } from "../server/runtime-host/codex-rpc.js";
import { CodexBackendError } from "../server/runtime-host/codex-app-server.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StructuredRuntime, type StructuredAdapter, type StructuredScope } from "../server/structured-runtime.js";
import { createCodexStructuredAdapter, type CodexStructuredProvisioner } from "../server/codex-structured-ask.js";
import { captureStructuredScope } from "../server/structured-scope.js";
import { runtimeReady, runtimeNotReady } from "../server/runtime-host/policy.js";
import { Store } from "../server/db.js";
import { createApp } from "../server/app.js";
import { streamTurn, type TurnDeps } from "../server/turn.js";
import { type RouteOptions } from "../harness/index.js";

const stores: Store[] = [];
const directories: string[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const request: RouteOptions = { authChoice: { mode: "subscription", provider: "codex" }, profileSource: "fixture", userProject: "/fixture/project", question: "count" };
const scope = (): StructuredScope => ({ sessionId: "session", turnId: "turn", assertCurrent: vi.fn() });
function host(adapter?: StructuredAdapter) {
  const localRoute = vi.fn(async () => ({ backend: "codex-local" as const, warnings: [], finalText: "local" }));
  const localSetup = { run: vi.fn(async () => ({ finalText: "local setup", sessionId: "legacy-anchor" })) };
  const runtime = new StructuredRuntime({ selected: { codex: "codex-app-server", claude: "claude-sandbox-runtime" }, allowLocal: true,
    localRoute, localSetupFor: () => localSetup, ...(adapter ? { adapters: { codex: adapter } } : {}) });
  return { runtime, localRoute, localSetup };
}
function provisioner() {
  const permit = { runtime: {}, assertActive: vi.fn(), release: vi.fn() };
  const tools = { accountEmail: "fixture@example.invalid", definitions: [], assertCurrent: vi.fn(), call: vi.fn(async (..._args: unknown[]): Promise<unknown> => undefined), close: vi.fn(async () => {}) };
  const driver = { startThread: vi.fn(async () => "thread"), runTurn: vi.fn(async (_question?: string, _options?: { timeoutMs?: number }) => ({ id: "turn", status: "completed", items: [{ type: "agentMessage", id: "answer", text: "99 orders" }] })), close: vi.fn(async () => {}) };
  const dispose = vi.fn(async () => {});
  const backend = { prepareLaunch: vi.fn(() => permit), probe: vi.fn(async () => ({ readiness: runtimeReady("0.156.1", []), diagnostic: { phase: "capability" } })), open: vi.fn(async (_permit: unknown, _input: { tools: typeof tools }) => driver) };
  const prepare = vi.fn(async () => ({ input: { tools, spec: {}, wrenHome: {}, assertScopeActive() {} }, dispose }));
  const adapter = createCodexStructuredAdapter({ backend, prepare } as unknown as CodexStructuredProvisioner);
  return { permit, tools, driver, dispose, backend, prepare, adapter, ...host(adapter) };
}

describe("explicit structured runtime boundary", () => {
  it.each(["codex_identity_uncertified", "codex_dependencies_drifted"] as const)("keeps unavailable vendors independent and never falls back (%s)", async (code) => {
    const f = provisioner(); f.backend.probe.mockResolvedValue({ readiness: runtimeNotReady("codex-app-server", "incompatible", code), diagnostic: { phase: "identity" } } as never);
    await expect(f.runtime.route(request, scope())).rejects.toMatchObject({ code: "unavailable" });
    const readiness = await f.runtime.readiness();
    expect(readiness.codex).toMatchObject({ ask: false, code });
    expect(readiness.claude).toMatchObject({ ask: false, setup: false });
    expect(f.prepare).not.toHaveBeenCalled(); expect(f.localRoute).not.toHaveBeenCalled();
    await expect(f.runtime.route({ ...request, authChoice: { mode: "subscription", provider: "claude" } }, scope())).rejects.toMatchObject({ code: "unavailable" });
  });
  it("rejects mismatched injected adapters, absent adapters and unsupported Setup", async () => {
    const f = provisioner();
    await expect(host().runtime.route(request, scope())).rejects.toMatchObject({ code: "unavailable" });
    await expect(host({ ...f.adapter, vendor: "claude" }).runtime.route(request, scope())).rejects.toMatchObject({ code: "unavailable" });
    await expect(f.runtime.setup({ prompt: "connect", workspaceRoot: "/fixture", authChoice: request.authChoice }, scope())).rejects.toMatchObject({ code: "unsupported" });
    expect(f.localSetup.run).not.toHaveBeenCalled(); expect(f.prepare).not.toHaveBeenCalled();
    expect((await f.runtime.readiness()).codex).toMatchObject({ ask: true, setup: false });
  });
  it("obtains the backend permit before preparing scoped authority", async () => {
    const f = provisioner(); f.backend.prepareLaunch.mockImplementation(() => { throw Error("uncertified private detail"); });
    await expect(f.runtime.route(request, scope())).rejects.toThrow("Structured runtime failed.");
    expect(f.prepare).not.toHaveBeenCalled(); expect(f.backend.open).not.toHaveBeenCalled(); expect(f.localRoute).not.toHaveBeenCalled();
  });
  it("returns the direct backend only after confirmed close and preserves compliance warnings", async () => {
    const f = provisioner(); let release!: () => void;
    f.driver.close.mockImplementation(() => new Promise<void>((resolve) => { release = resolve; }));
    let resolved = false;
    const pending = f.runtime.route(request, scope()).then((result) => { resolved = true; return result; });
    await vi.waitFor(() => expect(release).toBeDefined()); expect(resolved).toBe(false); expect(f.dispose).not.toHaveBeenCalled();
    release(); const result = await pending;
    expect(result).toMatchObject({ backend: "codex-app-server", finalText: "99 orders" }); expect(result.warnings.length).toBeGreaterThan(0);
    expect(f.dispose).toHaveBeenCalledOnce(); expect(f.tools.close).toHaveBeenCalledOnce(); expect(f.localRoute).not.toHaveBeenCalled();
  });
  it("carries only host results through the adapter after cleanup, never model-authored rows", async () => {
    const f = provisioner();
    const evidence = { status: "ok", output: { kind: "value", value: { columns: ["customers"], rows: [{ customers: 7 }] } },
      provenance: { verified: true, definition: { sql: "SELECT count(*) AS customers FROM customers" } } };
    f.tools.call.mockResolvedValue(evidence);
    f.driver.runTurn.mockImplementation(async () => {
      const input = f.backend.open.mock.calls[0]![1];
      await input.tools.call("component", {}, "call", new AbortController().signal);
      return { id: "turn", status: "completed", items: [{ type: "agentMessage", id: "answer", text: 'Interpretation only; not 999 customers.' }] };
    });
    const value = await f.runtime.route(request, scope());
    expect(value).toMatchObject({ backend: "codex-app-server", dataAttempted: true,
      envelope: { verified: true, verificationScope: "query-results", blocks: [{ type: "table", rows: [{ customers: 7 }] }, { type: "definition" }] } });
    expect(f.dispose).toHaveBeenCalledOnce();
    expect(f.driver.runTurn.mock.calls[0]?.[0]).toContain("User question:\ncount");
  });

  it("does not promote an earlier success after a later root call throws", async () => {
    const f = provisioner();
    f.tools.call.mockResolvedValueOnce({ status: "ok", output: { kind: "value", value: { columns: ["n"], rows: [[7]] } }, provenance: { verified: true, definition: { sql: "SELECT 7 AS n" } } })
      .mockRejectedValueOnce(Error("refused"));
    f.driver.runTurn.mockImplementation(async () => {
      const tools = f.backend.open.mock.calls[0]![1].tools;
      await tools.call("component", {}, "1", new AbortController().signal);
      await tools.call("component", {}, "2", new AbortController().signal).catch(() => {});
      return { id: "turn", status: "completed", items: [{ type: "agentMessage", id: "answer", text: 'Failed second query' }] };
    });
    const value = await f.runtime.route(request, scope());
    expect(value).not.toHaveProperty("envelope"); expect(value).toHaveProperty("dataAttempted", true);
  });

  it("gives the outer turn room for a bounded component and preserves explicit caller timeout", async () => {
    const f = provisioner(); await f.runtime.route(request, scope());
    expect(f.driver.runTurn.mock.calls[0]![1]).toMatchObject({ timeoutMs: 300_000 });
    await f.runtime.route({ ...request, chatTimeoutMs: 7_000 }, scope());
    expect(f.driver.runTurn.mock.calls[1]![1]).toMatchObject({ timeoutMs: 7_000 });
  });
  it("reports a safe timeout reason after cleanup without exposing vendor details", async () => {
    const f = provisioner(); f.driver.runTurn.mockRejectedValue(new CodexRpcError("timeout"));
    await expect(f.runtime.route(request, scope())).rejects.toMatchObject({ code: "timeout" });
    expect(f.dispose).toHaveBeenCalledOnce();
  });
  it("rejects a returned no-tool answer when final integrity validation fails", async () => {
    const f = provisioner(); const onEvent = vi.fn();
    const original = f.driver.runTurn.getMockImplementation()!;
    f.driver.runTurn.mockImplementation(async () => {
      const result = await original();
      f.tools.assertCurrent.mockImplementation(() => { throw Error("integrity changed"); });
      return result;
    });
    await expect(f.runtime.route({ ...request, onEvent }, scope())).rejects.toMatchObject({ code: "failed" });
    expect(onEvent.mock.calls.some(([event]) => event.kind === "run.finish")).toBe(false);
    expect(f.driver.close).toHaveBeenCalledOnce(); expect(f.tools.close).toHaveBeenCalledOnce();
  });
  it("retains materialization and reports cleanup failure, including at shutdown", async () => {
    const f = provisioner(); f.driver.close.mockRejectedValue(Error("private path"));
    await expect(f.runtime.route(request, scope())).rejects.toMatchObject({ code: "cleanup" });
    expect(f.dispose).not.toHaveBeenCalled(); await expect(f.runtime.shutdown()).rejects.toMatchObject({ code: "cleanup" });
  });
  it("revocation aborts the driver and waits for disposal before resolving shutdown", async () => {
    const f = provisioner(); let rejectTurn!: (error: Error) => void;
    f.driver.runTurn.mockImplementation(() => new Promise((_, reject) => { rejectTurn = reject; }));
    f.driver.close.mockImplementation(async () => { rejectTurn(Error("closed")); });
    const pending = f.runtime.route(request, scope()); const rejected = expect(pending).rejects.toMatchObject({ code: "cancelled" });
    await vi.waitFor(() => expect(f.driver.runTurn).toHaveBeenCalledOnce()); f.runtime.revoke();
    await rejected; await f.runtime.shutdown(); expect(f.dispose).toHaveBeenCalledOnce();
    expect((await f.runtime.readiness()).codex.ask).toBe(false);
  });
  it("a cancelled/stale preparation is cleaned before a driver can open", async () => {
    const f = provisioner(); const controller = new AbortController(); const captured = { ...scope(), signal: controller.signal };
    f.prepare.mockImplementation(async () => { controller.abort(); return { input: { tools: f.tools, spec: {}, wrenHome: {}, assertScopeActive() {} }, dispose: f.dispose }; });
    await expect(f.runtime.route(request, captured)).rejects.toMatchObject({ code: "cancelled" });
    expect(f.backend.open).not.toHaveBeenCalled(); expect(f.dispose).toHaveBeenCalledOnce(); expect(f.permit.release).toHaveBeenCalled();
  });
  it("rejects unsupported roots and hosted subscriptions before credentials or model execution", async () => {
    const f = provisioner();
    await expect(f.runtime.route({ ...request, agentId: "connect_source" }, scope())).rejects.toMatchObject({ code: "unsupported" });
    await expect(f.runtime.route({ ...request, deployment: "hosted" }, scope())).rejects.toThrow();
    expect(f.prepare).not.toHaveBeenCalled(); expect(f.driver.runTurn).not.toHaveBeenCalled();
  });
  it("injected Setup keeps scope/signal/events and cannot leak a legacy resume anchor", async () => {
    const onEvent = vi.fn(); const setup = vi.fn(async (options, captured) => {
      expect(options.signal).toBe(captured.signal); captured.assertCurrent();
      options.onEvent({ runId: "fixture", seq: 1, kind: "run.start", mode: "B", agentId: "connect_source" });
      return { finalText: "SETUP_STATUS: needs_input", sessionId: "must-not-be-resumed" };
    });
    const f = provisioner(); const h = host({ ...f.adapter, setup });
    const options = { prompt: "fixture credentials", workspaceRoot: "/fixture", projectName: "demo", stepKey: "connect" as const, authChoice: request.authChoice, onEvent };
    expect(await h.runtime.setup(options, scope())).toEqual({ finalText: "SETUP_STATUS: needs_input" });
    expect(onEvent).toHaveBeenCalledOnce();
    await expect(h.runtime.setup({ ...options, resumeSessionId: "foreign" }, scope())).rejects.toMatchObject({ code: "unsupported" });
    expect(setup).toHaveBeenCalledOnce(); expect(h.localSetup.run).not.toHaveBeenCalled();
  });
  it("captures runtime, binding and durable-turn identity without exposing credentials", () => {
    const store = new Store(":memory:"); stores.push(store);
    const session = store.createSession("analysis");
    const turn = store.createTurn({ id: "turn-fixture", sessionId: session.id, question: "count", composedInput: null });
    const captured = captureStructuredScope(store, turn, () => "/fixture"); captured.assertCurrent();
    store.setRuntimeSettings({ ...store.getRuntimeSettings(), subscriptionProvider: "codex" });
    expect(() => captured.assertCurrent()).toThrow("Structured runtime stale.");
    expect(JSON.stringify(captured)).not.toContain("subscriptionProvider");
  });
  it("the BFF consumes injected Ask results and exposes independent readiness", async () => {
    const store = new Store(":memory:"); stores.push(store); const f = provisioner();
    const session = store.createSession("analysis"); const turn = store.createTurn({ id: "turn-fixture", sessionId: session.id, question: "count", composedInput: null });
    const deps = { store, structuredRuntime: f.runtime, route: f.localRoute, baseRouteOptions: request } as TurnDeps;
    const frames: unknown[] = []; await streamTurn(deps, session.id, turn.id, async (frame) => { frames.push(frame); });
    expect(store.getTurn(turn.id)).toMatchObject({ backend: "codex-app-server", resultKind: "answer" });
    expect(frames).toContainEqual(expect.objectContaining({ event: "done" })); expect(f.localRoute).not.toHaveBeenCalled();
    const readiness = await createApp(deps).request("/api/structured-runtime/readiness");
    expect(await readiness.json()).toMatchObject({ codex: { backend: "codex-app-server", ask: true, setup: false }, claude: { ask: false } });
  });
  it("retains allocations when opening the driver cannot confirm process cleanup", async () => {
    const f = provisioner(); f.backend.open.mockRejectedValue(new CodexBackendError("codex_app_server_cleanup_failed"));
    await expect(f.runtime.route(request, scope())).rejects.toMatchObject({ code: "cleanup" });
    expect(f.dispose).not.toHaveBeenCalled(); expect(f.tools.close).toHaveBeenCalledOnce();
    await expect(f.runtime.shutdown()).rejects.toMatchObject({ code: "cleanup" });
  });
  it("rejects late events and results after host scope changes", async () => {
    const f = provisioner(); let current = true; const onEvent = vi.fn();
    const ask = vi.fn(async (options: RouteOptions) => {
      current = false;
      expect(() => options.onEvent?.({ runId: "fixture", seq: 1, kind: "run.start", mode: "B", agentId: "answer_query" })).toThrow();
      return { backend: "codex-app-server" as const, warnings: [], finalText: "stale answer" };
    });
    await expect(host({ ...f.adapter, ask }).runtime.route({ ...request, onEvent }, { ...scope(), assertCurrent() { if (!current) throw Error("changed"); } })).rejects.toMatchObject({ code: "stale" });
    expect(onEvent).not.toHaveBeenCalled();
  });
  it("BFF Setup preserves terminal handling and strips injected resume identity", async () => {
    const store = new Store(":memory:"); stores.push(store); const f = provisioner();
    const workspaceRoot = mkdtempSync(path.join(tmpdir(), "structured-setup-")); directories.push(workspaceRoot);
    mkdirSync(path.join(workspaceRoot, "acme"));
    writeFileSync(path.join(workspaceRoot, "acme/wren_project.yml"), "name: acme");
    writeFileSync(path.join(workspaceRoot, "acme/.env"), "PASSWORD=synthetic-secret");
    store.setSetupConnectForm({ projectName: "acme", sourceType: "postgres" });
    const session = store.createSession("setup");
    const turn = store.createTurn({ id: "setup-fixture", sessionId: session.id, question: "connect", composedInput: null, setupStepKey: "connect", agentId: "connect_source" });
    const controller = new AbortController();
    const setup = vi.fn(async (options) => {
      expect(options.signal).toBeDefined(); expect(options.signal.aborted).toBe(false);
      return { finalText: "SETUP_STATUS: needs_input - PASSWORD=synthetic-secret", sessionId: "internal-anchor" };
    });
    const h = host({ ...f.adapter, setup });
    const frames: unknown[] = [];
    await streamTurn({ store, structuredRuntime: h.runtime, route: h.localRoute, baseRouteOptions: request, setupRunner: h.localSetup, workspaceRoot } as TurnDeps,
      session.id, turn.id, async (frame) => { frames.push(frame); }, controller.signal);
    expect(setup).toHaveBeenCalledOnce(); expect(h.localSetup.run).not.toHaveBeenCalled();
    expect(store.getTurn(turn.id), JSON.stringify(frames)).toMatchObject({ resultKind: "answer", resumeSessionId: null });
    expect(JSON.stringify(frames)).not.toContain("internal-anchor");
    expect(JSON.stringify(frames)).not.toContain("synthetic-secret");
    expect(frames).toContainEqual(expect.objectContaining({ event: "done" }));
  });

});
