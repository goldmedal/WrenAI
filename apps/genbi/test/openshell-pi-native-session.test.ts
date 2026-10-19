import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveWarbleBinary } from "../harness/compile/resolve-binary.js";
import { hashDirectory } from "../harness/compile/fingerprint.js";
import { openWrenComponentAccess } from "../harness/components/wren-access.js";
import { openOpenShellWrenAccess } from "../server/runtime-host/openshell-wren-access.js";
import { Store } from "../server/db.js";
import { OpenShellError, type OpenShellDriver, type OpenShellDuplex, type OpenShellResource } from "../server/runtime-host/openshell-types.js";
import { createOpenShellRuntimeComposition } from "../server/openshell-runtime-composition.js";
import { createOpenShellStructuredProvisioner } from "../server/openshell-structured-provisioner.js";
import { createOpenShellStructuredAdapter } from "../server/openshell-structured-ask.js";
import { StructuredRuntime } from "../server/structured-runtime.js";
import { resolveRuntimeSelection } from "../server/runtime-selection.js";
import { resolveNativeExecutable } from "../server/native-runtime-spec.js";
import { OpenShellNativeSessions } from "../server/openshell-native-sessions.js";
import { NativeSessionService, nativeSessionLifecycle } from "../server/native-sessions.js";
import { RuntimeHost } from "../server/runtime-host/local.js";
import { piProviderConfig, type OpenShellPiBoot, type OpenShellPiBootDescriptor } from "../server/runtime-host/openshell-pi-boot.js";
import { piAccountDigest } from "../server/runtime-host/openshell-pi-provider.js";
import { validatePiRuntimeBindings } from "../server/runtime-binding.js";
import { effectiveRouteOptions, streamTurn, type TurnDeps } from "../server/turn.js";
import { createApp } from "../server/app.js";
import { INTERACTIVE_TARGETS } from "../server/interactive-terminal.js";
import { dispatchForPurpose, interactiveTargetOf, resolveNativeRuntimeBinding } from "../server/native-dispatch-registry.js";
import type { RuntimeSettings } from "../server/wire-types.js";
import { PiSim, happyBehavior, type Bootstrap } from "./pi-sim.js";

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { vi.useRealTimers(); for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); });
const digest = `sha256:${"a".repeat(64)}`;
const sql = "SELECT COUNT(*) AS n FROM orders";
const SESSION_STEP = ["/usr/local/bin/node", "/opt/genbi/pi-session-step.mjs"], CONTROL = ["/usr/local/bin/node", "/opt/genbi/pi-step-control.mjs"];
const REQUEST_A = "11111111-1111-4111-8111-111111111111", REQUEST_B = "22222222-2222-4222-8222-222222222222", REQUEST_C = "33333333-3333-4333-8333-333333333333";
type Mode = "answer" | "hold-query" | "no-query";
interface Controls {
  mode?: Mode; delayedClose?: boolean; cleanupProofFailure?: boolean; gatewayPollMs?: number; verifyGateway?: () => Promise<void>; dbPath?: string;
  /** Faults of the session sandbox's step control and the worker's receipt. `check` counts every check call, from 1. */
  control?: { failBaseline?: boolean; failCheckOn?: number; failCleanup?: boolean; foreignReceipt?: boolean; noReceipt?: boolean };
}
const dataReply = (governed: (request: Record<string, unknown>) => { id: number; result?: unknown; error?: { class: string } }[], request: { id: number } & Record<string, unknown>) => {
  const answer = governed({ ...request, id: 1 })[1]!; return answer.error ? { id: request.id, error: answer.error } : { id: request.id, result: answer.result };
};

