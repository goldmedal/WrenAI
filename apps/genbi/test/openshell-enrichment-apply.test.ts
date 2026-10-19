import { createHash } from "node:crypto";
import { existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../server/app.js";
import { Store } from "../server/db.js";
import { createOpenShellEnrichmentApplier, SimulatedApplyCrash, type ApplyOutcome, type EnrichmentApplier } from "../server/enrichment-apply.js";
import { buildCandidate, buildReviewDiff, changeSetSha256 } from "../server/enrichment-candidate.js";
import { canonicalizeProposal, resolveEnrichmentBinding, type EnrichmentBinding } from "../server/enrichment.js";
import type { ValidatedReview } from "../server/enrichment-validation.js";
import { DockerSnapshotDriver, SNAPSHOT_HELPER_PATH, snapshotHash } from "../server/runtime-host/openshell-snapshot-driver.js";
import { snapshotSourceAuthority } from "../server/runtime-host/openshell-project-snapshots.js";
import type { OpenShellConfiguration } from "../server/runtime-host/openshell-driver.js";
import type { TurnDeps } from "../server/turn.js";

const dirs: string[] = [];
const stores: Store[] = [];
afterEach(() => { while (stores.length) stores.pop()!.close(); while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const MODEL = "name: orders\nproperties:\n  description: One row per order.\nprimary_key: id\ncolumns:\n  - name: id\n    type: INTEGER\n  - name: amount\n    type: DOUBLE\n";
const MODEL_AFTER = MODEL.replace("One row per order.", "One row per order. Amount in USD.");
const DESCRIBED = MODEL.replace("  description: One row per order.", "  description: \"One row per order. Amount in USD.\"");
const RULE = "Revenue is net of refunds.\n";
const RELATIONSHIPS = "relationships:\n  - name: orders_customer\n    models: [orders, customers]\n";
const OLD_MDL = '{"models":[{"name":"orders"}]}';
const NEW_MDL = JSON.stringify({ models: [{ name: "orders", properties: { description: "One row per order. Amount in USD." } }] }, null, 2);
const APPROVED = ["data/input.txt", "knowledge/rules/revenue.md", "models/orders/metadata.yml", "relationships.yml", "target/mdl.json", "wren_project.yml"];

/** Every file under a directory with its sha256: equal maps mean byte-identical trees (no extra, no missing). */
function treeHash(root: string): string {
  const out: string[] = [];
  const walk = (directory: string, prefix: string) => {
    for (const name of readdirSync(directory).sort()) {
      const absolute = path.join(directory, name); const info = lstatSync(absolute);
      if (info.isSymbolicLink()) out.push(`${prefix}${name} -> link`);
      else if (info.isDirectory()) walk(absolute, `${prefix}${name}/`);
      else out.push(`${prefix}${name} ${sha(readFileSync(absolute))}`);
    }
  };
  walk(root, ""); return out.join("\n");
}

interface Options { operations?: unknown[]; extraFiles?: Record<string, string>; ttlMs?: number; fault?: Parameters<typeof createOpenShellEnrichmentApplier>[0]["fault"]; approved?: string[]; reviewEdit?: (review: ValidatedReview) => ValidatedReview; onAdvanced?: (ids: readonly string[]) => void }
function fixture(options: Options = {}) {
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), "genbi-apply-"))); dirs.push(base);
  const project = path.join(base, "project");
  for (const directory of ["target", "data", "knowledge/rules", "models/orders"]) mkdirSync(path.join(project, directory), { recursive: true });
  writeFileSync(path.join(project, "wren_project.yml"), "schema_version: 5\nname: demo\ndata_source: duckdb\n");
  writeFileSync(path.join(project, "target/mdl.json"), OLD_MDL); writeFileSync(path.join(project, "data/input.txt"), "synthetic rows");
  writeFileSync(path.join(project, "knowledge/rules/revenue.md"), RULE); writeFileSync(path.join(project, "models/orders/metadata.yml"), MODEL); writeFileSync(path.join(project, "relationships.yml"), RELATIONSHIPS);
  for (const [name, text] of Object.entries(options.extraFiles ?? {})) { mkdirSync(path.dirname(path.join(project, name)), { recursive: true }); writeFileSync(path.join(project, name), text); }
  const dbPath = path.join(base, "genbi.db");
  const openStore = () => { const store = new Store(dbPath); stores.push(store); return store; };
  const store = openStore();
  const bind = () => store.activateEnrichmentBinding(resolveEnrichmentBinding(project));
  const binding = bind();
  const clock = { value: Date.parse("2026-10-16T00:00:00Z") };
  const account = { value: "account-A" as string | undefined };
  const advanced = vi.fn();
  const approved = options.approved ?? APPROVED;
  const current = (s: Store): EnrichmentBinding | undefined => { const stored = s.getEnrichmentBinding(); if (!stored) return undefined; return { ...resolveEnrichmentBinding(project), generation: stored.generation }; };
  const applierFor = (s: Store, fault?: Options["fault"]): EnrichmentApplier => createOpenShellEnrichmentApplier({ store: s, getBinding: () => current(s), account: () => account.value,
    inventory: () => ({ approvedFiles: approved, preserveProjectConfig: true }), onBindingAdvanced: (ids) => { advanced(ids); options.onAdvanced?.(ids); }, now: () => clock.value, ...(options.ttlMs ? { ttlMs: options.ttlMs } : {}), ...(fault ? { fault } : {}) });
  const applier = applierFor(store, options.fault);

  const read = (relative: string) => { try { return readFileSync(path.join(project, relative)); } catch { return undefined; } };
  /** A validated run exactly as the validator route settles it, built from the real project bytes. */
  const makeRun = (id: string, operations: unknown[] = options.operations ?? [
    { sink: "knowledge/rules/revenue.md", changeKind: "knowledge_append", summary: "Refunds", draft: "Refunds are excluded." },
    { sink: "models/orders/metadata.yml", changeKind: "mdl_metric", summary: "Describe orders", draft: MODEL_AFTER },
  ], validate = true) => {
    const created = store.createDraftingEnrichmentRun({ id, mode: "grill", binding: current(store)!, backend: "openshell" });
    const proposal = canonicalizeProposal({ operations }, created.projectRevision);
    store.finalizeEnrichmentDraft({ runId: id, expectedVersion: created.version, proposalId: proposal.id, proposalHash: proposal.hash, operations: proposal.operations, pendingValidation: true });
    const pending = store.getEnrichmentRun(id)!;
    if (!validate) return pending;
    const built = buildCandidate(proposal, (relative) => read(relative));
    if (!built.ok) throw new Error(`fixture candidate refused: ${built.failure.code}`);
    const { diff, diffSha256 } = buildReviewDiff(built.files);
    const manifestFiles = approved.map((name) => { const bytes = read(name)!; return { path: `project/${name}`, size: bytes.length, sha256: sha(bytes) }; })
      .concat([{ path: "wren-home/profiles.yml", size: 3, sha256: sha("x\n\n") }]).sort((a, b) => (a.path < b.path ? -1 : 1));
    const live = current(store)!;
    let review: ValidatedReview = { version: 1, account: "account-A", binding: { generation: live.generation, revision: live.revision, projectIdentity: live.identity },
      snapshot: { digest: `sha256:${sha("snapshot")}`, project: `sha256:${sha("project")}`, bindingGeneration: String(live.generation), bindingRevision: live.revision, context: `sha256:${sha("context")}`, files: manifestFiles },
      diff, diffSha256, mdlContent: NEW_MDL, receipt: { image: `sha256:${sha("i")}`, policy: `sha256:${sha("p")}`, script: `sha256:${sha("s")}`, wheel: `sha256:${sha("w")}`, toolchain: `sha256:${sha("t")}`, architecture: "linux-arm64", protocol: "genbi-validate/1",
        checks: [], mdl: { sha256: sha(NEW_MDL), size: Buffer.byteLength(NEW_MDL) }, changeSetSha256: changeSetSha256(built.files.map((file) => ({ path: file.path, content: file.after }))) } };
    if (options.reviewEdit) review = options.reviewEdit(review);
    expect(store.settleEnrichmentValidation({ runId: id, expectedVersion: pending.version, outcome: { kind: "validated", review } })).toBe(true);
    return store.getEnrichmentRun(id)!;
  };
  const mint = (runId: string, a: EnrichmentApplier = applier): { capability: string; reviewSha256: string } => {
    const outcome = a.mint(runId);
    if (!outcome.ok) throw new Error(`mint refused: ${outcome.code}`);
    return { capability: outcome.capability!, reviewSha256: outcome.reviewSha256! };
  };
  const status = (runId: string) => store.getEnrichmentRun(runId)!.status;
  return { base, project, dbPath, store, openStore, bind, binding, clock, account, advanced, applier, applierFor, makeRun, mint, status, read, current: () => current(store)! };
}
type Fixture = ReturnType<typeof fixture>;
const refusedWith = (outcome: ApplyOutcome, code: string) => { expect(outcome).toMatchObject({ ok: false, code }); };
const applyWith = (f: Fixture, runId: string, token: { capability: string; reviewSha256: string }) => f.applier.apply(runId, token);

