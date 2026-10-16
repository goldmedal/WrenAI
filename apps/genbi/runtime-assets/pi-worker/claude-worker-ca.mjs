import fs from 'node:fs';
import { randomUUID, X509Certificate } from 'node:crypto';

const material = '/run/openshell-supervisor-ca/material';
const certificate = material + '/ca.crt';
const bundle = material + '/ca-bundle.crt';
const layout = [
  ['/', 0, 0, 0o755, true],
  ['/run', 0, 0, 0o755, true],
  ['/run/openshell-supervisor-ca', 0, 0, 0o755, true],
  [material, 1500, 1500, 0o755, true],
  [certificate, 1500, 1500, 0o444, false],
  [bundle, 1500, 1500, 0o444, false],
];
const deny = () => { throw Error('worker trust admission'); };
const identity = s => [s.dev, s.ino, s.uid, s.gid, s.mode, s.size];
const same = (a, b) => identity(a).every((value, index) => value === identity(b)[index]);

// Requires the pinned supervisor's hard-requirement Landlock policy. Its CA
// material is workload-owned, but effective read-only rules prohibit mutation.
// io is an explicit deterministic-test seam, never selected by worker input.
export function supervisorCaTrust(environment, io = fs, uid = process.getuid(), gid = process.getgid()) {
  if (['NODE_TLS_REJECT_UNAUTHORIZED', 'BUN_TLS_REJECT_UNAUTHORIZED'].some(key => environment[key] !== undefined && environment[key] !== '1')) deny();
  const supplied = [environment.NODE_EXTRA_CA_CERTS, environment.SSL_CERT_FILE];
  if (supplied.every(value => value === undefined)) return { environment: Object.freeze({}), assertCurrent() {}, close() {} };
  if (supplied[0] !== certificate || supplied[1] !== bundle || uid !== 1500 || gid !== 1500) deny();
  const descriptors = [];
  let snapshots;
  let closed = false;
  const close = () => { if (!closed) { closed = true; for (const fd of descriptors) io.closeSync(fd); } };
  function inspect() {
    return layout.map(([path, owner, group, mode, directory]) => {
      const s = io.lstatSync(path);
      if (s.isSymbolicLink() || io.realpathSync(path) !== path || s.uid !== owner || s.gid !== group || (s.mode & 0o7777) !== mode
        || (directory ? !s.isDirectory() : !s.isFile())) deny();
      return s;
    });
  }
  function read(path, maximum, original) {
    if (original.size < 1 || original.size > maximum) deny();
    const fd = io.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    descriptors.push(fd);
    if (!same(original, io.fstatSync(fd)) || !same(original, io.lstatSync(path))) deny();
    const bytes = Buffer.alloc(original.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const length = io.readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!length) break;
      offset += length;
    }
    if (offset !== original.size || !same(original, io.fstatSync(fd))) deny();
    return new TextDecoder('utf8', { fatal: true }).decode(bytes.subarray(0, offset));
  }
  function pem(text) {
    const entries = text.match(/-----BEGIN CERTIFICATE-----[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----/g) ?? [];
    if (!entries.length || entries.length > 512 || text.replace(/-----BEGIN CERTIFICATE-----[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----/g, '').trim()) deny();
    return entries.map(value => new X509Certificate(value));
  }
  function requireReadOnly() {
    const path = material + '/.claude-ca-readonly-' + randomUUID();
    let fd;
    try {
      fd = io.openSync(path, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600);
    } catch (error) {
      if (!['EACCES', 'EPERM', 'EROFS'].includes(error.code)) deny();
      try { io.lstatSync(path); } catch (absent) { if (absent.code === 'ENOENT') return; }
      deny();
    }
    // An unexpectedly writable directory never grants authority. Remove only
    // the exact empty inode this invocation created, then reject the launch.
    try {
      const opened = io.fstatSync(fd), named = io.lstatSync(path);
      if (!opened.isFile() || opened.uid !== uid || opened.gid !== gid || opened.size !== 0 || named.isSymbolicLink() || !same(opened, named)) deny();
      io.unlinkSync(path);
    } finally { io.closeSync(fd); }
    deny();
  }
  const assertCurrent = () => {
    if (closed) deny();
    const current = inspect();
    if (!current.every((value, index) => same(value, snapshots[index]))) deny();
    if (!descriptors.every((fd, index) => same(io.fstatSync(fd), snapshots[index + 4]))) deny();
  };
  try {
    snapshots = inspect();
    const own = pem(read(certificate, 65_536, snapshots[4]));
    const roots = pem(read(bundle, 1_048_576, snapshots[5]));
    if (own.length !== 1 || !own[0].ca || !roots.some(value => value.raw.equals(own[0].raw))) deny();
    requireReadOnly();
    assertCurrent();
    return { environment: Object.freeze({ NODE_EXTRA_CA_CERTS: certificate, SSL_CERT_FILE: bundle }), assertCurrent, close };
  } catch { close(); deny(); }
}
