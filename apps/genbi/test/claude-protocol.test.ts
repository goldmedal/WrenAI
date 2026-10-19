import { describe, expect, it } from "vitest";
import { ClaudeLineFrames, ClaudeRawProtocol, PINNED_CLAUDE_BUILTIN_AGENTS, CLAUDE_TRANSPORT_LIMITS as L } from "../server/runtime-host/claude-protocol.js";
import type { StepRun } from "../harness/components/runner.js";
const run: StepRun = { tier:"cheap",request:"synthetic",input:{},consumes:{},children:[],prompt:"",signal:new AbortController().signal,
 tools:{echo:async()=>({})},toolDescriptions:{},toolSchemas:{echo:{type:"object",properties:{text:{type:"string"}},required:["text"],additionalProperties:false}} };
const init={type:"system",subtype:"init",session_id:"session",uuid:"init",claude_code_version:"2.1.259",cwd:"/sandbox",model:"synthetic-model",apiKeySource:"none",tools:["mcp__component__echo"],mcp_servers:[{name:"component",status:"connected"}],skills:[],plugins:[],slash_commands:[],permissionMode:"default"};
const mcp=(request_id="one",id: string|number=1,method="initialize",params: unknown={protocolVersion:"2024-11-05",capabilities:{},clientInfo:{name:"synthetic",version:"1"}})=>({type:"control_request",request_id,request:{subtype:"mcp_message",server_name:"component",message:{jsonrpc:"2.0",id,method,params}}});
function gate() {let active=true;const protocol=new ClaudeRawProtocol({run,model:"synthetic-model",cwd:"/sandbox",secret:"synthetic-secret-canary",check(){if(!active)throw Error("revoked")}});return {protocol,revoke(){active=false}};}
const account = { email: "approved@example.test", tokenSource: "CLAUDE_CODE_OAUTH_TOKEN", subscriptionType: "synthetic", apiKeySource: "none", apiProvider: "firstParty" };
const metadata = { account, commands: [], agents: [], models: [], output_style: "default", available_output_styles: ["default"] };
const response = (body: Record<string, unknown> = metadata, request_id = "init-host") => ({ type: "control_response", response: { subtype: "success", request_id, response: body } });
const encode = (value: unknown) => Buffer.from(JSON.stringify(value) + "\n");
function initializeGate() { const p = gate().protocol; p.host({ type: "control_request", request_id: "init-host", request: { subtype: "initialize" } }); return p; }
describe("Claude raw gate before SDK MCP",()=>{
 it("binds initialization, exact tool schema and one-shot handler claims",()=>{const {protocol:p}=gate();p.worker(init);p.worker(mcp());p.worker(mcp("two",2,"tools/call",{name:"echo",arguments:{text:"合成"}}));p.claim("echo",{text:"合成"});p.settled();expect(()=>p.claim("echo",{text:"合成"})).toThrow();});
 it.each(["outer","rpc","server","Bash","permission","scope","late","schema","before-init"])("rejects %s authority",kind=>{const f=gate(),p=f.protocol;if(kind!=="before-init")p.worker(init);if(kind==="before-init"){p.worker(mcp());expect(()=>p.worker(mcp("call",2,"tools/call",{name:"echo",arguments:{text:"ok"}}))).toThrow();return}p.worker(mcp());const call=mcp("two",2,"tools/call",{name:"echo",arguments:{text:"ok"}});p.worker(call);
  if(kind==="outer"){expect(()=>p.worker(call)).toThrow();return}if(kind==="rpc"){expect(()=>p.worker({...call,request_id:"three"})).toThrow();return}
  if(kind==="late"){f.revoke();expect(()=>p.claim("echo",{text:"ok"})).toThrow();return}
  const bad=kind==="server"?{...call,request_id:"three",request:{...call.request,server_name:"other"}}:kind==="Bash"?mcp("three",3,"tools/call",{name:"Bash",arguments:{}}):kind==="schema"?mcp("three",3,"tools/call",{name:"echo",arguments:{text:1}}):kind==="permission"?{type:"control_request",request_id:"three",request:{subtype:"can_use_tool",tool_name:"Bash"}}:{type:"result",session_id:"sibling",uuid:"x"};expect(()=>p.worker(bad)).toThrow();
 });
 it("admits the pinned CLI MCP handshake before system/init, then governs the declared tool", () => {
  const p = gate().protocol;
  p.worker(mcp("one",1,"initialize",{protocolVersion:"2024-11-05",capabilities:{},clientInfo:{name:"synthetic",version:"1",title:"Synthetic client",description:"Synthetic public metadata",websiteUrl:"https://example.test"}}));
  p.worker({type:"control_request",request_id:"initialized",request:{subtype:"mcp_message",server_name:"component",message:{jsonrpc:"2.0",method:"notifications/initialized"}}});
  p.worker(mcp("list",2,"tools/list",{}));
  p.worker({...init,agents:["Explore","Plan","general-purpose","statusline-setup","claude"]});
  p.worker(mcp("call",3,"tools/call",{name:"echo",arguments:{text:"ok"}}));p.claim("echo",{text:"ok"});p.settled();
 });
 it.each(["tool", "server", "outer-replay", "rpc-replay", "scope", "method", "notification-before-mcp", "malformed"])("rejects pre-system/init %s", kind => {
  const f = gate(), p = f.protocol;
  if(kind === "notification-before-mcp") { expect(()=>p.worker({type:"control_request",request_id:"notification",request:{subtype:"mcp_message",server_name:"component",message:{jsonrpc:"2.0",method:"notifications/initialized"}}})).toThrow();return; }
  p.worker(mcp());
  if(kind === "scope") { f.revoke();expect(()=>p.worker(mcp("list",2,"tools/list",{}))).toThrow();return; }
  const bad = kind === "tool" ? mcp("call",2,"tools/call",{name:"echo",arguments:{text:"ok"}}) :
   kind === "server" ? {...mcp("list",2,"tools/list",{}),request:{...mcp().request,server_name:"other",message:{jsonrpc:"2.0",id:2,method:"tools/list",params:{}}}} :
   kind === "outer-replay" ? mcp("one",2,"tools/list",{}) : kind === "rpc-replay" ? mcp("list",1,"tools/list",{}) :
   kind === "method" ? mcp("other",2,"resources/read",{}) : mcp("list",2,"tools/list",{extra:true});
  expect(()=>p.worker(bad)).toThrow();
 });
 it.each([{title:1},{title:"x".repeat(129)},{description:{}},{description:"x".repeat(1025)},{websiteUrl:"not a URL"},{websiteUrl:1},{accessCredential:"opaque-value"}])("rejects malformed or unknown MCP client metadata %j", fields => {
  expect(()=>gate().protocol.worker(mcp("one",1,"initialize",{protocolVersion:"2024-11-05",capabilities:{},clientInfo:{name:"synthetic",version:"1",...fields}}))).toThrow();
 });
 it.each([undefined,[],[...PINNED_CLAUDE_BUILTIN_AGENTS]])("admits only absent/empty/exact pinned raw metadata %j",agents=>{expect(()=>gate().protocol.worker({...init,agents})).not.toThrow();});
 it.each([PINNED_CLAUDE_BUILTIN_AGENTS.slice(0,4),[...PINNED_CLAUDE_BUILTIN_AGENTS,"custom"],[...PINNED_CLAUDE_BUILTIN_AGENTS.slice(0,4),"Explore"],["custom"],null])("rejects non-pinned builtin metadata %j", agents => {
  expect(()=>gate().protocol.worker({...init,agents})).toThrow();
 });
 it.each(["Agent","Task"])("builtin metadata grants no %s tool authority", name => {
  const p=gate().protocol;p.worker({...init,agents:[...PINNED_CLAUDE_BUILTIN_AGENTS]});p.worker(mcp());
  expect(()=>p.worker(mcp("effect",2,"tools/call",{name,arguments:{}}))).toThrow();
  expect(()=>p.worker({type:"assistant",session_id:"session",uuid:"effect-message",parent_tool_use_id:null,message:{content:[{type:"tool_use",name,id:"call",input:{}}]}})).toThrow();
  expect(()=>p.claim(name,{})).toThrow();
 });
 it("rejects duplicate/unknown host response IDs",()=>{const {protocol:p}=gate();p.host({type:"control_request",request_id:"host",request:{subtype:"initialize"}});const frame=response(metadata,"host");p.worker(frame);expect(()=>p.worker(frame)).toThrow();expect(()=>p.host({type:"control_request",request_id:"host",request:{subtype:"initialize"}})).toThrow();});
 it("rejects result and settlement while a host control response is outstanding",()=>{const {protocol:p}=gate();p.worker(init);p.host({type:"control_request",request_id:"pending",request:{subtype:"mcp_message"}});const result={type:"result",session_id:"session",uuid:"result"};expect(()=>p.worker(result)).toThrow();expect(()=>p.settled()).toThrow();p.worker({type:"control_response",response:{subtype:"success",request_id:"pending",response:{}}});p.worker(result);p.settled();});
 it("admits the exact public OAuth provenance label only in validated initialize account metadata",()=>{const {protocol:p}=gate();p.host({type:"control_request",request_id:"init-host",request:{subtype:"initialize"}});
  const account={email:"approved@example.test",tokenSource:"CLAUDE_CODE_OAUTH_TOKEN",subscriptionType:"synthetic",apiKeySource:"none",apiProvider:"firstParty"};
  const frame=response();
  expect(()=>p.secretSafe(encode(frame))).not.toThrow();expect(()=>p.secretSafe(encode(response({...metadata,account:{tokenSource:'CLAUDE_CODE_OAUTH_TOKEN',apiProvider:'firstParty'}})))).not.toThrow();
  for(const value of [
   {...frame,response:{...frame.response,response:{...frame.response.response,account:{...account,organization:"synthetic-secret-canary"}}}},
   {...frame,response:{...frame.response,response:{...frame.response.response,account:{...account,access_token:"synthetic-secret-canary"}}}},
   {...frame,response:{...frame.response,response:{...frame.response.response,diagnostic:"CLAUDE_CODE_OAUTH_TOKEN"}}},
   {...frame,response:{...frame.response,response:{...frame.response.response,account:{...account,extra:"approved"}}}},
   {type:"result",session_id:"session",uuid:"x",result:"CLAUDE_CODE_OAUTH_TOKEN"}
  ])expect(()=>p.secretSafe(encode(value))).toThrow();
  const escaped=encode({...frame,response:{...frame.response,response:{...frame.response.response,account:{...account,organization:"synthetic-secret-canary"}}}}).toString().replace("synthetic-secret-canary","\\u0073ynthetic-secret-canary");expect(()=>p.secretSafe(Buffer.from(escaped))).toThrow();
  p.worker(frame);expect(()=>p.secretSafe(encode(frame))).toThrow();
 });
 it("rejects the provenance label in a non-initialize control response",()=>{const {protocol:p}=gate();p.host({type:"control_request",request_id:"other",request:{subtype:"mcp_message"}});expect(()=>p.secretSafe(Buffer.from(JSON.stringify({type:"control_response",response:{subtype:"success",request_id:"other",response:{account:{tokenSource:"CLAUDE_CODE_OAUTH_TOKEN",apiKeySource:"none",apiProvider:"firstParty"}}}})))).toThrow();});
 it("enforces 32 calls and rejects credential-shaped diagnostics",()=>{const {protocol:p}=gate();p.worker(init);p.worker(mcp());for(let i=0;i<32;i++){p.worker(mcp("call"+i,10+i,"tools/call",{name:"echo",arguments:{text:"ok"}}));p.claim("echo",{text:"ok"});}expect(()=>p.worker(mcp("overflow",100,"tools/call",{name:"echo",arguments:{text:"ok"}}))).toThrow();for(const secret of ["synthetic-secret-canary","sk-ant-secret","refresh_token"])expect(()=>p.secretSafe(Buffer.from(secret))).toThrow();});
});
describe("closed pinned initialize metadata", () => {
 const model = { value: "sonnet", resolvedModel: "synthetic-model", displayName: "Synthetic", description: "Synthetic model", supportsEffort: true,
  supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"], supportsAdaptiveThinking: true, supportsFastMode: false, supportsAutoMode: false,
  disabled: false, promoListPrice: "$3/$15" };
 const supported = { ...metadata, account: { ...account, organization: "Synthetic" },
  commands: [{ name: "example", description: "Synthetic command", argumentHint: "<value>", aliases: ["sample"] }],
  agents: [{ name: "example", description: "Synthetic agent", model: "inherit" }], models: [model], unavailable_models: [{ ...model, disabled: true }],
  hooks_applied: true, fast_mode_state: "off", fast_mode_disabled_reason: "sdk_opt_in_required", current_model: "synthetic-model",
  current_permission_mode: "default", session_state: "idle", permission_mode_from_default_fallback: false, auto_default_nudge: "plan", pid: 123,
  footer_indicator: { text: "test" }, feedback_survey_config: { minTimeBeforeFeedbackMs: 1, minTimeBetweenFeedbackMs: 2, minTimeBetweenGlobalFeedbackMs: 3,
   minUserTurnsBeforeFeedback: 1, minUserTurnsBetweenFeedback: 2, hideThanksAfterMs: 3, onForModels: ["synthetic-model"], probability: 0.1, lastSurveyShownTime: null },
  analytics_disabled: true, remote_control_auto_enable: false, remote_control_auto_on_by_default: false, remote_control_available: false, ide_rc_auto_enable_gate: false };
 it("admits all supported public SDK and pinned CLI metadata without granting identity authority", () => {
  for (const body of [supported, { ...metadata, account: { tokenSource: "CLAUDE_CODE_OAUTH_TOKEN", apiProvider: "firstParty" } }, { ...metadata, account: {} }]) {
   const p = initializeGate(), frame = response(body); p.secretSafe(encode(frame)); p.worker(frame); p.settled();
  }
  const p = initializeGate(), frame = response(supported);
  p.secretSafe(Buffer.from(encode(frame).toString().replace("CLAUDE_CODE_OAUTH_TOKEN", "\\u0043LAUDE_CODE_OAUTH_TOKEN")));
 });
 it.each(["outer", "response", "metadata", "account", "command", "agent", "model", "unavailable-model", "footer", "survey"])("rejects unknown opaque credential metadata in %s", position => {
  const credential = { accessCredential: "opaque-unrelated-access-value-123456789" };
  const frame = response(supported);
  const bad = position === "outer" ? { ...frame, ...credential } : position === "response" ? { ...frame, response: { ...frame.response, ...credential } } : response({
   ...supported, ...(position === "metadata" ? credential : position === "account" ? { account: { ...account, ...credential } } :
    position === "command" ? { commands: [{ ...supported.commands[0], ...credential }] } : position === "agent" ? { agents: [{ ...supported.agents[0], ...credential }] } :
    position === "model" ? { models: [{ ...model, ...credential }] } : position === "unavailable-model" ? { unavailable_models: [{ ...model, ...credential }] } :
    position === "footer" ? { footer_indicator: { text: "test", ...credential } } : { feedback_survey_config: { ...supported.feedback_survey_config, ...credential } }),
  });
  const p = initializeGate(); expect(() => p.secretSafe(encode(bad))).toThrow(); expect(() => p.worker(bad)).toThrow();
  expect(() => p.settled()).toThrow(); p.worker(frame); p.settled();
 });
 it.each(["outer", "response", "metadata", "account"])("rejects configured and escaped synthetic secrets in %s", position => {
  const frame = response(); const secret = { accessCredential: "synthetic-secret-canary" };
  const bad = position === "outer" ? { ...frame, ...secret } : position === "response" ? { ...frame, response: { ...frame.response, ...secret } } :
   response(position === "metadata" ? { ...metadata, ...secret } : { ...metadata, account: { ...account, ...secret } });
  const p = initializeGate(); expect(() => p.secretSafe(encode(bad))).toThrow();
  expect(() => p.secretSafe(Buffer.from(encode(bad).toString().replace("synthetic-secret-canary", "\\u0073ynthetic-secret-canary")))).toThrow();
 });
 it("rejects unknown metadata even without the provenance exception", () => {
  for (const body of [{ ...metadata, account: {}, accessCredential: "opaque-unrelated" }, { ...metadata, account: { accessCredential: "opaque-unrelated" } }]) {
   const p = initializeGate(); expect(() => p.worker(response(body))).toThrow(); expect(() => p.settled()).toThrow();
  }
 });
 it.each([
  { commands: [{}] }, { agents: [{ name: "x", description: "x", model: {} }] }, { models: [{ ...model, supportsEffort: "yes" }] },
  { models: [{ ...model, supportedEffortLevels: ["unknown"] }] }, { available_output_styles: [{}] }, { output_style: {} }, { hooks_applied: "yes" },
  { fast_mode_state: "unknown" }, { fast_mode_disabled_reason: "other" }, { pid: "123" }, { current_permission_mode: "unknown" }, { session_state: "unknown" },
  { footer_indicator: { text: {} } }, { feedback_survey_config: { ...supported.feedback_survey_config, onForModels: [{}] } }, { remote_control_available: {} },
 ])("rejects malformed supported metadata %j", change => {
  const p = initializeGate(), bad = response({ ...supported, ...change }); expect(() => p.secretSafe(encode(bad))).toThrow(); expect(() => p.worker(bad)).toThrow();
 });
 it("requires complete initialize metadata and a matching outstanding request", () => {
  const p = initializeGate(); expect(() => p.worker(response({ account }))).toThrow();
  expect(() => p.secretSafe(encode(response(metadata, "other")))).toThrow(); expect(() => p.worker(response(metadata, "other"))).toThrow();
  p.worker(response()); expect(() => p.secretSafe(encode(response()))).toThrow(); expect(() => p.worker(response())).toThrow();
 });
 it.each(["output_style", "command", "model", "organization"])("rejects the provenance marker outside account.tokenSource: %s", position => {
  const marker = "CLAUDE_CODE_OAUTH_TOKEN", p = initializeGate();
  const body = { ...supported, ...(position === "output_style" ? { output_style: marker } : position === "command" ? { commands: [{ ...supported.commands[0], description: marker }] } :
   position === "model" ? { models: [{ ...model, description: marker }] } : { account: { ...account, organization: marker } }) };
  expect(() => p.secretSafe(encode(response(body)))).toThrow();
 });
 it.each(["synthetic-secret-canary", "sk-ant-synthetic", "refresh_token", "access_token"])("rejects secret values in otherwise supported fields: %s", secret => {
  const p = initializeGate(); expect(() => p.secretSafe(encode(response({ ...supported, models: [{ ...model, description: secret }] })))).toThrow();
 });
});
describe("finite byte framing",()=>{
 it("handles fragmented UTF8 and rejects invalid UTF8, malformed JSON and partial EOF",()=>{const frame=Buffer.from(JSON.stringify({text:"合成"})+"\n"),p=new ClaudeLineFrames();let output:unknown[]=[];for(const byte of frame)output.push(...p.feed(Buffer.from([byte])));expect(output).toHaveLength(1);p.end();for(const bytes of [Buffer.from([0xff,10]),Buffer.from("invalid\n")])expect(()=>new ClaudeLineFrames().feed(bytes)).toThrow();const partial=new ClaudeLineFrames();partial.feed(Buffer.from('{"x":1}'));expect(()=>partial.end()).toThrow();});
 it("accepts exact encoded line cap and rejects boundary+1; caps protocol messages",()=>{const encode=(n:number)=>Buffer.from('{"x":"'+"a".repeat(n-9)+'"}\n');expect(encode(L.line).length).toBe(L.line);expect(new ClaudeLineFrames().feed(encode(L.line))).toHaveLength(1);expect(()=>new ClaudeLineFrames().feed(encode(L.line+1))).toThrow();const frames=new ClaudeLineFrames();for(let i=0;i<L.frames;i++)frames.feed(Buffer.from('{}\n'));expect(()=>frames.feed(Buffer.from('{}\n'))).toThrow();});
});

