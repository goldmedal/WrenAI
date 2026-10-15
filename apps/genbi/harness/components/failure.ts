/** Every code a failed component run can carry to the host; the user-facing text never includes more than this. */
export const COMPONENT_FAILURE_CODES = ["unsupported_callee", "invalid_request", "invalid_result", "budget_exhausted", "cancelled", "transient_transport", "callee_failed"] as const;
export type ComponentFailureCode = (typeof COMPONENT_FAILURE_CODES)[number];

const FAILURE_MESSAGES: Readonly<Record<ComponentFailureCode, string>> = {
  invalid_result: "The component produced a result that could not be assembled or validated",
  budget_exhausted: "The component exceeded its step or call budget",
  cancelled: "The component run was cancelled or timed out",
  callee_failed: "A component step or tool call failed",
  unsupported_callee: "The component called a component this deployment does not support",
  invalid_request: "The component received a request it could not accept",
  transient_transport: "The component lost its connection to the model or data service",
};
/** The generic, secret-free text for a failure code. It ends in `(code)` so a stored message still names its code. */
export function componentFailureMessage(code: ComponentFailureCode): string {
  return `${FAILURE_MESSAGES[code]} (${code}).`;
}
/** The code a message built by {@link componentFailureMessage} names, else undefined. */
export function componentFailureCodeOf(message: string): ComponentFailureCode | undefined {
  const found = /\((\w+)\)\.$/.exec(message)?.[1];
  const code = COMPONENT_FAILURE_CODES.find((candidate) => candidate === found);
  return code !== undefined && componentFailureMessage(code) === message ? code : undefined;
}
