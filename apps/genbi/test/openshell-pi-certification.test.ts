import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../server/db.js";
import { createOpenShellRuntimeComposition } from "../server/openshell-runtime-composition.js";
import { renderPiEndpointAssets } from "../server/runtime-host/openshell-pi-assets.js";
import { PI_CERTIFIED_ROWS, piCertificationSchema, type InstalledComponents, type PiCertification } from "../server/runtime-host/openshell-vendor-certification.js";
import type { OpenShellDriver } from "../server/runtime-host/openshell-types.js";
import { resolveRuntimeSelection } from "../server/runtime-selection.js";
import { StructuredRuntime } from "../server/structured-runtime.js";
import type { RouteResult } from "../harness/index.js";

const digest = `sha256:${"a".repeat(64)}`;
const roots: string[] = [];
const stores: { close(): void }[] = [];
const shutdowns: (() => Promise<void>)[] = [];
afterEach(async () => {
  // The lifecycle owns a journal under the state root: it must stop before the root is removed.
  for (const shutdown of shutdowns.splice(0)) await shutdown().catch(() => {});
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const row = (): PiCertification => structuredClone(piCertificationSchema.parse(PI_CERTIFIED_ROWS[0]));
const installedFor = (certified: PiCertification): InstalledComponents => ({
  "@warble/cli": certified.dependencies.warble, "@warble/codex-local": certified.dependencies.warble, "@warble/claude-agent-sdk": certified.dependencies.warble,
  "@warble/ir-spec": certified.dependencies.ir, "@wrenai/context-loader": certified.dependencies["context-loader"],
});

/** A real descriptor, real rendered policy and profile files and a real driver configuration file; only the driver and docker are fakes. */
function bootFixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "pi-certification-")); roots.push(root); chmodSync(root, 0o700);
  const certs = Object.fromEntries(["caCert", "clientCert", "clientKey"].map(key => { const file = path.join(root, key); writeFileSync(file, "synthetic-pki", { mode: 0o600 }); return [key, file]; })) as Record<"caCert" | "clientCert" | "clientKey", string>;
  const descriptor = { version: 1, gatewayUrl: "https://localhost:9443/", ...certs, auth: "api-key", provider: "vendor-provider", profileId: "vendor-profile", displayLabel: "synthetic vendor", profileDigest: digest, generation: "gen-1",
    endpoint: { providerId: "vendor", api: "openai-completions", baseUrl: "https://api.vendor.example.test/v1", credentialEnv: "VENDOR_KEY" }, thinking: "off", models: { cheap: "model-cheap", strong: "model-strong" } };
  const bootFile = path.join(root, "pi-boot.json"); writeFileSync(bootFile, JSON.stringify(descriptor), { mode: 0o600 });
  const rendered = renderPiEndpointAssets({ host: "api.vendor.example.test", port: 443, profileId: "vendor-profile", displayName: "synthetic vendor", credentialEnv: "VENDOR_KEY" });
  const policy = path.join(root, "policy.yaml"), profile = path.join(root, "profile.yaml"); writeFileSync(policy, rendered.policy); writeFileSync(profile, rendered.profile);
  const certified = row();
  const config = path.join(root, "runtime.json");
  writeFileSync(config, JSON.stringify({ executable: config, executableDigest: `sha256:${certified.gateway.executableSha256}`, version: certified.gateway.version, gateway: "synthetic", workspace: "default",
    image: `sha256:${"b".repeat(64)}`, supervisorImage: digest, policy, policyDigest: digest, home: root, configHome: root, stateHome: root,
    dockerExecutable: config, dockerRealpath: config, dockerDigest: digest, dockerSocket: path.join(root, "none.sock"), dockerNamespace: "synthetic", exclusive: true,
    pi: { image: `sha256:${"c".repeat(64)}`, policy, policyDigest: digest, provider: "vendor-provider", profile, profileDigest: digest } }));
  const env = { GENBI_RUNTIME: "openshell", GENBI_BACKEND: "pi", GENBI_OPENSHELL_CONFIG: config, GENBI_OPENSHELL_PI_BOOT: bootFile };
  const identity = { image: digest, policy: digest, gateway: "synthetic", workspace: "default", configuration: digest };
  const driver = { version: "synthetic", identity, modelIdentity: identity, probe: async () => {}, list: async () => [] } as unknown as OpenShellDriver;
  return { root, env, driver, certified, descriptor };
}
async function compose(options: { proof?: () => Promise<void>; livePins?: () => unknown; rows?: readonly unknown[]; pins?: unknown; installed?: InstalledComponents; host?: { platform: string; arch: string }; unreadable?: boolean } = {}) {
  const f = bootFixture(); const store = new Store(":memory:"); stores.push(store);
  const composition = await createOpenShellRuntimeComposition({ env: f.env, selection: resolveRuntimeSelection(f.env), store, stateRoot: path.join(f.root, "lifecycle"), driver: f.driver,
    piCertification: { rows: options.rows ?? [f.certified], installed: () => options.installed ?? installedFor(f.certified), host: options.host ?? { platform: "darwin", arch: "arm64" },
      readPins: async () => { if (options.unreadable) throw new Error("docker down"); return options.livePins?.() ?? options.pins ?? structuredClone(f.certified.image.pins); } },
    // The read-only gateway proof is a seam so the certification requirement that composePi wraps around it can be run without an OpenShell executable.
    piGatewayProof: options.proof ?? (async () => {}) });
  shutdowns.push(() => composition.shutdown());
  const runtime = new StructuredRuntime({ selection: resolveRuntimeSelection(f.env), localRoute: async () => { throw new Error("no fallback"); }, localSetupFor: () => undefined, adapters: { pi: composition.adapter },
    // The source object deliberately carries everything the descriptor holds: the projection must pick three fields and never pass the rest through.
    piPins: () => composition.piBoot ? ({ ...composition.piBoot.descriptor, provider: composition.piBoot.descriptor.displayLabel, auth: "byo", models: composition.piBoot.descriptor.models } as never) : undefined });
  return { ...f, composition, runtime };
}

