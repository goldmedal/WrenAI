import { isDeepStrictEqual } from "node:util";
import { TextDecoder } from "node:util";
import { z } from "zod";
import type { ComponentAccess } from "../../harness/components/broker.js";
import { declaredDefaultIds } from "../../harness/components/knowledge-rules.js";
import { declaredRuleIdsOf, GovernedWrenError, GOVERNED_ERROR_CLASSES, governedHelloMatchesDeclarations, type GovernedUnavailableReason } from "../../harness/components/wren-access.js";
import type { DataSnapshotLease } from "./openshell-project-snapshots.js";
import type { OpenShellDuplex } from "./openshell-types.js";

export interface WrenWorkerIdentity {
  readonly worker: "genbi-wren-worker/1"; readonly snapshot: string; readonly script: string;
  readonly wheel: string; readonly toolchain: string; readonly architecture: "linux-arm64"; readonly protocol: "wren-governed/2";
}
const response = z.object({ id: z.number().int().nonnegative(), result: z.unknown().optional(),
  error: z.object({ class: z.enum(GOVERNED_ERROR_CLASSES.filter(x => x !== "transport") as [string, ...string[]]), message: z.string().max(1024), rule_ids: declaredDefaultIds.optional() }).strict().optional() }).strict();

/**
 * The expected tuple is host configuration + admitted lease; remote bytes have no authority. The worker's governed hello follows its
 * identity line: the two-key protocol 2 hello for a project that declares nothing, protocol 3 announcing exactly `declaredDefaults`
 * (the host catalog's declared default rule ids) for one that declares rules. Any other hello is unavailable.
 */
