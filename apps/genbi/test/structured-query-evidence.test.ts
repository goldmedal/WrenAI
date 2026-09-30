import { describe, expect, it } from "vitest";
import { structuredQueryEnvelope, analyticalAskPrompt } from "../server/structured-query-evidence.js";
const root = (rows: unknown = [{ week: "2018-04-09", customers: 1 }]) => ({ status: "ok",
  output: { kind: "value", value: { columns: ["week", "customers"], rows, verified: false } },
  provenance: { verified: true, definition: { sql: "SELECT week, customers FROM weekly" } } });
describe("structured query evidence", () => {
  it("preserves ordered object cells, SQL, empty rows and unknown lineage without fabricating filters", () => {
    const envelope = structuredQueryEnvelope([root(), root([])], "Full data range, ordering customers.");
    expect(envelope).toMatchObject({ verified: true, verificationScope: "query-results", explanation: "Full data range, ordering customers.",
      blocks: [{ type: "table", rows: [{ week: "2018-04-09", customers: 1 }] }, { type: "definition", sql: "SELECT week, customers FROM weekly" },
        { type: "table", rows: [] }, { type: "definition" }] });
    expect((envelope!.blocks as object[])[1]).not.toHaveProperty("filters");
  });
  it.for([[], [root(), { status: "refused" }], [{ ...root(), provenance: { verified: false } }], [root([[1]])], [root([{ week: "2018-04-09" }])]])("rejects incomplete or mixed evidence: %j", (roots) => {
    expect(structuredQueryEnvelope(roots, "claimed verified")).toBeUndefined();
  });
  it("retains a host-normalized render root without parsing a model envelope", () => {
    const blocks = [{ type: "kpi_card", label: "Orders", value: 99 }];
    expect(structuredQueryEnvelope([{ status: "ok", output: { kind: "render", blocks }, provenance: { verified: true } }], "interpretation"))
      .toMatchObject({ blocks, verified: true });
  });
  it("anchors relative dates to an explicit clock and forbids arbitrary recent windows", () => {
    const prompt = analyticalAskPrompt("告訴我週度客戶資料", new Date("2026-09-30T00:00:00Z"));
    expect(prompt).toContain("2026-09-30T00:00:00.000Z");
    expect(prompt).toContain("full available data range");
    expect(prompt).toContain("Never silently re-anchor");
    expect(prompt).toContain("definition of each metric");
    expect(prompt).toContain("User question:\n告訴我週度客戶資料");
  });
});
