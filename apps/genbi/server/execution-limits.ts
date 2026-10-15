import { COMPONENT_TIMEOUT_MS_RANGE, CliUsageError, parseComponentTimeoutMs } from "../harness/cli-args.js";
import type { Deployment } from "../harness/compliance/index.js";
import { DEFAULT_COMPONENT_LIMITS } from "../harness/components/runner.js";
import type { ComponentLimits } from "../harness/components/runner.js";
import type { ExecutionLimitsDto, HarnessLimitSource, OperatorExecutionLimits } from "./wire-types.js";

/** Where the deployer-level component timeout came from. The operator layer is `HarnessLimitSource`. */
export type ComponentTimeoutSource = "default" | "env";

/** The deployer's execution budget, resolved once at boot from the environment. */
export interface ExecutionLimits {
  readonly componentLimits: ComponentLimits;
  readonly componentTimeoutSource: ComponentTimeoutSource;
}

/**
 * Everything the environment says about execution limits: the deployer's budget, the ceiling an
 * operator may raise it to, and the deployment kind that decides whether operators may edit at all.
 */
export interface ExecutionLimitsConfig {
  readonly deployer: ExecutionLimits;
  /** Upper bound for an operator override; `WREN_HARNESS_MAX_COMPONENT_TIMEOUT_MS` or the range maximum. */
  readonly ceilingMs: number;
  readonly ceilingSource: ComponentTimeoutSource;
  readonly deployment: Deployment;
}

/** The budget in force right now: deployer config plus the operator's saved override, if one applies. */
export interface EffectiveExecutionLimits {
  readonly componentLimits: ComponentLimits;
  readonly componentTimeoutSource: HarnessLimitSource;
  readonly deployerTimeoutMs: number;
  readonly ceilingMs: number;
  readonly minMs: number;
  readonly editable: boolean;
  readonly editableReason?: string;
  readonly operatorTimeoutMs?: number;
}

/** A rejected operator value; the message is safe to return to the browser. */
export class ExecutionLimitsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExecutionLimitsError";
  }
}

const HOSTED_LOCK_REASON =
  "Operator overrides are disabled on a hosted deployment until the deployer sets WREN_HARNESS_MAX_COMPONENT_TIMEOUT_MS as the ceiling.";

/**
 * Resolves the deployer's execution budget from the environment. Precedence is built-in default
 * < `WREN_HARNESS_COMPONENT_TIMEOUT_MS`; a malformed or out-of-range value throws `CliUsageError`
 * so boot stops with the variable and its range named, never a silent fallback to 120 s. Only the
 * timeout is deployer-settable: the byte, depth and step caps are part of the host contract and
 * stay at `DEFAULT_COMPONENT_LIMITS`.
 */
export function resolveExecutionLimits(env: Readonly<Record<string, string | undefined>>): ExecutionLimits {
  const timeoutMs = parseComponentTimeoutMs(env["WREN_HARNESS_COMPONENT_TIMEOUT_MS"]);
  if (timeoutMs === undefined) return { componentLimits: DEFAULT_COMPONENT_LIMITS, componentTimeoutSource: "default" };
  return { componentLimits: Object.freeze({ ...DEFAULT_COMPONENT_LIMITS, timeoutMs }), componentTimeoutSource: "env" };
}

/**
 * The full boot-time configuration: the deployer budget plus the operator ceiling. The ceiling
 * must not sit below the deployer's own value, otherwise the deployer could never be in force.
 */
export function resolveExecutionLimitsConfig(env: Readonly<Record<string, string | undefined>>, deployment: Deployment): ExecutionLimitsConfig {
  const deployer = resolveExecutionLimits(env);
  const ceiling = parseComponentTimeoutMs(env["WREN_HARNESS_MAX_COMPONENT_TIMEOUT_MS"], "WREN_HARNESS_MAX_COMPONENT_TIMEOUT_MS");
  const ceilingMs = ceiling ?? COMPONENT_TIMEOUT_MS_RANGE.max;
  if (deployer.componentLimits.timeoutMs > ceilingMs) {
    throw new CliUsageError(
      `WREN_HARNESS_COMPONENT_TIMEOUT_MS (${deployer.componentLimits.timeoutMs}) exceeds WREN_HARNESS_MAX_COMPONENT_TIMEOUT_MS (${ceilingMs})`,
    );
  }
  return { deployer, ceilingMs, ceilingSource: ceiling === undefined ? "default" : "env", deployment };
}

/**
 * Applies the operator's saved override on top of the deployer config. Precedence is built-in
 * default < deployer env < operator. An override is applied only when operators may edit on this
 * deployment and the value is still inside the current range; a stale override that no longer
 * fits (the deployer lowered the ceiling) is reported but not enforced.
 */
