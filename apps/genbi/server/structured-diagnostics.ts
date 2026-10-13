import { beginStructuredTimingPhase } from "./structured-timing.js";
import { types } from "node:util";
import { ContextLoaderFailedError, ContextLoaderNotFoundError, InvalidProfileShapeError, WarbleBinaryNotFoundError, WarbleCommandFailedError } from "../harness/compile/errors.js";
import { StructuredRuntimeError } from "./structured-runtime.js";
import { InteractiveLaunchError } from "./native-session-workspace.js";

export const structuredDiagnosticStages = ["runtime_admission", "runtime_readiness", "adapter_dispatch", "adapter_validation", "adapter_preparation", "configuration", "executable_capture", "currentness", "compile_profile", "ir_tiers", "vendor_identity", "context_capture", "context_ir", "context_identity", "context_producer", "context_snapshot", "runtime_bindings", "host_admission", "host_plan", "model_scope", "broker_host", "provider_setup", "provider_open", "adapter_run", "adapter_result", "adapter_cleanup"] as const;
export type StructuredDiagnosticStage = typeof structuredDiagnosticStages[number];
export const structuredDiagnosticReasons = ["none", "unknown", "structured_unavailable", "structured_unsupported", "structured_stale", "structured_cancelled", "structured_failed", "structured_cleanup", "structured_timeout", "compile_command_failed", "context_loader_failed", "context_loader_unavailable", "profile_shape_invalid", "producer_unavailable", "system_enoent", "system_eacces", "system_eperm", "system_etimedout", "system_abort_err", "native_launch_invalid", "scope_signal_aborted"] as const;
export type StructuredDiagnosticReason = typeof structuredDiagnosticReasons[number];
export interface StructuredDiagnosticRecord {
  readonly stage: StructuredDiagnosticStage;
  readonly state: "entered" | "succeeded" | "failed";
  readonly reason: StructuredDiagnosticReason;
}
/** Host composition only: no request identity or exception payload crosses this seam. */
export type StructuredDiagnosticObserver = (record: Readonly<StructuredDiagnosticRecord>) => void;

export function structuredDiagnosticReason(error: unknown): StructuredDiagnosticReason {
  try {
    if (!error || typeof error !== "object" || types.isProxy(error)) return "unknown";
    const prototype = Object.getPrototypeOf(error);
    if (types.isProxy(prototype)) return "unknown";
    if (prototype === StructuredRuntimeError.prototype) {
      const descriptor = Object.getOwnPropertyDescriptor(error, "code");
      if (descriptor && "value" in descriptor) switch (descriptor.value) {
        case "unavailable": return "structured_unavailable"; case "unsupported": return "structured_unsupported";
        case "stale": return "structured_stale"; case "cancelled": return "structured_cancelled";
        case "failed": return "structured_failed"; case "cleanup": return "structured_cleanup"; case "timeout": return "structured_timeout";
      }
      return "unknown";
    }
    if (prototype === InteractiveLaunchError.prototype) return "native_launch_invalid";
    if (prototype === WarbleCommandFailedError.prototype) return "compile_command_failed";
    if (prototype === ContextLoaderFailedError.prototype) return "context_loader_failed";
    if (prototype === ContextLoaderNotFoundError.prototype) return "context_loader_unavailable";
    if (prototype === InvalidProfileShapeError.prototype) return "profile_shape_invalid";
    if (prototype === WarbleBinaryNotFoundError.prototype) return "producer_unavailable";
    const descriptor = Object.getOwnPropertyDescriptor(error, "code");
    if (descriptor && "value" in descriptor) switch (descriptor.value) {
      case "ENOENT": return "system_enoent"; case "EACCES": return "system_eacces"; case "EPERM": return "system_eperm";
      case "ETIMEDOUT": return "system_etimedout"; case "ABORT_ERR": return "system_abort_err";
    }
  } catch { /* Hostile values cannot turn observation into an exception. */ }
  return "unknown";
}
function notify(observer: StructuredDiagnosticObserver | undefined, stage: StructuredDiagnosticStage, state: StructuredDiagnosticRecord["state"], reason: StructuredDiagnosticReason): void {
  try {
    const result: unknown = observer?.(Object.freeze({ stage, state, reason }));
    // A mistaken asynchronous observer is still observational only.
    if (types.isPromise(result)) void Promise.prototype.then.call(result, undefined, () => {});
  } catch { /* Diagnostics never change the governed operation. */ }
}
/** Failure override is a host-local guard sample, never observer/config input. */
function reasonAtFailure(error: unknown, resolve?: () => StructuredDiagnosticReason | undefined): StructuredDiagnosticReason {
  if (resolve) try {
    const value: unknown = resolve();
    if (typeof value === "string" && value !== "none" && structuredDiagnosticReasons.includes(value as StructuredDiagnosticReason)) return value as StructuredDiagnosticReason;
    if (types.isPromise(value)) void Promise.prototype.then.call(value, undefined, () => {});
  } catch { /* Resolver failures cannot replace the original operation error. */ }
  return structuredDiagnosticReason(error);
}
export function observeStructured<T>(observer: StructuredDiagnosticObserver | undefined, stage: StructuredDiagnosticStage, operation: () => T, failureReason?: () => StructuredDiagnosticReason | undefined): T {
  if (!observer) return operation();
  const finish = beginStructuredTimingPhase(observer, stage); let failed = false;
  notify(observer, stage, "entered", "none");
  try { const result = operation(); notify(observer, stage, "succeeded", "none"); return result; }
  catch (error) { failed = true; notify(observer, stage, "failed", reasonAtFailure(error, failureReason)); throw error; }
  finally { finish?.(failed); }
}
export async function observeStructuredAsync<T>(observer: StructuredDiagnosticObserver | undefined, stage: StructuredDiagnosticStage, operation: () => Promise<T>): Promise<T> {
  if (!observer) return operation();
  const finish = beginStructuredTimingPhase(observer, stage); let failed = false;
  notify(observer, stage, "entered", "none");
  try { const result = await operation(); notify(observer, stage, "succeeded", "none"); return result; }
  catch (error) { failed = true; notify(observer, stage, "failed", structuredDiagnosticReason(error)); throw error; }
  finally { finish?.(failed); }
}
