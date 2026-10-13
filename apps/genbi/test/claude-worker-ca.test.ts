import { afterEach, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

const asset = path.resolve(import.meta.dirname, "../runtime-assets/claude-worker");
const { supervisorCaTrust } = await import(pathToFileURL(path.join(asset, "claude-worker-ca.mjs")).href);
const certificate = "/run/openshell-supervisor-ca/material/ca.crt";
const bundle = "/run/openshell-supervisor-ca/material/ca-bundle.crt";
const material = path.dirname(certificate);
const validEnv = { NODE_EXTRA_CA_CERTS: certificate, SSL_CERT_FILE: bundle };
const caPem = `-----BEGIN CERTIFICATE-----
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
const leafPem = `-----BEGIN CERTIFICATE-----
MIIC0zCCAbugAwIBAgIJAJ7QNZby1dHTMA0GCSqGSIb3DQEBCwUAMCAxHjAcBgNV
BAMMFXN5bnRoZXRpYy13b3JrZXItbGVhZjAeFw0yNjEwMDIwOTEzMzBaFw0zNjA5
MjkwOTEzMzBaMCAxHjAcBgNVBAMMFXN5bnRoZXRpYy13b3JrZXItbGVhZjCCASIw
DQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEBAPP6QfvsOqIuiAoTQ/UyNDDfvlWO
Cw0pExxza8Ya4jHMAwPY0gaJGHYp9Qx0M+/SbzmzGuAFWEyLQs8eEUiaW6X8iCbH
iGyY/iQMYo+Rf0p+4NjdgGaqSRuC38Knz+eaRjGeOLVZvYCMcfUVvSv2TsMEhfE3
k47S/f+FqQTLeNuBZ1EIQBfKZydGLDJBHNoym5/kSnl2ICveqhLYDKNmpNkeEhO0
Yx8mY0sCOSjzGNNHW/0NKNduLVsvxFQlyIODS8el08vzkwS28z3Glh8hNKLCzDMW
F4+ZzssQcTroOEZaaEX6l2W5MUjQ8yjVkC/AM3N2fiGQg+frQYAqnQ3scrUCAwEA
AaMQMA4wDAYDVR0TAQH/BAIwADANBgkqhkiG9w0BAQsFAAOCAQEAdvFTwET8ElEu
ssr8pmQn6m1i+mrtBd922jlLRZwBZLa74gmr9PR7wiywRYt1Nslp9mleReEaarbC
Yag8vDd2MCayxOZJ2jH2XylIcqhPZrhiUVJ0/pECPU1BbB6v6hV/LeB3CLrbPVWC
XJ0SROSMJRVJxxw7ZEfmtjFJ61PxG2Zw9GwD7kVrR0CD/G/M7UZD7Op79MRDCk2M
2R0/xr9hTv8U5Z6sHe20WYAEowCWwj31LnX5qjK1PLttr+20FjRYH9XG2vLoaBil
4njwDsNHijHj3VdcnjCZkbYD1Nmui9CbRxouFZmPUgZHpVQJNuWyeiGh9OxUgE0U
gMg6TWOFaA==
-----END CERTIFICATE-----
`;
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "claude-ca-test-"))); roots.push(root);
  fs.chmodSync(root, 0o755);
  const map = (p: string) => path.join(root, p);
  for (const p of ["/run", "/run/openshell-supervisor-ca", material, "/sandbox"]) fs.mkdirSync(map(p), { recursive: true, mode: 0o755 });
  fs.writeFileSync(map(certificate), caPem, { mode: 0o444 });
  fs.writeFileSync(map(bundle), caPem + leafPem, { mode: 0o444 });
  const descriptors = new Map<number, string>();
  const unlinks: string[] = [];
  let blocked = true, permission = "EACCES", sentinelVisible = false, replacedSentinel = false;
  let change: (p: string, s: fs.Stats, kind: string) => void = () => {};
  const stats = (p: string, s: fs.Stats, kind: string) => {
    const workloadOwned = p.startsWith(material); s.uid = workloadOwned ? 1500 : 0; s.gid = s.uid;
    change(p, s, kind); return s;
  };
  const io = {
    lstatSync(p: string) {
      if (p.includes("/.claude-ca-readonly-") && (sentinelVisible || replacedSentinel)) return stats(p, fs.lstatSync(map(certificate)), "path");
      return stats(p, fs.lstatSync(map(p)), "path");
    },
    realpathSync(p: string) { const real = fs.realpathSync(map(p)); return "/" + path.relative(root, real); },
    openSync(p: string, flags: number, mode?: number) {
      if (p.includes("/.claude-ca-readonly-") && blocked) throw Object.assign(Error("synthetic"), { code: permission });
      const fd = fs.openSync(map(p), flags, mode); descriptors.set(fd, p); return fd;
    },
    fstatSync(fd: number) { return stats(descriptors.get(fd)!, fs.fstatSync(fd), "fd"); },
    readSync: fs.readSync,
    closeSync(fd: number) { descriptors.delete(fd); fs.closeSync(fd); },
    unlinkSync(p: string) { unlinks.push(p); fs.unlinkSync(map(p)); },
  };
  // The logical trusted owners are supplied by this deterministic FS seam only;
  // actual Linux owner/mode and Landlock behavior have separate runtime gates.
  return { root, map, io, descriptors, unlinks,
    set writable(v: boolean) { blocked = !v; }, set error(v: string) { permission = v; },
    set visible(v: boolean) { sentinelVisible = v; }, set replaced(v: boolean) { replacedSentinel = v; },
    set mutate(fn: typeof change) { change = fn; },
    write(p: string, text: string) { fs.chmodSync(map(p), 0o644); fs.writeFileSync(map(p), text); fs.chmodSync(map(p), 0o444); },
  };
}

it("preserves only both fixed CA variables after no-follow material/readonly validation", () => {
  const f = fixture();
  const trust = supervisorCaTrust({ ...validEnv, HTTP_PROXY: "http://ambient.test", HTTPS_PROXY: "http://ambient.test", DENO_CERT: "/ambient", SSL_CERT_DIR: "/ambient", NODE_OPTIONS: "--trace-warnings" }, f.io, 1500, 1500);
  expect(trust.environment).toEqual(validEnv); trust.assertCurrent(); trust.close(); expect(f.descriptors.size).toBe(0);
});
it("absent CA preserves bootstrap compatibility without reading ambient material", () => {
  const trust = supervisorCaTrust({}, { lstatSync() { throw Error("must not read"); } }, 1500, 1500);
  expect(trust.environment).toEqual({}); trust.assertCurrent(); trust.close();
});
it.each([{ NODE_EXTRA_CA_CERTS: certificate }, { SSL_CERT_FILE: bundle }, { NODE_EXTRA_CA_CERTS: "/sandbox/ca.crt", SSL_CERT_FILE: bundle }, { NODE_EXTRA_CA_CERTS: certificate, SSL_CERT_FILE: "/tmp/bundle" }])("rejects partial/unexpected caller paths", environment => {
  const f = fixture(); expect(() => supervisorCaTrust(environment, f.io, 1500, 1500)).toThrow("worker trust admission"); expect(f.descriptors.size).toBe(0);
});
it.each(["0", "false", "", "off"])("rejects insecure TLS setting %s even without CA", value => {
  expect(() => supervisorCaTrust({ NODE_TLS_REJECT_UNAUTHORIZED: value }, {}, 1500, 1500)).toThrow("worker trust admission");
  expect(() => supervisorCaTrust({ BUN_TLS_REJECT_UNAUTHORIZED: value }, {}, 1500, 1500)).toThrow("worker trust admission");
});
it.each(["uid", "gid", "mode"])("rejects untrusted CA leaf %s", field => {
  const f = fixture(); f.mutate = (p, s) => { if (p === certificate) { if (field === "mode") s.mode |= 0o200; else s[field as "uid" | "gid"] = 0; } };
  expect(() => supervisorCaTrust(validEnv, f.io, 1500, 1500)).toThrow("worker trust admission"); expect(f.descriptors.size).toBe(0);
});
it("rejects a writable/incorrect trusted ancestor", () => {
  const f = fixture(); f.mutate = (p, s) => { if (p === "/run") s.mode |= 0o022; };
  expect(() => supervisorCaTrust(validEnv, f.io, 1500, 1500)).toThrow("worker trust admission");
});
it.each([certificate, material])("rejects a symlink at fixed path %s", p => {
  const f = fixture(); const target = f.map(p) + "-real"; fs.renameSync(f.map(p), target); fs.symlinkSync(target, f.map(p));
  expect(() => supervisorCaTrust(validEnv, f.io, 1500, 1500)).toThrow("worker trust admission"); expect(f.descriptors.size).toBe(0);
});
it("rejects leaf replacement between no-follow open and fstat", () => {
  const f = fixture(); f.mutate = (p, s, kind) => { if (p === certificate && kind === "fd") s.ino++; };
  expect(() => supervisorCaTrust(validEnv, f.io, 1500, 1500)).toThrow("worker trust admission"); expect(f.descriptors.size).toBe(0);
});
it("rechecks trusted paths immediately before exec and closes held descriptors", () => {
  const f = fixture(); const trust = supervisorCaTrust(validEnv, f.io, 1500, 1500);
  f.mutate = (p, s) => { if (p === bundle) s.ino++; };
  expect(() => trust.assertCurrent()).toThrow("worker trust admission"); trust.close(); expect(f.descriptors.size).toBe(0);
});
it.each(["malformed", "not-ca", "no-own-ca", "malformed-bundle"])("rejects PEM material %s", variant => {
  const f = fixture();
  if (variant === "malformed") f.write(certificate, "not a certificate");
  if (variant === "not-ca") f.write(certificate, leafPem);
  if (variant === "no-own-ca") f.write(bundle, leafPem);
  if (variant === "malformed-bundle") f.write(bundle, caPem + "untrusted suffix");
  expect(() => supervisorCaTrust(validEnv, f.io, 1500, 1500)).toThrow("worker trust admission"); expect(f.descriptors.size).toBe(0);
});
it.each([certificate, bundle])("bounds CA file size before allocation/read %s", p => {
  const f = fixture(); f.mutate = (target, s) => { if (target === p) s.size = p === certificate ? 65_537 : 1_048_577; };
  expect(() => supervisorCaTrust(validEnv, f.io, 1500, 1500)).toThrow("worker trust admission"); expect(f.descriptors.size).toBe(0);
});
it("rejects an effectively writable directory and removes only its own empty sentinel", () => {
  const f = fixture(); f.writable = true;
  expect(() => supervisorCaTrust(validEnv, f.io, 1500, 1500)).toThrow("worker trust admission");
  expect(f.unlinks).toHaveLength(1); expect(f.unlinks[0]).toMatch(/\/\.claude-ca-readonly-[a-f0-9-]+$/); expect(fs.existsSync(f.map(f.unlinks[0]!))).toBe(false);
  expect(fs.readFileSync(f.map(certificate), "utf8")).toBe(caPem); expect(f.descriptors.size).toBe(0);
});
it("never removes a substituted sentinel inode or a real CA file", () => {
  const f = fixture(); f.writable = true; f.replaced = true;
  expect(() => supervisorCaTrust(validEnv, f.io, 1500, 1500)).toThrow("worker trust admission"); expect(f.unlinks).toEqual([]); expect(f.descriptors.size).toBe(0);
});
it.each(["ENOSPC", "EIO"])("does not confuse %s with read-only enforcement", error => {
  const f = fixture(); f.error = error; expect(() => supervisorCaTrust(validEnv, f.io, 1500, 1500)).toThrow("worker trust admission"); expect(f.descriptors.size).toBe(0);
});
it("permission denial still requires the randomized sentinel to be absent", () => {
  const f = fixture(); f.visible = true; expect(() => supervisorCaTrust(validEnv, f.io, 1500, 1500)).toThrow("worker trust admission"); expect(f.unlinks).toEqual([]);
});

async function executeWrapper(environment: Record<string, string>, corruptPin = false) {
  const f = fixture(); const source = fs.readFileSync(path.join(asset, "claude-worker.mjs"), "utf8"); const helper = fs.readFileSync(path.join(asset, "claude-worker-ca.mjs"));
  const files: Record<string, Buffer> = { "/usr/local/bin/node": Buffer.from("synthetic-node"), "/opt/genbi/claude": Buffer.from("synthetic-cli"), "/opt/genbi/claude-worker.mjs": Buffer.from(source), "/opt/genbi/claude-worker-ca.mjs": helper };
  const hash = (p: string) => createHash("sha256").update(files[p]!).digest("hex");
  files["/opt/genbi/pins.json"] = Buffer.from(JSON.stringify({ nodeVersion: "v24.20.0", node: hash("/usr/local/bin/node"), claude: hash("/opt/genbi/claude"), wrapper: hash("/opt/genbi/claude-worker.mjs"), caTrust: corruptPin ? "bad" : hash("/opt/genbi/claude-worker-ca.mjs") }));
  const token = "synthetic-bootstrap-only-123456";
  const boot = Buffer.from(JSON.stringify({ protocol: 1, scope: "11111111-1111-4111-8111-111111111111", generation: "22222222-2222-4222-8222-222222222222", expiresAt: Date.now() + 3600000, access: token, argv: ["--version"] })); const prefix = Buffer.alloc(4); prefix.writeUInt32BE(boot.length); const input = Buffer.concat([prefix, boot]); let offset = 0, helperCalls = 0, childEnv: Record<string, string> | undefined; const errors: string[] = [];
  const processStub = { platform: "linux", arch: "arm64", version: "v24.20.0", env: environment, stderr: { write(value: string) { errors.push(value); } }, exit() { throw Error("synthetic worker exit"); }, execve(_file: string, args: string[], env: Record<string, string>) { expect(args).toEqual(["/opt/genbi/claude", "--version"]); childEnv = env; } };
  const readSync = (fd: number, bytes: Buffer, start: number, length: number) => { expect(fd).toBe(0); const count = Math.min(length, input.length - offset); input.copy(bytes, start, offset, offset + count); offset += count; return count; };
  const readFileSync = (p: string) => files[p] ?? fs.readFileSync(f.map(p));
  const mkdirSync = (p: string, options: fs.MakeDirectoryOptions) => fs.mkdirSync(f.map(p), options);
  const writeFileSync = (p: string, bytes: string, options: fs.WriteFileOptions) => fs.writeFileSync(f.map(p), bytes, options);
  const trustModule = { supervisorCaTrust(env: Record<string, string>) { helperCalls++; return supervisorCaTrust(env, f.io, 1500, 1500); } };
  // Execute the real wrapper body, substituting only OS/crypto/process bindings;
  // no bootstrap, trust, pin, isolation or environment predicate is rewritten.
  const body = source.replace(/^import .*;\n/gm, "").replace("await import('./claude-worker-ca.mjs')", "trustModule");
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  let rejected = false;
  try { await new AsyncFunction("readSync", "readFileSync", "mkdirSync", "writeFileSync", "createHash", "process", "trustModule", body)(readSync, readFileSync, mkdirSync, writeFileSync, createHash, processStub, trustModule); } catch { rejected = true; }
  return { f, childEnv, token, errors, helperCalls, rejected };
}
it("real wrapper passes validated CA only, keeps private token off argv/errors and drops ambient settings", async () => {
  const result = await executeWrapper({ ...validEnv, HTTP_PROXY: "http://ambient.test", DENO_CERT: "/ambient", NODE_OPTIONS: "ambient", ANTHROPIC_API_KEY: "ambient-secret" });
  expect(result.rejected).toBe(false); expect(result.childEnv).toMatchObject(validEnv); expect(result.childEnv!.CLAUDE_CODE_OAUTH_TOKEN).toBe(result.token);
  expect(["HTTP_PROXY", "DENO_CERT", "NODE_OPTIONS", "ANTHROPIC_API_KEY", "NODE_TLS_REJECT_UNAUTHORIZED"].every(key => !Object.hasOwn(result.childEnv!, key))).toBe(true); expect(result.errors.join("")).not.toContain(result.token); expect(result.f.descriptors.size).toBe(0);
});
it("real wrapper supports CA absence and rejects helper tampering before importing it", async () => {
  const absent = await executeWrapper({}); expect(absent.rejected).toBe(false); expect(Object.hasOwn(absent.childEnv!, "NODE_EXTRA_CA_CERTS")).toBe(false);
  const corrupt = await executeWrapper(validEnv, true); expect(corrupt.rejected).toBe(true); expect(corrupt.helperCalls).toBe(0); expect(corrupt.childEnv).toBeUndefined(); expect(corrupt.errors.join("")).not.toContain(corrupt.token);
});
it("real wrapper rejects disabled TLS before exec without credential/path leakage", async () => {
  const result = await executeWrapper({ ...validEnv, NODE_TLS_REJECT_UNAUTHORIZED: "0" }); expect(result.rejected).toBe(true); expect(result.childEnv).toBeUndefined(); expect(result.errors.join("")).not.toContain(certificate); expect(result.errors.join("")).not.toContain(result.token);
});
