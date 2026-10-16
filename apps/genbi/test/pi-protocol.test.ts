import { describe, expect, it } from "vitest";
import { PI_SETTINGS, PI_TRANSPORT_LIMITS as L, PiLineFrames, PiProtocolFault, PiStepProtocol, admitPiArgv, buildPiAgentFiles, buildPiArgv, buildPiBootstrap, expectedPiDigests, piStepPaths, sha256Hex, type PiStepSpec } from "../server/runtime-host/pi-protocol.js";

const scope = "11111111-2222-4333-8444-555555555555";
const token = "ab".repeat(16);
const endpoint = { providerId: "stubvendor", api: "openai-completions" as const, baseUrl: "http://host.example.test:18694/v1", credentialEnv: "STUB_KEY" };
const schema = { type: "object", properties: { code: { type: "string" } }, required: ["code"], additionalProperties: false };
const prompt = "BRIEF\n\nPROMPT";
function make(options: { tools?: string[]; scopeId?: string; input?: Record<string, unknown> } = {}) {
  const names = options.tools ?? ["lookup"];
  const tools = Object.fromEntries(names.map(name => [name, async () => ({ ok: true })]));
  const run = { tools, toolSchemas: Object.fromEntries(names.map(name => [name, schema])), toolDescriptions: Object.fromEntries(names.map(name => [name, `${name} tool`])), request: "ask", input: options.input ?? { q: "hello" }, consumes: {} };
  const spec: PiStepSpec = { scope: options.scopeId ?? scope, model: "stub-model", endpoint, systemPrompt: prompt, tools: names };
  const protocol = new PiStepProtocol({ run, spec, token, check() {} });
  return { run, spec, protocol, digests: expectedPiDigests(spec, token) };
}
const wire = (name: string) => `mcp__component__${name}`;
const stagedFrame = (f: ReturnType<typeof make>, overrides: Record<string, unknown> = {}) => ({ t: "staged", protocol: 1, scope: f.spec.scope, digests: f.digests, ...overrides });
const started = (f: ReturnType<typeof make>, overrides: Record<string, unknown> = {}) => ({ t: "started", scope: f.spec.scope, inputSha256: f.protocol.inputSha256, ...overrides });
const pi = (e: Record<string, unknown>) => ({ t: "pi", e });
const system = (f: ReturnType<typeof make>, overrides: { toolsAdded?: unknown; sections?: unknown } = {}) => pi({ type: "message_end", message: { role: "system", content: "",
  sections: overrides.sections ?? { preamble: prompt, cwd: `<cwd>\n${piStepPaths(f.spec.scope).cwd}\n</cwd>` },
  toolsAdded: overrides.toolsAdded ?? f.spec.tools.map(name => ({ name: wire(name), description: "d", parameters: schema })) } });
const assistant = (stopReason: string, text = "answer", extra: Record<string, unknown> = {}) => pi({ type: "message_end", message: { role: "assistant", stopReason, content: text ? [{ type: "text", text }] : [], usage: { input: 10, output: 2, cacheRead: 3, cacheWrite: 1 }, ...extra } });
const settled = pi({ type: "agent_settled" });
const exit = (f: ReturnType<typeof make>, overrides: Record<string, unknown> = {}) => ({ t: "exit", scope: f.spec.scope, code: 0, signal: null, forced: false, remaining: 0, ...overrides });
const rpc = (m: Record<string, unknown>) => ({ t: "mcp", m: { jsonrpc: "2.0", ...m } as { jsonrpc: string; id?: unknown; method?: string; params?: Record<string, unknown> } });
const init = rpc({ id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: { roots: {} }, clientInfo: { name: "pi", version: "1.0.4" } } });
const initialized = rpc({ method: "notifications/initialized" });
const call = (id: number, name = "lookup", args: unknown = { code: "K7" }) => rpc({ id, method: "tools/call", params: { name, arguments: args, _meta: { progressToken: id } } });
/** Drives a protocol to the point where pi runs; returns the effect of each step. */
function prepare(f: ReturnType<typeof make>, withMcp = true) {
  f.protocol.worker(stagedFrame(f) as never); f.protocol.host({ t: "input", text: f.protocol.inputText });
  f.protocol.worker(started(f) as never);
  if (withMcp) { f.protocol.worker(init as never); f.protocol.host({ t: "mcp", m: { jsonrpc: "2.0", id: 1, result: {} } }); f.protocol.worker(initialized as never);
    const list = rpc({ id: 2, method: "tools/list" }); f.protocol.worker(list as never); f.protocol.host({ t: "mcp", m: { jsonrpc: "2.0", id: 2, result: {} } }); }
}
function finish(f: ReturnType<typeof make>, finalStop = "stop") {
  f.protocol.worker(system(f) as never); f.protocol.worker(assistant(finalStop) as never); f.protocol.worker(settled as never);
  f.protocol.host({ t: "end" }); f.protocol.worker(exit(f) as never);
}
const faults = (fn: () => unknown) => { try { fn(); } catch (error) { return error instanceof PiProtocolFault ? error.code : "other"; } return undefined; };

