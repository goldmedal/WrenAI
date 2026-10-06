import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, mkdtemp: vi.fn(actual.mkdtemp) };
});

import { mkdtemp } from "node:fs/promises";
import type { ComponentAccess } from "../harness/components/broker.js";
import { resolveArtifactsDir, type RouteOptions, type RouteResult } from "../harness/index.js";
import { createApp } from "../server/app.js";
import { Store } from "../server/db.js";
import { NATIVE_MCP_PERSIST_ANSWER_TOOL_NAME, NATIVE_MCP_QUERY_TOOL_NAME, NATIVE_MCP_TOOL_NAME, NativeArtifactService } from "../server/native-artifacts.js";
import type { TurnDeps } from "../server/turn.js";

const NATIVE_MCP_URL = "http://127.0.0.1:4787/api/native-sessions/mcp";
const ORDERS_SQL = "SELECT COUNT(*) AS order_count FROM orders";
const OTHER_SQL = "SELECT COUNT(*) AS order_count FROM orders WHERE status = 'placed'";

const dirs: string[] = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

/** A governed-access stand-in shaped like `wren governed-stdio` results, with a close spy. */
function fakeAccess(): ComponentAccess & { close: ReturnType<typeof vi.fn> } {
  return {
    async query(request: { sql: string; limit: number }) {
      const { sql, limit } = request;
      if (/\bfrom\s+customers\b/i.test(sql)) {
        const count = Math.min(limit, 5);
        return { columns: ["id"], rows: Array.from({ length: count }, (_, index) => ({ id: index + 1 })), definition: { sql, source_tables: ["customers"], filters: [] } };
      }
      if (!/\bfrom\s+orders\b/i.test(sql)) return { columns: ["n"], rows: [{ n: 424 }], definition: { sql, source_tables: [], filters: [] } };
      return { columns: ["order_count"], rows: [{ order_count: 42 }], definition: { sql, source_tables: ["orders"], filters: [] } };
    },
    async inspect() { throw new Error("not used"); },
    close: vi.fn(async () => {}),
  } as unknown as ComponentAccess & { close: ReturnType<typeof vi.fn> };
}

function createFixture(options: { query?: boolean } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "genbi-native-query-"));
  dirs.push(root);
  const outDir = path.join(root, "out");
  const binding = { identity: "project-identity", generation: 4, revision: "sha256:revision", path: root };
  const store = new Store(":memory:");
  const opened: { session: string; access: ReturnType<typeof fakeAccess> }[] = [];
  const service = new NativeArtifactService({
    store, artifactsRoot: resolveArtifactsDir(outDir), expectedMcpUrl: NATIVE_MCP_URL, mcpUrl: NATIVE_MCP_URL, getBinding: () => binding,
    ...(options.query === false ? {} : { openQueryAccess: async (bound: typeof binding) => {
      expect(bound).toEqual(binding);
      const access = fakeAccess();
      opened.push({ session: "", access });
      return access;
    } }),
  });
  const session = (id: string) => {
    store.createNativeSession({ id, purpose: "analysis", vendor: "claude", agent: "answer_query", scopeKind: "bound_project", scopeId: `scope-${id}`,
      projectIdentity: binding.identity, bindingGeneration: binding.generation, projectRevision: binding.revision });
    store.transitionNativeSession(id, "running", { started: true });
    return service.issue(store.getNativeSession(id)!, binding).credential;
  };
  const app = createApp({
    store,
    route: async (_options: RouteOptions): Promise<RouteResult> => ({ backend: "agent", warnings: [], kind: "answer", envelope: { blocks: [] }, trace: { steps: [] } }),
    baseRouteOptions: { authChoice: { mode: "api-key", adapter: "mock" }, profileSource: "/fixture/profile", userProject: "/fixture/project", outDir },
    nativeArtifacts: service,
  } satisfies TurnDeps);
  const mcp = async (credential: string, method: string, params?: Record<string, unknown>) => {
    const response = await app.request("/api/native-sessions/mcp", { method: "POST",
      headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...(params ? { params } : {}) }) });
    return { status: response.status, body: await response.json() as { result?: { isError?: boolean; structuredContent?: Record<string, unknown>; tools?: { name: string }[] }; error?: unknown } };
  };
  const call = (credential: string, name: string, args: unknown) => mcp(credential, "tools/call", { name, arguments: args });
  const query = async (credential: string, sql: string, limit?: number) => {
    const { body } = await call(credential, NATIVE_MCP_QUERY_TOOL_NAME, { sql, ...(limit !== undefined ? { limit } : {}) });
    return body.result!;
  };
  let key = 0;
  const persist = async (credential: string, envelope: unknown) => {
    const { body } = await call(credential, NATIVE_MCP_PERSIST_ANSWER_TOOL_NAME, { version: "1", idempotency_key: `persist-key-${++key}`, envelope });
    const ref = body.result?.structuredContent?.answer_ref as string | undefined;
    if (!ref) throw new Error(`persist failed: ${JSON.stringify(body)}`);
    const row = store.getNativeStructuredAnswer(ref)!;
    return { ref, grounded: row.grounded, envelope: JSON.parse(row.envelopeJson) as { blocks: unknown[]; verified: boolean } };
  };
  const save = async (credential: string, source: Record<string, unknown>) => {
    const { body } = await call(credential, NATIVE_MCP_TOOL_NAME, { version: "1", name: "Orders", idempotency_key: `save-key-${++key}`, ...source });
    const id = body.result?.structuredContent?.artifact_id as string | undefined;
    if (!id) throw new Error(`save failed: ${JSON.stringify(body)}`);
    return store.listArtifacts().find((artifact) => artifact.id === id)!;
  };
  return { store, service, opened, session, mcp, query, persist, save };
}

