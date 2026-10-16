import { afterEach, describe, expect, it } from "vitest";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import type fs from "node:fs";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
// @ts-expect-error plain JS worker asset
import { admitArgv, admitFiles, remainingProcesses, stepPaths } from "../runtime-assets/pi-worker/pi-worker-core.mjs";
// @ts-expect-error plain JS worker asset
import { supervisorCaTrust } from "../runtime-assets/pi-worker/claude-worker-ca.mjs";
// @ts-expect-error plain JS test fixture
import { bundle, certificate, makeIo, material, writeMaterial } from "./support/supervisor-ca-fixture.mjs";
import { PiLineFrames, PiProtocolFault, PiStepProtocol, admitPiArgv, buildPiAgentFiles, buildPiArgv, buildPiBootstrap, type PiStepSpec } from "../server/runtime-host/pi-protocol.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const assets = path.resolve(here, "../runtime-assets/pi-worker");
const runner = path.join(here, "support/pi-worker-runner.mjs");
const token = "ef".repeat(16);
const schema = { type: "object", properties: { code: { type: "string" } }, required: ["code"], additionalProperties: false };
const roots: string[] = []; const children: ChildProcess[] = [];
const reap = (root: string) => { try { for (const scope of readdirSync(path.join(root, "steps"))) { try { for (const pid of Object.values(JSON.parse(readFileSync(path.join(root, "steps", scope, "pids.json"), "utf8"))) as number[]) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } } } catch { /* no pids */ } } } catch { /* no steps */ } };
afterEach(() => { for (const child of children.splice(0)) { try { child.kill("SIGKILL"); } catch { /* gone */ } } for (const root of roots.splice(0)) { reap(root); rmSync(root, { recursive: true, force: true }); } });
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const waitFor = async (condition: () => boolean, ms = 8000) => { const end = Date.now() + ms; while (!condition()) { if (Date.now() > end) throw new Error("timeout"); await new Promise(resolve => setTimeout(resolve, 25)); } };

function setup(options: { tools?: string[]; systemPrompt?: string; input?: Record<string, unknown> } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "genbi-pi-worker-")); roots.push(root);
  const names = options.tools ?? ["lookup"]; const scope = randomUUID(); const steps = path.join(root, "steps");
  const calls: unknown[] = [];
  const tools = Object.fromEntries(names.map(name => [name, async (input: unknown) => { calls.push(input); return { word: "marmalade" }; }]));
  const run = { tools, toolSchemas: Object.fromEntries(names.map(name => [name, schema])), toolDescriptions: Object.fromEntries(names.map(name => [name, "d"])), request: "ask", input: options.input ?? { q: "hello [call:lookup{\"code\":\"K7\"}]" }, consumes: {} };
  const spec: PiStepSpec = { scope, model: "stub-model", endpoint: { providerId: "stubvendor", api: "openai-completions", baseUrl: "http://host.example.test:18694/v1", credentialEnv: "STUB_KEY" }, systemPrompt: options.systemPrompt ?? "HOST PROMPT", tools: names,
    stepsRoot: steps, runtime: { node: process.execPath, shim: path.join(assets, "pi-mcp-shim.mjs") } };
  return { root, steps, scope, spec, run, calls, protocol: new PiStepProtocol({ run, spec, token, check() {} }) };
}
type Setup = ReturnType<typeof setup>;
const placeholder = "openshell:resolve:env:v1_STUB_KEY";
function launch(f: Setup, extra: { env?: Record<string, string>; bootstrap?: Buffer; beforeInput?: () => void } = {}) {
  const env: Record<string, string> = { PATH: process.env.PATH ?? "", TEST_STEPS: f.steps, STUB_KEY: placeholder, SECRET_PARENT: "must-not-reach-pi", ...extra.env };
  const child = spawn(process.execPath, [runner], { env, stdio: ["pipe", "pipe", "pipe"] }); children.push(child);
  let stderr = ""; child.stderr.on("data", chunk => { stderr += chunk; });
  const frames = new PiLineFrames(); const seen: Record<string, unknown>[] = []; let fault: unknown;
  const send = (frame: Record<string, unknown>) => { f.protocol.host(frame); child.stdin.write(JSON.stringify(frame) + "\n"); };
  child.stdout.on("data", (data: Buffer) => { try { for (const frame of frames.feed(data)) {
    seen.push(frame.value); const effect = f.protocol.worker(frame.value);
    if (effect.kind === "send") { extra.beforeInput?.(); send(effect.frame as never); }
    else if (effect.kind === "mcp") { if (effect.action.kind === "respond") send(effect.action.frame as never); else if (effect.action.kind === "call") { const call = effect.action; void f.run.tools[call.name]!(call.input).then(output => send(f.protocol.answer(call.id, output) as never)); } }
    else if (effect.kind === "settled") send({ t: "end" });
  } } catch (error) { fault = error; child.kill("SIGKILL"); } });
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => child.once("close", (code, signal) => resolve({ code, signal })));
  child.stdin.on("error", () => {});
  child.stdin.write(extra.bootstrap ?? buildPiBootstrap(f.spec, token));
  return { child, exit, seen, stderr: () => stderr, fault: () => fault, send };
}
const notes = (f: Setup) => path.join(f.steps, f.scope, "notes.jsonl");
const pids = (f: Setup) => path.join(f.steps, f.scope, "pids.json");
const sha = (value: string) => createHash("sha256").update(value).digest("hex");

