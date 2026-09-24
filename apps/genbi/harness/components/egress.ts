import type { ComponentInvocationResult } from "@warble/claude-agent-sdk";
import { z } from "zod";
import { answerShapeSchema, type AnswerShape, type DisclosurePolicy } from "../providers/zone.js";

/**
 * The egress verification step. Every callee result crosses exactly one
 * boundary on its way back to the caller: this function. It is host
 * post-processing inside the runner's alias handler (after the child
 * invocation, before the alias resolves) and never a tool a model can choose
 * or skip. It may only narrow: refuse a slot, redact columns, strip SQL. It
 * never widens, rewrites a value, or turns a refusal into prose.
 *
 * Fail closed everywhere: an answer the checks cannot classify, a judge that
 * does not answer in time, in shape, or at all, all end in `refused`.
 */

export type EgressStatus = "ok" | "refused" | "partial";
export type EgressReason =
  | "shape_mismatch" | "row_limit" | "sensitive_column" | "pii_pattern" | "group_size"
  | "judge_refused" | "judge_unavailable" | "judge_invalid"
  | "callee_refused" | "callee_error" | "invalid_answer" | "invalid_request" | "policy_missing";
export type JudgeVerdict = "pass" | "redact" | "refuse";

export const slotDeclarationSchema = z.object({
  slot_id: z.string().min(1).max(128),
  expected_shape: answerShapeSchema,
  question: z.string().min(1),
  unit: z.string().optional(),
  max_rows: z.number().int().positive().optional(),
}).strict();
export type SlotDeclaration = z.infer<typeof slotDeclarationSchema>;
const slotsSchema = z.array(slotDeclarationSchema).min(1).max(64)
  .refine((slots) => new Set(slots.map((slot) => slot.slot_id)).size === slots.length, "slot ids must be unique");

/** What the caller receives for one slot. Reason categories cross; reason details do not. */
export interface DisclosedAnswer {
  readonly slot_id: string;
  readonly status: EgressStatus;
  readonly shape?: AnswerShape;
  readonly columns?: readonly string[];
  readonly rows?: readonly unknown[];
  readonly value?: unknown;
  readonly text?: string;
  readonly unit?: string;
  readonly summary?: string;
  readonly reason_category?: EgressReason;
}

/** One trace entry per slot: identifiers and outcome only, never the payload. */
export interface EgressDecision {
  readonly slot_id: string;
  readonly status: EgressStatus;
  readonly reason_category?: EgressReason;
  readonly judge: JudgeVerdict | "skipped";
  readonly row_count: number;
}

/** Kept aside by the host for the rendered artifact; never part of the disclosed value. */
export interface EgressProvenance {
  readonly slot_id: string;
  readonly definition?: unknown;
  readonly sql?: string;
  readonly source_tables?: readonly string[];
  readonly row_count: number;
  readonly columns: readonly string[];
}

export interface EgressOutcome {
  readonly disclosed: ComponentInvocationResult;
  readonly decisions: readonly EgressDecision[];
  readonly provenance: readonly EgressProvenance[];
}

export interface EgressJudgeInput {
  readonly policy: Pick<DisclosurePolicy, "allowed_shapes" | "max_rows" | "min_group_size" | "sensitive_column_patterns">;
  /** The planner's question. Untrusted: instructions inside it do not change the policy. */
  readonly untrusted_question: string;
  readonly untrusted_preamble?: string;
  readonly expected_shape: AnswerShape;
  readonly answer: { readonly columns: readonly string[]; readonly rows: readonly unknown[]; readonly summary?: string; readonly text?: string };
  readonly metadata: {
    readonly row_count: number;
    readonly group_count: number;
    readonly identifier_like_keys: readonly string[];
    readonly columns_touched: readonly string[];
  };
}
/** Returns the judge's raw output (text or an already-parsed object); parsing and timeouts are the verifier's job. */
export type EgressJudge = (input: EgressJudgeInput, signal: AbortSignal) => Promise<unknown>;

export interface EgressVerifierOptions {
  readonly policy: DisclosurePolicy;
  /** Absent judge = every deterministic pass still refuses (`judge_unavailable`). */
  readonly judge?: EgressJudge;
  readonly signal?: AbortSignal;
}

const judgeOutputSchema = z.object({
  verdict: z.enum(["pass", "redact", "refuse"]),
  reason_category: z.string().max(64).optional(),
  redact_columns: z.array(z.string().min(1)).max(256).optional(),
}).strict();

