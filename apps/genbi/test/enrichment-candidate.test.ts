import { afterEach, describe, expect, it } from "vitest";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { appendKnowledge, buildCandidate, buildReviewDiff, CANDIDATE_LIMITS, changeSetSha256, DESCRIPTION_MERGE_RULE, materializeCandidate, mergeDescriptions, scopeViolation, verifyMerged, type CandidateFailureCode } from "../server/enrichment-candidate.js";
import { isAdditiveYaml, isDescriptionOnlyChange, parseYamlSubset, YamlSubsetError } from "../server/enrichment-yaml.js";
import { canonicalizeProposal, type EnrichmentChangeKind } from "../server/enrichment.js";
import { judgeValidatorResult, sanitizeValidatorMessage, validatorRequest, type ValidatorReceiptTuple } from "../server/enrichment-validation.js";
import type { SnapshotManifest } from "../server/runtime-host/openshell-snapshot-types.js";

const dirs: string[] = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });
const tmp = () => { const dir = mkdtempSync(path.join(tmpdir(), "genbi-candidate-")); dirs.push(dir); return dir; };
const fixture = (relative: string) => readFileSync(path.join(import.meta.dirname, "fixtures", "card-project", relative), "utf8");
const MODEL = fixture("models/orders/metadata.yml");
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const op = (sink: string, draft: string, changeKind: EnrichmentChangeKind = "knowledge_append") => ({ sink, changeKind, summary: "s", draft, risk: "low" as const, id: `op-${sink}`, confidence: "x" });
/** A snapshot reader backed by a map; an absent path is a file the snapshot lacks (a creation, which this runtime refuses). */
const snapshot = (files: Record<string, string>) => (relative: string) => (relative in files ? Buffer.from(files[relative]!) : undefined);
const candidate = (operations: ReturnType<typeof op>[], files: Record<string, string> = {}) => buildCandidate({ operations }, snapshot(files));
/** An existing, empty snapshot file for each sink. */
const existing = (...sinks: string[]) => Object.fromEntries(sinks.map((sink) => [sink, ""]));
const refusedWith = (result: ReturnType<typeof candidate>, code: CandidateFailureCode) => { expect(result.ok).toBe(false); if (!result.ok) { expect(result.failure.code).toBe(code); expect(result.failure.stage).toBe("host"); } };

describe("the YAML subset reader", () => {
  it("reads the metadata shapes Wren projects use", () => {
    const model = parseYamlSubset(MODEL);
    expect(model.t).toBe("map");
    const cube = parseYamlSubset(fixture("cubes/order_metrics/metadata.yml"));
    expect(cube.t === "map" && cube.entries.get("time_dimensions")?.t).toBe("seq");
    const relationships = parseYamlSubset(fixture("relationships.yml"));
    expect(relationships.t === "map" && relationships.entries.get("relationships")).toMatchObject({ t: "seq", items: [{ t: "map" }] });
  });
  it.each([
    ["a tab indent", "a:\n\tb: 1\n"], ["an anchor", "a: &x 1\nb: *x\n"], ["an alias", "a: *x\n"], ["a tag", "a: !!str 1\n"], ["a duplicate key", "a: 1\na: 2\n"],
    ["a flow mapping", "a: {b: 1}\n"], ["a nested flow sequence", "a: [[1], 2]\n"], ["a multi-line plain scalar", "a: one\n  two\n"], ["a second document", "a: 1\n---\nb: 2\n"],
    ["a scalar document", "just text\n"], ["an explicit key", "? a\n: b\n"], ["an indentation indicator", "a: |2\n   x\n"], ["a merge key", "a: 1\n<<: {b: 1}\n"], ["a NUL", "a: 1\u0000\n"],
  ])("refuses %s rather than guessing", (_label, text) => { expect(() => parseYamlSubset(text)).toThrow(YamlSubsetError); });
  it("reads quoted scalars, block scalars and comments", () => {
    const node = parseYamlSubset("a: 'it''s'\nb: \"x\\ty\"\nc: |\n  line one\n  line two\nd: >\n  folded\n  text\n# comment\ne: plain # trailing\n");
    expect(node.t === "map" && [...node.entries].map(([key, value]) => [key, value.t === "str" ? value.v : value.t])).toEqual([["a", "it's"], ["b", "x\ty"], ["c", "line one\nline two\n"], ["d", "folded text\n"], ["e", "plain"]]);
  });
  it("accepts a sequence at the same indent as its key", () => {
    const node = parseYamlSubset("columns:\n- name: a\n  type: INTEGER\n- name: b\n");
    expect(node.t === "map" && node.entries.get("columns")).toMatchObject({ t: "seq", items: [{ t: "map" }, { t: "map" }] });
  });
  const additive = (before: string, after: string) => isAdditiveYaml(parseYamlSubset(before), parseYamlSubset(after));
  it("additivity: new keys, new list items and extended descriptions are additive", () => {
    expect(additive(MODEL, MODEL.replace("One row per order, amount in USD.", "One row per order, amount in USD. Includes refunds."))).toBe(true);
    expect(additive(MODEL, `${MODEL}foo: bar\n`)).toBe(true);
    expect(additive(MODEL, `${MODEL}  - name: extra\n    type: DATE\n`)).toBe(true);
  });
  it.each([
    ["an existing value changed", (m: string) => m.replace("primary_key: id", "primary_key: customer_id")],
    ["a key removed", (m: string) => m.replace("primary_key: id\n", "")],
    ["a list shrunk", (m: string) => m.replace(/  - name: internal_note[\s\S]*$/, "")],
    ["a list item changed", (m: string) => m.replace("type: BIGINT", "type: DOUBLE")],
    ["a non-description string extended", (m: string) => m.replace("name: orders", "name: orders_v2")],
    ["a description replaced", (m: string) => m.replace("One row per order, amount in USD.", "Something else.")],
    ["a scalar type changed", (m: string) => m.replace("not_null: true", "not_null: \"true\"")],
    ["a description made shorter", (m: string) => m.replace("One row per order, amount in USD.", "One row")],
  ])("additivity refuses %s", (_label, change) => { expect(additive(MODEL, change(MODEL))).toBe(false); });
});

