import { types } from "node:util";
import { GovernedWrenError } from "../../harness/components/wren-access.js";
import type { StepRun, StepResponse } from "../../harness/components/runner.js";
import { claimPiHostRuntime } from "./openshell-pi-provider.js";
import type { PiStepChannel, PiToolCall } from "./pi-json-process.js";
import type { PiStepProtocol } from "./pi-protocol.js";
import { PI_TRANSPORT_LIMITS, PiProtocolFault } from "./pi-protocol.js";

/** Supplied only by the OpenShell pi provider. A structural copy has no authority. */
export interface PiComponentRuntime {
  readonly vendor: "pi";
  readonly model: string;
  readonly tier: string;
  readonly signal?: AbortSignal;
  assertCurrent(): void;
  assertExecutableCurrent?(): void;
  /** Binds this runtime to exactly one run and returns its bounded channel and protocol state. */
  openStep(run: StepRun, hooks: { readonly signal: AbortSignal; onCall(call: PiToolCall): void; onSettled(): void }): { readonly channel: PiStepChannel; readonly protocol: PiStepProtocol };
  /** Resolves only after the sandbox owning every vendor process is proven gone. */
  close(): Promise<void>;
}
export class PiComponentError extends Error {
  constructor(readonly reason: "protocol" | "cancelled" | "cleanup") { super(`pi component ${reason}`); }
}
const deny = (): never => { throw new PiComponentError("protocol"); };
const queryAborts = new WeakSet<object>();
/** A real governed query rejection from a host tool handler ended this step; never a serialized or model-supplied claim. */
export function isPiQueryAbort(error: unknown): boolean { return !!error && typeof error === "object" && queryAborts.has(error); }

const classifyFailure = (error: unknown, abortReason: PiComponentError["reason"] | undefined, signal: AbortSignal): PiComponentError => {
  if (abortReason && error instanceof PiComponentError && error.reason === "cancelled") return new PiComponentError(abortReason);
  return new PiComponentError(error instanceof PiComponentError ? error.reason : error instanceof PiProtocolFault && error.code !== "overload" ? (error.code === "protocol" ? "protocol" : error.code) : signal.aborted ? "cancelled" : "protocol");
};

/** One fresh `pi --mode json` per step: events decide success, the host answers every tool call, the exit status is never read. */
export async function runPiComponentStep(runtime: PiComponentRuntime, run: StepRun, binding?: { check(): void }): Promise<StepResponse> {
  const controller = new AbortController();
  const signal = AbortSignal.any([run.signal, controller.signal, ...(runtime.signal ? [runtime.signal] : [])]);
  const close = runtime.close.bind(runtime);
  let host: ReturnType<typeof claimPiHostRuntime> | undefined;
  let active = true, failed = false, succeeded = false, governedRejection = false, timedOut = false, pending = 0;
  let abortReason: PiComponentError["reason"] | undefined;
  const fail = () => { failed = true; abortReason ??= run.signal.aborted || runtime.signal?.aborted ? "cancelled" : "protocol"; controller.abort(); };
  let toolQueue: Promise<unknown> = Promise.resolve();
  let channel: PiStepChannel | undefined, protocol: PiStepProtocol | undefined;
  const check = () => { if (!active || failed) deny(); if (signal.aborted) throw new PiComponentError("cancelled"); host?.check(); binding?.check(); };
  const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, PI_TRANSPORT_LIMITS.deadlineMs);
  const abort = new Promise<never>((_, reject) => { signal.addEventListener("abort", () => reject(new PiComponentError("cancelled")), { once: true }); });
  void abort.catch(() => {});
  const wait = <T>(value: Promise<T>): Promise<T> => Promise.race([value, abort]);
  try {
    host = claimPiHostRuntime(runtime, run);
    check(); runtime.assertExecutableCurrent?.();
    const tools = Object.freeze({ ...run.tools });
    const opened = runtime.openStep(run, {
      signal,
      onCall(call) {
        pending++;
        const result = toolQueue.then(async () => {
          check(); runtime.assertExecutableCurrent?.();
          const handler = Object.hasOwn(tools, call.name) ? tools[call.name] : undefined; if (!handler) deny();
          const output = await wait(handler!(call.input)); check();
          channel!.send(protocol!.answer(call.id, output));
        });
        toolQueue = result.catch(error => {
          if (!signal.aborted && !!error && typeof error === "object" && !types.isProxy(error) && Object.getPrototypeOf(error) === GovernedWrenError.prototype) governedRejection = true;
          fail();
        });
        void result.finally(() => { pending--; }).catch(() => {});
      },
      onSettled() { try { check(); if (pending) deny(); channel!.send({ t: "end" }); } catch { fail(); } },
    });
    channel = opened.channel; protocol = opened.protocol;
    await wait(channel.finished); check();
    if (pending) deny();
    const response = protocol.result(); succeeded = true; return response;
  } catch (error) {
    const failure = classifyFailure(error, abortReason, signal);
    if (governedRejection && !run.signal.aborted && !runtime.signal?.aborted && !timedOut) queryAborts.add(failure);
    throw failure;
  } finally {
    active = false; clearTimeout(timeout); controller.abort();
    let cleaned = true;
    try { await close(); } catch { cleaned = false; }
    if (!cleaned) throw new PiComponentError("cleanup");
    if (succeeded) { try { host?.afterClose(); } catch { throw new PiComponentError("cleanup"); } }
  }
}
