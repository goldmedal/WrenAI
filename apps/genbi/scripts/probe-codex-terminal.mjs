// Explicit offline probe: official CLI renderer + in-memory conversation only.
// No app-server, provider credential, network model request, or database is used.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, realpathSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { execFile as execCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
const packageUrl = process.env.GENBI_TERMINAL_PACKAGE_ROOT
  ? pathToFileURL(process.env.GENBI_TERMINAL_PACKAGE_ROOT.replace(/\/$/, '') + '/') : new URL('../', import.meta.url);
const { InteractiveTerminalManager } = await import(new URL('dist-server/server/interactive-terminal.js', packageUrl));
const { ensureDarwinNodePtySpawnHelper, createProbedPtyFactory } = await import(new URL('dist-server/server/node-pty-host.js', packageUrl));
const { attestNativeExecutable } = await import(new URL('dist-server/server/native-runtime-spec.js', packageUrl));
const { startCodexTerminal } = await import(new URL('dist-server/server/runtime-host/codex-terminal.js', packageUrl));
const require = createRequire(new URL('package.json', packageUrl));
const binary = process.argv[2];
if (!binary) throw new Error('Pass the exact Codex executable path. This probe never calls a model.');
ensureDarwinNodePtySpawnHelper(require.resolve('node-pty'));
const pty = await createProbedPtyFactory(require('node-pty'));
const cwd = realpathSync(mkdtempSync('/private/tmp/genbi-terminal-fixture-'));
const threadId = randomUUID(), capability = randomUUID();
let listener, turn, complete, sequence = 0, calls = 0, steers = 0, interruptions = 0;
const event = (method, params) => listener({ type:'event', sequence: ++sequence, event:{ method, params } });
const conversation = { capability, terminalThreadId:()=>threadId, snapshot:()=>({sequence}), attach:(_cap,receive)=> {
  listener=receive;
  return { detach(){}, submit(text){
    calls++; const turnId=randomUUID(); turn={id:turnId,status:'inProgress',items:[]};
    const result=new Promise(resolve=>{complete=()=>resolve({turnId,status:turn.status});});
    queueMicrotask(()=>{
      event('turn/started',{threadId,turn});
      if(text==='wait')return;
      const item={type:'agentMessage',id:randomUUID(),text:`OFFLINE_REPLY_${calls}`};
      event('item/started',{threadId,turnId,item:{...item,text:''}});
      event('item/agentMessage/delta',{threadId,turnId,itemId:item.id,delta:item.text});
      event('item/completed',{threadId,turnId,item});
      turn={...turn,status:'completed',items:[item]};event('turn/completed',{threadId,turn});complete();
    });return result;
  },async steer(text, expectedTurnId){assert.equal(expectedTurnId,turn.id);assert.equal(text,"early followup");steers++;const item={type:'userMessage',id:randomUUID(),content:[{type:'text',text}]};
    event('item/started',{threadId,turnId:turn.id,item});event('item/completed',{threadId,turnId:turn.id,item});return {turnId:turn.id};},async interrupt(){interruptions++;turn={...turn,status:'interrupted'};event('turn/completed',{threadId,turn});complete();} };
}};
let renderer, output='', launchSpec;
const until=async(predicate,label)=>{for(let i=0;i<100;i++){if(predicate())return;await delay(100);}throw new Error(label);};
const text=()=>output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'');
try {
 const manager=new InteractiveTerminalManager(pty);
 renderer=await startCodexTerminal({id:randomUUID(),conversation,manager:{start(...args){launchSpec=args[0];const terminal=manager.start(...args);terminal.onData(s=>{output+=s;});return terminal;}},vendor:attestNativeExecutable('vendor',binary),cwd,model:'gpt-5.5',assertActive(){}});
 const terminal=renderer.terminal;
 assert(terminal.claim(capability));
 let unlisten=terminal.onData(s=>{output+=s;});
 await until(()=>text().includes('OpenAI Codex'),'official CLI banner');
 terminal.resize(120,40);
 const ask=async(q,n)=>{terminal.write(q);await delay(300);terminal.write('\r');await until(()=>text().includes(`OFFLINE_REPLY_${n}`),'rendered fixture reply');};
 await ask('first',1);
 terminal.detach();unlisten();assert(terminal.claim(capability));
 let replay='';unlisten=terminal.onData(s=>{replay+=s;output+=s;});assert(replay.includes('OFFLINE_REPLY_1'));
 await ask('follow up',2);
 terminal.write('wait');await delay(300);terminal.write('\r');await until(()=>calls===3,'third fixture turn');terminal.write('early followup');await delay(300);terminal.write('\r');await until(()=>steers===1,'in-flight text steer');terminal.write('\x1b');
 await until(()=>interruptions===1 && text().includes('OFFLINE_REPLY_4'),'interrupted and sent queued steer');
 terminal.write('wait');await delay(300);terminal.write('\r');await until(()=>calls===5,'standalone cancellation turn');terminal.write('\x1b');
 await until(()=>interruptions===2 && turn.status==='interrupted','cancelled fixture turn');
 const sentinelRoot=realpathSync(mkdtempSync('/private/tmp/genbi-terminal-deny-'));
 const sentinel=sentinelRoot+'/sentinel';writeFileSync(sentinel,'private-fixture');
 const sandboxArgs=launchSpec.argv.slice(0,launchSpec.argv.indexOf('--')+1);
 const exec=promisify(execCallback);
 const childEnv={HOME:launchSpec.cwd+'/home',CODEX_HOME:launchSpec.cwd+'/home',PATH:'/usr/bin:/bin'};
 const sandbox=(args)=>exec(binary,[...sandboxArgs,...args],{cwd:launchSpec.cwd,env:childEnv,timeout:5000});
 let networkRequests=0;
 const http=createServer((_req,res)=>{networkRequests++;res.end('unexpected');});
 await new Promise(resolve=>http.listen(0,'127.0.0.1',resolve));
 try {
   await assert.rejects(sandbox(['/bin/cat',sentinel]));
   await assert.rejects(sandbox(['/bin/sh','-c','printf changed > "$1"','probe',sentinel]));
   assert.equal(readFileSync(sentinel,'utf8'),'private-fixture');
   await sandbox(['/bin/sh','-c','printf allowed > "$1"','probe',launchSpec.cwd+'/allowed']);
   assert.equal(readFileSync(launchSpec.cwd+'/allowed','utf8'),'allowed');
   await assert.rejects(sandbox(['/usr/bin/curl','--noproxy','*','--max-time','2',`http://127.0.0.1:${http.address().port}`]));
   assert.equal(networkRequests,0);
 } finally {await new Promise(resolve=>http.close(resolve));rmSync(sentinelRoot,{recursive:true});}
 unlisten();await renderer.close();renderer=undefined;
 console.log(JSON.stringify({officialCli:true,modelCalls:0,fixtureTurns:calls,steer:steers===1,resize:true,reconnect:true,cancel:true,protectedReadDenied:true,outsideWriteDenied:true,networkDenied:true,cleanup:true}));
} catch(error) {console.error(text().slice(-3000));throw error;} finally {await renderer?.close();rmSync(cwd,{recursive:true});}
