import { mkdirSync, mkdtempSync, writeFileSync, existsSync, rmSync, realpathSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCodexRuntimeComposition, readCodexBootConfiguration } from "../server/codex-runtime-composition.js";
import { CodexAppServerBackend } from "../server/runtime-host/codex-app-server.js";
import { runtimeReady, runtimeNotReady } from "../server/runtime-host/policy.js";
import { buildCodexSessionPolicy } from "../server/runtime-host/codex-policy.js";
import { compileProfile } from "../harness/compile/index.js";
import { resolveContextLoaderBinary } from "../harness/compile/context-loader.js";
import { prepareCapturedCodexDirectTools } from "../server/native-component-context.js";
import { isCodexExecutionCertified } from "../server/runtime-host/codex-compatibility.js";
import { Store } from "../server/db.js";
import type { NativeArtifactService } from "../server/native-artifacts.js";
import type { NativeSessionRow } from "../server/db.js";
vi.mock("../server/runtime-host/codex-compatibility.js", async (original) => ({
  ...(await original<typeof import("../server/runtime-host/codex-compatibility.js")>()), isCodexExecutionCertified: vi.fn(() => true), isCodexTerminalCertified: vi.fn(() => true),
}));
vi.mock("../harness/compile/index.js", () => ({ compileProfile: vi.fn() }));
vi.mock("../harness/compile/context-loader.js", () => ({ resolveContextLoaderBinary: vi.fn() }));
vi.mock("../server/native-component-context.js", () => ({ prepareCapturedCodexDirectTools: vi.fn() }));
vi.mock("../server/runtime-host/codex-policy.js", () => ({ buildCodexSessionPolicy: vi.fn() }));
vi.mock("../server/runtime-host/codex-app-server.js", async (original) => {
  const actual = await original<typeof import("../server/runtime-host/codex-app-server.js")>();
  return { ...actual, CodexAppServerBackend: vi.fn() };
});
const roots: string[] = [], stores: Store[] = [];
afterEach(() => { stores.splice(0).forEach((store) => store.close()); roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })); });
beforeEach(() => { vi.clearAllMocks(); vi.mocked(isCodexExecutionCertified).mockReturnValue(true); });
function fixture() {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "codex-composition-test-"))); roots.push(root);
  const login = path.join(root, "login"), project = path.join(root, "project");
  mkdirSync(login, { mode: 0o700 }); mkdirSync(project);
  writeFileSync(path.join(login, "auth.json"), "fixture-not-a-login", { mode: 0o600 });
  const ir = path.join(root, "ir.json"); writeFileSync(ir, "{}");
  // These attested roles never execute through the mocked backend/compiler.
  // Avoid repeatedly hashing the full Node binary for every synthetic role.
  const executable = path.join(root, "fixture-runtime"); writeFileSync(executable, "#!/bin/sh\nexit 1\n", { mode: 0o700 });
  vi.mocked(resolveContextLoaderBinary).mockReturnValue(executable);
  const runtime = { launcher: executable, venv_python: executable };
  const permit = { runtime, assertActive: vi.fn(), release: vi.fn() };
  const transport = { write: vi.fn(), listen: vi.fn(), close: vi.fn(async () => {}) };
  const backend = { probe: vi.fn(async () => ({ readiness: runtimeReady("fixture", []), diagnostic: { phase: "capability" } })),
    prepareLaunch: vi.fn(() => permit), open: vi.fn(), openStep: vi.fn(() => ({ transport, policy: {} })), shutdown: vi.fn(async () => {}) };
  vi.mocked(CodexAppServerBackend).mockImplementation(function () { return backend as never; });
  vi.mocked(compileProfile).mockResolvedValue({ irPath: ir } as never);
  const tools = { accountEmail: "fixture@example.invalid", definitions: [], assertCurrent: vi.fn(), call: vi.fn(), close: vi.fn(async () => {}) };
  vi.mocked(prepareCapturedCodexDirectTools).mockResolvedValue(tools);
  const store = new Store(":memory:"); stores.push(store);
  store.setRuntimeSettings({ ...store.getRuntimeSettings(), authMode: "subscription", subscriptionProvider: "codex", subscriptionDriverModel: "driver", apiKeyModel: "step" });
  let binding = { identity: "project", path: project, generation: 1, revision: "v1" };
  const artifacts = { issue: vi.fn(() => ({ credential: "host-only" })), revoke: vi.fn(), save: vi.fn(), persistAnswer: vi.fn() };
  const composition = createCodexRuntimeComposition({ configuration: readCodexBootConfiguration({ GENBI_CODEX_RUNTIME: "app-server", GENBI_CODEX_EXECUTABLE: executable,
    GENBI_CODEX_SOURCE: "https://example.invalid/codex", WREN_HARNESS_CODEX_HOME: login, GENBI_CODEX_ACCOUNT_EMAIL: "fixture@example.invalid" }),
    packageRoot: root, producerBinary: executable, profileSource: "fixture", store, getBinding: () => binding, sourceWrenHome: () => path.join(root, "wren-home"), artifacts: artifacts as unknown as NativeArtifactService });
  const controller = new AbortController();
  const input = { options: { authChoice: { mode: "subscription" as const, provider: "codex" as const }, profileSource: "fixture", userProject: project, question: "count" },
    scope: { sessionId: "session", turnId: "turn", signal: controller.signal, assertCurrent: vi.fn() }, permit: permit as never };
  return { root, store, tools, composition, input, permit, backend, controller, artifacts, transport, binding, changeBinding() { binding = { ...binding, revision: "v2" }; } };
}
describe("Codex application composition", () => {
  it("defaults local and rejects invalid selection without coercing it to local", () => {
    expect(readCodexBootConfiguration({})).toEqual({ selected: "local", allowLocal: true });
    expect(readCodexBootConfiguration({ GENBI_CODEX_RUNTIME: "app-server", GENBI_ALLOW_LOCAL_RUNTIME: "0" })).toMatchObject({ selected: "codex-app-server", allowLocal: false });
    expect(() => readCodexBootConfiguration({ GENBI_CODEX_RUNTIME: "auto" })).toThrow();
    expect(() => readCodexBootConfiguration({ GENBI_ALLOW_LOCAL_RUNTIME: "false" })).toThrow();
  });
  it("projects the backend certification failure without allocating or compiling", async () => {
    const f = fixture(); f.backend.probe.mockResolvedValue({ readiness: runtimeNotReady("codex-app-server", "incompatible", "codex_identity_uncertified"), diagnostic: { phase: "identity" } } as never);
    expect((await f.composition.probe()).readiness).toMatchObject({ code: "codex_identity_uncertified" });
    expect(compileProfile).not.toHaveBeenCalled(); expect(prepareCapturedCodexDirectTools).not.toHaveBeenCalled();
  });
  it("denies uncertified execution scope before readiness or any materialization", async () => {
    const f = fixture(); vi.mocked(isCodexExecutionCertified).mockReturnValue(false);
    expect((await f.composition.probe()).readiness.state).not.toBe("ready");
    await expect(f.composition.structured.prepare(f.input)).rejects.toThrow();
    await expect(f.composition.native.prepare({ session: { id: "session", entryVerb: "generate_dashboard" } as NativeSessionRow,
      binding: f.binding, permit: f.input.permit, signal: f.controller.signal, assertActive() {} })).rejects.toThrow();
    expect(isCodexExecutionCertified).toHaveBeenCalledWith("https://example.invalid/codex", expect.any(String), ["driver", "step", "step"], "generate_dashboard");
    expect(f.artifacts.issue).not.toHaveBeenCalled(); expect(compileProfile).not.toHaveBeenCalled();
    expect(f.backend.openStep).not.toHaveBeenCalled();
  });
  it("prepares an isolated workspace with exact model and host-only Wren environment", async () => {
    const f = fixture(); const result = await f.composition.structured.prepare(f.input); roots.push(path.dirname(result.input.spec.workspace));
    expect(result.input.model).toBe("driver"); expect(result.input.spec.workspace).not.toBe(f.binding.path);
    expect(result.input.spec.childEnvironment.HOME).not.toBe(os.homedir());
    expect(result.input.spec.childEnvironment.CODEX_HOME).toBe(path.join(f.root, "login"));
    expect(result.input.spec.toolDirectories).toEqual([...new Set([path.dirname(realpathSync(process.execPath)), realpathSync("/usr/bin"), realpathSync("/bin"), f.root])]);
    expect(buildCodexSessionPolicy).toHaveBeenCalledBefore(vi.mocked(compileProfile));
    const captured = vi.mocked(prepareCapturedCodexDirectTools).mock.calls[0]![2];
    expect(captured.wrenEnvironment).toMatchObject({ WREN_PROJECT_HOME: f.binding.path, WREN_HOME: path.join(f.root, "wren-home") });
    expect(captured.wrenEnvironment).not.toHaveProperty("CODEX_HOME");
    expect(captured.wrenEnvironment).not.toHaveProperty("ANTHROPIC_BASE_URL");
    expect(captured.vendor.models).toEqual({ cheap: "step", strong: "step" });
    expect(f.backend.openStep).not.toHaveBeenCalled();
    await result.input.tools.close(); await result.dispose(); expect(existsSync(result.input.spec.workspace)).toBe(false);
  });
  it("keeps cheap scope checks separate while disk tampering still blocks the next protected operation", async () => {
    const f = fixture(); const result = await f.composition.structured.prepare(f.input); roots.push(path.dirname(result.input.spec.workspace));
    const captured = vi.mocked(prepareCapturedCodexDirectTools).mock.calls[0]![2];
    writeFileSync(path.join(f.root, "fixture-runtime"), "tampered");
    expect(() => captured.assertLive!()).not.toThrow();
    expect(() => captured.assertCurrent()).toThrow();
    await expect(captured.vendor.open("step", f.controller.signal)).rejects.toThrow();
    expect(f.backend.openStep).not.toHaveBeenCalled();
    f.changeBinding(); expect(() => captured.assertLive!()).toThrow();
    await result.input.tools.close(); await result.dispose();
  });
  it.each(["binding", "settings", "cancel"])("rejects %s changes after preparation", async (change) => {
    const f = fixture(); const result = await f.composition.structured.prepare(f.input); roots.push(path.dirname(result.input.spec.workspace));
    if (change === "binding") f.changeBinding();
    if (change === "settings") f.store.setRuntimeSettings({ ...f.store.getRuntimeSettings(), subscriptionDriverModel: "changed" });
    if (change === "cancel") f.controller.abort();
    expect(() => result.input.assertScopeActive()).toThrow();
    await result.input.tools.close(); await result.dispose();
  });
  it("closes component resources and retains allocations when cleanup fails", async () => {
    const f = fixture(); const result = await f.composition.structured.prepare(f.input); roots.push(path.dirname(result.input.spec.workspace));
    const options = vi.mocked(prepareCapturedCodexDirectTools).mock.calls[0]![2];
    await options.vendor.open("step", f.controller.signal);
    f.transport.close.mockRejectedValue(Error("cleanup"));
    await expect(result.input.tools.close()).rejects.toThrow(); await expect(result.dispose()).rejects.toThrow();
    expect(existsSync(result.input.spec.workspace)).toBe(true);
  });
  it("cleans allocations when cancellation arrives during compile", async () => {
    const f = fixture(); let workspace = "";
    vi.mocked(compileProfile).mockImplementation(async () => {
      workspace = vi.mocked(buildCodexSessionPolicy).mock.calls[0]![0].workspace; f.controller.abort(); return { irPath: "unused" } as never;
    });
    await expect(f.composition.structured.prepare(f.input)).rejects.toThrow(); expect(existsSync(workspace)).toBe(false);
    expect(prepareCapturedCodexDirectTools).not.toHaveBeenCalled();
  });
  it("checks permits before native credentials and refuses unsupported roots", async () => {
    const f = fixture(); f.permit.assertActive.mockImplementation(() => { throw Error("expired"); });
    await expect(f.composition.native.prepare({ session: { id: "session", entryVerb: "answer_query" } as NativeSessionRow, binding: f.binding,
      permit: f.input.permit, signal: f.controller.signal, assertActive() {} })).rejects.toThrow();
    expect(f.artifacts.issue).not.toHaveBeenCalled(); expect(compileProfile).not.toHaveBeenCalled();
  });
  it.each([
    [{ revenue: 1672, order_count: 99 }],
    [[99, 1672]],
  ])("persists verified query rows in the artifact service supported shape: %j", async (row) => {
    const f = fixture(); const prepared = await f.composition.native.prepare({ session: { id: "session", entryVerb: "answer_query" } as NativeSessionRow,
      binding: f.binding, permit: f.input.permit, signal: f.controller.signal, assertActive() {} }); roots.push(path.dirname(prepared.input.spec.workspace));
    const sink = vi.mocked(prepareCapturedCodexDirectTools).mock.calls[0]![2].persistRoot!;
    const value = { columns: ["order_count", "revenue"], rows: [row] };
    const result = { status: "ok" as const, output: { kind: "value" as const, value }, provenance: { verified: false } };
    await sink(result, {} as never, f.controller.signal);
    expect(f.artifacts.persistAnswer).not.toHaveBeenCalled();
    await sink({ ...result, provenance: { verified: true } }, {} as never, f.controller.signal);
    expect(f.artifacts.persistAnswer).toHaveBeenCalledWith("host-only", expect.objectContaining({
      envelope: { blocks: [{ type: "table", ...value }], verified: true },
    }));
    await prepared.input.tools.close(); await prepared.dispose();
  });
  it("uses the native artifact sink only for verified root results and revokes its credential", async () => {
    const f = fixture(); const prepared = await f.composition.native.prepare({ session: { id: "session", entryVerb: "generate_dashboard" } as NativeSessionRow,
      binding: f.binding, permit: f.input.permit, signal: f.controller.signal, assertActive() {} }); roots.push(path.dirname(prepared.input.spec.workspace));
    const sink = vi.mocked(prepareCapturedCodexDirectTools).mock.calls[0]![2].persistRoot!;
    await sink({ status: "ok", output: { kind: "render", blocks: [] }, provenance: { verified: false } }, {} as never, f.controller.signal);
    expect(f.artifacts.save).not.toHaveBeenCalled();
    await sink({ status: "ok", output: { kind: "render", blocks: [] }, provenance: { verified: true } }, {} as never, f.controller.signal);
    expect(f.artifacts.save).toHaveBeenCalledOnce();
    await prepared.input.tools.close(); await prepared.dispose(); expect(f.artifacts.revoke).toHaveBeenCalledWith("host-only");
  });
});
