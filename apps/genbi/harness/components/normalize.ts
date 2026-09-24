import { normalizeComponentResult, type ComponentInvocationResult, type RenderBlock } from "@warble/claude-agent-sdk";
import { z } from "zod";
import { checkSemanticGuards, querySemantics, type QuerySemantics } from "./semantic-guards.js";
import { namedAnswerSql, selectAnsweringCandidate, sqlKey } from "../render/answering-query.js";
import type { ComponentEvidence, ComponentPlan } from "./runner.js";

const definitionSchema = z.object({ sql: z.string(), source_tables: z.array(z.string()), filters: z.array(z.string()) }).strict();
const table = z.object({ columns: z.array(z.string()).min(1), rows: z.array(z.record(z.string(), z.unknown())) });
const blocks = z.array(z.object({ type: z.string(), fields: z.record(z.string(), z.string()) }).strict());
const capabilities = z.array(z.string());
interface GroundedQuery { readonly sql: string; readonly table: z.infer<typeof table>; readonly output: unknown }
/** The observed definition for an executed query, or the bare SQL when the tool returned none. */
function definitionOf(query: GroundedQuery): z.infer<typeof definitionSchema> | { sql: string } {
  const parsed = definitionSchema.safeParse((query.output as { definition?: unknown } | null)?.definition);
  return parsed.success && parsed.data.sql === query.sql ? parsed.data : { sql: query.sql };
}
function groundedQueries(observations: readonly { readonly input: unknown; readonly output: unknown }[]): GroundedQuery[] {
  const grounded: GroundedQuery[] = [];
  for (const call of observations) {
    const sql = (call.input as { sql?: unknown } | null)?.sql;
    const parsed = table.safeParse(call.output);
    if (typeof sql === "string" && parsed.success) grounded.push({ sql, table: parsed.data, output: call.output });
  }
  return grounded;
}
function refused(): ComponentInvocationResult {
  return { status: "refused", code: "callee_refused", message: "The component did not produce a grounded result." };
}

