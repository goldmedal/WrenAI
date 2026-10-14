import { describe, expect, it } from "vitest";
import { CliUsageError } from "../harness/cli-args.js";
import { DEFAULT_COMPONENT_LIMITS } from "../harness/components/runner.js";
import { describeExecutionLimits, resolveExecutionLimits } from "../server/execution-limits.js";

describe("resolveExecutionLimits", () => {
  it("uses the built-in budget when the env var is unset", () => {
    const limits = resolveExecutionLimits({});
    expect(limits).toEqual({ componentLimits: DEFAULT_COMPONENT_LIMITS, componentTimeoutSource: "default" });
    expect(limits.componentLimits.timeoutMs).toBe(120_000);
    expect(describeExecutionLimits(limits)).toBe("execution limits: component run timeout 120000 ms (120 s, built-in default)");
  });

  it("overrides only the timeout from WREN_HARNESS_COMPONENT_TIMEOUT_MS", () => {
    const limits = resolveExecutionLimits({ WREN_HARNESS_COMPONENT_TIMEOUT_MS: "300000" });
    expect(limits.componentTimeoutSource).toBe("env");
    expect(limits.componentLimits).toEqual({ ...DEFAULT_COMPONENT_LIMITS, timeoutMs: 300_000 });
    expect(describeExecutionLimits(limits)).toBe("execution limits: component run timeout 300000 ms (300 s, WREN_HARNESS_COMPONENT_TIMEOUT_MS)");
  });

  it("fails loudly on a malformed or out-of-range value", () => {
    for (const bad of ["abc", "10", "9999999"]) {
      expect(() => resolveExecutionLimits({ WREN_HARNESS_COMPONENT_TIMEOUT_MS: bad })).toThrow(CliUsageError);
      expect(() => resolveExecutionLimits({ WREN_HARNESS_COMPONENT_TIMEOUT_MS: bad })).toThrow(/WREN_HARNESS_COMPONENT_TIMEOUT_MS/);
    }
  });
});
