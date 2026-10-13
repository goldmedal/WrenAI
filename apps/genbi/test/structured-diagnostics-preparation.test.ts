import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveWarbleBinary } from "../harness/compile/resolve-binary.js";
import { hashDirectory } from "../harness/compile/fingerprint.js";
import { openWrenComponentAccess } from "../harness/components/wren-access.js";
import * as compile from "../harness/compile/index.js";
import * as capturedContext from "../server/native-component-context.js";
import * as hostPlan from "../server/runtime-host/component-host-plan.js";
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

import type { StructuredDiagnosticObserver, StructuredDiagnosticRecord } from "../server/structured-diagnostics.js";
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); });
const digest = "sha256:" + "a".repeat(64);
const sql = "SELECT COUNT(*) AS n FROM orders";
const expected = { accountUuid: "11111111-1111-4111-8111-111111111111", organizationUuid: "22222222-2222-4222-8222-222222222222", email: "synthetic@example.test", subscription: "pro" as const };
async function fixture(diagnostics: StructuredDiagnosticObserver) {
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
  let providerBoundaries = 0;
  const identity = { image: digest, policy: digest, gateway: "synthetic", workspace: "default", configuration: digest };
  const never = async (): Promise<never> => { throw Error("No runtime or network permitted"); };
  const driver: OpenShellDriver = { version: "synthetic", identity, modelIdentity: identity, probe: async () => {}, create: never, list: never, inspect: never, remove: never, assertAbsent: never, exec: never, duplex: never };
  const composition = await createOpenShellRuntimeCompositionForTesting({ env: { GENBI_CLAUDE_RUNTIME: "openshell", GENBI_OPENSHELL_CONFIG: config }, store, stateRoot: path.join(root, "lifecycle"), driver, claude: { vault, duplex: driver.duplex! } });
  cleanup.push(async () => { await composition.shutdown(); store.close(); });
  composition.claudeProvider = () => { providerBoundaries++; throw Error("pre-SDK hardstop private-sentinel"); };
  const producer = await resolveWarbleBinary();
  const profileSource = path.join(application, "profiles/genbi-default");
  const provisioner = createOpenShellStructuredProvisioner({ composition, store, producerBinary: producer, wrenBinary: wren, profileSource, hostHome: root, sourceWrenHome: () => home, getBinding: () => store.getEnrichmentBinding(), modelsFor: settings => resolveStructuredClaudeModels(settings, () => "synthetic-model"), assertConfigurationCurrent() {}, diagnostics });
  const local = vi.fn(async () => { throw Error("No fallback"); });
  const runtime = new StructuredRuntime({ selected: { claude: "openshell", codex: "local" }, allowLocal: false, localRoute: local, localSetupFor: () => undefined, adapters: { claude: createOpenShellStructuredAdapter(provisioner, diagnostics) }, diagnostics });
  const app = createApp({ store, structuredRuntime: runtime, route: local, baseRouteOptions: { authChoice: { mode: "subscription", provider: "claude" }, profileSource, userProject: project } });
  return { root, store, runtime, app, local, providerBoundaries: () => providerBoundaries };
}

it.each(["after_compile", "after_context", "after_plan", "before_provider"] as const)("actual HTTP Ask retains %s before generic wrapper, with no SDK/network/runtime", async variant => {
  const records: StructuredDiagnosticRecord[] = [];
  if (variant === "after_compile") { const original = compile.compileProfile; vi.spyOn(compile, "compileProfile").mockImplementation(async (...args) => { await original(...args); throw Error("private-sentinel after compile"); }); }
  if (variant === "after_context") { const original = capturedContext.prepareCapturedStructuredAskHost; vi.spyOn(capturedContext, "prepareCapturedStructuredAskHost").mockImplementation(async (...args) => { await original(...args); throw Error("private-sentinel after context"); }); }
  if (variant === "after_plan") { const original = hostPlan.produceComponentHostPlan; vi.spyOn(hostPlan, "produceComponentHostPlan").mockImplementation(async (...args) => { await original(...args); throw Error("private-sentinel after plan"); }); }
  const f = await fixture(record => records.push(record));
  const session = f.store.createSession("analysis");
  const created = await f.app.request(`/api/sessions/${session.id}/turns`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ question: "count orders" }) });
  expect(created.status).toBe(200); const { turnId } = await created.json() as { turnId: string };
  const response = await f.app.request(`/api/sessions/${session.id}/stream?turn=${encodeURIComponent(turnId)}`); const text = await response.text();
  expect(f.store.getTurn(turnId)).toMatchObject({ backend: null, resultKind: "error", answerSummary: null, errorMessage: "Structured runtime failed." });
  const stage = { after_compile: "compile_profile", after_context: "context_capture", after_plan: "host_plan", before_provider: "provider_setup" }[variant];
  expect(records.find(record => record.state === "failed"), JSON.stringify(records)).toEqual({ stage, state: "failed", reason: "unknown" });
  expect(f.providerBoundaries()).toBe(variant === "before_provider" ? 1 : 0);
  expect(records.some(record => record.stage === "provider_open")).toBe(false);
  expect(JSON.stringify(records) + text).not.toContain("private-sentinel");
  expect(f.store.listOpenShellIntents()).toEqual([]); expect(f.local).not.toHaveBeenCalled();
  await f.runtime.shutdown();
}, 120_000);
