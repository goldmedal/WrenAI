import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import type { Stats } from "node:fs";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { installedComponents, type InstalledComponents } from "./openshell-vendor-certification.js";
import { evaluateLocalPiIdentity, LOCAL_PI_CERTIFIED_ROWS, nodeMeetsPiMinimum, localPiPinsSchema, type LocalPiPins, type LocalPiVerdict } from "./local-pi-certification.js";

/**
 * The GenBI-managed pi install used by the local runtime. It is an explicit operator step (`genbi-local-pi install`), never a boot-time
 * download: boot only reads and verifies it. The install directory is derived from the packaged lockfile, and pi is never discovered from PATH.
 */
const PACKAGED_ASSETS = fileURLToPath(new URL("../../runtime-assets/pi-worker/", import.meta.url));
export const LOCAL_PI_PACKAGE = path.join("node_modules", "@earendil-works", "pi-coding-agent");
const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const hashFile = (file: string) => sha256(readFileSync(file));
const MAX_PINS_BYTES = 4096;
const NPM_TIMEOUT_MS = 10 * 60_000;

/** Same semantics as `hashTree` in the packaged `pi-pins.mjs`: regular files only, per-directory name order, `<sha256>  <relative path>` lines. */
export function hashTree(root: string): string {
  const lines: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) lines.push(`${hashFile(full)}  ${path.relative(root, full)}\n`);
      else throw new Error("unsupported tree entry");
    }
  };
  walk(root);
  return sha256(lines.join(""));
}

export interface PackagedPiAssets {
  readonly root: string;
  readonly piVersion: string;
  readonly packageJsonSha256: string;
  readonly lockfileSha256: string;
  readonly shimSha256: string;
}
/** The packaged pi-worker manifests. Throws when the package is incomplete. */
export function packagedPiAssets(root = PACKAGED_ASSETS): PackagedPiAssets {
  const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as { dependencies?: Record<string, unknown> };
  const piVersion = manifest.dependencies?.["@earendil-works/pi-coding-agent"];
  if (typeof piVersion !== "string" || !/^[0-9]+\.[0-9]+\.[0-9]+$/.test(piVersion)) throw new Error("the packaged pi version is not an exact version");
  return { root, piVersion, packageJsonSha256: hashFile(path.join(root, "package.json")), lockfileSha256: hashFile(path.join(root, "package-lock.json")), shimSha256: hashFile(path.join(root, "pi-mcp-shim.mjs")) };
}

/** The GenBI state directory: `GENBI_STATE_DIR`, else the per-user application state location. */
export function resolveGenbiStateDir(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.GENBI_STATE_DIR;
  if (configured !== undefined && configured !== "") {
    if (!path.isAbsolute(configured) || configured.includes("\0")) throw new Error("GENBI_STATE_DIR must be an absolute path");
    return path.resolve(configured);
  }
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", "WrenAI", "genbi");
  return path.join(env.XDG_STATE_HOME && path.isAbsolute(env.XDG_STATE_HOME) ? env.XDG_STATE_HOME : path.join(os.homedir(), ".local", "state"), "wrenai", "genbi");
}
export const localPiInstallName = (assets: PackagedPiAssets) => `${assets.piVersion}-${assets.lockfileSha256.slice(0, 12)}`;
export const localPiInstallDir = (stateDir: string, assets: PackagedPiAssets) => path.join(stateDir, "runtimes", "pi", localPiInstallName(assets));

const ownedPrivate = (stat: Stats) => stat.uid === process.getuid?.() && (stat.mode & 0o022) === 0;

/** Recompute the pins from the bytes now on disk. Throws on any anomaly (symlink, missing file, other versions). */
export function computeLocalPiPins(installDir: string, assets: PackagedPiAssets): LocalPiPins {
  const directory = lstatSync(installDir);
  if (!directory.isDirectory() || directory.isSymbolicLink() || !ownedPrivate(directory)) throw new Error("install directory");
  const pkg = path.join(installDir, LOCAL_PI_PACKAGE);
  const piVersion = (JSON.parse(readFileSync(path.join(pkg, "package.json"), "utf8")) as { version?: unknown }).version;
  const pins = { piVersion, piBundle: hashTree(path.join(pkg, "dist", "bundle")), shim: assets.shimSha256,
    lockfile: hashFile(path.join(installDir, "package-lock.json")), packageJson: hashFile(path.join(installDir, "package.json")) };
  const parsed = localPiPinsSchema.parse(pins);
  if (parsed.piVersion !== assets.piVersion || parsed.lockfile !== assets.lockfileSha256 || parsed.packageJson !== assets.packageJsonSha256) throw new Error("install differs from the packaged manifests");
  return parsed;
}