describe("host candidate: materialization, additivity and bounds", () => {
  it("builds the exact before/after against the snapshot bytes for a valid proposal (two Markdown appends and a YAML description addition)", () => {
    const result = candidate([
      op("knowledge/rules/glossary-note.md", "A new rule."),
      op("knowledge/rules/revenue.md", "Refunds are excluded."),
      op("models/orders/metadata.yml", MODEL.replace("amount in USD.", "amount in USD. Includes refunds."), "mdl_metric"),
    ], { "knowledge/rules/glossary-note.md": "Existing rule.\n", "knowledge/rules/revenue.md": "Revenue is net of refunds.\n", "models/orders/metadata.yml": MODEL });
    expect(result.ok).toBe(true); if (!result.ok) return;
    expect(result.files.map((file) => [file.path, file.change])).toEqual([["knowledge/rules/glossary-note.md", "modified"], ["knowledge/rules/revenue.md", "modified"], ["models/orders/metadata.yml", "modified"]]);
    const revenue = result.files[1]!;
    expect(revenue).toMatchObject({ before: "Revenue is net of refunds.\n", after: "Revenue is net of refunds.\nRefunds are excluded.\n", appended: "Refunds are excluded.\n", beforeSha256: sha("Revenue is net of refunds.\n"), afterSha256: sha("Revenue is net of refunds.\nRefunds are excluded.\n") });
    expect(result.files[2]!.appended).toBeNull();
    const { diff, diffSha256 } = buildReviewDiff(result.files);
    expect(diff).toHaveLength(3); expect(diffSha256).toMatch(/^sha256:[a-f0-9]{64}$/); expect(buildReviewDiff(result.files).diffSha256).toBe(diffSha256);
    expect(changeSetSha256(result.files.map((file) => ({ path: file.path, content: file.after })))).toMatch(/^sha256:/);
  });
  it.each([
    ["an existing key/value changed", [op("models/orders/metadata.yml", MODEL.replace("primary_key: id", "primary_key: customer_id"), "mdl_metric")], { "models/orders/metadata.yml": MODEL }],
    ["a list shrunk", [op("models/orders/metadata.yml", MODEL.replace(/  - name: internal_note[\s\S]*$/, ""), "mdl_metric")], { "models/orders/metadata.yml": MODEL }],
    ["a non-description edit", [op("models/orders/metadata.yml", MODEL.replace("name: orders", "name: renamed"), "mdl_metric")], { "models/orders/metadata.yml": MODEL }],
    ["a deleted key", [op("models/orders/metadata.yml", MODEL.replace("ref_sql: SELECT * FROM raw_orders WHERE deleted_at IS NULL\n", ""), "mdl_metric")], { "models/orders/metadata.yml": MODEL }],
  ])("refuses %s as not additive", (_label, operations, files) => { refusedWith(candidate(operations, files), "not_additive"); });
  it("refuses YAML the host review cannot verify, new or existing, instead of passing it", () => {
    refusedWith(candidate([op("models/orders/metadata.yml", "name: a\ncolumns: [[1]]\n", "mdl_metric")], { "models/orders/metadata.yml": MODEL }), "yaml_unsupported");
    refusedWith(candidate([op("models/orders/metadata.yml", `${MODEL}x: 1\n`, "mdl_metric")], { "models/orders/metadata.yml": "name: &a orders\nb: *a\n" }), "yaml_unsupported_existing");
  });
  it.each([
    ["traversal", "knowledge/rules/../../wren_project.yml", "path_invalid"], ["traversal in the middle", "models/../models/x/metadata.yml", "path_invalid"], ["an absolute path", "/etc/passwd", "path_invalid"],
    ["a backslash", "knowledge\\rules\\x.md", "path_invalid"], ["an empty segment", "knowledge//rules/x.md", "path_invalid"], ["a path over the length limit", `knowledge/rules/${"a".repeat(160)}.md`, "path_invalid"],
    ["a NUL in the path", "knowledge/rules/x\u0000.md", "path_invalid"], ["a path outside the allowlist", "src/evil.ts", "sink_not_allowed"], ["the project config", "wren_project.yml", "sink_not_allowed"],
    ["the compiled MDL", "target/mdl.json", "sink_not_allowed"], ["a Markdown file outside the knowledge categories", "knowledge/other/x.md", "sink_not_allowed"],
  ] as const)("refuses a path attack: %s", (_label, sink, code) => { refusedWith(candidate([op(sink, "x")]), code); });
  it("refuses more than 20 files, duplicates (including by case), oversize, binary and ill-formed text, and empty change sets", () => {
    refusedWith(candidate(Array.from({ length: 21 }, (_v, index) => op(`knowledge/rules/r${index}.md`, "x"))), "too_many_files");
    refusedWith(candidate([op("knowledge/rules/a.md", "x"), op("knowledge/rules/a.md", "y")], existing("knowledge/rules/a.md")), "duplicate_path");
    refusedWith(candidate([op("knowledge/rules/a.md", "x"), op("knowledge/rules/A.md", "y")], existing("knowledge/rules/a.md", "knowledge/rules/A.md")), "duplicate_path");
    refusedWith(candidate([op("knowledge/rules/a.md", "x".repeat(CANDIDATE_LIMITS.afterBytes + 1))], existing("knowledge/rules/a.md")), "too_large");
    const many = Array.from({ length: 17 }, (_v, index) => `knowledge/rules/r${index}.md`);
    refusedWith(candidate(many.map((sink) => op(sink, "x".repeat(4000))), existing(...many)), "too_large");
    refusedWith(candidate([op("knowledge/rules/a.md", "bad\u0000text")], existing("knowledge/rules/a.md")), "binary_content");
    refusedWith(candidate([op("knowledge/rules/a.md", "lone \ud800 surrogate")], existing("knowledge/rules/a.md")), "binary_content");
    refusedWith(candidate([op("knowledge/rules/a.md", "  \n")], { "knowledge/rules/a.md": "same\n" }), "no_changes");
    refusedWith(candidate([op("models/orders/metadata.yml", MODEL, "mdl_metric")], { "models/orders/metadata.yml": MODEL }), "no_changes");
    refusedWith(candidate([]), "no_changes");
    refusedWith(candidate([op("knowledge/rules/a.md", "x", "conflict"), op("models/x", "y", "ambiguous")]), "no_changes");
  });
  it("refuses an existing file that is binary or too large to review exactly, and an unreadable snapshot file", () => {
    refusedWith(candidate([op("knowledge/rules/a.md", "x")], { "knowledge/rules/a.md": "bin\u0000ary" }), "binary_content");
    refusedWith(buildCandidate({ operations: [op("knowledge/rules/a.md", "x")] }, () => Buffer.alloc(CANDIDATE_LIMITS.beforeBytes + 1, 97)), "too_large");
    refusedWith(buildCandidate({ operations: [op("knowledge/rules/a.md", "x")] }, () => { throw new Error("symlink in snapshot copy"); }), "source_unreadable");
  });
  it("failure evidence never carries attacker-chosen paths or draft text", () => {
    const result = candidate([op("../../etc/passwd", "SECRET-DRAFT-TEXT")]);
    expect(JSON.stringify(result)).not.toMatch(/passwd|SECRET-DRAFT/);
  });
  it("conflict and ambiguous operations are review-only and never become files", () => {
    const result = candidate([op("knowledge/rules/a.md", "x"), op("models/orders", "unresolved", "conflict")], existing("knowledge/rules/a.md"));
    expect(result.ok && result.files.map((file) => file.path)).toEqual(["knowledge/rules/a.md"]);
  });
  it("is deterministic and order independent", () => {
    const a = op("knowledge/rules/a.md", "a"), b = op("knowledge/rules/b.md", "b"); const files = existing("knowledge/rules/a.md", "knowledge/rules/b.md");
    expect(JSON.stringify(candidate([a, b], files))).toBe(JSON.stringify(candidate([b, a], files)));
  });
});

