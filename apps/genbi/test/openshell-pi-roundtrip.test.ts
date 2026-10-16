import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveWarbleBinary } from "../harness/compile/resolve-binary.js";
import { hashDirectory } from "../harness/compile/fingerprint.js";
import { openWrenComponentAccess } from "../harness/components/wren-access.js";
import type { ComponentLimits } from "../harness/components/runner.js";
import { openOpenShellWrenAccess } from "../server/runtime-host/openshell-wren-access.js";
import { Store } from "../server/db.js";
import { OpenShellError, type OpenShellDriver, type OpenShellDuplex, type OpenShellResource } from "../server/runtime-host/openshell-types.js";
import { createOpenShellRuntimeComposition } from "../server/openshell-runtime-composition.js";
import { createOpenShellStructuredProvisioner } from "../server/openshell-structured-provisioner.js";
import { createOpenShellStructuredAdapter } from "../server/openshell-structured-ask.js";
import { StructuredRuntime } from "../server/structured-runtime.js";
import { resolveRuntimeSelection } from "../server/runtime-selection.js";
import { resolveNativeExecutable } from "../server/native-runtime-spec.js";
import { piProviderConfig, type OpenShellPiBoot, type OpenShellPiBootDescriptor } from "../server/runtime-host/openshell-pi-boot.js";
import { piAccountDigest } from "../server/runtime-host/openshell-pi-provider.js";
import { validatePiRuntimeBindings } from "../server/runtime-binding.js";
import { streamTurn, effectiveRouteOptions, type TurnDeps } from "../server/turn.js";
import { createApp } from "../server/app.js";
import type { RuntimeSettings } from "../server/wire-types.js";
import { PiSim, happyBehavior, type Bootstrap } from "./pi-sim.js";

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); });
const digest = `sha256:${"a".repeat(64)}`;
const sql = "SELECT COUNT(*) AS n FROM orders";
const KEY_ENV = ["OPENAI_API_KEY", "GENBI_GATEWAY_API_KEY", "ANTHROPIC_API_KEY", "WREN_HARNESS_API_KEY"] as const;
type Mode = "answer" | "hold-query" | "no-query" | "model-length" | "delete" | "big-limit" | "query-error";
interface Controls { mode?: Mode; componentLimits?: ComponentLimits; change?: (ctx: { store: Store; project: string; boot: { current: boolean } }) => void; gatewayPollMs?: number; verifyGateway?: () => Promise<void>; }

/** The pi worker is scripted; every frame it emits is judged by the real host protocol, broker and governed data path. */
function piBehavior(ctx: { mode: Mode; receipt: { streams: number; calls: number }; change: () => void }): ConstructorParameters<typeof PiSim>[0] {
  let inner: ReturnType<typeof happyBehavior> | undefined;
  const text = JSON.stringify({ columns: ["n"], rows: [{ n: 999999 }], verified: true, definition: { sql }, artifact: { kind: "dashboard", forged: true } });
  return {
    onBootstrap(sim: PiSim, boot: Bootstrap) {
      ctx.receipt.streams++;
      const at = boot.argv.indexOf("--tools"); const tools = at < 0 ? [] : boot.argv[at + 1]!.split(",");
      const query = tools.find(name => name.endsWith("query_read_only"));
      const statement = ctx.mode === "delete" ? "DELETE FROM orders" : sql;
      const args = ctx.mode === "big-limit" ? { sql, limit: 99_999_999 } : { sql: statement };
      inner = happyBehavior({ ...(query && ctx.mode !== "no-query" ? { call: { name: query.replace(/^mcp__component__/, ""), args } } : {}), text, ...(ctx.mode === "model-length" ? { stop: "length" } : {}) });
      inner.onBootstrap(sim, boot);
    },
    onFrame(sim: PiSim, frame) {
      if (frame.t === "mcp" && sim.frames.filter(item => item.t === "mcp").length === 2) { ctx.change(); ctx.receipt.calls++; }
      inner!.onFrame(sim, frame);
    },
  };
}

