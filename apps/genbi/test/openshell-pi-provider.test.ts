import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Store } from "../server/db.js";
import { OpenShellLifecycle } from "../server/runtime-host/openshell-lifecycle.js";
import { OpenShellError, OPEN_SHELL_OWNER_LABEL, type OpenShellDriver, type OpenShellIntent, type OpenShellResource } from "../server/runtime-host/openshell-types.js";
import { PI_PROC_CHECK_BUDGET_MS, createOpenShellPiProvider, piAccountDigest, piAccountLabel, type PiCleanupReport, type PiProviderConfig } from "../server/runtime-host/openshell-pi-provider.js";
import { PiComponentError, runPiComponentStep, type PiComponentRuntime } from "../server/runtime-host/pi-component-step.js";
import { PI_PROC_CHECK_ARGV, PI_WORKER_ARGV } from "../server/runtime-host/pi-protocol.js";
import type { StepRun } from "../harness/components/runner.js";
import { PiSim, happyBehavior, piWire, rpc, type HappyOptions } from "./pi-sim.js";

const sha = (char: string) => `sha256:${char.repeat(64)}`;
const identity = { image: sha("a"), policy: sha("b"), gateway: "gateway", workspace: "default", configuration: sha("c") };
const providerConfig: PiProviderConfig = { provider: "stub-provider", displayLabel: "stub vendor", profileDigest: sha("d"), generation: "gen-1",
  endpoint: { providerId: "stubvendor", api: "openai-completions", baseUrl: "http://host.example.test:18694/v1", credentialEnv: "STUB_KEY" } };
