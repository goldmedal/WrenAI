import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEFAULT_COMPONENT_LIMITS } from "../harness/components/runner.js";
import { GATEWAY_JWT_TTL, OPENSHELL_SUPERVISOR_DEFAULTS, RUNTIME_BUDGETS_MS } from "../harness/runtime-budgets.js";
import { CLAUDE_TRANSPORT_LIMITS } from "../server/runtime-host/claude-protocol.js";
import { NATIVE_SESSION_IDLE_TTL_MS } from "../server/native-sessions.js";
import { SANDBOX_PROBE_FAILURE_LIMIT } from "../server/openshell-native-sessions.js";

const read = (relative: string) => readFileSync(new URL(`../${relative}`, import.meta.url), "utf8");
const B = RUNTIME_BUDGETS_MS;

describe("runtime budgets", () => {
  it("pins every value", () => {
    expect({ ...B }).toEqual({
      claudeComponentStep: 120_000, claudeDuplexDeadline: 120_000, claudeTokenRefreshMargin: 135_000, defaultComponentTimeout: 120_000,
      sessionIdleTtl: 1_800_000, sandboxProbeInterval: 60_000, sandboxProbeTimeout: 45_000, sqlStatementDefault: 30_000, sqlStatementCap: 120_000,
    });
    expect({ ...OPENSHELL_SUPERVISOR_DEFAULTS }).toEqual({ boundaryTokenLifetimeMs: 900_000, renewalFraction: 0.8, renewalJitterFraction: 0.1 });
    expect(GATEWAY_JWT_TTL.owner).toBe("operator");
  });

  it("holds finite positive values and is frozen", () => {
    for (const value of [...Object.values(B), ...Object.values(OPENSHELL_SUPERVISOR_DEFAULTS)]) {
      expect(Number.isFinite(value)).toBe(true);
      expect(value).toBeGreaterThan(0);
    }
    for (const value of Object.values(B)) expect(Number.isInteger(value)).toBe(true);
    expect(Number.isInteger(OPENSHELL_SUPERVISOR_DEFAULTS.boundaryTokenLifetimeMs)).toBe(true);
    expect(Object.isFrozen(B) && Object.isFrozen(OPENSHELL_SUPERVISOR_DEFAULTS) && Object.isFrozen(GATEWAY_JWT_TTL)).toBe(true);
  });

  it("keeps the budgets consistent with each other", () => {
    expect(B.claudeComponentStep).toBeLessThanOrEqual(B.claudeDuplexDeadline);
    expect(B.defaultComponentTimeout).toBeGreaterThanOrEqual(B.claudeComponentStep);
    expect(B.sqlStatementCap).toBeLessThanOrEqual(B.claudeComponentStep);
    expect(B.sqlStatementDefault).toBeLessThanOrEqual(B.sqlStatementCap);
    expect(B.sessionIdleTtl).toBeGreaterThan(B.claudeComponentStep);
    expect(B.claudeComponentStep).toBeLessThan(B.claudeTokenRefreshMargin);
    expect(B.sandboxProbeTimeout).toBeLessThan(B.sandboxProbeInterval);
    expect(B.sandboxProbeInterval * SANDBOX_PROBE_FAILURE_LIMIT).toBeLessThan(B.sessionIdleTtl);
  });

  it("is what the runtime actually uses", () => {
    expect(CLAUDE_TRANSPORT_LIMITS.deadlineMs).toBe(B.claudeDuplexDeadline);
    expect(DEFAULT_COMPONENT_LIMITS.timeoutMs).toBe(B.defaultComponentTimeout);
    expect(NATIVE_SESSION_IDLE_TTL_MS).toBe(B.sessionIdleTtl);
  });

  it("has no remaining hardcodes at the source sites", () => {
    const step = read("server/runtime-host/claude-component-step.ts");
    expect(step).not.toMatch(/120_?000/);
    expect(step.match(/RUNTIME_BUDGETS_MS\.claudeComponentStep/g)?.length).toBe(3);
    expect(read("server/runtime-host/claude-protocol.ts")).toContain("deadlineMs: RUNTIME_BUDGETS_MS.claudeDuplexDeadline");
    for (const file of ["server/openshell-structured-ask.ts", "server/openshell-enrichment.ts"]) {
      const source = read(file);
      expect(source).toContain("?? RUNTIME_BUDGETS_MS.defaultComponentTimeout");
      expect(source).not.toContain("?? 120_000");
    }
    const sessions = read("server/openshell-native-sessions.ts");
    expect(sessions).toContain("RUNTIME_BUDGETS_MS.sessionIdleTtl");
    expect(sessions).not.toContain("30 * 60_000");
    expect(sessions).toContain("RUNTIME_BUDGETS_MS.sandboxProbeInterval");
    expect(read("server/runtime-host/openshell-lifecycle.ts")).toContain("RUNTIME_BUDGETS_MS.sandboxProbeTimeout");
    expect(read("server/native-sessions.ts")).toContain("NATIVE_SESSION_IDLE_TTL_MS = RUNTIME_BUDGETS_MS.sessionIdleTtl");
    expect(read("harness/components/runner.ts")).toContain("timeoutMs: RUNTIME_BUDGETS_MS.defaultComponentTimeout");
    const broker = read("harness/components/broker.ts");
    expect(broker).toContain("RUNTIME_BUDGETS_MS.sqlStatementCap");
    expect(broker).toContain("RUNTIME_BUDGETS_MS.sqlStatementDefault");
    expect(broker).not.toContain("Math.min(120_000");
  });

  it("keeps the SQL budgets out of the Python worker", () => {
    expect(read("runtime-assets/wren-worker/worker.py")).not.toMatch(/statement_timeout/);
  });
});
