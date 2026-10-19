/**
 * A small, fail-closed reader for the YAML subset Wren metadata files use, plus the additivity rule the host enforces on enrichment.
 *
 * It is not a general YAML parser (the repo convention is small single-purpose scanners, and a dependency would edit the root
 * lockfile). Anything outside the subset throws `YamlSubsetError`; callers treat that as a refusal, never as a pass. Supported:
 * block mappings/sequences, quoted and plain scalars, a one-line flow sequence of scalars, `[]`/`{}`, and `|` `>` block scalars
 * (optional `-`/`+` chomping). Refused: tabs, anchors/aliases/tags, multi-document, flow mappings, multi-line plain/quoted
 * scalars, explicit keys, duplicate keys, indentation indicators.
 */
export class YamlSubsetError extends Error {}

export type YamlNode =
  | { readonly t: "map"; readonly entries: ReadonlyMap<string, YamlNode> }
  | { readonly t: "seq"; readonly items: readonly YamlNode[] }
  | { readonly t: "str"; readonly v: string }
  | { readonly t: "other"; readonly v: string };

const fail = (reason: string): never => { throw new YamlSubsetError(reason); };
const MAX_DEPTH = 24;
const MAX_LINES = 4096;
/** YAML whitespace is exactly space and tab. Unicode spaces are ordinary content, as in PyYAML, never separators or indentation. */
const ltrim = (text: string): string => text.replace(/^[ \t]+/, "");
const rtrim = (text: string): string => text.replace(/[ \t]+$/, "");
const atrim = (text: string): string => rtrim(ltrim(text));
/** Characters PyYAML rejects (C0 controls other than tab/LF/CR, DEL) or treats as line breaks (NEL, LS, PS) while JS does not. Refused anywhere. */
const FORBIDDEN_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u0085\u2028\u2029]/;
const KEY = /^([A-Za-z0-9_][A-Za-z0-9_.-]*)[ \t]*:(?:[ \t]+|$)/;
const PLAIN_START_FORBIDDEN = /^[\]\[{},#&*!|>'"%@`]/;
const RESERVED = new Set(["~", "null", "y", "n", "yes", "no", "true", "false", "on", "off"]);

/** A plain scalar resolves to a string only when it cannot be read as null/bool/number/date; everything else compares raw. */
function plain(text: string): YamlNode {
  const lower = text.toLowerCase();
  return text === "" || RESERVED.has(lower) || /^[-+.]?\d/.test(text) || /^[-+]?\.(?:inf|nan)$/.test(lower) ? { t: "other", v: text } : { t: "str", v: text };
}

function stripComment(text: string): string {
  let quote = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quote === '"') { if (c === "\\") i++; else if (c === '"') quote = ""; continue; }
    if (quote === "'") { if (c === "'") { if (text[i + 1] === "'") i++; else quote = ""; } continue; }
    if (c === '"' || c === "'") { if (i === 0 || /[ \t[,:]/.test(text[i - 1]!)) quote = c; continue; }
    if (c === "#" && (i === 0 || /[ \t]/.test(text[i - 1]!))) return rtrim(text.slice(0, i));
  }
  return rtrim(text);
}

function quoted(text: string): string {
  const q = text[0];
  let out = "";
  for (let i = 1; i < text.length; i++) {
    const c = text[i]!;
    if (q === "'") { if (c === "'") { if (text[i + 1] === "'") { out += "'"; i++; continue; } return i === text.length - 1 ? out : fail("trailing text after quoted scalar"); } out += c; continue; }
    if (c === '"') return i === text.length - 1 ? out : fail("trailing text after quoted scalar");
    if (c !== "\\") { out += c; continue; }
    const e = text[++i];
    if (e === "n") out += "\n"; else if (e === "t") out += "\t"; else if (e === '"' || e === "\\" || e === "/") out += e;
    else if (e === "u" && /^[0-9a-fA-F]{4}$/.test(text.slice(i + 1, i + 5))) { out += String.fromCharCode(parseInt(text.slice(i + 1, i + 5), 16)); i += 4; }
    else return fail("unsupported escape");
  }
  return fail("unterminated quoted scalar");
}

function flowSeq(text: string): YamlNode {
  if (!text.endsWith("]")) return fail("flow sequence must end on its line");
  const inner = atrim(text.slice(1, -1));
  if (inner === "") return { t: "seq", items: [] };
  const parts: string[] = []; let quote = "", start = 0;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i]!;
    if (quote) { if (quote === '"' && c === "\\") i++; else if (c === quote) quote = ""; continue; }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === "[" || c === "{" || c === "]" || c === "}") fail("nested flow collection");
    if (c === ",") { parts.push(inner.slice(start, i)); start = i + 1; }
  }
  if (quote) fail("unterminated quoted scalar");
  parts.push(inner.slice(start));
  return { t: "seq", items: parts.map((part) => { const value = atrim(part); if (!value) return fail("empty flow item"); return scalar(value); }) };
}

