import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { planDigest, readExecutionPlan } from "../../harness/components/plan.js";
import { prepareDirectCodexComponentHost, type NativeComponentBindings } from "../native-component-preparation.js";
import { NativeComponentAdmission } from "../native-components.js";

/** Host-only connection authority. Neither its identity nor credentials enter tool arguments. */
export interface CodexSessionTools {
  readonly accountEmail: string;
  readonly definitions: readonly { readonly name: string; readonly description: string; readonly inputSchema: unknown }[];
  assertCurrent(): void;
  call(name: string, input: unknown, callId: string, signal: AbortSignal): Promise<unknown>;
  close(): Promise<void>;
}

/** Materializes only a verified host plan. No vendor config, .codex directory, or MCP endpoint. */
export async function prepareCodexDirectTools(options: {
  readonly irDocument: string;
  readonly scope: Readonly<Record<string, unknown>>;
  readonly bindings: NativeComponentBindings;
  readonly producerBinary: string;
  readonly accountEmail: string;
  readonly expiresAt: number;
  readonly signal: AbortSignal;
}): Promise<CodexSessionTools> {
  const { irDocument, accountEmail, expiresAt, signal } = options;
  if (!accountEmail.trim() || !Number.isSafeInteger(expiresAt) || expiresAt <= Date.now()) throw new Error("Direct session authority expired");
  const prepared = prepareDirectCodexComponentHost(irDocument, options.scope, options.bindings);
  const check = () => { signal.throwIfAborted(); if (Date.now() >= expiresAt) throw new Error("Direct session authority expired"); prepared.assertCurrent(); };
  check();
  const root = Object.keys(prepared.hostRoots)[0]!;
  const hostDocument = JSON.stringify(prepared.hostRoots[root]);
  const ir = z.object({ context_binding: z.record(z.string(), z.unknown()), components: z.array(z.object({ id: z.string() }).passthrough()) }).passthrough().parse(JSON.parse(irDocument));
  const directory = await mkdtemp(path.join(os.tmpdir(), "genbi-direct-plan-"));
  try {
    await writeFile(path.join(directory, "ir.json"), irDocument, { mode: 0o600 });
    await writeFile(path.join(directory, "host.json"), hostDocument, { mode: 0o600 });
    check();
    await promisify(execFile)(options.producerBinary, ["produce-session", path.join(directory, "ir.json"), "--component", root,
      "--host-contract", path.join(directory, "host.json"), "--out", path.join(directory, "plan.json")],
    { cwd: directory, env: { PATH: [path.dirname(process.execPath), "/usr/bin", "/bin"].join(path.delimiter) }, timeout: 30_000, maxBuffer: 1_048_576, signal });
    check();
    const document = await readFile(path.join(directory, "plan.json"), "utf8");
    const digest = z.object({ plan_sha256: z.string().regex(/^sha256:[a-f0-9]{64}$/) }).parse(JSON.parse(document)).plan_sha256;
    const plan = readExecutionPlan(document, { digest, inputIrDigest: `sha256:${createHash("sha256").update(irDocument).digest("hex")}`,
      contextBinding: ir.context_binding, declarations: Object.fromEntries(ir.components.map((node) => [node.id, node])), directHostDocument: hostDocument });
    if (plan.entries.length !== 1 || plan.entries[0] !== root) throw new Error("Direct session entry mismatch");
    const name = `warble_run_${planDigest({ identity: prepared.identity, plan: plan.identity }).slice(7, 39)}`;
    const admission = new NativeComponentAdmission({ identity: prepared.identity, digest: plan.identity, roots: { [root]: plan }, tools: { [root]: name } },
      () => { check(); return prepared.identity; }, prepared.host);
    const lifetime = new AbortController();
    const timeout = setTimeout(() => lifetime.abort(), Math.min(expiresAt - Date.now(), 2_147_483_647));
    timeout.unref();
    const combined = AbortSignal.any([signal, lifetime.signal]);
    let closing: Promise<void> | undefined;
    const close = () => { lifetime.abort(); clearTimeout(timeout); return closing ??= admission.close(); };
    combined.addEventListener("abort", () => { void close().catch(() => {}); }, { once: true });
    const current = () => { combined.throwIfAborted(); check(); };
    const definitions = Object.freeze(admission.list().map((tool) => Object.freeze({ ...tool, inputSchema: structuredClone(tool.inputSchema) })));
    return Object.freeze({ accountEmail, definitions, assertCurrent: current,
      async call(tool: string, input: unknown, callId: string, parent: AbortSignal) {
        current();
        const result = await admission.call(tool, input, callId, AbortSignal.any([combined, parent]));
        current(); return result;
      }, close });
  } finally { await rm(directory, { recursive: true, force: true }); }
}
