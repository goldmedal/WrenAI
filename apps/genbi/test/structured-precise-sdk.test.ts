import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, realpathSync, rmSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../server/db.js";
import { ClaudeAccountVault } from "../server/runtime-host/claude-account-vault.js";
import { OpenShellLifecycle } from "../server/runtime-host/openshell-lifecycle.js";
import { createOpenShellClaudeProvider } from "../server/runtime-host/openshell-claude-provider.js";
import { runClaudeComponentStep } from "../server/runtime-host/claude-component-step.js";
import type { OpenShellDriver, OpenShellDuplex, OpenShellResource } from "../server/runtime-host/openshell-types.js";
import type { StepRun } from "../harness/components/runner.js";

const cleanup: (() => Promise<void>)[]=[];
afterEach(async()=>{for(const close of cleanup.splice(0))await close();});
const init={type:"system",subtype:"init",session_id:"synthetic-session",uuid:"init",claude_code_version:"2.1.259",cwd:"/sandbox",model:"synthetic-model",apiKeySource:"none",tools:["mcp__component__echo"],mcp_servers:[{name:"component",status:"connected"}],skills:[],plugins:[],slash_commands:[],permissionMode:"default"};
const result={type:"result",subtype:"success",session_id:"synthetic-session",uuid:"result",is_error:false,result:"synthetic",permission_denials:[],modelUsage:{"synthetic-model":{webSearchRequests:0,inputTokens:1,outputTokens:1,cacheReadInputTokens:0,cacheCreationInputTokens:0}},usage:{input_tokens:1,output_tokens:1}};
const frame=(request_id:string,message:Record<string,unknown>)=>({type:"control_request",request_id,request:{subtype:"mcp_message",server_name:"component",message}});
const serialized=()=>process.env.GENBI_MCP_META_FIXTURE ? JSON.parse(readFileSync(process.env.GENBI_MCP_META_FIXTURE,"utf8"))[0] as Record<string,unknown> : {jsonrpc:"2.0",id:2,method:"tools/call",params:{name:"echo",arguments:{text:"synthetic"},_meta:{"claudecode/toolUseId":"synthetic-parent",progressToken:2}}};

