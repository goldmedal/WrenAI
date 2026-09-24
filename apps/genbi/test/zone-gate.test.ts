import { describe, expect, it } from "vitest";
import { assertZoneGate, evaluateZoneGate, ZoneGateError } from "../harness/components/zone-gate.js";
import type { TierBinding } from "../harness/providers/index.js";
import { policy, priv, pub, reportPlan, splitBinding } from "./zone-fixtures.js";

describe("zone gate", () => {
  it("accepts a valid split binding and an all-private binding", () => {
    const split = evaluateZoneGate(reportPlan(), "plan_report", splitBinding());
    expect(split.armed).toBe(true);
    expect(split.violations).toEqual([]);
    expect(split.steps.map((step) => [step.component, step.step, step.role, step.zone])).toEqual([
      ["plan_report", "plan_layout", "caller", "public"], ["plan_report", "narrate", "caller", "public"],
      ["answer_batch", "resolve_intent", "callee", "private"], ["answer_batch", "generate_sql", "callee", "private"],
    ]);
    const allPrivate = { ...splitBinding(), tiers: { ...splitBinding().tiers, plan: priv("local-planner") } };
    expect(evaluateZoneGate(reportPlan(), "plan_report", allPrivate).violations).toEqual([]);
    expect(() => assertZoneGate(reportPlan(), "plan_report", allPrivate)).not.toThrow();
  });
  it("rejects a public tier on a callee step, naming step, tier and zone", () => {
    const binding = { ...splitBinding(), tiers: { ...splitBinding().tiers, strong: pub("cloud-strong") } };
    const result = evaluateZoneGate(reportPlan(), "plan_report", binding);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toMatchObject({ code: "callee_public", component: "answer_batch", step: "generate_sql", tier: "strong", zone: "public" });
    expect(result.violations[0]!.message).toMatch(/answer_batch\.generate_sql .*tier strong.*zone: public.*must be private/);
    expect(() => assertZoneGate(reportPlan(), "plan_report", binding)).toThrow(ZoneGateError);
  });
  it("rejects a public tier on a callee step even without a data tool (whole callee runs private)", () => {
    const binding = { ...splitBinding(), tiers: { ...splitBinding().tiers, cheap: pub("cloud-cheap") } };
    expect(evaluateZoneGate(reportPlan(), "plan_report", binding).violations).toMatchObject([{ code: "callee_public", step: "resolve_intent", tier: "cheap", zone: "public" }]);
  });
  it("rejects a public judge tier and a public render tier", () => {
    const judge = { ...splitBinding(), tiers: { ...splitBinding().tiers, judge: pub("cloud-judge") } };
    expect(evaluateZoneGate(reportPlan(), "plan_report", judge).violations).toMatchObject([{ code: "judge_public", tier: "judge", zone: "public" }]);
    expect(evaluateZoneGate(reportPlan(), "plan_report", judge).violations[0]!.message).toMatch(/judge tier "judge" is zone: public/);
    const render = { ...splitBinding(), tiers: { ...splitBinding().tiers, render: pub("cloud-render") } };
    expect(evaluateZoneGate(reportPlan(), "plan_report", render).violations).toMatchObject([{ code: "render_public", tier: "render", zone: "public" }]);
  });
  it("rejects a zone-relevant tier lacking zone, and a policy without a judge", () => {
    const { zone: _dropped, ...noZone } = priv("super");
    const binding = { ...splitBinding(), tiers: { ...splitBinding().tiers, strong: noZone } };
    const result = evaluateZoneGate(reportPlan(), "plan_report", binding);
    expect(result.violations).toMatchObject([{ code: "missing_zone", component: "answer_batch", step: "generate_sql", tier: "strong", zone: "unbound" }]);
    expect(result.violations[0]!.message).toMatch(/declares no zone/);
    const { roles: _roles, ...noJudge } = splitBinding();
    // Dropping `roles` loses the render role too; the entry renders a contract from a public terminal step, so that is its own violation.
    expect(evaluateZoneGate(reportPlan(), "plan_report", noJudge).violations.map((violation) => violation.code)).toEqual(["render_unbound", "missing_judge"]);
  });
  it("rejects a zone-aware binding whose public caller reaches a callee without a disclosure policy", () => {
    const { disclosurePolicy: _policy, roles: _roles, ...tiersOnly } = splitBinding();
    const result = evaluateZoneGate(reportPlan(), "plan_report", tiersOnly);
    expect(result.armed).toBe(true);
    expect(result.violations.filter((violation) => violation.code !== "render_unbound")).toMatchObject([{ code: "missing_policy", component: "plan_report", step: "plan_layout", tier: "plan", zone: "public" }]);
    // An all-private caller may compose without a policy: nothing crosses a zone. Its render stage inherits a private tier, so no render role is needed either.
    const allPrivate = { ...tiersOnly, tiers: { ...tiersOnly.tiers, plan: priv("local-planner") } };
    expect(evaluateZoneGate(reportPlan(), "plan_report", allPrivate).violations).toEqual([]);
  });
  it("rejects a data-bearing caller step on a public tier (spec §8 re-check)", () => {
    const plan = reportPlan();
    const caller = plan.components.plan_report!;
    const armed = { ...plan, components: { ...plan.components, plan_report: { ...caller, steps: [{ ...caller.steps[0]!, tools: [{ name: "query", source: "native" }] }, caller.steps[1]!] } } };
    expect(evaluateZoneGate(armed, "plan_report", splitBinding()).violations).toMatchObject([{ code: "data_step_public", component: "plan_report", step: "plan_layout", tier: "plan", zone: "public" }]);
  });
  it("lets a caller step without data tools leave zone unset, but reports it", () => {
    const { zone: _dropped, ...noZone } = pub("sonnet");
    const binding = { ...splitBinding(), tiers: { ...splitBinding().tiers, plan: noZone } };
    const result = evaluateZoneGate(reportPlan(), "plan_report", binding);
    expect(result.violations).toEqual([]);
    expect(result.steps[0]).toMatchObject({ step: "plan_layout", zone: "unbound" });
  });
  it("is keyed on (mount, tier): a shared tier name binds different zones and models per mount", () => {
    const binding: TierBinding = { tiers: {
      "plan_report/strong": pub("cloud-strong"), "answer_batch/strong": priv("local-strong"), cheap: priv("nano"), judge: priv("nano"), render: priv("nano") },
      disclosurePolicy: policy, roles: { judge: "judge", render: "render" } };
    const plan = reportPlan();
    const caller = plan.components.plan_report!;
    const shared = { ...plan, components: { ...plan.components, plan_report: { ...caller, steps: caller.steps.map((step) => ({ ...step, tier: "strong" })) } } };
    const result = evaluateZoneGate(shared, "plan_report", binding);
    expect(result.violations).toEqual([]);
    expect(result.steps.find((step) => step.component === "plan_report")).toMatchObject({ key: "plan_report/strong", zone: "public", spec: { config: { modelId: "cloud-strong" } } });
    expect(result.steps.find((step) => step.step === "generate_sql")).toMatchObject({ key: "answer_batch/strong", zone: "private", spec: { config: { modelId: "local-strong" } } });
    // Flat legacy key for the same tier name would put the callee on the public model: rejected.
    const flat: TierBinding = { ...binding, tiers: { strong: pub("cloud-strong"), cheap: priv("nano"), judge: priv("nano"), render: priv("nano") } };
    expect(evaluateZoneGate(shared, "plan_report", flat).violations).toMatchObject([{ code: "callee_public", step: "generate_sql", tier: "strong" }]);
  });
  it("is not armed for a legacy binding with no zone information, and reports unbound tiers", () => {
    const result = evaluateZoneGate(reportPlan(), "plan_report", { tiers: { plan: { adapter: "mock", config: {} }, cheap: { adapter: "mock", config: {} }, strong: { adapter: "mock", config: {} } } });
    expect(result.armed).toBe(false);
    expect(result.violations).toEqual([]);
    expect(result.steps.every((step) => step.zone === "unbound")).toBe(true);
    const { cheap: _cheap, ...withoutCheap } = splitBinding().tiers;
    const unbound = evaluateZoneGate(reportPlan(), "plan_report", { ...splitBinding(), tiers: withoutCheap });
    expect(unbound.violations).toMatchObject([{ code: "unbound_tier", step: "resolve_intent", tier: "cheap" }]);
    expect(unbound.violations[0]!.message).toMatch(/looked up answer_batch\/cheap, then cheap/);
  });
});

