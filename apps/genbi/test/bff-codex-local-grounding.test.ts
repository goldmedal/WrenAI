import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../server/app.js";
import { Store } from "../server/db.js";
import type { AnswerEvent } from "../server/wire-types.js";
import { route, type Bundle, type CodexAskExecutor, type DispatchedExecutor } from "../harness/index.js";
import { runCodexAskDefault } from "../harness/route/codex-ask.js";
import { truncationNote } from "../server/host-evidence-grounding.js";
import type { TurnDeps } from "../server/turn.js";
import { parseSse } from "./bff-sse-helpers.js";
import { fakeWrenWorkspace } from "./codex-host-evidence-helpers.js";

const DISPATCHER = path.join(import.meta.dirname, "fixtures", "fake-codex-mcp-dispatcher.mjs");
const ORDERS_SQL = "SELECT COUNT(*) AS order_count FROM orders";
const OTHER_SQL = "SELECT COUNT(*) AS order_count FROM orders WHERE status = 'placed'";

function agent(id: string): Bundle["agents"][number] {
  return { id, verb: id, component_type: "analytical", realization_kind: "skill", trigger: "one_shot", outcome: "none",
    steps: [], guardrails: {}, tools: [], output_schema: { type: "object", properties: {}, required: [] }, capabilities: [] };
}
const bundle = (target: string): Bundle => ({ vercel_bundle_version: "0.1", compat: { min_ir_version: "0.4", max_ir_version: "0.4" },
  profile: "genbi-default", target, agents: [agent("answer_query")] });

interface Script { calls: { name: string; arguments: Record<string, unknown> }[]; answer: unknown }

const scratch: string[] = [];
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  for (const directory of scratch.splice(0)) rmSync(directory, { recursive: true, force: true });
});

/** A BFF whose codex:local turns run the real runner, host query service and proxy, with a fake Codex and wren. */
function codexBff(): { ask(script: Script): Promise<AnswerEvent["answer"]> } {
  const workspace = fakeWrenWorkspace();
  cleanups.push(workspace.cleanup);
  const scripts = mkdtempSync(path.join(os.tmpdir(), "genbi-cl-scripts-"));
  scratch.push(scripts);
  const irPath = path.join(scripts, "ir.json");
  writeFileSync(irPath, "{}");
  const codexAsk: CodexAskExecutor = (options) => runCodexAskDefault({
    ...options,
    userProject: workspace.project,
    irPath,
    codexHome: scripts,
    codexModels: { orchestrator: "driver-model", cheap: "cheap-model", strong: "strong-model" },
    codexLocalCli: { command: process.execPath, prefixArgs: [DISPATCHER] },
    mcpServer: { command: workspace.wren, prefixArgs: [] },
    timeoutMs: 20_000,
  });
  const deps: TurnDeps = {
    store: new Store(":memory:"),
    route,
    baseRouteOptions: { authChoice: { mode: "subscription", provider: "codex" }, profileSource: "/fixture/profile",
      userProject: workspace.project, outDir: scripts, codexAsk },
    describeBundle: async () => bundle("codex:local"),
  };
  const app = createApp(deps);
  let session: Promise<string> | undefined;
  let turns = 0;
  return {
    async ask(script) {
      session ??= (async () => ((await (await app.request("/api/sessions", { method: "POST", body: "{}" })).json()) as { id: string }).id)();
      const id = await session;
      const file = path.join(scripts, `turn-${++turns}.json`);
      writeFileSync(file, JSON.stringify(script));
      const { turnId } = (await (await app.request(`/api/sessions/${id}/turns`, { method: "POST", body: JSON.stringify({ question: `script:${file}` }) })).json()) as { turnId: string };
      const frames = parseSse(await (await app.request(`/api/sessions/${id}/stream?turn=${turnId}`)).text());
      const answer = frames.find((frame) => frame.event === "event" && (frame.data as { kind?: string }).kind === "answer");
      if (!answer) throw new Error(`no answer frame: ${JSON.stringify(frames.filter((frame) => frame.event === "event").map((frame) => frame.data))}`);
      return (answer.data as AnswerEvent).answer;
    },
  };
}

const run = (sql: string) => ({ name: "run_sql", arguments: { sql } });
/** codex:local's query-result terminal shape; `order_count` is whatever the model typed. */
const queryResult = (sql: string, orderCount: number, extra: Record<string, unknown> = {}) => ({
  result_set: { columns: ["order_count"], rows: [{ order_count: orderCount }] },
  sql, source_tables: ["orders"], filters: [], execution_passed: true, validation_passed: true, validation_error: null, ...extra,
});
function envelopeOf(answer: AnswerEvent["answer"]) {
  if (answer.form !== "rich") throw new Error(`expected a rich answer, got ${JSON.stringify(answer)}`);
  return answer.envelope;
}

