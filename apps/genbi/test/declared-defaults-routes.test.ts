import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hashDirectory } from "../harness/compile/fingerprint.js";
import { declaredDefaultsOption, declaredDefaultsOptionOfProject } from "../harness/components/declared-defaults.js";
import * as wrenAccess from "../harness/components/wren-access.js";
import { runCodexAskDefault } from "../harness/route/codex-ask.js";
import { runDispatchedDefault } from "../harness/route/dispatched.js";
import { openNativeQueryAccess } from "../server/native-query-access.js";
import { createNativeComponentRuntimeBindings, type NativeComponentRuntimeOptions } from "../server/native-component-runtime.js";
import type { ComponentPlan } from "../harness/components/runner.js";
import { fakeWrenWorkspace } from "./codex-host-evidence-helpers.js";

const FIXTURES = path.join(import.meta.dirname, "fixtures");
const IDS = ["usd-at-transaction-date", "exclude-test-accounts"];
const ORDERS_SQL = "SELECT COUNT(*) AS order_count FROM orders";
const SENTENCE = "The query does not apply a default rule that the bound project declares for the models it reads, so it was not executed.";
const ENVIRONMENT = ["WREN_HARNESS_CONTEXT_LOADER_BIN", "FAKE_LOADER_DECLARED", "FAKE_WREN_DECLARED", "FAKE_WREN_RULE_IDS", "FAKE_WREN_HELLO"] as const;

interface Outcome { readonly isError: boolean; readonly text: string }
interface Route { readonly name: string; run(sql: string): Promise<Outcome> }

const scratch: string[] = [];
const cleanups: (() => void)[] = [];
const saved: Partial<Record<(typeof ENVIRONMENT)[number], string | undefined>> = {};
let logged: string[] = [];

beforeEach(() => {
  for (const key of ENVIRONMENT) { saved[key] = process.env[key]; delete process.env[key]; }
  logged = [];
  vi.spyOn(console, "error").mockImplementation((line: unknown) => { logged.push(String(line)); });
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const key of ENVIRONMENT) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]!; }
  for (const cleanup of cleanups.splice(0)) cleanup();
  for (const directory of scratch.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function scratchDirectory(prefix: string): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), prefix));
  scratch.push(directory);
  return directory;
}
/** Installs the stand-in context generator, whose catalog declares `catalog` (none when empty). */
function useCatalog(catalog: readonly string[]): void {
  const root = scratchDirectory("genbi-dd-loader-");
  const loader = path.join(root, "wren-context-loader");
  writeFileSync(loader, `#!${process.execPath}\n${readFileSync(path.join(FIXTURES, "fake-context-loader.cjs"), "utf8")}`, { mode: 0o700 });
  process.env["WREN_HARNESS_CONTEXT_LOADER_BIN"] = loader;
  process.env["FAKE_LOADER_DECLARED"] = catalog.join(",");
}
/** What the stand-in `wren` announces: protocol 3 with `ids`, or a raw hello frame. */
function useWren(announced: { ids?: readonly string[]; hello?: unknown; ruleIds?: readonly string[] }): void {
  process.env["FAKE_WREN_DECLARED"] = (announced.ids ?? []).join(",");
  if (announced.hello !== undefined) process.env["FAKE_WREN_HELLO"] = JSON.stringify(announced.hello);
  if (announced.ruleIds) process.env["FAKE_WREN_RULE_IDS"] = announced.ruleIds.join(",");
}

type ToolResult = { result?: { isError?: boolean; content?: { text: string }[] } };
const outcomeOf = (result: ToolResult | undefined): Outcome => ({ isError: result?.result?.isError === true, text: result?.result?.content?.[0]?.text ?? "" });

