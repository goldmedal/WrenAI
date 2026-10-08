import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { installContextLoader, isRepositorySourcePackage } from "../scripts/installer.mjs";
import { readVerifiedState, targetFor } from "../lib/verified.mjs";

const sha256 = (content) => createHash("sha256").update(content).digest("hex");

function tarEntry(name, content) {
  const header = Buffer.alloc(512);
  header.write(name);
  header.write(content.length.toString(8).padStart(11, "0"), 124);
  header[135] = 0;
  header[156] = "0".charCodeAt(0);
  header.write("ustar", 257);
  return Buffer.concat([header, content, Buffer.alloc((512 - (content.length % 512)) % 512), Buffer.alloc(1024)]);
}

async function fixture({ artifact = Buffer.from("#!/bin/sh\necho loader\n"), target = targetFor(), row = {} } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "context-loader-package-"));
  const archive = gzipSync(tarEntry("wren-context-loader", artifact));
  const manifest = {
    schema: 1,
    package: "@wrenai/context-loader",
    version: "0.1.0",
    artifacts: {
      [target]: {
        url: "https://example.invalid/context-loader.tar.gz",
        archiveSha256: sha256(archive),
        binarySha256: sha256(artifact),
        binaryPath: "wren-context-loader",
        ...row,
      },
    },
  };
  await writeFile(path.join(root, "package.json"), JSON.stringify({ name: manifest.package, version: manifest.version }));
  await writeFile(path.join(root, "artifacts.json"), JSON.stringify(manifest));
  return { root, archive, artifact };
}

const fetchArchive = (archive) => async () => ({ ok: true, arrayBuffer: async () => archive });

async function makeSourceWorkspace(root) {
  const packageRoot = path.join(root, "apps", "context-loader");
  await mkdir(packageRoot, { recursive: true });
  await writeFile(path.join(root, "pnpm-workspace.yaml"), "packages: []\n");
  await writeFile(path.join(packageRoot, "SOURCE_WORKSPACE"), "source marker\n");
  return packageRoot;
}

test("installs a digest-verified current-platform binary atomically and records canonical state", async () => {
  const { root, archive, artifact } = await fixture();
  const first = await installContextLoader({ packageRoot: root, fetchImpl: fetchArchive(archive) });
  assert.equal(first.reused, false);
  assert.deepEqual(await readFile(first.binary), artifact);
  const state = readVerifiedState(root);
  assert.equal(state.binary, await realpath(first.binary));
  assert.equal(state.state.target, targetFor());
  assert.match(state.identity, /package:@wrenai\/context-loader@0\.1\.0:[a-z0-9_-]+:[a-f0-9]{64}/);
  const second = await installContextLoader({ packageRoot: root, fetchImpl: async () => { throw new Error("offline"); } });
  assert.equal(second.reused, true);
});

test("fails closed for unsupported targets, archive tampering, and binary digest tampering", async () => {
  const supported = await fixture();
  const unsupportedPlatform = process.platform === "linux" ? "darwin" : "linux";
  await assert.rejects(
    installContextLoader({ packageRoot: supported.root, fetchImpl: fetchArchive(supported.archive), platform: unsupportedPlatform, arch: process.arch }),
    /unsupported-platform/,
  );
  const archiveTampered = await fixture({ row: { archiveSha256: "0".repeat(64) } });
  await assert.rejects(installContextLoader({ packageRoot: archiveTampered.root, fetchImpl: fetchArchive(archiveTampered.archive) }), /archive-digest-mismatch/);
  const binaryTampered = await fixture({ row: { binarySha256: "0".repeat(64) } });
  await assert.rejects(installContextLoader({ packageRoot: binaryTampered.root, fetchImpl: fetchArchive(binaryTampered.archive) }), /binary-digest-mismatch/);
});

test("rejects stale or altered installed state at runtime", async () => {
  const { root, archive } = await fixture();
  await installContextLoader({ packageRoot: root, fetchImpl: fetchArchive(archive) });
  const statePath = path.join(root, "install-state.json");
  const state = JSON.parse(await readFile(statePath, "utf8"));
  await writeFile(statePath, JSON.stringify({ ...state, version: "0.1.1" }));
  assert.throws(() => readVerifiedState(root), /stale-state/);
});

