import type { AdapterSpec, TierBinding } from "../providers/binding.js";
import type { ExecutionPlan } from "./runner.js";
import { evaluateZoneGate, type ZoneGateResult } from "./zone-gate.js";

export interface AdapterAudit {
  readonly adapter: string;
  readonly model: string;
  readonly endpointHost: string;
  readonly thinking: "on" | "off" | "unset";
}

export interface ZoneDryRunEdge {
  readonly from: string;
  readonly alias: string;
  readonly to: string;
}

export interface ZoneDryRunOptions {
  /** The capability card that public-zone steps would receive, when the project is known. */
  readonly card?: { readonly digest: string; readonly bytes: number; readonly truncated: boolean };
}
export interface ZoneDryRun {
  readonly gate: ZoneGateResult;
  readonly card?: ZoneDryRunOptions["card"];
  /** Which host context each step would receive: the card on public steps, the snapshot elsewhere. */
  readonly contexts: Readonly<Record<string, "card" | "snapshot">>;
  readonly audits: Readonly<Record<string, AdapterAudit>>;
  readonly edges: readonly ZoneDryRunEdge[];
  /** 0 when the gate is not armed or found nothing; 1 on any violation. */
  readonly exitCode: 0 | 1;
}

function readString(record: unknown, key: string): string | undefined {
  if (typeof record !== "object" || record === null) return undefined;
  const value = (record as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * What an audit needs to know about the serving runtime behind a spec,
 * read from the spec's configuration alone. No adapter is constructed, no
 * request is made: the dry-run must stay runnable with no network and no
 * credentials.
 */
export function auditAdapterSpec(spec: AdapterSpec): AdapterAudit {
  const config = spec.config as Record<string, unknown> | undefined;
  const baseURL = readString(config, "baseURL");
  let endpointHost = "(adapter default)";
  if (baseURL !== undefined) {
    try { endpointHost = new URL(baseURL).host; } catch { endpointHost = `(invalid baseURL: ${baseURL})`; }
  } else if (spec.adapter === "anthropic") {
    endpointHost = "api.anthropic.com (adapter default)";
  } else if (spec.adapter === "mock") {
    endpointHost = "(none: mock)";
  }
  const extraBody = config?.["extraBody"];
  const kwargs = typeof extraBody === "object" && extraBody !== null ? (extraBody as Record<string, unknown>)["chat_template_kwargs"] : undefined;
  const enable = typeof kwargs === "object" && kwargs !== null ? (kwargs as Record<string, unknown>)["enable_thinking"] : undefined;
  return {
    adapter: spec.adapter,
    model: readString(config, "model") ?? "(adapter default)",
    endpointHost,
    thinking: enable === true ? "on" : enable === false ? "off" : "unset",
  };
}

/** Evaluates the gate over the plan and collects everything an audit prints; pure, offline. */
export function describeZoneDryRun(plan: ExecutionPlan, entry: string, binding: TierBinding, options: ZoneDryRunOptions = {}): ZoneDryRun {
  const gate = evaluateZoneGate(plan, entry, binding);
  const contexts: Record<string, "card" | "snapshot"> = {};
  for (const report of gate.steps) contexts[`${report.component}.${report.step}`] = gate.armed && report.zone === "public" ? "card" : "snapshot";
  const audits: Record<string, AdapterAudit> = {};
  for (const report of gate.steps) if (report.key !== undefined && report.spec) audits[report.key] = auditAdapterSpec(report.spec);
  for (const role of gate.roles) if (role.spec) audits[role.key] = auditAdapterSpec(role.spec);
  const edges: ZoneDryRunEdge[] = [];
  for (const report of gate.steps) for (const edge of report.calls) edges.push({ from: `${report.component}.${report.step}`, alias: edge.alias, to: edge.component });
  return { gate, ...(options.card ? { card: options.card } : {}), contexts, audits, edges, exitCode: gate.armed && gate.violations.length > 0 ? 1 : 0 };
}

/** Renders a dry-run as the fixed-width text the CLI prints. */
export function formatZoneDryRun(dryRun: ZoneDryRun): string {
  const lines: string[] = [];
  const { gate } = dryRun;
  lines.push(`zone dry-run · entry ${gate.entry} · gate ${gate.armed ? "armed" : "NOT armed (legacy single-zone binding: no zone, disclosure_policy or roles declared)"}`);
  lines.push("");
  lines.push("steps");
  for (const step of gate.steps) {
    const audit = step.key !== undefined ? dryRun.audits[step.key] : undefined;
    const where = audit ? `${audit.adapter} model=${audit.model} host=${audit.endpointHost} thinking=${audit.thinking}` : "(unbound)";
    const tools = step.dataTools.length ? ` tools=${step.dataTools.join(",")}` : "";
    const context = dryRun.contexts[`${step.component}.${step.step}`] ?? "snapshot";
    const contextText = context === "card" ? `context=card${dryRun.card ? ` sha256:${dryRun.card.digest}` : ""}` : "context=snapshot";
    lines.push(`  ${step.component}.${step.step}  role=${step.role}  tier=${step.tier}  key=${step.key ?? "-"}  zone=${step.zone}  ${contextText}  ${where}${tools}`);
  }
  if (dryRun.card) lines.push(`  capability card: sha256:${dryRun.card.digest} (${dryRun.card.bytes} bytes${dryRun.card.truncated ? ", truncated" : ""}) — sent to public-zone steps only`);
  lines.push("");
  lines.push("call edges");
  if (dryRun.edges.length === 0) lines.push("  (none)");
  for (const edge of dryRun.edges) lines.push(`  ${edge.from} --[${edge.alias}]--> ${edge.to}`);
  lines.push("");
  lines.push("roles");
  if (gate.roles.length === 0) lines.push("  (none declared)");
  for (const role of gate.roles) {
    const audit = dryRun.audits[role.key];
    const where = audit ? `${audit.adapter} model=${audit.model} host=${audit.endpointHost} thinking=${audit.thinking}` : "(unbound)";
    lines.push(`  ${role.role}  key=${role.key}  zone=${role.zone}  ${where}`);
  }
  lines.push("");
  if (!gate.armed) lines.push("result: gate not armed; nothing was checked");
  else if (gate.violations.length === 0) lines.push("result: ok (no zone violations)");
  else {
    lines.push(`result: REJECTED (${gate.violations.length} violation${gate.violations.length === 1 ? "" : "s"})`);
    for (const violation of gate.violations) lines.push(`  - [${violation.code}] ${violation.message}`);
  }
  return `${lines.join("\n")}\n`;
}