describe("S3-1: validated run -> mint -> Apply", () => {
  it("writes exactly the reviewed bytes plus the validator MDL, bumps the generation, revokes native sessions and rejects the old capability", () => {
    const f = fixture(); const run = f.makeRun("run-1");
    const session = f.store.createNativeSession({ id: "native-session-1", purpose: "analysis", vendor: "claude", agent: "a", scopeKind: "bound_project", scopeId: "s", projectIdentity: f.binding.identity, bindingGeneration: f.binding.generation, projectRevision: f.binding.revision });
    const other = f.makeRun("run-other");   // a second validated review, bound to the generation Apply is about to retire
    const staleCapability = f.mint("run-other");
    const token = f.mint(run.id);
    const outcome = applyWith(f, run.id, token);
    expect(outcome).toMatchObject({ ok: true, code: "applied" });
    expect(readFileSync(path.join(f.project, "knowledge/rules/revenue.md"), "utf8")).toBe(`${RULE}Refunds are excluded.\n`);
    expect(readFileSync(path.join(f.project, "models/orders/metadata.yml"), "utf8")).toBe(MODEL_AFTER);
    const mdl = readFileSync(path.join(f.project, "target/mdl.json"), "utf8");
    expect(mdl).toBe(NEW_MDL); expect(sha(mdl)).toBe(f.store.getEnrichmentValidation(run.id) && (f.store.getEnrichmentValidation(run.id) as { review: ValidatedReview }).review.receipt.mdl.sha256);
    expect(readFileSync(path.join(f.project, "data/input.txt"), "utf8")).toBe("synthetic rows");
    expect(readdirSync(path.join(f.project, "models/orders"))).toEqual(["metadata.yml"]); // no temp file left behind
    // New revision/generation, native sessions revoked in the same transaction, capabilities dropped.
    const advanced = f.store.getEnrichmentBinding()!;
    expect(advanced.generation).toBe(f.binding.generation + 1); expect(advanced.revision).toBe(resolveEnrichmentBinding(f.project).revision); expect(advanced.revision).not.toBe(f.binding.revision);
    expect(f.store.getNativeSession(session.id)).toMatchObject({ status: "stopped" });
    expect(f.advanced).toHaveBeenCalledWith(["native-session-1"]);
    expect(f.status(run.id)).toBe("applied");
    expect(f.store.listEnrichmentOperations(run.id).map((operation) => [operation.state, operation.completed])).toEqual([["applied", true], ["applied", true]]);
    expect(f.store.getEnrichmentApplyJournal(run.id)).toMatchObject({ state: "applied", receipt: { version: 1, binding: { generation: advanced.generation }, previousBinding: { generation: f.binding.generation }, mdl: { written: true } } });
    // The capability is spent; the other review's still-unspent capability cannot be used on the retired generation.
    expect(f.store.getEnrichmentApplyCapability(run.id)).toMatchObject({ consumedOutcome: "used" });
    const tree = treeHash(f.project);
    refusedWith(applyWith(f, other.id, staleCapability), "binding_changed");
    expect(f.status(other.id)).toBe("apply_refused"); expect(treeHash(f.project)).toBe(tree);
    refusedWith(f.applier.mint(other.id), "run_not_appliable");
  });
  it("a description_append run goes from pending through the validator stand-in and review to Apply, writing exactly the reviewed bytes", () => {
    const f = fixture({ operations: [{ sink: "models/orders/metadata.yml", changeKind: "description_append", summary: "Describe orders", draft: "description: \"Amount in USD.\"\n" }] });
    const run = f.makeRun("run-description", undefined, false);
    expect(run.status).toBe("validation_pending");
    expect(f.store.listEnrichmentOperations(run.id)).toMatchObject([{ changeKind: "description_append", state: "validation_pending" }]);
    const validated = f.makeRun("run-description-validated");
    expect(validated.status).toBe("awaiting_decision");
    const outcome = applyWith(f, validated.id, f.mint(validated.id));
    expect(outcome).toMatchObject({ ok: true, code: "applied" });
    expect(readFileSync(path.join(f.project, "models/orders/metadata.yml"), "utf8")).toBe(DESCRIBED);
    expect(f.store.listEnrichmentOperations(validated.id).map((operation) => [operation.changeKind, operation.state, operation.completed])).toEqual([["description_append", "applied", true]]);
  });
  it("skips the MDL write when the receipt's MDL already is the current file", () => {
    const f = fixture(); writeFileSync(path.join(f.project, "target/mdl.json"), NEW_MDL); f.bind();
    const run = f.makeRun("run-same-mdl");
    const outcome = applyWith(f, run.id, f.mint(run.id));
    expect(outcome).toMatchObject({ ok: true, receipt: { mdl: { written: false } } });
    expect(f.store.getEnrichmentApplyJournal(run.id)!.files.map((file) => file.path)).toEqual(["knowledge/rules/revenue.md", "models/orders/metadata.yml"]);
  });
  const python = process.env.GENBI_SNAPSHOT_CAPTURE_PYTHON;
  it.skipIf(!python)("a fresh snapshot capture after Apply includes the new bytes and the exact approved tree", async () => {
    const f = fixture();
    const run = f.makeRun("run-capture"); expect(applyWith(f, run.id, f.mint(run.id))).toMatchObject({ ok: true });
    const executable = realpathSync(python!); const docker = realpathSync("/bin/echo"); const digest = `sha256:${"a".repeat(64)}`;
    const config: OpenShellConfiguration = { executable: docker, executableDigest: snapshotHash(readFileSync(docker)), version: "0.0.1", gateway: "gateway", workspace: "default", image: digest, supervisorImage: digest, policy: SNAPSHOT_HELPER_PATH,
      policyDigest: snapshotHash(readFileSync(SNAPSHOT_HELPER_PATH)), home: "/private/tmp", configHome: "/private/tmp", stateHome: "/private/tmp", dockerExecutable: docker, dockerRealpath: docker, dockerDigest: snapshotHash(readFileSync(docker)),
      dockerSocket: "/private/tmp/none.sock", dockerNamespace: "fixture", exclusive: true, dataPolicy: SNAPSHOT_HELPER_PATH, dataPolicyDigest: snapshotHash(readFileSync(SNAPSHOT_HELPER_PATH)),
      snapshotCapture: { executable, realpath: executable, digest: snapshotHash(readFileSync(executable)), helperDigest: snapshotHash(readFileSync(SNAPSHOT_HELPER_PATH)), approvedFiles: APPROVED } } as unknown as OpenShellConfiguration;
    const authority = snapshotSourceAuthority({ store: f.store, currentProject: () => f.project, approvedFiles: config.snapshotCapture!.approvedFiles, currentContext: () => digest, preserveProjectConfig: true });
    const request = authority({ backend: "openshell", account: digest, generation: "1", session: "s", turn: "t", binding: digest, bindingGeneration: "x", bindingRevision: digest, context: digest, plan: digest } as never);
    expect(request).toBeDefined();
    const manifest = await new DockerSnapshotDriver(config).capture(request!, path.join(f.base, "after.tar"), new AbortController().signal);
    const entry = (name: string) => manifest.files.find((file) => file.path === `project/${name}`)?.sha256;
    expect(entry("knowledge/rules/revenue.md")).toBe(sha(`${RULE}Refunds are excluded.\n`)); expect(entry("models/orders/metadata.yml")).toBe(sha(MODEL_AFTER)); expect(entry("target/mdl.json")).toBe(sha(NEW_MDL));
    expect(manifest.bindingGeneration).toBe(String(f.store.getEnrichmentBinding()!.generation)); expect(manifest.bindingRevision).toBe(resolveEnrichmentBinding(f.project).revision);
  });
});

