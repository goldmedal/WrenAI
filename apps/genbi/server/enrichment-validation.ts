/**
 * Host-side contract for the credential-less enrichment validator: the strict result schema, the decision that a result may count as
 * "validated", and the review/evidence records persisted for it. Pure: no sandbox, no I/O.
 *
 * A validator result has no authority of its own. It is accepted only when its change set is byte-equal to the host's candidate, its
 * regenerated MDL hashes to what it claims, and every check the host requires for that candidate passed (a check the validator
 * "skipped" but the candidate needs is a failure, not a pass).
 */
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { SnapshotManifest } from "./runtime-host/openshell-snapshot-types.js";
import { CANDIDATE_LIMITS, buildReviewDiff, changeSetSha256, type CandidateFile, type CandidateFailure, type ReviewDiffEntry } from "./enrichment-candidate.js";

export const VALIDATOR_CHECKS = ["additivity", "context_validate", "context_build", "dry_plan", "cube_sql", "dry_run"] as const;
export type ValidatorCheckName = typeof VALIDATOR_CHECKS[number];
const checkSchema = z.object({ check: z.enum(VALIDATOR_CHECKS), status: z.enum(["pass", "fail", "skipped"]), code: z.string().regex(/^[a-z0-9_]{1,48}$/), message: z.string().max(240) }).strict();
const checksSchema = z.array(checkSchema).min(1).max(VALIDATOR_CHECKS.length).refine((checks) => new Set(checks.map((check) => check.check)).size === checks.length);
const okResult = z.object({ status: z.literal("ok"), applied: z.array(z.object({ path: z.string().max(CANDIDATE_LIMITS.pathLength), content: z.string().max(CANDIDATE_LIMITS.afterBytes) }).strict()).min(1).max(CANDIDATE_LIMITS.files),
  checks: checksSchema, mdl: z.object({ sha256: z.string().regex(/^[a-f0-9]{64}$/), size: z.number().int().min(1).max(CANDIDATE_LIMITS.mdlBytes), content: z.string().max(CANDIDATE_LIMITS.mdlBytes) }).strict() }).strict();
const failedResult = z.object({ status: z.literal("failed"), checks: checksSchema }).strict();
const resultSchema = z.discriminatedUnion("status", [okResult, failedResult]);
export type ValidatorResult = z.infer<typeof resultSchema>;
export type ValidatorCheck = z.infer<typeof checkSchema>;