test("rejects final-file and ancestor-directory symlinks at runtime", async () => {
  const finalLink = await fixture();
  const installed = await installContextLoader({ packageRoot: finalLink.root, fetchImpl: fetchArchive(finalLink.archive) });
  const external = path.join(await mkdtemp(path.join(os.tmpdir(), "context-loader-external-")), "wren-context-loader");
  await writeFile(external, await readFile(installed.binary), { mode: 0o755 });
  await rm(installed.binary);
  await symlink(external, installed.binary);
  assert.throws(() => readVerifiedState(finalLink.root), /linked|outside/);

  const ancestorLink = await fixture();
  const installedAncestor = await installContextLoader({ packageRoot: ancestorLink.root, fetchImpl: fetchArchive(ancestorLink.archive) });
  const externalDir = await mkdtemp(path.join(os.tmpdir(), "context-loader-external-dir-"));
  await writeFile(path.join(externalDir, "wren-context-loader"), await readFile(installedAncestor.binary), { mode: 0o755 });
  await rm(path.join(ancestorLink.root, "bin"), { recursive: true });
  await symlink(externalDir, path.join(ancestorLink.root, "bin"));
  assert.throws(() => readVerifiedState(ancestorLink.root), /linked|outside/);
});

test("refuses a same-bytes external binary during reuse and a bin-directory link before any install write", async () => {
  const reusable = await fixture();
  const installed = await installContextLoader({ packageRoot: reusable.root, fetchImpl: fetchArchive(reusable.archive) });
  const external = path.join(await mkdtemp(path.join(os.tmpdir(), "context-loader-reuse-external-")), "wren-context-loader");
  await writeFile(external, await readFile(installed.binary), { mode: 0o755 });
  await rm(installed.binary);
  await symlink(external, installed.binary);
  await assert.rejects(
    installContextLoader({ packageRoot: reusable.root, fetchImpl: fetchArchive(reusable.archive) }),
    /unsafe-path/,
  );
  assert.deepEqual(await readFile(external), reusable.artifact);

  const fresh = await fixture();
  const externalDir = await mkdtemp(path.join(os.tmpdir(), "context-loader-write-external-"));
  const sentinel = path.join(externalDir, "wren-context-loader");
  await writeFile(sentinel, "outside-before", { mode: 0o755 });
  await symlink(externalDir, path.join(fresh.root, "bin"));
  await assert.rejects(
    installContextLoader({ packageRoot: fresh.root, fetchImpl: fetchArchive(fresh.archive) }),
    /unsafe-path/,
  );
  assert.equal(await readFile(sentinel, "utf8"), "outside-before");
  assert.deepEqual(await readdir(externalDir), ["wren-context-loader"]);
});

test("recognizes fork and source-archive workspaces, while npm-packed copies cannot bypass", async () => {
  const forkRoot = await mkdtemp(path.join(os.tmpdir(), "context-loader-fork-"));
  const forkPackage = await makeSourceWorkspace(forkRoot);
  execFileSync("git", ["init", forkRoot]);
  execFileSync("git", ["-C", forkRoot, "remote", "add", "origin", "https://example.invalid/fork.git"]);
  assert.equal(await isRepositorySourcePackage(forkPackage), true);

  const sourceArchiveRoot = await mkdtemp(path.join(os.tmpdir(), "context-loader-source-archive-"));
  const sourceArchivePackage = await makeSourceWorkspace(sourceArchiveRoot);
  assert.equal(await isRepositorySourcePackage(sourceArchivePackage), true);

  const actualPackageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const packed = JSON.parse(execFileSync("npm", ["pack", "--json", "--dry-run"], { cwd: actualPackageRoot, encoding: "utf8" }));
  assert.equal(packed[0].files.some((entry) => entry.path === "SOURCE_WORKSPACE"), false);

  const unpackedRoot = await mkdtemp(path.join(os.tmpdir(), "context-loader-unpacked-"));
  const unpackedPackage = path.join(unpackedRoot, "apps", "context-loader");
  await mkdir(unpackedPackage, { recursive: true });
  await writeFile(path.join(unpackedRoot, "pnpm-workspace.yaml"), "packages: []\n");
  assert.equal(await isRepositorySourcePackage(unpackedPackage), false);
});

const generator = fileURLToPath(new URL("../scripts/generate-release-manifest.mjs", import.meta.url));

async function writeArchive(dir, name, binary) {
  const archive = gzipSync(tarEntry("wren-context-loader", binary));
  await writeFile(path.join(dir, name), archive);
  return archive;
}

