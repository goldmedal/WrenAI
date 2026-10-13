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

async function setup(change?: (call: Record<string, unknown>)=>Record<string, unknown>, afterReply: Record<string,unknown>[] = [], finalResult: Record<string,unknown> = result) {
 const root=realpathSync(mkdtempSync(path.join(os.tmpdir(),"claude-mcp-meta-")));
 const expected={accountUuid:"11111111-1111-4111-8111-111111111111",organizationUuid:"22222222-2222-4222-8222-222222222222",email:"approved@example.test",subscription:"pro" as const};
 const vault=ClaudeAccountVault.forTesting({root:path.join(root,"vault"),transport:async url=>new Response(JSON.stringify(url.endsWith("/token") ? {access_token:"synthetic-roundtrip-access-1234",refresh_token:"synthetic-roundtrip-refresh-1234",expires_in:3600,scope:"user:profile user:inference",token_type:"Bearer"} : {account:{uuid:expected.accountUuid,email:expected.email},organization:{uuid:expected.organizationUuid,organization_type:"claude_pro"}}))});
 vault.enroll({accessToken:"synthetic-import-access-1234",refreshToken:"synthetic-import-refresh-1234",expiresAt:Date.now()+3600000});await vault.verify(expected);
 const digest="sha256:"+"a".repeat(64),identity={image:digest,policy:digest,gateway:"synthetic",workspace:"default",configuration:digest};
 const resources=new Map<string,OpenShellResource>(),responses:Record<string,unknown>[]=[];
 let resolveDone!:(value:number)=>void,wake:(()=>void)|undefined,closed=false,bootstrapped=false,prompted=false,listed=false,started=false,pending="";
 const chunks:Buffer[]=[];const emit=(value:unknown)=>{chunks.push(Buffer.from(JSON.stringify(value)+"\n"));wake?.();wake=undefined;};
 const begin=()=>{if(!prompted||!listed||started)return;started=true;emit(init);emit({type:"system",subtype:"thinking_tokens",session_id:"synthetic-session",uuid:"thinking",estimated_tokens:2.5,estimated_tokens_delta:0.5});emit({type:"assistant",session_id:"synthetic-session",uuid:"assistant",parent_tool_use_id:null,message:{content:[{type:"tool_use",id:"synthetic-parent",name:"mcp__component__echo",input:{text:"synthetic"}}]}});const call=serialized();emit(frame("mcp-call",change?change(call):call));};
 const stream:OpenShellDuplex={done:new Promise(resolve=>resolveDone=resolve),output:(async function*(){while(!closed||chunks.length){if(!chunks.length){await new Promise<void>(resolve=>wake=resolve);continue;}yield{stream:"stdout" as const,data:chunks.shift()!};}})(),close(){closed=true;resolveDone(0);wake?.();wake=undefined;},write(data){
  if(!bootstrapped){bootstrapped=true;expect(data.readUInt32BE(0)).toBe(data.length-4);return;}
  pending+=data.toString("utf8");for(let index;(index=pending.indexOf("\n"))>=0;){const value=JSON.parse(pending.slice(0,index));pending=pending.slice(index+1);
   if(value.type==="control_request"){
    if(value.request.subtype==="initialize"){
     emit({type:"control_response",response:{subtype:"success",request_id:value.request_id,response:{account:{tokenSource:"CLAUDE_CODE_OAUTH_TOKEN",apiProvider:"firstParty"},commands:[],agents:[],models:[],output_style:"default",available_output_styles:["default"]}}});
     emit(frame("mcp-init",{jsonrpc:"2.0",id:0,method:"initialize",params:{protocolVersion:"2024-11-05",capabilities:{},clientInfo:{name:"claude-code",version:"2.1.259"}}}));
    }else if(value.request.subtype==="interrupt")emit({type:"control_response",response:{subtype:"success",request_id:value.request_id,response:{}}});
   }else if(value.type==="user"){prompted=true;begin();}
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
 const provider=createOpenShellClaudeProvider({lifecycle,vault,models:{cheap:"synthetic-model"},scope,currentScope:()=>scope,assertCurrent(){}});
 const runtime=await provider.open("synthetic-model",new AbortController().signal,"cheap");
 const echo=vi.fn(async()=>({text:"synthetic"}));const run:StepRun={tier:"cheap",request:"synthetic",input:{},consumes:{},children:[],prompt:"declared echo",signal:new AbortController().signal,tools:{echo},toolDescriptions:{echo:"synthetic"},toolSchemas:{echo:{type:"object",properties:{text:{type:"string"}},required:["text"],additionalProperties:false}}};
 return{runtime,run,echo,resources,responses,store};
}

it("completes pinned metadata through the real SDK, branded host, vault, lifecycle and framed fake peer",async()=>{
 const test=await setup();await expect(runClaudeComponentStep(test.runtime,test.run)).resolves.toEqual({value:"synthetic",usage:{inputTokens:1,outputTokens:1}});
 expect(test.echo).toHaveBeenCalledExactlyOnceWith({text:"synthetic"});expect(test.resources.size).toBe(0);expect(test.store.listOpenShellIntents().every(i=>i.phase==="cleaned")).toBe(true);
 const response=test.responses.find(value=>(value.response as Record<string,unknown>).request_id==="mcp-call");expect(response).toBeDefined();
});
it("preserves the runner's null-prototype StepRun containers through branded integrity checks",async()=>{
 const test=await setup();
 for(const name of ["input","consumes","tools","toolDescriptions","toolSchemas"] as const)Object.setPrototypeOf(test.run[name],null);
 await expect(runClaudeComponentStep(test.runtime,test.run)).resolves.toMatchObject({value:"synthetic"});
 expect(test.echo).toHaveBeenCalledOnce();expect(test.resources.size).toBe(0);
});
it("preserves trailing sparse-array holes in StepRun data snapshots",async()=>{
 const test=await setup();Object.assign(test.run.consumes,{sparse:new Array(2)});
 await expect(runClaudeComponentStep(test.runtime,test.run)).resolves.toMatchObject({value:"synthetic"});
 expect(test.echo).toHaveBeenCalledOnce();expect(test.resources.size).toBe(0);
});
it.each(["data","function","signal","prototype"])("rejects post-claim %s mutation before tool effects",async kind=>{
 let test!:Awaited<ReturnType<typeof setup>>;
 test=await setup(call=>{
  if(kind==="data")Object.assign(test.run.consumes,{forged:true});
  if(kind==="function")Object.assign(test.run.tools,{echo:async()=>({text:"forged"})});
  if(kind==="signal")Object.defineProperty(test.run,"signal",{value:new AbortController().signal});
  if(kind==="prototype")Object.setPrototypeOf(test.run.tools,null);
  return call;
 });
 await expect(runClaudeComponentStep(test.runtime,test.run)).rejects.toThrow();expect(test.echo).not.toHaveBeenCalled();expect(test.resources.size).toBe(0);
});
it.each(["custom-prototype","accessor","symbol"])("rejects unsupported StepRun %s without interpreting it",async kind=>{
 const test=await setup(),getter=vi.fn(()=>"forged");
 if(kind==="custom-prototype")Object.setPrototypeOf(test.run.consumes,{inherited:true});
 if(kind==="accessor")Object.defineProperty(test.run.consumes,"getter",{enumerable:true,get:getter});
 if(kind==="symbol")Object.assign(test.run.consumes,{[Symbol("authority")]:true});
 await expect(runClaudeComponentStep(test.runtime,test.run)).rejects.toThrow();expect(getter).not.toHaveBeenCalled();expect(test.echo).not.toHaveBeenCalled();expect(test.resources.size).toBe(0);
});
it.each(["unknown-meta","wrong-token","wrong-tool","wrong-input"])("rejects framed %s before any effect through the real SDK",async kind=>{
 const test=await setup(call=>{const params=call.params as Record<string,unknown>,meta=params._meta as Record<string,unknown>;return{...call,params:{...params,...(kind==="wrong-tool"?{name:"Bash"}:kind==="wrong-input"?{arguments:{text:1}}:{_meta:{...meta,...(kind==="unknown-meta"?{scope:"sibling"}:{progressToken:99})}})}};});
 await expect(runClaudeComponentStep(test.runtime,test.run)).rejects.toThrow();expect(test.echo).not.toHaveBeenCalled();expect(test.resources.size).toBe(0);
});


const rateFixture=(status:string):Record<string,unknown>=>process.env.GENBI_RATE_LIMIT_FIXTURE ? (JSON.parse(readFileSync(process.env.GENBI_RATE_LIMIT_FIXTURE,"utf8")) as Record<string,unknown>[]).find(event=>(event.rate_limit_info as Record<string,unknown>).status===status)! : {type:"rate_limit_event",session_id:"synthetic-session",uuid:"synthetic-rate",rate_limit_info:{status,resetsAt:-1,rateLimitType:"five_hour",utilization:1.25,overageStatus:"allowed_warning",overageResetsAt:Number.MAX_SAFE_INTEGER+1,overageDisabledReason:"org_level_disabled_until",isUsingOverage:false,overageInUse:true,surpassedThreshold:-0.5,rateLimitGraceActive:true,overagePeriodMonthly:{utilization:-1},overagePeriodChannel:{utilization:Number.MAX_SAFE_INTEGER+1},errorCode:"credits_required",canUserPurchaseCredits:true,hasChargeableSavedPaymentMethod:false,unifiedWindows:{five_hour:{utilization:1.25,resetsAt:2000000000},seven_day:{utilization:-0.25,resetsAt:2000000001},seven_day_overage_included:{utilization:2.5,resetsAt:2000000002}}}};
it.each(["allowed","allowed_warning","rejected"])("completes real SDK tool reply → complete pinned %s event → authoritative result",async status=>{
 const test=await setup(undefined,[rateFixture(status)]);await expect(runClaudeComponentStep(test.runtime,test.run)).resolves.toEqual({value:"synthetic",usage:{inputTokens:1,outputTokens:1}});
 expect(test.echo).toHaveBeenCalledExactlyOnceWith({text:"synthetic"});expect(test.responses.some(v=>(v.response as Record<string,unknown>).request_id==="mcp-call")).toBe(true);expect(test.resources.size).toBe(0);expect(test.store.listOpenShellIntents().every(i=>i.phase==="cleaned")).toBe(true);
});
it.each(["unknown","nested","replay","cross-session","error-result"])("real SDK rate %s cannot add effects or infer completion",async kind=>{
 const rate=rateFixture("allowed"),info=rate.rate_limit_info as Record<string,unknown>;
 const events=kind==="replay"?[rate,rate]:[{...rate,...(kind==="cross-session"?{session_id:"sibling"}:kind==="unknown"?{rate_limit_info:{...info,extra:true}}:kind==="nested"?{rate_limit_info:{...info,overagePeriodMonthly:{utilization:1,extra:true}}}:{})}];
 const test=await setup(undefined,events,kind==="error-result"?{...result,is_error:true}:result);await expect(runClaudeComponentStep(test.runtime,test.run)).rejects.toThrow();expect(test.echo).toHaveBeenCalledTimes(1);expect(test.resources.size).toBe(0);
});