describe("pi worker against a fake pi and the real relay shim", () => {
  it("stages the host files, relays a tool call through the socket, filters pi events and ends in-band with exit status 0", async () => {
    const f = setup(); const w = launch(f); const result = await w.exit;
    expect(w.fault()).toBeUndefined(); expect(w.stderr()).toBe(""); expect(result).toEqual({ code: 0, signal: null });
    expect(f.calls).toEqual([{ code: "K7" }]);
    expect(f.protocol.result()).toMatchObject({ value: 'fake answer after "{\\"word\\":\\"marmalade\\"}"', usage: { inputTokens: 14, outputTokens: 6 } });
    const types = w.seen.map(frame => frame.t === "pi" ? `pi:${(frame.e as { type: string; message?: { role: string } }).type}${(frame.e as { message?: { role: string } }).message ? ":" + (frame.e as { message: { role: string } }).message.role : ""}` : frame.t === "mcp" ? "mcp" : frame.t);
    expect(types).toEqual(["staged", "started", "mcp", "mcp", "mcp", "pi:message_end:system", "pi:message_end:assistant", "pi:tool_execution_start", "mcp", "pi:message_end:assistant", "pi:agent_settled", "exit"]);
    expect(JSON.stringify(w.seen)).not.toMatch(/agent_end|turn_start|"session"|message_start/);
  });
  it("hands pi exactly three agent files, an empty cwd, a disposable HOME, a placeholder-only credential and a minimal environment", async () => {
    const f = setup({ input: { q: "[observe]" }, tools: [] }); const w = launch(f); await w.exit; expect(w.fault()).toBeUndefined();
    const observed = JSON.parse(f.protocol.result().value as string);
    expect(observed.agentFiles).toEqual(["mcp.json", "models.json", "settings.json"]); expect(observed.cwdEntries).toEqual([]);
    expect(observed.home).toBe(`${f.steps}/${f.scope}/home`); expect(observed.cred).toBe(placeholder);
    expect(observed.modes).toEqual({ step: "700", agentFile: "600" });
    const allowed = new Set(["PATH", "HOME", "TMPDIR", "LANG", "PI_CODING_AGENT_DIR", "PI_OFFLINE", "PI_SKIP_VERSION_CHECK", "PI_TELEMETRY", "STUB_KEY", "__CF_USER_TEXT_ENCODING"]);
    expect((observed.envKeys as string[]).filter(key => !allowed.has(key))).toEqual([]); expect(observed.envKeys).not.toContain("SECRET_PARENT"); expect(observed.envKeys).not.toContain("TEST_STEPS");
    expect(JSON.stringify(observed)).not.toContain("must-not-reach-pi");
  });
  it("runs a toolless step with no relay server, no socket and the in-band end only", async () => {
    const f = setup({ tools: [], input: { q: "plain" } }); const w = launch(f); await w.exit; expect(w.fault()).toBeUndefined();
    expect(f.protocol.result().value).toBe("fake answer"); expect(existsSync(path.join(f.steps, f.scope, "mcp.sock"))).toBe(false);
    expect(readFileSync(path.join(f.steps, f.scope, "agent", "mcp.json"), "utf8")).toBe(JSON.stringify({ autoEnableCodemode: false, mcpServers: {} }));
    expect(JSON.parse(readFileSync(notes(f), "utf8").trim()).argv).toContain("--no-tools");
  });
  it("writes the system prompt, settings and models file byte-for-byte as computed by the host", async () => {
    const f = setup({ systemPrompt: "line one\nline two with \"quotes\" and unicode é" }); const w = launch(f); await w.exit; expect(w.fault()).toBeUndefined();
    const files = buildPiAgentFiles(f.spec, token); const base = path.join(f.steps, f.scope);
    expect(readFileSync(path.join(base, "system-prompt.txt"), "utf8")).toBe(f.spec.systemPrompt);
    for (const [name, content] of [["settings.json", files.settings], ["models.json", files.models], ["mcp.json", files.mcp]] as const) expect(sha(readFileSync(path.join(base, "agent", name), "utf8"))).toBe(sha(content));
  });
  it("keeps the user message off argv: it reaches pi on stdin and the host verifies the digest", async () => {
    const f = setup({ input: { q: "[observe] -- --append-system-prompt x" }, tools: [] }); const w = launch(f); await w.exit; expect(w.fault()).toBeUndefined();
    const argv = JSON.parse(readFileSync(notes(f), "utf8").trim()).argv as string[]; expect(argv).toEqual(buildPiArgv(f.spec)); expect(argv.join(" ")).not.toContain("append-system-prompt");
    expect(w.seen.find(frame => frame.t === "started")).toMatchObject({ inputSha256: sha(f.protocol.inputText) });
  });
});