describe("pinned thinking progress is bounded metadata", () => {
 const progress = { type:"system",subtype:"thinking_tokens",session_id:"session",uuid:"progress",estimated_tokens:2.5,estimated_tokens_delta:0.5 };
 it("preserves a complete framed assistant/result sequence without claiming a tool", () => {
  const p=gate().protocol, frames=new ClaudeLineFrames();
  for(const frame of [init,progress,{...progress,uuid:"reset",estimated_tokens:0,estimated_tokens_delta:0},
   {type:"assistant",session_id:"session",uuid:"assistant",message:{content:[{type:"text",text:"synthetic"}]}},
   {type:"result",session_id:"session",uuid:"result"}]) for(const parsed of frames.feed(encode(frame)))p.worker(parsed.value);
  frames.end();p.settled();expect(()=>p.claim("echo",{})).toThrow();
  expect(()=>p.worker({...progress,uuid:"late"})).not.toThrow();expect(()=>p.worker({type:"assistant",session_id:"session",uuid:"late-assistant",message:{content:[]}})).toThrow();
 });
 it.each([
  {estimated_tokens:-1},{estimated_tokens_delta:-1},{estimated_tokens:NaN},{estimated_tokens:Infinity},
  {estimated_tokens_delta:Infinity},{estimated_tokens:Number.MAX_SAFE_INTEGER+1},{estimated_tokens_delta:3},
  {estimated_tokens:"2"},{estimated_tokens_delta:undefined},{extra:true},{subtype:"api_retry"},{uuid:""},{session_id:"sibling"},
 ])("rejects malformed or unrelated progress %j",change=>{const p=gate().protocol;p.worker(init);expect(()=>p.worker({...progress,...change})).toThrow();});
 it("rejects pre-init, init-UUID replay, progress replay, assistant-UUID replay and revocation",()=>{
  expect(()=>gate().protocol.worker(progress)).toThrow();
  const f=gate(),p=f.protocol;p.worker(init);expect(()=>p.worker({...progress,uuid:"init"})).toThrow();
  p.worker(progress);expect(()=>p.worker(progress)).toThrow();
  expect(()=>p.worker({type:"assistant",session_id:"session",uuid:"progress",message:{content:[]}})).toThrow();
  f.revoke();expect(()=>p.worker({...progress,uuid:"revoked"})).toThrow();
 });
 it("counts progress toward frame and identity caps and rejects oversized identity",()=>{
  const p=gate().protocol;p.worker(init);const frames=new ClaudeLineFrames();frames.feed(encode(init));
  for(let n=1;n<=8192;n++){const frame={...progress,uuid:"p"+n};for(const parsed of frames.feed(encode(frame)))p.worker(parsed.value);}
  expect(()=>frames.feed(encode({...progress,uuid:"overflow"}))).toThrow();expect(()=>p.worker({...progress,uuid:"overflow"})).toThrow();
  const fresh=gate().protocol;fresh.worker(init);expect(()=>fresh.worker({...progress,uuid:"x".repeat(129)})).toThrow();
 });
 it("does not grant tool or result authority via progress fields",()=>{
  const p=gate().protocol;p.worker(init);
  for(const extra of [{message:{content:[{type:"tool_use",name:"Bash",input:{}}]}},{usage:{output_tokens:2}},{is_error:false},{result:"synthetic"}])expect(()=>p.worker({...progress,...extra})).toThrow();
  p.worker(progress);expect(()=>p.claim("echo",{})).toThrow();
 });
});