/** Child normalization is pure. Data evidence comes from observed tools, never a verified flag. */
export function normalizeComponentEvidence(component: ComponentPlan, evidence: ComponentEvidence, context?: unknown): ComponentInvocationResult {
  const grants = component.steps.flatMap((step) => step.tools);
  const queryNames = new Set(grants.filter((grant) => grant.source === "host:sql_execution:read_only" || (grant.source === "native" && grant.name === "query")).map((grant) => grant.name));
  const observations = evidence.tools.filter((call) => queryNames.has(call.tool));
  const guards = z.array(z.record(z.string(), z.unknown())).parse(component.declaration.guardrails ?? []);
  const semanticGuard = guards.some((guard) => (guard.name === "additivity_guard" && guard.locked === true) || guard.name === "drill_depth_limit");
  const proofs: QuerySemantics[] = [];
  for (const call of observations) {
    const proof = querySemantics.safeParse((call.output as { semantics?: unknown } | null)?.semantics);
    if (proof.success && proof.data.sql === (call.input as { sql?: unknown } | null)?.sql) proofs.push(proof.data);
    else if (semanticGuard) return refused();
  }
  // The public child-result contract carries no semantic query proof. Do not infer
  // additivity from a child's generic verified flag or from its model-authored value.
  if (semanticGuard && evidence.children.length > 0) return refused();
  if (!checkSemanticGuards(guards, proofs, context)) return refused();
  const definitions: z.infer<typeof definitionSchema>[] = [];
  for (const call of observations) {
    const parsed = definitionSchema.safeParse((call.output as { definition?: unknown } | null)?.definition);
    if (parsed.success && parsed.data.sql === (call.input as { sql?: unknown })?.sql) definitions.push(parsed.data);
  }
  const data = observations.map((call) => table.safeParse(call.output)).filter((value) => value.success).map((value) => value.data!);
  const declared = capabilities.parse(component.declaration.required_capabilities);
  const render = blocks.parse((component.declaration.effect as { render_blocks?: unknown }).render_blocks ?? []) as RenderBlock[];
  const steps = component.steps.filter((step) => Object.hasOwn(evidence.steps, step.produces));
  const terminal = steps.at(-1);
  if (!terminal) return refused();
  const lastProduct = evidence.steps[terminal.produces];
  // Tool evidence cannot turn an explicit terminal refusal or error into success.
  let terminalValue: unknown = lastProduct;
  if (typeof lastProduct === "string") {
    try { terminalValue = JSON.parse(lastProduct); } catch { /* Ordinary prose is normalized below. */ }
  }
  if (terminalValue && typeof terminalValue === "object" && "status" in terminalValue
    && ["refused", "error"].includes(String(terminalValue.status))) return refused();
  if (declared.includes("sql_execution:read_only") && data.length === 0) return refused();
  // A batch-shaped callee (answer_batch) ends in an array with one entry per slot. Each tabular
  // entry is rebuilt from the observed query result its SQL names; the model's copy of the rows
  // is never read, and an entry no executed query backs is returned as unanswerable.
  if (render.length === 0 && Array.isArray(terminalValue)) return normalizeBatchTerminal(terminalValue, observations);
  if (render.length === 0 && data.length > 0) {
    const grounded = groundedQueries(observations);
    // The answer is the query the terminal value names, never simply the last table: a model
    // that runs a stray check after the right query must not turn that check into the answer.
    // A value naming no query keeps the historical last-observation rule; a value naming a
    // query that never ran is refused rather than answered with another table.
    let chosen: GroundedQuery | undefined;
    if (namedAnswerSql(terminalValue) === undefined) {
      const last = observations[observations.length - 1]!;
      const actual = table.safeParse(last.output);
      if (!actual.success) return refused();
      const sql = (last.input as { sql?: unknown }).sql;
      chosen = { sql: typeof sql === "string" ? sql : "", table: actual.data, output: last.output };
    } else {
      chosen = selectAnsweringCandidate(grounded, terminalValue);
    }
    if (!chosen) return refused();
    const definition = definitionOf(chosen);
    return { status: "ok", output: { kind: "value", value: { ...chosen.table, verified: true, summary: "Query completed.", definition } },
      provenance: { verified: true, definition } };
  }
  const result = normalizeComponentResult(typeof lastProduct === "string" ? lastProduct : JSON.stringify(lastProduct), render).value;
  if (result.status !== "ok") return result;
  const composed = component.steps.some((step) => step.calls.length > 0);
  if (composed) {
    if (evidence.children.length === 0 || evidence.children.some((child) => child.status !== "ok" || child.provenance?.verified !== true)) return refused();
    for (const child of evidence.children) {
      if (child.status !== "ok" || child.output.kind !== "value") return refused();
      const parsed = table.safeParse(child.output.value);
      if (!parsed.success) return refused();
      data.push(parsed.data);
      const definition = definitionSchema.safeParse(child.provenance?.definition);
      if (definition.success) definitions.push(definition.data);
    }
  }
  if (result.output.kind === "render" && data.length > 0 && !grounded(result.output.blocks, data, definitions)) return refused();
  // A render with data-bearing blocks cannot earn provenance from prose alone.
  if (result.output.kind === "render" && result.output.blocks.some((block) => ["table", "chart", "kpi_card"].includes(String(block.type))) && data.length === 0) return refused();
  return { ...result, provenance: { ...result.provenance, verified: data.length > 0 } };
}

