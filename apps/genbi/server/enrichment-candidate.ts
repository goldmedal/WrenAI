/**
 * The host-authoritative draft of an OpenShell enrichment proposal: which project files it would write, whether every edit is purely
 * additive, and the exact bounded before/after of each file against the PUBLISHED SNAPSHOT's bytes.
 *
 * The sandbox validator re-checks the same rules (defence in depth) and must return a change set byte-equal to the one built here;
 * nothing an agent or model claims about success is read.
 */
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readSync, realpathSync, rmSync, writeSync } from "node:fs";
import path from "node:path";
import { TextDecoder } from "node:util";
import { isEnrichmentSink, sinkMatchesKind, type EnrichmentChangeKind, type EnrichmentProposal } from "./enrichment.js";
import { isAdditiveYaml, isDescriptionOnlyChange, parseYamlSubset, YamlSubsetError, type YamlNode } from "./enrichment-yaml.js";

export const CANDIDATE_LIMITS = Object.freeze({ files: 20, pathLength: 160, afterBytes: 65_536, beforeBytes: 65_536, beforeTotalBytes: 262_144, mdlBytes: 98_304 });

export type CandidateFailureCode = "no_changes" | "too_many_files" | "path_invalid" | "sink_not_allowed" | "duplicate_path" | "binary_content" | "too_large"
  | "source_unreadable" | "yaml_unsupported" | "yaml_unsupported_existing" | "not_additive" | "unsupported_by_runtime";
const MESSAGES: Record<CandidateFailureCode, string> = {
  no_changes: "The proposal changes no project file.",
  too_many_files: "The proposal changes more files than the review limit allows.",
  path_invalid: "A proposed path is not a valid project-relative path.",
  sink_not_allowed: "A proposed path is not an allowed enrichment sink.",
  duplicate_path: "Two proposed changes target the same file.",
  binary_content: "Proposed or existing text is not plain UTF-8 text.",
  too_large: "The proposed change exceeds the review size limits.",
  source_unreadable: "An existing file could not be read from the published snapshot.",
  yaml_unsupported: "The proposed YAML uses constructs the host review cannot verify.",
  yaml_unsupported_existing: "An existing YAML file uses constructs the host review cannot verify.",
  not_additive: "The change modifies or removes existing content; only additive edits are allowed.",
  unsupported_by_runtime: "This runtime only accepts additions to existing knowledge, model descriptions and relationships; new files, cubes, views and calculated columns are not supported.",
};
export interface CandidateFailure { readonly stage: "host"; readonly code: CandidateFailureCode; readonly message: string; readonly path?: string }
export interface CandidateFile {
  /** Under option A every candidate file already exists in the published snapshot: there is no `added`. */
  readonly path: string; readonly change: "modified"; readonly before: string; readonly after: string;
  /** The host-built tail a Markdown file gained (what a reviewer actually reads); null for YAML. */
  readonly appended: string | null;
  readonly beforeSha256: string; readonly afterSha256: string;
}
export type CandidateResult = { readonly ok: true; readonly files: readonly CandidateFile[] } | { readonly ok: false; readonly failure: CandidateFailure };

const sha256 = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
const strictUtf8 = new TextDecoder("utf-8", { fatal: true });
const refuse = (code: CandidateFailureCode, sink?: unknown): CandidateResult => ({ ok: false, failure: { stage: "host", code, message: MESSAGES[code],
  ...(typeof sink === "string" && isEnrichmentSink(sink) ? { path: sink } : {}) } });
export const validPath = (sink: unknown): sink is string => typeof sink === "string" && sink.length > 0 && sink.length <= CANDIDATE_LIMITS.pathLength && !sink.startsWith("/")
  && !/[\\\0]/.test(sink) && sink.split("/").every((part) => part !== "" && part !== "." && part !== "..");

/**
 * How the host appends a `knowledge_append` proposal to the existing file: the proposal text is the TAIL, never the whole file.
 * Leading line breaks of the tail are dropped, exactly one separating newline is inserted only when the file is non-empty and does not already
 * end with one, and the tail always ends with a newline. The model never has to reproduce the existing text.
 */
