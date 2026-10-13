import {createStructuredTimingRecorder,createStructuredTimingObserver,readStructuredTimingReceipt} from "../server/structured-timing.js";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveWarbleBinary } from "../harness/compile/resolve-binary.js";
import { hashDirectory } from "../harness/compile/fingerprint.js";
import { openWrenComponentAccess } from "../harness/components/wren-access.js";
import * as wrenAccess from "../harness/components/wren-access.js";
import * as contextVerification from "../harness/components/context.js";
import * as componentRuntime from "../server/native-component-runtime.js";
import { Store } from "../server/db.js";
import { ClaudeAccountVault } from "../server/runtime-host/claude-account-vault.js";
import type { OpenShellDriver, OpenShellDuplex, OpenShellResource } from "../server/runtime-host/openshell-types.js";
import { createOpenShellRuntimeCompositionForTesting } from "../server/openshell-runtime-composition.js";
import { createOpenShellStructuredProvisioner, resolveStructuredClaudeModels } from "../server/openshell-structured-provisioner.js";
import { createOpenShellStructuredAdapter } from "../server/openshell-structured-ask.js";
import { StructuredRuntime } from "../server/structured-runtime.js";
import { resolveNativeExecutable } from "../server/native-runtime-spec.js";
import { streamTurn, type TurnDeps } from "../server/turn.js";
import { createApp } from "../server/app.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); });
const digest = "sha256:" + "a".repeat(64);
const sql = "SELECT COUNT(*) AS n FROM orders";
const expected = { accountUuid: "11111111-1111-4111-8111-111111111111", organizationUuid: "22222222-2222-4222-8222-222222222222", email: "synthetic@example.test", subscription: "pro" as const };
const frame = (request_id: string, message: unknown) => ({ type: "control_request", request_id, request: { subtype: "mcp_message", server_name: "component", message } });

