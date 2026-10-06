import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../server/app.js";
import { Store } from "../server/db.js";
import type { AnswerEvent } from "../server/wire-types.js";
import { route, runDispatchedDefault, type Bundle, type DispatchedExecutor, type DispatchedOptions } from "../harness/index.js";
import { HOST_MCP_INSTRUCTION, HOST_MCP_SERVER_NAME } from "../harness/route/dispatched.js";
import type { TurnDeps } from "../server/turn.js";
import { parseSse } from "./bff-sse-helpers.js";
import { fakeWrenWorkspace, PROXY_SOURCE } from "./codex-host-evidence-helpers.js";

const FAKE_CHAT = path.join(import.meta.dirname, "fixtures", "fake-agent-sdk-host-mcp.mjs");
const ORDERS_SQL = "SELECT COUNT(*) AS order_count FROM orders";
const OTHER_SQL = "SELECT COUNT(*) AS order_count FROM orders WHERE status = 'placed'";

function agent(id: string): Bundle["agents"][number] {
  return { id, verb: id, component_type: "analytical", realization_kind: "skill", trigger: "one_shot", outcome: "none",
    steps: [], guardrails: {}, tools: [], output_schema: { type: "object", properties: {}, required: [] }, capabilities: [] };
}
const bundle: Bundle = { vercel_bundle_version: "0.1", compat: { min_ir_version: "0.4", max_ir_version: "0.4" },
  profile: "genbi-default", target: "claude-agent-sdk", agents: [agent("answer_query")] };

interface Script { calls: { name: string; arguments: Record<string, unknown> }[]; answer: unknown }
interface Capture {
  args: string[]; configPath?: string; configStat?: { mode: number; uid: number }; configKeys?: string[];
  config?: { name: string; command: string; args: string[]; tools: string[]; instruction?: string }; configError?: string;
  tools?: string[]; results: unknown[];
}

const scratch: string[] = [];
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  for (const directory of scratch.splice(0)) rmSync(directory, { recursive: true, force: true });
});

/**
 * A BFF whose Claude subscription Ask turns run the real dispatched runner, host query service
 * and host proxy, with a fake `warble-agent-sdk chat` (which loads the host MCP config with
 * warble's own loader) and a fake wren.
 */
function claudeBff(override: (options: DispatchedOptions) => DispatchedOptions = (options) => options) {
  const workspace = fakeWrenWorkspace();
  cleanups.push(workspace.cleanup);
  const scripts = mkdtempSync(path.join(os.tmpdir(), "genbi-as-scripts-"));
  scratch.push(scripts);
  const irPath = path.join(scripts, "ir.json");
  writeFileSync(irPath, "{}");
  const chat = path.join(scripts, "warble-agent-sdk");
  writeFileSync(chat, `#!${process.execPath}\nimport(${JSON.stringify(FAKE_CHAT)});\n`, { mode: 0o700 });
  const dispatched: DispatchedExecutor = (options) => runDispatchedDefault(override({
    ...options,
    userProject: workspace.project,
    irPath,
    warbleBin: "/usr/bin/false",
    agentSdkBin: chat,
    outDir: scripts,
    chatTimeoutMs: 20_000,
    ...(options.hostQueries !== undefined ? { hostQueries: { wren: workspace.wren } } : {}),
  }));
  const deps: TurnDeps = {
    store: new Store(":memory:"),
    route,
    baseRouteOptions: { authChoice: { mode: "subscription", provider: "claude" }, profileSource: "/fixture/profile",
      userProject: workspace.project, outDir: scripts, dispatched },
    describeBundle: async () => bundle,
  };
  const app = createApp(deps);
  let session: Promise<string> | undefined;
  let turns = 0;
  return {
    async ask(script: Script): Promise<{ answer: AnswerEvent["answer"]; capture: Capture }> {
      session ??= (async () => ((await (await app.request("/api/sessions", { method: "POST", body: "{}" })).json()) as { id: string }).id)();
      const id = await session;
      const file = path.join(scripts, `turn-${++turns}.json`);
      const capture = path.join(scripts, `capture-${turns}.json`);
      writeFileSync(file, JSON.stringify({ ...script, capture }));
      const { turnId } = (await (await app.request(`/api/sessions/${id}/turns`, { method: "POST", body: JSON.stringify({ question: `script:${file}` }) })).json()) as { turnId: string };
      const frames = parseSse(await (await app.request(`/api/sessions/${id}/stream?turn=${turnId}`)).text());
      const answer = frames.find((frame) => frame.event === "event" && (frame.data as { kind?: string }).kind === "answer");
      if (!answer) throw new Error(`no answer frame: ${JSON.stringify(frames.filter((frame) => frame.event === "event").map((frame) => frame.data))}`);
      return { answer: (answer.data as AnswerEvent).answer, capture: JSON.parse(readFileSync(capture, "utf8")) as Capture };
    },
  };
}

