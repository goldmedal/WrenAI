import { afterEach, expect, it, vi } from "vitest";
import { createStructuredTimingRecorder, createStructuredTimingObserver, structuredTimingForObserver, measureStructuredTiming, classifyTimingResult, readStructuredTimingReceipt, createStructuredComponentTiming, recordAdmittedTimingResult, recordComponentTimingAbort } from "../server/structured-timing.js";
import { observeStructured, observeStructuredAsync } from "../server/structured-diagnostics.js";
import { createOpenShellStructuredAdapter } from "../server/openshell-structured-ask.js";
afterEach(() => vi.useRealTimers());
it("ordinary/forged observer has no recorder and disabled measurements do not touch clocks", () => {
  const observer = vi.fn(); expect(structuredTimingForObserver(observer)).toBeUndefined();
  const result = {}; expect(measureStructuredTiming(undefined, "currentness", () => result)).toBe(result);
  expect(() => createStructuredTimingObserver({} as any)).toThrow();
});
it("sync and async observers retain exact results/errors even when the supplied observer throws", async () => {
  const recorder = createStructuredTimingRecorder({role:"utility"});recorder.beginSession(1);
  const observer = createStructuredTimingObserver(recorder, () => {throw Error("synthetic-secret-shaped-value");});
  const result = {}, error = Error("synthetic-secret-shaped-value");
  expect(observeStructured(observer,"currentness",()=>result)).toBe(result);
  expect(await observeStructuredAsync(observer,"context_capture",async()=>result)).toBe(result);
  try {observeStructured(observer,"currentness",()=>{throw error});throw Error("not thrown");}catch(e){expect(e).toBe(error);}
  await expect(observeStructuredAsync(observer,"context_capture",async()=>{throw error})).rejects.toBe(error);
  const snap=recorder.snapshot();expect(snap.sessions[0]!.phases.currentness.failedCount).toBe(1);expect(snap.sessions[0]!.phases.context_capture.failedCount).toBe(1);
  expect(JSON.stringify(snap)).not.toContain("synthetic-secret");
});
it("nested sync exclusive work and covered union do not sum inclusive children", () => {
  let clock=0;const recorder=createStructuredTimingRecorder({role:"utility",clock:()=>clock});
  recorder.measure("currentness",()=>{clock+=2;recorder.measure("exact_bytes",()=>{clock+=3});clock+=4});
  const r=recorder.snapshot();expect(r.metrics.currentness.inclusiveMs).toBe(9);expect(r.metrics.currentness.exclusiveMs).toBe(6);expect(r.metrics.exact_bytes.exclusiveMs).toBe(3);expect(r.coveredSyncMs).toBe(9);
  const error=Error("synthetic");try{recorder.measure("exact_bytes",()=>{clock+=5;throw error});}catch(e){expect(e).toBe(error);}
  expect(recorder.snapshot().metrics.exact_bytes.count).toBe(2);expect(recorder.snapshot().metrics.exact_bytes.inclusiveMs).toBe(8);
});
it.each(["success","error_during_execution","error_max_turns","error_max_budget_usd","error_max_structured_output_retries"])("keeps closed first admitted result %s across later records and cleanup", category => {
  const r=createStructuredTimingRecorder({role:"utility"});r.beginSession(1);const step=createStructuredComponentTiming(r);
  recordAdmittedTimingResult(step,{type:"result",subtype:category,is_error:category!=="success",result:"synthetic-secret"});
  for(let i=0;i<300;i++)r.mark("sdk_result");recordAdmittedTimingResult(step,{type:"result",subtype:"success",is_error:false});recordComponentTimingAbort(step,"cleanup");
  const s=r.snapshot();expect(s.sessions[0]!.steps[0]!.firstResult?.category).toBe(category);expect(s.sessions[0]!.steps[0]!.firstAbort?.source).toBe("cleanup");expect(JSON.stringify(s)).not.toContain("synthetic-secret");expect(readStructuredTimingReceipt(s)).toEqual(s);
});
it("all hostile result shapes classify unknown without invoking traps/getters",()=>{
  let traps=0;const proxy=new Proxy({}, {get(){traps++;throw Error()},getPrototypeOf(){traps++;throw Error()},ownKeys(){traps++;throw Error()},getOwnPropertyDescriptor(){traps++;throw Error()}});const revoked=Proxy.revocable({},{});revoked.revoke();
  const getter={type:"result",get subtype(){traps++;throw Error()},is_error:false};
  for(const input of [proxy,revoked.proxy,Object.create(proxy),Object.create(Object.create(proxy)),getter,{type:"result",subtype:proxy,is_error:false}])expect(classifyTimingResult(input)).toEqual({category:"unknown",isError:null});
  expect(traps).toBe(0);expect(classifyTimingResult({type:"result",subtype:"synthetic-secret",is_error:true})).toEqual({category:"unknown",isError:true});
});
it("unregistered timing contexts cannot record results",()=>{
  const r=createStructuredTimingRecorder({role:"utility"});r.beginSession(1);recordAdmittedTimingResult({ordinal:1},{type:"result",subtype:"success"});expect(r.snapshot().sessions[0]!.steps.every(s=>!s.opened)).toBe(true);
});
it("receipt getter/proxy/malformed/overflow is rejected without authority or payload leak",()=>{
  const r=createStructuredTimingRecorder({role:"utility"});r.beginSession(1);for(let i=0;i<4;i++)createStructuredComponentTiming(r);expect(r.snapshot().overflow).toBe(true);expect(()=>readStructuredTimingReceipt(r.snapshot())).toThrow();
  let traps=0;const base=createStructuredTimingRecorder({role:"wrapper"}).snapshot(),proxy=new Proxy({}, {get(){traps++;throw Error()},getPrototypeOf(){traps++;throw Error()},ownKeys(){traps++;throw Error()}});
  for(const input of [proxy,{...base,get role(){traps++;throw Error()}},{...base,parentLink:proxy},{...base,unexpected:"synthetic-secret"}])expect(()=>readStructuredTimingReceipt(input)).toThrow();expect(traps).toBe(0);
});
it("bad clocks invalidate diagnostics but original work/error still runs exactly once",()=>{
  let calls=0;const r=createStructuredTimingRecorder({role:"utility",clock(){calls++;throw Error("synthetic-secret");}}),work=vi.fn(()=>({}));expect(r.measure("currentness",work)).toBe(work.mock.results[0]!.value);expect(work).toHaveBeenCalledOnce();expect(r.snapshot().invalid).toBe(true);expect(calls).toBeGreaterThan(0);
});
it("actual adapter records unchanged120s expiry separately from disposal",async()=>{
  vi.useFakeTimers();vi.setSystemTime(0);const r=createStructuredTimingRecorder({role:"utility",clock:()=>Date.now()});r.beginSession(1);const observer=createStructuredTimingObserver(r);let disposed=0;
  const adapter=createOpenShellStructuredAdapter({probe:async()=>({} as any),async prepare(input){return{assertCurrent(){input.scope.assertCurrent()},async run(){await new Promise<void>(resolve=>input.scope.signal!.addEventListener("abort",()=>resolve(),{once:true}));input.scope.assertCurrent();throw Error("unreachable")},async dispose(){disposed++}}}},observer);
  const pending=adapter.ask!({authChoice:{mode:"subscription",provider:"claude"},question:"synthetic"} as any,{sessionId:"synthetic",turnId:"synthetic",assertCurrent(){}} as any);const rejected=expect(pending).rejects.toMatchObject({code:"timeout"});await vi.advanceTimersByTimeAsync(120000);await rejected;
  const s=r.snapshot().sessions[0]!;expect(s.adapterTimer.deadlineMs).toBe(120000);expect(s.adapterTimer.registeredMs).toBe(0);expect(s.adapterTimer.dueMs).toBe(120000);expect(s.adapterTimer.callbackMs).toBe(120000);expect(s.firstAbort?.source).toBe("adapter_timeout");expect(s.milestones.adapter_cleanup.completedMs).toBe(120000);expect(disposed).toBe(1);
});
it("two slots/frozen snapshots and boundary-reference clocks stay separate",()=>{
 const parent=createStructuredTimingRecorder({role:"wrapper",clock:()=>100});parent.mark("utility_spawn");const r=createStructuredTimingRecorder({role:"utility",parentLink:{role:"wrapper",boundary:"utility_spawn",offsetMs:parent.snapshot().elapsedMs},clock:()=>5000});r.beginSession(1);r.completeSession();r.beginSession(2);r.mark("http_ask");const s=r.snapshot();expect(s.elapsedMs).toBe(0);expect(s.parentLink?.offsetMs).toBe(0);expect(s.sessions[0]!.completed).toBe(true);expect(Object.isFrozen(s.sessions[0]!.steps[0])).toBe(true);
});

