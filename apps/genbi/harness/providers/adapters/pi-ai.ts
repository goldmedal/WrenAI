import type {
  JSONObject,
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4Content,
  LanguageModelV4FinishReason,
  LanguageModelV4GenerateResult,
  LanguageModelV4Prompt,
  LanguageModelV4StreamPart,
  LanguageModelV4StreamResult,
  LanguageModelV4ToolResultOutput,
  LanguageModelV4Usage,
  SharedV4ProviderMetadata,
  SharedV4ProviderOptions,
  SharedV4Warning,
} from "@ai-sdk/provider";
// Type-only: erased at build time, so the optional dependency is never loaded
// unless a pi-ai model is actually called (see `loadPiAi`).
import type {
  Api,
  ApiKeyAuth,
  AssistantMessage,
  AssistantMessageEvent,
  AuthContext,
  Context,
  ImageContent,
  JsonObject,
  Message,
  Model,
  Models,
  Provider,
  StopReason,
  StreamOptions,
  TextContent,
  ThinkingContent,
  Tool,
  ToolCall,
  ToolResultMessage,
  TSchema,
  Usage,
} from "@earendil-works/pi-ai";

export const PI_AI_ADAPTER_ID = "pi-ai";

const PI_AI_PACKAGE = "@earendil-works/pi-ai";
const METADATA_KEY = "pi-ai";

/**
 * Config for the `pi-ai` adapter: one model behind pi-ai's unified client.
 *
 * - `provider` is a pi-ai built-in provider id (`openrouter`, `amazon-bedrock`,
 *   `vercel-ai-gateway`, ...), or — together with `baseUrl` — the name given to
 *   a custom endpoint.
 * - `baseUrl` turns the binding into a custom provider speaking the OpenAI
 *   chat-completions wire (`openai-completions`). Custom endpoints speaking the
 *   Anthropic messages wire are not wired up here and are untested.
 * - `apiKey` is passed on every request. Nothing else is consulted: no
 *   environment variables, no `~/.pi` files, no stored or OAuth credentials.
 */
export interface PiAiAdapterConfig {
  readonly provider: string;
  readonly model: string;
  readonly apiKey?: string;
  readonly baseUrl?: string;
  readonly headers?: Readonly<Record<string, string>>;
  /** Test seam: a fetch replacement so requests can be scripted offline. */
  readonly fetch?: typeof fetch;
}

interface PiAiRuntime {
  readonly core: typeof import("@earendil-works/pi-ai");
  readonly builtins: typeof import("@earendil-works/pi-ai/providers/all");
  readonly completions: typeof import("@earendil-works/pi-ai/api/openai-completions.lazy");
}

let runtime: Promise<PiAiRuntime> | undefined;

/**
 * Loads pi-ai on first use. It is an optional dependency (it needs Node
 * >= 22.19 and pulls several vendor SDKs), so nothing imports it until a
 * gateway-bound model is actually called.
 */
function loadPiAi(): Promise<PiAiRuntime> {
  runtime ??= Promise.all([
    import("@earendil-works/pi-ai"),
    import("@earendil-works/pi-ai/providers/all"),
    import("@earendil-works/pi-ai/api/openai-completions.lazy"),
  ]).then(
    ([core, builtins, completions]) => ({ core, builtins, completions }),
    (error: unknown) => {
      runtime = undefined;
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(
        `The pi-ai adapter (gateway mode) needs the optional dependency ${PI_AI_PACKAGE}, which could not be loaded: ${reason}. ` +
          `Install it alongside this package on Node.js >= 22.19, or choose a different runtime mode.`,
      );
    },
  );
  return runtime;
}

// No environment variables and no files: credentials only ever arrive as the
// per-request `apiKey`.
const SEALED_AUTH_CONTEXT: AuthContext = {
  env: async () => undefined,
  fileExists: async () => false,
};

