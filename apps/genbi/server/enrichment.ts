/**
 * Host-owned contract for optional post-bind enrichment.
 *
 * This is intentionally a GenBI contract, not an import of any runtime's
 * implementation.  A runtime may inspect and draft, but only this host keeps
 * the revision lock, risk classification, approvals and completion ledger.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

export type EnrichmentMode = "grill" | "autopilot";
export type EnrichmentRisk = "low" | "high" | "conflict" | "ambiguous";
export type EnrichmentDecision = "accept" | "edit" | "skip";
export type EnrichmentRunStatus = "drafting" | "validation_pending" | "validation_failed" | "awaiting_decision" | "awaiting_approval" | "ready" | "completed" | "cancelled" | "reconcile_required" | "failed"
  /** OpenShell apply-all lifecycle: in flight, done, refused with evidence, rolled back, or discarded by the user. */
  | "applying" | "applied" | "apply_refused" | "apply_failed" | "discarded";
/**
 * `description_append` adds or extends a `description` in an existing `models/<name>/metadata.yml`. It is OpenShell-only: the model returns a
 * closed payload of descriptions (never the file), the host merges it line by line into the published snapshot's bytes, and the host-local
 * ladder refuses the kind because only the OpenShell materialization and validator realize it.
 */
export type EnrichmentChangeKind = "knowledge_append" | "description_append" | "new_cube" | "new_view" | "new_relationship" | "mdl_metric" | "calculated_column" | "conflict" | "ambiguous";
export type EnrichmentOperationState = "validation_pending" | "validation_failed" | "awaiting_decision" | "awaiting_approval" | "ready" | "ready_to_reapply" | "applying" | "applied" | "skipped" | "reconcile_required";
/**
 * Model-authored confidence is display-only. It never participates in risk,
 * approval, or Auto-pilot eligibility. Numbers remain accepted internally so
 * existing ledgers and callers can be read during the transition to labels.
 */
export type EnrichmentConfidence = string | number;

/** Safe, sink-scoped proposal metadata. Never carry source material or SDK ids. */
export interface EnrichmentOperation {
  readonly id: string;
  readonly sink: string;
  readonly risk: EnrichmentRisk;
  readonly summary: string;
  readonly confidence: EnrichmentConfidence;
  readonly changeKind: EnrichmentChangeKind;
  readonly draft: string;
}

export interface EnrichmentProposal {
  readonly id: string;
  readonly hash: string;
  readonly projectRevision: string;
  readonly operations: readonly EnrichmentOperation[];
}

/**
 * The host's view of the currently bound project. Paths alone are not an
 * authority: a symlink can be retargeted and the same spelling can name a
 * different directory. `identity` is deliberately a portable textual form of
 * the platform's device/inode pair, while `path` is the canonical realpath.
 */
export interface EnrichmentBinding {
  readonly path: string;
  readonly identity: string;
  readonly generation: number;
  readonly revision: string;
}

export type UnversionedEnrichmentBinding = Omit<EnrichmentBinding, "generation">;

/**
 * The subset of a binding that identifies *which directory* is bound,
 * independent of whether it has ever been built. Binding a project (Setup's
 * connect step, adopt, the context step's temporary healthcheck bind) is a
 * foundation operation that must succeed regardless of build state, so it
 * may only ever produce this — never a revision.
 */
export type ProjectIdentity = Omit<UnversionedEnrichmentBinding, "revision">;

/** Untrusted runtime draft: host ignores its ids, hash, revision and risk. */
export interface EnrichmentDraftOperation { readonly sink: string; readonly changeKind: EnrichmentChangeKind; readonly summary: string; readonly draft: string; readonly confidence?: unknown; readonly id?: string; readonly risk?: EnrichmentRisk; }
export interface EnrichmentDraft { readonly operations: readonly EnrichmentDraftOperation[]; readonly id?: string; readonly hash?: string; readonly projectRevision?: string; }

/**
 * A runner's own live answer to "can you serve `draft()` right now, and if
 * not, why not". `reason` is a short, stable, machine-readable code (never
 * free-form prose): it must already be safe to hand to a browser as-is, so
 * it must never carry a runner/dispatcher path, an SDK session id, or any
 * provider identity beyond what the caller's own runtime configuration
 * already chose. The host route (`server/app.ts`) only forwards whatever
 * `readiness()` returns; it never re-derives it from the runtime config
 * itself, so a runner that grows a new refusal reason surfaces it here
 * without the route needing to change.
 */
