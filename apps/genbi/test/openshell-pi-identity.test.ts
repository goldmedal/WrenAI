import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PI_IDENTITY_TOTAL_DEADLINE_MS, assertPiCertified, createPiCertificationGate, requirePiCertification, createPiImagePinsReader, piAssetsConform, type PiGateVerdict } from "../server/runtime-host/openshell-pi-identity.js";
import { PI_CERTIFIED_ROWS, piCertificationSchema, shippedPiTemplateDigests, type InstalledComponents, type PiCertification } from "../server/runtime-host/openshell-vendor-certification.js";
import { renderPiEndpointAssets } from "../server/runtime-host/openshell-pi-assets.js";
import { OpenShellError } from "../server/runtime-host/openshell-types.js";
import type { OpenShellPiBootDescriptor } from "../server/runtime-host/openshell-pi-boot.js";

const roots: string[] = [];
afterEach(() => { vi.useRealTimers(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const certified = (): PiCertification => structuredClone(piCertificationSchema.parse(PI_CERTIFIED_ROWS[0]));
const installedFor = (row: PiCertification): InstalledComponents => ({
  "@warble/cli": row.dependencies.warble, "@warble/codex-local": row.dependencies.warble, "@warble/claude-agent-sdk": row.dependencies.warble,
  "@warble/ir-spec": row.dependencies.ir, "@wrenai/context-loader": row.dependencies["context-loader"],
});

/** A ustar archive with one regular file, as `docker cp <container>:<file> -` writes it. */
function tar(name: string, content: string, type = "0"): Buffer {
  const header = Buffer.alloc(512); header.write(name, 0, "latin1"); header.write("0000644\0", 100); header.write(`${content.length.toString(8).padStart(11, "0")}\0`, 124); header[156] = type.charCodeAt(0);
  header.write("ustar\0", 257);
  const body = Buffer.alloc(Math.ceil(content.length / 512) * 512); body.write(content, 0, "latin1");
  return Buffer.concat([header, body, Buffer.alloc(1024)]);
}
const fixture = () => {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "pi-identity-"))); roots.push(root); chmodSync(root, 0o700);
  const docker = path.join(root, "docker"); writeFileSync(docker, "#!/bin/sh\n", { mode: 0o700 });
  const row = certified();
  const descriptor = { endpoint: { providerId: "vendor", api: "openai-completions", baseUrl: "https://api.vendor.example.test/v1", credentialEnv: "VENDOR_KEY" }, profileId: "vendor-profile" } as unknown as OpenShellPiBootDescriptor;
  const rendered = renderPiEndpointAssets({ host: "api.vendor.example.test", port: 443, profileId: "vendor-profile", displayName: "synthetic vendor", credentialEnv: "VENDOR_KEY" });
  const policy = path.join(root, "policy.yaml"), profile = path.join(root, "profile.yaml");
  writeFileSync(policy, rendered.policy); writeFileSync(profile, rendered.profile);
  const configuration = { dockerExecutable: docker, dockerRealpath: docker, dockerDigest: `sha256:${sha(Buffer.from("#!/bin/sh\n"))}`, dockerSocket: path.join(root, "docker.sock"), dockerNamespace: "synthetic",
    executableDigest: `sha256:${row.gateway.executableSha256}`, version: row.gateway.version, home: root, configHome: root, stateHome: root,
    pi: { image: `sha256:${"c".repeat(64)}`, policy, policyDigest: `sha256:${sha(rendered.policy)}`, provider: "vendor-provider", profile, profileDigest: `sha256:${sha(rendered.profile)}` } };
  const calls: string[][] = []; const containers = new Set<string>();
  const run = vi.fn<(exe: string, argv: readonly string[], env: NodeJS.ProcessEnv, signal?: AbortSignal) => Promise<string>>(async (_exe, argv) => {
    calls.push([...argv]);
    if (argv[0] === "ps") return [...containers].join("\n");
    if (argv[0] === "create") { containers.add(argv[argv.indexOf("--name") + 1]!); return "container-id\n"; }
    if (argv[0] === "cp") return tar("pins.json", JSON.stringify(row.image.pins)).toString("latin1");
    if (argv[0] === "rm") { for (const name of argv.slice(2)) containers.delete(name); return ""; }
    throw new Error(`unexpected docker ${argv[0]}`);
  });
  return { root, row, descriptor, configuration, run, calls, containers, policy, profile, rendered };
};

