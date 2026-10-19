// Fixed host-only session-step entrypoint: one pi step inside an owned, reused session sandbox.
// A thin supervisor around the unchanged per-step worker, so pins, CA trust, argv and file admission, the host system prompt, the key placeholder and the in-band end all stay the worker's.
// Its private receipt precedes every worker frame, and the worker never sees a byte of the bootstrap before the receipt is written.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { procIdentity, ownedDirectory } from './pi-step-control.mjs';
let phase = 'platform';
const fail = () => { process.stderr.write('worker admission ' + phase + '\n'); process.exit(70); };
try {
  if (process.platform !== 'linux' || process.arch !== 'arm64' || process.getuid() !== 1500) fail();
  phase = 'assets';
  const pins = JSON.parse(fs.readFileSync('/opt/genbi/pins.json', 'utf8'));
  const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  if (process.version !== pins.nodeVersion || hash('/usr/local/bin/node') !== pins.node || hash('/opt/genbi/pi-session-step.mjs') !== pins.sessionStep
    || hash('/opt/genbi/pi-step-control.mjs') !== pins.stepControl || hash('/opt/genbi/pi-worker.mjs') !== pins.worker || hash('/opt/genbi/pi-pins.mjs') !== pins.pins) fail();
  phase = 'bootstrap';
  const deadline = Date.now() + 15000;
  const exact = size => { const result = Buffer.alloc(size); let offset = 0; while (offset < size) { let n; try { n = fs.readSync(0, result, offset, size - offset, null); } catch (error) { if (error.code !== 'EAGAIN' || Date.now() >= deadline) fail(); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 8); continue; } if (!n) fail(); offset += n; } return result; };
  const head = exact(4); const length = head.readUInt32BE(); if (length < 1 || length > 1048576) fail();
  const body = exact(length);
  const scope = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)).scope;
  // Everything else in the bootstrap is the worker's to validate; the supervisor only needs the step id to name its receipt and directory.
  if (typeof scope !== 'string' || !/^[a-f0-9-]{36}$/.test(scope)) fail();
  phase = 'isolation';
  const steps = '/sandbox/steps';
  try { fs.mkdirSync(steps, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  ownedDirectory(steps);
  const root = steps + '/' + scope;
  // The worker creates the step directory itself and refuses an existing one; a pre-existing entry is never reused.
  if (fs.existsSync(root)) fail();
  phase = 'exec';
  const child = spawn('/usr/local/bin/node', ['/opt/genbi/pi-worker.mjs'], { cwd: '/sandbox', env: process.env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
  let pending = Buffer.alloc(0), frames = 0, outputBytes = 0, exitFrame, receipt;
  child.stdout.on('data', chunk => {
    try {
      if (!receipt) throw Error('order');
      outputBytes += chunk.length; if (outputBytes > 17825792) throw Error('output');
      pending = Buffer.concat([pending, chunk]);
      for (let end; (end = pending.indexOf(10)) >= 0;) {
        if (end >= 2097152 || ++frames > 2048) throw Error('frame');
        const raw = pending.subarray(0, end + 1); pending = pending.subarray(end + 1);
        const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('frame');
        // Nothing may follow the worker's own exit frame.
        if (exitFrame) throw Error('frame');
        if (value.t === 'exit') exitFrame = value;
        process.stdout.write(raw);
      }
      if (pending.length >= 2097152) throw Error('frame');
    } catch { try { child.kill('SIGKILL'); } catch { /* exiting anyway */ } fail(); }
  });
  child.on('error', fail);
  child.on('spawn', () => {
    try {
      const identity = procIdentity(child.pid);
      if (identity.group !== child.pid || identity.parent !== process.pid) { child.kill('SIGKILL'); fail(); }
      receipt = { type: 'genbi.step', version: 1, step: scope, pid: child.pid, group: identity.group, start: identity.start };
      process.stdout.write(JSON.stringify(receipt) + '\n');
      child.stderr.pipe(process.stderr);
      child.stdin.on('error', fail);
      child.stdin.write(Buffer.concat([head, body]));
      process.stdin.pipe(child.stdin);
    } catch { fail(); }
  });
  child.on('close', code => {
    if (code !== 0 || !receipt || !exitFrame || exitFrame.scope !== scope || exitFrame.forced !== false || exitFrame.remaining !== 0 || pending.length !== 0) process.exit(71);
    try { ownedDirectory(root); fs.writeFileSync(root + '/settled.json', JSON.stringify({ ...receipt, outcome: 'normal' }), { flag: 'wx', mode: 0o600 }); }
    catch { process.exit(71); }
    process.exit(0);
  });
} catch { fail(); }