export const KNOWLEDGE_APPEND_RULE = "after = before + (before is empty or ends with LF ? \"\" : LF) + tail without leading line breaks + (tail ends with LF ? \"\" : LF)";
export function appendKnowledge(before: string, tail: string): { readonly after: string; readonly appended: string } | undefined {
  const text = tail.replace(/^(?:\r?\n)+/, "");
  if (/^[ \t\r\n]*$/.test(text)) return undefined;
  const appended = `${before === "" || before.endsWith("\n") ? "" : "\n"}${text}${text.endsWith("\n") ? "" : "\n"}`;
  return { after: before + appended, appended };
}

/**
 * How the host realizes a `description_append` proposal: the model returns only the descriptions to add, never the file. The payload
 * is a closed YAML mapping, `description` (the model) and/or `columns` (existing column name -> description), every value one line of text.
 * The host edits the existing bytes line by line: a description is added after the `name` line it belongs to, or an existing single-line
 * description is extended; every other original line survives unchanged. The result is then verified independently of how it was built.
 */
export const DESCRIPTION_PAYLOAD_LIMITS = Object.freeze({ bytes: 8_192, columns: 100, valueChars: 500 });
export const DESCRIPTION_MERGE_RULE = "after = before with, per described node, an existing single-line description replaced by `description: <JSON string of old + SPACE + addition>` or a new `description: <JSON string>` line inserted after the node's `name` line";
export type MergeResult = { readonly ok: true; readonly after: string } | { readonly ok: false; readonly code: CandidateFailureCode };
const mergeFailure = (code: CandidateFailureCode): MergeResult => ({ ok: false, code });
/** Everything outside PyYAML's printable set (space..~, U+00A0..U+D7FF, U+E000..U+FFFD, astral), plus the Unicode line separators it accepts but reads as breaks. */
const DESCRIPTION_CONTROL = /[^\u0020-\u007e\u00a0-\ud7ff\ue000-\ufffd\u{10000}-\u{10ffff}]|[\u2028\u2029]/u;
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

function descriptionText(node: YamlNode): string | undefined {
  if (node.t !== "str" || DESCRIPTION_CONTROL.test(node.v) || LONE_SURROGATE.test(node.v)) return undefined;
  const text = node.v.trim();
  return text !== "" && text.length <= DESCRIPTION_PAYLOAD_LIMITS.valueChars ? text : undefined;
}
function parseDescriptionPayload(draft: string): { readonly model: string | undefined; readonly columns: ReadonlyMap<string, string> } | CandidateFailureCode {
  if (Buffer.byteLength(draft, "utf8") > DESCRIPTION_PAYLOAD_LIMITS.bytes) return "too_large";
  let root: YamlNode;
  try { root = parseYamlSubset(draft); } catch (error) { if (error instanceof YamlSubsetError) return "yaml_unsupported"; throw error; }
  if (root.t !== "map") return "yaml_unsupported";
  let model: string | undefined; const columns = new Map<string, string>();
  for (const [key, value] of root.entries) {
    if (key === "description") { model = descriptionText(value); if (model === undefined) return "yaml_unsupported"; }
    else if (key === "columns") {
      if (value.t !== "map") return "yaml_unsupported";
      if (value.entries.size > DESCRIPTION_PAYLOAD_LIMITS.columns) return "too_large";
      for (const [name, text] of value.entries) { const description = descriptionText(text); if (description === undefined) return "yaml_unsupported"; columns.set(name, description); }
    } else return "yaml_unsupported";
  }
  return model === undefined && columns.size === 0 ? "yaml_unsupported" : { model, columns };
}