export interface LocalPiLauncher { readonly command: string; readonly prefix: readonly string[] }
export interface LocalPiVerification { readonly verdict: LocalPiVerdict; readonly launcher?: LocalPiLauncher; readonly pins?: LocalPiPins }
export interface LocalPiVerifyOptions {
  readonly stateDir: string;
  /** Test seam: certified rows to judge against. Production passes none and only the packaged rows count. */
  readonly rows?: readonly unknown[];
  readonly host?: { readonly platform: string; readonly arch: string };
  readonly installed?: InstalledComponents;
  readonly nodeVersion?: string;
  readonly assets?: PackagedPiAssets;
}

/** The one identity check the boot, `verify` and every step run. Never throws: every failure is a verdict. */
export function verifyLocalPi(options: LocalPiVerifyOptions): LocalPiVerification {
  if (!nodeMeetsPiMinimum(options.nodeVersion ?? process.version)) return { verdict: { ready: false, code: "pi_node_unsupported" } };
  let assets: PackagedPiAssets;
  try { assets = options.assets ?? packagedPiAssets(); } catch { return { verdict: { ready: false, code: "pi_uncertified" } }; }
  const dir = localPiInstallDir(options.stateDir, assets);
  let recorded: unknown;
  try {
    if (!existsSync(dir)) return { verdict: { ready: false, code: "pi_not_installed" } };
    const file = path.join(dir, "pins.json");
    if (!existsSync(file)) return { verdict: { ready: false, code: "pi_not_installed" } };
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || !ownedPrivate(stat) || stat.size > MAX_PINS_BYTES) return { verdict: { ready: false, code: "pi_identity_mismatch" } };
    recorded = JSON.parse(readFileSync(file, "utf8"));
  } catch { return { verdict: { ready: false, code: "pi_identity_mismatch" } }; }
  let live: LocalPiPins;
  try { live = computeLocalPiPins(dir, assets); } catch { return { verdict: { ready: false, code: "pi_identity_mismatch" } }; }
  const rows = options.rows ?? LOCAL_PI_CERTIFIED_ROWS;
  const verdict = evaluateLocalPiIdentity({ host: options.host ?? { platform: process.platform, arch: process.arch }, nodeVersion: options.nodeVersion ?? process.version, recorded, live }, rows, options.installed ?? installedComponents());
  if (!verdict.ready) return { verdict, pins: live };
  try {
    const cli = realpathSync(path.join(dir, LOCAL_PI_PACKAGE, "dist", "bundle", "cli.js"));
    if (!cli.startsWith(realpathSync(path.join(dir, LOCAL_PI_PACKAGE, "dist", "bundle")) + path.sep)) throw new Error("launcher");
    return { verdict, pins: live, launcher: { command: process.execPath, prefix: [cli] } };
  } catch { return { verdict: { ready: false, code: "pi_identity_mismatch" }, pins: live }; }
}

export type NpmRunner = (executable: string, argv: readonly string[], environment: NodeJS.ProcessEnv, cwd: string, timeoutMs: number) => Promise<void>;
const defaultNpm: NpmRunner = (executable, argv, environment, cwd, timeoutMs) => new Promise((resolve, reject) => {
  execFile(executable, [...argv], { env: environment, cwd, timeout: timeoutMs, maxBuffer: 1 << 20, windowsHide: true }, (error) => (error ? reject(error) : resolve()));
});