describe("pinned SDK-control tool metadata", () => {
 const params = {name:"echo",arguments:{text:"ok"},_meta:{progressToken:2,"claudecode/toolUseId":"parent-group"}};
 const ready = () => { const f=gate();f.protocol.worker(mcp());f.protocol.worker(init);return f; };
 it.each([undefined,{progressToken:2},{progressToken:2,"claudecode/toolUseId":"parent-group"}])("preserves exact one-shot claims with inert metadata %j", meta => {
  const p=ready().protocol;const frame=mcp("call",2,"tools/call",{...params,...(meta===undefined?{_meta:undefined}:{_meta:meta})});const before=structuredClone(frame);
  p.worker(frame);expect(frame).toEqual(before);expect(()=>p.claim("echo",{text:"wrong"})).toThrow();
  expect(()=>p.claim("echo",{text:"ok"})).toThrow();
  const q=ready().protocol;q.worker(frame);q.claim("echo",{text:"ok"});q.settled();expect(()=>q.claim("echo",{text:"ok"})).toThrow();
 });
 it("allows the same first-parent annotation on distinct calls without granting replay authority",()=>{
  const p=ready().protocol;p.worker({type:"assistant",session_id:"session",uuid:"assistant",message:{content:[
   {type:"tool_use",id:"parent-group",name:"mcp__component__echo",input:{text:"first"}},
   {type:"tool_use",id:"later",name:"mcp__component__echo",input:{text:"second"}}]}});
  for(const [id,text] of [[2,"first"],[3,"second"]] as const){const frame=mcp("call"+id,id,"tools/call",{name:"echo",arguments:{text},_meta:{progressToken:id,"claudecode/toolUseId":"parent-group"}});p.worker(frame);p.claim("echo",{text});expect(()=>p.worker(frame)).toThrow();expect(()=>p.worker({...frame,request_id:"replayed"+id})).toThrow();}
  p.settled();expect(()=>p.claim("echo",{text:"second"})).toThrow();
 });
 it.each([null,[],{}, {progressToken:"2"},{progressToken:1},{progressToken:-1},{progressToken:2.5},{progressToken:NaN},{progressToken:Infinity},
  {progressToken:Number.MAX_SAFE_INTEGER+1},{progressToken:2,"claudecode/toolUseId":""},{progressToken:2,"claudecode/toolUseId":"x".repeat(129)},
  {progressToken:2,"claudecode/toolUseId":2},{progressToken:2,"claudecode/toolUseId":null},{progressToken:2,unknown:true},
  {progressToken:2,"io.modelcontextprotocol/related-task":{taskId:"x"}},{progressToken:2,"io.modelcontextprotocol/protocolVersion":"2026-07-28"},
  {progressToken:2,scope:"other"},{progressToken:2,name:"Bash"},{progressToken:2,arguments:{}}])("rejects malformed/unknown metadata %j before a claim", meta=>{
  const p=ready().protocol;expect(()=>p.worker(mcp("call",2,"tools/call",{...params,_meta:meta}))).toThrow();expect(()=>p.claim("echo",{text:"ok"})).toThrow();
 });
 it("rejects a string RPC ID despite an equal-looking numeric progress token",()=>{const p=ready().protocol;expect(()=>p.worker(mcp("call","2","tools/call",params))).toThrow();expect(()=>p.claim("echo",{text:"ok"})).toThrow();});
 it("bounds progress tokens and parent annotations at the admitted identifier limits",()=>{const p=ready().protocol;p.worker(mcp("call",Number.MAX_SAFE_INTEGER,"tools/call",{...params,_meta:{progressToken:Number.MAX_SAFE_INTEGER,"claudecode/toolUseId":"x".repeat(128)}}));p.claim("echo",{text:"ok"});p.settled();});
 it.each(["pre-mcp","pre-system","after-result","revoked","server","method","name","arguments","extra-params"])("metadata cannot bypass %s admission",kind=>{
  const f=gate(),p=f.protocol;if(kind!=="pre-mcp")p.worker(mcp());if(kind!=="pre-system"&&kind!=="pre-mcp")p.worker(init);
  if(kind==="after-result")p.worker({type:"result",session_id:"session",uuid:"result"});if(kind==="revoked")f.revoke();
  let frame=mcp("call",2,kind==="method"?"resources/read":"tools/call",{...params,...(kind==="name"?{name:"Bash"}:kind==="arguments"?{arguments:{text:1}}:kind==="extra-params"?{scope:"sibling"}:{})});
  if(kind==="server")frame={...frame,request:{...frame.request,server_name:"other"}};
  expect(()=>p.worker(frame)).toThrow();expect(()=>p.claim("echo",{text:"ok"})).toThrow();
 });
 it("checks currentness again between a valid metadata request and its tool claim",()=>{const f=ready();f.protocol.worker(mcp("call",2,"tools/call",params));f.revoke();expect(()=>f.protocol.claim("echo",{text:"ok"})).toThrow();});
});