interface Slot { readonly kind: "direct" | "properties" | "none"; readonly value?: string }
/** Where a map keeps its description: directly, else under `properties` (where Wren keeps it). */
function descriptionSlot(node: YamlNode): Slot {
  if (node.t !== "map") return { kind: "none" };
  const direct = node.entries.get("description");
  if (direct) return direct.t === "str" ? { kind: "direct", value: direct.v } : { kind: "direct" };
  const properties = node.entries.get("properties");
  const nested = properties?.t === "map" ? properties.entries.get("description") : undefined;
  return nested ? (nested.t === "str" ? { kind: "properties", value: nested.v } : { kind: "properties" }) : { kind: "none" };
}
/** A structural fingerprint that leaves out only the one description slot of the model and of each column. */
function fingerprint(node: YamlNode, skipDescription: boolean, columnsOf = false): unknown {
  if (node.t === "str") return ["s", node.v];
  if (node.t === "other") return ["o", node.v];
  if (node.t === "seq") return ["q", node.items.map((item) => fingerprint(item, columnsOf))];
  const slot = skipDescription ? descriptionSlot(node).kind : "none";
  const entries: unknown[] = [];
  for (const [key, value] of node.entries) {
    if (slot === "direct" && key === "description") continue;
    if (slot === "properties" && key === "properties" && value.t === "map") { entries.push([key, ["m", [...value.entries].filter(([name]) => name !== "description").map(([name, item]) => [name, fingerprint(item, false)])]]); continue; }
    entries.push([key, fingerprint(value, false, skipDescription && key === "columns")]);
  }
  return ["m", entries];
}
function describedNodes(root: YamlNode): { readonly model: YamlNode; readonly columns: readonly { readonly name: string; readonly node: YamlNode }[] } | undefined {
  if (root.t !== "map") return undefined;
  const list = root.entries.get("columns");
  const columns: { name: string; node: YamlNode }[] = [];
  if (list !== undefined) {
    if (list.t !== "seq") return undefined;
    for (const item of list.items) { const name = item.t === "map" ? item.entries.get("name") : undefined; if (item.t !== "map" || name?.t !== "str") return undefined; columns.push({ name: name.v, node: item }); }
  }
  return { model: root, columns };
}

/**
 * Independent verification of a merged description change: it must parse, be additive, be description-only, differ from the original only in the
 * one description slot of the model and of each named column, and carry exactly the intended text there. Returns the refusal code, or undefined.
 */
export function verifyMerged(before: string, after: string, expected: { readonly model?: string; readonly columns: ReadonlyMap<string, string> }): CandidateFailureCode | undefined {
  let next: YamlNode, previous: YamlNode;
  try { next = parseYamlSubset(after); } catch (error) { if (error instanceof YamlSubsetError) return "yaml_unsupported"; throw error; }
  try { previous = parseYamlSubset(before); } catch (error) { if (error instanceof YamlSubsetError) return "yaml_unsupported_existing"; throw error; }
  if (!isAdditiveYaml(previous, next)) return "not_additive";
  if (!isDescriptionOnlyChange(previous, next)) return "unsupported_by_runtime";
  const was = describedNodes(previous), now = describedNodes(next);
  if (!was || !now || was.columns.length !== now.columns.length) return "not_additive";
  if (JSON.stringify(fingerprint(previous, true)) !== JSON.stringify(fingerprint(next, true))) return "not_additive";
  const same = (a: Slot, b: Slot, want: string | undefined) => (want === undefined ? a.value === b.value : b.value === want);
  if (!same(descriptionSlot(was.model), descriptionSlot(now.model), expected.model)) return "not_additive";
  for (const [index, column] of was.columns.entries()) {
    const other = now.columns[index]!;
    if (other.name !== column.name || !same(descriptionSlot(column.node), descriptionSlot(other.node), expected.columns.get(column.name))) return "not_additive";
  }
  for (const name of expected.columns.keys()) if (!was.columns.some((column) => column.name === name)) return "unsupported_by_runtime";
  return undefined;
}

interface Region { readonly start: number; readonly end: number; readonly column: number; readonly dashFirst: boolean }
type Edit = { readonly kind: "replace"; readonly line: number; readonly text: string } | { readonly kind: "insert"; readonly before: number; readonly text: string };

