// Host-only fixed control operation. No model tool exposes this entrypoint.
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
export function ownedDirectory(directory) {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== 1500 || (stat.mode & 0o777) !== 0o700 || fs.realpathSync(directory) !== directory) throw Error('ownership');
}
function readIdentity(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) throw Error('identity');
  const raw = fs.readFileSync('/proc/' + pid + '/stat', 'utf8');
  const stat = fs.statSync('/proc/' + pid);
  const values = raw.slice(raw.lastIndexOf(')') + 2).trim().split(/\s+/);
  const value = { pid, parent: Number(values[1]), group: Number(values[2]), start: values[19], state: values[0], uid: stat.uid };
  if (!/^\d+$/.test(value.start) || !Number.isSafeInteger(value.group) || !Number.isSafeInteger(value.parent)) throw Error('identity');
  return value;
}
export function procIdentity(pid) { const value = readIdentity(pid); if (value.uid !== 1500) throw Error('identity'); return value; }
function inventory() {
  const found = [];
  for (const name of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    try { if (fs.statSync('/proc/' + name).uid === 1500) found.push(procIdentity(Number(name))); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (found.length > 256) throw Error('overload');
  }
  return found;
}
function helperLineage() {
  const found = new Map(); let pid = process.pid;
  for (let n = 0; pid > 0 && n < 64; n++) {
    const value = readIdentity(pid);
    if (found.has(pid)) throw Error('lineage'); found.set(pid, value.start);
    if (pid === 1) return found; pid = value.parent;
  }
  if (pid > 0) throw Error('lineage'); return found;
}
function admittedHelper() {
  if (process.platform !== 'linux' || process.getuid() !== 1500 || !/^NoNewPrivs:\s+1$/m.test(fs.readFileSync('/proc/self/status', 'utf8'))) throw Error('identity');
}
function validateBaseline(value) {
  if (!value || Object.keys(value).sort().join(',') !== 'processes,type,version' || value.type !== 'genbi.session.baseline' || value.version !== 1
    || !Array.isArray(value.processes) || value.processes.length > 256) throw Error('baseline');
  const found = new Map();
  for (const row of value.processes) {
    if (!row || Object.keys(row).sort().join(',') !== 'pid,start' || !Number.isSafeInteger(row.pid) || row.pid < 1 || !/^\d+$/.test(row.start) || found.has(row.pid)) throw Error('baseline');
    found.set(row.pid, row.start);
  }
  return found;
}
export function captureBaseline() {
  admittedHelper(); const lineage = helperLineage();
  return { type: 'genbi.session.baseline', version: 1, processes: inventory().filter(value => !lineage.has(value.pid)).map(({ pid, start }) => ({ pid, start })).sort((a, b) => a.pid - b.pid) };
}
export function checkBaseline(baseline) {
  admittedHelper(); const approved = validateBaseline(baseline), lineage = helperLineage();
  const unknown = [];
  for (const value of inventory()) {
    if (approved.has(value.pid) && approved.get(value.pid) !== value.start) throw Error('recycled baseline');
    if (approved.get(value.pid) !== value.start && lineage.get(value.pid) !== value.start) unknown.push(value);
  }
  return unknown;
}
export async function cleanupStep(receipt, baseline, timeout = 4000) {
  if (process.platform !== 'linux' || process.getuid() !== 1500 || !receipt || Object.keys(receipt).sort().join(',') !== 'group,pid,start,step,type,version'
    || receipt.type !== 'genbi.step' || receipt.version !== 1 || !/^[a-f0-9-]{36}$/.test(receipt.step)
    || !Number.isSafeInteger(receipt.pid) || receipt.pid <= 1 || receipt.group !== receipt.pid || !/^\d+$/.test(receipt.start)
    || !Number.isSafeInteger(timeout) || timeout < 1 || timeout > 4000) throw Error('identity');
  const root = '/sandbox/steps/' + receipt.step;
  ownedDirectory('/sandbox/steps'); ownedDirectory(root);
  const until = Date.now() + timeout;
  for (;;) {
    if (Date.now() >= until) throw Error('deadline');
    let leader;
    try { leader = procIdentity(receipt.pid); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (leader && (leader.group !== receipt.group || leader.start !== receipt.start)) throw Error('identity');
    const processes = checkBaseline(baseline);
    if (processes.some(value => BigInt(value.start) < BigInt(receipt.start))) throw Error('identity');
    if (processes.length === 0) {
      const marker = root + '/settled.json';
      if (!fs.existsSync(marker)) { await new Promise(resolve => setTimeout(resolve, 25)); continue; }
      const stat = fs.lstatSync(marker);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== 1500 || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600 || stat.size > 512) throw Error('settlement');
      const settlement = JSON.parse(fs.readFileSync(marker, 'utf8'));
      if (Object.keys(settlement).sort().join(',') !== 'group,outcome,pid,start,step,type,version' || settlement.outcome !== 'normal'
        || Object.keys(receipt).some(key => settlement[key] !== receipt[key])) throw Error('settlement');
      ownedDirectory(root); fs.rmSync(root, { recursive: true });
      if (fs.existsSync(root) || checkBaseline(baseline).length) throw Error('cleanup');
      return { type: 'genbi.step.cleaned', version: 1, step: receipt.step, pid: receipt.pid, group: receipt.group, start: receipt.start, remaining: 0 };
    }
    // Group signaling is deliberately denied by OpenShell's child seccomp filter.
    // This helper observes only. Any retained process at the bound requires exact
    // whole-sandbox teardown, never a best-effort numeric PID kill or step reuse.
    if (Date.now() >= until) throw Error('deadline');
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length === 3 && process.argv[2] === '--baseline') console.log(JSON.stringify(captureBaseline()));
    else if (process.argv.length === 4 && process.argv[2] === '--check' && Buffer.byteLength(process.argv[3]) <= 16384) {
      if (checkBaseline(JSON.parse(process.argv[3])).length) throw Error('unknown process');
      console.log(JSON.stringify({ type: 'genbi.session.checked', version: 1, remaining: 0 }));
    } else {
      if (process.argv.length !== 3 || Buffer.byteLength(process.argv[2]) > 16384) throw Error('input');
      const input = JSON.parse(process.argv[2]); if (Object.keys(input).sort().join(',') !== 'baseline,receipt') throw Error('input');
      console.log(JSON.stringify(await cleanupStep(input.receipt, input.baseline)));
    }
  } catch { process.stderr.write('step cleanup unavailable\n'); process.exitCode = 70; }
}
