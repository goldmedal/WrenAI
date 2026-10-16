import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { StepRun, StepResponse } from "../../harness/components/runner.js";
import { CLAUDE_TRANSPORT_LIMITS } from "./claude-protocol.js";

/** Shared transport bounds; only the bootstrap differs because it carries the system prompt. */
export const PI_TRANSPORT_LIMITS = Object.freeze({ ...CLAUDE_TRANSPORT_LIMITS, bootstrap: 1_048_576 });
export const PI_PROTOCOL_VERSION = 1;
export const PI_WORKER_ARGV = Object.freeze(["/usr/local/bin/node", "/opt/genbi/pi-worker.mjs"] as const);
export const PI_PROC_CHECK_ARGV = Object.freeze(["/usr/local/bin/node", "/opt/genbi/pi-proc-check.mjs"] as const);
export const PI_MCP_SERVER = "component";
const MAX_TOOL_ARGUMENTS = 65_536;
const MAX_TOOL_RESULT = 1_048_000;

export class PiProtocolFault extends Error { constructor(readonly code: "protocol" | "overload" | "cancelled" | "cleanup") { super(`pi transport ${code}`); } }
const deny = (): never => { throw new PiProtocolFault("protocol"); };
const record = z.record(z.string(), z.unknown());
const hex = z.string().regex(/^[a-f0-9]{64}$/);
const uuid = z.string().regex(/^[a-f0-9-]{36}$/);
export const sha256Hex = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

export type PiThinking = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export interface PiEndpointConfig {
  /** Provider id used inside pi (`models.json` key and `--provider`). */
  readonly providerId: string;
  readonly api: "openai-completions" | "openai-responses" | "anthropic-messages";
  readonly baseUrl: string;
  /** Env var that holds only the OpenShell placeholder inside the sandbox. */
  readonly credentialEnv: string;
  readonly contextWindow?: number | undefined;
  readonly maxTokens?: number | undefined;
  readonly reasoning?: boolean | undefined;
}
export interface PiStepSpec {
  readonly scope: string;
  readonly model: string;
  readonly thinking?: PiThinking | undefined;
  readonly endpoint: PiEndpointConfig;
  /** Exactly the host instructions: [run.brief, run.prompt].filter(Boolean).join("\n\n"). */
  readonly systemPrompt: string;
  readonly tools: readonly string[];
  /** Only the production default is used by the provider; a different root exists so the worker can be exercised off Linux. */
  readonly stepsRoot?: string | undefined;
  /** Same purpose: absolute node and relay script locations; the provider always uses the image defaults. */
  readonly runtime?: { readonly node: string; readonly shim: string } | undefined;
}
const token = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/);
export const piEndpointSchema = z.object({
  providerId: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/), api: z.enum(["openai-completions", "openai-responses", "anthropic-messages"]),
  baseUrl: z.string().max(2048).refine(value => { try { const url = new URL(value); return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash; } catch { return false; } }),
  credentialEnv: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/), contextWindow: z.number().int().min(1024).max(4_000_000).optional(),
  maxTokens: z.number().int().min(1).max(1_000_000).optional(), reasoning: z.boolean().optional(),
}).strict();
const toolName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/);
const specSchema = z.object({ scope: uuid, model: token, thinking: z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]).optional(), endpoint: piEndpointSchema,
  systemPrompt: z.string().min(1).max(PI_TRANSPORT_LIMITS.line), tools: z.array(toolName).max(PI_TRANSPORT_LIMITS.calls), stepsRoot: z.string().regex(/^\/[A-Za-z0-9/_.-]{1,200}$/).optional(),
  runtime: z.object({ node: z.string().regex(/^\/[A-Za-z0-9/_.-]{1,200}$/), shim: z.string().regex(/^\/[A-Za-z0-9/_.-]{1,200}$/) }).strict().optional() }).strict()
  .refine(value => new Set(value.tools).size === value.tools.length);