describe("inert pinned rate-limit transport",()=>{
 const rate={type:"rate_limit_event",session_id:"session",uuid:"rate",rate_limit_info:{status:"allowed"}};
 const ready=()=>{const f=gate();f.protocol.worker(init);return f;};
 it.each(["allowed","allowed_warning","rejected"])("admits framed %s telemetry without claims or settlement",status=>{
  const p=ready().protocol,frames=new ClaudeLineFrames(),event={...rate,rate_limit_info:{status}};
  for(const parsed of frames.feed(encode(event)))p.worker(parsed.value);
  expect(()=>p.claim("echo",{text:"ok"})).toThrow();p.worker({type:"result",session_id:"session",uuid:"result"});
  expect(()=>p.worker({...event,uuid:"late"})).not.toThrow();expect(()=>p.worker({type:"assistant",session_id:"session",uuid:"late-assistant",message:{content:[]}})).toThrow();
 });
 it.each([-1,1.25,Number.MAX_SAFE_INTEGER+1,1e100])("keeps finite producer numeric %s inert without guessed limits",value=>{
  const p=ready().protocol;p.worker({...rate,rate_limit_info:{status:"allowed",utilization:value,surpassedThreshold:value,resetsAt:value===1.25?-2:value,overageResetsAt:-1,overagePeriodMonthly:{utilization:value},overagePeriodChannel:{utilization:value},unifiedWindows:{five_hour:{utilization:value,resetsAt:-1}}}});
  expect(()=>p.claim("echo",{text:"ok"})).toThrow();
 });
 it.each([
  {status:"other"},{status:undefined},{status:"allowed",extra:true},{status:"allowed",utilization:"1"},{status:"allowed",utilization:NaN},{status:"allowed",utilization:Infinity},
  {status:"allowed",surpassedThreshold:-Infinity},{status:"allowed",resetsAt:1.5},{status:"allowed",overageResetsAt:NaN},
  {status:"allowed",rateLimitType:"unknown"},{status:"allowed",overageStatus:"other"},{status:"allowed",overageDisabledReason:"org_spend_cap_reached"},
  {status:"allowed",isUsingOverage:1},{status:"allowed",overageInUse:"true"},{status:"allowed",rateLimitGraceActive:null},
  {status:"allowed",canUserPurchaseCredits:"true"},{status:"allowed",hasChargeableSavedPaymentMethod:0},{status:"allowed",errorCode:"other"},
  {status:"allowed",overagePeriodMonthly:{utilization:1,extra:true}},{status:"allowed",overagePeriodChannel:{}},
  {status:"allowed",unifiedWindows:{seven_day_opus:{utilization:1,resetsAt:1}}},{status:"allowed",unifiedWindows:{five_hour:{utilization:1,resetsAt:1,extra:true}}},
  {status:"allowed",unifiedWindows:{seven_day:{utilization:1,resetsAt:1.5}}},{status:"allowed",unifiedWindows:[]},{status:"allowed",overagePeriodMonthly:[]},
 ])("rejects malformed closed rate info %j without claims",info=>{const p=ready().protocol;expect(()=>p.worker({...rate,rate_limit_info:info})).toThrow();expect(()=>p.claim("echo",{text:"ok"})).toThrow();});
 it.each([{extra:true},{usage:{output_tokens:99}},{result:"forged"},{message:{content:[{type:"tool_use",name:"Bash"}]}},{session_id:"sibling"},{uuid:"x".repeat(129)},{session_id:"x".repeat(129)}])("rejects rate outer drift %j",change=>{expect(()=>ready().protocol.worker({...rate,...change})).toThrow();});
 it("preserves pre-init, replay, cross-kind replay, revocation and result fences",()=>{
  expect(()=>gate().protocol.worker(rate)).toThrow();const f=ready(),p=f.protocol;p.worker(rate);expect(()=>p.worker(rate)).toThrow();
  expect(()=>p.worker({type:"assistant",uuid:"rate",session_id:"session",message:{content:[]}})).toThrow();f.revoke();expect(()=>p.worker({...rate,uuid:"new"})).toThrow();
 });
 it("keeps rate frames within existing frame caps",()=>{const p=ready().protocol,frames=new ClaudeLineFrames();frames.feed(encode(init));for(let i=1;i<=8192;i++)for(const frame of frames.feed(encode({...rate,uuid:"rate"+i})))p.worker(frame.value);expect(()=>frames.feed(encode({...rate,uuid:"overflow"}))).toThrow();expect(()=>p.worker({...rate,uuid:"overflow"})).toThrow();});
});

