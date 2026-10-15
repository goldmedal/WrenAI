import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
const receipt={type:"genbi.step",version:1,step:"11111111-1111-4111-8111-111111111111",pid:30,group:30,start:"100"};
const baseline={type:"genbi.session.baseline",version:1,processes:[{pid:5,start:"10"}]};
function fixture(mode="normal") {
  const procs=new Map<number,{parent:number;group:number;start:string;uid:number}>();
  procs.set(1,{parent:0,group:1,start:"1",uid:0});procs.set(5,{parent:1,group:5,start:mode==="recycled"?"200":"10",uid:1500});procs.set(400,{parent:1,group:400,start:"300",uid:1500});
  if(mode==="escaped")procs.set(50,{parent:1,group:50,start:"110",uid:1500});
  let directory=true;const stat=(uid=1500)=>({uid,mode:0o700,nlink:1,size:200,isDirectory:()=>true,isSymbolicLink:()=>false,isFile:()=>false});
  const fs={
    readdirSync:()=>[...procs.keys()].map(String),realpathSync:(file:string)=>file,
    readFileSync(file:string){if(file==="/proc/self/status")return "NoNewPrivs:\t1\n";if(file.endsWith("settled.json"))return JSON.stringify({...receipt,outcome:"normal"});const pid=Number(file.split("/")[2]);const v=procs.get(pid);if(!v)throw Object.assign(Error(),{code:"ENOENT"});const fields=Array(20).fill("0");fields[0]="S";fields[1]=v.parent;fields[2]=v.group;fields[19]=v.start;return `${pid} (node) ${fields.join(" ")}`;},
    statSync(file:string){const v=procs.get(Number(file.split("/")[2]));if(!v)throw Object.assign(Error(),{code:"ENOENT"});return stat(v.uid);},
    lstatSync(file:string){if(file.endsWith("settled.json"))return {...stat(),mode:0o600,isFile:()=>true};return stat();},
    existsSync:(file:string)=>file.endsWith("settled.json")||directory,rmSync(){directory=false;},
  };
  const source=readFileSync(path.join(process.cwd(),"runtime-assets/claude-worker/claude-step-control.mjs"),"utf8").replace(/^import .*;$/gm,"").replace(/export /g,"").split("if (process.argv[1]")[0];
  const fakeProcess={platform:"linux",pid:400,getuid:()=>1500,argv:[]};
  return new Function("fs","process",source+";return {captureBaseline,checkBaseline,cleanupStep};")(fs,fakeProcess) as {captureBaseline():unknown;checkBaseline(value:unknown):unknown[];cleanupStep(receipt:unknown,baseline:unknown,timeout?:number):Promise<unknown>};
}
it("whole UID inventory allows only immutable baseline and fixed helper lineage, then validates settlement and removes exact step state",async()=>{
  const f=fixture();expect(f.captureBaseline()).toEqual(baseline);expect(f.checkBaseline(baseline)).toEqual([]);
  expect(await f.cleanupStep(receipt,baseline)).toMatchObject({type:"genbi.step.cleaned",step:receipt.step,remaining:0});
});
it("an escaped/reparented descendant is unknown even though the original PGID is empty",async()=>{
  const f=fixture("escaped");expect(f.checkBaseline(baseline)).toContainEqual(expect.objectContaining({pid:50,parent:1,group:50}));
  await expect(f.cleanupStep(receipt,baseline,1)).rejects.toThrow("deadline");
});
it("PID recycling and browser/model supplied baseline shape cannot become zero proof",()=>{
  expect(()=>fixture("recycled").checkBaseline(baseline)).toThrow("recycled baseline");
  expect(()=>fixture().checkBaseline({...baseline,allowPid:50})).toThrow("baseline");
});