function grounded(render: readonly Record<string, unknown>[], data: readonly z.infer<typeof table>[], definitions: readonly z.infer<typeof definitionSchema>[]): boolean {
  return render.every((block) => {
    if (block.type === "definition") return definitions.some((definition) => definition.sql === block.sql
      && JSON.stringify(definition.source_tables) === JSON.stringify(block.source_tables) && JSON.stringify(definition.filters) === JSON.stringify(block.filters));
    if (block.type === "kpi_card") return typeof block.label === "string" && data.some((source) => source.columns.includes(block.label as string)
      && source.rows.some((row) => row[block.label as string] === block.value
        && (block.unit === undefined || (Object.hasOwn(row, "unit") && row.unit === block.unit))
        && (block.delta === undefined || (Object.hasOwn(row, "delta") && row.delta === block.delta))));
    if (block.type !== "table" && block.type !== "chart") return true;
    if (!Array.isArray(block.rows)) return false;
    const columns = block.type === "table" ? block.columns : [block.x, ...(Array.isArray(block.series) ? block.series : [])];
    if (!Array.isArray(columns) || !columns.length || new Set(columns).size !== columns.length || !columns.every((value) => typeof value === "string")) return false;
    const sources = data.filter((source) => columns.every((name) => source.columns.includes(name)));
    if (!sources.length) return false;
    if (block.rows.length === 0) return sources.some((source) => source.rows.length === 0);
    return block.rows.every((row) => {
      if (Array.isArray(row) && row.length !== columns.length) return false;
      const values = Array.isArray(row) ? Object.fromEntries(columns.map((name, index) => [name, row[index]])) : row;
      if (!values || typeof values !== "object") return false;
      if (Object.keys(values).length !== columns.length || !columns.every((name) => Object.hasOwn(values, name))) return false;
      return sources.some((source) => source.rows.some((observed) => Object.entries(values).every(([name, value]) => Object.hasOwn(observed, name) && JSON.stringify(observed[name]) === JSON.stringify(value))));
    });
  });
}

const batchEntry = z.object({ slot_id: z.string().min(1).max(128) }).passthrough();
const stringList = z.array(z.string()).max(64);
const REASON_LIMIT = 200;
function sanitizedReason(value: unknown, fallback: string): string {
  const text = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  return (text.length > 0 ? text : fallback).slice(0, REASON_LIMIT);
}
/**
 * One entry per slot, first entry per slot id wins. A tabular entry is
 * accepted only when its `definition.sql` names a query this run executed
 * with a table-shaped result; its columns and rows are then the observed
 * ones. The model contributes `summary` and the lineage strings of
 * `definition`; every value comes from the tool. Entries the model marked
 * `unanswerable` (or `refused`) pass through with a bounded reason.
 */
function normalizeBatchTerminal(entries: readonly unknown[], observations: readonly ComponentEvidence["tools"][number][]): ComponentInvocationResult {
  const seen = new Set<string>();
  const value: Record<string, unknown>[] = [];
  let answered = 0;
  for (const raw of entries) {
    const entry = batchEntry.safeParse(raw);
    if (!entry.success || seen.has(entry.data.slot_id)) continue;
    seen.add(entry.data.slot_id);
    const item = entry.data;
    if (item.status === "unanswerable" || item.status === "refused") {
      value.push({ slot_id: item.slot_id, status: "unanswerable", reason: sanitizedReason(item.reason, "the callee could not answer this slot") });
      continue;
    }
    const claimed = item.definition && typeof item.definition === "object" ? item.definition as Record<string, unknown> : undefined;
    const sql = typeof claimed?.sql === "string" ? claimed.sql : undefined;
    // Whitespace- and terminator-insensitive, like the single-answer selection: the model may reformat the SQL it names.
    const observed = sql === undefined ? undefined : [...observations].reverse().find((call) => { const ran = (call.input as { sql?: unknown } | null)?.sql; return typeof ran === "string" && sqlKey(ran) === sqlKey(sql) && table.safeParse(call.output).success; });
    const actual = observed ? table.safeParse(observed.output) : undefined;
    if (!observed || !actual?.success) {
      value.push({ slot_id: item.slot_id, status: "unanswerable", reason: "no executed query backs this answer" });
      continue;
    }
    const proven = definitionSchema.safeParse((observed.output as { definition?: unknown }).definition);
    const definition = proven.success && proven.data.sql === sql ? proven.data : {
      sql: sql!,
      source_tables: stringList.safeParse(claimed?.source_tables).success ? claimed!.source_tables as string[] : [],
      filters: stringList.safeParse(claimed?.filters).success ? claimed!.filters as string[] : [],
    };
    answered += 1;
    value.push({ slot_id: item.slot_id, columns: actual.data.columns, rows: actual.data.rows, verified: true,
      summary: typeof item.summary === "string" ? item.summary : "Query completed.", definition });
  }
  if (value.length === 0) return refused();
  // Spec §6.2: an array value is preserved as-is with no outer provenance; per-entry `verified`/`definition` stay on the entries.
  return { status: "ok", output: { kind: "value", value }, ...(answered > 0 ? { provenance: { verified: true } } : {}) };
}