it("recording a non-result or hostile raw value is inert and cannot create a first result",()=>{
 const r=createStructuredTimingRecorder({role:"utility"});r.beginSession(1);const step=createStructuredComponentTiming(r);let traps=0;const proxy=new Proxy({}, {get(){traps++;throw Error()},getPrototypeOf(){traps++;throw Error()},ownKeys(){traps++;throw Error()},getOwnPropertyDescriptor(){traps++;throw Error()}});const revoked=Proxy.revocable({},{});revoked.revoke();
 for(const value of [proxy,revoked.proxy,Object.create(proxy),{type:"system"},{get type(){traps++;throw Error()}}])recordAdmittedTimingResult(step,value);expect(traps).toBe(0);expect(r.snapshot().sessions[0]!.steps[0]!.firstResult).toBeNull();
});

it("overlapping async phases have separate wall spans and never enter sync covered-work totals",async()=>{
 let clock=0;const r=createStructuredTimingRecorder({role:"utility",clock:()=>clock});r.beginSession(1);const o=createStructuredTimingObserver(r);let a!:()=>void,b!:()=>void;
 const first=observeStructuredAsync(o,"compile_profile",()=>new Promise<void>(resolve=>a=resolve)),second=observeStructuredAsync(o,"context_capture",()=>new Promise<void>(resolve=>b=resolve));clock=10;a();b();await Promise.all([first,second]);const s=r.snapshot();expect(s.sessions[0]!.phases.compile_profile.wallMs).toBe(10);expect(s.sessions[0]!.phases.context_capture.wallMs).toBe(10);expect(s.coveredSyncMs).toBe(0);expect(s.metrics.currentness.count).toBe(0);
});
