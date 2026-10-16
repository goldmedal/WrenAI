import { afterEach, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { readOpenShellPiBoot, piEndpointAddress, piProviderConfig } from "../server/runtime-host/openshell-pi-boot.js";
import { inProcessAuthOffer, inProcessAuthViaBackend, isBackendOffered, localModeAuthOffer, resolveRuntimeSelection, RuntimeSelectionError } from "../server/runtime-selection.js";
import { piAccountDigest } from "../server/runtime-host/openshell-pi-provider.js";
import { readOpenShellClaudeBoot } from "../server/runtime-host/openshell-claude-boot.js";
import { createOpenShellRuntimeComposition } from "../server/openshell-runtime-composition.js";
import { Store } from "../server/db.js";
import type { OpenShellDriver } from "../server/runtime-host/openshell-types.js";

const digest = `sha256:${"a".repeat(64)}`;
const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
export function piBootFixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "openshell-pi-boot-")); roots.push(root); chmodSync(root, 0o700);
  const certs = Object.fromEntries(["caCert", "clientCert", "clientKey"].map(key => { const file = path.join(root, key); writeFileSync(file, "synthetic-pki", { mode: 0o600 }); return [key, file]; })) as Record<"caCert" | "clientCert" | "clientKey", string>;
  const descriptor = { version: 1, gatewayUrl: "https://localhost:9443/", ...certs, auth: "api-key", provider: "vendor-provider", profileId: "vendor-profile", displayLabel: "synthetic vendor", profileDigest: digest, generation: "gen-1",
    endpoint: { providerId: "vendor", api: "openai-completions", baseUrl: "https://api.vendor.example.test/v1", credentialEnv: "VENDOR_KEY" }, thinking: "off",
    models: { cheap: "model-cheap", strong: "model-strong" } };
  const file = path.join(root, "pi-boot.json");
  const save = (value: unknown = descriptor) => writeFileSync(file, JSON.stringify(value), { mode: 0o600 }); save();
  const env = { GENBI_RUNTIME: "openshell", GENBI_BACKEND: "pi", GENBI_OPENSHELL_PI_BOOT: file };
  return { root, file, descriptor, env, save, selection: resolveRuntimeSelection(env) };
}

describe("pi on the OpenShell row of the runtime selection", () => {
  const openshell = (backend: string) => resolveRuntimeSelection({ GENBI_RUNTIME: "openshell", GENBI_BACKEND: backend });
  it("is offered under openshell when listed, never under local, and never silently not offered", () => {
    expect(openshell("pi").offers.pi).toEqual({ offered: true });
    expect(isBackendOffered(resolveRuntimeSelection({ GENBI_BACKEND: "pi" }), "pi")).toBe(false);
    expect(resolveRuntimeSelection({ GENBI_BACKEND: "pi" }).offers.pi.reason).toBeTruthy();
    expect(openshell("claude").offers.pi.offered).toBe(false);
  });
  it("offers api-key and gateway auth through the in-process auth seam only with pi listed, and never local-mode auth", () => {
    expect(inProcessAuthOffer(openshell("pi"))).toEqual({ offered: true }); expect(inProcessAuthViaBackend(openshell("pi"))).toBe("pi");
    expect(inProcessAuthOffer(openshell("claude")).offered).toBe(false); expect(inProcessAuthViaBackend(openshell("claude"))).toBeUndefined();
    expect(localModeAuthOffer(openshell("pi")).offered).toBe(false);
    // The local runtime keeps in-process execution on the host, which is not a route through a backend.
    expect(inProcessAuthOffer(resolveRuntimeSelection({})).offered).toBe(true); expect(inProcessAuthViaBackend(resolveRuntimeSelection({}))).toBeUndefined();
  });
  it("is refused for boot under local when the descriptor variable is set, naming it", () => {
    const f = piBootFixture();
    expect(() => resolveRuntimeSelection({ GENBI_RUNTIME: "local", GENBI_BACKEND: "pi", GENBI_OPENSHELL_PI_BOOT: f.file })).toThrow(RuntimeSelectionError);
    expect(() => resolveRuntimeSelection({ GENBI_OPENSHELL_PI_BOOT: f.file })).toThrow("GENBI_OPENSHELL_PI_BOOT applies only when GENBI_RUNTIME=openshell");
  });
  it("is exclusive with claude under openshell, and the removed vendor selector does not exist", () => {
    expect(() => openshell("claude,pi")).toThrow("only one model backend");
    expect(() => resolveRuntimeSelection({ GENBI_RUNTIME: "openshell", GENBI_BACKEND: "pi", GENBI_CLAUDE_RUNTIME: "openshell" })).toThrow("GENBI_CLAUDE_RUNTIME is no longer supported");
  });
});

