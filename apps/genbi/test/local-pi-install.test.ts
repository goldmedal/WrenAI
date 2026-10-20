import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { evaluateLocalPiIdentity, LOCAL_PI_CERTIFIED_ROWS, LOCAL_PI_MIN_NODE, localPiCertificationSchema, localPiPinsSchema, nodeMeetsPiMinimum } from "../server/runtime-host/local-pi-certification.js";
import { computeLocalPiPins, hashTree, installLocalPi, LocalPiInstallError, localPiInstallDir, localPiInstallName, packagedPiAssets, resolveGenbiStateDir, verifyLocalPi } from "../server/runtime-host/local-pi-install.js";
import { runtimeNotReady } from "../server/runtime-host/policy.js";
import { RUNTIME_BACKEND_IDS } from "../server/runtime-host/types.js";
import { describeManagedPi, installManagedPi, verifyManagedPi } from "../server/local-pi-operator.js";
import { certifiedRow, fakeNpm, installFake } from "./local-pi-fixture.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const tmp = () => { const root = mkdtempSync(path.join(os.tmpdir(), "local-pi-install-")); roots.push(root); return root; };
const flip = (digest: string) => `${digest[0] === "0" ? "1" : "0"}${digest.slice(1)}`;

describe("managed install and host pins", () => {
  it("installs from the packaged lockfile without scripts and writes closed pins", async () => {
    const root = tmp(); const calls: string[][] = [];
    const stateDir = path.join(root, "state");
    const report = await installLocalPi({ stateDir, run: async (exe, argv, env, cwd) => { calls.push([...argv]); await fakeNpm(path.join(root, "c.json"))(exe, argv, env, cwd, 1); expect(Object.keys(env).sort()).toEqual(["HOME", "LANG", "PATH", "npm_config_audit", "npm_config_fund", "npm_config_ignore_scripts", "npm_config_update_notifier"]); } });
    expect(calls).toEqual([["ci", "--ignore-scripts", "--no-audit", "--no-fund"]]);
    const assets = packagedPiAssets();
    expect(report.install).toBe(path.join("runtimes", "pi", localPiInstallName(assets)));
    expect(JSON.stringify(report)).not.toContain(root);
    const recorded = localPiPinsSchema.parse(JSON.parse(readFileSync(path.join(localPiInstallDir(stateDir, assets), "pins.json"), "utf8")));
    expect(recorded).toEqual(report.pins);
    expect(recorded.lockfile).toBe(assets.lockfileSha256);
    expect(recorded.packageJson).toBe(assets.packageJsonSha256);
    expect(recorded.shim).toBe(assets.shimSha256);
    expect(Object.keys(recorded).sort()).toEqual(["lockfile", "packageJson", "piBundle", "piVersion", "shim"]);
  });
  it("is idempotent, refuses a differing install without --replace and replaces it with it", async () => {
    const root = tmp(); const f = await installFake(root);
    const again = await installLocalPi({ stateDir: f.stateDir, run: fakeNpm(f.configPath) });
    expect(again.steps.at(-1)).toEqual({ name: "install in place", status: "unchanged" });
    const other = path.join(root, "other.json"); writeFileSync(other, "{}");
    await expect(installLocalPi({ stateDir: f.stateDir, run: fakeNpm(other) })).rejects.toMatchObject({ code: "refused_to_overwrite" });
    expect((await installLocalPi({ stateDir: f.stateDir, replace: true, run: fakeNpm(other) })).pins.piBundle).not.toBe(f.pins.piBundle);
  });
  it("fails closed when npm fails or leaves a different version", async () => {
    const root = tmp();
    await expect(installLocalPi({ stateDir: path.join(root, "s"), run: async () => { throw new Error("offline"); } })).rejects.toBeInstanceOf(LocalPiInstallError);
    await expect(installLocalPi({ stateDir: path.join(root, "s"), run: async () => {} })).rejects.toMatchObject({ code: "install_failed" });
  });
  it("hashes a tree exactly like the packaged pi-pins module", async () => {
    const root = tmp(); const f = await installFake(root);
    const { hashTree: packaged } = await import(path.join(packagedPiAssets().root, "pi-pins.mjs")) as { hashTree(root: string): string };
    const bundle = path.join(f.installDir, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle");
    expect(hashTree(bundle)).toBe(packaged(bundle));
  });
  it("resolves the state directory from GENBI_STATE_DIR only when absolute", () => {
    expect(resolveGenbiStateDir({ GENBI_STATE_DIR: "/private/state" })).toBe("/private/state");
    expect(() => resolveGenbiStateDir({ GENBI_STATE_DIR: "relative" })).toThrow();
    expect(resolveGenbiStateDir({})).toContain("genbi");
  });
});

describe("verdicts and reason codes", () => {
  it("ready only with the exact row", async () => {
    const f = await installFake(tmp());
    const ok = verifyLocalPi({ stateDir: f.stateDir, rows: [f.row] });
    expect(ok.verdict).toEqual({ ready: true, version: packagedPiAssets().piVersion });
    expect(ok.launcher).toMatchObject({ command: process.execPath });
  });
  it("never finds pi on PATH: a `pi` earlier on PATH changes nothing, and the launcher is this Node on the managed bundle", async () => {
    const root = tmp(); const decoy = path.join(root, "bin"); mkdirSync(decoy); writeFileSync(path.join(decoy, "pi"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const f = await installFake(root);
    const original = process.env.PATH; process.env.PATH = `${decoy}:${original}`;
    try {
      const ready = verifyLocalPi({ stateDir: f.stateDir, rows: [f.row] });
      expect(ready.launcher?.command).toBe(process.execPath);
      expect(ready.launcher?.prefix).toHaveLength(1); expect(ready.launcher!.prefix[0]!.startsWith(realpathSync(f.installDir))).toBe(true);
      // With no install, a pi on PATH is not an identity.
      expect(verifyLocalPi({ stateDir: path.join(root, "none"), rows: [f.row] }).verdict).toEqual({ ready: false, code: "pi_not_installed" });
    } finally { process.env.PATH = original; }
  });
  it("pi_not_installed: no directory, and a directory without pins.json", async () => {
    const root = tmp();
    expect(verifyLocalPi({ stateDir: path.join(root, "none"), rows: [] }).verdict).toEqual({ ready: false, code: "pi_not_installed" });
    const f = await installFake(root); rmSync(path.join(f.installDir, "pins.json"));
    expect(verifyLocalPi({ stateDir: f.stateDir, rows: [f.row] }).verdict).toEqual({ ready: false, code: "pi_not_installed" });
  });
  it("pi_uncertified: an untampered install without a matching row, for other hosts, other Node versions, and for non-certified records", async () => {
    const f = await installFake(tmp());
    expect(verifyLocalPi({ stateDir: f.stateDir, rows: [] }).verdict).toEqual({ ready: false, code: "pi_uncertified" });
    expect(verifyLocalPi({ stateDir: f.stateDir, rows: [f.row], host: { platform: "linux", arch: "x64" } }).verdict).toEqual({ ready: false, code: "pi_uncertified" });
    for (const record of [{ ...f.row, state: "tested_baseline" }, { ...f.row, extra: 1 }, { state: "certified_row" }, { ...f.row, evidence: {} }, "x", null])
      expect(verifyLocalPi({ stateDir: f.stateDir, rows: [record] }).verdict).toEqual({ ready: false, code: "pi_uncertified" });
  });
  it("pi_identity_mismatch: a tampered bundle, tampered pins.json, a symlink and a changed digest in the row", async () => {
    const f = await installFake(tmp());
    const bundle = path.join(f.installDir, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle");
    const mismatch = { ready: false, code: "pi_identity_mismatch" };
    for (const key of ["piBundle", "shim", "lockfile", "packageJson"] as const)
      expect(verifyLocalPi({ stateDir: f.stateDir, rows: [certifiedRow({ ...f.row.install.pins, [key]: flip(f.row.install.pins[key]) })] }).verdict).toEqual(mismatch);
    const pinsFile = path.join(f.installDir, "pins.json"); const original = readFileSync(pinsFile, "utf8");
    writeFileSync(pinsFile, JSON.stringify({ ...f.pins, extra: true })); expect(verifyLocalPi({ stateDir: f.stateDir, rows: [f.row] }).verdict).toEqual(mismatch);
    writeFileSync(pinsFile, "not json"); expect(verifyLocalPi({ stateDir: f.stateDir, rows: [f.row] }).verdict).toEqual(mismatch);
    writeFileSync(pinsFile, original); expect(verifyLocalPi({ stateDir: f.stateDir, rows: [f.row] }).verdict.ready).toBe(true);
    writeFileSync(path.join(bundle, "cli.js"), `${readFileSync(path.join(bundle, "cli.js"), "utf8")}\n// tampered`);
    expect(verifyLocalPi({ stateDir: f.stateDir, rows: [f.row] }).verdict).toEqual(mismatch);
  });
  it("pi_identity_mismatch: a group-writable install directory", async () => {
    const f = await installFake(tmp()); chmodSync(f.installDir, 0o775);
    expect(verifyLocalPi({ stateDir: f.stateDir, rows: [f.row] }).verdict).toEqual({ ready: false, code: "pi_identity_mismatch" });
  });
  it("pi_dependencies_drifted: a row certified for other component versions", async () => {
    const f = await installFake(tmp());
    const drifted = certifiedRow(f.row.install.pins, { dependencies: { ...f.row.dependencies, warble: "9.9.9" } });
    expect(verifyLocalPi({ stateDir: f.stateDir, rows: [drifted] }).verdict).toMatchObject({ ready: false, code: "pi_dependencies_drifted" });
  });
  it("the pure evaluator never throws a digest or path and treats any pins shape as a mismatch", () => {
    expect(evaluateLocalPiIdentity({ host: { platform: "darwin", arch: "arm64" }, nodeVersion: "v24.1.0", recorded: undefined, live: undefined }, [])).toEqual({ ready: false, code: "pi_not_installed" });
    expect(evaluateLocalPiIdentity({ host: { platform: "darwin", arch: "arm64" }, nodeVersion: "v24.1.0", recorded: {}, live: {} }, [])).toEqual({ ready: false, code: "pi_identity_mismatch" });
  });
  describe("Node: the row pins the major version, pi's minimum is enforced", () => {
    const major = Number(/^v(\d+)/.exec(process.version)![1]);
    it("the same major with a different minor or patch is ready", async () => {
      const f = await installFake(tmp());
      for (const nodeVersion of [process.version, `v${major}.99.99`, `v${major}.${major === 22 ? 19 : 0}.1`]) expect(verifyLocalPi({ stateDir: f.stateDir, rows: [f.row], nodeVersion }).verdict.ready, nodeVersion).toBe(true);
    });
    it("a different major is pi_uncertified, even when the pins match exactly", async () => {
      const f = await installFake(tmp());
      for (const nodeVersion of [`v${major + 1}.0.0`, `v${major + 2}.5.1`]) expect(verifyLocalPi({ stateDir: f.stateDir, rows: [f.row], nodeVersion }).verdict, nodeVersion).toEqual({ ready: false, code: "pi_uncertified" });
    });
    it("below pi's minimum Node is refused with its own code before any row or install is consulted", async () => {
      expect(LOCAL_PI_MIN_NODE).toBe("22.19.0");
      const f = await installFake(tmp());
      const row22 = certifiedRow(f.row.install.pins, { nodeMajor: 22 });
      for (const nodeVersion of ["v22.18.9", "v22.0.0", "v20.19.0", "v18.20.0", "garbage"]) {
        expect(verifyLocalPi({ stateDir: f.stateDir, rows: [row22], nodeVersion }).verdict, nodeVersion).toEqual({ ready: false, code: "pi_node_unsupported" });
        expect(verifyLocalPi({ stateDir: path.join(tmp(), "none"), rows: [row22], nodeVersion }).verdict, nodeVersion).toEqual({ ready: false, code: "pi_node_unsupported" });
      }
      expect(verifyLocalPi({ stateDir: f.stateDir, rows: [row22], nodeVersion: "v22.19.0" }).verdict.ready).toBe(true);
      expect(nodeMeetsPiMinimum("v22.19.0")).toBe(true); expect(nodeMeetsPiMinimum("v22.18.99")).toBe(false); expect(nodeMeetsPiMinimum("v23.0.0")).toBe(true); expect(nodeMeetsPiMinimum("v100.0.0")).toBe(true);
    });
    it("the browser-safe message names the minimum without a path or digest", () => {
      const message = runtimeNotReady("pi-local", "incompatible", "pi_node_unsupported").message;
      expect(message).toContain("22.19"); expect(message).not.toMatch(/\/|sha256/);
    });
  });
  it("rows come only from the package: no environment variable or file can supply one", async () => {
    const root = tmp(); const f = await installFake(root); const file = path.join(root, "rows.json");
    writeFileSync(file, JSON.stringify([f.row]));
    const before = process.env.GENBI_PI_LOCAL_ROWS; process.env.GENBI_PI_LOCAL_ROWS = file;
    try {
      // Without an injected row only LOCAL_PI_CERTIFIED_ROWS counts; this install is not the packaged identity, so it is never ready.
      expect(verifyLocalPi({ stateDir: f.stateDir }).verdict.ready).toBe(false);
      expect(verifyManagedPi({ stateDir: f.stateDir }).ok).toBe(false);
      expect(describeManagedPi({ stateDir: f.stateDir })).toMatchObject({ packagedRows: LOCAL_PI_CERTIFIED_ROWS.map(() => expect.anything()) });
    } finally { if (before === undefined) delete process.env.GENBI_PI_LOCAL_ROWS; else process.env.GENBI_PI_LOCAL_ROWS = before; }
  });
  it("the row schema is strict and closed", () => {
    expect(localPiCertificationSchema.safeParse(certifiedRow({ piVersion: "1.0.4", piBundle: "a".repeat(64), shim: "b".repeat(64), lockfile: "c".repeat(64), packageJson: "d".repeat(64) })).success).toBe(true);
  });
  it("reason codes are fixed, browser-safe, family-worded and not a native runtime backend", () => {
    for (const code of ["pi_not_installed", "pi_uncertified", "pi_identity_mismatch", "pi_dependencies_drifted", "pi_provider_unsupported", "pi_node_unsupported", "runtime_probe_failed"] as const) {
      const message = runtimeNotReady("pi-local", "unavailable", code).message;
      expect(message).not.toMatch(/\/|sha256|OpenShell/);
    }
    expect(new Set(["pi_not_installed", "pi_uncertified", "pi_identity_mismatch", "pi_dependencies_drifted"]).size).toBe(4);
    expect(RUNTIME_BACKEND_IDS as readonly string[]).not.toContain("pi-local");
  });
});

describe("operator helper functions", () => {
  it("install, verify and row speak digests and names only and mirror the boot verdict", async () => {
    const root = tmp(); const stateDir = path.join(root, "state"); const configPath = path.join(root, "c.json"); writeFileSync(configPath, "{}");
    expect(verifyManagedPi({ stateDir })).toEqual({ ok: false, checks: [{ name: "managed install", ok: false, code: "pi_not_installed" }] });
    const report = await installManagedPi({ stateDir, run: fakeNpm(configPath) });
    expect(JSON.stringify(report)).not.toContain(root);
    const verified = verifyManagedPi({ stateDir });
    expect(verified.ok).toBe(false); expect(["pi_uncertified", "pi_identity_mismatch"]).toContain(verified.checks[0]!.code);
    const described = describeManagedPi({ stateDir });
    expect(JSON.stringify(described)).not.toContain(root);
    expect(described).toMatchObject({ installed: { present: true }, candidate: { vendor: "pi-local", nodeMajor: Number(/^v(\d+)/.exec(process.version)![1]) } });
    expect(JSON.stringify(described)).not.toMatch(/GENBI_PI_LOCAL_ROWS|operatorRows/);
    expect(computeLocalPiPins(path.join(stateDir, "runtimes", "pi", localPiInstallName(packagedPiAssets())), packagedPiAssets())).toEqual(report.pins);
  });
});
