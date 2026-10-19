import { isDeepStrictEqual, TextDecoder } from "node:util";
import type { ValidatorSnapshotLease } from "./openshell-project-snapshots.js";
import { OpenShellError, type OpenShellDuplex } from "./openshell-types.js";

/** Protected tuple the validator prelude must equal. Remote bytes confer no authority; the host configuration does. */
export interface ValidatorWorkerIdentity {
  readonly worker: "genbi-wren-validator/1"; readonly snapshot: string; readonly script: string;
  readonly wheel: string; readonly toolchain: string; readonly architecture: "linux-arm64"; readonly protocol: "genbi-validate/1";
}
export const VALIDATOR_REQUEST_MAX_BYTES = 196_608;
export const VALIDATOR_RESULT_MAX_BYTES = 524_288;
const PRELUDE_MAX_BYTES = 4096;
const STDERR_MAX_BYTES = 65_536;

/**
 * One bounded exchange with the fixed validator: verify the snapshot, read the prelude, compare it to the protected tuple, send exactly
 * one request line, read exactly one result line, then require a clean exit with no further output. Any deviation is a protocol failure.
 * The result is returned as raw bytes; the caller owns schema validation and the byte-equality decision.
 */
export async function exchangeWithValidator(options: { lease: ValidatorSnapshotLease; expected: ValidatorWorkerIdentity; request: Buffer; signal: AbortSignal; assertCurrent(): void; timeoutMs: number }): Promise<Buffer> {
  const { lease, expected, request } = options;
  if (request.length > VALIDATOR_REQUEST_MAX_BYTES || request.includes(10)) throw new OpenShellError("openshell_scope_invalid");
  const deadline = AbortSignal.any([options.signal, lease.signal, AbortSignal.timeout(options.timeoutMs)]);
  const check = () => { deadline.throwIfAborted(); options.assertCurrent(); lease.assertActive(); };
  let stream: OpenShellDuplex | undefined;
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => { stream?.close(); reject(new OpenShellError("openshell_cancelled")); };
    deadline.addEventListener("abort", onAbort, { once: true });
  });
  void aborted.catch(() => {});
  try {
    check(); await Promise.race([lease.verify(), aborted]); check();
    stream = await Promise.race([lease.openValidator(), aborted]); check();
    if (deadline.aborted) onAbort?.();
    const iterator = stream.output[Symbol.asyncIterator]();
    let buffer = Buffer.alloc(0), stderr = 0, exit: number | undefined, ended = false;
    const pull = async (): Promise<void> => {
      check();
      const step = await Promise.race([iterator.next(), aborted]);
      check();
      if (step.done) { ended = true; return; }
      const packet = step.value;
      if ("type" in packet) { exit = packet.exitCode; return; }
      if (packet.stream === "stderr") { stderr += packet.data.length; if (stderr > STDERR_MAX_BYTES) throw new OpenShellError("openshell_protocol_invalid"); return; }
      buffer = Buffer.concat([buffer, packet.data]);
    };
    const line = async (max: number): Promise<Buffer> => {
      for (;;) {
        const end = buffer.indexOf(10);
        if (end >= 0) { if (end > max) throw new OpenShellError("openshell_protocol_invalid"); const value = buffer.subarray(0, end); buffer = buffer.subarray(end + 1); return Buffer.from(value); }
        if (buffer.length > max || exit !== undefined || ended) throw new OpenShellError("openshell_protocol_invalid");
        await pull();
      }
    };
    let prelude: unknown;
    try { prelude = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await line(PRELUDE_MAX_BYTES))); } catch (error) { throw error instanceof OpenShellError ? error : new OpenShellError("openshell_protocol_invalid"); }
    if (!isDeepStrictEqual(prelude, expected) || buffer.length) throw new OpenShellError("openshell_identity_mismatch");
    check(); stream.write(Buffer.concat([request, Buffer.from("\n")]));
    const result = await line(VALIDATOR_RESULT_MAX_BYTES);
    // Nothing may follow the result but a clean exit.
    while (exit === undefined && !ended) { await pull(); if (buffer.length) throw new OpenShellError("openshell_protocol_invalid"); }
    if (buffer.length || (exit !== undefined && exit !== 0)) throw new OpenShellError("openshell_protocol_invalid");
    if (exit === undefined && (await Promise.race([stream.done, aborted])) !== 0) throw new OpenShellError("openshell_protocol_invalid");
    check();
    return result;
  } catch (error) {
    // A cancel or deadline is reported uniformly, whichever await observed it first.
    if (deadline.aborted && !(error instanceof OpenShellError && error.code !== "openshell_cancelled")) throw new OpenShellError("openshell_cancelled");
    throw error;
  } finally {
    if (onAbort) deadline.removeEventListener("abort", onAbort);
    stream?.close();
  }
}