describe("S3-2: refusals leave the source byte-identical", () => {
  it("a wrong, forged or replayed capability, a wrong run and a wrong review hash", () => {
    const f = fixture(); const a = f.makeRun("run-a"); const b = f.makeRun("run-b");
    const tokenA = f.mint(a.id); const tokenB = f.mint(b.id); const tree = treeHash(f.project);
    refusedWith(f.applier.apply(a.id, { capability: "forged-capability-0123456789", reviewSha256: tokenA.reviewSha256 }), "capability_invalid");
    refusedWith(f.applier.apply(a.id, { capability: 42, reviewSha256: tokenA.reviewSha256 }), "capability_invalid");
    refusedWith(f.applier.apply(a.id, tokenB), "capability_invalid");                                 // another run's capability
    expect(f.status(a.id)).toBe("awaiting_decision"); expect(f.store.getEnrichmentApplyCapability(a.id)!.consumedAt).toBeNull();
    refusedWith(f.applier.apply(a.id, { capability: tokenA.capability, reviewSha256: `sha256:${"0".repeat(64)}` }), "review_mismatch"); // valid capability, wrong review hash: spent
    expect(f.status(a.id)).toBe("awaiting_decision");
    refusedWith(f.applier.apply(a.id, tokenA), "capability_invalid");                                 // replay of the spent capability
    expect(treeHash(f.project)).toBe(tree);
    const fresh = f.mint(a.id);                                                                        // re-minting is explicit and works
    expect(applyWith(f, a.id, fresh)).toMatchObject({ ok: true });
  });
  it("re-minting invalidates the previous capability", () => {
    const f = fixture(); const run = f.makeRun("run-remint"); const first = f.mint(run.id); const second = f.mint(run.id); const tree = treeHash(f.project);
    refusedWith(applyWith(f, run.id, first), "capability_invalid"); expect(treeHash(f.project)).toBe(tree);
    expect(applyWith(f, run.id, second)).toMatchObject({ ok: true });
  });
  it("an expired capability (TTL <= 15 minutes) is refused and burned", () => {
    const f = fixture({ ttlMs: 60 * 60_000 }); const run = f.makeRun("run-ttl"); const token = f.mint(run.id); const tree = treeHash(f.project);
    const row = f.store.getEnrichmentApplyCapability(run.id)!; expect(Date.parse(row.expiresAt) - Date.parse(row.mintedAt)).toBe(15 * 60_000);
    f.clock.value += 15 * 60_000 + 1;
    refusedWith(applyWith(f, run.id, token), "capability_expired");
    expect(f.store.getEnrichmentApplyCapability(run.id)).toMatchObject({ consumedOutcome: "expired" }); expect(treeHash(f.project)).toBe(tree); expect(f.status(run.id)).toBe("awaiting_decision");
  });
  it("only the hash of the token is stored, and the token has at least 128 bits", () => {
    const f = fixture(); const run = f.makeRun("run-hash"); const token = f.mint(run.id);
    const row = f.store.getEnrichmentApplyCapability(run.id)!; expect(row.tokenHash).toBe(sha(token.capability)); expect(JSON.stringify(row)).not.toContain(token.capability);
    expect(Buffer.from(token.capability, "base64url").length).toBeGreaterThanOrEqual(16);
  });
  it("a binding change after mint ends apply_refused(binding_changed)", () => {
    const f = fixture(); const run = f.makeRun("run-binding"); const token = f.mint(run.id); f.bind(); const tree = treeHash(f.project);
    refusedWith(applyWith(f, run.id, token), "binding_changed"); expect(f.status(run.id)).toBe("apply_refused"); expect(treeHash(f.project)).toBe(tree);
    expect(f.store.listEnrichmentEvents(run.id).some((event) => event.kind === "apply_refused" && event.message === "binding_changed")).toBe(true);
    expect(f.store.getEnrichmentApplyJournal(run.id)).toBeUndefined();
  });
  it("an account change after mint ends apply_refused(account_changed), and mint itself refuses an unverified account", () => {
    const f = fixture(); const run = f.makeRun("run-account"); f.account.value = undefined; refusedWith(f.applier.mint(run.id), "account_changed"); f.account.value = "account-A";
    const token = f.mint(run.id); f.account.value = "account-B"; const tree = treeHash(f.project);
    refusedWith(applyWith(f, run.id, token), "account_changed"); expect(f.status(run.id)).toBe("apply_refused"); expect(treeHash(f.project)).toBe(tree);
  });
  it("a modified source file that is NOT in the change set is full-manifest drift", () => {
    const f = fixture(); const run = f.makeRun("run-drift"); const token = f.mint(run.id);
    writeFileSync(path.join(f.project, "data/input.txt"), "synthetic rows, changed after review"); const tree = treeHash(f.project);
    refusedWith(applyWith(f, run.id, token), "manifest_drift"); expect(f.status(run.id)).toBe("apply_refused"); expect(treeHash(f.project)).toBe(tree);
    expect(f.store.getEnrichmentApplyJournal(run.id)).toBeUndefined();
  });
  it("an extra file in the project tree is drift too (the governed snapshot would refuse it)", () => {
    const f = fixture(); const run = f.makeRun("run-extra"); const token = f.mint(run.id); writeFileSync(path.join(f.project, "stray.txt"), "x"); const tree = treeHash(f.project);
    refusedWith(applyWith(f, run.id, token), "manifest_drift"); expect(treeHash(f.project)).toBe(tree);
  });
  it("a target file changed since the review is refused", () => {
    const f = fixture(); const run = f.makeRun("run-target"); const token = f.mint(run.id);
    writeFileSync(path.join(f.project, "knowledge/rules/revenue.md"), `${RULE}Someone else added this.\n`); const tree = treeHash(f.project);
    refusedWith(applyWith(f, run.id, token), "manifest_drift"); expect(treeHash(f.project)).toBe(tree);
  });
  it("a manifest that matches the review but a target whose bytes differ from the recorded `before` is refused as target_changed", () => {
    // The review's own manifest is edited to the later bytes, so only the per-target before-bytes check can catch it.
    const later = `${RULE}Edited between draft and review.\n`;
    const f = fixture({ reviewEdit: (review) => ({ ...review, snapshot: { ...review.snapshot, files: review.snapshot.files.map((file) => (file.path === "project/knowledge/rules/revenue.md" ? { ...file, size: Buffer.byteLength(later), sha256: sha(later) } : file)) } }) });
    const run = f.makeRun("run-before"); writeFileSync(path.join(f.project, "knowledge/rules/revenue.md"), later); const token = f.mint(run.id); const tree = treeHash(f.project);
    refusedWith(applyWith(f, run.id, token), "target_changed"); expect(treeHash(f.project)).toBe(tree);
  });
  it.each(["ancestor", "leaf", "hardlink"] as const)("a %s swapped for a link is refused", (kind) => {
    const f = fixture(); const run = f.makeRun(`run-link-${kind}`); const token = f.mint(run.id); const outside = path.join(f.base, "outside"); mkdirSync(outside);
    if (kind === "ancestor") { renameSync(path.join(f.project, "knowledge"), path.join(outside, "knowledge")); symlinkSync(path.join(outside, "knowledge"), path.join(f.project, "knowledge")); }
    if (kind === "leaf") { writeFileSync(path.join(outside, "revenue.md"), RULE); rmSync(path.join(f.project, "knowledge/rules/revenue.md")); symlinkSync(path.join(outside, "revenue.md"), path.join(f.project, "knowledge/rules/revenue.md")); }
    if (kind === "hardlink") linkSync(path.join(f.project, "knowledge/rules/revenue.md"), path.join(outside, "alias.md"));
    const tree = treeHash(f.project); const outsideTree = treeHash(outside);
    const outcome = applyWith(f, run.id, token); expect(outcome).toMatchObject({ ok: false }); expect(["symlink", "manifest_drift"]).toContain((outcome as { code: string }).code);
    expect(treeHash(f.project)).toBe(tree); expect(treeHash(outside)).toBe(outsideTree);
  });
  it("discard then apply is refused and the capability is burned", () => {
    const f = fixture(); const run = f.makeRun("run-discard"); const token = f.mint(run.id); const tree = treeHash(f.project);
    expect(f.applier.discard(run.id)).toMatchObject({ ok: true, code: "discarded" });
    refusedWith(applyWith(f, run.id, token), "run_not_appliable"); refusedWith(f.applier.mint(run.id), "run_not_appliable"); expect(treeHash(f.project)).toBe(tree);
  });
  it("validation_failed and validation_pending runs cannot mint or apply", () => {
    const f = fixture(); const pending = f.makeRun("run-pending", undefined, false);
    refusedWith(f.applier.mint(pending.id), "run_not_appliable"); refusedWith(f.applier.apply(pending.id, { capability: "x".repeat(43), reviewSha256: "x" }), "run_not_appliable");
    const failed = f.makeRun("run-failed", undefined, false);
    expect(f.store.settleEnrichmentValidation({ runId: failed.id, expectedVersion: failed.version, outcome: { kind: "failed", failure: { version: 1, stage: "validator", code: "validator_failed", message: "no" } } })).toBe(true);
    refusedWith(f.applier.mint(failed.id), "run_not_appliable"); refusedWith(f.applier.apply(failed.id, { capability: "x".repeat(43), reviewSha256: "x" }), "run_not_appliable");
    // A forged capability row cannot make a failed run appliable.
    f.store.putEnrichmentApplyCapability({ runId: failed.id, tokenHash: sha("t".repeat(43)), reviewSha256: "x", changeSetSha256: "x", bindingPath: f.project, bindingIdentity: "x", bindingGeneration: 1, bindingRevision: "x", account: "account-A", mintedAt: "2026-10-16T00:00:00.000Z", expiresAt: "2999-01-01T00:00:00.000Z", consumedAt: null, consumedOutcome: null });
    refusedWith(f.applier.apply(failed.id, { capability: "t".repeat(43), reviewSha256: "x" }), "run_not_appliable");
  });
  it("a cancelled run is refused", () => {
    const f = fixture(); const run = f.makeRun("run-cancel"); const token = f.mint(run.id);
    expect(f.store.transitionEnrichmentRunFenced({ runId: run.id, from: ["awaiting_decision"], to: "cancelled", event: { kind: "cancelled", message: "cancelled" } })).toBe(true); const tree = treeHash(f.project);
    refusedWith(applyWith(f, run.id, token), "run_not_appliable"); expect(treeHash(f.project)).toBe(tree);
  });
  it("concurrent double apply: exactly one wins, the other is the idempotent receipt, and nothing is written twice", async () => {
    const f = fixture(); const run = f.makeRun("run-double"); const token = f.mint(run.id);
    const results = await Promise.all([Promise.resolve().then(() => applyWith(f, run.id, token)), Promise.resolve().then(() => applyWith(f, run.id, token))]);
    expect(results.every((result) => result.ok)).toBe(true);
    expect(results.filter((result) => result.ok && result.replay !== true)).toHaveLength(1); expect(results.filter((result) => result.ok && result.replay === true)).toHaveLength(1);
    expect(f.advanced).toHaveBeenCalledTimes(1); expect(f.store.getEnrichmentBinding()!.generation).toBe(f.binding.generation + 1);
    expect(f.store.listEnrichmentApplyJournals()).toHaveLength(1);
  });
  it("re-apply after success is idempotent: it returns the applied receipt and writes nothing", () => {
    const f = fixture(); const run = f.makeRun("run-idem"); const token = f.mint(run.id); const first = applyWith(f, run.id, token); expect(first).toMatchObject({ ok: true });
    const tree = treeHash(f.project); const generation = f.store.getEnrichmentBinding()!.generation;
    const again = applyWith(f, run.id, token); expect(again).toMatchObject({ ok: true, replay: true, receipt: (first as { receipt: unknown }).receipt });
    expect(applyWith(f, run.id, { capability: "q".repeat(43), reviewSha256: "x" })).toMatchObject({ ok: true, replay: true });
    expect(treeHash(f.project)).toBe(tree); expect(f.store.getEnrichmentBinding()!.generation).toBe(generation); expect(f.advanced).toHaveBeenCalledTimes(1);
  });
  it("re-checks the option-A scope as a precondition: a review naming a file the snapshot lacks, a cube or a created file is refused", () => {
    const ghostAfter = "ghost\n";
    for (const [name, sink] of [["ghost", "knowledge/rules/ghost.md"], ["cube", "cubes/metrics/metadata.yml"]] as const) {
      const f = fixture({ reviewEdit: (review) => {
        const entry = { path: sink, change: "modified" as const, beforeSha256: sha(""), afterSha256: sha(ghostAfter), before: "", after: ghostAfter, appended: ghostAfter };
        const { diffSha256 } = buildReviewDiff([entry]);
        return { ...review, diff: [entry], diffSha256, receipt: { ...review.receipt, changeSetSha256: changeSetSha256([{ path: sink, content: ghostAfter }]) } };
      } });
      const run = f.makeRun(`run-scope-${name}`); const token = f.mint(run.id); const tree = treeHash(f.project);
      refusedWith(applyWith(f, run.id, token), "unsupported_by_runtime"); expect(f.status(run.id)).toBe("apply_refused"); expect(treeHash(f.project)).toBe(tree); expect(existsSync(path.join(f.project, sink))).toBe(false);
    }
  });
  it("a review record whose diff no longer matches its digests is refused", () => {
    const f = fixture({ reviewEdit: (review) => ({ ...review, diff: review.diff.map((entry, index) => (index === 0 ? { ...entry, after: `${entry.after}tampered\n` } : entry)) }) });
    const run = f.makeRun("run-tamper"); const token = f.mint(run.id); const tree = treeHash(f.project);
    refusedWith(applyWith(f, run.id, token), "review_mismatch"); expect(treeHash(f.project)).toBe(tree);
  });
});

