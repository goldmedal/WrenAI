import { resolveExecutionLimits } from "../server/execution-limits.js";
import type { ComponentLimits } from "../harness/components/runner.js";
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
import { openOpenShellWrenAccess } from "../server/runtime-host/openshell-wren-access.js";
import { Store } from "../server/db.js";
import { ClaudeAccountVault } from "../server/runtime-host/claude-account-vault.js";
import type { OpenShellDriver, OpenShellDuplex, OpenShellResource } from "../server/runtime-host/openshell-types.js";
import { createOpenShellRuntimeCompositionForTesting } from "../server/openshell-runtime-composition.js";
import { createOpenShellStructuredProvisioner, resolveStructuredClaudeModels } from "../server/openshell-structured-provisioner.js";
import { createOpenShellStructuredAdapter } from "../server/openshell-structured-ask.js";
import { StructuredRuntime } from "../server/structured-runtime.js";
import { resolveNativeExecutable } from "../server/native-runtime-spec.js";
import { OpenShellNativeSessions } from "../server/openshell-native-sessions.js";
import { NativeSessionService } from "../server/native-sessions.js";
import { RuntimeHost } from "../server/runtime-host/local.js";
import { streamTurn, effectiveRouteOptions, type TurnDeps } from "../server/turn.js";
import { createApp } from "../server/app.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); });
const digest = "sha256:" + "a".repeat(64);
const sql = "SELECT COUNT(*) AS n FROM orders";
const expected = { accountUuid: "11111111-1111-4111-8111-111111111111", organizationUuid: "22222222-2222-4222-8222-222222222222", email: "synthetic@example.test", subscription: "pro" as const };
const frame = (request_id: string, message: unknown) => ({ type: "control_request", request_id, request: { subtype: "mcp_message", server_name: "component", message } });