function dispatchedRoute(): Route {
  return { name: "dispatched host-proxy turn", async run(sql) {
    const workspace = fakeWrenWorkspace(); cleanups.push(workspace.cleanup);
    const scripts = scratchDirectory("genbi-dd-dispatched-");
    const irPath = path.join(scripts, "ir.json"); writeFileSync(irPath, "{}");
    const chat = path.join(scripts, "warble-agent-sdk");
    writeFileSync(chat, `#!${process.execPath}\nimport(${JSON.stringify(path.join(FIXTURES, "fake-agent-sdk-host-mcp.mjs"))});\n`, { mode: 0o700 });
    const script = path.join(scripts, "turn.json"), capture = path.join(scripts, "capture.json");
    writeFileSync(script, JSON.stringify({ calls: [{ name: "run_sql", arguments: { sql } }], answer: "done", capture }));
    await runDispatchedDefault({ authChoice: { mode: "subscription", provider: "claude" }, profileSource: "/fixture/profile", userProject: workspace.project, question: `script:${script}`,
      irPath, warbleBin: "/usr/bin/false", agentSdkBin: chat, outDir: scripts, chatTimeoutMs: 20_000, hostQueries: { wren: workspace.wren } });
    return outcomeOf((JSON.parse(readFileSync(capture, "utf8")) as { results: ToolResult[] }).results[0]);
  } };
}
function codexAskRoute(): Route {
  return { name: "codex-ask host-proxy turn", async run(sql) {
    const workspace = fakeWrenWorkspace(); cleanups.push(workspace.cleanup);
    const scripts = scratchDirectory("genbi-dd-codex-");
    const irPath = path.join(scripts, "ir.json"); writeFileSync(irPath, "{}");
    const script = path.join(scripts, "turn.json"), capture = path.join(scripts, "capture.json");
    writeFileSync(script, JSON.stringify({ calls: [{ name: "run_sql", arguments: { sql } }], answer: "done", capture }));
    await runCodexAskDefault({ authChoice: { mode: "subscription", provider: "codex" }, profileSource: "/fixture/profile", userProject: workspace.project, question: `script:${script}`,
      irPath, codexHome: scripts, codexModels: { orchestrator: "driver-model", cheap: "cheap-model", strong: "strong-model" },
      codexLocalCli: { command: process.execPath, prefixArgs: [path.join(FIXTURES, "fake-codex-mcp-dispatcher.mjs")] }, mcpServer: { command: workspace.wren, prefixArgs: [] }, timeoutMs: 20_000 }).catch(() => undefined);
    return outcomeOf((JSON.parse(readFileSync(capture, "utf8")) as { results: ToolResult[] }).results[0]);
  } };
}
async function outcomeOfAccess(open: () => Promise<{ query(input: { sql: string; limit: number }, signal: AbortSignal): Promise<unknown>; close(): Promise<void> }>, sql: string): Promise<Outcome> {
  const signal = new AbortController().signal;
  try {
    const access = await open();
    try { await access.query({ sql, limit: 5 }, signal); return { isError: false, text: "" }; } finally { await access.close(); }
  } catch (error) { return { isError: true, text: (error as Error).message }; }
}
function enrichmentRoute(): Route {
  return { name: "enrichment native session query", async run(sql) {
    const workspace = fakeWrenWorkspace(); cleanups.push(workspace.cleanup);
    return outcomeOfAccess(() => openNativeQueryAccess(workspace.wren, { path: workspace.project }, new AbortController().signal), sql);
  } };
}
const COMPONENT: ComponentPlan = { id: "root", declaration: {}, steps: [{ name: "q", tier: "strong", prompt: "", produces: "result", consumes: [], tools: [{ name: "query", source: "wren" }], calls: [] }] };
/** The native runtime's data access, given the declared set the captured context carries (`catalog`) and, optionally, an `openDataAccess` override. */
async function nativeRuntimeAccess(workspace: { wren: string; project: string }, catalog: readonly string[], openDataAccess?: NativeComponentRuntimeOptions["openDataAccess"]) {
  const identity = { session_id: "synthetic", vendor: "claude" as const, auth_identity: "approved", runtime_generation: "1", binding: { project_identity: "project", generation: "1", revision: "revision" } };
  const signal = new AbortController().signal;
  const bindings = createNativeComponentRuntimeBindings({ identity, contexts: {}, verifierBinary: "unused", currentIdentity: () => identity, assertCurrent() {},
    vendor: { vendor: "claude", authIdentity: "approved", accountEmail: "approved@example.test", generation: "1", models: { strong: "approved-model" }, assertCurrent() {}, open: async () => { throw new Error("no model"); } },
    wren: { executable: workspace.wren, project: workspace.project, fingerprint: await hashDirectory(workspace.project), identity: await wrenAccess.captureWrenAccessIdentity(workspace.project), ...declaredDefaultsOption(catalog) },
    ...(openDataAccess ? { openDataAccess } : {}) } as unknown as NativeComponentRuntimeOptions);
  return bindings.prepare(COMPONENT, {} as never, signal);
}
/** The catalog the captured context would carry is whatever the stand-in generator announces. */
const announcedCatalog = (): readonly string[] => (process.env["FAKE_LOADER_DECLARED"] ?? "").split(",").filter(Boolean);
function nativeRuntimeRoute(): Route {
  return { name: "native component runtime data access", async run(sql) {
    const workspace = fakeWrenWorkspace(); cleanups.push(workspace.cleanup);
    return outcomeOfAccess(() => nativeRuntimeAccess(workspace, announcedCatalog()), sql);
  } };
}

/** Routes that read the declared set from the project's own catalog; the native runtime takes it from the captured context, so it is driven with the same ids. */
const catalogRoutes = (): Route[] => [dispatchedRoute(), codexAskRoute(), enrichmentRoute()];

