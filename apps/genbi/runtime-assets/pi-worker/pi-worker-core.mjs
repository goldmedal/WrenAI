// Worker core: materialises the host-computed pi configuration, runs one `pi --mode json`, relays its events and the tool channel over the
// single duplex, and ends itself in-band so the transport reports a real exit status. It interprets no MCP and grants nothing.
import { spawn } from 'node:child_process';
import { createHash, timingSafeEqual } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { supervisorCaTrust } from './claude-worker-ca.mjs';

const LIMITS = Object.freeze({ line: 2097152, frames: 1024, bootstrap: 1048576, total: 16777216, calls: 32, deadlineMs: 130000, exitWaitMs: 10000 });
const SETTINGS = '{"defaultProjectTrust":"never","enableInstallTelemetry":false,"enableAnalytics":false,"quietStartup":true,"defaultTools":[],"retry":{"enabled":false}}';
const PASS = ['ALL_PROXY', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'all_proxy', 'http_proxy', 'https_proxy', 'no_proxy', 'NODE_USE_ENV_PROXY'];
const PLACEHOLDER = /^(?:PLACEHOLDER:)?openshell:resolve:env:[A-Za-z0-9_]{1,256}$/;
const sha256 = value => createHash('sha256').update(value).digest('hex');
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export const stepPaths = (root, scope) => { const base = `${root}/${scope}`; return { base, agent: `${base}/agent`, cwd: `${base}/work`, home: `${base}/home`, tmp: `${base}/tmp`, prompt: `${base}/system-prompt.txt`, socket: `${base}/mcp.sock` }; };

