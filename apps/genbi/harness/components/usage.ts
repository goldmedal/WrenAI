import type { LanguageModel } from "ai";
import type { ProviderUsage, UsageRecord, UsageTrace } from "../events/types.js";

export interface StepUsage { readonly inputTokens: number; readonly outputTokens: number }

/** Provider-reported counts; a missing or malformed count is recorded as zero, never omitted. */
export function reportedUsage(usage: { readonly inputTokens?: number | undefined; readonly outputTokens?: number | undefined } | undefined): StepUsage {
  const count = (value: number | undefined) => value !== undefined && Number.isSafeInteger(value) && value >= 0 ? value : 0;
  return { inputTokens: count(usage?.inputTokens), outputTokens: count(usage?.outputTokens) };
}

export function modelIdOf(model: LanguageModel): string {
  return typeof model === "string" ? model : model.modelId;
}

/** Per-step records plus their totals per provider, in first-seen order. */
export function summariseUsage(records: readonly UsageRecord[]): UsageTrace {
  const providers = new Map<string, ProviderUsage>();
  for (const record of records) {
    const key = JSON.stringify([record.zone, record.adapter, record.model]);
    const total = providers.get(key) ?? { zone: record.zone, adapter: record.adapter, model: record.model, calls: 0, inputTokens: 0, outputTokens: 0 };
    providers.set(key, { ...total, calls: total.calls + 1,
      inputTokens: total.inputTokens + record.inputTokens, outputTokens: total.outputTokens + record.outputTokens });
  }
  return { steps: [...records], providers: [...providers.values()] };
}
