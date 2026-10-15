import { parseComponentTimeoutMs } from "../harness/cli-args.js";
import { DEFAULT_COMPONENT_LIMITS } from "../harness/components/runner.js";
import type { ComponentLimits } from "../harness/components/runner.js";

/** Where the component timeout's effective value came from. An operator-editable layer is a later ticket. */
export type ComponentTimeoutSource = "default" | "env";

/** The execution budget this BFF enforces, resolved once at boot. */
export interface ExecutionLimits {
  readonly componentLimits: ComponentLimits;
  readonly componentTimeoutSource: ComponentTimeoutSource;
}

/**
 * Resolves the host's execution budget from the deployer's environment. Precedence is
 * built-in default < `WREN_HARNESS_COMPONENT_TIMEOUT_MS`; a malformed or out-of-range value
 * throws `CliUsageError` so boot stops with the variable and its range named, never a silent
 * fallback to 120 s. Only the timeout is deployer-settable: the byte, depth and step caps are
 * part of the host contract and stay at `DEFAULT_COMPONENT_LIMITS`.
 */
export function resolveExecutionLimits(env: Readonly<Record<string, string | undefined>>): ExecutionLimits {
  const timeoutMs = parseComponentTimeoutMs(env["WREN_HARNESS_COMPONENT_TIMEOUT_MS"]);
  if (timeoutMs === undefined) return { componentLimits: DEFAULT_COMPONENT_LIMITS, componentTimeoutSource: "default" };
  return { componentLimits: Object.freeze({ ...DEFAULT_COMPONENT_LIMITS, timeoutMs }), componentTimeoutSource: "env" };
}

/** The boot-log line that states the effective budget and where it came from. */
export function describeExecutionLimits(limits: ExecutionLimits): string {
  const { timeoutMs } = limits.componentLimits;
  const source = limits.componentTimeoutSource === "env" ? "WREN_HARNESS_COMPONENT_TIMEOUT_MS" : "built-in default";
  return `execution limits: component run timeout ${timeoutMs} ms (${timeoutMs / 1000} s, ${source})`;
}