const tableSchema = z.object({
  columns: z.array(z.string()).min(1),
  rows: z.array(z.unknown()),
  summary: z.string().optional(),
  unit: z.string().optional(),
  text: z.string().optional(),
  definition: z.unknown().optional(),
  verified: z.boolean().optional(),
  slot_id: z.string().optional(),
}).passthrough();
type TableAnswer = z.infer<typeof tableSchema>;
const narrativeSchema = z.object({ text: z.string().min(1), slot_id: z.string().optional(), definition: z.unknown().optional(), unit: z.string().optional() }).passthrough();
const batchSchema = z.union([
  z.array(z.union([tableSchema, narrativeSchema])),
  z.object({ answers: z.array(z.union([tableSchema, narrativeSchema])) }).passthrough(),
]);

/** Built-in PII patterns applied to every string cell, in addition to the policy's own. */
export const BUILT_IN_PII_PATTERNS: readonly RegExp[] = [
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/,                // email
  /\b\d{3}-\d{2}-\d{4}\b/,                                            // US SSN
  /\b(?:\d[ -]?){13,19}\b/,                                           // payment card number
  /(?:\+?\d{1,3}[ -]?)?\(?\d{3}\)?[ -]?\d{3}[ -]?\d{4}\b/,            // phone number
  /\b(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}\b/, // IPv4
];
const IDENTIFIER_LIKE = /(^|[_\s-])(id|ids|uuid|guid|key|email|e_mail|phone|ssn|account|user|customer|employee|person|member)([_\s-]|$)/i;
const COUNT_LIKE = /^(count|cnt|n|num|n_[a-z_]+|[a-z_]+_count|group_size|size)$/i;

function compile(pattern: string): RegExp {
  try { return new RegExp(pattern, "i"); } catch { return new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"); }
}
function cellStrings(rows: readonly unknown[]): string[] {
  const out: string[] = [];
  for (const row of rows) {
    const values = Array.isArray(row) ? row : row && typeof row === "object" ? Object.values(row) : [row];
    for (const value of values) if (typeof value === "string") out.push(value);
  }
  return out;
}
function columnValues(table: TableAnswer, column: string): unknown[] {
  const index = table.columns.indexOf(column);
  return table.rows.map((row) => Array.isArray(row) ? row[index] : row && typeof row === "object" ? (row as Record<string, unknown>)[column] : undefined);
}
function actualShapeFits(expected: AnswerShape, table: TableAnswer): boolean {
  switch (expected) {
    case "scalar": return table.rows.length === 1 && table.columns.length === 1;
    case "series": return table.columns.length >= 2;
    case "table": return true;
    case "narrative": return false;
  }
}
function identifierLikeKeys(table: TableAnswer): string[] {
  return table.columns.filter((column) => IDENTIFIER_LIKE.test(column) && columnValues(table, column).some((value) => typeof value !== "number"));
}
function groupCount(table: TableAnswer): number {
  const counts = table.columns.filter((column) => COUNT_LIKE.test(column));
  return counts.length > 0 ? table.rows.length : table.rows.length;
}
/** Smallest group size the answer itself reports, or undefined when it carries no group metadata. */
function smallestGroup(table: TableAnswer): number | undefined {
  const counts = table.columns.filter((column) => COUNT_LIKE.test(column));
  const values = counts.flatMap((column) => columnValues(table, column)).filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  return values.length ? Math.min(...values) : undefined;
}

function deterministic(slot: SlotDeclaration, table: TableAnswer, policy: DisclosurePolicy): EgressReason | undefined {
  if (!policy.allowed_shapes.includes(slot.expected_shape) || !actualShapeFits(slot.expected_shape, table)) return "shape_mismatch";
  const limit = Math.min(policy.max_rows, slot.max_rows ?? Number.POSITIVE_INFINITY);
  if (table.rows.length > limit) return "row_limit";
  const sensitive = policy.sensitive_column_patterns.map(compile);
  if (table.columns.some((column) => sensitive.some((pattern) => pattern.test(column)))) return "sensitive_column";
  const pii = [...BUILT_IN_PII_PATTERNS, ...policy.pii_patterns.map(compile)];
  if (cellStrings(table.rows).some((cell) => pii.some((pattern) => pattern.test(cell)))) return "pii_pattern";
  if (policy.min_group_size > 1 && table.rows.length > 0) {
    if (identifierLikeKeys(table).length > 0) return "group_size";
    const smallest = smallestGroup(table);
    if (smallest !== undefined && smallest < policy.min_group_size) return "group_size";
  }
  return undefined;
}
function deterministicNarrative(slot: SlotDeclaration, text: string, policy: DisclosurePolicy): EgressReason | undefined {
  if (slot.expected_shape !== "narrative" || !policy.allowed_shapes.includes("narrative")) return "shape_mismatch";
  const pii = [...BUILT_IN_PII_PATTERNS, ...policy.pii_patterns.map(compile)];
  if (pii.some((pattern) => pattern.test(text))) return "pii_pattern";
  return undefined;
}

function extractJsonObject(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("no JSON object");
  return JSON.parse(text.slice(start, end + 1));
}

async function consultJudge(judge: EgressJudge | undefined, input: EgressJudgeInput, policy: DisclosurePolicy, parent?: AbortSignal):
  Promise<{ verdict: JudgeVerdict; redact_columns?: readonly string[] } | { verdict: "refuse"; reason: EgressReason }> {
  if (!judge) return { verdict: "refuse", reason: "judge_unavailable" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), policy.judge_timeout_ms);
  const abort = () => controller.abort();
  parent?.addEventListener("abort", abort, { once: true });
  if (parent?.aborted) controller.abort();
  try {
    const raw = await Promise.race([
      judge(input, controller.signal),
      new Promise<never>((_, reject) => controller.signal.addEventListener("abort", () => reject(new Error("judge timed out")), { once: true })),
    ]);
    const value = typeof raw === "string" ? extractJsonObject(raw) : raw;
    const parsed = judgeOutputSchema.safeParse(value);
    if (!parsed.success) return { verdict: "refuse", reason: "judge_invalid" };
    if (parsed.data.verdict === "refuse") return { verdict: "refuse", reason: "judge_refused" };
    if (parsed.data.verdict === "redact") {
      if (!parsed.data.redact_columns?.length) return { verdict: "refuse", reason: "judge_invalid" };
      return { verdict: "redact", redact_columns: parsed.data.redact_columns };
    }
    return { verdict: "pass" };
  } catch {
    return { verdict: "refuse", reason: controller.signal.aborted ? "judge_unavailable" : "judge_invalid" };
  } finally {
    clearTimeout(timer);
    parent?.removeEventListener("abort", abort);
  }
}