/** Sandbox text is untrusted: drop control characters and path-like or URL-like tokens, collapse whitespace, bound the length. */
export function sanitizeValidatorMessage(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]+/g, " ").split(/\sLINE \d+:|\sphase=/)[0]!.replace(/(?:[A-Za-z]:\\|\/)[^\s,;:'")]*/g, "<path>").replace(/\s+/g, " ").trim().slice(0, 240);
}

export type ValidationFailureStage = "host" | "validator" | "runtime";
/** Sanitized, persisted/displayed reason a run ended `validation_failed`. Never carries paths, SQL, credentials or exception text. */
export interface ValidationFailure {
  readonly version: 1; readonly stage: ValidationFailureStage; readonly code: string; readonly message: string; readonly path?: string; readonly checks?: readonly ValidatorCheck[];
}
export const hostFailure = (failure: CandidateFailure): ValidationFailure => ({ version: 1, stage: "host", code: failure.code, message: failure.message, ...(failure.path ? { path: failure.path } : {}) });
export const runtimeFailure = (code: string, message: string): ValidationFailure => ({ version: 1, stage: "runtime", code, message });
const validatorFailure = (code: string, message: string, checks?: readonly ValidatorCheck[]): ValidationFailure => ({ version: 1, stage: "validator", code, message, ...(checks ? { checks } : {}) });

export interface ValidatorReceiptTuple { readonly image: string; readonly policy: string; readonly script: string; readonly wheel: string; readonly toolchain: string; readonly architecture: string; readonly protocol: string }
/** Everything a later apply step binds to: the exact diff, the validator receipt, the snapshot manifest and the binding it was reviewed against. */
export interface ValidatedReview {
  readonly version: 1;
  /** Fingerprint of the model account the draft and validation ran under; Apply refuses when it changed. */
  readonly account: string;
  readonly binding: { readonly generation: number; readonly revision: string; readonly projectIdentity: string };
  readonly snapshot: { readonly digest: string; readonly project: string; readonly bindingGeneration: string; readonly bindingRevision: string; readonly context: string; readonly files: SnapshotManifest["files"] };
  readonly diff: readonly ReviewDiffEntry[];
  readonly diffSha256: string;
  /** The validator-regenerated MDL, byte-exact (its sha256 is `receipt.mdl.sha256`). Never part of the public DTO; Apply writes exactly this. */
  readonly mdlContent: string;
  readonly receipt: ValidatorReceiptTuple & { readonly checks: readonly ValidatorCheck[]; readonly mdl: { readonly sha256: string; readonly size: number }; readonly changeSetSha256: string };
}

export type ValidatorVerdict = { readonly ok: true; readonly review: ValidatedReview } | { readonly ok: false; readonly failure: ValidationFailure };

const required = (files: readonly { readonly path: string }[]): ReadonlyMap<ValidatorCheckName, "pass" | "skipped"> => {
  const relation = files.some((file) => /^(?:models|views)\//.test(file.path)), cube = files.some((file) => file.path.startsWith("cubes/"));
  return new Map<ValidatorCheckName, "pass" | "skipped">([["additivity", "pass"], ["context_validate", "pass"], ["context_build", "pass"],
    ["dry_plan", relation ? "pass" : "skipped"], ["cube_sql", cube ? "pass" : "skipped"], ["dry_run", cube ? "pass" : "skipped"]]);
};

/** Decide what one raw validator result line means. Every deviation is a typed failure; nothing here throws on untrusted input. */
export function judgeValidatorResult(raw: Buffer, candidate: { readonly files: readonly CandidateFile[]; readonly sent: readonly { readonly path: string; readonly content: string }[] },
  context: { readonly account: string; readonly binding: ValidatedReview["binding"]; readonly manifest: SnapshotManifest; readonly receipt: ValidatorReceiptTuple }): ValidatorVerdict {
  let result: ValidatorResult;
  try {
    if (raw.length > 524_288) throw new Error("oversized");
    result = resultSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)));
  } catch { return { ok: false, failure: validatorFailure("validator_protocol", "The validator returned a malformed, oversized or unexpected result.") }; }
  const checks = result.checks.map((check) => ({ ...check, message: sanitizeValidatorMessage(check.message) }));
  if (result.status === "failed") {
    if (!checks.some((check) => check.status === "fail")) return { ok: false, failure: validatorFailure("validator_protocol", "The validator reported failure without a failed check.") };
    const failed = checks.find((check) => check.status === "fail")!;
    return { ok: false, failure: validatorFailure("validator_failed", `Validation failed at ${failed.check}: ${failed.message || failed.code}`, checks) };
  }
  // Byte-equality of the change set the validator says it applied with the one the host sent.
  if (!isDeepStrictEqual(result.applied, candidate.sent) || !isDeepStrictEqual(candidate.sent, candidate.files.map((file) => ({ path: file.path, content: file.after })))) {
    return { ok: false, failure: validatorFailure("change_set_mismatch", "The validator's applied change set is not byte-equal to the reviewed candidate.", checks) };
  }
  const expected = required(candidate.sent);
  for (const [name, status] of expected) {
    const check = checks.find((item) => item.check === name);
    if (!check || check.status !== status) return { ok: false, failure: validatorFailure("check_not_passed", `Required check ${name} did not ${status === "pass" ? "pass" : "stay skipped"}.`, checks) };
  }
  const content = Buffer.from(result.mdl.content, "utf8");
  let valid = content.length === result.mdl.size && createHash("sha256").update(content).digest("hex") === result.mdl.sha256;
  if (valid) { try { const parsed: unknown = JSON.parse(result.mdl.content); valid = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) && Array.isArray((parsed as { models?: unknown }).models); } catch { valid = false; } }
  if (!valid) return { ok: false, failure: validatorFailure("mdl_invalid", "The regenerated MDL is missing, oversized or does not match its digest.", checks) };
  const { diff, diffSha256 } = buildReviewDiff(candidate.files);
  const { manifest } = context;
  return { ok: true, review: { version: 1, account: context.account, binding: context.binding, mdlContent: result.mdl.content,
    snapshot: { digest: manifest.digest, project: manifest.project, bindingGeneration: manifest.bindingGeneration, bindingRevision: manifest.bindingRevision, context: manifest.context, files: manifest.files },
    diff, diffSha256, receipt: { ...context.receipt, checks, mdl: { sha256: result.mdl.sha256, size: result.mdl.size }, changeSetSha256: changeSetSha256(candidate.sent) } } };
}

/** The request the validator receives: exactly the host's read-back candidate, nothing else. */
export function validatorRequest(files: readonly { readonly path: string; readonly content: string }[]): Buffer {
  return Buffer.from(JSON.stringify({ version: 1, files }), "utf8");
}
