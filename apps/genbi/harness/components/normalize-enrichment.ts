import type { ComponentInvocationResult } from "@warble/claude-agent-sdk";
import type { ComponentEvidence, ComponentPlan } from "./runner.js";
import { parseTerminalJson } from "./terminal-json.js";

/**
 * Normalization for the enrichment purpose. An enrichment stage's product is a host-typed document (a gap
 * inventory or a proposal), not a query-grounded answer or a render contract, so nothing here earns provenance:
 * the host validates the document itself (`server/enrichment.ts`) before it reaches any ledger.
 * A prose terminal is kept as text; an explicit refusal or error terminal can never become a result.
 */
export function normalizeEnrichmentEvidence(component: ComponentPlan, evidence: ComponentEvidence): ComponentInvocationResult {
  const refused: ComponentInvocationResult = { status: "refused", code: "callee_refused", message: "The component did not produce a result." };
  const terminal = component.steps.filter((step) => Object.hasOwn(evidence.steps, step.produces)).at(-1);
  if (!terminal) return refused;
  const product = evidence.steps[terminal.produces];
  const parsed = typeof product === "string" ? parseTerminalJson(product) : { ok: true as const, value: product };
  const value = parsed.ok ? parsed.value : product;
  if (value === undefined || value === null || (typeof value === "string" && value.trim() === "")) return refused;
  if (typeof value === "object" && !Array.isArray(value) && "status" in value && ["refused", "error"].includes(String((value as { status: unknown }).status))) return refused;
  return { status: "ok", output: { kind: "value", value }, provenance: { verified: false } };
}