export function mergeDescriptions(before: string, draft: string): MergeResult {
  const payload = parseDescriptionPayload(draft);
  if (typeof payload === "string") return mergeFailure(payload);
  let root: YamlNode;
  try { root = parseYamlSubset(before); } catch (error) { if (error instanceof YamlSubsetError) return mergeFailure("yaml_unsupported_existing"); throw error; }
  const nodes = describedNodes(root);
  if (!nodes || new Set(nodes.columns.map((column) => column.name)).size !== nodes.columns.length) return mergeFailure("yaml_unsupported_existing");
  const eol = before.includes("\r\n") ? "\r\n" : "\n";
  if (eol === "\r\n" && /(?<!\r)\n/.test(before)) return mergeFailure("yaml_unsupported_existing");
  const lines = before.split(eol);
  const indentOf = (line: string) => line.length - line.trimStart().length;
  const significant = (line: string) => line.trim() !== "" && !line.trimStart().startsWith("#");
  /** The one line in the region that holds `key` at the region's key column, undefined when there is none, null when ambiguous. */
  const findKey = (region: Region, key: string): number | undefined | null => {
    const found: number[] = [];
    for (let i = region.start; i < region.end; i++) {
      const head = lines[i]!.slice(0, region.column);
      if (!(i === region.start && region.dashFirst) && !(head.length === region.column && /^ *$/.test(head))) continue;
      const rest = lines[i]!.slice(region.column);
      if (rest.startsWith(key) && /^[ \t]*:(?:[ \t]|$)/.test(rest.slice(key.length))) found.push(i);
    }
    return found.length > 1 ? null : found[0];
  };
  /** A `name` whose value is empty or a block scalar spans more than its line, so a line cannot be inserted after it. */
  const scalarOpensBlock = (line: number, column: number): boolean => { const rest = lines[line]!.slice(column).replace(/^name[ \t]*:[ \t]*/, ""); return rest === "" || /^[|>]/.test(rest); };
  const model: Region = { start: 0, end: lines.length, column: 0, dashFirst: false };
  const edits: Edit[] = []; const expected = new Map<string, string>(); let expectedModel: string | undefined;
  const refuseExisting = mergeFailure("yaml_unsupported_existing");

  /** Plans the edit for one node; `insertAfter` is the line a new description goes after (the node's `name`). */
  const plan = (node: YamlNode, region: Region, addition: string, insertBefore: number): { readonly text: string } | CandidateFailureCode => {
    const slot = descriptionSlot(node);
    let holder = region, line: number | undefined | null;
    if (slot.kind === "none") { edits.push({ kind: "insert", before: insertBefore, text: `${" ".repeat(region.column)}description: ${JSON.stringify(addition)}` }); return { text: addition }; }
    if (slot.kind === "properties") {
      const header = findKey(region, "properties");
      if (typeof header !== "number") return "yaml_unsupported_existing";
      let end = header + 1, column = -1;
      for (let i = header + 1; i < region.end; i++) {
        if (significant(lines[i]!)) { if (indentOf(lines[i]!) <= region.column) break; if (column < 0) column = indentOf(lines[i]!); }
        end = i + 1;
      }
      if (column < 0) return "yaml_unsupported_existing";
      holder = { start: header + 1, end, column, dashFirst: false };
    }
    line = findKey(holder, "description");
    if (typeof line !== "number" || slot.value === undefined) return "yaml_unsupported_existing";
    const value = lines[line]!.slice(holder.column).replace(/^description[ \t]*:[ \t]*/, "");
    if (value === "" || /^[|>]/.test(value)) return "yaml_unsupported_existing";
    const text = slot.value === "" || /\s$/.test(slot.value) ? slot.value + addition : `${slot.value} ${addition}`;
    // A trailing comment on the replaced description line is dropped with the old value (documented, tested).
    edits.push({ kind: "replace", line, text: `${lines[line]!.slice(0, holder.column)}description: ${JSON.stringify(text)}` });
    return { text };
  };

  if (payload.model !== undefined) {
    const named = findKey(model, "name");
    if (named === null || (named !== undefined && scalarOpensBlock(named, 0))) return refuseExisting;
    const planned = plan(root, model, payload.model, named === undefined ? (lines[0]!.trim() === "---" ? 1 : 0) : named + 1);
    if (typeof planned === "string") return mergeFailure(planned);
    expectedModel = planned.text;
  }
  if (payload.columns.size > 0) {
    for (const name of payload.columns.keys()) if (!nodes.columns.some((column) => column.name === name)) return mergeFailure("unsupported_by_runtime");
    const header = findKey(model, "columns");
    if (typeof header !== "number") return refuseExisting;
    let first = header + 1;
    while (first < lines.length && !significant(lines[first]!)) first++;
    const seqIndent = first < lines.length ? indentOf(lines[first]!) : 0;
    const starts: number[] = []; let stop = lines.length;
    for (let i = first; i < lines.length; i++) {
      if (!significant(lines[i]!)) continue;
      const indent = indentOf(lines[i]!);
      const dash = /^-(?:[ \t]|$)/.test(lines[i]!.slice(indent));
      if (indent < seqIndent || (indent === seqIndent && !dash)) { stop = i; break; }
      if (indent === seqIndent) starts.push(i);
    }
    if (starts.length !== nodes.columns.length) return refuseExisting;
    for (const [index, column] of nodes.columns.entries()) {
      const addition = payload.columns.get(column.name);
      if (addition === undefined) continue;
      const start = starts[index]!, end = starts[index + 1] ?? stop;
      const prefix = /^( *-[ \t]+)\S/.exec(lines[start]!);
      let region: Region;
      if (prefix) region = { start, end, column: prefix[1]!.length, dashFirst: true };
      else {
        let next = start + 1; while (next < end && !significant(lines[next]!)) next++;
        if (next >= end) return refuseExisting;
        region = { start, end, column: indentOf(lines[next]!), dashFirst: false };
      }
      const named = findKey(region, "name");
      if (typeof named !== "number" || scalarOpensBlock(named, region.column)) return refuseExisting;
      const planned = plan(column.node, region, addition, named + 1);
      if (typeof planned === "string") return mergeFailure(planned);
      expected.set(column.name, planned.text);
    }
  }

  const out = [...lines];
  for (const edit of [...edits].sort((a, b) => (editPosition(b) - editPosition(a)))) {
    if (edit.kind === "replace") out[edit.line] = edit.text; else out.splice(edit.before, 0, edit.text);
  }
  const after = out.join(eol);
  if (!preservesLines(lines, out, edits)) return mergeFailure("not_additive");
  const code = verifyMerged(before, after, { ...(expectedModel === undefined ? {} : { model: expectedModel }), columns: expected });
  return code ? mergeFailure(code) : { ok: true, after };
}
const editPosition = (edit: Edit): number => (edit.kind === "replace" ? edit.line : edit.before - 0.5);