describe("host-owned scratch materialization", () => {
  const files = [{ path: "knowledge/rules/a.md", change: "modified" as const, before: "", after: "A\n", appended: "A\n", beforeSha256: sha(""), afterSha256: sha("A\n") }];
  it("writes into a private directory, reads back what it sent, and disposes it", () => {
    const root = path.join(tmp(), "drafts");
    const scratch = materializeCandidate(root, files);
    expect(scratch.files).toEqual([{ path: "knowledge/rules/a.md", content: "A\n" }]);
    expect(lstatSync(root).mode & 0o077).toBe(0);
    const directory = path.join(root, readdirSync(root)[0]!);
    expect(existsSync(path.join(directory, "knowledge/rules/a.md"))).toBe(true);
    scratch.dispose(); expect(existsSync(directory)).toBe(false);
  });
  it("refuses a symlinked or group-readable scratch root, and a path that would escape it", () => {
    const base = tmp(); const real = path.join(base, "real"); mkdirSync(real, { mode: 0o700 }); symlinkSync(real, path.join(base, "link"));
    expect(() => materializeCandidate(path.join(base, "link"), files)).toThrow();
    const open = path.join(base, "open"); mkdirSync(open, { mode: 0o755 }); expect(() => materializeCandidate(open, files)).toThrow();
    expect(() => materializeCandidate(path.join(base, "ok"), [{ ...files[0]!, path: "../escape.md" }])).toThrow();
    expect(existsSync(path.join(base, "escape.md"))).toBe(false);
  });
});

// ---------------------------------------------------------------- the validator verdict
const manifest = { version: 1, project: `sha256:${"b".repeat(64)}`, bindingGeneration: "3", bindingRevision: `sha256:${"c".repeat(64)}`, context: `sha256:${"d".repeat(64)}`, source: `sha256:${"e".repeat(64)}`,
  files: [{ path: "project/knowledge/rules/a.md", size: 3, sha256: sha("old") }], digest: `sha256:${"f".repeat(64)}` } as SnapshotManifest;
const receipt: ValidatorReceiptTuple = { image: `sha256:${"1".repeat(64)}`, policy: `sha256:${"2".repeat(64)}`, script: `sha256:${"3".repeat(64)}`, wheel: `sha256:${"4".repeat(64)}`, toolchain: `sha256:${"5".repeat(64)}`, architecture: "linux-arm64", protocol: "genbi-validate/1" };
const context = { account: "account-fingerprint", binding: { generation: 3, revision: manifest.bindingRevision, projectIdentity: "dev:1:ino:2" }, manifest, receipt };
const proposal = canonicalizeProposal({ operations: [{ sink: "knowledge/rules/a.md", changeKind: "knowledge_append", summary: "s", draft: "more" }] }, "sha256:rev");
const built = buildCandidate(proposal, snapshot({ "knowledge/rules/a.md": "old\n" }));
if (!built.ok) throw new Error("fixture candidate must build");
const sent = built.files.map((file) => ({ path: file.path, content: file.after }));
const mdl = JSON.stringify({ models: [{ name: "orders" }] }, null, 2);
const mdlResult = { sha256: sha(mdl), size: Buffer.byteLength(mdl), content: mdl };
const pass = (check: string) => ({ check, status: "pass", code: "ok", message: "" });
const skipped = (check: string) => ({ check, status: "skipped", code: "not_applicable", message: "" });
const okChecks = [pass("additivity"), pass("context_validate"), pass("context_build"), skipped("dry_plan"), skipped("cube_sql"), skipped("dry_run")];
const okResult = (overrides: Record<string, unknown> = {}) => ({ status: "ok", applied: sent, checks: okChecks, mdl: mdlResult, ...overrides });
const judge = (value: unknown, files = built.files, candidateSent = sent) => judgeValidatorResult(Buffer.from(typeof value === "string" ? value : JSON.stringify(value)), { files, sent: candidateSent }, context);
const failureOf = (verdict: ReturnType<typeof judge>) => { expect(verdict.ok).toBe(false); return verdict.ok ? undefined! : verdict.failure; };

