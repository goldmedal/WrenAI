// Runs the production worker core against a temporary steps root with a fake pi. macOS lists processes through ps; Linux uses /proc.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const assets = path.resolve(here, '../../runtime-assets/pi-worker');
const { runPiWorker } = await import(path.join(assets, 'pi-worker-core.mjs'));
const { supervisorCaTrust } = await import(path.join(assets, 'claude-worker-ca.mjs'));
const { makeIo } = await import(path.join(here, 'supervisor-ca-fixture.mjs'));
const psList = () => execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,pgid=,stat=,command='], { encoding: 'utf8' }).trim().split('\n').map(line => { const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line); return m && !/ \/bin\/ps /.test(` ${m[5]} `) ? { pid: +m[1], ppid: +m[2], pgrp: +m[3], state: m[4][0], cmdline: m[5] } : null; }).filter(Boolean);
await runPiWorker({ stdin: process.stdin, stdout: process.stdout, env: process.env, ...(process.platform === 'linux' ? {} : { listProcesses: psList }), ...(process.env.TEST_CA_ROOT ? { caTrust: (env) => supervisorCaTrust(env, makeIo(process.env.TEST_CA_ROOT), 1500, 1500) } : {}), markers: process.env.TEST_MARKER ? [process.env.TEST_MARKER] : [],
  roots: { steps: process.env.TEST_STEPS, pi: { command: process.execPath, prefix: [path.join(here, 'fake-pi.mjs')] }, node: process.execPath, shim: path.join(assets, 'pi-mcp-shim.mjs') }, exit: code => process.exit(code) });
