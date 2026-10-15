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

import { effectiveExecutionLimits, executionLimitsDtoFor, ExecutionLimitsError, resolveExecutionLimitsConfig, validateOperatorComponentTimeoutMs, withRunBudget, describeExecutionLimitsConfig } from "../server/execution-limits.js";
import { componentFailureCodeOf, componentFailureMessage } from "../harness/components/runner.js";

describe("resolveExecutionLimitsConfig", () => {
  it("defaults the ceiling to the range maximum and marks personal deployments editable", () => {
    const config = resolveExecutionLimitsConfig({}, "personal");
    expect(config).toMatchObject({ ceilingMs: 1_800_000, ceilingSource: "default", deployment: "personal" });
    expect(effectiveExecutionLimits(config, undefined)).toMatchObject({ editable: true, componentTimeoutSource: "default", deployerTimeoutMs: 120_000 });
    expect(describeExecutionLimitsConfig(config)).toContain("ceiling 1800000 ms (built-in default); operators may raise it on the Harness page");
  });

  it("reads the ceiling from WREN_HARNESS_MAX_COMPONENT_TIMEOUT_MS and rejects a deployer value above it", () => {
    const config = resolveExecutionLimitsConfig({ WREN_HARNESS_MAX_COMPONENT_TIMEOUT_MS: "600000" }, "personal");
    expect(config).toMatchObject({ ceilingMs: 600_000, ceilingSource: "env" });
    expect(() => resolveExecutionLimitsConfig({ WREN_HARNESS_COMPONENT_TIMEOUT_MS: "900000", WREN_HARNESS_MAX_COMPONENT_TIMEOUT_MS: "600000" }, "personal"))
      .toThrow(/WREN_HARNESS_COMPONENT_TIMEOUT_MS \(900000\) exceeds WREN_HARNESS_MAX_COMPONENT_TIMEOUT_MS \(600000\)/);
    expect(() => resolveExecutionLimitsConfig({ WREN_HARNESS_MAX_COMPONENT_TIMEOUT_MS: "nope" }, "personal")).toThrow(CliUsageError);
  });

  it("locks operator overrides on a hosted deployment until a ceiling is set explicitly", () => {
    const locked = effectiveExecutionLimits(resolveExecutionLimitsConfig({}, "hosted"), { componentTimeoutMs: 300_000 });
    expect(locked).toMatchObject({ editable: false, componentTimeoutSource: "default", operatorTimeoutMs: 300_000 });
    expect(locked.componentLimits.timeoutMs).toBe(120_000);
    expect(locked.editableReason).toMatch(/WREN_HARNESS_MAX_COMPONENT_TIMEOUT_MS/);
    const unlocked = effectiveExecutionLimits(resolveExecutionLimitsConfig({ WREN_HARNESS_MAX_COMPONENT_TIMEOUT_MS: "900000" }, "hosted"), { componentTimeoutMs: 300_000 });
    expect(unlocked).toMatchObject({ editable: true, componentTimeoutSource: "operator" });
    expect(unlocked.componentLimits.timeoutMs).toBe(300_000);
  });
});

describe("effectiveExecutionLimits", () => {
  const config = resolveExecutionLimitsConfig({ WREN_HARNESS_COMPONENT_TIMEOUT_MS: "240000", WREN_HARNESS_MAX_COMPONENT_TIMEOUT_MS: "600000" }, "personal");

  it("layers operator over env over default, changing only the timeout", () => {
    const env = effectiveExecutionLimits(config, undefined);
    expect(env).toMatchObject({ componentTimeoutSource: "env", deployerTimeoutMs: 240_000, ceilingMs: 600_000, minMs: 30_000, editable: true });
    expect(env.componentLimits).toEqual({ ...DEFAULT_COMPONENT_LIMITS, timeoutMs: 240_000 });
    const operator = effectiveExecutionLimits(config, { componentTimeoutMs: 480_000 });
    expect(operator).toMatchObject({ componentTimeoutSource: "operator", operatorTimeoutMs: 480_000, deployerTimeoutMs: 240_000 });
    expect(operator.componentLimits).toEqual({ ...DEFAULT_COMPONENT_LIMITS, timeoutMs: 480_000 });
  });

  it("reports but does not enforce a saved override that no longer fits the ceiling", () => {
    const stale = effectiveExecutionLimits(config, { componentTimeoutMs: 900_000 });
    expect(stale).toMatchObject({ componentTimeoutSource: "env", operatorTimeoutMs: 900_000 });
    expect(stale.componentLimits.timeoutMs).toBe(240_000);
  });

  it("validates operator values against the live ceiling", () => {
    expect(validateOperatorComponentTimeoutMs(config, 300_000)).toBe(300_000);
    for (const bad of [29_999, 600_001, 5.5, "300000", null, undefined]) {
      expect(() => validateOperatorComponentTimeoutMs(config, bad)).toThrow(ExecutionLimitsError);
    }
    expect(() => validateOperatorComponentTimeoutMs(config, 700_000)).toThrow(/between 30000 and 600000 \(the ceiling set by WREN_HARNESS_MAX_COMPONENT_TIMEOUT_MS\)/);
  });

  it("builds a read-only DTO without a boot config", () => {
    expect(executionLimitsDtoFor(undefined, undefined, undefined)).toMatchObject({ componentTimeoutMs: 120_000, componentTimeoutSource: "default", editable: false });
    expect(executionLimitsDtoFor(undefined, undefined, { ...DEFAULT_COMPONENT_LIMITS, timeoutMs: 300_000 })).toMatchObject({ componentTimeoutMs: 300_000, componentTimeoutSource: "env", editable: false });
    expect(executionLimitsDtoFor(config, { componentTimeoutMs: 480_000 }, undefined)).toMatchObject({ componentTimeoutMs: 480_000, componentTimeoutSource: "operator", editable: true });
  });
});

describe("withRunBudget", () => {
  it("names the budget and where to raise it while keeping the code suffix parseable", () => {
    const config = resolveExecutionLimitsConfig({}, "personal");
    const message = withRunBudget(componentFailureMessage("cancelled"), effectiveExecutionLimits(config, { componentTimeoutMs: 300_000 }));
    expect(message).toBe("The component run was cancelled or timed out; the run budget was 300 s (set on the Harness page); raise it on the Harness page (cancelled).");
    expect(componentFailureCodeOf(message)).toBe("cancelled");
    const hosted = withRunBudget(componentFailureMessage("cancelled"), effectiveExecutionLimits(resolveExecutionLimitsConfig({}, "hosted"), undefined));
    expect(hosted).toContain("the run budget was 120 s (the built-in default); ask the deployer to raise WREN_HARNESS_COMPONENT_TIMEOUT_MS (cancelled).");
  });
});