describe("resolve-only reading of a pi image's pins", () => {
  it("creates the configured image id without starting it, copies one file out and removes the container", async () => {
    const f = fixture(); const read = createPiImagePinsReader({ configuration: f.configuration, run: f.run as never });
    expect(await read()).toEqual(f.row.image.pins);
    expect(f.calls.map(argv => argv[0])).toEqual(["ps", "create", "cp", "rm"]);
    const create = f.calls[1]!; expect(create).toEqual(["create", "--pull", "never", "--name", expect.stringMatching(/^genbi-pi-identity-[a-f0-9]{16}$/), "--label", "genbi-pi-identity=synthetic", "--network", "none", f.configuration.pi.image]);
    const name = create[4]; expect(f.calls[2]).toEqual(["cp", `${name}:/opt/genbi/pins.json`, "-"]); expect(f.calls[3]).toEqual(["rm", "-f", name]);
    expect(f.calls.flat()).not.toContain("start"); expect(f.calls.flat()).not.toContain("run"); expect(f.calls.flat()).not.toContain("exec");
    expect(f.containers.size).toBe(0);
  });
  it("runs docker with its explicit minimal environment and the driver's socket, never the ambient environment", async () => {
    const f = fixture(); await createPiImagePinsReader({ configuration: f.configuration, run: f.run as never })();
    for (const call of f.run.mock.calls) {
      expect(call[0]).toBe(f.configuration.dockerExecutable);
      expect(call[2]).toEqual({ PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: f.root, XDG_CONFIG_HOME: f.root, XDG_STATE_HOME: f.root, LANG: "en_US.UTF-8", DOCKER_HOST: `unix://${f.configuration.dockerSocket}` });
    }
  });
  it("sweeps a leftover labelled container of a crashed earlier read before creating a new one", async () => {
    const f = fixture(); f.containers.add("genbi-pi-identity-leftover00"); await createPiImagePinsReader({ configuration: f.configuration, run: f.run as never })();
    expect(f.calls[0]).toEqual(["ps", "-a", "-q", "--filter", "label=genbi-pi-identity=synthetic"]); expect(f.calls[1]![0]).toBe("rm"); expect(f.containers.size).toBe(0);
  });
  it("caches a successful read by image id and never a failed one", async () => {
    const f = fixture(); const read = createPiImagePinsReader({ configuration: f.configuration, run: f.run as never });
    await read(); await read(); expect(f.calls.filter(argv => argv[0] === "create")).toHaveLength(1);
    const g = fixture(); let fail = true;
    g.run.mockImplementation(async (_e, argv) => { if (argv[0] === "cp" && fail) throw new Error("nope"); g.calls.push([...argv]); if (argv[0] === "cp") return tar("pins.json", "{}").toString("latin1"); return argv[0] === "ps" ? "" : "id"; });
    const retry = createPiImagePinsReader({ configuration: g.configuration, run: g.run as never });
    await expect(retry()).rejects.toMatchObject({ code: "openshell_gateway_unavailable" }); fail = false; await expect(retry()).resolves.toEqual({});
  });
  it.each([
    ["a failed create", (argv: readonly string[]) => argv[0] === "create"],
    ["a failed copy", (argv: readonly string[]) => argv[0] === "cp"],
  ])("fails closed on %s and still removes the container it may have made", async (_name, fails) => {
    const f = fixture(); f.run.mockImplementation(async (_e, argv) => { f.calls.push([...argv]); if (fails(argv)) throw new Error("docker said no"); return argv[0] === "ps" ? "" : "id"; });
    await expect(createPiImagePinsReader({ configuration: f.configuration, run: f.run as never })()).rejects.toMatchObject({ code: "openshell_gateway_unavailable" });
    expect(f.calls.at(-1)![0]).toBe("rm");
  });
  it.each([
    ["a name other than pins.json", tar("other.json", "{}")],
    ["a directory entry", tar("pins.json", "{}", "5")],
    ["an empty file", tar("pins.json", "")],
    ["a file larger than a pins record", tar("pins.json", "x".repeat(9000))],
    ["a truncated archive", tar("pins.json", "{}").subarray(0, 100)],
  ])("rejects %s", async (_name, archive) => {
    const f = fixture(); f.run.mockImplementation(async (_e, argv) => { f.calls.push([...argv]); return argv[0] === "cp" ? archive.toString("latin1") : argv[0] === "ps" ? "" : "id"; });
    await expect(createPiImagePinsReader({ configuration: f.configuration, run: f.run as never })()).rejects.toMatchObject({ code: "openshell_protocol_invalid" });
    expect(f.calls.at(-1)![0]).toBe("rm");
  });
  it("is a closed error when the archive content is not JSON", async () => {
    const f = fixture(); f.run.mockImplementation(async (_e, argv) => argv[0] === "cp" ? tar("pins.json", "not json").toString("latin1") : argv[0] === "ps" ? "" : "id");
    await expect(createPiImagePinsReader({ configuration: f.configuration, run: f.run as never })()).rejects.toThrow();
  });
  it("refuses to run a docker executable whose bytes or location changed, before any command", async () => {
    const f = fixture(); writeFileSync(f.configuration.dockerExecutable, "#!/bin/sh\necho tampered\n");
    await expect(createPiImagePinsReader({ configuration: f.configuration, run: f.run as never })()).rejects.toMatchObject({ code: "openshell_identity_mismatch" });
    expect(f.run).not.toHaveBeenCalled();
    const g = fixture(); await expect(createPiImagePinsReader({ configuration: { ...g.configuration, dockerRealpath: path.join(g.root, "elsewhere") }, run: g.run as never })()).rejects.toMatchObject({ code: "openshell_identity_mismatch" });
  });
  it("is bounded as a whole: a hung docker becomes a closed error at the total deadline, with the container still removed", async () => {
    vi.useFakeTimers(); const f = fixture();
    f.run.mockImplementation((_e, argv, _env, signal) => argv[0] === "rm" ? Promise.resolve("") : new Promise((_resolve, reject) => { signal?.addEventListener("abort", () => reject(new OpenShellError("openshell_remote_unknown")), { once: true }); }));
    const read = createPiImagePinsReader({ configuration: f.configuration, run: f.run as never }); const outcome = read().then(() => "resolved", error => (error as OpenShellError).code);
    await vi.advanceTimersByTimeAsync(PI_IDENTITY_TOTAL_DEADLINE_MS + 1); expect(await outcome).toBe("openshell_gateway_unavailable");
  });
  it("never pulls: the create names the local image id with --pull never", async () => {
    const f = fixture(); await createPiImagePinsReader({ configuration: f.configuration, run: f.run as never })();
    const create = f.calls.find(argv => argv[0] === "create")!; expect(create.slice(0, 3)).toEqual(["create", "--pull", "never"]); expect(create.at(-1)).toBe(f.configuration.pi.image);
  });
  /** The last call must be the removal of the container that was created, run without the cancelled signal. */
  const expectRemovedAfterCreate = (f: ReturnType<typeof fixture>, calls: { argv: readonly string[]; signal: AbortSignal | undefined }[]) => {
    const created = calls.find(call => call.argv[0] === "create")!; const name = created.argv[created.argv.indexOf("--name") + 1];
    const last = calls.at(-1)!; expect(last.argv).toEqual(["rm", "-f", name]); expect(last.signal).toBeUndefined(); expect(f.containers.has(name!)).toBe(false);
  };
  it("removes the created container after the caller aborts in the middle of the read, even though the abort already fired", async () => {
    const f = fixture(); const controller = new AbortController(); const calls: { argv: readonly string[]; signal: AbortSignal | undefined }[] = [];
    f.run.mockImplementation(async (_e, argv, _env, signal) => {
      calls.push({ argv: [...argv], signal });
      if (argv[0] === "ps") return "";
      if (argv[0] === "create") { f.containers.add(argv[argv.indexOf("--name") + 1]!); return "id"; }
      if (argv[0] === "cp") { controller.abort(); throw new OpenShellError("openshell_remote_unknown"); }
      if (argv[0] === "rm") { if (signal?.aborted) throw new OpenShellError("openshell_remote_unknown"); for (const name of argv.slice(2)) f.containers.delete(name); return ""; }
      throw new Error("unexpected");
    });
    await expect(createPiImagePinsReader({ configuration: f.configuration, run: f.run as never })(controller.signal)).rejects.toThrow();
    expectRemovedAfterCreate(f, calls);
  });
  it("removes the created container after the total deadline fired, with the removal run on a fresh deadline", async () => {
    vi.useFakeTimers(); const f = fixture(); const calls: { argv: readonly string[]; signal: AbortSignal | undefined }[] = [];
    f.run.mockImplementation((_e, argv, _env, signal) => {
      calls.push({ argv: [...argv], signal });
      if (argv[0] === "ps") return Promise.resolve("");
      if (argv[0] === "create") { f.containers.add(argv[argv.indexOf("--name") + 1]!); return Promise.resolve("id"); }
      if (argv[0] === "rm") { if (signal?.aborted) return Promise.reject(new OpenShellError("openshell_remote_unknown")); for (const name of argv.slice(2)) f.containers.delete(name); return Promise.resolve(""); }
      return new Promise((_resolve, reject) => { signal?.addEventListener("abort", () => reject(new OpenShellError("openshell_remote_unknown")), { once: true }); });
    });
    const outcome = createPiImagePinsReader({ configuration: f.configuration, run: f.run as never })().then(() => "resolved", error => (error as OpenShellError).code);
    await vi.advanceTimersByTimeAsync(PI_IDENTITY_TOTAL_DEADLINE_MS + 1); expect(await outcome).toBe("openshell_gateway_unavailable");
    expectRemovedAfterCreate(f, calls);
  });
  it("propagates the caller's cancellation as a cancellation, not a verdict", async () => {
    const f = fixture(); const controller = new AbortController(); controller.abort();
    await expect(createPiImagePinsReader({ configuration: f.configuration, run: f.run as never })(controller.signal)).rejects.toThrow();
    expect(f.run).not.toHaveBeenCalled();
  });
  it("has nothing to read without a pi block", () => {
    const f = fixture(); const { pi: _pi, ...rest } = f.configuration;
    expect(() => createPiImagePinsReader({ configuration: rest as never, run: f.run as never })).toThrow();
  });
});

