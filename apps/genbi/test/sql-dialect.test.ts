import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { hashDirectory } from "../harness/compile/fingerprint.js";
import { resolveWarbleBinary } from "../harness/compile/resolve-binary.js";
import { createComponentBroker, type ComponentIdentity } from "../harness/components/broker.js";
import { normalizeComponentEvidence } from "../harness/components/normalize.js";
import { planDigest } from "../harness/components/plan.js";
import { ComponentRunner, type ComponentPlan, type ExecutionPlan, type StepRun } from "../harness/components/runner.js";
import { KNOWN_DATA_SOURCES, readProjectSqlDialect, sqlDialectFor } from "../harness/components/sql-dialect.js";
import { GovernedWrenError, openWrenComponentAccess } from "../harness/components/wren-access.js";

/** The `wren` CLI on PATH is a uv-tool script whose shebang is the interpreter that has core/wren installed. */
async function wrenPython(): Promise<string | undefined> {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    try {
      const first = (await readFile(path.join(dir, "wren"), "utf8")).split("\n", 1)[0] ?? "";
      if (first.startsWith("#!")) return first.slice(2).trim();
    } catch { /* not in this directory */ }
  }
  return undefined;
}
const python = await wrenPython();
function coreMapping(): Record<string, string> | undefined {
  if (!python) return undefined;
  const run = spawnSync(python, ["-c", "import json\nfrom wren.model.data_source import DataSource\nfrom wren.mdl.cte_rewriter import get_sqlglot_dialect\nprint(json.dumps({d.value: get_sqlglot_dialect(d) for d in DataSource}))"], { encoding: "utf8" });
  if (run.status !== 0) return undefined;
  return JSON.parse(run.stdout) as Record<string, string>;
}
const core = coreMapping();

describe("SQL dialect of a bound project", () => {
  it.skipIf(core === undefined)("mirrors core/wren's get_sqlglot_dialect for every data source it lists", () => {
    expect([...KNOWN_DATA_SOURCES].sort()).toEqual(Object.keys(core!).sort());
    for (const [source, dialect] of Object.entries(core!)) expect(sqlDialectFor(source), source).toBe(dialect);
  });
  it("maps the sources with a fixed override and passes the rest through", () => {
    expect(["canner", "datafusion", "mssql", "local_file", "s3_file", "minio_file", "gcs_file", "duckdb", "postgres", "bigquery"].map((s) => sqlDialectFor(s)))
      .toEqual(["trino", "wren", "tsql", "duckdb", "duckdb", "duckdb", "duckdb", "duckdb", "postgres", "bigquery"]);
    expect(sqlDialectFor(" DuckDB ")).toBe("duckdb");
  });
  it.each([undefined, "", "   ", "not_a_source"])("gives no dialect for %j", (value) => { expect(sqlDialectFor(value)).toBeUndefined(); });

  async function project(yaml: string | undefined, run: (dir: string) => Promise<void>) {
    const dir = await mkdtemp(path.join(os.tmpdir(), "genbi-dialect-"));
    try { if (yaml !== undefined) await writeFile(path.join(dir, "wren_project.yml"), yaml); await run(dir); } finally { await rm(dir, { recursive: true, force: true }); }
  }
  it("reads the declared data_source, ignoring a trailing comment", async () => {
    await project("name: demo\ndata_source: postgres  # prod\n", async (dir) => expect(await readProjectSqlDialect(dir)).toBe("postgres"));
    await project("data_source: local_file\n", async (dir) => expect(await readProjectSqlDialect(dir)).toBe("duckdb"));
  });
  it.each([["unset field", "data_source:  # not set yet\n"], ["no field", "name: demo\n"], ["unknown source", "data_source: acme\n"]])("an unbound project (%s) has no dialect", async (_name, yaml) => {
    await project(yaml, async (dir) => expect(await readProjectSqlDialect(dir)).toBeUndefined());
  });
  it("a project without wren_project.yml has no dialect", async () => { await project(undefined, async (dir) => expect(await readProjectSqlDialect(dir)).toBeUndefined()); });

  const FAKE = `console.log(JSON.stringify({id:0,protocol:"wren-governed/2"}));
    const readline = require('node:readline');
    readline.createInterface({input:process.stdin}).on('line',line => {
      const request=JSON.parse(line);
      const cls = request.sql.includes('other') ? 'model_not_found' : 'policy_rejected';
      console.log(JSON.stringify({id:request.id,error:{class:cls,message:'raw wire text 42'}}));
    });`;
  async function rejection(yaml: string | undefined, sql: string) {
    let out: { sqlDialect: string | undefined; message: string } | undefined;
    await project(yaml, async (dir) => {
      await writeFile(path.join(dir, "fake-wren"), `#!${process.execPath}\n${FAKE}`, { mode: 0o700 });
      const access = await openWrenComponentAccess({ executable: path.join(dir, "fake-wren"), project: dir, fingerprint: await hashDirectory(dir), signal: new AbortController().signal });
      try {
        const error = await access.query({ sql, limit: 1 }, new AbortController().signal).catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(GovernedWrenError);
        out = { sqlDialect: access.sqlDialect, message: (error as Error).message };
      } finally { await access.close(); }
    });
    return out!;
  }
  it.each([["duckdb", "duckdb"], ["postgres", "postgres"]])("a %s-bound project's policy rejection tells the model the %s dialect, and nothing else", async (source, dialect) => {
    const result = await rejection(`data_source: ${source}\n`, "SELECT TO_CHAR(d) FROM t");
    expect(result.sqlDialect).toBe(dialect);
    expect(result.message).toContain(`SQL dialect: ${dialect} (from the project's data source). Write ${dialect} SQL; functions from other databases are rejected.`);
    expect(result.message).not.toMatch(/raw wire text|TO_CHAR|42/);
  });
  it("only a policy rejection carries the dialect; another class keeps its own text", async () => {
    expect((await rejection("data_source: duckdb\n", "SELECT other")).message).not.toContain("SQL dialect");
  });
  it("an unbound project's rejection carries no dialect", async () => {
    const result = await rejection("data_source:  # not set yet\n", "SELECT 1 FROM t");
    expect(result.sqlDialect).toBeUndefined();
    expect(result.message).not.toContain("SQL dialect");
  });
});