/** Every original line survives, in order, unchanged unless it is a replaced description line; the only other lines are the inserted ones. */
function preservesLines(before: readonly string[], after: readonly string[], edits: readonly Edit[]): boolean {
  const replaced = new Map(edits.flatMap((edit) => (edit.kind === "replace" ? [[edit.line, edit.text] as const] : [])));
  const inserted = edits.flatMap((edit) => (edit.kind === "insert" ? [edit.text] : []));
  if (after.length !== before.length + inserted.length) return false;
  let p = 0;
  for (const line of after) {
    if (p < before.length && (replaced.has(p) ? replaced.get(p) === line : before[p] === line)) { p++; continue; }
    const at = inserted.indexOf(line);
    if (at < 0) return false;
    inserted.splice(at, 1);
  }
  return p === before.length && inserted.length === 0;
}

/** Kinds this runtime cannot serve: cubes, views and calculated columns (the governed data worker refuses a project that has them). */
const UNSUPPORTED_KINDS: readonly EnrichmentChangeKind[] = ["new_cube", "new_view", "calculated_column"];
/** Path-and-kind-only part of the scope rule, safe to run before any snapshot exists. Returns the offending sink, or undefined. */
export function scopeViolation(proposal: Pick<EnrichmentProposal, "operations">): { readonly sink: string } | undefined {
  for (const operation of proposal.operations) {
    if (operation.changeKind === "conflict" || operation.changeKind === "ambiguous") continue;
    if (UNSUPPORTED_KINDS.includes(operation.changeKind) || /^(?:cubes|views)\//.test(operation.sink)) return { sink: operation.sink };
  }
  return undefined;
}
export const scopeFailure = (sink: string): CandidateFailure => ({ stage: "host", code: "unsupported_by_runtime", message: MESSAGES.unsupported_by_runtime, ...(isEnrichmentSink(sink) ? { path: sink } : {}) });
/** The same rule from a sink alone (used again by Apply as a precondition). */
export const sinkInRuntimeScope = (sink: string): boolean => isEnrichmentSink(sink) && !/^(?:cubes|views)\//.test(sink);

/**
 * `read` returns the verified snapshot bytes of a project-relative file, or undefined when the snapshot has no such file.
 * It may throw; that is `source_unreadable`. Conflict/ambiguous operations name no applicable file and are review-only.
 * A file the snapshot lacks is never created (the governed snapshot must keep equalling its approved file list): `unsupported_by_runtime`.
 */
export function buildCandidate(proposal: Pick<EnrichmentProposal, "operations">, read: (relative: string, maxBytes: number) => Buffer | undefined): CandidateResult {
  const operations = proposal.operations.filter((operation) => operation.changeKind !== "conflict" && operation.changeKind !== "ambiguous");
  if (operations.length === 0) return refuse("no_changes");
  if (operations.length > CANDIDATE_LIMITS.files) return refuse("too_many_files");
  const seen = new Set<string>(); const files: CandidateFile[] = [];
  let afterTotal = 0, beforeTotal = 0;
  for (const operation of operations) {
    const sink: unknown = operation.sink;
    if (!validPath(sink)) return refuse("path_invalid");
    if (!isEnrichmentSink(sink) || (operation.changeKind === "description_append" && !sinkMatchesKind(operation.changeKind, sink))) return refuse("sink_not_allowed");
    if (scopeViolation({ operations: [operation] })) return refuse("unsupported_by_runtime", sink);
    if (seen.has(sink.toLowerCase())) return refuse("duplicate_path", sink);
    seen.add(sink.toLowerCase());
    const draft: unknown = operation.draft;
    if (typeof draft !== "string" || draft.includes("\0") || Buffer.from(draft, "utf8").toString("utf8") !== draft) return refuse("binary_content", sink);
    let beforeBytes: Buffer | undefined;
    try { beforeBytes = read(sink, CANDIDATE_LIMITS.beforeBytes); } catch { return refuse("source_unreadable", sink); }
    if (!beforeBytes) return refuse("unsupported_by_runtime", sink);
    beforeTotal += beforeBytes.length;
    if (beforeBytes.length > CANDIDATE_LIMITS.beforeBytes || beforeTotal > CANDIDATE_LIMITS.beforeTotalBytes) return refuse("too_large", sink);
    let before: string;
    try { before = strictUtf8.decode(beforeBytes); } catch { return refuse("binary_content", sink); }
    if (before.includes("\0")) return refuse("binary_content", sink);
    let after: string; let appended: string | null = null;
    if (operation.changeKind === "knowledge_append") {
      const built = appendKnowledge(before, draft);
      if (!built) return refuse("no_changes", sink);
      ({ after, appended } = built);
    } else if (operation.changeKind === "description_append") {
      const merged = mergeDescriptions(before, draft);
      if (!merged.ok) return refuse(merged.code, sink);
      after = merged.after;
    } else after = draft.endsWith("\n") ? draft : `${draft}\n`;
    const afterBytes = Buffer.from(after, "utf8");
    afterTotal += afterBytes.length;
    if (afterTotal > CANDIDATE_LIMITS.afterBytes) return refuse("too_large", sink);
    if (before === after) continue;
    if (sink.endsWith(".md")) {
      if (!afterBytes.subarray(0, beforeBytes.length).equals(beforeBytes)) return refuse("not_additive", sink);
      appended ??= after.slice(before.length);
    } else {
      let next, previous;
      try { next = parseYamlSubset(after); } catch (error) { if (error instanceof YamlSubsetError) return refuse("yaml_unsupported", sink); throw error; }
      try { previous = parseYamlSubset(before); } catch (error) { if (error instanceof YamlSubsetError) return refuse("yaml_unsupported_existing", sink); throw error; }
      if (!isAdditiveYaml(previous, next)) return refuse("not_additive", sink);
      if (sink.startsWith("models/") && !isDescriptionOnlyChange(previous, next)) return refuse("unsupported_by_runtime", sink);
    }
    files.push({ path: sink, change: "modified", before, after, appended, beforeSha256: sha256(beforeBytes), afterSha256: sha256(afterBytes) });
  }
  if (files.length === 0) return refuse("no_changes");
  return { ok: true, files: files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)) };
}

