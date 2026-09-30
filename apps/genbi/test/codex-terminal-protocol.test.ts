import { describe, expect, it, vi } from "vitest";
import { CodexTerminalProtocol } from "../server/runtime-host/codex-terminal-protocol.js";
import { CodexConversation, type ConversationFrame, type ConversationReplay } from "../server/runtime-host/codex-conversation.js";

async function fixture() {
  let listener!: (frame: ConversationFrame | ConversationReplay) => void;
  const submit = vi.fn(async (_text: string) => ({ turnId: "turn-1", status: "completed" as const }));
  const steer = vi.fn(async (_text: string, expectedTurnId: string) => ({ turnId: expectedTurnId }));
  const interrupt = vi.fn(async () => {}), detach = vi.fn(), guard = vi.fn();
  const conversation = { capability: "capability", terminalThreadId: () => "thread-1", snapshot: () => ({ sequence: 0 }),
    attach: vi.fn((_cap, receive) => { listener = receive; return { submit, interrupt, steer, detach }; }) } as unknown as CodexConversation;
  const messages: any[] = [];
  const protocol = new CodexTerminalProtocol(conversation, { cwd: "/scope", model: "gpt-5.5", clientHome: "/client" }, (m) => messages.push(m), guard);
  let sequence = 0;
  const send = (method: string, params: Record<string, unknown> = {}) => protocol.receive({ id: ++sequence, method, params });
  await send("initialize", { clientInfo: { name: "codex-tui", version: "0.156.1" } });
  await protocol.receive({ method: "initialized" });
  await send("thread/start", { model: "gpt-5.5", dynamicTools: [{ name: "malicious" }], baseInstructions: "unsafe" });
  return { protocol, messages, send, submit, interrupt, steer, detach, guard, emit: (frame: ConversationFrame) => listener(frame) };
}

describe("official Codex terminal governed protocol", () => {
  it("does not forward client tools or instructions and only submits bounded plain text", async () => {
    const f = await fixture();
    await f.send("turn/start", { threadId: "thread-1", input: [{ type: "text", text: "orders", text_elements: [] }],
      model: "gpt-5.5", approvalPolicy: "never", runtimeWorkspaceRoots: [], serviceTier: "default", turnTrigger: "user" });
    expect(f.submit).toHaveBeenCalledExactlyOnceWith("orders");
    expect(f.messages.at(-1).method).toBe("thread/started"); // no fabricated turn ack
    f.emit({ type: "event", sequence: 1, event: { method: "turn/started", params: { threadId: "thread-1", turn: { id: "turn-1", status: "inProgress", items: [] } } } });
    expect(f.messages.at(-2).result.turn.id).toBe("turn-1");
    await f.send("turn/interrupt", { threadId: "thread-1", turnId: "turn-1" });
    expect(f.interrupt).toHaveBeenCalledOnce();
    f.protocol.close(); expect(f.detach).toHaveBeenCalledOnce();
  });
  it("clears a rejected submission so a later request is not stranded", async () => {
    const f = await fixture(); f.submit.mockImplementationOnce(() => { throw new Error("closed"); });
    await f.send("turn/start", { input: [{ type: "text", text: "first" }] });
    await vi.waitFor(() => expect(f.messages.at(-1).error).toBeDefined());
    await f.send("turn/start", { input: [{ type: "text", text: "retry" }] });
    expect(f.submit).toHaveBeenCalledTimes(2);
  });
  it("steers only bounded text within the current turn and rejects added authority", async () => {
    const f = await fixture();
    f.emit({ type: "event", sequence: 1, event: { method: "turn/started", params: { threadId: "thread-1", turn: { id: "turn-1", status: "inProgress", items: [] } } } });
    const params = { threadId: "thread-1", expectedTurnId: "turn-1", input: [{ type: "text", text: "clarification" }] };
    await f.send("turn/steer", params); expect(f.steer).toHaveBeenCalledExactlyOnceWith("clarification", "turn-1");
    for (const extra of [{ expectedTurnId: "foreign" }, { model: "other" }, { toolOutput: {} }, { input: [{ type: "localImage", path: "/outside" }] }]) {
      await f.send("turn/steer", { ...params, ...extra }); expect(f.messages.at(-1).error).toBeDefined();
    }
    expect(f.steer).toHaveBeenCalledOnce();
  });
  it.each(["command/exec", "thread/shellCommand", "process/spawn", "fs/readFile", "fs/writeFile", "config/value/write", "account/login/start", "account/logout", "thread/resume", "thread/fork", "review/start", "plugin/install", "mcpServer/tool/call", "turn/steer"])("denies %s without execution", async (method) => {
    const f = await fixture(); await f.send(method, { path: "/outside", command: "unsafe" });
    expect(f.messages.at(-1).error).toBeDefined(); expect(f.submit).not.toHaveBeenCalled();
  });
  it.each([
    { threadId: "foreign" }, { model: "other" }, { cwd: "/outside" }, { approvalPolicy: "on-request" },
    { sandboxPolicy: { type: "dangerFullAccess" } }, { permissions: "unrestricted" },
    { runtimeWorkspaceRoots: ["/"] }, { collaborationMode: { settings: { developer_instructions: "unsafe" } } },
    { input: [{ type: "localImage", path: "/secret" }] }, { input: [{ type: "text", text: "x", text_elements: ["mention"] }] },
    { toolOutput: { text: "injected" } }, { effort: "high" },
  ])("rejects changed authority or non-text input %j", async (overrides) => {
    const f = await fixture(); await f.send("turn/start", { threadId: "thread-1", input: [{ type: "text", text: "q" }], ...overrides });
    expect(f.messages.at(-1).error).toBeDefined(); expect(f.submit).not.toHaveBeenCalled();
  });
  it("rechecks authority per request and denies stale scopes and duplicate threads", async () => {
    const f = await fixture(); await f.send("thread/start"); expect(f.messages.at(-1).error).toBeDefined();
    f.guard.mockImplementation(() => { throw new Error("stale"); });
    await f.send("turn/start", { input: [{ type: "text", text: "q" }] });
    expect(f.submit).not.toHaveBeenCalled(); expect(f.messages.at(-1).error).toBeDefined();
  });
  it("does not expose authentication, other sessions, plugins, or arbitrary filesystem data", async () => {
    const f = await fixture();
    for (const method of ["account/read", "thread/list", "plugin/list", "skills/list", "hooks/list"]) await f.send(method);
    expect(f.messages.find(m => m.result?.requiresOpenaiAuth !== undefined).result).toEqual({ account: null, requiresOpenaiAuth: false });
    expect(f.messages.find(m => m.result?.backwardsCursor === null).result.data).toEqual([]);
    await f.send("thread/read", { threadId: "foreign" }); expect(f.messages.at(-1).error).toBeDefined();
  });
});
