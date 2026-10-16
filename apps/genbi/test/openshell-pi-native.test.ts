import { beforeEach, describe, expect, it, vi } from "vitest";
import { createNativeComponentRuntimeBindings, type NativeComponentRuntimeOptions } from "../server/native-component-runtime.js";
import { runPiComponentStep } from "../server/runtime-host/pi-component-step.js";
import { runClaudeComponentStep } from "../server/runtime-host/claude-component-step.js";
import { hashDirectory } from "../harness/compile/fingerprint.js";
import { openWrenComponentAccess } from "../harness/components/wren-access.js";
import type { StepRun, ComponentPlan } from "../harness/components/runner.js";
vi.mock("../server/runtime-host/pi-component-step.js", () => ({ runPiComponentStep: vi.fn(async () => ({ value: "synthetic" })) }));
vi.mock("../server/runtime-host/claude-component-step.js", () => ({ runClaudeComponentStep: vi.fn(async () => ({ value: "synthetic" })) }));
vi.mock("../harness/components/wren-access.js", () => ({ openWrenComponentAccess: vi.fn(async () => { throw Error("Wren must not start in these tests"); }) }));
vi.mock("../harness/compile/fingerprint.js", () => ({ hashDirectory: vi.fn(async () => "fingerprint") }));
const toolless: ComponentPlan = { id: "root", declaration: {}, steps: [{ name: "layout", tier: "fast", prompt: "", produces: "result", consumes: [], tools: [], calls: [] }] };
const tooled: ComponentPlan = { id: "root", declaration: {}, steps: [{ name: "layout", tier: "fast", prompt: "", produces: "result", consumes: [], tools: [{ name: "query", source: "native" }], calls: [] }] };
const run = (signal = new AbortController().signal): StepRun => ({ tier: "fast", request: "synthetic", input: {}, prompt: "", consumes: {}, children: [], tools: {}, toolSchemas: {}, toolDescriptions: {}, signal });
function setup() {
  const identity = { session_id: "synthetic", vendor: "pi", auth_identity: "sha256:account", runtime_generation: "gen-1", binding: { project_identity: "project", generation: "1", revision: "revision" } };
  const close = vi.fn(async () => {});
  const resource = { vendor: "pi" as const, model: "approved-model", tier: "fast", assertCurrent: vi.fn(), openStep: vi.fn(), close };
  const openStep = vi.fn(async () => resource); const open = vi.fn(async () => resource); const openDataAccess = vi.fn(async () => ({ query: vi.fn(), inspect: vi.fn(), close: vi.fn() }));
  const options = { identity, contexts: {}, verifierBinary: "unused", currentIdentity: vi.fn(() => identity), assertCurrent: vi.fn(), openDataAccess,
    vendor: { vendor: "pi", authIdentity: "sha256:account", accountEmail: "pi (stub)", generation: "gen-1", models: { fast: "approved-model" }, assertCurrent: vi.fn(), open, openStep },
    wren: { executable: "/synthetic/wren", project: "/synthetic/project", fingerprint: "fingerprint", identity: { environment: { SECRET: "must-not-reach-vendor" }, digest: "digest", assertCurrent: vi.fn(async () => {}) } },
  } as unknown as NativeComponentRuntimeOptions;
  return { options, open, openStep, openDataAccess, resource, close };
}
beforeEach(() => { vi.clearAllMocks(); vi.mocked(hashDirectory).mockResolvedValue("fingerprint"); });

