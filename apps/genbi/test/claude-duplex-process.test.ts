import { afterEach, describe, expect, it, vi } from "vitest";
import { ClaudeDuplexProcess } from "../server/runtime-host/claude-duplex-process.js";
import { CLAUDE_TRANSPORT_LIMITS as L, type ClaudeRawProtocol } from "../server/runtime-host/claude-protocol.js";
import type { OpenShellDuplex } from "../server/runtime-host/openshell-types.js";
const processes: ClaudeDuplexProcess[]=[];
afterEach(async()=>{vi.useRealTimers();for(const p of processes.splice(0))await p.close().catch(()=>{});});
const protocol=()=>({host:vi.fn(),worker:vi.fn(),secretSafe:vi.fn()}) as unknown as ClaudeRawProtocol;
function setup(events?: OpenShellDuplex["output"], bootstrap=Buffer.alloc(4), connect?: (signal:AbortSignal)=>Promise<OpenShellDuplex>, cleanup=vi.fn(async()=>{})) {
 const controller=new AbortController(),write=vi.fn(),close=vi.fn();const stream:OpenShellDuplex={output:events??(async function*(){await new Promise(()=>{});})(),done:Promise.resolve(0),write,close};
 const p=new ClaudeDuplexProcess({signal:controller.signal,protocol:protocol(),bootstrap,connect:connect??(async()=>stream),check(){},cleanup});processes.push(p);return {p,controller,write,close,cleanup};
}
const line=(n:number)=>Buffer.from('{"x":"'+"a".repeat(n-9)+'"}\n');
describe("bounded Claude duplex facade",()=>{
 it("counts bootstrap and rejects chunk boundary+1 before upstream writes",async()=>{const f=setup();await vi.waitFor(()=>expect(f.write).toHaveBeenCalledTimes(1));expect(f.p.stdin.write(Buffer.alloc(L.chunk+1))).toBe(false);expect(f.p.killed).toBe(true);expect(f.write).toHaveBeenCalledTimes(1);await f.p.close();expect(f.cleanup).toHaveBeenCalledTimes(1);});
 it("caps total admitted bytes before Writable queue when producer ignores false",async()=>{const f=setup(undefined,Buffer.alloc(4),()=>new Promise(()=>{}));const chunk=Buffer.alloc(L.chunk);for(let i=0;i<255;i++)f.p.stdin.write(chunk);f.p.stdin.write(Buffer.alloc(L.chunk-4));expect(f.p.killed).toBe(false);expect(f.p.stdin.write(Buffer.alloc(1))).toBe(false);expect(f.p.killed).toBe(true);expect(f.write).not.toHaveBeenCalled();await f.p.close();});
 it("does not forward incomplete/oversized lines and splits a valid 2MiB line into admitted 64KiB writes",async()=>{const f=setup();await vi.waitFor(()=>expect(f.write).toHaveBeenCalledTimes(1));const bytes=line(L.line);for(let i=0;i<bytes.length;i+=L.chunk)f.p.stdin.write(bytes.subarray(i,i+L.chunk));await vi.waitFor(()=>expect(f.write).toHaveBeenCalledTimes(33));expect(f.write.mock.calls.slice(1).every(([b])=>b.length<=L.chunk)).toBe(true);
  const g=setup();await vi.waitFor(()=>expect(g.write).toHaveBeenCalledTimes(1));const oversized=line(L.line+1);for(let i=0;i<oversized.length;i+=L.chunk)g.p.stdin.write(oversized.subarray(i,i+L.chunk));await vi.waitFor(()=>expect(g.p.killed).toBe(true));expect(g.write).toHaveBeenCalledTimes(1);
 });
 it("accepts exact bootstrap limit and rejects bootstrap boundary+1",async()=>{const f=setup(undefined,Buffer.alloc(L.bootstrap));await vi.waitFor(()=>expect(f.write).toHaveBeenCalledTimes(1));const g=setup(undefined,Buffer.alloc(L.bootstrap+1));await vi.waitFor(()=>expect(g.p.killed).toBe(true));expect(g.write).not.toHaveBeenCalled();});
 it("caps combined protocol frame count across input/output",async()=>{
  let release!:()=>void;const f=setup((async function*(){await new Promise<void>(resolve=>release=resolve);for(let i=0;i<513;i++)yield{stream:"stdout" as const,data:Buffer.from('{}\n')};await new Promise(()=>{});})());
  await vi.waitFor(()=>expect(f.write).toHaveBeenCalledTimes(1));for(let i=0;i<512;i++)f.p.stdin.write('{}\n');await vi.waitFor(()=>expect(f.write).toHaveBeenCalledTimes(513));release();await vi.waitFor(()=>expect(f.p.killed).toBe(true));
 });
 it("caps unread stdout, combined stderr and unexpected EOF",async()=>{
  const unread=setup((async function*(){for(let i=0;i<5;i++)yield {stream:"stdout" as const,data:line(1048576)};})());await vi.waitFor(()=>expect(unread.p.killed).toBe(true));expect(unread.p.stdout.readableLength).toBeLessThanOrEqual(L.unread);
  const output=setup((async function*(){yield {stream:"stderr" as const,data:Buffer.alloc(L.output)};yield {stream:"stderr" as const,data:Buffer.alloc(1)};})());await vi.waitFor(()=>expect(output.p.killed).toBe(true));
  const eof=setup((async function*(){yield {stream:"stdout" as const,data:Buffer.from('{}\n')};})());await vi.waitFor(()=>expect(eof.p.killed).toBe(true));
 });
 it("revokes immediate input/output admission on original signal and rejects half-close",async()=>{const f=setup();await vi.waitFor(()=>expect(f.write).toHaveBeenCalledTimes(1));f.controller.abort();expect(f.p.stdin.write('{}\n')).toBe(false);await f.p.close();expect(f.cleanup).toHaveBeenCalledTimes(1);const g=setup();g.p.stdin.end();await vi.waitFor(()=>expect(g.p.killed).toBe(true));});
 it("bounds cleanup uncertainty independently of an unresponsive peer",async()=>{vi.useFakeTimers();const f=setup(undefined,Buffer.alloc(4),()=>new Promise(()=>{}),vi.fn(()=>new Promise(()=>{})));const rejected=expect(f.p.close()).rejects.toThrow("cleanup");await vi.advanceTimersByTimeAsync(L.cleanupMs);await rejected;});
});
