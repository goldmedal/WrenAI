// A stand-in `wren` for codex:local host-evidence tests; copied next to a `#!node` line at test time.
//   governed-stdio --project <p>  the governed query transport the host query service drives
//   serve mcp ...                 the plain MCP server the proxy passes every other tool to
const readline = require("node:readline");
const [mode, sub] = process.argv.slice(2);
const write = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);

if (mode === "governed-stdio") {
  // FAKE_WREN_DECLARED: comma-separated declared default rule ids; set, the hello is protocol 3 and a `/*declared*/` query is
  // refused with FAKE_WREN_RULE_IDS (comma-separated; unset sends no `rule_ids`).
  const declared = process.env.FAKE_WREN_DECLARED?.split(",").filter(Boolean) ?? [];
  write(declared.length ? { id: 0, protocol: "wren-governed/3", declared_defaults: declared } : { id: 0, protocol: "wren-governed/2" });
  readline.createInterface({ input: process.stdin }).on("line", (line) => {
    const request = JSON.parse(line);
    const sql = String(request.sql ?? "");
    if (request.operation !== "query") return write({ id: request.id, error: { class: "invalid_request", message: "x" } });
    if (sql.includes("/*declared*/")) {
      const ruleIds = process.env.FAKE_WREN_RULE_IDS?.split(",").filter(Boolean);
      return write({ id: request.id, error: { class: "declared_default_missing", message: "x", ...(ruleIds ? { rule_ids: ruleIds } : {}) } });
    }
    if (sql.includes("/*lax*/")) {
      // A host that failed to refuse a query reading no table: the definition proves no source.
      return write({ id: request.id, result: { columns: ["n"], rows: [{ n: 424 }], definition: { sql, source_tables: [], filters: [] } } });
    }
    if (/\bfrom\s+customers\b/i.test(sql)) {
      // Five customers in all: a limit below that returns exactly `limit` rows.
      const count = Math.min(request.limit, 5);
      return write({ id: request.id, result: {
        columns: ["id"], rows: Array.from({ length: count }, (_, index) => ({ id: index + 1 })),
        definition: { sql, source_tables: ["customers"], filters: [] },
      } });
    }
    if (!/\bfrom\s+orders\b/i.test(sql)) {
      // Like the real transport: a query that reads no model is refused before execution.
      return write({ id: request.id, error: { class: "policy_rejected", message: "x" } });
    }
    const filters = /\bwhere\s+(.+)$/i.exec(sql);
    write({ id: request.id, result: {
      columns: ["order_count"], rows: [{ order_count: 42 }],
      definition: { sql, source_tables: ["orders"], filters: filters ? [filters[1]] : [] },
    } });
  });
} else if (mode === "serve" && sub === "mcp") {
  const tools = ["run_sql", "dry_run", "list_models"].map((name) => ({
    name, description: name, inputSchema: { type: "object", properties: { sql: { type: "string" }, limit: { type: "integer" } } },
  }));
  const structured = {
    // What plain `wren serve mcp` would return: no host id, no recorded evidence.
    run_sql: { columns: ["source"], rows: [{ source: "plain-wren-mcp" }], row_count: 1, truncated: false },
    dry_run: { ok: true },
    list_models: { models: ["orders"] },
  };
  readline.createInterface({ input: process.stdin }).on("line", (line) => {
    const message = JSON.parse(line);
    if (message.id === undefined) return;
    if (message.method === "initialize") {
      return write({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake-wren", version: "0" } } });
    }
    if (message.method === "tools/list") return write({ jsonrpc: "2.0", id: message.id, result: { tools } });
    if (message.method === "tools/call") {
      const value = structured[message.params?.name];
      if (!value) return write({ jsonrpc: "2.0", id: message.id, error: { code: -32602, message: "unknown tool" } });
      return write({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value, isError: false } });
    }
    write({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "method not found" } });
  });
} else {
  process.exit(2);
}
