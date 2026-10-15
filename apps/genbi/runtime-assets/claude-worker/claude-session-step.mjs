// Fixed session-step launcher. Its private receipt precedes all SDK frames.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { procIdentity, ownedDirectory } from './claude-step-control.mjs';
let phase = 'platform';
const fail = () => { process.stderr.write('worker admission ' + phase + '\n'); process.exit(70); };
try {
  if (process.platform !== 'linux' || process.arch !== 'arm64' || process.getuid() !== 1500) fail();
  phase = 'bootstrap';
  const deadline = Date.now() + 15000;
  const exact = size => { const result = Buffer.alloc(size); let offset = 0; while (offset < size) { let n; try { n = fs.readSync(0, result, offset, size - offset, null); } catch (error) { if (error.code !== 'EAGAIN' || Date.now() >= deadline) fail(); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 8); continue; } if (!n) fail(); offset += n; } return result; };
  const length = exact(4).readUInt32BE(); if (length < 1 || length + 4 > 16384) fail();
  const boot = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(exact(length)));
  if (Object.keys(boot).sort().join(',') !== 'access,argv,expiresAt,generation,protocol,scope' || boot.protocol !== 1
    || typeof boot.access !== 'string' || !/^[A-Za-z0-9._~-]{16,8192}$/.test(boot.access)
    || !Number.isSafeInteger(boot.expiresAt) || boot.expiresAt < Date.now() + 135000
    || !/^[a-f0-9-]{36}$/.test(boot.generation) || !/^[a-f0-9-]{36}$/.test(boot.scope)
    || !Array.isArray(boot.argv) || boot.argv.length > 40 || boot.argv.some(v => typeof v !== 'string' || v.includes('\0') || v.includes(boot.access))) fail();
  phase = 'assets';
  const pins = JSON.parse(fs.readFileSync('/opt/genbi/pins.json', 'utf8'));
  const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  if (process.version !== pins.nodeVersion || hash('/usr/local/bin/node') !== pins.node || hash('/opt/genbi/claude') !== pins.claude
    || hash('/opt/genbi/claude-session-step.mjs') !== pins.sessionStep || hash('/opt/genbi/claude-step-control.mjs') !== pins.stepControl
    || hash('/opt/genbi/claude-worker-ca.mjs') !== pins.caTrust) fail();
  phase = 'isolation';
  const steps = '/sandbox/steps';
  try { fs.mkdirSync(steps, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  ownedDirectory(steps);
  const root = steps + '/' + boot.scope;
  fs.mkdirSync(root, { mode: 0o700 }); ownedDirectory(root);
  for (const name of ['home', 'config', 'tmp', 'work']) fs.mkdirSync(root + '/' + name, { mode: 0o700 });
  fs.writeFileSync(root + '/config/.claude.json', JSON.stringify({ hasCompletedOnboarding: true }), { mode: 0o600, flag: 'wx' });
  const { supervisorCaTrust } = await import('./claude-worker-ca.mjs');
  const trust = supervisorCaTrust(process.env);
  const environment = { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: root + '/home', CLAUDE_CONFIG_DIR: root + '/config', TMPDIR: root + '/tmp', LANG: 'C.UTF-8',
    CLAUDE_CODE_OAUTH_TOKEN: boot.access, CLAUDE_CODE_ENTRYPOINT: 'sdk-ts', CLAUDE_AGENT_SDK_VERSION: '0.3.259', DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', ...trust.environment };
  phase = 'exec'; trust.assertCurrent();
  const child = spawn('/opt/genbi/claude', boot.argv, { cwd: root + '/work', env: environment, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
  let pending = Buffer.alloc(0), frames = 0, outputBytes = 0, terminal = false;
  let receipt;
  const terminalShape = value => value.type === 'result' && value.subtype === 'success' && value.is_error === false
    && typeof value.uuid === 'string' && value.uuid.length > 0 && value.uuid.length <= 512
    && typeof value.session_id === 'string' && value.session_id.length > 0 && value.session_id.length <= 512
    && typeof value.result === 'string' && value.result.length <= 1048576
    && Array.isArray(value.permission_denials) && value.permission_denials.length === 0
    && value.modelUsage && typeof value.modelUsage === 'object' && Object.keys(value.modelUsage).length === 1
    && Object.entries(value.modelUsage).every(([model, usage]) => model === boot.argv[boot.argv.indexOf('--model') + 1]
      && usage && usage.webSearchRequests === 0 && ['inputTokens', 'outputTokens', 'cacheReadInputTokens', 'cacheCreationInputTokens'].every(name => Number.isSafeInteger(usage[name]) && usage[name] >= 0))
    && value.usage && Number.isSafeInteger(value.usage.input_tokens) && value.usage.input_tokens >= 0
    && Number.isSafeInteger(value.usage.output_tokens) && value.usage.output_tokens >= 0;
  child.stdout.on('data', chunk => {
    try {
      outputBytes += chunk.length; if (outputBytes > 16777216) throw Error('output');
      pending = Buffer.concat([pending, chunk]);
      for (let end; (end = pending.indexOf(10)) >= 0;) {
        if (end >= 2097152 || ++frames > 1024 || terminal) throw Error('frame');
        const raw = pending.subarray(0, end + 1); pending = pending.subarray(end + 1);
        const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('frame');
        process.stdout.write(raw);
        if (value.type === 'result') {
          if (!terminalShape(value)) throw Error('result');
          terminal = true;
          // Lifecycle hint only: host protocol/root verification remains authoritative.
          // This is a local child pipe EOF, not an OpenShell transport half-close.
          child.stdin.end(error => { if (error) fail(); });
          setTimeout(fail, 4000).unref();
        }
      }
      if (pending.length >= 2097152) throw Error('frame');
    } catch { fail(); }
  });
  child.on('error', fail);
  child.on('spawn', () => {
    const identity = procIdentity(child.pid);
    if (identity.group !== child.pid || identity.parent !== process.pid) { child.kill('SIGKILL'); fail(); }
    receipt = { type: 'genbi.step', version: 1, step: boot.scope, pid: child.pid, group: identity.group, start: identity.start };
    process.stdout.write(JSON.stringify(receipt) + '\n');
    trust.close();
    child.stderr.pipe(process.stderr); process.stdin.pipe(child.stdin);
    child.stdin.on('error', fail);
  });
  child.on('close', code => {
    if (code !== 0 || !terminal || pending.length !== 0 || !receipt) process.exit(71);
    try { ownedDirectory(root); fs.writeFileSync(root + '/settled.json', JSON.stringify({ ...receipt, outcome: 'normal' }), { flag: 'wx', mode: 0o600 }); }
    catch { process.exit(71); }
    process.exit(0);
  });
} catch { fail(); }