/** The pi session-step worker is scripted: it speaks the real receipt and frames, and every frame is judged by the real host protocol, broker and governed data path. */
async function fixture(controls: Controls = {}) {
  const mode = controls.mode ?? "answer";
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "openshell-pi-native-")));
  cleanup.push(async () => { rmSync(root, { recursive: true, force: true }); });
  const project = path.join(root, "project"), home = path.join(root, "wren-home"), database = path.join(root, "data");
  for (const dir of [project, home, database, path.join(project, "models/orders")]) mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(project, "wren_project.yml"), "schema_version: 5\nname: synthetic\ncatalog: wren\nschema: public\ndata_source: duckdb\nprofile: synthetic\n");
  writeFileSync(path.join(project, "models/orders/metadata.yml"), "name: orders\nref_sql: SELECT * FROM synthetic.raw_orders\ncolumns:\n  - name: id\n    type: INTEGER\n");
  writeFileSync(path.join(home, "profiles.yml"), `profiles:\n  synthetic:\n    datasource: duckdb\n    url: ${JSON.stringify(database)}\n    format: duckdb\n`, { mode: 0o600 });
  const resolvedWren = resolveNativeExecutable("wren", "wren", process.env.PATH)!.executable;
  const python = process.env.GENBI_GOVERNED_WREN_PYTHON ?? readFileSync(resolvedWren, "utf8").split("\n")[0]!.slice(2);
  execFileSync(python, ["-c", "import duckdb,sys; c=duckdb.connect(sys.argv[1]); c.execute('CREATE TABLE raw_orders(id INTEGER)'); c.execute('INSERT INTO raw_orders VALUES (1),(2),(3),(4),(5),(6),(7)'); c.close()", path.join(database, "synthetic.duckdb")], { env: { PATH: "/usr/bin:/bin", HOME: root }, stdio: "pipe" });
  const application = path.resolve(process.cwd());
  const source = path.resolve(application, "../../core/wren/src");
  const wren = path.join(root, "wren");
  writeFileSync(wren, `#!${python}\nimport sys\nsys.path.insert(0,${JSON.stringify(source)})\nfrom wren.cli import app\napp()\n`, { mode: 0o700 });
  const governedEnvironment = { PATH: "/usr/bin:/bin", HOME: root, WREN_HOME: home, PYTHONNOUSERSITE: "1", PYTHONDONTWRITEBYTECODE: "1" };
  const governed = (request: Record<string, unknown>) => execFileSync(wren, ["governed-stdio", "--project", project], { env: governedEnvironment, input: JSON.stringify(request) + "\n", timeout: 20_000, stdio: ["pipe", "pipe", "pipe"] })
    .toString("utf8").trim().split("\n").map(line => JSON.parse(line)) as { id: number; result?: unknown; error?: { class: string } }[];
  const oracle = governed({ id: 1, operation: "query", sql, limit: 1000 });
  expect(oracle).toEqual([{ id: 0, protocol: "wren-governed/2" }, { id: 1, result: { columns: ["n"], rows: [{ n: 7 }], definition: { sql, source_tables: ["orders"], filters: [] } } }]);
  const oracleAccess = await openWrenComponentAccess({ executable: wren, project, fingerprint: await hashDirectory(project), signal: new AbortController().signal,
    environment: { PATH: [root, path.dirname(process.execPath), "/usr/bin", "/bin"].join(path.delimiter), HOME: root, WREN_HOME: home, WREN_PROJECT_HOME: project, PYTHONNOUSERSITE: "1", PYTHONUTF8: "1", PYTHONDONTWRITEBYTECODE: "1" } });
  try { expect(await oracleAccess.query({ sql, limit: 1000 }, new AbortController().signal)).toMatchObject({ rows: [{ n: 7 }] }); } finally { await oracleAccess.close(); }
  const config = path.join(root, "configuration.json");
  const piImage = `sha256:${"c".repeat(64)}`;
  writeFileSync(config, JSON.stringify({ executable: wren, executableDigest: digest, version: "0.0.1", gateway: "synthetic", workspace: "default", image: digest, supervisorImage: digest,
    policy: config, policyDigest: digest, home: root, configHome: root, stateHome: root, dockerExecutable: wren, dockerRealpath: wren, dockerDigest: digest, dockerSocket: path.join(root, "none.sock"), dockerNamespace: "synthetic", exclusive: true,
    pi: { image: piImage, policy: config, policyDigest: digest, provider: "vendor-provider", profile: config, profileDigest: digest } }));
  const store = new Store(controls.dbPath ?? ":memory:", { nativeScopedVendor: "pi" });
  store.setRuntimeSettings({ authMode: "byo", apiKeyAdapter: "openai-compatible", tierModels: [{ tier: "cheap", model: "model-cheap" }, { tier: "strong", model: "model-strong" }], hybrid: false, deployment: "personal" });
  store.activateEnrichmentBinding({ path: project, identity: "synthetic-project", revision: digest });

  const descriptor: OpenShellPiBootDescriptor = Object.freeze({ version: 1, gatewayUrl: "https://localhost:9443/", caCert: "/a", clientCert: "/b", clientKey: "/c", auth: "api-key", provider: "vendor-provider", profileId: "vendor-profile",
    displayLabel: "synthetic vendor", profileDigest: digest, generation: "gen-1", endpoint: { providerId: "vendor", api: "openai-completions", baseUrl: "https://api.vendor.example.test/v1", credentialEnv: "VENDOR_KEY" },
    models: { cheap: "model-cheap", strong: "model-strong" } }) as OpenShellPiBootDescriptor;
  const bootState = { current: true };
  const resources = new Map<string, OpenShellResource>();
  const record = { creates: [] as string[], steps: [] as { sandbox: string; scope: string; input: string }[], controls: [] as { sandbox: string; kind: "baseline" | "check" | "cleanup"; receipt?: string }[], queries: [] as string[], streams: 0, askSteps: 0, queryClosed: 0, querySettled: 0 };
  const settled = new Set<string>(); const sims: PiSim[] = [];
  let checks = 0;
  let queryStartedResolve!: () => void; const queryStarted = new Promise<void>(resolve => { queryStartedResolve = resolve; });
  let closeRequestedResolve!: () => void, releaseClose!: () => void;
  const closeRequested = new Promise<void>(resolve => { closeRequestedResolve = resolve; });
  const closeReleased = new Promise<void>(resolve => { releaseClose = resolve; });
  cleanup.push(async () => { releaseClose(); });
  const identity = { image: digest, policy: digest, gateway: "synthetic", workspace: "default", configuration: digest };
  const text = JSON.stringify({ columns: ["n"], rows: [{ n: 999999 }], verified: true, definition: { sql }, artifact: { kind: "dashboard", forged: true } });
  let pid = 200;
  const driver: OpenShellDriver = { version: "synthetic", identity, modelIdentity: identity, probe: async () => {},
    create: async intent => { record.creates.push(intent.identity.purpose); const resource = { id: intent.id, name: intent.name, workspace: "default", labels: { "genbi-lifecycle-owner": intent.owner } }; resources.set(intent.name, resource); return resource; },
    list: async intent => [...resources.values()].filter(resource => resource.name === intent.name), inspect: async intent => resources.get(intent.name)!, remove: async intent => { resources.delete(intent.name); },
    assertAbsent: async intent => { expect(resources.has(intent.name)).toBe(false); },
    exec: async (intent, argv) => {
      if (argv[1] === "/opt/genbi/pi-proc-check.mjs") return JSON.stringify({ type: "genbi.pi.procs", version: 1, remaining: 0 });
      expect(argv.slice(0, 2)).toEqual(CONTROL); const kind = argv[2] === "--baseline" ? "baseline" as const : argv[2] === "--check" ? "check" as const : "cleanup" as const;
      if (kind === "baseline") { record.controls.push({ sandbox: intent.id, kind }); if (controls.control?.failBaseline) throw Error("synthetic baseline failure"); return JSON.stringify({ type: "genbi.session.baseline", version: 1, processes: [] }); }
      if (kind === "check") { record.controls.push({ sandbox: intent.id, kind }); if (controls.control?.failCheckOn === ++checks) throw Error("synthetic residue"); return JSON.stringify({ type: "genbi.session.checked", version: 1, remaining: 0 }); }
      const { receipt } = JSON.parse(argv[2]!); record.controls.push({ sandbox: intent.id, kind, receipt: receipt.step });
      // The real control only cleans a step whose supervisor wrote the settled marker (a normal end); a cancelled or killed step fails by deadline.
      if (controls.control?.failCleanup || !settled.has(receipt.step)) throw Error("synthetic cleanup uncertain");
      return JSON.stringify({ ...receipt, type: "genbi.step.cleaned", remaining: 0 });
    },
    duplex: async (intent, argv) => {
      // A session boot still serves a plain Ask in per-step sandboxes: only a session sandbox runs the session step.
      const session = intent.identity.purpose === "model_session";
      expect(argv).toEqual(session ? SESSION_STEP : ["/usr/local/bin/node", "/opt/genbi/pi-worker.mjs"]);
      if (session) record.streams++; else record.askSteps++;
      const sim = new PiSim({
        onBootstrap(sim, boot: Bootstrap) {
          const at = boot.argv.indexOf("--tools"); const tools = at < 0 ? [] : boot.argv[at + 1]!.split(",");
          const query = tools.find(name => name.endsWith("query_read_only"));
          // The receipt is the first thing the supervisor writes, before the worker has staged anything.
          if (session && !controls.control?.noReceipt) sim.emit({ type: "genbi.step", version: 1, step: controls.control?.foreignReceipt ? "99999999-9999-4999-8999-999999999999" : boot.scope, pid: ++pid, group: pid, start: "1000" });
          inner = happyBehavior({ ...(query && mode !== "no-query" ? { call: { name: query.replace(/^mcp__component__/, ""), args: { sql } } } : {}), text, onExit: () => { settled.add(boot.scope); } });
          if (session) record.steps.push({ sandbox: intent.id, scope: boot.scope, input: "" });
          inner.onBootstrap(sim, boot);
        },
        onFrame(sim, frame) { if (session && frame.t === "input") record.steps.at(-1)!.input = String(frame.text); inner!.onFrame(sim, frame); },
      });
      let inner: ReturnType<typeof happyBehavior> | undefined; sims.push(sim); return sim.stream;
    } };
  const boot: OpenShellPiBoot = { descriptor, identity: digest, account: piAccountDigest(piProviderConfig(descriptor)),
    assertCurrent() { if (!bootState.current) throw new Error("Protected OpenShell configuration changed"); }, duplex: async (intent, argv, signal) => driver.duplex!(intent, argv, signal) };
  const verifyGateway = vi.fn(controls.verifyGateway ?? (async () => {}));
  const selection = resolveRuntimeSelection({ GENBI_RUNTIME: "openshell", GENBI_BACKEND: "pi" });
  const composition = await createOpenShellRuntimeComposition({ env: { GENBI_RUNTIME: "openshell", GENBI_BACKEND: "pi", GENBI_OPENSHELL_CONFIG: config }, selection, store, stateRoot: path.join(root, "lifecycle"), driver, pi: { boot, verifyGateway } });
  Object.defineProperty(composition, "dataWorkerAvailable", { value: true });
  vi.spyOn(composition, "bindDataContext").mockImplementation((_context, check) => async (_scope, signal) => {
    const tuple = { worker: "genbi-wren-worker/1" as const, snapshot: digest, script: digest, wheel: digest, toolchain: digest, architecture: "linux-arm64" as const, protocol: "wren-governed/2" as const };
    let wake: (() => void) | undefined, closed = false;
    const chunks = [Buffer.from(JSON.stringify(tuple) + "\n" + JSON.stringify({ id: 0, protocol: tuple.protocol }) + "\n")];
    const dataStream: OpenShellDuplex = { done: new Promise(() => {}),
      output: (async function* () { while (!closed) { if (chunks.length) yield { stream: "stdout" as const, data: chunks.shift()! }; else await new Promise<void>(resolve => { wake = resolve; }); } })(),
      write(bytes) {
        check(); const request = JSON.parse(bytes.toString()); expect(request.operation).toBe("query");
        record.queries.push(request.sql); queryStartedResolve();
        if (mode === "hold-query") return;
        chunks.push(Buffer.from(JSON.stringify(dataReply(governed, request)) + "\n")); wake?.();
      },
      close() { record.queryClosed++; closed = true; wake?.(); } };
    return openOpenShellWrenAccess({ expected: tuple, signal, assertCurrent: check, lease: { id: "synthetic-data", reference: "synthetic-ref", assertActive: check,
      async verify() { check(); return { digest } as never; }, async read() { return Buffer.from(JSON.stringify({ models: ["orders"] })); }, async openGoverned() { return dataStream; },
      async close() { dataStream.close(); closeRequestedResolve(); if (controls.delayedClose) await closeReleased; record.querySettled++; } } });
  });
  cleanup.push(async () => { await composition.shutdown(); store.close(); });
  const producer = await resolveWarbleBinary();
  const profileSource = path.join(application, "profiles/genbi-default");
  const provisioner = createOpenShellStructuredProvisioner({ composition, store, ...(controls.gatewayPollMs ? { gatewayPollMs: controls.gatewayPollMs } : {}),
    producerBinary: producer, wrenBinary: wren, profileSource, hostHome: root, sourceWrenHome: () => home, getBinding: () => store.getEnrichmentBinding(),
    modelsFor: () => { throw new Error("the Claude model resolver must never run for a pi boot"); }, assertConfigurationCurrent() { boot.assertCurrent(); } });
  if (controls.cleanupProofFailure) provisioner.assertSessionCleaned = () => { throw Error("synthetic owned cleanup remains uncertain"); };
  const local = vi.fn(async () => { throw Error("in-process fallback forbidden"); });
  const runtime = new StructuredRuntime({ selection, localRoute: local, localSetupFor: () => undefined, adapters: { pi: createOpenShellStructuredAdapter(provisioner, undefined, "pi") }, onRevoke: composition.revokeRuntime });
  const deps = { store, structuredRuntime: runtime, route: local, piRuntime: { validate: (settings: RuntimeSettings, tiers: readonly string[]) => validatePiRuntimeBindings(settings, tiers, boot.descriptor.models, boot.descriptor.auth) },
    getRuntimeTierNames: async () => ["cheap", "strong"], setAuthChoice() {},
    baseRouteOptions: { authChoice: { mode: "api-key", adapter: "openai-compatible" }, profileSource, userProject: project, question: "count orders" } } as unknown as TurnDeps;
  const native = new OpenShellNativeSessions({ store, provisioner, runtime: () => runtime, getBinding: () => store.getEnrichmentBinding(), routeOptions: () => effectiveRouteOptions(deps) });
  const nativeService = new NativeSessionService({ store, openShellNative: native, workspaceRoot: root, terminalManager: async () => { throw Error("no terminal"); }, getBinding: () => store.getEnrichmentBinding(), warbleBin: producer,
    irPaths: { analysis: path.join(profileSource, "ir.golden.json"), setup: undefined, context_enrichment: undefined }, nativeHome: root, sourceWrenHome: () => home, selection,
    runtimeHost: new RuntimeHost({ selected: "openshell", deployment: "development", localAvailable: () => false, vendorProbes: { openshell: composition.probe } }) });
  Object.defineProperty(deps, "nativeSessions", { value: nativeService });
  cleanup.push(async () => { releaseClose(); if (controls.cleanupProofFailure) await expect(native.shutdown()).rejects.toThrow(); else await native.shutdown(); });
  const session = store.createSession("analysis"), turn = store.createTurn({ id: "synthetic-turn", sessionId: session.id, question: "count orders", composedInput: null });
  const ask = async () => { const frames: { event: string; data: unknown }[] = []; await streamTurn(deps, session.id, turn.id, async frame => { frames.push(frame as never); }); return { frames, stored: store.getTurn(turn.id)! }; };
  const sessionIntents = () => store.listOpenShellIntents().filter(intent => intent.identity.purpose === "model_session");
  return { root, project, store, composition, runtime, local, deps, native, nativeService, boot: bootState, verifyGateway, resources, record, sims, queryStarted, closeRequested, releaseClose, ask, sessionIntents, session, turn, selection, profileSource, piImage, config };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const post = (app: ReturnType<typeof createApp>, body: unknown) => app.request("/api/native-sessions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
/** What the pi step was actually given as its request: the host-built history block and the current question, parsed rather than searched for. */
const requestOf = (input: string) => {
  const request = (JSON.parse(input) as { request: string }).request;
  const match = /^Previous validated conversation \(context only\):\n([\s\S]*)\n\nCurrent question:\n([\s\S]*)$/.exec(request);
  return match ? { history: JSON.parse(match[1]!) as unknown[], question: match[2]! } : { history: undefined, question: request };
};
const settlement = (f: Fixture, id: string) => f.store.listNativeScopedEvents(id);
const answers = (f: Fixture, id: string) => settlement(f, id).filter(event => event.kind === "answer");

describe("pi scoped Native Sessions on OpenShell mirror the Claude scoped session", () => {
  it("creates one owned pi-image session sandbox over HTTP, runs the governed answer_query route per turn, carries host-built history only and keeps one sandbox for every step", async () => {
    const f = await fixture(); const app = createApp(f.deps);
    const readiness = await (await app.request("/api/native-sessions/readiness")).json() as { analysis: { available: boolean; target: string; vendors: Record<string, { available: boolean }> }; runtimeSelection: { backends: Record<string, { state: string; offered: boolean }> }; runtime: { provider: string; target: string } };
    expect(readiness.analysis).toMatchObject({ available: true, target: "pi:scoped-events", vendors: { pi: { available: true }, claude: { available: false }, codex: { available: false } } });
    expect(readiness.runtimeSelection.backends).toMatchObject({ pi: { offered: true, state: "ready" }, claude: { offered: false, state: "not_offered" } }); expect(readiness.runtime).toMatchObject({ provider: "pi", target: "pi:scoped-events" });
    const launched = await post(app, { purpose: "analysis" });
    expect(launched.status, await launched.clone().text()).toBe(201);
    const { session, capability } = await launched.json() as { session: { id: string; transport: string; vendor: string; dispatchTarget: string; purpose: string }; capability: string };
    expect(session).toMatchObject({ transport: "scoped-events", vendor: "pi", dispatchTarget: "pi:scoped-events", purpose: "analysis" });
    expect(INTERACTIVE_TARGETS).not.toContain(session.dispatchTarget as never);
    for (const cap of [undefined, "44444444-4444-4444-8444-444444444444"]) {
      const denied = await post(app, { purpose: "analysis", intent: "open_existing", sessionId: session.id, ...(cap ? { capability: cap } : {}) });
      expect(denied.status).toBe(409); expect(await denied.json()).not.toHaveProperty("capability");
    }
    const reopened = await post(app, { purpose: "analysis", intent: "open_existing", sessionId: session.id, capability });
    expect(reopened.status).toBe(201); expect(await reopened.json()).toMatchObject({ session: { id: session.id }, capability });
    // Exactly one owned sandbox holding the session identity (its pi image selection is the driver's, tested there); nothing else was created.
    const held = f.sessionIntents(); expect(held).toHaveLength(1); expect(held[0]!.identity.purpose).toBe("model_session"); expect(f.record.creates).toEqual(["model_session"]);
    expect(f.record.controls).toEqual([{ sandbox: held[0]!.id, kind: "baseline" }]);
    const frames: any[] = [], attachment = f.native.attach(session.id, capability, frame => frames.push(frame))!;
    const pending = attachment.submit(REQUEST_A, "count orders"); attachment.detach(); await pending;
    const first = answers(f, session.id)[0]!.payload as { kind: string; answer: unknown };
    expect(first).toMatchObject({ kind: "answer" }); expect(JSON.stringify(first)).toMatch(/\\"n\\":7|"n":7/); expect(JSON.stringify(settlement(f, session.id))).not.toMatch(/999999|forged|dashboard/);
    expect(f.store.getLatestNativeStructuredAnswer(session.id)).toMatchObject({ grounded: true });
    const turnOneSteps = f.record.steps.length; expect(turnOneSteps).toBeGreaterThan(1);
    for (const step of f.record.steps) { expect(step.sandbox).toBe(held[0]!.id); expect(requestOf(step.input)).toEqual({ history: undefined, question: "count orders" }); }
    // A replayed request id runs nothing; the same id with another question is refused.
    const replay = f.native.attach(session.id, capability, frame => frames.push(frame))!; const count = f.record.streams;
    await replay.submit(REQUEST_A, "count orders"); expect(f.record.streams).toBe(count);
    await expect(replay.submit(REQUEST_A, "different question")).rejects.toThrow();
    // The follow-up sees the first verified answer only through host-built context.
    const cursor = f.native.history(session.id)!.through; await replay.submit(REQUEST_B, "and now again");
    expect(answers(f, session.id)).toHaveLength(2);
    const second = f.record.steps.slice(turnOneSteps); expect(second.length).toBeGreaterThan(1);
    // Exactly the first turn's validated answer, as persisted, and the new question: no user text, worklog, state, error or model prose.
    for (const step of second) expect(requestOf(step.input)).toEqual({ history: [first], question: "and now again" });
    // The model's own prose still flows between the steps of one turn (that is the plan's dataflow); it is never carried across turns.
    for (const step of second) expect(JSON.stringify(requestOf(step.input).history)).not.toMatch(/999999|forged|dashboard/);
    // Every step of both turns ran in the one session sandbox, each in its own step process with its own scope and a control cleanup in between.
    expect(f.sessionIntents().map(intent => intent.id)).toEqual(held.map(intent => intent.id)); expect(f.record.creates).toEqual(["model_session"]);
    expect(new Set(f.record.steps.map(step => step.scope)).size).toBe(f.record.steps.length);
    const trace = f.record.controls.map(row => row.kind); expect(trace[0]).toBe("baseline"); expect(trace.filter(kind => kind === "check")).toHaveLength(f.record.steps.length); expect(trace.filter(kind => kind === "cleanup")).toHaveLength(f.record.steps.length);
    for (let index = 1; index < trace.length; index += 2) { expect(trace[index]).toBe("check"); expect(trace[index + 1]).toBe("cleanup"); }
    expect(f.record.controls.filter(row => row.kind === "cleanup").map(row => row.receipt)).toEqual(f.record.steps.map(step => step.scope));
    expect(f.native.history(session.id, cursor)!.events.every(event => event.sequence > cursor)).toBe(true);
    expect(f.native.attach(session.id, "wrong", () => {})).toBeUndefined();
    for (let n = 0; n < 520; n++) f.store.appendNativeScopedEvent(session.id, null, "worklog", { steps: [] });
    expect(f.native.history(session.id, 0)!.truncated).toBe(true); expect(f.native.history(session.id, f.store.nativeScopedPrunedThrough(session.id))!.truncated).toBe(false);
    expect(f.verifyGateway.mock.calls.length).toBeGreaterThan(f.record.steps.length);
    expect(await f.native.stop(session.id, capability)).toBe(true); expect(f.store.getNativeSession(session.id)?.status).toBe("stopped");
    expect(f.resources.size).toBe(0); expect(f.sessionIntents().every(intent => intent.phase === "cleaned")).toBe(true); expect(f.local).not.toHaveBeenCalled();
    expect(settlement(f, session.id)).toContainEqual(expect.objectContaining({ kind: "state", payload: { state: "stopped", cleanup: "confirmed" } }));
  }, 180_000);

  it("shares Ask's root authority: the same question gives the Ask answer and the session answer the same grounded table", async () => {
    const f = await fixture(); await f.ask(); const ask = f.store.listEventsForTurn(f.turn.id).find(event => event.kind === "answer")!.payload as { answer: unknown };
    const launched = await f.native.open({ purpose: "analysis" }); const attachment = f.native.attach(launched.row.id, launched.capability, () => {})!;
    await attachment.submit(REQUEST_A, "count orders");
    expect(answers(f, launched.row.id)[0]!.payload).toEqual(expect.objectContaining({ kind: "answer", answer: (ask as { answer: unknown }).answer }));
  }, 180_000);

  it("refuses an unsupported purpose or profile, and an unready runtime, before any durable launch effect", async () => {
    const f = await fixture(); const before = f.store.listOpenShellIntents().length;
    await expect(f.native.open({ purpose: "setup" })).rejects.toThrow(); await expect(f.native.open({ purpose: "context_enrichment" })).rejects.toThrow(); await expect(f.native.open({ purpose: "analysis", profile: "custom" })).rejects.toThrow();
    expect(f.store.listNativeSessions()).toHaveLength(0); expect(f.store.listOpenShellIntents()).toHaveLength(before);
    await f.composition.lifecycle!.shutdown(); await expect(f.native.open({ purpose: "analysis" })).rejects.toThrow();
    expect(f.store.listNativeSessions()).toHaveLength(0); expect(f.resources.size).toBe(0);
  }, 180_000);

  it.each(["cancel", "stop"] as const)("%s aborts an active query, destroys the sandbox of the interrupted step, confirms cleanup and never persists a late answer", async operation => {
    const f = await fixture({ mode: "hold-query" }); const launched = await f.native.open({ purpose: "analysis" });
    const frames: any[] = [], attachment = f.native.attach(launched.row.id, launched.capability, frame => frames.push(frame))!;
    const pending = attachment.submit(REQUEST_C, "count orders"); await f.queryStarted; expect(f.record.queryClosed).toBe(0);
    if (operation === "cancel") await attachment.cancel(); else await f.native.stop(launched.row.id, launched.capability);
    await pending;
    expect(f.record.queryClosed).toBeGreaterThan(0); expect(f.resources.size).toBe(0);
    expect(f.store.getNativeSession(launched.row.id)?.status).toBe(operation === "cancel" ? "interrupted" : "stopped");
    expect(frames).toContainEqual(expect.objectContaining({ kind: "state", payload: { state: operation === "cancel" ? "interrupted" : "stopped", cleanup: "confirmed" } }));
    expect(f.store.getNativeScopedRequest(launched.row.id, REQUEST_C)?.status).toBe("cancelled");
    expect(answers(f, launched.row.id)).toEqual([]); expect(f.store.getLatestNativeStructuredAnswer(launched.row.id)).toBeUndefined();
    await expect(attachment.submit("44444444-4444-4444-8444-444444444444", "follow up")).rejects.toThrow();
    await f.native.shutdown(); expect(f.local).not.toHaveBeenCalled(); expect(f.sessionIntents().every(intent => intent.phase === "cleaned")).toBe(true);
  }, 180_000);

  it("detaching the browser never cancels the running turn, and the session answers once the browser is gone", async () => {
    const f = await fixture(); const launched = await f.native.open({ purpose: "analysis" }); const frames: any[] = [];
    const attachment = f.native.attach(launched.row.id, launched.capability, frame => frames.push(frame))!;
    const pending = attachment.submit(REQUEST_A, "count orders"); attachment.detach(); await pending;
    expect(f.store.getNativeSession(launched.row.id)?.status).toBe("detached"); expect(answers(f, launched.row.id)).toHaveLength(1);
    expect(f.store.getNativeScopedRequest(launched.row.id, REQUEST_A)?.status).toBe("complete");
  }, 180_000);

  it("two sessions hold different sandbox authority and reject cross-capability and settings reuse", async () => {
    const f = await fixture();
    const a = await f.native.open({ purpose: "analysis", requestId: REQUEST_A }), b = await f.native.open({ purpose: "analysis", requestId: REQUEST_B });
    await expect(f.native.open({ purpose: "analysis", id: a.row.id, capability: b.capability })).rejects.toThrow();
    expect(a.row.id).not.toBe(b.row.id); expect(a.capability).not.toBe(b.capability);
    const leases = f.sessionIntents(); expect(leases).toHaveLength(2); expect(new Set(leases.map(intent => intent.id)).size).toBe(2);
    expect(new Set(leases.map(intent => intent.identity.session))).toEqual(new Set([a.row.id, b.row.id]));
    expect(f.native.attach(a.row.id, b.capability, () => {})).toBeUndefined();
    // A step of one session never runs in the other's sandbox.
    const attachmentA = f.native.attach(a.row.id, a.capability, () => {})!, attachmentB = f.native.attach(b.row.id, b.capability, () => {})!;
    await attachmentA.submit(REQUEST_C, "count orders"); const aSandbox = leases.find(intent => intent.identity.session === a.row.id)!.id;
    expect(f.record.steps.length).toBeGreaterThan(0); for (const step of f.record.steps) expect(step.sandbox).toBe(aSandbox);
    const seen = f.record.steps.length; await attachmentB.submit("55555555-5555-4555-8555-555555555555", "count orders");
    const bSandbox = leases.find(intent => intent.identity.session === b.row.id)!.id;
    for (const step of f.record.steps.slice(seen)) expect(step.sandbox).toBe(bSandbox);
    expect(new Set(f.record.steps.map(step => step.scope)).size).toBe(f.record.steps.length);
    f.store.setRuntimeSettings({ ...f.store.getRuntimeSettings(), tierModels: [{ tier: "cheap", model: "model-cheap" }, { tier: "strong", model: "changed" }] });
    await expect(attachmentA.submit("66666666-6666-4666-8666-666666666666", "count orders")).rejects.toThrow();
    await expect(f.native.open({ purpose: "analysis", id: b.row.id, capability: b.capability })).rejects.toThrow();
    f.native.revoke([a.row.id, b.row.id]); await f.native.shutdown(); expect(f.resources.size).toBe(0);
  }, 180_000);

  it("lease-abort interruption waits for delayed query cleanup, then confirms only its session while another session stays active", async () => {
    const f = await fixture({ mode: "hold-query", delayedClose: true });
    const a = await f.native.open({ purpose: "analysis", requestId: REQUEST_A }), b = await f.native.open({ purpose: "analysis", requestId: REQUEST_B });
    const trace: string[] = [], frames: any[] = [];
    const attachment = f.native.attach(a.row.id, a.capability, frame => { frames.push(frame); if (frame.type === "event" && frame.kind === "state" && (frame.payload as any).cleanup === "confirmed") { trace.push("confirmed"); expect(f.record.querySettled).toBe(1); } })!;
    const pending = attachment.submit(REQUEST_C, "count orders"); await f.queryStarted;
    const cancelled = attachment.cancel(); await f.closeRequested;
    expect(f.record.querySettled).toBe(0); expect(frames.some(frame => frame.kind === "state" && frame.payload.cleanup === "confirmed")).toBe(false);
    trace.push("release-query-close"); f.releaseClose(); await cancelled; await pending;
    expect(trace).toEqual(["release-query-close", "confirmed"]);
    const events = settlement(f, a.row.id); const error = events.find(row => row.kind === "error")!, confirmed = events.find(row => row.kind === "state" && (row.payload as any).cleanup === "confirmed")!;
    expect(error.sequence).toBeLessThan(confirmed.sequence); expect(events.filter(row => row.kind === "answer")).toEqual([]);
    expect(f.store.getNativeSession(b.row.id)?.status).toBe("running"); expect(f.native.capability(b.row.id)).toBe(b.capability);
    await f.native.stop(b.row.id, b.capability); expect(f.resources.size).toBe(0);
  }, 180_000);

  it("an owned cleanup proof failure stays pending and can never become confirmed or a successful answer", async () => {
    const f = await fixture({ mode: "hold-query", cleanupProofFailure: true }); const a = await f.native.open({ purpose: "analysis" });
    const attachment = f.native.attach(a.row.id, a.capability, () => {})!;
    const pending = attachment.submit(REQUEST_C, "count orders"); await f.queryStarted; const rejected = expect(pending).rejects.toThrow();
    await expect(attachment.cancel()).rejects.toThrow(); await rejected;
    const events = settlement(f, a.row.id); expect(events).toContainEqual(expect.objectContaining({ kind: "state", payload: { state: "interrupted", cleanup: "pending" } }));
    expect(events.some(row => row.kind === "state" && (row.payload as any).cleanup === "confirmed")).toBe(false); expect(f.store.getLatestNativeStructuredAnswer(a.row.id)).toBeUndefined();
    await expect(f.native.shutdown()).rejects.toThrow();
  }, 180_000);
});

describe("revocation: an old capability is rejected before any root effect, and the exact lease is cleaned", () => {
  const changes: [string, (f: Fixture) => void][] = [
    ["a binding revision change", f => { const old = f.store.getEnrichmentBinding()!; f.store.activateEnrichmentBinding({ path: old.path, identity: old.identity, revision: `sha256:${"b".repeat(64)}` }); }],
    ["a runtime setting change", f => { f.store.setRuntimeSettings({ ...f.store.getRuntimeSettings(), tierModels: [{ tier: "cheap", model: "model-cheap" }, { tier: "strong", model: "other" }] }); }],
    ["a pi descriptor change", f => { f.boot.current = false; }],
    ["a native runtime generation change", f => { f.store.setRuntimeSettings({ ...f.store.getRuntimeSettings() }); }],
    ["a binding to another authentication mode", f => { f.store.setRuntimeSettings({ ...f.store.getRuntimeSettings(), authMode: "gateway", gatewayProvider: "vendor" }); }],
  ];
  it.each(changes)("%s", async (_name, change) => {
    const f = await fixture(); const a = await f.native.open({ purpose: "analysis" }); const attachment = f.native.attach(a.row.id, a.capability, () => {})!;
    const intentsBefore = f.store.listOpenShellIntents().length, stepsBefore = f.record.steps.length, queriesBefore = f.record.queries.length;
    change(f);
    await expect(attachment.submit(REQUEST_C, "count orders")).rejects.toThrow(); await expect(f.native.open({ purpose: "analysis", id: a.row.id, capability: a.capability })).rejects.toThrow();
    expect(f.store.listOpenShellIntents()).toHaveLength(intentsBefore); expect(f.record.steps).toHaveLength(stepsBefore); expect(f.record.queries).toHaveLength(queriesBefore);
    expect(f.store.getNativeScopedRequest(a.row.id, REQUEST_C)).toBeUndefined(); expect(f.store.getLatestNativeStructuredAnswer(a.row.id)).toBeUndefined();
    f.native.reconcile(a.row.id); await f.native.shutdown(); expect(f.resources.size).toBe(0); expect(f.store.getNativeSession(a.row.id)?.status).toBe("interrupted");
    expect(f.sessionIntents().filter(row => row.identity.session === a.row.id).every(row => row.phase === "cleaned")).toBe(true); expect(f.local).not.toHaveBeenCalled();
  }, 180_000);
  it("a gateway profile that stops verifying revokes the live session at once, with no further step", async () => {
    let tampered = false; const f = await fixture({ gatewayPollMs: 50, verifyGateway: async () => { if (tampered) throw new OpenShellError("openshell_identity_mismatch"); } });
    const a = await f.native.open({ purpose: "analysis" }); const attachment = f.native.attach(a.row.id, a.capability, () => {})!; expect(f.resources.size).toBe(1);
    tampered = true;
    const end = Date.now() + 8000; while (f.resources.size > 0 && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 25));
    expect(f.resources.size).toBe(0); await vi.waitFor(() => expect(f.store.getNativeSession(a.row.id)?.status).toBe("interrupted"), { timeout: 8000 });
    await expect(attachment.submit(REQUEST_C, "count orders")).rejects.toThrow(); expect(f.record.steps).toHaveLength(0); expect(f.record.queries).toHaveLength(0);
    expect(settlement(f, a.row.id)).toContainEqual(expect.objectContaining({ kind: "state", payload: { state: "interrupted", cleanup: "confirmed" } }));
  }, 180_000);
  it("no session is reserved when the gateway does not verify at creation, and no sandbox exists", async () => {
    const f = await fixture({ verifyGateway: async () => { throw new OpenShellError("openshell_identity_mismatch"); } });
    await expect(f.native.open({ purpose: "analysis" })).rejects.toThrow(); expect(f.store.listNativeSessions()).toHaveLength(0); expect(f.record.creates).toEqual([]); expect(f.resources.size).toBe(0);
    expect(await f.runtime.readiness({ mode: "api-key", adapter: "openai-compatible" })).toMatchObject({ backends: { pi: { state: "unavailable" } } });
  }, 180_000);
  it("runs no step once the gateway changed after the session was admitted: the turn ends without an answer and the session is interrupted", async () => {
    let changed = false; const f = await fixture({ verifyGateway: async () => { if (changed) throw new OpenShellError("openshell_identity_mismatch"); } });
    const a = await f.native.open({ purpose: "analysis" }); const attachment = f.native.attach(a.row.id, a.capability, () => {})!; changed = true;
    await attachment.submit(REQUEST_C, "count orders").catch(() => {});
    expect(f.record.steps).toHaveLength(0); expect(f.record.queries).toHaveLength(0); expect(answers(f, a.row.id)).toEqual([]);
    await vi.waitFor(() => expect(f.store.getNativeSession(a.row.id)?.status).toBe("interrupted"), { timeout: 10_000 }); expect(f.resources.size).toBe(0);
  }, 180_000);
});

