import { z } from "zod";

/** One batch entry: a slot id plus whatever the model wrote; normalization decides what is kept. */
export const batchEntry = z.object({ slot_id: z.string().min(1).max(128) }).passthrough();

// An unclosed bracket rescans to the end, and a bracket that closes but does not parse (a Markdown
// link) also counts: after this many failures the scan gives up and the text stays prose.
const MAX_FAILED_STARTS = 64;
/** The end index of the bracketed span opening at `start`, tracking JSON strings; -1 when it never closes. */
function spanEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let index = start; index < text.length; index++) {
    const char = text[index];
    if (inString) {
      if (char === "\\") index++;
      else if (char === '"') inString = false;
    } else if (char === '"') inString = true;
    else if (char === "{" || char === "[") depth++;
    else if (char === "}" || char === "]") { depth--; if (depth === 0) return index; }
  }
  return -1;
}
function parsedJson(text: string): { value: unknown } | undefined {
  try { return { value: JSON.parse(text) }; } catch { return undefined; }
}
/**
 * The one top-level JSON array or object in a prose terminal, after dropping reasoning tags
 * and Markdown fences. Zero or several candidates return undefined, so the text stays prose.
 */
function soleJsonValue(raw: string): unknown {
  const untagged = raw.replace(/<think>[\s\S]*?<\/think>/gi, "");
  // A lone closing tag: everything before it is treated as reasoning.
  const closing = untagged.toLowerCase().lastIndexOf("</think>");
  const text = (closing >= 0 ? untagged.slice(closing + "</think>".length) : untagged).replace(/```[\w-]*/g, "");
  const found: unknown[] = [];
  let failures = 0;
  for (let index = 0; index < text.length; index++) {
    if (text[index] !== "{" && text[index] !== "[") continue;
    const end = spanEnd(text, index);
    const candidate = end >= 0 ? parsedJson(text.slice(index, end + 1)) : undefined;
    if (candidate) {
      found.push(candidate.value);
      if (found.length > 1) return undefined;
      index = end;
    } else if (++failures > MAX_FAILED_STARTS) return undefined;
  }
  return found.length === 1 ? found[0] : undefined;
}

/**
 * The single definition of "a terminal parses": the whole text as JSON, else the one JSON value
 * a prose wrapper holds. A loose array counts only when it holds batch entries, so an incidental
 * array in a single-answer terminal stays prose. Malformed JSON is refused, never repaired by guess;
 * the error is the strict parse's message, for the repair step to act on.
 */
export function parseTerminalJson(text: string): { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly error: string } {
  try { return { ok: true, value: JSON.parse(text) }; } catch (error) {
    const loose = soleJsonValue(text);
    if (loose !== undefined && (!Array.isArray(loose) || loose.some((entry) => batchEntry.safeParse(entry).success))) return { ok: true, value: loose };
    return { ok: false, error: error instanceof Error ? error.message : "invalid JSON" };
  }
}