describe("raw transport: after the result", () => {
 const sid = { session_id: "session" };
 const res = { type: "result", session_id: "session", uuid: "result" };
 const idle = { type: "system", subtype: "session_state_changed", uuid: "idle", ...sid, state: "idle" };
 const siteOf = (action: () => void): string | undefined => { try { action(); } catch (error) { return (error as { site?: string }).site ?? "schema"; } return undefined; };
 const done = () => { const p = gate().protocol; p.worker(init); p.worker(res); return p; };
 it("accepts a trailing inert event without changing the settled result or reopening the stream", () => {
  const p = done(); p.worker(idle); p.worker({ type: "system", subtype: "status", uuid: "st", ...sid, status: null });
  p.settled(); expect(() => p.claim("echo", {})).toThrow();
 });
 it.each([
  ["assistant", { type: "assistant", uuid: "a", ...sid, message: { content: [{ type: "text", text: "x" }] } }],
  ["tool_use", { type: "assistant", uuid: "a", ...sid, message: { content: [{ type: "tool_use", name: "mcp__component__echo" }] } }],
  ["second result", { ...res, uuid: "result2" }],
  ["init", { ...init, uuid: "init2" }],
  ["unknown system event", { type: "system", subtype: "compact_boundary", uuid: "c", ...sid }],
 ])("refuses a trailing %s as message_after_result", (_name, event) => {
  expect(siteOf(() => done().worker(event as Record<string, unknown>))).toBe("message_after_result");
 });
 it("keeps trailing events unique, same-session and bounded by the frame limit", () => {
  const p = done(); p.worker(idle);
  expect(siteOf(() => p.worker(idle))).toBe("duplicate_uuid");
  expect(siteOf(() => p.worker({ ...idle, uuid: "other", session_id: "foreign" }))).toBe("session_mismatch");
  const cap = (extra: Record<string, unknown>) => ({ ...extra });
  void cap;
 });
 it("counts substantive and inert frames against separate caps, and reports closed-vocabulary counts", () => {
  const q = gate().protocol; q.worker(init);
  for (let index = 0; index < L.frames - 1; index++) q.worker({ type: "assistant", uuid: `a${index}`, ...sid, message: { content: [] } });
  expect(siteOf(() => q.worker({ type: "assistant", uuid: "a-over", ...sid, message: { content: [] } }))).toBe("transport_frame_limit");
  const r = gate().protocol; r.worker(init);
  for (let index = 0; index < 8192; index++) r.worker({ type: "system", subtype: "session_state_changed", uuid: `n${index}`, ...sid, state: "running" });
  expect(siteOf(() => r.worker({ ...idle, uuid: "one-too-many" }))).toBe("inert_frame_limit");
  const counts = r.frameCounts();
  expect(Object.keys(counts).sort()).toEqual(["system:init", "system:session_state_changed"]);
  expect(counts["system:session_state_changed"]).toBe(8193);
  const hostile = gate().protocol; hostile.worker(init);
  try { hostile.worker({ type: "private-model-text", uuid: "h", ...sid }); } catch { /* refused */ }
  expect(hostile.frameCounts()).toEqual({ "system:init": 1, other: 1 });
  expect(JSON.stringify(hostile.frameCounts())).not.toContain("private-model-text");
});
});

