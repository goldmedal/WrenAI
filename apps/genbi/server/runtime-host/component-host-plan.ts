import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { readExecutionPlan } from "../../harness/components/plan.js";
import type { NativeComponentPreparation } from "../native-components.js";

/** A host-produced single-root plan, correlated with captured IR and host authority. */
export async function produceComponentHostPlan(options: {
  readonly irDocument: string;
  readonly prepared: NativeComponentPreparation;
  readonly producerBinary: string;
  readonly signal: AbortSignal;
  assertCurrent(): void;
  assertExecutableCurrent?(): void;
}) {
  const check = () => { options.signal.throwIfAborted(); options.assertCurrent(); options.prepared.assertCurrent(); };
  check();
  const roots = Object.keys(options.prepared.hostRoots);
  if (roots.length !== 1) throw new Error("Component host requires one entry");
  const root = roots[0]!;
  const hostDocument = JSON.stringify(options.prepared.hostRoots[root]);
  const ir = z.object({ context_binding: z.record(z.string(), z.unknown()), components: z.array(z.object({ id: z.string() }).passthrough()) })
    .passthrough().parse(JSON.parse(options.irDocument));
  const directory = await mkdtemp(path.join(os.tmpdir(), "genbi-component-plan-"));
  try {
    await writeFile(path.join(directory, "ir.json"), options.irDocument, { mode: 0o600 });
    await writeFile(path.join(directory, "host.json"), hostDocument, { mode: 0o600 });
    check();
    options.assertExecutableCurrent?.();
    await promisify(execFile)(options.producerBinary, ["produce-session", path.join(directory, "ir.json"), "--component", root,
      "--host-contract", path.join(directory, "host.json"), "--out", path.join(directory, "plan.json")],
    { cwd: directory, env: { PATH: [path.dirname(process.execPath), "/usr/bin", "/bin"].join(path.delimiter) }, timeout: 30_000, maxBuffer: 1_048_576, signal: options.signal });
    check();
    const document = await readFile(path.join(directory, "plan.json"), "utf8");
    check();
    const digest = z.object({ plan_sha256: z.string().regex(/^sha256:[a-f0-9]{64}$/) }).parse(JSON.parse(document)).plan_sha256;
    const plan = readExecutionPlan(document, { digest, inputIrDigest: `sha256:${createHash("sha256").update(options.irDocument).digest("hex")}`,
      contextBinding: ir.context_binding, declarations: Object.fromEntries(ir.components.map((node) => [node.id, node])), directHostDocument: hostDocument });
    if (plan.entries.length !== 1 || plan.entries[0] !== root) throw new Error("Component host entry mismatch");
    check();
    return { root, plan };
  } finally { await rm(directory, { recursive: true, force: true }); }
}
