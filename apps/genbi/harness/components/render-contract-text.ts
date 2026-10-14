export interface RenderBlockContract {
  readonly type: string;
  readonly fields: Readonly<Record<string, string>>;
}

function describeField(name: string, declared: string): string {
  const optional = declared.endsWith("?");
  const type = optional ? declared.slice(0, -1) : declared;
  return `${JSON.stringify(name)}:<${type}${optional ? ", optional" : ""}>`;
}

/** One block contract as a flat instance template, derived from the declared schema so it cannot drift. */
export function describeRenderBlock(block: RenderBlockContract): string {
  const members = [`"type":${JSON.stringify(block.type)}`, ...Object.entries(block.fields).map(([name, declared]) => describeField(name, declared))];
  return `{${members.join(",")}}`;
}

export function describeRenderContract(blocks: readonly RenderBlockContract[]): string {
  return [
    "Each block is a flat JSON object. Allowed block shapes (<type> is the value type; optional fields may be omitted, never null):",
    ...blocks.map((block) => `- ${describeRenderBlock(block)}`),
    "Block fields go at the top level of the block object, never under a `fields` key.",
  ].join("\n");
}
