import { types } from "node:util";
import { GovernedWrenError, GOVERNED_ERROR_CLASSES, type GovernedErrorClass } from "../harness/components/wren-access.js";
import type { ComponentAccess } from "../harness/components/broker.js";
import { StructuredRuntimeError } from "./structured-runtime.js";

export interface StructuredErrorFeedback {
  readonly code: string;
  readonly kind: "query" | "connection" | "runtime";
  readonly message: string;
}
const queryMessages: Readonly<Record<GovernedErrorClass, string>> = Object.freeze({
  invalid_request: "The query request is invalid. Please rephrase the question.",
  model_not_found: "The requested table is unavailable in the current dataset. Use the tables in its semantic context.",
  cube_not_queryable: "The query read a semantic definition as if it were a table. Use the base model of that definition and compute the measure from its columns.",
  ungrounded_literal: "The query returned values typed into it rather than data from the dataset. Compute the value from the dataset's tables in one query.",
  declared_default_missing: "The query skipped a default rule that the project declares for this dataset. Apply the project's default rule and run the query again.",
  policy_rejected: "The query was rejected by the read-only policy. Use a read-only analytical query.",
  invalid_sql: "The query could not be planned against the current dataset. Check the SQL and required columns.",
  execution_failed: "The current dataset could not execute the query. Check that the required columns exist and their types match the query.",
  timeout: "The query exceeded its time limit. Narrow the question before trying again.",
  datasource_unavailable: "The data source is unavailable. Check its connection before trying again.",
  result_too_large: "The query result is too large. Request fewer rows or a summary.",
  internal: "The query failed for an unknown reason. No verified answer was saved.",
  transport: "The connection to the data worker is unavailable. No verified answer was saved.",
});
const failures = new WeakMap<object, StructuredErrorFeedback>();
class StructuredQueryError extends StructuredRuntimeError {
  constructor(errorClass: GovernedErrorClass) {
    super("failed");
    const feedback = { code: `query.${errorClass}`, kind: errorClass === "transport" ? "connection" as const : "query" as const, message: queryMessages[errorClass] };
    this.message = feedback.message;
    failures.set(this, Object.freeze(feedback));
  }
}
/** Only an actual host query rejection is recorded; model text and serialized lookalikes have no authority. */
export function observeStructuredQueryAccess(access: ComponentAccess, record: (failure: Error | undefined) => void): ComponentAccess {
  return { ...access, async query(...args) {
    try { const result = await Reflect.apply(access.query, access, args); record(undefined); return result; }
    catch (error) {
      let failure: Error | undefined;
      if (error && typeof error === "object" && !types.isProxy(error) && Object.getPrototypeOf(error) === GovernedWrenError.prototype) {
        const descriptor = Object.getOwnPropertyDescriptor(error, "errorClass");
        if (descriptor && "value" in descriptor && GOVERNED_ERROR_CLASSES.includes(descriptor.value)) failure = new StructuredQueryError(descriptor.value);
      }
      record(failure); throw error;
    }
  } };
}
export function isStructuredQueryFailure(error: unknown): boolean {
  return !!error && typeof error === "object" && failures.has(error);
}
/** One prepared root's last query cause is eligible only after its provider returned successfully. */
export function createStructuredQueryFailureTracker() {
  let failure: Error | undefined;
  let providerReturned = false;
  let failedStep = false;
  const clear = () => { failure = undefined; providerReturned = false; failedStep = false; };
  return {
    record(value: Error | undefined) { failure = value; },
    start: clear,
    providerReturned(failed: boolean) { if (failed) clear(); else providerReturned = true; },
    providerRejected: clear,
    providerQueryAborted() { providerReturned = true; },
    finish(status?: string) { if (status !== "error") clear(); else failedStep = providerReturned && failure !== undefined; },
    terminalFailure() { return failedStep ? failure : undefined; },
  };
}
const runtimeCodes = ["unavailable", "unsupported", "stale", "cancelled", "failed", "cleanup", "timeout", "unaccepted"] as const;
const unacceptedMessage = "I could not produce a verified answer for that question. Your session is still open; try rephrasing or ask another question.";
export function storedStructuredFailure(code?: string | null): StructuredErrorFeedback {
  const queryClass = GOVERNED_ERROR_CLASSES.find(value => code === `query.${value}`);
  if (queryClass) return { code: `query.${queryClass}`, kind: queryClass === "transport" ? "connection" : "query", message: queryMessages[queryClass] };
  const runtimeCode = runtimeCodes.find(value => code === `runtime.${value}`) ?? "failed";
  return { code: `runtime.${runtimeCode}`, kind: "runtime", message: runtimeCode === "unaccepted" ? unacceptedMessage : `Structured runtime ${runtimeCode}.` };
}
/** Closed set of failures that end only the turn: cleanup is confirmed and no sandbox, transport or query-source fault is implied. Everything else, including any unknown code, ends the session. */
export const SESSION_KEEPING_FAILURE_CODES: ReadonlySet<string> = new Set(["runtime.unaccepted", "query.invalid_request", "query.policy_rejected"]);
/** Closed data-query inability, never an infrastructure diagnosis or a specific missing-field claim. */
export function structuredDataRefusal(code?: string | null): { readonly reason: string; readonly fix: string } | undefined {
  if (code === "query.execution_failed") return {
    reason: "I could not answer this question from the current dataset because the query could not be completed.",
    fix: "Check whether the required fields are available and their types match the query, or ask a question the current dataset can support.",
  };
  if (code === "query.invalid_sql") return {
    reason: "I could not answer this question because the query could not be planned against the current dataset.",
    fix: "Rephrase the question using the dataset's available tables and fields.",
  };
  if (code === "query.model_not_found") return {
    reason: "I could not answer this question because the requested table is unavailable in the current dataset.",
    fix: "Use a table in the current semantic context, or connect the required data.",
  };
  if (code === "query.cube_not_queryable") return {
    reason: "I could not answer this question because the query read a semantic definition as if it were a table.",
    fix: "Ask for the measure over its base model's fields, or rephrase the question using the dataset's tables and fields.",
  };
  if (code === "query.ungrounded_literal") return {
    reason: "I could not answer this question because the query returned values typed into it rather than data from the dataset.",
    fix: "Ask the question again so the answer is computed from the dataset's tables, or rephrase it using the dataset's available fields.",
  };
  if (code === "query.declared_default_missing") return {
    reason: "I could not answer this question because the query did not apply a declared default rule of the project.",
    fix: "Ask the question again so the answer is computed with the project's default rules applied, or rephrase it using the dataset's available fields.",
  };
  return undefined;
}
/** Public feedback never reads an exception message, SQL, path, stack or vendor payload. */
export function structuredFailureFeedback(error: unknown): StructuredErrorFeedback {
  if (error && typeof error === "object") {
    const known = failures.get(error);
    if (known) return known;
    if (!types.isProxy(error) && Object.getPrototypeOf(error) === StructuredRuntimeError.prototype) {
      const descriptor = Object.getOwnPropertyDescriptor(error, "code");
      if (descriptor && "value" in descriptor && runtimeCodes.includes(descriptor.value)) return storedStructuredFailure(`runtime.${descriptor.value}`);
    }
  }
  return storedStructuredFailure();
}