describe("the query tool description the model sees", () => {
  let verifierBinary: string;
  beforeAll(async () => { verifierBinary = await resolveWarbleBinary(process.env.WARBLE_TEST_CLI); });
  const contexts = { answer: { binding: {}, snapshot: { context_version: 2, parseable: true } } };
  const identity: ComponentIdentity = { session: "s", vendor: "v", account: "a", generation: "1", project: "p", bindingRevision: "r", contextDigest: planDigest(contexts), planDigest: "plan" };
  const component = (): ComponentPlan => ({ id: "answer", declaration: { context_binding: {}, context_precondition: [{ predicate: "mdl_parseable" }], required_capabilities: ["sql_execution:read_only"], effect: { render_blocks: [] },
    guardrails: [{ name: "read_only_execution", locked: true }] },
    steps: [{ name: "query", tier: "cheap", prompt: "query", consumes: [], produces: "data", tools: [{ name: "query", source: "native" }], calls: [] }] });
  const plan = (): ExecutionPlan => ({ identity: "plan", entries: ["answer"], components: { answer: component() } });
  async function descriptionFor(sqlDialect: string | undefined): Promise<string | undefined> {
    let seen: string | undefined;
    const broker = createComponentBroker({ plan: plan(), contexts, verifierBinary, identity, currentIdentity: () => identity,
      async prepare() { return { ...(sqlDialect ? { sqlDialect } : {}), async query() { return {}; }, async inspect() { return {}; }, async close() {} }; },
      async step(run: StepRun) { seen = run.toolDescriptions["query"]; return { value: "done" }; },
      async normalize(node, evidence) { return normalizeComponentEvidence(node, evidence); } });
    await new ComponentRunner(plan(), broker).run("answer", { request: "go" });
    return seen;
  }
  it.each(["duckdb", "postgres"])("names the %s dialect", async (dialect) => {
    const text = await descriptionFor(dialect);
    expect(text).toContain(`SQL dialect: ${dialect} (from the project's data source). Write ${dialect} SQL; functions from other databases are rejected.`);
  });
  it("has no dialect line for an unbound project", async () => { expect(await descriptionFor(undefined)).toBeUndefined(); });
});
