import { describe, expect, it, vi } from "vitest";
import type { Query, SDKMessage, Options } from "@anthropic-ai/claude-agent-sdk";
import { isClaudeQueryAbort, runClaudeComponentStep, type ClaudeComponentRuntime } from "../server/runtime-host/claude-component-step.js";
import { GovernedWrenError } from "../harness/components/wren-access.js";
import { deriveClaudeNativeRuntime } from "../server/runtime-host/openshell-claude-provider.js";
import type { StepRun } from "../harness/components/runner.js";

const handlers = vi.hoisted(() => new Map<string, (input: unknown) => Promise<unknown>>());
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  tool: (name: string, _description: string, _schema: unknown, callback: (input: unknown) => Promise<unknown>) => { handlers.set(name, callback); return { name }; },
  createSdkMcpServer: () => ({ type: "sdk", name: "component", instance: {} }),
}));
const account = { email: "approved@example.test", tokenSource: "synthetic-subscription", subscriptionType: "synthetic", apiKeySource: "none", apiProvider: "firstParty" as const };
const init = { apiKeySource: "none", type: "system", subtype: "init", uuid: "init", session_id: "session", claude_code_version: "2.1.259", cwd: "/synthetic/work",
  model: "synthetic-model", tools: ["mcp__component__query"], mcp_servers: [{ name: "component", status: "connected" }],
  skills: [], plugins: [], slash_commands: [], permissionMode: "default" };
const result = { type: "result", subtype: "success", uuid: "result", session_id: "session", is_error: false, result: "synthetic answer",
  permission_denials: [], modelUsage: { "synthetic-model": { webSearchRequests: 0, inputTokens: 2, outputTokens: 2, cacheReadInputTokens: 2, cacheCreationInputTokens: 1 } }, usage: { input_tokens: 5, output_tokens: 2 } };
