import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { describeComponentPlan } from "../harness/components/display.js";
import { buildCapabilityCard } from "../harness/components/capability-card.js";
import type { StepRun } from "../harness/components/runner.js";
import { runInProcessDefault } from "../harness/route/in-process.js";
import { runAiComponentStep } from "../harness/components/ai-step.js";
import { openWrenComponentAccess } from "../harness/components/wren-access.js";
import { policy, priv, pub, reportPlan } from "./zone-fixtures.js";

const SNAPSHOT = { context_version: 2, parseable: true, models: [{ name: "orders", has_timestamp: true, columns: ["id", "amount"] }] };
const CATALOG = { catalog_version: 1, project: { name: "surface_demo", data_source: "duckdb" },
  models: [{ name: "orders", description: "One row per order.", primary_key: ["id"], columns: [{ name: "id", type: "INTEGER" }, { name: "amount", type: "DOUBLE", description: "USD" }] }],
  relationships: [], cubes: [], views: [] };

vi.mock("../harness/components/ai-step.js", () => ({ runAiComponentStep: vi.fn() }));
vi.mock("../harness/components/egress-judge.js", () => ({ createModelJudge: () => async () => JSON.stringify({ verdict: "pass", reason_category: "aggregate" }) }));
vi.mock("../harness/components/wren-access.js", async (original) => ({ ...await original<typeof import("../harness/components/wren-access.js")>(), openWrenComponentAccess: vi.fn() }));
vi.mock("../harness/tools/index.js", async (original) => ({ ...await original<typeof import("../harness/tools/index.js")>(), resolveWrenBinary: vi.fn() }));
vi.mock("../harness/compile/context-loader.js", () => ({ resolveContextLoader: () => ({ bin: "synthetic-context-loader" }),
  generatePreparedContext: vi.fn(async () => { throw new Error("a zone-aware run must generate the catalog too"); }),
  generatePreparedContextAndCatalog: vi.fn(async (_bin: string, _project: string, output: string, catalog: string) => {
    await writeFile(output, JSON.stringify(SNAPSHOT));
    await writeFile(catalog, JSON.stringify(CATALOG));
  }),
}));

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

beforeEach(() => vi.resetAllMocks());

describe("capability card surfaces", () => {
  it("reaches only public-zone steps, is fingerprinted per surface, and the snapshot never reaches them", async () => {
    const project = await mkdtemp(path.join(os.tmpdir(), "genbi-card-surface-"));
    try {
      const base = reportPlan();
      const plan = { ...base, systemPrompt: "Profile instructions", components: Object.fromEntries(Object.entries(base.components)
        .map(([id, node]) => [id, { ...node, declaration: { ...node.declaration, context_binding: { project } } }])) };
      vi.mocked(openWrenComponentAccess).mockResolvedValue({ query: async () => ({ columns: ["revenue"], rows: [{ revenue: "42" }] }), inspect: async () => ({}), close: async () => {} });
      const prompts: { tier: string; prompt: string }[] = [];
      vi.mocked(runAiComponentStep).mockImplementation(async (run: StepRun) => {
        prompts.push({ tier: run.tier, prompt: run.prompt });
        if (run.tools.ask) { await run.tools.ask({ request: "revenue" }); return { value: JSON.stringify({ layout: "planned" }) }; }
        if (run.tools.query) { await run.tools.query({ sql: "SELECT 42 AS revenue" }); return { value: "done" }; }
        return { value: JSON.stringify({ blocks: [{ type: "kpi_card", label: "revenue", value: "42" }] }) };
      });
      const card = buildCapabilityCard(CATALOG, { maxBytes: 260 });
      expect(card.truncated).toBe(true);
      const result = await runInProcessDefault({ bundle: describeComponentPlan(plan, "synthetic"), userProject: project, profileSource: project, question: "annual revenue report", agentId: "plan_report",
        authChoice: { mode: "api-key", adapter: "openai" },
        tierBinding: { plan: pub("sonnet"), cheap: priv("nano"), strong: priv("super"), judge: priv("nano-judge") },
        disclosurePolicy: policy, zoneRoles: { judge: "judge" }, capabilityCard: { maxBytes: 260 },
        ...(process.env.WARBLE_TEST_CLI ? { warbleBin: process.env.WARBLE_TEST_CLI } : {}),
      });
      expect(result.kind).toBe("answer");
      const surfaces = result.trace?.surfaces ?? [];
      expect(surfaces.map((record) => [record.component, record.step, record.zone, record.context])).toEqual([
        ["plan_report", "plan_layout", "public", "card"], ["answer_batch", "resolve_intent", "private", "snapshot"],
        ["answer_batch", "generate_sql", "private", "snapshot"], ["plan_report", "narrate", "public", "card"],
      ]);
      const snapshotDigest = sha(`Host semantic context:\n${JSON.stringify(SNAPSHOT)}`);
      for (const record of surfaces) {
        expect(record.algorithm).toBe("sha256");
        expect(record.surfaces["system"]).toBe(sha("Profile instructions"));
        if (record.zone === "public") { expect(record.surfaces["context"]).toBe(card.digest); expect(Object.values(record.surfaces)).not.toContain(snapshotDigest); }
        else { expect(record.surfaces["context"]).toBe(snapshotDigest); expect(Object.values(record.surfaces)).not.toContain(card.digest); }
      }
      expect(new Set(surfaces.map((record) => record.digest)).size).toBe(surfaces.length);
      // The assembled prompts agree with the fingerprints: public steps see the card, private steps the snapshot.
      for (const { tier, prompt } of prompts) {
        if (tier === "plan") { expect(prompt).toContain("# Capability card"); expect(prompt).not.toContain("Host semantic context"); }
        else { expect(prompt).toContain("Host semantic context"); expect(prompt).not.toContain("Capability card"); }
      }
      // The truncation is traced as a warning without the card text.
      const warning = result.trace?.steps.find((step) => step.tool === "capability_card");
      expect(warning?.detail).toMatch(/warning: capability card truncated by the size bound \(\d+ lines omitted, \d+ bytes kept\)/);
      expect(JSON.stringify(result.trace)).not.toContain("One row per order");
    } finally { await rm(project, { recursive: true, force: true }); }
  });
});