export const piWireTool = (name: string) => `mcp__${PI_MCP_SERVER}__${name}`;
export const PI_STEPS_ROOT = "/sandbox/steps";
export const piStepRoot = (scope: string, stepsRoot = PI_STEPS_ROOT) => `${stepsRoot}/${scope}`;
export const piStepPaths = (scope: string, stepsRoot = PI_STEPS_ROOT) => { const root = piStepRoot(scope, stepsRoot); return Object.freeze({ root, agent: `${root}/agent`, cwd: `${root}/work`, home: `${root}/home`, tmp: `${root}/tmp`, prompt: `${root}/system-prompt.txt`, socket: `${root}/mcp.sock` }); };

/** Fixed pi agent-dir settings. Project trust is never granted and nothing is retried or reported. */
export const PI_SETTINGS = Object.freeze({ defaultProjectTrust: "never", enableInstallTelemetry: false, enableAnalytics: false, quietStartup: true, defaultTools: [], retry: { enabled: false } });
export const PI_SHIM = "/opt/genbi/pi-mcp-shim.mjs";

/** The complete pi argv. Every isolation flag is host-decided; no message argument (input arrives on stdin). */
export function buildPiArgv(input: PiStepSpec): string[] {
  const spec = specSchema.parse(input); const paths = piStepPaths(spec.scope, spec.stepsRoot);
  return ["--mode", "json", "--no-session", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-approve", "-e", "builtin:mcp",
    ...(spec.tools.length ? ["--tools", spec.tools.map(piWireTool).join(",")] : ["--no-tools"]),
    "--system-prompt", paths.prompt, "--provider", spec.endpoint.providerId, "--model", spec.model, ...(spec.thinking ? ["--thinking", spec.thinking] : [])];
}
/** Independent argv admission: exact flag set, exact values, no duplicate, nothing that adds a prompt, context, skill or extension source. */
export function admitPiArgv(argv: readonly string[], input: PiStepSpec): void {
  const spec = specSchema.parse(input); const paths = piStepPaths(spec.scope, spec.stepsRoot);
  const wire = spec.tools.map(piWireTool);
  const pairs = new Map<string, string>([["--mode", "json"], ["-e", "builtin:mcp"], ["--system-prompt", paths.prompt], ["--provider", spec.endpoint.providerId], ["--model", spec.model]]);
  if (wire.length) pairs.set("--tools", wire.join(","));
  if (spec.thinking) pairs.set("--thinking", spec.thinking);
  const singles = new Set(["--no-session", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-approve", ...(wire.length ? [] : ["--no-tools"])]);
  const seen = new Set<string>();
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index]!; if (seen.has(flag)) deny(); seen.add(flag);
    if (singles.has(flag)) continue;
    const value = argv[++index]; if (value === undefined || !pairs.has(flag) || pairs.get(flag) !== value) deny();
  }
  for (const flag of [...singles, ...pairs.keys()]) if (!seen.has(flag)) deny();
  if (seen.size !== singles.size + pairs.size) deny();
}
const json = (value: unknown) => JSON.stringify(value);
export function buildPiAgentFiles(input: PiStepSpec, shimToken: string) {
  const spec = specSchema.parse(input); const paths = piStepPaths(spec.scope, spec.stepsRoot);
  const endpoint = spec.endpoint;
  const models = { providers: { [endpoint.providerId]: { baseUrl: endpoint.baseUrl, api: endpoint.api, apiKey: `$${endpoint.credentialEnv}`,
    models: [{ id: spec.model, reasoning: endpoint.reasoning ?? false, input: ["text"], contextWindow: endpoint.contextWindow ?? 128_000, maxTokens: endpoint.maxTokens ?? 8192,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } };
  const mcp = { autoEnableCodemode: false, mcpServers: spec.tools.length ? { [PI_MCP_SERVER]: { command: spec.runtime?.node ?? PI_WORKER_ARGV[0], args: [spec.runtime?.shim ?? PI_SHIM, paths.socket, shimToken], exposure: "direct", timeout: 30 } } : {} };
  return { settings: json(PI_SETTINGS), models: json(models), mcp: json(mcp), systemPrompt: spec.systemPrompt };
}
export function expectedPiDigests(input: PiStepSpec, shimToken: string) {
  const files = buildPiAgentFiles(input, shimToken);
  return { argv: sha256Hex(json(buildPiArgv(input))), settings: sha256Hex(files.settings), models: sha256Hex(files.models), mcp: sha256Hex(files.mcp), prompt: sha256Hex(files.systemPrompt) };
}
/** Length-prefixed private bootstrap. Everything pi can see is computed here and only materialised by the worker. */
export function buildPiBootstrap(input: PiStepSpec, shimToken: string): Buffer {
  const spec = specSchema.parse(input); admitPiArgv(buildPiArgv(spec), spec);
  const body = Buffer.from(json({ protocol: PI_PROTOCOL_VERSION, scope: spec.scope, token: shimToken, credentialEnv: spec.endpoint.credentialEnv, argv: buildPiArgv(spec), files: buildPiAgentFiles(spec, shimToken) }));
  if (body.length > PI_TRANSPORT_LIMITS.bootstrap) throw new PiProtocolFault("overload");
  const prefix = Buffer.alloc(4); prefix.writeUInt32BE(body.length); return Buffer.concat([prefix, body]);
}
export function userMessage(run: Pick<StepRun, "request" | "input" | "consumes">): string { return JSON.stringify({ request: run.request, input: run.input, consumes: run.consumes }); }

/** UTF-8 and complete-line accounting happen on bytes. */
export class PiLineFrames {
  private pending = Buffer.alloc(0); private count = 0;
  feed(data: Buffer): { bytes: Buffer; value: Record<string, unknown> }[] {
    const frames: { bytes: Buffer; value: Record<string, unknown> }[] = []; let start = 0;
    for (let cursor = 0; cursor < data.length; cursor++) if (data[cursor] === 10) {
      const part = data.subarray(start, cursor + 1);
      if (this.pending.length + part.length > PI_TRANSPORT_LIMITS.line || ++this.count > PI_TRANSPORT_LIMITS.frames) throw new PiProtocolFault("overload");
      const bytes = Buffer.concat([this.pending, part]); this.pending = Buffer.alloc(0); start = cursor + 1;
      try { frames.push({ bytes, value: record.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))) }); } catch { deny(); }
    }
    if (start < data.length) {
      if (this.pending.length + data.length - start >= PI_TRANSPORT_LIMITS.line) throw new PiProtocolFault("overload");
      this.pending = Buffer.concat([this.pending, data.subarray(start)]);
    }
    return frames;
  }
  get bufferedBytes(): number { return this.pending.length; }
  end(): void { if (this.pending.length) deny(); }
}

