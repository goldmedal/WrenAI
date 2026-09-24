import { isZoneAwareBinding, resolveTierSpec, type AdapterSpec, type TierBinding } from "../providers/binding.js";
import type { Zone } from "../providers/zone.js";
import type { ComponentStep, ExecutionPlan } from "./runner.js";

/** Where a step sits in the composition as seen from one entry. */
export type ZoneStepRole = "caller" | "callee";

export interface ZoneStepReport {
  readonly component: string;
  readonly step: string;
  readonly tier: string;
  readonly role: ZoneStepRole;
  /** The binding key that bound this (mount, tier); undefined when nothing did. */
  readonly key?: string;
  readonly spec?: AdapterSpec;
  readonly zone: Zone | "unbound";
  /** Data-bearing tool grants on the step (query / semantic_introspect). */
  readonly dataTools: readonly string[];
  readonly calls: readonly { readonly alias: string; readonly component: string }[];
}

export interface ZoneRoleReport {
  readonly role: "judge" | "render";
  readonly key: string;
  readonly spec?: AdapterSpec;
  readonly zone: Zone | "unbound";
}

export type ZoneGateViolationCode =
  | "callee_public"
  | "data_step_public"
  | "missing_zone"
  | "unbound_tier"
  | "judge_public"
  | "render_public"
  | "missing_judge";

export interface ZoneGateViolation {
  readonly code: ZoneGateViolationCode;
  readonly component?: string;
  readonly step?: string;
  readonly tier: string;
  readonly zone: Zone | "unbound";
  readonly message: string;
}

export interface ZoneGateResult {
  /** False for a legacy single-zone binding: nothing was checked and nothing is claimed. */
  readonly armed: boolean;
  readonly entry: string;
  readonly steps: readonly ZoneStepReport[];
  readonly roles: readonly ZoneRoleReport[];
  readonly violations: readonly ZoneGateViolation[];
}

export class ZoneGateError extends Error {
  constructor(readonly violations: readonly ZoneGateViolation[]) {
    super(`zone gate rejected the binding:\n${violations.map((violation) => `  - ${violation.message}`).join("\n")}`);
    this.name = "ZoneGateError";
  }
}

/** The mounts reachable from `entry`, in first-visit order; the entry itself is first. */
export function reachableMounts(plan: ExecutionPlan, entry: string): string[] {
  const closure: string[] = [];
  const seen = new Set<string>();
  const visit = (id: string): void => {
    if (seen.has(id)) return;
    seen.add(id);
    closure.push(id);
    const node = plan.components[id];
    if (!node) throw new Error(`zone gate: plan has no component "${id}"`);
    for (const step of node.steps) for (const edge of step.calls) visit(edge.component);
  };
  visit(entry);
  return closure;
}

function dataToolNames(step: ComponentStep): string[] {
  return step.tools.map((tool) => tool.name);
}

/**
 * The zone gate: a pure function over (plan, binding) that decides whether a
 * binding may run a composition at all. Enforced at binding time, before any
 * model, tool or child session starts; a violation is a loud failure, never a
 * degrade.
 *
 * Rules, keyed on (mount, tier):
 * 1. every step of a callee mount (reached through a call edge) resolves to `zone: private`;
 * 2. every step that holds a data tool grant resolves to `zone: private`, whatever its mount;
 * 3. the `judge` role tier, when declared, is private; a disclosure policy without a judge fails;
 * 4. the `render` role tier, when declared, is private;
 * 5. a tier referenced by any of the above without a `zone` fails — no default zone;
 * 6. a caller step without data tools may be public, private, or leave zone unset.
 *
 * A binding with no zone information anywhere is not zone-aware: the gate is
 * not armed and the result carries no violations, only the step report.
 */
export function evaluateZoneGate(plan: ExecutionPlan, entry: string, binding: TierBinding): ZoneGateResult {
  const armed = isZoneAwareBinding(binding);
  const mounts = reachableMounts(plan, entry);
  const steps: ZoneStepReport[] = [];
  const violations: ZoneGateViolation[] = [];
  for (const mount of mounts) {
    const node = plan.components[mount]!;
    const role: ZoneStepRole = mount === entry ? "caller" : "callee";
    for (const step of node.steps) {
      const resolved = resolveTierSpec(binding, step.tier, mount);
      const zone: Zone | "unbound" = resolved?.spec.zone ?? "unbound";
      const report: ZoneStepReport = { component: mount, step: step.name, tier: step.tier, role,
        ...(resolved ? { key: resolved.key, spec: resolved.spec } : {}), zone, dataTools: dataToolNames(step), calls: step.calls };
      steps.push(report);
      if (!armed) continue;
      const where = `step ${mount}.${step.name} (tier ${step.tier})`;
      if (!resolved) {
        violations.push({ code: "unbound_tier", component: mount, step: step.name, tier: step.tier, zone,
          message: `${where} has no binding entry (looked up ${mount}/${step.tier}, then ${step.tier})` });
        continue;
      }
      const relevant = role === "callee" || report.dataTools.length > 0;
      if (!relevant) continue;
      const why = role === "callee" ? "runs inside the callee" : `holds data tools ${report.dataTools.join(", ")}`;
      if (zone === "unbound") {
        violations.push({ code: "missing_zone", component: mount, step: step.name, tier: step.tier, zone,
          message: `${where} ${why} but binding entry "${resolved.key}" declares no zone` });
      } else if (zone !== "private") {
        violations.push({ code: role === "callee" ? "callee_public" : "data_step_public", component: mount, step: step.name, tier: step.tier, zone,
          message: `${where} ${why} but binding entry "${resolved.key}" is zone: ${zone}; it must be private` });
      }
    }
  }
  const roles: ZoneRoleReport[] = [];
  for (const role of ["judge", "render"] as const) {
    const key = binding.roles?.[role];
    if (key === undefined) continue;
    const spec = binding.tiers[key];
    const zone: Zone | "unbound" = spec?.zone ?? "unbound";
    roles.push({ role, key, ...(spec ? { spec } : {}), zone });
    if (!armed) continue;
    if (!spec) {
      violations.push({ code: "unbound_tier", tier: key, zone, message: `${role} role names binding entry "${key}", which does not exist` });
    } else if (zone === "unbound") {
      violations.push({ code: "missing_zone", tier: key, zone, message: `${role} tier "${key}" declares no zone; it must be private` });
    } else if (zone !== "private") {
      violations.push({ code: role === "judge" ? "judge_public" : "render_public", tier: key, zone,
        message: `${role} tier "${key}" is zone: ${zone}; it ${role === "judge" ? "sees unfiltered answers" : "sees rows"} and must be private` });
    }
  }
  if (armed && binding.disclosurePolicy !== undefined && binding.roles?.judge === undefined) {
    violations.push({ code: "missing_judge", tier: "(none)", zone: "unbound",
      message: "disclosure_policy is set but roles.judge names no tier; the egress verification step needs a private judge" });
  }
  return { armed, entry, steps, roles, violations };
}

/** Runs the gate and throws {@link ZoneGateError} when an armed gate finds any violation. */
export function assertZoneGate(plan: ExecutionPlan, entry: string, binding: TierBinding): ZoneGateResult {
  const result = evaluateZoneGate(plan, entry, binding);
  if (result.armed && result.violations.length > 0) throw new ZoneGateError(result.violations);
  return result;
}