function setup(events: unknown[] = [init, result]) {
  handlers.clear();
  const run: StepRun = { tier: "cheap", request: "synthetic", input: {}, consumes: {}, children: [], prompt: "only this step", signal: new AbortController().signal,
    tools: { query: vi.fn(async () => ({ rows: [{ n: 1 }] })) }, toolDescriptions: {}, toolSchemas: { query: { type: "object", required: ["sql"], properties: { sql: { type: "string" } }, additionalProperties: false } } };
  const pending: unknown[] = [...events];
  let options!: Options;
  let prompt!: AsyncIterable<unknown>;
  const next = vi.fn(async () => {
    const value = pending.shift();
    if (typeof value === "function") await value();
    return { done: false, value: (typeof value === "function" ? pending.shift() : value) as SDKMessage };
  });
  const session = { accountInfo: vi.fn(async () => account), next } as unknown as Query;
  const runtime: ClaudeComponentRuntime = { cwd: "/synthetic/work", executable: "/synthetic/claude", model: "synthetic-model", account,
    environment: { HOME: "/synthetic/home", CLAUDE_CONFIG_DIR: "/synthetic/login", PATH: "/usr/bin:/bin" },
    spawn: vi.fn(() => { throw new Error("process forbidden"); }), query: vi.fn((input) => { options = input.options; prompt = input.prompt; return session; }), assertCurrent: vi.fn(), close: vi.fn(async () => {}) };
  return { run, runtime, session, next, options: () => options, prompt: () => prompt };
}
describe("governed Claude component step", () => {
  it("preserves the local native close path and complete SDK account admission", async () => {
    const test = setup(); const close = vi.fn(async () => { await test.runtime.close(); });
    const wrapper = deriveClaudeNativeRuntime(test.runtime, () => test.runtime.assertCurrent(), close);
    await expect(runClaudeComponentStep(wrapper, test.run)).resolves.toMatchObject({ value: "synthetic answer" });
    expect(close).toHaveBeenCalledTimes(1); expect(test.runtime.close).toHaveBeenCalledTimes(1);
    expect(test.session.accountInfo).toHaveBeenCalledTimes(2);
  });
  it("uses exact tools and isolated input with no default vendor spawn", async () => {
    const test = setup([init, async () => { await handlers.get("query")!({ sql: "SELECT 1" }); }, result]);
    await expect(runClaudeComponentStep(test.runtime, test.run)).resolves.toEqual({ value: "synthetic answer", usage: { inputTokens: 5, outputTokens: 2 } });
    expect(test.run.tools.query).toHaveBeenCalledExactlyOnceWith({ sql: "SELECT 1" });
    expect(test.options()).toMatchObject({ tools: [], allowedTools: ["mcp__component__query"], agents: {}, plugins: [], settingSources: [], persistSession: false, maxTurns: 12 });
    expect(test.runtime.spawn).not.toHaveBeenCalled(); expect(test.runtime.close).toHaveBeenCalledTimes(1);
    expect(test.session.accountInfo).toHaveBeenCalledTimes(2);
  });
  it.each(["identity", "api-key", "missing-source", "third-party", "environment", "revocation"])("denies %s before sending input", async (kind) => {
    const test = setup();
    if (kind === "identity") vi.mocked(test.session.accountInfo).mockResolvedValue({ ...account, email: "other@example.test" });
    if (kind === "api-key") vi.mocked(test.session.accountInfo).mockResolvedValue({ ...account, apiKeySource: "ANTHROPIC_API_KEY" });
    if (kind === "third-party") vi.mocked(test.session.accountInfo).mockResolvedValue({ ...account, apiProvider: "bedrock" });
    if (kind === "missing-source") vi.mocked(test.session.accountInfo).mockResolvedValue({ email: account.email, tokenSource: account.tokenSource, subscriptionType: account.subscriptionType });
    if (kind === "environment") Object.assign(test.runtime.environment, { ANTHROPIC_API_KEY: "synthetic" });
    if (kind === "revocation") vi.mocked(test.runtime.assertCurrent).mockImplementation(() => { throw Error("private"); });
    await expect(runClaudeComponentStep(test.runtime, test.run)).rejects.toThrow("Claude component protocol");
    expect(test.next).not.toHaveBeenCalled(); expect(test.runtime.close).toHaveBeenCalledTimes(1);
  });
  it.each([
    { apiKeySource: "ANTHROPIC_API_KEY" }, { tools: ["Bash"] }, { model: "other" }, { cwd: "/other" }, { claude_code_version: "other" },
    { plugins: [{ name: "extra", path: "/extra" }] }, { skills: ["extra"] }, { mcp_servers: [{ name: "extra", status: "connected" }] },
  ])("denies vendor init authority drift %j", async (changed) => {
    const test = setup([{ ...init, ...changed }, result]);
    await expect(runClaudeComponentStep(test.runtime, test.run)).rejects.toThrow("Claude component protocol"); expect(test.run.tools.query).not.toHaveBeenCalled();
  });
  it("ignores inert thinking progress for local Claude, with the same rules as the host path",async()=>{
    const test=setup([init,{type:"system",subtype:"thinking_tokens",session_id:"session",uuid:"progress",estimated_tokens:2.5,estimated_tokens_delta:0.5},result]);
    await expect(runClaudeComponentStep(test.runtime,test.run)).resolves.toMatchObject({value:"synthetic answer"});
    expect(test.run.tools.query).not.toHaveBeenCalled();expect(test.runtime.close).toHaveBeenCalledTimes(1);
  });
  it("ignores inert rate-limit events for local Claude, with the same rules as the host path",async()=>{
    const test=setup([init,{type:"rate_limit_event",session_id:"session",uuid:"rate",rate_limit_info:{status:"allowed"}},result]);
    await expect(runClaudeComponentStep(test.runtime,test.run)).resolves.toMatchObject({value:"synthetic answer"});
    expect(test.run.tools.query).not.toHaveBeenCalled();expect(test.runtime.close).toHaveBeenCalledTimes(1);
  });
  it("keeps local Claude builtin metadata unavailable", async () => {
    const test=setup([{...init,agents:["Explore","Plan","general-purpose","statusline-setup","claude-code-guide"]},result]);
    await expect(runClaudeComponentStep(test.runtime,test.run)).rejects.toThrow("Claude component protocol");expect(test.run.tools.query).not.toHaveBeenCalled();
  });
  it("fails rather than accepting a model result after tool failure", async () => {
    const test = setup([init, async () => { await handlers.get("query")!({ sql: "SELECT 1" }).catch(() => {}); }, result]);
    vi.mocked(test.run.tools.query!).mockRejectedValue(Error("private"));
    await expect(runClaudeComponentStep(test.runtime, test.run)).rejects.toThrow("Claude component");
  });
  it.each(["query", "unknown", "external-cancel", "cleanup"])("brands only the actual internal governed query abort (%s)", async kind => {
    const controller = new AbortController();
    const test = setup([init, async () => { await handlers.get("query")!({ sql: "SELECT 1" }).catch(() => {}); }, result]);
    vi.mocked(test.run.tools.query!).mockImplementation(async () => { if (kind === "external-cancel") controller.abort(); throw kind === "unknown" ? Error("private data") : new GovernedWrenError("execution_failed"); });
    if (kind === "cleanup") vi.mocked(test.runtime.close).mockRejectedValue(Error("private cleanup"));
    const error = await runClaudeComponentStep(test.runtime, { ...test.run, signal: controller.signal }).catch(error => error);
    expect(isClaudeQueryAbort(error)).toBe(kind === "query");
    expect(isClaudeQueryAbort(structuredClone(error))).toBe(false);
    expect(test.runtime.close).toHaveBeenCalledTimes(1);
  });
  it("denies sibling session events", async () => {
    const test = setup([init, { ...result, session_id: "other" }]);
    await expect(runClaudeComponentStep(test.runtime, test.run)).rejects.toThrow("Claude component protocol");
  });
  it("rechecks account before returning success", async () => {
    const test = setup(); vi.mocked(test.session.accountInfo).mockResolvedValueOnce(account).mockResolvedValueOnce({ ...account, email: "changed@example.test" });
    await expect(runClaudeComponentStep(test.runtime, test.run)).rejects.toThrow("Claude component protocol");
  });
  it("reports cleanup failure even after a valid result", async () => {
    const test = setup(); vi.mocked(test.runtime.close).mockRejectedValue(Error("private"));
    await expect(runClaudeComponentStep(test.runtime, test.run)).rejects.toThrow("Claude component cleanup");
  });
  it("cancels stalled vendor messages and drains its owned runtime", async () => {
    const test = setup(); const controller = new AbortController(); test.next.mockImplementation(() => new Promise(() => {}));
    const pending = runClaudeComponentStep(test.runtime, { ...test.run, signal: controller.signal });
    const rejected = expect(pending).rejects.toThrow("Claude component cancelled");
    await vi.waitFor(() => expect(test.next).toHaveBeenCalled()); controller.abort(); await rejected;
    expect(test.runtime.close).toHaveBeenCalledTimes(1);
  });
  it.each([{ other: result.modelUsage["synthetic-model"] }, {}, { "synthetic-model": { ...result.modelUsage["synthetic-model"], webSearchRequests: 1 } }])("blocks missing or fallback model usage %j", async (modelUsage) => {
    const test = setup([init, { ...result, modelUsage }]);
    await expect(runClaudeComponentStep(test.runtime, test.run)).rejects.toThrow("Claude component protocol");
  });
  it("keeps the prompt closed until approved account information arrives", async () => {
    const test = setup(); let release!: (value: typeof account) => void;
    vi.mocked(test.session.accountInfo).mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const result = runClaudeComponentStep(test.runtime, test.run);
    const input = test.prompt()[Symbol.asyncIterator](); let yielded = false;
    const nextInput = input.next().then((value) => { yielded = true; return value; });
    await Promise.resolve(); expect(yielded).toBe(false); release(account);
    await expect(nextInput).resolves.toMatchObject({ done: false, value: { type: "user" } });
    await result; await expect(input.next()).resolves.toMatchObject({ done: true });
  });

});