export interface EnrichmentRunnerReadiness {
  readonly available: boolean;
  readonly reason?: string;
}

export interface EnrichmentRunner {
  /**
   * A runner only drafts a typed proposal.  It must not mutate a project: the
   * host validates and applies accepted operations through its completion
   * ledger.  The production constructor deliberately does not provide one
   * until the dispatcher exposes this callback contract.
   */
  draft(input: { readonly projectPath: string; readonly mode: EnrichmentMode; readonly projectRevision: string }): Promise<unknown>;

  /**
   * Optional live readiness check, independent of `draft()`: it must return
   * without dispatching, without a live model turn, and without any other
   * cost or side effect -- a pure read of whatever the runner already
   * consults to decide whether to refuse (e.g. the current `AuthChoice`).
   * Omitted only by test doubles that don't model refusal; such a runner is
   * treated as always available, matching this capability's behavior before
   * `readiness()` existed.
   */
  readiness?(): EnrichmentRunnerReadiness;
}

/** Trusted deterministic apply seam owned and invoked by the host. */
export interface EnrichmentApplyRunner {
  apply(input: { readonly projectPath: string; readonly projectRevision: string; readonly proposalHash: string; readonly operation: EnrichmentOperation; readonly idempotencyKey: string; readonly fence: number }): Promise<{ readonly validationDigest: string; readonly buildDigest: string }>;
  reconcile(input: { readonly idempotencyKey: string; readonly fence: number }): Promise<{ readonly state: "applied" | "not_applied" | "still_unknown"; readonly validationDigest?: string; readonly buildDigest?: string }>;
}

/** The host never sends proposal text to an approval provider. */
export interface EnrichmentApprovalRequest {
  readonly runId: string;
  readonly binding: EnrichmentBinding;
  readonly proposalHash: string;
  readonly operation: { readonly id: string; readonly sink: string; readonly risk: EnrichmentRisk; readonly changeKind: EnrichmentChangeKind; readonly hash: string };
}

/** A trusted host callback returns an opaque, short-lived authorization record. */
export interface EnrichmentApprovalAttestation {
  readonly evidenceRef: string;
  readonly nonce: string;
  readonly expiresAt: string;
  readonly binding: EnrichmentBinding;
  readonly proposalHash: string;
  readonly operationHash: string;
}

export interface EnrichmentApprovalProvider { attest(input: EnrichmentApprovalRequest): Promise<EnrichmentApprovalAttestation>; }

/** Closed-vocabulary description of why a draft was refused; never carries model text. */
export interface ProposalDiagnostic { readonly operations: number; readonly items: readonly { readonly fields: readonly string[]; readonly kind: string; readonly kind_length: string; readonly sink: string }[] }
export class EnrichmentContractError extends Error { diagnostic?: ProposalDiagnostic; }

/**
 * Identifies a project directory without requiring it to be built. This is
 * the only resolution `bindProject` may use: binding must succeed for a
 * freshly connected, not-yet-compiled project, so it can never read or
 * require `target/mdl.json`.
 */
export function resolveProjectIdentity(projectPath: string): ProjectIdentity {
  const canonicalPath = realpathSync(projectPath);
  const stats = statSync(canonicalPath);
  return {
    path: canonicalPath,
    // `dev` and `ino` are the portable subset Node exposes on POSIX and are
    // stringified so SQLite/JSON never loses precision on a large inode.
    identity: `dev:${String(stats.dev)}:ino:${String(stats.ino)}`,
  };
}

/**
 * Identifies a project directory *and* proves it is built. Only enrichment
 * call sites may use this: they need a concrete revision to lock a run
 * against or to fence an in-flight operation, and it is legitimate for them
 * to refuse (via `EnrichmentContractError`) when the project isn't built.
 */
export function resolveEnrichmentBinding(projectPath: string): UnversionedEnrichmentBinding {
  const identity = resolveProjectIdentity(projectPath);
  return { ...identity, revision: computeBoundProjectRevision(identity.path) };
}

export function sameEnrichmentBinding(left: EnrichmentBinding, right: EnrichmentBinding): boolean {
  return left.path === right.path
    && left.identity === right.identity
    && left.generation === right.generation
    && left.revision === right.revision;
}