async function fixture(controls: Controls = {}) {
  const mode = controls.mode ?? "answer";
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "openshell-pi-roundtrip-")));
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
  /** The real governed worker is the oracle and the policy: it answers, rejects and limits exactly as production does. */
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
  const store = new Store(":memory:");
  store.setRuntimeSettings({ authMode: "byo", apiKeyAdapter: "openai-compatible", tierModels: [{ tier: "cheap", model: "model-cheap" }, { tier: "strong", model: "model-strong" }], hybrid: false, deployment: "personal" });
  store.activateEnrichmentBinding({ path: project, identity: "synthetic-project", revision: digest });

  const descriptor: OpenShellPiBootDescriptor = Object.freeze({ version: 1, gatewayUrl: "https://localhost:9443/", caCert: "/a", clientCert: "/b", clientKey: "/c", auth: "api-key", provider: "vendor-provider", profileId: "vendor-profile",
    displayLabel: "synthetic vendor", profileDigest: digest, generation: "gen-1", endpoint: { providerId: "vendor", api: "openai-completions", baseUrl: "https://api.vendor.example.test/v1", credentialEnv: "VENDOR_KEY" },
    models: { cheap: "model-cheap", strong: "model-strong" } }) as OpenShellPiBootDescriptor;
  const bootState = { current: true };
  const resources = new Map<string, OpenShellResource>();
  const receipt = { streams: 0, calls: 0, creates: 0, queries: [] as string[], limits: [] as unknown[], answers: 0, intentModels: [] as string[] };
  const sims: PiSim[] = [];
  let queryStartedResolve!: () => void; const queryStarted = new Promise<void>(resolve => { queryStartedResolve = resolve; });
  const identity = { image: digest, policy: digest, gateway: "synthetic", workspace: "default", configuration: digest };
  const driver: OpenShellDriver = { version: "synthetic", identity, modelIdentity: identity, probe: async () => {},
    create: async intent => { receipt.creates++; if (intent.identity.purpose === "model") receipt.intentModels.push(`${intent.identity.tier}:${intent.identity.model}`); const resource = { id: intent.id, name: intent.name, workspace: "default", labels: { "genbi-lifecycle-owner": intent.owner } }; resources.set(intent.name, resource); return resource; },
    list: async intent => [...resources.values()].filter(resource => resource.name === intent.name), inspect: async intent => resources.get(intent.name)!, remove: async intent => { resources.delete(intent.name); },
    assertAbsent: async intent => { expect(resources.has(intent.name)).toBe(false); },
    exec: async () => JSON.stringify({ type: "genbi.pi.procs", version: 1, remaining: 0 }),
    duplex: async intent => { if (intent.identity.purpose !== "model") throw Error("not a model step"); const sim = new PiSim(piBehavior({ mode, receipt, change: () => controls.change?.({ store, project, boot: bootState }) })); sims.push(sim); return sim.stream; } };
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
        receipt.queries.push(request.sql); receipt.limits.push(request.limit); queryStartedResolve();
        if (mode === "hold-query") return;
        const reply = mode === "query-error" ? { id: request.id, error: { class: "execution_failed", message: "synthetic private SQL/token/path must not escape" } }
          : (() => { const answer = governed({ ...request, id: 1 })[1]!; return answer.error ? { id: request.id, error: answer.error } : { id: request.id, result: answer.result }; })();
        chunks.push(Buffer.from(JSON.stringify(reply) + "\n")); wake?.();
      },
      close() { closed = true; wake?.(); } };
    return openOpenShellWrenAccess({ expected: tuple, signal, assertCurrent: check, lease: { id: "synthetic-data", reference: "synthetic-ref", assertActive: check,
      async verify() { check(); return { digest } as never; }, async read() { return Buffer.from(JSON.stringify({ models: ["orders"] })); }, async openGoverned() { return dataStream; }, async close() { dataStream.close(); } } });
  });
  cleanup.push(async () => { await composition.shutdown(); store.close(); });
  const producer = await resolveWarbleBinary();
  const profileSource = path.join(application, "profiles/genbi-default");
  const provisioner = createOpenShellStructuredProvisioner({ composition, store, ...(controls.componentLimits ? { componentLimits: controls.componentLimits } : {}), ...(controls.gatewayPollMs ? { gatewayPollMs: controls.gatewayPollMs } : {}),
    producerBinary: producer, wrenBinary: wren, profileSource, hostHome: root, sourceWrenHome: () => home, getBinding: () => store.getEnrichmentBinding(),
    modelsFor: () => { throw new Error("the Claude model resolver must never run for a pi boot"); }, assertConfigurationCurrent() { boot.assertCurrent(); } });
  expect(provisioner.reserveSession).toBeUndefined();
  const local = vi.fn(async () => { throw Error("in-process fallback forbidden"); });
  const adapter = createOpenShellStructuredAdapter(provisioner, undefined, "pi");
  const runtime = new StructuredRuntime({ selection, localRoute: local, localSetupFor: () => undefined, adapters: { pi: adapter }, onRevoke: composition.revokeRuntime });
  const deps = { store, structuredRuntime: runtime, route: local, piRuntime: { validate: (settings: RuntimeSettings, tiers: readonly string[]) => validatePiRuntimeBindings(settings, tiers, boot.descriptor.models, boot.descriptor.auth) },
    getRuntimeTierNames: async () => ["cheap", "strong"], setAuthChoice() {},
    baseRouteOptions: { ...(controls.componentLimits ? { componentLimits: controls.componentLimits } : {}), authChoice: { mode: "api-key", adapter: "openai-compatible" }, profileSource, userProject: project, question: "count orders" } } as unknown as TurnDeps;
  const session = store.createSession("analysis"), turn = store.createTurn({ id: "synthetic-turn", sessionId: session.id, question: "count orders", composedInput: null });
  const ask = async (signal?: AbortSignal) => { const frames: { event: string; data: unknown }[] = []; await streamTurn(deps, session.id, turn.id, async frame => { frames.push(frame as never); }, signal); return { frames, stored: store.getTurn(turn.id)! }; };
  return { root, project, store, composition, runtime, local, deps, session, turn, receipt, resources, sims, boot: bootState, verifyGateway, queryStarted, ask, governed, descriptor, profileSource };
}
const noAnswerHappened = (f: Awaited<ReturnType<typeof fixture>>, stored: ReturnType<Store["getTurn"]>) => {
  expect(stored).not.toMatchObject({ resultKind: "answer" });
  expect(f.store.listEventsForTurn(f.turn.id).some(event => event.kind === "answer")).toBe(false);
  expect(f.resources.size).toBe(0); expect(f.store.listOpenShellIntents().every(intent => intent.phase === "cleaned")).toBe(true);
  expect(f.local).not.toHaveBeenCalled();
};
/**
 * Records every application read of the vendor key variables. Node's own child-process spawn copies the whole
 * environment into a child that is given no explicit one (the profile compiler and the context loader); that implicit
 * inheritance is reported separately because it predates this boot and is not a read by the Ask.
 */