describe("judging a validator result (the host decides; the validator only reports)", () => {
  it("accepts a result whose change set is byte-equal, with every required check passed, and builds the review record", () => {
    const verdict = judge(okResult());
    expect(verdict.ok).toBe(true); if (!verdict.ok) return;
    expect(verdict.review).toMatchObject({ version: 1, binding: context.binding, snapshot: { digest: manifest.digest, files: manifest.files }, receipt: { ...receipt, mdl: { sha256: sha(mdl), size: Buffer.byteLength(mdl) } } });
    expect(verdict.review.diff).toEqual([expect.objectContaining({ path: "knowledge/rules/a.md", change: "modified", before: "old\n", after: "old\nmore\n" })]);
    expect(verdict.review.receipt.changeSetSha256).toBe(changeSetSha256(sent));
  });
  it("a change set that differs from the candidate is refused (content, extra file, missing file, order, path)", () => {
    for (const applied of [[{ path: "knowledge/rules/a.md", content: "old\nmore\nEXTRA\n" }], [...sent, { path: "knowledge/rules/b.md", content: "x\n" }], [], [{ path: "knowledge/rules/B.md", content: "old\nmore\n" }]]) {
      const failure = failureOf(judge(okResult({ applied })));
      expect(failure).toMatchObject({ stage: "validator", code: expect.stringMatching(/change_set_mismatch|validator_protocol/) });
    }
  });
  it("a sandbox claim of success never overrides the host: a required check that did not pass is a failure", () => {
    expect(failureOf(judge(okResult({ checks: [pass("additivity"), pass("context_validate"), { check: "context_build", status: "skipped", code: "x", message: "" }, skipped("dry_plan"), skipped("cube_sql"), skipped("dry_run")] })))).toMatchObject({ code: "check_not_passed" });
    expect(failureOf(judge(okResult({ checks: okChecks.filter((check) => check.check !== "context_validate") })))).toMatchObject({ code: "check_not_passed" });
  });
  it("a check the candidate needs may not be skipped, and one it does not need may not be claimed", () => {
    const model = canonicalizeProposal({ operations: [{ sink: "models/orders/metadata.yml", changeKind: "mdl_metric", summary: "s", draft: MODEL.replace("amount in USD.", "amount in USD. Includes refunds.") }] }, "sha256:rev");
    const modelBuilt = buildCandidate(model, snapshot({ "models/orders/metadata.yml": MODEL }));
    if (!modelBuilt.ok) throw new Error("fixture"); const modelSent = modelBuilt.files.map((file) => ({ path: file.path, content: file.after }));
    expect(failureOf(judge(okResult({ applied: modelSent }), modelBuilt.files, modelSent))).toMatchObject({ code: "check_not_passed" });
    const checks = [pass("additivity"), pass("context_validate"), pass("context_build"), pass("dry_plan"), skipped("cube_sql"), skipped("dry_run")];
    expect(judge(okResult({ applied: modelSent, checks }), modelBuilt.files, modelSent).ok).toBe(true);
    expect(failureOf(judge(okResult({ checks: [...okChecks.slice(0, 3), pass("dry_plan"), skipped("cube_sql"), skipped("dry_run")] })))).toMatchObject({ code: "check_not_passed" });
  });
  it.each([
    ["not JSON", "not json"], ["an array", "[]"], ["an unknown status", '{"status":"maybe"}'], ["an extra top-level key", JSON.stringify({ ...okResult(), extra: 1 })],
    ["an unknown check name", JSON.stringify(okResult({ checks: [...okChecks, { check: "shell", status: "pass", code: "ok", message: "" }] }))],
    ["a duplicate check", JSON.stringify(okResult({ checks: [...okChecks, pass("additivity")] }))], ["a check with extra keys", JSON.stringify(okResult({ checks: [{ ...pass("additivity"), extra: 1 }] }))],
    ["an ok result without an MDL", JSON.stringify({ status: "ok", applied: sent, checks: okChecks })], ["a failed result with an applied set", JSON.stringify({ status: "failed", applied: sent, checks: okChecks })],
    ["a message over the limit", JSON.stringify(okResult({ checks: [{ ...pass("additivity"), message: "x".repeat(241) }] }))], ["an oversized result", `{"status":"failed","checks":[],"pad":"${"x".repeat(600_000)}"}`],
    ["an MDL over the size limit", JSON.stringify(okResult({ mdl: { ...mdlResult, size: CANDIDATE_LIMITS.mdlBytes + 1 } }))],
  ])("refuses a malformed, oversized or extra result: %s", (_label, value) => { expect(failureOf(judge(value))).toMatchObject({ stage: "validator", code: "validator_protocol" }); });
  it.each([
    ["a digest that does not match the content", okResult({ mdl: { ...mdlResult, sha256: "0".repeat(64) } })],
    ["a size that does not match the content", okResult({ mdl: { ...mdlResult, size: mdlResult.size + 1 } })],
    ["MDL that is not an object with models", okResult({ mdl: { sha256: sha("[]"), size: 2, content: "[]" } })],
  ])("an MDL with %s is refused", (_label, value) => { expect(failureOf(judge(value))).toMatchObject({ code: "mdl_invalid" }); });
  it("a failed result becomes sanitized evidence naming the failed check; sandbox text never carries paths or SQL context", () => {
    const failure = failureOf(judge({ status: "failed", checks: [pass("additivity"), { check: "dry_run", status: "fail", code: "dry_run_error", message: "Binder error at /sandbox/validate-x/project/a.yml near LINE 1: SELECT secret FROM t" }] }));
    expect(failure).toMatchObject({ stage: "validator", code: "validator_failed" });
    expect(JSON.stringify(failure)).not.toMatch(/\/sandbox|SELECT secret/); expect(failure.message).toContain("dry_run");
    expect(failureOf(judge({ status: "failed", checks: [pass("additivity")] }))).toMatchObject({ code: "validator_protocol" });
  });
  it("sanitizes control characters, paths, SQL context and length", () => {
    expect(sanitizeValidatorMessage("a\u0000b /etc/passwd c:\\x\\y LINE 1: SELECT 1")).toBe("a b <path> <path>");
    expect(sanitizeValidatorMessage("x ".repeat(500)).length).toBeLessThanOrEqual(240);
  });
  describe("a recorded real validator transcript", () => {
    // Recorded from validator.py running in the pinned worker image toolchain (wrenai 0.13.0, wren-core-py 0.7.1, DuckDB 1.5.0) over a synthetic snapshot.
    const recorded = (name: string) => readFileSync(path.join(import.meta.dirname, "fixtures", "validator-transcript", name));
    const recordedModel = "name: orders\nref_sql: SELECT id, customer_id, amount, order_date FROM shop.main.orders\nprimary_key: id\nproperties:\n  description: One row per order.\ncolumns:\n  - name: id\n    type: INTEGER\n  - name: customer_id\n    type: INTEGER\n  - name: amount\n    type: DOUBLE\n  - name: order_date\n    type: DATE\n";
    it("the host accepts the real validator's success result only against the candidate that produced it", () => {
      // The transcript predates the scope restriction (it includes a cube); it is replayed against files rebuilt from its own `applied` set,
      // so this exercises the judge's byte-equality and check requirements, not scope (scope is covered by the candidate and validator tests).
      const applied = (JSON.parse(recorded("valid.result.json").toString()) as { applied: { path: string; content: string }[] }).applied;
      const files = applied.map((entry) => ({ path: entry.path, change: "modified" as const, before: "", after: entry.content, appended: null, beforeSha256: sha(""), afterSha256: sha(entry.content) }));
      const candidateSent = files.map((file) => ({ path: file.path, content: file.after }));
      const verdict = judgeValidatorResult(recorded("valid.result.json"), { files, sent: candidateSent }, context);
      expect(verdict.ok).toBe(true);
      // The same transcript replayed against a different candidate is a change-set mismatch.
      const tampered = files.map((file, index) => (index === 0 ? { ...file, after: `${file.after}x\n` } : file));
      expect(judgeValidatorResult(recorded("valid.result.json"), { files: tampered, sent: tampered.map((file) => ({ path: file.path, content: file.after })) }, context)).toMatchObject({ ok: false, failure: { code: "change_set_mismatch" } });
    });
    it("S3-4: the real validator's unsupported_by_runtime refusal (a cube) becomes sanitized validator_failed evidence naming the additivity check", () => {
      const verdict = judgeValidatorResult(recorded("unsupported-cube.result.json"), { files: [], sent: [] }, context);
      expect(verdict).toMatchObject({ ok: false, failure: { stage: "validator", code: "validator_failed", checks: [{ check: "additivity", status: "fail", code: "unsupported_by_runtime" }] } });
    });
    it("the real validator's knowledge append is accepted only against the candidate the host built over the same bytes", () => {
      const result = JSON.parse(recorded("knowledge-append.result.json").toString()) as { applied: { path: string; content: string }[] };
      const built = buildCandidate({ operations: [{ sink: "knowledge/rules/revenue.md", changeKind: "knowledge_append", summary: "s", draft: "Refunds are excluded from revenue.", risk: "low", id: "x", confidence: "x" }] }, snapshot({ "knowledge/rules/revenue.md": "Revenue is net of refunds.\n" }));
      if (!built.ok) throw new Error("candidate must build");
      expect(built.files.map((file) => ({ path: file.path, content: file.after }))).toEqual(result.applied);
      const sentFiles = built.files.map((file) => ({ path: file.path, content: file.after }));
      expect(judgeValidatorResult(recorded("knowledge-append.result.json"), { files: built.files, sent: sentFiles }, context).ok).toBe(true);
    });
    it("the real validator's failure result becomes sanitized validator_failed evidence", () => {
      const verdict = judgeValidatorResult(recorded("missing-column.result.json"), { files: [], sent: [] }, context);
      expect(verdict).toMatchObject({ ok: false, failure: { stage: "validator", code: "validator_failed" } });
      expect(JSON.stringify(verdict)).toContain("dry_run"); expect(JSON.stringify(verdict)).not.toMatch(/SELECT|\/sandbox/);
    });
  });
  it("the validator request is exactly the host's read-back candidate", () => {
    expect(JSON.parse(validatorRequest(sent).toString())).toEqual({ version: 1, files: sent });
  });
});

