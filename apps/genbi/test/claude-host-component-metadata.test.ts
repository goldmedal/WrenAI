import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../server/db.js";
import { ClaudeAccountVault } from "../server/runtime-host/claude-account-vault.js";
import { OpenShellLifecycle } from "../server/runtime-host/openshell-lifecycle.js";
import type { OpenShellDriver, OpenShellResource } from "../server/runtime-host/openshell-types.js";
import type { ClaudeComponentRuntime } from "../server/runtime-host/claude-component-step.js";
import { createOpenShellClaudeProviderForTesting } from "../server/runtime-host/openshell-claude-provider.js";
import { runClaudeComponentStep } from "../server/runtime-host/claude-component-step.js";
import { PINNED_CLAUDE_BUILTIN_AGENTS, ClaudeRawProtocol } from "../server/runtime-host/claude-protocol.js";
import type { StepRun } from "../harness/components/runner.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { vi.useRealTimers(); for (const close of cleanup.splice(0)) await close(); });
async function setup(events: unknown[], wire = false) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "claude-observation-")));
  const expected = { accountUuid: "11111111-1111-4111-8111-111111111111", organizationUuid: "22222222-2222-4222-8222-222222222222", email: "approved@example.test", subscription: "pro" as const };
  const vault = ClaudeAccountVault.forTesting({ root: path.join(root, "vault"), transport: async url => new Response(JSON.stringify(url.endsWith("/token")
    ? { access_token: "synthetic-observation-access-1234", refresh_token: "synthetic-observation-refresh-1234", expires_in: 3600, scope: "user:profile user:inference", token_type: "Bearer" }
    : { account: { uuid: expected.accountUuid, email: expected.email }, organization: { uuid: expected.organizationUuid, organization_type: "claude_pro" } })) });
  vault.enroll({ accessToken: "synthetic-import-access-1234", refreshToken: "synthetic-import-refresh-1234", expiresAt: Date.now() + 3600000 }); await vault.verify(expected);
  const digest = "sha256:" + "a".repeat(64), identity = { image: digest, policy: digest, gateway: "synthetic", workspace: "default", configuration: digest };
  const resources = new Map<string, OpenShellResource>(); const remove = vi.fn(async (intent: { name: string }) => { resources.delete(intent.name); });
  const driver: OpenShellDriver = { version: "synthetic", identity, modelIdentity: identity, probe: async () => {},
    create: async intent => { const resource = { id: intent.id, name: intent.name, workspace: "default", labels: { "genbi-lifecycle-owner": intent.owner } }; resources.set(intent.name, resource); return resource; },
    list: async intent => [...resources.values()].filter(resource => resource.name === intent.name), inspect: async intent => { const resource = resources.get(intent.name); if (!resource) throw Error(); return resource; }, remove,
    assertAbsent: async intent => { expect(resources.has(intent.name)).toBe(false); }, exec: async () => { throw Error("no process or model request"); } };
  const store = new Store(":memory:"), lifecycle = new OpenShellLifecycle({ driver, journal: store, stateRoot: path.join(root, "lifecycle"), exclusive: true });
  cleanup.push(async () => { await lifecycle.shutdown(); vault.close(); store.close(); rmSync(root, { recursive: true, force: true }); }); await lifecycle.initialize();
  const status = vault.status(), scope = { backend: "openshell" as const, account: status.fingerprint!, generation: status.generation!, session: "observation", turn: "turn", binding: "binding", bindingGeneration: "1", bindingRevision: digest, context: digest, plan: digest, ...identity };
  let active = true;
  const raw = wire ? new ClaudeRawProtocol({run:step().run,model:"synthetic-model",cwd:"/sandbox",secret:"synthetic-only",check(){if(!active)throw Error("revoked");}}) : undefined;
  const query = vi.fn(() => ({ accountInfo: async () => ({ tokenSource: "CLAUDE_CODE_OAUTH_TOKEN", apiProvider: "firstParty" }), next: async () => { let value = events.shift(); if(typeof value === "function"){value();value=events.shift();} raw?.worker(value as Record<string,unknown>); return {done:false,value}; } }));
  const provider = createOpenShellClaudeProviderForTesting({ lifecycle, vault, models: { cheap: "synthetic-model" }, scope, currentScope: () => scope, assertCurrent() {if(!active)throw Error("revoked");} }, query as unknown as ClaudeComponentRuntime["query"]);
  const runtime = await provider.open("synthetic-model", new AbortController().signal, "cheap");
  return { runtime, query, resources, remove, store, revoke(){active=false;} };
}

