import { observeStructured, observeStructuredAsync, type StructuredDiagnosticObserver } from "./structured-diagnostics.js";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { generatePreparedContextAndCatalog } from "../harness/compile/context-loader.js";
import { hashDirectory } from "../harness/compile/fingerprint.js";
import { declaredDefaultsOption } from "../harness/components/declared-defaults.js";
import { declaredDefaultsOfCatalog } from "../harness/components/knowledge-rules.js";
import { captureWrenAccessIdentity } from "../harness/components/wren-access.js";
import { prepareCodexDirectTools, type CodexSessionTools } from "./runtime-host/codex-direct-tools.js";
import { prepareNativeComponentHost, prepareStructuredAskComponentHost, prepareStructuredEnrichComponentHost, type NativeComponentBindings } from "./native-component-preparation.js";
import { createNativeComponentRuntimeBindings, type NativeComponentRuntimeOptions } from "./native-component-runtime.js";
import type { NativeComponentPreparation } from "./native-components.js";

export interface NativeComponentContextOptions extends Omit<NativeComponentRuntimeOptions, "contexts" | "wren"> {
  /** All executables and the provider are resolved by the certified server provisioner. */
  readonly contextLoaderBinary: string;
  readonly diagnostics?: StructuredDiagnosticObserver;
  /** Explicit host-only credential environment supplied by the provisioner. */
  readonly wrenEnvironment?: Readonly<NodeJS.ProcessEnv>;
  readonly wrenBinary: string;
  readonly project: string;
  readonly signal: AbortSignal;
}

/** Capture file-only context before host admission; never opens a vendor or Wren process. */
export async function prepareCapturedNativeComponentHost(
  irDocument: string, scope: Readonly<Record<string, unknown>>, options: NativeComponentContextOptions,
): Promise<NativeComponentPreparation | undefined> {
  const capturedScope = structuredClone(scope);
  const bindings = await captureBindings(irDocument, analysisOnly(options));
  return prepareNativeComponentHost(irDocument, capturedScope, bindings);
}

/** Same captured project/credential authority, with the single answer-query root pinned. */
export async function prepareCapturedStructuredAskHost(
  irDocument: string, scope: Readonly<Record<string, unknown>>, options: NativeComponentContextOptions,
): Promise<NativeComponentPreparation> {
  if ((options.vendor.vendor !== "claude" && options.vendor.vendor !== "pi") || options.identity.vendor !== options.vendor.vendor) throw new Error("Structured OpenShell Ask requires Claude or pi");
  const capturedScope = structuredClone(scope);
  const bindings = await captureBindings(irDocument, analysisOnly(options));
  return observeStructured(options.diagnostics, "host_admission", () => prepareStructuredAskComponentHost(irDocument, capturedScope, bindings));
}

/** Same captured authority for one enrichment stage; the purpose is fixed here, never taken from the caller's options. */
export async function prepareCapturedStructuredEnrichHost(
  irDocument: string, scope: Readonly<Record<string, unknown>>, options: NativeComponentContextOptions,
): Promise<NativeComponentPreparation> {
  if (options.vendor.vendor !== "claude" || options.identity.vendor !== "claude" || options.persistRoot) throw new Error("Structured OpenShell enrichment requires Claude");
  const capturedScope = structuredClone(scope);
  const bindings = await captureBindings(irDocument, { ...options, purpose: "enrichment" });
  return observeStructured(options.diagnostics, "host_admission", () => prepareStructuredEnrichComponentHost(irDocument, capturedScope, bindings));
}

/** Direct-session variant shares the same captured project/credential provenance. */
export async function prepareCapturedCodexDirectTools(irDocument: string, scope: Readonly<Record<string, unknown>>,
  options: NativeComponentContextOptions & { readonly producerBinary: string; readonly expiresAt: number },
): Promise<CodexSessionTools> {
  if (options.vendor.vendor !== "codex" || options.identity.vendor !== "codex") throw new Error("Direct session requires Codex");
  const capturedScope = structuredClone(scope);
  const accountEmail = options.vendor.accountEmail;
  const bindings = await captureBindings(irDocument, analysisOnly(options));
  return prepareCodexDirectTools({ irDocument, scope: capturedScope, bindings, producerBinary: options.producerBinary,
    accountEmail, expiresAt: options.expiresAt, signal: options.signal });
}