describe.each([...catalogRoutes(), nativeRuntimeRoute()])("declared default rules on the $name", (route) => {
  it("opens governed access for a declaring project and renders a declared-default refusal as the sentence plus the declared rule id", async () => {
    useCatalog(IDS); useWren({ ids: IDS, ruleIds: ["exclude-test-accounts", "undeclared-rule"] });
    const refused = await route.run(`${ORDERS_SQL} /*declared*/`);
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain(`[declared_default_missing]: ${SENTENCE}`);
    expect(refused.text.endsWith(" Rule: exclude-test-accounts")).toBe(true);
    expect(refused.text).not.toContain("undeclared-rule");
    expect((await route.run(ORDERS_SQL)).isError).toBe(false);
  }, 30_000);
  it.each([
    ["one of the two declared ids", { ids: ["exclude-test-accounts"] }],
    ["an extra id", { ids: [...IDS, "extra-rule"] }],
    ["an empty list", { hello: { id: 0, protocol: "wren-governed/3", declared_defaults: [] } }],
    ["a protocol 2 hello", {}],
  ])("is unavailable with the declarations reason when the governed process announces %s", async (_name, announced) => {
    useCatalog(IDS); useWren(announced);
    const refused = await route.run(ORDERS_SQL);
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("[transport]");
    expect(logged.some((line) => line.includes('"site":"governed_hello"') && line.includes('"code":"governed_declarations_mismatch"'))).toBe(true);
  }, 30_000);
  it("keeps a project that declares nothing on a two-key protocol 2 hello, and refuses a process that announces rules it does not declare", async () => {
    useCatalog([]); useWren({});
    expect((await route.run(ORDERS_SQL)).isError).toBe(false);
    useWren({ ids: IDS });
    const refused = await route.run(ORDERS_SQL);
    expect(refused.isError).toBe(true); expect(refused.text).toContain("[transport]");
  }, 30_000);
});

describe("the declared-defaults option of a project", () => {
  it("is the catalog's declared ids, in order, and absent (not empty) for a project that declares nothing", async () => {
    useCatalog(IDS);
    expect(await declaredDefaultsOptionOfProject("/synthetic/project")).toEqual({ declaredDefaults: IDS });
    useCatalog([]);
    const none = await declaredDefaultsOptionOfProject("/synthetic/project");
    expect(Object.hasOwn(none, "declaredDefaults")).toBe(false);
    expect(Object.hasOwn(declaredDefaultsOption([]), "declaredDefaults")).toBe(false);
  });
  it("is absent, with a count-free log line, when the catalog cannot be produced, so a governed process announcing rules is refused", async () => {
    process.env["WREN_HARNESS_CONTEXT_LOADER_BIN"] = path.join(os.tmpdir(), "genbi-dd-missing-loader");
    const none = await declaredDefaultsOptionOfProject("/synthetic/project");
    expect(Object.hasOwn(none, "declaredDefaults")).toBe(false);
    expect(logged).toContain(`[component-failure] ${JSON.stringify({ site: "declared_defaults_catalog", code: "catalog_unavailable" })}`);
  });
  it("propagates a cancellation instead of reading it as 'declares nothing'", async () => {
    useCatalog(IDS);
    const controller = new AbortController(); controller.abort();
    await expect(declaredDefaultsOptionOfProject("/synthetic/project", { signal: controller.signal })).rejects.toThrow();
  });
});

describe("non-declaring projects make the same governed call as before declarations existed", () => {
  const spy = () => vi.spyOn(wrenAccess, "openWrenComponentAccess");
  const optionsOf = (mock: ReturnType<typeof spy>) => mock.mock.calls.map(([options]) => options);
  it.each([dispatchedRoute(), codexAskRoute(), enrichmentRoute(), nativeRuntimeRoute()])("omits the option entirely on the $name", async (route) => {
    useCatalog([]); useWren({});
    const open = spy();
    expect((await route.run(ORDERS_SQL)).isError).toBe(false);
    expect(open).toHaveBeenCalled();
    for (const options of optionsOf(open)) expect(Object.hasOwn(options, "declaredDefaults")).toBe(false);
  }, 30_000);
  it.each([dispatchedRoute(), codexAskRoute(), enrichmentRoute(), nativeRuntimeRoute()])("passes exactly the catalog's set on the $name", async (route) => {
    useCatalog(IDS); useWren({ ids: IDS });
    const open = spy();
    expect((await route.run(ORDERS_SQL)).isError).toBe(false);
    for (const options of optionsOf(open)) expect(options.declaredDefaults).toEqual(IDS);
  }, 30_000);
  it("tells the native runtime's data-access override the declared set, and an empty set for a project that declares nothing", async () => {
    const workspace = fakeWrenWorkspace(); cleanups.push(workspace.cleanup);
    for (const catalog of [IDS, []]) {
      const open = vi.fn(async () => ({ query: async () => ({}), inspect: async () => ({}), close: async () => {} }));
      await nativeRuntimeAccess(workspace, catalog, open);
      expect(open).toHaveBeenCalledExactlyOnceWith(expect.any(AbortSignal), catalog);
    }
  });
});
