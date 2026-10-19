/**
 * Real (non-mock) `EnrichmentRunner` implementation for the draft path.
 *
 * Dispatches warble's `genbi-enrich-context` profile — `inspect_context`
 * then `draft_enrichment` — via dispatched (the Claude Agent SDK dispatcher),
 * one subprocess per component. `warble-agent-sdk chat` is a single
 * line-per-turn stdin protocol (see `harness/route/dispatched.ts`'s
 * `spawnChat`/`buildAgentSdkChatArgs`), so a two-component flow is two
 * separate dispatches: this module folds turn 1's finalText into turn 2's
 * composed question itself — there is no SDK-level session chaining that
 * could do this for us within one `draft()` call.
 *
 * Translation, not policy. `server/enrichment.ts`'s `canonicalizeProposal`
 * is the only place a draft becomes a trusted `EnrichmentProposal`: it
 * ignores any `id`/`hash`/`projectRevision`/`risk` the model supplies and
 * independently recomputes them. This module's `translateDraftTerminal`
 * adds a second, independent layer of the same discipline by construction:
 * it copies over only five named fields (`sink`, `changeKind`, `summary`,
 * `draft`, `confidence`) from the model's parsed JSON, so a forged
 * `hash`/`id`/`risk`/`projectRevision` the model includes never even
 * reaches `canonicalizeProposal` in the first place.
 *
 * Vocabulary seam: warble's `draft_enrichment` component (steps/draft.md)
 * only ever describes the operation envelope in prose — `relative_sink`,
 * `recommended_yaml`, confidence/evidence — and is silent on a literal
 * `changeKind`/`summary` field, because those are GenBI-host vocabulary
 * (`EnrichmentChangeKind`), not something warble's own contract shares with
 * the model. `composeDraftPrompt` below is where that gap is closed: it
 * layers an additional host-owned instruction on top of the dispatched
 * component's own step prompt, exactly the way `server/compose.ts`'s
 * `composeSetupPrompt` layers its own `SETUP_STATUS: ok|needs_input|error`
 * terminal convention on top of `connect_source`, "since warble's
 * `connect_source` component carries no terminal-status convention of its
 * own." Neither wrapper prompt edits or contradicts the dispatched
 * component's own instructions.
 */
import type { AgentEvent, AuthChoice } from "../harness/index.js";
import { resolveDefaultEnrichIrPath, runDispatchedDefault } from "../harness/index.js";
import { sinkInRuntimeScope, validPath } from "./enrichment-candidate.js";
import { EnrichmentContractError, isEnrichmentSink, sinkMatchesKind, type EnrichmentMode, type EnrichmentRunner, type EnrichmentRunnerReadiness } from "./enrichment.js";

/**
 * The one live refusal condition `readiness()` and `defaultDispatch` share --
 * this dispatch path only ever talks to Claude via dispatched, so anything else
 * is a refusal, not a routing choice. Kept as a single function so the two
 * call sites (the readiness check below, and `defaultDispatch`'s own guard)
 * can never drift apart from each other; the reason code is also exactly
 * what `readiness()` hands to the host route, which forwards it verbatim.
 */
const REQUIRES_CLAUDE_SUBSCRIPTION = "requires_claude_subscription";

/**
 * A type guard (not just a boolean) so `defaultDispatch`'s own guard clause
 * keeps narrowing `authChoice` to what `runDispatchedDefault` requires -- the
 * single source of truth `draftAuthReadiness` and `defaultDispatch` both
 * call, so the two can never drift apart.
 */
function isClaudeSubscriptionAuth(authChoice: AuthChoice): authChoice is AuthChoice & { mode: "subscription"; provider: "claude" } {
  return authChoice.mode === "subscription" && authChoice.provider === "claude";
}

function draftAuthReadiness(authChoice: AuthChoice): EnrichmentRunnerReadiness {
  return isClaudeSubscriptionAuth(authChoice) ? { available: true } : { available: false, reason: REQUIRES_CLAUDE_SUBSCRIPTION };
}