const init={type:"system",subtype:"init",session_id:"session",uuid:"init",claude_code_version:"2.1.259",cwd:"/sandbox",model:"synthetic-model",apiKeySource:"none",tools:["mcp__component__echo"],mcp_servers:[{name:"component",status:"connected"}],skills:[],plugins:[],slash_commands:[],permissionMode:"default",agents:["Explore","Plan","general-purpose","statusline-setup","claude"]};
const result={type:"result",subtype:"success",session_id:"session",uuid:"result",is_error:false,result:"synthetic",permission_denials:[],modelUsage:{"synthetic-model":{webSearchRequests:0,inputTokens:1,outputTokens:1,cacheReadInputTokens:0,cacheCreationInputTokens:0}},usage:{input_tokens:1,output_tokens:1}};
function step(){const echo=vi.fn(async()=>({text:"synthetic"}));const run:StepRun={tier:"cheap",request:"synthetic",input:{},consumes:{},children:[],prompt:"declared echo only",signal:new AbortController().signal,tools:{echo},toolDescriptions:{echo:"synthetic"},toolSchemas:{echo:{type:"object",properties:{text:{type:"string"}},required:["text"],additionalProperties:false}}};return{run,echo};}
it.each([undefined,[],["Explore","Plan","general-purpose","statusline-setup","claude"]])("accepts absent/empty/exact pinned host metadata %j only with actual proof and cleans its worker",async agents=>{
 const test=await setup([{...init,agents},result]),{run,echo}=step();await expect(runClaudeComponentStep(test.runtime,run)).resolves.toMatchObject({value:"synthetic"});expect(echo).not.toHaveBeenCalled();expect(test.resources.size).toBe(0);expect(test.store.listOpenShellIntents().every(i=>i.phase==="cleaned")).toBe(true);
});
it.each([["custom"],PINNED_CLAUDE_BUILTIN_AGENTS.slice(0,4),[...PINNED_CLAUDE_BUILTIN_AGENTS.slice(0,4),"Explore"],null])("rejects non-pinned host agent metadata %j without effects",async agents=>{
 const test=await setup([{...init,agents},result]),{run,echo}=step();await expect(runClaudeComponentStep(test.runtime,run)).rejects.toThrow("Claude component protocol");expect(echo).not.toHaveBeenCalled();expect(test.resources.size).toBe(0);
});
it.each(["Agent","Task"])("pinned builtin metadata cannot grant host %s effects",async name=>{
 const test=await setup([init,{type:"assistant",session_id:"session",uuid:"effect",parent_tool_use_id:null,message:{content:[{type:"tool_use",name,id:"call",input:{}}]}},result]),{run,echo}=step();await expect(runClaudeComponentStep(test.runtime,run)).rejects.toThrow("Claude component protocol");expect(echo).not.toHaveBeenCalled();expect(test.resources.size).toBe(0);
});