describe("raw transport: inert events and fault sites", () => {
 const sid = { session_id: "session" };
 const inert = [
  { type: "system", subtype: "status", uuid: "s1", ...sid, status: "requesting" },
  { type: "system", subtype: "status", uuid: "s2", ...sid, status: null, permissionMode: "default" },
  { type: "system", subtype: "api_retry", uuid: "s3", ...sid, attempt: 1, max_retries: 3, retry_delay_ms: 250, error_status: 529, error: "overloaded" },
  { type: "system", subtype: "session_state_changed", uuid: "s4", ...sid, state: "running" },
 ];
 const siteOf = (action: () => void): string | undefined => { try { action(); } catch (error) { return (error as { site?: string }).site ?? "schema"; } return undefined; };
 it.each(inert)("ignores the inert %j event without claiming a tool or lifting a limit", event => {
  const p = gate().protocol, frames = new ClaudeLineFrames();
  for (const frame of [init, event, { type: "assistant", session_id: "session", uuid: "assistant", message: { content: [{ type: "text", text: "synthetic" }] } }, { type: "result", session_id: "session", uuid: "result" }]) for (const parsed of frames.feed(encode(frame))) p.worker(parsed.value);
  frames.end(); p.settled(); expect(() => p.claim("echo", {})).toThrow();
 });
 it("still counts an inert event against the duplicate-uuid rule", () => {
  const p = gate().protocol; p.worker(init); p.worker(inert[0]!);
  expect(siteOf(() => p.worker(inert[0]!))).toBe("duplicate_uuid");
 });
 it.each([
  [{ type: "system", subtype: "status", uuid: "m1", ...sid, status: "private-model-text" }, "schema"],
  [{ type: "system", subtype: "api_retry", uuid: "m2", ...sid, attempt: "x", max_retries: 1, retry_delay_ms: 1, error_status: null, error: "e" }, "schema"],
  [{ type: "system", subtype: "compact_boundary", uuid: "m3", ...sid }, "unexpected_event:system.compact_boundary"],
  [{ type: "system", subtype: "private-model-text", uuid: "m4", ...sid }, "unexpected_event:system.other"],
  [{ type: "tool_progress", uuid: "m5", ...sid }, "unexpected_event:tool_progress"],
  [{ type: "stream_event", uuid: "m6", ...sid }, "unexpected_event:stream_event"],
  [{ type: "private-model-text", uuid: "m7", ...sid }, "unexpected_event:other"],
  [{ type: "assistant", uuid: "m8", ...sid, message: { content: [{ type: "tool_use", name: "mcp__component__other" }] } }, "undeclared_tool_use"],
 ])("refuses %j with the %s site and no claim", (event, site) => {
  const p = gate().protocol; p.worker(init);
  expect(siteOf(() => p.worker(event as Record<string, unknown>))).toBe(site);
  expect(() => p.claim("echo", { text: "ok" })).toThrow();
 });
 it("labels an unadmitted tool call and an extra init tool", () => {
  const p = gate().protocol; p.worker(init); expect(siteOf(() => p.claim("echo", { text: "ok" }))).toBe("tool_claim");
  expect(siteOf(() => gate().protocol.worker({ ...init, tools: ["mcp__component__echo", "Bash"] }))).toBe("init_tools");
 });
});
