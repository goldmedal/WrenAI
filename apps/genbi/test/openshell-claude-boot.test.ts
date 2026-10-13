import { afterEach, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { readOpenShellClaudeBoot, resolveOpenShellClaudeModel, verifyRetainedOpenShellClaudeBoot } from "../server/runtime-host/openshell-claude-boot.js";
import { ClaudeAccountVault } from "../server/runtime-host/claude-account-vault.js";
import { HOST_ENDPOINTS } from "../server/runtime-host/claude-host-verification.js";
import { createOpenShellRuntimeComposition } from "../server/openshell-runtime-composition.js";
import { Store } from "../server/db.js";
import type { OpenShellDriver } from "../server/runtime-host/openshell-types.js";

const expected = { accountUuid: "11111111-1111-4111-8111-111111111111", organizationUuid: "22222222-2222-4222-8222-222222222222", email: "synthetic@example.test", subscription: "pro" as const };
const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "openshell-boot-")); roots.push(root); chmodSync(root, 0o700);
  const vaultRoot = path.join(root, "vault"); mkdirSync(vaultRoot, { mode: 0o700 });
  writeFileSync(path.join(vaultRoot, "account.json"), "{}", { mode: 0o600 });
  const certs = Object.fromEntries(["caCert", "clientCert", "clientKey"].map(key => { const file = path.join(root, key); writeFileSync(file, "synthetic-pki", { mode: 0o600 }); return [key, file]; })) as Record<"caCert" | "clientCert" | "clientKey", string>;
  const descriptor = { version: 1, verifyRetainedAccount: true, vaultRoot, gatewayUrl: "https://localhost:9443/", ...certs, expected,
    models: { haiku: "claude-haiku-4-5-20251001", sonnet: "claude-sonnet-4-6", opus: "claude-opus-4-6" } };
  const file = path.join(root, "boot.json");
  const save = (value: unknown = descriptor) => writeFileSync(file, JSON.stringify(value), { mode: 0o600 }); save();
  const env = { GENBI_CLAUDE_RUNTIME: "openshell", GENBI_OPENSHELL_CLAUDE_BOOT: file };
  return { root, file, descriptor, env, save };
}
describe("protected OpenShell Claude boot", () => {
  it.each(["absent", "false", "valid"])("production composition invokes retained verification only for %s opt-in", async kind => {
    const f = fixture(), digest = "sha256:" + "a".repeat(64), config = path.join(f.root, "runtime.json");
    const identity = { image: digest, policy: digest, gateway: "synthetic", workspace: "default", configuration: digest };
    writeFileSync(config, JSON.stringify({ executable: f.file, executableDigest: digest, version: "0.0.1", gateway: "synthetic", workspace: "default", image: digest, supervisorImage: digest,
      policy: f.file, policyDigest: digest, home: f.root, configHome: f.root, stateHome: f.root, dockerExecutable: f.file, dockerRealpath: f.file, dockerDigest: digest, dockerSocket: path.join(f.root, "none.sock"), dockerNamespace: "synthetic", exclusive: true,
      model: { image: digest, policy: f.file, policyDigest: digest } }));
    rmSync(path.join(f.descriptor.vaultRoot, "account.json"));
    const seeded = ClaudeAccountVault.forTesting({ root: f.descriptor.vaultRoot, transport: async () => { throw Error("not used"); } });
    seeded.enroll({ accessToken: "synthetic-retained-access", refreshToken: "synthetic-retained-refresh", expiresAt: Date.now() + 3600_000 }); seeded.close();
    if (kind === "false") f.save({ ...f.descriptor, verifyRetainedAccount: false });
    const verify = vi.spyOn(ClaudeAccountVault.prototype, "verify").mockRejectedValue(Error("synthetic verifier refusal"));
    const driver = { version: "synthetic", identity, modelIdentity: identity, probe: async () => {}, list: async () => [] } as unknown as OpenShellDriver;
    const store = new Store(":memory:");
    const composition = await createOpenShellRuntimeComposition({ env: { GENBI_CLAUDE_RUNTIME: "openshell", GENBI_OPENSHELL_CONFIG: config,
      ...(kind !== "absent" ? { GENBI_OPENSHELL_CLAUDE_BOOT: f.file } : {}) }, store, stateRoot: path.join(f.root, "lifecycle"), driver });
    try {
      if (kind === "valid") { expect(verify).toHaveBeenCalledExactlyOnceWith(expected); expect(verify.mock.instances[0]).toBe(composition.claudeVault); expect(composition.claudeVault?.status().state).toBe("unverified"); }
      else { expect(verify).not.toHaveBeenCalled(); expect(composition.claudeVault).toBeUndefined(); }
      expect(store.listOpenShellIntents()).toEqual([]);
    } finally { await composition.shutdown(); store.close(); }
  });
  it("is absent unless server selected OpenShell and explicit descriptor", () => {
    const f = fixture(); expect(readOpenShellClaudeBoot({})).toBeUndefined(); expect(readOpenShellClaudeBoot({ GENBI_CLAUDE_RUNTIME: "openshell" })).toBeUndefined();
    expect(readOpenShellClaudeBoot({ ...f.env, GENBI_CLAUDE_RUNTIME: "local" })).toBeUndefined();
  });
  it.each(["flag", "version", "unknown", "credential", "endpoint", "tuple", "relative", "alias", "unknown-alias", "missing-pki", "missing-account"])("fails closed on %s", kind => {
    const f = fixture(); const value = structuredClone(f.descriptor) as Record<string, unknown>;
    if (kind === "flag") value.verifyRetainedAccount = false;
    if (kind === "version") value.version = 2;
    if (kind === "unknown") value.extra = true;
    if (kind === "credential") value.refreshToken = "synthetic-forbidden";
    if (kind === "endpoint") value.profileEndpoint = "https://example.test/";
    if (kind === "tuple") value.expected = { ...expected, accountUuid: "malformed" };
    if (kind === "relative") value.vaultRoot = "relative";
    if (kind === "alias") value.models = { haiku: "haiku" };
    if (kind === "unknown-alias") value.models = { fast: "claude-haiku-4-5-20251001" };
    if (kind === "missing-pki") rmSync(f.descriptor.clientKey);
    if (kind === "missing-account") rmSync(path.join(f.descriptor.vaultRoot, "account.json"));
    f.save(value); expect(readOpenShellClaudeBoot(f.env)).toBeUndefined();
  });
  it.each(["file-mode", "parent-mode", "symlink", "pki-mode"])("rejects unsafe %s", kind => {
    const f = fixture();
    if (kind === "file-mode") chmodSync(f.file, 0o644);
    if (kind === "parent-mode") chmodSync(f.root, 0o755);
    if (kind === "symlink") { const saved = f.file + ".saved"; writeFileSync(saved, readFileSync(f.file), { mode: 0o600 }); rmSync(f.file); symlinkSync(saved, f.file); }
    if (kind === "pki-mode") chmodSync(f.descriptor.clientKey, 0o644);
    expect(readOpenShellClaudeBoot(f.env)).toBeUndefined();
  });
  it("binds descriptor and PKI currentness without opening a connection", () => {
    const f = fixture(); const boot = readOpenShellClaudeBoot(f.env)!;
    expect(() => boot.assertCurrent()).not.toThrow(); expect(() => { boot.descriptor.models.haiku = "forged"; }).toThrow();
    f.save({ ...f.descriptor, models: { haiku: "claude-other-pinned" } }); expect(() => boot.assertCurrent()).toThrow("changed");
    f.save(); writeFileSync(f.descriptor.clientKey, "replacement"); expect(() => boot.assertCurrent()).toThrow("changed");
  });
  it("resolves only explicit aliases and rejects recursive inherit/missing map", () => {
    const f = fixture(); const boot = readOpenShellClaudeBoot(f.env)!;
    expect(resolveOpenShellClaudeModel("haiku", "", boot.descriptor)).toBe(f.descriptor.models.haiku);
    expect(resolveOpenShellClaudeModel("inherit", "haiku", boot.descriptor)).toBe(f.descriptor.models.haiku);
    expect(resolveOpenShellClaudeModel("inherit", "claude-fixed-driver", boot.descriptor)).toBe("claude-fixed-driver");
    expect(() => resolveOpenShellClaudeModel("inherit", "inherit", boot.descriptor)).toThrow();
    expect(() => resolveOpenShellClaudeModel("inherit", "", boot.descriptor)).toThrow();
    expect(() => resolveOpenShellClaudeModel("haiku", "", { ...boot.descriptor, models: {} })).toThrow();
    expect(() => resolveOpenShellClaudeModel("https://example.test/model", "", boot.descriptor)).toThrow();
  });
  it("runs the real retained-vault verification control flow through the trusted no-network test verifier", async () => {
    const f = fixture(); rmSync(path.join(f.descriptor.vaultRoot, "account.json"));
    const transport = vi.fn(async (url: string) => new Response(JSON.stringify(url === HOST_ENDPOINTS.refresh
      ? { access_token: "synthetic-refreshed-access", refresh_token: "synthetic-rotated-refresh", expires_in: 3600, token_type: "Bearer", scope: "user:profile user:inference" }
      : { account: { uuid: expected.accountUuid, email: expected.email }, organization: { uuid: expected.organizationUuid, organization_type: "claude_pro" } })));
    const vault = ClaudeAccountVault.forTesting({ root: f.descriptor.vaultRoot, transport });
    try {
      vault.enroll({ accessToken: "synthetic-imported-access", refreshToken: "synthetic-retained-refresh", expiresAt: Date.now() + 3600_000 });
      const boot = readOpenShellClaudeBoot(f.env)!;
      expect(vault.status().state).toBe("unverified"); await verifyRetainedOpenShellClaudeBoot(vault, boot);
      expect(vault.status().state).toBe("verified"); expect(transport.mock.calls.map(([url]) => url)).toEqual([HOST_ENDPOINTS.refresh, HOST_ENDPOINTS.profile]);
      const calls = transport.mock.calls.length;
      f.save({ ...f.descriptor, expected: { ...expected, email: "different@example.test" } });
      await expect(verifyRetainedOpenShellClaudeBoot(vault, readOpenShellClaudeBoot(f.env)!)).rejects.toThrow("identity");
      expect(transport).toHaveBeenCalledTimes(calls);
      vault.close();
      const restarted = new ClaudeAccountVault({ root: f.descriptor.vaultRoot });
      expect(restarted.status().state).toBe("unverified"); restarted.close();
    } finally { vault.close(); }
  });
});