const sid = { session_id: "session" };
const assistant = (uuid: string, content: unknown[], extra: Record<string, unknown> = {}) => ({ type: "assistant", uuid, ...sid, parent_tool_use_id: null, message: { content }, ...extra });
const benign: [string, unknown][] = [
  ["thinking_tokens", { type: "system", subtype: "thinking_tokens", uuid: "b1", ...sid, estimated_tokens: 3, estimated_tokens_delta: 1 }],
  ["rate_limit_event", { type: "rate_limit_event", uuid: "b2", ...sid, rate_limit_info: { status: "allowed", utilization: 0.5 } }],
  ["system status", { type: "system", subtype: "status", uuid: "b3", ...sid, status: "requesting" }],
  ["system status (idle)", { type: "system", subtype: "status", uuid: "b4", ...sid, status: null, permissionMode: "default" }],
  ["api_retry", { type: "system", subtype: "api_retry", uuid: "b5", ...sid, attempt: 1, max_retries: 3, retry_delay_ms: 500, error_status: 529, error: "overloaded" }],
  ["session_state_changed", { type: "system", subtype: "session_state_changed", uuid: "b6", ...sid, state: "running" }],
  ["thinking content block", assistant("b7", [{ type: "thinking", thinking: "x" }, { type: "redacted_thinking", data: "x" }, { type: "text", text: "x" }])],
];
const rejected: [string, string, unknown[]][] = [
  ["unexpected_event:system.compact_boundary", "unknown system event", [init, { type: "system", subtype: "compact_boundary", uuid: "x1", ...sid }, result]],
  ["unexpected_event:system.other", "unrecognized system subtype", [init, { type: "system", subtype: "private-model-text", uuid: "x1", ...sid }, result]],
  ["unexpected_event:stream_event", "partial stream event", [init, { type: "stream_event", uuid: "x1", ...sid }, result]],
  ["unexpected_event:tool_progress", "tool progress", [init, { type: "tool_progress", uuid: "x1", ...sid }, result]],
  ["unexpected_event:other", "unrecognized top-level type", [init, { type: "private-model-text", uuid: "x1", ...sid }, result]],
  ["undeclared_tool_use", "undeclared tool_use", [init, assistant("x1", [{ type: "tool_use", id: "t", name: "mcp__component__other", input: {} }]), result]],
  ["permission_denials", "permission denials", [init, { ...result, permission_denials: [{ tool_name: "Bash", tool_use_id: "t", tool_input: {} }] }]],
  ["result_error", "error result", [init, { ...result, is_error: true }]],
  ["result_shape", "malformed result", [init, { ...result, modelUsage: "none" }]],
  ["model_usage_keys", "two models", [init, { ...result, modelUsage: { ...result.modelUsage, other: result.modelUsage["synthetic-model"] } }]],
  ["parent_tool_use", "nested message", [init, assistant("x1", [], { parent_tool_use_id: "t" }), result]],
  ["unexpected_block", "unknown content block", [init, assistant("x1", [{ type: "image" }]), result]],
  ["duplicate_uuid", "repeated uuid", [init, assistant("init", []), result]],
  ["session_mismatch", "foreign session", [init, assistant("x1", [], { session_id: "other" }), result]],
  ["init_duplicate", "second init", [init, { ...init, uuid: "init2" }, result]],
  ["init_tools", "extra init tool", [{ ...init, tools: ["mcp__component__query", "Bash"] }, result]],
  ["schema", "malformed benign event", [init, { type: "system", subtype: "thinking_tokens", uuid: "x1", ...sid, estimated_tokens: "many" }, result]],
  ["schema", "malformed status", [init, { type: "system", subtype: "status", uuid: "x1", ...sid, status: "private-model-text" }, result]],
];
describe("Claude component stream rules (non-host mode)", () => {
  it.each(benign)("ignores the inert %s message without relaxing anything else", async (_name, event) => {
    const test = setup([init, event, result]);
    await expect(runClaudeComponentStep(test.runtime, test.run)).resolves.toMatchObject({ value: "synthetic answer" });
    expect(test.run.tools.query).not.toHaveBeenCalled();
  });
  it("ignores every benign message together between a granted tool call and the result", async () => {
    const test = setup([init, ...benign.map(([, event]) => event), async () => { await handlers.get("query")!({ sql: "SELECT 1" }); }, result]);
    await expect(runClaudeComponentStep(test.runtime, test.run)).resolves.toMatchObject({ value: "synthetic answer" });
    expect(test.run.tools.query).toHaveBeenCalledOnce();
  });
  it.each(rejected)("refuses with the %s site (%s) and the unchanged public error", async (site, _name, events) => {
    const test = setup(events);
    const error = await runClaudeComponentStep(test.runtime, test.run).catch((value: unknown) => value) as Error & { faultSite?: string };
    expect(error).toBeInstanceOf(Error); expect(error.message).toBe("Claude component protocol"); expect(error.faultSite).toBe(site);
    expect(JSON.stringify(error.faultSite)).not.toMatch(/private-model-text/);
  });
  const inertBurst = (count: number) => Array.from({ length: count }, (_v, index) => ({ type: "system", subtype: "session_state_changed", uuid: `m${index}`, ...sid, state: "running" }));
  it("accepts a burst of more than 512 inert events and still returns the original result", async () => {
    const test = setup([init, ...inertBurst(700), result]);
    await expect(runClaudeComponentStep(test.runtime, test.run)).resolves.toMatchObject({ value: "synthetic answer" });
  });
  it("still caps substantive messages at 512 with step_frame_limit and reports closed-vocabulary counts", async () => {
    const many = Array.from({ length: 520 }, (_v, index) => assistant(`s${index}`, [{ type: "text", text: "x" }]));
    const test = setup([init, ...many, result]);
    const error = await runClaudeComponentStep(test.runtime, test.run).catch((value: unknown) => value) as Error & { faultSite?: string; frameCounts?: Record<string, number> };
    expect(error.faultSite).toBe("step_frame_limit");
    expect(error.frameCounts).toEqual({ assistant: 512, "system:init": 1 });
  });
  it("bounds inert events by their own cap with inert_frame_limit", async () => {
    const test = setup([init, ...inertBurst(8193), result]);
    const error = await runClaudeComponentStep(test.runtime, test.run).catch((value: unknown) => value) as Error & { faultSite?: string; frameCounts?: Record<string, number> };
    expect(error.faultSite).toBe("inert_frame_limit"); expect(error.frameCounts).toEqual({ "system:init": 1, "system:session_state_changed": 8193 });
  });
  it("counts hostile type strings and tool_use blocks only under fixed keys", async () => {
    const test = setup([init, assistant("t1", [{ type: "tool_use", id: "t", name: "mcp__component__other", input: {} }]), result]);
    const error = await runClaudeComponentStep(test.runtime, test.run).catch((value: unknown) => value) as Error & { frameCounts?: Record<string, number> };
    expect(error.frameCounts).toEqual({ assistant: 1, tool_use: 1, "system:init": 1 });
    const other = setup([init, { type: "private-model-text", uuid: "p", ...sid }, result]);
    const second = await runClaudeComponentStep(other.runtime, other.run).catch((value: unknown) => value) as Error & { frameCounts?: Record<string, number> };
    expect(second.frameCounts).toEqual({ other: 1, "system:init": 1 }); expect(JSON.stringify(second.frameCounts)).not.toContain("private-model-text");
  });
  it("labels a stream that ends before a result", async () => {
    const test = setup([init]); test.next.mockImplementationOnce(async () => ({ done: false, value: init as unknown as SDKMessage })).mockImplementation(async () => ({ done: true, value: undefined as unknown as SDKMessage }));
    const error = await runClaudeComponentStep(test.runtime, test.run).catch((value: unknown) => value) as Error & { faultSite?: string };
    expect(error.message).toBe("Claude component protocol"); expect(error.faultSite).toBe("stream_ended");
  });
  it("a granted tool call after a benign event is still schema-validated and counted", async () => {
    const test = setup([init, benign[0]![1], async () => { await handlers.get("query")!({ sql: "SELECT 1" }); }, result]);
    await runClaudeComponentStep(test.runtime, test.run);
    expect(test.run.tools.query).toHaveBeenCalledExactlyOnceWith({ sql: "SELECT 1" });
  });
});

