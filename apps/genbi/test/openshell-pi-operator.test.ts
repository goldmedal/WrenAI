import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PiOperatorError, describePackagedCertification, piOperatorSpecSchema, provisionPiBoot, verifyPiBoot, type OperatorRunner } from "../server/openshell-pi-operator.js";
import { readOpenShellPiBoot } from "../server/runtime-host/openshell-pi-boot.js";
import { canonicalGatewayProfileDigest } from "../server/runtime-host/openshell-pi-gateway.js";
import { renderPiEndpointAssets } from "../server/runtime-host/openshell-pi-assets.js";
import { resolveRuntimeSelection } from "../server/runtime-selection.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const digest = `sha256:${"a".repeat(64)}`;
const IMAGE = `sha256:${"1".repeat(64)}`;

function fixture(overrides: Record<string, unknown> = {}) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "pi-operator-"))); roots.push(root); chmodSync(root, 0o700);
  const pki = path.join(root, "pki"); mkdirSync(pki, { mode: 0o700 });
  for (const name of ["ca.crt", "client.crt", "client.key"]) writeFileSync(path.join(pki, name), "synthetic-pki", { mode: 0o600 });
  const executable = path.join(root, "openshell"); writeFileSync(executable, "#!/bin/sh\n", { mode: 0o700 });
  const dockerExecutable = path.join(root, "docker"); writeFileSync(dockerExecutable, "#!/bin/sh\n", { mode: 0o700 });
  const policy = path.join(root, "base-policy.yaml"); writeFileSync(policy, "version: 1\n");
  const baseDriverConfig = path.join(root, "base.json");
  writeFileSync(baseDriverConfig, JSON.stringify({ executable, executableDigest: digest, version: "0.0.9", gateway: "operator-gw", workspace: "default", image: `sha256:${"b".repeat(64)}`, supervisorImage: digest,
    policy, policyDigest: digest, home: root, configHome: root, stateHome: root, dockerExecutable, dockerRealpath: dockerExecutable, dockerDigest: digest, dockerSocket: path.join(root, "docker.sock"), dockerNamespace: "operator-gw", exclusive: true,
    model: { image: `sha256:${"d".repeat(64)}`, policy, policyDigest: digest } }));
  const outDir = path.join(root, "out");
  const spec = { version: 1, baseDriverConfig, outDir, imageTag: "operator-pi-worker:1.0.4", gatewayUrl: "https://127.0.0.1:9443/", caCert: path.join(pki, "ca.crt"), clientCert: path.join(pki, "client.crt"), clientKey: path.join(pki, "client.key"),
    auth: "api-key", provider: "vendor-provider", profileId: "vendor-profile", displayLabel: "Synthetic Vendor", generation: "gen-1",
    endpoint: { providerId: "vendor", api: "openai-completions", baseUrl: "https://api.vendor.example.test/v1", credentialEnv: "VENDOR_KEY" }, thinking: "off", models: { cheap: "model-cheap", strong: "model-strong" }, ...overrides };
  return { root, spec, outDir, executable, dockerExecutable };
}
/** A fake docker and OpenShell. It records every command, so what ran, and what never ran, is observed. */
function fakeGateway(f: ReturnType<typeof fixture>, options: { imageId?: string; profile?: "absent" | "present" | "foreign"; providerExists?: boolean; failBuild?: boolean } = {}) {
  const calls: { exe: string; argv: string[] }[] = [];
  const state = { profile: undefined as unknown, imported: 0 };
  const assets = renderPiEndpointAssets({ host: "api.vendor.example.test", port: 443, profileId: "vendor-profile", displayName: "Synthetic Vendor", credentialEnv: "VENDOR_KEY" });
  void assets;
  const exportOf = (binaries = ["/usr/local/bin/node"], envVar = "VENDOR_KEY") => ({ id: "vendor-profile", display_name: "Synthetic Vendor", resource_version: "7", source: "custom", credentials: [{ name: "api_key", env_vars: [envVar] }],
    endpoints: [{ host: "api.vendor.example.test", port: 443, protocol: "rest", access: "read-write", enforcement: "enforce" }], binaries });
  if (options.profile === "present") state.profile = exportOf(); if (options.profile === "foreign") state.profile = exportOf(["/bin/sh"]);
  const run: OperatorRunner = async (exe, argv) => {
    calls.push({ exe, argv: [...argv] });
    if (exe === f.dockerExecutable) {
      if (argv[0] === "build") { if (options.failBuild) throw new Error("docker build failed with details"); return `${options.imageId ?? IMAGE}\n`; }
      if (argv[0] === "image") return `${options.imageId ?? IMAGE}\n`;
    }
    const rest = argv.slice(4);
    // As on a real gateway, lint refuses a profile id that is already registered.
    if (rest[0] === "provider" && rest[1] === "profile" && rest[2] === "lint") { if (state.profile) throw new Error("profile already exists"); return "ok"; }
    if (rest[0] === "provider" && rest[1] === "profile" && rest[2] === "export") { if (!state.profile) throw new Error("not found"); return JSON.stringify(state.profile); }
    if (rest[0] === "provider" && rest[1] === "profile" && rest[2] === "import") { state.profile = exportOf(); state.imported++; return "imported"; }
    if (rest[0] === "provider" && rest[1] === "list") return JSON.stringify({ next_page_token: "", providers: options.providerExists ? [{ name: "vendor-provider", type: "vendor-profile", credential_keys: ["VENDOR_KEY"] }] : [] });
    throw new Error(`unexpected command ${exe} ${argv.join(" ")}`);
  };
  return { run, calls, state };
}
const read = (file: string) => readFileSync(file, "utf8");
const mode = (file: string) => statSync(file).mode & 0o777;