describe("S3-3: interruption, restart and recovery", () => {
  /** Simulates a kill after file `k` of the journal, then a new process on the same database. */
  function interrupt(k: number, options: Options = {}) {
    const f = fixture({ ...options, fault: ({ phase, index }) => (phase === "after_file" && index === k ? "crash" : undefined) });
    const run = f.makeRun("run-crash"); const token = f.mint(run.id); const before = treeHash(f.project);
    expect(() => applyWith(f, run.id, token)).toThrow(SimulatedApplyCrash);
    return { f, run, before };
  }
  const restart = (f: Fixture) => { const store = f.openStore(); return { store, applier: f.applierFor(store) }; };

  it.each([1, 2, 3])("a kill after file %i of 3 leaves the journal row and restart rolls everything back to the before bytes", (k) => {
    const { f, run, before } = interrupt(k);
    expect(f.status(run.id)).toBe("applying"); expect(f.store.getEnrichmentApplyJournal(run.id)).toMatchObject({ state: "applying" });
    expect(treeHash(f.project)).not.toBe(before);
    const { store, applier } = restart(f);
    expect(applier.recover()).toEqual({ rolledBack: 1, reconcileRequired: 0 });
    expect(treeHash(f.project)).toBe(before);
    expect(store.getEnrichmentRun(run.id)!.status).toBe("apply_failed");
    expect(store.getEnrichmentApplyJournal(run.id)).toMatchObject({ state: "rolled_back", evidence: "rolled_back" });
    expect(store.listEnrichmentEvents(run.id).map((event) => event.kind)).toEqual(expect.arrayContaining(["applying", "apply_failed"]));
    expect(store.getEnrichmentBinding()!.generation).toBe(f.binding.generation);          // the binding never advanced
    expect(applier.recover()).toEqual({ rolledBack: 0, reconcileRequired: 0 });            // idempotent
    expect(readdirSync(path.join(f.project, "knowledge/rules"))).toEqual(["revenue.md"]);
  });
  it("a file with a third hash goes to reconcile_required, is left untouched, keeps its evidence and blocks further OpenShell apply on the project", () => {
    const { f, run } = interrupt(1);
    writeFileSync(path.join(f.project, "knowledge/rules/revenue.md"), "somebody else wrote this\n");
    const { store, applier } = restart(f); const tree = treeHash(f.project);
    expect(applier.recover()).toEqual({ rolledBack: 0, reconcileRequired: 1 });
    expect(treeHash(f.project)).toBe(tree);
    expect(store.getEnrichmentRun(run.id)!.status).toBe("reconcile_required");
    expect(store.getEnrichmentApplyJournal(run.id)).toMatchObject({ state: "reconcile_required", evidence: "third_hash" });
    expect(store.listEnrichmentApplyJournals().map((row) => row.state)).toEqual(["reconcile_required"]);
    expect(store.listEnrichmentOperations(run.id).every((operation) => operation.state === "reconcile_required")).toBe(true);
    // A different validated run on the same project can neither mint nor apply until an operator resolves it.
    const next = f.makeRun("run-next"); refusedWith(f.applier.mint(next.id), "reconcile_required");
    expect(applier.mint(next.id)).toMatchObject({ ok: false, code: "reconcile_required" });
    // The documented operator resolution: restore the files, then mark the row resolved.
    store.settleEnrichmentApplyJournal(run.id, "resolved", "operator");
    expect(applier.mint(next.id)).toMatchObject({ ok: true });
  });
  it("an apply that has not been recovered yet blocks a new apply instead of racing it", () => {
    const { f } = interrupt(1); const next = f.makeRun("run-after-crash");
    refusedWith(f.applier.mint(next.id), "recovery_pending");
  });
  it("an in-process failure after file k rolls back the same way and ends apply_failed", () => {
    const f = fixture({ fault: ({ phase, index }) => { if (phase === "after_file" && index === 1) throw new Error("disk went away"); } });
    const run = f.makeRun("run-inproc"); const token = f.mint(run.id); const before = treeHash(f.project);
    expect(applyWith(f, run.id, token)).toMatchObject({ ok: false, code: "apply_failed", rolledBack: true });
    expect(treeHash(f.project)).toBe(before); expect(f.status(run.id)).toBe("apply_failed");
    expect(f.store.getEnrichmentApplyJournal(run.id)).toMatchObject({ state: "rolled_back" }); expect(f.store.getEnrichmentBinding()!.generation).toBe(f.binding.generation);
    expect(f.advanced).not.toHaveBeenCalled();
  });
  it("an in-process failure with a third hash on a written file stops at reconcile_required instead of overwriting it", () => {
    let f!: Fixture;
    f = fixture({ fault: ({ phase, index }) => { if (phase === "after_file" && index === 1) { writeFileSync(path.join(f.project, "knowledge/rules/revenue.md"), "concurrent writer\n"); throw new Error("boom"); } } });
    const run = f.makeRun("run-inproc-third"); const token = f.mint(run.id);
    expect(applyWith(f, run.id, token)).toMatchObject({ ok: false, code: "apply_failed", rolledBack: false });
    expect(readFileSync(path.join(f.project, "knowledge/rules/revenue.md"), "utf8")).toBe("concurrent writer\n");
    expect(f.status(run.id)).toBe("reconcile_required"); expect(f.store.getEnrichmentApplyJournal(run.id)).toMatchObject({ state: "reconcile_required" });
  });
  it("recovery removes a leftover temp file the interrupted apply created", () => {
    const { f, before } = interrupt(1); const leftover = path.join(f.project, "models/orders", `.genbi-apply-${sha("run-crash").slice(0, 12)}-1.tmp`);
    writeFileSync(leftover, "partial");
    const { applier } = restart(f); applier.recover();
    expect(existsSync(leftover)).toBe(false); expect(treeHash(f.project)).toBe(before);
  });
  it("the journal row exists (with the before bytes) before the first temp file or rename, and every file is still untouched at that point", () => {
    const seen: { index: number; state?: string; names: string[]; tree: string }[] = []; let storeRef!: Store; let projectRef = ""; let before = "";
    const f = fixture({ fault: ({ phase, index }) => { if (phase === "before_file") seen.push({ index, ...(storeRef.getEnrichmentApplyJournal("run-j") ? { state: storeRef.getEnrichmentApplyJournal("run-j")!.state } : {}), names: readdirSync(path.join(projectRef, "models/orders")), tree: index === 0 ? treeHash(projectRef) : "" }); } });
    storeRef = f.store; projectRef = f.project; const run = f.makeRun("run-j"); before = treeHash(f.project); applyWith(f, run.id, f.mint(run.id));
    expect(seen.map((entry) => entry.index)).toEqual([0, 1, 2]);
    expect(seen.every((entry) => entry.state === "applying")).toBe(true);
    expect(seen[0]!.tree).toBe(before); expect(seen[0]!.names).toEqual(["metadata.yml"]);
    const journal = f.store.getEnrichmentApplyJournal(run.id)!;
    expect(journal.files.map((file) => [file.path, Buffer.from(file.before, "base64").toString("utf8")])).toEqual([["knowledge/rules/revenue.md", RULE], ["models/orders/metadata.yml", MODEL], ["target/mdl.json", OLD_MDL]]);
  });
  it("recovery removes a stale temp for a file it must restore (a kill in the middle of an earlier rollback) and still rolls back", () => {
    const { f, before } = interrupt(1);
    const stale = path.join(f.project, "knowledge/rules", `.genbi-apply-${sha("run-crash").slice(0, 12)}-0.tmp`); writeFileSync(stale, "partial restore");
    const { store, applier } = restart(f);
    expect(applier.recover()).toEqual({ rolledBack: 1, reconcileRequired: 0 });
    expect(existsSync(stale)).toBe(false); expect(treeHash(f.project)).toBe(before); expect(store.getEnrichmentApplyJournal("run-crash")).toMatchObject({ state: "rolled_back" });
  });
  it("a temp left by a third-hash stop is removed too (only the exact run-derived names), so the governed snapshot tree stays clean", () => {
    const { f } = interrupt(1); writeFileSync(path.join(f.project, "knowledge/rules/revenue.md"), "somebody else wrote this\n");
    const mine = path.join(f.project, "models/orders", `.genbi-apply-${sha("run-crash").slice(0, 12)}-1.tmp`); const foreign = path.join(f.project, "models/orders", ".genbi-apply-other.tmp"); writeFileSync(mine, "x"); writeFileSync(foreign, "y");
    const { applier } = restart(f); expect(applier.recover()).toEqual({ rolledBack: 0, reconcileRequired: 1 });
    expect(existsSync(mine)).toBe(false); expect(existsSync(foreign)).toBe(true);
  });
});

