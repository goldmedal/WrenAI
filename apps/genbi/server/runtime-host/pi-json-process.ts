import type { OpenShellDuplex } from "./openshell-types.js";
import { PiLineFrames, PiProtocolFault, PI_TRANSPORT_LIMITS as L, type PiFrameEffect, type PiHostFrame, type PiMcpAction, type PiStepProtocol } from "./pi-protocol.js";

export type PiToolCall = Extract<PiMcpAction, { kind: "call" }>;
export type PiCleanupReason = "settled" | "cancelled";
/**
 * One bounded multiplexed duplex per step. The normal end is in-band: the host sends the `end` sentinel, the worker exits by itself and the SDK
 * delivers a real exit event. `close()` and the abort signal are cancellation only: the SDK reports them as an error and never delivers an exit status.
 */
export class PiStepChannel {
  readonly finished: Promise<void>;
  killed = false;
  private active = true;
  private completed = false;
  private admitted = 0;
  private outputBytes = 0;
  private frames = 0;
  private stream: OpenShellDuplex | undefined;
  private fault: PiProtocolFault | undefined;
  private closePromise: Promise<void> | undefined;
  private readonly input = new PiLineFrames();
  private readonly output = new PiLineFrames();
  private readonly controller = new AbortController();
  private readonly timer: ReturnType<typeof setTimeout>;
  private readonly abort: () => void;
  private resolveFinished!: () => void;
  private rejectFinished!: (error: unknown) => void;
  private readonly ready: Promise<void>;
  constructor(private readonly options: { signal: AbortSignal; protocol: PiStepProtocol; bootstrap: Buffer; connect(signal: AbortSignal): Promise<OpenShellDuplex>; check(): void;
    cleanup(reason: PiCleanupReason): Promise<void>; onCall(call: PiToolCall): void; onSettled(): void;
    /** Session sandbox only: the first worker frame is the private step receipt and goes here, never to the protocol. */
    admitPrelude?(value: unknown): void }) {
    this.finished = new Promise<void>((resolve, reject) => { this.resolveFinished = resolve; this.rejectFinished = reject; });
    this.finished.catch(() => {});
    this.abort = () => this.failWith("cancelled"); options.signal.addEventListener("abort", this.abort, { once: true });
    this.timer = setTimeout(this.abort, L.deadlineMs);
    this.ready = (async () => {
      this.check(); if (options.bootstrap.length > L.bootstrap + 4) throw new PiProtocolFault("overload");
      this.admitted += options.bootstrap.length;
      const stream = await options.connect(this.controller.signal); this.stream = stream; this.check();
      stream.write(options.bootstrap); void this.consume(stream);
    })();
    void this.ready.catch((error: unknown) => this.failWith(error instanceof PiProtocolFault ? error.code : "protocol"));
    if (options.signal.aborted) this.abort();
  }
  get failure(): PiProtocolFault | undefined { return this.fault; }
  private check(): void { if (!this.active || this.options.signal.aborted) throw new PiProtocolFault("cancelled"); this.options.check(); }
  /** Admits, bounds and writes one host frame. Order and shape are decided by the protocol, not the caller. */
  send(frame: PiHostFrame): void {
    try {
      this.check(); if (!this.stream) throw new PiProtocolFault("protocol");
      this.options.protocol.host(frame as unknown as Record<string, unknown>);
      const bytes = Buffer.from(JSON.stringify(frame) + "\n");
      if (++this.frames > L.frames || this.admitted + bytes.length > L.input) throw new PiProtocolFault("overload");
      this.input.feed(bytes); this.admitted += bytes.length;
      for (let offset = 0; offset < bytes.length; offset += L.chunk) this.stream.write(bytes.subarray(offset, offset + L.chunk));
    } catch (error) { this.failWith(error instanceof PiProtocolFault ? error.code : "protocol"); throw error instanceof PiProtocolFault ? error : new PiProtocolFault("protocol"); }
  }
  private effect(effect: PiFrameEffect): void {
    if (effect.kind === "send") this.send(effect.frame);
    else if (effect.kind === "mcp") { if (effect.action.kind === "respond") this.send(effect.action.frame); else if (effect.action.kind === "call") this.options.onCall(effect.action); }
    else if (effect.kind === "settled") this.options.onSettled();
  }
  private async consume(stream: OpenShellDuplex): Promise<void> {
    let exited = false;
    let prelude = this.options.admitPrelude === undefined;
    try {
      for await (const event of stream.output) {
        this.check();
        if ("type" in event) {
          if (exited || event.exitCode !== 0 || !this.options.protocol.hasExited) throw new PiProtocolFault("protocol");
          this.output.end(); this.input.end(); exited = true; continue;
        }
        if (exited) throw new PiProtocolFault("protocol");
        this.outputBytes += event.data.length; if (this.outputBytes > L.output) throw new PiProtocolFault("overload");
        // Diagnostics from the sandbox are counted and discarded, never retained or surfaced.
        if (event.stream === "stderr") continue;
        for (const frame of this.output.feed(event.data)) {
          if (++this.frames > L.frames) throw new PiProtocolFault("overload");
          if (!prelude) { this.options.admitPrelude!(frame.value); prelude = true; continue; }
          this.effect(this.options.protocol.worker(frame.value));
        }
      }
      if (!exited || await stream.done !== 0) throw new PiProtocolFault("protocol");
      this.completed = true; clearTimeout(this.timer); this.resolveFinished();
    } catch (error) { this.failWith(error instanceof PiProtocolFault ? error.code : "protocol"); }
  }
  private failWith(code: PiProtocolFault["code"]): void {
    if (!this.active) return;
    this.active = false; this.killed = true; this.fault = new PiProtocolFault(code); this.controller.abort(); this.stream?.close();
    this.rejectFinished(this.fault); void this.close().catch(() => {});
  }
  /** Cancellation: stops admission first, then ends the transport and runs the bounded cleanup. */
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    const reason: PiCleanupReason = this.completed ? "settled" : "cancelled";
    this.active = false; this.killed = !this.completed; clearTimeout(this.timer); this.options.signal.removeEventListener("abort", this.abort);
    this.controller.abort(); this.stream?.close();
    this.closePromise = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([this.options.cleanup(reason), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new PiProtocolFault("cleanup")), L.cleanupMs); })]); }
      catch { throw new PiProtocolFault("cleanup"); } finally { clearTimeout(timer); }
    })();
    return this.closePromise;
  }
}
