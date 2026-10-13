import { planDigest } from "../../harness/components/plan.js";
import { prepareDirectCodexComponentHost, type NativeComponentBindings } from "../native-component-preparation.js";
import { NativeComponentAdmission } from "../native-components.js";
import { produceComponentHostPlan } from "./component-host-plan.js";

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
  const { root, plan } = await produceComponentHostPlan({ irDocument, prepared, producerBinary: options.producerBinary, signal, assertCurrent: check });
  const name = `warble_run_${planDigest({ identity: prepared.identity, plan: plan.identity }).slice(7, 39)}`;
  const admission = new NativeComponentAdmission({ identity: prepared.identity, digest: plan.identity, roots: { [root]: plan }, tools: { [root]: name } },
    () => { check(); return prepared.identity; }, prepared.host, prepared.componentLimits);
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
}