describe("pi readiness through the production composition requires a certified row", () => {
  it("is ready with a matching row, and offers ask only then", async () => {
    const f = await compose(); expect(f.composition.piBoot).toBeDefined();
    expect(await f.composition.probe()).toMatchObject({ readiness: { state: "ready" } });
    expect((await f.runtime.readiness()).backends.pi).toMatchObject({ offered: true, backend: "openshell", state: "ready" });
  });
  it.each([
    ["no row at all", { rows: [] }, "pi_uncertified", "incompatible"],
    ["a tested_baseline row for exactly this build", { rows: [{ ...row(), state: "tested_baseline" }] }, "pi_uncertified", "incompatible"],
    ["a row for another host", { host: { platform: "linux", arch: "x64" } }, "pi_uncertified", "incompatible"],
    ["a different image", { pins: { ...row().image.pins, worker: "e".repeat(64) } }, "pi_identity_mismatch", "incompatible"],
    ["drifted components", { installed: { ...installedFor(row()), "@wrenai/context-loader": "0.0.1" } }, "pi_dependencies_drifted", "incompatible"],
    ["an image that cannot be observed", { unreadable: true }, "runtime_probe_failed", "unavailable"],
  ] as const)("is not ready for %s, with the browser-safe code %s", async (_name, options, code, state) => {
    const f = await compose(options as never);
    expect(await f.composition.probe()).toMatchObject({ readiness: { state, code } });
    const pi = (await f.runtime.readiness()).backends.pi as Record<string, unknown>;
    expect(pi).toMatchObject({ offered: true, state: "unavailable", ask: false, setup: false, code });
  });
  it("denies an Ask at admission without a certified row, with no fallback to in-process execution", async () => {
    const f = await compose({ rows: [] });
    await expect(f.runtime.route({ authChoice: { mode: "api-key", adapter: "openai-compatible" }, profileSource: "x", userProject: "/x", question: "q" } as never,
      { sessionId: "s", turnId: "t", assertCurrent() {} })).rejects.toMatchObject({ code: "unavailable" });
  });
  it("revokes through the gateway proof the moment the image stops matching, so a drift mid-run cancels the run", async () => {
    let pins: unknown = undefined; const f = bootFixture(); const store = new Store(":memory:"); stores.push(store);
    const composition = await createOpenShellRuntimeComposition({ env: f.env, selection: resolveRuntimeSelection(f.env), store, stateRoot: path.join(f.root, "lifecycle"), driver: f.driver,
      piCertification: { rows: [f.certified], installed: () => installedFor(f.certified), host: { platform: "darwin", arch: "arm64" }, readPins: async () => pins ?? structuredClone(f.certified.image.pins) } });
    shutdowns.push(() => composition.shutdown());
    // The real gateway verifier needs an OpenShell executable; here it fails first, which proves it runs before the certification and that boot records its code.
    expect(composition.bootVerification).toMatchObject({ ok: false });
    pins = { ...f.certified.image.pins, shim: "0".repeat(64) };
    expect(await composition.probe()).toMatchObject({ readiness: { code: "pi_identity_mismatch" } });
  });
});