describe("a failed session-step control leaves cleanup_pending and blocks reuse", () => {
  it("a baseline that cannot be taken: no session row has a sandbox, and the launch fails before any step", async () => {
    const f = await fixture({ control: { failBaseline: true } }); await expect(f.native.open({ purpose: "analysis" })).rejects.toThrow();
    expect(f.record.steps).toHaveLength(0); expect(f.resources.size).toBe(0); expect(f.store.listNativeSessions().every(row => row.status === "interrupted")).toBe(true); expect(f.sessionIntents().every(row => row.phase === "cleaned")).toBe(true);
  }, 180_000);
  it("a check that finds a process before the next step destroys the sandbox, fails the turn without an answer, and the session cannot be reused", async () => {
    const f = await fixture({ control: { failCheckOn: 2 } }); const a = await f.native.open({ purpose: "analysis" }); const attachment = f.native.attach(a.row.id, a.capability, () => {})!;
    await attachment.submit(REQUEST_C, "count orders");
    expect(answers(f, a.row.id)).toEqual([]); expect(f.store.getLatestNativeStructuredAnswer(a.row.id)).toBeUndefined(); expect(f.store.getNativeSession(a.row.id)?.status).toBe("interrupted");
    expect(f.resources.size).toBe(0); expect(f.sessionIntents().every(row => row.phase === "cleaned")).toBe(true);
    await expect(attachment.submit(REQUEST_B, "count orders")).rejects.toThrow(); await expect(f.native.open({ purpose: "analysis", id: a.row.id, capability: a.capability })).rejects.toThrow();
  }, 180_000);
  it("an uncertain step cleanup makes the session unusable even though the step itself ended normally", async () => {
    const f = await fixture({ control: { failCleanup: true } }); const a = await f.native.open({ purpose: "analysis" }); const attachment = f.native.attach(a.row.id, a.capability, () => {})!;
    await attachment.submit(REQUEST_C, "count orders");
    expect(answers(f, a.row.id)).toEqual([]); expect(f.store.getNativeSession(a.row.id)?.status).toBe("interrupted"); expect(f.resources.size).toBe(0);
    await expect(attachment.submit(REQUEST_B, "count orders")).rejects.toThrow();
  }, 180_000);
  it.each([["a receipt naming another step", { foreignReceipt: true }], ["no receipt before the frames", { noReceipt: true }]] as const)("%s fails the step and fences the session: no answer, sandbox destroyed", async (_name, control) => {
    const f = await fixture({ control }); const a = await f.native.open({ purpose: "analysis" }); const attachment = f.native.attach(a.row.id, a.capability, () => {})!;
    await attachment.submit(REQUEST_C, "count orders");
    expect(answers(f, a.row.id)).toEqual([]); expect(f.store.getLatestNativeStructuredAnswer(a.row.id)).toBeUndefined(); expect(f.store.getNativeSession(a.row.id)?.status).toBe("interrupted"); expect(f.resources.size).toBe(0);
    expect(f.record.queries.length).toBeLessThanOrEqual(0 + 1);
  }, 180_000);
});

