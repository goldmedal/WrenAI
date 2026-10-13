import { afterEach, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const children: ChildProcess[] = [], roots: string[] = [];
afterEach(async () => {
  await Promise.all(children.splice(0).map(async (child) => {
    if (child.exitCode === null && child.signalCode === null) { const closed = once(child, "close"); child.kill("SIGKILL"); await closed; }
  }));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const moduleUrl = new URL("../dist-server/server/runtime-host/openshell-lifecycle.js", import.meta.url).href;
const worker = `
import { OpenShellLifecycle } from ${JSON.stringify(moduleUrl)};
const manager = new OpenShellLifecycle({stateRoot:process.argv[1],exclusive:true,
 journal:{listOpenShellIntents:()=>[],saveOpenShellIntent:()=>{},interruptOpenShellWork:()=>{}},
 driver:{version:'0.0.1',identity:{},probe:async()=>{}}});
process.on('message',async command=>{
 if(command==='start') {try{await manager.initialize();process.send({state:(await manager.probe()).readiness.state});}
 catch(error){await manager.shutdown();process.send({state:'blocked',code:error.code});}}
 if(command==='probe') process.send({state:(await manager.probe()).readiness.state});
});
process.send({state:'booted'});
`;
function message(child: ChildProcess): Promise<{ state: string; code?: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(Error("worker IPC timeout")); }, 5000);
    const cleanup = () => { clearTimeout(timer); child.off("message", receive); child.off("error", error); };
    const receive = (value: unknown) => { cleanup(); resolve(value as { state: string; code?: string }); };
    const error = (value: Error) => { cleanup(); reject(value); };
    child.once("message", receive); child.once("error", error);
  });
}
async function boot(root: string) {
  const child = spawn(process.execPath, ["--input-type=module", "-e", worker, root], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
  children.push(child); expect((await message(child)).state).toBe("booted"); return child;
}
it("OS releases a crashed controller's SQLite lock; two simultaneous successors cannot both become ready", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "genbi-lock-recovery-")); roots.push(root);
  const original = await boot(root); const first = message(original); original.send("start"); expect((await first).state).toBe("ready");
  const inode = statSync(path.join(root, "openshell-owner.sqlite")).ino;
  const closed = once(original, "close"); original.kill("SIGKILL"); await closed;
  const contenders = await Promise.all([boot(root), boot(root)]);
  const results = contenders.map(child => message(child)); for (const child of contenders) child.send("start");
  const states = await Promise.all(results); expect(states.filter(row => row.state === "ready")).toHaveLength(1);
  expect(states.filter(row => row.code === "openshell_exclusivity_required")).toHaveLength(1);
  const winner = contenders[states.findIndex(row => row.state === "ready")]!;
  const live = message(winner); winner.send("probe"); expect((await live).state).toBe("ready");
  expect(statSync(path.join(root, "openshell-owner.sqlite")).ino).toBe(inode);
});
