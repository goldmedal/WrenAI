/**
 * Apply-all and Discard for an OpenShell-validated enrichment review.
 *
 * Apply writes exactly the validated change set (plus the validator-regenerated `target/mdl.json` when it differs) as ONE unit, behind a
 * server-minted, hash-stored, single-use capability. Every precondition is checked synchronously, inside the same `BEGIN IMMEDIATE`
 * transaction that records the durable journal row, and no `await` separates the last check from the first write. The journal row (with
 * the bytes found before) exists before any project file is touched, so an interruption is always recoverable: roll back iff every file
 * is exactly its old or its new bytes, otherwise stop at `reconcile_required`. Nothing here ever resumes forward.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readSync, readdirSync, realpathSync, renameSync, unlinkSync, writeSync } from "node:fs";
import path from "node:path";
import type { EnrichmentApplyJournalFile, EnrichmentApplyJournalRow, Store } from "./db.js";
import { resolveEnrichmentBinding, type EnrichmentBinding, type EnrichmentRunStatus } from "./enrichment.js";
import { changeSetSha256, sinkInRuntimeScope, type ReviewDiffEntry } from "./enrichment-candidate.js";
import type { ValidatedReview } from "./enrichment-validation.js";

export const APPLY_CAPABILITY_TTL_MS = 10 * 60_000;
const MAX_TTL_MS = 15 * 60_000;
const MAX_MDL_BEFORE_BYTES = 1_048_576;
const MAX_SOURCE_FILE_BYTES = 134_217_728;
const MAX_SOURCE_TOTAL_BYTES = 268_435_456;
const MAX_SOURCE_FILES = 4094;
const MDL_PATH = "target/mdl.json";

export type ApplyCode = "run_not_found" | "not_openshell" | "run_not_appliable" | "validation_missing" | "capability_invalid" | "capability_expired" | "review_mismatch" | "reconcile_required"
  | "recovery_pending" | "unsupported_by_runtime" | "binding_changed" | "account_changed" | "manifest_drift" | "target_changed" | "symlink" | "mdl_invalid" | "too_large" | "source_unreadable"
  | "inventory_unavailable" | "apply_failed" | "applied" | "discarded" | "not_discardable" | "minted";

/** A refusal before any write. `terminal` refusals end the run `apply_refused`; the others leave it appliable (the capability is spent either way). */
export class ApplyRefusal extends Error {
  constructor(readonly code: ApplyCode, readonly terminal: boolean) { super(code); }
}
/** Test seam: a simulated process kill. The apply code must not clean up after it, exactly as after a real kill. */
export class SimulatedApplyCrash extends Error {}

export interface ApplyReceipt {
  readonly version: 1; readonly appliedAt: string; readonly runId: string; readonly diffSha256: string; readonly changeSetSha256: string;
  readonly files: readonly { readonly path: string; readonly beforeSha256: string; readonly afterSha256: string }[];
  readonly mdl: { readonly sha256: string; readonly written: boolean };
  readonly previousBinding: { readonly generation: number; readonly revision: string };
  readonly binding: { readonly generation: number; readonly revision: string };
}
export type ApplyOutcome =
  | { readonly ok: true; readonly status: 200 | 201; readonly code: "applied" | "discarded" | "minted"; readonly receipt?: ApplyReceipt; readonly replay?: boolean; /** The apply is committed, but dropping live runtime state failed; the committed generation bump still fences every old scope. */ readonly revocationPending?: boolean; readonly capability?: string; readonly expiresAt?: string; readonly reviewSha256?: string; readonly changeSetSha256?: string }
  | { readonly ok: false; readonly status: 403 | 404 | 409 | 500 | 503; readonly code: ApplyCode; readonly terminal?: boolean; readonly rolledBack?: boolean };

