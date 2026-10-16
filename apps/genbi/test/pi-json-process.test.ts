import { afterEach, describe, expect, it, vi } from "vitest";
import { PiStepChannel, type PiToolCall } from "../server/runtime-host/pi-json-process.js";
import { PI_TRANSPORT_LIMITS as L, PiProtocolFault, PiStepProtocol, buildPiBootstrap, type PiStepSpec } from "../server/runtime-host/pi-protocol.js";
import { PiSim, happyBehavior } from "./pi-sim.js";

const scope = "11111111-2222-4333-8444-555555555555";
const token = "cd".repeat(16);
const schema = { type: "object", properties: { code: { type: "string" } }, required: ["code"], additionalProperties: false };
const spec: PiStepSpec = { scope, model: "stub-model", endpoint: { providerId: "stubvendor", api: "openai-completions", baseUrl: "http://host.example.test:18694/v1", credentialEnv: "STUB_KEY" }, systemPrompt: "HOST PROMPT", tools: ["lookup"] };
const run = { tools: { lookup: async () => 1 }, toolSchemas: { lookup: schema }, toolDescriptions: { lookup: "d" }, request: "ask", input: { q: 1 }, consumes: {} };
const channels: PiStepChannel[] = [];
afterEach(async () => { vi.useRealTimers(); for (const channel of channels.splice(0)) await channel.close().catch(() => {}); });
function setup(sim: PiSim, extra: { protocol?: PiStepProtocol; cleanup?: (reason: string) => Promise<void>; onCall?: (call: PiToolCall) => void; onSettled?: () => void; bootstrap?: Buffer; connect?: () => Promise<PiSim["stream"]> } = {}) {
  const controller = new AbortController();
  const protocol = extra.protocol ?? new PiStepProtocol({ run, spec, token, check() {} });
  const cleanup = vi.fn(extra.cleanup ?? (async () => {}));
  const onCall = vi.fn(extra.onCall ?? (() => {})); const onSettled = vi.fn(extra.onSettled ?? (() => {}));
  const channel = new PiStepChannel({ signal: controller.signal, protocol, bootstrap: extra.bootstrap ?? buildPiBootstrap(spec, token), connect: extra.connect ?? (async () => sim.stream), check() {}, cleanup, onCall, onSettled });
  channels.push(channel);
  return { channel, controller, protocol, cleanup, onCall, onSettled };
}
const mockProtocol = (overrides: Record<string, unknown> = {}) => ({ worker: vi.fn(() => ({ kind: "none" })), host: vi.fn(), hasExited: false, ...overrides }) as unknown as PiStepProtocol;
const fault = async (promise: Promise<unknown>) => { try { await promise; } catch (error) { return error instanceof PiProtocolFault ? error.code : "other"; } return undefined; };