async function setup(thinkingOnly = false, afterReply: Record<string,unknown>[] = [], finalResult: Record<string,unknown> = result) {
 const root=realpathSync(mkdtempSync(path.join(os.tmpdir(),"claude-mcp-meta-")));
 const expected={accountUuid:"11111111-1111-4111-8111-111111111111",organizationUuid:"22222222-2222-4222-8222-222222222222",email:"approved@example.test",subscription:"pro" as const};
 const vault=ClaudeAccountVault.forTesting({root:path.join(root,"vault"),transport:async url=>new Response(JSON.stringify(url.endsWith("/token") ? {access_token:"synthetic-roundtrip-access-1234",refresh_token:"synthetic-roundtrip-refresh-1234",expires_in:3600,scope:"user:profile user:inference",token_type:"Bearer"} : {account:{uuid:expected.accountUuid,email:expected.email},organization:{uuid:expected.organizationUuid,organization_type:"claude_pro"}}))});
 vault.enroll({accessToken:"synthetic-import-access-1234",refreshToken:"synthetic-import-refresh-1234",expiresAt:Date.now()+3600000});await vault.verify(expected);
 const digest="sha256:"+"a".repeat(64),identity={image:digest,policy:digest,gateway:"synthetic",workspace:"default",configuration:digest};
 const resources=new Map<string,OpenShellResource>(),responses:Record<string,unknown>[]=[];
 let resolveDone!:(value:number)=>void,wake:(()=>void)|undefined,closed=false,bootstrapped=false,prompted=false,listed=false,started=false,pending="",promptCount=0,forwardedContent="";
 const chunks:Buffer[]=[];const emit=(value:unknown)=>{chunks.push(Buffer.from(JSON.stringify(value)+"\n"));wake?.();wake=undefined;};
 const begin=()=>{if(!prompted||!listed||started)return;started=true;emit(init);if(thinkingOnly){for(let i=0;i<3;i++)emit({type:"system",subtype:"thinking_tokens",session_id:"synthetic-session",uuid:"thinking-"+i,estimated_tokens:i+1,estimated_tokens_delta:1});return;}emit({type:"system",subtype:"thinking_tokens",session_id:"synthetic-session",uuid:"thinking",estimated_tokens:2.5,estimated_tokens_delta:0.5});emit({type:"assistant",session_id:"synthetic-session",uuid:"assistant",parent_tool_use_id:null,message:{content:[{type:"tool_use",id:"synthetic-parent",name:"mcp__component__echo",input:{text:"synthetic"}}]}});const call=serialized();emit(frame("mcp-call",call));};
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
    if(value.response.request_id==="mcp-call"){for(const event of afterReply)emit(event);emit(finalResult);}
   }
  }
 }};
 const driver:OpenShellDriver={version:"synthetic",identity,modelIdentity:identity,probe:async()=>{},create:async intent=>{const resource={id:intent.id,name:intent.name,workspace:"default",labels:{"genbi-lifecycle-owner":intent.owner}};resources.set(intent.name,resource);return resource;},list:async intent=>[...resources.values()].filter(r=>r.name===intent.name),inspect:async intent=>{const resource=resources.get(intent.name);if(!resource)throw Error();return resource;},remove:async intent=>{resources.delete(intent.name);},assertAbsent:async intent=>{expect(resources.has(intent.name)).toBe(false);},exec:async()=>{throw Error("no live runtime");},duplex:async()=>stream};
 const store=new Store(":memory:"),lifecycle=new OpenShellLifecycle({driver,journal:store,stateRoot:path.join(root,"lifecycle"),exclusive:true});
 cleanup.push(async()=>{stream.close();await lifecycle.shutdown();vault.close();store.close();rmSync(root,{recursive:true,force:true});});await lifecycle.initialize();
 const status=vault.status(),scope={backend:"openshell" as const,account:status.fingerprint!,generation:status.generation!,session:"roundtrip",turn:"turn",binding:"binding",bindingGeneration:"1",bindingRevision:digest,context:digest,plan:digest,...identity};
 const timing=createStructuredTimingRecorder({role:"utility"});timing.beginSession(1);
 const provider=createOpenShellClaudeProvider({timing,lifecycle,vault,models:{cheap:"synthetic-model"},scope,currentScope:()=>scope,assertCurrent(){}});
 const runtime=await provider.open("synthetic-model",new AbortController().signal,"cheap");
 const echo=vi.fn(async()=>({text:"synthetic"}));const run:StepRun={tier:"cheap",request:"synthetic",input:{},consumes:{},children:[],prompt:"declared echo",signal:new AbortController().signal,tools:{echo},toolDescriptions:{echo:"synthetic"},toolSchemas:{echo:{type:"object",properties:{text:{type:"string"}},required:["text"],additionalProperties:false}}};
 return{runtime,run,timing,echo,resources,responses,store,get promptCount(){return promptCount},get forwardedContent(){return forwardedContent},get stdinDestroyed(){return runtime.signal?.aborted}};
}

