#!/usr/bin/env node
/** Offline exact-artifact acceptance. No release approval, network, or model calls. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { preparePythonTree, runtimeTreeDigest } from '../managed-wren/runtime-tree.cjs';
import { provisionManagedWrenRuntime, resolveManagedWrenRuntime } from '../dist-server/server/managed-wren-runtime.js';

if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('requires macOS arm64');
const input = process.argv[2];
if (!input) throw new Error('usage: probe-managed-wren-install.mjs <local-release-artifacts-directory>');
const source = realpathSync(input);
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const exact = JSON.parse(readFileSync(path.join(packageRoot, 'managed-wren/release-inputs.json')));
const wheels = JSON.parse(readFileSync(path.join(source, 'wheel-inputs.json')));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const archive = path.join(source, 'python.tar.gz');
assert.equal(hash(readFileSync(archive)), exact.python.sha256);
for (const wheel of wheels) assert.equal(hash(readFileSync(path.join(source, 'wheels', wheel.filename))), wheel.sha256);
const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'genbi-real-install-')));
const env = { PATH: '/usr/bin:/bin', HOME: root, PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1' };
const run = (file, args) => execFileSync(file, args, { env, timeout: 180_000, stdio: 'pipe' }).toString();
const previousFetch = globalThis.fetch;
let completed = false;
try {
  const release = path.join(root, 'release'); const runtime = path.join(release, 'runtime');
  mkdirSync(runtime, { recursive: true, mode: 0o700 });
  run('/usr/bin/tar', ['-xpzf', archive, '-C', runtime]);
  const pythonRoot = path.join(runtime, 'python');
  let writable = 0;
  const count = directory => { for (const name of readdirSync(directory)) { const file = path.join(directory, name); const stat = lstatSync(file); if (stat.isSymbolicLink()) continue; if (stat.mode & 0o022) writable++; if (stat.isDirectory()) count(file); } };
  count(pythonRoot); assert.ok(writable > 0, 'expected upstream writable-mode regression input');
  const rawDigest = runtimeTreeDigest(pythonRoot);
  preparePythonTree(pythonRoot);
  const pythonDigest = runtimeTreeDigest(pythonRoot); assert.notEqual(pythonDigest, rawDigest);
  run(path.join(pythonRoot, 'bin/python3.11'), ['-m', 'venv', path.join(runtime, 'venv')]);
  const requirements = path.join(release, 'requirements.txt');
  writeFileSync(requirements, wheels.map(w => `${w.distribution}==${w.version} --hash=sha256:${w.sha256}`).join('\n') + '\n');
  run(path.join(runtime, 'venv/bin/python'), ['-m', 'pip', 'install', '--no-index', '--no-deps', '--require-hashes', '--find-links', path.join(source, 'wheels'), '-r', requirements]);
  copyFileSync(path.join(source, 'wheel-inputs.json'), path.join(release, 'wheel-inputs.json'));
  run(process.execPath, [path.join(packageRoot, 'scripts/managed-wren-release.mjs'), release, 'managed-wren-fixture']);
  const candidate = JSON.parse(readFileSync(path.join(release, 'managed-wren-manifest.candidate.json')));
  assert.equal(candidate.runtime.pythonTreeSha256, pythonDigest);
  // Approval exists only in this disposable test package, never the shipped manifest.
  const fixturePackage = path.join(root, 'fixture-package'); mkdirSync(path.join(fixturePackage, 'managed-wren'), { recursive: true });
  writeFileSync(path.join(fixturePackage, 'managed-wren/manifest.json'), JSON.stringify({ ...candidate, activation: 'approved', licenseApproval: { state: 'approved', evidence: 'offline-test-fixture-only' } }));
  const assets = new Map([[candidate.python.mirror.url, archive], ...candidate.wheels.map(w => [w.url, path.join(source, 'wheels', w.filename)])]);
  let requests = 0;
  globalThis.fetch = async url => { requests++; const file = assets.get(String(url)); if (!file) throw new Error('network forbidden'); return new Response(readFileSync(file)); };
  const options = { packageRoot: fixturePackage, runtimeRoot: path.join(root, 'Application Support', 'managed-wren') };
  const installed = await provisionManagedWrenRuntime(options);
  assert.deepEqual(resolveManagedWrenRuntime(options), installed);
  const firstRequests = requests;
  assert.deepEqual(await provisionManagedWrenRuntime(options), installed);
  assert.equal(requests, firstRequests); assert.equal(requests, wheels.length + 1);
  assert.match(run(installed.venv_python, ['-m', 'pip', 'check']), /No broken requirements/);
  assert.match(run(installed.launcher, ['--help']), /Usage:/);
  const mode = lstatSync(installed.interpreter).mode & 0o777;
  chmodSync(installed.interpreter, mode | 0o020);
  assert.throws(() => resolveManagedWrenRuntime(options));
  await assert.rejects(provisionManagedWrenRuntime(options));
  assert.equal(lstatSync(installed.interpreter).mode & 0o777, mode | 0o020);
  chmodSync(installed.interpreter, mode);
  assert.deepEqual(resolveManagedWrenRuntime(options), installed);
  console.log(JSON.stringify({ status: 'passed', upstreamWritableEntries: writable, wheels: wheels.length, archiveSha256: exact.python.sha256, pythonTreeSha256: pythonDigest, manifestDigest: installed.manifest_digest, provision: true, resolve: true, reuseWithoutFetch: true, pipCheck: true, wrenHelp: true, permissionTamperRejected: true, modelCalls: 0 }));
  completed = true;
} catch (error) {
  console.error(`Failed fixture retained at ${root}`); throw error;
} finally {
  globalThis.fetch = previousFetch;
  if (completed) rmSync(root, { recursive: true, force: true });
}