const digests = z.object({ argv: hex, settings: hex, models: hex, mcp: hex, prompt: hex }).strict();
const piEvent = z.object({ type: z.enum(["message_end", "tool_execution_start", "tool_execution_end", "agent_settled"]) }).passthrough();
const rpcId = z.union([z.string().min(1).max(128), z.number().int().safe()]);
const mcpMessage = z.object({ jsonrpc: z.literal("2.0"), id: rpcId.optional(), method: z.string().min(1).max(64), params: record.optional() }).strict();
const workerFrame = z.discriminatedUnion("t", [
  z.object({ t: z.literal("staged"), protocol: z.literal(PI_PROTOCOL_VERSION), scope: uuid, digests }).strict(),
  z.object({ t: z.literal("started"), scope: uuid, inputSha256: hex }).strict(),
  z.object({ t: z.literal("pi"), e: piEvent }).strict(),
  z.object({ t: z.literal("mcp"), m: record }).strict(),
  z.object({ t: z.literal("exit"), scope: uuid, code: z.number().int().nullable(), signal: z.string().max(16).nullable(), forced: z.boolean(), remaining: z.number().int().min(0) }).strict(),
]);
export type PiWorkerFrame = z.infer<typeof workerFrame>;
export type PiHostFrame = { t: "input"; text: string } | { t: "mcp"; m: Record<string, unknown> } | { t: "end" };
export type PiMcpAction = { kind: "respond"; frame: PiHostFrame } | { kind: "call"; id: string | number; name: string; input: Record<string, unknown> } | { kind: "none" };
export type PiFrameEffect = { kind: "send"; frame: PiHostFrame } | { kind: "mcp"; action: PiMcpAction } | { kind: "settled" } | { kind: "exited" } | { kind: "none" };

