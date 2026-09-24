import { normalizeComponentResult, type ComponentInvocationResult, type RenderBlock } from "@warble/claude-agent-sdk";
import { z } from "zod";
import { answerShapeSchema } from "../providers/zone.js";
import type { DisclosedAnswer, EgressProvenance } from "./egress.js";
import type { ComponentEvidence, ComponentPlan } from "./runner.js";

/**
 * The two-stage report: host-side slot materialisation and synthesis.
 *
 * A report component (the Hub `plan_report`) runs two model steps. The first
 * lays out blocks whose data cells are `{slot_id}` placeholders and asks the
 * callee for every answer in one batched call; the second writes the summary
 * and per-block notes. Neither step is allowed to type a value into the
 * report: this module is where the values come from.
 *
 * - {@link buildSlotTable} turns the disclosed child results (what the caller
 *   was allowed to see, after egress) and the provenance the egress step kept
 *   aside into one table keyed by slot id.
 * - {@link materialiseReportPlan} fills the layout from that table for the
 *   narrator to read: filled cells carry their values, refused or unanswered
 *   cells carry `status: unavailable` and a reason category. Provenance
 *   (SQL, source tables) is withheld here; the narrator runs on a public tier.
 * - {@link synthesiseReport} builds the final render envelope from the layout,
 *   the slot table and only the narrator's text (summary, notes, titles). A
 *   value the narrator retyped is never read. Provenance is attached here, by
 *   the host, from the child run.
 *
 * Every value in the rendered report therefore traces to a disclosed answer,
 * and every disclosed answer traces to an observed query result in the child.
 */

export const BLOCK_SHAPES = { kpi_card: "scalar", chart: "series", table: "table", narrative: "narrative" } as const;
export type DataBlockType = keyof typeof BLOCK_SHAPES;
const dataBlockTypeSchema = z.enum(["kpi_card", "chart", "table", "narrative"]);
const chartTypeSchema = z.enum(["bar", "line", "pie", "area", "scatter"]);

const layoutSlotSchema = z.object({
  slot_id: z.string().min(1).max(128),
  block_type: dataBlockTypeSchema,
  expected_shape: answerShapeSchema,
  question: z.string().min(1),
  unit: z.string().optional(),
  max_rows: z.number().int().positive().optional(),
});
/** Unknown keys are stripped: a number the planner copied into a placeholder is dropped, never read. */
const layoutBlockSchema = z.object({
  type: dataBlockTypeSchema,
  label: z.string().optional(),
  title: z.string().optional(),
  chart_type: chartTypeSchema.optional(),
  slot_id: z.string().min(1).max(128),
});
export const reportPlanSchema = z.object({
  title: z.string().optional(),
  preamble: z.object({ period: z.string().optional(), currency: z.string().optional(), filters: z.array(z.string()).default([]) }).default({ filters: [] }),
  slots: z.array(layoutSlotSchema).max(64),
  blocks: z.array(layoutBlockSchema).min(1).max(64),
  summary_brief: z.string().optional(),
});
export type ReportPlan = z.infer<typeof reportPlanSchema>;
export type LayoutBlock = z.infer<typeof layoutBlockSchema>;

const cell = z.union([z.string(), z.number(), z.boolean(), z.null()]);
type Cell = z.infer<typeof cell>;
const disclosedAnswerSchema = z.object({
  slot_id: z.string().min(1),
  status: z.enum(["ok", "partial", "refused"]),
  shape: answerShapeSchema.optional(),
  columns: z.array(z.string()).optional(),
  rows: z.array(z.unknown()).optional(),
  value: z.unknown().optional(),
  text: z.string().optional(),
  unit: z.string().optional(),
  summary: z.string().optional(),
  reason_category: z.string().optional(),
}).strict();
const disclosedBatchSchema = z.object({ answers: z.array(disclosedAnswerSchema) }).passthrough();

export interface SlotEntry {
  readonly answer: DisclosedAnswer;
  /** Host-only: never handed to a model. */
  readonly provenance?: EgressProvenance;
}
export type SlotTable = ReadonlyMap<string, SlotEntry>;

/**
 * One row per slot from the disclosed child results (first answer per slot id
 * wins; a follow-up call adds new ids). Provenance is joined by slot id.
 */