// ---------------------------------------------------------------- scope (existing files only), knowledge_append, YAML whitespace
const RELATIONSHIPS = fixture("relationships.yml");

describe("S3-4: OpenShell scope is existing files only, and only knowledge, descriptions and relationships", () => {
  it.each([
    ["a new knowledge file", [op("knowledge/rules/brand-new.md", "A rule.")], {}],
    ["a first relationships.yml", [op("relationships.yml", RELATIONSHIPS, "new_relationship")], {}],
    ["a new model metadata file", [op("models/fresh/metadata.yml", MODEL.replace("name: orders", "name: fresh"), "mdl_metric")], {}],
  ])("refuses %s with unsupported_by_runtime", (_label, operations, files) => { refusedWith(candidate(operations, files), "unsupported_by_runtime"); });
  it.each([
    ["a cube", op("cubes/order_metrics/metadata.yml", "name: order_metrics\n", "new_cube")],
    ["a view", op("views/recent/metadata.yml", "name: recent\n", "new_view")],
    ["a calculated column", op("models/orders/metadata.yml", `${MODEL}  - name: gross\n    type: DOUBLE\n    is_calculated: true\n    expression: amount * 2\n`, "calculated_column")],
  ])("refuses %s before reading the snapshot", (_label, operation) => {
    expect(scopeViolation({ operations: [operation] })).toEqual({ sink: operation.sink });
    let reads = 0;
    const result = buildCandidate({ operations: [operation] }, () => { reads++; return Buffer.from(MODEL); });
    refusedWith(result, "unsupported_by_runtime"); expect(reads).toBe(0);
  });
  it("refuses a calculated or plain new column smuggled through mdl_metric, a new key, and a changed list, as unsupported_by_runtime", () => {
    const files = { "models/orders/metadata.yml": MODEL };
    refusedWith(candidate([op("models/orders/metadata.yml", `${MODEL}  - name: gross\n    type: DOUBLE\n    is_calculated: true\n    expression: amount * 2\n`, "mdl_metric")], files), "unsupported_by_runtime");
    refusedWith(candidate([op("models/orders/metadata.yml", `${MODEL}  - name: plain\n    type: DATE\n`, "mdl_metric")], files), "unsupported_by_runtime");
    refusedWith(candidate([op("models/orders/metadata.yml", `${MODEL}extra_key: 1\n`, "mdl_metric")], files), "unsupported_by_runtime");
  });
  it("still accepts description additions on a model and on columns with or without a properties block", () => {
    const model = MODEL.replace("amount in USD.", "amount in USD. Includes refunds.")
      .replace("    type: DATE\n    properties:\n      description: Order date (UTC).", "    type: DATE\n    properties:\n      description: Order date (UTC). Midnight boundary.")
      .replace("  - name: id\n    type: INTEGER\n    not_null: true", "  - name: id\n    type: INTEGER\n    not_null: true\n    properties:\n      description: Order identifier.")
      .replace("  - name: amount\n    type: DOUBLE", "  - name: amount\n    type: DOUBLE\n    description: Order total.");
    const result = candidate([op("models/orders/metadata.yml", model, "mdl_metric")], { "models/orders/metadata.yml": MODEL });
    expect(result.ok).toBe(true);
    expect(isDescriptionOnlyChange(parseYamlSubset(MODEL), parseYamlSubset(model))).toBe(true);
  });
  it("accepts an additive edit of an existing relationships.yml", () => {
    const result = candidate([op("relationships.yml", `${RELATIONSHIPS}  - name: orders_product\n    models: [orders, products]\n    join_type: MANY_TO_ONE\n    condition: orders.product_id = products.id\n`, "new_relationship")], { "relationships.yml": RELATIONSHIPS });
    expect(result.ok).toBe(true);
  });
  it("description-only is strictly narrower than additive", () => {
    const before = parseYamlSubset(MODEL);
    for (const after of [`${MODEL}  - name: plain\n    type: DATE\n`, `${MODEL}extra: 1\n`, MODEL.replace("is_hidden: true", "is_hidden: true\n    flag: x")]) {
      expect(isAdditiveYaml(before, parseYamlSubset(after))).toBe(true);
      expect(isDescriptionOnlyChange(before, parseYamlSubset(after))).toBe(false);
    }
  });
});

describe("S3-5: knowledge_append is built by the host over the existing bytes", () => {
  it("validates an append without the model reproducing the existing text, and the diff shows only the appended text", () => {
    const existingText = "Revenue is net of refunds.\nA second long existing paragraph the model never sees again.\n";
    const result = candidate([op("knowledge/rules/revenue.md", "Refunds are excluded from revenue.")], { "knowledge/rules/revenue.md": existingText });
    expect(result.ok).toBe(true); if (!result.ok) return;
    const file = result.files[0]!;
    expect(file.after).toBe(`${existingText}Refunds are excluded from revenue.\n`);
    expect(file.appended).toBe("Refunds are excluded from revenue.\n");
    expect(file.after.startsWith(file.before)).toBe(true); expect(file.after.slice(file.before.length)).toBe(file.appended);
    expect(buildReviewDiff(result.files).diff[0]).toMatchObject({ before: existingText, appended: "Refunds are excluded from revenue.\n" });
  });
  it.each([
    ["no trailing newline gets exactly one separator", "existing", "tail", "existing\ntail\n"],
    ["an existing trailing newline gets none", "existing\n", "tail", "existing\ntail\n"],
    ["an existing blank trailing line is kept as it is", "existing\n\n", "tail", "existing\n\ntail\n"],
    ["leading line breaks of the tail are dropped", "existing\n", "\n\r\ntail", "existing\ntail\n"],
    ["a tail with its own trailing newline gets no extra one", "existing\n", "tail\n", "existing\ntail\n"],
    ["an empty file gets no leading newline", "", "tail", "tail\n"],
  ])("separator rule: %s", (_label, before, tail, after) => { expect(appendKnowledge(before, tail)?.after).toBe(after); });
  it("a whitespace-only tail appends nothing", () => { expect(appendKnowledge("x\n", " \n\t")).toBeUndefined(); });
  it("the old whole-file draft shape is no longer how a knowledge append is expressed: the existing text is not a required prefix", () => {
    const result = candidate([op("knowledge/rules/revenue.md", "Revenue is gross.")], { "knowledge/rules/revenue.md": "Revenue is net of refunds.\n" });
    expect(result.ok && result.files[0]!.after).toBe("Revenue is net of refunds.\nRevenue is gross.\n");
  });
});