/** Strict argv admission: exact flag set and exact values. Nothing that adds a prompt, context, skill, extension or session source passes. */
export function admitArgv(argv, paths, providerId, model) {
  if (!Array.isArray(argv) || argv.length > 40 || argv.some(value => typeof value !== 'string' || value.includes('\0'))) throw new Error('argv');
  const singles = new Set(['--no-session', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-themes', '--no-context-files', '--no-approve']);
  const pairs = new Map([['--mode', 'json'], ['-e', 'builtin:mcp'], ['--system-prompt', paths.prompt], ['--provider', providerId], ['--model', model]]);
  const seen = new Set();
  let tools;
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (seen.has(flag)) throw new Error('argv');
    seen.add(flag);
    if (singles.has(flag)) continue;
    if (flag === '--no-tools') { tools = []; continue; }
    const value = argv[++index];
    if (value === undefined) throw new Error('argv');
    if (flag === '--tools') {
      if (!/^mcp__component__[A-Za-z0-9][A-Za-z0-9_-]{0,63}(?:,mcp__component__[A-Za-z0-9][A-Za-z0-9_-]{0,63}){0,31}$/.test(value)) throw new Error('argv');
      tools = value.split(',');
      if (new Set(tools).size !== tools.length) throw new Error('argv');
    } else if (flag === '--thinking') { if (!['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(value)) throw new Error('argv'); }
    else if (!pairs.has(flag) || pairs.get(flag) !== value) throw new Error('argv');
  }
  for (const flag of [...singles, ...pairs.keys()]) if (!seen.has(flag)) throw new Error('argv');
  if (tools === undefined || (seen.has('--tools') && seen.has('--no-tools'))) throw new Error('argv');
  return tools;
}

const noBang = value => { if (typeof value === 'string') return !value.startsWith('!'); if (Array.isArray(value)) return value.every(noBang); if (isRecord(value)) return Object.values(value).every(noBang); return true; };

/** Validates the host-computed files before anything is written. A literal key, a `!command` value or a second server never passes. */
export function admitFiles(files, ctx) {
  const { paths, credentialEnv, token, tools, providerId, model, shim, node } = ctx;
  if (!isRecord(files) || Object.keys(files).sort().join(',') !== 'mcp,models,settings,systemPrompt' || Object.values(files).some(value => typeof value !== 'string')) throw new Error('files');
  if (files.settings !== SETTINGS || !files.systemPrompt || Buffer.byteLength(files.systemPrompt) > LIMITS.line) throw new Error('files');
  const models = JSON.parse(files.models), mcp = JSON.parse(files.mcp);
  if (!noBang(models) || !noBang(mcp) || !isRecord(models) || Object.keys(models).join(',') !== 'providers') throw new Error('files');
  const providers = Object.entries(models.providers);
  if (providers.length !== 1 || providers[0][0] !== providerId) throw new Error('files');
  const provider = providers[0][1];
  if (!isRecord(provider) || provider.apiKey !== `$${credentialEnv}` || !['openai-completions', 'openai-responses', 'anthropic-messages'].includes(provider.api)
    || !Array.isArray(provider.models) || provider.models.length !== 1 || provider.models[0].id !== model || Object.keys(provider).sort().join(',') !== 'api,apiKey,baseUrl,models') throw new Error('files');
  const url = new URL(provider.baseUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('files');
  if (!isRecord(mcp) || mcp.autoEnableCodemode !== false || Object.keys(mcp).sort().join(',') !== 'autoEnableCodemode,mcpServers') throw new Error('files');
  const servers = Object.keys(mcp.mcpServers);
  if (!tools.length) { if (servers.length) throw new Error('files'); return; }
  const server = mcp.mcpServers.component;
  if (servers.join(',') !== 'component' || !isRecord(server) || Object.keys(server).sort().join(',') !== 'args,command,exposure,timeout' || server.command !== node || server.exposure !== 'direct' || server.timeout !== 30
    || JSON.stringify(server.args) !== JSON.stringify([shim, paths.socket, token])) throw new Error('files');
}

function readProc() {
  const rows = [];
  for (const name of readdirSync('/proc')) {
    if (!/^[0-9]+$/.test(name)) continue;
    try {
      const stat = readFileSync(`/proc/${name}/stat`, 'utf8');
      const close = stat.lastIndexOf(')');
      const [state, ppid, pgrp] = stat.slice(close + 2).split(' ');
      let cmdline = '', comm = '';
      try { cmdline = readFileSync(`/proc/${name}/cmdline`, 'utf8'); comm = readFileSync(`/proc/${name}/comm`, 'utf8').trim(); } catch { /* process vanished */ }
      rows.push({ pid: Number(name), ppid: Number(ppid), pgrp: Number(pgrp), state, cmdline, comm });
    } catch { /* process vanished */ }
  }
  return rows;
}
const MARKERS = ['/opt/genbi/pi-mcp-shim.mjs', '/opt/pi/'];
/** Processes still attached to this step: descendants of the worker, members of pi's process group, or anything that still runs pi or the relay
 *  (a process that left the group is found by its command line; pi renames itself, so its command name `pi` counts too). Zombies are not processes. */
export function remainingProcesses(rows, workerPid, groupLeader, markers = MARKERS) {
  const children = new Map();
  for (const row of rows) { const list = children.get(row.ppid) ?? []; list.push(row.pid); children.set(row.ppid, list); }
  const descendants = new Set(); const stack = [workerPid];
  while (stack.length) for (const pid of children.get(stack.pop()) ?? []) if (!descendants.has(pid)) { descendants.add(pid); stack.push(pid); }
  return rows.filter(row => row.pid !== workerPid && row.state !== 'Z' && (descendants.has(row.pid) || (groupLeader !== undefined && row.pgrp === groupLeader) || row.comm === 'pi' || markers.some(marker => typeof row.cmdline === 'string' && row.cmdline.includes(marker)))).length;
}

export async function runPiWorker(ctx) {
  const { stdin, stdout, env, roots } = ctx;
  const listProcesses = ctx.listProcesses ?? readProc;
  let outputBytes = 0, frames = 0, finished = false;
  let child, shimConn, server, helloDone = false, paths, boot, tools, token, staged, trust;
  let piExited = false, piResult, settledForwarded = false, endReceived = false, stage = 'bootstrap';
  const timers = [];
  const send = line => new Promise(resolve => {
    outputBytes += Buffer.byteLength(line) + 1;
    if (outputBytes > LIMITS.total || ++frames > LIMITS.frames) { fatal('overload'); resolve(); return; }
    stdout.write(line + '\n', () => resolve());
  });
  const killGroup = signal => { if (child?.pid) { try { process.kill(-child.pid, signal); } catch { /* group already gone */ } } };
  const finish = async code => { if (finished) return; finished = true; for (const timer of timers) clearTimeout(timer); try { trust?.close(); } catch { /* closing */ } try { server?.close(); shimConn?.destroy(); } catch { /* closing */ } ctx.exit(code); };
  const fatal = tag => { if (finished) return; process.stderr.write('worker ' + tag + '\n'); killGroup('SIGKILL'); void finish(70); };
  timers.push(setTimeout(() => fatal('deadline'), LIMITS.deadlineMs));

  const lines = onLine => {
    let pending = Buffer.alloc(0);
    return chunk => {
      pending = Buffer.concat([pending, chunk]); let at;
      while ((at = pending.indexOf(10)) >= 0) { const line = pending.subarray(0, at); pending = pending.subarray(at + 1); if (line.length > LIMITS.line) { fatal('overload'); return; } onLine(line); }
      if (pending.length > LIMITS.line) fatal('overload');
    };
  };

  async function maybeFinalize() {
    if (finished || !piExited || stage === 'bootstrap') return;
    if (!endReceived && settledForwarded) return;
    let remaining = 0;
    for (let attempt = 0; attempt < 20; attempt++) { remaining = remainingProcesses(listProcesses(), process.pid, child?.pid, ctx.markers); if (!remaining) break; killGroup('SIGKILL'); await new Promise(resolve => setTimeout(resolve, 100)); }
    await send(JSON.stringify({ t: 'exit', scope: boot.scope, code: piResult.code, signal: piResult.signal, forced: piResult.forced, remaining }));
    await finish(0);
  }

  function onHostFrame(line) {
    let frame;
    try { frame = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line)); } catch { fatal('frame'); return; }
    if (!isRecord(frame)) { fatal('frame'); return; }
    if (stage === 'staged') {
      if (frame.t !== 'input' || typeof frame.text !== 'string' || Object.keys(frame).length !== 2) { fatal('frame'); return; }
      stage = 'running'; startPi(frame.text); return;
    }
    if (stage !== 'running') { fatal('frame'); return; }
    if (frame.t === 'mcp' && isRecord(frame.m) && Object.keys(frame).length === 2) {
      if (!shimConn || !helloDone || shimConn.destroyed) { fatal('channel'); return; }
      shimConn.write(JSON.stringify(frame.m) + '\n'); return;
    }
    if (frame.t === 'end' && Object.keys(frame).length === 1 && !endReceived) {
      endReceived = true;
      timers.push(setTimeout(() => { if (!piExited) { piResult = { ...(piResult ?? {}), forced: true }; killGroup('SIGTERM'); timers.push(setTimeout(() => killGroup('SIGKILL'), 2000)); } }, LIMITS.exitWaitMs));
      void maybeFinalize(); return;
    }
    fatal('frame');
  }

  function startPi(text) {
    if (!layoutUnchanged()) { fatal('layout'); return; }
    try { trust.assertCurrent(); } catch { fatal('trust'); return; }
    const input = Buffer.from(text, 'utf8');
    const env2 = { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: paths.home, TMPDIR: paths.tmp, LANG: 'C.UTF-8', PI_CODING_AGENT_DIR: paths.agent, PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1', PI_TELEMETRY: '0' };
    for (const name of PASS) if (env[name] !== undefined) env2[name] = env[name];
    Object.assign(env2, trust.environment);
    env2[boot.credentialEnv] = env[boot.credentialEnv];
    child = spawn(roots.pi.command, [...roots.pi.prefix, ...boot.argv], { cwd: paths.cwd, env: env2, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    child.on('error', () => fatal('spawn'));
    child.stdin.on('error', () => {});
    child.stdin.end(input);
    void send(JSON.stringify({ t: 'started', scope: boot.scope, inputSha256: sha256(input) }));
    child.stdout.on('data', lines(line => {
      if (finished) return;
      let event;
      try { event = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line)); } catch { fatal('pi_output'); return; }
      if (!isRecord(event) || typeof event.type !== 'string') { fatal('pi_output'); return; }
      const role = isRecord(event.message) ? event.message.role : undefined;
      const forward = (event.type === 'message_end' && (role === 'system' || role === 'assistant')) || event.type === 'tool_execution_start' || event.type === 'agent_settled';
      if (!forward) return;
      if (event.type === 'agent_settled') settledForwarded = true;
      void send('{"t":"pi","e":' + line.toString('utf8') + '}');
    }));
    child.stderr.on('data', () => {});
    child.on('close', (code, signal) => {
      piExited = true; piResult = { code, signal: signal ?? null, forced: piResult?.forced === true };
      void maybeFinalize();
    });
  }

  async function bootstrap(chunk) {
    // Exactly the length-prefixed bootstrap is consumed here; later bytes belong to the frame reader.
    bootBuffer = Buffer.concat([bootBuffer, chunk]);
    if (bootBuffer.length < 4) return false;
    const length = bootBuffer.readUInt32BE(0);
    if (length < 1 || length > LIMITS.bootstrap) { fatal('bootstrap'); return true; }
    if (bootBuffer.length < 4 + length) return false;
    const rest = bootBuffer.subarray(4 + length);
    try {
      boot = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bootBuffer.subarray(4, 4 + length)));
      if (!isRecord(boot) || Object.keys(boot).sort().join(',') !== 'argv,credentialEnv,files,protocol,scope,token' || boot.protocol !== 1
        || !/^[a-f0-9-]{36}$/.test(boot.scope) || !/^[a-f0-9]{32}$/.test(boot.token) || !/^[A-Z][A-Z0-9_]{0,63}$/.test(boot.credentialEnv)) throw new Error('bootstrap');
      token = boot.token; paths = stepPaths(roots.steps, boot.scope);
      const providerId = boot.argv[boot.argv.indexOf('--provider') + 1], model = boot.argv[boot.argv.indexOf('--model') + 1];
      tools = admitArgv(boot.argv, paths, providerId, model);
      admitFiles(boot.files, { paths, credentialEnv: boot.credentialEnv, token, tools, providerId, model, shim: roots.shim, node: roots.node });
      if (typeof env[boot.credentialEnv] !== 'string' || !PLACEHOLDER.test(env[boot.credentialEnv])) throw new Error('credential');
      // Same trust admission as the Claude worker: both CA variables unset, or exactly the supervisor material after the full layout/ownership/PEM/read-only checks.
      trust = (ctx.caTrust ?? supervisorCaTrust)(env);
      // Layout: one 0700 directory per step; pi sees exactly the three agent-dir files, an empty cwd and a disposable HOME.
      mkdirSync(roots.steps, { recursive: true, mode: 0o700 });
      mkdirSync(paths.base, { mode: 0o700 });
      for (const directory of [paths.agent, paths.cwd, paths.home, paths.tmp]) mkdirSync(directory, { mode: 0o700 });
      for (const [name, content] of [[`${paths.agent}/settings.json`, boot.files.settings], [`${paths.agent}/models.json`, boot.files.models], [`${paths.agent}/mcp.json`, boot.files.mcp], [paths.prompt, boot.files.systemPrompt]]) writeFileSync(name, content, { mode: 0o600, flag: 'wx' });
      if (readdirSync(paths.agent).sort().join(',') !== 'mcp.json,models.json,settings.json' || readdirSync(paths.cwd).length || readdirSync(paths.home).length || readdirSync(paths.tmp).length) throw new Error('layout');
      process.umask(0o077);
      if (tools.length) await listen();
      staged = digestsOnDisk();
      stage = 'staged';
      await send(JSON.stringify({ t: 'staged', protocol: 1, scope: boot.scope, digests: staged }));
    } catch (error) { fatal('bootstrap ' + (error instanceof Error ? error.message : 'invalid')); return true; }
    if (rest.length) frameReader(rest);
    return true;
  }
  // What pi will read, exactly as it is on disk right now. Checked once when staged and again immediately before pi starts.
  function digestsOnDisk() {
    return { argv: sha256(JSON.stringify(boot.argv)), settings: sha256(readFileSync(`${paths.agent}/settings.json`)), models: sha256(readFileSync(`${paths.agent}/models.json`)), mcp: sha256(readFileSync(`${paths.agent}/mcp.json`)), prompt: sha256(readFileSync(paths.prompt)) };
  }
  function layoutUnchanged() {
    try {
      return readdirSync(paths.agent).sort().join(',') === 'mcp.json,models.json,settings.json' && !readdirSync(paths.cwd).length && !readdirSync(paths.home).length
        && JSON.stringify(digestsOnDisk()) === JSON.stringify(staged);
    } catch { return false; }
  }
  let bootBuffer = Buffer.alloc(0);
  let frameReader = () => {};

  function listen() {
    return new Promise((resolve, reject) => {
      server = net.createServer(connection => {
        if (shimConn) { connection.destroy(); return; }
        shimConn = connection; server.close();
        let seen = 0;
        connection.on('error', () => {});
        connection.on('data', lines(line => {
          if (finished) return;
          if (!helloDone) {
            try { const value = JSON.parse(line.toString('utf8')); const given = Buffer.from(String(value?.hello), 'utf8'), want = Buffer.from(token, 'utf8'); if (Object.keys(value).join(',') !== 'hello' || given.length !== want.length || !timingSafeEqual(given, want)) throw new Error(); helloDone = true; } catch { fatal('shim_hello'); }
            return;
          }
          let message;
          try { message = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line)); } catch { fatal('shim_frame'); return; }
          if (!isRecord(message) || ++seen > LIMITS.frames) { fatal('shim_frame'); return; }
          void send(JSON.stringify({ t: 'mcp', m: message }));
        }));
      });
      server.once('error', reject);
      server.listen(paths.socket, () => {
        try { chmodSync(paths.socket, 0o600); const stat = lstatSync(paths.socket); if (!stat.isSocket() || (stat.mode & 0o777) !== 0o600) throw new Error('socket'); resolve(); } catch (error) { reject(error); }
      });
    });
  }

  frameReader = lines(onHostFrame);
  let started = false;
  stdin.on('data', chunk => {
    if (finished) return;
    if (!started) { started = true; timers.push(setTimeout(() => { if (stage === 'bootstrap') fatal('bootstrap_deadline'); }, 15000)); }
    if (stage === 'bootstrap') void bootstrap(chunk); else frameReader(chunk);
  });
  // The duplex closing before the in-band end is cancellation: nothing may outlive the transport.
  const cancelled = () => { if (finished || endReceived) return; killGroup('SIGKILL'); void finish(1); };
  stdin.on('end', cancelled); stdin.on('close', cancelled); stdin.on('error', cancelled);
}
