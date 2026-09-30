import { z } from "zod";
import type { CodexConversation, CodexConversationAttachment, ConversationFrame, ConversationReplay } from "./codex-conversation.js";
import { CODEX_BASELINE_VERSION } from "./codex-compatibility.js";

const request = z.object({ id: z.union([z.string().max(256), z.number().int()]).optional(), method: z.string().max(128), params: z.record(z.string(), z.unknown()).optional() }).strict();
const input = z.array(z.object({ type: z.literal("text"), text: z.string().min(1).max(262_144), text_elements: z.array(z.unknown()).max(0).optional() }).strict()).min(1).max(16);
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/**
 * Protocol presented to the official remote TUI, not an app-server proxy.
 * Only text submission and interruption reach the governed conversation.
 * Config, filesystem, shell, auth, plugin and cross-thread mutations never do.
 * Catalogs describe this host's restricted surface, not the operator's account.
 */
export class CodexTerminalProtocol {
  private initialized = false;
  private acknowledged = false;
  private started = false;
  private submitted = false;
  private attachment: CodexConversationAttachment | undefined;
  private pendingTurn: string | number | undefined;
  private activeTurn: string | undefined;
  private closed = false;
  private readonly createdAt = Math.floor(Date.now() / 1000);
  private readonly ids = new Set<string | number>();
  constructor(private readonly conversation: CodexConversation, private readonly scope: { cwd: string; clientHome: string; model: string },
    private readonly send: (message: unknown) => void, private readonly assertActive: () => void, private readonly onReady: () => void = () => {}) {}

