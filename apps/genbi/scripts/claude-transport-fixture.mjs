/** Compiled and packed acceptance. Synthetic identity/peer only, no accounts/models. */
export async function installedClaudeTransportFixture(packageRoot) {
  const assert = (await import('node:assert/strict')).default;
  const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
  const { pathToFileURL } = await import('node:url');
  const module = name => import(pathToFileURL(path.join(packageRoot, 'dist-server/server', name + '.js')).href);
  const { ClaudeAccountVault } = await module('runtime-host/claude-account-vault');
  const { attestOpenShellSdk } = await module('runtime-host/openshell-sdk-assets');
  const { claimClaudeHostRuntime, deriveClaudeNativeRuntime } = await module('runtime-host/openshell-claude-provider');
  const { observeClaudeHostNoModel } = await module('runtime-host/claude-identity-verifier');
  const { runClaudeComponentStep } = await module('runtime-host/claude-component-step');
  const { createOpenShellRuntimeCompositionForTesting } = await module('openshell-runtime-composition');
  const { Store } = await module('db');
  const sdkRoot = attestOpenShellSdk(); assert.ok(sdkRoot.startsWith(packageRoot));
  const require = (await import('node:module')).createRequire(path.join(packageRoot, 'package.json'));
  const direct = require.resolve('@anthropic-ai/claude-agent-sdk'); assert.ok(direct.includes('claude-agent-sdk'));
  const expected = { accountUuid:'11111111-1111-4111-8111-111111111111', organizationUuid:'22222222-2222-4222-8222-222222222222', email:'approved@example.test', subscription:'pro' };
  const directQuery = (await import((await import('node:url')).pathToFileURL(direct).href)).query;
  const account = { tokenSource: 'CLAUDE_CODE_OAUTH_TOKEN', apiProvider: 'firstParty' };
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'claude-installed-')));
  const vault = ClaudeAccountVault.forTesting({ root:path.join(root,'vault'), transport:async(url,init)=>new Response(JSON.stringify(url.endsWith('/token') ? {access_token:access,refresh_token:'synthetic-host-refresh-canary-1234',expires_in:3600,scope:'user:profile user:inference',token_type:'Bearer'} : {account:{uuid:expected.accountUuid,email:expected.email},organization:{uuid:expected.organizationUuid,organization_type:'claude_pro'}})) });
  const access = 'synthetic-private-access-canary-1234';
  vault.enroll({accessToken:access,refreshToken:'synthetic-host-refresh-canary-1234',expiresAt:Date.now()+3600000}); await vault.verify(expected);
  const status = vault.status(); const digest='sha256:'+'a'.repeat(64);
  const driverIdentity = { image:digest,policy:digest,gateway:'synthetic',workspace:'default',configuration:digest };
  const resources = new Map(); let mode='normal', creations=0, calls=0, launches=0, bootstraps=0, unansweredHost=0, notificationServer;
  const peer = () => {
    const queue=[];let wake;let closed=false;let phase=0;let buffer=Buffer.alloc(0);let boot=true;
    const send = value=>{queue.push({stream:'stdout',data:Buffer.from(JSON.stringify(value)+'\n')});wake?.();wake=undefined;};
    const request = (request_id,id,method,params)=>({type:'control_request',request_id,request:{subtype:'mcp_message',server_name:'component',message:{jsonrpc:'2.0',id,method,params}}});
    const result = ()=>send({type:'result',subtype:'success',session_id:'synthetic-session',uuid:'result',is_error:false,result:'synthetic answer',permission_denials:[],modelUsage:{'synthetic-model':{webSearchRequests:0,inputTokens:0,outputTokens:0,cacheReadInputTokens:0,cacheCreationInputTokens:0}},usage:{input_tokens:0,output_tokens:0}});
    const response = request_id=>send({type:'control_response',response:{subtype:'success',request_id,response:{account:mode==='secret-account'?{...account,organization:access}:mode==='missing-account'?{apiProvider:'firstParty'}:account,models:[],commands:[],agents:[],output_style:'default',available_output_styles:['default'],...(mode==='credential-metadata'?{accessCredential:'opaque-unrelated-access-value-123456789'}:{})}}});
    const stream = { output:(async function*(){while(!closed){if(!queue.length)await new Promise(resolve=>wake=resolve);while(queue.length)yield queue.shift();}})(),done:new Promise(()=>{}),close(){closed=true;wake?.();},write(data){
      buffer=Buffer.concat([buffer,data]);
      if(boot){if(buffer.length<4)return;const n=buffer.readUInt32BE();if(buffer.length<n+4)return;const b=JSON.parse(buffer.subarray(4,n+4));assert.equal(b.access,access);assert.notEqual(b.generation,status.generation);assert.match(b.generation,/^[a-f0-9-]{36}$/);assert.equal(b.argv.includes(access),false);assert.ok(!Object.hasOwn(b,'refreshToken'));bootstraps++;buffer=buffer.subarray(n+4);boot=false;}
      while(buffer.includes(10)){
        const n=buffer.indexOf(10);const value=JSON.parse(buffer.subarray(0,n));buffer=buffer.subarray(n+1);
        if(value.type==='control_request'){if(mode==='unanswered-host'&&value.request.subtype==='mcp_message'){unansweredHost++;result();}else response(value.request_id);}
        else if(value.type==='user'){
          send({type:'system',subtype:'init',session_id:'synthetic-session',uuid:'init',claude_code_version:'2.1.259',cwd:'/sandbox',model:'synthetic-model',apiKeySource:'none',tools:mode==='no-tool'||mode==='no-tool-pass'?[]:['mcp__component__echo'],mcp_servers:[{name:'component',status:'connected'}],skills:[],plugins:[],slash_commands:[],permissionMode:'default'});
          send(request('init',1,'initialize',{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'synthetic',version:'1'}}));
        }else if(value.type==='control_response'){
          if(phase++===0){if(mode==='no-tool-pass'){result();continue;}if(mode==='unanswered-host'){void notificationServer.sendToolListChanged();continue;}const call=request('call',2,'tools/call',{name:mode==='Bash'?'Bash':'echo',arguments:{text:'合成'}});send(call);if(mode==='replay')send(call);if(mode==='rpc-replay')send({...call,request_id:'other'});if(mode==='no-tool'){} }
          else send({type:'result',subtype:'success',session_id:'synthetic-session',uuid:'result',is_error:false,result:'synthetic answer',permission_denials:[],modelUsage:{'synthetic-model':{webSearchRequests:0,inputTokens:0,outputTokens:0,cacheReadInputTokens:0,cacheCreationInputTokens:0}},usage:{input_tokens:0,output_tokens:0}});
        }
      }
    }}; return stream;
  };
  const driver={version:'0.0.1',identity:driverIdentity,modelIdentity:driverIdentity,probe:async()=>{},create:async intent=>{creations++;const resource={id:intent.id,name:intent.name,workspace:'default',labels:{'genbi-lifecycle-owner':intent.owner}};resources.set(intent.name,resource);return resource;},list:async intent=>[...resources.values()].filter(r=>r.name===intent.name),inspect:async intent=>resources.get(intent.name),remove:async intent=>{resources.delete(intent.name)},assertAbsent:async intent=>{assert.equal(resources.has(intent.name),false)},exec:async()=>{throw Error('buffered exec forbidden')},duplex:async()=>{launches++;return peer()}};
  const configFile=path.join(root,'config.json');fs.writeFileSync(configFile,JSON.stringify({executable:'/synthetic/openshell',executableDigest:digest,version:'0.0.1',gateway:'synthetic',workspace:'default',image:digest,supervisorImage:digest,policy:'/synthetic/policy',policyDigest:digest,home:root,configHome:root,stateHome:root,dockerExecutable:'/synthetic/docker',dockerRealpath:'/synthetic/docker',dockerDigest:digest,dockerSocket:'/synthetic/socket',dockerNamespace:'synthetic',exclusive:true}));
  const store = new Store(':memory:');let composition;
  try {
    composition=await createOpenShellRuntimeCompositionForTesting({env:{GENBI_CLAUDE_RUNTIME:'openshell',GENBI_OPENSHELL_CONFIG:configFile},store,stateRoot:path.join(root,'lifecycle'),driver,claude:{vault,sdkQueryForTesting:args=>{notificationServer=args.options.mcpServers?.component?.instance;return directQuery(args);},duplex:async()=>{throw Error('driver seam only')}}});
    const scope={backend:'openshell',account:status.fingerprint,generation:status.generation,session:'first-session',turn:'turn',binding:'binding',bindingGeneration:'1',bindingRevision:digest,context:digest,plan:digest,...driverIdentity};
    const run={tier:'cheap',request:'synthetic',input:{},consumes:{},children:[],prompt:'only this step',signal:new AbortController().signal,tools:{echo:async input=>{calls++;assert.deepEqual(input,{text:'合成'});return {echo:'合成'}}},toolDescriptions:{},toolSchemas:{echo:{type:'object',properties:{text:{type:'string'}},required:['text'],additionalProperties:false}}};
    const observation=composition.claudeProvider({scope,currentScope:()=>scope,models:{cheap:'synthetic-model'},assertCurrent(){}});
    await observeClaudeHostNoModel(await observation.open('synthetic-model',run.signal),'cheap',run.signal);
    assert.equal(calls,0);console.log('installed-claude-host-no-model-observation-ok');
    for(const session of ['first-session','second-session']){
      const captured={...scope,session};const provider=composition.claudeProvider({scope:captured,currentScope:()=>captured,models:{cheap:'synthetic-model'},assertCurrent(){}});assert.equal(provider.accountEmail,expected.email);
      const original=await provider.open('synthetic-model',run.signal);const runtime=session==='second-session'?deriveClaudeNativeRuntime(original,()=>provider.assertCurrent(),()=>original.close()):original;

      assert.equal(JSON.stringify(runtime.environment).includes(access),false);
      assert.throws(()=>claimClaudeHostRuntime({...runtime},run));
      assert.throws(()=>claimClaudeHostRuntime(JSON.parse(JSON.stringify(runtime)),run));
      assert.throws(()=>claimClaudeHostRuntime(runtime,{...run,tier:'other'}));
      assert.equal(Reflect.set(runtime,'model','wrong-model'),false);
      assert.deepEqual(await runClaudeComponentStep(runtime,run),{value:'synthetic answer',usage:{inputTokens:0,outputTokens:0}});
    }
    assert.equal(calls,2);assert.equal(bootstraps,3);console.log('installed-claude-private-runtime-lineage-ok');
    for(const hostile of ['replay','rpc-replay','Bash','no-tool','unanswered-host','secret-account','missing-account','credential-metadata']){
      mode=hostile;const provider=composition.claudeProvider({scope,currentScope:()=>scope,models:{cheap:'synthetic-model'},assertCurrent(){}});const runtime=await provider.open('synthetic-model',run.signal);
      // A real SDK server notification creates the unanswered host control request.

      const callsBefore=calls;
      await assert.rejects(runClaudeComponentStep(runtime,hostile==='no-tool'?{...run,tools:{},toolSchemas:{}}:run));
      assert.equal(resources.size,0);if(hostile==='secret-account'||hostile==='missing-account'||hostile==='credential-metadata')assert.equal(calls,callsBefore);if(hostile==='unanswered-host'){assert.equal(unansweredHost,1);assert.equal(calls,callsBefore);console.log('installed-claude-unanswered-host-rejected-before-handler');}
    }
    mode='no-tool-pass';
    const noToolProvider=composition.claudeProvider({scope,currentScope:()=>scope,models:{cheap:'synthetic-model'},assertCurrent(){}});
    assert.deepEqual(await runClaudeComponentStep(await noToolProvider.open('synthetic-model',run.signal),{...run,tools:{},toolSchemas:{}}),{value:'synthetic answer',usage:{inputTokens:0,outputTokens:0}});
    mode='normal';
    let releaseHandler,enteredHandler;
    const entered=new Promise(resolve=>enteredHandler=resolve);
    const blockedRun={...run,tools:{echo:async()=>{enteredHandler();return new Promise(resolve=>releaseHandler=resolve);}}};
    const rotatingProvider=composition.claudeProvider({scope,currentScope:()=>scope,models:{cheap:'synthetic-model'},assertCurrent(){}});
    const rotatingRuntime=await rotatingProvider.open('synthetic-model',run.signal);
    const blocked=runClaudeComponentStep(rotatingRuntime,blockedRun);const denied=assert.rejects(blocked);await entered;
    const rotation=vault.verify(expected);assert.equal(rotatingRuntime.signal.aborted,true);await denied;releaseHandler({late:true});await rotation;
    assert.equal(vault.status().generation,status.generation);assert.equal(resources.size,0);console.log('installed-claude-rotation-denied-pending-result');
    assert.equal(creations,13);assert.equal(launches,13);assert.ok(store.listOpenShellIntents().every(row=>row.phase==='cleaned'&&row.identity.purpose==='model'&&row.identity.snapshot==='none'));
    const steps=store.listOpenShellIntents().map(row=>row.identity.step);assert.equal(new Set(steps).size,13);
    assert.equal(JSON.stringify(store.listOpenShellIntents()).includes(access),false);
    const asset=path.join(sdkRoot,'dist/errors.js'),original=fs.readFileSync(asset);try{fs.appendFileSync(asset,'\n// tamper');assert.throws(()=>attestOpenShellSdk());}finally{fs.writeFileSync(asset,original)}
    // Fault the actual private vault file while host operations and a worker are admitted.
    const lifecycleIdentity={...scope,purpose:'lifecycle',operation:'worker',snapshot:'none'};
    const lifecycle=composition.lifecycle;
    const effect=lifecycle.claimEffect(await lifecycle.prepareLaunch(lifecycleIdentity,()=>lifecycleIdentity));
    const stalePermit=await lifecycle.prepareLaunch(lifecycleIdentity,()=>lifecycleIdentity);
    const owned=await lifecycle.launch(await lifecycle.prepareLaunch(lifecycleIdentity,()=>lifecycleIdentity));
    const accountLease=await vault.lease(status.fingerprint,status.generation);
    let workerSignal,finishWorker;const blockedWorker=owned.effect(async signal=>{workerSignal=signal;return new Promise(resolve=>finishWorker=resolve)});
    const workerRejected=assert.rejects(blockedWorker);
    const {StructuredRuntime}=await module('structured-runtime');const signals=[],releases=[];
    const structured=new StructuredRuntime({selected:{codex:'local',claude:'local'},allowLocal:true,onRevoke:()=>composition.revoke(),localSetupFor:()=>undefined,
      localRoute:async options=>{signals.push(options.signal);return new Promise(resolve=>releases.push(()=>resolve({backend:'codex-local',warnings:[],finalText:'late completion'})))} });
    const requests=[0,1].map(index=>structured.route({authChoice:{mode:'subscription',provider:'claude'},profileSource:'synthetic',userProject:'/synthetic',question:'blocked'},
      {sessionId:'blocked-'+index,turnId:'turn',assertCurrent(){}}));
    const cancelled=requests.map(pending=>assert.rejects(pending,error=>error.code==='cancelled'));
    assert.equal(signals.length,2);
    fs.chmodSync(path.join(root,'vault/account.json'),0o644);
    try{
      assert.throws(()=>structured.revoke(),/Claude account storage/);
      assert.equal(accountLease.signal.aborted,true);assert.equal(effect.signal.aborted,true);assert.equal(workerSignal.aborted,true);
      assert.ok(signals.every(signal=>signal.aborted));assert.throws(()=>lifecycle.assertLaunchPermit(stalePermit));
      const createsBefore=creations;await assert.rejects(lifecycle.launch(stalePermit));assert.equal(creations,createsBefore);
      assert.throws(()=>composition.claudeProvider({scope,currentScope:()=>scope,models:{cheap:'synthetic-model'},assertCurrent(){}}));
    }finally{fs.chmodSync(path.join(root,'vault/account.json'),0o600);for(const release of releases)release();finishWorker('late effect');}
    await Promise.all([...cancelled,workerRejected]);await owned.close();effect.release();accountLease.release();await structured.shutdown();
    assert.equal(resources.size,0);assert.ok(store.listOpenShellIntents().every(row=>row.phase==='cleaned'));
    console.log('installed-claude-storage-fault-fenced-all-operations');console.log('installed-claude-transport-ok');
  } finally { await composition?.shutdown();store.close();fs.rmSync(root,{recursive:true,force:true}); }
}
