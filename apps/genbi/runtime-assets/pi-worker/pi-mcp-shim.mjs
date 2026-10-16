// stdio MCP relay launched by pi. It forwards JSON lines between pi and the worker's per-step unix socket and does nothing else:
// no network, no environment access, no logging, and only the worker's socket is accepted.
import net from 'node:net';
import { lstatSync } from 'node:fs';
import path from 'node:path';

const MAX_LINE = 2097152;
const [socketPath, token] = process.argv.slice(2);
const bail = () => process.exit(1);
if (process.argv.length !== 4 || !/^\/[A-Za-z0-9/_.-]{1,200}\/[a-f0-9-]{36}\/mcp\.sock$/.test(socketPath ?? '') || !/^[a-f0-9]{32}$/.test(token ?? '')) bail();
try {
  const directory = lstatSync(path.dirname(socketPath)), socket = lstatSync(socketPath), uid = process.getuid();
  if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== uid || (directory.mode & 0o777) !== 0o700
    || !socket.isSocket() || socket.uid !== uid || (socket.mode & 0o777) !== 0o600) bail();
} catch { bail(); }

process.stdout.on('error', bail);
const connection = net.connect({ path: socketPath });
connection.on('error', bail);
connection.on('close', () => process.exit(0));
connection.on('connect', () => {
  connection.write(JSON.stringify({ hello: token }) + '\n');
  let pending = Buffer.alloc(0);
  process.stdin.on('data', chunk => {
    pending = Buffer.concat([pending, chunk]);
    let at;
    while ((at = pending.indexOf(10)) >= 0) {
      const line = pending.subarray(0, at + 1); pending = pending.subarray(at + 1);
      if (line.length > MAX_LINE) bail();
      connection.write(line);
    }
    if (pending.length > MAX_LINE) bail();
  });
  process.stdin.on('end', () => connection.end());
  connection.on('data', chunk => process.stdout.write(chunk));
});