const schema = { type: "object", properties: { code: { type: "string" } }, required: ["code"], additionalProperties: false };
const roots: string[] = [], stores: Store[] = [], managers: OpenShellLifecycle[] = [];
afterEach(async () => { vi.useRealTimers(); for (const manager of managers.splice(0)) await manager.shutdown().catch(() => {}); for (const store of stores.splice(0)) store.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

class FakeDriver implements OpenShellDriver {
  readonly version = "0.0.1"; readonly identity = identity; readonly modelIdentity = identity;
  readonly resources = new Map<string, OpenShellResource>(); readonly sims: PiSim[] = []; readonly log: string[] = []; readonly intents: OpenShellIntent[] = [];
  behavior: () => ConstructorParameters<typeof PiSim>[0] = () => happyBehavior();
  execResults: string[] = []; removeFails = false; duplexArgv: (readonly string[])[] = [];
  probe = vi.fn(async () => {});
  create = vi.fn(async (intent: OpenShellIntent) => { this.log.push("create"); this.intents.push(intent); const resource = { id: `r-${this.intents.length}`, name: intent.name, workspace: intent.identity.workspace, labels: { [OPEN_SHELL_OWNER_LABEL]: intent.owner } }; this.resources.set(intent.name, resource); return resource; });
  list = vi.fn(async (intent: OpenShellIntent) => [...this.resources.values()].filter(row => row.labels[OPEN_SHELL_OWNER_LABEL] === intent.owner));
  inspect = vi.fn(async (intent: OpenShellIntent) => this.resources.get(intent.name)!);
  remove = vi.fn(async (intent: OpenShellIntent) => { this.log.push("remove"); if (this.removeFails) throw new OpenShellError("openshell_cleanup_pending"); this.resources.delete(intent.name); });
  assertAbsent = vi.fn(async (intent: OpenShellIntent) => { if (this.resources.has(intent.name)) throw new OpenShellError("openshell_cleanup_pending"); });
  exec = vi.fn(async (_intent: OpenShellIntent, argv: readonly string[]) => { this.log.push(`exec ${argv.join(" ")}`); return this.execResults.shift() ?? JSON.stringify({ type: "genbi.pi.procs", version: 1, remaining: 0 }); });
  duplex = vi.fn(async (_intent: OpenShellIntent, argv: readonly string[]) => { this.log.push("duplex"); this.duplexArgv.push(argv); const sim = new PiSim(this.behavior()); this.sims.push(sim); const close = sim.stream.close; sim.stream.close = () => { this.log.push("stream.close"); close(); }; return sim.stream; });
}
async function fixture(overrides: { driver?: Partial<FakeDriver>; config?: Partial<PiProviderConfig> } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "genbi-pi-provider-")); roots.push(root);
  const store = new Store(":memory:"); stores.push(store);
  const driver = Object.assign(new FakeDriver(), overrides.driver);
  const lifecycle = new OpenShellLifecycle({ driver, journal: store, stateRoot: root, exclusive: true }); managers.push(lifecycle); await lifecycle.initialize();
  const config = { ...providerConfig, ...overrides.config };
  const scope = { backend: "openshell" as const, account: piAccountDigest(config), generation: config.generation, session: "session", turn: "turn", binding: "binding", bindingGeneration: "1", bindingRevision: sha("e"), context: sha("f"), plan: sha("1"), ...identity };
  const reports: PiCleanupReport[] = []; let current: typeof scope | undefined = scope;
  const provider = createOpenShellPiProvider({ lifecycle, config, models: { fast: "stub-model" }, scope, currentScope: () => current, assertCurrent() {}, onCleanup: report => reports.push(report) });
  const open = (signal = new AbortController().signal) => provider.open("stub-model", signal, "fast");
  return { root, store, driver, lifecycle, provider, reports, scope, config, open, setCurrent(value: typeof scope | undefined) { current = value; } };
}
function stepRun(options: { tools?: Record<string, (input: unknown) => Promise<unknown>>; signal?: AbortSignal; brief?: string; prompt?: string; input?: Record<string, unknown> } = {}): StepRun {
  const tools = options.tools ?? { lookup: async (input: unknown) => ({ word: "marmalade", input }) };
  return { tier: "fast", request: "ask", input: options.input ?? { q: "hello" }, brief: options.brief ?? "BRIEF", prompt: options.prompt ?? "PROMPT", consumes: {}, children: [], tools,
    toolSchemas: Object.fromEntries(Object.keys(tools).map(name => [name, schema])), toolDescriptions: Object.fromEntries(Object.keys(tools).map(name => [name, `${name} tool`])), signal: options.signal ?? new AbortController().signal };
}
const failure = async (promise: Promise<unknown>) => { try { await promise; } catch (error) { return error instanceof PiComponentError ? error.reason : (error as Error).message; } return undefined; };
const withCall: HappyOptions = { call: { name: "lookup", args: { code: "K7" } } };