describe("pi step channel: in-band end versus cancel", () => {
  it("ends through the sentinel: settled, end frame, exit frame, then a real exit event with status 0", async () => {
    const sim = new PiSim(happyBehavior({ call: { name: "lookup", args: { code: "K7" } } }));
    let channel!: PiStepChannel; let protocol!: PiStepProtocol;
    const f = setup(sim, { onCall(call) { channel.send(protocol.answer(call.id, { ok: true })); }, onSettled() { channel.send({ t: "end" }); } });
    channel = f.channel; protocol = f.protocol;
    await f.channel.finished;
    expect(sim.closeCalls).toBe(0); expect(sim.exited).toBe(true);
    expect(f.onCall).toHaveBeenCalledTimes(1); expect(f.onSettled).toHaveBeenCalledTimes(1);
    expect(protocol.result()).toMatchObject({ value: "answer text" });
    expect(sim.frames.map(frame => frame.t)).toEqual(["input", "mcp", "mcp", "mcp", "end"]);
    await f.channel.close(); expect(f.cleanup).toHaveBeenCalledExactlyOnceWith("settled"); expect(f.channel.failure).toBeUndefined();
  });
  it("treats an exit event without the worker's exit frame as a protocol failure", async () => {
    const sim = new PiSim({ onBootstrap(s) { s.exit(0); } });
    const f = setup(sim); expect(await fault(f.channel.finished)).toBe("protocol"); await expect(f.channel.close()).resolves.toBeUndefined(); expect(f.cleanup).toHaveBeenCalledExactlyOnceWith("cancelled");
  });
  it("rejects a non-zero exit status even after a clean exit frame", async () => {
    const sim = new PiSim(happyBehavior({ onExit() {} }));
    const behavior = happyBehavior(); const original = behavior.onFrame;
    const bad = new PiSim({ onBootstrap: behavior.onBootstrap, onFrame(s, frame) { if (frame.t === "end") { s.emit({ t: "exit", scope, code: 0, signal: null, forced: false, remaining: 0 }); s.exit(3); } else original(s, frame); } });
    void sim; let channel!: PiStepChannel; const f = setup(bad, { onSettled() { channel.send({ t: "end" }); } }); channel = f.channel;
    expect(await fault(f.channel.finished)).toBe("protocol");
  });
  it("uses cancellation only for abort: the stream is closed, no end frame is sent and cleanup learns it was a cancel", async () => {
    const sim = new PiSim(happyBehavior({ finalEvents() {} }));
    const f = setup(sim); await vi.waitFor(() => expect(sim.boot).toBeDefined());
    f.controller.abort();
    expect(await fault(f.channel.finished)).toBe("cancelled");
    expect(sim.closeCalls).toBeGreaterThanOrEqual(1); expect(sim.frames.some(frame => frame.t === "end")).toBe(false);
    await f.channel.close(); expect(f.cleanup).toHaveBeenCalledExactlyOnceWith("cancelled"); expect(f.channel.killed).toBe(true);
  });
  it("revokes admission before cleanup: nothing is written after an abort and a late send is refused by the channel itself", async () => {
    const sim = new PiSim(); const order: string[] = [];
    const f = setup(sim, { protocol: mockProtocol(), cleanup: async () => { order.push(sim.closeCalls >= 1 ? "cleanup after close" : "cleanup before close"); } });
    await vi.waitFor(() => expect(sim.writes.length).toBe(1)); f.channel.send({ t: "end" }); expect(sim.writes.length).toBe(2);
    const before = sim.writes.length; f.controller.abort();
    expect(() => f.channel.send({ t: "end" })).toThrow(PiProtocolFault); expect(sim.writes.length).toBe(before);
    await f.channel.close().catch(() => {}); expect(order).toEqual(["cleanup after close"]);
  });
  it("closes the transport and fails when the worker closes without an exit event", async () => {
    const sim = new PiSim(happyBehavior({ finalEvents() {} })); const f = setup(sim); await vi.waitFor(() => expect(sim.boot).toBeDefined()); sim.finish();
    expect(await fault(f.channel.finished)).toBe("protocol");
  });
  it("fails the step when a worker frame breaks the protocol, without surfacing the frame", async () => {
    const sim = new PiSim({ onBootstrap(s) { s.emit({ t: "pi", e: { type: "agent_settled" } }); } });
    const f = setup(sim); expect(await fault(f.channel.finished)).toBe("protocol"); expect(sim.closeCalls).toBeGreaterThanOrEqual(1);
    await f.channel.close(); expect(f.cleanup).toHaveBeenCalledWith("cancelled");
  });
});

