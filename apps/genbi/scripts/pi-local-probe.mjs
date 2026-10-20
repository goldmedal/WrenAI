#!/usr/bin/env node
// Deterministic probe of pi on the local runtime. No model, no real key: the "vendor" is a scripted stub on loopback that holds a generated dummy key.
// It runs the real managed pi install through the real key proxy, step host and component step, and records what pi could see.
//
//   node scripts/pi-local-probe.mjs --root <package root holding dist-server> --state-dir <genbi state dir with `genbi-local-pi install` done>
//        [--port <stub port, default 4791>] [--out <file>]
//
// The identity check uses the packaged rows only. Run it under the Node major version the row certifies.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const arg = (name, fallback) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : fallback; };
const root = arg('--root'), stateDir = arg('--state-dir'), out = arg('--out'), port = Number(arg('--port', '4791'));
if (!root || !path.isAbsolute(root) || !stateDir || !path.isAbsolute(stateDir)) { process.stderr.write('usage: pi-local-probe.mjs --root <abs package root> --state-dir <abs dir> [--port n] [--out file]\n'); process.exit(64); }
const dist = (rel) => import(pathToFileURL(path.join(root, 'dist-server', rel)).href);
const { verifyLocalPi, packagedPiAssets } = await dist('server/runtime-host/local-pi-install.js');
const { LOCAL_PI_CERTIFIED_ROWS, nodeMajorOf } = await dist('server/runtime-host/local-pi-certification.js');
const { LocalPiKeyProxy } = await dist('server/runtime-host/local-pi-key-proxy.js');
const { createLocalPiProvider } = await dist('server/runtime-host/local-pi-provider.js');
const { defaultStepsRoot, ensureStepsRoot, listProcesses } = await dist('server/runtime-host/local-pi-step.js');
const { PiComponentError, runPiComponentStep } = await dist('server/runtime-host/pi-component-step.js');
const { describeManagedPi } = await dist('server/local-pi-operator.js');

const dummy = `probe-${crypto.randomBytes(24).toString('hex')}`;
const checks = []; const check = (name, ok, detail) => { checks.push({ name, ok: Boolean(ok), ...(detail === undefined ? {} : { detail }) }); };
const scrub = (value) => JSON.parse(JSON.stringify(value).split(dummy).join('<dummy-key>'));

// ---- identity under this Node ------------------------------------------------------------------------------------------------------------------------------------------------
const verification = verifyLocalPi({ stateDir });
const described = describeManagedPi({ stateDir });
check('packaged certification row covers this host and Node major and matches the installed identity', verification.verdict.ready === true && described.packagedRows.some((row) => row.matchesInstalled === true), { verdict: verification.verdict, packagedRows: described.packagedRows.length });
const major = nodeMajorOf(process.version);
check('another Node major is pi_uncertified and a Node below pi\'s minimum is pi_node_unsupported', verifyLocalPi({ stateDir, nodeVersion: `v${major + 1}.0.0` }).verdict.code === 'pi_uncertified' && verifyLocalPi({ stateDir, nodeVersion: 'v22.18.0' }).verdict.code === 'pi_node_unsupported');
check('the same Node major with another patch level is ready', verifyLocalPi({ stateDir, nodeVersion: `v${major}.99.99` }).verdict.ready === true);
check('a row is read from the package only: GENBI_PI_LOCAL_ROWS changes nothing', (() => { const before = process.env.GENBI_PI_LOCAL_ROWS; process.env.GENBI_PI_LOCAL_ROWS = path.join(os.tmpdir(), 'none.json'); try { return verifyLocalPi({ stateDir }).verdict.ready === verification.verdict.ready; } finally { if (before === undefined) delete process.env.GENBI_PI_LOCAL_ROWS; else process.env.GENBI_PI_LOCAL_ROWS = before; } })());
if (!verification.launcher) { const report = scrub({ kind: 'deterministic_pi_local_evidence', ok: false, checks }); if (out) fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify(report)); process.exit(1); }