describe("the configured policy and profile must be instances of the shipped templates", () => {
  const f = () => fixture();
  it("accepts the templates rendered with the descriptor's own endpoint, profile id and credential name, for any operator label", () => {
    const x = f(); expect(piAssetsConform(x.descriptor, x.rendered.policy, x.rendered.profile)).toEqual({ policy: true, profile: true });
    const other = renderPiEndpointAssets({ host: "api.vendor.example.test", port: 443, profileId: "vendor-profile", displayName: "Another Label 2", credentialEnv: "VENDOR_KEY" });
    expect(piAssetsConform(x.descriptor, other.policy, other.profile)).toEqual({ policy: true, profile: true });
  });
  it.each([
    ["a policy that also allows a second endpoint", (x: ReturnType<typeof fixture>) => ({ policy: `${x.rendered.policy}      - host: evil.example.test\n`, profile: x.rendered.profile }), { policy: false, profile: true }],
    ["a policy with Landlock relaxed", (x: ReturnType<typeof fixture>) => ({ policy: x.rendered.policy.replace("hard_requirement", "best_effort"), profile: x.rendered.profile }), { policy: false, profile: true }],
    ["a policy for another endpoint", (x: ReturnType<typeof fixture>) => ({ policy: renderPiEndpointAssets({ host: "elsewhere.example.test", port: 443, profileId: "vendor-profile", displayName: "d", credentialEnv: "VENDOR_KEY" }).policy, profile: x.rendered.profile }), { policy: false, profile: true }],
    ["a profile with another binary", (x: ReturnType<typeof fixture>) => ({ policy: x.rendered.policy, profile: x.rendered.profile.replace("/usr/local/bin/node", "/bin/sh") }), { policy: true, profile: false }],
    ["a profile that injects a second credential", (x: ReturnType<typeof fixture>) => ({ policy: x.rendered.policy, profile: x.rendered.profile.replace("  - VENDOR_KEY", "  - VENDOR_KEY\n  - OTHER_KEY") }), { policy: true, profile: false }],
    ["a profile for another credential name", (x: ReturnType<typeof fixture>) => ({ policy: x.rendered.policy, profile: x.rendered.profile.replace(/VENDOR_KEY/g, "OTHER_KEY") }), { policy: true, profile: false }],
    ["a profile without a display name", (x: ReturnType<typeof fixture>) => ({ policy: x.rendered.policy, profile: x.rendered.profile.replace(/^display_name: .*\n/m, "") }), { policy: true, profile: false }],
    ["empty files", () => ({ policy: "", profile: "" }), { policy: false, profile: false }],
  ])("denies %s", (_name, change, expected) => {
    const x = f(); const { policy, profile } = change(x); expect(piAssetsConform(x.descriptor, policy, profile)).toEqual(expected);
  });
  it("denies, rather than throws, when the descriptor's endpoint cannot be rendered", () => {
    const x = f(); const broken = { ...x.descriptor, endpoint: { ...x.descriptor.endpoint, baseUrl: "not a url" } } as OpenShellPiBootDescriptor;
    expect(piAssetsConform(broken, x.rendered.policy, x.rendered.profile)).toEqual({ policy: false, profile: false });
  });
});

