import { z } from "zod";
import { isDeepStrictEqual } from "node:util";
import type { StepRun } from "../../harness/components/runner.js";

export const CLAUDE_TRANSPORT_LIMITS = Object.freeze({ chunk: 65536, line: 2097152, input: 16777216, output: 16777216, unread: 4194304, frames: 1024, calls: 32, bootstrap: 16384, deadlineMs: 120000, cleanupMs: 15000 });
/**
 * Closed, internal-only label for the first rule a Claude stream broke. It is built from fixed vocabulary only: never
 * model text, tool input, paths, SQL or credentials, and it never changes the public error text or status.
 */
const SDK_MESSAGE_TYPES = ["assistant", "user", "result", "system", "stream_event", "tool_progress", "auth_status", "rate_limit_event", "control_request", "control_response", "keep_alive"] as const;
const SDK_SYSTEM_SUBTYPES = ["init", "status", "api_retry", "compact_boundary", "control_request_progress", "hook_started", "hook_progress", "hook_response", "local_command_output", "plugin_install",
  "task_notification", "task_started", "task_updated", "task_progress", "background_tasks_changed", "thinking_tokens", "session_state_changed", "worker_shutting_down", "commands_changed", "notification",
  "files_persisted", "tool_use_summary", "memory_recall", "elicitation_complete", "permission_denied", "prompt_suggestion", "mirror_error", "informational", "conversation_reset"] as const;
export type ClaudeFaultSite =
  | "unspecified" | "schema" | "internal" | "transport" | "overload" | "cancelled" | "cleanup"
  | "frame_decode" | "frame_limit" | "tool_schema" | "secret_leak" | "host_frame" | "control_response" | "rpc_duplicate" | "mcp_order"
  | "tool_call_order" | "tool_call_limit" | "tool_input_limit" | "tool_output_limit" | "undeclared_tool_use" | "tool_claim" | "settle_pending"
  | "duplicate_uuid" | "transport_frame_limit" | "step_frame_limit" | "inert_frame_limit" | "message_after_result" | "init_duplicate" | "init_tools" | "init_mcp_servers" | "session_mismatch" | "preflight" | "inactive" | "stream_ended"
  | "parent_tool_use" | "unexpected_block" | "result_error" | "permission_denials" | "model_usage_keys" | "result_shape" | "result_pending"
  | "unexpected_event:other" | `unexpected_event:${typeof SDK_MESSAGE_TYPES[number]}` | `unexpected_event:system.${typeof SDK_SYSTEM_SUBTYPES[number]}` | "unexpected_event:system.other";
const faultSite = (value: string): ClaudeFaultSite => value as ClaudeFaultSite;
/** The label for a stream message this host does not recognize, from fixed vocabularies only. */
export function unexpectedEventSite(value: unknown): ClaudeFaultSite {
  const message = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const type = (SDK_MESSAGE_TYPES as readonly string[]).includes(String(message.type)) ? String(message.type) : undefined;
  if (type === "system") return (SDK_SYSTEM_SUBTYPES as readonly string[]).includes(String(message.subtype)) ? faultSite(`unexpected_event:system.${String(message.subtype)}`) : "unexpected_event:system.other";
  return type ? faultSite(`unexpected_event:${type}`) : "unexpected_event:other";
}
export class ClaudeProtocolFault extends Error { constructor(readonly code: "protocol" | "overload" | "cancelled" | "cleanup", readonly site: ClaudeFaultSite = code === "protocol" ? "unspecified" : code) { super(`Claude transport ${code}`); } }
/** The site a thrown error maps to: schema validation failures are `schema`, anything unrecognized is `internal`. */
export function faultSiteOf(error: unknown): ClaudeFaultSite {
  if (error instanceof ClaudeProtocolFault) return error.site;
  return error instanceof z.ZodError ? "schema" : "internal";
}
const deny = (site: ClaudeFaultSite = "unspecified"): never => { throw new ClaudeProtocolFault("protocol", site); };
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

const claudeStatusEvent = z.object({ type: z.literal("system"), subtype: z.literal("status"), session_id: z.string().min(1).max(128), uuid: z.string().min(1).max(128),
  status: z.enum(["compacting", "requesting"]).nullable(), permissionMode: z.literal("default").optional() }).strict();
const claudeApiRetryEvent = z.object({ type: z.literal("system"), subtype: z.literal("api_retry"), session_id: z.string().min(1).max(128), uuid: z.string().min(1).max(128),
  attempt: z.number().int().nonnegative().max(1000), max_retries: z.number().int().nonnegative().max(1000), retry_delay_ms: z.number().finite().nonnegative(),
  error_status: z.number().int().nullable(), error: z.string().max(64) }).strict();