export const INSPECT_CONTEXT_AGENT_ID = "inspect_context";
export const DRAFT_ENRICHMENT_AGENT_ID = "draft_enrichment";

/** One dispatched turn: an `agentId` (warble component) + composed `question`, against a bound project. */
export interface EnrichmentDispatchInput {
  readonly agentId: string;
  readonly question: string;
  readonly userProject: string;
}
export interface EnrichmentDispatchResult {
  readonly finalText: string;
}
/** Test-only seam: replaces the two real dispatched subprocess dispatches. Never set in production. */
export type EnrichmentDispatch = (input: EnrichmentDispatchInput) => Promise<EnrichmentDispatchResult>;

export interface DispatchedEnrichmentDraftRunnerOptions {
  /**
   * Live auth-choice read, not a value frozen at construction. `EnrichmentRunner.draft()`
   * (`server/enrichment.ts`) takes no `authChoice` parameter of its own — unlike
   * `SetupStepRunner.run()`, which does — so this is this module's own seam for staying current
   * with a later `PUT /api/config/runtime` rebind (`server/turn.ts`'s `TurnDeps.getAuthChoice`)
   * instead of dispatching every future draft call against whatever auth choice happened to be
   * active when `server/bin.ts` constructed this runner at boot.
   */
  readonly getAuthChoice: () => AuthChoice;
  /** Defaults to `resolveDefaultEnrichIrPath()` (the committed `profiles/genbi-enrich-context/ir.golden.json`). */
  readonly irPath?: string;
  readonly warbleBin?: string;
  readonly agentSdkBin?: string;
  readonly outDir?: string;
  /**
   * Mirrors `DispatchedSetupRunnerOptions.getModelsConfig` — a live read, not a value frozen at
   * construction, so a later `PUT /api/config/runtime` rebind is picked up by the next draft
   * call instead of requiring a process restart.
   */
  /**
   * Directory of the genbi-enrich-context profile. When set, the draft is
   * Dispatched from an IR compiled against the bound project — which is the
   * only way the agent's injected context describes the project it is about to
   * propose changes to.
   *
   * Without it the runner falls back to `irPath`, a prebuilt IR. That is how
   * this ran until now, and the prebuilt IR available to it was the profile's
   * eval golden: the profile compiled against warble's own example project,
   * with jaffle-shop's models baked into `context_binding.resolved`. A live
   * draft duly analysed gaps in someone else's schema.
   */
  readonly profileSource?: string;
  readonly getModelsConfig?: () => string | undefined;
  readonly chatTimeoutMs?: number;
  readonly maxTurns?: number;
  readonly onEvent?: (event: AgentEvent) => void;
  /** Test-only seam. See `EnrichmentDispatch`. Never set in production wiring (`server/bin.ts`). */
  readonly dispatch?: EnrichmentDispatch;
}

/**
 * Which profile input `runDispatchedDefault` is given, and whether it is allowed to
 * skip compilation.
 *
 * Passing `irPath` short-circuits `compileProfile`, which is how a prebuilt
 * golden — the profile compiled against warble's own example project — used to
 * reach the agent. With a profile source we want the opposite: compile, so the
 * Dispatched IR's context is the bound project's.
 *
 * Exported because that branch is the whole point of the fix and is otherwise
 * only reachable through a real dispatch.
 */
export function draftProfileInput(profileSource: string | undefined, irPath: string): { profileSource: string; irPath?: string } {
  return profileSource === undefined ? { profileSource: irPath, irPath } : { profileSource };
}

