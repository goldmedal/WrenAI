import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, chmodSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ClaudeAccountVault, assertVaultLease } from "../server/runtime-host/claude-account-vault.js";
import { createClaudeHostVerifierForTesting, HOST_ENDPOINTS, readHostVerificationReceipt } from "../server/runtime-host/claude-host-verification.js";
const identity = { accountUuid:"11111111-1111-4111-8111-111111111111", organizationUuid:"22222222-2222-4222-8222-222222222222", email:"approved@example.test", subscription:"pro" as const };
const bundle = {accessToken:"synthetic-imported-access-1234", refreshToken:"synthetic-refresh-canary-1234", expiresAt:Date.now()+3600000};
const refreshed = "synthetic-refreshed-access-1234";
const grant = () => ({access_token:refreshed,refresh_token:"synthetic-rotated-refresh-1234",expires_in:3600,scope:"user:profile user:inference",token_type:"Bearer"});
const profile = () => ({account:{uuid:identity.accountUuid,email:identity.email},organization:{uuid:identity.organizationUuid,organization_type:"claude_pro",name:"Approved Org"}});
const resources: { root: string; vault: ClaudeAccountVault }[] = [];
afterEach(() => { for (const { root, vault } of resources.splice(0)) { vault.close(); rmSync(root, { recursive: true, force: true }); } });
function setup() {
 const root = mkdtempSync(path.join(os.tmpdir(), "claude-vault-")); let now=Date.now();
 const transport=vi.fn(async(url:string,_init:RequestInit)=>new Response(JSON.stringify(url===HOST_ENDPOINTS.refresh?grant():profile())));
 const vault = ClaudeAccountVault.forTesting({root,transport,now:()=>now}); resources.push({root,vault});
 return {root,vault,transport,advance(ms:number){now+=ms}};
}
async function approve(test:ReturnType<typeof setup>) { test.vault.enroll(bundle); await test.vault.verify(identity); const s=test.vault.status();return {fingerprint:s.fingerprint!,generation:s.generation!}; }
describe("host authenticated refresh and same-access profile vault",()=>{
 it("never trusts imported access; preserves stable enrollment and synchronously aborts old leases at rotation",async()=>{
  const t=setup();t.vault.enroll(bundle);await expect(t.vault.lease("x","y")).rejects.toThrow("unverified");
  await t.vault.verify(identity);const s=t.vault.status();const a=await t.vault.lease(s.fingerprint!,s.generation!);
  expect(a.accessCredential()).toBe(refreshed);expect(t.transport.mock.calls[1]![1].headers).toMatchObject({authorization:`Bearer ${refreshed}`});
  expect(t.transport.mock.calls[0]![1].body).toContain('"scope":"user:profile user:inference"');
  const rotation=t.vault.verify(identity);expect(a.signal.aborted).toBe(true);expect(()=>assertVaultLease(a)).toThrow();expect(t.vault.status().state).toBe("busy");
  await rotation;const b=await t.vault.lease(s.fingerprint!,s.generation!);expect(b.generation).toBe(a.generation);expect(b.credentialGeneration).not.toBe(a.credentialGeneration);
  expect(()=>assertVaultLease({...b})).toThrow("identity");t.vault.disconnect();expect(b.signal.aborted).toBe(true);
 });
 it("single-flights initial verification and does not publish before profile settles",async()=>{
  const t=setup();t.vault.enroll(bundle);let resolve!: (response:Response)=>void;
  t.transport.mockImplementation(async url=>url===HOST_ENDPOINTS.refresh?new Response(JSON.stringify(grant())):new Promise(r=>resolve=r));
  const a=t.vault.verify(identity), b=t.vault.verify(identity);expect(a).toBe(b);await expect(t.vault.verify({...identity,email:"other@example.test"})).rejects.toThrow("identity");await new Promise(r=>setTimeout(r,5));
  await expect(t.vault.lease("x","y")).rejects.toThrow("busy");expect(t.transport).toHaveBeenCalledTimes(2);resolve(new Response(JSON.stringify(profile())));await a;
 });
 it.each(["user:profile","user:inference","","user:profile user:inference user:profile","user:profile user:inference org:read"])("rejects unauthenticated/ambiguous scope %s",async scope=>{
  const t=setup();t.transport.mockResolvedValue(new Response(JSON.stringify({...grant(),scope})));t.vault.enroll(bundle);await expect(t.vault.verify(identity)).rejects.toThrow("refresh");expect(t.vault.status().state).not.toBe("verified");expect(t.transport).toHaveBeenCalledTimes(1);
 });
 it("cannot restore old authority after mismatch, failure, tamper, or late replacement",async()=>{
  const t=setup();const s=await approve(t);const old=await t.vault.lease(s.fingerprint,s.generation);
  t.transport.mockImplementation(async url=>new Response(JSON.stringify(url===HOST_ENDPOINTS.refresh?grant():{...profile(),account:{...profile().account,email:"other@example.test"}})));
  await expect(t.vault.verify(identity)).rejects.toThrow("identity");expect(()=>old.accessCredential()).toThrow();await expect(t.vault.lease(s.fingerprint,s.generation)).rejects.toThrow();
  let resolve!: (response:Response)=>void;t.transport.mockImplementation(()=>new Promise(r=>resolve=r));const pending=t.vault.verify(identity);const rejection=expect(pending).rejects.toThrow();await Promise.resolve();t.vault.enroll(bundle);resolve(new Response(JSON.stringify(grant())));await rejection;expect(t.vault.status()).toEqual({state:"unverified"});
 });
 it("keeps disk failure unavailable and aborts all leases synchronously",async()=>{
  const t=setup();const s=await approve(t);const a=await t.vault.lease(s.fingerprint,s.generation),b=await t.vault.lease(s.fingerprint,s.generation);
  chmodSync(path.join(t.root,"account.json"),0o644);expect(()=>a.assertCurrent()).toThrow("storage");expect(a.signal.aborted).toBe(true);expect(b.signal.aborted).toBe(true);expect(()=>b.assertCurrent()).toThrow();chmodSync(path.join(t.root,"account.json"),0o600);
 });
 it("fences before storage failure during rotation and never accepts a persistence flag on restart",async()=>{
  const t=setup();const s=await approve(t);const old=await t.vault.lease(s.fingerprint,s.generation);
  chmodSync(t.root,0o755);const pending=t.vault.verify(identity);expect(old.signal.aborted).toBe(true);await expect(pending).rejects.toThrow();chmodSync(t.root,0o700);
  t.vault.close();const next=new ClaudeAccountVault({root:t.root});expect(next.status().state).not.toBe("verified");next.close();
 });
 it("retains legacy credentials as unverified without accepting old SDK assertions",async()=>{
  const t=setup();t.vault.close();writeFileSync(path.join(t.root,"account.json"),JSON.stringify({version:1,generation:identity.accountUuid,bundle,identity:{email:identity.email},verified:true,refreshing:false}),{mode:0o600});
  const next=new ClaudeAccountVault({root:t.root});expect(next.status()).toEqual({state:"unverified"});expect(JSON.parse(readFileSync(path.join(t.root,"account.json"),"utf8")).bundle).toEqual(bundle);next.close();
  rmSync(path.join(t.root,"account.json"));symlinkSync("/dev/null",path.join(t.root,"account.json"));expect(()=>new ClaudeAccountVault({root:t.root})).toThrow("storage");
 });
 it("uses fixed endpoints/header policy, opaque receipts and omitted refresh fallback",async()=>{
  const t=setup();t.transport.mockImplementation(async url=>new Response(JSON.stringify(url===HOST_ENDPOINTS.refresh?{...grant(),refresh_token:undefined}:profile())));
  const verifier=createClaudeHostVerifierForTesting(t.transport);const receipt=await verifier(bundle.refreshToken,new AbortController().signal);
  expect(readHostVerificationReceipt(receipt).bundle.refreshToken).toBe(bundle.refreshToken);expect(()=>readHostVerificationReceipt({...receipt})).toThrow();expect(JSON.stringify(receipt)).not.toContain("access");
  expect(t.transport.mock.calls.map(([url])=>url)).toEqual([HOST_ENDPOINTS.refresh,HOST_ENDPOINTS.profile]);expect(t.transport.mock.calls.every(([,init])=>init.redirect==="error")).toBe(true);
 });
 it.each(["claude_pro","claude_max","claude_team","claude_enterprise"])("maps exact subscription %s",async kind=>{
  const t=setup();t.transport.mockImplementation(async url=>new Response(JSON.stringify(url===HOST_ENDPOINTS.refresh?grant():{...profile(),organization:{...profile().organization,organization_type:kind}})));
  const receipt=await createClaudeHostVerifierForTesting(t.transport)(bundle.refreshToken,new AbortController().signal);expect(readHostVerificationReceipt(receipt).identity.subscription).toBe(kind.slice(7));
 });
 it.each([undefined,null,"api","CLAUDE_PRO"])("denies unsupported subscription %s",async kind=>{
  const t=setup();t.transport.mockImplementation(async url=>new Response(JSON.stringify(url===HOST_ENDPOINTS.refresh?grant():{...profile(),organization:{...profile().organization,organization_type:kind}})));
  t.vault.enroll(bundle);await expect(t.vault.verify(identity)).rejects.toThrow();
 });
 it.each(["accountUuid","organizationUuid","email","subscription"])("requires explicit approved %s equality",async field=>{
  const t=setup();t.vault.enroll(bundle);await expect(t.vault.verify({...identity,[field]:field.endsWith("Uuid")?"33333333-3333-4333-8333-333333333333":field==="email"?"other@example.test":"max"})).rejects.toThrow("identity");
 });
 it.each(["headers","body","cancel"])("bounds whole stage %s even for a broken transport",async mode=>{
  const transport=async(_url:string,init:RequestInit)=>mode==="headers"?new Promise<Response>(()=>{}):new Response(new ReadableStream({start(c){if(mode==="cancel")c.enqueue(new Uint8Array([123]));},cancel(){return new Promise(()=>{})}}));
  const start=Date.now();await expect(createClaudeHostVerifierForTesting(transport,{stageDeadlineMs:20})(bundle.refreshToken,new AbortController().signal)).rejects.toThrow("timeout");expect(Date.now()-start).toBeLessThan(500);
 });
 it.each([new Response("x".repeat(32769)),new Response(new Uint8Array([255])),new Response("bad"),new Response("secret",{status:302}),new Response("{}",{headers:{"content-encoding":"gzip"}})])("sanitizes malformed, oversized, redirect/compressed responses",async response=>{
  await expect(createClaudeHostVerifierForTesting(async()=>response)(bundle.refreshToken,new AbortController().signal)).rejects.toThrow("Claude host refresh");
 });
});