describe("fix round 1: nothing after the success commit may touch the files", () => {
  it("B1: a runtime revocation that throws after the commit still reports applied, keeps the after-bytes and never rolls back", () => {
    const f = fixture({ onAdvanced: () => { throw new Error("revokeRuntime failed"); } }); const run = f.makeRun("run-b1"); const token = f.mint(run.id);
    const outcome = applyWith(f, run.id, token);
    expect(outcome).toMatchObject({ ok: true, status: 200, code: "applied", revocationPending: true, receipt: { version: 1 } });
    expect(readFileSync(path.join(f.project, "knowledge/rules/revenue.md"), "utf8")).toBe(`${RULE}Refunds are excluded.\n`);
    expect(readFileSync(path.join(f.project, "models/orders/metadata.yml"), "utf8")).toBe(MODEL_AFTER); expect(readFileSync(path.join(f.project, "target/mdl.json"), "utf8")).toBe(NEW_MDL);
    expect(f.status(run.id)).toBe("applied"); expect(f.store.getEnrichmentApplyJournal(run.id)).toMatchObject({ state: "applied" });
    expect(f.store.getEnrichmentBinding()!.generation).toBe(f.binding.generation + 1);
    expect(f.store.listEnrichmentEvents(run.id).some((event) => event.kind === "revocation_pending")).toBe(true);
    // The disk and the ledger agree, so the idempotent re-apply returns a true receipt.
    const tree = treeHash(f.project);
    expect(applyWith(f, run.id, token)).toMatchObject({ ok: true, replay: true }); expect(treeHash(f.project)).toBe(tree);
    expect(f.applier.recover()).toEqual({ rolledBack: 0, reconcileRequired: 0 }); expect(treeHash(f.project)).toBe(tree);
  });
  it("B1 over HTTP: the route answers 200 with the receipt and revocationPending", async () => {
    const f = fixture({ onAdvanced: () => { throw new Error("revokeRuntime failed"); } }); const run = f.makeRun("run-b1-http"); const token = f.mint(run.id);
    const a = createApp({ store: f.store, baseRouteOptions: { authChoice: { mode: "subscription", provider: "claude" }, profileSource: "fixture", userProject: f.project }, route: async () => { throw Error("unused"); }, openShellEnrichmentApply: f.applier } as unknown as TurnDeps);
    const response = await a.request(`/api/context/enrichment/${run.id}/apply`, { method: "POST", body: JSON.stringify(token) });
    expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ code: "applied", revocationPending: true, receipt: { version: 1 }, run: { status: "applied" } });
  });
  it("rollback acts only on an `applying` row: an applied, rolled-back or reconcile_required row is returned as it is and no file is touched", () => {
    const f = fixture(); const applied = f.makeRun("run-final"); expect(applyWith(f, applied.id, f.mint(applied.id))).toMatchObject({ ok: true });
    const tree = treeHash(f.project);
    expect(f.applier.recoverRun(applied.id)).toBe("unchanged"); expect(f.applier.recoverRun("no-such-run")).toBe("unchanged"); expect(treeHash(f.project)).toBe(tree);
    expect(f.store.getEnrichmentApplyJournal(applied.id)).toMatchObject({ state: "applied" }); expect(f.status(applied.id)).toBe("applied");
    // A forged "applied" journal state on an in-flight-looking row of another run still never restores anything.
    for (const state of ["rolled_back", "reconcile_required"] as const) {
      const g = fixture({ fault: ({ phase, index }) => (phase === "after_file" && index === 1 ? "crash" : undefined) }); const run = g.makeRun("run-state"); const token = g.mint(run.id);
      expect(() => applyWith(g, run.id, token)).toThrow(SimulatedApplyCrash);
      g.store.settleEnrichmentApplyJournal(run.id, state, "test"); const mid = treeHash(g.project);
      expect(g.applier.recoverRun(run.id)).toBe(state); expect(treeHash(g.project)).toBe(mid);
    }
  });
});