describe("lifecycle states are distinct", () => {
  it("an idle detached session is stopped by the idle TTL, with confirmed cleanup", async () => {
    const f = await fixture(); const a = await f.native.open({ purpose: "analysis" }); const attachment = f.native.attach(a.row.id, a.capability, () => {})!;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }); attachment.detach();
    expect(f.store.getNativeSession(a.row.id)?.status).toBe("detached");
    await vi.advanceTimersByTimeAsync(30 * 60_000 + 1); vi.useRealTimers();
    await vi.waitFor(() => expect(f.store.getNativeSession(a.row.id)?.status).toBe("stopped"), { timeout: 10_000 });
    expect(f.resources.size).toBe(0); expect(settlement(f, a.row.id)).toContainEqual(expect.objectContaining({ kind: "state", payload: { state: "stopped", cleanup: "confirmed" } }));
  }, 180_000);
  it("a BFF restart shows the session as interrupted and never resumes it", async () => {
    const dbPath = path.join(realpathSync(mkdtempSync(path.join(os.tmpdir(), "openshell-pi-native-db-"))), "bff.sqlite");
    const f = await fixture({ dbPath }); const a = await f.native.open({ purpose: "analysis" }); const attachment = f.native.attach(a.row.id, a.capability, () => {})!;
    await attachment.submit(REQUEST_A, "count orders"); expect(answers(f, a.row.id)).toHaveLength(1);
    const restarted = new Store(dbPath, { nativeScopedVendor: "pi" });
    try {
      expect(restarted.getNativeSession(a.row.id)?.status).toBe("interrupted"); expect(restarted.getNativeSession(a.row.id)?.vendor).toBe("pi");
      // Nothing of the old process survives: the answers are replayable history, the sandbox is not resumable.
      expect(restarted.listNativeScopedEvents(a.row.id).filter(event => event.kind === "answer")).toHaveLength(1);
      const lifecycle = nativeSessionLifecycle(restarted.getNativeSession(a.row.id)!); expect(lifecycle).toMatchObject({ liveAction: "restart", resumeAvailable: false });
    } finally { restarted.close(); }
    await f.native.stop(a.row.id, a.capability); rmSync(path.dirname(dbPath), { recursive: true, force: true });
  }, 180_000);
  it("a session lost to a server-side interruption reads as interrupted, never as stopped", async () => {
    const f = await fixture({ mode: "hold-query" }); const a = await f.native.open({ purpose: "analysis" }); const attachment = f.native.attach(a.row.id, a.capability, () => {})!;
    const pending = attachment.submit(REQUEST_C, "count orders"); await f.queryStarted; f.runtime.revoke(); await pending.catch(() => {});
    await vi.waitFor(() => expect(f.store.getNativeSession(a.row.id)?.status).toBe("interrupted"), { timeout: 10_000 }); expect(f.resources.size).toBe(0);
  }, 180_000);
});