/** An API-key auth that only accepts the key passed with the request. */
function explicitKeyAuth(name: string): ApiKeyAuth {
  return {
    name,
    resolve: async ({ credential }) => ({ auth: credential?.key ? { apiKey: credential.key } : {} }),
  };
}

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

async function resolveTarget(config: PiAiAdapterConfig): Promise<{ readonly models: Models; readonly model: Model<Api> }> {
  const { core, builtins, completions } = await loadPiAi();
  // An empty in-memory credential store: nothing stored, so pi-ai never
  // resolves a stored or OAuth credential.
  const models = core.createModels({ credentials: new core.InMemoryCredentialStore(), authContext: SEALED_AUTH_CONTEXT });

  if (config.baseUrl !== undefined) {
    const model: Model<"openai-completions"> = {
      id: config.model,
      name: config.model,
      api: "openai-completions",
      provider: config.provider,
      baseUrl: config.baseUrl,
      reasoning: false,
      input: ["text", "image"],
      cost: ZERO_COST,
      contextWindow: 128_000,
      maxTokens: 16_384,
    };
    models.setProvider(
      core.createProvider({
        id: config.provider,
        name: config.provider,
        baseUrl: config.baseUrl,
        auth: { apiKey: explicitKeyAuth(config.provider) },
        models: [model],
        api: completions.openAICompletionsApi(),
      }),
    );
    return { models, model };
  }

  const builtin = builtins.builtinProviders().find((candidate) => candidate.id === config.provider);
  if (builtin === undefined) {
    throw new Error(
      `pi-ai has no built-in provider "${config.provider}"; set a base URL to use it as a custom OpenAI-compatible endpoint. ` +
        `Known providers: ${builtins.builtinProviders().map((candidate) => candidate.id).join(", ")}`,
    );
  }
  if (builtin.auth.apiKey === undefined) {
    throw new Error(`pi-ai provider "${config.provider}" only supports OAuth sign-in, which gateway mode does not use.`);
  }
  // Register the provider with its API-key auth only: OAuth sign-in is never offered.
  const apiKeyOnly: Provider = { ...builtin, auth: { apiKey: builtin.auth.apiKey } };
  models.setProvider(apiKeyOnly);

  const model = models.getModel(config.provider, config.model);
  if (model === undefined) {
    // A provider may mix wire APIs across its models, so an uncatalogued id
    // cannot safely borrow another model's API. Fail instead of guessing.
    throw new Error(
      `pi-ai's catalog has no model "${config.model}" for provider "${config.provider}"; ` +
        `pick a catalogued model id, or set a base URL to call it as a custom OpenAI-compatible endpoint.`,
    );
  }
  return { models, model };
}

type Warnings = SharedV4Warning[];

function unsupported(warnings: Warnings, feature: string, details?: string): void {
  warnings.push(details === undefined ? { type: "unsupported", feature } : { type: "unsupported", feature, details });
}

function piOptions(options: SharedV4ProviderOptions | undefined): JSONObject | undefined {
  return options?.[METADATA_KEY];
}

function stringOption(options: SharedV4ProviderOptions | undefined, key: string): string | undefined {
  const value = piOptions(options)?.[key];
  return typeof value === "string" ? value : undefined;
}

function toBase64(data: Uint8Array | string): string {
  return typeof data === "string" ? data : Buffer.from(data).toString("base64");
}