export function computeBoundProjectRevision(projectPath: string): string {
  const required = ["wren_project.yml", path.join("target", "mdl.json")];
  const hash = createHash("sha256");
  for (const relative of required) {
    const file = path.join(projectPath, relative);
    if (!existsSync(file)) throw new EnrichmentContractError("bound project is not built; compile and bind before enriching context");
    hash.update(relative);
    hash.update(readFileSync(file));
  }
  return `sha256:${hash.digest("hex")}`;
}

// Sink paths are project-relative to the bound Wren project root. These must match the real
// project file layout this codebase already uses everywhere else (see server/context-files.ts:
// `models/<name>/metadata.yml`, `views/<name>/metadata.yml`, `cubes/<name>/metadata.yml`, a single
// top-level `relationships.yml`) and, for knowledge, the layout `wren context init` actually
// creates on disk (core/wren's `_KNOWLEDGE_SUBDIRS` skeleton: `knowledge/knowledge.yml` plus a
// `knowledge/{rules,glossary,metrics,caveats,sql}/` subdirectory per category — never a flat
// `knowledge/<file>.md`). A previous edit here fixed a `mdl/`-prefixed shape that could never
// match a real sink, and introduced this flat `knowledge/*.md` shape in the same breath — which
// is exactly as unreal: it accepts a path the real layout never produces (`knowledge/general.md`)
// and rejects the one every project ships with (`knowledge/rules/general.md`). See
// `test/enrichment-sink-real-layout.test.ts`, which checks these patterns against a project a
// real `wren context init` produced, not a hand-written string, so this cannot drift again
// unnoticed.
const KNOWLEDGE_CATEGORIES = ["rules", "glossary", "metrics", "caveats", "sql"] as const;
const SINKS: Record<EnrichmentChangeKind, RegExp> = { knowledge_append: new RegExp(`^knowledge/(?:${KNOWLEDGE_CATEGORIES.join("|")})/[a-z0-9_-]+\\.md$`, "i"), new_cube: /^cubes\/[a-z0-9_-]+\/metadata\.yml$/, new_view: /^views\/[a-z0-9_-]+\/metadata\.yml$/, new_relationship: /^relationships\.yml$/, mdl_metric: /^models\/[a-z0-9_-]+\/metadata\.yml$/, description_append: /^models\/[a-z0-9_-]+\/metadata\.yml$/, calculated_column: /^models\/[a-z0-9_-]+\/metadata\.yml$/, conflict: /^(?:models|views|cubes|knowledge)\/|^relationships\.yml$/, ambiguous: /^(?:models|views|cubes|knowledge)\/|^relationships\.yml$/ };
const FILE_SINK_KINDS: readonly EnrichmentChangeKind[] = ["knowledge_append", "description_append", "new_cube", "new_view", "new_relationship", "mdl_metric", "calculated_column"];
/** True when `sink` is a file an applicable (non conflict/ambiguous) enrichment change may write. The host re-checks this before materializing. */
export function isEnrichmentSink(sink: string): boolean { return FILE_SINK_KINDS.some((kind) => SINKS[kind].test(sink)); }
function riskFor(kind: EnrichmentChangeKind): EnrichmentRisk { if (kind === "conflict") return "conflict"; if (kind === "ambiguous") return "ambiguous"; return kind === "knowledge_append" ? "low" : "high"; }

const MAX_OPERATIONS = 20;
const MAX_SUMMARY_LENGTH = 512;
const MAX_DRAFT_LENGTH = 4096;
const DISPLAY_SECRET = /\b(?:api[_ -]?key|access[_ -]?key|password|secret|token|authorization|bearer)\b\s*[:=]\s*[^\s,;]+|\b(?:sk|sess)_[A-Za-z0-9_-]+/gi;
const DISPLAY_INTERNAL = /(?:\/Users\/|\/home\/|[A-Za-z]:\\\\)[^\s,;]+|\b(?:resume[_ -]?session(?:[_ -]?id)?|sdk[_ -]?session(?:[_ -]?id)?|session[_ -]?id|provider|model|prompt)\b\s*[:=]\s*[^\s,;]+|\b(?:openai|anthropic|gemini|claude|codex)\b/gi;

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/**
 * Names which check failed so a future occurrence is diagnosable without
 * reading this source \u2014 but never echoes `value` itself: a value failing
 * exactly because it's a raw path or credential is the one case the
 * `DISPLAY_INTERNAL`/`DISPLAY_SECRET` redaction below exists to strip, so
 * putting it back into the message would defeat that redaction.
 */
