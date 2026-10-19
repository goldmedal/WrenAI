import { EventEmitter } from "node:events";
import { Readable, Writable } from "node:stream";
import type { SpawnedProcess } from "@anthropic-ai/claude-agent-sdk";
import type { OpenShellDuplex } from "./openshell-types.js";
import { ClaudeLineFrames, ClaudeProtocolFault, CLAUDE_INERT_FRAME_CAP, faultSiteOf, isInertShape, type ClaudeFaultSite, type ClaudeFrameCounts, CLAUDE_TRANSPORT_LIMITS as L, type ClaudeRawProtocol } from "./claude-protocol.js";

/** Local bounded admission; OpenShell write has no upstream drain. EOF is unsupported. */
export class ClaudeDuplexProcess extends EventEmitter implements SpawnedProcess {
  readonly stdout = new Readable({ read() {}, highWaterMark: 65536 });
  readonly stdin: Writable;
  killed = false;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  private active = true;
  /** First rule the stream broke; internal diagnostics only. */
  faultSite: ClaudeFaultSite | undefined;
  faultCounts: ClaudeFrameCounts | undefined;
  private inertFrames = 0;
  private admitted = 0;
  private outputBytes = 0;
  private frames = 0;
  private stream: OpenShellDuplex | undefined;
  private readonly input = new ClaudeLineFrames();
  private readonly output = new ClaudeLineFrames();
  private closePromise: Promise<void> | undefined;
  private readonly controller = new AbortController();
  private readonly timer: ReturnType<typeof setTimeout>;
  private readonly abort: () => void;
  constructor(private readonly options: { signal: AbortSignal; protocol: ClaudeRawProtocol; bootstrap: Buffer; connect(signal: AbortSignal): Promise<OpenShellDuplex>; check(): void; cleanup(): Promise<void>; admitPrelude?(value: unknown): void }) {
    super();
    this.on("error", () => {}); this.stdout.on("error", () => {});
    this.stdin = new Writable({ highWaterMark: 65536, write: (chunk: Buffer, _encoding, callback) => {
      void this.ready.then(() => { this.check(); for (const frame of this.input.feed(chunk)) { if (isInertShape(frame.value) ? ++this.inertFrames > CLAUDE_INERT_FRAME_CAP : ++this.frames > L.frames) throw new ClaudeProtocolFault("overload"); this.options.protocol.host(frame.value); this.options.protocol.secretSafe(frame.bytes); for (let offset = 0; offset < frame.bytes.length; offset += L.chunk) this.stream!.write(frame.bytes.subarray(offset, offset + L.chunk)); } }).then(() => callback(), (error: unknown) => { this.fail("protocol", faultSiteOf(error)); callback(new ClaudeProtocolFault("protocol")); });
    }, final: (callback) => { this.fail("cancelled"); callback(); } });
    this.stdin.on("error", () => {});
    // Admission happens before Writable's own queue, including producers ignoring write(false).
    const write = this.stdin.write.bind(this.stdin);
    this.stdin.write = ((chunk: string | Uint8Array, encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void), callback?: (error?: Error | null) => void) => {
      const encoding = typeof encodingOrCallback === "string" ? encodingOrCallback : undefined;
      const bytes = typeof chunk === "string" ? Buffer.from(chunk, encoding) : Buffer.from(chunk);
      try { this.check(); if (bytes.length > L.chunk || this.admitted + bytes.length > L.input) throw new ClaudeProtocolFault("overload"); this.admitted += bytes.length; }
      catch { this.fail("overload"); const cb = typeof encodingOrCallback === "function" ? encodingOrCallback : callback; cb?.(new ClaudeProtocolFault("overload")); return false; }
      return write(bytes, typeof encodingOrCallback === "function" ? encodingOrCallback : callback);
    }) as Writable["write"];
    this.abort = () => this.fail("cancelled"); options.signal.addEventListener("abort", this.abort, { once: true });
    this.timer = setTimeout(this.abort, L.deadlineMs);
    this.ready = (async () => {
      this.check(); if (options.bootstrap.length > L.bootstrap) throw new ClaudeProtocolFault("overload");
      this.admitted += options.bootstrap.length;
      const stream = await options.connect(this.controller.signal); this.stream = stream; this.check();
      stream.write(options.bootstrap); void this.consume(stream);
    })();
    void this.ready.catch(() => this.fail("protocol"));
    if (options.signal.aborted) this.abort();
  }
  private readonly ready: Promise<void>;
  private check(): void { if (!this.active || this.options.signal.aborted) throw new ClaudeProtocolFault("cancelled"); this.options.check(); }
  private async consume(stream: OpenShellDuplex): Promise<void> {
    let exited = false;
    let prelude = this.options.admitPrelude === undefined;
    try {
      for await (const event of stream.output) {
        this.check();
        if ("type" in event) {
          if (exited || event.exitCode !== 0) throw new ClaudeProtocolFault("protocol");
          this.output.end(); this.input.end(); exited = true; this.exitCode = event.exitCode;
          this.stdout.push(null); this.emit("exit", event.exitCode, null); continue;
        }
        if (exited) throw new ClaudeProtocolFault("protocol");
        this.outputBytes += event.data.length; if (this.outputBytes > L.output) throw new ClaudeProtocolFault("overload");
        // stderr is counted and discarded. Never retain or expose vendor diagnostics.
        if (event.stream === "stderr") continue;
        if (this.stdout.readableLength + this.output.bufferedBytes + event.data.length > L.unread) throw new ClaudeProtocolFault("overload");
        for (const frame of this.output.feed(event.data)) {
          if (isInertShape(frame.value) ? ++this.inertFrames > CLAUDE_INERT_FRAME_CAP : ++this.frames > L.frames) throw new ClaudeProtocolFault("overload");
          if (!prelude) { this.options.admitPrelude!(frame.value); prelude = true; continue; }
          this.options.protocol.secretSafe(frame.bytes); this.options.protocol.worker(frame.value);
          if (this.stdout.readableLength + frame.bytes.length > L.unread) throw new ClaudeProtocolFault("overload");
          this.stdout.push(frame.bytes);
        }
      }
      if (!exited || await stream.done !== 0) throw new ClaudeProtocolFault("protocol");
    } catch (error) { this.fail(error instanceof ClaudeProtocolFault ? error.code : "protocol", faultSiteOf(error)); }
  }
  private fail(code: ClaudeProtocolFault["code"], site?: ClaudeFaultSite): void {
    if (!this.active) return;
    if (this.faultSite === undefined) { this.faultSite = site ?? (code === "protocol" ? "unspecified" : code); this.faultCounts = this.options.protocol.frameCounts?.(); }
    this.active = false; this.killed = true; this.controller.abort(); this.stream?.close();
    this.emit("error", new ClaudeProtocolFault(code)); this.stdout.destroy(new ClaudeProtocolFault(code)); this.stdin.destroy(new ClaudeProtocolFault(code));
    void this.close().catch(() => {});
  }
  kill(signal: NodeJS.Signals): boolean { this.signalCode = signal; this.fail("cancelled"); return true; }
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.active = false; this.killed = true; clearTimeout(this.timer); this.options.signal.removeEventListener("abort", this.abort);
    this.controller.abort(); this.stream?.close(); this.stdin.destroy(); this.stdout.destroy();
    this.closePromise = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([this.options.cleanup(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new ClaudeProtocolFault("cleanup")), L.cleanupMs); })]); }
      catch { throw new ClaudeProtocolFault("cleanup"); } finally { clearTimeout(timer); }
    })(); return this.closePromise;
  }
}
