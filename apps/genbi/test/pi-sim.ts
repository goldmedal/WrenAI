import { createHash } from "node:crypto";
import type { OpenShellDuplex } from "../server/runtime-host/openshell-types.js";
import { piStepPaths } from "../server/runtime-host/pi-protocol.js";

const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
type Output = { stream: "stdout" | "stderr"; data: Buffer } | { type: "exit"; exitCode: number };
export interface Bootstrap { protocol: number; scope: string; token: string; credentialEnv: string; argv: string[]; files: { settings: string; models: string; mcp: string; systemPrompt: string } }
export type HostFrame = Record<string, unknown> & { t: string };

/** Peer of the host duplex that stands in for the sandbox: scripted, deterministic, and never a source of authority. */
export class PiSim {
  readonly writes: Buffer[] = [];
  readonly frames: HostFrame[] = [];
  boot: Bootstrap | undefined;
  closeCalls = 0;
  exited = false;
  private pending = Buffer.alloc(0);
  private bootstrapRead = false;
  private readonly queue: Output[] = [];
  private waiter: ((value: IteratorResult<Output>) => void) | undefined;
  private finished = false;
  private resolveDone!: (code: number) => void;
  readonly done = new Promise<number>(resolve => { this.resolveDone = resolve; });
  constructor(private readonly behavior: { onBootstrap?(sim: PiSim, boot: Bootstrap): void; onFrame?(sim: PiSim, frame: HostFrame): void } = {}) {}
  readonly stream: OpenShellDuplex = {
    output: { [Symbol.asyncIterator]: () => ({ next: () => new Promise<IteratorResult<Output>>(resolve => {
      const item = this.queue.shift(); if (item) { resolve({ value: item, done: false }); return; }
      if (this.finished) { resolve({ value: undefined, done: true }); return; }
      this.waiter = resolve; }) }) },
    write: (data: Buffer) => {
      this.writes.push(Buffer.from(data)); this.pending = Buffer.concat([this.pending, data]);
      if (!this.bootstrapRead) {
        if (this.pending.length < 4 || this.pending.length < 4 + this.pending.readUInt32BE(0)) return;
        const length = this.pending.readUInt32BE(0); this.boot = JSON.parse(this.pending.subarray(4, 4 + length).toString()) as Bootstrap; this.pending = this.pending.subarray(4 + length); this.bootstrapRead = true;
        this.behavior.onBootstrap?.(this, this.boot);
      }
      let at: number; while ((at = this.pending.indexOf(10)) >= 0) { const line = this.pending.subarray(0, at); this.pending = this.pending.subarray(at + 1); const frame = JSON.parse(line.toString()) as HostFrame; this.frames.push(frame); this.behavior.onFrame?.(this, frame); }
    },
    close: () => { this.closeCalls++; this.finish(); },
    done: this.done,
  };
  private push(item: Output) { if (this.waiter) { const waiter = this.waiter; this.waiter = undefined; waiter({ value: item, done: false }); } else this.queue.push(item); }
  emit(frame: Record<string, unknown>) { this.push({ stream: "stdout", data: Buffer.from(JSON.stringify(frame) + "\n") }); }
  emitRaw(data: Buffer) { this.push({ stream: "stdout", data }); }
  emitStderr(size: number) { this.push({ stream: "stderr", data: Buffer.alloc(size, 120) }); }
  exit(code = 0) { this.exited = true; this.push({ type: "exit", exitCode: code }); this.resolveDone(code); this.finish(); }
  finish() { this.finished = true; if (this.waiter) { const waiter = this.waiter; this.waiter = undefined; waiter({ value: undefined, done: true }); } }
}

export interface HappyOptions {
  call?: { name: string; args: unknown } | undefined;
  stop?: string; text?: string; exitCode?: number;
  toolsAdded?: (boot: Bootstrap) => unknown;
  sections?: (boot: Bootstrap) => unknown;
  /** Replaces the frames emitted once the model is done (default: the stopping assistant message then agent_settled). */
  finalEvents?: (sim: PiSim, boot: Bootstrap) => void;
  afterSettled?: (sim: PiSim) => void;
  onExit?: (sim: PiSim) => void;
}
export const piWire = (name: string) => `mcp__component__${name}`;
export const rpc = (m: Record<string, unknown>) => ({ t: "mcp", m: { jsonrpc: "2.0", ...m } });
export const initRequest = rpc({ id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: { roots: {} }, clientInfo: { name: "pi", version: "1.0.4" } } });

/** The cooperative worker: stages what the host sent, mirrors pi's event order, ends in-band. */
export function happyBehavior(options: HappyOptions = {}) {
  let phase = 0;
  const toolNames = (boot: Bootstrap) => { const at = boot.argv.indexOf("--tools"); return at < 0 ? [] : boot.argv[at + 1]!.split(","); };
  const emitSystem = (sim: PiSim, boot: Bootstrap) => {
    const tools = toolNames(boot);
    sim.emit({ t: "pi", e: { type: "message_end", message: { role: "system", content: "", sections: options.sections ? options.sections(boot) : { preamble: boot.files.systemPrompt, cwd: `<cwd>\n${piStepPaths(boot.scope).cwd}\n</cwd>` },
      ...(options.toolsAdded ? { toolsAdded: options.toolsAdded(boot) } : tools.length ? { toolsAdded: tools.map(name => ({ name, description: "d", parameters: {} })) } : {}) } } });
  };
  const emitFinal = (sim: PiSim, boot: Bootstrap) => {
    if (options.finalEvents) { options.finalEvents(sim, boot); return; }
    sim.emit({ t: "pi", e: { type: "message_end", message: { role: "assistant", stopReason: options.stop ?? "stop", content: [{ type: "text", text: options.text ?? "answer text" }], usage: { input: 5, output: 2 } } } });
    sim.emit({ t: "pi", e: { type: "agent_settled" } }); options.afterSettled?.(sim);
  };
  return {
    onBootstrap(sim: PiSim, boot: Bootstrap) {
      sim.emit({ t: "staged", protocol: 1, scope: boot.scope, digests: { argv: sha(JSON.stringify(boot.argv)), settings: sha(boot.files.settings), models: sha(boot.files.models), mcp: sha(boot.files.mcp), prompt: sha(boot.files.systemPrompt) } });
    },
    onFrame(sim: PiSim, frame: HostFrame) {
      const boot = sim.boot!;
      if (frame.t === "input") {
        sim.emit({ t: "started", scope: boot.scope, inputSha256: sha(String(frame.text)) });
        if (toolNames(boot).length) sim.emit(initRequest); else { emitSystem(sim, boot); emitFinal(sim, boot); }
        return;
      }
      if (frame.t === "mcp") {
        phase++;
        if (phase === 1) { sim.emit(rpc({ method: "notifications/initialized" })); sim.emit(rpc({ id: 2, method: "tools/list" })); }
        else if (phase === 2) { emitSystem(sim, boot); if (options.call) sim.emit(rpc({ id: 3, method: "tools/call", params: { name: options.call.name, arguments: options.call.args, _meta: { progressToken: 3 } } })); else emitFinal(sim, boot); }
        else if (phase === 3) { sim.emit({ t: "pi", e: { type: "message_end", message: { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", name: piWire(options.call!.name), arguments: options.call!.args }] } } }); emitFinal(sim, boot); }
        return;
      }
      if (frame.t === "end") {
        sim.emit({ t: "exit", scope: boot.scope, code: options.exitCode ?? 0, signal: null, forced: false, remaining: 0 }); options.onExit?.(sim); sim.exit(0);
      }
    },
  };
}
