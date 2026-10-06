import { chmodSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import type { Socket } from "node:net";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CodexHostQueryService } from "../harness/route/codex-host-query.js";
import { HostConnection } from "../harness/route/codex-wren-proxy.js";
import { fakeWrenWorkspace, openTestHostService, startProxy } from "./codex-host-evidence-helpers.js";

const ORDERS_SQL = "SELECT COUNT(*) AS order_count FROM orders";
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function setup(): Promise<{ wren: string; project: string; root: string; service: CodexHostQueryService }> {
  const workspace = fakeWrenWorkspace();
  cleanups.push(workspace.cleanup);
  const service = await openTestHostService(workspace.wren, workspace.project);
  cleanups.push(() => service.close());
  return { ...workspace, service };
}

function proxy(args: readonly string[], wren: string, project: string): ReturnType<typeof startProxy> {
  const started = startProxy(args, wren, project);
  cleanups.push(() => started.stop());
  return started;
}

describe("codex:local Wren MCP proxy", () => {
  it("routes run_sql to this turn's host query service, which records it with a host query_id", async () => {
    const { wren, project, service } = await setup();
    const client = proxy(["--credential-file", service.credentialFile], wren, project);
    await client.call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } });
    const reply = await client.call("tools/call", { name: "run_sql", arguments: { sql: ORDERS_SQL } });
    const structured = reply.result?.structuredContent as Record<string, unknown>;
    expect(reply.result?.isError).toBe(false);
    expect(structured).toMatchObject({ columns: ["order_count"], rows: [{ order_count: 42 }],
      definition: { sql: ORDERS_SQL, source_tables: ["orders"] } });
    expect(structured.query_id).toMatch(/^q1-[0-9a-f]{8}$/);
    const observations = service.observations();
    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({ tool: "run_sql", input: { sql: ORDERS_SQL, limit: 1000 }, output: { query_id: structured.query_id } });
  });

  it("passes every other tool, and the tool list, through to plain wren serve mcp", async () => {
    const { wren, project, service } = await setup();
    const client = proxy(["--credential-file", service.credentialFile], wren, project);
    const init = await client.call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } });
    expect(init.result).toMatchObject({ serverInfo: { name: "fake-wren" } });
    const listed = await client.call("tools/list", {});
    expect((listed.result?.tools as { name: string }[]).map((tool) => tool.name)).toEqual(["run_sql", "dry_run", "list_models"]);
    const dryRun = await client.call("tools/call", { name: "dry_run", arguments: { sql: ORDERS_SQL } });
    expect(dryRun.result).toMatchObject({ structuredContent: { ok: true }, isError: false });
    const models = await client.call("tools/call", { name: "list_models", arguments: {} });
    expect(models.result).toMatchObject({ structuredContent: { models: ["orders"] } });
    expect(service.observations()).toHaveLength(0);
  });

  it("refuses run_sql without a credential file, and never runs it on plain wren serve mcp", async () => {
    const { wren, project, service } = await setup();
    const client = proxy(["--credential-file", path.join(project, "missing.json")], wren, project);
    const reply = await client.call("tools/call", { name: "run_sql", arguments: { sql: ORDERS_SQL } });
    expect(reply.result).toMatchObject({ isError: true, content: [{ type: "text", text: expect.stringContaining("no valid host query credential") }] });
    expect(JSON.stringify(reply)).not.toContain("plain-wren-mcp");
    expect(service.observations()).toHaveLength(0);
  });

  it("reports truncation like plain run_sql: probes one row past the limit and returns only the limit", async () => {
    const { wren, project, service } = await setup();
    const client = proxy(["--credential-file", service.credentialFile], wren, project);
    const sql = "SELECT id FROM customers";
    const cut = (await client.call("tools/call", { name: "run_sql", arguments: { sql, limit: 3 } })).result?.structuredContent as Record<string, unknown>;
    expect(cut).toMatchObject({ rows: [{ id: 1 }, { id: 2 }, { id: 3 }], row_count: 3, truncated: true });
    const whole = (await client.call("tools/call", { name: "run_sql", arguments: { sql, limit: 10 } })).result?.structuredContent as Record<string, unknown>;
    expect(whole).toMatchObject({ row_count: 5, truncated: false });
    expect(service.observations().map((call) => [call.input.limit, (call.output as { rows: unknown[]; truncated: boolean }).rows.length, (call.output as { truncated: boolean }).truncated]))
      .toEqual([[3, 3, true], [10, 5, false]]);
  });

  it("returns clear tool errors for table-less SQL and limit 0, recording neither", async () => {
    const { wren, project, service } = await setup();
    const client = proxy(["--credential-file", service.credentialFile], wren, project);
    const literal = await client.call("tools/call", { name: "run_sql", arguments: { sql: "SELECT 42 AS n" } });
    expect(literal.result).toMatchObject({ isError: true, content: [{ text: expect.stringContaining("[policy_rejected]: The read-only analytical policy rejected the query") }] });
    const zero = await client.call("tools/call", { name: "run_sql", arguments: { sql: ORDERS_SQL, limit: 0 } });
    expect(zero.result).toMatchObject({ isError: true, content: [{ text: expect.stringContaining("optional positive integer limit") }] });
    expect(service.observations()).toHaveLength(0);
  });

  it("refuses a symlinked credential file, even one pointing at the turn's real credential", async () => {
    const { wren, project, root, service } = await setup();
    const link = path.join(root, "linked-credential.json");
    symlinkSync(service.credentialFile, link);
    const client = proxy(["--credential-file", link], wren, project);
    const reply = await client.call("tools/call", { name: "run_sql", arguments: { sql: ORDERS_SQL } });
    expect(reply.result).toMatchObject({ isError: true, content: [{ text: expect.stringContaining("no valid host query credential") }] });
    expect(service.observations()).toHaveLength(0);
  });

  it("refuses a credential file that others can read", async () => {
    const { wren, project, root, service } = await setup();
    const copy = path.join(root, "shared-credential.json");
    writeFileSync(copy, readFileSync(service.credentialFile));
    chmodSync(copy, 0o644);
    const client = proxy(["--credential-file", copy], wren, project);
    const reply = await client.call("tools/call", { name: "run_sql", arguments: { sql: ORDERS_SQL } });
    expect(reply.result).toMatchObject({ isError: true, content: [{ text: expect.stringContaining("no valid host query credential") }] });
    expect(service.observations()).toHaveLength(0);
  });

  it("the host service refuses a proxy whose token is not this turn's", async () => {
    const { wren, project, root, service } = await setup();
    const real = JSON.parse(readFileSync(service.credentialFile, "utf8")) as { socket: string; token: string };
    const forged = path.join(root, "forged-credential.json");
    writeFileSync(forged, JSON.stringify({ socket: real.socket, token: "x".repeat(real.token.length) }), { mode: 0o600 });
    const client = proxy(["--credential-file", forged], wren, project);
    const reply = await client.call("tools/call", { name: "run_sql", arguments: { sql: ORDERS_SQL } });
    expect(reply.result).toMatchObject({ isError: true, content: [{ text: expect.stringContaining("[unauthorized]") }] });
    expect(service.observations()).toHaveLength(0);
  });

  it("keeps the token out of every path and argument: only the 0600 file holds it", async () => {
    const { service } = await setup();
    const credential = JSON.parse(readFileSync(service.credentialFile, "utf8")) as { socket: string; token: string };
    expect(statSync(service.credentialFile).mode & 0o777).toBe(0o600);
    expect(statSync(path.dirname(service.credentialFile)).mode & 0o777).toBe(0o700);
    expect(service.credentialFile).not.toContain(credential.token);
    expect(credential.socket).not.toContain(credential.token);
  });

  it("discards observations and stops serving when the turn closes", async () => {
    const { wren, project, service } = await setup();
    const client = proxy(["--credential-file", service.credentialFile], wren, project);
    await client.call("tools/call", { name: "run_sql", arguments: { sql: ORDERS_SQL } });
    expect(service.observations()).toHaveLength(1);
    await service.close();
    expect(service.observations()).toHaveLength(0);
    const after = await client.call("tools/call", { name: "run_sql", arguments: { sql: ORDERS_SQL } });
    expect(after.result).toMatchObject({ isError: true });
    expect(service.observations()).toHaveLength(0);
  });
});

class FakeSocket extends EventEmitter {
  destroyed = false;
  readonly written: string[] = [];
  setEncoding(): this { return this; }
  write(line: string): boolean { this.written.push(line); return true; }
  end(): this { return this; }
}

describe("codex:local proxy host connection", () => {
  it("a stale socket closing late does not fail a request pending on its replacement", async () => {
    const sockets = [new FakeSocket(), new FakeSocket()];
    let opened = 0;
    const connection = new HostConnection({ socket: "/unused", token: "t".repeat(43) }, () => sockets[opened++] as unknown as Socket);
    const first = connection.request("SELECT 1 FROM orders", undefined);
    sockets[0]!.emit("error", new Error("reset"));
    await expect(first).resolves.toEqual({ error: "transport" });
    sockets[0]!.destroyed = true;
    const second = connection.request("SELECT 2 FROM orders", undefined);
    expect(opened).toBe(2);
    sockets[0]!.emit("close");
    const id = (JSON.parse(sockets[1]!.written[0]!) as { id: number }).id;
    sockets[1]!.emit("data", `${JSON.stringify({ id, result: { columns: ["n"], rows: [] } })}\n`);
    await expect(second).resolves.toEqual({ result: { columns: ["n"], rows: [] } });
  });
});
