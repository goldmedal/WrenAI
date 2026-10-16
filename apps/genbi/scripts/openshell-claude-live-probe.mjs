#!/usr/bin/env node
// Explicit host operator utility. Never imports ambient login or refreshes on startup.
import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const mod=name=>import(path.join(root,'dist-server/server',name+'.js'));
const authorized=process.argv.includes('--authorize-profile')&&process.argv.includes('--authorize-refresh');
const observeAuthorized=process.argv.includes('--authorize-worker-observation');
const modelsAuthorized=process.argv.includes('--authorize-two-session-models');
const file=process.argv.find(value=>value.startsWith('--operator-file='))?.slice('--operator-file='.length);
if(!authorized||!file||!path.isAbsolute(file))throw Error('Explicit --authorize-profile AND --authorize-refresh and absolute --operator-file required; obtain human authority first');
const secure = file => {
 if(!path.isAbsolute(file)||fs.realpathSync(file)!==file)throw Error('Operator path admission failed');const stat=fs.lstatSync(file);if(stat.isSymbolicLink()||!stat.isFile()||stat.uid!==process.getuid()||(stat.mode&0o777)!==0o600||stat.size>32768)throw Error('Operator file admission failed');
 const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);try{const opened=fs.fstatSync(fd);if(opened.ino!==stat.ino||opened.dev!==stat.dev||opened.size!==stat.size||(opened.mode&0o777)!==0o600)throw Error();return fs.readFileSync(fd);}finally{fs.closeSync(fd);}
};
let composition,store,client;
try{
 const operator=JSON.parse(secure(file));
 if(!operator.expected||!operator.models||!operator.openshellConfig||!operator.pki||!operator.credentialBundle||!operator.vaultRoot||!operator.stateRoot)throw Error('Operator configuration incomplete');
 const {Store}=await mod('db');const {OpenShellCliDriver}=await mod('runtime-host/openshell-driver');const {createOpenShellRuntimeComposition}=await mod('openshell-runtime-composition');const {resolveRuntimeSelection}=await mod('runtime-selection');const {connectOpenShellSdk}=await mod('runtime-host/openshell-sdk-assets');const {observeClaudeHostNoModel}=await mod('runtime-host/claude-identity-verifier');const {runClaudeComponentStep}=await mod('runtime-host/claude-component-step');
 const config=JSON.parse(secure(operator.openshellConfig));const bundle=JSON.parse(secure(operator.credentialBundle));
 client=await connectOpenShellSdk({gateway:operator.pki.gateway,caCert:secure(operator.pki.caCert),clientCert:secure(operator.pki.clientCert),clientKey:secure(operator.pki.clientKey)});
 const driver=new OpenShellCliDriver(config,undefined,(intent,argv,signal)=>client.sandbox.execInteractive(intent.name,[...argv],{workspace:config.workspace,workdir:'/sandbox',tty:false,noLoginShell:true,timeoutSecs:120,signal,environment:{HOME:'/sandbox',PATH:'/usr/local/bin:/usr/bin:/bin',LANG:'C.UTF-8'}}));
 let scope;const model=operator.models.cheap;if(typeof model!=='string')throw Error('Server selected cheap model required');
 fs.mkdirSync(operator.stateRoot,{recursive:true,mode:0o700});store=new Store(path.join(operator.stateRoot,'probe.sqlite'));composition=await createOpenShellRuntimeComposition({env:{GENBI_OPENSHELL_CONFIG:operator.openshellConfig},selection:resolveRuntimeSelection({GENBI_RUNTIME:'openshell',GENBI_BACKEND:'claude'}),store,stateRoot:operator.stateRoot,driver,claude:{vaultRoot:operator.vaultRoot,duplex:async()=>{throw Error('driver owns duplex')}}});
 const vault=composition.claudeVault;
 const digest='sha256:'+crypto.createHash('sha256').update('operator identity verification').digest('hex');
 scope={backend:'openshell',account:digest,generation:crypto.randomUUID(),session:'operator-identity',turn:'identity',binding:'operator-probe',bindingGeneration:'1',bindingRevision:digest,context:digest,plan:digest,...driver.modelIdentity};
 if(!vault.retainedCredential())vault.enroll(bundle);await vault.verify(operator.expected);const status=vault.status();
 console.log(JSON.stringify({identityVerified:true,fingerprint:status.fingerprint,generation:status.generation,modelCalls:0}));
 if(observeAuthorized){
   const captured={...scope,account:status.fingerprint,generation:status.generation,session:crypto.randomUUID(),turn:crypto.randomUUID()};
   const provider=composition.claudeProvider({scope:captured,currentScope:()=>captured,models:operator.models,assertCurrent(){}});
   await observeClaudeHostNoModel(await provider.open(model,new AbortController().signal,'cheap'),'cheap',new AbortController().signal);
   console.log(JSON.stringify({workerObservation:true,modelCalls:0,cleanup:true}));
 }
 if(modelsAuthorized){
   for(let index=0;index<2;index++){
    const captured={...scope,account:status.fingerprint,generation:status.generation,session:crypto.randomUUID(),turn:crypto.randomUUID()};
    const provider=composition.claudeProvider({scope:captured,currentScope:()=>captured,models:operator.models,assertCurrent(){}});let calls=0;
    const run={tier:'cheap',request:'Call only the declared echo tool with text retained account smoke, then reply OK.',input:{},consumes:{},children:[],prompt:'Use exactly the declared echo tool once. Do not use any other tool.',signal:new AbortController().signal,
     tools:{echo:async input=>{calls++;return{text:input.text}}},toolDescriptions:{echo:'Echo a synthetic string for this approved smoke'},toolSchemas:{echo:{type:'object',properties:{text:{type:'string',maxLength:100}},required:['text'],additionalProperties:false}}};
    const runtime=await provider.open(model,run.signal,'cheap');await runClaudeComponentStep(runtime,run);if(calls!==1)throw Error('Declared tool smoke failed');
    console.log(JSON.stringify({session:index+1,retainedFingerprint:status.fingerprint,serverSelectedModel:model,declaredToolCalls:calls,cleanup:true}));
   }
 }
}catch{process.stderr.write('Authorized Claude probe failed; identity/runtime remains unavailable. Vendor refresh may have rotated; explicit credential re-enrollment can be necessary after profile/persistence failure. Do not restore cached authority.\n');process.exitCode=1;}
finally{try{await composition?.shutdown();}catch{process.stderr.write('Owned cleanup pending; reuse denied.\n');process.exitCode=1;}store?.close();client?.close?.();}
