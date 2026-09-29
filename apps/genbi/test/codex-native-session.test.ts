import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { serve } from "@hono/node-server";
import { WebSocket, WebSocketServer } from "ws";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Store } from "../server/db.js";
import { NativeSessionService } from "../server/native-sessions.js";
import type { DirectCodexProvisioner } from "../server/codex-native-session.js";
import { RuntimeHost, runtimeReady } from "../server/runtime-host/index.js";
import type { CodexEvent } from "../server/runtime-host/codex-events.js";
import { conversationSocket } from "../server/conversation-socket.js";
import { createApp } from "../server/app.js";

const owned: { service: NativeSessionService; store: Store }[] = [];
afterEach(async () => { for (const f of owned.splice(0)) { await f.service.shutdown().catch(() => {}); f.store.close(); } vi.useRealTimers(); });
function fixture(database = ":memory:") {
  const store = new Store(database);
  store.setRuntimeSettings({ ...store.getRuntimeSettings(), subscriptionProvider: "codex", subscriptionDriverModel: "driver", tierModels: [{ tier: "cheap", model: "cheap" }, { tier: "strong", model: "strong" }] });
  const binding = { identity: "project", generation: 1, revision: "one", path: "/synthetic/project" };
  let emit!: (event: CodexEvent) => void;
  let fail!: (error: Error) => void;
  let finish!: (value: { id: string; status: "completed" | "interrupted"; items: [] }) => void;
  const close = vi.fn(async () => {});
  const driver = { startThread: vi.fn(async () => "thread"), close, onFailure: vi.fn((listener) => { fail = listener; return () => {}; }),
    runTurn: vi.fn(async () => {
      emit({ method: "turn/started", params: { threadId: "thread", turn: { id: "turn", status: "inProgress", items: [] } } });
      return await new Promise((resolve) => { finish = resolve; });
    }),
    interruptTurn: vi.fn(async () => { finish({ id: "turn", status: "interrupted", items: [] }); }),
  };
  const permit = { runtime: {}, assertActive: vi.fn(), release: vi.fn() };
  const tools = { accountEmail: "test@example.invalid", definitions: [], assertCurrent: vi.fn(), call: vi.fn(), close: vi.fn(async () => {}) };
  const dispose = vi.fn(async () => {});
  const backend = { prepareLaunch: vi.fn(() => permit), open: vi.fn(async (_permit, input) => { emit = input.onEvent; return driver; }) };
  const prepare = vi.fn(async () => ({ input: { spec: {}, wrenHome: {}, tools, assertScopeActive() {} }, dispose }));
  const terminalManager = vi.fn(async () => { throw Error("PTY forbidden"); });
  const options = { store, terminalManager, getBinding: () => binding, workspaceRoot: undefined,
    irPaths: { analysis: undefined, setup: undefined, context_enrichment: undefined }, warbleBin: "/nonexistent/producer",
    runtimeHost: new RuntimeHost({ selected: "codex-app-server", deployment: "production", localAvailable: () => false,
      vendorProbes: { "codex-app-server": async () => ({ readiness: runtimeReady("0.156.1", []), diagnostic: { phase: "capability" } }) } }),
    directCodex: { backend, prepare } as unknown as DirectCodexProvisioner,
  };
  const service = new NativeSessionService(options); owned.push({ service, store });
  return { service, store, binding, backend, prepare, permit, close, tools, dispose, driver, terminalManager, options,
    fail: () => fail(Error("synthetic provider failure")),
    emit: (event: CodexEvent) => emit(event), finish: () => finish({ id: "turn", status: "completed", items: [] }) };
}
const launch = (f: ReturnType<typeof fixture>) => f.service.startSeparate({ purpose: "analysis", idempotencyKey: randomUUID() });
describe("durable direct Codex Sessions", () => {
  it("acquires the permit before rows/preparation and never falls back to PTY", async () => {
    const f = fixture();
    f.backend.prepareLaunch.mockImplementation(() => { expect(f.store.listNativeSessions()).toEqual([]); throw Error("uncertified"); });
    await expect(launch(f)).rejects.toThrow();
    expect(f.store.listNativeSessions()).toEqual([]); expect(f.prepare).not.toHaveBeenCalled(); expect(f.terminalManager).not.toHaveBeenCalled();
  });
  it("missing preparation and unsupported purposes fail before durable writes", async () => {
    const f = fixture(); const { directCodex: _, ...options } = f.options;
    const service = new NativeSessionService(options);
    try { await expect(service.create({ purpose: "analysis" })).rejects.toThrow(); } finally { await service.shutdown(); }
    await expect(f.service.create({ purpose: "setup" })).rejects.toThrow();
    expect(f.store.listNativeSessions()).toEqual([]); expect(f.terminalManager).not.toHaveBeenCalled();
  });
  it("persists conversation transport, reopens and isolates adjacent/stale attachments", async () => {
    const f = fixture(); const a = await launch(f); const b = await launch(f);
    expect(a.row.transport).toBe("conversation"); expect(f.service.runtime(a.row.id)).toBeUndefined();
    expect(f.service.attachConversation(a.row.id, b.capability!, () => {})).toBeUndefined();
    const frames: unknown[] = [];
    const first = f.service.attachConversation(a.row.id, a.capability!, (frame) => frames.push(frame))!;
    expect(first).toBeDefined(); expect(frames[0]).toMatchObject({ type: "replay", state: "ready" });
    expect(f.service.attachConversation(a.row.id, a.capability!, () => {})).toBeUndefined();
    first.detach(); expect(f.service.get(a.row.id)?.status).toBe("detached");
    expect((await f.service.openExisting({ purpose: "analysis", id: a.row.id })).capability).toBe(a.capability);
    const second = f.service.attachConversation(a.row.id, a.capability!, () => {})!;
    first.detach(); expect(f.service.get(a.row.id)?.status).toBe("running");
    expect(() => first.submit("stale")).toThrow(); second.detach();
    await f.service.stopAndWait(a.row.id, a.capability!);
    expect(f.service.resumeAvailability(f.service.get(a.row.id)!)).toMatchObject({ available: false, cause: "no_resume_handle" });
  });
  it("streams prompt/cancel, retains detached replay, awaits stop and revokes capabilities", async () => {
    const f = fixture(); const a = await launch(f); const frames: unknown[] = [];
    const handle = f.service.attachConversation(a.row.id, a.capability!, (frame) => frames.push(frame))!;
    const pending = handle.submit("count orders"); await vi.waitFor(() => expect(f.driver.runTurn).toHaveBeenCalledOnce());
    await handle.interrupt(); expect(await pending).toMatchObject({ status: "interrupted" });
    expect(frames.some((frame: any) => frame.type === "event" && frame.event.method === "turn/started")).toBe(true);
    handle.detach();
    let release!: () => void; f.close.mockImplementation(() => new Promise((resolve) => { release = resolve; }));
    let done = false; const stopped = f.service.stopAndWait(a.row.id, a.capability!).then(() => { done = true; });
    await vi.waitFor(() => expect(release).toBeDefined()); expect(done).toBe(false);
    expect(f.service.attachConversation(a.row.id, a.capability!, () => {})).toBeUndefined();
    release(); await stopped; expect(f.dispose).toHaveBeenCalledOnce(); expect(f.tools.close).toHaveBeenCalled();
  });
  it("rejects binding changes during preparation and cleans abandoned allocations", async () => {
    const f = fixture(); f.prepare.mockImplementation(async () => {
      f.binding.revision = "changed";
      return { input: { spec: {}, wrenHome: {}, tools: f.tools, assertScopeActive() {} }, dispose: f.dispose };
    });
    await expect(launch(f)).rejects.toThrow(); expect(f.backend.open).not.toHaveBeenCalled();
    expect(f.tools.close).toHaveBeenCalledOnce(); expect(f.dispose).toHaveBeenCalledOnce(); expect(f.permit.release).toHaveBeenCalled();
  });
  it("initial/idle expiry closes the owned conversation", async () => {
    vi.useFakeTimers(); const f = fixture(); const a = await launch(f);
    await vi.advanceTimersByTimeAsync(15_001);
    expect(f.service.get(a.row.id)?.status).toBe("stopped"); expect(f.close).toHaveBeenCalledOnce();
    const b = await launch(f); const h = f.service.attachConversation(b.row.id, b.capability!, () => {})!; h.detach();
    await vi.advanceTimersByTimeAsync(30 * 60_000 + 1); expect(f.service.get(b.row.id)?.status).toBe("stopped");
  });
  it("marks persisted conversations unavailable after process-local ownership is lost", async () => {
    const f = fixture(); const a = await launch(f);
    const restarted = new NativeSessionService(f.options);
    expect(restarted.get(a.row.id)?.status).toBe("stopped");
    await restarted.shutdown();
  });
  it("API stop rejects adjacent capabilities and exposes only fixed cleanup errors", async () => {
    const f = fixture(); const a = await launch(f);
    const app = createApp({ store: f.store, nativeSessions: f.service } as Parameters<typeof createApp>[0]);
    const request = (capability: string) => app.request(`/api/native-sessions/${a.row.id}/stop`, { method: "POST", body: JSON.stringify({ capability }) });
    expect((await request(randomUUID())).status).toBe(404);
    f.close.mockRejectedValue(Error("private cleanup detail"));
    const result = await request(a.capability!); expect(result.status).toBe(409);
    expect(await result.text()).not.toContain("private"); expect(f.service.get(a.row.id)?.status).toBe("stopped");
    expect(f.dispose).not.toHaveBeenCalled(); // preserve resources while process cleanup is unconfirmed
    await expect(f.service.shutdown()).rejects.toThrow("cleanup");
  });
  it("WebSocket rejects foreign owners, malformed authority, future cursors and backpressure", async () => {
    const f = fixture(); const a = await launch(f);
    const ws = { send: vi.fn(), close: vi.fn(), raw: { bufferedAmount: 0 } };
    const live = conversationSocket(f.service, a.row.id, a.capability!, "0"); live.onOpen({}, ws);
    const rejected = conversationSocket(f.service, a.row.id, randomUUID(), "0"); rejected.onOpen({}, ws); rejected.onClose();
    expect(f.service.get(a.row.id)?.status).toBe("running");
    live.onMessage({ data: JSON.stringify({ type: "prompt", text: "question", command: "/bin/sh" }) }, ws);
    expect(f.driver.runTurn).not.toHaveBeenCalled(); expect(f.service.get(a.row.id)?.status).toBe("detached");
    const future = conversationSocket(f.service, a.row.id, a.capability!, "9999"); future.onOpen({}, ws);
    expect(f.service.get(a.row.id)?.status).toBe("detached");
    ws.raw.bufferedAmount = 3_000_000;
    conversationSocket(f.service, a.row.id, a.capability!, "0").onOpen({}, ws);
    await vi.waitFor(() => expect(f.close).toHaveBeenCalled());
  });
  it("closes a running turn when the runtime generation is revoked", async () => {
    const f = fixture(); const a = await launch(f);
    const h = f.service.attachConversation(a.row.id, a.capability!, () => {})!;
    const pending = h.submit("question"); const rejected = expect(pending).rejects.toThrow();
    await vi.waitFor(() => expect(f.driver.runTurn).toHaveBeenCalledOnce());
    f.store.stopNativeSessionAndRevokeRecoveryAction(a.row.id);
    f.service.revokeRuntimeCapabilities([a.row.id]);
    await rejected; await f.service.drainComponentCleanup();
    expect(f.close).toHaveBeenCalledOnce(); expect(f.dispose).toHaveBeenCalledOnce();
    expect(() => h.submit("late")).toThrow();
    expect(f.service.attachConversation(a.row.id, a.capability!, () => {})).toBeUndefined();
    h.detach(); expect(f.service.get(a.row.id)?.status).toBe("stopped");
  });
  it("persists provider failure even while detached and revokes its owner", async () => {
    const f = fixture(); const a = await launch(f);
    const h = f.service.attachConversation(a.row.id, a.capability!, () => {})!; h.detach(); f.fail();
    await vi.waitFor(() => expect(f.service.get(a.row.id)?.status).toBe("failed"));
    await f.service.drainComponentCleanup();
    expect(f.dispose).toHaveBeenCalledOnce();
    expect(f.service.get(a.row.id)?.failure).not.toContain("synthetic");
    expect(f.service.attachConversation(a.row.id, a.capability!, () => {})).toBeUndefined();
  });
  it("shutdown awaits preparation and disposes late allocations without opening", async () => {
    const f = fixture(); let release!: () => void;
    f.prepare.mockImplementation(async () => {
      await new Promise<void>((resolve) => { release = resolve; });
      return { input: { spec: {}, wrenHome: {}, tools: f.tools, assertScopeActive() {} }, dispose: f.dispose };
    });
    const pending = launch(f); const rejected = expect(pending).rejects.toThrow();
    await vi.waitFor(() => expect(release).toBeDefined());
    let done = false; const shutdown = f.service.shutdown().then(() => { done = true; });
    expect(done).toBe(false); release(); await rejected; await shutdown;
    expect(f.backend.open).not.toHaveBeenCalled(); expect(f.dispose).toHaveBeenCalledOnce();
    expect(f.store.listNativeSessions()[0]?.status).toBe("failed");
  });
  it("retains the transport discriminator across database reopen", async () => {
    const directory = mkdtempSync(join(tmpdir(), "genbi-conversation-db-"));
    const database = join(directory, "store.db");
    try {
      const f = fixture(database); const a = await launch(f); await f.service.shutdown();
      owned.splice(owned.findIndex((item) => item.service === f.service), 1); f.store.close();
      const reopened = new Store(database);
      try { expect(reopened.getNativeSession(a.row.id)).toMatchObject({ transport: "conversation", status: "stopped" }); }
      finally { reopened.close(); }
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
  it("serves capability-authenticated events through the actual WebSocket route", async () => {
    const f = fixture(); const a = await launch(f);
    const app = createApp({ store: f.store, nativeSessions: f.service } as Parameters<typeof createApp>[0]);
    const websocket = new WebSocketServer({ noServer: true });
    const server = serve({ fetch: app.fetch, websocket: { server: websocket as never }, hostname: "127.0.0.1", port: 0 });
    const clients: WebSocket[] = [];
    try {
      if (!server.listening) await once(server, "listening");
      const port = (server.address() as { port: number }).port;
      const connect = (cap: string) => {
        const client = new WebSocket(`ws://127.0.0.1:${port}/api/native-sessions/${a.row.id}/conversation?cap=${cap}&after=0`);
        clients.push(client); return client;
      };
      const denied = connect(randomUUID()); expect((await once(denied, "close"))[0]).toBe(1008);
      const client = connect(a.capability!); const frames: any[] = [];
      client.on("message", (data) => frames.push(JSON.parse(String(data))));
      await once(client, "open"); await vi.waitFor(() => expect(frames[0]).toMatchObject({ type: "replay", state: "ready" }));
      client.send(JSON.stringify({ type: "prompt", text: "count" }));
      await vi.waitFor(() => expect(f.driver.runTurn).toHaveBeenCalledOnce());
      client.send(JSON.stringify({ type: "interrupt" }));
      await vi.waitFor(() => expect(f.driver.interruptTurn).toHaveBeenCalledOnce());
      await vi.waitFor(() => expect(frames.at(-1)).toMatchObject({ type: "state", state: "ready" }));
      client.close(); await once(client, "close");
      await vi.waitFor(() => expect(f.service.get(a.row.id)?.status).toBe("detached"));
    } finally {
      for (const client of clients) client.terminate();
      websocket.close(); await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

});