const answer = (definition: Record<string, unknown> | undefined, value = 41) => ({
  verified: true,
  blocks: [
    { type: "table", columns: ["order_count"], rows: [[value]] },
    ...(definition ? [{ type: "definition", source_tables: ["orders"], filters: [], ...definition }] : []),
  ],
});

describe("native session query tool", () => {
  it("is offered to analysis sessions only when the host can open governed access", async () => {
    const withQuery = createFixture();
    const listed = await withQuery.mcp(withQuery.session("native-a"), "tools/list");
    expect(listed.body.result!.tools!.map((tool) => tool.name)).toEqual([NATIVE_MCP_QUERY_TOOL_NAME, NATIVE_MCP_PERSIST_ANSWER_TOOL_NAME, NATIVE_MCP_TOOL_NAME]);
    const without = createFixture({ query: false });
    const credential = without.session("native-b");
    expect((await without.mcp(credential, "tools/list")).body.result!.tools!.map((tool) => tool.name)).toEqual([NATIVE_MCP_PERSIST_ANSWER_TOOL_NAME, NATIVE_MCP_TOOL_NAME]);
    expect((await without.mcp(credential, "tools/call", { name: NATIVE_MCP_QUERY_TOOL_NAME, arguments: { sql: ORDERS_SQL } })).body.result).toBeUndefined();
  });

  it("returns rows plus a session-tagged query_id, and refuses a malformed request", async () => {
    const f = createFixture();
    const credential = f.session("native-a");
    const first = await f.query(credential, ORDERS_SQL);
    expect(first.isError).toBe(false);
    expect(first.structuredContent).toMatchObject({ columns: ["order_count"], rows: [{ order_count: 42 }], row_count: 1, truncated: false, query_id: expect.stringMatching(/^q1-[0-9a-f]{8}$/) });
    const second = await f.query(credential, OTHER_SQL);
    const tag = (id: unknown) => String(id).split("-")[1];
    expect(second.structuredContent!.query_id).toMatch(/^q2-/);
    expect(tag(second.structuredContent!.query_id)).toBe(tag(first.structuredContent!.query_id));
    const other = await f.query(f.session("native-b"), ORDERS_SQL);
    expect(tag(other.structuredContent!.query_id)).not.toBe(tag(first.structuredContent!.query_id));
    const bad = (await f.mcp(credential, "tools/call", { name: NATIVE_MCP_QUERY_TOOL_NAME, arguments: { sql: ORDERS_SQL, extra: 1 } })).body.result!;
    expect(bad.isError).toBe(true);
    expect(bad.structuredContent).toBeUndefined();
  });

  it("verifies a persisted answer citing this session's query, with the table rebuilt from the observation", async () => {
    const f = createFixture();
    const credential = f.session("native-a");
    const queryId = (await f.query(credential, ORDERS_SQL)).structuredContent!.query_id as string;
    const byId = await f.persist(credential, answer({ sql: ORDERS_SQL, query_id: queryId }));
    expect(byId.grounded).toBe(true);
    expect(byId.envelope).toEqual({ verified: true, blocks: [
      { type: "table", columns: ["order_count"], rows: [{ order_count: 42 }] },
      { type: "definition", sql: ORDERS_SQL, source_tables: ["orders"], filters: [], query_id: queryId },
    ] });
    const bySql = await f.persist(credential, answer({ sql: `  ${ORDERS_SQL};` }));
    expect(bySql.grounded).toBe(true);
    // A save by reference inherits the grounded provenance; an envelope save citing the query grounds too.
    expect((await f.save(credential, { answer_ref: byId.ref })).verified).toBe(true);
    expect((await f.save(credential, { envelope: answer({ sql: ORDERS_SQL, query_id: queryId }) })).verified).toBe(true);
  });

  it("leaves unverified an answer citing another session's query, a table-less query, a query never run, or nothing", async () => {
    const f = createFixture();
    const a = f.session("native-a");
    const b = f.session("native-b");
    const otherId = (await f.query(b, ORDERS_SQL)).structuredContent!.query_id as string;
    await f.query(a, OTHER_SQL);
    // Another session's query, by id and by SQL: session A never ran ORDERS_SQL.
    expect((await f.persist(a, answer({ sql: ORDERS_SQL, query_id: otherId }))).grounded).toBe(false);
    expect((await f.persist(a, answer({ sql: ORDERS_SQL }))).grounded).toBe(false);
    // A query that read no table, cited by its own id.
    const tableless = (await f.query(a, "SELECT 424 AS n")).structuredContent!.query_id as string;
    const lax = await f.persist(a, { verified: true, blocks: [{ type: "table", columns: ["n"], rows: [[424]] }, { type: "definition", sql: "SELECT 424 AS n", source_tables: ["orders"], filters: [], query_id: tableless }] });
    expect(lax.grounded).toBe(false);
    expect(lax.envelope.verified).toBe(false);
    // A model-typed envelope with no citation, after a host-run query.
    const typed = await f.persist(a, answer(undefined, 42));
    expect(typed.grounded).toBe(false);
    expect(typed.envelope).toEqual({ ...answer(undefined, 42), verified: false });
    // A save whose envelope also carries a chart stays unverified.
    expect((await f.save(a, { envelope: { verified: true, blocks: [...answer({ sql: OTHER_SQL }).blocks, { type: "chart", chart_type: "bar", x: "k", series: ["v"], rows: [["a", 1]] }] } })).verified).toBe(false);
  });

  it("persists a cited truncated result unverified: the persist contract has no field for the host's truncation note", async () => {
    const f = createFixture();
    const credential = f.session("native-a");
    const sql = "SELECT id FROM customers";
    const queryId = (await f.query(credential, sql, 2)).structuredContent!.query_id as string;
    const persisted = await f.persist(credential, { verified: true, blocks: [{ type: "table", columns: ["id"], rows: [[1], [2]] }, { type: "definition", sql, source_tables: ["customers"], filters: [], query_id: queryId }] });
    expect(persisted.grounded).toBe(false);
  });

  it("closes each session's governed access when its credential is revoked or the service disposed, and opens no host query directory", async () => {
    vi.mocked(mkdtemp).mockClear();
    const f = createFixture();
    const a = f.session("native-a");
    const b = f.session("native-b");
    await f.query(a, ORDERS_SQL);
    await f.query(b, ORDERS_SQL);
    expect(f.opened).toHaveLength(2);
    f.service.revoke(a);
    await f.service.queriesClosed();
    expect(f.opened[0]!.access.close).toHaveBeenCalledOnce();
    expect(f.opened[1]!.access.close).not.toHaveBeenCalled();
    f.service.dispose();
    await f.service.queriesClosed();
    expect(f.opened[1]!.access.close).toHaveBeenCalledOnce();
    expect((await f.mcp(b, "tools/call", { name: NATIVE_MCP_QUERY_TOOL_NAME, arguments: { sql: ORDERS_SQL } })).status).toBe(401);
    expect(vi.mocked(mkdtemp).mock.calls.filter(([prefix]) => String(prefix).includes("genbi-hq-"))).toEqual([]);
  });
});