function defaultDispatch(options: DispatchedEnrichmentDraftRunnerOptions): EnrichmentDispatch {
  return async ({ agentId, question, userProject }) => {
    const irPath = options.irPath ?? resolveDefaultEnrichIrPath();
    if (irPath === undefined) {
      throw new EnrichmentContractError(
        "no genbi-enrich-context IR found (searched ancestors for a sibling warble checkout); " +
          "pass an explicit irPath or check out warble as a sibling repo",
      );
    }
    const authChoice = options.getAuthChoice();
    if (!isClaudeSubscriptionAuth(authChoice)) {
      throw new EnrichmentContractError(
        `enrichment draft dispatch requires Claude subscription auth, got mode "${authChoice.mode}"` +
          (authChoice.mode === "subscription" ? ` provider "${authChoice.provider}"` : ""),
      );
    }
    const modelsConfig = options.getModelsConfig?.();
    const result = await runDispatchedDefault({
      authChoice,
      ...draftProfileInput(options.profileSource, irPath),
      userProject,
      question,
      agentId,
      ...(options.warbleBin !== undefined ? { warbleBin: options.warbleBin } : {}),
      ...(options.agentSdkBin !== undefined ? { agentSdkBin: options.agentSdkBin } : {}),
      ...(options.outDir !== undefined ? { outDir: options.outDir } : {}),
      ...(modelsConfig !== undefined ? { modelsConfig } : {}),
      ...(options.chatTimeoutMs !== undefined ? { chatTimeoutMs: options.chatTimeoutMs } : {}),
      ...(options.maxTurns !== undefined ? { maxTurns: options.maxTurns } : {}),
      ...(options.onEvent !== undefined ? { onEvent: options.onEvent } : {}),
    });
    return { finalText: result.finalText };
  };
}

/**
 * `inspect_context` has no formal params and no dynamic per-run content to
 * restate (unlike Setup's `connect`/`context` steps, which restate a
 * project name / source type the warble component has no other way to
 * learn). The only thing this run-specific wrapper needs to convey is the
 * mode, because `steps/inspect.md` itself makes probe permission mode
 * dependent ("In grill mode, live database probes are allowed only after
 * the host records the user's one-time consent; in autopilot they are
 * forbidden"). This host does not yet implement a consent-recording
 * mechanism, so it must say so honestly rather than silently imply consent
 * was granted — asserting an unrecorded consent is exactly the kind of
 * disprovable claim this codebase has been burned by before.
 */
export function composeInspectPrompt(mode: EnrichmentMode): string {
  const probeRule =
    mode === "grill"
      ? "No one-time database-probe consent has been recorded for this run, so do not perform any live database probe — rely only on already-materialized MDL, cube, knowledge, and NL-to-SQL content."
      : "Autopilot mode: live database probes are forbidden — rely only on already-materialized MDL, cube, knowledge, and NL-to-SQL content.";
  return `Begin the enrichment inventory now. Run mode is "${mode}". ${probeRule} Produce the enrichment_gaps inventory exactly as instructed.`;
}

/**
 * Layers two host-owned requirements on top of `draft_enrichment`'s own
 * `steps/draft.md` instructions, which never contradict: (1) the pinned
 * project revision this run is locked to, restated so the model treats it
 * as input rather than inferring one of its own (draft.md already demands
 * this, this just supplies the concrete value); (2) a `changeKind` and a
 * `summary` field on every operation — vocabulary the host's own
 * `EnrichmentChangeKind` type needs to classify and route the sink, that
 * warble's component prose never names. Everything else (field names for
 * the sink/body themselves, the single-operation-plus-decision shape for
 * grill, the cube schema, the append-only/no-overwrite rules) is exactly
 * what draft.md already tells the model — restating it here would be
 * redundant, not additive.
 */