export interface ApplyInventory { readonly approvedFiles: readonly string[]; /** When false the snapshot's `project/wren_project.yml` is a projection, not source bytes. */ readonly preserveProjectConfig: boolean }
/** `before_file` fires before a file's temp is created (index is 0-based); `after_file` after its rename (index is 1-based). */
export interface ApplyFaultEvent { readonly phase: "before_file" | "after_file"; readonly index: number; readonly total: number }
export interface EnrichmentApplierOptions {
  readonly store: Store;
  /** The host's current binding with a revision resolved fresh from disk. */
  readonly getBinding: () => EnrichmentBinding | undefined;
  /** Fingerprint of the verified model account, or undefined when none is verified. */
  readonly account: () => string | undefined;
  /** The operator's approved file list; undefined when the governed snapshot is not configured. */
  readonly inventory: () => ApplyInventory | undefined;
  /** Runs after the success transaction with the native sessions it revoked: drop their in-memory capabilities and in-flight scopes. */
  readonly onBindingAdvanced?: (revokedNativeSessionIds: readonly string[]) => void;
  readonly now?: () => number;
  readonly ttlMs?: number;
  /** Test seam: throw to fail in process (rolled back), return "crash" to simulate a kill. */
  readonly fault?: (event: ApplyFaultEvent) => void | "crash";
}
export interface EnrichmentApplier {
  mint(runId: string): ApplyOutcome;
  apply(runId: string, input: { readonly capability: unknown; readonly reviewSha256: unknown }): ApplyOutcome;
  discard(runId: string): ApplyOutcome;
  /** Startup recovery of every `applying` journal row. Never resumes forward. */
  recover(): { readonly rolledBack: number; readonly reconcileRequired: number };
  /** Recovery of one run's journal: acts only on an `applying` row; any other state is final and returns its classification untouched. */
  recoverRun(runId: string): "rolled_back" | "reconcile_required" | "unchanged";
}

const sha256 = (value: Buffer | string): string => createHash("sha256").update(value).digest("hex");
const safeEqual = (a: string, b: string): boolean => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const refused = (code: ApplyCode, status: 403 | 404 | 409 | 500 | 503 = 409, extra: { terminal?: boolean } = {}): ApplyOutcome => ({ ok: false, status, code, ...extra });
const BLOCKING = ["applying", "reconcile_required"] as const;

interface TargetPlan { readonly file: EnrichmentApplyJournalFile; readonly after: Buffer; readonly mode: number; readonly directories: readonly { readonly path: string; readonly dev: number; readonly ino: number }[] }
interface ApplyPlan { readonly root: string; readonly targets: readonly TargetPlan[]; readonly review: ValidatedReview; readonly mdlWritten: boolean; readonly previous: EnrichmentBinding }

/** Reads one regular file without following a link; throws on anything else. */
function readExact(absolute: string, maxBytes: number): Buffer {
  const fd = openSync(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.nlink !== 1 || info.size > maxBytes) throw new ApplyRefusal(info.size > maxBytes ? "too_large" : "symlink", true);
    const out = Buffer.alloc(info.size); let length = 0;
    while (length < out.length) { const n = readSync(fd, out, length, out.length - length, null); if (!n) break; length += n; }
    if (length !== out.length) throw new ApplyRefusal("target_changed", true);
    return out;
  } finally { closeSync(fd); }
}
function hashFile(absolute: string, maxBytes: number): { size: number; sha256: string } {
  const fd = openSync(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.nlink !== 1) throw new ApplyRefusal("symlink", true);
    if (info.size > maxBytes) throw new ApplyRefusal("too_large", true);
    const hash = createHash("sha256"); const chunk = Buffer.alloc(1_048_576); let total = 0;
    for (;;) { const n = readSync(fd, chunk, 0, chunk.length, null); if (!n) break; hash.update(chunk.subarray(0, n)); total += n; }
    if (total !== info.size) throw new ApplyRefusal("manifest_drift", true);
    return { size: total, sha256: hash.digest("hex") };
  } finally { closeSync(fd); }
}
/** Classifies a filesystem failure: an unreadable source is transient, a vanished or swapped one is drift. */
function classify(error: unknown): ApplyRefusal {
  if (error instanceof ApplyRefusal) return error;
  const code = (error as NodeJS.ErrnoException)?.code;
  if (code === "ELOOP" || code === "ENOTDIR") return new ApplyRefusal("symlink", true);
  if (code === "ENOENT") return new ApplyRefusal("target_changed", true);
  return new ApplyRefusal("source_unreadable", false);
}

