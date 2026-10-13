import { z } from "zod";
import { isDeepStrictEqual } from "node:util";
import type { StepRun } from "../../harness/components/runner.js";

export const CLAUDE_TRANSPORT_LIMITS = Object.freeze({ chunk: 65536, line: 2097152, input: 16777216, output: 16777216, unread: 4194304, frames: 1024, calls: 32, bootstrap: 16384, deadlineMs: 120000, cleanupMs: 15000 });
export class ClaudeProtocolFault extends Error { constructor(readonly code: "protocol" | "overload" | "cancelled" | "cleanup") { super(`Claude transport ${code}`); } }
const deny = (): never => { throw new ClaudeProtocolFault("protocol"); };
const object = z.record(z.string(), z.unknown());
const id = z.union([z.string().min(1).max(128), z.number().int().safe()]);
const requestId = z.string().min(1).max(128);
// Pinned SDK-control tool metadata only correlates an already admitted request.
const toolMeta = z.object({
  progressToken: z.number().int().safe().nonnegative(),
  "claudecode/toolUseId": requestId.optional(),
}).strict();
/** Pinned CLI builtin names are inert metadata; they grant no tool or agent authority. */
export const PINNED_CLAUDE_BUILTIN_AGENTS = ["Explore", "Plan", "general-purpose", "statusline-setup", "claude"] as const;
export const claudeHostBuiltinAgents = z.union([z.array(z.never()), z.array(z.enum(PINNED_CLAUDE_BUILTIN_AGENTS)).length(5).refine(names => new Set(names).size === 5)]);

const controlResponse = z.object({ type: z.literal("control_response"), response: z.object({
  subtype: z.literal("success"), request_id: requestId, response: object,
}).strict() }).strict();
// SDK 0.3.259's initialize metadata plus Code 2.1.259's emitted/internal fields.
// Every nested metadata object is closed; these values never establish account authority.
const permissionMode = z.enum(["default", "acceptEdits", "bypassPermissions", "plan", "dontAsk", "auto"]);
const modelInfo = z.object({
  value: z.string(), resolvedModel: z.string().optional(), displayName: z.string(), description: z.string(),
  supportsEffort: z.boolean().optional(), supportedEffortLevels: z.array(z.enum(["low", "medium", "high", "xhigh", "max"])).optional(),
  supportsAdaptiveThinking: z.boolean().optional(), supportsFastMode: z.boolean().optional(), supportsAutoMode: z.boolean().optional(),
  disabled: z.boolean().optional(), promoListPrice: z.string().optional(),
}).strict();
const initializeResponse = z.object({
  commands: z.array(z.object({ name: z.string(), description: z.string(), argumentHint: z.string(), aliases: z.array(z.string()).optional() }).strict()),
  agents: z.array(z.object({ name: z.string(), description: z.string(), model: z.string().optional() }).strict()),
  output_style: z.string(), available_output_styles: z.array(z.string()), models: z.array(modelInfo),
  account: z.object({
    email: z.email().max(254).optional(), organization: z.string().max(256).optional(), subscriptionType: z.string().max(128).optional(),
    tokenSource: z.string().max(128).optional(), apiKeySource: z.literal("none").optional(), apiProvider: z.literal("firstParty").optional(),
  }).strict(),
  hooks_applied: z.boolean().optional(),
  fast_mode_state: z.enum(["off", "cooldown", "on"]).optional(),
  fast_mode_disabled_reason: z.enum(["free", "preference", "extra_usage_disabled", "network_error", "unknown", "not_first_party", "disabled_by_env", "model_not_allowed", "sdk_opt_in_required", "pending"]).optional(),
  unavailable_models: z.array(modelInfo).optional(), current_model: z.string().optional(), current_permission_mode: permissionMode.optional(),
  session_state: z.enum(["idle", "running", "requires_action"]).optional(), permission_mode_from_default_fallback: z.boolean().optional(),
  auto_default_nudge: permissionMode.optional(), pid: z.number().optional(),
  footer_indicator: z.object({ text: z.string() }).strict().optional(),
  feedback_survey_config: z.object({
    minTimeBeforeFeedbackMs: z.number(), minTimeBetweenFeedbackMs: z.number(), minTimeBetweenGlobalFeedbackMs: z.number(),
    minUserTurnsBeforeFeedback: z.number(), minUserTurnsBetweenFeedback: z.number(), hideThanksAfterMs: z.number(),
    onForModels: z.array(z.string()), probability: z.number(), lastSurveyShownTime: z.number().nullable(),
  }).strict().optional(),
  analytics_disabled: z.boolean().optional(), remote_control_auto_enable: z.boolean().optional(), remote_control_auto_on_by_default: z.boolean().optional(),
  remote_control_available: z.boolean().optional(), ide_rc_auto_enable_gate: z.boolean().optional(),
}).strict();
/** UTF8 and complete newline accounting happen on bytes, never replacement-decoded strings. */
// Pinned CLI progress estimates are inert and may be fractional; only result usage is authoritative.
export const claudeThinkingTokens = z.object({
  type: z.literal("system"), subtype: z.literal("thinking_tokens"),
  session_id: z.string().min(1).max(128), uuid: z.string().min(1).max(128),
  estimated_tokens: z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER),
  estimated_tokens_delta: z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER),
}).strict().refine(value => value.estimated_tokens_delta <= value.estimated_tokens);

