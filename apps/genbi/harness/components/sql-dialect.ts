import { readFile } from "node:fs/promises";
import path from "node:path";
import { readYamlScalarField } from "../setup/yaml-scalar.js";

/**
 * The SQL dialect a bound project's queries are parsed and policed with. The governed query process
 * parses with `get_sqlglot_dialect(DataSource(datasource))` in core/wren: a fixed override for seven
 * sources and the source's own name for the rest. This mirrors that mapping; `sql-dialect.test.ts`
 * compares it with the real function whenever a wren interpreter is available, so drift is caught.
 */
const DIALECT_OVERRIDES: Readonly<Record<string, string>> = Object.freeze({
  canner: "trino", datafusion: "wren", mssql: "tsql",
  local_file: "duckdb", s3_file: "duckdb", minio_file: "duckdb", gcs_file: "duckdb",
});
/** Every `DataSource` core/wren defines; a value outside this list is unknown and gets no dialect. */
export const KNOWN_DATA_SOURCES: readonly string[] = Object.freeze([
  "athena", "bigquery", "canner", "clickhouse", "datafusion", "mssql", "mysql", "doris", "oracle", "postgres", "redshift",
  "snowflake", "trino", "local_file", "s3_file", "minio_file", "gcs_file", "duckdb", "spark", "databricks",
]);

/** The dialect for a declared data source, or undefined when it is empty or not a known source (never a guess). */
export function sqlDialectFor(dataSource: string | undefined): string | undefined {
  const name = dataSource?.trim().toLowerCase();
  if (!name || !KNOWN_DATA_SOURCES.includes(name)) return undefined;
  return DIALECT_OVERRIDES[name] ?? name;
}

/** The dialect of the project's declared `data_source`, or undefined when the file, the field or the source is missing. */
export async function readProjectSqlDialect(project: string): Promise<string | undefined> {
  try {
    return sqlDialectFor(readYamlScalarField(await readFile(path.join(project, "wren_project.yml"), "utf8"), "data_source"));
  } catch { return undefined; }
}

/** Model-visible guidance: the dialect name only, never data. */
export function dialectGuidance(dialect: string): string {
  return `SQL dialect: ${dialect} (from the project's data source). Write ${dialect} SQL; functions from other databases are rejected.`;
}