export function effectiveExecutionLimits(config: ExecutionLimitsConfig, operator: OperatorExecutionLimits | undefined): EffectiveExecutionLimits {
  const editable = config.deployment !== "hosted" || config.ceilingSource === "env";
  const base = config.deployer;
  const operatorMs = operator?.componentTimeoutMs;
  const applies = editable && operatorMs !== undefined && Number.isInteger(operatorMs)
    && operatorMs >= COMPONENT_TIMEOUT_MS_RANGE.min && operatorMs <= config.ceilingMs;
  return {
    componentLimits: applies ? Object.freeze({ ...base.componentLimits, timeoutMs: operatorMs }) : base.componentLimits,
    componentTimeoutSource: applies ? "operator" : base.componentTimeoutSource,
    deployerTimeoutMs: base.componentLimits.timeoutMs,
    ceilingMs: config.ceilingMs,
    minMs: COMPONENT_TIMEOUT_MS_RANGE.min,
    editable,
    ...(editable ? {} : { editableReason: HOSTED_LOCK_REASON }),
    ...(operatorMs !== undefined ? { operatorTimeoutMs: operatorMs } : {}),
  };
}

/** Validates a value an operator wants to save; throws `ExecutionLimitsError` with the allowed range. */
export function validateOperatorComponentTimeoutMs(config: ExecutionLimitsConfig, raw: unknown): number {
  const ceilingNote = config.ceilingSource === "env" ? " (the ceiling set by WREN_HARNESS_MAX_COMPONENT_TIMEOUT_MS)" : "";
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < COMPONENT_TIMEOUT_MS_RANGE.min || raw > config.ceilingMs) {
    throw new ExecutionLimitsError(
      `componentTimeoutMs must be an integer number of milliseconds between ${COMPONENT_TIMEOUT_MS_RANGE.min} and ${config.ceilingMs}${ceilingNote}, got ${JSON.stringify(raw)}`,
    );
  }
  return raw;
}

/**
 * The `GET/PUT /api/config/limits` body. Without a boot config (tests, or a `TurnDeps` built
 * without one) the DTO describes the fixed route options and is read-only.
 */
export function executionLimitsDtoFor(
  config: ExecutionLimitsConfig | undefined, operator: OperatorExecutionLimits | undefined, boot: ComponentLimits | undefined,
): ExecutionLimitsDto {
  if (config === undefined) {
    const timeoutMs = boot?.timeoutMs ?? DEFAULT_COMPONENT_LIMITS.timeoutMs;
    return {
      componentTimeoutMs: timeoutMs, componentTimeoutSource: boot ? "env" : "default", deployerTimeoutMs: timeoutMs,
      ceilingMs: COMPONENT_TIMEOUT_MS_RANGE.max, minMs: COMPONENT_TIMEOUT_MS_RANGE.min,
      editable: false, editableReason: "Execution limits are not configured on this BFF instance.",
    };
  }
  const { componentLimits, ...rest } = effectiveExecutionLimits(config, operator);
  return { componentTimeoutMs: componentLimits.timeoutMs, ...rest };
}

/** Appends the budget a cancelled run had to its user-facing message, keeping the trailing `(code).` that names the code. */
export function withRunBudget(message: string, limits: EffectiveExecutionLimits): string {
  const seconds = limits.componentLimits.timeoutMs / 1000;
  const source = limits.componentTimeoutSource === "operator" ? "set on the Harness page"
    : limits.componentTimeoutSource === "env" ? "set by WREN_HARNESS_COMPONENT_TIMEOUT_MS" : "the built-in default";
  const raise = limits.editable ? "raise it on the Harness page" : "ask the deployer to raise WREN_HARNESS_COMPONENT_TIMEOUT_MS";
  const budget = `the run budget was ${seconds} s (${source}); ${raise}`;
  return / \(\w+\)\.$/.test(message) ? message.replace(/ \((\w+)\)\.$/, `; ${budget} ($1).`) : `${message} ${budget}.`;
}

/** The boot-log line that states the effective deployer budget and where it came from. */
export function describeExecutionLimits(limits: ExecutionLimits): string {
  const { timeoutMs } = limits.componentLimits;
  const source = limits.componentTimeoutSource === "env" ? "WREN_HARNESS_COMPONENT_TIMEOUT_MS" : "built-in default";
  return `execution limits: component run timeout ${timeoutMs} ms (${timeoutMs / 1000} s, ${source})`;
}

/** The boot-log line for the full config: deployer budget plus the operator ceiling. */
export function describeExecutionLimitsConfig(config: ExecutionLimitsConfig): string {
  const ceilingSource = config.ceilingSource === "env" ? "WREN_HARNESS_MAX_COMPONENT_TIMEOUT_MS" : "built-in default";
  const operators = effectiveExecutionLimits(config, undefined).editable ? "operators may raise it on the Harness page" : "operator overrides disabled (hosted)";
  return `${describeExecutionLimits(config.deployer)}; ceiling ${config.ceilingMs} ms (${ceilingSource}); ${operators}`;
}
