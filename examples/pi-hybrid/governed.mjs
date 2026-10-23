import { spawn } from 'node:child_process';
import { isAbsolute, join } from 'node:path';

// One bounded Wren process per operation. This module never accepts model-selected
// executables, paths, environment variables or command-line flags.
export function governed(binding, operation, signal = new AbortController().signal) {
  if (process.platform === 'win32' || ![binding.executable, binding.project, binding.home].every(isAbsolute)) {
    return Promise.reject(new Error('query_unavailable'));
  }
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(binding.executable, ['governed-stdio', '--project', binding.project], {
      cwd: binding.home, detached: true, stdio: ['pipe', 'pipe', 'pipe'],
      env: { HOME: binding.home, WREN_HOME: join(binding.home, '.wren'),
        LANG: 'C.UTF-8', PYTHONIOENCODING: 'utf-8', PYTHONNOUSERSITE: '1' },
    });
    let output = '', size = 0, failed = false;
    const kill = () => { if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} } };
    const fail = () => { failed = true; kill(); };
    const timer = setTimeout(fail, 10000);
    signal.addEventListener('abort', fail, { once: true });
    if (signal.aborted) fail();
    const consume = chunk => { size += chunk.length; if (size > 1048576) fail(); };
    child.stdout.on('data', chunk => { consume(chunk); if (!failed) output += chunk.toString('utf8'); });
    child.stderr.on('data', consume); // never forward stderr, even on exit 0
    child.on('error', fail);
    child.stdin.on('error', fail);
    child.on('exit', kill);
    child.on('close', code => {
      clearTimeout(timer); signal.removeEventListener('abort', fail); kill();
      try {
        if (failed || signal.aborted || code !== 0 || !output.endsWith('\n')) throw Error();
        const lines = output.trimEnd().split('\n').map(line => JSON.parse(line));
        if (lines.length !== 2 || JSON.stringify(lines[0]) !== '{"id":0,"protocol":"wren-governed/2"}'
          || Object.keys(lines[1]).sort().join(',') !== 'id,result' || lines[1].id !== 1) throw Error();
        resolve(lines[1].result);
      } catch { reject(new Error('query_unavailable')); }
    });
    child.stdin.end(JSON.stringify({ ...operation, id: 1 }) + '\n');
  });
}