// Pinned subscription telemetry is inert; values never select tools, retries or success.
const rateStatus = z.enum(["allowed", "allowed_warning", "rejected"]);
const rateNumber = z.number().finite();
// The publisher rounds resets but does not impose safe-integer or sign bounds.
const rateReset = rateNumber.refine(Number.isInteger);
const rateWindow = z.object({ utilization: rateNumber, resetsAt: rateReset }).strict();
const ratePeriod = z.object({ utilization: rateNumber }).strict();
export const claudeRateLimitEvent = z.object({
  type: z.literal("rate_limit_event"), session_id: requestId, uuid: requestId,
  rate_limit_info: z.object({
    status: rateStatus,
    resetsAt: rateReset.optional(),
    rateLimitType: z.enum(["five_hour", "seven_day", "seven_day_opus", "seven_day_sonnet", "seven_day_overage_included", "overage"]).optional(),
    utilization: rateNumber.optional(),
    unifiedWindows: z.object({ five_hour: rateWindow.optional(), seven_day: rateWindow.optional(), seven_day_overage_included: rateWindow.optional() }).strict().optional(),
    overageStatus: rateStatus.optional(), overageResetsAt: rateReset.optional(),
    overageDisabledReason: z.enum(["overage_not_provisioned", "org_level_disabled", "org_level_disabled_until", "out_of_credits", "seat_tier_level_disabled", "member_level_disabled", "seat_tier_zero_credit_limit", "group_zero_credit_limit", "member_zero_credit_limit", "org_service_level_disabled", "no_limits_configured", "fetch_error", "unknown"]).optional(),
    isUsingOverage: z.boolean().optional(), overageInUse: z.boolean().optional(), surpassedThreshold: rateNumber.optional(),
    rateLimitGraceActive: z.boolean().optional(), overagePeriodMonthly: ratePeriod.optional(), overagePeriodChannel: ratePeriod.optional(),
    errorCode: z.literal("credits_required").optional(), canUserPurchaseCredits: z.boolean().optional(), hasChargeableSavedPaymentMethod: z.boolean().optional(),
  }).strict(),
}).strict();