describe("component failure log", () => {
  it("carries the closed fault_site label next to the unchanged public detail", async () => {
    const { ComponentRunner } = await import("../harness/components/runner.js");
    const test = setup([init, assistant("x1", [{ type: "tool_use", id: "t", name: "mcp__component__other", input: {} }]), result]);
    const plan = { identity: "plan", entries: ["c"], components: { c: { id: "c", declaration: {}, steps: [{ name: "s", tier: "cheap", prompt: "p", consumes: [], produces: "o", tools: [], calls: [] }] } } };
    const host = { prepare: async () => ({ tools: [], isCurrent: () => true, normalize: async () => ({ status: "ok" as const, output: { kind: "value" as const, value: 1 } }), close: async () => {} }),
      runStep: async () => runClaudeComponentStep(test.runtime, test.run) };
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    let lines: string[] = [];
    try { await new ComponentRunner(plan as never, host as never).run("c", { request: "x" }); } finally { lines = log.mock.calls.map((call) => String(call[0])); log.mockRestore(); }
    const line = lines.find((text) => text.includes("[component-failure]") && text.includes("Claude component protocol"));
    expect(line).toContain('"fault_site":"undeclared_tool_use"');
    expect(line).toContain('"frame_counts":{"assistant":1,"tool_use":1,"system:init":1}');
  });
});
