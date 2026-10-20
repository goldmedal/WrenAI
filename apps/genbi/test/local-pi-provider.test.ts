import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { StepRun } from "../harness/components/runner.js";
import { PACKAGED_SHIM } from "../server/runtime-host/local-pi-provider.js";
import { LocalPiKeyProxy } from "../server/runtime-host/local-pi-key-proxy.js";
import { createLocalPiProvider, LOCAL_PI_TOKEN_ENV, type LocalPiProviderOptions } from "../server/runtime-host/local-pi-provider.js";
import { verifyLocalPi } from "../server/runtime-host/local-pi-install.js";
import { defaultStepsRoot, ensureStepsRoot, listProcesses, type LocalPiCleanupReport } from "../server/runtime-host/local-pi-step.js";
import { PiComponentError, runPiComponentStep } from "../server/runtime-host/pi-component-step.js";
import { DUMMY_KEY, installFake, stepDirs, stubUpstream, type FakeConfig } from "./local-pi-fixture.js";

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); delete process.env.ANTHROPIC_API_KEY; });
const schema = { type: "object", properties: { code: { type: "string" } }, required: ["code"], additionalProperties: false };
const DECOY = "decoy-bff-secret-must-not-reach-pi";

function stepRun(options: { tools?: Record<string, (input: unknown) => Promise<unknown>>; signal?: AbortSignal } = {}): StepRun {
  const tools = options.tools ?? { lookup: async () => ({ word: "marmalade" }) };
  return { tier: "fast", request: "ask", input: { q: "hello" }, brief: "BRIEF", prompt: "PROMPT", consumes: {}, children: [], tools,
    toolSchemas: Object.fromEntries(Object.keys(tools).map((name) => [name, schema])), toolDescriptions: Object.fromEntries(Object.keys(tools).map((name) => [name, `${name} tool`])), signal: options.signal ?? new AbortController().signal };
}

async function fixture(config: FakeConfig = { http: true, call: { suffix: "lookup", args: { code: "K7" } } }, overrides: Partial<LocalPiProviderOptions> & { env?: NodeJS.ProcessEnv } = {}) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "lpi-"))); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const record = path.join(root, "record.jsonl");
  const f = await installFake(root, { record, ...config });
  const upstream = await stubUpstream(); cleanup.push(upstream.close);
  const proxy = new LocalPiKeyProxy({ env: () => overrides.env ?? { VENDOR_KEY: DUMMY_KEY } }); cleanup.push(() => proxy.close());
  // A unix socket path is short-limited, and the shim fixes the `<root>/<uuid>/mcp.sock` layout, so the steps root is a short real path.
  const stepsRoot = path.join(realpathSync("/tmp"), `lpi-${path.basename(root).slice(-8)}`); ensureStepsRoot(stepsRoot); cleanup.push(() => rmSync(stepsRoot, { recursive: true, force: true }));
  const reports: LocalPiCleanupReport[] = [];
  const provider = createLocalPiProvider({ proxy, endpoints: { fast: { api: "openai-completions", upstream: `${upstream.origin}/v1`, credentialEnv: "VENDOR_KEY", model: "stub-model" } },
    authIdentity: "local-pi:test", generation: "1", accountLabel: "pi (test)", assertCurrent() {}, assertExecutableCurrent() {}, stepsRoot,
    verifyIdentity: () => { const v = verifyLocalPi({ stateDir: f.stateDir, rows: [f.row] }); if (!v.launcher) throw new Error("not ready"); return v.launcher; },
    onCleanup: (report) => reports.push(report), ...overrides });
  const records = () => (existsSync(record) ? readFileSync(record, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>) : []);
  return { root, f, upstream, proxy, provider, stepsRoot, reports, records, record, open: (signal = new AbortController().signal) => provider.open("stub-model", signal, "fast") };
}
const residue = async (stepsRoot: string) => (await listProcesses()).filter((row) => row.command.includes(stepsRoot) && !row.stat.startsWith("Z"));