type Boot = { argv: string[]; files: { settings: string; models: string; mcp: string; systemPrompt: string }; [key: string]: unknown };
describe("pi worker admission", () => {
  const mutate = (f: Setup, change: (boot: Boot) => void) => { const body = JSON.parse(buildPiBootstrap(f.spec, token).subarray(4).toString()); change(body); const bytes = Buffer.from(JSON.stringify(body)); const prefix = Buffer.alloc(4); prefix.writeUInt32BE(bytes.length); return Buffer.concat([prefix, bytes]); };
  const rejected: [string, (boot: Boot) => void, string?][] = [
    ["an extra prompt flag", boot => { boot.argv.push("--append-system-prompt", "evil"); }], ["an extension", boot => { boot.argv.push("-e", "/evil.js"); }], ["a skill", boot => { boot.argv.push("--skill", "/x"); }],
    ["a session flag", boot => { boot.argv.push("--session", "s"); }], ["a missing context flag", boot => { boot.argv = boot.argv.filter((value: string) => value !== "--no-context-files"); }],
    ["a foreign prompt path", boot => { boot.argv[boot.argv.indexOf("--system-prompt") + 1] = "/sandbox/AGENTS.md"; }], ["a builtin tool", boot => { boot.argv[boot.argv.indexOf("--tools") + 1] = "bash,read"; }],
    ["a literal api key", boot => { const models = JSON.parse(boot.files.models); models.providers.stubvendor.apiKey = "sk-literal-key-value"; boot.files.models = JSON.stringify(models); }],
    ["a command api key", boot => { const models = JSON.parse(boot.files.models); models.providers.stubvendor.apiKey = "!cat /etc/passwd"; boot.files.models = JSON.stringify(models); }],
    ["a second provider", boot => { const models = JSON.parse(boot.files.models); models.providers.other = models.providers.stubvendor; boot.files.models = JSON.stringify(models); }],
    ["a widened trust setting", boot => { boot.files.settings = JSON.stringify({ ...JSON.parse(boot.files.settings), defaultProjectTrust: "always" }); }],
    ["a second relay server", boot => { const mcp = JSON.parse(boot.files.mcp); mcp.mcpServers.evil = { command: "/bin/sh", args: ["-c", "id"] }; boot.files.mcp = JSON.stringify(mcp); }],
    ["a relay command that is not node", boot => { const mcp = JSON.parse(boot.files.mcp); mcp.mcpServers.component.command = "/bin/sh"; boot.files.mcp = JSON.stringify(mcp); }],
    ["a relay socket outside the step", boot => { const mcp = JSON.parse(boot.files.mcp); mcp.mcpServers.component.args[1] = "/tmp/x.sock"; boot.files.mcp = JSON.stringify(mcp); }],
    ["an extra bootstrap key", boot => { boot.extra = 1; }], ["another protocol version", boot => { boot.protocol = 2; }], ["a malformed token", boot => { boot.token = "short"; }], ["a traversal scope", boot => { boot.scope = "../../etc"; }],
    ["an empty prompt", boot => { boot.files.systemPrompt = ""; }], ["a lowercase credential name", boot => { boot.credentialEnv = "stub_key"; }],
  ];
  it.each(rejected)("exits before any pi process when the bootstrap carries %s", async (_name, change) => {
    const f = setup(); const w = launch(f, { bootstrap: mutate(f, change) }); const result = await w.exit;
    expect(result.code).toBe(70); expect(w.seen).toEqual([]); expect(existsSync(notes(f))).toBe(false); expect(w.stderr()).toMatch(/^worker (?:bootstrap|overload)/);
  });
  it("refuses a credential that is not an OpenShell placeholder, so a real key can never be passed on", async () => {
    for (const value of ["sk-live-looking-secret", "", "Bearer openshell:resolve:env:x"]) {
      const f = setup(); const w = launch(f, { env: { STUB_KEY: value } }); const result = await w.exit;
      expect(result.code).toBe(70); expect(existsSync(notes(f))).toBe(false); expect(w.stderr()).not.toContain(value || "\u0000");
    }
  });
  it("refuses to reuse an existing step directory and an oversized or unterminated bootstrap", async () => {
    const f = setup(); mkdirSync(path.join(f.steps, f.scope), { recursive: true }); expect((await launch(f).exit).code).toBe(70);
    const g = setup(); const big = Buffer.alloc(4); big.writeUInt32BE(1_048_577); expect((await launch(g, { bootstrap: big }).exit).code).toBe(70);
    const h = setup(); const zero = Buffer.alloc(4); expect((await launch(h, { bootstrap: zero }).exit).code).toBe(70);
  });
  it.each([["an agent-dir APPEND_SYSTEM.md", (agent: string) => writeFileSync(path.join(agent, "APPEND_SYSTEM.md"), "HOSTILE")], ["a rewritten models.json", (agent: string) => writeFileSync(path.join(agent, "models.json"), "{}")],
    ["an extra file in the empty cwd", (agent: string) => writeFileSync(path.join(path.dirname(agent), "work", "AGENTS.md"), "HOSTILE")], ["a rewritten system prompt", (agent: string) => writeFileSync(path.join(path.dirname(agent), "system-prompt.txt"), "other")]] as const)(
    "never starts pi when %s appears between staging and the user message", async (_name, plant) => {
    const f = setup(); const w = launch(f, { beforeInput: () => plant(path.join(f.steps, f.scope, "agent")) }); const result = await w.exit;
    expect(result.code).toBe(70); expect(w.stderr()).toMatch(/^worker layout/); expect(existsSync(notes(f))).toBe(false); expect(w.seen.map(frame => frame.t)).toEqual(["staged"]);
  });
  it("rejects any frame it was not told to expect", async () => {
    const f = setup(); const w = launch(f); await waitFor(() => w.seen.some(frame => frame.t === "staged"));
    w.child.stdin.write(JSON.stringify({ t: "bogus" }) + "\n"); expect((await w.exit).code).toBe(70);
  });
  it("agrees with the host on argv admission for a battery of mutations", () => {
    const f = setup(); const good = buildPiArgv(f.spec); const paths = stepPaths(f.steps, f.scope);
    const battery: string[][] = [good, [...good, "--append-system-prompt", "x"], [...good, "--skill", "x"], [...good, "-e", "/e.js"], [...good, "--approve"], [...good, "--api-key", "k"], [...good, "--"], [...good, "run"],
      good.filter(value => value !== "--no-skills"), good.filter(value => value !== "--no-approve"), good.map(value => value === "json" ? "rpc" : value), good.map(value => value === "stubvendor" ? "other" : value),
      good.map(value => value === paths.prompt ? "/sandbox/AGENTS.md" : value), good.map(value => value === "mcp__component__lookup" ? "mcp__component__lookup,bash" : value), good.map(value => value === "mcp__component__lookup" ? "bash" : value), [...good, "--no-tools"],
      [...good, "--thinking", "high"], [...good, "--thinking", "extreme"], [...good, "--no-session"], good.slice(0, -2)];
    for (const argv of battery) {
      const host = (() => { try { admitPiArgv(argv, f.spec); return true; } catch (error) { if (error instanceof PiProtocolFault) return false; throw error; } })();
      const worker = (() => { try { admitArgv(argv, paths, "stubvendor", "stub-model"); return true; } catch { return false; } })();
      // The worker accepts a superset only where it cannot know the host's choice (an optional thinking level); both must reject everything else.
      if (argv.includes("--thinking") && argv[argv.indexOf("--thinking") + 1] === "high") { expect(host, argv.join(" ")).toBe(false); expect(worker, argv.join(" ")).toBe(true); } else expect(worker, argv.join(" ")).toBe(host);
    }
    const spec = { ...f.spec, thinking: "high" as const }; expect(() => admitPiArgv(buildPiArgv(spec), spec)).not.toThrow(); expect(() => admitArgv(buildPiArgv(spec), paths, "stubvendor", "stub-model")).not.toThrow();
    expect(() => admitFiles(JSON.parse("{}"), { paths, credentialEnv: "STUB_KEY", token, tools: ["x"], providerId: "stubvendor", model: "stub-model", shim: "/s", node: "/n" })).toThrow();
  });
});