/** Analysis, native and direct-session captures can never carry the enrichment-only proposal sink. */
function analysisOnly(options: NativeComponentContextOptions): NativeComponentContextOptions {
  if (options.propose || options.purpose === "enrichment") throw new Error("Analysis preparation cannot carry a proposal grant");
  return options;
}

async function captureBindings(irDocument: string, options: NativeComponentContextOptions): Promise<NativeComponentBindings> {
  const identity = structuredClone(options.identity);
  const project = path.resolve(options.project);
  const signal = options.signal;
  const currentIdentity = options.currentIdentity.bind(options);
  const assertBinding = options.assertCurrent.bind(options);
  const assertVendor = options.vendor.assertCurrent.bind(options.vendor);
  const check = () => {
    signal.throwIfAborted(); assertBinding(); assertVendor();
    if (!isDeepStrictEqual(currentIdentity(), identity)) throw new Error("Native component context binding expired");
  };
  check();
  const ir = observeStructured(options.diagnostics, "context_ir", () => z.object({ warble_ir_version: z.literal("0.9"), components: z.array(z.object({
    id: z.string(), context_binding: z.record(z.string(), z.unknown()).optional(),
  }).passthrough()) }).passthrough().parse(JSON.parse(irDocument)));
  if (new Set(ir.components.map((component) => component.id)).size !== ir.components.length) throw new Error("Duplicate component identity");
  const fingerprint = await observeStructuredAsync(options.diagnostics, "context_identity", () => hashDirectory(project));
  const accessIdentity = await observeStructuredAsync(options.diagnostics, "context_identity", () => captureWrenAccessIdentity(project, options.wrenEnvironment));
  check();
  const scratch = await mkdtemp(path.join(os.tmpdir(), "genbi-native-context-"));
  try {
    const snapshotPath = path.join(scratch, "context.json");
    const catalogPath = path.join(scratch, "catalog.json");
    // One generator process reads the project once: the snapshot and the catalog whose declared default rules the governed access must announce.
    await observeStructuredAsync(options.diagnostics, "context_producer", () => { options.assertExecutableCurrent?.(); return generatePreparedContextAndCatalog(options.contextLoaderBinary, project, snapshotPath, catalogPath, signal); });
    const declaredDefaults = declaredDefaultsOfCatalog(await observeStructuredAsync(options.diagnostics, "context_snapshot", async () => JSON.parse(await readFile(catalogPath, "utf8")) as unknown));
    const snapshot = await observeStructuredAsync(options.diagnostics, "context_snapshot", async () => z.object({ context_version: z.literal(2), parseable: z.literal(true) }).passthrough()
      .parse(JSON.parse(await readFile(snapshotPath, "utf8"))));
    await accessIdentity.assertCurrent();
    if (fingerprint !== await hashDirectory(project)) throw new Error("Native component project changed during context capture");
    check();
    const contexts = Object.fromEntries(ir.components.flatMap((component) => {
      const binding = component.context_binding;
      // Other, unreachable components cannot contribute a project or context grant.
      // Preparation below requires a captured context for every reachable component.
      if (!binding || typeof binding.project !== "string" || path.resolve(binding.project) !== project) return [];
      return [[component.id, { binding, snapshot }]];
    }));
    const bindings = observeStructured(options.diagnostics, "runtime_bindings", () => createNativeComponentRuntimeBindings({ ...options, identity, contexts, currentIdentity, assertCurrent: check,
      wren: { executable: options.wrenBinary, project, fingerprint, identity: accessIdentity, ...declaredDefaultsOption(declaredDefaults) } }));
    return bindings;
  } finally { await rm(scratch, { recursive: true, force: true }); }
}
