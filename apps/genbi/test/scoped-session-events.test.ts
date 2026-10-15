import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { Store } from "../server/db.js";
import { scopedSessionSocket } from "../server/scoped-session-socket.js";
import type { NativeSessionService } from "../server/native-sessions.js";
const cleanup: (() => void)[] = []; afterEach(() => cleanup.splice(0).reverse().forEach(close => close()));
const native = (store: Store, id = "session") => store.createNativeSession({ id, transport: "scoped-events", purpose: "analysis", vendor: "claude", agent: "answer_query", scopeKind: "bound_project", scopeId: "scope", projectIdentity: "project", bindingGeneration: 1, projectRevision: "revision", runtimeGeneration: 1, dispatchProfile: "genbi-default", dispatchTarget: "claude-code:interactive" });
it("keeps global cursors ordered without calling interleaved sessions pruned, and records actual pruning", () => {
  const store = new Store(":memory:"); cleanup.push(() => store.close()); native(store,"a"); native(store,"b");
  for (let n=0;n<3;n++) { store.appendNativeScopedEvent("a",null,"state",{state:"ready"}); store.appendNativeScopedEvent("b",null,"state",{state:"ready"}); }
  expect(store.listNativeScopedEvents("b")[0]!.sequence).toBe(2); expect(store.nativeScopedPrunedThrough("a")).toBe(0); expect(store.nativeScopedPrunedThrough("b")).toBe(0);
  for (let n=0;n<520;n++) store.appendNativeScopedEvent("a",null,"worklog",{n});
  const a = store.listNativeScopedEvents("a"); expect(a).toHaveLength(512); expect(store.nativeScopedPrunedThrough("a")).toBeGreaterThan(0);
  expect(a[0]!.sequence).toBeGreaterThan(store.nativeScopedPrunedThrough("a")); expect(store.nativeScopedPrunedThrough("b")).toBe(0);
  expect(store.listNativeScopedEvents("a",a[20]!.sequence).every(row=>row.sequence>a[20]!.sequence)).toBe(true);
  for (let n=0;n<8;n++) store.appendNativeScopedEvent("b",null,"user",{text:"x".repeat(600000)});
  expect(store.listNativeScopedEvents("b").reduce((n,row)=>n+Buffer.byteLength(JSON.stringify(row.payload)),0)).toBeLessThanOrEqual(4194304);
  expect(store.nativeScopedPrunedThrough("b")).toBeGreaterThan(0);
});
it("atomically commits one root answer, rolls back an oversized result, and restart interrupts pending requests without resuming", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(),"scoped-restart-")); cleanup.push(()=>rmSync(dir,{recursive:true,force:true})); const file=path.join(dir,"bff.sqlite");
  let store = new Store(file); native(store); store.transitionNativeSession("session","running");
  store.reserveNativeScopedRequest("session","complete","hash","turn");
  expect(()=>store.finishNativeScopedRequest("session","complete","complete","answer",{text:"x".repeat(1100000)},{digest:"digest",envelopeJson:"{}"})).toThrow();
  expect(store.getNativeScopedRequest("session","complete")?.status).toBe("running"); expect(store.getLatestNativeStructuredAnswer("session")).toBeUndefined();
  const answer={kind:"answer",answer:{form:"rich",envelope:{}}}; const saved=store.finishNativeScopedRequest("session","complete","complete","answer",answer,{digest:"digest",envelopeJson:"{}"});
  expect(saved).toBeDefined(); expect(store.finishNativeScopedRequest("session","complete","complete","answer",answer)).toBeUndefined();
  store.reserveNativeScopedRequest("session","pending","hash2","turn2"); store.close(); store=new Store(file); cleanup.push(()=>store.close());
  expect(store.getNativeSession("session")).toMatchObject({transport:"scoped-events",status:"interrupted",failure:expect.stringContaining("BFF restart")});
  expect(store.getNativeScopedRequest("session","pending")?.status).toBe("interrupted"); expect(store.getNativeScopedRequest("session","complete")?.status).toBe("complete");
  expect(store.listNativeScopedEvents("session").filter(row=>row.kind==="answer")).toHaveLength(1);
  expect(store.getLatestNativeStructuredAnswer("session")).toMatchObject({grounded:true});
});
it("socket closes malformed authority frames, has no browser command seam, and browser close only detaches", async () => {
  const detach=vi.fn(),cancel=vi.fn(async()=>{}),submit=vi.fn(async()=>{}),attachScoped=vi.fn(()=>({detach,cancel,submit}));
  const service={attachScoped} as unknown as NativeSessionService,ws={send:vi.fn(),close:vi.fn()};
  const socket=scopedSessionSocket(service,"session","cap","0");socket.onOpen(null,ws); expect(attachScoped).toHaveBeenCalledWith("session","cap",expect.any(Function),0);
  socket.onMessage({data:JSON.stringify({type:"prompt",requestId:"request",text:"question"})},ws);expect(submit).toHaveBeenCalledWith("request","question");
  socket.onMessage({data:JSON.stringify({type:"cancel"})},ws);expect(cancel).toHaveBeenCalledOnce();
  for(const data of [JSON.stringify({type:"prompt",requestId:"request",text:"question",sessionId:"other"}),JSON.stringify({type:"exec",pid:99,command:"arbitrary"}),"{",Buffer.from("{}"),"x".repeat(263169)]) socket.onMessage({data},ws);
  expect(ws.close).toHaveBeenCalledTimes(5);socket.onClose();expect(detach).toHaveBeenCalledOnce();expect(cancel).toHaveBeenCalledOnce();
  const invalid=scopedSessionSocket(service,"session","cap","-1");invalid.onOpen(null,ws);expect(attachScoped).toHaveBeenCalledOnce();
});
