import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { describeZoneDryRun, formatZoneDryRun } from "../harness/components/zone-dry-run.js";
import type { TierBinding } from "../harness/providers/index.js";
import { policy, reportPlan } from "./zone-fixtures.js";

const nim = (model: string, thinking?: boolean) => ({ adapter: "openai-compatible", zone: "private" as const,
  config: { baseURL: "https://nim.internal:8443/v1", model, ...(thinking !== undefined ? { extraBody: { chat_template_kwargs: { enable_thinking: thinking } } } : {}) } });
function binding(): TierBinding {
  return { tiers: {
    "plan_report/plan": { adapter: "anthropic", config: { model: "claude-sonnet" }, zone: "public" },
    "answer_batch/strong": nim("nvidia/nemotron-3-super", true),
    cheap: nim("nvidia/nemotron-3-nano", false),
    judge: nim("nvidia/nemotron-3-nano", false),
    render: nim("nvidia/nemotron-3-nano"),
  }, disclosurePolicy: policy, roles: { judge: "judge", render: "render" } };
}

describe("zone dry-run", () => {
  const originalFetch = globalThis.fetch;
  beforeEach(() => {
    globalThis.fetch = (() => { throw new Error("network access during dry-run"); }) as typeof fetch;
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("OPENAI_API_KEY", "");
  });
  afterEach(() => { globalThis.fetch = originalFetch; vi.unstubAllEnvs(); });

  it("prints every step with component, tier, key, zone, adapter, model, endpoint host and thinking, plus every call edge", () => {
    const dryRun = describeZoneDryRun(reportPlan(), "plan_report", binding());
    expect(dryRun.exitCode).toBe(0);
    expect(dryRun.edges).toEqual([{ from: "plan_report.plan_layout", alias: "ask", to: "answer_batch" }]);
    expect(dryRun.audits["plan_report/plan"]).toEqual({ adapter: "anthropic", model: "claude-sonnet", endpointHost: "api.anthropic.com (adapter default)", thinking: "unset" });
    expect(dryRun.audits["answer_batch/strong"]).toEqual({ adapter: "openai-compatible", model: "nvidia/nemotron-3-super", endpointHost: "nim.internal:8443", thinking: "on" });
    expect(dryRun.audits["cheap"]).toMatchObject({ thinking: "off" });
    expect(dryRun.audits["render"]).toMatchObject({ thinking: "unset" });
    const text = formatZoneDryRun(dryRun);
    expect(text).toContain("gate armed");
    expect(text).toContain("plan_report.plan_layout  role=caller  tier=plan  key=plan_report/plan  zone=public  context=card  anthropic model=claude-sonnet host=api.anthropic.com (adapter default) thinking=unset");
    expect(text).toContain("answer_batch.generate_sql  role=callee  tier=strong  key=answer_batch/strong  zone=private  context=snapshot  openai-compatible model=nvidia/nemotron-3-super host=nim.internal:8443 thinking=on tools=query");
    expect(text).toContain("answer_batch.resolve_intent  role=callee  tier=cheap  key=cheap  zone=private  context=snapshot");
    expect(text).toContain("plan_report.plan_layout --[ask]--> answer_batch");
    expect(text).toContain("judge  key=judge  zone=private  openai-compatible model=nvidia/nemotron-3-nano host=nim.internal:8443 thinking=off");
    expect(text).toContain("result: ok");
  });
  it("exits non-zero and lists the violation when the gate rejects the binding", () => {
    const rejected = { ...binding(), tiers: { ...binding().tiers, "answer_batch/strong": { ...nim("x", true), zone: "public" as const } } };
    const dryRun = describeZoneDryRun(reportPlan(), "plan_report", rejected);
    expect(dryRun.exitCode).toBe(1);
    const text = formatZoneDryRun(dryRun);
    expect(text).toContain("result: REJECTED (1 violation)");
    expect(text).toContain("[callee_public] step answer_batch.generate_sql (tier strong)");
  });
  it("says when the gate is not armed and marks unbound zones", () => {
    const text = formatZoneDryRun(describeZoneDryRun(reportPlan(), "plan_report", { tiers: { plan: { adapter: "mock", config: {} }, cheap: { adapter: "mock", config: {} }, strong: { adapter: "mock", config: {} } } }));
    expect(text).toContain("NOT armed");
    expect(text).toContain("zone=unbound");
    expect(text).toContain("host=(none: mock)");
    expect(text).toContain("result: gate not armed");
  });
});