describe("S3-6 / M1: the YAML subset reader does not treat Unicode whitespace as YAML whitespace", () => {
  const additive = (before: string, after: string) => isAdditiveYaml(parseYamlSubset(before), parseYamlSubset(after));
  it("a key renamed by a leading NBSP is refused, not read as the same key", () => {
    expect(() => parseYamlSubset(" a: 1\n")).toThrow(YamlSubsetError);
    refusedWith(candidate([op("models/orders/metadata.yml", " name: orders\n", "mdl_metric")], { "models/orders/metadata.yml": "name: orders\n" }), "yaml_unsupported");
  });
  it("a trailing NBSP makes a different scalar", () => {
    expect(additive("a: foo\n", "a: foo\n")).toBe(true);
    expect(additive("a: foo\n", "a: foo \n")).toBe(false);
    expect(additive("description: foo\n", "description: foo \n")).toBe(true); // an extension of a description (prefix), not an equality
    expect(additive("description: foo \n", "description: foo\n")).toBe(false);
  });
  it.each(["\u0085", " ", " ", "\u000b", "\u000c"])("refuses U+%s anywhere (PyYAML reads it as a line break or rejects it)", (character) => {
    expect(() => parseYamlSubset(`a: x${character}y\n`)).toThrow(YamlSubsetError);
  });
  it("a whitespace-only line inside a block scalar is content, so it compares exactly", () => {
    const withBlank = "description: |\n  x\n\n  y\n", withSpaces = "description: |\n  x\n    \n  y\n";
    const value = (text: string) => { const node = parseYamlSubset(text); return node.t === "map" && node.entries.get("description")?.t === "str" ? (node.entries.get("description") as { v: string }).v : undefined; };
    expect(value(withBlank)).toBe("x\n\ny\n"); expect(value(withSpaces)).toBe("x\n  \ny\n");
    expect(additive(withBlank, withSpaces)).toBe(false);
    expect(additive(withSpaces, withSpaces)).toBe(true);
    expect(additive("description: |\n  x\n  \n  y\n", withBlank)).toBe(true);
  });
  it("tabs and spaces still separate where YAML allows them", () => {
    expect(additive("a: 1 # note\nb:\t2\n", "a: 1\nb: 2\nc: 3\n")).toBe(true);
  });
});