export class LocalPiInstallError extends Error {
  constructor(readonly code: "npm_unavailable" | "install_failed" | "refused_to_overwrite" | "incomplete_package", message: string) { super(message); this.name = "LocalPiInstallError"; }
}
export interface LocalPiInstallStep { readonly name: string; readonly status: "done" | "unchanged" }
export interface LocalPiInstallReport { readonly ok: true; readonly steps: readonly LocalPiInstallStep[]; readonly install: string; readonly pins: LocalPiPins }

function ensurePrivateDirectories(directory: string): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory() || stat.uid !== process.getuid?.()) throw new LocalPiInstallError("refused_to_overwrite", "The install location is not a directory owned by you.");
}

/**
 * `npm ci --ignore-scripts` from the packaged lockfile into a private temp directory, pins computed from the result, then an atomic rename.
 * An identical existing install is left alone; a different one is refused without `replace`.
 */
export async function installLocalPi(options: { readonly stateDir: string; readonly replace?: boolean; readonly run?: NpmRunner; readonly assets?: PackagedPiAssets }): Promise<LocalPiInstallReport> {
  let assets: PackagedPiAssets;
  try { assets = options.assets ?? packagedPiAssets(); } catch { throw new LocalPiInstallError("incomplete_package", "The packaged pi manifests are missing; reinstall @wrenai/genbi."); }
  const run = options.run ?? defaultNpm;
  const target = localPiInstallDir(options.stateDir, assets);
  const parent = path.dirname(target);
  ensurePrivateDirectories(parent);
  const steps: LocalPiInstallStep[] = [];
  const npm = path.join(path.dirname(process.execPath), "npm");
  if (options.run === undefined && !existsSync(npm)) throw new LocalPiInstallError("npm_unavailable", "npm was not found next to the running Node; run this helper with a Node that ships npm.");
  const scratch = mkdtempSync(path.join(parent, ".install-"));
  chmodSync(scratch, 0o700);
  try {
    copyFileSync(path.join(assets.root, "package.json"), path.join(scratch, "package.json"));
    copyFileSync(path.join(assets.root, "package-lock.json"), path.join(scratch, "package-lock.json"));
    const environment = Object.freeze({ PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, HOME: os.homedir(), LANG: "en_US.UTF-8",
      npm_config_ignore_scripts: "true", npm_config_audit: "false", npm_config_fund: "false", npm_config_update_notifier: "false" });
    try { await run(npm, ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], environment, scratch, NPM_TIMEOUT_MS); }
    catch { throw new LocalPiInstallError("install_failed", "npm ci failed. Run `npm ci --ignore-scripts` yourself in a copy of the packaged runtime-assets/pi-worker to see why."); }
    steps.push({ name: "npm ci --ignore-scripts from the packaged lockfile", status: "done" });
    let pins: LocalPiPins;
    try { pins = computeLocalPiPins(scratch, assets); } catch { throw new LocalPiInstallError("install_failed", "The installed pi does not match the packaged manifests."); }
    writeFileSync(path.join(scratch, "pins.json"), `${JSON.stringify(pins, null, 2)}\n`, { mode: 0o600 });
    chmodSync(path.join(scratch, "pins.json"), 0o600);
    steps.push({ name: "compute and write pins.json", status: "done" });
    if (existsSync(target)) {
      let same = false;
      try { same = JSON.stringify(computeLocalPiPins(target, assets)) === JSON.stringify(pins) && JSON.stringify(JSON.parse(readFileSync(path.join(target, "pins.json"), "utf8"))) === JSON.stringify(pins); } catch { same = false; }
      if (same) { rmSync(scratch, { recursive: true, force: true }); steps.push({ name: "install in place", status: "unchanged" }); return { ok: true, steps, install: path.join("runtimes", "pi", path.basename(target)), pins }; }
      if (options.replace !== true) throw new LocalPiInstallError("refused_to_overwrite", "An install with different content already exists; review it, then pass --replace to overwrite it.");
      const old = path.join(parent, `.old-${randomBytes(6).toString("hex")}`);
      renameSync(target, old); renameSync(scratch, target); rmSync(old, { recursive: true, force: true });
    } else renameSync(scratch, target);
    steps.push({ name: "install in place", status: "done" });
    return { ok: true, steps, install: path.join("runtimes", "pi", path.basename(target)), pins };
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}