describe("pi OpenShell provider: one owned sandbox per step", () => {
  it("runs two synthetic steps, each in its own new sandbox with its own worker, and cleans each up", async () => {
    const f = await fixture(); const seen: unknown[] = [];
    const run = () => stepRun({ tools: { lookup: async input => { seen.push(input); return { word: "marmalade" }; } } });
    const first = await runPiComponentStep(await f.open(), run()); f.driver.behavior = () => happyBehavior({ ...withCall, text: "second answer" });
    f.driver.behavior = () => happyBehavior({ ...withCall, text: "the word is marmalade" });
    const second = await runPiComponentStep(await f.open(), run());
    expect(first).toMatchObject({ value: "answer text" }); expect(second).toMatchObject({ value: "the word is marmalade", usage: { inputTokens: 5, outputTokens: 2 } });
    expect(seen).toEqual([{ code: "K7" }]);
    expect(f.driver.create).toHaveBeenCalledTimes(2); expect(f.driver.intents[0]!.name).not.toBe(f.driver.intents[1]!.name); expect(f.driver.sims).toHaveLength(2); expect(f.driver.remove).toHaveBeenCalledTimes(2);
    expect(f.driver.duplexArgv.every(argv => JSON.stringify(argv) === JSON.stringify(PI_WORKER_ARGV))).toBe(true);
    expect(f.store.listOpenShellIntents().map(intent => intent.phase)).toEqual(["cleaned", "cleaned"]);
    for (const intent of f.driver.intents) expect(intent.identity).toMatchObject({ purpose: "model", operation: "step", snapshot: "none", attempt: 1, model: "stub-model", tier: "fast", ...identity });
    expect(f.reports).toEqual([{ reason: "settled", processes: "not_checked", teardown: "proven" }, { reason: "settled", processes: "not_checked", teardown: "proven" }]);
  });
  it("sends exactly the host instructions as the system prompt and the exact host input as the user message", async () => {
    const f = await fixture(); f.driver.behavior = () => happyBehavior({ finalEvents: (sim, boot) => { sim.emit({ t: "pi", e: { type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: boot.files.systemPrompt }] } } }); sim.emit({ t: "pi", e: { type: "agent_settled" } }); } });
    const response = await runPiComponentStep(await f.open(), stepRun({ brief: "host brief", prompt: "host prompt", tools: {} }));
    expect(response.value).toBe("host brief\n\nhost prompt");
    const boot = f.driver.sims[0]!.boot!; expect(boot.files.systemPrompt).toBe("host brief\n\nhost prompt");
    expect(f.driver.sims[0]!.frames.find(frame => frame.t === "input")).toEqual({ t: "input", text: JSON.stringify({ request: "ask", input: { q: "hello" }, consumes: {} }) });
    await expect(runPiComponentStep(await f.open(), stepRun({ brief: "", prompt: "" }))).rejects.toBeInstanceOf(PiComponentError);
  });
  it("gives a toolless step no tools, no relay server and no tool channel", async () => {
    const f = await fixture(); const handler = vi.fn(); await runPiComponentStep(await f.open(), stepRun({ tools: {} }));
    const boot = f.driver.sims[0]!.boot!; expect(boot.argv).toContain("--no-tools"); expect(boot.argv).not.toContain("--tools");
    expect(JSON.parse(boot.files.mcp).mcpServers).toEqual({}); expect(f.driver.sims[0]!.frames.map(frame => frame.t)).toEqual(["input", "end"]); expect(handler).not.toHaveBeenCalled();
  });
});

