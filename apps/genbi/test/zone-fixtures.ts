import type { ExecutionPlan } from "../harness/components/runner.js";
import type { AdapterSpec, TierBinding } from "../harness/providers/index.js";

/** A caller (plan_report: plan_layout -> narrate) composing a data-bearing callee (answer_batch). */
export function reportPlan(): ExecutionPlan {
  const declaration = { verb: "answer", type: "analytical", realization_kind: "skill", context_binding: { project: "/p" },
    guardrails: [{ name: "read_only_execution", locked: true }], effect: { render_blocks: [] } };
  return { identity: "report", entries: ["plan_report"], components: {
    plan_report: { id: "plan_report", declaration: { ...declaration, required_capabilities: ["component_invocation", "render_contract"],
      effect: { render_blocks: [{ type: "kpi_card", fields: { label: "string", value: "string" } }] } },
      steps: [
        { name: "plan_layout", tier: "plan", prompt: "Plan", consumes: [], produces: "layout", tools: [], calls: [{ alias: "ask", component: "answer_batch" }] },
        { name: "narrate", tier: "plan", prompt: "Narrate", consumes: ["layout"], produces: "report", tools: [], calls: [] },
      ] },
    answer_batch: { id: "answer_batch", declaration: { ...declaration, required_capabilities: ["sql_execution:read_only"] },
      steps: [
        { name: "resolve_intent", tier: "cheap", prompt: "Resolve", consumes: [], produces: "intent", tools: [], calls: [] },
        { name: "generate_sql", tier: "strong", prompt: "Query", consumes: ["intent"], produces: "data", tools: [{ name: "query", source: "native" }], calls: [] },
      ] },
  } };
}
export const priv = (modelId: string): AdapterSpec => ({ adapter: "mock", config: { modelId }, zone: "private" });
export const pub = (modelId: string): AdapterSpec => ({ adapter: "mock", config: { modelId }, zone: "public" });
export const policy = { allowed_shapes: ["scalar", "series", "table", "narrative"] as ("scalar" | "series" | "table" | "narrative")[], max_rows: 50, min_group_size: 5, sensitive_column_patterns: ["email"], pii_patterns: [], judge_timeout_ms: 30_000 };
export function splitBinding(): TierBinding {
  return { tiers: { plan: pub("sonnet"), cheap: priv("nano"), strong: priv("super"), judge: priv("nano-judge"), render: priv("nano-render") },
    disclosurePolicy: policy, roles: { judge: "judge", render: "render" } };
}