/** Synthetic peer speaks the actual direct SDK wire; no SDK query or broker handler is mocked. */
function peer(model: string, receipt: { calls: number; replies: number; streams: number; initializations: number; prompts: number; lists: number; listErrors: number }, expectedToolCount: () => number, change?: () => void): OpenShellDuplex {
  receipt.streams++;
  let wake: (() => void) | undefined, closed = false, boot = false, prompted = false, listed = false, started = false, pending = "";
  let tools: { name: string; inputSchema: Record<string, unknown> }[] = [];
  let resolveDone!: (code: number) => void;
  const chunks: Buffer[] = [];
  const emit = (value: unknown) => { chunks.push(Buffer.from(JSON.stringify(value) + "\n")); wake?.(); wake = undefined; };
  const finish = () => emit({ type: "result", subtype: "success", uuid: "result", session_id: "synthetic-worker", is_error: false,
    result: JSON.stringify({ columns: ["n"], rows: [{ n: 999999 }], verified: true, definition: { sql } }), permission_denials: [],
    modelUsage: { [model]: { webSearchRequests: 0, inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } }, usage: { input_tokens: 1, output_tokens: 1 } });
  const begin = () => {
    if (!prompted || !listed || started) return; started = true;
    emit({ type: "system", subtype: "init", uuid: "init", session_id: "synthetic-worker", claude_code_version: "2.1.259", cwd: "/sandbox", model, apiKeySource: "none",
      tools: tools.map(tool => "mcp__component__" + tool.name), mcp_servers: [{ name: "component", status: "connected" }], skills: [], plugins: [], slash_commands: [], permissionMode: "default" });
    const query = tools.find(tool => Object.hasOwn((tool.inputSchema.properties ?? {}) as object, "sql"));
    if (!query) { finish(); return; }
    const args = { sql };
    emit({ type: "assistant", session_id: "synthetic-worker", uuid: "assistant", parent_tool_use_id: null, message: { content: [{ type: "tool_use", id: "synthetic-call", name: "mcp__component__" + query.name, input: args }] } });
    change?.(); receipt.calls++;
    emit(frame("mcp-call", { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: query.name, arguments: args, _meta: { progressToken: 2, "claudecode/toolUseId": "synthetic-call" } } }));
  };
  return {
    done: new Promise(resolve => { resolveDone = resolve; }),
    output: (async function* () { while (!closed || chunks.length) { if (!chunks.length) { await new Promise<void>(resolve => { wake = resolve; }); continue; } yield { stream: "stdout" as const, data: chunks.shift()! }; } })(),
    close() { closed = true; resolveDone(0); wake?.(); wake = undefined; },
    write(data) {
      if (!boot) { boot = true; expect(data.readUInt32BE(0)).toBe(data.length - 4); return; }
      pending += data.toString("utf8");
      for (let index; (index = pending.indexOf("\n")) >= 0;) {
        const value = JSON.parse(pending.slice(0, index)); pending = pending.slice(index + 1);
        if (value.type === "control_request" && value.request.subtype === "initialize") {
          receipt.initializations++;
          emit({ type: "control_response", response: { subtype: "success", request_id: value.request_id, response: { account: { tokenSource: "CLAUDE_CODE_OAUTH_TOKEN", apiProvider: "firstParty" }, commands: [], agents: [], models: [], output_style: "default", available_output_styles: ["default"] } } });
          emit(frame("mcp-init", { jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "claude-code", version: "2.1.259" } } }));
        } else if (value.type === "control_request" && value.request.subtype === "interrupt") {
          emit({ type: "control_response", response: { subtype: "success", request_id: value.request_id, response: {} } });
        } else if (value.type === "user") { receipt.prompts++; prompted = true; begin(); }
        else if (value.type === "control_response") {
          if (value.response.request_id === "mcp-init") { emit(frame("notify", { jsonrpc: "2.0", method: "notifications/initialized" })); emit(frame("mcp-list", { jsonrpc: "2.0", id: 1, method: "tools/list" })); }
          if (value.response.request_id === "mcp-list") {
            receipt.lists++;
            const reply = value.response.response?.mcp_response;
            // The pinned SDK registers tools/list only when at least one tool is registered.
            if (expectedToolCount() === 0 && reply?.error?.code === -32601) tools = [];
            else if (Array.isArray(reply?.result?.tools)) tools = reply.result.tools;
            else { receipt.listErrors++; throw Error("Synthetic tools list failed"); }
            listed = true; begin();
          }
          if (value.response.request_id === "mcp-call") {
            receipt.replies++; emit({ type: "rate_limit_event", session_id: "synthetic-worker", uuid: "rate", rate_limit_info: { status: "allowed", utilization: 1.25 } }); finish();
          }
        }
      }
    },
  };
}

