export { UnknownAdapterError, UnknownTierError } from "./errors.js";

export { createProviderRegistry } from "./registry.js";
export type { AdapterFactory, ProviderRegistry } from "./registry.js";

export {
  isZoneAwareBinding,
  parseTierBindingKey,
  resolveStepModel,
  resolveTierModel,
  resolveTierSpec,
  tierBindingKey,
} from "./binding.js";
export type { AdapterSpec, TierBinding } from "./binding.js";

export {
  ANSWER_SHAPES,
  ZONES,
  answerShapeSchema,
  disclosurePolicySchema,
  parseDisclosurePolicy,
  parseTierBindingDocument,
  readTierBindingFile,
  TierBindingParseError,
  tierBindingDocumentSchema,
  zoneRolesSchema,
  zoneSchema,
} from "./zone.js";
export type { AnswerShape, DisclosurePolicy, TierBindingDocument, Zone, ZoneRoles } from "./zone.js";

export { createMockAdapter, MOCK_ADAPTER_ID } from "./adapters/mock.js";
export type { MockAdapterConfig } from "./adapters/mock.js";

export {
  createOpenAICompatibleAdapter,
  mergeRequestBody,
  OPENAI_COMPATIBLE_ADAPTER_ID,
} from "./adapters/openai-compatible.js";
export type { OpenAICompatibleAdapterConfig } from "./adapters/openai-compatible.js";

export { ANTHROPIC_ADAPTER_ID, createAnthropicAdapter } from "./adapters/anthropic.js";
export type { AnthropicAdapterConfig } from "./adapters/anthropic.js";

export { createOpenAIAdapter, OPENAI_ADAPTER_ID } from "./adapters/openai.js";
export type { OpenAIAdapterConfig } from "./adapters/openai.js";

export { createPiAiAdapter, listPiAiCatalog, PI_AI_ADAPTER_ID } from "./adapters/pi-ai.js";
export type { PiAiAdapterConfig, PiAiCatalog } from "./adapters/pi-ai.js";

import { createAnthropicAdapter, ANTHROPIC_ADAPTER_ID } from "./adapters/anthropic.js";
import { createMockAdapter, MOCK_ADAPTER_ID } from "./adapters/mock.js";
import { createOpenAIAdapter, OPENAI_ADAPTER_ID } from "./adapters/openai.js";
import {
  createOpenAICompatibleAdapter,
  OPENAI_COMPATIBLE_ADAPTER_ID,
} from "./adapters/openai-compatible.js";
import { createPiAiAdapter, PI_AI_ADAPTER_ID } from "./adapters/pi-ai.js";
import { createProviderRegistry, type ProviderRegistry } from "./registry.js";

/**
 * A provider registry pre-populated with the built-in adapters
 * (`mock`, `openai-compatible`, `anthropic`, `openai`, `pi-ai`). Callers can still
 * `register()` additional adapter ids onto the returned registry.
 */
export function createDefaultProviderRegistry(): ProviderRegistry {
  const registry = createProviderRegistry();
  registry.register(MOCK_ADAPTER_ID, createMockAdapter);
  registry.register(OPENAI_COMPATIBLE_ADAPTER_ID, createOpenAICompatibleAdapter);
  registry.register(ANTHROPIC_ADAPTER_ID, createAnthropicAdapter);
  registry.register(OPENAI_ADAPTER_ID, createOpenAIAdapter);
  registry.register(PI_AI_ADAPTER_ID, createPiAiAdapter);
  return registry;
}