describe("S3-7: Discard", () => {
  it("is terminal, burns the capability and writes nothing", () => {
    const f = fixture(); const run = f.makeRun("run-d"); const token = f.mint(run.id); const tree = treeHash(f.project); const generation = f.store.getEnrichmentBinding()!.generation;
    expect(f.applier.discard(run.id)).toMatchObject({ ok: true, code: "discarded" });
    expect(f.status(run.id)).toBe("discarded"); expect(f.store.getEnrichmentApplyCapability(run.id)).toMatchObject({ consumedOutcome: "discarded" });
    expect(f.store.listEnrichmentOperations(run.id).every((operation) => operation.state === "skipped" && operation.decision === "skip")).toBe(true);
    expect(treeHash(f.project)).toBe(tree); expect(f.store.getEnrichmentBinding()!.generation).toBe(generation); expect(f.store.getEnrichmentApplyJournal(run.id)).toBeUndefined();
    refusedWith(applyWith(f, run.id, token), "run_not_appliable"); refusedWith(f.applier.discard(run.id), "not_discardable");
  });
  it("a validation_failed run can be discarded; an applied run cannot", () => {
    const f = fixture(); const failed = f.makeRun("run-vf", undefined, false);
    expect(f.store.settleEnrichmentValidation({ runId: failed.id, expectedVersion: failed.version, outcome: { kind: "failed", failure: { version: 1, stage: "host", code: "unsupported_by_runtime", message: "no" } } })).toBe(true);
    expect(f.applier.discard(failed.id)).toMatchObject({ ok: true }); expect(f.status(failed.id)).toBe("discarded");
    const run = f.makeRun("run-applied"); expect(applyWith(f, run.id, f.mint(run.id))).toMatchObject({ ok: true });
    refusedWith(f.applier.discard(run.id), "not_discardable"); expect(f.status(run.id)).toBe("applied");
    refusedWith(f.applier.discard("missing"), "run_not_found");
    const pending = f.makeRun("run-pending-d", undefined, false); refusedWith(f.applier.discard(pending.id), "not_discardable");
  });
});