const claudeSessionStateEvent = z.object({ type: z.literal("system"), subtype: z.literal("session_state_changed"), session_id: z.string().min(1).max(128), uuid: z.string().min(1).max(128),
  state: z.enum(["idle", "running", "requires_action"]) }).strict();
/**
 * The inert progress/telemetry messages the pinned CLI (2.1.259, SDK 0.3.259 types) may interleave with a step. Matching one
 * means it is ignored: it never selects tools, retries, success or any authority, and every field is strictly schema-checked
 * (a malformed one still fails). Shared by the raw transport and the step loop so every component follows the same rule.
 */
export const CLAUDE_INERT_FRAME_CAP = 8192;
/** Cheap shape-only test for the inert set (no schema check); used only to choose which flood cap a frame counts against. */
export function isInertShape(value: Record<string, unknown>): boolean {
  return value.type === "rate_limit_event" || (value.type === "system" && ["thinking_tokens", "status", "api_retry", "session_state_changed"].includes(String(value.subtype)));
}
const FRAME_COUNT_KEYS = ["assistant", "user", "tool_use", "result", "system:init", "system:status", "system:api_retry", "system:session_state_changed", "thinking_tokens", "rate_limit_event", "stream_event", "other"] as const;
export type ClaudeFrameCounts = Partial<Record<typeof FRAME_COUNT_KEYS[number], number>>;
function frameCountKey(value: Record<string, unknown>): typeof FRAME_COUNT_KEYS[number] {
  if (value.type === "system") {
    if (value.subtype === "thinking_tokens") return "thinking_tokens";
    return (["init", "status", "api_retry", "session_state_changed"] as const).includes(value.subtype as never) ? `system:${String(value.subtype)}` as typeof FRAME_COUNT_KEYS[number] : "other";
  }
  return (["assistant", "user", "result", "rate_limit_event", "stream_event"] as const).includes(value.type as never) ? value.type as typeof FRAME_COUNT_KEYS[number] : "other";
}
/** Bounded per-type message counts over a fixed vocabulary; never holds content or raw type strings. */
export class ClaudeFrameTally {
  private readonly counts = new Map<typeof FRAME_COUNT_KEYS[number], number>();
  add(value: Record<string, unknown>): void {
    const bump = (key: typeof FRAME_COUNT_KEYS[number], by = 1) => this.counts.set(key, Math.min(1_000_000, (this.counts.get(key) ?? 0) + by));
    bump(frameCountKey(value));
    const content = value.type === "assistant" && value.message && typeof value.message === "object" ? (value.message as { content?: unknown }).content : undefined;
    if (Array.isArray(content)) { let tools = 0; for (const block of content.slice(0, 4096)) if (block && typeof block === "object" && (block as { type?: unknown }).type === "tool_use") tools++; if (tools) bump("tool_use", tools); }
  }
  snapshot(): ClaudeFrameCounts { return Object.fromEntries(FRAME_COUNT_KEYS.filter((key) => this.counts.has(key)).map((key) => [key, this.counts.get(key)!])); }
}
export function claudeInertEvent(value: Record<string, unknown>): boolean {
  if (value.type === "system" && value.subtype === "thinking_tokens") { claudeThinkingTokens.parse(value); return true; }
  if (value.type === "rate_limit_event") { claudeRateLimitEvent.parse(value); return true; }
  if (value.type === "system" && value.subtype === "status") { claudeStatusEvent.parse(value); return true; }
  if (value.type === "system" && value.subtype === "api_retry") { claudeApiRetryEvent.parse(value); return true; }
  if (value.type === "system" && value.subtype === "session_state_changed") { claudeSessionStateEvent.parse(value); return true; }
  return false;
}