describe("protected OpenShell pi boot", () => {
  it("is absent unless the selection offers pi on openshell and a descriptor path is explicit", () => {
    const f = piBootFixture(); const claude = resolveRuntimeSelection({ GENBI_RUNTIME: "openshell", GENBI_BACKEND: "claude" });
    expect(readOpenShellPiBoot({}, f.selection)).toBeUndefined();
    expect(readOpenShellPiBoot(f.env, claude)).toBeUndefined();
    expect(readOpenShellPiBoot(f.env, resolveRuntimeSelection({ GENBI_BACKEND: "pi" }))).toBeUndefined();
    expect(readOpenShellPiBoot({ ...f.env, GENBI_OPENSHELL_PI_BOOT: "relative.json" }, f.selection)).toBeUndefined();
    expect(readOpenShellPiBoot(f.env, f.selection)).toBeDefined();
  });
  it("derives the account from names and digests only, never from a credential", () => {
    const f = piBootFixture(); const boot = readOpenShellPiBoot(f.env, f.selection)!;
    expect(boot.account).toBe(piAccountDigest(piProviderConfig(boot.descriptor)));
    expect(boot.account).toBe(piAccountDigest({ provider: "vendor-provider", profileDigest: digest, generation: "gen-1" }));
    expect(JSON.stringify(boot.descriptor)).not.toMatch(/key=|secret|token/i);
    expect(piEndpointAddress(boot.descriptor.endpoint)).toEqual({ host: "api.vendor.example.test", port: 443 });
    expect(piEndpointAddress({ ...boot.descriptor.endpoint, baseUrl: "http://host.example.test:18694/v1" })).toEqual({ host: "host.example.test", port: 18694 });
  });
  it.each(["version", "unknown", "credential", "gateway-http", "relative-pki", "auth-mode", "profile-digest", "provider", "profile-id", "generation", "endpoint-key", "alias", "inherit", "empty-models", "bad-tier", "missing-pki"])("fails closed on %s", kind => {
    const f = piBootFixture(); const value = structuredClone(f.descriptor) as Record<string, unknown> & { endpoint: Record<string, unknown>; models: Record<string, unknown> };
    if (kind === "version") value.version = 2;
    if (kind === "unknown") value.extra = true;
    if (kind === "credential") value.apiKey = "synthetic-forbidden";
    if (kind === "gateway-http") value.gatewayUrl = "http://localhost:9443/";
    if (kind === "relative-pki") value.caCert = "relative";
    if (kind === "auth-mode") value.auth = "subscription";
    if (kind === "profile-digest") value.profileDigest = "sha256:short";
    if (kind === "provider") value.provider = "bad provider";
    if (kind === "profile-id") value.profileId = "Bad_Profile";
    if (kind === "generation") value.generation = "";
    if (kind === "endpoint-key") value.endpoint.apiKey = "synthetic-forbidden";
    if (kind === "alias") value.models = { cheap: "sonnet" };
    if (kind === "inherit") value.models = { cheap: "inherit" };
    if (kind === "empty-models") value.models = {};
    if (kind === "bad-tier") value.models = { "bad tier": "model-x" };
    if (kind === "missing-pki") rmSync(f.descriptor.clientKey);
    f.save(value); expect(readOpenShellPiBoot(f.env, f.selection)).toBeUndefined();
  });
  it.each(["file-mode", "parent-mode", "symlink", "pki-mode"])("rejects unsafe %s", kind => {
    const f = piBootFixture();
    if (kind === "file-mode") chmodSync(f.file, 0o644);
    if (kind === "parent-mode") chmodSync(f.root, 0o755);
    if (kind === "symlink") { const saved = f.file + ".saved"; writeFileSync(saved, readFileSync(f.file), { mode: 0o600 }); rmSync(f.file); symlinkSync(saved, f.file); }
    if (kind === "pki-mode") chmodSync(f.descriptor.clientKey, 0o644);
    expect(readOpenShellPiBoot(f.env, f.selection)).toBeUndefined();
  });
  it("binds descriptor and PKI currentness: any byte change fences the boot", () => {
    const f = piBootFixture(); const boot = readOpenShellPiBoot(f.env, f.selection)!;
    expect(() => boot.assertCurrent()).not.toThrow(); expect(() => { (boot.descriptor.models as Record<string, string>).cheap = "forged"; }).toThrow();
    f.save({ ...f.descriptor, generation: "gen-2" }); expect(() => boot.assertCurrent()).toThrow("changed");
    f.save(); expect(() => boot.assertCurrent()).not.toThrow();
    f.save({ ...f.descriptor, models: { cheap: "other-model", strong: "model-strong" } }); expect(() => boot.assertCurrent()).toThrow("changed");
    f.save(); writeFileSync(f.descriptor.clientKey, "replacement"); expect(() => boot.assertCurrent()).toThrow("changed");
  });
});

