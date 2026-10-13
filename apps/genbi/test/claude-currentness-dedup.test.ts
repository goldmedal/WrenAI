import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, realpathSync, rmSync, readFileSync, writeFileSync, statSync, utimesSync, renameSync, symlinkSync, lstatSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../server/db.js";
import { ClaudeAccountVault } from "../server/runtime-host/claude-account-vault.js";
import { OpenShellLifecycle } from "../server/runtime-host/openshell-lifecycle.js";
import { createOpenShellClaudeProviderForTesting, deriveClaudeNativeRuntime, claimClaudeHostRuntime } from "../server/runtime-host/openshell-claude-provider.js";
import { runClaudeComponentStep } from "../server/runtime-host/claude-component-step.js";
import type { OpenShellDriver, OpenShellDuplex, OpenShellResource } from "../server/runtime-host/openshell-types.js";
import { query, type Query } from "@anthropic-ai/claude-agent-sdk";
import { attestNativeExecutable, assertNativeExecutableIdentity } from "../server/native-runtime-spec.js";
import type { ClaudeComponentRuntime } from "../server/runtime-host/claude-component-step.js";
import type { StepRun } from "../harness/components/runner.js";

const cleanup: (() => Promise<void>)[]=[];
afterEach(async()=>{for(const close of cleanup.splice(0))await close();});
const init={type:"system",subtype:"init",session_id:"synthetic-session",uuid:"init",claude_code_version:"2.1.259",cwd:"/sandbox",model:"synthetic-model",apiKeySource:"none",tools:["mcp__component__echo"],mcp_servers:[{name:"component",status:"connected"}],skills:[],plugins:[],slash_commands:[],permissionMode:"default"};
const result={type:"result",subtype:"success",session_id:"synthetic-session",uuid:"result",is_error:false,result:"synthetic",permission_denials:[],modelUsage:{"synthetic-model":{webSearchRequests:0,inputTokens:1,outputTokens:1,cacheReadInputTokens:0,cacheCreationInputTokens:0}},usage:{input_tokens:1,output_tokens:1}};
const frame=(request_id:string,message:Record<string,unknown>)=>({type:"control_request",request_id,request:{subtype:"mcp_message",server_name:"component",message}});
const serialized=()=>process.env.GENBI_MCP_META_FIXTURE ? JSON.parse(readFileSync(process.env.GENBI_MCP_META_FIXTURE,"utf8"))[0] as Record<string,unknown> : {jsonrpc:"2.0",id:2,method:"tools/call",params:{name:"echo",arguments:{text:"synthetic"},_meta:{"claudecode/toolUseId":"synthetic-parent",progressToken:2}}};