const progress={type:"system",subtype:"thinking_tokens",session_id:"session",uuid:"progress",estimated_tokens:2.5,estimated_tokens_delta:0.5};
it("admits framed host progress through both layers and completes only with authoritative result usage",async()=>{
 const test=await setup([init,progress,{...progress,uuid:"block-reset",estimated_tokens:0,estimated_tokens_delta:0},
  {type:"assistant",session_id:"session",uuid:"assistant",parent_tool_use_id:null,message:{content:[{type:"text",text:"synthetic"}]}},result],true),{run,echo}=step();
 await expect(runClaudeComponentStep(test.runtime,run)).resolves.toEqual({value:"synthetic",usage:{inputTokens:1,outputTokens:1}});
 expect(echo).not.toHaveBeenCalled();expect(test.resources.size).toBe(0);expect(test.store.listOpenShellIntents().every(i=>i.phase==="cleaned")).toBe(true);
});
it.each([{estimated_tokens:-1},{estimated_tokens_delta:-1},{estimated_tokens:NaN},{estimated_tokens:Infinity},
 {estimated_tokens:Number.MAX_SAFE_INTEGER+1},{estimated_tokens_delta:3},{estimated_tokens:"2"},{estimated_tokens_delta:undefined},
 {extra:true},{subtype:"api_retry"},{uuid:"init"},{session_id:"sibling"},{uuid:"x".repeat(129)},
 {usage:{output_tokens:999}},{message:{content:[{type:"tool_use",name:"Bash",input:{}}]}}])("host component rejects hostile progress %j without effects",async change=>{
 const test=await setup([init,{...progress,...change},result]),{run,echo}=step();
 await expect(runClaudeComponentStep(test.runtime,run)).rejects.toThrow("Claude component protocol");expect(echo).not.toHaveBeenCalled();expect(test.resources.size).toBe(0);
});
it.each(["pre-init","replay","revocation","cap","error-result"])("host progress cannot evade %s fence",async kind=>{
 const events:unknown[]=kind==="pre-init"?[progress,init,result]:kind==="replay"?[init,progress,progress,result]:kind==="cap"?[init,...Array.from({length:8200},(_,i)=>({...progress,uuid:"p"+i})),result]:[init,progress,result];
 const test=await setup(events),{run,echo}=step();
 if(kind==="revocation")events.splice(1,0,()=>test.revoke());
 if(kind==="error-result")events[2]={...result,is_error:true};
 await expect(runClaudeComponentStep(test.runtime,run)).rejects.toThrow("Claude component protocol");expect(echo).not.toHaveBeenCalled();expect(test.resources.size).toBe(0);
});


const rate={type:"rate_limit_event",session_id:"session",uuid:"rate",rate_limit_info:{status:"allowed"}};
it.each(["allowed","allowed_warning","rejected"])("host skips %s rate metadata and retains authoritative result usage",async status=>{
 const test=await setup([init,{...rate,rate_limit_info:{status,utilization:1.5}},result],true),{run,echo}=step();
 await expect(runClaudeComponentStep(test.runtime,run)).resolves.toEqual({value:"synthetic",usage:{inputTokens:1,outputTokens:1}});expect(echo).not.toHaveBeenCalled();expect(test.resources.size).toBe(0);
});
it.each(["pre-init","replay","revocation","cap","error-result","unknown","nested","identity"])("rate metadata cannot evade host %s fence",async kind=>{
 const events:unknown[]=kind==="pre-init"?[rate,init,result]:kind==="replay"?[init,rate,rate,result]:kind==="cap"?[init,...Array.from({length:8200},(_,i)=>({...rate,uuid:"r"+i})),result]:[init,rate,result];
 if(kind==="unknown")events[1]={...rate,rate_limit_info:{status:"allowed",scope:"forged"}};
 if(kind==="nested")events[1]={...rate,rate_limit_info:{status:"allowed",unifiedWindows:{five_hour:{utilization:1,resetsAt:2,scope:"forged"}}}};
 if(kind==="identity")events[1]={...rate,uuid:"x".repeat(129)};
 if(kind==="error-result")events[2]={...result,is_error:true};
 const test=await setup(events),{run,echo}=step();if(kind==="revocation")events.splice(1,0,()=>test.revoke());
 await expect(runClaudeComponentStep(test.runtime,run)).rejects.toThrow("Claude component protocol");expect(echo).not.toHaveBeenCalled();expect(test.resources.size).toBe(0);
});
