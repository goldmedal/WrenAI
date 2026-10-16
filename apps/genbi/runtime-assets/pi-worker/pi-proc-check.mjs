// Reads /proc and reports how many pi step processes (worker, tool relay, pi itself) are still alive. Used after a cancellation, before teardown.
// pi renames itself (command line `pi`, command name `pi`), so its command name counts alongside the path markers.
import { readFileSync, readdirSync } from 'node:fs';

const MARKERS = ['/opt/genbi/pi-worker.mjs', '/opt/genbi/pi-mcp-shim.mjs', '/opt/pi/'];
let remaining = 0;
for (const name of readdirSync('/proc')) {
  if (!/^[0-9]+$/.test(name) || Number(name) === process.pid) continue;
  try {
    const stat = readFileSync(`/proc/${name}/stat`, 'utf8');
    if (stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3) === 'Z') continue;
    const command = readFileSync(`/proc/${name}/cmdline`, 'utf8');
    const comm = readFileSync(`/proc/${name}/comm`, 'utf8').trim();
    if (comm === 'pi' || MARKERS.some(marker => command.includes(marker))) remaining++;
  } catch { /* process vanished */ }
}
process.stdout.write(JSON.stringify({ type: 'genbi.pi.procs', version: 1, remaining }) + '\n');
