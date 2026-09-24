import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { AdapterSpec, TierBinding } from "./binding.js";

/**
 * Where a tier's model runs. `private` is a deployment the operator trusts
 * with project data (rows, SQL, the semantic context); `public` is anything
 * else, typically a cloud API. A deployment fact declared on the binding —
 * never derived from an endpoint host, a model id or an adapter kind.
 */
export const ZONES = ["private", "public"] as const;
export type Zone = (typeof ZONES)[number];
export const zoneSchema = z.enum(ZONES);

/** The answer shapes a planner may declare for a slot and the policy may allow. */
export const ANSWER_SHAPES = ["scalar", "series", "table", "narrative"] as const;
export type AnswerShape = (typeof ANSWER_SHAPES)[number];
export const answerShapeSchema = z.enum(ANSWER_SHAPES);

/**
 * The egress disclosure policy: what a verified callee answer may look like
 * before it is disclosed to a public-zone caller. `max_rows` is required and
 * must be a positive integer — a policy that forgets it would otherwise
 * silently allow any table through, which is the wrong default for a gate.
 */
export const disclosurePolicySchema = z.object({
  allowed_shapes: z.array(answerShapeSchema).min(1).default([...ANSWER_SHAPES]),
  max_rows: z.number().int().positive(),
  min_group_size: z.number().int().nonnegative().default(1),
  sensitive_column_patterns: z.array(z.string().min(1)).default([]),
  /** Regexes matched against string cells; the built-in PII set applies as well. */
  pii_patterns: z.array(z.string().min(1)).default([]),
  /** Judge wall-clock budget; a judge that exceeds it refuses the slot. */
  judge_timeout_ms: z.number().int().positive().default(30_000),
}).strict();
export type DisclosurePolicy = z.infer<typeof disclosurePolicySchema>;

/**
 * Non-step tiers the zone gate must check by role. Each value is a binding
 * key (a bare tier or `<mount>/<tier>`) that must resolve in `tiers`.
 */
export const zoneRolesSchema = z.object({
  judge: z.string().min(1).optional(),
  render: z.string().min(1).optional(),
}).strict();
export type ZoneRoles = z.infer<typeof zoneRolesSchema>;

const adapterSpecSchema = z.object({
  adapter: z.string().min(1),
  config: z.record(z.string(), z.unknown()).default({}),
  zone: zoneSchema.optional(),
}).strict();

/**
 * The on-disk tier binding document (`--tier-binding <file>`), the file
 * counterpart of the `--tier-adapter` flags. Keys of `tiers` are bare tier
 * names or `<mount>/<tier>`; `disclosure_policy` and `roles` are the hybrid
 * split's additions. Credentials belong in the adapter's environment, not in
 * this file, but nothing here forbids `config.apiKey` for a local dev setup.
 */
export const tierBindingDocumentSchema = z.object({
  tiers: z.record(z.string().min(1), adapterSpecSchema),
  disclosure_policy: disclosurePolicySchema.optional(),
  roles: zoneRolesSchema.optional(),
}).strict();
export type TierBindingDocument = z.infer<typeof tierBindingDocumentSchema>;

export class TierBindingParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TierBindingParseError";
  }
}

function describeIssues(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.map(String).join(".") || "<root>"}: ${issue.message}`).join("; ");
}

/** Parses a tier binding document into the runtime `TierBinding`, loud-failing on any schema violation. */
export function parseTierBindingDocument(value: unknown): TierBinding {
  const parsed = tierBindingDocumentSchema.safeParse(value);
  if (!parsed.success) throw new TierBindingParseError(`tier binding is invalid — ${describeIssues(parsed.error)}`);
  const tiers: Record<string, AdapterSpec> = {};
  for (const [key, spec] of Object.entries(parsed.data.tiers)) {
    if (key.startsWith("/") || key.endsWith("/") || key.split("/").length > 2) {
      throw new TierBindingParseError(`tier binding key "${key}" must be "<tier>" or "<mount>/<tier>"`);
    }
    tiers[key] = { adapter: spec.adapter, config: spec.config, ...(spec.zone !== undefined ? { zone: spec.zone } : {}) };
  }
  const binding: TierBinding = {
    tiers,
    ...(parsed.data.disclosure_policy !== undefined ? { disclosurePolicy: parsed.data.disclosure_policy } : {}),
    ...(parsed.data.roles !== undefined ? { roles: parsed.data.roles } : {}),
  };
  for (const [role, key] of Object.entries(binding.roles ?? {})) {
    if (key !== undefined && binding.tiers[key] === undefined) {
      throw new TierBindingParseError(`roles.${role} names tier "${key}", which is not in tiers`);
    }
  }
  return binding;
}

/** Parses a disclosure policy on its own (the shape the egress verification step consumes). */
export function parseDisclosurePolicy(value: unknown): DisclosurePolicy {
  const parsed = disclosurePolicySchema.safeParse(value);
  if (!parsed.success) throw new TierBindingParseError(`disclosure_policy is invalid — ${describeIssues(parsed.error)}`);
  return parsed.data;
}

/** Reads and parses a JSON tier binding file. */
export async function readTierBindingFile(filePath: string): Promise<TierBinding> {
  let text: string;
  try {
    text = await readFile(filePath, "utf8");
  } catch (error) {
    throw new TierBindingParseError(`cannot read tier binding file "${filePath}": ${error instanceof Error ? error.message : String(error)}`);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new TierBindingParseError(`tier binding file "${filePath}" is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return parseTierBindingDocument(value);
}
