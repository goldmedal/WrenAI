// Per-step worker entry. Verifies the pinned image contents, then hands stdin/stdout to the worker core.
// It never execs pi directly: it stays the parent so it can multiplex pi events and the tool channel over one duplex.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
let phase = 'platform';
const fail = () => { process.stderr.write('worker admission ' + phase + '\n'); process.exit(70); };
try {
  if (process.platform !== 'linux' || process.arch !== 'arm64') fail();
  phase = 'assets';
  const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex');
  const pins = JSON.parse(readFileSync('/opt/genbi/pins.json', 'utf8'));
  if (pins.pins !== hash('/opt/genbi/pi-pins.mjs')) fail();
  const { PIN_PATHS, PI_BUNDLE, hashTree } = await import('./pi-pins.mjs');
  if (process.version !== pins.nodeVersion || pins.piVersion !== '1.0.4') fail();
  for (const [name, file] of Object.entries(PIN_PATHS)) if (name !== 'pins' && hash(file) !== pins[name]) fail();
  if (hashTree(PI_BUNDLE) !== pins.piBundle) fail();
  phase = 'run';
  const { runPiWorker } = await import('./pi-worker-core.mjs');
  await runPiWorker({ stdin: process.stdin, stdout: process.stdout, env: process.env,
    roots: { steps: '/sandbox/steps', pi: { command: '/opt/pi/node_modules/.bin/pi', prefix: [] }, node: '/usr/local/bin/node', shim: '/opt/genbi/pi-mcp-shim.mjs' },
    exit: code => process.exit(code) });
} catch { fail(); }
