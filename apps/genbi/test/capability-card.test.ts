import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { generatePreparedContextAndCatalog, resolveContextLoader } from "../harness/compile/context-loader.js";
import { buildCapabilityCard, capabilityCatalogSchema, DEFAULT_CARD_MAX_BYTES } from "../harness/components/capability-card.js";
import { describeZoneDryRun, formatZoneDryRun } from "../harness/components/zone-dry-run.js";
import { reportPlan, splitBinding } from "./zone-fixtures.js";

const FIXTURE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "card-project");

/** Runs the real generator over `project` and returns the catalog document text. */
async function catalogOf(project: string): Promise<string> {
  const scratch = await mkdtemp(path.join(os.tmpdir(), "genbi-card-"));
  try {
    await generatePreparedContextAndCatalog(resolveContextLoader().bin, project, path.join(scratch, "context.json"), path.join(scratch, "catalog.json"));
    return await readFile(path.join(scratch, "catalog.json"), "utf8");
  } finally { await rm(scratch, { recursive: true, force: true }); }
}

describe("capability card", () => {
  it("is byte-identical across runs and carries names, types, descriptions, relationships, enum meanings, grains and the declared date range", async () => {
    const [first, second] = await Promise.all([catalogOf(FIXTURE), catalogOf(FIXTURE)]);
    expect(first).toBe(second);
    const a = buildCapabilityCard(JSON.parse(first));
    const b = buildCapabilityCard(JSON.parse(second));
    expect(a.text).toBe(b.text);
    expect(a.digest).toBe(b.digest);
    expect(a.truncated).toBe(false);
    const card = a.text;
    expect(card).toMatchSnapshot();
    expect(card).toContain("project: card_demo (duckdb)");
    expect(card).toContain("- customers [pk: id] — One row per customer account.");
    expect(card).toContain("  - id: INTEGER (not null) — Unique customer id.");
    expect(card).toContain("  - customer_id: INTEGER (relationship: orders_customer)");
    expect(card).toContain("  - amount_cents: BIGINT (calculated)");
    expect(card).toContain("- orders_customer: orders customers MANY_TO_ONE on orders.customer_id = customers.id");
    expect(card).toContain("- order_metrics (base: orders) — Revenue and order counts.");
    expect(card).toContain("measures: total_revenue DOUBLE — Sum of order amounts in USD.; order_count BIGINT");
    expect(card).toContain("time dimensions: order_date DATE [grains: day/month/quarter/year; range: 2023-01-01..2024-12-31]");
    expect(card).toContain("- customer_orders — Orders joined to their customer.");
    expect(card).toContain("- customers.tier: ENT = enterprise; SMB = small business");
    expect(card).toContain("- customers.status: A = active; C = churned");
  });
  it("contains no sample values, no row counts, no SQL and no hidden column, although the fixture carries all of them", async () => {
    const catalog = await catalogOf(FIXTURE);
    for (const forbidden of ["Acme Corp", "Globex", "Initech", "sample_values", "SELECT", "FROM", "deleted_at", "amount * 100", "expression", "statement", "total-revenue", "row_count", "rows"]) {
      expect(catalog, `catalog carries ${forbidden}`).not.toContain(forbidden);
    }
    const card = buildCapabilityCard(JSON.parse(catalog)).text;
    for (const forbidden of ["Acme Corp", "Globex", "Initech", "SELECT", "FROM ", "deleted_at", "amount * 100", "internal_note", "sample_values"]) {
      expect(card, `card carries ${forbidden}`).not.toContain(forbidden);
    }
    expect(card).toContain("It carries no sample values, row counts or SQL");
  });
  it("does not change when unknown fields are added to the project (allow-list, not deny-list)", async () => {
    const baseline = buildCapabilityCard(JSON.parse(await catalogOf(FIXTURE)));
    const copy = await mkdtemp(path.join(os.tmpdir(), "genbi-card-unknown-"));
    try {
      await cp(FIXTURE, copy, { recursive: true });
      const model = path.join(copy, "models", "customers", "metadata.yml");
      await writeFile(model, `${await readFile(model, "utf8")}retention_days: 90\nproperties_extra: { pii_level: high }\n`);
      const column = await readFile(model, "utf8");
      await writeFile(model, column.replace("      description: Unique customer id.\n", "      description: Unique customer id.\n      sample_rows: [1, 2, 3]\n      classification: confidential\n"));
      const cube = path.join(copy, "cubes", "order_metrics", "metadata.yml");
      await writeFile(cube, `${await readFile(cube, "utf8")}refresh_schedule: hourly\n`);
      const changed = buildCapabilityCard(JSON.parse(await catalogOf(copy)));
      expect(changed.text).toBe(baseline.text);
      expect(changed.digest).toBe(baseline.digest);
    } finally { await rm(copy, { recursive: true, force: true }); }
    // The second allow-list layer: unknown keys in the catalog document itself are stripped too.
    const doc = JSON.parse(await catalogOf(FIXTURE)) as { models: Record<string, unknown>[] };
    doc.models[0]!["row_count"] = 12345;
    (doc.models[0]!["columns"] as Record<string, unknown>[])[0]!["sample_values"] = ["leak"];
    (doc as Record<string, unknown>)["statistics"] = { rows: 99 };
    const stripped = buildCapabilityCard(doc);
    expect(stripped.text).toBe(baseline.text);
    expect(JSON.stringify(capabilityCatalogSchema.parse(doc))).not.toContain("leak");
  });
  it("is truncated deterministically above the size bound, with a marker line", async () => {
    const catalog = JSON.parse(await catalogOf(FIXTURE));
    const full = buildCapabilityCard(catalog);
    expect(full.bytes).toBeLessThan(DEFAULT_CARD_MAX_BYTES);
    const bound = Math.floor(full.bytes / 2);
    const a = buildCapabilityCard(catalog, { maxBytes: bound });
    const b = buildCapabilityCard(catalog, { maxBytes: bound });
    expect(a).toEqual(b);
    expect(a.truncated).toBe(true);
    expect(a.omittedLines).toBeGreaterThan(0);
    expect(a.bytes).toBeLessThanOrEqual(bound);
    expect(a.text.endsWith(`[card truncated by the size bound: ${a.omittedLines} lines omitted]`)).toBe(true);
    expect(full.text.startsWith(a.text.slice(0, a.text.lastIndexOf("\n")))).toBe(true);
    expect(a.digest).not.toBe(full.digest);
  });
  it("shows in the dry-run as the context of public-zone steps only", async () => {
    const card = buildCapabilityCard(JSON.parse(await catalogOf(FIXTURE)));
    const dryRun = describeZoneDryRun(reportPlan(), "plan_report", splitBinding(), { card: { digest: card.digest, bytes: card.bytes, truncated: card.truncated } });
    expect(dryRun.contexts).toEqual({ "plan_report.plan_layout": "card", "plan_report.narrate": "card", "answer_batch.resolve_intent": "snapshot", "answer_batch.generate_sql": "snapshot" });
    const text = formatZoneDryRun(dryRun);
    expect(text).toContain(`plan_report.plan_layout  role=caller  tier=plan  key=plan  zone=public  context=card sha256:${card.digest}`);
    expect(text).toContain("answer_batch.generate_sql  role=callee  tier=strong  key=strong  zone=private  context=snapshot");
    expect(text).toContain(`capability card: sha256:${card.digest} (${card.bytes} bytes) — sent to public-zone steps only`);
  });
});
