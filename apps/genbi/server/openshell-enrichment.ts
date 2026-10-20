import { isDeepStrictEqual } from "node:util";
import type { ComponentInvocationResult } from "@warble/claude-agent-sdk";
import { observeStructured, observeStructuredAsync, type StructuredDiagnosticObserver } from "./structured-diagnostics.js";
import { canonicalizeProposal, EnrichmentContractError } from "./enrichment.js";
import { composeDraftPrompt, hasEditableFiles, selectEditableFiles, composeInspectPrompt, describeDraftShape, translateDraftTerminal } from "./enrichment-runner.js";
import type { OpenShellPreparedHost, OpenShellStructuredProvisioner } from "./openshell-structured-ask.js";
import { StructuredRuntimeError, type EnrichOptions, type EnrichResult, type StructuredScope } from "./structured-runtime.js";
import { RUNTIME_BUDGETS_MS } from "../harness/runtime-budgets.js";

type RootResult = Extract<ComponentInvocationResult, { status: "ok" }>;
const results = new WeakMap<object, { readonly snapshot: EnrichResult; assertCurrent(): void }>();
/** The gap inventory is folded into the draft request, which has its own byte cap; keep it well under that. */
const MAX_GAP_INVENTORY_CHARS = 24_000;
/** Two governed stages (inspect, then draft), each bounded by its own component timeout. */
const STAGES = 2;

/** The one declared capability the OpenShell enrichment realization has no tool for: a repository/raw-material Read. */
const UNREALIZED_CAPABILITIES: ReadonlySet<string> = new Set(["raw_material_read"]);
const ENRICHMENT_STAGE_IDS: ReadonlySet<string> = new Set(["inspect_context", "draft_enrichment"]);

/**
 * The IR the OpenShell enrichment stages are produced from: the compiled profile minus what the sandbox cannot realize.
 * Strictly subtractive and limited to the two stage components: the raw-material Read capability is dropped (the stage
 * sees the captured host context and governed `inspect` only) and the declared render blocks are emptied (the proposal
 * is typed by the host, not by a render contract). Nothing is added, so no stage gains authority; any other capability
 * the pinned producer cannot realize still wall-hits.
 */
export function deriveOpenShellEnrichmentIr(document: string): string {
  const ir = JSON.parse(document) as { components?: unknown };
  if (!Array.isArray(ir.components)) throw new StructuredRuntimeError("unsupported");
  for (const node of ir.components as { id?: unknown; required_capabilities?: unknown; effect?: { render_blocks?: unknown } }[]) {
    if (typeof node.id !== "string" || !ENRICHMENT_STAGE_IDS.has(node.id)) continue;
    if (Array.isArray(node.required_capabilities)) node.required_capabilities = node.required_capabilities.filter((capability) => !UNREALIZED_CAPABILITIES.has(String(capability)));
    if (node.effect && Array.isArray(node.effect.render_blocks)) node.effect.render_blocks = [];
  }
  return JSON.stringify(ir);
}

/** Only a proposal collected through the broker `propose` grant, after the runner has settled, may reach the ledger. */
export function readOpenShellEnrichmentResult(result: EnrichResult): EnrichResult {
  const proof = results.get(result);
  if (!proof || !isDeepStrictEqual(result, proof.snapshot)) throw new StructuredRuntimeError("failed");
  proof.assertCurrent();
  return structuredClone(proof.snapshot);
}

const text = (value: unknown): string => typeof value === "string" ? value : JSON.stringify(value);
function rootValue(result: ComponentInvocationResult): unknown {
  if (result.status !== "ok" || result.output.kind !== "value") throw new StructuredRuntimeError("failed");
  return result.output.value;
}

/**
 * One server-selected enrichment draft: `inspect_context`, then `draft_enrichment`, each a governed component root
 * with model steps in the model sandbox and data reads through the governed Wren worker. The only write output is
 * the proposal the broker's `propose` grant hands to the sink below; nothing is written to the project.
 */