/** Streamed sha256 of every file of the bound project, requiring the tree to equal the approved list exactly (as the snapshot helper does). */
function captureSourceManifest(root: string, approved: readonly string[]): Map<string, { size: number; sha256: string }> {
  const allowed = new Set(approved); const prefixes = new Set<string>();
  for (const file of approved) { const parts = file.split("/"); for (let i = 1; i < parts.length; i++) prefixes.add(parts.slice(0, i).join("/")); }
  const out = new Map<string, { size: number; sha256: string }>(); let total = 0;
  const walk = (directory: string, prefix: string) => {
    for (const entry of readdirSync(directory).sort()) {
      const relative = prefix + entry; const absolute = path.join(directory, entry); const info = lstatSync(absolute);
      if (info.isSymbolicLink()) throw new ApplyRefusal("symlink", true);
      if (info.isDirectory()) { if (!prefixes.has(relative)) throw new ApplyRefusal("manifest_drift", true); walk(absolute, `${relative}/`); continue; }
      if (!info.isFile() || !allowed.has(relative)) throw new ApplyRefusal("manifest_drift", true);
      const hashed = hashFile(absolute, MAX_SOURCE_FILE_BYTES);
      total += hashed.size;
      if (total > MAX_SOURCE_TOTAL_BYTES || out.size >= MAX_SOURCE_FILES) throw new ApplyRefusal("too_large", true);
      out.set(`project/${relative}`, hashed);
    }
  };
  walk(root, "");
  if (out.size !== allowed.size) throw new ApplyRefusal("manifest_drift", true);
  return out;
}

