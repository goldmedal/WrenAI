import { describe, expect, it } from "vitest";
import { ComponentRunner, type ExecutionPlan, type RunnerHost } from "../harness/components/runner.js";
import { GovernedWrenError } from "../harness/components/wren-access.js";
import { createStructuredQueryFailureTracker, observeStructuredQueryAccess, storedStructuredFailure, structuredFailureFeedback } from "../server/structured-error-feedback.js";

const generic = { code: "runtime.failed", kind: "runtime", message: "Structured runtime failed." };
async function run(mode: "query" | "provider-failed" | "provider-throw" | "repair" | "cleanup") {
  const tracker = createStructuredQueryFailureTracker();
  let queries = 0;
  const access = observeStructuredQueryAccess({
    async query() { if (++queries === 1) throw new GovernedWrenError("execution_failed"); return { rows: [{ n: 7 }] }; },
    async inspect() { return {}; }, async close() {},
  }, tracker.record);
  const plan: ExecutionPlan = { identity: "synthetic", entries: ["answer"], components: { answer: { id: "answer", declaration: {}, steps: [
    { name: "query", tier: "cheap", prompt: "query", consumes: [], produces: "data", tools: [{ name: "query", source: "mcp:wren/query" }], calls: [] },
    ...(mode === "repair" ? [{ name: "repair", repairOf: "query", tier: "cheap", prompt: "repair", consumes: ["data"], produces: "fixed", tools: [{ name: "query", source: "mcp:wren/query" }], calls: [] }] : []),
  ] } } };
  const host: RunnerHost = {
    async prepare() { return { isCurrent: () => true, tools: [{ name: "query", source: "mcp:wren/query", execute: (input, signal) => access.query(input as never, signal) }],
      async normalize() { return { status: "ok", output: { kind: "value", value: { n: 7 } } }; }, async close() { if (mode === "cleanup") throw Error("sensitive cleanup"); } }; },
    onEvent(event) { if (event.kind === "step.start") tracker.start(); if (event.kind === "step.finish") tracker.finish(event.status!); },
    async runStep(step) {
      try {
        await step.tools.query!({ sql: "SELECT n", limit: 1 }).catch(() => {});
        if (mode === "provider-throw") throw Error("sensitive provider transport");
        const response = { value: "terminal", ...(mode === "provider-failed" ? { failed: true } : {}) };
        tracker.providerReturned(response.failed === true);
        return response;
      } catch (error) { tracker.providerRejected(); throw error; }
    },
  };
  const runner = new ComponentRunner(plan, host);
  const result = await runner.run("answer", { request: "synthetic" });
  const failure = result.status === "error" && result.code === "callee_failed" && !runner.cleanupFailed ? tracker.terminalFailure() : undefined;
  return { result, feedback: structuredFailureFeedback(failure), queries };
}

describe("host-owned structured error feedback", () => {
  it("classifies an unrepaired actual query rejection without claiming a specific missing column", async () => {
    const value = await run("query");
    expect(value.result.status).toBe("error");
    expect(value.feedback).toEqual(storedStructuredFailure("query.execution_failed"));
    expect(value.feedback.message).toContain("required columns");
    expect(value.feedback.message).not.toContain("price");
  });
  it.each(["provider-failed", "provider-throw", "cleanup"] as const)("does not blame a previous query when the terminal cause is %s", async mode => {
    expect((await run(mode)).feedback).toEqual(generic);
  });
  it("clears query failure after a declared successful repair", async () => {
    const value = await run("repair"); expect(value.result.status).toBe("ok"); expect(value.queries).toBe(2); expect(value.feedback).toEqual(generic);
  });
  it("does not trust sensitive unknown errors, getters, model text or serialized lookalikes", () => {
    for (const error of [Error("secret-token /private/path SELECT price"), { errorClass: "execution_failed", code: "query.execution_failed" },
      { get code() { throw Error("getter must not run"); }, message: "column missing" }, new Proxy({}, { getPrototypeOf() { throw Error("proxy must not run"); } })]) {
      expect(structuredFailureFeedback(error)).toEqual(generic);
    }
    expect(storedStructuredFailure("column-price-missing")).toEqual(generic);
  });
});