describe("local pi provider: one host pi per step behind a per-step proxy grant", () => {
  it("runs a governed tool call end to end; pi holds only the per-step token; the stub sees the real key", async () => {
    process.env.ANTHROPIC_API_KEY = DECOY;
    const seen: unknown[] = [];
    const t = await fixture();
    const runtime = await t.open();
    const response = await runPiComponentStep(runtime, stepRun({ tools: { lookup: async (input) => { seen.push(input); return { word: "marmalade" }; } } }));
    expect(response).toEqual({ value: "answer text", usage: { inputTokens: 5, outputTokens: 2 } });
    expect(seen).toEqual([{ code: "K7" }]);
    // The upstream received the real key through the proxy, on the pinned path.
    expect(t.upstream.seen).toHaveLength(1);
    expect(t.upstream.seen[0]!.url).toBe("/v1/chat/completions"); expect(t.upstream.seen[0]!.headers.authorization).toBe(`Bearer ${DUMMY_KEY}`);
    // Everything pi could observe: argv, env, agent-dir files, system prompt, the MCP exchange. None of it carries the key or the BFF decoy.
    const raw = readFileSync(t.record, "utf8");
    expect(raw).not.toContain(DUMMY_KEY); expect(raw).not.toContain(DECOY);
    const start = t.records().find((entry) => entry.kind === "start")! as { env: Record<string, string>; argv: string[]; agentFiles: Record<string, string>; cwd: string };
    // macOS adds __CF_USER_TEXT_ENCODING to every exec by itself; nothing else may appear.
    expect(Object.keys(start.env).filter((name) => !name.startsWith("__CF_")).sort()).toEqual(["GENBI_PI_STEP_TOKEN", "HOME", "LANG", "PATH", "PI_CODING_AGENT_DIR", "PI_OFFLINE", "PI_SKIP_VERSION_CHECK", "PI_TELEMETRY", "TMPDIR"]);
    expect(start.env.GENBI_PI_STEP_TOKEN).toMatch(/^[a-f0-9]{64}$/); expect(start.env.PI_OFFLINE).toBe("1");
    const models = JSON.parse(start.agentFiles["models.json"]!) as { providers: Record<string, { baseUrl: string; apiKey: string }> };
    const provider = Object.values(models.providers)[0]!;
    expect(provider.apiKey).toBe("$GENBI_PI_STEP_TOKEN"); expect(provider.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/);
    expect(Object.keys(start.agentFiles).sort()).toEqual(["mcp.json", "models.json", "settings.json"]);
    expect(start.argv.join(" ")).not.toContain(start.env.GENBI_PI_STEP_TOKEN!);
    expect(start.argv).toEqual(expect.arrayContaining(["--mode", "json", "--no-session", "--no-extensions", "--no-skills", "--no-context-files", "--no-approve", "-e", "builtin:mcp"]));
    expect(start.argv.join(" ")).toContain("--tools mcp__component__lookup");
    const http = t.records().find((entry) => entry.kind === "http") as { status: number };
    expect(http.status).toBe(200);
    // Cleanup is proven: processes, directory, grant.
    expect(t.reports).toEqual([{ reason: "settled", processes: "clear", directory: "removed", grant: "revoked" }]);
    expect(stepDirs(t.stepsRoot)).toEqual([]); expect(t.proxy.liveGrants).toBe(0); expect(await residue(t.stepsRoot)).toEqual([]);
  });

  it("runs from an installed package: a node and a relay under paths the protocol does not admit (`@`) are reached through safe paths in the steps root", async () => {
    const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "lpi-at-"))); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
    const nodeDir = path.join(root, "node@24", "bin"), shimDir = path.join(root, "node_modules", "@wrenai", "genbi"); mkdirSync(nodeDir, { recursive: true }); mkdirSync(shimDir, { recursive: true });
    symlinkSync(process.execPath, path.join(nodeDir, "node")); copyFileSync(PACKAGED_SHIM, path.join(shimDir, "pi-mcp-shim.mjs"));
    const t = await fixture(undefined, { node: path.join(nodeDir, "node"), shim: path.join(shimDir, "pi-mcp-shim.mjs") });
    const response = await runPiComponentStep(await t.open(), stepRun());
    expect(response.value).toBe("answer text");
    const start = t.records().find((entry) => entry.kind === "start")! as { agentFiles: Record<string, string> };
    const server = Object.values((JSON.parse(start.agentFiles["mcp.json"]!) as { mcpServers: Record<string, { command: string; args: string[] }> }).mcpServers)[0]!;
    expect(server.command).toBe(path.join(t.stepsRoot, "node")); expect(server.args[0]).toBe(path.join(t.stepsRoot, "pi-mcp-shim.mjs"));
    expect(lstatSync(server.command).isSymbolicLink()).toBe(true); expect(readlinkSync(server.command)).toBe(path.join(nodeDir, "node"));
    expect(readFileSync(server.args[0]!).equals(readFileSync(PACKAGED_SHIM))).toBe(true);
    // A tampered copy is replaced by the packaged bytes before the next step.
    writeFileSync(server.args[0]!.concat(".x"), "x"); rmSync(server.args[0]!, { force: true }); writeFileSync(server.args[0]!, "tampered");
    await runPiComponentStep(await t.open(), stepRun());
    expect(readFileSync(server.args[0]!).equals(readFileSync(PACKAGED_SHIM))).toBe(true);
  });

  it("a token captured from a finished step is refused afterwards", async () => {
    const t = await fixture();
    await runPiComponentStep(await t.open(), stepRun());
    const start = t.records().find((entry) => entry.kind === "start")! as { env: Record<string, string>; agentFiles: Record<string, string> };
    const base = (Object.values((JSON.parse(start.agentFiles["models.json"]!) as { providers: Record<string, { baseUrl: string }> }).providers)[0]!).baseUrl;
    const reply = await fetch(`${base}/chat/completions`, { method: "POST", headers: { authorization: `Bearer ${start.env.GENBI_PI_STEP_TOKEN}` }, body: "{}" }).catch(() => undefined);
    expect(reply === undefined || reply.status === 401).toBe(true);
    expect(t.upstream.seen).toHaveLength(1);
  });

  it("cancel kills the process group, removes the directory, revokes the grant and proves it", async () => {
    const t = await fixture({ http: false, hang: true });
    const controller = new AbortController();
    const pending = runPiComponentStep(await t.open(controller.signal), stepRun({ signal: controller.signal })).catch((error) => error);
    for (let waited = 0; waited < 5000 && !t.records().some((entry) => entry.kind === "start"); waited += 20) await new Promise((resolve) => setTimeout(resolve, 20));
    expect(t.records().some((entry) => entry.kind === "start")).toBe(true);
    controller.abort();
    const error = await pending;
    expect(error).toBeInstanceOf(PiComponentError); expect((error as PiComponentError).reason).toBe("cancelled");
    expect(t.reports.at(-1)).toMatchObject({ reason: "cancelled", processes: "clear", directory: "removed", grant: "revoked" });
    expect(stepDirs(t.stepsRoot)).toEqual([]); expect(t.proxy.liveGrants).toBe(0); expect(await residue(t.stepsRoot)).toEqual([]);
  });

  it("a descendant that outlives pi is found by its command line and reaped", async () => {
    const t = await fixture({ http: false, orphan: true });
    const response = await runPiComponentStep(await t.open(), stepRun({ tools: {} }));
    expect(response.value).toBe("answer text");
    expect(await residue(t.stepsRoot)).toEqual([]);
    expect(t.reports.at(-1)).toMatchObject({ processes: "clear", directory: "removed" });
  });

  it("cleanup that cannot be proven fails closed as a cleanup fault", async () => {
    const t = await fixture({ http: false }, { list: async () => { throw new Error("ps unavailable"); } });
    const error = await runPiComponentStep(await t.open(), stepRun({ tools: {} })).catch((reason) => reason);
    expect(error).toBeInstanceOf(PiComponentError); expect((error as PiComponentError).reason).toBe("cleanup");
    expect(stepDirs(t.stepsRoot)).toEqual([]); expect(t.proxy.liveGrants).toBe(0);
  });

  it("re-verifies the certified identity before every step: a tampered bundle never starts pi", async () => {
    const t = await fixture();
    const runtime = await t.open();
    const bundle = path.join(t.f.installDir, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js");
    writeFileSync(bundle, `${readFileSync(bundle, "utf8")}\n// tampered`);
    const error = await runPiComponentStep(runtime, stepRun()).catch((reason) => reason);
    expect(error).toBeInstanceOf(PiComponentError);
    expect(t.records()).toEqual([]); expect(t.proxy.liveGrants).toBe(0); expect(t.upstream.seen).toEqual([]);
  });

  it("refuses to open a step when the key is missing, before any grant exists", async () => {
    const t = await fixture(undefined, { env: {} });
    await expect(t.open()).rejects.toBeDefined();
    expect(t.proxy.liveGrants).toBe(0); expect(stepDirs(t.stepsRoot)).toEqual([]);
  });

  it("refuses an unknown tier or a model that is not the tier's", async () => {
    const t = await fixture();
    await expect(t.provider.open("other-model", new AbortController().signal, "fast")).rejects.toBeDefined();
    await expect(t.provider.open("stub-model", new AbortController().signal, "missing")).rejects.toBeDefined();
    expect(t.proxy.liveGrants).toBe(0);
  });

  it("uses the token variable name and a fresh step directory each time", async () => {
    const t = await fixture({ http: false });
    await runPiComponentStep(await t.open(), stepRun({ tools: {} })); await runPiComponentStep(await t.open(), stepRun({ tools: {} }));
    const starts = t.records().filter((entry) => entry.kind === "start") as { env: Record<string, string>; cwd: string }[];
    expect(starts).toHaveLength(2);
    expect(starts[0]!.env[LOCAL_PI_TOKEN_ENV]).not.toBe(starts[1]!.env[LOCAL_PI_TOKEN_ENV]); expect(starts[0]!.cwd).not.toBe(starts[1]!.cwd);
  });

  it("falls back to a short steps root when the temp location is too long for a socket", () => {
    const fallback = path.join(realpathSync("/tmp"), `gbpi-${process.getuid?.() ?? 0}`);
    expect(defaultStepsRoot("/a".repeat(60))).toBe(fallback);
    expect(defaultStepsRoot("/a".repeat(5))).toBe(path.join("/a".repeat(5), `gbpi-${process.getuid?.() ?? 0}`));
  });
});
