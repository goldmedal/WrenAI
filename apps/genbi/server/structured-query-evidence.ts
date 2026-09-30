import { z } from "zod";
import type { RenderEnvelope } from "../harness/render/envelope.js";

const cell = z.union([z.string(), z.number().finite(), z.boolean(), z.null()]);
const table = z.object({ columns: z.array(z.string()).min(1), rows: z.array(z.union([z.array(cell), z.record(z.string(), cell)])) });
const definition = z.object({ sql: z.string().trim().min(1), source_tables: z.array(z.string()).optional(), filters: z.array(z.string()).optional() });
const renderResult = z.object({ status: z.literal("ok"),
  output: z.object({ kind: z.literal("render"), blocks: z.array(z.object({ type: z.string() }).passthrough()) }),
  provenance: z.object({ verified: z.literal(true) }) });
const result = z.object({ status: z.literal("ok"), output: z.object({ kind: z.literal("value"), value: table }),
  provenance: z.object({ verified: z.literal(true), definition }) });

/** Only call with returns from scoped host tools, never vendor messages or tool arguments.
 * Keep every root in call order; mixed failure/success must not look wholly verified.
 */
export function structuredQueryEnvelope(roots: readonly unknown[], explanation: string): RenderEnvelope | undefined {
  if (!roots.length) return undefined;
  const blocks: unknown[] = [];
  for (const raw of roots) {
    const parsed = result.safeParse(raw);
    if (!parsed.success) {
      const rendered = renderResult.safeParse(raw);
      if (!rendered.success || !rendered.data.output.blocks.length) return undefined;
      blocks.push(...rendered.data.output.blocks);
      continue;
    }
    const { columns, rows } = parsed.data.output.value;
    if (new Set(columns).size !== columns.length || rows.some((row) => Array.isArray(row)
      ? row.length !== columns.length : columns.some((name) => !Object.hasOwn(row, name)))) return undefined;
    blocks.push({ type: "table", columns, rows }, { type: "definition", ...parsed.data.provenance.definition });
  }
  return { blocks, verified: true, verificationScope: "query-results", explanation };
}

/** Supply the clock explicitly. Historical datasets must never silently become 'recent'. */
export function analyticalAskPrompt(question: string, now: Date): string {
  return `Current reference time (UTC): ${now.toISOString()}.
Use the selected analysis tool for data questions and pass the user's requested period and metric definitions faithfully.
If no period was specified, use the full available data range and disclose this assumption; do not invent a recent N-week limit.
For relative periods, distinguish the current calendar from the latest data date. Never silently re-anchor a calendar-relative request.
The application displays successful query rows and SQL directly. Do not repeat the table or serialize an answer envelope in your final text.
Instead explain in the user's language: exact date range and anchor, date field, week start, timezone (or unknown), partial periods,
and the definition of each metric. Separate context-defined metrics from assumptions. Do not invent signup dates or duplicate synonymous metrics.
If the result cannot establish a date bound or definition, state that it is unknown or ask for clarification. Do not invent evidence.

User question:
${question}`;
}