/** Synthetic peer speaks the actual direct SDK wire; no SDK query or broker handler is mocked. */
function peer(model: string, receipt: { calls: number; replies: number; streams: number; initializations: number; prompts: number; lists: number; listErrors: number }, expectedToolCount: () => number, change?: () => void, native = false): OpenShellDuplex {
  receipt.streams++; let cwd = "/sandbox";
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
    emit({ type: "system", subtype: "init", uuid: "init", session_id: "synthetic-worker", claude_code_version: "2.1.259", cwd, model, apiKeySource: "none",
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
      if (!boot) { boot = true; expect(data.readUInt32BE(0)).toBe(data.length - 4); if (native) { const header = JSON.parse(data.subarray(4).toString()); cwd = `/sandbox/steps/${header.scope}/work`; model = header.argv[header.argv.indexOf("--model") + 1]; emit({ type: "genbi.step", version: 1, step: header.scope, pid: 200, group: 200, start: "1000" }); } return; }
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

async function fixture(change?: (store: Store) => void, failureMode?: "query" | "provider-failed" | "hold-query", controls: { componentLimits?: ComponentLimits; delayedClose?: boolean; helperFailure?: boolean; cleanupProofFailure?: boolean } = {}) {
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
  let querySettled = 0, observedQuery = false;
  let closeRequestedResolve!: () => void, releaseClose!: () => void;
  const closeRequested = new Promise<void>(resolve => { closeRequestedResolve = resolve; });
  const closeReleased = new Promise<void>(resolve => { releaseClose = resolve; });
  cleanup.push(async () => { releaseClose(); });
  let expectedTools = 0, queryClosed = 0; let queryStartedResolve!: () => void;
  const queryStarted = new Promise<void>(resolve => { queryStartedResolve = resolve; });
  const identity = { image: digest, policy: digest, gateway: "synthetic", workspace: "default", configuration: digest };
  const driver: OpenShellDriver = { version: "synthetic", identity, modelIdentity: identity, probe: async () => {}, create: async intent => { const resource = { id: intent.id, name: intent.name, workspace: "default", labels: { "genbi-lifecycle-owner": intent.owner } }; resources.set(intent.name, resource); return resource; }, list: async intent => [...resources.values()].filter(resource => resource.name === intent.name), inspect: async intent => resources.get(intent.name)!, remove: async intent => { resources.delete(intent.name); }, assertAbsent: async intent => { expect(resources.has(intent.name)).toBe(false); }, exec: async (_intent, argv) => { if (argv[1] !== "/opt/genbi/claude-step-control.mjs") throw Error("no live runtime"); if (argv[2] === "--baseline") return JSON.stringify({ type: "genbi.session.baseline", version: 1, processes: [] }); if (argv[2] === "--check") return JSON.stringify({ type: "genbi.session.checked", version: 1, remaining: 0 }); if (controls.helperFailure && observedQuery) throw Error("synthetic uncertain model cleanup"); return JSON.stringify({ ...JSON.parse(argv[2]!).receipt, type: "genbi.step.cleaned", remaining: 0 }); }, duplex: async intent => { if (intent.identity.purpose !== "model" && intent.identity.purpose !== "model_session") throw Error("not a model step"); const stream = peer(intent.identity.purpose === "model" ? intent.identity.model : "synthetic-model", receipt, () => expectedTools, change ? () => change(store) : undefined, intent.identity.purpose === "model_session"); streams.push(stream); return stream; } };
  const composition = await createOpenShellRuntimeCompositionForTesting({ env: { GENBI_CLAUDE_RUNTIME: "openshell", GENBI_OPENSHELL_CONFIG: config }, store, stateRoot: path.join(root, "lifecycle"), driver, claude: { vault, duplex: driver.duplex! } });
  Object.defineProperty(composition, "dataWorkerAvailable", { value: true });
  // Credential-free synthetic data peer exercises the production bounded adapter.
  // Actual Linux/OpenShell execution is a separate container acceptance gate.
  vi.spyOn(composition, "bindDataContext").mockImplementation((_context, check) => async (_scope, signal) => {
    const tuple = { worker: "genbi-wren-worker/1" as const, snapshot: digest, script: digest, wheel: digest, toolchain: digest, architecture: "linux-arm64" as const, protocol: "wren-governed/2" as const };
    let wake: (() => void) | undefined, closed = false;
    const chunks = [Buffer.from(JSON.stringify(tuple) + "\n" + JSON.stringify({ id: 0, protocol: tuple.protocol }) + "\n")];
    const dataStream: OpenShellDuplex = { done: new Promise(() => {}),
      output: (async function* () { while (!closed) { if (chunks.length) yield { stream: "stdout" as const, data: chunks.shift()! }; else await new Promise<void>(resolve => { wake = resolve; }); } })(),
      write(bytes) { check(); const request = JSON.parse(bytes.toString()); expect(request.operation).toBe("query"); expect(request.sql).toBe(sql); observedQuery = true; queryStartedResolve(); if (failureMode === "hold-query") return; chunks.push(Buffer.from(JSON.stringify(failureMode ? { id: request.id, error: { class: "execution_failed", message: "synthetic private SQL/token/path must not escape" } } : { id: request.id, result: oracle[1].result }) + "\n")); wake?.(); },
      close() { queryClosed++; closed = true; wake?.(); } };
    return openOpenShellWrenAccess({ expected: tuple, signal, assertCurrent: check, lease: { id: "synthetic-data", reference: "synthetic-ref", assertActive: check,
      async verify() { check(); return { digest } as never; }, async read() { return Buffer.from(JSON.stringify({ models: ["orders"] })); }, async openGoverned() { return dataStream; }, async close() { dataStream.close(); closeRequestedResolve(); if (controls.delayedClose) await closeReleased; querySettled++; } } });
  });
  cleanup.push(async () => { for (const stream of streams) stream.close(); await composition.shutdown(); store.close(); });
  const producer = await resolveWarbleBinary();
  const profileSource = path.join(application, "profiles/genbi-default");
  const timing=createStructuredTimingRecorder({role:"utility"});timing.beginSession(1);const diagnostics=createStructuredTimingObserver(timing);
  const provisioner = createOpenShellStructuredProvisioner({ composition, store, diagnostics, ...(controls.componentLimits ? { componentLimits: controls.componentLimits } : {}), producerBinary: producer, wrenBinary: wren, profileSource, hostHome: root, sourceWrenHome: () => home, getBinding: () => store.getEnrichmentBinding(), modelsFor: settings => resolveStructuredClaudeModels(settings, () => "synthetic-model"), assertConfigurationCurrent() {} });
  if (controls.cleanupProofFailure) provisioner.assertSessionCleaned = () => { throw Error("synthetic owned cleanup remains uncertain"); };
  const phases: string[] = []; const capturedLimits: (ComponentLimits | undefined)[] = [];
  const realBindings = componentRuntime.createNativeComponentRuntimeBindings;
  vi.spyOn(componentRuntime, "createNativeComponentRuntimeBindings").mockImplementation(options => { capturedLimits.push(options.componentLimits); const bindings = realBindings(options); const step = bindings.step; return { ...bindings, async step(...args) { expectedTools = Object.keys(args[0].tools).length; phases.push("step-start"); try { const value = await step(...args); phases.push("step-pass"); return failureMode === "provider-failed" && expectedTools > 0 ? { ...value, failed: true } : value; } catch (error) { phases.push("step-error:" + String(error)); if (failureMode === "provider-failed") throw Error("synthetic later provider transport failure"); throw error; } } }; });
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
  const deps = { store, structuredRuntime: runtime, route: local, baseRouteOptions: { ...(controls.componentLimits ? { componentLimits: controls.componentLimits } : {}), authChoice: { mode: "subscription", provider: "claude" }, profileSource, userProject: project, question: "count orders" } } as TurnDeps;
  const native = new OpenShellNativeSessions({ store, provisioner, runtime: () => runtime, getBinding: () => store.getEnrichmentBinding(), routeOptions: () => effectiveRouteOptions(deps) });
  const nativeService = new NativeSessionService({ store, openShellNative: native, workspaceRoot: root, terminalManager: async () => { throw Error("no terminal"); }, getBinding: () => store.getEnrichmentBinding(), warbleBin: producer, irPaths: { analysis: path.join(profileSource, "ir.golden.json"), setup: undefined, context_enrichment: undefined }, nativeHome: root, sourceWrenHome: () => home, runtimeHost: new RuntimeHost({ selected: "openshell", deployment: "development", localAvailable: () => false, vendorProbes: { openshell: composition.probe } }) });
  Object.defineProperty(deps, "nativeSessions", { value: nativeService }); cleanup.push(async () => { releaseClose(); if (controls.cleanupProofFailure) await expect(native.shutdown()).rejects.toThrow(); else await native.shutdown(); });
  const session = store.createSession("analysis"), turn = store.createTurn({ id: "synthetic-turn", sessionId: session.id, question: "count orders", composedInput: null });
  return { root, store, timing, capturedLimits, composition, runtime, local, deps, session, turn, receipt, resources, before, retained, phases, native, nativeService, vault, queryStarted, queryClosed: () => queryClosed, querySettled: () => querySettled, closeRequested, releaseClose };
}

it("HTTP-selected Ask runs pinned plan → branded SDK peer → synthetic Wren data peer → one verified durable answer", async () => {
  const componentLimits = resolveExecutionLimits({ WREN_HARNESS_COMPONENT_TIMEOUT_MS: "300000" }).componentLimits;
  const f = await fixture(undefined, undefined, { componentLimits }); const app = createApp(f.deps);
  expect(await (await app.request("/api/structured-runtime/readiness")).json()).toMatchObject({ active: { backend: "openshell", ask: true, queryExecution: "openshell" } });
  const frames: unknown[] = []; await streamTurn(f.deps, f.session.id, f.turn.id, async frame => { frames.push(frame); });
  const stored = f.store.getTurn(f.turn.id);
  expect(stored, JSON.stringify({ frames, phases: f.phases, receipt: f.receipt })).toMatchObject({ backend: "openshell", resultKind: "answer" });
  expect(JSON.parse(stored!.answerSummary!)).toEqual([{ type: "table", columns: ["n"], rows: [{ n: 7 }] }, { type: "definition", sql, source_tables: ["orders"], filters: [] }]);
  expect(JSON.stringify(stored)).not.toContain("999999"); expect(f.receipt.calls).toBeGreaterThan(0); expect(f.receipt.replies).toBe(f.receipt.calls); expect(f.receipt.streams).toBeGreaterThan(1);
  expect(f.local).not.toHaveBeenCalled(); expect(wrenAccess.openWrenComponentAccess).not.toHaveBeenCalled(); expect(f.resources.size).toBe(0); expect(f.store.listOpenShellIntents().every(intent => intent.phase === "cleaned")).toBe(true);
  const timing=readStructuredTimingReceipt(f.timing.snapshot());
  expect(timing.metrics.currentness.count).toBeGreaterThan(0);
  // Progress events retain logical currentness checks.  Exact-byte identity is
  // intentionally reserved for authority boundaries, so this full Ask must
  // prove both that it ran and that it did not restore per-progress hashing.
  expect(timing.metrics.exact_bytes.count).toBeGreaterThanOrEqual(4);
  expect(timing.metrics.exact_bytes.count).toBeLessThan(timing.metrics.currentness.count);
  expect(timing.sessions[0]!.adapterTimer.deadlineMs).toBe(300000);
  expect(f.capturedLimits.length).toBeGreaterThan(0); expect(f.capturedLimits.every(limits => JSON.stringify(limits) === JSON.stringify(componentLimits))).toBe(true);expect(timing.sessions[0]!.adapterTimer.callbackMs).toBeNull();
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

it.each(["query", "provider-failed"] as const)("production provisioner persists and replays only the terminal %s cause", async mode => {
  const f = await fixture(undefined, mode); const frames: unknown[] = [];
  await streamTurn(f.deps, f.session.id, f.turn.id, async frame => { frames.push(frame); });
  const expectedCode = mode === "query" ? "query.execution_failed" : "runtime.failed";
  expect(f.store.getTurn(f.turn.id), JSON.stringify(f.phases)).toMatchObject({ resultKind: mode === "query" ? "refusal" : "error", errorCode: expectedCode });
  if (mode === "query") {
    expect(frames).toContainEqual(expect.objectContaining({ event: "event", data: expect.objectContaining({ kind: "refusal", reason: expect.stringContaining("current dataset") }) }));
    expect(frames.some((frame: any) => frame.event === "error")).toBe(false);
    expect(f.store.listEventsForTurn(f.turn.id).filter(event => event.kind === "refusal")).toHaveLength(1);
  } else expect(frames).toContainEqual(expect.objectContaining({ event: "error", data: expect.objectContaining({ code: expectedCode, kind: "runtime" }) }));
  expect(JSON.stringify(frames)).not.toContain("synthetic private");
  const before = { ...f.receipt }; const replay: unknown[] = [];
  await streamTurn(f.deps, f.session.id, f.turn.id, async frame => { replay.push(frame); });
  expect(replay.filter((frame: any) => frame.event !== "worklog")).toEqual(frames.filter((frame: any) => frame.event !== "worklog")); expect(f.receipt).toEqual(before);
  const app = createApp(f.deps); const hydrated = await (await app.request(`/api/sessions/${f.session.id}`)).json() as { events: { kind: string }[] };
  if (mode === "query") { expect(hydrated).not.toHaveProperty("error"); expect(hydrated.events.filter((event: any) => event.kind === "refusal")).toHaveLength(1); }
  else expect(hydrated).toMatchObject({ error: { code: expectedCode } });
  expect(f.store.listEventsForTurn(f.turn.id).some(event => event.kind === "answer")).toBe(false);
  expect(f.resources.size).toBe(0); expect(f.local).not.toHaveBeenCalled();
}, 120_000);

it("scoped Native HTTP launch shares Ask root authority, reconnects one sandbox and deduplicates follow-up", async () => {
  const f = await fixture(); const app = createApp(f.deps);
  await streamTurn(f.deps, f.session.id, f.turn.id, async () => {});
  const ask = f.store.listEventsForTurn(f.turn.id).find(event => event.kind === "answer")!.payload;
  const launched = await app.request("/api/native-sessions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ purpose: "analysis" }) });
  expect(launched.status, await launched.clone().text()).toBe(201);
  const { session, capability } = await launched.json() as { session: { id: string; transport: string }; capability: string };
  expect(session.transport).toBe("scoped-events");
  for (const cap of [undefined, "44444444-4444-4444-8444-444444444444"]) {
    const denied = await app.request("/api/native-sessions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ purpose: "analysis", intent: "open_existing", sessionId: session.id, ...(cap ? { capability: cap } : {}) }) });
    expect(denied.status).toBe(409); expect(await denied.json()).not.toHaveProperty("capability");
  }
  const reopened = await app.request("/api/native-sessions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ purpose: "analysis", intent: "open_existing", sessionId: session.id, capability }) });
  expect(reopened.status).toBe(201); expect(await reopened.json()).toMatchObject({ session: { id: session.id }, capability });
  const held = f.store.listOpenShellIntents().filter(intent => intent.identity.purpose === "model_session"); expect(held).toHaveLength(1);
  const frames: any[] = [], attachment = f.native.attach(session.id, capability, frame => frames.push(frame))!;
  const requestId = "11111111-1111-4111-8111-111111111111";
  const pending = attachment.submit(requestId, "count orders"); attachment.detach(); await pending;
  const replay = f.native.attach(session.id, capability, frame => frames.push(frame))!;
  const nativeAnswer = f.store.listNativeScopedEvents(session.id).find(event => event.kind === "answer")!.payload;
  expect(nativeAnswer).toEqual(expect.objectContaining({ kind: "answer", answer: (ask as any).answer }));
  expect(f.store.getLatestNativeStructuredAnswer(session.id)).toMatchObject({ grounded: true });
  const count = { ...f.receipt }; await replay.submit(requestId, "count orders"); expect(f.receipt).toEqual(count);
  await expect(replay.submit(requestId, "different question")).rejects.toThrow();
  const beforeCursor = f.native.history(session.id)!.through; await replay.submit("22222222-2222-4222-8222-222222222222", "count orders again");
  expect(f.store.listNativeScopedEvents(session.id).filter(event => event.kind === "answer")).toHaveLength(2);
  expect(f.store.listOpenShellIntents().filter(intent => intent.identity.purpose === "model_session").map(intent => intent.id)).toEqual(held.map(intent => intent.id));
  expect(f.native.history(session.id, beforeCursor)!.events.every(event => event.sequence > beforeCursor)).toBe(true);
  expect(f.native.attach(session.id, "wrong", () => {})).toBeUndefined();
  for (let n = 0; n < 520; n++) f.store.appendNativeScopedEvent(session.id, null, "worklog", { steps: [] });
  expect(f.native.history(session.id, 0)!.truncated).toBe(true);
  expect(f.native.history(session.id, f.store.nativeScopedPrunedThrough(session.id))!.truncated).toBe(false);
  expect(await f.native.stop(session.id, capability)).toBe(true); expect(f.store.getNativeSession(session.id)?.status).toBe("stopped");
  expect(f.resources.size).toBe(0); expect(f.local).not.toHaveBeenCalled(); expect(f.retained()).toBe(f.before);
}, 120_000);

it("scoped Native unsupported purpose/profile and missing readiness fail before durable launch effects", async () => {
  const f = await fixture(); const before = f.store.listOpenShellIntents().length;
  await expect(f.native.open({ purpose: "setup" })).rejects.toThrow(); await expect(f.native.open({ purpose: "analysis", profile: "custom" })).rejects.toThrow();
  expect(f.store.listNativeSessions()).toHaveLength(0); expect(f.store.listOpenShellIntents()).toHaveLength(before);
  await f.composition.lifecycle!.shutdown(); await expect(f.native.open({ purpose: "analysis" })).rejects.toThrow();
  expect(f.store.listNativeSessions()).toHaveLength(0); expect(f.resources.size).toBe(0);
}, 120_000);


it.each(["cancel", "stop"] as const)("scoped Native %s aborts an active query, confirms cleanup and never persists a late answer", async operation => {
  const f = await fixture(undefined, "hold-query"); const launched = await f.native.open({ purpose: "analysis" });
  const frames: any[] = [], attachment = f.native.attach(launched.row.id, launched.capability, frame => frames.push(frame))!;
  const requestId = "33333333-3333-4333-8333-333333333333";
  const pending = attachment.submit(requestId, "count orders"); await f.queryStarted;
  expect(f.queryClosed()).toBe(0);
  if (operation === "cancel") await attachment.cancel(); else await f.native.stop(launched.row.id, launched.capability);
  await pending;
  expect(f.queryClosed()).toBeGreaterThan(0); expect(f.resources.size).toBe(0);
  expect(f.store.getNativeSession(launched.row.id)?.status).toBe(operation === "cancel" ? "interrupted" : "stopped");
  expect(frames).toContainEqual(expect.objectContaining({ kind: "state", payload: { state: operation === "cancel" ? "interrupted" : "stopped", cleanup: "confirmed" } }));
  expect(f.store.getNativeScopedRequest(launched.row.id, requestId)?.status).toBe("cancelled");
  expect(f.store.listNativeScopedEvents(launched.row.id).filter(event => event.kind === "answer")).toEqual([]);
  expect(f.store.getLatestNativeStructuredAnswer(launched.row.id)).toBeUndefined();
  await expect(attachment.submit("44444444-4444-4444-8444-444444444444", "follow up")).rejects.toThrow();
  await f.native.shutdown(); expect(f.store.getNativeSession(launched.row.id)?.status).toBe(operation === "cancel" ? "interrupted" : "stopped");
  expect(f.local).not.toHaveBeenCalled(); expect(f.retained()).toBe(f.before);
}, 120_000);

it("two scoped Native sessions hold different sandbox authority and reject cross-capability and runtime generation reuse", async () => {
  const f = await fixture();
  const a = await f.native.open({ purpose: "analysis", requestId: "11111111-1111-4111-8111-111111111111" });
  const b = await f.native.open({ purpose: "analysis", requestId: "22222222-2222-4222-8222-222222222222" });
  expect(f.native.history(a.row.id)!.truncated).toBe(false); expect(f.native.history(b.row.id)!.truncated).toBe(false);
  await expect(f.native.open({ purpose: "analysis", id: a.row.id, capability: b.capability })).rejects.toThrow();
  expect(a.row.id).not.toBe(b.row.id); expect(a.capability).not.toBe(b.capability);
  const leases = f.store.listOpenShellIntents().filter(intent => intent.identity.purpose === "model_session");
  expect(leases).toHaveLength(2); expect(new Set(leases.map(intent => intent.id)).size).toBe(2);
  expect(new Set(leases.map(intent => intent.identity.session))).toEqual(new Set([a.row.id, b.row.id]));
  expect(f.native.attach(a.row.id, b.capability, () => {})).toBeUndefined();
  const attachment = f.native.attach(a.row.id, a.capability, () => {})!;
  f.store.setRuntimeSettings({ ...f.store.getRuntimeSettings(), subscriptionDriverModel: "new-model" });
  await expect(attachment.submit("33333333-3333-4333-8333-333333333333", "count orders")).rejects.toThrow();
  await expect(f.native.open({ purpose: "analysis", id: b.row.id, capability: b.capability })).rejects.toThrow();
  f.native.revoke([a.row.id,b.row.id]); await f.native.shutdown(); expect(f.resources.size).toBe(0);
  expect(f.store.getLatestNativeStructuredAnswer(a.row.id)).toBeUndefined(); expect(f.store.getLatestNativeStructuredAnswer(b.row.id)).toBeUndefined();
}, 120_000);


it("lease-abort interruption waits for delayed query cleanup, then confirms only its session while another lease stays active", async () => {
  const f=await fixture(undefined,"hold-query",{delayedClose:true,helperFailure:true});
  const a=await f.native.open({purpose:"analysis",requestId:"11111111-1111-4111-8111-111111111111"});
  const b=await f.native.open({purpose:"analysis",requestId:"22222222-2222-4222-8222-222222222222"});
  const trace:string[]=[],frames:any[]=[];
  const attachment=f.native.attach(a.row.id,a.capability,frame=>{frames.push(frame);if(frame.type==="event"&&frame.kind==="state"&&(frame.payload as any).cleanup==="confirmed"){trace.push("confirmed");expect(f.querySettled()).toBe(1);}})!;
  const pending=attachment.submit("33333333-3333-4333-8333-333333333333","count orders");await f.queryStarted;
  const cancelled=attachment.cancel();await f.closeRequested;
  expect(f.querySettled()).toBe(0);expect(frames.some(frame=>frame.kind==="state"&&frame.payload.cleanup==="confirmed")).toBe(false);
  trace.push("release-query-close");f.releaseClose();await cancelled;await pending;
  expect(trace).toEqual(["release-query-close","confirmed"]);
  const events=f.store.listNativeScopedEvents(a.row.id);const error=events.find(row=>row.kind==="error")!,confirmed=events.find(row=>row.kind==="state"&&(row.payload as any).cleanup==="confirmed")!;
  expect(error.sequence).toBeLessThan(confirmed.sequence);expect(events.filter(row=>row.kind==="answer")).toEqual([]);
  expect(f.store.getNativeSession(b.row.id)?.status).toBe("running");expect(f.native.capability(b.row.id)).toBe(b.capability);
  await f.native.stop(b.row.id,b.capability);expect(f.resources.size).toBe(0);
},120_000);

it("owned cleanup proof failure remains pending and cannot turn into confirmed or a successful answer",async()=>{
  const f=await fixture(undefined,"hold-query",{cleanupProofFailure:true});const a=await f.native.open({purpose:"analysis"});
  const attachment=f.native.attach(a.row.id,a.capability,()=>{})!;
  const pending=attachment.submit("33333333-3333-4333-8333-333333333333","count orders");await f.queryStarted;
  const pendingRejected=expect(pending).rejects.toThrow();
  await expect(attachment.cancel()).rejects.toThrow();await pendingRejected;
  const events=f.store.listNativeScopedEvents(a.row.id);
  expect(events).toContainEqual(expect.objectContaining({kind:"state",payload:{state:"interrupted",cleanup:"pending"}}));
  expect(events.some(row=>row.kind==="state"&&(row.payload as any).cleanup==="confirmed")).toBe(false);
  expect(f.store.getLatestNativeStructuredAnswer(a.row.id)).toBeUndefined();await expect(f.native.shutdown()).rejects.toThrow();
},120_000);


it.each(["binding", "account-generation"] as const)("scoped Native %s invalidation rejects the old capability before any root effects and cleans its exact lease",async change=>{
  const f=await fixture();const a=await f.native.open({purpose:"analysis"});const attachment=f.native.attach(a.row.id,a.capability,()=>{})!;
  const intentsBefore=f.store.listOpenShellIntents().length,callsBefore={...f.receipt};
  if(change==="binding") {const old=f.store.getEnrichmentBinding()!;f.store.activateEnrichmentBinding({path:old.path,identity:old.identity,revision:"sha256:"+"b".repeat(64)});}
  else f.vault.enroll({accessToken:"synthetic-replacement-access",refreshToken:"synthetic-replacement-refresh",expiresAt:Date.now()+3600000});
  await expect(attachment.submit("33333333-3333-4333-8333-333333333333","count orders")).rejects.toThrow();
  await expect(f.native.open({purpose:"analysis",id:a.row.id,capability:a.capability})).rejects.toThrow();
  expect(f.store.listOpenShellIntents()).toHaveLength(intentsBefore);expect(f.receipt).toEqual(callsBefore);
  expect(f.store.getNativeScopedRequest(a.row.id,"33333333-3333-4333-8333-333333333333")).toBeUndefined();
  expect(f.store.getLatestNativeStructuredAnswer(a.row.id)).toBeUndefined();
  f.native.reconcile(a.row.id);await f.native.shutdown();expect(f.resources.size).toBe(0);
  expect(f.store.getNativeSession(a.row.id)?.status).toBe("interrupted");
  expect(f.store.listOpenShellIntents().filter(row=>row.identity.session===a.row.id).every(row=>row.phase==="cleaned")).toBe(true);
  expect(f.local).not.toHaveBeenCalled();
},120_000);

it("gateway runtime selection cannot launch a scoped Claude Native sandbox or persist root effects", async () => {
  const f = await fixture();
  f.store.setRuntimeSettings({ ...f.store.getRuntimeSettings(), authMode: "gateway", gatewayProvider: "openrouter", gatewayModel: "synthetic", tierModels: [{ tier: "cheap" }, { tier: "strong" }] });
  await expect(f.native.open({ purpose: "analysis" })).rejects.toThrow();
  expect(f.store.listNativeSessions()).toHaveLength(0); expect(f.store.listOpenShellIntents()).toHaveLength(0);
  expect(f.receipt.streams).toBe(0); expect(f.resources.size).toBe(0); expect(f.local).not.toHaveBeenCalled();
}, 120_000);