  close(): void { this.closed = true; this.attachment?.detach(); this.attachment = undefined; }
  private thread() {
    const id = this.conversation.terminalThreadId();
    return { id, sessionId: id, forkedFromId: null, parentThreadId: null, preview: "", ephemeral: true,
      section: null, sectionEnteredAt: null, projectId: null, historyMode: "legacy", modelProvider: "openai", model: this.scope.model,
      reasoningEffort: null, createdAt: this.createdAt, updatedAt: this.createdAt, recencyAt: this.createdAt,
      status: { type: this.activeTurn ? "active" : "idle", ...(this.activeTurn ? { activeFlags: [] } : {}) }, path: null,
      cwd: this.scope.cwd, cliVersion: CODEX_BASELINE_VERSION, originator: "genbi", source: "appServer", threadSource: "user",
      agentNickname: null, agentRole: null, gitInfo: null, name: null, turns: [] };
  }
  private result(id: string | number, result: unknown): void { if (!this.closed) this.send({ id, result }); }
  private error(id: string | number, message = "This operation is unavailable in the pinned GenBI session."): void {
    if (!this.closed) this.send({ id, error: { code: -32600, message } });
  }
  private event(frame: ConversationFrame | ConversationReplay): void {
    if (this.closed || frame.type !== "event") return;
    const event = structuredClone(frame.event) as { method: string; params: Record<string, unknown> };
    if (event.method === "turn/started" && record(event.params.turn)) {
      this.activeTurn = String(event.params.turn.id);
      if (this.pendingTurn !== undefined) { this.result(this.pendingTurn, { turn: terminalTurn(event.params.turn) }); this.pendingTurn = undefined; }
    }
    if (record(event.params.turn)) event.params.turn = terminalTurn(event.params.turn);
    if (record(event.params.item)) event.params.item = terminalItem(event.params.item);
    this.send(event);
    if (event.method === "turn/completed") this.activeTurn = undefined;
  }
  async receive(value: unknown): Promise<void> {
    const parsed = request.safeParse(value);
    if (!parsed.success || this.closed) throw new Error("Invalid terminal protocol message");
    const { id, method, params = {} } = parsed.data;
    if (method === "initialized" && id === undefined && this.initialized && !this.acknowledged) { this.acknowledged = true; return; }
    if (id === undefined) throw new Error("Invalid terminal protocol notification");
    if (this.ids.has(id) || this.ids.size >= 4096) throw new Error("Duplicate or excessive terminal request");
    this.ids.add(id);
    try {
      this.assertActive();
      if (method === "initialize") {
        if (this.initialized || !record(params.clientInfo) || params.clientInfo.name !== "codex-tui" || params.clientInfo.version !== CODEX_BASELINE_VERSION) throw new Error();
        this.initialized = true;
        this.result(id, { userAgent: `genbi/${CODEX_BASELINE_VERSION}`, codexHome: this.scope.clientHome, platformFamily: "unix", platformOs: "macos" }); return;
      }
      if (!this.acknowledged) throw new Error();
      // Every scoped request is confined to this process-owned thread/workspace.
      if (params.threadId != null && params.threadId !== this.conversation.terminalThreadId()) throw new Error();
      if (params.cwd != null && params.cwd !== this.scope.cwd) throw new Error();
      if (params.model != null && params.model !== this.scope.model) throw new Error();
      switch (method) {
        case "account/read": this.result(id, { account: null, requiresOpenaiAuth: false }); return; // login is owned by the host
        case "config/read": this.result(id, { config: { model: this.scope.model, model_provider: "openai", approval_policy: "never", sandbox_mode: "read-only",
          web_search: "disabled", check_for_update_on_startup: false, project_doc_max_bytes: 0, project_root_markers: [],
          projects: { [this.scope.cwd]: { trust_level: "trusted" } }, features: { remote_control: false, hooks: false, plugins: false, apps: false, multi_agent: false },
          history: { persistence: "none" } }, origins: {}, layers: [] }); return;
        case "configRequirements/read": this.result(id, { requirements: { allowedApprovalPolicies: ["never"], allowedSandboxModes: ["read-only"], allowedWebSearchModes: ["disabled"] } }); return;
        case "model/list": this.result(id, { data: [{ id: this.scope.model, model: this.scope.model, displayName: this.scope.model,
          description: "GenBI session model", hidden: false, isDefault: true, upgrade: null, upgradeInfo: null,
          supportedReasoningEfforts: [], defaultReasoningEffort: "medium", inputModalities: ["text"], supportsPersonality: false }], nextCursor: null }); return;
        case "hooks/list": this.result(id, { data: [{ cwd: this.scope.cwd, hooks: [], warnings: [], errors: [] }] }); return;
        case "skills/list": this.result(id, { data: [{ cwd: this.scope.cwd, skills: [], errors: [] }] }); return;
        case "plugin/list": this.result(id, { marketplaces: [], marketplaceLoadErrors: [], featuredPluginIds: [] }); return;
        case "app/installed": this.result(id, { apps: [] }); return;
        case "mcpServerStatus/list": this.result(id, { data: [], nextCursor: null }); return;
        case "collaborationMode/list": this.result(id, { data: [] }); return;
        case "thread/loaded/list": this.result(id, { data: this.started ? [this.conversation.terminalThreadId()] : [], nextCursor: null }); return;
        case "thread/list": this.result(id, { data: [], nextCursor: null, backwardsCursor: null }); return;
        case "thread/read":
          if (!this.started || params.includeTurns === true) throw new Error();
          this.result(id, { thread: this.thread() }); return;
        case "thread/turns/list":
          if (!this.started || this.submitted) throw new Error();
          this.result(id, { data: [], nextCursor: null, backwardsCursor: null }); return;
        case "thread/start": {
          if (this.started) throw new Error();
          // Client-supplied policy, tools and instructions are never forwarded.
          // The already-created host thread owns all execution authority.
          this.started = true;
          this.attachment = this.conversation.attach(this.conversation.capability, (f) => this.event(f), this.conversation.snapshot().sequence);
          const thread = this.thread();
          this.result(id, { thread, model: this.scope.model, modelProvider: "openai", serviceTier: null, disabledPluginIds: [], cwd: this.scope.cwd,
            runtimeWorkspaceRoots: [], instructionSources: [], approvalPolicy: "never", approvalsReviewer: "user",
            sandbox: { type: "readOnly", networkAccess: false }, activePermissionProfile: null, reasoningEffort: null });
          this.send({ method: "thread/started", params: { thread } }); this.onReady(); return;
        }
        case "turn/start": {
          if (!this.started || !this.attachment || this.pendingTurn !== undefined || this.activeTurn) throw new Error();
          const text = input.parse(params.input).map((part) => part.text).join("\n");
          if (Buffer.byteLength(text) > 262_144) throw new Error();
          // Only plain text enters the driver. Policy/model/config overrides,
          // injected tool outputs and collaboration instructions are rejected.
          for (const [key, val] of Object.entries(params)) {
            if (["threadId", "input", "cwd", "model", "clientUserMessageId"].includes(key) || val == null) continue;
            if (key === "approvalPolicy" && val === "never") continue;
            if (key === "approvalsReviewer" && val === "user") continue;
            if (key === "turnTrigger" && val === "user") continue;
            if (key === "serviceTier" && val === "default") continue;
            if (key === "runtimeWorkspaceRoots" && Array.isArray(val) && val.length === 0) continue;
            if (key === "sandboxPolicy" && record(val) && val.type === "readOnly" && val.networkAccess !== true) continue;
            throw new Error();
          }
          this.pendingTurn = id;
          this.submitted = true;
          void Promise.resolve().then(() => this.attachment!.submit(text)).catch(() => { if (this.pendingTurn !== undefined) this.error(this.pendingTurn, "GenBI could not complete the turn."); this.pendingTurn = undefined; }); return;
        }
        case "turn/steer": {
          if (!this.activeTurn || params.expectedTurnId !== this.activeTurn || !this.attachment?.steer) throw new Error();
          const text = input.parse(params.input).map((part) => part.text).join("\n");
          if (Buffer.byteLength(text) > 262_144) throw new Error();
          for (const [key, value] of Object.entries(params)) {
            if (["threadId", "expectedTurnId", "input", "clientUserMessageId"].includes(key) || value == null) continue;
            throw new Error();
          }
          this.result(id, await this.attachment.steer(text, this.activeTurn)); return;
        }
        case "turn/interrupt":
          if (!this.activeTurn || params.turnId !== this.activeTurn || !this.attachment) throw new Error();
          await this.attachment.interrupt(); this.result(id, {}); return;
        default: this.error(id); return;
      }
    } catch { this.error(id); }
  }
}

function terminalTurn(turn: Record<string, unknown>): Record<string, unknown> {
  return { ...turn, items: Array.isArray(turn.items) ? turn.items.map((i) => record(i) ? terminalItem(i) : i) : [], itemsView: turn.itemsView ?? "full",
    error: turn.status === "failed" ? { message: "GenBI execution failed.", codexErrorInfo: null, additionalDetails: null } : null,
    startedAt: null, completedAt: null, durationMs: null };
}
function terminalItem(item: Record<string, unknown>): Record<string, unknown> {
  if (item.type === "userMessage" && Array.isArray(item.content)) return { ...item, content: item.content.map((p) => record(p) ? { ...p, text_elements: [] } : p) };
  if (item.type === "agentMessage") return { ...item, phase: null };
  if (item.type === "dynamicToolCall") return { ...item, arguments: {}, contentItems: null, durationMs: null };
  return item;
}