describe("routes: authorize, apply, discard (and the per-operation flow stays closed)", () => {
  function app(f: Fixture) {
    const deps = { store: f.store, baseRouteOptions: { authChoice: { mode: "subscription", provider: "claude" }, profileSource: "fixture", userProject: f.project }, route: async () => { throw Error("unused"); },
      openShellEnrichmentApply: f.applier } as unknown as TurnDeps;
    return createApp(deps);
  }
  const post = (a: ReturnType<typeof app>, route: string, body: unknown = {}) => a.request(`/api/context/enrichment/${route}`, { method: "POST", body: JSON.stringify(body) });
  it("mints once over HTTP, applies with it, and never leaks the capability or source bytes through the run DTO", async () => {
    const f = fixture(); const run = f.makeRun("run-http"); const a = app(f);
    const minted = await post(a, `${run.id}/apply/authorize`); expect(minted.status).toBe(201); expect(minted.headers.get("cache-control")).toBe("no-store");
    const token = await minted.json() as { capability: string; reviewSha256: string; expiresAt: string; run: unknown };
    expect(JSON.stringify(token.run)).not.toContain(token.capability);
    const dto = await (await a.request(`/api/context/enrichment/${run.id}`)).json(); expect(JSON.stringify(dto)).not.toContain(token.capability); expect(dto).not.toHaveProperty("review.mdlContent");
    expect(dto).toMatchObject({ review: { diffSha256: token.reviewSha256 } });
    const bad = await post(a, `${run.id}/apply`, { capability: "x".repeat(43), reviewSha256: token.reviewSha256 }); expect(bad.status).toBe(403); expect(await bad.json()).toMatchObject({ code: "capability_invalid" });
    const applied = await post(a, `${run.id}/apply`, { capability: token.capability, reviewSha256: token.reviewSha256 }); expect(applied.status).toBe(200);
    expect(await applied.json()).toMatchObject({ code: "applied", run: { status: "applied", apply: { state: "applied", receipt: { version: 1 } } } });
    const replay = await post(a, `${run.id}/apply`, { capability: token.capability, reviewSha256: token.reviewSha256 }); expect(replay.status).toBe(200); expect(await replay.json()).toMatchObject({ replay: true });
  });
  it("S4-4: the status poll keeps showing the applied run with its receipt, while the older-generation run stays refused", async () => {
    const f = fixture(); const older = f.makeRun("run-older"); const latest = f.makeRun("run-latest"); const a = app(f);
    const olderToken = f.mint(older.id);
    const minted = await (await post(a, `${latest.id}/apply/authorize`)).json() as { capability: string; reviewSha256: string };
    const before = await (await a.request("/api/context/enrichment")).json() as { backend: string; run?: { id: string; status: string } };
    expect(before.backend).toBe("local"); expect(before.run).toMatchObject({ id: latest.id, status: "awaiting_decision" });
    expect((await post(a, `${latest.id}/apply`, { capability: minted.capability, reviewSha256: minted.reviewSha256 })).status).toBe(200);
    const after = await (await a.request("/api/context/enrichment")).json() as { run?: { id: string; status: string; apply?: { state: string; receipt?: { version: number; files: unknown[] } }; events: { kind: string }[] } };
    expect(after.run).toMatchObject({ id: latest.id, status: "applied", apply: { state: "applied", receipt: { version: 1 } } });
    expect(after.run!.apply!.receipt!.files.length).toBeGreaterThan(0); expect(JSON.stringify(after)).not.toContain(minted.capability);
    // Visibility is read-only: the run that was minted against the old generation is still refused, and is not shown by the poll.
    const refused = await post(a, `${older.id}/apply`, olderToken);
    expect(refused.status).toBeGreaterThanOrEqual(400); expect(f.status(older.id)).not.toBe("applied");
    expect((await post(a, `${older.id}/apply/authorize`)).status).toBeGreaterThanOrEqual(400);
    // Once the binding moves on again the applied run is no longer the active one.
    f.store.activateEnrichmentBinding(f.current());
    const moved = await (await a.request("/api/context/enrichment")).json() as { run?: unknown }; expect(moved.run).toBeUndefined();
  });
  it("discard over HTTP, and 503 when the apply host is not configured", async () => {
    const f = fixture(); const run = f.makeRun("run-http-d"); const a = app(f);
    const discarded = await post(a, `${run.id}/discard`); expect(discarded.status).toBe(200); expect(await discarded.json()).toMatchObject({ code: "discarded", run: { status: "discarded" } });
    expect((await post(a, `${run.id}/discard`)).status).toBe(409);
    const bare = createApp({ store: f.store, baseRouteOptions: { authChoice: { mode: "subscription", provider: "claude" }, profileSource: "fixture", userProject: f.project }, route: async () => { throw Error("unused"); } } as unknown as TurnDeps);
    expect((await post(bare, `${run.id}/apply/authorize`)).status).toBe(503);
  });
  it("M2: /approval, /decision, /retry and /reapply refuse an OpenShell run and never move an operation to ready", async () => {
    const f = fixture(); const run = f.makeRun("run-m2"); const a = app(f); const operation = f.store.listEnrichmentOperations(run.id)[0]!; const before = f.store.getEnrichmentRun(run.id)!;
    const body = { operationId: operation.id, proposalHash: before.proposalHash, projectRevision: before.projectRevision, expectedVersion: before.version, decision: "accept" };
    // Even a legacy-shaped accepted operation (as a pre-existing row could be) cannot be approved into `ready`.
    expect(f.store.transitionEnrichmentMetadata({ runId: run.id, expectedVersion: before.version, binding: f.current(), operation: { id: operation.id, expectedState: "awaiting_decision", expectedDecision: null, decision: "accept", nextState: "awaiting_approval" }, status: "awaiting_approval", event: { kind: "accept", message: "legacy" } })).toBe(true);
    const accepted = f.store.getEnrichmentRun(run.id)!; Object.assign(body, { expectedVersion: accepted.version });
    for (const route of ["approval", "decision", "retry", "reapply"]) { const response = await post(a, `${run.id}/${route}`, body); expect(response.status, route).toBe(409); }
    expect(f.store.listEnrichmentOperations(run.id).map((row) => row.state)).toEqual(["awaiting_approval", "awaiting_decision"]);
    expect(f.store.getEnrichmentRun(run.id)).toMatchObject({ version: accepted.version });
    // The per-operation apply body is not an alternative to apply-all: a run in this legacy shape is not appliable at all.
    const legacy = await post(a, `${run.id}/apply`, { operationId: operation.id, expectedVersion: accepted.version }); expect(legacy.status).toBe(409);
  });
  it("cancelling a validated run through its route makes Apply refuse", async () => {
    const f = fixture(); const run = f.makeRun("run-cancel-http"); const a = app(f); const token = f.mint(run.id);
    const cancelled = await post(a, `${run.id}/cancel`, { expectedVersion: f.store.getEnrichmentRun(run.id)!.version }); expect(cancelled.status).toBe(200);
    const response = await post(a, `${run.id}/apply`, token); expect(response.status).toBe(409); expect(treeHash(f.project)).toContain("relationships.yml");
    expect(f.status(run.id)).toBe("cancelled");
  });
});
