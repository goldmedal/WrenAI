#!/usr/bin/env node
/**
 * Operator provisioning for a pi boot on OpenShell. Host-side, run by the operator, never by the server.
 *
 *   genbi-openshell-pi provision --spec <spec.json> [--dry-run] [--replace]
 *   genbi-openshell-pi verify    --dir <output directory>
 *   genbi-openshell-pi row
 *
 * It builds the pi image, renders and imports the policy and profile, writes the protected descriptor and driver configuration, and
 * PRINTS the `openshell provider create` command for you to run in your own shell. It never reads, accepts or stores a model key and
 * never consults the ambient environment.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entry = path.join(packageRoot, 'dist-server', 'server', 'openshell-pi-operator.js');
const usage = 'usage: genbi-openshell-pi provision --spec <spec.json> [--dry-run] [--replace] | verify --dir <directory> | row\n';

const fail = (message, code = 'usage') => { process.stderr.write(`${JSON.stringify({ ok: false, code, message })}\n`); process.exitCode = 1; };
if (!existsSync(entry)) {
  fail(`cannot find the built server at ${entry}. This install looks incomplete or corrupted: reinstall @wrenai/genbi and try again.`, 'incomplete_install');
} else {
  const [command, ...rest] = process.argv.slice(2);
  const flag = (name) => rest.includes(name);
  const value = (name) => { const index = rest.indexOf(name); return index >= 0 ? rest[index + 1] : undefined; };
  const known = new Set(['--spec', '--dir', '--dry-run', '--replace']);
  const unknown = rest.filter((item) => item.startsWith('--') && !known.has(item));
  const operator = await import(entry);
  try {
    if (unknown.length > 0) fail(`unknown option ${unknown[0]}. ${usage}`);
    else if (command === 'provision') {
      const specFile = value('--spec');
      if (!specFile || !path.isAbsolute(specFile)) fail(`provision needs --spec with an absolute path. ${usage}`);
      else {
        const report = await operator.provisionPiBoot(JSON.parse(readFileSync(specFile, 'utf8')), { dryRun: flag('--dry-run'), replace: flag('--replace') });
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
        process.stdout.write(`\nRun this yourself, in your own shell, with your key in place of <your key>:\n  ${report.providerCommand}\n`);
      }
    } else if (command === 'verify') {
      const directory = value('--dir');
      if (!directory || !path.isAbsolute(directory)) fail(`verify needs --dir with an absolute path. ${usage}`);
      else {
        const report = await operator.verifyPiBoot(directory);
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
        if (!report.ok) process.exitCode = 1;
      }
    } else if (command === 'row') {
      process.stdout.write(`${JSON.stringify(operator.describePackagedCertification(), null, 2)}\n`);
    } else fail(usage);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error), error && typeof error === 'object' && 'code' in error ? String(error.code) : 'failed');
  }
}
