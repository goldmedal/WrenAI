// Content digests shared by the image build (pins.json) and the worker's start-up admission.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

export const hashFile = file => createHash('sha256').update(readFileSync(file)).digest('hex');

/** Digest of a directory tree: regular files only, per-directory name order, `<sha256>  <relative path>` lines. */
export function hashTree(root) {
  const lines = [];
  const walk = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) lines.push(`${hashFile(full)}  ${path.relative(root, full)}\n`);
      else throw new Error('unsupported tree entry');
    }
  };
  walk(root);
  return createHash('sha256').update(lines.join('')).digest('hex');
}

export const PIN_PATHS = Object.freeze({
  node: '/usr/local/bin/node', worker: '/opt/genbi/pi-worker.mjs', workerCore: '/opt/genbi/pi-worker-core.mjs', shim: '/opt/genbi/pi-mcp-shim.mjs',
  procCheck: '/opt/genbi/pi-proc-check.mjs', trust: '/opt/genbi/claude-worker-ca.mjs', pins: '/opt/genbi/pi-pins.mjs', lockfile: '/opt/pi/package-lock.json',
});
export const PI_PACKAGE = '/opt/pi/node_modules/@earendil-works/pi-coding-agent';
export const PI_BUNDLE = `${PI_PACKAGE}/dist/bundle`;

export function computePins() {
  const pins = { nodeVersion: process.version, piVersion: JSON.parse(readFileSync(`${PI_PACKAGE}/package.json`, 'utf8')).version, piBundle: hashTree(PI_BUNDLE) };
  for (const [name, file] of Object.entries(PIN_PATHS)) pins[name] = hashFile(file);
  return pins;
}