describe("the gateway proof composePi exposes also requires the certified identity", () => {
  it("passes at boot and later only while the image, the row and the components match", async () => {
    let pins: unknown;
    const f = await compose({ livePins: () => pins }); expect(f.composition.bootVerification).toEqual({ ok: true });
    await expect(f.composition.verifyPiGateway!()).resolves.toBeUndefined();
    pins = { ...f.certified.image.pins, shim: "0".repeat(64) };
    await expect(f.composition.verifyPiGateway!()).rejects.toMatchObject({ code: "pi_identity_mismatch" });
    pins = undefined; await expect(f.composition.verifyPiGateway!()).resolves.toBeUndefined();
  });
  it("rejects with pi_uncertified when no row exists, and records it as the boot verification", async () => {
    const f = await compose({ rows: [] });
    expect(f.composition.bootVerification).toEqual({ ok: false, code: "pi_uncertified" });
    await expect(f.composition.verifyPiGateway!()).rejects.toMatchObject({ code: "pi_uncertified" });
  });
  it("rejects with pi_dependencies_drifted and with runtime_probe_failed when the image cannot be observed", async () => {
    await expect((await compose({ installed: { ...installedFor(row()), "@warble/cli": "0.0.1" } })).composition.verifyPiGateway!()).rejects.toMatchObject({ code: "pi_dependencies_drifted" });
    await expect((await compose({ unreadable: true })).composition.verifyPiGateway!()).rejects.toMatchObject({ code: "runtime_probe_failed" });
  });
  it("runs the gateway proof first: a failing proof is the error and the identity is never read", async () => {
    let reads = 0; const { OpenShellError } = await import("../server/runtime-host/openshell-types.js");
    const f = await compose({ proof: async () => { throw new OpenShellError("openshell_identity_mismatch"); }, livePins: () => { reads++; return undefined; } });
    reads = 0; await expect(f.composition.verifyPiGateway!()).rejects.toMatchObject({ code: "openshell_identity_mismatch" }); expect(reads).toBe(0);
  });
});

describe("the readiness projection is browser-safe", () => {
  it("shows the label, the authentication mode and one model id per tier, and nothing that names the endpoint, key, profile, image, path or digest", async () => {
    const f = await compose(); const readiness = await f.runtime.readiness();
    expect(readiness.backends.pi).toMatchObject({ pinned: { provider: "synthetic vendor", auth: "byo", models: { cheap: "model-cheap", strong: "model-strong" } } });
    const text = JSON.stringify(readiness);
    for (const secret of ["api.vendor.example.test", "VENDOR_KEY", "vendor-profile", "vendor-provider", "gen-1", "localhost:9443", "sha256:", f.root, "pi-boot", "credentialEnv", "baseUrl", "profileDigest", "providerId"]) expect(text, secret).not.toContain(secret);
    expect(Object.keys((readiness.backends.pi as { pinned: object }).pinned).sort()).toEqual(["auth", "models", "provider"]);
  });
  it("shows the pins even when pi is not ready, so the operator sees what the boot pinned", async () => {
    const f = await compose({ rows: [] }); expect((await f.runtime.readiness()).backends.pi).toMatchObject({ state: "unavailable", code: "pi_uncertified", pinned: { models: { cheap: "model-cheap" } } });
  });
  it("shows nothing pinned for a boot without a descriptor, for a backend not offered and for the Claude backend", async () => {
    const selection = resolveRuntimeSelection({ GENBI_RUNTIME: "openshell", GENBI_BACKEND: "claude" });
    const runtime = new StructuredRuntime({ selection, localRoute: async () => ({ backend: "x", warnings: [] }) as unknown as RouteResult, localSetupFor: () => undefined, piPins: () => ({ provider: "x", auth: "byo", models: { a: "m" } }) });
    const readiness = await runtime.readiness(); expect(readiness.backends.pi).toMatchObject({ offered: false, state: "not_offered" }); expect(JSON.stringify(readiness)).not.toContain("pinned");
    const none = new StructuredRuntime({ selection: resolveRuntimeSelection({ GENBI_RUNTIME: "openshell", GENBI_BACKEND: "pi" }), localRoute: async () => ({}) as never, localSetupFor: () => undefined, piPins: () => undefined });
    expect(JSON.stringify(await none.readiness())).not.toContain("pinned");
  });
});

describe("Claude on OpenShell readiness is not gated by a pi row", () => {
  it("is ready with no certification row and no pi block, exactly as before", async () => {
    const f = bootFixture(); const store = new Store(":memory:"); stores.push(store);
    const env = { GENBI_RUNTIME: "openshell", GENBI_BACKEND: "claude", GENBI_OPENSHELL_CONFIG: f.env.GENBI_OPENSHELL_CONFIG };
    const composition = await createOpenShellRuntimeComposition({ env, selection: resolveRuntimeSelection(env), store, stateRoot: path.join(f.root, "lifecycle"), driver: f.driver, piCertification: { rows: [] } });
    shutdowns.push(() => composition.shutdown());
    expect(composition.modelVendor).toBe("claude"); expect(await composition.probe()).toMatchObject({ readiness: { state: "ready" } });
  });
});