// ---- stub vendor on loopback (holds the dummy key, records booleans only) ---------------------------------------------------------------------------------------------------
const seen = []; let mode = 'answer';
const stub = http.createServer((req, res) => {
  let raw = ''; req.on('data', (chunk) => { raw += chunk; });
  req.on('end', () => {
    let body = null; try { body = JSON.parse(raw); } catch { /* recorded below */ }
    const auth = String(req.headers.authorization ?? '');
    const tools = body?.tools ?? []; const last = (body?.messages ?? []).at(-1);
    seen.push({ url: req.url, authIsDummyKey: auth === `Bearer ${dummy}`, authLooksLikeStepToken: /^Bearer [a-f0-9]{64}$/.test(auth), hasXApiKey: req.headers['x-api-key'] !== undefined, bodyHasDummyKey: raw.includes(dummy), tools: tools.length });
    if (mode === 'hold') return; // the request is never answered: the step is cancelled while pi waits
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const base = { id: 'chatcmpl-stub', object: 'chat.completion.chunk', created: 0, model: body?.model ?? 'stub' };
    const send = (delta, finish = null) => res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
    const done = () => { res.write(`data: ${JSON.stringify({ ...base, choices: [], usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 } })}\n\ndata: [DONE]\n\n`); res.end(); };
    send({ role: 'assistant', content: '' });
    const tool = tools.find((candidate) => Object.hasOwn(candidate.function?.parameters?.properties ?? {}, 'code'));
    if (tool && last?.role !== 'tool') {
      send({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: tool.function.name, arguments: '' } }] });
      send({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ code: 'K7' }) } }] });
      send({}, 'tool_calls'); done(); return;
    }
    send({ content: 'probe answer' }); send({}, 'stop'); done();
  });
});
await new Promise((resolve, reject) => { stub.once('error', reject); stub.listen(port, '127.0.0.1', resolve); });

// ---- the real step host ---------------------------------------------------------------------------------------------------------------------------------------------------------
const stepsRoot = defaultStepsRoot(fs.realpathSync(os.tmpdir())); ensureStepsRoot(stepsRoot);
const proxy = new LocalPiKeyProxy({ env: () => ({ VENDOR_KEY: dummy }) });
const reports = [];
const provider = createLocalPiProvider({ proxy, endpoints: { fast: { api: 'openai-completions', upstream: `http://127.0.0.1:${port}/v1`, credentialEnv: 'VENDOR_KEY', model: 'stub-model' } },
  authIdentity: 'local-pi:probe', generation: '1', accountLabel: 'pi (probe)', assertCurrent() {}, assertExecutableCurrent() {}, stepsRoot,
  verifyIdentity: () => { const current = verifyLocalPi({ stateDir }); if (!current.launcher) throw new Error('not ready'); return current.launcher; }, onCleanup: (report) => reports.push(report) });
const schema = { type: 'object', properties: { code: { type: 'string' } }, required: ['code'], additionalProperties: false };
const run = (signal) => ({ tier: 'fast', request: 'ask', input: { q: 'hello' }, brief: 'BRIEF', prompt: 'PROMPT', consumes: {}, children: [], tools: { lookup: async (input) => { toolInputs.push(input); return { word: 'marmalade' }; } },
  toolSchemas: { lookup: schema }, toolDescriptions: { lookup: 'lookup tool' }, signal });
const toolInputs = [];