export function buildSlotTable(children: readonly ComponentInvocationResult[], provenance: readonly EgressProvenance[] = []): SlotTable {
  const table = new Map<string, SlotEntry>();
  const kept = new Map<string, EgressProvenance>();
  for (const item of provenance) if (!kept.has(item.slot_id)) kept.set(item.slot_id, item);
  for (const child of children) {
    if (child.status !== "ok" || child.output.kind !== "value") continue;
    const batch = disclosedBatchSchema.safeParse(child.output.value);
    if (!batch.success) continue;
    for (const answer of batch.data.answers) {
      if (table.has(answer.slot_id)) continue;
      const aside = kept.get(answer.slot_id);
      table.set(answer.slot_id, { answer: answer as DisclosedAnswer, ...(aside ? { provenance: aside } : {}) });
    }
  }
  return table;
}

/** Positional rows for the render contract's `row[]`; object rows are projected through `columns`. */
function positionalRows(columns: readonly string[], rows: readonly unknown[]): Cell[][] | undefined {
  const out: Cell[][] = [];
  for (const row of rows) {
    const values = Array.isArray(row) ? row : row && typeof row === "object" ? columns.map((column) => (row as Record<string, unknown>)[column]) : undefined;
    if (values === undefined || values.length !== columns.length) return undefined;
    const parsed = z.array(cell).safeParse(values.map((value) => value === undefined ? null : value));
    if (!parsed.success) return undefined;
    out.push(parsed.data);
  }
  return out;
}

export type MaterialisedBlock =
  | { readonly type: "kpi_card"; readonly label: string; readonly slot_id: string; readonly value: number | string; readonly unit?: string }
  | { readonly type: "chart"; readonly title: string; readonly chart_type: z.infer<typeof chartTypeSchema>; readonly slot_id: string; readonly x: string; readonly series: readonly string[]; readonly rows: readonly Cell[][] }
  | { readonly type: "table"; readonly title: string; readonly slot_id: string; readonly columns: readonly string[]; readonly rows: readonly Cell[][] }
  | { readonly type: "narrative"; readonly title: string; readonly slot_id: string; readonly text: string }
  | { readonly type: DataBlockType; readonly label: string; readonly slot_id: string; readonly status: "unavailable"; readonly reason_category: string };

export interface MaterialisedPlan {
  readonly title?: string;
  readonly preamble: ReportPlan["preamble"];
  readonly blocks: readonly MaterialisedBlock[];
  readonly summary_brief?: string;
}

function labelOf(block: LayoutBlock): string { return block.label ?? block.title ?? block.slot_id; }
function unavailable(block: LayoutBlock, reason: string): MaterialisedBlock {
  return { type: block.type, label: labelOf(block), slot_id: block.slot_id, status: "unavailable", reason_category: reason };
}

/** Fills one layout block from its slot entry, or marks it unavailable with the reason. */
function fillBlock(block: LayoutBlock, slot: ReportPlan["slots"][number] | undefined, entry: SlotEntry | undefined): MaterialisedBlock {
  if (!slot) return unavailable(block, "not_declared");
  if (BLOCK_SHAPES[block.type] !== slot.expected_shape) return unavailable(block, "shape_mismatch");
  if (!entry) return unavailable(block, "not_requested");
  const answer = entry.answer;
  if (answer.status === "refused") return unavailable(block, answer.reason_category ?? "refused");
  const unit = slot.unit ?? answer.unit;
  const columns = answer.columns ?? [];
  const rows = answer.rows ?? [];
  switch (block.type) {
    case "kpi_card": {
      const raw = answer.value !== undefined ? answer.value : positionalRows(columns, rows)?.[0]?.[0];
      if (typeof raw !== "number" && typeof raw !== "string") return unavailable(block, "invalid_answer");
      if (typeof raw === "number" && !Number.isFinite(raw)) return unavailable(block, "invalid_answer");
      return { type: "kpi_card", label: labelOf(block), slot_id: block.slot_id, value: raw, ...(unit !== undefined ? { unit } : {}) };
    }
    case "chart": {
      const positional = columns.length >= 2 ? positionalRows(columns, rows) : undefined;
      if (!positional) return unavailable(block, "invalid_answer");
      return { type: "chart", title: labelOf(block), chart_type: block.chart_type ?? "bar", slot_id: block.slot_id, x: columns[0]!, series: columns.slice(1), rows: positional };
    }
    case "table": {
      const positional = columns.length >= 1 ? positionalRows(columns, rows) : undefined;
      if (!positional) return unavailable(block, "invalid_answer");
      return { type: "table", title: labelOf(block), slot_id: block.slot_id, columns: [...columns], rows: positional };
    }
    case "narrative": {
      const text = answer.text ?? answer.summary;
      if (typeof text !== "string" || text.length === 0) return unavailable(block, "invalid_answer");
      return { type: "narrative", title: labelOf(block), slot_id: block.slot_id, text };
    }
  }
}