describe("pi OpenShell provider: hostile frames never reach a tool", () => {
  const hostile: [string, (sim: PiSim) => void][] = [
    ["an undeclared tool", sim => sim.emit(rpc({ id: 3, method: "tools/call", params: { name: "bash", arguments: { command: "id" } } }))],
    ["a tool that belongs to another step", sim => sim.emit(rpc({ id: 3, method: "tools/call", params: { name: "other", arguments: { code: "x" } } }))],
    ["schema-invalid arguments", sim => sim.emit(rpc({ id: 3, method: "tools/call", params: { name: "lookup", arguments: { code: 7 } } }))],
    ["oversized arguments", sim => sim.emit(rpc({ id: 3, method: "tools/call", params: { name: "lookup", arguments: { code: "x".repeat(70_000) } } }))],
    ["a replayed request id", sim => { sim.emit(rpc({ id: 2, method: "tools/call", params: { name: "lookup", arguments: { code: "x" } } })); }],
    ["a frame larger than a line", sim => sim.emitRaw(Buffer.from(`{"t":"mcp","m":{"pad":"${"a".repeat(2_100_000)}"}}\n`))],
  ];
  it.each(hostile)("rejects %s, invokes no tool and still cleans up", async (_name, attack) => {
    const f = await fixture(); const tool = vi.fn(async () => ({ word: "never" }));
    f.driver.behavior = () => ({ ...happyBehavior({ finalEvents() {} }), onFrame(sim: PiSim, frame) { const happy = happyBehavior({ finalEvents() {} }); if (frame.t === "mcp" && sim.frames.filter(item => item.t === "mcp").length === 2) attack(sim); else happy.onFrame(sim, frame); } });
    expect(await failure(runPiComponentStep(await f.open(), stepRun({ tools: { lookup: tool } })))).toBe("protocol");
    expect(tool).not.toHaveBeenCalled(); expect(f.driver.remove).toHaveBeenCalledTimes(1); expect(f.store.listOpenShellIntents().map(intent => intent.phase)).toEqual(["cleaned"]);
  });
  it("rejects a tool call that arrives before the MCP handshake", async () => {
    const f = await fixture(); const tool = vi.fn(async () => ({ word: "never" })); const base = happyBehavior();
    f.driver.behavior = () => ({ ...base, onFrame(sim: PiSim, frame) { if (frame.t === "input") { sim.emit({ t: "started", scope: sim.boot!.scope, inputSha256: createHash("sha256").update(String(frame.text)).digest("hex") }); sim.emit(rpc({ id: 1, method: "tools/call", params: { name: "lookup", arguments: { code: "x" } } })); } else base.onFrame(sim, frame); } });
    expect(await failure(runPiComponentStep(await f.open(), stepRun({ tools: { lookup: tool } })))).toBe("protocol"); expect(tool).not.toHaveBeenCalled();
  });
  it("rejects a late call after the step settled and a replay of an answered id, running the tool at most once", async () => {
    const f = await fixture(); const tool = vi.fn(async () => ({ word: "once" }));
    f.driver.behavior = () => happyBehavior({ ...withCall, afterSettled: sim => sim.emit(rpc({ id: 3, method: "tools/call", params: { name: "lookup", arguments: { code: "K7" } } })) });
    expect(await failure(runPiComponentStep(await f.open(), stepRun({ tools: { lookup: tool } })))).toBe("protocol");
    expect(tool).toHaveBeenCalledTimes(1);
  });
  it("rejects a call arriving after the host revoked admission", async () => {
    const f = await fixture(); const tool = vi.fn(async () => ({ word: "never" })); const controller = new AbortController();
    f.driver.behavior = () => ({ ...happyBehavior({ finalEvents() {} }), onFrame(sim: PiSim, frame) { happyBehavior({ finalEvents() {} }).onFrame(sim, frame); if (frame.t === "mcp" && sim.frames.filter(item => item.t === "mcp").length === 2) { controller.abort(); sim.emit(rpc({ id: 3, method: "tools/call", params: { name: "lookup", arguments: { code: "K7" } } })); } } });
    expect(await failure(runPiComponentStep(await f.open(), stepRun({ tools: { lookup: tool }, signal: controller.signal })))).toBe("cancelled");
    expect(tool).not.toHaveBeenCalled();
  });
  it("fails the step, runs no further tool and cleans up when a tool itself rejects", async () => {
    const f = await fixture(); f.driver.behavior = () => happyBehavior(withCall);
    expect(await failure(runPiComponentStep(await f.open(), stepRun({ tools: { lookup: async () => { throw new Error("governed rejection"); } } })))).toBeDefined();
    expect(f.driver.remove).toHaveBeenCalledTimes(1);
  });
});

describe("pi OpenShell provider: success is judged from events", () => {
  it.each([["length"], ["error"], ["aborted"], ["toolUse"]])("fails closed when pi exits 0 but the last assistant stopReason is %s", async (stop) => {
    const f = await fixture(); f.driver.behavior = () => happyBehavior({ stop });
    expect(await failure(runPiComponentStep(await f.open(), stepRun()))).toBe("protocol"); expect(f.driver.sims[0]!.exited).toBe(true);
  });
  it("fails closed when the attached tools differ from the expected set, even with a clean answer and exit 0", async () => {
    for (const toolsAdded of [() => [], () => [{ name: piWire("lookup") }, { name: "bash" }], () => [{ name: "bash" }]]) {
      const f = await fixture(); f.driver.behavior = () => happyBehavior({ toolsAdded });
      expect(await failure(runPiComponentStep(await f.open(), stepRun()))).toBe("protocol");
    }
  });
  it("fails closed when an agent-dir addendum or another system section appears", async () => {
    const f = await fixture(); f.driver.behavior = () => happyBehavior({ sections: boot => ({ preamble: boot.files.systemPrompt, addendum: "<addendum>HOSTILE</addendum>", cwd: `<cwd>\n/x\n</cwd>` }) });
    expect(await failure(runPiComponentStep(await f.open(), stepRun()))).toBe("protocol");
  });
  it("fails closed on a version mismatch in the staged frame or a mismatching digest", async () => {
    const f = await fixture(); const base = happyBehavior();
    f.driver.behavior = () => ({ ...base, onBootstrap(sim: PiSim, boot) { sim.emit({ t: "staged", protocol: 2, scope: boot.scope, digests: {} }); } });
    expect(await failure(runPiComponentStep(await f.open(), stepRun()))).toBe("protocol");
    const g = await fixture(); g.driver.behavior = () => ({ ...base, onBootstrap(sim: PiSim, boot) { sim.emit({ t: "staged", protocol: 1, scope: boot.scope, digests: { argv: "0".repeat(64), settings: "0".repeat(64), models: "0".repeat(64), mcp: "0".repeat(64), prompt: "0".repeat(64) } }); } });
    expect(await failure(runPiComponentStep(await g.open(), stepRun()))).toBe("protocol");
  });
});