describe("pi step channel: bounds", () => {
  it("accepts the exact bootstrap limit and rejects bootstrap boundary+1 before connecting", async () => {
    const ok = new PiSim(); setup(ok, { protocol: mockProtocol(), bootstrap: Buffer.alloc(L.bootstrap + 4) }); await vi.waitFor(() => expect(ok.writes.length).toBe(1));
    const connect = vi.fn(async () => new PiSim().stream); const bad = setup(new PiSim(), { protocol: mockProtocol(), bootstrap: Buffer.alloc(L.bootstrap + 5), connect });
    expect(await fault(bad.channel.finished)).toBe("overload"); expect(connect).not.toHaveBeenCalled();
  });
  it("caps total output bytes, including discarded stderr, and never retains stderr", async () => {
    const protocol = mockProtocol(); const sim = new PiSim({ onBootstrap(s) { s.emitStderr(L.output); s.emitStderr(1); } });
    const f = setup(sim, { protocol }); expect(await fault(f.channel.finished)).toBe("overload"); expect(vi.mocked(protocol.worker)).not.toHaveBeenCalled();
  });
  it("caps one line at 2 MiB and rejects an unterminated oversized line and invalid frames", async () => {
    const long = setup(new PiSim({ onBootstrap(s) { s.emitRaw(Buffer.from(`{"x":"${"a".repeat(L.line)}"}\n`)); } }), { protocol: mockProtocol() }); expect(await fault(long.channel.finished)).toBe("overload");
    const open = setup(new PiSim({ onBootstrap(s) { s.emitRaw(Buffer.alloc(L.line, 97)); } }), { protocol: mockProtocol() }); expect(await fault(open.channel.finished)).toBe("overload");
    const bad = setup(new PiSim({ onBootstrap(s) { s.emitRaw(Buffer.from("not json\n")); } }), { protocol: mockProtocol() }); expect(await fault(bad.channel.finished)).toBe("protocol");
  });
  it("caps the combined frame count across both directions", async () => {
    const protocol = mockProtocol(); let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    const sim = new PiSim({ onBootstrap(s) { void gate.then(() => { for (let i = 0; i <= L.frames; i++) s.emit({ t: "pi", e: { type: "agent_settled" } }); }); } });
    const f = setup(sim, { protocol }); await vi.waitFor(() => expect(sim.boot).toBeDefined()); release();
    expect(await fault(f.channel.finished)).toBe("overload"); expect(vi.mocked(protocol.worker).mock.calls.length).toBeLessThanOrEqual(L.frames);
  });
  it("splits a valid 2 MiB host frame into admitted 64 KiB writes and refuses an oversized one", async () => {
    const sim = new PiSim(); const protocol = mockProtocol(); const f = setup(sim, { protocol }); await vi.waitFor(() => expect(sim.writes.length).toBe(1));
    const text = "a".repeat(L.line - 30); f.channel.send({ t: "input", text });
    const written = sim.writes.slice(1); expect(written.length).toBeGreaterThan(1); expect(written.every(chunk => chunk.length <= L.chunk)).toBe(true);
    expect(() => f.channel.send({ t: "input", text: "b".repeat(L.line) })).toThrow(PiProtocolFault); expect(await fault(f.channel.finished)).toBe("overload");
  });
  it("rejects stdout after the exit event and a partial line at exit", async () => {
    const protocol = mockProtocol({ hasExited: true }); const after = setup(new PiSim({ onBootstrap(s) { s.exit(0); s.emitRaw(Buffer.from("{}\n")); } }), { protocol });
    expect(await fault(after.channel.finished)).toBe("protocol");
    const partial = setup(new PiSim({ onBootstrap(s) { s.emitRaw(Buffer.from('{"a"')); s.exit(0); } }), { protocol: mockProtocol({ hasExited: true }) }); expect(await fault(partial.channel.finished)).toBe("protocol");
  });
  it("bounds a run by the step deadline and cleanup by the cleanup deadline", async () => {
    vi.useFakeTimers(); const sim = new PiSim(happyBehavior({ finalEvents() {} }));
    const f = setup(sim, { cleanup: () => new Promise(() => {}) });
    await vi.advanceTimersByTimeAsync(L.deadlineMs); await expect(f.channel.finished).rejects.toMatchObject({ code: "cancelled" });
    const closing = expect(f.channel.close()).rejects.toMatchObject({ code: "cleanup" }); await vi.advanceTimersByTimeAsync(L.cleanupMs); await closing;
  });
  it("does not write anything when the connection itself fails", async () => {
    const f = setup(new PiSim(), { connect: async () => { throw new Error("gateway down"); } }); expect(await fault(f.channel.finished)).toBe("protocol");
  });
});