/** Deterministic state for one step. Worker-supplied ids and names only correlate; they never confer authority. */
export class PiStepProtocol {
  private readonly spec: PiStepSpec; private readonly expected: ReturnType<typeof expectedPiDigests>; private readonly wire: ReadonlySet<string>;
  private readonly schemas: Readonly<Record<string, z.ZodType>>; private readonly descriptions: Readonly<Record<string, string>>; private readonly toolSchemas: Readonly<Record<string, Record<string, unknown>>>;
  private readonly seenIds = new Set<string>(); private readonly outstanding = new Set<string>();
  private staged = false; private inputSent = false; private started = false; private systemSeen = false; private settled = false; private endSent = false; private exitSeen = false;
  private mcpInitialize = false; private mcpInitialized = false; private calls = 0; private events = 0;
  private readonly assistant: Record<string, unknown>[] = [];
  private readonly toolStarts: string[] = [];
  private input = "";
  constructor(private readonly options: { run: Pick<StepRun, "tools" | "toolSchemas" | "toolDescriptions" | "request" | "input" | "consumes">; spec: PiStepSpec; token: string; check(): void }) {
    this.spec = specSchema.parse(options.spec); this.expected = expectedPiDigests(this.spec, options.token);
    admitPiArgv(buildPiArgv(this.spec), this.spec);
    const names = Object.keys(options.run.tools);
    if (!isDeepStrictEqual([...names].sort(), [...this.spec.tools].sort())) deny();
    this.wire = new Set(names.map(piWireTool));
    this.schemas = Object.fromEntries(names.map(name => [name, z.fromJSONSchema(options.run.toolSchemas[name] ?? deny())]));
    this.toolSchemas = Object.fromEntries(names.map(name => [name, structuredClone(options.run.toolSchemas[name] ?? deny()) as Record<string, unknown>]));
    this.descriptions = Object.fromEntries(names.map(name => [name, options.run.toolDescriptions[name] ?? name]));
    this.input = userMessage(options.run);
    if (Buffer.byteLength(JSON.stringify({ t: "input", text: this.input }) + "\n") > PI_TRANSPORT_LIMITS.line) throw new PiProtocolFault("overload");
  }
  /** The user message is fixed at construction from the exact run; the worker cannot influence it. */
  get inputText(): string { return this.input; }
  get isSettled(): boolean { return this.settled; }
  get hasExited(): boolean { return this.exitSeen; }
  get inputSha256(): string { return sha256Hex(this.input); }
  host(value: Record<string, unknown>): void { try { this.hostFrame(value); } catch (error) { throw error instanceof PiProtocolFault ? error : new PiProtocolFault("protocol"); } }
  private hostFrame(value: Record<string, unknown>): void {
    this.options.check();
    if (value.t === "input") { if (!this.staged || this.inputSent || value.text !== this.input || Object.keys(value).length !== 2) deny(); this.inputSent = true; return; }
    if (value.t === "end") { if (!this.settled || this.endSent || this.outstanding.size || Object.keys(value).length !== 1) deny(); this.endSent = true; return; }
    if (value.t === "mcp") {
      const parsed = z.object({ t: z.literal("mcp"), m: z.object({ jsonrpc: z.literal("2.0"), id: rpcId, result: record.optional(), error: z.object({ code: z.number().int(), message: z.string().max(256) }).strict().optional() }).strict() }).strict().parse(value);
      if ((parsed.m.result === undefined) === (parsed.m.error === undefined)) deny();
      const key = JSON.stringify(parsed.m.id); if (!this.outstanding.delete(key)) deny(); return;
    }
    deny();
  }
  /** Validates one worker frame and says what the host owes in return. */
  worker(value: Record<string, unknown>): PiFrameEffect { try { return this.workerFrame(value); } catch (error) { throw error instanceof PiProtocolFault ? error : new PiProtocolFault("protocol"); } }
  private workerFrame(value: Record<string, unknown>): PiFrameEffect {
    this.options.check();
    if (this.exitSeen) deny();
    const frame = workerFrame.parse(value);
    if (frame.t === "staged") {
      if (this.staged || frame.scope !== this.spec.scope || !isDeepStrictEqual(frame.digests, this.expected)) deny();
      this.staged = true; return { kind: "send", frame: { t: "input", text: this.input } };
    }
    if (!this.staged || !this.inputSent) deny();
    if (frame.t === "started") {
      if (this.started || frame.scope !== this.spec.scope || frame.inputSha256 !== this.inputSha256) deny();
      this.started = true; return { kind: "none" };
    }
    if (!this.started) deny();
    if (frame.t === "exit") {
      if (frame.scope !== this.spec.scope || !this.endSent || frame.forced || frame.remaining !== 0) deny();
      this.exitSeen = true; return { kind: "exited" };
    }
    if (this.settled || this.endSent) deny();
    if (++this.events > PI_TRANSPORT_LIMITS.frames) throw new PiProtocolFault("overload");
    if (frame.t === "mcp") return { kind: "mcp", action: this.acceptMcp(frame.m) };
    return this.acceptEvent(frame.e);
  }
  private acceptEvent(event: z.infer<typeof piEvent>): PiFrameEffect {
    if (event.type === "agent_settled") {
      if (!this.systemSeen || !this.assistant.length || this.outstanding.size) deny();
      this.settled = true; return { kind: "settled" };
    }
    if (event.type === "tool_execution_start" || event.type === "tool_execution_end") {
      const name = z.object({ toolName: z.string() }).passthrough().parse(event).toolName; if (!this.wire.has(name) || !this.systemSeen) deny();
      if (event.type === "tool_execution_start") this.toolStarts.push(name);
      return { kind: "none" };
    }
    const message = z.object({ message: z.object({ role: z.string() }).passthrough() }).passthrough().parse(event).message;
    if (message.role === "system") {
      if (this.systemSeen || this.assistant.length) deny();
      const system = z.object({ role: z.literal("system"), sections: z.object({ preamble: z.string(), cwd: z.string() }).strict(),
        toolsAdded: z.array(z.object({ name: z.string() }).passthrough()).optional() }).passthrough().parse(message);
      // `--no-context-files` does not suppress an agent-dir APPEND_SYSTEM.md (an `addendum` section); anything but the host prompt fails closed here.
      if (system.sections.preamble !== this.spec.systemPrompt || system.sections.cwd !== `<cwd>\n${piStepPaths(this.spec.scope, this.spec.stepsRoot).cwd}\n</cwd>`) deny();
      const names = (system.toolsAdded ?? []).map(tool => tool.name);
      if (new Set(names).size !== names.length || !isDeepStrictEqual([...names].sort(), [...this.wire].sort())) deny();
      this.systemSeen = true; return { kind: "none" };
    }
    if (message.role !== "assistant" || !this.systemSeen) deny();
    const assistant = z.object({ role: z.literal("assistant"), stopReason: z.string().max(32), content: z.array(record) }).passthrough().parse(message);
    for (const block of assistant.content) if (block.type === "toolCall" && !this.wire.has(String(block.name))) deny();
    this.assistant.push(assistant); return { kind: "none" };
  }
  private acceptMcp(raw: Record<string, unknown>): PiMcpAction {
    const message = mcpMessage.parse(raw);
    if (message.id === undefined) {
      if (message.method === "notifications/initialized") { if (!this.mcpInitialize || this.mcpInitialized) deny(); this.mcpInitialized = true; return { kind: "none" }; }
      if (message.method === "notifications/cancelled") { if (!this.mcpInitialize) deny(); return { kind: "none" }; }
      return deny();
    }
    const key = JSON.stringify(message.id); if (this.seenIds.has(key) || this.seenIds.size >= PI_TRANSPORT_LIMITS.frames) deny(); this.seenIds.add(key); this.outstanding.add(key);
    const reply = (result: Record<string, unknown>): PiMcpAction => ({ kind: "respond", frame: { t: "mcp", m: { jsonrpc: "2.0", id: message.id as string | number, result } } });
    if (message.method === "initialize") {
      if (this.mcpInitialize) deny();
      const params = z.object({ protocolVersion: z.string().min(1).max(64), capabilities: record, clientInfo: z.object({ name: z.string().max(128), version: z.string().max(64) }).passthrough() }).strict().parse(message.params);
      this.mcpInitialize = true;
      return reply({ protocolVersion: params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: PI_MCP_SERVER, version: "1" } });
    }
    if (!this.mcpInitialize) deny();
    if (message.method === "ping") { if (message.params && Object.keys(message.params).length) deny(); return reply({}); }
    if (!this.mcpInitialized) deny();
    if (message.method === "tools/list") {
      if (message.params && Object.keys(message.params).length) deny();
      return reply({ tools: this.spec.tools.map(name => ({ name, description: this.descriptions[name], inputSchema: this.toolSchemas[name] })) });
    }
    if (message.method !== "tools/call") return deny();
    const params = z.object({ name: z.string(), arguments: record.default({}), _meta: record.optional() }).strict().parse(message.params);
    const schema = this.schemas[params.name]; if (!schema || !Object.hasOwn(this.schemas, params.name) || ++this.calls > PI_TRANSPORT_LIMITS.calls) deny();
    if (Buffer.byteLength(JSON.stringify(params.arguments)) > MAX_TOOL_ARGUMENTS || (params._meta && Buffer.byteLength(JSON.stringify(params._meta)) > 1024)) deny();
    const parsed = schema!.safeParse(params.arguments); if (!parsed.success) deny();
    return { kind: "call", id: message.id, name: params.name, input: parsed.data as Record<string, unknown> };
  }
  /** Builds the one answer owed for an admitted tools/call. */
  answer(id: string | number, output: unknown): PiHostFrame {
    const text = JSON.stringify(output); if (text === undefined || Buffer.byteLength(text) > MAX_TOOL_RESULT) throw new PiProtocolFault("overload");
    return { t: "mcp", m: { jsonrpc: "2.0", id, result: { content: [{ type: "text", text }] } } };
  }
  /** Judged from events only; the process exit status is never an input. */
  result(): StepResponse {
    this.options.check();
    if (!this.staged || !this.started || !this.systemSeen || !this.settled || !this.endSent || !this.exitSeen || this.outstanding.size) deny();
    const last = this.assistant.at(-1); if (!last || last.stopReason !== "stop") return deny();
    const text = (last.content as Record<string, unknown>[]).filter(block => block.type === "text").map(block => String(block.text ?? "")).join("");
    if (!text) deny();
    let inputTokens = 0, outputTokens = 0;
    const count = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
    for (const message of this.assistant) { const usage = (message.usage ?? {}) as Record<string, unknown>; inputTokens += count(usage.input) + count(usage.cacheRead) + count(usage.cacheWrite); outputTokens += count(usage.output); }
    return { value: text, usage: { inputTokens, outputTokens } };
  }
}