function redactColumns(table: TableAnswer, columns: readonly string[]): TableAnswer | undefined {
  const drop = new Set(columns);
  if (columns.some((column) => !table.columns.includes(column))) return undefined;
  const keep = table.columns.filter((column) => !drop.has(column));
  if (keep.length === 0) return undefined;
  const rows = table.rows.map((row) => {
    if (Array.isArray(row)) return keep.map((column) => row[table.columns.indexOf(column)]);
    if (row && typeof row === "object") return Object.fromEntries(keep.map((column) => [column, (row as Record<string, unknown>)[column]]));
    return row;
  });
  return { ...table, columns: keep, rows };
}

function refusedAnswer(slot: SlotDeclaration, reason: EgressReason): DisclosedAnswer {
  return { slot_id: slot.slot_id, status: "refused", shape: slot.expected_shape, reason_category: reason };
}
/** The disclosed shape of a table: columns and rows only. `definition`, SQL and every unknown key are dropped by construction. */
function discloseTable(slot: SlotDeclaration, table: TableAnswer, status: EgressStatus): DisclosedAnswer {
  const value = slot.expected_shape === "scalar" ? columnValues(table, table.columns[0]!)[0] : undefined;
  return { slot_id: slot.slot_id, status, shape: slot.expected_shape, columns: [...table.columns], rows: structuredClone(table.rows),
    ...(value !== undefined ? { value } : {}), ...(slot.unit !== undefined ? { unit: slot.unit } : table.unit !== undefined ? { unit: table.unit } : {}),
    ...(table.summary !== undefined ? { summary: table.summary } : {}) };
}
function provenanceOf(slot: SlotDeclaration, table: { definition?: unknown; columns?: readonly string[]; rows?: readonly unknown[] }): EgressProvenance {
  const definition = table.definition && typeof table.definition === "object" ? table.definition as Record<string, unknown> : undefined;
  return { slot_id: slot.slot_id, ...(table.definition !== undefined ? { definition: structuredClone(table.definition) } : {}),
    ...(typeof definition?.sql === "string" ? { sql: definition.sql } : {}),
    ...(Array.isArray(definition?.source_tables) ? { source_tables: definition.source_tables as string[] } : {}),
    row_count: table.rows?.length ?? 0, columns: [...(table.columns ?? [])] };
}