const sampleDir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'probe-sample-'));
let sampling = true; const sampled = new Set(); const psLines = new Set();
const copyTree = (from, to) => { for (const entry of fs.readdirSync(from, { withFileTypes: true })) { const source = path.join(from, entry.name), target = path.join(to, entry.name); if (entry.isDirectory()) { fs.mkdirSync(target, { recursive: true }); copyTree(source, target); } else if (entry.isFile()) { try { fs.copyFileSync(source, target); sampled.add(path.relative(sampleDir, target).replace(/^[0-9a-f-]{36}\//, '<step>/')); } catch { /* vanished */ } } } };
const sampler = (async () => {
  while (sampling) {
    try {
      const dirs = fs.readdirSync(stepsRoot).filter((name) => /^[0-9a-f-]{36}$/.test(name));
      for (const dir of dirs) { fs.mkdirSync(path.join(sampleDir, dir), { recursive: true }); try { copyTree(path.join(stepsRoot, dir), path.join(sampleDir, dir)); } catch { /* vanished */ } }
      if (dirs.length) for (const line of execFileSync('/bin/ps', ['-axww', '-E', '-o', 'pid=,command='], { encoding: 'utf8', maxBuffer: 64 << 20 }).split('\n')) if (line.includes(stepsRoot)) psLines.add(line.trim());
    } catch { /* keep sampling */ }
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
})();
const stepDirs = () => fs.readdirSync(stepsRoot).filter((name) => /^[0-9a-f-]{36}$/.test(name));
const residue = async () => (await listProcesses()).filter((row) => row.command.includes(stepsRoot) && !row.stat.startsWith('Z')).length;

// 1. a complete step: pi -> proxy -> stub, a governed tool call, an answer
const response = await runPiComponentStep(await provider.open('stub-model', new AbortController().signal, 'fast'), run(new AbortController().signal));
check('a real pi 1.0.4 step runs through the proxy and the host answers its one tool call', response.value === 'probe answer' && toolInputs.length === 1 && toolInputs[0].code === 'K7', { value: response.value, toolInputs });
check('the stub received only requests that carry the dummy key injected by the proxy, never the step token', seen.length >= 2 && seen.every((entry) => entry.authIsDummyKey && !entry.authLooksLikeStepToken && !entry.hasXApiKey && !entry.bodyHasDummyKey && entry.url === '/v1/chat/completions'), { requests: seen.length, urls: [...new Set(seen.map((entry) => entry.url))] });
check('the step finished with processes clear, directory removed and grant revoked', reports.length === 1 && reports[0].reason === 'settled' && reports[0].processes === 'clear' && reports[0].directory === 'removed' && reports[0].grant === 'revoked' && stepDirs().length === 0 && proxy.liveGrants === 0 && await residue() === 0, reports[0]);

// 2. a cancelled step: pi is waiting on the vendor; the abort must leave nothing behind
mode = 'hold'; const before = seen.length; const controller = new AbortController();
const pending = runPiComponentStep(await provider.open('stub-model', controller.signal, 'fast'), run(controller.signal)).then(() => 'completed', (error) => error);
for (let waited = 0; waited < 60_000 && seen.length === before; waited += 25) await new Promise((resolve) => setTimeout(resolve, 25));
controller.abort(); const outcome = await pending;
check('a step cancelled while pi waits on the vendor fails as cancelled and proves cleanup', outcome instanceof PiComponentError && outcome.reason === 'cancelled' && reports.length === 2 && reports[1].reason === 'cancelled' && reports[1].processes === 'clear' && reports[1].directory === 'removed' && reports[1].grant === 'revoked' && stepDirs().length === 0 && proxy.liveGrants === 0 && await residue() === 0, reports[1]);

// ---- what pi could see ---------------------------------------------------------------------------------------------------------------------------------------------------
await new Promise((resolve) => setTimeout(resolve, 200)); sampling = false; await sampler;
let filesWithKey = 0; const walk = (dir) => { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) { const full = path.join(dir, entry.name); if (entry.isDirectory()) walk(full); else if (fs.readFileSync(full, 'utf8').includes(dummy)) filesWithKey++; } }; walk(sampleDir);
const ps = [...psLines].join('\n');
check('nothing pi could read held the key: sampled step files and process lines carry the step token variable and no vendor key', filesWithKey === 0 && !ps.includes(dummy) && /GENBI_PI_STEP_TOKEN=[a-f0-9]{64}/.test(ps) && !/VENDOR_KEY=|OPENAI_API_KEY=|ANTHROPIC_API_KEY=/.test(ps), { sampledFiles: [...sampled].filter((name) => !name.includes('node-compile-cache')).sort(), processLines: psLines.size });

await proxy.close(); await new Promise((resolve) => stub.close(resolve)); stub.closeAllConnections?.();
fs.rmSync(sampleDir, { recursive: true, force: true });
const assets = packagedPiAssets();
const report = scrub({ kind: 'deterministic_pi_local_evidence', date: new Date().toISOString().slice(0, 10), vendor: 'pi-local', runner: 'scripts/pi-local-probe.mjs', modelCalls: 0,
  host: { platform: process.platform, arch: process.arch }, node: { version: process.version, major }, piVersion: assets.piVersion, ok: checks.every((entry) => entry.ok), checks });
if (out) fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ ok: report.ok, node: process.version, checks: checks.map((entry) => `${entry.ok ? 'ok' : 'FAIL'} ${entry.name.slice(0, 70)}`) }));
process.exit(report.ok ? 0 : 1);