import {createStructuredTimingRecorder} from "../server/structured-timing.js";
import {ClaudeRawProtocol} from "../server/runtime-host/claude-protocol.js";
const evidence:Record<string,unknown>[]=[];
it("actual source branded provider + real SDK forwards user exactly once and completes tool/result without input EOF",async()=>{
 const t=await setup();const returned=await runClaudeComponentStep(t.runtime,t.run);expect(returned).toEqual({value:"synthetic",usage:{inputTokens:1,outputTokens:1}});expect(t.promptCount).toBe(1);expect(t.forwardedContent).toBe(JSON.stringify({request:t.run.request,input:t.run.input,consumes:t.run.consumes}));expect(t.echo).toHaveBeenCalledOnce();expect(t.resources.size).toBe(0);expect(t.responses.some(v=>(v.response as any).request_id==="mcp-call")).toBe(true);expect(t.timing.snapshot().sessions[0]!.steps[0]!.firstResult?.category).toBe("success");evidence.push({case:"completion",timing:t.timing.snapshot(),actualProductionSource:true,realSdk:true,brandedVaultLifecycle:true,promptForwardedExactlyOnce:true,exactEnvelope:true,governedToolEffect:1,matchingReply:true,resultReturned:true,requiredPrematureInputEOF:false,ownedResourcesAbsent:true});
});
it("thinking-only peer remains awaitable then external cancellation closes without result/effect",async()=>{
 const t=await setup(true),controller=new AbortController();const p=runClaudeComponentStep(t.runtime,{...t.run,signal:controller.signal});const rejection=expect(p).rejects.toThrow();await new Promise(r=>setTimeout(r,100));expect(t.promptCount).toBe(1);controller.abort();await rejection;expect(t.echo).not.toHaveBeenCalled();expect(t.resources.size).toBe(0);expect(t.timing.snapshot().sessions[0]!.steps[0]!.firstResult).toBeNull();evidence.push({case:"thinking_only_cancel",timing:t.timing.snapshot(),actualProductionSource:true,realSdk:true,promptForwardedExactlyOnce:true,observedThinkingFrames:3,cancellation:true,resultReturned:false,governedToolEffect:0,ownedResourcesAbsent:true});
});
it("pre-aborted input cannot forward user or effect",async()=>{
 const t=await setup(true),controller=new AbortController();controller.abort();await expect(runClaudeComponentStep(t.runtime,{...t.run,signal:controller.signal})).rejects.toThrow();expect(t.promptCount).toBe(0);expect(t.echo).not.toHaveBeenCalled();evidence.push({case:"pre_abort",promptForwarded:false,governedToolEffect:0,resultReturned:false});
});
import {writeFileSync} from "node:fs";
import {afterAll} from "vitest";
afterAll(()=>{const file=process.env.GENBI_PRECISE_TIMING_EVIDENCE;if(file)writeFileSync(file,JSON.stringify({version:1,synthetic:true,actualVendorRequests:0,realCredentialReads:0,actualRuntimeResources:0,cases:evidence},null,2)+"\n",{mode:0o600});});

it.each(["error_during_execution","error_max_turns","error_max_budget_usd","error_max_structured_output_retries"])("actual raw admission retains %s and never synthesizes success",async category=>{
 const t=await setup(false,[],{...result,subtype:category,is_error:true});await expect(runClaudeComponentStep(t.runtime,t.run)).rejects.toThrow();const step=t.timing.snapshot().sessions[0]!.steps[0]!;expect(step.firstResult?.category).toBe(category);expect(step.firstResult?.isError).toBe(true);expect(step.timer.deadlineMs).toBe(120000);expect(t.resources.size).toBe(0);evidence.push({case:category,timing:t.timing.snapshot(),resultReturned:false,ownedResourcesAbsent:true});
});
it("actual factory post-admission wrapper preserves original receiver/return/error for hostile values",async()=>{
 const t=await setup(true),descriptor=Object.getOwnPropertyDescriptor(ClaudeRawProtocol.prototype,"worker")!;let captured:ClaudeRawProtocol|undefined,receiver:unknown,traps=0;const sentinel={},error=Error("synthetic-secret-error");let fail=false;
 Object.defineProperty(ClaudeRawProtocol.prototype,"worker",{configurable:true,get(){captured=this;return function(this:unknown){receiver=this;if(fail)throw error;return sentinel;}},set(value){Object.defineProperty(this,"worker",{value,configurable:true,writable:true});}});
 try{t.runtime.admitStep!(t.run);expect(captured).toBeDefined();const proxy=new Proxy({}, {get(){traps++;throw Error()},getPrototypeOf(){traps++;throw Error()},ownKeys(){traps++;throw Error()},getOwnPropertyDescriptor(){traps++;throw Error()}}),revoked=Proxy.revocable({},{});revoked.revoke();
  for(const value of [proxy,revoked.proxy,Object.create(proxy),Object.create(Object.create(proxy)),{type:"result",subtype:proxy},{get type(){traps++;throw Error()}}]){expect((captured!.worker as any)(value)).toBe(sentinel);expect(receiver).toBe(captured);}
  expect(traps).toBe(0);expect(t.timing.snapshot().sessions[0]!.steps[0]!.firstResult).toBeNull();fail=true;try{captured!.worker({type:"result",subtype:"success"});throw Error("not thrown");}catch(e){expect(e).toBe(error);}
 }finally{Object.defineProperty(ClaudeRawProtocol.prototype,"worker",descriptor);await t.runtime.close();}
});
