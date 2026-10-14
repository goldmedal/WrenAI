import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveWarbleBinary } from "../harness/compile/resolve-binary.js";
import { createComponentBroker } from "../harness/components/broker.js";
import { normalizeComponentEvidence } from "../harness/components/normalize.js";
import { VERCEL_HOST_CONTRACT, planDigest, readExecutionPlan } from "../harness/components/plan.js";
import { ComponentRunner, type ExecutionPlan } from "../harness/components/runner.js";

/**
 * The real genbi-default profile compiled by the pinned warble (whose Hub declares `repair_layout`), run through
 * the real plan reader, runner, broker and normalizer. Only model and database responses are synthetic.
 */
let binary: string;
const KPI_OK = { type: "kpi_card", label: "n", value: 7 };
const TABLE = { type: "table", columns: ["n"], rows: [[7]] };
const envelope = (blocks: unknown[]) => JSON.stringify({ blocks, summary: "One verified panel" });
const BROKEN = envelope([{ type: "kpi_card", value: 7, title: "model-secret-77" }, TABLE]);
const REPAIRED = envelope([KPI_OK, TABLE]);

describe("generate_dashboard repair_layout against the compiled Hub component", () => {
  let temp: string;
  let plan: ExecutionPlan;
  let run: (repairText: string, composeText?: string) => Promise<{ result: Awaited<ReturnType<ComponentRunner["run"]>>; repairConsumes: unknown[]; ran: string[]; persisted: number }>;
  let logged: string[];
  beforeEach(async () => {
    binary = await resolveWarbleBinary(process.env.WARBLE_TEST_CLI);
    logged = [];
    vi.spyOn(console, "error").mockImplementation((line: unknown) => { logged.push(String(line)); });
    temp = realpathSync(mkdtempSync(path.join(os.tmpdir(), "genbi-repair-compiled-")));
    const irPath = path.join(temp, "ir.json");
    execFileSync(binary, ["compile", path.resolve("profiles/genbi-default"), "-o", irPath], { stdio: "pipe", timeout: 60_000, env: { ...process.env, XDG_CACHE_HOME: path.join(temp, "cache") } });
    const irDocument = readFileSync(irPath, "utf8");
    const ir = JSON.parse(irDocument);
    const snapshot = JSON.parse(readFileSync(path.resolve("profiles/genbi-default/context/context.json"), "utf8"));
    const contexts = Object.fromEntries(ir.components.map((node: { id: string; context_binding: Record<string, unknown> }) => [node.id, { binding: node.context_binding, snapshot }]));
    const out = path.join(temp, "out"); mkdirSync(out);
    const hostPath = path.join(temp, "host.json"); writeFileSync(hostPath, JSON.stringify(VERCEL_HOST_CONTRACT));
    execFileSync(binary, ["dispatch", irPath, "--target", "vercel", "--provider", path.resolve("providers/wren.provider.yaml"), "--host-contract", hostPath, "--out", out], { stdio: "pipe", timeout: 30_000 });
    const text = readFileSync(path.join(out, "bundle.json"), "utf8");
    plan = readExecutionPlan(text, { digest: JSON.parse(text).bundle_sha256, inputIrDigest: planDigest(ir), contextBinding: ir.context_binding,
      declarations: Object.fromEntries(ir.components.map((node: { id: string }) => [node.id, node])) });
    const identity = { session: "synthetic", vendor: "vercel", account: "synthetic", generation: "1", project: "synthetic", bindingRevision: "1", contextDigest: planDigest(contexts), planDigest: plan.identity };
    run = async (repairText, composeText = BROKEN) => {
      const repairConsumes: unknown[] = [];
      const ran: string[] = [];
      let persisted = 0;
      const broker = createComponentBroker({ plan, contexts, identity, currentIdentity: () => identity, verifierBinary: binary,
        async prepare() {
          return { async query(input) { return { columns: ["n"], rows: [{ n: 7 }], definition: { sql: input.sql, source_tables: ["orders"], filters: [] } }; },
            async inspect() { return snapshot; }, async close() {} };
        },
        async step(step, component) {
          if (component.id === "generate_dashboard") {
            if (Object.hasOwn(step.consumes, "dashboard")) { ran.push("repair_layout"); repairConsumes.push(step.consumes["dashboard"]); return { value: repairText }; }
            if (!Object.hasOwn(step.consumes, "dashboard_plan")) { ran.push("plan_dashboard"); return { value: "One panel" }; }
            ran.push("compose_layout");
            await step.tools.answer!({ request: "the panel" });
            return { value: composeText };
          }
          if (!Object.hasOwn(step.consumes, "query_intent")) return { value: "Count the synthetic rows" };
          const tool = Object.entries(step.toolSchemas).find(([, schema]) => JSON.stringify(schema).includes('"sql"'))?.[0]!;
          await step.tools[tool]!({ sql: "SELECT n FROM orders" });
          return { value: { verified: true, columns: ["n"], rows: [[7]] } };
        },
        async normalize(component, evidence, _signal, context) { return normalizeComponentEvidence(component, evidence, context); },
        async persistRoot() { persisted++; },
      });
      const result = await new ComponentRunner(plan, broker).run("generate_dashboard", { request: "overview" });
      return { result, repairConsumes, ran, persisted };
    };
  });
  afterEach(() => { vi.restoreAllMocks(); rmSync(temp, { recursive: true, force: true }); });

  it("compiles repair_layout as a repair of compose_layout", () => {
    const steps = plan.components["generate_dashboard"]!.steps;
    expect(steps.map((step) => step.name)).toEqual(["plan_dashboard", "compose_layout", "repair_layout"]);
    expect(steps[2]).toMatchObject({ repairOf: "compose_layout", consumes: ["dashboard"], produces: "repaired_dashboard" });
  });
  it("feeds the violation to repair_layout and returns the repaired blocks, grounded", async () => {
    const out = await run(REPAIRED);
    expect(out.ran).toEqual(["plan_dashboard", "compose_layout", "repair_layout"]);
    const consumed = out.repairConsumes[0] as { status: string; code: string; reason: string; text: string };
    expect(consumed).toMatchObject({ status: "error", code: "step_failed", text: BROKEN });
    expect(consumed.reason).toMatch(/^render_contract_violation: .*field `label`/);
    expect(consumed.reason).not.toContain("model-secret-77");
    expect(out.result).toMatchObject({ status: "ok", output: { kind: "render", blocks: [KPI_OK, TABLE] }, provenance: { verified: true } });
    expect(JSON.stringify(out.result)).not.toContain("model-secret-77");
    expect(out.persisted).toBe(1);
    expect(logged.filter((line) => line.includes('"site":"step_render_check"'))).toHaveLength(1);
  });
  it("skips repair_layout when compose_layout conforms", async () => {
    const out = await run(BROKEN, REPAIRED);
    expect(out.ran).toEqual(["plan_dashboard", "compose_layout"]);
    expect(out.result).toMatchObject({ status: "ok", output: { kind: "render", blocks: [KPI_OK, TABLE] } });
  });
  it("a repair that still violates ends in the render-contract refusal", async () => {
    const out = await run(BROKEN);
    expect(out.ran).toEqual(["plan_dashboard", "compose_layout", "repair_layout"]);
    expect(out.result).toMatchObject({ status: "refused", code: "callee_refused" });
    expect((out.result as { message: string }).message).toMatch(/^The result did not match the render contract: .*field `label`/);
  });
});