export const OPENSHELL_CHANGE_KINDS = ["knowledge_append", "description_append", "new_relationship"] as const;
export const OPENSHELL_DRAFT_NOTE =
  "This project runs under a restricted runtime. You may only extend files that already exist in the project; never propose a file that does not exist yet, " +
  "and never add new columns, cubes, views or calculated columns. Every operation MUST carry a \"changeKind\", and it must be exactly one of: knowledge_append, description_append, new_relationship. " +
  "knowledge_append: \"recommended_yaml\" is only the text to add at the end of the named existing knowledge file; the host appends it. " +
  "description_append: \"recommended_yaml\" is only the descriptions to add to the named existing model metadata file (models/<name>/metadata.yml), never the file itself: a YAML mapping with an optional \"description\" (the model) and an optional \"columns\" mapping of column name to description, " +
  "no other keys, every description a double-quoted single-line string of at most 500 characters, and every column name exactly as it appears in the file; the host merges them into the file and refuses a column the file does not have. " +
  "new_relationship: add entries to the existing relationships.yml and return the complete updated file.";

/** Existing project files an OpenShell draft may extend, by the change kind each permits. Host-derived, project-relative, sorted. */
export interface EditableFiles {
  readonly knowledge: readonly string[];
  readonly metadata: readonly string[];
  readonly relationships: readonly string[];
}
const MAX_EDITABLE_FILES = 50;
const MAX_EDITABLE_CHARS = 4_000;

/**
 * Selects the editable existing files from the host's approved snapshot file list with the same predicates the candidate check uses
 * (`validPath`, `isEnrichmentSink`, `sinkInRuntimeScope`, `sinkMatchesKind`). Never derived from model output or gap text.
 */
export function selectEditableFiles(approvedFiles: readonly string[]): EditableFiles {
  const knowledge: string[] = [], metadata: string[] = [], relationships: string[] = [];
  let chars = 0, count = 0;
  for (const file of [...new Set(approvedFiles)].sort()) {
    if (count >= MAX_EDITABLE_FILES) break;
    if (!validPath(file) || !isEnrichmentSink(file) || !sinkInRuntimeScope(file)) continue;
    const bucket = sinkMatchesKind("knowledge_append", file) ? knowledge : sinkMatchesKind("description_append", file) ? metadata : sinkMatchesKind("new_relationship", file) ? relationships : undefined;
    if (!bucket) continue;
    chars += JSON.stringify(file).length + 2;
    if (chars > MAX_EDITABLE_CHARS) break;
    bucket.push(file); count += 1;
  }
  return { knowledge, metadata, relationships };
}
export const hasEditableFiles = (files: EditableFiles): boolean => files.knowledge.length + files.metadata.length > 0 || files.relationships.length > 0;

/** The example `description_append` payload; `amount_minor` is a neutral placeholder the model must replace with a column name from the file. */
export const DESCRIPTION_EXAMPLE_PAYLOAD = "description: \"One row per order.\"\ncolumns:\n  amount_minor: \"Order amount in minor units.\"\n";
function openShellExample(files: EditableFiles): string {
  const operation = files.knowledge.length > 0
    ? { changeKind: "knowledge_append", relative_sink: files.knowledge[0], summary: "Document revenue", recommended_yaml: "Revenue is net of refunds." }
    : { changeKind: "description_append", relative_sink: files.metadata[0] ?? files.relationships[0], summary: "Describe the model", recommended_yaml: DESCRIPTION_EXAMPLE_PAYLOAD };
  return JSON.stringify({ enrichment_proposal: { operation } });
}
function openShellEditableNote(files: EditableFiles): string {
  const list = (label: string, entries: readonly string[]) => entries.length > 0 ? ` ${label}: ${JSON.stringify(entries)}.` : "";
  return "The only files you may extend are these existing files; \"relative_sink\" must be exactly one of the listed paths, and each path only permits the kind named for it." +
    list("knowledge_append", files.knowledge) + list("description_append", files.metadata) + list("new_relationship", files.relationships) +
    ` Return exactly one operation, in this exact final shape (this example is ${files.knowledge.length > 0 ? "knowledge_append" : "description_append"}): ${openShellExample(files)}.`;
}