/**
 * The layout with every data cell resolved from the slot table. This is what
 * the narrator consumes as `report_plan`: values it must copy, never compute.
 * No `definition` block is included; provenance stays host-side until
 * {@link synthesiseReport}.
 */
export function materialiseReportPlan(plan: ReportPlan, table: SlotTable): MaterialisedPlan {
  const slots = new Map(plan.slots.map((slot) => [slot.slot_id, slot]));
  return {
    ...(plan.title !== undefined ? { title: plan.title } : {}),
    preamble: plan.preamble,
    blocks: plan.blocks.map((block) => fillBlock(block, slots.get(block.slot_id), table.get(block.slot_id))),
    ...(plan.summary_brief !== undefined ? { summary_brief: plan.summary_brief } : {}),
  };
}

/** Parses a step product (string or object) as a report plan; undefined when it is not one. */
export function parseReportPlan(product: unknown): ReportPlan | undefined {
  let value: unknown = product;
  if (typeof product === "string") {
    try { value = JSON.parse(extractJsonObject(product)); } catch { return undefined; }
  }
  const parsed = reportPlanSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function extractJsonObject(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced?.[1] ?? text).trim();
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("no JSON object");
  return candidate.slice(start, end + 1);
}

/** The only fields the narrator contributes: prose. Bounded so a runaway narrator cannot bloat the artifact. */
const NOTE_LIMIT = 4_000;
const TITLE_LIMIT = 200;
const SUMMARY_LIMIT = 20_000;
const narratorBlockSchema = z.object({
  slot_id: z.string().min(1).optional(),
  note: z.string().max(NOTE_LIMIT).optional(),
  label: z.string().min(1).max(TITLE_LIMIT).optional(),
  title: z.string().min(1).max(TITLE_LIMIT).optional(),
}).passthrough();
const narratorOutputSchema = z.object({
  blocks: z.array(narratorBlockSchema),
  summary: z.string().max(SUMMARY_LIMIT).optional(),
}).passthrough();
export interface NarratorText {
  readonly summary?: string;
  readonly notes: ReadonlyMap<string, { readonly note?: string; readonly label?: string }>;
}

/** Reads the narrator's text out of its output; the values it may have written are not looked at. */
export function readNarratorText(product: unknown): NarratorText | undefined {
  let value: unknown = product;
  if (typeof product === "string") {
    try { value = JSON.parse(extractJsonObject(product)); } catch { return undefined; }
  }
  const parsed = narratorOutputSchema.safeParse(value);
  if (!parsed.success) return undefined;
  const notes = new Map<string, { note?: string; label?: string }>();
  for (const block of parsed.data.blocks) {
    if (block.slot_id === undefined || notes.has(block.slot_id)) continue;
    const label = block.label ?? block.title;
    notes.set(block.slot_id, { ...(block.note !== undefined ? { note: block.note } : {}), ...(label !== undefined ? { label } : {}) });
  }
  return { ...(parsed.data.summary !== undefined ? { summary: parsed.data.summary } : {}), notes };
}

export interface SynthesisedReport {
  readonly blocks: readonly Record<string, unknown>[];
  readonly summary?: string;
  /** True only when at least one cell is filled and every filled cell came from a verified answer. */
  readonly verified: boolean;
  /** Slot ids whose provenance was attached as `definition` blocks. */
  readonly definitions: readonly string[];
}

const definitionSchema = z.object({ sql: z.string().min(1), source_tables: z.array(z.string()).default([]), filters: z.array(z.string()).default([]) }).passthrough();

/**
 * The rendered report. Values come from the slot table through the same
 * materialisation the narrator read; the narrator contributes summary, notes
 * and adjusted labels only; the host appends one `definition` block per
 * filled slot whose provenance carries SQL. The narrator cannot add, drop or
 * reorder blocks, and a number it emitted is never read.
 */