function display(value: unknown, maxLength: number, field: string): string {
  if (typeof value !== "string") throw new EnrichmentContractError(`enrichment operation's ${field} must be a string`);
  if (value.length === 0) throw new EnrichmentContractError(`enrichment operation's ${field} is empty`);
  if (value.length > maxLength) throw new EnrichmentContractError(`enrichment operation's ${field} exceeds the ${maxLength}-character limit`);
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) throw new EnrichmentContractError(`enrichment operation's ${field} contains control characters`);
  const redacted = value.replace(DISPLAY_SECRET, "[REDACTED]").replace(DISPLAY_INTERNAL, "[REDACTED]").trim();
  if (redacted.length === 0) throw new EnrichmentContractError(`enrichment operation's ${field} was empty after redaction`);
  return redacted;
}

/**
 * Converts untrusted model confidence into bounded UI text without making it
 * an operation-validity gate. Unsafe, missing, or structured values become a
 * neutral label instead of costing an otherwise valid proposal.
 */
export function normalizeEnrichmentConfidence(value: unknown): string {
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "Not provided";
  if (typeof value !== "string") return "Not provided";
  try {
    const label = display(value, 64, "confidence");
    return label.includes("[REDACTED]") ? "Not provided" : label;
  } catch {
    return "Not provided";
  }
}

export function hashEnrichmentOperation(operation: Pick<EnrichmentOperation, "id" | "sink" | "risk" | "summary" | "draft" | "changeKind">): string {
  // Confidence is model-authored display text, so it must not change the
  // approval-bound identity of an otherwise identical operation.
  return `sha256:${createHash("sha256").update(JSON.stringify([operation.id, operation.sink, operation.risk, operation.changeKind, operation.summary, operation.draft])).digest("hex")}`;
}

const DIAGNOSTIC_FIELDS = ["sink", "changeKind", "summary", "draft", "confidence", "id", "hash", "risk"] as const;
const KNOWN_KINDS = ["knowledge_append", "description_append", "new_cube", "new_view", "new_relationship", "mdl_metric", "calculated_column", "conflict", "ambiguous"] as const;
/** Likely model inventions, matched exactly (lowercased) so a hostile string can only ever map to `other`. */
const LIKELY_KINDS = ["description", "column_description", "description_update", "description_add", "model_description", "add_description", "metadata", "mdl_description", "mdl_column", "new_column", "column", "model", "metric",
  "relationship", "cube", "view", "knowledge", "append", "update", "edit", "add", "mdl_update", "mdl_append"] as const;