describe("native component runtime with the pi vendor", () => {
  it("gives a step without tools no query or context grant and never opens data access", async () => {
    const { options, openDataAccess } = setup(); const bindings = createNativeComponentRuntimeBindings(options);
    const access = await bindings.prepare(toolless, {} as never, run().signal);
    await expect(access.query({ sql: "select 1", limit: 1 }, run().signal)).rejects.toThrow("No component query grant");
    await expect(access.inspect({} as never)).rejects.toThrow("No component context grant");
    expect(openDataAccess).not.toHaveBeenCalled(); expect(openWrenComponentAccess).not.toHaveBeenCalled();
    await bindings.prepare(tooled, {} as never, run().signal); expect(openDataAccess).toHaveBeenCalledTimes(1);
  });
  it("opens only the captured model for the step's tier, runs the pi step with the binding check and closes the resource", async () => {
    const { options, openStep, open, close } = setup(); const bindings = createNativeComponentRuntimeBindings(options); const step = run();
    await expect(bindings.step(step, toolless, {} as never)).resolves.toEqual({ value: "synthetic" });
    expect(openStep).toHaveBeenCalledExactlyOnceWith("approved-model", "fast", step.signal); expect(open).not.toHaveBeenCalled();
    expect(runPiComponentStep).toHaveBeenCalledTimes(1); expect(vi.mocked(runPiComponentStep).mock.calls[0]![1]).toBe(step); expect(typeof vi.mocked(runPiComponentStep).mock.calls[0]![2]?.check).toBe("function");
    expect(close).toHaveBeenCalledTimes(1); expect(runClaudeComponentStep).not.toHaveBeenCalled();
  });
  it.each(["model", "account", "generation", "vendor", "binding"])("refuses changed %s before opening a vendor", async (field) => {
    const { options, openStep } = setup(); const bindings = createNativeComponentRuntimeBindings(options);
    if (field === "model") Object.assign(options.vendor.models, { fast: "forged" });
    if (field === "account") Object.assign(options.vendor, { authIdentity: "sha256:forged" });
    if (field === "generation") Object.assign(options.vendor, { generation: "gen-2" });
    if (field === "vendor") Object.assign(options.identity, { vendor: "claude" });
    if (field === "binding") vi.mocked(options.currentIdentity).mockReturnValue({ ...options.identity, runtime_generation: "gen-2" });
    await expect(bindings.step(run(), toolless, {} as never)).rejects.toThrow(); expect(openStep).not.toHaveBeenCalled();
  });
  it("closes a mismatched resource without running it, and refuses a foreign resource shape", async () => {
    const wrongModel = setup(); wrongModel.resource.model = "other-model";
    await expect(createNativeComponentRuntimeBindings(wrongModel.options).step(run(), toolless, {} as never)).rejects.toThrow("mismatch"); expect(wrongModel.close).toHaveBeenCalledTimes(1);
    const foreign = setup(); foreign.openStep.mockResolvedValue({ cwd: "/x", executable: "/x", model: "approved-model", account: { email: "a" }, environment: {}, query: vi.fn(), spawn: vi.fn(), assertCurrent: vi.fn(), close: foreign.close } as never);
    await expect(createNativeComponentRuntimeBindings(foreign.options).step(run(), toolless, {} as never)).rejects.toThrow("vendor mismatch"); expect(foreign.close).toHaveBeenCalledTimes(1);
    expect(runPiComponentStep).not.toHaveBeenCalled(); expect(runClaudeComponentStep).not.toHaveBeenCalled();
  });
  it("closes a resource returned after cancellation without running it, and never reuses a runtime", async () => {
    const { options, openStep, resource, close } = setup(); const bindings = createNativeComponentRuntimeBindings(options); const controller = new AbortController();
    openStep.mockImplementation(async () => { controller.abort(); return resource; });
    await expect(bindings.step(run(controller.signal), toolless, {} as never)).rejects.toThrow(); expect(close).toHaveBeenCalledTimes(1); expect(runPiComponentStep).not.toHaveBeenCalled();
    openStep.mockImplementation(async () => resource); await bindings.step(run(), toolless, {} as never); await expect(bindings.step(run(), toolless, {} as never)).rejects.toThrow("fresh runtime");
  });
  it("does not hand a pi runtime to the Claude branch", async () => {
    const { options } = setup(); (options.vendor as { vendor: string }).vendor = "claude"; (options.identity as { vendor: string }).vendor = "claude";
    await expect(createNativeComponentRuntimeBindings(options).step(run(), toolless, {} as never)).rejects.toThrow("vendor mismatch"); expect(runClaudeComponentStep).not.toHaveBeenCalled();
  });
});