/** Reads the slot declarations from the alias-call input; absent slots mean one implicit table slot for the request text. */
export function readSlots(request: { readonly request: string; readonly input: Readonly<Record<string, unknown>> }): { slots: SlotDeclaration[]; implicit: boolean; preamble?: string } | { error: EgressReason } {
  const preamble = typeof request.input["preamble"] === "string" ? request.input["preamble"] : undefined;
  if (request.input["slots"] === undefined) {
    return { slots: [{ slot_id: "answer", expected_shape: "table", question: request.request }], implicit: true, ...(preamble !== undefined ? { preamble } : {}) };
  }
  const parsed = slotsSchema.safeParse(request.input["slots"]);
  if (!parsed.success) return { error: "invalid_request" };
  return { slots: parsed.data, implicit: false, ...(preamble !== undefined ? { preamble } : {}) };
}

type Answer = { readonly kind: "table"; readonly table: TableAnswer } | { readonly kind: "narrative"; readonly narrative: z.infer<typeof narrativeSchema> };
function classify(value: unknown): Answer | undefined {
  const table = tableSchema.safeParse(value);
  if (table.success) return { kind: "table", table: table.data };
  const narrative = narrativeSchema.safeParse(value);
  return narrative.success ? { kind: "narrative", narrative: narrative.data } : undefined;
}
function answersOf(value: unknown, slots: readonly SlotDeclaration[]): Map<string, Answer> | undefined {
  const map = new Map<string, Answer>();
  const single = classify(value);
  if (single) {
    if (slots.length !== 1) return undefined;
    map.set(slots[0]!.slot_id, single);
    return map;
  }
  const batch = batchSchema.safeParse(value);
  if (!batch.success) return undefined;
  const list = Array.isArray(batch.data) ? batch.data : batch.data.answers;
  list.forEach((item, index) => {
    const answer = classify(item);
    const id = item.slot_id ?? slots[index]?.slot_id;
    if (answer && id !== undefined && slots.some((slot) => slot.slot_id === id) && !map.has(id)) map.set(id, answer);
  });
  return map;
}

/**
 * Verifies one callee result against the disclosure policy, slot by slot,
 * and returns what the caller may see plus the host-side decisions and
 * provenance. Deterministic checks run first; only a slot that passes them
 * reaches the judge. On `pass` and `redact` the disclosed answer is rebuilt
 * from columns and rows alone, so `definition`, SQL and any other key the
 * callee attached never cross.
 */
