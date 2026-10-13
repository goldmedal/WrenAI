import { expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
const responseState = vi.hoisted(() => ({ refresh: 200, profile: 200 }));
const calls = vi.hoisted(() => [] as { url: string; options: Record<string, unknown>; body: string }[]);
vi.mock("node:https",async()=>{
 const {EventEmitter}=await import("node:events");
 return {request(url:string,options:Record<string,unknown>,callback:(response:EventEmitter)=>void){
  const req=new EventEmitter() as EventEmitter & {end(body:string):void;destroy():void};
  req.destroy=()=>{};req.end=body=>{
   calls.push({url,options,body});
   const response=Object.assign(new EventEmitter(),{statusCode:url.endsWith("/token")?responseState.refresh:responseState.profile,headers:{"content-type":"application/json"},destroy(){}});
   const raw=url.endsWith("/token")?{access_token:"synthetic-production-access-1234",refresh_token:"synthetic-production-refresh-1234",scope:"user:profile user:inference",expires_in:3600,token_type:"Bearer"}:{account:{uuid:"11111111-1111-4111-8111-111111111111",email:"approved@example.test"},organization:{uuid:"22222222-2222-4222-8222-222222222222",organization_type:"claude_pro"}};
   queueMicrotask(()=>{callback(response);queueMicrotask(()=>{response.emit("data",Buffer.from(JSON.stringify(raw)));response.emit("end");});});
  };return req;
 }};
});
it("production factory uses dedicated literal HTTPS sockets and same authenticated access without ambient fetch",async()=>{
 const {createClaudeHostVerifier,readHostVerificationReceipt}=await import("../server/runtime-host/claude-host-verification.js");
 const receipt=await createClaudeHostVerifier()("synthetic-production-import-1234",new AbortController().signal);
 expect(readHostVerificationReceipt(receipt).identity.subscription).toBe("pro");
 expect(calls.map(c=>c.url)).toEqual(["https://platform.claude.com/v1/oauth/token","https://api.anthropic.com/api/oauth/profile"]);
 expect(calls.every(c=>c.options.agent===false)).toBe(true);
 expect(calls[1]!.options.headers).toMatchObject({authorization:"Bearer synthetic-production-access-1234","cache-control":"no-cache","accept-encoding":"identity"});
 expect(JSON.parse(calls[0]!.body)).toMatchObject({scope:"user:profile user:inference",client_id:"9d1c250a-e61b-44d9-88ed-5944d1962f5e"});
});

it.each([204,205,302,304,500])("production HTTPS safely refuses HTTP %s before Web Response construction",async status=>{
 const {createClaudeHostVerifier}=await import("../server/runtime-host/claude-host-verification.js");
 responseState.refresh=status;
 try {await expect(createClaudeHostVerifier()("synthetic-production-import-1234",new AbortController().signal)).rejects.toThrow("Claude host refresh");}
 finally {responseState.refresh=200;}
});
it("production HTTPS safely refuses a profile HTTP failure after authenticated refresh",async()=>{
 const {createClaudeHostVerifier}=await import("../server/runtime-host/claude-host-verification.js");responseState.profile=204;
 try {await expect(createClaudeHostVerifier()("synthetic-production-import-1234",new AbortController().signal)).rejects.toThrow("Claude host profile");}
 finally {responseState.profile=200;}
});