test("release manifest generator emits one digest row per target and the installer picks the row for its platform", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "context-loader-manifest-"));
  const binaries = { "darwin-arm64": Buffer.from("darwin"), "linux-arm64": Buffer.from("linux-arm"), "linux-x64": Buffer.from("linux-x64") };
  const archives = {};
  const args = [];
  for (const [target, binary] of Object.entries(binaries)) {
    archives[target] = await writeArchive(dir, `${target}.tar.gz`, binary);
    args.push(target, path.join(dir, `${target}.tar.gz`), `https://example.invalid/${target}.tar.gz`);
  }
  await writeFile(path.join(dir, "package.json"), JSON.stringify({ name: "@wrenai/context-loader", version: "9.9.9" }));
  execFileSync(process.execPath, [generator, dir, "9.9.9", "abc123", ...args], { stdio: "pipe" });
  const manifest = JSON.parse(await readFile(path.join(dir, "artifacts.json"), "utf8"));
  assert.deepEqual(Object.keys(manifest.artifacts).sort(), Object.keys(binaries).sort());
  for (const [target, binary] of Object.entries(binaries)) {
    assert.equal(manifest.artifacts[target].archiveSha256, sha256(archives[target]));
    assert.equal(manifest.artifacts[target].binarySha256, sha256(binary));
  }
  for (const [platform, arch, target] of [["linux", "x64", "linux-x64"], ["linux", "arm64", "linux-arm64"], ["darwin", "arm64", "darwin-arm64"]]) {
    const root = await mkdtemp(path.join(os.tmpdir(), "context-loader-pick-"));
    await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "@wrenai/context-loader", version: "9.9.9" }));
    await writeFile(path.join(root, "artifacts.json"), JSON.stringify({ ...manifest, artifacts: Object.fromEntries(Object.entries(manifest.artifacts).map(([key, row]) => [key, { ...row, url: `https://example.invalid/${key}` }])) }));
    const requested = [];
    const { binary } = await installContextLoader({
      packageRoot: root,
      platform,
      arch,
      fetchImpl: async (url) => {
        requested.push(url);
        return { ok: true, arrayBuffer: async () => archives[target] };
      },
    });
    assert.deepEqual(requested, [`https://example.invalid/${target}`]);
    assert.deepEqual(await readFile(binary), binaries[target]);
  }
});

test("release manifest generator keeps the single-archive darwin-arm64 form and rejects bad targets", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "context-loader-manifest-legacy-"));
  await writeArchive(dir, "a.tar.gz", Buffer.from("darwin"));
  execFileSync(process.execPath, [generator, dir, "1.0.0", "abc", path.join(dir, "a.tar.gz"), "https://example.invalid/a"], { stdio: "pipe" });
  assert.deepEqual(Object.keys(JSON.parse(await readFile(path.join(dir, "artifacts.json"), "utf8")).artifacts), ["darwin-arm64"]);
  const bad = (...extra) => () => execFileSync(process.execPath, [generator, dir, "1.0.0", "abc", ...extra], { stdio: "pipe" });
  assert.throws(bad("win32-x64", path.join(dir, "a.tar.gz"), "https://example.invalid/a"));
  assert.throws(bad("linux-x64", path.join(dir, "a.tar.gz"), "https://example.invalid/a", "linux-x64", path.join(dir, "a.tar.gz"), "https://example.invalid/b"));
});

const modeOf = async (file) => (await stat(file)).mode & 0o777;
const posixOnly = { skip: process.platform === "win32" };

async function withUmask(mask, run) {
  const previous = process.umask(mask);
  try {
    return await run();
  } finally {
    process.umask(previous);
  }
}

test("install leaves state, binary and bin directory readable by other users even under a restrictive umask", posixOnly, async () => {
  const { root, archive } = await fixture();
  await withUmask(0o077, () => installContextLoader({ packageRoot: root, fetchImpl: fetchArchive(archive) }));
  assert.equal((await modeOf(path.join(root, "install-state.json"))).toString(8), "644");
  assert.equal((await modeOf(path.join(root, "bin", "wren-context-loader"))).toString(8), "755");
  assert.equal((await modeOf(path.join(root, "bin"))).toString(8), "755");
  assert.deepEqual((await readdir(path.join(root, "bin"))).sort(), ["wren-context-loader"]);
  assert.deepEqual((await readdir(root)).filter((name) => name.includes(".tmp-")), []);
});

test("reusing an existing install keeps, and repairs, other-user readability", posixOnly, async () => {
  const { root, archive } = await fixture();
  await installContextLoader({ packageRoot: root, fetchImpl: fetchArchive(archive) });
  const reused = await withUmask(0o077, () => installContextLoader({ packageRoot: root, fetchImpl: async () => { throw new Error("offline"); } }));
  assert.equal(reused.reused, true);
  assert.equal((await modeOf(path.join(root, "install-state.json"))).toString(8), "644");
  await chmod(path.join(root, "install-state.json"), 0o600);
  await chmod(path.join(root, "bin"), 0o700);
  await installContextLoader({ packageRoot: root, fetchImpl: async () => { throw new Error("offline"); } });
  assert.equal((await modeOf(path.join(root, "install-state.json"))).toString(8), "644");
  assert.equal((await modeOf(path.join(root, "bin"))).toString(8), "755");
  assert.equal((await modeOf(path.join(root, "bin", "wren-context-loader"))).toString(8), "755");
});
