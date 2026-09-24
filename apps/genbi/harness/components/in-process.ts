import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { LanguageModel } from "ai";
import { z } from "zod";
import { fingerprintSurfaces } from "@warble/claude-agent-sdk";
import { generatePreparedContext, generatePreparedContextAndCatalog, resolveContextLoader } from "../compile/context-loader.js";
import { hashDirectory } from "../compile/fingerprint.js";
import { resolveWarbleBinary } from "../compile/resolve-binary.js";
import type { PromptSurfaceRecord, StepTrace, TraceStep, UsageRecord } from "../events/types.js";
import { createAgentEventEmitter } from "../events/emitter.js";
import { createDefaultProviderRegistry, isZoneAwareBinding, resolveTierModel, resolveTierSpec, type AdapterSpec, type TierBinding } from "../providers/index.js";
import { deriveAdapterSpec } from "../route/adapter-spec.js";
import type { InProcessOptions } from "../route/types.js";
import type { RunAgentResult } from "../session/types.js";
import { resolveWrenBinary } from "../tools/index.js";
import { runAiComponentStep } from "./ai-step.js";
import { createComponentBroker, type ComponentAccess, type ContextSurface } from "./broker.js";
import { buildCapabilityCard, type CapabilityCard } from "./capability-card.js";
import { verifyEgress } from "./egress.js";
import { createModelJudge } from "./egress-judge.js";
import { normalizeComponentEvidence } from "./normalize.js";
import { buildSlotTable, isReportComponent, materialiseReportPlan, normalizeReportEvidence, parseReportPlan, reportSteps } from "./report.js";
import { planDigest } from "./plan.js";
import { ComponentRunner, type ExecutionPlan } from "./runner.js";
import { modelIdOf, summariseUsage, type StepUsage } from "./usage.js";
import { captureWrenAccessIdentity, openWrenComponentAccess } from "./wren-access.js";
import { assertZoneGate } from "./zone-gate.js";

const data = z.object({ columns: z.array(z.string()), rows: z.array(z.record(z.string(), z.unknown())) });