describe("pi worker CA trust (same admission as the Claude worker)", () => {
  const validEnv = { NODE_EXTRA_CA_CERTS: certificate, SSL_CERT_FILE: bundle };
  function trust(change?: (p: string, s: fs.Stats, kind: string) => void) {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "genbi-pi-ca-"))); roots.push(root); const map = writeMaterial(root); const io = makeIo(root, change);
    return { root, map, io, admit: (env: Record<string, string>) => supervisorCaTrust(env, io, 1500, 1500) };
  }
  it("accepts both variables unset without reading anything, and exactly the supervisor material through the filesystem seam", () => {
    expect(supervisorCaTrust({}, { lstatSync() { throw new Error("must not read"); } }, 1500, 1500).environment).toEqual({});
    const t = trust(); const admitted = t.admit({ ...validEnv, HTTP_PROXY: "http://ambient.test", NODE_OPTIONS: "--trace-warnings" });
    expect(admitted.environment).toEqual(validEnv); admitted.assertCurrent(); admitted.close(); expect(t.io.descriptors.size).toBe(0);
  });
  it.each([
    ["only one variable", { NODE_EXTRA_CA_CERTS: certificate }], ["the bundle without the certificate", { SSL_CERT_FILE: bundle }], ["a path outside the supervisor material", { NODE_EXTRA_CA_CERTS: "/etc/openshell-tls/openshell-ca.pem", SSL_CERT_FILE: "/etc/openshell-tls/ca-bundle.pem" }],
    ["/etc/ssl", { NODE_EXTRA_CA_CERTS: "/etc/ssl/certs/ca-certificates.crt", SSL_CERT_FILE: "/etc/ssl/certs/ca-certificates.crt" }], ["the paths swapped", { NODE_EXTRA_CA_CERTS: bundle, SSL_CERT_FILE: certificate }],
    ["traversal into the material", { NODE_EXTRA_CA_CERTS: `${material}/../material/ca.crt`, SSL_CERT_FILE: bundle }], ["a doubled slash", { NODE_EXTRA_CA_CERTS: certificate, SSL_CERT_FILE: `${material}//ca-bundle.crt` }],
    ["a trailing NUL", { NODE_EXTRA_CA_CERTS: `${certificate}\0`, SSL_CERT_FILE: bundle }],
  ])("refuses %s", (_name, env) => { const t = trust(); expect(() => t.admit(env), _name).toThrow("worker trust admission"); expect(t.io.descriptors.size).toBe(0); });
  it.each(["uid", "gid", "mode"])("refuses a certificate with the wrong %s", (field) => {
    const t = trust((p, s) => { if (p === certificate) { if (field === "mode") s.mode |= 0o200; else s[field as "uid" | "gid"] = 0; } }); expect(() => t.admit(validEnv)).toThrow("worker trust admission"); expect(t.io.descriptors.size).toBe(0);
  });
  it.each([certificate, material])("refuses a symlink at %s", (p) => {
    const t = trust(); const target = t.map(p) + "-real"; renameSync(t.map(p), target); symlinkSync(target, t.map(p)); expect(() => t.admit(validEnv)).toThrow("worker trust admission"); expect(t.io.descriptors.size).toBe(0);
  });
  it("refuses a writable material directory, a leaf replaced between open and fstat, and use after close", () => {
    expect(() => trust((p, s) => { if (p === material) s.mode |= 0o022; }).admit(validEnv)).toThrow("worker trust admission");
    expect(() => trust((p, s, kind) => { if (p === certificate && kind === "fd") s.ino++; }).admit(validEnv)).toThrow("worker trust admission");
    const t = trust(); const admitted = t.admit(validEnv); admitted.close(); expect(() => admitted.assertCurrent()).toThrow("worker trust admission");
  });
  it.each(["0", "false", "", "off"])("refuses the TLS verification override %s", (value) => {
    expect(() => supervisorCaTrust({ NODE_TLS_REJECT_UNAUTHORIZED: value }, {}, 1500, 1500)).toThrow("worker trust admission"); expect(() => supervisorCaTrust({ BUN_TLS_REJECT_UNAUTHORIZED: value }, {}, 1500, 1500)).toThrow("worker trust admission");
  });
  it("the pi worker runs the same module byte for byte, so the two cannot drift", () => {
    expect(readFileSync(path.join(assets, "claude-worker-ca.mjs"))).toEqual(readFileSync(path.resolve(here, "../runtime-assets/claude-worker/claude-worker-ca.mjs")));
    expect(readFileSync(path.join(assets, "pi-pins.mjs"), "utf8")).toContain("trust: '/opt/genbi/claude-worker-ca.mjs'");
  });
  it("the worker exits before any pi process on an unacceptable CA setting, and starts pi with the admitted variables otherwise", async () => {
    const t = trust();
    for (const env of [{ NODE_EXTRA_CA_CERTS: "/etc/openshell-tls/openshell-ca.pem", SSL_CERT_FILE: "/etc/openshell-tls/ca-bundle.pem" }, { NODE_TLS_REJECT_UNAUTHORIZED: "0" }, { NODE_EXTRA_CA_CERTS: certificate }, validEnv]) {
      const bad = setup({ tools: [] }); const refused = launch(bad, { env }); expect((await refused.exit).code, JSON.stringify(env)).toBe(70);
      expect(refused.stderr()).toMatch(/^worker bootstrap/); expect(existsSync(notes(bad))).toBe(false); expect(refused.seen).toEqual([]);
    }
    const unset = setup({ input: { q: "[observe]" }, tools: [] }); const none = launch(unset); await none.exit; expect(none.fault()).toBeUndefined();
    const envKeys = (f: Setup) => JSON.parse(f.protocol.result().value as string).envKeys as string[]; expect(envKeys(unset)).not.toContain("NODE_EXTRA_CA_CERTS");
    const good = setup({ input: { q: "[observe]" }, tools: [] }); const w = launch(good, { env: { TEST_CA_ROOT: t.root, ...validEnv } }); await w.exit; expect(w.fault()).toBeUndefined();
    expect(envKeys(good)).toEqual(expect.arrayContaining(["NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE"]));
  });
  it("re-checks the material just before pi starts and never starts pi when it changed", async () => {
    const t = trust(); const f = setup({ tools: [] }); const w = launch(f, { env: { TEST_CA_ROOT: t.root, ...validEnv }, beforeInput: () => { chmodSync(t.map(certificate), 0o644); } });
    expect((await w.exit).code).toBe(70); expect(w.stderr()).toMatch(/^worker trust/); expect(existsSync(notes(f))).toBe(false);
  });
});