// Each turn spawns a fake Codex, the proxy and two fake wren processes.
describe("codex:local answers are grounded against this turn's host query observations", { timeout: 30_000 }, () => {
  it("verifies an answer citing a host-run query by SQL, with the table taken from the observation", async () => {
    const bff = codexBff();
    const envelope = envelopeOf(await bff.ask({ calls: [run(ORDERS_SQL)],
      answer: { ...queryResult(`  ${ORDERS_SQL.replace(/ /g, "\n ")} ;`, 41), summary: "There are 42 orders." } }));
    expect(envelope.verified).toBe(true);
    expect(envelope.blocks).toEqual([
      { type: "table", columns: ["order_count"], rows: [{ order_count: 42 }] },
      { type: "definition", sql: ORDERS_SQL, source_tables: ["orders"], filters: [], query_id: expect.stringMatching(/^q1-/) },
    ]);
  });

  it("verifies an answer citing a host-run query by its query_id, choosing that query over a later one", async () => {
    const bff = codexBff();
    const envelope = envelopeOf(await bff.ask({ calls: [run(ORDERS_SQL), run(OTHER_SQL)],
      answer: { columns: ["order_count"], rows: [[7]], definition: { query_id: "$QID0", sql: OTHER_SQL } } }));
    expect(envelope.verified).toBe(true);
    expect(envelope.blocks).toEqual([
      { type: "table", columns: ["order_count"], rows: [{ order_count: 42 }] },
      { type: "definition", sql: ORDERS_SQL, source_tables: ["orders"], filters: [], query_id: expect.stringMatching(/^q1-/) },
    ]);
  });

  it("verifies a cited truncated result for the rows shown, with a host truncation note", async () => {
    const bff = codexBff();
    const sql = "SELECT id FROM customers";
    const envelope = envelopeOf(await bff.ask({ calls: [{ name: "run_sql", arguments: { sql, limit: 2 } }],
      answer: { columns: ["id"], rows: [[1], [2]], summary: "There are 2 customers.", definition: { query_id: "$QID0" } } }));
    expect(envelope.verified).toBe(true);
    expect(envelope.blocks).toEqual([
      { type: "table", columns: ["id"], rows: [{ id: 1 }, { id: 2 }] },
      { type: "definition", sql, source_tables: ["customers"], filters: [], query_id: expect.stringMatching(/^q1-/) },
    ]);
    expect(envelope.summary).toBe(`There are 2 customers.\n\n${truncationNote(2)}`);
  });

  it("leaves an answer citing nothing unverified, even after a host-run query", async () => {
    const bff = codexBff();
    const envelope = envelopeOf(await bff.ask({ calls: [run(ORDERS_SQL)], answer: { columns: ["order_count"], rows: [[42]], verified: true } }));
    expect(envelope.verified).toBe(false);
    expect(envelope.blocks).toEqual([{ type: "table", columns: ["order_count"], rows: [[42]] }]);
  });

  it("leaves an answer citing a table-less query unverified: governed access refuses to run it", async () => {
    const bff = codexBff();
    const envelope = envelopeOf(await bff.ask({ calls: [run("SELECT 42 AS order_count")], answer: queryResult("SELECT 42 AS order_count", 42) }));
    expect(envelope.verified).toBe(false);
  });

  it("leaves an answer citing a table-less query unverified even when the host recorded a result for it", async () => {
    const bff = codexBff();
    const sql = "/*lax*/ SELECT 424 AS n";
    const envelope = envelopeOf(await bff.ask({ calls: [run(sql)],
      answer: { columns: ["n"], rows: [[424]], definition: { query_id: "$QID0", sql } } }));
    expect(envelope.verified).toBe(false);
    expect(envelope.blocks).toEqual([
      { type: "table", columns: ["n"], rows: [[424]] },
      { type: "definition", sql, source_tables: undefined, filters: undefined },
    ]);
  });

  it("leaves an answer citing a query the host did not run unverified", async () => {
    const bff = codexBff();
    const envelope = envelopeOf(await bff.ask({ calls: [run(ORDERS_SQL)], answer: queryResult(OTHER_SQL, 42) }));
    expect(envelope.verified).toBe(false);
    const byId = envelopeOf(await bff.ask({ calls: [run(ORDERS_SQL)],
      answer: { columns: ["order_count"], rows: [[42]], definition: { query_id: "q1-00000000", sql: ORDERS_SQL } } }));
    expect(byId.verified).toBe(false);
  });

  it("leaves an answer citing a query from a previous turn unverified", async () => {
    const bff = codexBff();
    const first = envelopeOf(await bff.ask({ calls: [run(ORDERS_SQL)], answer: queryResult(ORDERS_SQL, 42) }));
    expect(first.verified).toBe(true);
    const previousId = (first.blocks as { query_id?: string }[])[1]!.query_id!;
    const bySql = envelopeOf(await bff.ask({ calls: [], answer: queryResult(ORDERS_SQL, 42) }));
    expect(bySql.verified).toBe(false);
    const byId = envelopeOf(await bff.ask({ calls: [run(OTHER_SQL)],
      answer: { columns: ["order_count"], rows: [[42]], definition: { query_id: previousId, sql: ORDERS_SQL } } }));
    expect(byId.verified).toBe(false);
  });
});

describe("agent-sdk answers without host evidence stay unverified", () => {
  it("drops the model's verified flag whatever it cites when the turn recorded no host query", async () => {
    const outDir = mkdtempSync(path.join(os.tmpdir(), "genbi-agent-sdk-"));
    scratch.push(outDir);
    const dispatched: DispatchedExecutor = async () => ({ finalText: JSON.stringify({ ...queryResult(ORDERS_SQL, 42), verified: true }) });
    const deps: TurnDeps = {
      store: new Store(":memory:"),
      route,
      baseRouteOptions: { authChoice: { mode: "subscription", provider: "claude" }, profileSource: "/fixture/profile",
        userProject: outDir, outDir, dispatched },
      describeBundle: async () => bundle("claude-agent-sdk"),
    };
    const app = createApp(deps);
    const { id } = (await (await app.request("/api/sessions", { method: "POST", body: "{}" })).json()) as { id: string };
    const { turnId } = (await (await app.request(`/api/sessions/${id}/turns`, { method: "POST", body: JSON.stringify({ question: "how many orders" }) })).json()) as { turnId: string };
    const frames = parseSse(await (await app.request(`/api/sessions/${id}/stream?turn=${turnId}`)).text());
    const answer = frames.find((frame) => frame.event === "event" && (frame.data as { kind?: string }).kind === "answer")?.data as AnswerEvent;
    expect(envelopeOf(answer.answer).verified).toBe(false);
  });
});