export function composeDraftPrompt(mode: EnrichmentMode, projectRevision: string, gapInventory: string, options: { readonly runtime?: "openshell"; readonly editableFiles?: EditableFiles } = {}): string {
  const openShell = options.runtime === "openshell";
  const changeKinds = openShell ? OPENSHELL_CHANGE_KINDS.join(", ") : "knowledge_append, new_cube, new_view, new_relationship, mdl_metric, calculated_column, conflict, ambiguous";
  return (
    `Draft the enrichment proposal now for project revision "${projectRevision}", run mode "${mode}". ` +
    `In addition to the fields your own instructions already describe, every operation object must also carry ` +
    `a "changeKind" field set to exactly one of: ${changeKinds}; and a "summary" field: a short, one-line, ` +
    `human-readable description of the change with no raw excerpts or credentials. Do not invent or claim a ` +
    `hash, digest, id, or risk label for any operation — the host computes and independently verifies all of ` +
    `those and will discard any you include. ${openShell ? `${OPENSHELL_DRAFT_NOTE} ${openShellEditableNote(options.editableFiles ?? { knowledge: [], metadata: [], relationships: [] })} ` : ""}Gap inventory from the inspection step:\n${gapInventory}`
  );
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/**
 * Parses the model's bare-JSON final message. draft.md's instruction is
 * unambiguous ("Your FINAL message must be one JSON object only. Do not
 * include prose or Markdown fences"), and the compiled golden the runtime
 * actually dispatches matches it byte for byte -- so a fenced terminal is
 * model variance, not prompt drift, and the durable fix is host-side
 * tolerance, not a prompt rewrite (see
 * `test/draft-enrichment-fenced-terminal.integration.test.ts`, pinned
 * against a real recorded run whose terminal was prose followed by a
 * ```json fenced block).
 *
 * The fence match is intentionally NOT anchored to the whole trimmed
 * string, so a fence preceded (or followed) by prose is tolerated the same
 * as a bare fence or no fence at all. This duplicates the fence-matching
 * approach `harness/render/envelope.ts`'s `extractJsonObjectText` already
 * uses for the unrelated answer-rendering path, rather than importing that
 * function directly: it is private to that module, and its extra
 * brace-scanning fallback (for free-form, unfenced prose) is machinery this
 * caller doesn't need -- a bare JSON terminal here already round-trips
 * through `JSON.parse` below with no fence at all.
 */
export function parseDraftTerminalJson(finalText: string): unknown {
  let text = finalText.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)\s*```/.exec(text);
  if (fenced?.[1] !== undefined) text = fenced[1].trim();
  try {
    return JSON.parse(text);
  } catch {
    throw new EnrichmentContractError("draft turn did not return a parseable JSON terminal");
  }
}

/**
 * Normalizes warble's model-facing terminal shape (`{ enrichment_proposal:
 * {...} }`, a single operation directly under `enrichment_proposal` for
 * grill per draft.md's spec, or an `operations` array for a multi-operation
 * flow) into the shape `canonicalizeProposal` (server/enrichment.ts)
 * accepts: `{ operations: [{ sink, changeKind, summary, draft, confidence
 * }] }`. Copies over ONLY those five fields, by name, from whichever of the
 * model's own field names (`relative_sink`/`recommended_yaml`, this
 * module's added `changeKind`/`summary`) or the host's own names
 * (`sink`/`draft`) the model actually used — so a forged `hash`, `id`,
 * `projectRevision`, or `risk` the model includes anywhere in its JSON is
 * silently dropped here and never reaches `canonicalizeProposal` at all.
 */
export function translateDraftTerminal(finalText: string): unknown {
  const parsed = parseDraftTerminalJson(finalText);
  const root = record(parsed);
  const proposal = root ? record(root["enrichment_proposal"]) : undefined;
  if (!proposal) throw new EnrichmentContractError("draft turn's terminal did not contain an enrichment_proposal object");
  const singular = Object.hasOwn(proposal, "operation"), plural = Object.hasOwn(proposal, "operations");
  if (singular && plural) throw new EnrichmentContractError("draft turn's enrichment_proposal named both operation and operations");
  let rawOperations: readonly unknown[];
  if (singular) {
    const only = record(proposal["operation"]);
    if (!only) throw new EnrichmentContractError("draft turn's enrichment_proposal operation was not an object");
    rawOperations = [only];
  } else rawOperations = Array.isArray(proposal["operations"]) ? (proposal["operations"] as readonly unknown[]) : [proposal];
  const operations = rawOperations.map((rawOperation) => {
    const op = record(rawOperation) ?? {};
    return {
      sink: op["sink"] ?? op["relative_sink"],
      changeKind: op["changeKind"] ?? op["change_kind"],
      summary: op["summary"],
      draft: op["draft"] ?? op["recommended_yaml"],
      confidence: op["confidence"],
    };
  });
  return { operations };
}

const SHAPE_KEYS = ["operation", "operations", "relative_sink", "sink", "recommended_yaml", "draft", "changeKind", "change_kind", "summary", "confidence", "decision", "decisions", "project_revision", "projectRevision",
  "impact", "requires_approval", "autopilot_eligible", "evidence", "evidence_locators", "hash", "id", "risk"] as const;
const closedKeys = (value: Record<string, unknown>) => { const names = Object.keys(value); return { keys: SHAPE_KEYS.filter((key) => Object.hasOwn(value, key)), other: Math.min(99, names.filter((name) => !(SHAPE_KEYS as readonly string[]).includes(name)).length) }; };
/** Closed-vocabulary description of a draft terminal's structure for a refusal log: allowlisted key names and an `other` count, never values. */
export function describeDraftShape(finalText: string): { readonly proposal?: ReturnType<typeof closedKeys>; readonly operations: readonly ReturnType<typeof closedKeys>[] } {
  let parsed: unknown;
  try { parsed = parseDraftTerminalJson(finalText); } catch { return { operations: [] }; }
  const root = record(parsed); const proposal = root ? record(root["enrichment_proposal"]) : undefined;
  if (!proposal) return { operations: [] };
  const candidates = Array.isArray(proposal["operations"]) ? (proposal["operations"] as unknown[]) : proposal["operation"] !== undefined ? [proposal["operation"]] : [proposal];
  return { proposal: closedKeys(proposal), operations: candidates.slice(0, 20).map((candidate) => closedKeys(record(candidate) ?? {})) };
}

/**
 * Builds the real, production `EnrichmentRunner.draft()`: two dispatched
 * dispatches (`inspect_context` then `draft_enrichment`) against the bound
 * project, folding turn 1's output into turn 2's composed question, then
 * translating the terminal into the shape the host's own
 * `canonicalizeProposal` independently validates and hashes. Returns
 * `unknown`, exactly like the interface requires — this function never
 * calls `canonicalizeProposal` itself; that stays the caller's (the `/api/
 * context/enrichment/*` route's) job, same as every mock runner in
 * `test/bff-enrichment.test.ts`.
 */
export function createDispatchedEnrichmentDraftRunner(options: DispatchedEnrichmentDraftRunnerOptions): EnrichmentRunner {
  const dispatch = options.dispatch ?? defaultDispatch(options);
  return {
    async draft(input): Promise<unknown> {
      const inspectResult = await dispatch({
        agentId: INSPECT_CONTEXT_AGENT_ID,
        question: composeInspectPrompt(input.mode),
        userProject: input.projectPath,
      });
      const draftResult = await dispatch({
        agentId: DRAFT_ENRICHMENT_AGENT_ID,
        question: composeDraftPrompt(input.mode, input.projectRevision, inspectResult.finalText),
        userProject: input.projectPath,
      });
      return translateDraftTerminal(draftResult.finalText);
    },
    // Pure read of the live auth choice -- no dispatch, no cost, no side effect.
    readiness(): EnrichmentRunnerReadiness {
      return draftAuthReadiness(options.getAuthChoice());
    },
  };
}