export async function openOpenShellWrenAccess(options: { lease: DataSnapshotLease; expected: WrenWorkerIdentity; signal: AbortSignal; assertCurrent(): void; declaredDefaults?: readonly string[] }): Promise<ComponentAccess> {
  const { lease, signal } = options;
  const declaredDefaults = [...(options.declaredDefaults ?? [])];
  const declared: ReadonlySet<string> = new Set(declaredDefaults);
  const helloAccepted = (value: unknown): boolean => {
    if (declaredDefaults.length === 0) return isDeepStrictEqual(value, { id: 0, protocol: options.expected.protocol });
    return typeof value === "object" && value !== null && (value as { id?: unknown }).id === 0 && governedHelloMatchesDeclarations(value as Record<string, unknown>, declaredDefaults);
  };
  const isDeclarationsMatter = (value: unknown): boolean => declaredDefaults.length > 0
    || (typeof value === "object" && value !== null && ((value as { protocol?: unknown }).protocol === "wren-governed/3" || "declared_defaults" in value));
  let stream: OpenShellDuplex | undefined;
  let closed = false, closing: Promise<void> | undefined;
  let failure: Error = new GovernedWrenError("transport");
  let pending: { id: number; resolve(value: unknown): void; reject(error: Error): void } | undefined;
  let stage = 0, buffer = Buffer.alloc(0), nextId = 1;
  const check = () => { if (closed) throw failure; signal.throwIfAborted(); options.assertCurrent(); lease.assertActive(); };
  const ready = new Promise<void>((resolve, reject) => { pending = { id: 0, resolve: () => resolve(), reject }; });
  // Cancellation can reject readiness while a pre-handshake lease operation is pending.
  // Observe immediately; the awaited readiness below still propagates that failure.
  void ready.catch(() => {});
  const close = () => {
    if (closing) return closing;
    closed = true; pending?.reject(failure); pending = undefined;
    stream?.close();
    closing = lease.close().finally(() => signal.removeEventListener("abort", abort));
    return closing;
  };
  const abort = () => { void close().catch(() => {}); };
  signal.addEventListener("abort", abort, { once: true });
  const consume = async () => {
    try {
      for await (const packet of stream!.output) {
        if (closed) return;
        check();
        if ("type" in packet) throw failure;
        // Stderr is untrusted and discarded, but a flood must terminate the worker.
        if (packet.stream === "stderr") { stderrBytes += packet.data.length; if (stderrBytes > 65_536) throw failure; continue; }
        if (packet.data.length + buffer.length > 1_048_577) throw failure;
        buffer = Buffer.concat([buffer, packet.data]);
        while (buffer.includes(10)) {
          const end = buffer.indexOf(10), raw = buffer.subarray(0, end); buffer = buffer.subarray(end + 1);
          const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
          if (stage === 0) { if (!isDeepStrictEqual(value, options.expected)) throw failure; stage = 1; }
          else if (stage === 1) {
            if (buffer.length) throw failure;
            if (!helloAccepted(value)) {
              const reason: GovernedUnavailableReason | undefined = isDeclarationsMatter(value) ? "governed_declarations_mismatch" : undefined;
              if (reason) { failure = new GovernedWrenError("transport", undefined, { reason }); console.error(`[component-failure] ${JSON.stringify({ site: "governed_hello", code: reason, declared: declaredDefaults.length })}`); }
              throw failure;
            }
            stage = 2;
            const waiter = pending; pending = undefined; waiter?.resolve(undefined);
          } else {
            const reply = response.parse(value);
            if (!pending || reply.id !== pending.id || Object.hasOwn(reply, "result") === Object.hasOwn(reply, "error")) throw failure;
            // `rule_ids` names declared rules, so it belongs to that one class; on any other it is a contract violation.
            if (reply.error?.rule_ids !== undefined && reply.error.class !== "declared_default_missing") throw failure;
            const waiter = pending; pending = undefined;
            if (reply.error) waiter.reject(new GovernedWrenError(reply.error.class as Exclude<typeof GOVERNED_ERROR_CLASSES[number], "transport">, undefined,
              { ruleIds: reply.error.class === "declared_default_missing" ? declaredRuleIdsOf(reply.error.rule_ids, declared) : [] }));
            else waiter.resolve(reply.result);
          }
        }
        // Extra partial bytes between requests are unsolicited framing too.
        if (stage === 2 && !pending && buffer.length) throw failure;
      }
      throw failure;
    } catch { abort(); }
  };
  let stderrBytes = 0;
  let manifest: unknown;
  const timer = setTimeout(abort, 10_000);
  try {
    check(); await lease.verify(); check();
    manifest = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await lease.read("project/target/mdl.json"))); check();
    stream = await lease.openGoverned(); check();
    void consume(); void stream.done.then(abort, abort);
    await ready; check();
  } catch (error) { await close(); throw error; }
  finally { clearTimeout(timer); }
  let tail = Promise.resolve();
  const execute = (payload: Record<string, unknown>, operationSignal: AbortSignal): Promise<unknown> => {
    const operation = tail.then(async () => {
      operationSignal.throwIfAborted(); check();
      const cancel = () => { failure = new GovernedWrenError(operationSignal.reason?.name === "TimeoutError" ? "timeout" : "transport"); abort(); };
      operationSignal.addEventListener("abort", cancel, { once: true });
      try {
        if (operationSignal.aborted) cancel();
        check(); await lease.verify(); check(); operationSignal.throwIfAborted();
        const input = Buffer.from(JSON.stringify({ id: nextId, ...payload }) + "\n");
        if (input.length > 65_536) throw new GovernedWrenError("invalid_request");
        const result = new Promise<unknown>((resolve, reject) => { pending = { id: nextId++, resolve, reject }; });
        if (operationSignal.aborted) cancel(); else { try { check(); stream!.write(input); } catch { abort(); } }
        const value = await result; operationSignal.throwIfAborted(); check();
        if (payload.operation === "inspect") {
          if (!isDeepStrictEqual(value, manifest)) { abort(); throw failure; }
        } else {
          let query: { rows: Record<string, unknown>[] };
          try { query = z.object({ columns: z.array(z.string()), rows: z.array(z.record(z.string(), z.unknown())),
            definition: z.object({ sql: z.literal(payload.sql as string), source_tables: z.array(z.string()), filters: z.array(z.string()) }).strict(),
            semantics: z.unknown().optional() }).strict().parse(value); } catch { abort(); throw failure; }
          if (query.rows.length > (payload.limit as number)) { abort(); throw failure; }
        }
        await lease.verify(); operationSignal.throwIfAborted(); check();
        return value;
      } finally { operationSignal.removeEventListener("abort", cancel); }
    });
    tail = operation.then(() => {}, () => {}); return operation;
  };
  return { query: (input, parent) => execute({ operation: "query", ...input }, parent), inspect: parent => execute({ operation: "inspect" }, parent), close };
}
