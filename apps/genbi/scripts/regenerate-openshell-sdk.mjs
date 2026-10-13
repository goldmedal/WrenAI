#!/usr/bin/env node
// Explicit maintainer operation. Ordinary install/build/pack never invokes this.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
const upstream = process.argv[2]; if (!upstream || !path.isAbsolute(upstream)) throw Error('Pass an absolute public upstream checkout');
const assets = new URL('../runtime-assets/openshell-sdk/', import.meta.url);
const manifest = JSON.parse(fs.readFileSync(new URL('provenance.json', assets)));
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
if (execFileSync('git', ['-C', upstream, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() !== manifest.commit) throw Error('Upstream revision mismatch');
for (const [name, digest] of Object.entries(manifest.inputs)) if (hash(fs.readFileSync(path.join(upstream, name))) !== digest) throw Error('Input drift: ' + name);
const sdk = path.join(upstream, 'sdk/typescript');
const originalPackage = fs.readFileSync(path.join(sdk, 'package.json'));
const originalLock = fs.existsSync(path.join(sdk, 'package-lock.json')) ? fs.readFileSync(path.join(sdk, 'package-lock.json')) : undefined;
try {
fs.copyFileSync(new URL('build-package.json', assets), path.join(sdk, 'package.json'));
fs.copyFileSync(new URL('build-lock.json', assets), path.join(sdk, 'package-lock.json'));
for (const args of [['ci', '--ignore-scripts', '--no-audit', '--no-fund'], ['run', 'gen'], ['run', 'build']]) execFileSync('npm', args, { cwd: sdk, stdio: 'inherit' });
for (const [name, digest] of Object.entries(manifest.outputs)) if (name.startsWith('dist/')) {
  const generated = fs.readFileSync(path.join(sdk, name), 'utf8').replace(/\n\/\/# sourceMappingURL=.*/g, '');
  if (hash(generated) !== digest) throw Error('Output drift: ' + name);
}
console.log('Pinned public SDK closure reproduced');
} finally {
fs.writeFileSync(path.join(sdk, 'package.json'), originalPackage);
if (originalLock) fs.writeFileSync(path.join(sdk, 'package-lock.json'), originalLock); else fs.rmSync(path.join(sdk, 'package-lock.json'), { force: true });
}
