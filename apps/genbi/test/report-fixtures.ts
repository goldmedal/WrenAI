import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_WREN_PROVIDER_PATH, runWarble } from "../harness/compile/pipeline.js";
import { resolveWarbleBinary } from "../harness/compile/resolve-binary.js";
import { planDigest, readExecutionPlan, VERCEL_HOST_CONTRACT } from "../harness/components/plan.js";
import type { ExecutionPlan } from "../harness/components/runner.js";

/** This package's committed two-stage report profile and its IR golden, compiled from the pinned `@warble/cli`'s own Hub. */
export const REPORT_PROFILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "profiles", "genbi-report");
export const REPORT_IR_GOLDEN = path.join(REPORT_PROFILE, "ir.golden.json");

interface IrDocument {
  readonly warble_ir_version: string;
  readonly profile: string;
  readonly context_binding: Record<string, unknown>;
  readonly components: readonly { readonly id: string; readonly llm_calls: readonly { readonly name: string; readonly component_calls?: readonly { alias: string; component: string }[] }[]; [key: string]: unknown }[];
}

/**
 * The trusted execution plan for the committed report IR: the pinned warble
 * emits the vercel host bundle against this harness's host contract, and
 * `readExecutionPlan` verifies it against the IR exactly as the runtime does.
 * With `project`, every component's context binding is rebound to that
 * directory, the way `composeUserProfile` rebinds a user's project.
 */
export async function loadReportPlan(project?: string): Promise<{ plan: ExecutionPlan; ir: IrDocument; warbleBin: string }> {
  const warbleBin = await resolveWarbleBinary();
  const work = await mkdtemp(path.join(os.tmpdir(), "genbi-report-plan-"));
  try {
    const hostPath = path.join(work, "component-host.json");
    await writeFile(hostPath, JSON.stringify(VERCEL_HOST_CONTRACT));
    await runWarble(warbleBin, ["dispatch", "--target", "vercel", "--provider", DEFAULT_WREN_PROVIDER_PATH, "--host-contract", hostPath, REPORT_IR_GOLDEN, "--out", path.join(work, "bundle")]);
    const bundle = JSON.parse(await readFile(path.join(work, "bundle", "bundle.json"), "utf8")) as { bundle_sha256: string };
    const ir = JSON.parse(await readFile(REPORT_IR_GOLDEN, "utf8")) as IrDocument;
    const plan = readExecutionPlan(JSON.stringify(bundle), { digest: bundle.bundle_sha256, inputIrDigest: planDigest(ir),
      declarations: Object.fromEntries(ir.components.map((node) => [node.id, node])), contextBinding: ir.context_binding });
    if (project === undefined) return { plan, ir, warbleBin };
    const components = Object.fromEntries(Object.entries(plan.components).map(([id, node]) => [id, { ...node,
      declaration: { ...node.declaration, context_binding: { ...(node.declaration.context_binding as Record<string, unknown>), project } } }]));
    return { plan: { ...plan, components }, ir, warbleBin };
  } finally { await rm(work, { recursive: true, force: true }); }
}
