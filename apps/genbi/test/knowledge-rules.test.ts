import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { generatePreparedContextAndCatalog, resolveContextLoader } from "../harness/compile/context-loader.js";
import { resolveWarbleBinary } from "../harness/compile/resolve-binary.js";
import { createComponentBroker, snapshotSurfaceText, type ComponentIdentity } from "../harness/components/broker.js";
import { buildCapabilityCard } from "../harness/components/capability-card.js";
import { knowledgeRulesOfCatalog, knowledgeRulesSection, withKnowledgeRules } from "../harness/components/knowledge-rules.js";
import { normalizeComponentEvidence } from "../harness/components/normalize.js";
import { planDigest } from "../harness/components/plan.js";
import { ComponentRunner, type ComponentPlan, type ExecutionPlan } from "../harness/components/runner.js";

const FIXTURE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "card-project");

async function generate(project: string): Promise<{ snapshot: unknown; catalog: unknown }> {
  const scratch = await mkdtemp(path.join(os.tmpdir(), "genbi-knowledge-rules-"));
  try {
    await generatePreparedContextAndCatalog(resolveContextLoader().bin, project, path.join(scratch, "context.json"), path.join(scratch, "catalog.json"));
    return { snapshot: JSON.parse(await readFile(path.join(scratch, "context.json"), "utf8")), catalog: JSON.parse(await readFile(path.join(scratch, "catalog.json"), "utf8")) };
  } finally { await rm(scratch, { recursive: true, force: true }); }
}

describe("knowledge rules on the private snapshot surface", () => {
  it("appends every rule file verbatim under its path, after the snapshot", async () => {
    const { snapshot, catalog } = await generate(FIXTURE);
    const rules = knowledgeRulesOfCatalog(catalog);
    expect(rules.map((rule) => rule.path)).toEqual(["knowledge/rules/general.md", "knowledge/rules/net-revenue.md"]);
    const text = snapshotSurfaceText(snapshot, rules);
    expect(text.startsWith(snapshotSurfaceText(snapshot))).toBe(true);
    expect(text).toContain("## Knowledge rules");
    expect(text).toContain("### knowledge/rules/general.md\n## Currency\nAll amounts are USD.");
    expect(text).toContain("### knowledge/rules/net-revenue.md\n## Net revenue\nNet revenue = SUM(orders.amount_cents + orders.fee_cents) / 100 per order, never the gross amount.");
    expect(text.indexOf("## Knowledge rules")).toBeGreaterThan(text.indexOf("Cubes: "));
  });
  it("renders a project without rules byte-identically to the surface before rules existed", async () => {
    const copy = await mkdtemp(path.join(os.tmpdir(), "genbi-no-rules-"));
    try {
      await cp(FIXTURE, copy, { recursive: true });
      await rm(path.join(copy, "knowledge", "rules"), { recursive: true });
      const { snapshot, catalog } = await generate(copy);
      expect(knowledgeRulesOfCatalog(catalog)).toEqual([]);
      expect((catalog as Record<string, unknown>)["knowledge_rules"]).toBeUndefined();
      expect(snapshotSurfaceText(snapshot, knowledgeRulesOfCatalog(catalog))).toBe(snapshotSurfaceText(snapshot));
      expect(knowledgeRulesSection([])).toBe("");
    } finally { await rm(copy, { recursive: true, force: true }); }
  });
  it("ignores a malformed rules list instead of rendering it", () => {
    expect(knowledgeRulesOfCatalog({ knowledge_rules: "all amounts are USD" })).toEqual([]);
    expect(knowledgeRulesOfCatalog({ knowledge_rules: [{ path: 1 }] })).toEqual([]);
    expect(knowledgeRulesOfCatalog(null)).toEqual([]);
  });
});

describe("knowledge rules on the capability card", () => {
  it("carries the full rule text, and still no confirmed SQL, definition SQL, sample values or hidden columns", async () => {
    const { catalog } = await generate(FIXTURE);
    const card = buildCapabilityCard(catalog).text;
    expect(card).toContain("## Knowledge rules");
    expect(card).toContain("### knowledge/rules/general.md\n## Currency\nAll amounts are USD.");
    expect(card).toContain("Net revenue = SUM(orders.amount_cents + orders.fee_cents) / 100 per order, never the gross amount.");
    // knowledge/sql/total-revenue.md is a confirmed query: its question, SQL and slug stay off the card although rules are present.
    for (const forbidden of ["SELECT SUM(amount)", "What is the total revenue", "total-revenue", "knowledge/sql", "Acme Corp", "deleted_at", "internal_note", "sample_values"]) {
      expect(card, `card carries ${forbidden}`).not.toContain(forbidden);
    }
  });
  it("has no rules section when the project has no rules", async () => {
    const { catalog } = await generate(FIXTURE);
    const card = buildCapabilityCard({ ...(catalog as object), knowledge_rules: undefined }).text;
    expect(card).not.toContain("Knowledge rules");
  });
  it("does not carry the legacy flag or any other unknown catalog field", async () => {
    const { catalog } = await generate(FIXTURE);
    const card = buildCapabilityCard({ ...(catalog as object), knowledge_rules_used_legacy: true, knowledge_sql: [{ slug: "leak", sql: "SELECT 1" }] }).text;
    expect(card).not.toContain("used_legacy");
    expect(card).not.toContain("leak");
  });
});