/** lstat chain from the project root to the target: no link anywhere, directories recorded, a regular single-link file, realpath under the root. */
function inspectTarget(root: string, relative: string): { directories: { path: string; dev: number; ino: number }[]; mode: number } {
  const parts = relative.split("/"); const directories: { path: string; dev: number; ino: number }[] = []; let current = root; let mode = 0o644;
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]!);
    const info = lstatSync(current);
    if (info.isSymbolicLink()) throw new ApplyRefusal("symlink", true);
    if (i < parts.length - 1) { if (!info.isDirectory()) throw new ApplyRefusal("symlink", true); directories.push({ path: current, dev: info.dev, ino: info.ino }); }
    else { if (!info.isFile() || info.nlink !== 1) throw new ApplyRefusal("symlink", true); mode = info.mode & 0o777; }
  }
  const real = realpathSync(current);
  if (real !== path.join(realpathSync(root), relative)) throw new ApplyRefusal("symlink", true);
  return { directories, mode };
}
function recheckDirectories(directories: readonly { path: string; dev: number; ino: number }[]): void {
  for (const directory of directories) {
    const info = lstatSync(directory.path);
    if (info.isSymbolicLink() || !info.isDirectory() || info.dev !== directory.dev || info.ino !== directory.ino) throw new ApplyRefusal("symlink", true);
  }
}
function fsyncDirectory(directory: string): void {
  const fd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
const tempName = (runId: string, index: number): string => `.genbi-apply-${sha256(runId).slice(0, 12)}-${index}.tmp`;
/** temp (same directory, exclusive, no-follow) + fsync + ancestor recheck + rename + directory fsync. */
function atomicReplace(root: string, relative: string, bytes: Buffer, mode: number, directories: readonly { path: string; dev: number; ino: number }[], temporary: string): void {
  const absolute = path.join(root, relative); const directory = path.dirname(absolute); const temp = path.join(directory, temporary);
  // A stale temp with this exact run-derived name can only be ours (a kill between create and rename); a link or anything else is left, so O_EXCL refuses.
  try { if (lstatSync(temp).isFile()) unlinkSync(temp); } catch { /* none */ }
  const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
  try {
    try { let offset = 0; while (offset < bytes.length) offset += writeSync(fd, bytes, offset); fsyncSync(fd); } finally { closeSync(fd); }
    recheckDirectories(directories);
    renameSync(temp, absolute);
  } catch (error) { try { unlinkSync(temp); } catch { /* nothing to remove */ } throw error; }
  fsyncDirectory(directory);
}
function removeTemporaries(root: string, files: readonly EnrichmentApplyJournalFile[], runId: string): void {
  files.forEach((file, index) => { const temp = path.join(root, path.dirname(file.path), tempName(runId, index)); try { if (lstatSync(temp).isFile()) unlinkSync(temp); } catch { /* absent */ } });
}

export function createOpenShellEnrichmentApplier(options: EnrichmentApplierOptions): EnrichmentApplier {
  const { store } = options;
  const now = options.now ?? (() => Date.now());
  const ttl = Math.min(options.ttlMs ?? APPLY_CAPABILITY_TTL_MS, MAX_TTL_MS);
  const iso = (): string => new Date(now()).toISOString();

  const loadReview = (runId: string): ValidatedReview | undefined => {
    const validation = store.getEnrichmentValidation(runId);
    return validation?.outcome === "validated" && typeof validation.review.mdlContent === "string" && typeof validation.review.account === "string" ? validation.review : undefined;
  };
  const projectBlocked = (projectPath: string): "reconcile_required" | "recovery_pending" | undefined => {
    for (const row of store.listEnrichmentApplyJournals(BLOCKING)) if (row.projectPath === projectPath) return row.state === "applying" ? "recovery_pending" : "reconcile_required";
    return undefined;
  };
  const bindingMatches = (run: { projectPath: string; projectIdentity: string; projectRevision: string; bindingGeneration: number }, binding: EnrichmentBinding, review: ValidatedReview): boolean =>
    run.projectPath === binding.path && run.projectIdentity === binding.identity && run.projectRevision === binding.revision && run.bindingGeneration === binding.generation
    && review.binding.generation === binding.generation && review.binding.revision === binding.revision && review.binding.projectIdentity === binding.identity
    && review.snapshot.bindingGeneration === String(binding.generation) && review.snapshot.bindingRevision === binding.revision;

  /** Everything that must hold immediately before the first write. Throws ApplyRefusal; touches no file. */
  const plan = (run: NonNullable<ReturnType<Store["getEnrichmentRun"]>>, review: ValidatedReview, capability: NonNullable<ReturnType<Store["getEnrichmentApplyCapability"]>>): ApplyPlan => {
    // The record must be exactly what was reviewed: re-derive the diff and change-set digests from the stored entries.
    const diff: readonly ReviewDiffEntry[] = review.diff;
    if (`sha256:${sha256(JSON.stringify(diff))}` !== review.diffSha256 || changeSetSha256(diff.map((entry) => ({ path: entry.path, content: entry.after }))) !== review.receipt.changeSetSha256
      || capability.reviewSha256 !== review.diffSha256 || capability.changeSetSha256 !== review.receipt.changeSetSha256) throw new ApplyRefusal("review_mismatch", true);
    const binding = options.getBinding();
    if (!binding || !bindingMatches(run, binding, review)
      || capability.bindingPath !== binding.path || capability.bindingIdentity !== binding.identity || capability.bindingGeneration !== binding.generation || capability.bindingRevision !== binding.revision) throw new ApplyRefusal("binding_changed", true);
    const account = options.account();
    if (!account || account !== capability.account || account !== review.account) throw new ApplyRefusal("account_changed", true);
    // Scope is re-checked here too: only changes to files the snapshot already holds, never a creation, cube or view.
    const inventory = options.inventory();
    if (!inventory) throw new ApplyRefusal("inventory_unavailable", false);
    if (diff.length === 0) throw new ApplyRefusal("review_mismatch", true);
    const snapshotPaths = new Set(review.snapshot.files.map((file) => file.path));
    for (const entry of diff) if (entry.change !== "modified" || entry.beforeSha256 === null || !sinkInRuntimeScope(entry.path) || !snapshotPaths.has(`project/${entry.path}`) || !inventory.approvedFiles.includes(entry.path)) throw new ApplyRefusal("unsupported_by_runtime", true);
    const root = realpathSync(binding.path);
    try {
      // Full manifest: every approved file, not only the targets, must still be exactly what was published for the review.
      const fresh = captureSourceManifest(root, inventory.approvedFiles);
      for (const projected of inventory.preserveProjectConfig ? [] : ["project/wren_project.yml"]) fresh.delete(projected);
      const expected = review.snapshot.files.filter((file) => file.path.startsWith("project/") && (inventory.preserveProjectConfig || file.path !== "project/wren_project.yml"));
      if (expected.length !== fresh.size) throw new ApplyRefusal("manifest_drift", true);
      for (const file of expected) { const seen = fresh.get(file.path); if (!seen || seen.size !== file.size || seen.sha256 !== file.sha256) throw new ApplyRefusal("manifest_drift", true); }
      const targets: TargetPlan[] = [];
      for (const entry of diff) {
        const { directories, mode } = inspectTarget(root, entry.path);
        const current = readExact(path.join(root, entry.path), 65_536);
        const after = Buffer.from(entry.after, "utf8");
        if (sha256(current) !== entry.beforeSha256 || current.toString("utf8") !== entry.before || sha256(after) !== entry.afterSha256) throw new ApplyRefusal("target_changed", true);
        targets.push({ file: { path: entry.path, before: current.toString("base64"), beforeSha256: entry.beforeSha256, afterSha256: entry.afterSha256 }, after, mode, directories });
      }
      // The validator-regenerated MDL, byte-exact, written only when it is the receipt's and differs from the current one.
      const mdl = Buffer.from(review.mdlContent, "utf8");
      if (sha256(mdl) !== review.receipt.mdl.sha256 || mdl.length !== review.receipt.mdl.size) throw new ApplyRefusal("mdl_invalid", true);
      let mdlWritten = false;
      const mdlInfo = inspectTarget(root, MDL_PATH);
      const currentMdl = readExact(path.join(root, MDL_PATH), MAX_MDL_BEFORE_BYTES);
      if (sha256(currentMdl) !== review.receipt.mdl.sha256) {
        mdlWritten = true;
        targets.push({ file: { path: MDL_PATH, before: currentMdl.toString("base64"), beforeSha256: sha256(currentMdl), afterSha256: review.receipt.mdl.sha256 }, after: mdl, mode: mdlInfo.mode, directories: mdlInfo.directories });
      }
      return { root, targets, review, mdlWritten, previous: binding };
    } catch (error) { throw classify(error); }
  };

  const settleFailure = (runId: string, to: EnrichmentRunStatus, code: string): void => {
    store.transitionEnrichmentRunFenced({ runId, from: ["applying"], to, message: `Apply ended: ${code}`, operationState: to === "reconcile_required" ? "reconcile_required" : "skipped", event: { kind: to === "reconcile_required" ? "apply_reconcile_required" : "apply_failed", message: code } });
  };

  /**
   * Shared by the in-process failure path and BFF start: classify every journalled file by hash and either restore the old bytes
   * (iff each file is exactly old or new) or stop at `reconcile_required`. Evidence rows stay.
   */
  const rollback = (row: EnrichmentApplyJournalRow): "rolled_back" | "reconcile_required" | "unchanged" => {
    // Only an in-flight apply is ever restored. Any other state (applied, rolled back, reconcile_required, resolved) is final and untouched.
    const live = store.getEnrichmentApplyJournal(row.runId);
    if (!live || live.state !== "applying") return live?.state === "reconcile_required" ? "reconcile_required" : live?.state === "rolled_back" ? "rolled_back" : "unchanged";
    row = live;
    let root: string;
    try { root = realpathSync(row.projectPath); } catch { return conclude(row, "reconcile_required", "project_unreachable"); }
    try { removeTemporaries(root, row.files, row.runId); } catch { /* best effort: exact names only */ }
    const states = row.files.map((file) => {
      try {
        const { directories, mode } = inspectTarget(root, file.path);
        const hash = sha256(readExact(path.join(root, file.path), MAX_MDL_BEFORE_BYTES + 1));
        return { file, directories, mode, state: hash === file.beforeSha256 ? "old" as const : hash === file.afterSha256 ? "new" as const : "third" as const };
      } catch { return { file, directories: [], mode: 0o644, state: "third" as const }; }
    });
    if (states.some((entry) => entry.state === "third")) return conclude(row, "reconcile_required", "third_hash");
    try {
      states.forEach((entry, index) => { if (entry.state === "new") atomicReplace(root, entry.file.path, Buffer.from(entry.file.before, "base64"), entry.mode, entry.directories, tempName(row.runId, index)); });
      removeTemporaries(root, row.files, row.runId);
      for (const entry of row.files) if (sha256(readExact(path.join(root, entry.path), MAX_MDL_BEFORE_BYTES + 1)) !== entry.beforeSha256) return conclude(row, "reconcile_required", "restore_unverified");
    } catch { try { removeTemporaries(root, row.files, row.runId); } catch { /* best effort */ } return conclude(row, "reconcile_required", "restore_failed"); }
    return conclude(row, "rolled_back", "rolled_back");
  };
  const conclude = (row: EnrichmentApplyJournalRow, state: "rolled_back" | "reconcile_required", evidence: string): "rolled_back" | "reconcile_required" => {
    store.applyTransaction(() => {
      store.settleEnrichmentApplyJournal(row.runId, state, evidence);
      settleFailure(row.runId, state === "rolled_back" ? "apply_failed" : "reconcile_required", evidence);
    });
    return state;
  };

  return {
    mint(runId) {
      const run = store.getEnrichmentRun(runId);
      if (!run) return refused("run_not_found", 404);
      if (run.backend !== "openshell") return refused("not_openshell");
      if (run.status !== "awaiting_decision") return refused("run_not_appliable");
      const review = loadReview(runId);
      if (!review) return refused("validation_missing");
      const blocked = projectBlocked(run.projectPath);
      if (blocked) return refused(blocked);
      const binding = options.getBinding(); const account = options.account();
      if (!binding || !bindingMatches(run, binding, review)) return refused("binding_changed");
      if (!account || account !== review.account) return refused("account_changed");
      const capability = randomBytes(32).toString("base64url");
      const mintedAt = iso(); const expiresAt = new Date(now() + ttl).toISOString();
      store.putEnrichmentApplyCapability({ runId, tokenHash: sha256(capability), reviewSha256: review.diffSha256, changeSetSha256: review.receipt.changeSetSha256, bindingPath: binding.path, bindingIdentity: binding.identity,
        bindingGeneration: binding.generation, bindingRevision: binding.revision, account, mintedAt, expiresAt, consumedAt: null, consumedOutcome: null });
      return { ok: true, status: 201, code: "minted", capability, expiresAt, reviewSha256: review.diffSha256, changeSetSha256: review.receipt.changeSetSha256 };
    },

    apply(runId, input) {
      const run = store.getEnrichmentRun(runId);
      if (!run) return refused("run_not_found", 404);
      if (run.backend !== "openshell") return refused("not_openshell");
      if (run.status === "applied") {
        const receipt = store.getEnrichmentApplyJournal(runId)?.receipt as ApplyReceipt | null | undefined;
        return receipt ? { ok: true, status: 200, code: "applied", receipt, replay: true } : refused("run_not_appliable");
      }
      if (run.status !== "awaiting_decision") return refused("run_not_appliable");
      if (typeof input.capability !== "string" || input.capability.length < 16 || input.capability.length > 256) return refused("capability_invalid", 403);
      const review = loadReview(runId);
      if (!review) return refused("validation_missing");
      const tokenHash = sha256(input.capability);
      type Gate = { readonly kind: "plan"; readonly plan: ApplyPlan } | { readonly kind: "out"; readonly outcome: ApplyOutcome };
      // One transaction: capability spend, every precondition, the journal row and the run claim. A refusal is returned, never thrown, so the spend commits.
      const gate = store.applyTransaction((): Gate => {
        // Re-read inside the transaction: another process may have moved the run since the cheap check above.
        const live = store.getEnrichmentRun(runId);
        if (!live || live.status !== "awaiting_decision") return { kind: "out", outcome: refused("run_not_appliable") };
        const blocked = projectBlocked(run.projectPath);
        if (blocked) return { kind: "out", outcome: refused(blocked) };
        const capability = store.getEnrichmentApplyCapability(runId);
        if (!capability || !safeEqual(capability.tokenHash, tokenHash)) return { kind: "out", outcome: refused("capability_invalid", 403) };
        const nowIso = iso();
        if (!store.consumeEnrichmentApplyCapability(runId, tokenHash, nowIso)) {
          if (!capability.consumedAt) store.burnEnrichmentApplyCapability(runId, "expired", nowIso);
          return { kind: "out", outcome: refused(!capability.consumedAt && capability.expiresAt <= nowIso ? "capability_expired" : "capability_invalid", 403) };
        }
        const refuse = (error: ApplyRefusal): Gate => {
          if (error.terminal) store.transitionEnrichmentRunFenced({ runId, from: ["awaiting_decision"], to: "apply_refused", message: `Apply refused: ${error.code}`, operationState: "skipped", event: { kind: "apply_refused", message: error.code } });
          return { kind: "out", outcome: refused(error.code, 409, { terminal: error.terminal }) };
        };
        if (typeof input.reviewSha256 !== "string" || input.reviewSha256 !== review.diffSha256 || capability.reviewSha256 !== input.reviewSha256) return refuse(new ApplyRefusal("review_mismatch", false));
        let prepared: ApplyPlan;
        try { prepared = plan(run, review, capability); } catch (error) { return refuse(error instanceof ApplyRefusal ? error : new ApplyRefusal("source_unreadable", false)); }
        store.insertEnrichmentApplyJournal({ runId, projectPath: prepared.root, capabilityHash: tokenHash, changeSetSha256: review.receipt.changeSetSha256, files: prepared.targets.map((target) => target.file) });
        if (!store.transitionEnrichmentRunFenced({ runId, from: ["awaiting_decision"], to: "applying", event: { kind: "applying", message: "Applying the validated change set." } })) throw new ApplyRefusal("run_not_appliable", false);
        return { kind: "plan", plan: prepared };
      });
      if (gate.kind === "out") return gate.outcome;
      const { plan: prepared } = gate;
      const journalRow = store.getEnrichmentApplyJournal(runId)!;
      const total = prepared.targets.length;
      let advanced: ReturnType<Store["completeEnrichmentApply"]>;
      try {
        prepared.targets.forEach((target, index) => {
          if (options.fault?.({ phase: "before_file", index, total }) === "crash") throw new SimulatedApplyCrash();
          atomicReplace(prepared.root, target.file.path, target.after, target.mode, target.directories, tempName(runId, index));
          if (options.fault?.({ phase: "after_file", index: index + 1, total }) === "crash") throw new SimulatedApplyCrash();
        });
        for (const target of prepared.targets) if (sha256(readExact(path.join(prepared.root, target.file.path), MAX_MDL_BEFORE_BYTES + 1)) !== target.file.afterSha256) throw new ApplyRefusal("target_changed", true);
        const revision = resolveEnrichmentBinding(prepared.root).revision;
        const files = prepared.targets.map((target) => ({ path: target.file.path, beforeSha256: target.file.beforeSha256, afterSha256: target.file.afterSha256 }));
        advanced = store.completeEnrichmentApply({ runId, binding: { path: prepared.previous.path, identity: prepared.previous.identity, revision }, appliedOperationIds: store.listEnrichmentOperations(runId).filter((operation) => operation.changeKind !== "conflict" && operation.changeKind !== "ambiguous").map((operation) => operation.id),
          receipt: (binding) => ({ version: 1, appliedAt: iso(), runId, diffSha256: prepared.review.diffSha256, changeSetSha256: prepared.review.receipt.changeSetSha256, files,
            mdl: { sha256: prepared.review.receipt.mdl.sha256, written: prepared.mdlWritten }, previousBinding: { generation: prepared.previous.generation, revision: prepared.previous.revision }, binding: { generation: binding.generation, revision: binding.revision } } satisfies ApplyReceipt) });
        if (!advanced) throw new ApplyRefusal("apply_failed", true);
      } catch (error) {
        if (error instanceof SimulatedApplyCrash) throw error;
        // In-process failure BEFORE the success commit: the same classification and restore as after a restart. The row is kept as evidence either way.
        const outcome = rollback(store.getEnrichmentApplyJournal(runId) ?? journalRow);
        return { ok: false, status: 500, code: "apply_failed", rolledBack: outcome === "rolled_back" };
      }
      // The success transaction has committed: the outcome is `applied` from here on and no file is ever touched again. A failing runtime
      // revocation is reported, never rolled back; every older scope is already fenced by the committed generation bump.
      let revocationPending = false;
      try { options.onBindingAdvanced?.(advanced.revokedNativeSessionIds); }
      catch { revocationPending = true; try { store.appendEnrichmentEvent(runId, "revocation_pending", "Runtime revocation failed after the apply committed; older scopes are fenced by the new generation."); } catch { /* evidence is best effort */ } }
      return { ok: true, status: 200, code: "applied", receipt: store.getEnrichmentApplyJournal(runId)!.receipt as ApplyReceipt, ...(revocationPending ? { revocationPending } : {}) };
    },

    discard(runId) {
      const run = store.getEnrichmentRun(runId);
      if (!run) return refused("run_not_found", 404);
      if (run.backend !== "openshell") return refused("not_openshell");
      if (run.status !== "awaiting_decision" && run.status !== "validation_failed") return refused("not_discardable");
      return store.applyTransaction((): ApplyOutcome => {
        if (!store.transitionEnrichmentRunFenced({ runId, from: ["awaiting_decision", "validation_failed"], to: "discarded", operationState: "skipped", decision: "skip", event: { kind: "discarded", message: "The reviewed change set was discarded; no project file was written." } })) return refused("not_discardable");
        store.burnEnrichmentApplyCapability(runId, "discarded", iso());
        return { ok: true, status: 200, code: "discarded" };
      });
    },

    recoverRun(runId) {
      const row = store.getEnrichmentApplyJournal(runId);
      return row ? rollback(row) : "unchanged";
    },

    recover() {
      let rolledBack = 0, reconcileRequired = 0;
      for (const row of store.listEnrichmentApplyJournals(["applying"])) {
        const result = rollback(row);
        if (result === "rolled_back") rolledBack++; else if (result === "reconcile_required") reconcileRequired++;
      }
      return { rolledBack, reconcileRequired };
    },
  };
}