describe("pi argv and agent files", () => {
  it("builds exactly the closed argv, with the host prompt as a file and no message argument", () => {
    const argv = buildPiArgv(make().spec);
    expect(argv).toEqual(["--mode", "json", "--no-session", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-approve", "-e", "builtin:mcp",
      "--tools", wire("lookup"), "--system-prompt", piStepPaths(scope).prompt, "--provider", "stubvendor", "--model", "stub-model"]);
    for (const forbidden of ["--append-system-prompt", "--skill", "--prompt-template", "--theme", "--api-key", "--approve", "--continue", "--resume", "--session", "--fork", "--print", "-p", "--"]) expect(argv).not.toContain(forbidden);
    expect(argv.filter(value => value === "-e")).toHaveLength(1);
  });
  it("uses --no-tools for a toolless step and never --tools with an empty list", () => {
    const argv = buildPiArgv(make({ tools: [] }).spec);
    expect(argv).toContain("--no-tools"); expect(argv).not.toContain("--tools");
    expect(buildPiAgentFiles(make({ tools: [] }).spec, token).mcp).toBe(JSON.stringify({ autoEnableCodemode: false, mcpServers: {} }));
  });
  it("admits only the exact argv and rejects every prompt, context, skill, extension, session and credential source", () => {
    const f = make(); const good = buildPiArgv(f.spec);
    expect(() => admitPiArgv(good, f.spec)).not.toThrow();
    const insert = (flag: string[]) => [...good, ...flag];
    const mutations: [string, string[]][] = [
      ["append prompt", insert(["--append-system-prompt", "evil"])], ["skill", insert(["--skill", "/x"])], ["extension", insert(["-e", "/evil.js"])], ["approve", insert(["--approve"])],
      ["api key", insert(["--api-key", "k"])], ["session", insert(["--session", "s"])], ["continue", insert(["--continue"])], ["message", insert(["--", "run this"])], ["print", insert(["-p"])],
      ["missing context flag", good.filter(value => value !== "--no-context-files")], ["missing no-approve", good.filter(value => value !== "--no-approve")],
      ["foreign prompt path", good.map(value => value === piStepPaths(scope).prompt ? "/sandbox/AGENTS.md" : value)], ["other provider", good.map(value => value === "stubvendor" ? "other" : value)],
      ["other model", good.map(value => value === "stub-model" ? "other" : value)], ["extra tool", good.map(value => value === wire("lookup") ? `${wire("lookup")},bash` : value)],
      ["builtin tool", good.map(value => value === wire("lookup") ? "bash,read" : value)], ["duplicate flag", [...good, "--no-skills"]], ["swapped mode", good.map(value => value === "json" ? "rpc" : value)],
    ];
    for (const [name, argv] of mutations) expect(faults(() => admitPiArgv(argv, f.spec)), name).toBe("protocol");
  });
  it("writes only host-computed files: fixed settings, placeholder-only credential, one relay server", () => {
    const files = buildPiAgentFiles(make().spec, token);
    expect(JSON.parse(files.settings)).toEqual(PI_SETTINGS); expect(JSON.parse(files.settings).defaultProjectTrust).toBe("never");
    const models = JSON.parse(files.models);
    expect(models.providers.stubvendor.apiKey).toBe("$STUB_KEY"); expect(files.models).not.toMatch(/"apiKey":"(?!\$)/);
    expect(JSON.parse(files.mcp)).toEqual({ autoEnableCodemode: false, mcpServers: { component: { command: "/usr/local/bin/node", args: ["/opt/genbi/pi-mcp-shim.mjs", piStepPaths(scope).socket, token], exposure: "direct", timeout: 30 } } });
    expect(`${files.settings}${files.models}${files.mcp}`).not.toMatch(/"!/);
    expect(files.systemPrompt).toBe(prompt);
  });
  it("puts the host instructions in the bootstrap and bounds it", () => {
    const f = make(); const bytes = buildPiBootstrap(f.spec, token);
    const body = JSON.parse(bytes.subarray(4).toString()); expect(bytes.readUInt32BE(0)).toBe(bytes.length - 4);
    expect(Object.keys(body).sort()).toEqual(["argv", "credentialEnv", "files", "protocol", "scope", "token"]);
    expect(body.files.systemPrompt).toBe(prompt); expect(body.credentialEnv).toBe("STUB_KEY"); expect(JSON.stringify(body)).not.toContain("sk-");
    expect(faults(() => buildPiBootstrap({ ...f.spec, systemPrompt: "x".repeat(L.line + 1) }, token))).toBeDefined();
    expect(() => buildPiBootstrap({ ...f.spec, systemPrompt: "" }, token)).toThrow();
  });
  it("rejects specs that could widen the process: more than 32 tools, unsafe names, duplicate tools, non-closed endpoint", () => {
    const f = make();
    for (const spec of [{ ...f.spec, tools: ["a,b"] }, { ...f.spec, tools: ["x", "x"] }, { ...f.spec, model: "bad model" }, { ...f.spec, scope: "../escape" },
      { ...f.spec, tools: Array.from({ length: L.calls + 1 }, (_, i) => `tool_${i}`) }, { ...f.spec, endpoint: { ...endpoint, baseUrl: "http://user:pw@host.example.test/v1" } }, { ...f.spec, endpoint: { ...endpoint, credentialEnv: "lower" } }, { ...f.spec, endpoint: { ...endpoint, providerId: "Has Space" } }])
      expect(() => buildPiArgv(spec as PiStepSpec)).toThrow();
  });
});

describe("pi line framing", () => {
  it("splits LF frames on bytes, caps lines and frame counts, and rejects invalid UTF-8 or JSON", () => {
    const frames = new PiLineFrames();
    expect(frames.feed(Buffer.from('{"a":1}\n{"b"')).map(frame => frame.value)).toEqual([{ a: 1 }]); expect(frames.feed(Buffer.from(':2}\n')).map(frame => frame.value)).toEqual([{ b: 2 }]);
    expect(faults(() => new PiLineFrames().feed(Buffer.from("not json\n")))).toBe("protocol");
    expect(faults(() => new PiLineFrames().feed(Buffer.from([0x7b, 0xff, 0x7d, 10])))).toBe("protocol");
    expect(faults(() => new PiLineFrames().feed(Buffer.from("[1]\n")))).toBe("protocol");
    expect(faults(() => new PiLineFrames().feed(Buffer.from(`{"x":"${"a".repeat(L.line)}"}\n`)))).toBe("overload");
    expect(faults(() => new PiLineFrames().feed(Buffer.alloc(L.line, 97)))).toBe("overload");
    const many = new PiLineFrames(); expect(faults(() => { for (let i = 0; i <= L.frames; i++) many.feed(Buffer.from("{}\n")); })).toBe("overload");
    const partial = new PiLineFrames(); partial.feed(Buffer.from('{"a"')); expect(faults(() => partial.end())).toBe("protocol");
  });
});

describe("pi step protocol: success is judged from events", () => {
  it("completes the in-band lifecycle and derives the answer and usage from the last assistant message", () => {
    const f = make(); prepare(f);
    const effect = f.protocol.worker(call(3) as never);
    expect(effect).toMatchObject({ kind: "mcp", action: { kind: "call", id: 3, name: "lookup", input: { code: "K7" } } });
    f.protocol.host(f.protocol.answer(3, { word: "marmalade" }) as never);
    f.protocol.worker(system(f) as never); f.protocol.worker(pi({ type: "tool_execution_start", toolName: wire("lookup") }) as never);
    f.protocol.worker(assistant("toolUse", "") as never); f.protocol.worker(assistant("stop", "the word is marmalade") as never);
    expect(f.protocol.worker(settled as never)).toEqual({ kind: "settled" }); f.protocol.host({ t: "end" }); expect(f.protocol.worker(exit(f) as never)).toEqual({ kind: "exited" });
    expect(f.protocol.result()).toEqual({ value: "the word is marmalade", usage: { inputTokens: 28, outputTokens: 4 } });
  });
  it("answers initialize, ping and tools/list from the real step tools only", () => {
    const f = make({ tools: ["lookup", "other"] }); f.protocol.worker(stagedFrame(f) as never); f.protocol.host({ t: "input", text: f.protocol.inputText }); f.protocol.worker(started(f) as never);
    expect(f.protocol.worker(init as never)).toMatchObject({ kind: "mcp", action: { kind: "respond", frame: { t: "mcp", m: { id: 1, result: { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "component" } } } } } });
    f.protocol.host({ t: "mcp", m: { jsonrpc: "2.0", id: 1, result: {} } }); f.protocol.worker(initialized as never);
    f.protocol.worker(rpc({ id: 5, method: "ping" }) as never); f.protocol.host({ t: "mcp", m: { jsonrpc: "2.0", id: 5, result: {} } });
    const listed = f.protocol.worker(rpc({ id: 6, method: "tools/list" }) as never) as unknown as { action: { frame: { m: { result: { tools: { name: string; description: string; inputSchema: unknown }[] } } } } };
    expect(listed.action.frame.m.result.tools).toEqual([{ name: "lookup", description: "lookup tool", inputSchema: schema }, { name: "other", description: "other tool", inputSchema: schema }]);
  });
  it.each(["length", "error", "toolUse", "aborted", "pending"])("fails closed when the last assistant stopReason is %s, whatever the exit status", (reason) => {
    const f = make(); prepare(f); finish(f, reason);
    expect(faults(() => f.protocol.result())).toBe("protocol");
  });
  it("fails closed on an empty answer, a missing settle, a missing end or a missing exit frame", () => {
    const empty = make(); prepare(empty); empty.protocol.worker(system(empty) as never); empty.protocol.worker(assistant("stop", "") as never); empty.protocol.worker(settled as never); empty.protocol.host({ t: "end" }); empty.protocol.worker(exit(empty) as never);
    expect(faults(() => empty.protocol.result())).toBe("protocol");
    const unsettled = make(); prepare(unsettled); unsettled.protocol.worker(system(unsettled) as never); unsettled.protocol.worker(assistant("stop") as never);
    expect(faults(() => unsettled.protocol.result())).toBe("protocol");
    const noExit = make(); prepare(noExit); noExit.protocol.worker(system(noExit) as never); noExit.protocol.worker(assistant("stop") as never); noExit.protocol.worker(settled as never); noExit.protocol.host({ t: "end" });
    expect(faults(() => noExit.protocol.result())).toBe("protocol");
  });
  it("requires the system toolsAdded to equal the expected tool set exactly", () => {
    const missing = make({ tools: ["lookup", "other"] }); prepare(missing);
    expect(faults(() => missing.protocol.worker(system(missing, { toolsAdded: [{ name: wire("lookup") }] }) as never))).toBe("protocol");
    const extra = make(); prepare(extra);
    expect(faults(() => extra.protocol.worker(system(extra, { toolsAdded: [{ name: wire("lookup") }, { name: "bash" }] }) as never))).toBe("protocol");
    const none = make(); prepare(none);
    expect(faults(() => none.protocol.worker(system(none, { toolsAdded: [] }) as never))).toBe("protocol");
    const duplicate = make(); prepare(duplicate);
    expect(faults(() => duplicate.protocol.worker(system(duplicate, { toolsAdded: [{ name: wire("lookup") }, { name: wire("lookup") }] }) as never))).toBe("protocol");
    const toolless = make({ tools: [] }); prepare(toolless, false);
    expect(() => toolless.protocol.worker(system(toolless, { toolsAdded: [] }) as never)).not.toThrow();
    const leaking = make({ tools: [] }); prepare(leaking, false);
    expect(faults(() => leaking.protocol.worker(system(leaking, { toolsAdded: [{ name: wire("lookup") }] }) as never))).toBe("protocol");
  });
  it("accepts only the host prompt and cwd as system sections (an addendum, context file or skill section is a leak)", () => {
    const cwd = (f: ReturnType<typeof make>) => `<cwd>\n${piStepPaths(f.spec.scope).cwd}\n</cwd>`;
    for (const [name, sections] of Object.entries({
      addendum: (f: ReturnType<typeof make>) => ({ preamble: prompt, addendum: "<addendum>\nHOSTILE\n</addendum>", cwd: cwd(f) }),
      context: (f: ReturnType<typeof make>) => ({ preamble: prompt, contextFiles: "AGENTS.md", cwd: cwd(f) }),
      skills: (f: ReturnType<typeof make>) => ({ preamble: prompt, skills: "evil", cwd: cwd(f) }),
      preamble: (f: ReturnType<typeof make>) => ({ preamble: `${prompt}\nextra`, cwd: cwd(f) }),
      defaultPrompt: (f: ReturnType<typeof make>) => ({ preamble: "You are an expert coding assistant", cwd: cwd(f) }),
      cwd: () => ({ preamble: prompt, cwd: "<cwd>\n/sandbox\n</cwd>" }),
      missing: () => ({ preamble: prompt }),
    })) { const f = make(); prepare(f); expect(faults(() => f.protocol.worker(system(f, { sections: sections(f) }) as never)), name).toBe("protocol"); }
  });
  it("rejects an assistant tool call to an undeclared tool and any non-system/assistant message", () => {
    const f = make(); prepare(f); f.protocol.worker(system(f) as never);
    expect(faults(() => f.protocol.worker(pi({ type: "message_end", message: { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", name: wire("other"), arguments: {} }] } }) as never))).toBe("protocol");
    const g = make(); prepare(g); expect(faults(() => g.protocol.worker(pi({ type: "message_end", message: { role: "user", content: [] } }) as never))).toBe("protocol");
    const h = make(); prepare(h); expect(faults(() => h.protocol.worker(assistant("stop") as never))).toBe("protocol");
    const i = make(); prepare(i); i.protocol.worker(system(i) as never); expect(faults(() => i.protocol.worker(system(i) as never))).toBe("protocol");
  });
});

describe("pi step protocol: ordering, versions and scope", () => {
  it.each(["argv", "settings", "models", "mcp", "prompt"] as const)("rejects a staged frame whose %s digest differs from the host computation", (key) => {
    const f = make(); expect(faults(() => f.protocol.worker(stagedFrame(f, { digests: { ...f.digests, [key]: sha256Hex("tampered") } }) as never))).toBe("protocol");
  });
  it("rejects a staged frame with another scope, another protocol version, or extra fields", () => {
    const f = make(); expect(faults(() => f.protocol.worker(stagedFrame(f, { scope: "99999999-2222-4333-8444-555555555555" }) as never))).toBe("protocol");
    expect(faults(() => make().protocol.worker(stagedFrame(f, { protocol: 2 }) as never))).toBe("protocol");
    expect(faults(() => make().protocol.worker(stagedFrame(f, { extra: 1 }) as never))).toBe("protocol");
    const again = make(); again.protocol.worker(stagedFrame(again) as never); expect(faults(() => again.protocol.worker(stagedFrame(again) as never))).toBe("protocol");
  });
  it("accepts the user message only once, only after staging and only with the exact host text", () => {
    const f = make(); expect(faults(() => f.protocol.host({ t: "input", text: f.protocol.inputText }))).toBe("protocol");
    const g = make(); g.protocol.worker(stagedFrame(g) as never); expect(faults(() => g.protocol.host({ t: "input", text: "something else" }))).toBe("protocol");
    g.protocol.host({ t: "input", text: g.protocol.inputText }); expect(faults(() => g.protocol.host({ t: "input", text: g.protocol.inputText }))).toBe("protocol");
    expect(g.protocol.inputText).toBe(JSON.stringify({ request: "ask", input: { q: "hello" }, consumes: {} }));
  });
  it("rejects worker frames before the exact staged/started handshake and a started digest that is not the host input", () => {
    for (const frame of [(f: ReturnType<typeof make>) => system(f), () => settled, (f: ReturnType<typeof make>) => started(f), () => init])
      { const f = make(); expect(faults(() => f.protocol.worker(frame(f) as never))).toBe("protocol"); }
    const g = make(); g.protocol.worker(stagedFrame(g) as never); expect(faults(() => g.protocol.worker(started(g) as never))).toBe("protocol");
    const h = make(); h.protocol.worker(stagedFrame(h) as never); h.protocol.host({ t: "input", text: h.protocol.inputText });
    expect(faults(() => h.protocol.worker(started(h, { inputSha256: sha256Hex("other") }) as never))).toBe("protocol");
    expect(faults(() => make().protocol.worker({ t: "unknown" } as never))).toBe("protocol");
  });
  it("rejects any frame after settle and after exit, an early or forced exit, and leftover processes", () => {
    const late = make(); prepare(late); late.protocol.worker(system(late) as never); late.protocol.worker(assistant("stop") as never); late.protocol.worker(settled as never);
    expect(faults(() => late.protocol.worker(call(9) as never))).toBe("protocol");
    expect(faults(() => late.protocol.worker(assistant("stop") as never))).toBe("protocol");
    const done = make(); prepare(done); finish(done); expect(faults(() => done.protocol.worker(assistant("stop") as never))).toBe("protocol"); expect(faults(() => done.protocol.worker(exit(done) as never))).toBe("protocol");
    const early = make(); prepare(early); expect(faults(() => early.protocol.worker(exit(early) as never))).toBe("protocol");
    for (const overrides of [{ forced: true }, { remaining: 1 }, { scope: "99999999-2222-4333-8444-555555555555" }]) {
      const f = make(); prepare(f); f.protocol.worker(system(f) as never); f.protocol.worker(assistant("stop") as never); f.protocol.worker(settled as never); f.protocol.host({ t: "end" });
      expect(faults(() => f.protocol.worker(exit(f, overrides) as never)), JSON.stringify(overrides)).toBe("protocol");
    }
  });
  it("sends the end sentinel only after settle, once, and with no call outstanding", () => {
    const early = make(); prepare(early); expect(faults(() => early.protocol.host({ t: "end" }))).toBe("protocol");
    const pending = make(); prepare(pending); pending.protocol.worker(call(3) as never); pending.protocol.worker(system(pending) as never); pending.protocol.worker(assistant("stop") as never);
    expect(faults(() => pending.protocol.worker(settled as never))).toBe("protocol");
    const twice = make(); prepare(twice); twice.protocol.worker(system(twice) as never); twice.protocol.worker(assistant("stop") as never); twice.protocol.worker(settled as never); twice.protocol.host({ t: "end" });
    expect(faults(() => twice.protocol.host({ t: "end" }))).toBe("protocol");
  });
  it("refuses a call for another step's tool and an answer nobody asked for", () => {
    const a = make({ tools: ["lookup"] }); const b = make({ tools: ["other"], scopeId: "99999999-2222-4333-8444-555555555555" });
    prepare(a); prepare(b);
    expect(faults(() => a.protocol.worker(call(3, "other") as never))).toBe("protocol");
    expect(faults(() => b.protocol.worker(call(3, "lookup") as never))).toBe("protocol");
    expect(faults(() => b.protocol.worker(stagedFrame(a) as never))).toBe("protocol");
    const c = make(); prepare(c); expect(faults(() => c.protocol.host({ t: "mcp", m: { jsonrpc: "2.0", id: 77, result: {} } }))).toBe("protocol");
    c.protocol.worker(call(3) as never); c.protocol.host(c.protocol.answer(3, 1) as never); expect(faults(() => c.protocol.host(c.protocol.answer(3, 1) as never))).toBe("protocol");
    expect(faults(() => c.protocol.host({ t: "mcp", m: { jsonrpc: "2.0", id: 3, result: {}, error: { code: 1, message: "x" } } } as never))).toBe("protocol");
  });
});

describe("pi step protocol: tool channel", () => {
  it.each([
    ["undeclared tool", () => call(3, "bash")], ["prefixed wire name", () => call(3, wire("lookup"))], ["prototype key", () => call(3, "__proto__")], ["constructor", () => call(3, "constructor")],
    ["missing argument", () => call(3, "lookup", {})], ["extra argument", () => call(3, "lookup", { code: "K7", sql: "select 1" })], ["wrong type", () => call(3, "lookup", { code: 7 })],
    ["non-object arguments", () => call(3, "lookup", [1])], ["unknown params key", () => rpc({ id: 3, method: "tools/call", params: { name: "lookup", arguments: { code: "a" }, task: {} } })],
    ["unknown method", () => rpc({ id: 3, method: "resources/list" })], ["notification with unknown method", () => rpc({ method: "notifications/roots/list_changed" })],
    ["oversized arguments", () => call(3, "lookup", { code: "x".repeat(65_537) })], ["oversized meta", () => rpc({ id: 3, method: "tools/call", params: { name: "lookup", arguments: { code: "a" }, _meta: { a: "x".repeat(2000) } } })],
    ["bad jsonrpc", () => ({ t: "mcp", m: { jsonrpc: "1.0", id: 3, method: "ping" } })], ["id of the wrong type", () => rpc({ id: { x: 1 }, method: "ping" })],
  ])("rejects %s without producing a call", (_name, frame) => {
    const f = make(); prepare(f); expect(faults(() => f.protocol.worker(frame() as never))).toBe("protocol");
  });
  it("rejects replayed ids, calls before initialization, a second initialize and a 33rd call", () => {
    const f = make(); prepare(f); f.protocol.worker(call(3) as never); expect(faults(() => f.protocol.worker(call(3) as never))).toBe("protocol");
    const early = make(); early.protocol.worker(stagedFrame(early) as never); early.protocol.host({ t: "input", text: early.protocol.inputText }); early.protocol.worker(started(early) as never);
    expect(faults(() => early.protocol.worker(call(2) as never))).toBe("protocol");
    early.protocol.worker(init as never); expect(faults(() => early.protocol.worker(call(2) as never))).toBe("protocol"); expect(faults(() => early.protocol.worker(rpc({ id: 9, method: "initialize", params: init.m.params }) as never))).toBe("protocol");
    const many = make(); prepare(many);
    for (let id = 10; id < 10 + L.calls; id++) { many.protocol.worker(call(id) as never); many.protocol.host(many.protocol.answer(id, 1) as never); }
    expect(faults(() => many.protocol.worker(call(99) as never))).toBe("protocol");
  });
  it("hands the schema-validated copy to the tool, never the worker's object", () => {
    const f = make(); prepare(f); const frame = call(3); const effect = f.protocol.worker(frame as never) as { action: { input: Record<string, unknown> } };
    expect(effect.action.input).toEqual({ code: "K7" }); expect(effect.action.input).not.toBe((frame.m.params as { arguments: unknown }).arguments);
  });
  it("bounds a tool answer", () => {
    const f = make(); prepare(f); f.protocol.worker(call(3) as never);
    expect(faults(() => f.protocol.answer(3, "x".repeat(1_048_001)))).toBe("overload"); expect(faults(() => f.protocol.answer(3, undefined))).toBe("overload");
  });
  it("refuses an input too large to frame", () => {
    expect(faults(() => make({ input: { blob: "x".repeat(L.line) } }))).toBe("overload");
  });
});