export interface ReviewDiffEntry { readonly path: string; readonly change: "modified"; readonly beforeSha256: string; readonly afterSha256: string; readonly before: string; readonly after: string; readonly appended: string | null }
/** The exact, bounded before/after the human reviews (and a later apply step binds to via `diffSha256`). */
export function buildReviewDiff(files: readonly CandidateFile[]): { readonly diff: readonly ReviewDiffEntry[]; readonly diffSha256: string } {
  const diff = files.map(({ path: file, change, beforeSha256, afterSha256, before, after, appended }) => ({ path: file, change, beforeSha256, afterSha256, before, after, appended }));
  return { diff, diffSha256: `sha256:${sha256(JSON.stringify(diff))}` };
}
/** Digest of the exact change set (path and content bytes) the validator must have applied. */
export function changeSetSha256(files: readonly { readonly path: string; readonly content: string }[]): string {
  return `sha256:${sha256(JSON.stringify(files.map(({ path: file, content }) => ({ path: file, sha256: sha256(content) }))))}`;
}

/**
 * Host-owned scratch directory (0700, not a symlink, realpath-contained) the candidate is materialized into and read back from with
 * `O_NOFOLLOW` before it is sent anywhere. The read-back bytes, not the in-memory strings, are what the validator is given.
 */
