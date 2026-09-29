/** Serialized into the installed-package child; every product import uses the installed root. */
export async function installedDirectToolsFixture(packageRoot) {
  const { default: assert } = await import("node:assert/strict");
  const { readFile } = await import("node:fs/promises");
  const { pathToFileURL } = await import("node:url");
  const moduleAt = (relative) => pathToFileURL(packageRoot + "/" + relative).href;
  const { prepareCodexDirectTools } = await import(moduleAt("dist-server/server/runtime-host/codex-direct-tools.js"));
  const { CodexSession } = await import(moduleAt("dist-server/server/runtime-host/codex-session.js"));
  const { resolveWarbleBinary } = await import(moduleAt("dist-server/harness/compile/resolve-binary.js"));
  const irDocument = await readFile(packageRoot + "/profiles/genbi-default/ir.golden.json", "utf8");
  const ir = JSON.parse(irDocument);
  const producerBinary = await resolveWarbleBinary();
  const identity = { session_id: "packed-fixture", vendor: "codex", auth_identity: "fixture", runtime_generation: "fixture",
    binding: { project_identity: "synthetic", generation: "1", revision: "1" } };
  let queries = 0;
  const tools = await prepareCodexDirectTools({ irDocument, scope: { binding: identity.binding, entry: { kind: "agent", verb: "answer_query", prompt: "count" } },
    accountEmail: "fixture@example.invalid", producerBinary, expiresAt: Date.now() + 30_000, signal: new AbortController().signal,
    bindings: { identity, currentIdentity: () => identity, assertCurrent() {}, verifierBinary: producerBinary,
      contexts: Object.fromEntries(ir.components.map((node) => [node.id, { binding: node.context_binding, snapshot: { context_version: 2, parseable: true } }])),
      async prepare() { return { async query() { queries++; return { columns: ["n"], rows: [[99]] }; }, async inspect() { return {}; }, async close() {} }; },
      async step(run) { if (run.tools.query_read_only) await run.tools.query_read_only({ sql: "SELECT count(*) FROM orders" }); return { value: "synthetic" }; },
      async normalize() { return { status: "ok", output: { kind: "value", value: 99 } }; },
    } });
  let handlers;
  const send = (value) => handlers.data(Buffer.from(JSON.stringify(value) + "\n"));
  const item = { type: "dynamicToolCall", id: "call", tool: tools.definitions[0].name, status: "inProgress" };
  const completed = { ...item, status: "completed", success: true };
  const transport = { listen(value) { handlers = value; }, async close() {}, write(line) {
    const m = JSON.parse(line);
    if (m.id === "tool-request") {
      assert.equal(m.result.success, true);
      send({ method: "item/completed", params: { threadId: "thread", turnId: "turn", item: completed } });
      send({ method: "turn/completed", params: { threadId: "thread", turn: { id: "turn", status: "completed", items: [completed] } } }); return;
    }
    if (!m.id) return;
    let result;
    if (m.method === "initialize") result = { codexHome: "/login", platformFamily: "unix", platformOs: "macos", userAgent: "codex_cli_rs/0.156.1 fixture" };
    else if (m.method === "config/read") result = { config: {} };
    else if (m.method === "permissionProfile/list") result = { data: [{ id: "genbi-scoped", allowed: true }], nextCursor: null };
    else if (m.method === "account/read") result = { requiresOpenaiAuth: true, account: { type: "chatgpt", email: "fixture@example.invalid" } };
    else if (m.method === "thread/start") {
      assert.deepEqual(m.params.dynamicTools, tools.definitions); assert.deepEqual(m.params.runtimeWorkspaceRoots, []);
      result = { thread: { id: "thread", cwd: "/scope", cliVersion: "0.156.1", ephemeral: true } };
    } else if (m.method === "turn/start") {
      const turn = { id: "turn", status: "inProgress", items: [] };
      send({ method: "turn/started", params: { threadId: "thread", turn } });
      send({ method: "item/started", params: { threadId: "thread", turnId: "turn", item } });
      send({ id: "tool-request", method: "item/tool/call", params: { threadId: "thread", turnId: "turn", callId: "call", tool: item.tool, arguments: { request: "count orders" } } });
      result = { turn };
    } else throw Error("Unexpected RPC");
    send({ id: m.id, result });
  } };
  const session = await CodexSession.connect(transport, { cwd: "/scope", codexHome: "/login", profile: "genbi-scoped", args: [], environment: {}, commandEnvironment: {}, configuration: {} }, () => {}, () => {}, undefined, tools);
  try {
    await session.startThread(); assert.equal((await session.runTurn("question")).status, "completed"); assert.ok(queries > 0);
    assert.throws(() => session.startCommand({ command: ["/bin/sh"] }));
  } finally { await session.close(); }
  await assert.rejects(tools.call(item.tool, { request: "late" }, "late", new AbortController().signal));
}
