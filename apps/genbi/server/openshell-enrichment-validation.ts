import { isDeepStrictEqual } from "node:util";
import { planDigest } from "../harness/components/plan.js";
import { buildCandidate, materializeCandidate, scopeFailure, scopeViolation } from "./enrichment-candidate.js";
import type { EnrichmentBinding } from "./enrichment.js";
import { hostFailure, judgeValidatorResult, runtimeFailure, validatorRequest, type ValidationFailure } from "./enrichment-validation.js";
import type { createOpenShellRuntimeComposition } from "./openshell-runtime-composition.js";
import { OpenShellError } from "./runtime-host/openshell-types.js";
import { StructuredRuntimeError, type EnrichmentValidationRequest, type EnrichmentValidationResult, type StructuredScope } from "./structured-runtime.js";

type Composition = Pick<Awaited<ReturnType<typeof createOpenShellRuntimeComposition>>, "bindValidatorContext" | "validatorAvailable" | "claudeVault">;
export interface OpenShellEnrichmentValidatorOptions {
  readonly composition: Composition;
  readonly getBinding: () => EnrichmentBinding | undefined;
  /** Host-owned private directory the candidate is materialized into; never inside the project. */
  readonly scratchRoot: string;
  /** Whole validation (publication, host check, sandbox, cleanup). Default 5 minutes. */
  readonly timeoutMs?: number;
  /** Bound on the validator sandbox exchange itself. Default 2 minutes. */
  readonly exchangeTimeoutMs?: number;
  assertConfigurationCurrent?(): void;
}
export interface OpenShellEnrichmentValidator {
  available(): boolean;
  validate(request: EnrichmentValidationRequest, scope: StructuredScope): Promise<EnrichmentValidationResult>;
}

const protocolFailure = (code: string, message: string): EnrichmentValidationResult => ({ status: "failed", failure: { version: 1, stage: "validator", code, message } });
const failed = (failure: ValidationFailure): EnrichmentValidationResult => ({ status: "failed", failure });

/**
 * Independent validation of a recorded proposal, outside the model scope: the host builds and checks the draft against the published
 * snapshot, and only a draft that passes is sent to the fresh, credential-less, no-network validator sandbox. Cleanup always finishes
 * before a verdict is returned; cancel, stale state, timeout or cleanup uncertainty are errors, never a `validated` result.
 */
export function createOpenShellEnrichmentValidator(options: OpenShellEnrichmentValidatorOptions): OpenShellEnrichmentValidator {
  const composition = options.composition;
  return {
    available: () => composition.validatorAvailable(),
    async validate(request, scope) {
      const timeout = new AbortController();
      const timer = setTimeout(() => timeout.abort(), Math.min(options.timeoutMs ?? 300_000, 2_147_483_647));
      const signal = AbortSignal.any([timeout.signal, ...(scope.signal ? [scope.signal] : [])]);
      const started = Date.now();
      let session: Awaited<ReturnType<ReturnType<Composition["bindValidatorContext"]>>> | undefined;
      let verdict: EnrichmentValidationResult | undefined;
      let thrown: unknown;
      let currentness = () => { signal.throwIfAborted(); scope.assertCurrent(); };
      try {
        if (!composition.validatorAvailable()) throw new StructuredRuntimeError("unavailable");
        const status = structuredClone(composition.claudeVault?.status());
        if (status?.state !== "verified" || !status.fingerprint || !status.generation) throw new StructuredRuntimeError("unavailable");
        const binding = structuredClone(request.binding);
        currentness = () => {
          signal.throwIfAborted(); scope.assertCurrent(); options.assertConfigurationCurrent?.();
          if (!isDeepStrictEqual(options.getBinding(), binding) || !isDeepStrictEqual(composition.claudeVault?.status(), status)) throw new StructuredRuntimeError("stale");
        };
        currentness();
        // Scope is decided from kind and sink alone first: an unsupported proposal never costs a snapshot publication or a sandbox.
        const early = scopeViolation(request.proposal);
        if (early) verdict = failed(hostFailure(scopeFailure(early.sink)));
        else {
          const proposal = request.proposal;
          const context = planDigest({ purpose: "enrichment_validation", proposal: proposal.hash, revision: binding.revision });
          const identity = { backend: "openshell" as const, account: status.fingerprint, generation: status.generation, session: scope.sessionId, turn: scope.turnId,
            binding: binding.identity, bindingGeneration: String(binding.generation), bindingRevision: binding.revision, context, plan: planDigest({ purpose: "validate", proposal: proposal.hash }) };
          session = await composition.bindValidatorContext(context, currentness)(identity, signal);
          currentness();
          const candidate = buildCandidate(proposal, (relative, maxBytes) => session!.readSource(relative, maxBytes));
          if (!candidate.ok) { verdict = failed(hostFailure(candidate.failure)); }
          else {
            const materialized = materializeCandidate(options.scratchRoot, candidate.files);
            try {
              currentness();
              let raw: Buffer;
              try {
                raw = await session.validate(validatorRequest(materialized.files), Math.max(1000, Math.min(options.exchangeTimeoutMs ?? 120_000, (options.timeoutMs ?? 300_000) - (Date.now() - started))));
              } catch (error) {
                if (error instanceof OpenShellError && (error.code === "openshell_protocol_invalid" || error.code === "openshell_identity_mismatch")) {
                  verdict = protocolFailure(error.code === "openshell_identity_mismatch" ? "validator_identity" : "validator_protocol", "The validator sandbox did not follow the protected validator protocol.");
                } else throw error;
                raw = Buffer.alloc(0);
              }
              if (!verdict) {
                currentness();
                const judged = judgeValidatorResult(raw, { files: candidate.files, sent: materialized.files },
                  { account: status.fingerprint, binding: { generation: binding.generation, revision: binding.revision, projectIdentity: binding.identity }, manifest: session.manifest,
                    receipt: { image: session.validator.image, policy: session.validator.policy, script: session.validator.script, wheel: session.validator.wheel, toolchain: session.validator.toolchain,
                      architecture: session.validator.architecture, protocol: session.validator.protocol } });
                verdict = judged.ok ? { status: "validated", review: judged.review } : failed(judged.failure);
              }
            } finally { materialized.dispose(); }
          }
        }
      } catch (error) { thrown = error; }
      let cleanupFailed = false;
      try { await session?.close(); } catch { cleanupFailed = true; }
      clearTimeout(timer);
      if (cleanupFailed) throw new StructuredRuntimeError("cleanup");
      if (thrown !== undefined) {
        if (timeout.signal.aborted) throw new StructuredRuntimeError("timeout");
        if (scope.signal?.aborted) throw new StructuredRuntimeError("cancelled");
        try { scope.assertCurrent(); } catch { throw new StructuredRuntimeError("stale"); }
        if (thrown instanceof StructuredRuntimeError) throw thrown;
        if (thrown instanceof OpenShellError && thrown.code === "openshell_scope_invalid") throw new StructuredRuntimeError("stale");
        throw new StructuredRuntimeError("failed");
      }
      try { currentness(); } catch { throw new StructuredRuntimeError(timeout.signal.aborted ? "timeout" : scope.signal?.aborted ? "cancelled" : "stale"); }
      return verdict ?? failed(runtimeFailure("failed", "Validation did not produce a verdict."));
    },
  };
}