/** Executable format 0.2 path; never flattened into the legacy agent tool union. */
export async function runInProcessComponents(plan: ExecutionPlan, options: InProcessOptions): Promise<RunAgentResult> {
  if (options.mcpServers) throw new Error("Composed execution requires component-owned host bindings");
  // The historical default entry is `answer_query`; a composed profile with exactly one entry
  // (the report profile: `plan_report` alone is an entry) runs that entry when none is named.
  const entry = options.agentId ?? defaultEntry(plan);
  // The binding is fixed and gated here, before any scratch state, context
  // generation, provider construction or child process exists. A rejected
  // binding therefore produces none of them.
  const binding: TierBinding = {
    tiers: structuredClone(options.tierBinding ?? Object.fromEntries(
      Object.values(plan.components).flatMap((component) => component.steps.map((step) => [step.tier,
        deriveAdapterSpec(options.authChoice, options.model ? { model: options.model } : {})])),
    )),
    ...(options.disclosurePolicy !== undefined ? { disclosurePolicy: structuredClone(options.disclosurePolicy) } : {}),
    ...(options.zoneRoles !== undefined ? { roles: structuredClone(options.zoneRoles) } : {}),
  };
  assertZoneGate(plan, entry, binding);
  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  const scratch = await mkdtemp(path.join(os.tmpdir(), "genbi-component-context-"));
  const emitter = createAgentEventEmitter(options.onEvent);
  const traceSteps: TraceStep[] = [];
  const surfaceRecords: PromptSurfaceRecord[] = [];
  const usageRecords: UsageRecord[] = [];
  const trace = (): StepTrace => ({ steps: traceSteps.sort((a, b) => a.ordinal - b.ordinal), surfaces: surfaceRecords, usage: summariseUsage(usageRecords) });
  const toolOrder = new Map<string, number>();
  const zoneAware = isZoneAwareBinding(binding);
  emitter.emit({ kind: "run.start", mode: "A", agentId: entry });
  try {
    signal.throwIfAborted();
    const project = path.resolve(options.userProject);
    const fingerprint = await hashDirectory(project);
    const accessIdentity = await captureWrenAccessIdentity(project);
    const snapshotPath = path.join(scratch, "context.json");
    const catalogPath = path.join(scratch, "catalog.json");
    // A zone-aware run also needs the capability catalog: the card public-zone steps
    // receive instead of the snapshot. One generator process reads the project once.
    if (zoneAware) await generatePreparedContextAndCatalog(resolveContextLoader().bin, project, snapshotPath, catalogPath);
    else await generatePreparedContext(resolveContextLoader().bin, project, snapshotPath);
    const snapshot: unknown = JSON.parse(await readFile(snapshotPath, "utf8"));
    let card: CapabilityCard | undefined;
    if (zoneAware) {
      card = buildCapabilityCard(JSON.parse(await readFile(catalogPath, "utf8")), options.capabilityCard ?? {});
      if (card.truncated) traceSteps.push({ id: "capability-card", tool: "capability_card", outcome: "success", ordinal: -1,
        detail: `warning: capability card truncated by the size bound (${card.omittedLines} lines omitted, ${card.bytes} bytes kept)` });
    }
    const zoneOf = (component: string, tier: string) => resolveTierSpec(binding, tier, component)?.spec.zone ?? "unbound";
    const checkProject = async () => {
      signal.throwIfAborted();
      await accessIdentity.assertCurrent();
      if (fingerprint !== await hashDirectory(project)) { controller.abort(); throw new Error("Component project changed"); }
    };
    await checkProject();
    const contexts = Object.fromEntries(Object.values(plan.components).map((component) => {
      const binding = z.object({ project: z.string() }).passthrough().parse(component.declaration.context_binding);
      if (path.resolve(binding.project) !== project) throw new Error("Component is bound to another project");
      return [component.id, { binding, snapshot }];
    }));
    const registry = createDefaultProviderRegistry();
    const identity = { session: randomUUID(), vendor: "in-process", account: planDigest(binding), generation: randomUUID(),
      project, bindingRevision: planDigest([fingerprint, accessIdentity.digest]), contextDigest: planDigest(contexts), planDigest: plan.identity };
    const models = new Map<string, Map<string, ReturnType<typeof resolveTierModel>>>();
    // Counts only, attributed to the provider that served the call; the payload never enters the record.
    const recordUsage = (at: Pick<UsageRecord, "component" | "step" | "tier" | "depth">, spec: AdapterSpec | undefined, model: LanguageModel | undefined, usage: StepUsage) => {
      usageRecords.push({ ...at, zone: spec?.zone ?? "unbound", adapter: spec?.adapter ?? "unbound", model: model ? modelIdOf(model) : "unbound",
        inputTokens: usage.inputTokens, outputTokens: usage.outputTokens });
    };
    // The egress verification seam is installed whenever a disclosure policy is
    // bound. The gate has already required a private judge tier for it, so a
    // missing judge here is an internal error, not a degrade.
    const policy = binding.disclosurePolicy;
    const judgeKey = binding.roles?.judge;
    const judgeSpec = judgeKey !== undefined ? binding.tiers[judgeKey] : undefined;
    if (policy && !judgeSpec) throw new Error("Egress verification requires a bound judge tier");
    const judgeModel = judgeSpec ? registry.create(judgeSpec.adapter, judgeSpec.config) : undefined;
    const broker = createComponentBroker({ plan, contexts, verifierBinary: await resolveWarbleBinary(options.warbleBin),
      identity, currentIdentity: () => signal.aborted ? undefined : identity,
      ...(policy ? { verifyChild: async (context, result, parent) => {
        await checkProject();
        const judge = judgeModel ? createModelJudge(judgeModel, (usage) => recordUsage({ component: context.callee, step: "egress_judge", tier: judgeKey!, depth: context.depth },
          judgeSpec, judgeModel, usage)) : undefined;
        return verifyEgress(context.request, result, { policy, ...(judge ? { judge } : {}), signal: parent });
      } } : {}),
      async prepare(component, _identity, parent): Promise<ComponentAccess> {
        await checkProject();
        // Keyed on (mount, tier): a caller and callee sharing a tier name can bind different models.
        models.set(component.id, new Map([...new Set(component.steps.map((step) => step.tier))]
          .map((tier) => [tier, resolveTierModel(binding, tier, registry, component.id)])));
        if (component.steps.every((step) => step.tools.length === 0)) return {
          async query() { throw new Error("No query grant"); }, async inspect() { throw new Error("No context grant"); }, async close() {},
        };
        await resolveWrenBinary();
        return openWrenComponentAccess({ executable: "wren", project, fingerprint, signal: parent, identity: accessIdentity });
      },
      // Public-zone steps never see the prepared snapshot; they get the card. Private steps get the snapshot as before.
      ...(card ? { contextSurface: (component, run): ContextSurface | undefined => {
        if (zoneOf(component.id, run.tier) === "public") return { kind: "card", text: card!.text };
        const context = contexts[component.id];
        return context ? { kind: "snapshot", text: `Host semantic context:\n${JSON.stringify(context.snapshot)}` } : undefined;
      } } : {}),
      async step(run, component) {
        await checkProject();
        const model = models.get(component.id)?.get(run.tier);
        if (!model) throw new Error("Missing component tier binding");
        // Host materialisation for a report's narrator: the layout it consumes is resolved from the
        // slot table (the disclosed child answers) before the model reads it, so the values it sees
        // are the verified ones and it never has to retype a number. The recorded product stays the
        // planner's own output; only the consumed view is materialised (decision recorded in the design doc).
        let consumes = run.consumes;
        const report = isReportComponent(component) ? reportSteps(component) : undefined;
        if (report && Object.hasOwn(run.consumes, report.layout.produces)) {
          const layout = parseReportPlan(run.consumes[report.layout.produces]);
          if (!layout) throw new Error("The planner did not produce a report layout");
          consumes = { ...run.consumes, [report.layout.produces]: materialiseReportPlan(layout, buildSlotTable(run.children)) };
        }
        // Every part of the assembled model input is fingerprinted, including the request and the
        // consumed artifacts, so an audit of a public-tier prompt covers the values that crossed.
        const surfaces: Record<string, string> = { ...(run.surfaces ?? { prompt: run.prompt }) };
        if (plan.systemPrompt) surfaces["system"] = plan.systemPrompt;
        if (run.brief !== undefined) surfaces["brief"] = run.brief;
        surfaces["input"] = JSON.stringify({ request: run.request, input: run.input });
        surfaces["consumes"] = JSON.stringify(consumes);
        const fingerprint = fingerprintSurfaces(surfaces);
        const stepName = plan.components[component.id]?.steps.find((step) => step.prompt === surfaces["prompt"] && step.tier === run.tier)?.name ?? "?";
        surfaceRecords.push({ component: component.id, step: stepName, tier: run.tier, zone: zoneOf(component.id, run.tier), context: run.contextKind ?? "none",
          algorithm: fingerprint.algorithm, digest: fingerprint.digest, surfaces: fingerprint.surfaces });
        const result = await runAiComponentStep({ ...run, consumes, prompt: [plan.systemPrompt, run.prompt].filter(Boolean).join("\n\n") }, model);
        await checkProject();
        return result;
      },
      async normalize(component, evidence) {
        await checkProject();
        // A report's envelope is synthesised by the host from the slot table; every other component keeps the generic path.
        return isReportComponent(component) ? normalizeReportEvidence(component, evidence) : normalizeComponentEvidence(component, evidence, contexts[component.id]?.snapshot);
      },
      onEvent(event) {
        if (event.kind === "usage" && event.step) {
          const tier = plan.components[event.component]?.steps.find((step) => step.name === event.step)?.tier ?? "unbound";
          recordUsage({ component: event.component, step: event.step, tier, depth: event.depth }, resolveTierSpec(binding, tier, event.component)?.spec,
            models.get(event.component)?.get(tier), event.usage ?? { inputTokens: 0, outputTokens: 0 });
          return;
        }
        if (event.kind === "egress") {
          // Slot id, status and reason category only: the payload never enters the trace.
          traceSteps.push({ id: `${event.callId}:egress:${event.slot}`, tool: "egress", outcome: event.egress === "refused" ? "error" : "success",
            ordinal: toolOrder.get(event.callId ?? "") ?? traceSteps.length, detail: `${event.tool}/${event.slot}: ${event.egress}${event.reason ? ` (${event.reason})` : ""}` });
          return;
        }
        if (event.callId && event.tool && event.kind === "tool.start") toolOrder.set(event.callId, toolOrder.size);
        if (event.callId && event.tool && event.kind === "tool.finish") traceSteps.push({ id: event.callId, tool: event.tool,
          outcome: event.status === "ok" ? "success" : "error", ordinal: toolOrder.get(event.callId) ?? traceSteps.length });
        if (!event.step) return;
        const stepId = `${event.invocation}:${event.step}`;
        if (event.kind === "step.start") emitter.emit({ kind: "step.start", stepId, name: event.step,
          tier: plan.components[event.component]!.steps.find((step) => step.name === event.step)!.tier,
          ...(event.parent ? { parent: event.parent } : {}), depth: event.depth });
        if (event.kind === "step.finish") emitter.emit({ kind: "step.finish", stepId, name: event.step, status: event.status === "ok" ? "ok" : "error" });
        if (event.tool && event.callId && event.kind === "tool.start") emitter.emit({ kind: "tool.call", stepId, callId: event.callId, tool: event.tool, depth: event.depth, status: "running" });
        if (event.tool && event.callId && event.kind === "tool.finish") emitter.emit({ kind: "tool.result", stepId, callId: event.callId, tool: event.tool, status: event.status === "ok" ? "success" : "error" });
      },
    });
    const result = await new ComponentRunner(plan, broker).run(entry, { request: options.question }, signal);
    if (result.status === "error") throw new Error("Component execution did not complete.");
    if (result.status !== "ok") {
      const envelope = { blocks: [], verified: false };
      emitter.emit({ kind: "refusal", reason: result.message, envelope });
      emitter.emit({ kind: "run.finish", status: "refusal" });
      return { kind: "refusal", reason: result.message, envelope, trace: trace() };
    }
    const value = result.output.kind === "value" ? data.safeParse(result.output.value) : undefined;
    const blocks = result.output.kind === "render" ? result.output.blocks : value?.success
      ? [{ type: "table", columns: value.data.columns, rows: value.data.rows }]
      : [{ type: "narrative", text: JSON.stringify(result.output.value) }];
    const envelope = { blocks, verified: result.provenance?.verified === true,
      ...(result.output.kind === "render" && result.output.summary !== undefined ? { summary: result.output.summary } : {}),
      ...(result.provenance?.definition ? { definition: result.provenance.definition } : {}) };
    emitter.emit({ kind: "answer", envelope });
    emitter.emit({ kind: "run.finish", status: "answer" });
    return { kind: "answer", envelope, trace: trace() };
  } catch (error) {
    emitter.emit({ kind: "error", message: "Component preparation or execution failed." });
    emitter.emit({ kind: "run.finish", status: "error" });
    throw error;
  } finally { controller.abort(); await rm(scratch, { recursive: true, force: true }); }
}

/** `answer_query` when the plan has it, else the plan's single entry; a multi-entry plan without `answer_query` keeps the historical default and fails as before. */
export function defaultEntry(plan: ExecutionPlan): string {
  if (plan.entries.includes("answer_query")) return "answer_query";
  return plan.entries.length === 1 ? plan.entries[0]! : "answer_query";
}
