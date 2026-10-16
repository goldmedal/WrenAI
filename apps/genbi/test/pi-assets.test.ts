import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderPiEndpointAssets } from "../server/runtime-host/openshell-pi-assets.js";
// @ts-expect-error plain JS worker asset
import { hashTree } from "../runtime-assets/pi-worker/pi-pins.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const assets = path.resolve(here, "../runtime-assets/pi-worker");
const text = (file: string) => readFileSync(path.join(assets, file), "utf8");
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const params = { host: "model.example.test", port: 443, profileId: "pi-endpoint", displayName: "Example model", credentialEnv: "MODEL_API_KEY" };

describe("pi worker image definition", () => {
  const dockerfile = text("Dockerfile");
  it("uses the same pinned public Node base as the Claude worker and installs only what the sandbox needs", () => {
    const base = (source: string) => /^FROM (node:\S+@sha256:[a-f0-9]{64})/m.exec(source)![1];
    expect(base(dockerfile)).toBe(base(readFileSync(path.resolve(here, "../runtime-assets/claude-worker/Dockerfile"), "utf8"))); expect(base(dockerfile)).toBe("node:24.20.0-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e");
    expect(dockerfile).toMatch(/apt-get install -y --no-install-recommends ca-certificates iproute2 nftables/);
    expect(dockerfile).toMatch(/npm ci --ignore-scripts/); expect(dockerfile).not.toMatch(/npm install/);
    expect(dockerfile).toMatch(/rm -rf [^\n]*\/usr\/local\/bin\/npm \/usr\/local\/bin\/npx/); expect(dockerfile).toMatch(/groupadd -g 1500 sandbox && useradd -u 1500 -g 1500/); expect(dockerfile).toMatch(/^USER 1500:1500$/m);
    expect([...dockerfile.matchAll(/^COPY (.+)$/gm)].map(match => match[1])).toEqual(["package.json package-lock.json ./", "pi-worker.mjs pi-worker-core.mjs pi-mcp-shim.mjs pi-proc-check.mjs pi-pins.mjs claude-worker-ca.mjs /opt/genbi/"]);
    const instructions = dockerfile.replace(/^#.*$/gm, "");
    for (const forbidden of [/\bwren\b/i, /project/i, /\bHOME=/, /\bENV\b/, /\bARG\b/, /--mount/, /\bVOLUME\b/, /API_KEY/]) expect(instructions, String(forbidden)).not.toMatch(forbidden);
  });
  it("pins pi 1.0.4 exactly, with a lockfile that freezes every transitive dependency at its tested version", () => {
    const manifest = JSON.parse(text("package.json")); expect(manifest.dependencies).toEqual({ "@earendil-works/pi-coding-agent": "1.0.4" });
    const lock = JSON.parse(text("package-lock.json")); expect(lock.lockfileVersion).toBe(3); expect(lock.packages[""].dependencies).toEqual({ "@earendil-works/pi-coding-agent": "1.0.4" });
    expect(lock.packages["node_modules/@earendil-works/pi-coding-agent"].version).toBe("1.0.4");
    for (const [name, entry] of Object.entries(lock.packages as Record<string, { version: string; integrity?: string; resolved?: string }>)) {
      if (!name) continue;
      expect(entry.integrity, name).toMatch(/^sha512-/); expect(entry.resolved, name).toMatch(/^https:\/\/registry\.npmjs\.org\//);
      if (name.startsWith("node_modules/@earendil-works/")) expect(entry.version, name).toBe("1.0.4");
    }
  });
  it("is covered by the package files and the installed-package acceptance", () => {
    expect(JSON.parse(readFileSync(path.resolve(here, "../package.json"), "utf8")).files).toContain("dist-server/runtime-assets");
    expect(readFileSync(path.resolve(here, "../scripts/installed-package-acceptance.mjs"), "utf8")).toContain("package/dist-server/runtime-assets/pi-worker/pi-worker.mjs");
    for (const file of ["pi-worker.mjs", "pi-worker-core.mjs", "pi-mcp-shim.mjs", "pi-proc-check.mjs", "pi-pins.mjs", "claude-worker-ca.mjs"]) expect(spawnSync(process.execPath, ["--check", path.join(assets, file)]).status, file).toBe(0);
  });
});

describe("pi endpoint templates", () => {
  it("renders a deny-all policy with exactly one model endpoint bound to node and a read-only trust store", () => {
    const { policy } = renderPiEndpointAssets(params);
    expect(policy).not.toContain("{{"); expect([...policy.matchAll(/^  ([a-z_]+):$/gm)].map(match => match[1])).toEqual(["model_provider"]);
    expect([...policy.matchAll(/- host: (\S+)/g)].map(match => match[1])).toEqual(["model.example.test"]); expect([...policy.matchAll(/port: (\d+)/g)].map(match => match[1])).toEqual(["443"]);
    expect([...policy.matchAll(/- path: (\S+)/g)].map(match => match[1])).toEqual(["/usr/local/bin/node"]);
    expect(policy).toMatch(/read_only: \[[^\]]*\/etc\/openshell-tls[^\]]*\]/); expect(policy).toMatch(/read_only: \[[^\]]*\/opt\/pi[^\]]*\/opt\/genbi[^\]]*\]/); expect(policy).toMatch(/read_write: \[\/sandbox, \/tmp, \/dev\/null\]/);
    expect(policy).toMatch(/compatibility: hard_requirement/); expect(policy).toMatch(/run_as_user: "1500"/); expect(policy).toMatch(/include_workdir: false/); expect(policy).toMatch(/protocol: rest/); expect(policy).toMatch(/enforcement: enforce/);
    expect(policy.match(/read_write: \[([^\]]*)\]/)![1]).not.toContain("openshell-tls");
  });
  it("renders a profile whose credential is injected, never embedded, and whose endpoint matches the policy", () => {
    const { profile, policy } = renderPiEndpointAssets(params);
    expect(profile).not.toContain("{{"); expect(profile).toMatch(/^id: pi-endpoint$/m); expect(profile).toMatch(/env_vars:\n  - MODEL_API_KEY/); expect(profile).toMatch(/auth_style: bearer/);
    expect(profile).toMatch(/- host: model\.example\.test\n {2}port: 443/); expect(profile).toMatch(/binaries:\n- \/usr\/local\/bin\/node/); expect(profile).not.toMatch(/sk-|secret|value:/i);
    expect(profile.match(/host: (\S+)/)![1]).toBe(policy.match(/host: (\S+)/)![1]);
  });
  it.each([["a host with a path", { host: "a/b" }], ["a host with a port", { host: "a.example:80" }], ["a host with a newline", { host: "a.example\nport: 1" }], ["an injection token", { host: "{{ENDPOINT_PORT}}" }], ["an empty host", { host: "" }],
    ["port zero", { port: 0 }], ["a port above the range", { port: 70000 }], ["a fractional port", { port: 1.5 }], ["an uppercase profile id", { profileId: "Bad" }], ["a lowercase credential name", { credentialEnv: "key" }], ["a display name with a newline", { displayName: "a\nb" }], ["an unknown field", { extra: 1 }]])("refuses %s", (_name, patch) => {
    expect(() => renderPiEndpointAssets({ ...params, ...patch } as never)).toThrow();
  });
});

describe("image pins", () => {
  it("digests a tree by name order and content, and refuses anything that is not a plain file", () => {
    const root = mkdtempSync(path.join(tmpdir(), "genbi-pi-pins-")); roots.push(root); mkdirSync(path.join(root, "b")); writeFileSync(path.join(root, "z.txt"), "z"); writeFileSync(path.join(root, "a.txt"), "a"); writeFileSync(path.join(root, "b", "c.txt"), "c");
    const sha = (value: string) => createHash("sha256").update(value).digest("hex");
    expect(hashTree(root)).toBe(sha(`${sha("a")}  a.txt\n${sha("c")}  b/c.txt\n${sha("z")}  z.txt\n`));
    writeFileSync(path.join(root, "a.txt"), "changed"); expect(hashTree(root)).not.toBe(sha(`${sha("a")}  a.txt\n${sha("c")}  b/c.txt\n${sha("z")}  z.txt\n`));
    symlinkSync("/etc/passwd", path.join(root, "link")); expect(() => hashTree(root)).toThrow();
  });
});
