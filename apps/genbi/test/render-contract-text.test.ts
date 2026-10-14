import { describe, expect, it } from "vitest";
import { describeRenderContract } from "../harness/components/render-contract-text.js";

const blocks = [
  { type: "kpi_card", fields: { label: "string", value: "number|string", unit: "string?", delta: "number?" } },
  { type: "table", fields: { columns: "string[]", rows: "row[]" } },
];

describe("render contract text", () => {
  const text = describeRenderContract(blocks);

  it("presents each block as a flat instance template", () => {
    expect(text).toContain('{"type":"kpi_card","label":<string>,"value":<number|string>,"unit":<string, optional>,"delta":<number, optional>}');
    expect(text).toContain('{"type":"table","columns":<string[]>,"rows":<row[]>}');
  });

  it("states the fields go at the top level and never presents fields as a key to emit", () => {
    expect(text).toContain("Block fields go at the top level of the block object, never under a `fields` key.");
    expect(text).not.toContain('"fields":');
    expect(text).not.toContain("fields:{");
  });
});