describe("description_append", () => {
  const LIVE = [
    "name: orders", "ref_sql: SELECT id, customer_id, amount_minor, currency, status, created_at FROM synthetic.orders", "primary_key: id", "columns",
  ].join("\n").replace("columns", "columns:") + "\n" + ["id:INTEGER", "customer_id:INTEGER", "amount_minor:INTEGER", "currency:VARCHAR", "status:VARCHAR", "created_at:DATE"]
    .map((entry) => `  - name: ${entry.split(":")[0]}\n    type: ${entry.split(":")[1]}\n`).join("");
  const SINK = "models/orders/metadata.yml";
  const merge = (payload: string, before = LIVE) => candidate([op(SINK, payload, "description_append")], { [SINK]: before });
  const after = (payload: string, before = LIVE) => { const result = merge(payload, before); expect(result.ok).toBe(true); return result.ok ? result.files[0]!.after : ""; };
  const AMOUNT = "Order amount in minor units (cents); divide by 100 for USD.";

  it("inserts exactly one description line after the column's name line and leaves every other line byte-identical", () => {
    const result = merge(`columns:\n  amount_minor: "${AMOUNT}"\n`);
    expect(result.ok).toBe(true); if (!result.ok) return;
    const lines = LIVE.split("\n"); const at = lines.indexOf("  - name: amount_minor");
    lines.splice(at + 1, 0, `    description: ${JSON.stringify(AMOUNT)}`);
    expect(result.files[0]).toMatchObject({ path: SINK, change: "modified", before: LIVE, after: lines.join("\n"), appended: null });
  });
  it("adds a model description and several column descriptions in one payload", () => {
    const merged = after(`description: "One row per order."\ncolumns:\n  id: "Order id."\n  status: "Lifecycle state."\n`);
    const lines = merged.split("\n");
    expect(lines[1]).toBe('description: "One row per order."');
    expect(lines).toContain('    description: "Order id."'); expect(lines).toContain('    description: "Lifecycle state."');
    expect(lines.length).toBe(LIVE.split("\n").length + 3);
    expect(lines.filter((line) => !line.includes("description:"))).toEqual(LIVE.split("\n"));
  });
  it.each([
    ["a plain", "description: One row per order.\n", "description: One row per order.\n"],
    ["a quoted", "description: \"One row per order.\"\n", "description: \"One row per order.\"\n"],
  ])("extends %s existing single-line description on the model", (_label, line, kept) => {
    const before = LIVE.replace("primary_key: id\n", `primary_key: id\n${line}`);
    expect(after('description: "Amount in USD."\n', before)).toBe(before.replace(kept, 'description: "One row per order. Amount in USD."\n'));
  });
  it("extends an existing properties.description and an existing column description, and keeps untouched ones", () => {
    const before = MODEL;
    const merged = after('description: "Includes refunds."\ncolumns:\n  order_date: "Day the order was placed."\n  amount: "In dollars."\n', before);
    expect(merged).toContain('  description: "One row per order, amount in USD. Includes refunds."\n');
    expect(merged).toContain('      description: "Order date (UTC). Day the order was placed."\n');
    expect(merged).toContain("  - name: amount\n    description: \"In dollars.\"\n    type: DOUBLE\n");
    expect(merged).toContain("  - name: internal_note\n    type: VARCHAR\n    is_hidden: true\n");
  });
  it("accepts astral and non-ASCII text inside the PyYAML printable set", () => {
    expect(merge('description: "caf\u00e9 \u4e2d\u6587 \ud83d\ude00 \ufffd"\n').ok).toBe(true);
  });
  it("drops a trailing comment on a replaced description line along with its old value, and nothing else", () => {
    const before = LIVE.replace("primary_key: id\n", "primary_key: id\ndescription: old # keep me?\n");
    expect(after('description: "new"\n', before)).toBe(before.replace("description: old # keep me?", 'description: "old new"'));
  });
  it("refuses a name that is a block scalar or empty as an existing-file problem", () => {
    refusedWith(merge('description: "d"\n', "name: |\n  orders\nprimary_key: id\n"), "yaml_unsupported_existing");
    refusedWith(merge('columns:\n  a: "d"\n', "name: m\ncolumns:\n  - name: >-\n      a\n"), "yaml_unsupported_existing");
  });
  it("refuses extending a block-scalar or empty existing description", () => {
    for (const body of ["description: |\n  one\n  two\n", "description: >-\n  folded\n"]) refusedWith(merge('description: "x"\n', LIVE.replace("primary_key: id\n", `primary_key: id\n${body}`)), "yaml_unsupported_existing");
    refusedWith(merge('columns:\n  id: "x"\n', LIVE.replace("  - name: id\n", "  - name: id\n    description: |\n      block\n")), "yaml_unsupported_existing");
  });
  it("keeps a CRLF file CRLF, and refuses mixed line endings", () => {
    const crlf = LIVE.replace(/\n/g, "\r\n");
    expect(after('columns:\n  id: "Id."\n', crlf)).toBe(crlf.replace("  - name: id\r\n", '  - name: id\r\n    description: "Id."\r\n'));
    refusedWith(merge('columns:\n  id: "Id."\n', crlf.replace("primary_key: id\r\n", "primary_key: id\n")), "yaml_unsupported_existing");
  });
  it("inserts a model description at the top when the file has no name, and after a leading document marker", () => {
    expect(after('description: "d"\n', "primary_key: id\n")).toBe('description: "d"\nprimary_key: id\n');
    expect(after('description: "d"\n', "---\nprimary_key: id\n")).toBe('---\ndescription: "d"\nprimary_key: id\n');
  });
  it("works when the first key of a column item is not its name and when the item is a bare dash", () => {
    const first = "name: m\ncolumns:\n  - type: INTEGER\n    name: a\n  -\n    name: b\n    type: DATE\n";
    expect(after('columns:\n  a: "A."\n  b: "B."\n', first)).toBe("name: m\ncolumns:\n  - type: INTEGER\n    name: a\n    description: \"A.\"\n  -\n    name: b\n    description: \"B.\"\n    type: DATE\n");
    const indentless = "name: m\ncolumns:\n- name: a\n  type: INTEGER\nprimary_key: a\n";
    expect(after('columns:\n  a: "A."\n', indentless)).toBe("name: m\ncolumns:\n- name: a\n  description: \"A.\"\n  type: INTEGER\nprimary_key: a\n");
  });
  it.each([
    ["an unknown column", 'columns:\n  nope: "x"\n'], ["a case-mismatched name", 'columns:\n  Amount_Minor: "x"\n'],
    ["__proto__", 'columns:\n  __proto__: "x"\n'], ["constructor", 'columns:\n  constructor: "x"\n'], ["toString", 'columns:\n  toString: "x"\n'],
    ["a model key as a column", 'columns:\n  ref_sql: "x"\n'], ["name", 'columns:\n  name: "x"\n'], ["columns", 'columns:\n  columns: "x"\n'],
    ["a name with a colon and space", 'columns:\n  "a: b": "x"\n'], ["a quoted name", 'columns:\n  "a\\"b": "x"\n'], ["a name with a hash", 'columns:\n  "a#b": "x"\n'],
    ["a name that only exists as a type value", 'columns:\n  INTEGER: "x"\n'],
  ])("refuses %s as unsupported_by_runtime", (_label, payload) => { refusedWith(merge(payload), "unsupported_by_runtime"); });
  it.each([
    ["an extra type key", 'type: "x"\ndescription: "d"\n'], ["ref_sql", 'ref_sql: "x"\n'], ["primary_key", 'primary_key: "x"\n'], ["additivity", 'additivity: "x"\ndescription: "d"\n'],
    ["a non-string model value", "description: 5\n"], ["a boolean value", "description: true\n"], ["a non-string column value", "columns:\n  id: 5\n"],
    ["a list value", "columns:\n  id:\n    - a\n"], ["a nested map under a column", "columns:\n  id:\n    description: x\n"], ["columns as a list", "columns:\n  - id\n"],
    ["an empty columns value", "columns:\n"], ["a flow mapping", 'columns: {id: "x"}\n'], ["a JSON object", '{"description": "d"}'], ["a scalar", "just text\n"],
    ["an empty payload", ""], ["a whitespace payload", "  \n\n"], ["an empty description", 'description: ""\n'], ["a blank description", 'description: "   "\n'],
    ["an empty columns mapping", "columns: {}\n"], ["a multi-line description", 'description: "a\\nb"\n'], ["a block scalar description", "description: |\n  a\n  b\n"],
    ["a tab", 'description: "a\\tb"\n'], ["a carriage return", 'description: "a\\rb"\n'], ["a control character", 'description: "a\\u0001b"\n'],
    ["U+FFFE", 'description: "a\\ufffeb"\n'], ["U+FFFF", 'description: "a\\uffffb"\n'], ["DEL", 'description: "a\\u007fb"\n'], ["a C1 control", 'description: "a\\u0090b"\n'], ["U+2028", 'description: "a\\u2028b"\n'], ["U+0085", 'description: "a\\u0085b"\n'], ["a lone surrogate", 'description: "a\\ud800b"\n'],
    ["an oversize description", `description: "${"x".repeat(501)}"\n`], ["an oversize column description", `columns:\n  id: "${"x".repeat(501)}"\n`],
    ["a duplicate key", 'description: "a"\ndescription: "b"\n'],
  ])("refuses %s as yaml_unsupported", (_label, payload) => { refusedWith(merge(payload), "yaml_unsupported"); });
  it("accepts a 500-character description and refuses size overruns as too_large", () => {
    expect(merge(`description: "${"x".repeat(500)}"\n`).ok).toBe(true);
    refusedWith(merge(`description: "d"\ncolumns:\n${Array.from({ length: 101 }, (_, i) => `  c${i}: "x"\n`).join("")}`), "too_large");
    refusedWith(merge(`columns:\n${Array.from({ length: 90 }, (_, i) => `  c${i}: "${"x".repeat(100)}"\n`).join("")}`), "too_large");
  });
  it("refuses the whole-file shape instead of merging it", () => {
    const wholeFile = "name: orders\nproperties:\n  description: One row per order.\ncolumns:\n  id:\n    type: INTEGER\n";
    refusedWith(merge(wholeFile), "yaml_unsupported");
    refusedWith(merge(LIVE.replace("primary_key: id\n", 'primary_key: id\ndescription: "d"\n')), "yaml_unsupported");
    refusedWith(merge(MODEL), "yaml_unsupported");
  });
  it.each([
    ["columns as a map", "name: m\ncolumns:\n  id:\n    type: INTEGER\n"], ["a duplicate column name", "name: m\ncolumns:\n  - name: id\n  - name: id\n"],
    ["an item without a name", "name: m\ncolumns:\n  - type: INTEGER\n"], ["a non-string name", "name: m\ncolumns:\n  - name: 5\n"], ["a scalar item", "name: m\ncolumns:\n  - id\n"],
    ["unparseable YAML", "name: [unterminated\n"], ["a quoted name key", 'name: m\ncolumns:\n  - "name": id\n'],
  ])("refuses an existing file with %s as yaml_unsupported_existing", (_label, before) => { refusedWith(merge('columns:\n  id: "x"\n', before), "yaml_unsupported_existing"); });
  it("is deterministic and idempotent-safe: a second extension keeps the first", () => {
    const once = after('columns:\n  id: "A."\n'); expect(after('columns:\n  id: "B."\n', once)).toBe(once.replace('"A."', '"A. B."'));
  });
  it("round-trips the merged bytes through the model-description rule: parse, additive, description-only", () => {
    const merged = after(`description: "d"\ncolumns:\n  amount_minor: "${AMOUNT}"\n  id: "i"\n`);
    expect(isAdditiveYaml(parseYamlSubset(LIVE), parseYamlSubset(merged))).toBe(true);
    expect(isDescriptionOnlyChange(parseYamlSubset(LIVE), parseYamlSubset(merged))).toBe(true);
    const direct = mergeDescriptions(LIVE, `columns:\n  id: "i"\n`);
    expect(direct).toMatchObject({ ok: true }); expect(DESCRIPTION_MERGE_RULE).toContain("description");
  });
  it("hostile text in descriptions stays inert inside one quoted scalar", () => {
    const text = 'say "hi" # not a comment: [x], {y} \\ back\\slash & *a !t | > - ? \' %';
    const merged = after(`description: ${JSON.stringify(text)}\n`);
    const parsed = parseYamlSubset(merged);
    expect(parsed.t === "map" && parsed.entries.get("description")).toMatchObject({ t: "str", v: text });
    expect(merged.split("\n").length).toBe(LIVE.split("\n").length + 1);
  });
  describe("verification of the merged result (independent of how it was built)", () => {
    const wanted = (model?: string, columns: [string, string][] = []) => ({ ...(model === undefined ? {} : { model }), columns: new Map(columns) });
    const good = LIVE.replace("  - name: id\n", '  - name: id\n    description: "Id."\n');
    it("accepts the intended result", () => { expect(verifyMerged(LIVE, good, wanted(undefined, [["id", "Id."]]))).toBeUndefined(); });
    it.each([
      ["a changed type", good.replace("type: INTEGER", "type: BIGINT"), "not_additive"],
      ["a dropped line", good.replace("primary_key: id\n", ""), "not_additive"],
      ["a new column", good + "  - name: extra\n    type: INTEGER\n", "unsupported_by_runtime"],
      ["a new key", good.replace("name: orders\n", "name: orders\nextra: 1\n"), "unsupported_by_runtime"],
      ["a description on the wrong column", LIVE.replace("  - name: status\n", '  - name: status\n    description: "Id."\n'), "not_additive"],
      ["different description text", good.replace('"Id."', '"Other."'), "not_additive"],
      ["a description on an untargeted column too", good.replace("  - name: status\n", '  - name: status\n    description: "x"\n'), "not_additive"],
      ["a description added to a nested node", good.replace("primary_key: id\n", "primary_key: id\nproperties:\n  description: x\n"), "not_additive"],
    ])("refuses %s", (_label, merged, code) => { expect(verifyMerged(LIVE, merged, wanted(undefined, [["id", "Id."]]))).toBe(code); });
    it("verifyMerged alone refuses an expected column that the original lacks", () => {
      expect(verifyMerged(LIVE, good, wanted(undefined, [["id", "Id."], ["nope", "x"]]))).toBe("unsupported_by_runtime");
      expect(verifyMerged(LIVE, LIVE, wanted(undefined, [["nope", "x"]]))).toBe("unsupported_by_runtime");
    });
    it("refuses an unknown expected column and unparseable output", () => {
      expect(verifyMerged(LIVE, good, wanted(undefined, [["id", "Id."], ["nope", "x"]]))).toBe("unsupported_by_runtime");
      expect(verifyMerged(LIVE, "a: [broken\n", wanted("x"))).toBe("yaml_unsupported");
    });
  });

  it("refuses the kind on a sink that is not a model metadata file, in the host and in canonicalization", () => {
    refusedWith(candidate([op("knowledge/rules/x.md", "text", "description_append")], { "knowledge/rules/x.md": "" }), "sink_not_allowed");
    expect(() => canonicalizeProposal({ operations: [{ sink: "knowledge/rules/x.md", changeKind: "description_append", summary: "s", draft: "d" }] }, "r")).toThrow("sink does not match");
    expect(() => canonicalizeProposal({ operations: [{ sink: "views/v/metadata.yml", changeKind: "description_append", summary: "s", draft: "d" }] }, "r")).toThrow("sink does not match");
  });
});