describe("the operator spec holds no secret", () => {
  it("accepts the documented shape", () => { expect(piOperatorSpecSchema.safeParse(fixture().spec).success).toBe(true); });
  it.each(["apiKey", "key", "credential", "token", "password", "secret", "OPENAI_API_KEY"])("rejects a %s field", (name) => {
    expect(piOperatorSpecSchema.safeParse({ ...fixture().spec, [name]: "sk-synthetic" }).success).toBe(false);
  });
  it.each([["a relative output", { outDir: "out" }], ["a lower-case credential name", { endpoint: { providerId: "vendor", api: "openai-completions", baseUrl: "https://x.example.test/v1", credentialEnv: "vendor_key" } }],
    ["an alias as a model", { models: { cheap: "inherit" } }], ["a free-text label", { displayLabel: "<script>" }]] as const)("rejects %s", async (_name, change) => {
    const f = fixture(change as never); await expect(provisionPiBoot(f.spec, { dryRun: true })).rejects.toMatchObject({ code: "spec_invalid" });
  });
  it("rejects a gateway URL that is not a bare https origin", async () => {
    for (const gatewayUrl of ["http://127.0.0.1:9443/", "https://user:pw@127.0.0.1:9443/", "https://127.0.0.1:9443/path", "https://127.0.0.1:9443/?x=1"])
      await expect(provisionPiBoot(fixture({ gatewayUrl }).spec, { dryRun: true })).rejects.toMatchObject({ code: "spec_invalid" });
  });
  it("rejects an unusable base driver configuration", async () => {
    const f = fixture(); writeFileSync(f.spec.baseDriverConfig as string, "{}"); await expect(provisionPiBoot(f.spec, { dryRun: true })).rejects.toMatchObject({ code: "base_configuration_invalid" });
  });
});

describe("provision --dry-run", () => {
  it("runs no command, writes nothing and creates no directory, and still reports the plan, the asset digests and the provider command", async () => {
    const f = fixture(); const g = fakeGateway(f);
    const report = await provisionPiBoot(f.spec, { dryRun: true, run: g.run });
    expect(g.calls).toEqual([]); expect(existsSync(f.outDir)).toBe(false);
    const assets = renderPiEndpointAssets({ host: "api.vendor.example.test", port: 443, profileId: "vendor-profile", displayName: "Synthetic Vendor", credentialEnv: "VENDOR_KEY" });
    expect(report).toMatchObject({ ok: true, dryRun: true, certifiedRowAvailable: true, files: { "policy.yaml": sha(assets.policy), "profile.yaml": sha(assets.profile) } });
    expect(report.providerCommand).toBe(`VENDOR_KEY=<your key> ${f.executable} --gateway operator-gw --workspace default provider create --name vendor-provider --type vendor-profile --credential VENDOR_KEY`);
    expect(report.steps.map(step => step.status)).toEqual(["planned", "planned", "planned", "operator_action", "planned"]);
  });
});

