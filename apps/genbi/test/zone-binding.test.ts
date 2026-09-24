import { describe, expect, it } from "vitest";
import { buildTierBindingFromFlags, CliUsageError, parseTierAdapterFlag } from "../harness/cli-args.js";
import {
  isZoneAwareBinding,
  parseDisclosurePolicy,
  parseTierBindingDocument,
  resolveTierSpec,
  TierBindingParseError,
  tierBindingKey,
} from "../harness/providers/index.js";
import { filterTierBindingForAgent } from "../harness/route/in-process.js";

const policy = { allowed_shapes: ["scalar", "series", "table", "narrative"], max_rows: 50, min_group_size: 5, sensitive_column_patterns: ["email", "phone", "ssn", "salary"] };

describe("tier binding document: zone and disclosure_policy", () => {
  it("parses zone per tier, mount-qualified keys, a disclosure policy and roles", () => {
    const binding = parseTierBindingDocument({
      tiers: {
        "plan_report/plan": { adapter: "anthropic", config: { model: "sonnet" }, zone: "public" },
        "answer_batch/strong": { adapter: "openai-compatible", config: { baseURL: "https://nim.internal/v1", model: "nemotron-super" }, zone: "private" },
        judge: { adapter: "openai-compatible", config: { baseURL: "https://nim.internal/v1", model: "nemotron-nano" }, zone: "private" },
      },
      disclosure_policy: policy,
      roles: { judge: "judge" },
    });
    expect(binding.tiers["plan_report/plan"]).toMatchObject({ adapter: "anthropic", zone: "public" });
    expect(binding.disclosurePolicy).toMatchObject({ max_rows: 50, min_group_size: 5, allowed_shapes: ["scalar", "series", "table", "narrative"] });
    expect(binding.roles).toEqual({ judge: "judge" });
    expect(isZoneAwareBinding(binding)).toBe(true);
  });
  it("rejects an unknown zone value", () => {
    expect(() => parseTierBindingDocument({ tiers: { strong: { adapter: "mock", config: {}, zone: "trusted" } } })).toThrow(TierBindingParseError);
    expect(() => parseTierBindingDocument({ tiers: { strong: { adapter: "mock", config: {}, zone: "trusted" } } })).toThrow(/tiers\.strong\.zone/);
  });
  it("rejects a policy with a missing or negative max_rows", () => {
    const { max_rows: _omitted, ...missing } = policy;
    expect(() => parseDisclosurePolicy(missing)).toThrow(/max_rows/);
    expect(() => parseDisclosurePolicy({ ...policy, max_rows: -1 })).toThrow(/max_rows/);
    expect(() => parseDisclosurePolicy({ ...policy, max_rows: 0 })).toThrow(/max_rows/);
    expect(() => parseTierBindingDocument({ tiers: { strong: { adapter: "mock" } }, disclosure_policy: missing })).toThrow(/disclosure_policy\.max_rows/);
  });
  it("rejects an unknown shape, a malformed key and a role naming an absent tier", () => {
    expect(() => parseDisclosurePolicy({ ...policy, allowed_shapes: ["scalar", "blob"] })).toThrow(/allowed_shapes/);
    expect(() => parseTierBindingDocument({ tiers: { "a/b/c": { adapter: "mock" } } })).toThrow(/must be "<tier>" or "<mount>\/<tier>"/);
    expect(() => parseTierBindingDocument({ tiers: { strong: { adapter: "mock" } }, roles: { judge: "judge" } })).toThrow(/roles\.judge names tier "judge"/);
  });
  it("treats a flat map with no zone information as a legacy, non-zone-aware binding", () => {
    const binding = parseTierBindingDocument({ tiers: { cheap: { adapter: "mock" }, strong: { adapter: "mock" } } });
    expect(isZoneAwareBinding(binding)).toBe(false);
  });
});

describe("(mount, tier) resolution", () => {
  const binding = parseTierBindingDocument({ tiers: {
    strong: { adapter: "mock", config: { modelId: "shared-strong" }, zone: "private" },
    "plan_report/strong": { adapter: "mock", config: { modelId: "cloud-strong" }, zone: "public" },
  } });
  it("prefers the exact mount-qualified key and falls back to the bare tier", () => {
    expect(tierBindingKey("plan_report", "strong")).toBe("plan_report/strong");
    expect(resolveTierSpec(binding, "strong", "plan_report")).toMatchObject({ key: "plan_report/strong", spec: { zone: "public", config: { modelId: "cloud-strong" } } });
    expect(resolveTierSpec(binding, "strong", "answer_batch")).toMatchObject({ key: "strong", spec: { zone: "private", config: { modelId: "shared-strong" } } });
    expect(resolveTierSpec(binding, "strong")).toMatchObject({ key: "strong" });
    expect(resolveTierSpec(binding, "cheap", "answer_batch")).toBeUndefined();
  });
  it("projects a legacy agent's tiers through its own mount", () => {
    const projected = filterTierBindingForAgent({ id: "plan_report", steps: [{ tier: "strong" }] }, binding.tiers);
    expect(projected).toEqual({ strong: binding.tiers["plan_report/strong"] });
    expect(filterTierBindingForAgent({ id: "answer_query", steps: [{ tier: "strong" }] }, binding.tiers)).toEqual({ strong: binding.tiers["strong"] });
  });
});

describe("--tier-adapter zone= and mount-qualified tiers", () => {
  it("parses zone and a <mount>/<tier> name", () => {
    expect(parseTierAdapterFlag("answer_query/strong=local:endpoint=http://nim.internal/v1,model=nemotron,zone=private")).toEqual({
      tier: "answer_query/strong", mode: "local", fields: { endpoint: "http://nim.internal/v1", model: "nemotron" }, zone: "private",
    });
    const tiers = buildTierBindingFromFlags(["plan=api-key:adapter=anthropic,model=sonnet,zone=public", "strong=local:zone=private"]);
    expect(tiers["plan"]).toMatchObject({ adapter: "anthropic", zone: "public" });
    expect(tiers["strong"]).toMatchObject({ adapter: "openai-compatible", zone: "private" });
    expect(buildTierBindingFromFlags(["cheap=local"])["cheap"]).not.toHaveProperty("zone");
  });
  it("rejects an unknown zone and a malformed mount key", () => {
    expect(() => parseTierAdapterFlag("strong=local:zone=trusted")).toThrow(CliUsageError);
    expect(() => parseTierAdapterFlag("strong=local:zone=trusted")).toThrow(/zone must be one of private\|public/);
    expect(() => parseTierAdapterFlag("a/b/c=local")).toThrow(/<mount>\/<tier>/);
  });
});