const run = (sql: string) => ({ name: "run_sql", arguments: { sql } });
/** answer_query's flat terminal shape; `order_count` is whatever the model typed. */
const queryResult = (sql: string, orderCount: number, extra: Record<string, unknown> = {}) => ({
  columns: ["order_count"], rows: [[orderCount]], definition: { sql, source_tables: ["orders"], filters: [] }, ...extra,
});
function envelopeOf(answer: AnswerEvent["answer"]) {
  if (answer.form !== "rich") throw new Error(`expected a rich answer, got ${JSON.stringify(answer)}`);
  return answer.envelope;
}

// Each turn spawns a fake dispatcher, the proxy and two fake wren processes.
describe("agent-sdk answers are grounded against this turn's host query observations", { timeout: 30_000 }, () => {
  it("verifies an answer citing a host-run query by SQL, with the table taken from the observation", async () => {
    const bff = claudeBff();
    const { answer, capture } = await bff.ask({ calls: [run(ORDERS_SQL)],
      answer: { ...queryResult(`  ${ORDERS_SQL.replace(/ /g, "\n ")} ;`, 41), summary: "There are 42 orders." } });
    const envelope = envelopeOf(answer);
    expect(envelope.verified).toBe(true);
    expect(envelope.blocks).toEqual([
      { type: "table", columns: ["order_count"], rows: [{ order_count: 42 }] },
      { type: "definition", sql: ORDERS_SQL, source_tables: ["orders"], filters: [], query_id: expect.stringMatching(/^q1-/) },
    ]);
    expect(capture.tools).toEqual(["run_sql", "dry_run", "list_models"]);
  });

  it("verifies an answer citing a host-run query by its query_id, choosing that query over a later one", async () => {
    const bff = claudeBff();
    const envelope = envelopeOf((await bff.ask({ calls: [run(ORDERS_SQL), run(OTHER_SQL)],
      answer: { columns: ["order_count"], rows: [[7]], definition: { query_id: "$QID0", sql: OTHER_SQL } } })).answer);
    expect(envelope.verified).toBe(true);
    expect(envelope.blocks).toEqual([
      { type: "table", columns: ["order_count"], rows: [{ order_count: 42 }] },
      { type: "definition", sql: ORDERS_SQL, source_tables: ["orders"], filters: [], query_id: expect.stringMatching(/^q1-/) },
    ]);
  });

  it("leaves an answer citing nothing unverified, even after a host-run query", async () => {
    const bff = claudeBff();
    const envelope = envelopeOf((await bff.ask({ calls: [run(ORDERS_SQL)], answer: { columns: ["order_count"], rows: [[42]], verified: true } })).answer);
    expect(envelope.verified).toBe(false);
  });

  it("leaves an answer citing a table-less query unverified, refused or recorded", async () => {
    const bff = claudeBff();
    const refused = envelopeOf((await bff.ask({ calls: [run("SELECT 42 AS order_count")], answer: queryResult("SELECT 42 AS order_count", 42) })).answer);
    expect(refused.verified).toBe(false);
    const sql = "/*lax*/ SELECT 424 AS n";
    const recorded = envelopeOf((await bff.ask({ calls: [run(sql)], answer: { columns: ["n"], rows: [[424]], definition: { query_id: "$QID0", sql } } })).answer);
    expect(recorded.verified).toBe(false);
  });

  it("leaves an answer citing a query the host did not run unverified", async () => {
    const bff = claudeBff();
    expect(envelopeOf((await bff.ask({ calls: [run(ORDERS_SQL)], answer: queryResult(OTHER_SQL, 42) })).answer).verified).toBe(false);
    const byId = envelopeOf((await bff.ask({ calls: [run(ORDERS_SQL)],
      answer: { columns: ["order_count"], rows: [[42]], definition: { query_id: "q1-00000000", sql: ORDERS_SQL } } })).answer);
    expect(byId.verified).toBe(false);
  });

  it("leaves an answer citing a query from a previous turn unverified", async () => {
    const bff = claudeBff();
    const first = envelopeOf((await bff.ask({ calls: [run(ORDERS_SQL)], answer: queryResult(ORDERS_SQL, 42) })).answer);
    expect(first.verified).toBe(true);
    const previousId = (first.blocks as { query_id?: string }[])[1]!.query_id!;
    expect(envelopeOf((await bff.ask({ calls: [], answer: queryResult(ORDERS_SQL, 42) })).answer).verified).toBe(false);
    const byId = envelopeOf((await bff.ask({ calls: [run(OTHER_SQL)],
      answer: { columns: ["order_count"], rows: [[42]], definition: { query_id: previousId, sql: ORDERS_SQL } } })).answer);
    expect(byId.verified).toBe(false);
  });

  it("dispatches with a host MCP config warble accepts: 0600, owned by this user, exact keys, paths only", async () => {
    const bff = claudeBff();
    const { capture } = await bff.ask({ calls: [], answer: "No data needed." });
    const flag = capture.args.indexOf("--host-mcp-config");
    expect(flag).toBeGreaterThan(-1);
    expect(capture.args[flag + 1]).toBe(capture.configPath);
    expect(capture.configError).toBeUndefined();
    expect(capture.configStat).toEqual({ mode: 0o600, uid: process.getuid!() });
    expect(capture.configKeys).toEqual(["name", "command", "args", "tools", "instruction"]);
    const config = capture.config!;
    expect(config.name).toBe(HOST_MCP_SERVER_NAME);
    expect(config.command).toBe(process.execPath);
    expect(config.tools).toEqual(["run_sql"]);
    expect(config.instruction).toBe(HOST_MCP_INSTRUCTION);
    expect(config.instruction).toContain("mcp__wren_host__run_sql");
    expect(config.args[0]).toBe(PROXY_SOURCE);
    expect(config.args.slice(1, 3)).toEqual(["--credential-file", path.join(path.dirname(capture.configPath!), "credential.json")]);
    expect(config.args.slice(3, 5)).toEqual(["--", expect.stringMatching(/\/wren$/)]);
    expect(config.args.slice(5)).toEqual(["serve", "mcp", "--project", expect.any(String), "--quiet"]);
    // The token lives only in the credential file: neither argv nor the config carries it.
    const service = path.dirname(capture.configPath!);
    expect(path.basename(service)).toMatch(/^genbi-hq-/);
    // The turn's service directory, with the config and credential files, is gone after the turn.
    expect(existsSync(service)).toBe(false);
  });

  it("refuses a host tool the config does not list", async () => {
    const bff = claudeBff();
    const { capture } = await bff.ask({ calls: [{ name: "dry_run", arguments: { sql: ORDERS_SQL } }], answer: "x" });
    expect(capture.results).toEqual([{ denied: "mcp__wren_host__dry_run" }]);
  });

  it("dispatches without a host MCP config when the caller asks for no host queries or binds a models config", async () => {
    const plain = claudeBff((options) => { const { hostQueries: _omit, ...rest } = options; return rest; });
    const none = await plain.ask({ calls: [run(ORDERS_SQL)], answer: queryResult(ORDERS_SQL, 42) });
    expect(none.capture.args).not.toContain("--host-mcp-config");
    expect(envelopeOf(none.answer).verified).toBe(false);
    const hybrid = claudeBff((options) => ({ ...options, modelsConfig: "/fixture/models.yaml" }));
    const staged = await hybrid.ask({ calls: [run(ORDERS_SQL)], answer: queryResult(ORDERS_SQL, 42) });
    expect(staged.capture.args).not.toContain("--host-mcp-config");
    expect(envelopeOf(staged.answer).verified).toBe(false);
  });
});