function parseToolInput(input: unknown): JsonObject {
  if (typeof input === "string") {
    try {
      const parsed: unknown = JSON.parse(input);
      return isJsonObject(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return isJsonObject(input) ? input : {};
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toolResultContent(output: LanguageModelV4ToolResultOutput): { content: (TextContent | ImageContent)[]; isError: boolean } {
  switch (output.type) {
    case "text":
      return { content: [{ type: "text", text: output.value }], isError: false };
    case "json":
      return { content: [{ type: "text", text: JSON.stringify(output.value) }], isError: false };
    case "error-text":
      return { content: [{ type: "text", text: output.value }], isError: true };
    case "error-json":
      return { content: [{ type: "text", text: JSON.stringify(output.value) }], isError: true };
    case "execution-denied":
      return { content: [{ type: "text", text: output.reason ?? "Tool execution was denied." }], isError: true };
    case "content": {
      const content: (TextContent | ImageContent)[] = [];
      for (const part of output.value) {
        if (part.type === "text") content.push({ type: "text", text: part.text });
        else if (part.type === "file" && part.mediaType.startsWith("image/") && part.data.type === "data") {
          content.push({ type: "image", data: toBase64(part.data.data), mimeType: part.mediaType });
        }
      }
      return { content, isError: false };
    }
  }
}

const ZERO_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** Maps the AI SDK prompt and tools onto a pi-ai `Context`. */
export function toPiContext(
  prompt: LanguageModelV4Prompt,
  options: Pick<LanguageModelV4CallOptions, "tools" | "toolChoice" | "responseFormat">,
  model: Pick<Model<Api>, "api" | "provider" | "id">,
  warnings: Warnings,
): Context {
  const system: string[] = [];
  const messages: Message[] = [];
  const timestamp = Date.now();

  for (const message of prompt) {
    switch (message.role) {
      case "system":
        system.push(message.content);
        break;
      case "user": {
        const content: (TextContent | ImageContent)[] = [];
        for (const part of message.content) {
          if (part.type === "text") content.push({ type: "text", text: part.text });
          else if (part.data.type === "text") content.push({ type: "text", text: part.data.text });
          else if (part.mediaType.startsWith("image/") && part.data.type === "data") {
            content.push({ type: "image", data: toBase64(part.data.data), mimeType: part.mediaType });
          } else unsupported(warnings, "file part", `${part.mediaType} (${part.data.type})`);
        }
        messages.push({ role: "user", content, timestamp });
        break;
      }
      case "assistant": {
        const content: (TextContent | ThinkingContent | ToolCall)[] = [];
        for (const part of message.content) {
          if (part.type === "text") content.push({ type: "text", text: part.text });
          else if (part.type === "reasoning") {
            const signature = stringOption(part.providerOptions, "signature");
            content.push({ type: "thinking", thinking: part.text, ...(signature !== undefined ? { thinkingSignature: signature } : {}) });
          } else if (part.type === "tool-call") {
            const thoughtSignature = stringOption(part.providerOptions, "thoughtSignature");
            content.push({
              type: "toolCall",
              id: part.toolCallId,
              name: part.toolName,
              arguments: parseToolInput(part.input),
              ...(thoughtSignature !== undefined ? { thoughtSignature } : {}),
            });
          } else if (part.type !== "tool-result") unsupported(warnings, `assistant ${part.type} part`);
        }
        const assistant: AssistantMessage = {
          role: "assistant",
          content,
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: ZERO_USAGE,
          stopReason: content.some((part) => part.type === "toolCall") ? "toolUse" : "stop",
          timestamp,
        };
        messages.push(assistant);
        break;
      }
      case "tool":
        for (const part of message.content) {
          if (part.type !== "tool-result") continue;
          const result: ToolResultMessage = {
            role: "toolResult",
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            ...toolResultContent(part.output),
            timestamp,
          };
          messages.push(result);
        }
        break;
    }
  }

  const responseFormat = options.responseFormat;
  if (responseFormat?.type === "json") {
    // pi-ai has no provider-neutral structured-output switch; ask for JSON in
    // the instructions and let the caller validate the text as usual.
    warnings.push({ type: "compatibility", feature: "responseFormat", details: "requested through the system prompt" });
    system.push(
      responseFormat.schema !== undefined
        ? `Respond with only a JSON value that matches this JSON schema:\n${JSON.stringify(responseFormat.schema)}`
        : "Respond with only a JSON value.",
    );
  }

  const tools: Tool[] = [];
  const toolChoice = options.toolChoice?.type ?? "auto";
  if (toolChoice === "required" || toolChoice === "tool") unsupported(warnings, `toolChoice ${toolChoice}`, "sent as auto");
  if (toolChoice !== "none") {
    for (const tool of options.tools ?? []) {
      if (tool.type !== "function") {
        unsupported(warnings, "provider tool", tool.name);
        continue;
      }
      // pi-ai's TypeBox schemas are plain JSON Schema objects at runtime.
      tools.push({ name: tool.name, description: tool.description ?? "", parameters: tool.inputSchema as unknown as TSchema });
    }
  }

  return {
    ...(system.length > 0 ? { systemPrompt: system.join("\n\n") } : {}),
    messages,
    ...(tools.length > 0 ? { tools } : {}),
  };
}

/** Maps pi-ai's stop reason onto the AI SDK's unified finish reason. */
export function toFinishReason(stopReason: StopReason): LanguageModelV4FinishReason {
  switch (stopReason) {
    case "stop":
      return { unified: "stop", raw: stopReason };
    case "toolUse":
      return { unified: "tool-calls", raw: stopReason };
    case "length":
      return { unified: "length", raw: stopReason };
    case "error":
      return { unified: "error", raw: stopReason };
    default:
      return { unified: "other", raw: stopReason };
  }
}

/** Maps pi-ai usage (where `input` excludes cached tokens) onto AI SDK usage. */
export function toUsage(usage: Usage): LanguageModelV4Usage {
  const reasoning = usage.reasoning;
  return {
    inputTokens: {
      total: usage.input + usage.cacheRead + usage.cacheWrite,
      noCache: usage.input,
      cacheRead: usage.cacheRead,
      cacheWrite: usage.cacheWrite,
    },
    outputTokens: {
      total: usage.output,
      text: reasoning !== undefined ? Math.max(0, usage.output - reasoning) : usage.output,
      reasoning,
    },
  };
}

function providerMetadata(message: AssistantMessage): SharedV4ProviderMetadata {
  const metadata: JSONObject = {
    provider: message.provider,
    api: message.api,
    cost: { ...message.usage.cost },
  };
  if (message.responseModel !== undefined) metadata["responseModel"] = message.responseModel;
  return { [METADATA_KEY]: metadata };
}

function signatureMetadata(key: string, value: string | undefined): SharedV4ProviderMetadata | undefined {
  return value !== undefined ? { [METADATA_KEY]: { [key]: value } } : undefined;
}

function toContent(message: AssistantMessage): LanguageModelV4Content[] {
  const content: LanguageModelV4Content[] = [];
  for (const part of message.content) {
    if (part.type === "text") content.push({ type: "text", text: part.text });
    else if (part.type === "thinking") {
      const metadata = signatureMetadata("signature", part.thinkingSignature);
      content.push({ type: "reasoning", text: part.thinking, ...(metadata ? { providerMetadata: metadata } : {}) });
    } else {
      const metadata = signatureMetadata("thoughtSignature", part.thoughtSignature);
      content.push({
        type: "tool-call",
        toolCallId: part.id,
        toolName: part.name,
        input: JSON.stringify(part.arguments),
        ...(metadata ? { providerMetadata: metadata } : {}),
      });
    }
  }
  return content;
}

class PiAiLanguageModel implements LanguageModelV4 {
  readonly specificationVersion = "v4";
  readonly provider: string;
  readonly modelId: string;
  readonly supportedUrls: Record<string, RegExp[]> = {};
  private target: Promise<{ readonly models: Models; readonly model: Model<Api> }> | undefined;

  constructor(private readonly config: PiAiAdapterConfig) {
    this.provider = `${PI_AI_ADAPTER_ID}.${config.provider}`;
    this.modelId = config.model;
  }

  private resolve(): Promise<{ readonly models: Models; readonly model: Model<Api> }> {
    this.target ??= resolveTarget(this.config).catch((error: unknown) => {
      this.target = undefined;
      throw error;
    });
    return this.target;
  }

  /** Removes the configured key from any text that may surface in an error or log. */
  private redact(text: string): string {
    const key = this.config.apiKey;
    return key !== undefined && key.length > 0 ? text.split(key).join("[redacted]") : text;
  }

  private failure(message: AssistantMessage): Error {
    const detail = message.errorMessage ?? message.stopReason;
    return new Error(this.redact(`pi-ai ${this.config.provider}/${this.config.model} request failed: ${detail}`));
  }

  private async start(options: LanguageModelV4CallOptions): Promise<{ events: AsyncIterable<AssistantMessageEvent>; warnings: Warnings }> {
    const { models, model } = await this.resolve();
    const warnings: Warnings = [];
    const context = toPiContext(options.prompt, options, model, warnings);
    for (const [feature, value] of [
      ["topP", options.topP],
      ["topK", options.topK],
      ["presencePenalty", options.presencePenalty],
      ["frequencyPenalty", options.frequencyPenalty],
      ["seed", options.seed],
      ["stopSequences", options.stopSequences],
    ] as const) {
      if (value !== undefined) unsupported(warnings, feature);
    }
    if (options.reasoning !== undefined && options.reasoning !== "provider-default") unsupported(warnings, "reasoning");

    const headers: Record<string, string> = { ...this.config.headers };
    for (const [name, value] of Object.entries(options.headers ?? {})) if (value !== undefined) headers[name] = value;

    const streamOptions: StreamOptions = {
      ...(this.config.apiKey !== undefined ? { apiKey: this.config.apiKey } : {}),
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
      ...(this.config.fetch !== undefined ? { fetch: this.config.fetch } : {}),
      ...(options.abortSignal !== undefined ? { signal: options.abortSignal } : {}),
      ...(options.maxOutputTokens !== undefined ? { maxTokens: options.maxOutputTokens } : {}),
      ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
    };
    return { events: models.stream(model, context, streamOptions), warnings };
  }

  async doGenerate(options: LanguageModelV4CallOptions): Promise<LanguageModelV4GenerateResult> {
    const { events, warnings } = await this.start(options);
    let final: AssistantMessage | undefined;
    for await (const event of events) {
      if (event.type === "done") final = event.message;
      else if (event.type === "error") throw this.failure(event.error);
    }
    if (final === undefined) throw new Error(`pi-ai ${this.config.provider}/${this.config.model} stream ended without a result`);
    return {
      content: toContent(final),
      finishReason: toFinishReason(final.stopReason),
      usage: toUsage(final.usage),
      providerMetadata: providerMetadata(final),
      response: {
        ...(final.responseId !== undefined ? { id: final.responseId } : {}),
        modelId: final.responseModel ?? final.model,
        timestamp: new Date(final.timestamp),
      },
      warnings,
    };
  }

  async doStream(options: LanguageModelV4CallOptions): Promise<LanguageModelV4StreamResult> {
    const { events, warnings } = await this.start(options);
    const failure = (message: AssistantMessage) => this.failure(message);
    const stream = new ReadableStream<LanguageModelV4StreamPart>({
      async start(controller) {
        controller.enqueue({ type: "stream-start", warnings });
        const toolInputIds = new Map<number, string>();
        try {
          for await (const event of events) {
            for (const part of toStreamParts(event, toolInputIds, failure)) controller.enqueue(part);
          }
        } catch (error) {
          controller.enqueue({ type: "error", error });
        }
        controller.close();
      },
    });
    return { stream };
  }
}

/** Maps one pi-ai stream event onto zero or more AI SDK stream parts. */
export function toStreamParts(
  event: AssistantMessageEvent,
  toolInputIds: Map<number, string>,
  failure: (message: AssistantMessage) => Error,
): LanguageModelV4StreamPart[] {
  switch (event.type) {
    case "start":
      return [];
    case "text_start":
      return [{ type: "text-start", id: `text-${event.contentIndex}` }];
    case "text_delta":
      return [{ type: "text-delta", id: `text-${event.contentIndex}`, delta: event.delta }];
    case "text_end":
      return [{ type: "text-end", id: `text-${event.contentIndex}` }];
    case "thinking_start":
      return [{ type: "reasoning-start", id: `reasoning-${event.contentIndex}` }];
    case "thinking_delta":
      return [{ type: "reasoning-delta", id: `reasoning-${event.contentIndex}`, delta: event.delta }];
    case "thinking_end": {
      const block = event.partial.content[event.contentIndex];
      const metadata = signatureMetadata("signature", block?.type === "thinking" ? block.thinkingSignature : undefined);
      return [{ type: "reasoning-end", id: `reasoning-${event.contentIndex}`, ...(metadata ? { providerMetadata: metadata } : {}) }];
    }
    case "toolcall_start": {
      const block = event.partial.content[event.contentIndex];
      const call = block?.type === "toolCall" ? block : undefined;
      const id = call?.id || `tool-${event.contentIndex}`;
      toolInputIds.set(event.contentIndex, id);
      return [{ type: "tool-input-start", id, toolName: call?.name ?? "" }];
    }
    case "toolcall_delta": {
      const id = toolInputIds.get(event.contentIndex) ?? `tool-${event.contentIndex}`;
      return [{ type: "tool-input-delta", id, delta: event.delta }];
    }
    case "toolcall_end": {
      const id = toolInputIds.get(event.contentIndex) ?? `tool-${event.contentIndex}`;
      const metadata = signatureMetadata("thoughtSignature", event.toolCall.thoughtSignature);
      return [
        { type: "tool-input-end", id },
        {
          type: "tool-call",
          toolCallId: event.toolCall.id || id,
          toolName: event.toolCall.name,
          input: JSON.stringify(event.toolCall.arguments),
          ...(metadata ? { providerMetadata: metadata } : {}),
        },
      ];
    }
    case "done":
      return [
        {
          type: "response-metadata",
          ...(event.message.responseId !== undefined ? { id: event.message.responseId } : {}),
          modelId: event.message.responseModel ?? event.message.model,
          timestamp: new Date(event.message.timestamp),
        },
        {
          type: "finish",
          finishReason: toFinishReason(event.message.stopReason),
          usage: toUsage(event.message.usage),
          providerMetadata: providerMetadata(event.message),
        },
      ];
    case "error":
      return [
        { type: "error", error: failure(event.error) },
        {
          type: "finish",
          finishReason: toFinishReason(event.error.stopReason),
          usage: toUsage(event.error.usage),
          providerMetadata: providerMetadata(event.error),
        },
      ];
  }
}

/** pi-ai's built-in, offline catalog: API-key providers and one provider's chat models. */
export interface PiAiCatalog {
  readonly providers: readonly string[];
  readonly models: readonly { readonly id: string; readonly name: string }[];
}

/**
 * Lists the catalog that ships inside pi-ai — no network, no credentials.
 * OAuth-only providers are left out because gateway mode cannot use them.
 */
export async function listPiAiCatalog(provider?: string): Promise<PiAiCatalog> {
  const { builtins } = await loadPiAi();
  const providers = builtins.builtinProviders().filter((candidate) => candidate.auth.apiKey !== undefined).map((candidate) => candidate.id);
  if (provider === undefined || !providers.includes(provider)) return { providers, models: [] };
  const catalogued = builtins.getBuiltinModels(provider as Parameters<typeof builtins.getBuiltinModels>[0]);
  return { providers, models: catalogued.map((model) => ({ id: model.id, name: model.name })) };
}

function requireNonEmpty(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`pi-ai adapter config requires a non-empty "${field}"`);
  }
  return value;
}

export function createPiAiAdapter(config: PiAiAdapterConfig): LanguageModelV4 {
  requireNonEmpty(config.provider, "provider");
  requireNonEmpty(config.model, "model");
  return new PiAiLanguageModel(config);
}