async function fixture(change?: (store: Store) => void) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "openshell-structured-roundtrip-")));
  cleanup.push(async () => { rmSync(root, { recursive: true, force: true }); });
  const project = path.join(root, "project"), home = path.join(root, "wren-home"), database = path.join(root, "data");
  for (const dir of [project, home, database, path.join(project, "models/orders")]) mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(project, "wren_project.yml"), "schema_version: 5\nname: synthetic\ncatalog: wren\nschema: public\ndata_source: duckdb\nprofile: synthetic\n");
  writeFileSync(path.join(project, "models/orders/metadata.yml"), "name: orders\nref_sql: SELECT * FROM synthetic.raw_orders\ncolumns:\n  - name: id\n    type: INTEGER\n");
  writeFileSync(path.join(home, "profiles.yml"), `profiles:\n  synthetic:\n    datasource: duckdb\n    url: ${JSON.stringify(database)}\n    format: duckdb\n`, { mode: 0o600 });
  const resolvedWren = resolveNativeExecutable("wren", "wren", process.env.PATH)!.executable;
  const python = process.env.GENBI_GOVERNED_WREN_PYTHON ?? readFileSync(resolvedWren, "utf8").split("\n")[0]!.slice(2);
  execFileSync(python, ["-c", "import duckdb,sys; c=duckdb.connect(sys.argv[1]); c.execute('CREATE TABLE raw_orders(id INTEGER)'); c.execute('INSERT INTO raw_orders VALUES (1),(2),(3),(4),(5),(6),(7)'); c.close()", path.join(database, "synthetic.duckdb")], { env: { PATH: "/usr/bin:/bin", HOME: root }, stdio: "pipe" });
  // Resolve this checkout's policy code explicitly; never switch a shared editable install.
  const application = path.resolve(process.cwd());
  const source = path.resolve(application, "../../core/wren/src");
  const wren = path.join(root, "wren");
  writeFileSync(wren, `#!${python}\nimport sys\nsys.path.insert(0,${JSON.stringify(source)})\nfrom wren.cli import app\napp()\n`, { mode: 0o700 });
  const oracle = execFileSync(wren, ["governed-stdio", "--project", project], { env: { PATH: "/usr/bin:/bin", HOME: root, WREN_HOME: home, PYTHONNOUSERSITE: "1", PYTHONDONTWRITEBYTECODE: "1" },
    input: JSON.stringify({ id: 1, operation: "query", sql, limit: 1000 }) + "\n", timeout: 10_000, stdio: ["pipe", "pipe", "pipe"] }).toString("utf8").trim().split("\n").map(line => JSON.parse(line));
  expect(oracle).toEqual([{ id: 0, protocol: "wren-governed/2" }, { id: 1, result: { columns: ["n"], rows: [{ n: 7 }], definition: { sql, source_tables: ["orders"], filters: [] } } }]);
  const oracleAccess = await openWrenComponentAccess({ executable: wren, project, fingerprint: await hashDirectory(project), signal: new AbortController().signal,
    environment: { PATH: [root, path.dirname(process.execPath), "/usr/bin", "/bin"].join(path.delimiter), HOME: root, WREN_HOME: home, WREN_PROJECT_HOME: project, PYTHONNOUSERSITE: "1", PYTHONUTF8: "1", PYTHONDONTWRITEBYTECODE: "1" } });
  try { expect(await oracleAccess.query({ sql, limit: 1000 }, new AbortController().signal)).toMatchObject({ rows: [{ n: 7 }] }); } finally { await oracleAccess.close(); }
  const config = path.join(root, "configuration.json");
  writeFileSync(config, JSON.stringify({ executable: wren, executableDigest: digest, version: "0.0.1", gateway: "synthetic", workspace: "default", image: digest, supervisorImage: digest,
    policy: config, policyDigest: digest, home: root, configHome: root, stateHome: root, dockerExecutable: wren, dockerRealpath: wren, dockerDigest: digest, dockerSocket: path.join(root, "none.sock"), dockerNamespace: "synthetic", exclusive: true,
    model: { image: digest, policy: config, policyDigest: digest } }));
  const store = new Store(":memory:");
  store.setRuntimeSettings({ authMode: "subscription", subscriptionProvider: "claude", subscriptionDriverModel: "synthetic-model", tierModels: [{ tier: "cheap", model: "haiku" }, { tier: "strong", model: "sonnet" }], hybrid: false, deployment: "personal", apiKeyAdapter: "anthropic" });
  store.activateEnrichmentBinding({ path: project, identity: "synthetic-project", revision: digest });
  const vault = ClaudeAccountVault.forTesting({ root: path.join(root, "vault"), transport: async url => new Response(JSON.stringify(url.endsWith("/token")
    ? { access_token: "synthetic-access-123456", refresh_token: "synthetic-refresh-123456", expires_in: 3600, scope: "user:profile user:inference", token_type: "Bearer" }
    : { account: { uuid: expected.accountUuid, email: expected.email }, organization: { uuid: expected.organizationUuid, organization_type: "claude_pro" } })) });
  vault.enroll({ accessToken: "synthetic-imported-access", refreshToken: "synthetic-imported-refresh", expiresAt: Date.now() + 3600000 }); await vault.verify(expected);
  const retained = () => createHash("sha256").update(readFileSync(path.join(root, "vault/account.json"))).digest("hex"); const before = retained();
  const resources = new Map<string, OpenShellResource>(), streams: OpenShellDuplex[] = [], receipt = { calls: 0, replies: 0, streams: 0, initializations: 0, prompts: 0, lists: 0, listErrors: 0 };
  let expectedTools = 0;
  const identity = { image: digest, policy: digest, gateway: "synthetic", workspace: "default", configuration: digest };
  const driver: OpenShellDriver = { version: "synthetic", identity, modelIdentity: identity, probe: async () => {}, create: async intent => { const resource = { id: intent.id, name: intent.name, workspace: "default", labels: { "genbi-lifecycle-owner": intent.owner } }; resources.set(intent.name, resource); return resource; }, list: async intent => [...resources.values()].filter(resource => resource.name === intent.name), inspect: async intent => resources.get(intent.name)!, remove: async intent => { resources.delete(intent.name); }, assertAbsent: async intent => { expect(resources.has(intent.name)).toBe(false); }, exec: async () => { throw Error("no live runtime"); }, duplex: async intent => { if (intent.identity.purpose !== "model") throw Error("not a model step"); const stream = peer(intent.identity.model, receipt, () => expectedTools, change ? () => change(store) : undefined); streams.push(stream); return stream; } };
  const composition = await createOpenShellRuntimeCompositionForTesting({ env: { GENBI_CLAUDE_RUNTIME: "openshell", GENBI_OPENSHELL_CONFIG: config }, store, stateRoot: path.join(root, "lifecycle"), driver, claude: { vault, duplex: driver.duplex! } });
  cleanup.push(async () => { for (const stream of streams) stream.close(); await composition.shutdown(); store.close(); });
  const producer = await resolveWarbleBinary();
  const profileSource = path.join(application, "profiles/genbi-default");
  const timing=createStructuredTimingRecorder({role:"utility"});timing.beginSession(1);const diagnostics=createStructuredTimingObserver(timing);
  const provisioner = createOpenShellStructuredProvisioner({ composition, store, diagnostics, producerBinary: producer, wrenBinary: wren, profileSource, hostHome: root, sourceWrenHome: () => home, getBinding: () => store.getEnrichmentBinding(), modelsFor: settings => resolveStructuredClaudeModels(settings, () => "synthetic-model"), assertConfigurationCurrent() {} });
  const phases: string[] = [];
  const realBindings = componentRuntime.createNativeComponentRuntimeBindings;
  vi.spyOn(componentRuntime, "createNativeComponentRuntimeBindings").mockImplementation(options => { const bindings = realBindings(options); const step = bindings.step; return { ...bindings, async step(...args) { expectedTools = Object.keys(args[0].tools).length; phases.push("step-start"); try { const value = await step(...args); phases.push("step-pass"); return value; } catch (error) { phases.push("step-error:" + String(error)); throw error; } } }; });
  const realAccess = wrenAccess.openWrenComponentAccess, realContext = contextVerification.verifyComponentContext;
  vi.spyOn(wrenAccess, "openWrenComponentAccess").mockImplementation(async options => { phases.push("wren-start"); try { const value = await realAccess(options); phases.push("wren-ready"); return value; } catch (error) { phases.push("wren-error:" + String(error)); throw error; } });
  vi.spyOn(contextVerification, "verifyComponentContext").mockImplementation(async (...args) => { phases.push("context-start"); try { await realContext(...args); phases.push("context-pass"); } catch (error) { phases.push("context-error:" + String(error)); throw error; } });
  const prepare = provisioner.prepare.bind(provisioner);
  provisioner.prepare = async input => {
    try { const value = await prepare(input); phases.push("prepared"); const run = value.run.bind(value); return { ...value, async run(request) { try { const result = await run(request); phases.push("result:" + result.status); return result; } catch (error) { phases.push("run:" + String(error)); throw error; } } }; }
    catch (error) { phases.push("prepare:" + String(error)); throw error; }
  };
  const local = vi.fn(async () => { throw Error("local fallback forbidden"); });
  const runtime = new StructuredRuntime({ diagnostics, selected: { claude: "openshell", codex: "local" }, allowLocal: false, localRoute: local, localSetupFor: () => undefined, adapters: { claude: createOpenShellStructuredAdapter(provisioner,diagnostics) }, onRevoke: composition.revokeRuntime });
  const deps = { store, structuredRuntime: runtime, route: local, baseRouteOptions: { authChoice: { mode: "subscription", provider: "claude" }, profileSource, userProject: project, question: "count orders" } } as TurnDeps;
  const session = store.createSession("analysis"), turn = store.createTurn({ id: "synthetic-turn", sessionId: session.id, question: "count orders", composedInput: null });
  return { root, store, timing, composition, runtime, local, deps, session, turn, receipt, resources, before, retained, phases };
}

