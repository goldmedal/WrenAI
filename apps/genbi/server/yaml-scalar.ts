/**
 * Reads a top-level `field: value` scalar from a `wren_project.yml`-shaped
 * document and returns the YAML *value*, not the raw line remainder.
 *
 * `wren context init` scaffolds lines such as
 * `data_source:  # not set yet — ...`, and hand-edited projects keep trailing
 * comments (`data_source: duckdb  # change to your datasource type`). A raw
 * remainder would hand that comment to callers as part of the value. This
 * stays a single-purpose reader (no YAML dependency, matching the rest of
 * `server/`); it only understands what a plain scalar line can contain:
 *
 * - an unquoted value ends at the first ` #` (a `#` preceded by whitespace);
 * - a quoted value ends at its closing quote, so `"a#b"` stays `a#b` and
 *   anything after the closing quote is a comment;
 * - a blank value, or one that is only a comment, reads as `""` (unset).
 *
 * Returns `undefined` only when the field's key line is absent.
 */
export function readYamlScalarField(content: string, field: string): string | undefined {
  const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`^${escaped}:[ \\t]*(.*)$`, "m").exec(content);
  if (!match) return undefined;
  return parseScalarValue(match[1]!.replace(/\r$/, ""));
}

function parseScalarValue(rest: string): string {
  const quote = rest[0];
  if (quote === '"' || quote === "'") {
    const closing = findClosingQuote(rest, quote);
    // An unterminated quote isn't a valid scalar; fall back to the plain-scalar rule rather than guessing.
    if (closing !== -1) return rest.slice(1, closing);
  }
  return stripPlainScalarComment(rest);
}

function findClosingQuote(rest: string, quote: string): number {
  for (let i = 1; i < rest.length; i++) {
    if (quote === '"' && rest[i] === "\\") {
      i++;
      continue;
    }
    if (rest[i] === quote) {
      if (quote === "'" && rest[i + 1] === "'") {
        i++;
        continue;
      }
      return i;
    }
  }
  return -1;
}

function stripPlainScalarComment(rest: string): string {
  if (rest.startsWith("#")) return "";
  const comment = /\s#/.exec(rest);
  return (comment ? rest.slice(0, comment.index) : rest).trim();
}