describe("pi worker cancellation and process accounting", () => {
  it("kills pi, its relay and their children when the transport closes before the in-band end", async () => {
    const f = setup({ input: { q: "[stall]" } }); const w = launch(f);
    await waitFor(() => existsSync(pids(f)) && w.seen.some(frame => frame.t === "started"));
    const ids = JSON.parse(readFileSync(pids(f), "utf8")) as { pi: number; child: number; shim: number };
    expect([ids.pi, ids.child, ids.shim].every(alive)).toBe(true);
    w.child.stdin.end(); const result = await w.exit; expect(result.code).not.toBe(0);
    await waitFor(() => ![ids.pi, ids.child, ids.shim].some(alive)); expect(w.seen.some(frame => frame.t === "exit")).toBe(false);
  });
  it("kills everything when the host kills the worker's input channel with a partial frame pending", async () => {
    const f = setup({ input: { q: "[stall]" } }); const w = launch(f); await waitFor(() => existsSync(pids(f)));
    const ids = JSON.parse(readFileSync(pids(f), "utf8")) as { pi: number; child: number };
    w.child.stdin.write('{"t":"mcp"'); w.child.stdin.destroy(); await w.exit; await waitFor(() => ![ids.pi, ids.child].some(alive));
  });
  it("reports a process that left pi's group but still runs, and the host fails closed on it", async () => {
    const f = setup({ input: { q: "[escape]" }, tools: [] }); const w = launch(f, { env: { TEST_MARKER: "ESCAPED-STEP-PROCESS" } }); await w.exit;
    const exit = w.seen.find(frame => frame.t === "exit") as { remaining: number } | undefined; expect(exit?.remaining).toBeGreaterThan(0); expect(w.fault()).toBeInstanceOf(PiProtocolFault);
    const escaped = JSON.parse(readFileSync(pids(f), "utf8")) as { escapee: number }; try { process.kill(escaped.escapee, "SIGKILL"); } catch { /* gone */ }
  }, 20_000);
  it("counts descendants, group members and command-line matches, and ignores zombies and the worker itself", () => {
    const rows = [{ pid: 10, ppid: 1, pgrp: 10, state: "S", cmdline: "worker" }, { pid: 11, ppid: 10, pgrp: 11, state: "S", cmdline: "pi" }, { pid: 12, ppid: 11, pgrp: 11, state: "S", cmdline: "shim" }, { pid: 13, ppid: 1, pgrp: 11, state: "S", cmdline: "orphan" },
      { pid: 14, ppid: 1, pgrp: 14, state: "S", cmdline: "node /opt/genbi/pi-mcp-shim.mjs a b" }, { pid: 15, ppid: 11, pgrp: 11, state: "Z", cmdline: "" }, { pid: 16, ppid: 1, pgrp: 16, state: "S", cmdline: "unrelated" }];
    expect(remainingProcesses(rows, 10, 11)).toBe(4); expect(remainingProcesses(rows, 10, undefined)).toBe(3); expect(remainingProcesses([rows[0], rows[6]], 10, 11)).toBe(0);
    expect(remainingProcesses([{ pid: 20, ppid: 1, pgrp: 20, state: "S", cmdline: "/opt/pi/node_modules/.bin/pi" }], 10, undefined)).toBe(1);
    expect(remainingProcesses([{ pid: 21, ppid: 1, pgrp: 21, state: "S", cmdline: "pi", comm: "pi" }, { pid: 22, ppid: 1, pgrp: 22, state: "S", cmdline: "pip", comm: "pip" }], 10, undefined)).toBe(1);
  });
});