describe("zone gate: the render stage is bound explicitly", () => {
  it("rejects a binding that leaves the render stage on its default tier when that default is public", () => {
    const { roles, ...rest } = splitBinding();
    const noRender: TierBinding = { ...rest, roles: { judge: roles!.judge! } };
    const result = evaluateZoneGate(reportPlan(), "plan_report", noRender);
    expect(result.violations).toMatchObject([{ code: "render_unbound", component: "plan_report", step: "narrate", tier: "plan", zone: "public" }]);
    expect(result.violations[0]!.message).toMatch(/roles\.render names no tier.*inherit step plan_report\.narrate \(tier plan, zone public\)/);
    expect(() => assertZoneGate(reportPlan(), "plan_report", noRender)).toThrow(ZoneGateError);
  });
  it("rejects a render role bound to a public tier, and accepts one bound private", () => {
    const publicRender = { ...splitBinding(), tiers: { ...splitBinding().tiers, render: pub("cloud-render") } };
    expect(evaluateZoneGate(reportPlan(), "plan_report", publicRender).violations).toMatchObject([{ code: "render_public", tier: "render", zone: "public" }]);
    expect(evaluateZoneGate(reportPlan(), "plan_report", splitBinding()).violations).toEqual([]);
    expect(evaluateZoneGate(reportPlan(), "plan_report", splitBinding()).roles).toMatchObject([{ role: "judge", zone: "private" }, { role: "render", zone: "private" }]);
  });
  it("does not demand a render role when the stage would inherit a private tier anyway", () => {
    const { roles, ...rest } = splitBinding();
    const allPrivate: TierBinding = { ...rest, tiers: { ...rest.tiers, plan: priv("local-planner") }, roles: { judge: roles!.judge! } };
    expect(evaluateZoneGate(reportPlan(), "plan_report", allPrivate).violations).toEqual([]);
  });
});