export class ClaudeLineFrames {
  private pending = Buffer.alloc(0);
  private count = 0;
  feed(data: Buffer): { bytes: Buffer; value: Record<string, unknown> }[] {
    const frames: { bytes: Buffer; value: Record<string, unknown> }[] = [];
    let start = 0;
    for (let cursor = 0; cursor < data.length; cursor++) if (data[cursor] === 10) {
      const part = data.subarray(start, cursor + 1);
      if (this.pending.length + part.length > CLAUDE_TRANSPORT_LIMITS.line || ++this.count > CLAUDE_TRANSPORT_LIMITS.frames) throw new ClaudeProtocolFault("overload");
      const bytes = Buffer.concat([this.pending, part]); this.pending = Buffer.alloc(0); start = cursor + 1;
      try { frames.push({ bytes, value: object.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))) }); } catch { deny(); }
    }
    if (start < data.length) {
      if (this.pending.length + data.length - start >= CLAUDE_TRANSPORT_LIMITS.line) throw new ClaudeProtocolFault("overload");
      this.pending = Buffer.concat([this.pending, data.subarray(start)]);
    }
    return frames;
  }
  get bufferedBytes(): number { return this.pending.length; }
  end(): void { if (this.pending.length) deny(); }
}
/** One captured host step per stream. Worker IDs only correlate; they never select authority. */
export class ClaudeRawProtocol {
  private readonly outerIds = new Set<string>();
  private readonly rpcIds = new Set<string>();
  private readonly hostIds = new Map<string, string>();
  private readonly hostSeen = new Set<string>();
  private readonly admitted: { name: string; input: unknown }[] = [];
  private initialized = false;
  private resultSeen = false;
  private workerSeen = new Set<string>();
  private mcpInitialized = false;
  private session: string | undefined;
  private calls = 0;
  private readonly schemas: Readonly<Record<string, z.ZodType>>;
  constructor(private readonly options: { run: StepRun; model: string; cwd: string; check(): void; secret: string }) {
    this.schemas = Object.fromEntries(Object.keys(options.run.tools).map((name) => [name, z.fromJSONSchema(options.run.toolSchemas[name] ?? deny())]));
  }
  secretSafe(bytes: Buffer): void {
    const raw = bytes.toString("utf8");
    // Include JSON-escaped ASCII in the secret check, without exempting credential values.
    const value = raw.replace(/\\u([a-f0-9]{4})/gi, (_match, hex: string) => String.fromCharCode(parseInt(hex, 16)));
    if (value.includes(this.options.secret) || /sk-ant-|refresh_token|access_token/i.test(value)) deny();
    if (/CLAUDE_CODE_OAUTH_TOKEN/i.test(value)) {
      // Code's public provenance label is valid only in an outstanding initialize response.
      // Exact account identity is still checked by the component/verifier before any prompt.
      try {
        const frame = controlResponse.parse(JSON.parse(raw));
        if (this.hostIds.get(frame.response.request_id) !== "initialize") deny();
        const metadata = initializeResponse.parse(frame.response.response);
        if (metadata.account.tokenSource !== "CLAUDE_CODE_OAUTH_TOKEN") deny();
        const safe = JSON.stringify({ ...frame, response: { ...frame.response, response: { ...metadata, account: { ...metadata.account, tokenSource: undefined } } } });
        if (safe.includes(this.options.secret) || /sk-ant-|refresh_token|access_token|CLAUDE_CODE_OAUTH_TOKEN/i.test(safe)) deny();
      } catch { deny(); }
    }
  }
  host(value: Record<string, unknown>): void {
    this.options.check();
    if (value.type === "control_request") {
      const parsed = z.object({ type: z.literal("control_request"), request_id: requestId, request: object }).strict().parse(value);
      if (this.hostSeen.has(parsed.request_id) || this.hostSeen.size >= CLAUDE_TRANSPORT_LIMITS.frames) deny();
      if (!["initialize", "interrupt", "mcp_message"].includes(String(parsed.request.subtype))) deny();
      this.hostSeen.add(parsed.request_id); this.hostIds.set(parsed.request_id, String(parsed.request.subtype));
    } else if (value.type === "user") {
      if (!this.initialized && this.hostIds.size) deny();
    } else if (value.type !== "control_response" && value.type !== "keep_alive") deny();
  }
  worker(value: Record<string, unknown>): void {
    this.options.check();
    if (value.type === "control_response") {
      const parsed = controlResponse.parse(value);
      if (this.hostIds.get(parsed.response.request_id) === "initialize") initializeResponse.parse(parsed.response.response);
      if (!this.hostIds.delete(parsed.response.request_id)) deny();
      return;
    }
    if (value.type === "keep_alive") { z.object({ type: z.literal("keep_alive") }).strict().parse(value); return; }
    if (value.type === "control_request") {
      // The pinned CLI enumerates its SDK MCP server before emitting system/init.
      const parsed = z.object({ type: z.literal("control_request"), request_id: requestId,
        request: z.object({ subtype: z.literal("mcp_message"), server_name: z.literal("component"), message: object }).strict() }).strict().parse(value);
      if (this.outerIds.has(parsed.request_id)) deny(); this.outerIds.add(parsed.request_id);
      const message = parsed.request.message;
      if (message.method === "notifications/initialized") {
        z.object({ jsonrpc: z.literal("2.0"), method: z.literal("notifications/initialized") }).strict().parse(message); if (!this.mcpInitialized) deny(); return;
      }
      const rpc = z.object({ jsonrpc: z.literal("2.0"), id, method: z.enum(["initialize", "tools/list", "tools/call"]), params: object.optional() }).strict().parse(message);
      const key = JSON.stringify(rpc.id); if (this.rpcIds.has(key)) deny(); this.rpcIds.add(key);
      if (rpc.method === "initialize") {
        if (this.mcpInitialized) deny();
        z.object({ protocolVersion: z.string().min(1).max(64), capabilities: z.object({}).strict(), clientInfo: z.object({ name: z.string().max(128), version: z.string().max(64), title: z.string().max(128).optional(), description: z.string().max(1024).optional(), websiteUrl: z.url().max(2048).optional() }).strict() }).strict().parse(rpc.params);
        this.mcpInitialized = true;
      } else {
        if (!this.mcpInitialized) deny();
        if (rpc.method === "tools/list") { if (rpc.params && Object.keys(rpc.params).length) deny(); }
        else {
          if (!this.initialized || this.resultSeen) deny();
          const params = z.object({ name: z.string(), arguments: object, _meta: toolMeta.optional() }).strict().parse(rpc.params);
          const schema = this.schemas[params.name]; if (!schema || ++this.calls > CLAUDE_TRANSPORT_LIMITS.calls) deny();
          if (Buffer.byteLength(JSON.stringify(params.arguments)) > 65536) deny();
          if (params._meta) {
            if (params._meta.progressToken !== rpc.id) deny();
          }
          schema!.parse(params.arguments); this.admitted.push({ name: params.name, input: structuredClone(params.arguments) });
        }
      }
      return;
    }
    const identity = z.object({ session_id: z.string().min(1).max(128), uuid: z.string().min(1).max(128) }).parse(value);
    if (this.resultSeen || this.workerSeen.has(identity.uuid) || this.workerSeen.size >= CLAUDE_TRANSPORT_LIMITS.frames) deny();
    if (value.type === "system" && value.subtype === "init") {
      if (this.initialized) deny();
      const init = z.object({ claude_code_version: z.literal("2.1.259"), cwd: z.literal(this.options.cwd), model: z.literal(this.options.model), apiKeySource: z.literal("none"),
        tools: z.array(z.string()), mcp_servers: z.array(z.object({ name: z.literal("component"), status: z.literal("connected") })),
        skills: z.array(z.never()), plugins: z.array(z.never()), agents: claudeHostBuiltinAgents.optional(), slash_commands: z.array(z.never()), permissionMode: z.literal("default") }).parse(value);
      const expected = Object.keys(this.schemas).map((name) => `mcp__component__${name}`).sort();
      if (!isDeepStrictEqual(init.tools.slice().sort(), expected) || init.mcp_servers.length !== 1) deny();
      this.initialized = true; this.session = identity.session_id;
    } else {
      if (!this.initialized || identity.session_id !== this.session) deny();
      if (value.type === "system" && value.subtype === "thinking_tokens") {
        claudeThinkingTokens.parse(value); this.workerSeen.add(identity.uuid); return;
      }
      if (value.type === "rate_limit_event") {
        claudeRateLimitEvent.parse(value); this.workerSeen.add(identity.uuid); return;
      }
      if (!["assistant", "user", "result"].includes(String(value.type))) deny();
      if (value.type === "result") { this.settled(); this.resultSeen = true; }
      if (value.type !== "result") {
        const content = z.object({ content: z.union([z.string(), z.array(object)]) }).parse(value.message).content;
        if (Array.isArray(content)) for (const block of content) if (block.type === "tool_use" && !Object.hasOwn(this.schemas, String(block.name).replace(/^mcp__component__/, ""))) deny();
      }
    }
    this.workerSeen.add(identity.uuid);
  }
  claim(name: string, input: unknown): void {
    this.options.check(); const next = this.admitted.shift();
    if (!next || next.name !== name || !isDeepStrictEqual(next.input, input)) deny();
  }
  settled(): void { this.options.check(); if (this.admitted.length || this.hostIds.size) deny(); }
}