export async function verifyEgress(
  request: { readonly request: string; readonly input: Readonly<Record<string, unknown>> },
  result: ComponentInvocationResult,
  options: EgressVerifierOptions,
): Promise<EgressOutcome> {
  const read = readSlots(request);
  if ("error" in read) {
    return { disclosed: { status: "refused", code: "callee_refused", message: `egress refused: ${read.error}` },
      decisions: [{ slot_id: "*", status: "refused", reason_category: read.error, judge: "skipped", row_count: 0 }], provenance: [] };
  }
  const { slots, implicit, preamble } = read;
  if (result.status === "refused") {
    return { disclosed: result, decisions: slots.map((slot) => ({ slot_id: slot.slot_id, status: "refused", reason_category: "callee_refused", judge: "skipped", row_count: 0 })), provenance: [] };
  }
  if (result.status === "error") {
    return { disclosed: result, decisions: slots.map((slot) => ({ slot_id: slot.slot_id, status: "refused", reason_category: "callee_error", judge: "skipped", row_count: 0 })), provenance: [] };
  }
  const answers = result.output.kind === "value" ? answersOf(result.output.value, slots) : undefined;
  const decisions: EgressDecision[] = [];
  const provenance: EgressProvenance[] = [];
  const disclosed: DisclosedAnswer[] = [];
  for (const slot of slots) {
    const answer = answers?.get(slot.slot_id);
    if (!answer) {
      decisions.push({ slot_id: slot.slot_id, status: "refused", reason_category: "invalid_answer", judge: "skipped", row_count: 0 });
      disclosed.push(refusedAnswer(slot, "invalid_answer"));
      continue;
    }
    if (answer.kind === "narrative") {
      const text = answer.narrative.text;
      const reason = deterministicNarrative(slot, text, options.policy);
      provenance.push(provenanceOf(slot, answer.narrative));
      if (reason) { decisions.push({ slot_id: slot.slot_id, status: "refused", reason_category: reason, judge: "skipped", row_count: 0 }); disclosed.push(refusedAnswer(slot, reason)); continue; }
      const judged = await consultJudge(options.judge, { policy: options.policy, untrusted_question: slot.question, ...(preamble !== undefined ? { untrusted_preamble: preamble } : {}),
        expected_shape: slot.expected_shape, answer: { columns: [], rows: [], text }, metadata: { row_count: 0, group_count: 0, identifier_like_keys: [], columns_touched: [] } }, options.policy, options.signal);
      if (judged.verdict !== "pass") {
        const reason = "reason" in judged ? judged.reason : "judge_invalid";
        decisions.push({ slot_id: slot.slot_id, status: "refused", reason_category: reason, judge: judged.verdict, row_count: 0 }); disclosed.push(refusedAnswer(slot, reason)); continue;
      }
      decisions.push({ slot_id: slot.slot_id, status: "ok", judge: "pass", row_count: 0 });
      disclosed.push({ slot_id: slot.slot_id, status: "ok", shape: "narrative", text, ...(slot.unit !== undefined ? { unit: slot.unit } : {}) });
      continue;
    }
    provenance.push(provenanceOf(slot, answer.table));
    let table: TableAnswer = answer.table;
    const reason = deterministic(slot, table, options.policy);
    if (reason) { decisions.push({ slot_id: slot.slot_id, status: "refused", reason_category: reason, judge: "skipped", row_count: table.rows.length }); disclosed.push(refusedAnswer(slot, reason)); continue; }
    const judged = await consultJudge(options.judge, { policy: options.policy, untrusted_question: slot.question, ...(preamble !== undefined ? { untrusted_preamble: preamble } : {}),
      expected_shape: slot.expected_shape, answer: { columns: table.columns, rows: table.rows, ...(table.summary !== undefined ? { summary: table.summary } : {}) },
      metadata: { row_count: table.rows.length, group_count: groupCount(table), identifier_like_keys: identifierLikeKeys(table), columns_touched: [...table.columns] } }, options.policy, options.signal);
    if (judged.verdict === "refuse") {
      const reasonCategory = "reason" in judged ? judged.reason : "judge_refused";
      decisions.push({ slot_id: slot.slot_id, status: "refused", reason_category: reasonCategory, judge: "refuse", row_count: table.rows.length }); disclosed.push(refusedAnswer(slot, reasonCategory)); continue;
    }
    let status: EgressStatus = "ok";
    if (judged.verdict === "redact") {
      const redacted = redactColumns(table, judged.redact_columns ?? []);
      const again = redacted ? deterministic(slot, redacted, options.policy) : "judge_invalid";
      if (!redacted || again) {
        const reasonCategory: EgressReason = again ?? "judge_invalid";
        decisions.push({ slot_id: slot.slot_id, status: "refused", reason_category: reasonCategory, judge: "redact", row_count: table.rows.length }); disclosed.push(refusedAnswer(slot, reasonCategory)); continue;
      }
      table = redacted;
      status = "partial";
    }
    decisions.push({ slot_id: slot.slot_id, status, judge: judged.verdict, row_count: table.rows.length });
    disclosed.push(discloseTable(slot, table, status));
  }
  const anyDisclosed = disclosed.some((answer) => answer.status !== "refused");
  if (implicit) {
    const only = disclosed[0]!;
    if (only.status === "refused") {
      return { disclosed: { status: "refused", code: "callee_refused", message: `egress refused: ${only.reason_category}` }, decisions, provenance };
    }
    // A single implicit slot keeps the tabular value contract callers already consume, minus definition/SQL.
    return { disclosed: { status: "ok", output: { kind: "value", value: { columns: only.columns, rows: only.rows, verified: true,
      ...(only.summary !== undefined ? { summary: only.summary } : {}), egress: { status: only.status } } }, provenance: { verified: true } }, decisions, provenance };
  }
  return { disclosed: { status: "ok", output: { kind: "value", value: { answers: disclosed } }, provenance: { verified: anyDisclosed } }, decisions, provenance };
}