export function synthesiseReport(plan: ReportPlan, table: SlotTable, narrator: NarratorText | undefined): SynthesisedReport {
  const materialised = materialiseReportPlan(plan, table);
  const blocks: Record<string, unknown>[] = [];
  const definitions: string[] = [];
  let filled = 0;
  let verified = true;
  for (const block of materialised.blocks) {
    const text = narrator?.notes.get(block.slot_id);
    if ("status" in block) {
      blocks.push({ type: "unavailable", label: text?.label ?? block.label, block_type: block.type, reason_category: block.reason_category,
        slot_id: block.slot_id, ...(text?.note !== undefined ? { note: text.note } : {}) });
      continue;
    }
    filled += 1;
    const entry = table.get(block.slot_id);
    if (entry?.provenance?.verified !== true) verified = false;
    const named = block.type === "kpi_card"
      ? { ...block, label: text?.label ?? block.label }
      : { ...block, title: text?.label ?? block.title };
    blocks.push({ ...named, ...(text?.note !== undefined && block.type !== "narrative" ? { note: text.note } : {}) });
    const source = entry?.provenance?.definition ?? (entry?.provenance?.sql !== undefined
      ? { sql: entry.provenance.sql, source_tables: entry.provenance.source_tables ?? [] } : undefined);
    const definition = definitionSchema.safeParse(source);
    if (definition.success) {
      blocks.push({ type: "definition", sql: definition.data.sql, source_tables: [...definition.data.source_tables], filters: [...definition.data.filters], slot_id: block.slot_id });
      definitions.push(block.slot_id);
    }
  }
  return { blocks, ...(narrator?.summary !== undefined ? { summary: narrator.summary } : {}), verified: filled > 0 && verified, definitions };
}

/** A component whose render contract declares an `unavailable` cell is a report: the host synthesises its envelope. */
export function isReportComponent(component: ComponentPlan): boolean {
  const render = (component.declaration.effect as { render_blocks?: unknown } | undefined)?.render_blocks;
  return Array.isArray(render) && render.some((block) => (block as { type?: unknown })?.type === "unavailable")
    && component.steps.some((step) => step.calls.length > 0);
}

/** The step that lays the report out (owns the call edge) and the one that narrates it (consumes the layout). */
export function reportSteps(component: ComponentPlan): { layout: ComponentPlan["steps"][number]; narrate?: ComponentPlan["steps"][number] } | undefined {
  const layout = component.steps.find((step) => step.calls.length > 0);
  if (!layout) return undefined;
  const narrate = component.steps.find((step) => !step.repairOf && step !== layout && step.consumes.includes(layout.produces));
  return { layout, ...(narrate ? { narrate } : {}) };
}

function refused(message: string): ComponentInvocationResult {
  return { status: "refused", code: "callee_refused", message };
}

/**
 * Root normalization for a report component: the host-owned synthesis. The
 * produced envelope is validated against the component's declared render
 * contract exactly as a model-authored one would be.
 */
export function normalizeReportEvidence(component: ComponentPlan, evidence: ComponentEvidence): ComponentInvocationResult {
  const steps = reportSteps(component);
  if (!steps) return refused("The report component declares no layout step.");
  const plan = parseReportPlan(evidence.steps[steps.layout.produces]);
  if (!plan) return refused("The planner did not produce a report layout.");
  const narrator = steps.narrate ? readNarratorText(evidence.steps[steps.narrate.produces]) : undefined;
  if (steps.narrate && !narrator) return refused("The narrator did not produce a report.");
  const table = buildSlotTable(evidence.children, evidence.egress ?? []);
  const report = synthesiseReport(plan, table, narrator);
  const contract = z.array(z.object({ type: z.string(), fields: z.record(z.string(), z.string()) }).strict())
    .parse((component.declaration.effect as { render_blocks?: unknown }).render_blocks ?? []) as RenderBlock[];
  const envelope = { blocks: report.blocks, ...(report.summary !== undefined ? { summary: report.summary } : {}), verified: report.verified };
  const normalized = normalizeComponentResult(JSON.stringify(envelope), contract).value;
  if (normalized.status !== "ok") return normalized;
  return { ...normalized, provenance: { verified: report.verified } };
}
