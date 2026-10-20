import { describe, expect, it, vi } from "vitest";
import type { RouteOptions } from "../harness/index.js";
import { createLocalPiStructuredAdapter, readLocalPiStructuredResult, type LocalPiPreparedHost, type LocalPiStructuredProvisioner } from "../server/local-pi-structured-ask.js";
import { runtimeReady } from "../server/runtime-host/policy.js";
import { StructuredRuntimeError, type StructuredScope } from "../server/structured-runtime.js";

const verified = { status: "ok", output: { kind: "value", value: { columns: ["n"], rows: [{ n: 7 }] } }, provenance: { verified: true, definition: { sql: "SELECT COUNT(*) AS n FROM orders" } } };
const unverified = { ...verified, provenance: { verified: false, definition: { sql: "SELECT 1" } } };
const options = { authChoice: { mode: "api-key", adapter: "openai-compatible" }, profileSource: "fixture", userProject: "/fixture/project", question: "count" } as RouteOptions;
const scope = (): StructuredScope => ({ sessionId: "s", turnId: "t", assertCurrent() {} });
const binding = { isCurrent: () => true } as never;

/** A provisioner whose host is scripted; every call to the adapter's persistRoot sink is observed. */
function harness(script: (persist: (value: unknown) => Promise<void>, signal: AbortSignal) => Promise<unknown>) {
  const persisted: unknown[] = []; const failures: unknown[] = [];
  const provisioner: LocalPiStructuredProvisioner = {
    probe: async () => runtimeReady("1.0.4", []),
    prepare: async (input) => {
      const host: LocalPiPreparedHost = { assertCurrent() {}, async run() {
        const signal = new AbortController().signal;
        return (await script(async (value) => { try { await input.persistRoot(value as never, binding, signal); persisted.push(value); } catch (error) { failures.push(error); throw error; } }, signal)) as never;
      }, dispose: vi.fn(async () => {}) };
      return host;
    },
  };
  return { adapter: createLocalPiStructuredAdapter(provisioner), persisted, failures };
}

describe("a pi Ask persists its verified root exactly once", () => {
  it("one verified root is persisted once and the answer is built from that root alone", async () => {
    const h = harness(async (persist) => { await persist(verified); return verified; });
    const result = await h.adapter.ask!(options, scope());
    expect(h.persisted).toEqual([verified]); expect(h.failures).toEqual([]);
    expect(result).toMatchObject({ backend: "pi-local", envelope: { verified: true, blocks: [{ type: "table", columns: ["n"], rows: [{ n: 7 }] }, { type: "definition", sql: "SELECT COUNT(*) AS n FROM orders" }] } });
    expect(readLocalPiStructuredResult(result as never).envelope).toEqual((result as { envelope: unknown }).envelope);
  });
  it("a second persist of the same or another verified root is refused and the Ask is not an answer", async () => {
    const other = { ...verified, output: { kind: "value", value: { columns: ["n"], rows: [{ n: 8 }] } } };
    for (const second of [verified, other]) {
      const h = harness(async (persist) => { await persist(verified); await persist(second); return verified; });
      await expect(h.adapter.ask!(options, scope())).rejects.toBeInstanceOf(StructuredRuntimeError);
      expect(h.persisted).toEqual([verified]); expect(h.failures).toHaveLength(1);
    }
  });
  it("a root that is not verified host evidence is never persisted and never an answer", async () => {
    for (const forged of [unverified, { status: "ok", output: { kind: "value", value: { columns: ["n"], rows: [{ n: 999999 }] } } }, { text: "n = 999999" }, null]) {
      const h = harness(async (persist) => { await persist(forged); return forged; });
      await expect(h.adapter.ask!(options, scope())).rejects.toBeInstanceOf(StructuredRuntimeError);
      expect(h.persisted).toEqual([]);
    }
  });
  it("a run that returns a root it never persisted, or one different from the persisted root, is not an answer", async () => {
    await expect(harness(async () => verified).adapter.ask!(options, scope())).rejects.toBeInstanceOf(StructuredRuntimeError);
    const other = { ...verified, output: { kind: "value", value: { columns: ["n"], rows: [{ n: 8 }] } } };
    await expect(harness(async (persist) => { await persist(verified); return other; }).adapter.ask!(options, scope())).rejects.toBeInstanceOf(StructuredRuntimeError);
  });
  it("a persist made after the Ask finished is refused", async () => {
    let late: ((value: unknown) => Promise<void>) | undefined;
    const h = harness(async (persist) => { late = persist; await persist(verified); return verified; });
    await h.adapter.ask!(options, scope());
    await expect(late!(verified)).rejects.toBeDefined();
    expect(h.persisted).toEqual([verified]);
  });
});