export async function runOpenShellEnrichment(provisioner: OpenShellStructuredProvisioner, options: EnrichOptions, scope: StructuredScope, diagnostics?: StructuredDiagnosticObserver): Promise<EnrichResult> {
  const prepareEnrichment = provisioner.prepareEnrichment;
  observeStructured(diagnostics, "adapter_validation", () => {
    if (!prepareEnrichment || options.authChoice.mode !== "subscription" || options.authChoice.provider !== "claude" || options.tierBinding !== undefined
      || options.disclosurePolicy !== undefined || options.zoneRoles !== undefined || options.mcpServers !== undefined
      || options.bundle !== undefined || options.inProcess !== undefined || options.dispatched !== undefined || options.codexAsk !== undefined) throw new StructuredRuntimeError("unsupported");
  });
  // The editable-file hint comes from the operator-approved snapshot file list, never from model output. No list, no draft.
  const approvedFiles = provisioner.enrichmentApprovedFiles?.();
  const editableFiles = approvedFiles ? selectEditableFiles(approvedFiles) : undefined;
  if (!editableFiles || !hasEditableFiles(editableFiles)) throw new StructuredRuntimeError("unsupported");
  const componentTimeoutMs = options.componentLimits?.timeoutMs ?? RUNTIME_BUDGETS_MS.defaultComponentTimeout;
  const timeoutMs = options.chatTimeoutMs ?? componentTimeoutMs * STAGES;
  if (!Number.isSafeInteger(componentTimeoutMs) || componentTimeoutMs <= 0 || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new StructuredRuntimeError("unsupported");
  const timeout = new AbortController();
  const signal = AbortSignal.any([timeout.signal, ...(scope.signal ? [scope.signal] : [])]);
  const timer = setTimeout(() => timeout.abort(), Math.min(timeoutMs, componentTimeoutMs * STAGES, 2_147_483_647));
  const assertCurrent = () => { signal.throwIfAborted(); scope.assertCurrent(); };
  const guarded: StructuredScope = { ...scope, signal, assertCurrent };
  let prepared: OpenShellPreparedHost | undefined;
  let proposal: unknown;
  let contractFailure: EnrichmentContractError | undefined;
  let root: RootResult | undefined;
  let closing: Promise<void> | undefined;
  const close = () => closing ??= observeStructuredAsync(diagnostics, "adapter_cleanup", () => prepared?.dispose() ?? Promise.resolve());
  const abort = () => { void close().catch(() => {}); };
  const stage = async (name: "inspect_context" | "draft_enrichment", request: string, propose?: NonNullable<Parameters<NonNullable<OpenShellStructuredProvisioner["prepareEnrichment"]>>[0]["propose"]>) => {
    closing = undefined;
    const host = prepared = await observeStructuredAsync(diagnostics, "adapter_preparation", () => prepareEnrichment!.call(provisioner, { options, scope: guarded, stage: name, request, ...(propose ? { propose } : {}), onEvent: () => assertCurrent() }));
    // Registered only now, like Ask: nothing is cleaned up on abort until a host exists to be disposed, and a failed
    // preparation cannot leave a stale listener (or a cached `closing`) pointing at the previous stage's host.
    signal.addEventListener("abort", abort, { once: true });
    try {
      assertCurrent(); host.assertCurrent();
      const value = await observeStructuredAsync(diagnostics, "adapter_run", () => host.run(request));
      assertCurrent(); host.assertCurrent();
      await close(); assertCurrent(); host.assertCurrent(); host.assertExecutableCurrent?.();
      return value;
    } finally { signal.removeEventListener("abort", abort); }
  };
  try {
    assertCurrent();
    const gaps = text(rootValue(await stage("inspect_context", composeInspectPrompt(options.mode))));
    if (gaps.length > MAX_GAP_INVENTORY_CHARS) throw new StructuredRuntimeError("failed");
    const value = await stage("draft_enrichment", composeDraftPrompt(options.mode, options.projectRevision, gaps, { runtime: "openshell", editableFiles }), {
      component: "draft_enrichment",
      async persist(candidate, binding, parent) {
        parent.throwIfAborted(); assertCurrent();
        prepared?.assertExecutableCurrent?.();
        if (root || !binding.isCurrent() || candidate.output.kind !== "value") throw new StructuredRuntimeError("failed");
        // Host validation: sink allowlist, operation count, size caps and duplicates. Model-authored ids/hashes/risk are dropped.
        // A contract refusal is the model's draft being invalid, not a runtime failure: remember it so the route reports 400 as it does locally.
        try {
          const draft = translateDraftTerminal(text(candidate.output.value));
          canonicalizeProposal(draft, options.projectRevision);
          root = structuredClone(candidate); proposal = draft;
        } catch (error) {
          if (error instanceof EnrichmentContractError) { contractFailure = error; console.error(`[enrichment] draft refused by the proposal contract: ${JSON.stringify({ ...(error.diagnostic ?? {}), shape: describeDraftShape(text(candidate.output.value)) })}`); }
          throw error;
        }
      },
    });
    if (!root || proposal === undefined || !isDeepStrictEqual(value, root)) throw new StructuredRuntimeError("failed");
    const result: EnrichResult = { backend: "openshell", draft: structuredClone(proposal) };
    const current = () => { assertCurrent(); prepared!.assertCurrent(); prepared!.assertExecutableCurrent?.(); };
    current();
    results.set(result, { snapshot: structuredClone(result), assertCurrent: current });
    return result;
  } catch (error) {
    try { await close(); } catch { throw new StructuredRuntimeError("cleanup"); }
    if (timeout.signal.aborted) throw new StructuredRuntimeError("timeout");
    if (scope.signal?.aborted) throw new StructuredRuntimeError("cancelled");
    try { scope.assertCurrent(); } catch { throw new StructuredRuntimeError("stale"); }
    if (contractFailure) throw new StructuredRuntimeError("contract", contractFailure.message);
    throw error instanceof StructuredRuntimeError ? error : new StructuredRuntimeError("failed");
  } finally { clearTimeout(timer); }
}