export function materializeCandidate(scratchRoot: string, files: readonly CandidateFile[]): { readonly files: readonly { readonly path: string; readonly content: string }[]; dispose(): void } {
  mkdirSync(scratchRoot, { recursive: true, mode: 0o700 });
  const rootInfo = lstatSync(scratchRoot);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory() || (rootInfo.mode & 0o077) !== 0) throw new Error("draft scratch root is not private");
  const root = realpathSync(scratchRoot);
  const directory = mkdtempSync(path.join(root, "draft-"));
  const dispose = () => rmSync(directory, { recursive: true, force: true });
  try {
    if (realpathSync(directory) !== directory || path.dirname(directory) !== root || (lstatSync(directory).mode & 0o077) !== 0) throw new Error("draft scratch is not contained");
    const out: { path: string; content: string }[] = [];
    for (const file of files) {
      const target = path.join(directory, file.path);
      if (path.relative(directory, target).startsWith("..") || path.isAbsolute(path.relative(directory, target))) throw new Error("draft path escapes scratch");
      mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      const bytes = Buffer.from(file.after, "utf8");
      const writer = openSync(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { let offset = 0; while (offset < bytes.length) offset += writeSync(writer, bytes, offset); } finally { closeSync(writer); }
      const reader = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const info = fstatSync(reader);
        if (!info.isFile() || info.size !== bytes.length) throw new Error("draft read-back mismatch");
        const back = Buffer.alloc(bytes.length); let length = 0;
        while (length < back.length) { const n = readSync(reader, back, length, back.length - length, null); if (!n) break; length += n; }
        if (length !== bytes.length || !back.equals(bytes)) throw new Error("draft read-back mismatch");
        out.push({ path: file.path, content: back.toString("utf8") });
      } finally { closeSync(reader); }
    }
    return { files: out, dispose };
  } catch (error) { dispose(); throw error; }
}