function scalar(text: string): YamlNode {
  if (text[0] === '"' || text[0] === "'") return { t: "str", v: quoted(text) };
  if (text[0] === "[") return flowSeq(text);
  if (text === "{}") return { t: "map", entries: new Map() };
  if (PLAIN_START_FORBIDDEN.test(text) || /^[-?:](?:[ \t]|$)/.test(text) || /:(?:[ \t]|$)/.test(text) || text.includes(" #")) return fail("unsupported scalar");
  return plain(text);
}

interface Line { indent: number; text: string }

class Reader {
  private index = 0;
  constructor(private readonly raw: string[]) {}
  private measure(index: number): Line | undefined {
    const raw = this.raw[index]!;
    if (/^ *\t/.test(raw)) fail("tab indentation");
    const indent = raw.length - ltrim(raw).length;
    const text = stripComment(ltrim(raw));
    return text === "" ? undefined : { indent, text };
  }
  /** Next significant (non-blank, non-comment) line without consuming it. */
  peek(): Line | undefined {
    while (this.index < this.raw.length) { const line = this.measure(this.index); if (line) return line; this.index++; }
    return undefined;
  }
  take(): void { this.index++; }
  /** Rewrites the current line (used for `- key: v` and `- - x`): the remainder acts as a line of its own at a deeper column. */
  replace(line: Line): void { this.raw[this.index] = " ".repeat(line.indent) + line.text; }
  blockScalar(header: string, parentIndent: number): YamlNode {
    const match = /^([|>])([-+]?)$/.exec(header);
    if (!match) return fail("unsupported block scalar header");
    const lines: string[] = []; let block = -1, leadingSpaces = 0;
    while (this.index < this.raw.length) {
      const raw = this.raw[this.index]!;
      if (/^ *\t/.test(raw)) fail("tab indentation");
      if (/^ *$/.test(raw)) {
        // A whitespace-only line is content beyond the block indent and an empty line within it; it is never silently trimmed.
        if (block < 0) { leadingSpaces = Math.max(leadingSpaces, raw.length); lines.push(""); }
        else lines.push(raw.length > block ? raw.slice(block) : "");
        this.index++; continue;
      }
      const indent = raw.length - ltrim(raw).length;
      if (block < 0) { if (indent <= parentIndent) break; block = indent; if (leadingSpaces > block) fail("whitespace-only line before block scalar content"); }
      if (indent < block) break;
      lines.push(raw.slice(block)); this.index++;
    }
    let trailing = 0;
    while (lines.length && lines[lines.length - 1] === "") { lines.pop(); trailing++; }
    let value = "";
    if (match[1] === "|") value = lines.join("\n");
    else {
      let blank = 0;
      for (const line of lines) {
        if (/^\s/.test(line)) fail("more-indented folded line");
        if (line === "") { blank++; continue; }
        if (value !== "" || blank) value += blank ? "\n".repeat(blank) : " ";
        value += line; blank = 0;
      }
    }
    if (lines.length === 0) return { t: "str", v: match[2] === "+" ? "\n".repeat(trailing) : "" };
    return { t: "str", v: match[2] === "-" ? value : value + (match[2] === "+" ? "\n".repeat(trailing + 1) : "\n") };
  }
  value(rest: string, parentIndent: number, depth: number): YamlNode {
    if (rest === "") {
      const next = this.peek();
      if (next && next.indent > parentIndent) return this.block(depth + 1);
      return { t: "other", v: "" };
    }
    if (rest[0] === "|" || rest[0] === ">") { this.take(); return this.blockScalar(rest, parentIndent); }
    const node = scalar(rest);
    this.take();
    const next = this.peek();
    if (next && next.indent > parentIndent) fail("multi-line scalar");
    return node;
  }
  block(depth: number): YamlNode {
    if (depth > MAX_DEPTH) fail("too deeply nested");
    const first = this.peek();
    if (!first) return fail("empty document");
    if (/^-(?:[ \t]|$)/.test(first.text)) return this.seq(first.indent, depth);
    if (KEY.test(first.text) || /^["'].*["'][ \t]*:(?:[ \t]|$)/.test(first.text)) return this.map(first.indent, depth);
    return fail("expected a mapping or sequence");
  }
  map(indent: number, depth: number): YamlNode {
    const entries = new Map<string, YamlNode>();
    for (;;) {
      const line = this.peek();
      if (!line || line.indent < indent) break;
      if (line.indent > indent) fail("unexpected indentation");
      if (/^-(?:[ \t]|$)/.test(line.text)) break;
      let key: string, rest: string;
      const keyed = KEY.exec(line.text);
      if (keyed) { key = keyed[1]!; rest = line.text.slice(keyed[0].length); }
      else {
        const q = line.text[0];
        if (q !== '"' && q !== "'") return fail("unsupported key");
        let end = 1; while (end < line.text.length && !(line.text[end] === q && (q === '"' ? line.text[end - 1] !== "\\" : line.text[end + 1] !== "'"))) end++;
        const after = /^[ \t]*:(?:[ \t]+|$)/.exec(line.text.slice(end + 1));
        if (!after) return fail("unsupported key");
        key = quoted(line.text.slice(0, end + 1)); rest = line.text.slice(end + 1 + after[0].length);
      }
      if (entries.has(key)) return fail("duplicate key");
      rest = atrim(rest);
      if (rest === "") {
        this.take();
        const next = this.peek();
        if (next && next.indent > indent) entries.set(key, this.block(depth + 1));
        else if (next && next.indent === indent && /^-(?:[ \t]|$)/.test(next.text)) entries.set(key, this.seq(indent, depth + 1));
        else entries.set(key, { t: "other", v: "" });
        continue;
      }
      entries.set(key, this.value(rest, indent, depth));
    }
    return { t: "map", entries };
  }
  seq(indent: number, depth: number): YamlNode {
    const items: YamlNode[] = [];
    for (;;) {
      const line = this.peek();
      if (!line || line.indent < indent) break;
      if (line.indent > indent) fail("unexpected indentation");
      if (!/^-(?:[ \t]|$)/.test(line.text)) break;
      const after = line.text.slice(1), rest = atrim(after);
      const column = indent + 1 + (after.length - ltrim(after).length);
      if (rest === "") { this.take(); const next = this.peek(); items.push(next && next.indent > indent ? this.block(depth + 1) : { t: "other", v: "" }); continue; }
      if (/^-(?:[ \t]|$)/.test(rest) || KEY.test(rest) || /^["'].*["'][ \t]*:(?:[ \t]|$)/.test(rest)) {
        this.replace({ indent: column, text: rest }); items.push(this.block(depth + 1)); continue;
      }
      items.push(this.value(rest, indent, depth));
    }
    return { t: "seq", items };
  }
}

export function parseYamlSubset(text: string): YamlNode {
  if (FORBIDDEN_CHARACTERS.test(text) || /\r(?!\n)/.test(text)) fail("control characters");
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (lines.length > MAX_LINES) fail("too many lines");
  if (atrim(lines[0] ?? "") === "---") lines.shift();
  if (lines.some((line) => atrim(line) === "---" || atrim(line) === "..." || line.startsWith("%"))) fail("multi-document or directive");
  const reader = new Reader(lines);
  const root = reader.block(0);
  if (reader.peek()) fail("trailing content");
  if (root.t !== "map" && root.t !== "seq") fail("expected a mapping or sequence");
  return root;
}

/**
 * Existing keys and values stay, lists only grow (item by item), and only a `description` string may be extended.
 * A scalar that is not a string compares raw, so a type change is never additive.
 */
export function isAdditiveYaml(before: YamlNode, after: YamlNode, key = ""): boolean {
  if (before.t === "map") return after.t === "map" && [...before.entries].every(([name, value]) => { const next = after.entries.get(name); return next !== undefined && isAdditiveYaml(value, next, name); });
  if (before.t === "seq") return after.t === "seq" && after.items.length >= before.items.length && before.items.every((item, index) => isAdditiveYaml(item, after.items[index]!, ""));
  if (before.t === "str" && key === "description") return after.t === "str" && after.v.startsWith(before.v);
  return before.t === after.t && before.v === after.v;
}

/**
 * The narrower rule for model metadata under a runtime that cannot serve new structure: everything existing stays, lists keep their length and
 * order, and the ONLY allowed change is extending an existing `description` string or adding one (directly, or as the sole entry of a new `properties` mapping, where Wren keeps it).
 * A new column (calculated or not), key or list item is not a description addition.
 */
const isDescriptionAddition = (name: string, value: YamlNode): boolean => (name === "description" && value.t === "str")
  || (name === "properties" && value.t === "map" && value.entries.size === 1 && value.entries.get("description")?.t === "str");
export function isDescriptionOnlyChange(before: YamlNode, after: YamlNode, key = ""): boolean {
  if (before.t === "map") {
    if (after.t !== "map") return false;
    for (const [name, value] of before.entries) { const next = after.entries.get(name); if (next === undefined || !isDescriptionOnlyChange(value, next, name)) return false; }
    for (const [name, value] of after.entries) { if (!before.entries.has(name) && !isDescriptionAddition(name, value)) return false; }
    return true;
  }
  if (before.t === "seq") return after.t === "seq" && after.items.length === before.items.length && before.items.every((item, index) => isDescriptionOnlyChange(item, after.items[index]!, ""));
  return isAdditiveYaml(before, after, key);
}
