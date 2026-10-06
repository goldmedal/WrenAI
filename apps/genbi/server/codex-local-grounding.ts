import { citedGroundedQuery } from "../harness/components/normalize.js";
import type { HostQueryObservation } from "../harness/route/codex-host-query.js";
import { extractJsonCandidateFromText, type RenderEnvelope } from "../harness/render/envelope.js";
import { namedAnswerQueryId, namedAnswerSql, sqlKey } from "../harness/render/answering-query.js";

/** Blocks whose values the host cannot rebuild from one observed table; their presence leaves an answer unverified. */
const UNREBUILDABLE_DATA_BLOCKS = new Set(["chart", "kpi_card"]);

interface Citation { readonly queryId?: string; readonly sql?: string }

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/**
 * The queries a codex:local answer names. A `{blocks}` answer cites through its `definition`
 * blocks; a flat or query-result answer through its own `definition` / top-level fields, read
 * from the raw text because envelope normalization drops a cited `query_id`. A host id wins over
 * SQL, like the component path.
 */
function citations(envelope: RenderEnvelope, finalText: string): Citation[] {
  const raw = extractJsonCandidateFromText(finalText);
  if (!Array.isArray(record(raw)?.blocks)) {
    const queryId = namedAnswerQueryId(raw);
    if (queryId !== undefined) return [{ queryId }];
    const sql = namedAnswerSql(raw);
    return sql !== undefined ? [{ sql }] : [];
  }
  const found: Citation[] = [];
  const seen = new Set<string>();
  for (const block of Array.isArray(envelope.blocks) ? envelope.blocks : []) {
    const fields = record(block);
    if (fields?.type !== "definition") continue;
    const queryId = typeof fields.query_id === "string" && fields.query_id.length > 0 ? fields.query_id : undefined;
    const sql = typeof fields.sql === "string" && fields.sql.trim() ? fields.sql : undefined;
    const citation = queryId !== undefined ? { queryId } : sql !== undefined ? { sql } : undefined;
    if (!citation) continue;
    const key = queryId !== undefined ? `id:${queryId}` : `sql:${sqlKey(sql!)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    found.push(citation);
  }
  return found;
}

/**
 * Grounds a codex:local answer against the queries this turn's host query service executed,
 * with the component path's predicate (`citedGroundedQuery`: a tool-proven definition that
 * reads at least one table, cited by `query_id`, else by whitespace-insensitive SQL).
 *
 * Verified only when the answer cites at least one query and every citation grounds. The
 * envelope is then rebuilt from the observations alone: one `table` and one `definition` block
 * (carrying the observed `query_id`) per cited query, plus the model's `summary` text as written.
 * A cited result the host saw truncated still grounds the rows it shows; the host then appends
 * a note to `summary`, the only place the render contract carries such text. Anything else stays the model's answer with
 * `verified: false`: no citation, a citation to a query this turn never ran (including one from
 * an earlier turn), a query that read no table, or chart / KPI blocks the host cannot rebuild.
 */
export function groundCodexLocalEnvelope(
  envelope: RenderEnvelope,
  finalText: string,
  observations: readonly HostQueryObservation[],
): RenderEnvelope {
  const unverified: RenderEnvelope = { ...envelope, verified: false };
  if (observations.length === 0) return unverified;
  const blocks = Array.isArray(envelope.blocks) ? envelope.blocks : [];
  if (blocks.some((block) => UNREBUILDABLE_DATA_BLOCKS.has(String(record(block)?.type)))) return unverified;
  const cited = citations(envelope, finalText);
  if (cited.length === 0) return unverified;
  const rebuilt: Record<string, unknown>[] = [];
  const notes: string[] = [];
  for (const citation of cited) {
    const query = citedGroundedQuery(observations, citation);
    if (!query) return unverified;
    const observation = observations.find((call) => (call.output as { query_id?: unknown } | null)?.query_id === query.queryId);
    if ((observation?.output as { truncated?: unknown } | undefined)?.truncated === true) notes.push(truncationNote(query.table.rows.length));
    // The definition keeps the observed query's host id, so grounding the rebuilt envelope
    // again (the artifact path does) resolves to the very same observation.
    rebuilt.push({ type: "table", columns: query.table.columns, rows: query.table.rows },
      { type: "definition", ...query.definition, ...(query.queryId !== undefined ? { query_id: query.queryId } : {}) });
  }
  const summary = withNotes(typeof envelope.summary === "string" ? envelope.summary : undefined, notes);
  return { blocks: rebuilt, ...(summary !== undefined ? { summary } : {}), verified: true };
}

/** Host-written, never model-written: a cited table that is only the first rows of its result. */
export function truncationNote(shown: number): string {
  return `Host note: this query returned more than ${shown} rows; the table shows only the first ${shown}.`;
}

/** Appends each host note once, so grounding an already-grounded envelope again changes nothing. */
function withNotes(summary: string | undefined, notes: readonly string[]): string | undefined {
  const missing = [...new Set(notes)].filter((note) => !summary?.includes(note));
  if (missing.length === 0) return summary;
  return [summary, ...missing].filter((part) => part !== undefined && part.length > 0).join("\n\n");
}
