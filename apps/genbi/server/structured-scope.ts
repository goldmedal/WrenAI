import { newId, type EnrichmentRunRow, type Store, type TurnRow } from "./db.js";
import { StructuredRuntimeError, type StructuredScope } from "./structured-runtime.js";

/** Captured host-only values are compared, never persisted or sent as model/browser authority. */
export function captureStructuredScope(store: Store, turn: TurnRow, getProject: () => string | undefined, signal?: AbortSignal): StructuredScope {
  const snapshot = () => JSON.stringify({ runtime: store.getRuntimeSettings(), generation: store.getNativeRuntimeBinding().generation,
    binding: store.getEnrichmentBinding(), project: getProject(), ...(turn.setupStepKey !== null ? { form: store.getSetupConnectForm() } : {}) });
  const captured = snapshot();
  return { sessionId: turn.sessionId, turnId: turn.id, ...(signal ? { signal } : {}), assertCurrent() {
    const current = store.getTurn(turn.id);
    if (signal?.aborted || snapshot() !== captured || !current || current.sessionId !== turn.sessionId || current.resultKind !== null) throw new StructuredRuntimeError("stale");
  } };
}

/**
 * One enrichment draft's captured host state. The run row is the session identity; the scope goes stale as soon as the runtime
 * settings, native generation, project binding or project path change, the request is cancelled, or the run leaves `drafting`.
 */
export function captureEnrichmentScope(store: Store, run: EnrichmentRunRow, getProject: () => string | undefined, signal?: AbortSignal, expected: "drafting" | "validation_pending" = "drafting"): StructuredScope {
  const snapshot = () => JSON.stringify({ runtime: store.getRuntimeSettings(), generation: store.getNativeRuntimeBinding().generation,
    binding: store.getEnrichmentBinding(), project: getProject() });
  const captured = snapshot();
  return { sessionId: run.id, turnId: newId("enrichment-draft"), ...(signal ? { signal } : {}), assertCurrent() {
    const current = store.getEnrichmentRun(run.id);
    if (signal?.aborted || snapshot() !== captured || !current || current.status !== expected) throw new StructuredRuntimeError("stale");
  } };
}