describe("knowledge rules and the context identity", () => {
  const snapshot = { context_version: 2, parseable: true };
  const rules = [{ path: "knowledge/rules/a.md", content: "Revenue excludes refunds." }, { path: "knowledge/rules/b.md", content: "Amounts are USD." }];
  const digestOf = (r: typeof rules) => planDigest({ answer: withKnowledgeRules({ binding: {}, snapshot }, r) });

  it("keeps the digest of a project without rules, and moves it when a rule is added, edited or renamed", () => {
    expect(withKnowledgeRules({ binding: {}, snapshot }, [])).toEqual({ binding: {}, snapshot });
    expect(digestOf([])).toBe(planDigest({ answer: { binding: {}, snapshot } }));
    expect(digestOf(rules)).not.toBe(digestOf([]));
    expect(digestOf([{ ...rules[0]!, content: "Revenue includes refunds." }, rules[1]!])).not.toBe(digestOf(rules));
    expect(digestOf([{ ...rules[0]!, path: "knowledge/rules/c.md" }, rules[1]!])).not.toBe(digestOf(rules));
    expect(digestOf(rules)).toBe(digestOf(structuredClone(rules)));
  });

  describe("through the broker", () => {
    let verifierBinary: string;
    beforeAll(async () => { verifierBinary = await resolveWarbleBinary(process.env.WARBLE_TEST_CLI); });
    const component = (): ComponentPlan => ({ id: "answer", declaration: { context_binding: {}, context_precondition: [{ predicate: "mdl_parseable" }], required_capabilities: ["sql_execution:read_only"], effect: { render_blocks: [] },
      guardrails: [{ name: "read_only_execution", locked: true }, { name: "row_limit", locked: true, threshold: 2 }] },
    steps: [{ name: "query", tier: "cheap", prompt: "query", consumes: [], produces: "data", tools: [{ name: "query", source: "native" }], calls: [] }] });
    const plan = (): ExecutionPlan => ({ identity: "plan", entries: ["answer"], components: { answer: component() } });
    const identityFor = (contexts: Record<string, unknown>): ComponentIdentity => ({ session: "s", vendor: "synthetic", account: "a", generation: "1", project: "p", bindingRevision: "r",
      contextDigest: planDigest(contexts), planDigest: "plan" });
    const broker = (contexts: Parameters<typeof createComponentBroker>[0]["contexts"], identity: ComponentIdentity, seen: string[]) => createComponentBroker({ plan: plan(), contexts, verifierBinary, identity,
      currentIdentity: () => identity,
      async prepare() { return { async query() { return { columns: [], rows: [] }; }, async inspect() { return {}; }, async close() {} }; },
      async step(run) { seen.push(run.prompt); return { value: "ok" }; },
      async normalize(node, evidence) { return normalizeComponentEvidence(node, evidence); } });

    it("shows the rules in the prompt of a private step, when the digest covers them", async () => {
      const contexts = { answer: withKnowledgeRules({ binding: {}, snapshot }, rules) };
      const seen: string[] = [];
      await new ComponentRunner(plan(), broker(contexts, identityFor(contexts), seen)).run("answer", { request: "q" });
      expect(seen).toHaveLength(1);
      expect(seen[0]).toContain("### knowledge/rules/a.md\nRevenue excludes refunds.");
      expect(seen[0]).toContain("### knowledge/rules/b.md\nAmounts are USD.");
    });
    it("refuses a context whose rules differ from the digest the identity was issued for", () => {
      const issued = { answer: withKnowledgeRules({ binding: {}, snapshot }, rules) };
      const mutated = { answer: withKnowledgeRules({ binding: {}, snapshot }, [{ ...rules[0]!, content: "Revenue includes refunds." }, rules[1]!]) };
      expect(() => broker(mutated, identityFor(issued), [])).toThrow("Component plan/context identity mismatch");
      expect(() => broker({ answer: { binding: {}, snapshot } }, identityFor(issued), [])).toThrow("Component plan/context identity mismatch");
      expect(() => broker(issued, identityFor(issued), [])).not.toThrow();
    });
  });
});