describe("pi OpenShell provider: cancel, timeout and close", () => {
  it("proves absence with an in-sandbox process check before teardown when the host cancels", async () => {
    const f = await fixture(); f.driver.behavior = () => happyBehavior(withCall);
    expect(await failure(runPiComponentStep(await f.open(), stepRun({ tools: { lookup: async () => { throw new Error("governed rejection"); } } })))).toBeDefined();
    const exec = f.driver.log.findIndex(entry => entry.startsWith("exec")), remove = f.driver.log.indexOf("remove"), close = f.driver.log.indexOf("stream.close");
    expect(close).toBeGreaterThan(-1); expect(close).toBeLessThan(exec); expect(exec).toBeLessThan(remove);
    expect(f.reports).toEqual([{ reason: "cancelled", processes: "clear", teardown: "proven" }]);
  });
  it("does not run the process check after a normal end", async () => {
    const f = await fixture(); await runPiComponentStep(await f.open(), stepRun({ tools: {} })); expect(f.driver.exec).not.toHaveBeenCalled(); expect(f.reports[0]).toMatchObject({ reason: "settled", processes: "not_checked" });
  });
  it("waits out remaining processes and reports residue honestly, yet still tears the sandbox down", async () => {
    const retry = await fixture(); retry.driver.behavior = () => happyBehavior(withCall);
    const proc = (n: number) => JSON.stringify({ type: "genbi.pi.procs", version: 1, remaining: n }); retry.driver.execResults = [proc(2), proc(0)];
    await failure(runPiComponentStep(await retry.open(), stepRun({ tools: { lookup: async () => { throw new Error("x"); } } })));
    expect(retry.reports).toEqual([{ reason: "cancelled", processes: "clear", teardown: "proven" }]); expect(retry.driver.exec).toHaveBeenCalledTimes(2);
    const stuck = await fixture(); stuck.driver.behavior = () => happyBehavior(withCall); stuck.driver.exec = vi.fn(async () => JSON.stringify({ type: "genbi.pi.procs", version: 1, remaining: 1 })) as never;
    await failure(runPiComponentStep(await stuck.open(), stepRun({ tools: { lookup: async () => { throw new Error("x"); } } })));
    expect(stuck.reports).toEqual([{ reason: "cancelled", processes: "residue", teardown: "proven" }]); expect(stuck.driver.remove).toHaveBeenCalledTimes(1);
  }, 15_000);
  it("reports an unreadable process check as unavailable and relies on the teardown proof", async () => {
    const f = await fixture(); f.driver.behavior = () => happyBehavior(withCall); f.driver.execResults = ["not json"];
    await failure(runPiComponentStep(await f.open(), stepRun({ tools: { lookup: async () => { throw new Error("x"); } } })));
    expect(f.reports).toEqual([{ reason: "cancelled", processes: "unavailable", teardown: "proven" }]);
  });
  it("starts the teardown within the cleanup budget when the process-check exec never returns, and reports a timeout, never clear", async () => {
    const f = await fixture(); f.driver.behavior = () => happyBehavior(withCall); f.driver.exec = vi.fn(() => new Promise<string>(() => {})) as never; const runtime = await f.open();
    vi.useFakeTimers(); const running = failure(runPiComponentStep(runtime, stepRun({ tools: { lookup: async () => { throw new Error("x"); } } })));
    await vi.advanceTimersByTimeAsync(1000); expect(f.driver.exec).toHaveBeenCalledTimes(1); expect(f.driver.remove).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(PI_PROC_CHECK_BUDGET_MS); expect(f.driver.remove).toHaveBeenCalledTimes(1);
    expect(f.driver.sims[0]!.closeCalls).toBeGreaterThanOrEqual(1); expect(await running).toBe("protocol"); vi.useRealTimers();
    expect(f.reports).toEqual([{ reason: "cancelled", processes: "timeout", teardown: "proven" }]);
    expect(f.store.listOpenShellIntents().map(intent => intent.phase)).toEqual(["cleaned"]);
  });
  it("ends in a cleanup fault and cleanup_pending, blocking reuse, when the process check hangs and the teardown cannot be proven either", async () => {
    const f = await fixture(); f.driver.behavior = () => happyBehavior(withCall); f.driver.exec = vi.fn(() => new Promise<string>(() => {})) as never; let release!: () => void;
    f.driver.remove = vi.fn(() => new Promise<void>(resolve => { release = resolve; })) as never; const runtime = await f.open();
    vi.useFakeTimers(); const running = failure(runPiComponentStep(runtime, stepRun({ tools: { lookup: async () => { throw new Error("x"); } } })));
    await vi.advanceTimersByTimeAsync(PI_PROC_CHECK_BUDGET_MS + 1000); expect(f.driver.remove).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(20_000); expect(await running).toBe("cleanup"); vi.useRealTimers();
    expect(f.store.listOpenShellIntents().map(intent => intent.phase)).toEqual(["cleanup_pending"]); await expect(f.open()).rejects.toBeInstanceOf(Error); expect(f.driver.create).toHaveBeenCalledTimes(1);
    expect(f.reports.every(report => report.processes !== "clear")).toBe(true);
    f.driver.resources.clear(); release();
  });
  it("tears down on a run abort even though the lifecycle revoked the lease first", async () => {
    const f = await fixture(); const controller = new AbortController(); f.driver.behavior = () => happyBehavior({ finalEvents() {} });
    const running = runPiComponentStep(await f.open(controller.signal), stepRun({ signal: controller.signal })); await vi.waitFor(() => expect(f.driver.sims[0]?.boot).toBeDefined()); controller.abort();
    expect(await failure(running)).toBe("cancelled"); await vi.waitFor(() => expect(f.store.listOpenShellIntents().map(intent => intent.phase)).toEqual(["cleaned"]));
    expect(f.driver.remove).toHaveBeenCalledTimes(1); expect(f.driver.sims[0]!.frames.some(frame => frame.t === "end")).toBe(false);
  });
  it("times a stalled step out at the step deadline, cancels, checks the processes and tears down", async () => {
    const f = await fixture(); f.driver.behavior = () => happyBehavior({ finalEvents() {} }); const runtime = await f.open();
    vi.useFakeTimers(); const running = failure(runPiComponentStep(runtime, stepRun({ tools: { lookup: async () => ({}) } }))); await vi.advanceTimersByTimeAsync(120_000);
    expect(await running).toBe("cancelled"); vi.useRealTimers();
    expect(f.reports).toEqual([{ reason: "cancelled", processes: "clear", teardown: "proven" }]); expect(f.driver.sims[0]!.frames.some(frame => frame.t === "end")).toBe(false); expect(f.driver.remove).toHaveBeenCalledTimes(1);
    expect(f.store.listOpenShellIntents().map(intent => intent.phase)).toEqual(["cleaned"]);
  });
  it("closes a runtime that never ran: the sandbox is torn down and no process check is needed", async () => {
    const f = await fixture(); const runtime = await f.open(); await runtime.close();
    expect(f.driver.remove).toHaveBeenCalledTimes(1); expect(f.driver.exec).not.toHaveBeenCalled(); expect(f.driver.duplex).not.toHaveBeenCalled(); expect(f.store.listOpenShellIntents().map(intent => intent.phase)).toEqual(["cleaned"]);
    expect(await failure(runPiComponentStep(runtime, stepRun({ tools: {} })))).toBeDefined();
  });
  it("leaves cleanup_pending and blocks the next launch when the teardown cannot be proven", async () => {
    const f = await fixture(); f.driver.behavior = () => happyBehavior(); f.driver.removeFails = true;
    expect(await failure(runPiComponentStep(await f.open(), stepRun()))).toBe("cleanup");
    expect(f.reports).toEqual([{ reason: "settled", processes: "not_checked", teardown: "failed" }]);
    expect(f.store.listOpenShellIntents().map(intent => intent.phase)).toEqual(["cleanup_pending"]);
    await expect(f.open()).rejects.toBeInstanceOf(Error); expect(f.driver.create).toHaveBeenCalledTimes(1);
    f.driver.removeFails = false; await f.lifecycle.retryCleanup(); expect(f.store.listOpenShellIntents().map(intent => intent.phase)).toEqual(["cleaned"]); expect(await failure(runPiComponentStep(await f.open(), stepRun({ tools: {} })))).toBeUndefined();
  });
  it("bounds a wedged cleanup instead of waiting forever", async () => {
    vi.useFakeTimers(); const f = await fixture(); f.driver.behavior = () => happyBehavior(); let release!: () => void; f.driver.remove = vi.fn(() => new Promise<void>(resolve => { release = resolve; })) as never;
    const running = failure(runPiComponentStep(await f.open(), stepRun())); await vi.advanceTimersByTimeAsync(20_000); expect(await running).toBe("cleanup");
    vi.useRealTimers(); f.driver.resources.clear(); release();
  });
});