it("HTTP-selected Ask runs pinned plan → branded SDK peer → real host Wren/DuckDB → one verified durable answer", async () => {
  const f = await fixture(); const app = createApp(f.deps);
  expect(await (await app.request("/api/structured-runtime/readiness")).json()).toMatchObject({ active: { backend: "openshell", ask: true, queryExecution: "host" } });
  const frames: unknown[] = []; await streamTurn(f.deps, f.session.id, f.turn.id, async frame => { frames.push(frame); });
  const stored = f.store.getTurn(f.turn.id);
  expect(stored, JSON.stringify({ frames, phases: f.phases, receipt: f.receipt })).toMatchObject({ backend: "openshell", resultKind: "answer" });
  expect(JSON.parse(stored!.answerSummary!)).toEqual([{ type: "table", columns: ["n"], rows: [{ n: 7 }] }, { type: "definition", sql, source_tables: ["orders"], filters: [] }]);
  expect(JSON.stringify(stored)).not.toContain("999999"); expect(f.receipt.calls).toBeGreaterThan(0); expect(f.receipt.replies).toBe(f.receipt.calls); expect(f.receipt.streams).toBeGreaterThan(1);
  expect(f.local).not.toHaveBeenCalled(); expect(f.resources.size).toBe(0); expect(f.store.listOpenShellIntents().every(intent => intent.phase === "cleaned")).toBe(true);
  const timing=readStructuredTimingReceipt(f.timing.snapshot());
  expect(timing.metrics.currentness.count).toBeGreaterThan(0);
  // Progress events retain logical currentness checks.  Exact-byte identity is
  // intentionally reserved for authority boundaries, so this full Ask must
  // prove both that it ran and that it did not restore per-progress hashing.
  expect(timing.metrics.exact_bytes.count).toBeGreaterThanOrEqual(4);
  expect(timing.metrics.exact_bytes.count).toBeLessThan(timing.metrics.currentness.count);
  expect(timing.sessions[0]!.adapterTimer.deadlineMs).toBe(120000);expect(timing.sessions[0]!.adapterTimer.callbackMs).toBeNull();
  expect(timing.sessions[0]!.phases.compile_profile.wallMs).toBeGreaterThan(0);expect(timing.sessions[0]!.phases.context_capture.wallMs).toBeGreaterThan(0);expect(timing.sessions[0]!.phases.host_plan.wallMs).toBeGreaterThan(0);
  expect(timing.sessions[0]!.steps.filter(s=>s.opened).length).toBe(f.receipt.streams);expect(timing.sessions[0]!.steps.filter(s=>s.opened).every(s=>s.firstResult?.category==="success"&&s.firstResult.isError===false)).toBe(true);
  const calls = { ...f.receipt }; await streamTurn(f.deps, f.session.id, f.turn.id, async () => {}); expect(f.receipt).toEqual(calls);
  f.composition.revokeRuntime(); f.composition.revokeRuntime(); expect(f.retained()).toBe(f.before);
// Actual three-step producer/host/SDK path checks exact executable pins at authority boundaries.
// The measured no-model path takes ~58s; this test-only total watchdog preserves production caps.
}, 120_000);

it("runtime change before raw MCP admission blocks effects/save and cleans owned resources without deleting login", async () => {
  const f = await fixture(store => { store.setRuntimeSettings({ ...store.getRuntimeSettings(), subscriptionDriverModel: "different-model" }); });
  await streamTurn(f.deps, f.session.id, f.turn.id, async () => {});
  expect(f.store.getTurn(f.turn.id)).not.toMatchObject({ resultKind: "answer" }); expect(f.receipt.calls, JSON.stringify(f.phases)).toBeGreaterThan(0); expect(f.receipt.replies).toBe(0); expect(f.resources.size).toBe(0);
  f.composition.revokeRuntime(); expect(f.retained()).toBe(f.before); expect(f.local).not.toHaveBeenCalled();
}, 120_000);