describe("pi relay shim", () => {
  const shim = path.join(assets, "pi-mcp-shim.mjs");
  const run = (args: string[]) => spawnSync(process.execPath, [shim, ...args], { encoding: "utf8", timeout: 10_000, input: "" });
  it("exits without connecting unless given the exact socket path and token form", () => {
    const root = mkdtempSync(path.join(tmpdir(), "genbi-pi-shim-")); roots.push(root);
    const dir = path.join(root, randomUUID()); mkdirSync(dir, { mode: 0o700 }); const socket = path.join(dir, "mcp.sock"); writeFileSync(socket, ""); chmodSync(socket, 0o600);
    for (const args of [[], [socket], ["relative/mcp.sock", token], [socket, "short"], [socket, token, "extra"], ["/tmp/other.sock", token], [path.join(root, "x", "mcp.sock"), token], [socket, token]])
      expect(run(args).status, args.join(" ")).toBe(1);
    chmodSync(dir, 0o755); expect(run([socket, token]).status).toBe(1);
  });
  it("is closed by construction: no network, no process spawning, no environment access, no file writes", () => {
    const source = readFileSync(shim, "utf8");
    expect([...source.matchAll(/from '([^']+)'/g)].map(match => match[1]).sort()).toEqual(["node:fs", "node:net", "node:path"]);
    for (const forbidden of [/process\.env/, /\benv\b/, /\bfetch\b/, /https?:/, /child_process/, /\bdns\b/, /\bdgram\b/, /writeFile/, /appendFile/, /console\./, /process\.stderr/, /net\.connect\(\{\s*(?:host|port)/, /createServer/, /\beval\b/, /new Function/])
      expect(source, String(forbidden)).not.toMatch(forbidden);
    expect(source).toContain("net.connect({ path: socketPath })");
  });
  it("keeps the worker free of anything that grants authority or reads outside the step", () => {
    const source = readFileSync(path.join(assets, "pi-worker-core.mjs"), "utf8");
    for (const forbidden of [/\bfetch\b/, /https?\.request/, /node:http/, /node:https/, /node:dns/, /eval\(/, /new Function/, /execve/, /readFileSync\('\/etc/])
      expect(source, String(forbidden)).not.toMatch(forbidden);
    expect(readdirSync(assets).sort()).toEqual(expect.arrayContaining(["Dockerfile", "package-lock.json", "package.json", "pi-mcp-shim.mjs", "pi-pins.mjs", "pi-proc-check.mjs", "pi-worker-core.mjs", "pi-worker.mjs", "policy.template.yaml", "profile.template.yaml"]));
  });
});
