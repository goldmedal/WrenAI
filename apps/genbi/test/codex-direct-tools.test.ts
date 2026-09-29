import { readFileSync } from "node:fs";
import { describe, it, expect, vi } from "vitest";
import { prepareCodexDirectTools } from "../server/runtime-host/codex-direct-tools.js";
import { resolveWarbleBinary } from "../harness/compile/resolve-binary.js";
import type { NativeComponentBindings } from "../server/native-component-preparation.js";

const document = readFileSync(new URL("../profiles/genbi-default/ir.golden.json", import.meta.url), "utf8");
async function fixture(entry = "answer_query") {
  const ir = JSON.parse(document);
  const producerBinary = await resolveWarbleBinary();
  const identity = { session_id: "one", vendor: "codex" as const, auth_identity: "approved", runtime_generation: "v1",
    binding: { project_identity: "jaffle", generation: "1", revision: "1" } };
  const current = structuredClone(identity);
  const controller = new AbortController();
  const query = vi.fn(async () => ({ columns: ["count"], rows: [[99]] }));
  const observed: { root: string; tools: string[] }[] = [];
  const bindings: NativeComponentBindings = { identity, currentIdentity: () => current, assertCurrent() {}, verifierBinary: producerBinary,
    contexts: Object.fromEntries(ir.components.map((node: any) => [node.id, { binding: node.context_binding, snapshot: { context_version: 2, parseable: true } }])),
    prepare: vi.fn<NativeComponentBindings["prepare"]>(async () => ({ query, async inspect() { return {}; }, async close() {} })),
    async step(run, component) {
      observed.push({ root: component.id, tools: Object.keys(run.tools) });
      if (run.tools.answer) await run.tools.answer({ request: "question" });
      if (run.tools.query_read_only) await run.tools.query_read_only({ sql: "SELECT count(*) FROM orders" });
      return { value: "done" };
    },
    async normalize() { return { status: "ok", output: { kind: "value", value: 99 } }; },
  };
  const open = (expiresAt = Date.now() + 60_000) => prepareCodexDirectTools({ irDocument: JSON.stringify(ir),
    scope: { binding: identity.binding, entry: { kind: "agent", verb: entry, prompt: "question" } }, bindings,
    accountEmail: "fixture@example.invalid", producerBinary, expiresAt, signal: controller.signal });
  return { open, current, controller, query, observed, bindings };
}
describe("released direct producer and scoped admission", () => {
  it.each(["answer_query", "generate_dashboard"])("materializes one %s root with its own step authority", async (entry) => {
    const f = await fixture(entry); const tools = await f.open();
    try {
      expect(tools.definitions).toHaveLength(1);
      expect(tools.definitions[0]!.inputSchema).not.toHaveProperty("connection");
      expect(await tools.call(tools.definitions[0]!.name, { request: "count orders" }, "1", new AbortController().signal)).toMatchObject({ status: "ok" });
      expect(f.query).toHaveBeenCalled();
      if (entry === "generate_dashboard") {
        expect(f.observed.filter((v) => v.root === entry).every((v) => !v.tools.includes("query_read_only"))).toBe(true);
        expect(f.observed.some((v) => v.root === "answer_query" && v.tools.includes("query_read_only"))).toBe(true);
      }
      await expect(tools.call(tools.definitions[0]!.name, { request: "again" }, "1", new AbortController().signal)).rejects.toThrow();
    } finally { await tools.close(); }
  });
  it.each(["session", "account", "generation", "binding", "revoked"])("rejects changed %s before data access", async (change) => {
    const f = await fixture(); const tools = await f.open();
    if (change === "session") f.current.session_id = "adjacent";
    if (change === "account") f.current.auth_identity = "wrong credential";
    if (change === "generation") f.current.runtime_generation = "v2";
    if (change === "binding") f.current.binding.revision = "2";
    if (change === "revoked") f.controller.abort();
    await expect(tools.call(tools.definitions[0]!.name, { request: "count" }, "1", new AbortController().signal)).rejects.toThrow();
    expect(f.query).not.toHaveBeenCalled(); await tools.close();
  });
  it("rejects expired authority, foreign tool, injected step and new calls after close", async () => {
    const f = await fixture(); await expect(f.open(Date.now() - 1)).rejects.toThrow();
    const tools = await f.open();
    await expect(tools.call("adjacent-session-tool", { request: "count" }, "1", new AbortController().signal)).rejects.toThrow();
    await expect(tools.call(tools.definitions[0]!.name, { request: "count", step: "query" }, "2", new AbortController().signal)).rejects.toThrow();
    expect(f.query).not.toHaveBeenCalled(); await tools.close();
    await expect(tools.call(tools.definitions[0]!.name, { request: "count" }, "3", new AbortController().signal)).rejects.toThrow();
  });
});

it("expires previously issued tools before access", async () => {
  const f = await fixture(); const tools = await f.open();
  const now = Date.now(); const clock = vi.spyOn(Date, "now").mockReturnValue(now + 120_000);
  try {
    await expect(tools.call(tools.definitions[0]!.name, { request: "count" }, "1", new AbortController().signal)).rejects.toThrow();
    expect(f.query).not.toHaveBeenCalled();
  } finally { clock.mockRestore(); await tools.close(); }
});
it("abort cancels an in-flight query and closes its access", async () => {
  const f = await fixture(); let pending: AbortSignal | undefined; const closed = vi.fn(async () => {});
  vi.mocked(f.bindings.prepare).mockImplementation(async () => ({ async inspect() { return {}; }, close: closed,
    async query(_input, signal) { pending = signal; return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(Error("cancelled")), { once: true })); },
  }));
  const tools = await f.open(); const running = tools.call(tools.definitions[0]!.name, { request: "count" }, "1", new AbortController().signal);
  void running.catch(() => {});
  await vi.waitFor(() => expect(pending).toBeDefined()); f.controller.abort();
  await expect(running).rejects.toThrow(); await tools.close();
  expect(pending!.aborted).toBe(true); expect(closed).toHaveBeenCalledOnce();
});