describe("a pi boot reports and gates native sessions on its own", () => {
  it("reports pi independently of the terminal vendors, and not ready when the saved binding is not an api-key or gateway one", async () => {
    const f = await fixture(); const app = createApp(f.deps);
    f.store.setRuntimeSettings({ ...f.store.getRuntimeSettings(), authMode: "subscription", subscriptionProvider: "claude", subscriptionDriverModel: "m" });
    const readiness = await (await app.request("/api/native-sessions/readiness")).json() as { analysis: { available: boolean; reason?: string; vendors: Record<string, { available: boolean }> }; runtime: { configured: boolean }; runtimeSelection: { backends: Record<string, { state: string }> } };
    expect(readiness.runtime.configured).toBe(false); expect(readiness.analysis).toMatchObject({ available: false }); expect(readiness.analysis.reason).toMatch(/pi/); expect(readiness.analysis.vendors.pi!.available).toBe(false); expect(readiness.runtimeSelection.backends.pi!.state).toBe("unavailable");
    expect([409, 503]).toContain((await post(app, { purpose: "analysis" })).status);
    expect(f.store.listNativeSessions()).toHaveLength(0); expect(f.record.creates).toEqual([]);
  }, 180_000);
  it("refuses setup, enrichment and a profile choice, and offers no resume for a pi session", async () => {
    const f = await fixture(); const app = createApp(f.deps);
    for (const body of [{ purpose: "setup" }, { purpose: "context_enrichment" }, { purpose: "analysis", profile: "custom" }, { purpose: "analysis", intent: "resume", sessionId: "x", idempotencyKey: REQUEST_A }]) {
      const response = await post(app, body); expect([400, 409, 503], JSON.stringify(body)).toContain(response.status);
    }
    expect(f.store.listNativeSessions()).toHaveLength(0); expect(f.record.creates).toEqual([]); expect(f.local).not.toHaveBeenCalled();
  }, 180_000);
});

