// Private one-shot stdin bootstrap. Read exact bytes; never prebuffer SDK input.
import { readSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
let phase = 'platform';
const fail = () => { process.stderr.write('worker admission ' + phase + '\n'); process.exit(70); };
try {
  if (process.platform !== 'linux' || process.arch !== 'arm64') fail();
  phase = 'bootstrap';
  const bootstrapDeadline = Date.now() + 15000;
  const exact = size => { const result = Buffer.alloc(size); let offset = 0; while (offset < size) { let n; try { n = readSync(0, result, offset, size - offset, null); } catch (error) { if (error.code !== "EAGAIN" || Date.now() >= bootstrapDeadline) fail(); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 8); continue; } if (!n) fail(); offset += n; } return result; };
  const length = exact(4).readUInt32BE(); if (length < 1 || length + 4 > 16384) fail();
  const boot = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(exact(length)));
  if (Object.keys(boot).sort().join(',') !== 'access,argv,expiresAt,generation,protocol,scope' || boot.protocol !== 1
    || typeof boot.access !== 'string' || !/^[A-Za-z0-9._~-]{16,8192}$/.test(boot.access)
    || !Number.isSafeInteger(boot.expiresAt) || boot.expiresAt < Date.now() + 135000
    || !/^[a-f0-9-]{36}$/.test(boot.generation) || !/^[a-f0-9-]{36}$/.test(boot.scope)
    || !Array.isArray(boot.argv) || boot.argv.length > 40 || boot.argv.some(v => typeof v !== 'string' || v.includes('\0') || v.includes(boot.access))) fail();
  phase = 'assets';
  const pins = JSON.parse(readFileSync('/opt/genbi/pins.json', 'utf8'));
  const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex');
  if (process.version !== pins.nodeVersion || hash('/usr/local/bin/node') !== pins.node || hash('/opt/genbi/claude') !== pins.claude
    || hash('/opt/genbi/claude-worker.mjs') !== pins.wrapper || hash('/opt/genbi/claude-worker-ca.mjs') !== pins.caTrust) fail();
  phase = 'isolation';
  const { supervisorCaTrust } = await import('./claude-worker-ca.mjs');
  const trust = supervisorCaTrust(process.env);
  for (const name of ['home', 'config', 'tmp']) mkdirSync('/sandbox/' + name, { mode: 0o700 });
  // No identity/email spoofing; real accountInfo must report the credential's identity.
  writeFileSync('/sandbox/config/.claude.json', JSON.stringify({ hasCompletedOnboarding: true }), { mode: 0o600, flag: 'wx' });
  const environment = { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/sandbox/home', CLAUDE_CONFIG_DIR: '/sandbox/config', TMPDIR: '/sandbox/tmp', LANG: 'C.UTF-8',
    CLAUDE_CODE_OAUTH_TOKEN: boot.access, CLAUDE_CODE_ENTRYPOINT: 'sdk-ts', CLAUDE_AGENT_SDK_VERSION: '0.3.259', DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', ...trust.environment };
  phase = 'exec';
  trust.assertCurrent();
  trust.close();
  process.execve('/opt/genbi/claude', ['/opt/genbi/claude', ...boot.argv], environment);
} catch { fail(); }
