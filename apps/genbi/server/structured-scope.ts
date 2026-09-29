import type { Store, TurnRow } from "./db.js";
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