describe("provision", () => {
  it("builds, renders, imports, writes a protected descriptor and a driver configuration, and prints but never runs the provider command", async () => {
    const f = fixture(); const g = fakeGateway(f); const report = await provisionPiBoot(f.spec, { run: g.run });
    expect(report).toMatchObject({ ok: true, dryRun: false, providerExists: false });
    expect(report.steps.map(step => `${step.name}:${step.status}`)).toEqual(["build image:done", "render policy and profile:done", "lint and import the profile:done", "print the provider-create command:operator_action", "write the descriptor and the driver configuration:done"]);
    expect(mode(f.outDir)).toBe(0o700); for (const name of ["policy.yaml", "profile.yaml", "pi-boot.json", "driver-config.json"]) expect(mode(path.join(f.outDir, name)), name).toBe(0o600);
    expect(g.calls[0]!.argv).toEqual(["build", "-q", "--platform", "linux/arm64", "-t", "operator-pi-worker:1.0.4", expect.stringMatching(/runtime-assets\/pi-worker\/$/)]);
    expect(g.calls.some(call => call.argv.includes("create"))).toBe(false); expect(g.calls.some(call => call.argv.includes("--credential"))).toBe(false);
    expect(g.state.imported).toBe(1); expect(report.providerCommand).toContain("<your key>");
    const profile = read(path.join(f.outDir, "profile.yaml")); expect(profile).toContain("- VENDOR_KEY"); expect(profile).not.toMatch(/sk-|api_key_value/i);
  });
  it("writes a descriptor the server reads, carrying the gateway export's canonical digest, and a driver configuration with only the pi block", async () => {
    const f = fixture(); const g = fakeGateway(f); await provisionPiBoot(f.spec, { run: g.run });
    const env = { GENBI_RUNTIME: "openshell", GENBI_BACKEND: "pi", GENBI_OPENSHELL_PI_BOOT: path.join(f.outDir, "pi-boot.json") };
    const boot = readOpenShellPiBoot(env, resolveRuntimeSelection(env));
    expect(boot?.descriptor).toMatchObject({ provider: "vendor-provider", profileId: "vendor-profile", auth: "api-key", generation: "gen-1", models: { cheap: "model-cheap", strong: "model-strong" } });
    expect(boot?.descriptor.profileDigest).toBe(canonicalGatewayProfileDigest(g.state.profile));
    const config = JSON.parse(read(path.join(f.outDir, "driver-config.json")));
    expect(config.model).toBeUndefined(); expect(config).toMatchObject({ gateway: "operator-gw", dockerNamespace: "operator-gw", exclusive: true });
    expect(config.pi).toEqual({ image: IMAGE, policy: path.join(f.outDir, "policy.yaml"), policyDigest: `sha256:${sha(read(path.join(f.outDir, "policy.yaml")))}`, provider: "vendor-provider", profile: path.join(f.outDir, "profile.yaml"), profileDigest: `sha256:${sha(read(path.join(f.outDir, "profile.yaml")))}` });
    expect(read(f.spec.baseDriverConfig as string)).toContain('"model"');
  });
  it("is idempotent: a second run changes nothing and reuses the imported profile", async () => {
    const f = fixture(); const g = fakeGateway(f); const first = await provisionPiBoot(f.spec, { run: g.run });
    const before = Object.fromEntries(readdirSync(f.outDir).map(name => [name, read(path.join(f.outDir, name))]));
    const second = await provisionPiBoot(f.spec, { run: g.run });
    expect(second.steps.map(step => step.status)).toEqual(["done", "unchanged", "reused", "operator_action", "unchanged"]); expect(second.files).toEqual(first.files); expect(g.state.imported).toBe(1);
    expect(g.calls.filter(call => call.argv.includes("lint"))).toHaveLength(1); expect(g.calls.filter(call => call.argv.includes("import"))).toHaveLength(1);
    expect(Object.fromEntries(readdirSync(f.outDir).map(name => [name, read(path.join(f.outDir, name))]))).toEqual(before);
  });
  it.each([
    ["a new image", { imageId: `sha256:${"2".repeat(64)}` }, undefined, "driver-config.json"],
    ["a new model", undefined, { models: { cheap: "other-model", strong: "model-strong" } }, "pi-boot.json"],
    ["a new generation", undefined, { generation: "gen-2" }, "pi-boot.json"],
  ] as const)("refuses to overwrite a changed descriptor or configuration for %s unless --replace, and changes nothing", async (_name, gateway, change, name) => {
    const f = fixture(); await provisionPiBoot(f.spec, { run: fakeGateway(f).run });
    const before = Object.fromEntries(readdirSync(f.outDir).map(entry => [entry, read(path.join(f.outDir, entry))]));
    const next = { ...f.spec, ...(change ?? {}) }; const g = fakeGateway(f, { ...(gateway ?? {}), profile: "present" });
    await expect(provisionPiBoot(next, { run: g.run })).rejects.toMatchObject({ code: "refused_to_overwrite", message: expect.stringContaining(name) });
    expect(Object.fromEntries(readdirSync(f.outDir).map(entry => [entry, read(path.join(f.outDir, entry))]))).toEqual(before);
    const replaced = await provisionPiBoot(next, { run: g.run, replace: true }); expect(replaced.ok).toBe(true);
    expect(read(path.join(f.outDir, name))).not.toBe(before[name]);
  });
  it("refuses a changed rendered asset before any docker or gateway command", async () => {
    const f = fixture(); await provisionPiBoot(f.spec, { run: fakeGateway(f).run });
    writeFileSync(path.join(f.outDir, "policy.yaml"), "version: 1\n# edited by hand\n", { mode: 0o600 });
    const g = fakeGateway(f, { profile: "present" });
    await expect(provisionPiBoot(f.spec, { run: g.run })).rejects.toMatchObject({ code: "refused_to_overwrite" }); expect(g.calls).toEqual([]);
  });
  it("refuses a symbolic link in place of an output file", async () => {
    const f = fixture(); mkdirSync(f.outDir, { mode: 0o700 }); const target = path.join(f.root, "elsewhere"); writeFileSync(target, "x");
    const { symlinkSync } = await import("node:fs"); symlinkSync(target, path.join(f.outDir, "pi-boot.json"));
    await expect(provisionPiBoot(f.spec, { run: fakeGateway(f).run })).rejects.toMatchObject({ code: "refused_to_overwrite" }); expect(read(target)).toBe("x");
  });
  it("refuses a gateway profile of the same id that is not the rendered one, and writes no descriptor", async () => {
    const f = fixture(); const g = fakeGateway(f, { profile: "foreign" });
    await expect(provisionPiBoot(f.spec, { run: g.run })).rejects.toMatchObject({ code: "profile_refused" });
    expect(existsSync(path.join(f.outDir, "pi-boot.json"))).toBe(false); expect(g.state.imported).toBe(0);
  });
  it("reports the provider as existing only when its type and credential name match, and still only prints the command", async () => {
    const f = fixture(); const g = fakeGateway(f, { providerExists: true }); const report = await provisionPiBoot(f.spec, { run: g.run });
    expect(report.providerExists).toBe(true); expect(g.calls.some(call => call.argv.includes("create"))).toBe(false);
  });
  it("fails with a build error that names no output and writes no descriptor", async () => {
    const f = fixture(); const g = fakeGateway(f, { failBuild: true });
    await expect(provisionPiBoot(f.spec, { run: g.run })).rejects.toMatchObject({ code: "build_failed", message: expect.not.stringContaining("details") });
    expect(existsSync(path.join(f.outDir, "pi-boot.json"))).toBe(false);
  });
  it("runs every command with an explicit minimal environment and never the ambient one", async () => {
    const f = fixture(); const environments: NodeJS.ProcessEnv[] = [];
    const g = fakeGateway(f); await provisionPiBoot(f.spec, { run: async (exe, argv, env, timeout) => { environments.push(env); return g.run(exe, argv, env, timeout); } });
    for (const env of environments) expect(Object.keys(env).sort()).toEqual(expect.arrayContaining(["HOME", "LANG", "PATH"]));
    for (const env of environments) expect(Object.keys(env).filter(name => !["PATH", "HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "LANG", "DOCKER_HOST"].includes(name))).toEqual([]);
  });
  it("passes the optional docker configuration directory to docker only, never to the OpenShell CLI", async () => {
    const f = fixture({ dockerConfig: path.join(os.tmpdir(), "operator-docker-config") }); const seen: { exe: string; env: NodeJS.ProcessEnv }[] = [];
    const g = fakeGateway(f); await provisionPiBoot(f.spec, { run: async (exe, argv, env, timeout) => { seen.push({ exe, env }); return g.run(exe, argv, env, timeout); } });
    for (const call of seen) expect(call.env["DOCKER_CONFIG"] === path.join(os.tmpdir(), "operator-docker-config"), call.exe).toBe(call.exe === f.dockerExecutable);
  });
});

describe("the operator helper never handles a key", () => {
  it("reads no environment variable at all while provisioning, dry-running or describing, and no canary ever reaches a file or a report", async () => {
    const canary = "sk-synthetic-canary-value-0123456789"; const original = process.env; const reads: string[] = [];
    const names = ["OPENAI_API_KEY", "VENDOR_KEY", "GENBI_GATEWAY_API_KEY", "ANTHROPIC_API_KEY", "WREN_HARNESS_API_KEY"]; for (const name of names) original[name] = canary;
    process.env = new Proxy(original, { get(target, property) { if (typeof property === "string") reads.push(property); return Reflect.get(target, property); }, has(target, property) { if (typeof property === "string") reads.push(property); return Reflect.has(target, property); } });
    try {
      const f = fixture(); const g = fakeGateway(f);
      const reports = [await provisionPiBoot(f.spec, { dryRun: true, run: g.run }), await provisionPiBoot(f.spec, { run: g.run }), await provisionPiBoot(f.spec, { run: g.run })];
      describePackagedCertification(); await verifyPiBoot(f.outDir).catch(() => {});
      expect(reads).toEqual([]);
      const text = JSON.stringify([reports, g.calls]) + readdirSync(f.outDir).map(name => read(path.join(f.outDir, name))).join("\n");
      expect(text).not.toContain(canary);
    } finally { process.env = original; for (const name of names) delete original[name]; }
  });
  it("has no process.env in the helper's code, and no credential parameter anywhere in its interface", () => {
    for (const file of ["../server/openshell-pi-operator.ts", "../bin/genbi-openshell-pi.mjs"]) {
      const source = readFileSync(new URL(file, import.meta.url), "utf8"); expect(source, file).not.toMatch(/process\.env|\benv\[|getenv/);
    }
    const bin = readFileSync(new URL("../bin/genbi-openshell-pi.mjs", import.meta.url), "utf8");
    expect(bin).not.toMatch(/--(?:key|api-key|credential|token|password|secret)\b/);
    expect(Object.keys(piOperatorSpecSchema.shape)).not.toEqual(expect.arrayContaining(["apiKey"]));
  });
});

describe("verify mirrors the boot checks in order", () => {
  it("fails at the descriptor when none exists, naming a fixed code", async () => {
    const f = fixture(); mkdirSync(f.outDir, { mode: 0o700 });
    expect(await verifyPiBoot(f.outDir)).toEqual({ ok: false, checks: [{ name: "protected descriptor", ok: false, code: "openshell_configuration_invalid" }] });
  });
  it("fails at the driver configuration when it carries a Claude model block next to the pi block, or names another provider", async () => {
    const f = fixture(); await provisionPiBoot(f.spec, { run: fakeGateway(f).run });
    const file = path.join(f.outDir, "driver-config.json"); const config = JSON.parse(read(file));
    writeFileSync(file, JSON.stringify({ ...config, model: JSON.parse(read(f.spec.baseDriverConfig as string)).model })); expect((await verifyPiBoot(f.outDir)).checks.at(-1)).toMatchObject({ name: "driver configuration", ok: false });
    writeFileSync(file, JSON.stringify({ ...config, pi: { ...config.pi, provider: "someone-else" } })); expect((await verifyPiBoot(f.outDir)).checks.at(-1)).toMatchObject({ name: "driver configuration", ok: false });
  });
  it("fails at the driver probe when the configured OpenShell executable is not the attested one", async () => {
    const f = fixture(); await provisionPiBoot(f.spec, { run: fakeGateway(f).run });
    expect(await verifyPiBoot(f.outDir)).toMatchObject({ ok: false, checks: [{ name: "protected descriptor", ok: true }, { name: "driver configuration", ok: true }, { name: "driver probe", ok: false, code: "openshell_identity_mismatch" }] });
  });
});

describe("verify reports the right step and fails closed at each effectful check", () => {
  const passing = { probeDriver: async () => {}, gatewayProof: () => async () => {}, certification: () => async () => ({ ready: true, version: "1.0.4" }) as const };
  const provisioned = async () => { const f = fixture(); await provisionPiBoot(f.spec, { run: fakeGateway(f).run }); return f; };
  const names = ["protected descriptor", "driver configuration", "driver probe", "gateway proof", "certified identity"];
  it("passes with all five checks in boot order when every check passes", async () => {
    const f = await provisioned(); expect(await verifyPiBoot(f.outDir, { checks: passing })).toEqual({ ok: true, checks: names.map(name => ({ name, ok: true })) });
  });
  it.each([["a coded error", Object.assign(new Error("x"), { code: "openshell_identity_mismatch" }), "openshell_identity_mismatch"], ["an uncoded error", new Error("x"), "openshell_unavailable"]])("fails at the gateway proof with %s and never reads the identity", async (_name, error, code) => {
    const f = await provisioned(); const certification = vi.fn(() => async () => ({ ready: true, version: "1.0.4" }) as const);
    const report = await verifyPiBoot(f.outDir, { checks: { ...passing, gatewayProof: () => async () => { throw error; }, certification } });
    expect(report).toEqual({ ok: false, checks: [...names.slice(0, 3).map(name => ({ name, ok: true })), { name: "gateway proof", ok: false, code }] }); expect(certification).not.toHaveBeenCalled();
  });
  it.each(["pi_uncertified", "pi_identity_mismatch", "pi_dependencies_drifted", "runtime_probe_failed"] as const)("fails at the certified identity with %s", async (code) => {
    const f = await provisioned();
    const report = await verifyPiBoot(f.outDir, { checks: { ...passing, certification: () => async () => ({ ready: false, code }) } });
    expect(report.ok).toBe(false); expect(report.checks).toEqual([...names.slice(0, 4).map(name => ({ name, ok: true })), { name: "certified identity", ok: false, code }]);
  });
  it("fails closed at the certified identity when the gate itself rejects", async () => {
    const f = await provisioned();
    expect(await verifyPiBoot(f.outDir, { checks: { ...passing, certification: () => async () => { throw new Error("docker down"); } } })).toMatchObject({ ok: false, checks: [{}, {}, {}, {}, { name: "certified identity", ok: false, code: "runtime_probe_failed" }] });
  });
  it("fails at the driver probe before the gateway proof is attempted", async () => {
    const f = await provisioned(); const gatewayProof = vi.fn(() => async () => {});
    const report = await verifyPiBoot(f.outDir, { checks: { ...passing, probeDriver: async () => { throw Object.assign(new Error("x"), { code: "openshell_version_mismatch" }); }, gatewayProof } });
    expect(report.checks.at(-1)).toEqual({ name: "driver probe", ok: false, code: "openshell_version_mismatch" }); expect(gatewayProof).not.toHaveBeenCalled();
  });
  it("passes the descriptor of this directory to the injected checks", async () => {
    const f = await provisioned(); const seen: string[] = [];
    await verifyPiBoot(f.outDir, { checks: { ...passing, gatewayProof: (_c, descriptor) => { seen.push(descriptor.provider); return async () => {}; }, certification: (configuration) => { seen.push(configuration.pi!.provider); return async () => ({ ready: true, version: "1.0.4" }) as const; } } });
    expect(seen).toEqual(["vendor-provider", "vendor-provider"]);
  });
});

describe("the packaged certification description", () => {
  it("reports one pi row that matches the assets this package ships, with no path", () => {
    const description = describePackagedCertification() as { rows: Record<string, unknown>[] };
    expect(description.rows).toHaveLength(1); expect(description.rows[0]).toMatchObject({ vendor: "pi", state: "certified_row", host: { platform: "darwin", arch: "arm64" }, packagedAssetsMatch: true });
    expect(JSON.stringify(description)).not.toMatch(/\/Users\/|\/private\/|\/home\/|\/tmp\//);
  });
  it("reports a mismatch when a shipped asset changes", () => {
    const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "pi-assets-"))); roots.push(root);
    const source = new URL("../runtime-assets/pi-worker/", import.meta.url);
    for (const name of readdirSync(source)) writeFileSync(path.join(root, name), readFileSync(new URL(name, source)));
    expect((describePackagedCertification(root) as { rows: { packagedAssetsMatch: boolean }[] }).rows[0]!.packagedAssetsMatch).toBe(true);
    writeFileSync(path.join(root, "pi-worker.mjs"), `${read(path.join(root, "pi-worker.mjs"))}\n// changed\n`);
    expect((describePackagedCertification(root) as { rows: { packagedAssetsMatch: boolean }[] }).rows[0]!.packagedAssetsMatch).toBe(false);
  });
});

describe("the CLI entry", () => {
  const bin = new URL("../bin/genbi-openshell-pi.mjs", import.meta.url).pathname;
  const run = (args: string[]) => spawnSync(process.execPath, [bin, ...args], { env: { PATH: "/usr/bin:/bin" }, encoding: "utf8" });
  it("prints the packaged row and exits 0", () => {
    const result = run(["row"]); expect(result.status, result.stderr).toBe(0); expect(JSON.parse(result.stdout).rows[0]).toMatchObject({ vendor: "pi", packagedAssetsMatch: true });
  });
  it("dry-runs a spec, prints the provider command with a placeholder, and creates nothing", () => {
    const f = fixture(); const specFile = path.join(f.root, "spec.json"); writeFileSync(specFile, JSON.stringify(f.spec));
    const result = run(["provision", "--spec", specFile, "--dry-run"]); expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("VENDOR_KEY=<your key>"); expect(result.stdout).toContain('"dryRun": true'); expect(existsSync(f.outDir)).toBe(false);
  });
  it.each([[[]], [["provision"]], [["provision", "--spec", "relative.json"]], [["verify"]], [["row", "--api-key", "x"]], [["frobnicate"]]] as const)("refuses %j with a usage error and exit 1", (args) => {
    const result = run([...args]); expect(result.status).toBe(1); expect(JSON.parse(result.stderr.split("\n").find(line => line.startsWith("{\"ok\""))!)).toMatchObject({ ok: false });
  });
  it("reports a spec that carries a key field as invalid and never echoes the value", () => {
    const f = fixture({ apiKey: "sk-synthetic-should-never-echo" }); const specFile = path.join(f.root, "spec.json"); writeFileSync(specFile, JSON.stringify(f.spec));
    const result = run(["provision", "--spec", specFile, "--dry-run"]); expect(result.status).toBe(1); expect(result.stderr).toContain("spec_invalid"); expect(result.stdout + result.stderr).not.toContain("sk-synthetic-should-never-echo");
  });
});
void PiOperatorError;