describe("pi OpenShell provider: identity for an API-key vendor", () => {
  it("derives the account from names and digests only and labels it with a fixed non-secret string", async () => {
    const f = await fixture();
    expect(f.provider).toMatchObject({ vendor: "pi", authIdentity: piAccountDigest(providerConfig), generation: "gen-1", accountEmail: "pi (stub vendor)", models: { fast: "stub-model" } });
    expect(piAccountLabel(providerConfig)).toBe("pi (stub vendor)"); expect(piAccountDigest(providerConfig)).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(piAccountDigest({ ...providerConfig, generation: "gen-2" })).not.toBe(piAccountDigest(providerConfig)); expect(piAccountDigest({ ...providerConfig, profileDigest: sha("9") })).not.toBe(piAccountDigest(providerConfig));
    expect(piAccountDigest({ ...providerConfig, provider: "other" })).not.toBe(piAccountDigest(providerConfig));
    expect(JSON.stringify(providerConfig)).not.toMatch(/(?:api[_-]?key|secret|bearer)/i);
  });
  it("refuses to construct when the identity does not match the driver or the configuration", async () => {
    const make = async (patch: (scope: Record<string, unknown>) => void) => {
      const root = mkdtempSync(path.join(tmpdir(), "genbi-pi-provider-")); roots.push(root); const store = new Store(":memory:"); stores.push(store);
      const lifecycle = new OpenShellLifecycle({ driver: new FakeDriver(), journal: store, stateRoot: root, exclusive: true }); managers.push(lifecycle); await lifecycle.initialize();
      const scope: Record<string, unknown> = { backend: "openshell", account: piAccountDigest(providerConfig), generation: "gen-1", session: "s", turn: "t", binding: "b", bindingGeneration: "1", bindingRevision: sha("e"), context: sha("f"), plan: sha("1"), ...identity }; patch(scope);
      return () => createOpenShellPiProvider({ lifecycle, config: providerConfig, models: { fast: "m" }, scope: scope as never, currentScope: () => scope as never, assertCurrent() {} });
    };
    for (const patch of [(s: Record<string, unknown>) => { s.account = sha("0"); }, (s: Record<string, unknown>) => { s.generation = "other"; }, (s: Record<string, unknown>) => { s.image = sha("0"); }, (s: Record<string, unknown>) => { s.policy = sha("0"); }])
      expect((await make(patch))).toThrow();
    expect((await make(() => {}))).not.toThrow();
    expect(() => createOpenShellPiProvider({ lifecycle: { modelIdentity: undefined } as never, config: providerConfig, models: {}, scope: {} as never, currentScope: () => undefined, assertCurrent() {} })).toThrow();
    for (const bad of [{ ...providerConfig, profileDigest: "x" }, { ...providerConfig, endpoint: { ...providerConfig.endpoint, credentialEnv: "bad env" } }, { ...providerConfig, displayLabel: "has\nnewline" }, { ...providerConfig, extra: 1 }])
      expect(() => createOpenShellPiProvider({ lifecycle: { modelIdentity: identity } as never, config: bad as never, models: {}, scope: {} as never, currentScope: () => undefined, assertCurrent() {} })).toThrow();
  });
  it("opens only the captured model for the captured tier and stops when the scope changes", async () => {
    const f = await fixture();
    await expect(f.provider.open("forged-model", new AbortController().signal, "fast")).rejects.toBeInstanceOf(Error);
    await expect(f.provider.open("stub-model", new AbortController().signal, "strong")).rejects.toBeInstanceOf(Error);
    f.setCurrent(undefined); await expect(f.open()).rejects.toBeInstanceOf(Error); expect(f.driver.create).not.toHaveBeenCalled();
  });
});

