import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const USAGE = "usage: generate-release-manifest.mjs <package-dir> <version> <source-commit> (<target> <archive> <asset-url>)+\n" +
  "       generate-release-manifest.mjs <package-dir> <version> <source-commit> <archive> <asset-url>   (darwin-arm64 only)";
const SUPPORTED_TARGETS = ["darwin-arm64", "linux-arm64", "linux-x64"];
const [packageDir, version, sourceCommit, ...rest] = process.argv.slice(2);
if (![packageDir, version, sourceCommit].every(Boolean) || rest.some((value) => !value)) throw new Error(USAGE);
const entries = parseEntries(rest);
const binaryPath = "wren-context-loader";
const sha256 = (data) => createHash("sha256").update(data).digest("hex");
const artifacts = {};
for (const { target, archivePath, assetUrl } of entries) {
  const archive = await readFile(archivePath);
  const binary = await readBinaryFromTarGz(archive, binaryPath);
  artifacts[target] = { url: assetUrl, archiveSha256: sha256(archive), binarySha256: sha256(binary), binaryPath };
}
const manifest = { schema: 1, package: "@wrenai/context-loader", version, sourceCommit, artifacts };
await writeFile(path.join(packageDir, "artifacts.json"), `${JSON.stringify(manifest, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(manifest)}\n`);

function parseEntries(args) {
  if (args.length === 2) return [{ target: "darwin-arm64", archivePath: args[0], assetUrl: args[1] }];
  if (args.length === 0 || args.length % 3 !== 0) throw new Error(USAGE);
  const parsed = [];
  for (let index = 0; index < args.length; index += 3) {
    const [target, archivePath, assetUrl] = args.slice(index, index + 3);
    if (!SUPPORTED_TARGETS.includes(target)) throw new Error(`unsupported target ${target}; expected one of ${SUPPORTED_TARGETS.join(", ")}`);
    if (parsed.some((entry) => entry.target === target)) throw new Error(`duplicate target ${target}`);
    parsed.push({ target, archivePath, assetUrl });
  }
  return parsed;
}

async function readBinaryFromTarGz(archive, expectedPath) {
  const { gunzipSync } = await import("node:zlib");
  const tar = gunzipSync(archive);
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/u, "");
    const size = Number.parseInt(header.subarray(124, 136).toString("utf8").replace(/\0.*$/u, "").trim() || "0", 8);
    if (!Number.isSafeInteger(size) || size < 0 || offset + 512 + size > tar.length) throw new Error("invalid release archive layout");
    if (name === expectedPath) return tar.subarray(offset + 512, offset + 512 + size);
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  throw new Error(`release archive lacks ${expectedPath}`);
}
