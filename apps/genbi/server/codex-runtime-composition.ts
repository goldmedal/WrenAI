import { lstatSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { Store } from "./db.js";
import type { EnrichmentBinding } from "./enrichment.js";
import type { NativeArtifactService } from "./native-artifacts.js";
import { codexModelsForRuntime } from "./runtime-binding.js";
import { compileProfile } from "../harness/compile/index.js";
import { resolveContextLoaderBinary } from "../harness/compile/context-loader.js";
import { attestNativeExecutable, assertNativeExecutableIdentity, buildNativeRuntimeSpec } from "./native-runtime-spec.js";
import { createEmptyCodexWrenHome } from "./native-wren-home.js";
import { prepareCapturedCodexDirectTools } from "./native-component-context.js";
import { CodexAppServerBackend, CodexBackendError, type CodexLaunchPermit } from "./runtime-host/codex-app-server.js";
import type { CodexSessionTools } from "./runtime-host/codex-direct-tools.js";
import type { RpcTransport } from "./runtime-host/codex-rpc.js";
import { buildCodexSessionPolicy } from "./runtime-host/codex-policy.js";
import { isCodexExecutionCertified, isCodexTerminalCertified } from "./runtime-host/codex-compatibility.js";
import { runtimeNotReady } from "./runtime-host/policy.js";
import type { RuntimeBackendProbeResult } from "./runtime-host/types.js";
import type { DirectCodexProvisioner } from "./codex-native-session.js";
import type { CodexStructuredProvisioner } from "./codex-structured-ask.js";
import type { NativeComponentBindings } from "./native-component-preparation.js";

export interface CodexBootConfiguration {
  readonly selected: "local" | "codex-app-server";
  readonly allowLocal: boolean;
  readonly executable?: string;
  readonly source?: string;
  readonly loginHome?: string;
  readonly accountEmail?: string;
}
/** Read once at composition. No browser values, PATH discovery or credential copying. */
export function readCodexBootConfiguration(env: NodeJS.ProcessEnv): CodexBootConfiguration {
  const selected = env.GENBI_CODEX_RUNTIME ?? "local";
  const local = env.GENBI_ALLOW_LOCAL_RUNTIME ?? "1";
  if (!["local", "app-server"].includes(selected) || !["0", "1"].includes(local)) throw new Error("Invalid server runtime selection.");
  return Object.freeze({ selected: selected === "app-server" ? "codex-app-server" : "local", allowLocal: local === "1",
    ...(env.GENBI_CODEX_EXECUTABLE ? { executable: env.GENBI_CODEX_EXECUTABLE } : {}),
    ...(env.GENBI_CODEX_SOURCE ? { source: env.GENBI_CODEX_SOURCE } : {}),
    ...(env.WREN_HARNESS_CODEX_HOME ? { loginHome: env.WREN_HARNESS_CODEX_HOME } : {}),
    ...(env.GENBI_CODEX_ACCOUNT_EMAIL ? { accountEmail: env.GENBI_CODEX_ACCOUNT_EMAIL } : {}) });
}
interface Options {
  readonly configuration: CodexBootConfiguration;
  readonly packageRoot: string;
  readonly producerBinary: string;
  readonly profileSource: string;
  readonly store: Store;
  readonly getBinding: () => EnrichmentBinding | undefined;
  readonly sourceWrenHome: () => string;
  readonly artifacts: NativeArtifactService;
}
const unavailable = () => new CodexBackendError("runtime_policy_unavailable");

/** Real composition for both entry surfaces; certification is enforced by the packaged backend. */
export function createCodexRuntimeComposition(options: Options) {
  const config = Object.freeze({ ...options.configuration });
  const backend = new CodexAppServerBackend({ executable: config.executable ?? "", source: config.source ?? "", packageRoot: options.packageRoot });
  const checkConfiguration = () => {
    if (!config.executable || !path.isAbsolute(config.executable) || !config.source?.startsWith("https://")
      || !config.loginHome || !path.isAbsolute(config.loginHome) || !config.accountEmail?.trim()) throw unavailable();
    const login = realpathSync(config.loginHome);
    const directory = lstatSync(config.loginHome);
    const auth = lstatSync(path.join(login, "auth.json"));
    if (directory.isSymbolicLink() || !directory.isDirectory() || (directory.mode & 0o777) !== 0o700
      || login === path.join(os.homedir(), ".codex") || !auth.isFile() || auth.isSymbolicLink() || (auth.mode & 0o077) !== 0) throw unavailable();
    return login;
  };
  const checkExecutionScope = (entry: string) => {
    const models = codexModelsForRuntime(options.store.getRuntimeSettings());
    const vendor = attestNativeExecutable("vendor", config.executable!);
    if (!isCodexExecutionCertified(config.source!, vendor.digest.slice(7), Object.values(models), entry)) throw unavailable();
  };
  const probe = async (): Promise<RuntimeBackendProbeResult<"codex-app-server">> => {
    const result = await backend.probe();
    if (result.readiness.state !== "ready") return result;
    try { checkConfiguration(); checkExecutionScope("answer_query"); attestNativeExecutable("producer", options.producerBinary); resolveContextLoaderBinary(); return result; }
    catch { return { readiness: runtimeNotReady("codex-app-server", "unprovisioned", "runtime_policy_unavailable"), diagnostic: { phase: "policy" } }; }
  };
  async function prepare(input: { id: string; binding: EnrichmentBinding; entry: string; permit: CodexLaunchPermit;
    signal: AbortSignal; assertActive(): void; persistRoot?: NativeComponentBindings["persistRoot"] }) {
    input.permit.assertActive(); input.assertActive(); input.signal.throwIfAborted();
    if (!["answer_query", "generate_dashboard"].includes(input.entry)) throw unavailable();
    const loginHome = checkConfiguration();
    checkExecutionScope(input.entry);
    const binding = structuredClone(input.binding);
    const settings = structuredClone(options.store.getRuntimeSettings());
    const generation = options.store.getNativeRuntimeBinding().generation;
    if (settings.authMode !== "subscription" || settings.subscriptionProvider !== "codex") throw unavailable();
    const models = codexModelsForRuntime(settings);
    if (!models.orchestrator.trim()) throw unavailable();
    const sourceHome = options.sourceWrenHome();
    const runtime = input.permit.runtime;
    const vendor = attestNativeExecutable("vendor", config.executable!);
    const producer = attestNativeExecutable("producer", options.producerBinary);
    const loader = attestNativeExecutable("producer", resolveContextLoaderBinary());
    const node = attestNativeExecutable("node", process.execPath);
    const wren = attestNativeExecutable("wren", runtime.launcher);
    const python = attestNativeExecutable("python", runtime.venv_python);
    const identity = { session_id: input.id, vendor: "codex" as const, auth_identity: config.accountEmail!, runtime_generation: String(generation),
      binding: { project_identity: binding.identity, generation: String(binding.generation), revision: binding.revision } };
    let retired = false;
    const checkLive = () => {
      input.signal.throwIfAborted(); input.assertActive();
      if (retired || !isDeepStrictEqual(options.getBinding(), binding) || !isDeepStrictEqual(options.store.getRuntimeSettings(), settings)
        || options.store.getNativeRuntimeBinding().generation !== generation || sourceHome !== options.sourceWrenHome() || checkConfiguration() !== loginHome) throw unavailable();
    };
    const check = () => {
      checkLive();
      for (const executable of [vendor, producer, loader, node, wren, python]) assertNativeExecutableIdentity(executable);
    };
    check(); input.permit.assertActive();
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "genbi-codex-session-")));
    let tools: CodexSessionTools | undefined;
    const steps = new Set<RpcTransport>();
    let cleanupFailed = false;
    let cleaned = false;
    const dispose = async () => { if (cleaned) return; if (cleanupFailed || steps.size) throw new CodexBackendError("codex_app_server_cleanup_failed");
      retired = true; await rm(root, { recursive: true, force: true }); cleaned = true; };
    try {
      check(); input.permit.assertActive();
      const workspace = path.join(root, "workspace"), home = path.join(root, "home");
      await mkdir(workspace, { mode: 0o700 }); await mkdir(home, { mode: 0o700 });
      const wrenHome = createEmptyCodexWrenHome(workspace);
      const spec = buildNativeRuntimeSpec({ backend: "codex-app-server", vendor: "codex", executables: [vendor, producer, node, wren, python],
        toolDirectories: await Promise.all([path.dirname(node.executable), "/usr/bin", "/bin", path.dirname(runtime.launcher)].map((directory) => realpath(directory))), workspace, home,
        binding, sessionWrenHome: wrenHome.home, codexHome: loginHome });
      buildCodexSessionPolicy(spec, runtime, wrenHome, true, models.orchestrator);
      const compiled = await compileProfile({ profileSource: options.profileSource, userProject: binding.path, mode: "native", warbleBin: producer.executable });
      check(); input.permit.assertActive();
      const irDocument = await readFile(compiled.irPath, "utf8");
      tools = await prepareCapturedCodexDirectTools(irDocument, { binding: identity.binding, entry: { kind: "agent", verb: input.entry, prompt: "Use the selected analysis tool." } }, {
        identity, currentIdentity: () => { checkLive(); return identity; }, assertCurrent: check, assertLive: checkLive,
        verifierBinary: producer.executable, producerBinary: producer.executable, contextLoaderBinary: loader.executable,
        wrenBinary: wren.executable, project: binding.path, signal: input.signal, expiresAt: Date.now() + 60 * 60_000,
        wrenEnvironment: { PATH: [path.dirname(runtime.launcher), path.dirname(runtime.venv_python), "/usr/bin", "/bin"].join(path.delimiter), HOME: home,
          WREN_HOME: sourceHome, WREN_PROJECT_HOME: binding.path, PYTHONNOUSERSITE: "1", PYTHONUTF8: "1", PYTHONDONTWRITEBYTECODE: "1" },
        ...(input.persistRoot ? { persistRoot: input.persistRoot } : {}),
        vendor: { vendor: "codex", authIdentity: config.accountEmail!, accountEmail: config.accountEmail!, generation: String(generation),
          models: { cheap: models.cheap, strong: models.strong }, assertCurrent: check, assertLive: checkLive,
          async open(model, signal) {
            check(); signal.throwIfAborted();
            const permit = backend.prepareLaunch();
            try {
              if (!isDeepStrictEqual(permit.runtime, runtime)) throw unavailable();
              const resource = backend.openStep(permit, { spec, wrenHome, model, accountEmail: config.accountEmail!, signal, assertScopeActive: checkLive });
              const raw = resource.transport;
              let closing: Promise<void> | undefined;
              const transport: RpcTransport = { listen: raw.listen.bind(raw), write: raw.write.bind(raw), close: () => closing ??= (async () => {
                try { await raw.close(); steps.delete(transport); } catch (error) { cleanupFailed = true; throw error; }
              })() };
              steps.add(transport); return { ...resource, transport };
            } finally { permit.release(); }
          } },
      });
      check(); input.permit.assertActive();
      const preparedTools = tools;
      const scopedTools: CodexSessionTools = { ...tools, async close() {
        const results = await Promise.allSettled([preparedTools.close(), ...[...steps].map((step) => step.close())]);
        if (cleanupFailed || results.some((item) => item.status === "rejected")) { cleanupFailed = true; throw new CodexBackendError("codex_app_server_cleanup_failed"); }
      } };
      return { input: { spec, wrenHome, model: models.orchestrator, tools: scopedTools, assertScopeActive: checkLive }, dispose };
    } catch (error) {
      try { await tools?.close(); await dispose(); } catch { throw new CodexBackendError("codex_app_server_cleanup_failed"); }
      throw error;
    }
  }
  const terminalCertified = (entry: string) => {
    try {
      const vendor = attestNativeExecutable("vendor", config.executable!);
      return isCodexTerminalCertified(config.source!, vendor.digest.slice(7), Object.values(codexModelsForRuntime(options.store.getRuntimeSettings())), entry);
    } catch { return false; }
  };
  const native: DirectCodexProvisioner = { backend, terminal: true, terminalCertified, async prepare(input) {
    input.permit.assertActive(); input.assertActive(); input.signal.throwIfAborted();
    checkConfiguration(); checkExecutionScope(input.session.entryVerb ?? "answer_query");
    if (!terminalCertified(input.session.entryVerb ?? "answer_query")) throw unavailable();
    const credential = options.artifacts.issue(input.session, input.binding).credential;
    try {
      const prepared = await prepare({ id: input.session.id, binding: input.binding, entry: input.session.entryVerb ?? "answer_query",
        permit: input.permit, signal: input.signal, assertActive: input.assertActive,
        async persistRoot(result, _binding, signal) {
          signal.throwIfAborted(); input.assertActive();
          if (result.provenance?.verified !== true) return;
          if (result.output.kind === "render") {
            options.artifacts.saveGrounded(credential, { version: "1", idempotency_key: randomUUID(), name: "Generated dashboard",
              envelope: { blocks: result.output.blocks, ...(result.output.summary ? { summary: result.output.summary } : {}), verified: true } });
          } else {
            const table = z.object({ columns: z.array(z.string()), rows: z.array(z.union([z.array(z.unknown()), z.record(z.string(), z.unknown())])) }).parse(result.output.value);
            const blocks: unknown[] = [{ type: "table", columns: table.columns, rows: table.rows }];
            if (result.provenance.definition) blocks.push({ type: "definition", ...z.record(z.string(), z.unknown()).parse(result.provenance.definition) });
            options.artifacts.persistGroundedAnswer(credential, { version: "1", idempotency_key: randomUUID(), envelope: { blocks, verified: true } });
          }
        } });
      return { ...prepared, async dispose() { options.artifacts.revoke(credential); await prepared.dispose(); } };
    } catch (error) { options.artifacts.revoke(credential); throw error; }
  } };
  const structured: CodexStructuredProvisioner = { backend: { probe, prepareLaunch: backend.prepareLaunch.bind(backend), open: backend.open.bind(backend) }, async prepare({ options: request, scope, permit }) {
    const binding = options.getBinding();
    if (!binding || request.userProject !== binding.path || !scope.signal) throw unavailable();
    return prepare({ id: `${scope.sessionId}:${scope.turnId}`, binding, entry: request.agentId ?? "answer_query", permit, signal: scope.signal, assertActive: scope.assertCurrent });
  } };
  return { probe, native, structured, shutdown: () => backend.shutdown() };
}
