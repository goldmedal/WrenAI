import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runWarble } from "../harness/compile/pipeline.js";
import { ComponentRunner, type ComponentBinding, type RunnerHost, type StepRun } from "../harness/components/runner.js";
import { loadReportPlan, REPORT_IR_GOLDEN, REPORT_PROFILE } from "./report-fixtures.js";

/**
 * The committed report profile against the released Hub. The pinned
 * `@warble/cli` carries its own Hub component library, so compiling with no
 * `--hub-dir` is exactly "the released Hub contains plan_report and
 * answer_batch": a local checkout's Hub is never consulted here.
 */
describe("genbi-report profile: released Hub, committed golden, caller SQL denial", () => {
  it("compiles from the pinned warble's own Hub (no --hub-dir) to the committed IR golden", async () => {
    const { warbleBin } = await loadReportPlan();
    const out = await mkdtemp(path.join(os.tmpdir(), "genbi-report-compile-"));
    try {
      await runWarble(warbleBin, ["compile", REPORT_PROFILE, "-o", path.join(out, "ir.json")]);
      const compiled = JSON.parse(await readFile(path.join(out, "ir.json"), "utf8"));
      const golden = JSON.parse(await readFile(REPORT_IR_GOLDEN, "utf8"));
      expect(compiled).toEqual(golden);
      expect(golden.warble_ir_version).toBe("0.8");
      expect(golden.profile).toBe("genbi-report");
      const ids = golden.components.map((node: { id: string; entrypoint?: boolean }) => [node.id, node.entrypoint]);
      expect(ids).toEqual([["plan_report", true], ["answer_batch", false]]);
      // Exactly one call edge, plan_layout -> answer_batch under alias `ask`.
      const edges = golden.components.flatMap((node: { id: string; llm_calls: { name: string; component_calls?: { alias: string; component: string }[] }[] }) =>
        node.llm_calls.flatMap((step) => (step.component_calls ?? []).map((edge) => [node.id, step.name, edge.alias, edge.component])));
      expect(edges).toEqual([["plan_report", "plan_layout", "ask", "answer_batch"]]);
      // The planner's mount brief carries no data-access framing; the callee's does.
      const briefs = Object.fromEntries(golden.components.map((node: { id: string; brief?: string }) => [node.id, node.brief ?? ""]));
      expect(briefs["plan_report"]).not.toMatch(/wren|SQL|sql/);
      expect(briefs["answer_batch"]).toContain("wren -q");
    } finally { await rm(out, { recursive: true, force: true }); }
  });

  it("denies the caller every SQL surface while the callee keeps its query tool (composition spec conformance in this harness)", async () => {
    const { plan } = await loadReportPlan();
    const caller = plan.components["plan_report"]!;
    const callee = plan.components["answer_batch"]!;
    expect(caller.steps.map((step) => [step.name, step.tools.map((tool) => tool.name), step.calls.map((edge) => edge.alias)])).toEqual([
      ["plan_layout", [], ["ask"]], ["narrate", [], []]]);
    for (const step of callee.steps) expect(step.tools.map((tool) => tool.name)).toEqual(["query"]);
    expect(callee.steps.map((step) => step.name)).toEqual(["resolve_intent", "generate_sql", "repair_sql"]);
    // At run time the caller's steps are handed no query function at all, and the callee's are.
    const executed: string[] = [];
    const surfaces: Record<string, string[]> = {};
    const host: RunnerHost = {
      async prepare(component) {
        const tools = component.id === "answer_batch" ? [{ name: "query", source: "native", async execute(input: unknown) { executed.push((input as { sql: string }).sql); return { columns: ["n"], rows: [{ n: 1 }] }; } }] : [];
        return { tools, isCurrent: () => true, async close() {},
          async normalize(evidence) {
            if (component.id === "answer_batch") return { status: "ok", output: { kind: "value", value: [{ slot_id: "n", columns: ["n"], rows: [{ n: 1 }], verified: true, definition: { sql: "SELECT 1 AS n" } }] } };
            return { status: "ok", output: { kind: "value", value: evidence.steps }, provenance: { verified: true } };
          } } satisfies ComponentBinding;
      },
      async runStep(run: StepRun) {
        const step = [...caller.steps, ...callee.steps].find((candidate) => candidate.prompt === run.prompt)!;
        surfaces[step.name] = Object.keys(run.tools);
        if (step.name === "plan_layout") {
          expect(run.tools["query"]).toBeUndefined();
          await run.tools["ask"]!({ request: "one cell", input: { questions: [{ slot_id: "n", expected_shape: "scalar", question: "n?" }] } });
          return { value: JSON.stringify({ title: "t", slots: [], blocks: [{ type: "kpi_card", label: "n", slot_id: "n" }] }) };
        }
        if (step.name === "generate_sql") { await run.tools["query"]!({ sql: "SELECT 1 AS n" }); return { value: "[]" }; }
        return { value: "{}" };
      },
    };
    const result = await new ComponentRunner(plan, host).run("plan_report", { request: "report" });
    expect(result.status).toBe("ok");
    expect(surfaces).toEqual({ plan_layout: ["ask"], narrate: [], resolve_intent: ["query"], generate_sql: ["query"] });
    expect(executed).toEqual(["SELECT 1 AS n"]);
  });
});