describe("pi is never a host-terminal target", () => {
  const routes = ["/api/context/terminal/sessions", "/api/context/terminal/prepare"] as const;
  const piTargets = ["pi", "pi:interactive", "pi:scoped-events", "pi-coding-agent:interactive"];
  const send = (app: ReturnType<typeof createApp>, route: string, target: unknown) => app.request(route, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ target }) });
  it("has no pi member in INTERACTIVE_TARGETS", () => { expect(INTERACTIVE_TARGETS).toEqual(["claude-code:interactive", "codex:interactive"]); expect(INTERACTIVE_TARGETS.every(target => !target.startsWith("pi"))).toBe(true); });
  it.each(routes)("%s refuses every pi target with 400, including the value pi's own session row carries, and never reaches the terminal host", async route => {
    const f = await fixture(); const start = vi.fn(), prepare = vi.fn();
    // Without the OpenShell operation gate in front, the route's own target allow-list is what refuses.
    const app = createApp({ ...f.deps, structuredRuntime: undefined, startInteractiveTerminal: start, prepareInteractiveTerminal: prepare } as unknown as TurnDeps);
    expect(f.store.getNativeRuntimeBinding()).toMatchObject({ configured: true, provider: "pi", target: "pi:scoped-events" });
    for (const target of [...piTargets, undefined, "", 7, null]) { const response = await send(app, route, target); expect(response.status, String(target)).toBe(400); }
    expect(start).not.toHaveBeenCalled(); expect(prepare).not.toHaveBeenCalled();
    // A real terminal target is refused against the pi binding too: it never matches.
    expect((await send(app, route, "claude-code:interactive")).status).toBe(409); expect(start).not.toHaveBeenCalled(); expect(prepare).not.toHaveBeenCalled();
  }, 180_000);
  it.each(routes)("%s is refused as unsupported by the OpenShell operation gate on a pi boot, before any handler", async route => {
    const f = await fixture(); const start = vi.fn(), prepare = vi.fn(); const app = createApp({ ...f.deps, startInteractiveTerminal: start, prepareInteractiveTerminal: prepare } as unknown as TurnDeps);
    for (const target of [...piTargets, "claude-code:interactive", "codex:interactive"]) { const response = await send(app, route, target); expect(response.status, target).toBe(503); expect(await response.json()).toMatchObject({ code: "unsupported" }); }
    expect(start).not.toHaveBeenCalled(); expect(prepare).not.toHaveBeenCalled(); expect(f.record.creates).toEqual([]);
  }, 180_000);
  it("never resolves a pi binding to a terminal target or a terminal dispatch", () => {
    const binding = resolveNativeRuntimeBinding({ authMode: "byo", apiKeyAdapter: "openai-compatible", tierModels: [], hybrid: false, deployment: "personal" } as RuntimeSettings, true, 3, "pi");
    expect(binding).toEqual({ configured: true, generation: 3, provider: "pi", target: "pi:scoped-events", targetLabel: "pi" });
    expect(interactiveTargetOf(binding)).toBeUndefined(); expect(dispatchForPurpose("analysis", binding)).toBeUndefined();
  });
});