describe("one boot serves one vendor", () => {
  function driverConfig(root: string, blocks: Record<string, unknown>) {
    const config = path.join(root, "runtime.json"), image = `sha256:${"b".repeat(64)}`, piImage = `sha256:${"c".repeat(64)}`;
    writeFileSync(config, JSON.stringify({ executable: config, executableDigest: digest, version: "0.0.1", gateway: "synthetic", workspace: "default", image, supervisorImage: digest, policy: config, policyDigest: digest,
      home: root, configHome: root, stateHome: root, dockerExecutable: config, dockerRealpath: config, dockerDigest: digest, dockerSocket: path.join(root, "none.sock"), dockerNamespace: "synthetic", exclusive: true,
      ...(blocks.pi ? { pi: { image: piImage, policy: config, policyDigest: digest, provider: "vendor-provider", profile: config, profileDigest: digest } } : {}),
      ...(blocks.model ? { model: { image: `sha256:${"d".repeat(64)}`, policy: config, policyDigest: digest } } : {}) }));
    return config;
  }
  const driver = (pi: boolean) => { const identity = { image: digest, policy: digest, gateway: "synthetic", workspace: "default", configuration: digest }; return { version: "synthetic", identity, modelIdentity: pi ? identity : undefined, probe: async () => {}, list: async () => [] } as unknown as OpenShellDriver; };

  it("reads the pi descriptor and never the Claude one when pi is the listed backend", async () => {
    const f = piBootFixture(); const config = driverConfig(f.root, { pi: true });
    const claudeSpy = vi.spyOn(await import("../server/runtime-host/openshell-claude-boot.js"), "readOpenShellClaudeBoot");
    const store = new Store(":memory:");
    const env = { ...f.env, GENBI_OPENSHELL_CONFIG: config, GENBI_OPENSHELL_CLAUDE_BOOT: "/nonexistent/claude.json" };
    const composition = await createOpenShellRuntimeComposition({ env, selection: resolveRuntimeSelection(env), store, stateRoot: path.join(f.root, "lifecycle"), driver: driver(true),
      pi: { boot: readOpenShellPiBoot(f.env, f.selection)!, verifyGateway: async () => {} } });
    try {
      expect(claudeSpy).not.toHaveBeenCalled();
      expect(composition.modelVendor).toBe("pi"); expect(composition.claudeVault).toBeUndefined(); expect(composition.claudeBoot).toBeUndefined();
      expect(composition.piBoot?.descriptor.provider).toBe("vendor-provider"); expect(composition.adapter.vendor).toBe("pi");
      expect(composition.bootVerification).toEqual({ ok: true });
    } finally { await composition.shutdown(); store.close(); }
  });
  it("reads the Claude descriptor and never the pi one when claude is the listed backend", async () => {
    const f = piBootFixture(); const config = driverConfig(f.root, { model: true });
    const store = new Store(":memory:");
    const piSpy = vi.spyOn(await import("../server/runtime-host/openshell-pi-boot.js"), "readOpenShellPiBoot");
    const env = { GENBI_RUNTIME: "openshell", GENBI_BACKEND: "claude", GENBI_OPENSHELL_CONFIG: config, GENBI_OPENSHELL_PI_BOOT: f.file };
    const composition = await createOpenShellRuntimeComposition({ env, selection: resolveRuntimeSelection(env), store, stateRoot: path.join(f.root, "lifecycle"), driver: driver(false) });
    try {
      expect(piSpy).not.toHaveBeenCalled(); expect(composition.modelVendor).toBe("claude"); expect(composition.adapter.vendor).toBe("claude");
      expect((composition as { piBoot?: unknown }).piBoot).toBeUndefined();
    } finally { await composition.shutdown(); store.close(); }
    expect(readOpenShellClaudeBoot({}, resolveRuntimeSelection({ GENBI_RUNTIME: "openshell", GENBI_BACKEND: "claude" }))).toBeUndefined();
  });
  it.each([["a Claude model block next to the pi block", { pi: true, model: true }], ["no pi block", { model: true }], ["a descriptor naming another provider", { pi: true }]] as const)("fails closed for %s: unready, no boot, no fallback", async (name, blocks) => {
    const f = piBootFixture(); const config = driverConfig(f.root, blocks);
    if (name === "a descriptor naming another provider") f.save({ ...f.descriptor, provider: "someone-elses-provider" });
    const store = new Store(":memory:");
    const env = { ...f.env, GENBI_OPENSHELL_CONFIG: config };
    const composition = await createOpenShellRuntimeComposition({ env, selection: resolveRuntimeSelection(env), store, stateRoot: path.join(f.root, "lifecycle"), driver: driver(true) });
    try {
      expect(composition.selected).toBe(true); expect(composition.modelVendor).toBe("pi");
      expect(composition.piBoot).toBeUndefined();
      expect(await composition.probe()).toMatchObject({ readiness: { state: "unprovisioned", code: "openshell_configuration_invalid" } });
      expect(composition.bootVerification).toMatchObject({ ok: false });
      expect(() => composition.piProvider({} as never)).toThrow("unavailable");
    } finally { await composition.shutdown(); store.close(); }
  });
  it("records a boot-time gateway verification failure and reports it without mutating the gateway", async () => {
    const f = piBootFixture(); const config = driverConfig(f.root, { pi: true });
    const { OpenShellError } = await import("../server/runtime-host/openshell-types.js");
    const store = new Store(":memory:"); const warn = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const env = { ...f.env, GENBI_OPENSHELL_CONFIG: config };
    const composition = await createOpenShellRuntimeComposition({ env, selection: resolveRuntimeSelection(env), store, stateRoot: path.join(f.root, "lifecycle"), driver: driver(true),
      pi: { boot: readOpenShellPiBoot(f.env, f.selection)!, verifyGateway: async () => { throw new OpenShellError("openshell_identity_mismatch"); } } });
    try { expect(composition.bootVerification).toEqual({ ok: false, code: "openshell_identity_mismatch" }); expect(warn).toHaveBeenCalledWith(expect.stringContaining("openshell_identity_mismatch")); }
    finally { await composition.shutdown(); store.close(); }
  });
});