describe("the pi certification gate", () => {
  const host = { platform: "darwin", arch: "arm64" };
  const gateFor = (x: ReturnType<typeof fixture>, extra: Partial<Parameters<typeof createPiCertificationGate>[0]> = {}) =>
    createPiCertificationGate({ configuration: x.configuration, descriptor: x.descriptor, host, installed: () => installedFor(x.row), readPins: async () => structuredClone(x.row.image.pins), ...extra });
  it("is ready for the certified image, policy, profile, host and OpenShell build", async () => {
    const x = fixture(); expect(await gateFor(x)()).toEqual({ ready: true, version: x.row.image.pins.piVersion });
  });
  it("reads the pins through the real reader when none is injected", async () => {
    const x = fixture(); const gate = createPiCertificationGate({ configuration: x.configuration, descriptor: x.descriptor, host, installed: () => installedFor(x.row), run: x.run as never });
    expect(await gate()).toMatchObject({ ready: true }); expect(x.calls.map(argv => argv[0])).toEqual(["ps", "create", "cp", "rm"]);
  });
  it.each([
    ["an image whose pins differ", (x: ReturnType<typeof fixture>) => ({ readPins: async () => ({ ...x.row.image.pins, worker: "a".repeat(64) }) }), "pi_identity_mismatch"],
    ["another OpenShell build", (x: ReturnType<typeof fixture>) => ({ configuration: { ...x.configuration, version: "0.0.1" } }), "pi_uncertified"],
    ["another host", () => ({ host: { platform: "linux", arch: "arm64" } }), "pi_uncertified"],
    ["no certified row", () => ({ rows: [] }), "pi_uncertified"],
    ["a tested_baseline row", (x: ReturnType<typeof fixture>) => ({ rows: [{ ...x.row, state: "tested_baseline" }] }), "pi_uncertified"],
    ["drifted components", (x: ReturnType<typeof fixture>) => ({ installed: () => ({ ...installedFor(x.row), "@warble/cli": "0.0.1" }) }), "pi_dependencies_drifted"],
  ] as const)("is not ready for %s", async (_name, change, code) => {
    const x = fixture(); expect(await gateFor(x, change(x) as never)()).toMatchObject({ ready: false, code });
  });
  it("is not ready when the configured policy or profile is not an instance of the certified templates", async () => {
    const x = fixture(); writeFileSync(x.policy, x.rendered.policy.replace("hard_requirement", "best_effort")); expect(await gateFor(x)()).toEqual({ ready: false, code: "pi_identity_mismatch" });
    const y = fixture(); writeFileSync(y.profile, `${y.rendered.profile}x: 1\n`); expect(await gateFor(y)()).toEqual({ ready: false, code: "pi_identity_mismatch" });
  });
  it("reports an unobservable image, an unreadable file and a missing pi block as unavailable, never as a verdict about the image", async () => {
    const x = fixture(); expect(await gateFor(x, { readPins: async () => { throw new Error("docker down"); } })()).toEqual({ ready: false, code: "runtime_probe_failed" });
    const y = fixture(); expect(await gateFor(y, { readFile: () => { throw new Error("gone"); } })()).toEqual({ ready: false, code: "runtime_probe_failed" });
    const z = fixture(); const { pi: _pi, ...rest } = z.configuration; expect(await gateFor(z, { configuration: rest as never })()).toEqual({ ready: false, code: "runtime_probe_failed" });
  });
  it("rethrows a cancellation instead of turning it into a verdict", async () => {
    const x = fixture(); const controller = new AbortController(); const gate = gateFor(x, { readPins: async () => { controller.abort(); throw new Error("aborted"); } });
    await expect(gate(controller.signal)).rejects.toThrow();
  });
  it("never lets a digest, a path or a drift detail reach the verdict's code", async () => {
    const x = fixture(); const verdict = await gateFor(x, { installed: () => ({ ...installedFor(x.row), "@warble/cli": "0.0.1" }) })();
    expect(JSON.stringify({ ready: verdict.ready, code: (verdict as { code: string }).code })).toBe('{"ready":false,"code":"pi_dependencies_drifted"}');
  });
  it("turns a verdict into the closed OpenShell error", () => {
    expect(() => assertPiCertified({ ready: true, version: "1.0.4" })).not.toThrow();
    for (const code of ["pi_uncertified", "pi_identity_mismatch", "pi_dependencies_drifted", "runtime_probe_failed"] as const)
      expect(() => assertPiCertified({ ready: false, code } as PiGateVerdict)).toThrow(expect.objectContaining({ code }));
  });
  it("uses the shipped templates the row was certified with", () => { expect(shippedPiTemplateDigests()).toEqual(certified().image.templates); });
  it("requires the gateway proof first and then the certified identity, and runs neither twice", async () => {
    const order: string[] = [];
    const verify = vi.fn(async () => { order.push("gateway"); }); const certify = vi.fn(async () => { order.push("certify"); return { ready: true, version: "1.0.4" } as const; });
    await requirePiCertification(verify, certify)(); expect(order).toEqual(["gateway", "certify"]);
    const refused = requirePiCertification(async () => { throw new OpenShellError("openshell_identity_mismatch"); }, certify); certify.mockClear();
    await expect(refused()).rejects.toMatchObject({ code: "openshell_identity_mismatch" }); expect(certify).not.toHaveBeenCalled();
    await expect(requirePiCertification(verify, async () => ({ ready: false, code: "pi_identity_mismatch" }))()).rejects.toMatchObject({ code: "pi_identity_mismatch" });
  });
});
