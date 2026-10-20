#!/usr/bin/env node
/**
 * Operator provisioning for pi on the local runtime. Host-side, run by the operator, never by the server.
 *
 *   genbi-local-pi install [--replace] [--state-dir <dir>]
 *   genbi-local-pi verify  [--state-dir <dir>]
 *   genbi-local-pi row     [--state-dir <dir>]
 *
 * `install` runs `npm ci --ignore-scripts` from the packaged lockfile into the GenBI state directory and writes the install's pins; it never
 * runs at boot. `verify` runs the same identity check a boot runs. `row` prints the packaged rows, whether they match the install,
 * and the candidate row for a maintainer to review. It never reads, accepts or stores a model key.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entry = path.join(packageRoot, 'dist-server', 'server', 'local-pi-operator.js');
const usage = 'usage: genbi-local-pi install [--replace] [--state-dir <dir>] | verify [--state-dir <dir>] | row [--state-dir <dir>]\n';

const fail = (message, code = 'usage') => { process.stderr.write(`${JSON.stringify({ ok: false, code, message })}\n`); process.exitCode = 1; };
if (!existsSync(entry)) {
  fail(`cannot find the built server at ${entry}. This install looks incomplete or corrupted: reinstall @wrenai/genbi and try again.`, 'incomplete_install');
} else {
  const [command, ...rest] = process.argv.slice(2);
  const flag = (name) => rest.includes(name);
  const value = (name) => { const index = rest.indexOf(name); return index >= 0 ? rest[index + 1] : undefined; };
  const known = new Set(['--replace', '--state-dir']);
  const unknown = rest.filter((item) => item.startsWith('--') && !known.has(item));
  const stateDir = value('--state-dir');
  try {
    if (unknown.length > 0) fail(`unknown option ${unknown[0]}. ${usage}`);
    else if (stateDir !== undefined && !path.isAbsolute(stateDir)) fail(`--state-dir needs an absolute path. ${usage}`);
    else {
      const operator = await import(entry);
      const options = { ...(stateDir ? { stateDir } : {}), ...(flag('--replace') ? { replace: true } : {}) };
      if (command === 'install') process.stdout.write(`${JSON.stringify(await operator.installManagedPi(options), null, 2)}\n`);
      else if (command === 'verify') {
        const report = operator.verifyManagedPi(options);
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
        if (!report.ok) fail(`pi is not ready: ${report.checks.find((check) => !check.ok)?.code ?? 'unknown'}`, report.checks.find((check) => !check.ok)?.code ?? 'failed');
      } else if (command === 'row') process.stdout.write(`${JSON.stringify(operator.describeManagedPi(options), null, 2)}\n`);
      else fail(usage);
    }
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error), error && typeof error === 'object' && 'code' in error ? String(error.code) : 'failed');
  }
}