async function setup(derived = false, countOnly = false) {
 const root=realpathSync(mkdtempSync(path.join(os.tmpdir(),"claude-mcp-meta-")));
 const expected={accountUuid:"11111111-1111-4111-8111-111111111111",organizationUuid:"22222222-2222-4222-8222-222222222222",email:"approved@example.test",subscription:"pro" as const};
 const vault=ClaudeAccountVault.forTesting({root:path.join(root,"vault"),transport:async url=>new Response(JSON.stringify(url.endsWith("/token") ? {access_token:"synthetic-roundtrip-access-1234",refresh_token:"synthetic-roundtrip-refresh-1234",expires_in:3600,scope:"user:profile user:inference",token_type:"Bearer"} : {account:{uuid:expected.accountUuid,email:expected.email},organization:{uuid:expected.organizationUuid,organization_type:"claude_pro"}}))});
 vault.enroll({accessToken:"synthetic-import-access-1234",refreshToken:"synthetic-import-refresh-1234",expiresAt:Date.now()+3600000});await vault.verify(expected);
 const digest="sha256:"+"a".repeat(64),identity={image:digest,policy:digest,gateway:"synthetic",workspace:"default",configuration:digest};
 const resources=new Map<string,OpenShellResource>(),responses:Record<string,unknown>[]=[];
 let resolveDone!:(value:number)=>void,wake:(()=>void)|undefined,closed=false,bootstrapped=false,prompted=false,listed=false,started=false,pending="",promptCount=0,forwardedContent="";
 const chunks:Buffer[]=[];const emit=(value:unknown)=>{chunks.push(Buffer.from(JSON.stringify(value)+"\n"));wake?.();wake=undefined;};
 const begin=()=>{if(!prompted||!listed||started)return;started=true;emit(init);emit({type:"system",subtype:"thinking_tokens",session_id:"synthetic-session",uuid:"thinking",estimated_tokens:2.5,estimated_tokens_delta:0.5});emit({type:"assistant",session_id:"synthetic-session",uuid:"assistant",parent_tool_use_id:null,message:{content:[{type:"tool_use",id:"synthetic-parent",name:"mcp__component__echo",input:{text:"synthetic"}}]}});const call=serialized();emit(frame("mcp-call",call));};
 const stream:OpenShellDuplex={done:new Promise(resolve=>resolveDone=resolve),output:(async function*(){while(!closed||chunks.length){if(!chunks.length){await new Promise<void>(resolve=>wake=resolve);continue;}yield{stream:"stdout" as const,data:chunks.shift()!};}})(),close(){closed=true;resolveDone(0);wake?.();wake=undefined;},write(data){
  if(!bootstrapped){bootstrapped=true;expect(data.readUInt32BE(0)).toBe(data.length-4);return;}
  pending+=data.toString("utf8");for(let index;(index=pending.indexOf("\n"))>=0;){const value=JSON.parse(pending.slice(0,index));pending=pending.slice(index+1);
   if(value.type==="control_request"){
    if(value.request.subtype==="initialize"){
     emit({type:"control_response",response:{subtype:"success",request_id:value.request_id,response:{account:{tokenSource:"CLAUDE_CODE_OAUTH_TOKEN",apiProvider:"firstParty"},commands:[],agents:[],models:[],output_style:"default",available_output_styles:["default"]}}});
     emit(frame("mcp-init",{jsonrpc:"2.0",id:0,method:"initialize",params:{protocolVersion:"2024-11-05",capabilities:{},clientInfo:{name:"claude-code",version:"2.1.259"}}}));
    }else if(value.request.subtype==="interrupt")emit({type:"control_response",response:{subtype:"success",request_id:value.request_id,response:{}}});
   }else if(value.type==="user"){promptCount++;forwardedContent=value.message.content;prompted=true;begin();}
   else if(value.type==="control_response"){
    responses.push(value);
    if(value.response.request_id==="mcp-init"){emit(frame("mcp-notify",{jsonrpc:"2.0",method:"notifications/initialized"}));emit(frame("mcp-list",{jsonrpc:"2.0",id:1,method:"tools/list"}));}
    if(value.response.request_id==="mcp-list"){listed=true;begin();}
    if(value.response.request_id==="mcp-call"){emit(result);}
   }
  }
 }};
 const driver:OpenShellDriver={version:"synthetic",identity,modelIdentity:identity,probe:async()=>{},create:async intent=>{const resource={id:intent.id,name:intent.name,workspace:"default",labels:{"genbi-lifecycle-owner":intent.owner}};resources.set(intent.name,resource);return resource;},list:async intent=>[...resources.values()].filter(r=>r.name===intent.name),inspect:async intent=>{const resource=resources.get(intent.name);if(!resource)throw Error();return resource;},remove:async intent=>{resources.delete(intent.name);},assertAbsent:async intent=>{expect(resources.has(intent.name)).toBe(false);},exec:async()=>{throw Error("no live runtime");},duplex:async()=>stream};
 const store=new Store(":memory:"),lifecycle=new OpenShellLifecycle({driver,journal:store,stateRoot:path.join(root,"lifecycle"),exclusive:true});
 cleanup.push(async()=>{stream.close();await lifecycle.shutdown();vault.close();store.close();rmSync(root,{recursive:true,force:true});});await lifecycle.initialize();
 const status=vault.status(),scope={backend:"openshell" as const,account:status.fingerprint!,generation:status.generation!,session:"roundtrip",turn:"turn",binding:"binding",bindingGeneration:"1",bindingRevision:digest,context:digest,plan:digest,...identity};
 const executable=path.join(root,"attested-executable");writeFileSync(executable,"#!/bin/sh\nexit 0\n",{mode:0o700});utimesSync(executable,1700000000,1700000000);
 const executableIdentity=attestNativeExecutable("node",executable),controller=new AbortController();let generation=1,checks=0,executableChecks=0;const bindingCheck=vi.fn(()=>{if(generation!==1)throw Error("synthetic stale binding");});
 const guard=()=>{checks++;controller.signal.throwIfAborted();bindingCheck();};
 const assertExecutableCurrent=()=>{executableChecks++;assertNativeExecutableIdentity(executableIdentity);};
 let afterNext:(value:unknown)=>void=()=>{},afterAccount:()=>void=()=>{},beforeNext:()=>void=()=>{};
 const counterEvents=[init,{type:"system",subtype:"thinking_tokens",session_id:"synthetic-session",uuid:"counter-progress",estimated_tokens:1,estimated_tokens_delta:1},result];
 const sdkQuery:ClaudeComponentRuntime["query"]=input=>{const original=countOnly?{accountInfo:async()=>({tokenSource:"CLAUDE_CODE_OAUTH_TOKEN",apiProvider:"firstParty"}),next:async()=>({done:false,value:counterEvents.shift()})} as unknown as Query:query(input);return {async next(){beforeNext();const next=await original.next();afterNext(next.value);return next;},async accountInfo(){const value=await original.accountInfo();afterAccount();return value;}} as unknown as Query;};
 const provider=createOpenShellClaudeProviderForTesting({lifecycle,vault,models:{cheap:"synthetic-model"},scope,currentScope:()=>scope,assertCurrent:guard,assertExecutableCurrent},sdkQuery);
 const original=await provider.open("synthetic-model",controller.signal,"cheap");
 const runtime=derived?deriveClaudeNativeRuntime(original,bindingCheck,()=>original.close()):original;
 const echo=vi.fn(async()=>({text:"synthetic"}));const run:StepRun={tier:"cheap",request:"synthetic",input:{},consumes:{},children:[],prompt:"declared echo",signal:new AbortController().signal,tools:{echo},toolDescriptions:{echo:"synthetic"},toolSchemas:{echo:{type:"object",properties:{text:{type:"string"}},required:["text"],additionalProperties:false}}};
 return{runtime,original,run,echo,resources,responses,store,vault,executable,executableIdentity,bindingCheck,controller,
  get checks(){return checks},get executableChecks(){return executableChecks},set beforeNext(value:()=>void){beforeNext=value},set afterNext(value:(value:unknown)=>void){afterNext=value},set afterAccount(value:()=>void){afterAccount=value},
  changeGeneration(){generation++},mutate(kind:string){
   const metadata=statSync(executable);
   if(kind==="same-size"){writeFileSync(executable,"#!/bin/sh\nexit 1\n");utimesSync(executable,metadata.atime,metadata.mtime);expect(statSync(executable).size).toBe(metadata.size);expect(statSync(executable).mtimeMs).toBe(metadata.mtimeMs);}
   else if(kind==="replacement"){const replacement=executable+"-replacement";writeFileSync(replacement,"#!/bin/sh\nexit 1\n",{mode:0o700});renameSync(replacement,executable);}
   else if(kind==="symlink"){renameSync(executable,executable+"-original");symlinkSync(executable+"-original",executable);}
   else if(kind==="abort")controller.abort();else if(kind==="generation")generation++;else if(kind==="revoke")vault.disconnect();else throw Error("unsupported synthetic mutation");
  },get promptCount(){return promptCount},get forwardedContent(){return forwardedContent},get stdinDestroyed(){return runtime.signal?.aborted}};
}


