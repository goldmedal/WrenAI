import { chmodSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { installLocalPi, packagedPiAssets, computeLocalPiPins, localPiInstallDir, type NpmRunner } from "../server/runtime-host/local-pi-install.js";
import { installedComponents } from "../server/runtime-host/openshell-vendor-certification.js";
import type { LocalPiCertification } from "../server/runtime-host/local-pi-certification.js";

const FAKE = fileURLToPath(new URL("./local-pi-fake-pi.mjs", import.meta.url));
export const DUMMY_KEY = "synthetic-vendor-key-for-local-pi-tests-0001";

export interface FakeConfig { record?: string; http?: boolean; httpPath?: string; call?: { suffix?: string; args: unknown }; text?: string; stop?: string; hang?: boolean; orphan?: boolean }

/** Writes what `npm ci` would leave, with the scripted pi as pi's own `cli.js`, so the real install, pins and verification code runs on it. */
export const fakeNpm = (configPath: string): NpmRunner => async (_exe, _argv, _env, cwd) => {
  const pkg = path.join(cwd, "node_modules", "@earendil-works", "pi-coding-agent");
  mkdirSync(path.join(pkg, "dist", "bundle"), { recursive: true });
  writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: packagedPiAssets().piVersion }));
  writeFileSync(path.join(pkg, "dist", "bundle", "cli.js"), readFileSync(FAKE, "utf8").replace("__CONFIG_PATH__", configPath));
  chmodSync(path.join(pkg, "dist", "bundle", "cli.js"), 0o755);
};

export const certifiedRow = (pins: LocalPiCertification["install"]["pins"], overrides: Partial<LocalPiCertification> = {}): LocalPiCertification => {
  const components = installedComponents();
  return { state: "certified_row", vendor: "pi-local", host: { platform: process.platform as "darwin" | "linux", arch: process.arch as "arm64" | "x64" }, nodeMajor: Number(/^v(\d+)/.exec(process.version)![1]), install: { pins },
    dependencies: { warble: components["@warble/cli"]!, ir: components["@warble/ir-spec"]!, "context-loader": components["@wrenai/context-loader"]! }, evidence: { approvalSha256: "a".repeat(64) }, ...overrides };
};

export async function installFake(root: string, config: FakeConfig = {}) {
  const stateDir = path.join(root, "state"); mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const configPath = path.join(root, "fake-config.json");
  writeFileSync(configPath, JSON.stringify(config));
  const report = await installLocalPi({ stateDir, run: fakeNpm(configPath) });
  const assets = packagedPiAssets();
  const installDir = localPiInstallDir(stateDir, assets);
  return { stateDir, installDir, configPath, report, pins: computeLocalPiPins(installDir, assets), row: certifiedRow(report.pins), setConfig: (next: FakeConfig) => writeFileSync(configPath, JSON.stringify(next)) };
}

export interface StubRequest { readonly method: string; readonly url: string; readonly headers: http.IncomingHttpHeaders; readonly body: string }
/** A loopback upstream that records what it receives. `reply` may stream. */
export async function stubUpstream(reply?: (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void) {
  const seen: StubRequest[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      seen.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });
      if (reply) reply(req, res, body); else { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: true })); }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return { seen, port, origin: `http://127.0.0.1:${port}`, close: () => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }) };
}

/** The per-step directories under a steps root (the root also holds the node link and the relay copy). */
export const stepDirs = (root: string) => readdirSync(root).filter((name) => /^[0-9a-f-]{36}$/.test(name));