const bucket = (length: number): string => length === 0 ? "0" : length <= 16 ? "1-16" : length <= 32 ? "17-32" : length <= 64 ? "33-64" : "65+";
/** Maps a refused draft onto fixed vocabularies only: present field names, the kind through an allowlist (else `other`), length buckets and a sink class. */
export function diagnoseProposalDraft(draft: unknown): ProposalDiagnostic {
  const operations = record(draft) && Array.isArray((draft as { operations?: unknown }).operations) ? (draft as { operations: unknown[] }).operations : [];
  return { operations: Math.min(operations.length, 1000), items: operations.slice(0, MAX_OPERATIONS).map((raw) => {
    const operation = record(raw) ?? {};
    const kind = operation.changeKind;
    const lowered = typeof kind === "string" ? kind.toLowerCase() : "";
    const sink = typeof operation.sink === "string" ? operation.sink : "";
    return { fields: DIAGNOSTIC_FIELDS.filter((field) => operation[field] !== undefined),
      kind: kind === undefined ? "missing" : typeof kind !== "string" ? "non_string" : (KNOWN_KINDS as readonly string[]).includes(kind) ? kind : (LIKELY_KINDS as readonly string[]).includes(lowered) ? lowered : "other",
      kind_length: typeof kind === "string" ? bucket(kind.length) : "0",
      sink: !sink ? "missing" : /\.\.|^\//.test(sink) ? "traversal" : /^knowledge\//.test(sink) ? "knowledge" : /^models\//.test(sink) ? "models" : /^views\//.test(sink) ? "views" : /^cubes\//.test(sink) ? "cubes" : sink === "relationships.yml" ? "relationships" : "other" };
  }) };
}
/** True when `sink` is the file shape this change kind is allowed to write. */
export function sinkMatchesKind(kind: EnrichmentChangeKind, sink: string): boolean { return Object.hasOwn(SINKS, kind) && SINKS[kind].test(sink); }

export function canonicalizeProposal(draft: unknown, revision: string): EnrichmentProposal {
  try { return canonicalizeProposalUnchecked(draft, revision); }
  catch (error) { if (error instanceof EnrichmentContractError && !error.diagnostic) error.diagnostic = diagnoseProposalDraft(draft); throw error; }
}
function canonicalizeProposalUnchecked(draft: unknown, revision: string): EnrichmentProposal {
  const input = record(draft);
  if (!input || !Array.isArray(input.operations)) throw new EnrichmentContractError("enrichment proposal must be an object with an operations array");
  if (input.operations.length === 0) throw new EnrichmentContractError("enrichment proposal has no operations");
  if (input.operations.length > MAX_OPERATIONS) throw new EnrichmentContractError(`enrichment proposal exceeds the ${MAX_OPERATIONS}-operation limit`);
  const ids = new Set<string>();
  const operations = input.operations.map((rawOperation) => {
    const operation = record(rawOperation);
    if (!operation) throw new EnrichmentContractError("enrichment operation must be an object");
    if (typeof operation.changeKind !== "string" || !Object.prototype.hasOwnProperty.call(SINKS, operation.changeKind)) {
      throw new EnrichmentContractError("enrichment operation has an unknown changeKind");
    }
    if (typeof operation.sink !== "string" || operation.sink.length === 0 || operation.sink.length > 160) {
      throw new EnrichmentContractError("enrichment operation's sink is missing, empty, or exceeds the 160-character limit");
    }
    if (!SINKS[operation.changeKind as EnrichmentChangeKind].test(operation.sink)) {
      throw new EnrichmentContractError(`enrichment operation's sink does not match the required layout for changeKind "${operation.changeKind}"`);
    }
    const summary = display(operation.summary, MAX_SUMMARY_LENGTH, "summary");
    const operationDraft = display(operation.draft, MAX_DRAFT_LENGTH, "draft");
    const changeKind = operation.changeKind as EnrichmentChangeKind;
    const confidence = normalizeEnrichmentConfidence(operation.confidence);
    const id = `op-${createHash("sha256").update(JSON.stringify([operation.sink, changeKind, summary, operationDraft])).digest("hex").slice(0, 24)}`;
    if (ids.has(id)) throw new EnrichmentContractError("runtime returned duplicate enrichment operations"); ids.add(id);
    return { id, sink: operation.sink, changeKind, risk: riskFor(changeKind), summary, draft: operationDraft, confidence };
  });
  const authoritativeOperations = operations.map(({ id, sink, risk, summary, draft: operationDraft, changeKind }) => ({ id, sink, risk, summary, draft: operationDraft, changeKind }));
  const hash = `sha256:${createHash("sha256").update(JSON.stringify({ revision, operations: authoritativeOperations })).digest("hex")}`;
  return { id: `proposal-${hash.slice(7, 31)}`, hash, projectRevision: revision, operations };
}

export function requiresApproval(mode: EnrichmentMode, risk: EnrichmentRisk): boolean {
  return risk !== "low" || mode === "grill";
}

/**
 * The host-mediated MCP tool a native `context_enrichment` session uses to
 * hand a drafted proposal to the host. The agent never writes into the bound
 * project directly: this tool only carries the proposal *document* through
 * to the same canonicalize -> shadow-verify -> finalize pipeline `POST
 * /api/context/enrichment/start` already uses (see `server/app.ts`'s
 * `settleEnrichmentDraft`). The schema below is deliberately permissive --
 * `canonicalizeProposal` above is the single source of truth for shape and
 * content validation, so this schema must not duplicate or drift from it.
 */
export const NATIVE_ENRICHMENT_SUBMIT_MCP_TOOL_NAME = "submit_context_proposal";

export const NATIVE_ENRICHMENT_SUBMIT_INPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["operations"],
  properties: {
    operations: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["sink", "changeKind", "summary", "draft"],
        properties: {
          sink: { type: "string" },
          changeKind: { enum: ["knowledge_append", "new_cube", "new_view", "new_relationship", "mdl_metric", "calculated_column", "conflict", "ambiguous"] },
          summary: { type: "string" },
          draft: { type: "string" },
          confidence: {},
        },
      },
    },
  },
} as const;