describe("proposal contract diagnostics", () => {
  const diagnose = (changeKind: unknown) => { try { canonicalizeProposal({ operations: [{ sink: "models/orders/metadata.yml", changeKind, summary: "s", draft: "d" }] }, "r"); } catch (error) { return (error as { message: string; diagnostic?: { items: { kind: string; kind_length: string; fields: string[]; sink: string }[] } }); } return undefined; };
  it.each([["description", "description"], ["Column_Description", "column_description"], ["description_append", undefined], ["Metadata", "metadata"], [undefined, "missing"], [7, "non_string"]])("maps %j to the closed kind %j", (value, expected) => {
    const error = diagnose(value);
    if (expected === undefined) { expect(error).toBeUndefined(); return; }
    expect(error!.message).toBe("enrichment operation has an unknown changeKind");
    expect(error!.diagnostic!.items[0]).toMatchObject({ kind: expected, sink: "models", fields: ["sink", ...(value === undefined ? [] : ["changeKind"]), "summary", "draft"] });
  });
  it("never echoes a hostile kind string and only buckets its length", () => {
    const hostile = "'; DROP TABLE x -- /home/user/secret sk-ant-123";
    const error = diagnose(hostile)!;
    expect(JSON.stringify(error.diagnostic)).not.toMatch(/DROP|home\/user|sk-ant/); expect(error.message).not.toContain("DROP");
    expect(error.diagnostic!.items[0]).toMatchObject({ kind: "other", kind_length: "33-64" });
    expect(diagnose("x".repeat(500))!.diagnostic!.items[0]!.kind_length).toBe("65+");
  });
});
