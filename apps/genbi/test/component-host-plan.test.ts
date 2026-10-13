import { expect, it } from "vitest";
import { produceComponentHostPlan } from "../server/runtime-host/component-host-plan.js";

it("rehashes after async plan-file preparation and before starting the producer", async () => {
  const prepared = { hostRoots: { answer_query: {} }, assertCurrent() {} };
  await expect(produceComponentHostPlan({
    irDocument: JSON.stringify({ context_binding: {}, components: [{ id: "answer_query" }] }), prepared: prepared as never,
    producerBinary: "/nonexistent/producer", signal: new AbortController().signal, assertCurrent() {},
    assertExecutableCurrent() { throw Error("executable changed after plan preparation"); },
  })).rejects.toThrow("executable changed after plan preparation");
});
