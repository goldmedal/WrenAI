import { describe, expect, it, vi } from "vitest";
import type { RouteOptions, RouteResult } from "../harness/index.js";
import { gateDecisionStep, summarizeResult, toAnswerOrRefusalEvent } from "../server/fold.js";
import { createLocalPiStructuredAdapter, type LocalPiStructuredProvisioner } from "../server/local-pi-structured-ask.js";
import { runtimeReady } from "../server/runtime-host/policy.js";
import type { StructuredScope } from "../server/structured-runtime.js";

const verified = { status: "ok", output: { kind: "value", value: { columns: ["n"], rows: [{ n: 7 }] } }, provenance: { verified: true, definition: { sql: "SELECT COUNT(*) AS n FROM orders" } } };
const options = { authChoice: { mode: "api-key", adapter: "openai-compatible" }, profileSource: "fixture", userProject: "/fixture/project", question: "count" } as RouteOptions;
const forgedEnvelope = { blocks: [{ type: "table", columns: ["n"], rows: [{ n: 999999 }] }], verified: true, verificationScope: "query-results" };
type PiLocal = Extract<RouteResult, { backend: "pi-local" }>;

/** A real adapter result: registered by the adapter, exactly as the BFF receives it. */
async function registered(scope: StructuredScope = { sessionId: "s", turnId: "t", assertCurrent() {} }): Promise<PiLocal> {
  const provisioner: LocalPiStructuredProvisioner = { probe: async () => runtimeReady("1.0.4", []),
    prepare: async (input) => ({ assertCurrent() {}, dispose: vi.fn(async () => {}),
      async run() { await input.persistRoot(verified as never, { isCurrent: () => true } as never, new AbortController().signal); return verified as never; } }) };
  return await createLocalPiStructuredAdapter(provisioner).ask!(options, scope) as PiLocal;
}
const functions = {
  "toAnswerOrRefusalEvent (the answer event)": (result: PiLocal) => toAnswerOrRefusalEvent("answer", result),
  "gateDecisionStep (the verify gate)": (result: PiLocal) => gateDecisionStep(result),
  "summarizeResult (the stored summary)": (result: PiLocal) => summarizeResult(result),
};

describe("a pi-local result folds only with the adapter's own authority", () => {
  it("the adapter's registered result folds into one verified answer, a done gate and a summary from the root", async () => {
    const result = await registered();
    expect(toAnswerOrRefusalEvent("answer", result)).toMatchObject({ kind: "answer", answer: { form: "rich", envelope: { verified: true, blocks: [{ type: "table", rows: [{ n: 7 }] }, { type: "definition" }] } } });
    expect(gateDecisionStep(result)).toMatchObject({ state: "done", label: "Verify gate" });
    expect(summarizeResult(result)).toContain('"n":7');
  });
  describe.each(Object.entries(functions))("%s", (_name, fold) => {
    it("refuses a hand-built result the adapter never registered: no answer, no gate, no summary", () => {
      for (const forged of [{ backend: "pi-local", warnings: [], envelope: forgedEnvelope }, { backend: "pi-local", warnings: [], envelope: { blocks: [], verified: true } },
        { backend: "pi-local", warnings: [], envelope: { ...forgedEnvelope, verified: false } }] as unknown as PiLocal[]) {
        expect(() => fold(forged)).toThrow();
      }
    });
    it("refuses a registered result whose envelope was replaced, whether by spread or by mutation", async () => {
      const real = await registered();
      expect(() => fold({ ...real, envelope: forgedEnvelope } as PiLocal)).toThrow();
      const mutated = structuredClone(real) as { envelope: unknown }; mutated.envelope = forgedEnvelope;
      expect(() => fold(mutated as PiLocal)).toThrow();
      expect(() => fold(real)).not.toThrow();
    });
    it("refuses a registered result once its scope is no longer current", async () => {
      let current = true;
      const real = await registered({ sessionId: "s", turnId: "t", assertCurrent() { if (!current) throw new Error("stale"); } });
      expect(() => fold(real)).not.toThrow();
      current = false;
      expect(() => fold(real)).toThrow();
    });
  });
});
