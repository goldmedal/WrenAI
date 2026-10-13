import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hashDirectory } from "../harness/compile/fingerprint.js";
import { ComponentExecutionError } from "../harness/components/runner.js";
import { GovernedWrenError, openWrenComponentAccess } from "../harness/components/wren-access.js";
import { createApp } from "../server/app.js";
import { Store } from "../server/db.js";
import type { Bundle, RouteOptions } from "../harness/index.js";
import type { TurnDeps } from "../server/turn.js";
import { parseSse } from "./bff-sse-helpers.js";

/** A governed process that rejects any SQL containing REJECT with a structured policy error and answers the rest. */
const FAKE = `
console.log(JSON.stringify({id:0,protocol:"wren-governed/2"}));
const readline = require('node:readline');
readline.createInterface({input:process.stdin}).on('line',line => {
  const request=JSON.parse(line);
  if (request.sql && request.sql.includes('REJECT')) console.log(JSON.stringify({id:request.id,error:{class:'policy_rejected',message:'unsupported function percentile_cont; api_key=sk-livesecret99999'}}));
  else console.log(JSON.stringify({id:request.id,result:{columns:['n'],rows:[{n:1}]}}));
});`;

let root: string;
let logged: string[];
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "genbi-governed-log-"));
  await writeFile(path.join(root, "fake-wren"), `#!${process.execPath}\n${FAKE}`, { mode: 0o700 });
  logged = [];
  vi.spyOn(console, "error").mockImplementation((line: unknown) => { logged.push(String(line)); });
});
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });
const lines = () => logged.filter((line) => line.startsWith("[component-failure]")).map((line) => JSON.parse(line.slice("[component-failure] ".length)) as Record<string, string>);
const open = async () => openWrenComponentAccess({ executable: path.join(root, "fake-wren"), project: root, fingerprint: await hashDirectory(root), signal: new AbortController().signal });

describe("a rejected governed query is logged with the SQL it submitted", () => {
  it("logs one line per rejected attempt with redacted, whitespace-collapsed, capped SQL and the wire class and message", async () => {
    const signal = new AbortController().signal;
    const access = await open();
    try {
      const longSql = `SELECT\n  REJECT, api_key=sk-sqlsecret12345 ${"x".repeat(3000)}`;
      await expect(access.query({ sql: longSql, limit: 1 }, signal)).rejects.toBeInstanceOf(GovernedWrenError);
      await expect(access.query({ sql: "SELECT percentile_cont(0.5) REJECT FROM orders", limit: 1 }, signal)).rejects.toBeInstanceOf(GovernedWrenError);
    } finally { await access.close(); }
    const found = lines();
    expect(found).toHaveLength(2);
    expect(found[0]).toMatchObject({ site: "governed_query", code: "policy_rejected" });
    expect(found[0]?.sql).toMatch(/^SELECT REJECT, api_key=\[redacted\] x+\.\.\.$/);
    expect(found[0]!.sql!.length).toBeLessThanOrEqual(2003);
    expect(found[1]!.sql).toBe("SELECT percentile_cont(0.5) REJECT FROM orders");
    expect(found[1]!.wire).toContain("unsupported function percentile_cont");
    expect(JSON.stringify(found)).not.toMatch(/sk-sqlsecret|sk-livesecret/);
  });

  it("a successful query logs nothing", async () => {
    const access = await open();
    try { await access.query({ sql: "SELECT 1", limit: 1 }, new AbortController().signal); } finally { await access.close(); }
    expect(logged).toEqual([]);
  });

  it("the SQL stays out of the SSE error frame the turn emits", async () => {
    const secretSql = "SELECT REJECT_ME_MARKER_QUERY FROM orders REJECT";
    const route = async (_options: RouteOptions) => {
      const access = await open();
      try { await access.query({ sql: secretSql, limit: 1 }, new AbortController().signal); } catch { throw new ComponentExecutionError("callee_failed"); } finally { await access.close(); }
      throw new Error("unreachable");
    };
    const bundle: Bundle = { vercel_bundle_version: "0.1", compat: { min_ir_version: "0.4", max_ir_version: "0.4" }, profile: "genbi-default", target: "vercel:headless", agents: [] };
    const app = createApp({ store: new Store(":memory:"), route, baseRouteOptions: { authChoice: { mode: "api-key", adapter: "mock" }, profileSource: "/f", userProject: "/f" }, describeBundle: async () => bundle } as TurnDeps);
    const session = (await (await app.request("/api/sessions", { method: "POST", body: "{}" })).json()) as { id: string };
    const { turnId } = (await (await app.request(`/api/sessions/${session.id}/turns`, { method: "POST", body: JSON.stringify({ question: "q" }) })).json()) as { turnId: string };
    const text = await (await app.request(`/api/sessions/${session.id}/stream?turn=${turnId}`)).text();
    expect(parseSse(text).at(-1)).toMatchObject({ event: "error", data: { code: "callee_failed" } });
    expect(text).not.toContain("REJECT_ME_MARKER_QUERY");
    expect(lines().some((line) => line["sql"]?.includes("REJECT_ME_MARKER_QUERY"))).toBe(true);
  });
});
