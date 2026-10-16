// Deterministic stand-in for the supervisor CA material and the filesystem seam `supervisorCaTrust` reads it through.
// Logical owners are supplied by the seam only; real Linux owner/mode behaviour has separate runtime gates.
import fs from 'node:fs';
import path from 'node:path';

export const certificate = '/run/openshell-supervisor-ca/material/ca.crt';
export const bundle = '/run/openshell-supervisor-ca/material/ca-bundle.crt';
export const material = path.dirname(certificate);
export const caPem = `-----BEGIN CERTIFICATE-----
MIIC0jCCAbqgAwIBAgIJAKcLMFcQnOwOMA0GCSqGSIb3DQEBCwUAMB4xHDAaBgNV
BAMME3N5bnRoZXRpYy13b3JrZXItY2EwHhcNMjYxMDAyMDkxMzMwWhcNMzYwOTI5
MDkxMzMwWjAeMRwwGgYDVQQDDBNzeW50aGV0aWMtd29ya2VyLWNhMIIBIjANBgkq
hkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAzZYPESe+Sm8T6TSHGPhobJRHBIR3BjkI
IzuyqBral7JclpzeOPQq3//kklwXb606UXa/BfB/3g0vQSd4OM46LahkkKu7YX+L
FKGDzj9AjkZPAT2M4xs+L7iKQRM64gsudBj9815pU8K/LEHJnQSSov+iUx8apL1f
mjNKA4z9ycLgwZHZacSfiPMDVXzNjKh/MrSP7jRt5Z5JRyOmlIvH48yiEQAa/TMS
m2qgUfuDAuV5iMOlVqQfj93f9jh53aBxeXP3FJcKq2uO1InmMM+KQgMoEcOVepcU
qPIld8Yu4w3bQIYB1tpiTlvBUNrmCtz19Recpl1jTXJgtfi0UNqYDwIDAQABoxMw
ETAPBgNVHRMBAf8EBTADAQH/MA0GCSqGSIb3DQEBCwUAA4IBAQAHlRfQom7HtnlQ
/MRaqKV9XNOngeKstJNzc0AC3xd+QIQZRLTrfCNv3ECWrDJ/QsKSimE9FnhQ4XEW
N+AIrDlzzYawKFaueT6nuEagUzoszk+QG32PvGXUtiNY/w95wsYD/glO0YSgTFTZ
aYZzL9azhrUhJiaW85kyIQ5UoMy/QqShtk6h2q50RJ4oy0uyFDgaZ+oNsBD4gjYI
xrthkuj7kYYo3VnQwv+yJdGNcCA9nAkHk2rc2hxibBGmuLLf4Ck2vacB1fRCe4OC
2GwV0r4g3Ren4SMGsgGzuYR7fXwaXDD8RhTFZD9nS8XZgHDZ32R2H4rAoMMF7wK2
UEIG2MXo
-----END CERTIFICATE-----
`;

/** Writes the material under `root` (a stand-in for `/`) with the modes the module demands. */
export function writeMaterial(root) {
  fs.chmodSync(root, 0o755);
  const map = (p) => path.join(root, p);
  for (const p of ['/run', '/run/openshell-supervisor-ca', material, '/sandbox']) fs.mkdirSync(map(p), { recursive: true, mode: 0o755 });
  fs.writeFileSync(map(certificate), caPem, { mode: 0o444 });
  fs.writeFileSync(map(bundle), caPem, { mode: 0o444 });
  return map;
}

/** `change(path, stats, kind)` may adjust what the seam reports (owner, mode, inode). Paths outside the material are root-owned. */
export function makeIo(root, change = () => {}) {
  const map = (p) => path.join(root, p);
  const descriptors = new Map();
  const stats = (p, s, kind) => { s.uid = p.startsWith(material) ? 1500 : 0; s.gid = s.uid; change(p, s, kind); return s; };
  const io = {
    lstatSync: (p) => stats(p, fs.lstatSync(map(p)), 'path'),
    realpathSync: (p) => '/' + path.relative(root, fs.realpathSync(map(p))),
    openSync(p, flags, mode) {
      // The read-only probe must be refused, as on a real read-only mount.
      if (p.includes('/.claude-ca-readonly-')) throw Object.assign(Error('synthetic'), { code: 'EACCES' });
      const fd = fs.openSync(map(p), flags, mode); descriptors.set(fd, p); return fd;
    },
    fstatSync: (fd) => stats(descriptors.get(fd), fs.fstatSync(fd), 'fd'),
    readSync: fs.readSync,
    closeSync(fd) { descriptors.delete(fd); fs.closeSync(fd); },
    unlinkSync: (p) => fs.unlinkSync(map(p)),
  };
  return Object.assign(io, { descriptors });
}