it.each([false,true])("fresh registered proof preserves successful real-SDK result (derived=%s)",async derived=>{
 const t=await setup(derived);const returned=await runClaudeComponentStep(t.runtime,t.run);expect(returned).toEqual({value:"synthetic",usage:{inputTokens:1,outputTokens:1}});expect(t.echo).toHaveBeenCalledOnce();expect(t.promptCount).toBe(1);expect(t.resources.size).toBe(0);expect(Object.isFrozen(t.runtime)).toBe(true);expect(t.runtime.model).toBe(t.original.model);if(derived)expect(t.bindingCheck).toHaveBeenCalled();
});
it.each([false,true])("host currentness executes one original chain per component iterator boundary (derived=%s)",async derived=>{
 const t=await setup(derived,true);const initial=t.checks;t.runtime.assertCurrent();const singleChain=t.checks-initial;expect(singleChain).toBeGreaterThan(0);let before=0,after=0;
 t.afterNext=value=>{if((value as Record<string,unknown>)?.type==="system"&&(value as Record<string,unknown>).subtype==="thinking_tokens")before=t.checks;};
 t.beforeNext=()=>{if(before&&!after)after=t.checks;};
 await runClaudeComponentStep(t.runtime,t.run);expect(after-before).toBe(singleChain); // Compare one actual original chain, including the retained lifecycle active check, without transport callbacks.

});
it.each([false,true])("thinking progress keeps live currentness but does not rehash executables (derived=%s)",async derived=>{
 const t=await setup(derived,true);let before=0,after=0;
 t.afterNext=value=>{if((value as Record<string,unknown>)?.type==="system"&&(value as Record<string,unknown>).subtype==="thinking_tokens")before=t.executableChecks;};
 t.beforeNext=()=>{if(before&&!after)after=t.executableChecks;};
 await runClaudeComponentStep(t.runtime,t.run);expect(after-before).toBe(0);expect(t.executableChecks).toBeGreaterThan(0);
});
for(const derived of [false,true])for(const stage of ["after-init","after-progress","before-result"] as const)for(const kind of ["same-size","replacement","symlink","generation","abort","revoke"]){
 it(`retains full-byte and live fences ${stage}/${kind}/derived=${derived}`,async()=>{
  const t=await setup(derived);let changed=false;t.afterNext=value=>{const frame=value as Record<string,unknown>;const hit=stage==="after-init"?frame.subtype==="init":stage==="after-progress"?frame.subtype==="thinking_tokens":frame.type==="result";if(hit&&!changed){t.mutate(kind);changed=true;}};
  await expect(runClaudeComponentStep(t.runtime,t.run)).rejects.toThrow();expect(changed).toBe(true);if(kind==="same-size"||kind==="replacement")expect(readFileSync(t.executable,"utf8")).toBe("#!/bin/sh\nexit 1\n");if(kind==="same-size")expect(statSync(t.executable).mtimeMs).toBe(1700000000000);if(kind==="symlink")expect(lstatSync(t.executable).isSymbolicLink()).toBe(true);if(kind==="abort")expect(t.controller.signal.aborted).toBe(true);if(kind==="revoke")expect(t.vault.status().state).toBe("revoked");expect(t.resources.size).toBe(0);if(stage!=="before-result")expect(t.echo).not.toHaveBeenCalled();else expect(t.echo).toHaveBeenCalledOnce();
 });
}
it.each([false,true])("reentrant asynchronous tool mutation blocks reply/result and further effect (derived=%s)",async derived=>{
 const t=await setup(derived);let mutationCompleted=false;t.echo.mockImplementation(async()=>{await Promise.resolve();t.mutate("same-size");mutationCompleted=true;return{text:"late"};});await expect(runClaudeComponentStep(t.runtime,t.run)).rejects.toThrow();expect(mutationCompleted).toBe(true);expect(t.echo).toHaveBeenCalledOnce();expect(t.responses.some(v=>(v.response as any).request_id==="mcp-call"&&(v.response as any).response?.result?.content)).toBe(false);expect(t.resources.size).toBe(0);
});
it.each([false,true])("untrusted field/function copy cannot acquire the proof (derived=%s)",async derived=>{
 const t=await setup(derived);expect(()=>claimClaudeHostRuntime({...t.runtime},t.run)).toThrow();await t.runtime.close();expect(t.resources.size).toBe(0);
});
it("unregistered local runtime still invokes its original currentness at every component boundary",async()=>{
 const guard=vi.fn(),events=[{...init,cwd:"/synthetic/work",tools:[]},result];
 const local:ClaudeComponentRuntime={cwd:"/synthetic/work",executable:"/synthetic/claude",model:"synthetic-model",account:{email:"approved@example.test",tokenSource:"CLAUDE_CODE_OAUTH_TOKEN",subscriptionType:"Claude Pro"},environment:{HOME:"/synthetic/home",CLAUDE_CONFIG_DIR:"/synthetic/config"},assertCurrent:guard,close:vi.fn(async()=>{}),spawn:()=>{throw Error("no process permitted")},query:()=>{expect(guard).toHaveBeenCalledTimes(1);return{accountInfo:async()=>({email:"approved@example.test",tokenSource:"CLAUDE_CODE_OAUTH_TOKEN",subscriptionType:"Claude Pro",apiKeySource:"none",apiProvider:"firstParty"}),next:async()=>({done:false,value:events.shift()})} as unknown as Query;}};
 const run:StepRun={tier:"cheap",request:"synthetic",input:{},consumes:{},children:[],prompt:"synthetic",signal:new AbortController().signal,tools:{},toolSchemas:{},toolDescriptions:{}};
 await expect(runClaudeComponentStep(local,run)).resolves.toEqual({value:"synthetic",usage:{inputTokens:1,outputTokens:1}});expect(guard).toHaveBeenCalledTimes(5);expect(local.close).toHaveBeenCalledOnce();
});