const recordingEnv = () => {
  const reads: string[] = [], inherited: string[] = []; const original = process.env;
  const target = Object.fromEntries(Object.entries(original)); for (const name of KEY_ENV) target[name] = `synthetic-${name.toLowerCase()}-must-never-be-used`;
  const note = (property: unknown) => { if (typeof property !== "string" || !(KEY_ENV as readonly string[]).includes(property)) return; (new Error().stack ?? "").includes("normalizeSpawnArguments") ? inherited.push(property) : reads.push(property); };
  process.env = new Proxy(target, { get(object, property) { note(property); return Reflect.get(object, property); }, has(object, property) { note(property); return Reflect.has(object, property); } }) as NodeJS.ProcessEnv;
  return { reads, inherited, restore() { process.env = original; } };
};

describe("pi OpenShell Structured Ask: the full scoped path with a scripted worker", () => {
  it("answers answer_query through scope, runtime, broker and the governed worker, persisting one verified root and ignoring everything the model says", async () => {
    const f = await fixture(); const app = createApp(f.deps);
    const readiness = await (await app.request("/api/structured-runtime/readiness")).json();
    expect(readiness).toMatchObject({ backends: { pi: { backend: "openshell", state: "ready", ask: true, setup: false, modelExecution: "openshell", queryExecution: "openshell", supportedAgents: ["answer_query"] } }, active: { backend: "openshell", ask: true } });
    const { frames, stored } = await f.ask();
    expect(stored, JSON.stringify(frames).slice(0, 800)).toMatchObject({ backend: "openshell", resultKind: "answer" });
    expect(JSON.parse(stored.answerSummary!)).toEqual([{ type: "table", columns: ["n"], rows: [{ n: 7 }] }, { type: "definition", sql, source_tables: ["orders"], filters: [] }]);
    // The UI trace shows the host-executed query tool and the host's verify gate, never anything the model claimed.
    const worklog = frames.filter(frame => frame.event === "worklog").at(-1)!.data as { label: string; kind: string; detail?: string }[];
    expect(worklog.some(row => row.kind === "tool" && row.label === "query_read_only")).toBe(true);
    expect(worklog.find(row => row.kind === "decision")?.detail).toContain("verified by the host")
    expect(JSON.stringify([stored, frames])).not.toMatch(/999999|forged|dashboard/);
    expect(frames.filter(frame => frame.event === "event").map(frame => (frame.data as { kind: string }).kind)).toEqual(["answer"]);
    expect(f.store.listEventsForTurn(f.turn.id).filter(event => event.kind === "answer")).toHaveLength(1);
    expect(f.receipt.queries).toEqual([sql]); expect(f.receipt.streams).toBeGreaterThan(1);
    // Every step ran in its own owned sandbox with exactly the host-pinned model of its tier, and each one was cleaned.
    expect(new Set(f.receipt.intentModels).size).toBeGreaterThan(0);
    for (const entry of f.receipt.intentModels) expect(["cheap:model-cheap", "strong:model-strong"]).toContain(entry);
    expect(f.store.listOpenShellIntents().length).toBe(f.receipt.creates); expect(f.store.listOpenShellIntents().every(intent => intent.phase === "cleaned")).toBe(true);
    expect(f.resources.size).toBe(0); expect(f.local).not.toHaveBeenCalled(); expect(f.verifyGateway.mock.calls.length).toBeGreaterThan(f.receipt.streams);
    // A replay serves the stored turn; nothing runs and nothing is persisted twice.
    const before = { ...f.receipt, queries: [...f.receipt.queries] };
    await f.ask(); expect(f.receipt.queries).toEqual(before.queries); expect(f.receipt.streams).toBe(before.streams);
    expect(f.store.listEventsForTurn(f.turn.id).filter(event => event.kind === "answer")).toHaveLength(1);
  }, 180_000);

  it("never reads a vendor key: the Ask succeeds with the key variables unset, and ignores them when they are set", async () => {
    const f = await fixture();
    const env = recordingEnv();
    try {
      effectiveRouteOptions(f.deps); effectiveRouteOptions(f.deps);
      const { stored } = await f.ask();
      expect(stored).toMatchObject({ resultKind: "answer", backend: "openshell" });
      expect(env.reads, "no vendor key variable may be read while the Ask is prepared, routed or run").toEqual([]);
      expect(JSON.stringify(f.store.listEventsForTurn(f.turn.id))).not.toContain("must-never-be-used");
    } finally { env.restore(); }
    for (const name of KEY_ENV) delete process.env[name];
    const second = await fixture(); const { stored } = await second.ask();
    expect(stored).toMatchObject({ resultKind: "answer", backend: "openshell" }); expect(second.local).not.toHaveBeenCalled();
  }, 180_000);

  it("routes api-key and gateway auth to the pi adapter only, with no in-process route and no tier binding", async () => {
    const f = await fixture();
    const options = effectiveRouteOptions(f.deps);
    expect(options).toMatchObject({ authChoice: { mode: "api-key" } }); expect(options.tierBinding).toBeUndefined(); expect(options.modelsConfig).toBeUndefined(); expect(options.codexModels).toBeUndefined();
    expect(JSON.stringify(options.authChoice)).not.toMatch(/apiKey/);
  });

  describe("what a model or a worker says never completes the Ask", () => {
    it.each([["a model that never calls the query tool and claims rows and an artifact", "no-query"], ["a model failure after the tool (stopReason length)", "model-length"]] as const)("is not an answer for %s", async (_name, mode) => {
      const f = await fixture({ mode }); const { stored } = await f.ask();
      expect(stored).toMatchObject({ resultKind: "error" }); noAnswerHappened(f, stored);
      expect(JSON.stringify(f.store.listEventsForTurn(f.turn.id))).not.toMatch(/999999|forged/);
    }, 180_000);
    it("does not persist an answer for a data failure and records only the host's terminal query cause", async () => {
      const f = await fixture({ mode: "query-error" }); const { stored } = await f.ask();
      expect(stored).toMatchObject({ resultKind: "refusal", errorCode: "query.execution_failed" }); noAnswerHappened(f, stored);
      expect(JSON.stringify(stored)).not.toMatch(/private SQL|token|path must not escape/);
    }, 180_000);
  });

  describe("tools stay constrained by the host", () => {
    it("runs read-only SQL only: a write is rejected by the governed worker, changes nothing and records the policy cause", async () => {
      const f = await fixture({ mode: "delete" }); const { stored } = await f.ask();
      expect(f.receipt.queries).toEqual(["DELETE FROM orders"]);
      expect(stored).toMatchObject({ resultKind: "error", errorCode: "query.policy_rejected" }); noAnswerHappened(f, stored);
      expect(f.governed({ id: 1, operation: "query", sql, limit: 10 })[1]).toMatchObject({ result: { rows: [{ n: 7 }] } });
    }, 180_000);
    it("caps the row limit the model asks for at the host's row guard", async () => {
      const f = await fixture({ mode: "big-limit" }); await f.ask();
      expect(f.receipt.limits.length).toBeGreaterThan(0);
      for (const limit of f.receipt.limits) expect(limit).toBeLessThanOrEqual(10_000);
    }, 180_000);
  });

  describe("revocation: no answer, confirmed cleanup, no effects", () => {
    it.each([
      ["a runtime setting change", ({ store }: { store: Store }) => { store.setRuntimeSettings({ ...store.getRuntimeSettings(), tierModels: [{ tier: "cheap", model: "model-cheap" }, { tier: "strong", model: "other-model" }] }); }],
      ["a binding revision change", ({ store, project }: { store: Store; project: string }) => { store.activateEnrichmentBinding({ path: project, identity: "synthetic-project", revision: `sha256:${"b".repeat(64)}` }); }],
      ["a pi descriptor change", ({ boot }: { boot: { current: boolean } }) => { boot.current = false; }],
    ])("revokes on %s before the first tool call is answered", async (_name, change) => {
      const f = await fixture({ change: change as never }); const { stored } = await f.ask();
      expect(f.receipt.calls).toBeGreaterThan(0); noAnswerHappened(f, stored);
      expect(f.store.listEventsForTurn(f.turn.id).filter(event => event.kind === "answer")).toHaveLength(0);
    }, 180_000);
    it("revokes on a native runtime generation change", async () => {
      let generations: [number, number] | undefined;
      const f = await fixture({ change: ({ store }) => { const before = store.getNativeRuntimeBinding().generation; store.setRuntimeSettings({ ...store.getRuntimeSettings(), authMode: "gateway", gatewayProvider: "vendor" }); generations = [before, store.getNativeRuntimeBinding().generation]; } });
      const { stored } = await f.ask(); noAnswerHappened(f, stored);
      expect(generations?.[1], JSON.stringify(generations)).toBeGreaterThanOrEqual(generations![0]);
    }, 180_000);
    it("revokes when the runtime is revoked while a step is running", async () => {
      const f = await fixture({ mode: "hold-query" }); const pending = f.ask();
      await f.queryStarted; f.runtime.revoke(); const { stored } = await pending;
      expect(stored).toMatchObject({ resultKind: "error" }); noAnswerHappened(f, stored);
    }, 180_000);
    it("cancels on the caller's abort while a query is in flight, confirming transport and worker cleanup", async () => {
      const f = await fixture({ mode: "hold-query" }); const controller = new AbortController(); const pending = f.ask(controller.signal);
      await f.queryStarted; controller.abort(); const { stored } = await pending;
      expect(stored).toMatchObject({ resultKind: "error" }); noAnswerHappened(f, stored); expect(f.sims.every(sim => sim.closeCalls > 0 || sim.exited)).toBe(true);
    }, 180_000);
    it("times out at the run budget and cleans up", async () => {
      const f = await fixture({ mode: "hold-query", componentLimits: { timeoutMs: 4000 } as ComponentLimits });
      const { stored } = await f.ask();
      expect(stored).toMatchObject({ resultKind: "error" }); noAnswerHappened(f, stored); expect(f.receipt.queries).toEqual([sql]);
    }, 180_000);
  });

  describe("gateway profile and provider verification fails closed", () => {
    const mismatch = () => { throw new OpenShellError("openshell_identity_mismatch"); };
    it("reports unready and creates no sandbox when the gateway objects do not verify at Ask admission", async () => {
      const f = await fixture({ verifyGateway: async () => mismatch() });
      const readiness = await f.runtime.readiness({ mode: "api-key", adapter: "openai-compatible" });
      expect(readiness.backends.pi).toMatchObject({ state: "unavailable", ask: false, code: "openshell_identity_mismatch" }); expect(readiness.active).toMatchObject({ ask: false });
      const { stored } = await f.ask();
      expect(stored).toMatchObject({ resultKind: "error" }); noAnswerHappened(f, stored); expect(f.receipt.creates).toBe(0); expect(f.receipt.queries).toEqual([]);
    }, 180_000);
    it("refuses to launch a step sandbox once the gateway changed after admission", async () => {
      // Calls: boot, readiness probe, prepare, then the first step launch.
      let calls = 0; const f = await fixture({ verifyGateway: async () => { if (++calls > 3) mismatch(); } });
      const { stored } = await f.ask();
      expect(stored).toMatchObject({ resultKind: "error" }); noAnswerHappened(f, stored); expect(f.receipt.creates).toBe(0);
    }, 180_000);
    it("cancels a running Ask promptly when the gateway profile changes mid-run", async () => {
      let tampered = false; const f = await fixture({ mode: "hold-query", gatewayPollMs: 100, verifyGateway: async () => { if (tampered) mismatch(); } });
      const pending = f.ask(); await f.queryStarted; tampered = true;
      const { stored } = await pending;
      expect(stored).toMatchObject({ resultKind: "error" }); expect(stored.errorCode).toBe("runtime.stale"); noAnswerHappened(f, stored);
    }, 180_000);
    it("refuses to return an answer when the gateway changed after the last step", async () => {
      let tampered = false; const f = await fixture({ change: () => { tampered = true; }, verifyGateway: async () => { if (tampered && f.receipt.queries.length > 0) mismatch(); } });
      const { stored } = await f.ask();
      expect(stored).not.toMatchObject({ resultKind: "answer" }); noAnswerHappened(f, stored);
    }, 180_000);
  });

  describe("only Ask is available under a pi boot", () => {
    it("refuses a subscription Ask without running anything, locally or in a sandbox", async () => {
      const f = await fixture(); (f.deps as { getAuthChoice?: () => unknown }).getAuthChoice = () => ({ mode: "subscription", provider: "claude" });
      const app = createApp(f.deps);
      const response = await app.request(`/api/sessions/${f.session.id}/turns`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ question: "count orders" }) });
      expect(response.status).toBe(503); expect(f.receipt.creates).toBe(0); expect(f.local).not.toHaveBeenCalled();
      await expect(f.runtime.route({ authChoice: { mode: "subscription", provider: "claude" }, profileSource: f.profileSource, userProject: f.project, question: "x" }, { sessionId: "s", turnId: "t", assertCurrent() {} })).rejects.toMatchObject({ code: "unavailable" });
      expect(f.local).not.toHaveBeenCalled(); expect(f.receipt.creates).toBe(0);
    });
    it.each(["/api/setup/connect", "/api/setup/adopt", "/api/native-sessions", "/api/context/enrichment/start", "/api/context/terminal/sessions"])("refuses %s", async route => {
      const f = await fixture(); const app = createApp(f.deps);
      const response = await app.request(route, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      expect(response.status).toBe(503); expect(await response.json()).toMatchObject({ code: "unsupported" }); expect(f.receipt.creates).toBe(0); expect(f.local).not.toHaveBeenCalled();
    });
    it("refuses an Ask whose authentication mode is not the one the descriptor serves, before any sandbox exists", async () => {
      const f = await fixture(); (f.deps as { getAuthChoice?: () => unknown }).getAuthChoice = () => ({ mode: "gateway", config: { provider: "vendor" } });
      const { stored } = await f.ask();
      expect(stored).toMatchObject({ resultKind: "error" }); noAnswerHappened(f, stored); expect(f.receipt.creates).toBe(0); expect(f.receipt.queries).toEqual([]);
    }, 180_000);
    it("refuses a hybrid runtime and a dashboard agent", async () => {
      const f = await fixture(); f.store.setRuntimeSettings({ ...f.store.getRuntimeSettings(), hybrid: true });
      expect(await f.runtime.readiness({ mode: "api-key", adapter: "openai-compatible" })).toMatchObject({ backends: { pi: { ask: false, state: "unavailable" } } });
      const { stored } = await f.ask(); expect(stored).toMatchObject({ resultKind: "error" }); noAnswerHappened(f, stored); expect(f.receipt.creates).toBe(0);
      const dashboards = await fixture();
      await expect(dashboards.runtime.route({ ...effectiveRouteOptions(dashboards.deps), question: "x", agentId: "generate_dashboard" } as never, { sessionId: "s", turnId: "t", assertCurrent() {} })).rejects.toMatchObject({ code: "unsupported" });
      expect(dashboards.receipt.creates).toBe(0); expect(dashboards.local).not.toHaveBeenCalled();
    });
  });

  describe("saving the runtime for a pi boot", () => {
    const put = async (f: Awaited<ReturnType<typeof fixture>>, patch: Record<string, unknown>) => createApp(f.deps).request("/api/config/runtime", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(patch) });
    it("accepts exactly the pinned models with no key in the environment and no base URL", async () => {
      const env = recordingEnv();
      try {
        const f = await fixture();
        const ok = await put(f, { authMode: "byo", apiKeyAdapter: "openai-compatible", tierModels: [{ tier: "cheap", model: "model-cheap" }, { tier: "strong", model: "model-strong" }] });
        expect(ok.status, JSON.stringify(await ok.clone().json())).toBe(200);
        expect(env.reads).toEqual([]);
      } finally { env.restore(); }
    });
    it.each([
      ["a model alias", { tierModels: [{ tier: "cheap", model: "sonnet" }, { tier: "strong", model: "model-strong" }] }],
      ["inherit", { tierModels: [{ tier: "cheap", model: "inherit" }, { tier: "strong", model: "model-strong" }] }],
      ["a model that is not the tier's pin", { tierModels: [{ tier: "cheap", model: "model-strong" }, { tier: "strong", model: "model-strong" }] }],
      ["a base URL on a tier", { tierModels: [{ tier: "cheap", model: "model-cheap", baseURL: "https://evil.example.test/v1" }, { tier: "strong", model: "model-strong" }] }],
      ["a base URL in the settings", { apiKeyBaseURL: "https://evil.example.test/v1" }],
      ["a missing tier", { tierModels: [{ tier: "cheap", model: "model-cheap" }] }],
      ["an unknown tier", { tierModels: [{ tier: "cheap", model: "model-cheap" }, { tier: "strong", model: "model-strong" }, { tier: "extra", model: "model-cheap" }] }],
      ["another authentication mode", { authMode: "gateway", gatewayProvider: "vendor" }],
    ])("rejects %s", async (_name, patch) => {
      const f = await fixture(); const before = JSON.stringify(f.store.getRuntimeSettings());
      const response = await put(f, { authMode: "byo", apiKeyAdapter: "openai-compatible", tierModels: [{ tier: "cheap", model: "model-cheap" }, { tier: "strong", model: "model-strong" }], ...patch });
      expect(response.status).toBe(400); expect(JSON.stringify(f.store.getRuntimeSettings())).toBe(before);
    });
  });
});
