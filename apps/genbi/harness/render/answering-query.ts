/**
 * Which executed query answers the question. A step may run several successful
 * queries (an exploratory count, then the real one, then a stray check), so
 * "the last successful table" is not a safe choice: a chatty model produces a
 * grounded but wrong answer. The model names the query it answered with in the
 * terminal value's `definition.sql` (the Hub prompts require the exact SQL it
 * ran); the host then selects the observed table with that SQL, and never the
 * model's own copy of the rows.
 */

/** Whitespace- and terminator-insensitive identity for one SQL text. */
export function sqlKey(sql: string): string {
  return sql.replace(/\s+/g, " ").replace(/;\s*$/, "").trim();
}

/** The SQL a terminal value names as its answer, if it names exactly one. */
export function namedAnswerSql(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const definition = record.definition;
  if (typeof definition === "object" && definition !== null && !Array.isArray(definition)) {
    const sql = (definition as Record<string, unknown>).sql;
    if (typeof sql === "string" && sql.trim()) return sql;
  }
  return typeof record.sql === "string" && record.sql.trim() ? record.sql : undefined;
}

/**
 * Picks the answering entry among candidates that each carry the SQL they ran.
 * Named and observed: the last observation of that SQL. Named but never run:
 * `undefined`, so the caller refuses rather than substitute another table.
 * Unnamed: the last candidate, the historical rule, kept only for values that
 * do not name a query at all.
 */
export function selectAnsweringCandidate<T extends { readonly sql?: string | undefined }>(
  candidates: readonly T[],
  terminalValue: unknown,
): T | undefined {
  const named = namedAnswerSql(terminalValue);
  if (named === undefined) return candidates.at(-1);
  const key = sqlKey(named);
  return [...candidates].reverse().find((candidate) => candidate.sql !== undefined && sqlKey(candidate.sql) === key);
}