describe("pi OpenShell provider: runtimes are one-shot and provider-minted", () => {
  it("accepts a structural copy of nothing: only the provider's own runtime, once, for the exact run", async () => {
    const f = await fixture(); const copyOwner = await f.open(); expect(await failure(runPiComponentStep({ ...copyOwner } as PiComponentRuntime, stepRun({ tools: {} })))).toBe("protocol");
    const g = await fixture(); const runtime = await g.open(); const run = stepRun({ tools: {} });
    await runPiComponentStep(runtime, run); expect(await failure(runPiComponentStep(runtime, stepRun({ tools: {} })))).toBe("protocol");
    const h = await fixture(); const other = await h.open(); expect(await failure(runPiComponentStep(other, stepRun({ tools: {}, signal: AbortSignal.abort() })))).toBeDefined();
  });
  it("rejects a run mutated between claim and use, calling neither the original nor the replacement tool", async () => {
    const f = await fixture(); const original = vi.fn(async () => ({ word: "original" })); const replacement = vi.fn(async () => ({ word: "replacement" })); const run = stepRun({ tools: { lookup: original } });
    f.driver.behavior = () => ({ ...happyBehavior({ finalEvents() {} }), onFrame(sim: PiSim, frame) { const happy = happyBehavior({ finalEvents() {} });
      if (frame.t === "mcp" && sim.frames.filter(item => item.t === "mcp").length === 2) { (run.tools as Record<string, unknown>).lookup = replacement; sim.emit(rpc({ id: 3, method: "tools/call", params: { name: "lookup", arguments: { code: "K7" } } })); } else happy.onFrame(sim, frame); } });
    expect(await failure(runPiComponentStep(await f.open(), run))).toBe("protocol"); expect(original).not.toHaveBeenCalled(); expect(replacement).not.toHaveBeenCalled();
  });
  it("rejects a second step and a tier mismatch on one runtime", async () => {
    const f = await fixture(); const runtime = await f.open();
    await expect(Promise.resolve().then(() => runtime.openStep({ ...stepRun(), tier: "strong" }, { signal: new AbortController().signal, onCall() {}, onSettled() {} }))).rejects.toBeInstanceOf(Error);
    await runtime.close().catch(() => {});
  });
});