export class ClaudeLineFrames {
  private pending = Buffer.alloc(0);
  private count = 0;
  private inertCount = 0;
  feed(data: Buffer): { bytes: Buffer; value: Record<string, unknown> }[] {
    const frames: { bytes: Buffer; value: Record<string, unknown> }[] = [];
    let start = 0;
    for (let cursor = 0; cursor < data.length; cursor++) if (data[cursor] === 10) {
      const part = data.subarray(start, cursor + 1);
      if (this.pending.length + part.length > CLAUDE_TRANSPORT_LIMITS.line) throw new ClaudeProtocolFault("overload");
      const bytes = Buffer.concat([this.pending, part]); this.pending = Buffer.alloc(0); start = cursor + 1;
      let value!: Record<string, unknown>;
      try { value = object.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))); } catch { deny("frame_decode"); }
      // Inert telemetry has its own cap so a chatty stream cannot exhaust the substantive-frame budget; sizes stay bounded for both.
      if (isInertShape(value) ? ++this.inertCount > CLAUDE_INERT_FRAME_CAP : ++this.count > CLAUDE_TRANSPORT_LIMITS.frames) throw new ClaudeProtocolFault("overload");
      frames.push({ bytes, value });
    }
    if (start < data.length) {
      if (this.pending.length + data.length - start >= CLAUDE_TRANSPORT_LIMITS.line) throw new ClaudeProtocolFault("overload");
      this.pending = Buffer.concat([this.pending, data.subarray(start)]);
    }
    return frames;
  }
  get bufferedBytes(): number { return this.pending.length; }
  end(): void { if (this.pending.length) deny("frame_decode"); }
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
  private mainCount = 0;
  private inertCount = 0;
  private readonly tally = new ClaudeFrameTally();
  frameCounts(): ClaudeFrameCounts { return this.tally.snapshot(); }
  private mcpInitialized = false;
  private session: string | undefined;
  private calls = 0;
  private readonly schemas: Readonly<Record<string, z.ZodType>>;
  constructor(private readonly options: { run: StepRun; model: string; cwd: string; check(): void; secret: string }) {
    this.schemas = Object.fromEntries(Object.keys(options.run.tools).map((name) => [name, z.fromJSONSchema(options.run.toolSchemas[name] ?? deny("tool_schema"))]));
  }
  secretSafe(bytes: Buffer): void {
    const raw = bytes.toString("utf8");
    // Include JSON-escaped ASCII in the secret check, without exempting credential values.
    const value = raw.replace(/\\u([a-f0-9]{4})/gi, (_match, hex: string) => String.fromCharCode(parseInt(hex, 16)));
    if (value.includes(this.options.secret) || /sk-ant-|refresh_token|access_token/i.test(value)) deny("secret_leak");
    if (/CLAUDE_CODE_OAUTH_TOKEN/i.test(value)) {
      // Code's public provenance label is valid only in an outstanding initialize response.
      // Exact account identity is still checked by the component/verifier before any prompt.
      try {
        const frame = controlResponse.parse(JSON.parse(raw));
        if (this.hostIds.get(frame.response.request_id) !== "initialize") deny("secret_leak");
        const metadata = initializeResponse.parse(frame.response.response);
        if (metadata.account.tokenSource !== "CLAUDE_CODE_OAUTH_TOKEN") deny("secret_leak");
        const safe = JSON.stringify({ ...frame, response: { ...frame.response, response: { ...metadata, account: { ...metadata.account, tokenSource: undefined } } } });
        if (safe.includes(this.options.secret) || /sk-ant-|refresh_token|access_token|CLAUDE_CODE_OAUTH_TOKEN/i.test(safe)) deny("secret_leak");
      } catch { deny("secret_leak"); }
    }
  }
  host(value: Record<string, unknown>): void {
    this.options.check();
    if (value.type === "control_request") {
      const parsed = z.object({ type: z.literal("control_request"), request_id: requestId, request: object }).strict().parse(value);
      if (this.hostSeen.has(parsed.request_id) || this.hostSeen.size >= CLAUDE_TRANSPORT_LIMITS.frames) deny("host_frame");
      if (!["initialize", "interrupt", "mcp_message"].includes(String(parsed.request.subtype))) deny("host_frame");
      this.hostSeen.add(parsed.request_id); this.hostIds.set(parsed.request_id, String(parsed.request.subtype));
    } else if (value.type === "user") {
      if (!this.initialized && this.hostIds.size) deny("host_frame");
    } else if (value.type !== "control_response" && value.type !== "keep_alive") deny("host_frame");
  }
  worker(value: Record<string, unknown>): void {
    this.options.check();
    if (value.type === "control_response") {
      const parsed = controlResponse.parse(value);
      if (this.hostIds.get(parsed.response.request_id) === "initialize") initializeResponse.parse(parsed.response.response);
      if (!this.hostIds.delete(parsed.response.request_id)) deny("control_response");
      return;
    }
    if (value.type === "keep_alive") { z.object({ type: z.literal("keep_alive") }).strict().parse(value); return; }
    if (value.type === "control_request") {
      // The pinned CLI enumerates its SDK MCP server before emitting system/init.
      const parsed = z.object({ type: z.literal("control_request"), request_id: requestId,
        request: z.object({ subtype: z.literal("mcp_message"), server_name: z.literal("component"), message: object }).strict() }).strict().parse(value);
      if (this.outerIds.has(parsed.request_id)) deny("rpc_duplicate"); this.outerIds.add(parsed.request_id);
      const message = parsed.request.message;
      if (message.method === "notifications/initialized") {
        z.object({ jsonrpc: z.literal("2.0"), method: z.literal("notifications/initialized") }).strict().parse(message); if (!this.mcpInitialized) deny("mcp_order"); return;
      }
      const rpc = z.object({ jsonrpc: z.literal("2.0"), id, method: z.enum(["initialize", "tools/list", "tools/call"]), params: object.optional() }).strict().parse(message);
      const key = JSON.stringify(rpc.id); if (this.rpcIds.has(key)) deny("rpc_duplicate"); this.rpcIds.add(key);
      if (rpc.method === "initialize") {
        if (this.mcpInitialized) deny("mcp_order");
        z.object({ protocolVersion: z.string().min(1).max(64), capabilities: z.object({}).strict(), clientInfo: z.object({ name: z.string().max(128), version: z.string().max(64), title: z.string().max(128).optional(), description: z.string().max(1024).optional(), websiteUrl: z.url().max(2048).optional() }).strict() }).strict().parse(rpc.params);
        this.mcpInitialized = true;
      } else {
        if (!this.mcpInitialized) deny("mcp_order");
        if (rpc.method === "tools/list") { if (rpc.params && Object.keys(rpc.params).length) deny("mcp_order"); }
        else {
          if (!this.initialized || this.resultSeen) deny("tool_call_order");
          const params = z.object({ name: z.string(), arguments: object, _meta: toolMeta.optional() }).strict().parse(rpc.params);
          const schema = this.schemas[params.name]; if (!schema) deny("undeclared_tool_use"); if (++this.calls > CLAUDE_TRANSPORT_LIMITS.calls) deny("tool_call_limit");
          if (Buffer.byteLength(JSON.stringify(params.arguments)) > 65536) deny("tool_input_limit");
          if (params._meta) {
            if (params._meta.progressToken !== rpc.id) deny("mcp_order");
          }
          schema!.parse(params.arguments); this.admitted.push({ name: params.name, input: structuredClone(params.arguments) });
        }
      }
      return;
    }
    const identity = z.object({ session_id: z.string().min(1).max(128), uuid: z.string().min(1).max(128) }).parse(value);
    this.tally.add(value);
    if (this.workerSeen.has(identity.uuid)) deny("duplicate_uuid");
    const inert = !(value.type === "system" && value.subtype === "init") && claudeInertEvent(value);
    if (inert) { if (++this.inertCount > CLAUDE_INERT_FRAME_CAP) deny("inert_frame_limit"); }
    else if (++this.mainCount > CLAUDE_TRANSPORT_LIMITS.frames) deny("transport_frame_limit");
    if (this.resultSeen) {
      // After the result only strictly inert telemetry (e.g. session_state_changed idle) may trail; it is counted, unique, never
      // reopens the stream, and never changes the result. Anything else, including a second result, is refused.
      if (this.initialized && identity.session_id !== this.session) deny("session_mismatch");
      if (inert) { this.workerSeen.add(identity.uuid); return; }
      deny("message_after_result");
    }
    if (value.type === "system" && value.subtype === "init") {
      if (this.initialized) deny("init_duplicate");
      const init = z.object({ claude_code_version: z.literal("2.1.259"), cwd: z.literal(this.options.cwd), model: z.literal(this.options.model), apiKeySource: z.literal("none"),
        tools: z.array(z.string()), mcp_servers: z.array(z.object({ name: z.literal("component"), status: z.literal("connected") })),
        skills: z.array(z.never()), plugins: z.array(z.never()), agents: claudeHostBuiltinAgents.optional(), slash_commands: z.array(z.never()), permissionMode: z.literal("default") }).parse(value);
      const expected = Object.keys(this.schemas).map((name) => `mcp__component__${name}`).sort();
      if (!isDeepStrictEqual(init.tools.slice().sort(), expected) || init.mcp_servers.length !== 1) deny("init_tools");
      this.initialized = true; this.session = identity.session_id;
    } else {
      if (!this.initialized || identity.session_id !== this.session) deny("session_mismatch");
      if (inert) { this.workerSeen.add(identity.uuid); return; }
      if (!["assistant", "user", "result"].includes(String(value.type))) deny(unexpectedEventSite(value));
      if (value.type === "result") { this.settled(); this.resultSeen = true; }
      if (value.type !== "result") {
        const content = z.object({ content: z.union([z.string(), z.array(object)]) }).parse(value.message).content;
        if (Array.isArray(content)) for (const block of content) if (block.type === "tool_use" && !Object.hasOwn(this.schemas, String(block.name).replace(/^mcp__component__/, ""))) deny("undeclared_tool_use");
      }
    }
    this.workerSeen.add(identity.uuid);
  }
  claim(name: string, input: unknown): void {
    this.options.check(); const next = this.admitted.shift();
    if (!next || next.name !== name || !isDeepStrictEqual(next.input, input)) deny("tool_claim");
  }
  settled(): void { this.options.check(); if (this.admitted.length || this.hostIds.size) deny("settle_pending"); }
}
