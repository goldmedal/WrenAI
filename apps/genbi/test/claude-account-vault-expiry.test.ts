import { afterEach, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ClaudeAccountVault, assertVaultLeaseAfterClose } from "../server/runtime-host/claude-account-vault.js";
import { HOST_ENDPOINTS } from "../server/runtime-host/claude-host-verification.js";
import { verifyRetainedOpenShellClaudeBoot } from "../server/runtime-host/openshell-claude-boot.js";

// Deterministic clock tests for the host vault, including concurrent-session rotation semantics
// (a same-identity lease-time refresh must not fence other sessions' live leases).

const identity = { accountUuid: "11111111-1111-4111-8111-111111111111", organizationUuid: "22222222-2222-4222-8222-222222222222", email: "approved@example.test", subscription: "pro" as const };
const profile = () => ({ account: { uuid: identity.accountUuid, email: identity.email }, organization: { uuid: identity.organizationUuid, organization_type: "claude_pro", name: "Approved Org" } });
const lifetimeSeconds = 200;
const startedAt = 1_800_000_000_000;
const resources: { root: string; vault: ClaudeAccountVault }[] = [];
afterEach(() => { for (const { root, vault } of resources.splice(0)) { vault.close(); rmSync(root, { recursive: true, force: true }); } });

function clock() { let now = startedAt; return { now: () => now, advance(ms: number) { now += ms; } }; }
function rotatingTransport() {
  let issued = 0;
  const transport = vi.fn(async (url: string, _init: RequestInit) => {
    if (url !== HOST_ENDPOINTS.refresh) return new Response(JSON.stringify(profile()));
    issued++;
    return new Response(JSON.stringify({ access_token: `synthetic-access-token-${issued}`, refresh_token: `synthetic-refresh-token-${issued}`, expires_in: lifetimeSeconds, scope: "user:profile user:inference", token_type: "Bearer" }));
  });
  return { transport, issued: () => issued };
}
function open(root: string, transport: Parameters<typeof ClaudeAccountVault.forTesting>[0]["transport"], now: () => number, stageDeadlineMs?: number) {
  const vault = ClaudeAccountVault.forTesting({ root, transport, now, ...(stageDeadlineMs ? { stageDeadlineMs } : {}) });
  resources.push({ root, vault }); return vault;
}
function setup() {
  const root = mkdtempSync(path.join(os.tmpdir(), "claude-vault-expiry-")); const time = clock(); const rotation = rotatingTransport();
  const vault = open(root, rotation.transport, time.now);
  vault.enroll({ accessToken: "synthetic-imported-access-1234", refreshToken: "synthetic-imported-refresh-1234", expiresAt: startedAt + 3_600_000 });
  return { root, time, rotation, vault, verify: () => vault.verify(identity), ids: () => { const status = vault.status(); return { fingerprint: status.fingerprint!, generation: status.generation! }; } };
}
const persisted = (root: string) => JSON.parse(readFileSync(path.join(root, "account.json"), "utf8")) as { verified: boolean; refreshing: boolean; bundle: { accessToken: string; expiresAt: number } };

describe("vault clock: refresh at expiry", () => {
  // supports long-session AC#3
  it("refreshes when a lease is issued inside the 135 s margin and hands out the rotated token", async () => {
    const t = setup(); await t.verify(); const { fingerprint, generation } = t.ids();
    const early = await t.vault.lease(fingerprint, generation);
    expect(early.accessCredential()).toBe("synthetic-access-token-1"); expect(t.rotation.issued()).toBe(1);
    t.time.advance(64_000);
    const stillFresh = await t.vault.lease(fingerprint, generation);
    expect(stillFresh.accessCredential()).toBe("synthetic-access-token-1"); expect(t.rotation.issued()).toBe(1);
    t.time.advance(2_000);
    const rotated = await t.vault.lease(fingerprint, generation);
    expect(t.rotation.issued()).toBe(2); expect(rotated.accessCredential()).toBe("synthetic-access-token-2");
    expect(rotated.expiresAt).toBe(t.time.now() + lifetimeSeconds * 1000); expect(persisted(t.root).bundle.accessToken).toBe("synthetic-access-token-2");
    expect(t.vault.status().state).toBe("verified");
  });

  // supports long-session AC#3
  it("never serves a token at or past its own expiry: an in-flight lease is revoked, not extended", async () => {
    const t = setup(); await t.verify(); const { fingerprint, generation } = t.ids();
    const lease = await t.vault.lease(fingerprint, generation);
    t.time.advance(lifetimeSeconds * 1000 - 1); expect(lease.accessCredential()).toBe("synthetic-access-token-1");
    t.time.advance(1);
    expect(() => lease.accessCredential()).toThrow("revoked"); expect(() => lease.assertCurrent()).toThrow("revoked");
    expect(t.rotation.issued()).toBe(1);
  });
});

describe("vault clock: expired token at boot", () => {
  async function expiredAtBoot() {
    const t = setup(); await t.verify(); const approved = t.ids(); t.vault.close(); resources.pop();
    t.time.advance(lifetimeSeconds * 1000 + 60_000);
    return { ...t, approved };
  }

  // supports long-session AC#3
  it("a boot refresh that never completes leaves refreshing:true, fails readiness closed, and restart reports interrupted", async () => {
    const t = await expiredAtBoot(); const hang = vi.fn((_url: string, _init: RequestInit) => new Promise<Response>(() => {}));
    const vault = open(t.root, hang, t.time.now, 20);
    expect(vault.status().state).toBe("unverified"); expect(persisted(t.root)).toMatchObject({ verified: false, refreshing: false });
    const boot = { descriptor: { expected: identity }, assertCurrent() {} } as never;
    await expect(verifyRetainedOpenShellClaudeBoot(vault, boot)).rejects.toThrow("refresh");
    expect(hang).toHaveBeenCalledTimes(1);
    expect(vault.status().state).toBe("refresh"); expect(persisted(t.root)).toMatchObject({ verified: false, refreshing: true });
    await expect(vault.lease(t.approved.fingerprint, t.approved.generation)).rejects.toThrow("refresh");
    vault.close(); resources.pop();
    const restarted = open(t.root, hang, t.time.now, 20);
    expect(restarted.status().state).toBe("interrupted"); expect(persisted(t.root)).toMatchObject({ verified: false, refreshing: false });
    await expect(verifyRetainedOpenShellClaudeBoot(restarted, boot)).rejects.toThrow("refresh");
    expect(restarted.status().state).toBe("refresh");
    await expect(restarted.lease(t.approved.fingerprint, t.approved.generation)).rejects.toThrow("refresh");
  });

  // supports long-session AC#3
  it("a rejected boot refresh is a fault, not a success: no verified state, no lease, no retry", async () => {
    const t = await expiredAtBoot(); const reject = vi.fn(async (_url: string, _init: RequestInit) => new Response("{}", { status: 400 }));
    const vault = open(t.root, reject, t.time.now);
    const boot = { descriptor: { expected: identity }, assertCurrent() {} } as never;
    await expect(verifyRetainedOpenShellClaudeBoot(vault, boot)).rejects.toThrow("refresh");
    expect(reject).toHaveBeenCalledTimes(1);
    expect(vault.status().state).toBe("refresh"); expect(persisted(t.root)).toMatchObject({ verified: false, refreshing: true });
    await expect(vault.lease(t.approved.fingerprint, t.approved.generation)).rejects.toThrow("refresh");
    t.time.advance(10_000); expect(reject).toHaveBeenCalledTimes(1);
  });
});

describe("vault: refresh failure mid-session and revoke", () => {
  // supports long-session AC#3
  it("a failed refresh at lease time leaves the vault unverified, aborts the old lease and blocks new leases", async () => {
    const t = setup(); await t.verify(); const { fingerprint, generation } = t.ids();
    const old = await t.vault.lease(fingerprint, generation);
    t.rotation.transport.mockImplementation(async () => new Response("{}", { status: 500 }));
    t.time.advance(70_000);
    await expect(t.vault.lease(fingerprint, generation)).rejects.toThrow("refresh");
    expect(old.signal.aborted).toBe(true); expect(() => old.accessCredential()).toThrow("revoked");
    expect(t.vault.status().state).toBe("refresh"); expect(persisted(t.root)).toMatchObject({ verified: false, refreshing: true });
    await expect(t.vault.lease(fingerprint, generation)).rejects.toThrow("refresh");
  });

  // supports long-session AC#4
  it("revoke stops new model and tool starts and aborts every outstanding lease", async () => {
    const t = setup(); await t.verify(); const { fingerprint, generation } = t.ids();
    const model = await t.vault.lease(fingerprint, generation), tool = await t.vault.lease(fingerprint, generation);
    t.vault.disconnect();
    for (const lease of [model, tool]) { expect(lease.signal.aborted).toBe(true); expect(() => lease.accessCredential()).toThrow("revoked"); expect(() => lease.assertCurrent()).toThrow("revoked"); }
    await expect(t.vault.lease(fingerprint, generation)).rejects.toThrow("revoked");
    await expect(t.verify()).rejects.toThrow("unverified");
    expect(t.vault.status().state).toBe("revoked"); expect(t.vault.retainedCredential()).toBe(false);
    expect(() => readFileSync(path.join(t.root, "account.json"))).toThrow();
    const calls = t.rotation.transport.mock.calls.length; await Promise.resolve(); expect(t.rotation.transport.mock.calls.length).toBe(calls);
  });

  // supports long-session AC#4
  it("a vault whose storage is tampered refuses new leases even though the token has not expired", async () => {
    const t = setup(); await t.verify(); const { fingerprint, generation } = t.ids();
    const file = path.join(t.root, "account.json"); chmodSync(file, 0o644);
    await expect(t.vault.lease(fingerprint, generation)).rejects.toThrow("storage"); chmodSync(file, 0o600);
    expect(t.vault.status().state).not.toBe("verified");
  });
});

describe("vault: same-identity rotation does not fence live leases", () => {
  const rotateAfter = (t: ReturnType<typeof setup>) => t.time.advance(66_000);
  const refreshCalls = (t: ReturnType<typeof setup>) => t.rotation.transport.mock.calls.filter(([url]) => url === HOST_ENDPOINTS.refresh).length;

  // supports long-session AC#4
  it("a rotation triggered by session A leaves session B's in-flight lease working with its own token", async () => {
    const t = setup(); await t.verify(); const { fingerprint, generation } = t.ids();
    const b = await t.vault.lease(fingerprint, generation); const before = t.vault.status().generation;
    expect(b.accessCredential()).toBe("synthetic-access-token-1");
    rotateAfter(t);
    const a = await t.vault.lease(fingerprint, generation);
    expect(a.accessCredential()).toBe("synthetic-access-token-2"); expect(refreshCalls(t)).toBe(2);
    expect(() => b.assertCurrent()).not.toThrow(); expect(b.accessCredential()).toBe("synthetic-access-token-1"); expect(b.signal.aborted).toBe(false);
    const next = await t.vault.lease(fingerprint, generation);
    expect(next.accessCredential()).toBe("synthetic-access-token-2");
    expect(a.credentialGeneration).not.toBe(b.credentialGeneration); expect(a.generation).toBe(b.generation);
    expect(t.vault.status()).toMatchObject({ state: "verified", generation: before });
    expect(persisted(t.root).bundle.accessToken).toBe("synthetic-access-token-2");
  });

  // supports long-session AC#4
  it("concurrent lease() calls during a rotation share one refresh and all get the rotated token", async () => {
    const t = setup(); await t.verify(); const { fingerprint, generation } = t.ids(); const baseline = refreshCalls(t);
    rotateAfter(t);
    const leases = await Promise.all([1, 2, 3, 4].map(() => t.vault.lease(fingerprint, generation)));
    expect(refreshCalls(t) - baseline).toBe(1);
    for (const lease of leases) expect(lease.accessCredential()).toBe("synthetic-access-token-2");
    expect(new Set(leases.map((lease) => lease.credentialGeneration)).size).toBe(1);
  });

  // supports long-session AC#4
  it("an in-flight lease survives the rotation but is revoked at its own token expiry", async () => {
    const t = setup(); await t.verify(); const { fingerprint, generation } = t.ids();
    const old = await t.vault.lease(fingerprint, generation);
    rotateAfter(t); const fresh = await t.vault.lease(fingerprint, generation);
    t.time.advance(lifetimeSeconds * 1000 - 66_000 - 1); expect(old.accessCredential()).toBe("synthetic-access-token-1");
    t.time.advance(1); expect(() => old.accessCredential()).toThrow("revoked"); expect(() => old.assertCurrent()).toThrow("revoked");
    expect(fresh.accessCredential()).toBe("synthetic-access-token-2");
  });

  // supports long-session AC#4
  it("never hands the refresh token to a lease holder", async () => {
    const t = setup(); await t.verify(); const { fingerprint, generation } = t.ids();
    rotateAfter(t); const lease = await t.vault.lease(fingerprint, generation);
    expect(Object.keys(lease).sort()).toEqual(["accessCredential", "assertCurrent", "credentialGeneration", "expiresAt", "fingerprint", "generation", "identity", "organizationName", "release", "signal"]);
    expect(JSON.stringify(Object.values(lease).filter((value) => typeof value !== "function" && !(value instanceof AbortSignal)))).not.toMatch(/refresh/i);
    expect(lease.accessCredential()).not.toMatch(/refresh/);
  });

  // supports long-session AC#4
  it.each([
    ["the refresh endpoint fails", (t: ReturnType<typeof setup>) => t.rotation.transport.mockImplementation(async () => new Response("{}", { status: 500 })), "refresh"],
    ["the refreshed identity differs", (t: ReturnType<typeof setup>) => { const base = t.rotation.transport.getMockImplementation()!; t.rotation.transport.mockImplementation(async (url, init) => url === HOST_ENDPOINTS.refresh ? base(url, init) : new Response(JSON.stringify({ ...profile(), account: { uuid: identity.accountUuid, email: "other@example.test" } }))); }, "identity"],
  ] as const)("a failed rotation fences every lease and fails closed when %s", async (_name, arrange, code) => {
    const t = setup(); await t.verify(); const { fingerprint, generation } = t.ids();
    const first = await t.vault.lease(fingerprint, generation), second = await t.vault.lease(fingerprint, generation);
    arrange(t); rotateAfter(t);
    await expect(t.vault.lease(fingerprint, generation)).rejects.toThrow(code);
    for (const lease of [first, second]) { expect(lease.signal.aborted).toBe(true); expect(() => lease.accessCredential()).toThrow("revoked"); expect(() => lease.assertCurrent()).toThrow("revoked"); }
    expect(t.vault.status().state).not.toBe("verified"); expect(persisted(t.root)).toMatchObject({ verified: false, refreshing: true });
    await expect(t.vault.lease(fingerprint, generation)).rejects.toThrow();
    t.time.advance(10_000); expect(() => first.accessCredential()).toThrow("revoked");
  });

  // supports long-session AC#4
  it("a revoke during an in-flight rotation wins: no late success", async () => {
    const t = setup(); await t.verify(); const { fingerprint, generation } = t.ids();
    const live = await t.vault.lease(fingerprint, generation);
    const base = t.rotation.transport.getMockImplementation()!; let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
    t.rotation.transport.mockImplementation(async (url, init) => { if (url === HOST_ENDPOINTS.refresh) await gate; return base(url, init); });
    rotateAfter(t); const pending = t.vault.lease(fingerprint, generation); const settled = pending.then(() => "ok", (error: Error) => error.message);
    await Promise.resolve(); t.vault.disconnect(); release();
    expect(await settled).toMatch(/refresh|revoked/); expect(() => live.accessCredential()).toThrow("revoked");
    expect(t.vault.status().state).toBe("revoked"); expect(() => readFileSync(path.join(t.root, "account.json"))).toThrow();
  });

  // supports long-session AC#4
  it.each([
    ["enroll", (t: ReturnType<typeof setup>) => t.vault.enroll({ accessToken: "synthetic-other-access-1234", refreshToken: "synthetic-other-refresh-1234", expiresAt: startedAt + 3_600_000 })],
    ["revoke", (t: ReturnType<typeof setup>) => t.vault.disconnect()],
    ["stop", (t: ReturnType<typeof setup>) => t.vault.close()],
    ["an external rewrite of the credential file", (t: ReturnType<typeof setup>) => writeFileSync(path.join(t.root, "account.json"), `${readFileSync(path.join(t.root, "account.json"), "utf8")}\n`)],
  ] as const)("%s still fences every live lease", async (_name, act) => {
    const t = setup(); await t.verify(); const { fingerprint, generation } = t.ids();
    const first = await t.vault.lease(fingerprint, generation); rotateAfter(t); const second = await t.vault.lease(fingerprint, generation);
    act(t);
    for (const lease of [first, second]) { expect(() => lease.accessCredential()).toThrow(); expect(() => lease.assertCurrent()).toThrow(); }
    expect(first.signal.aborted || second.signal.aborted).toBe(true);
  });

  // supports long-session AC#4
  it("a restart while a rotation is in flight recovers as interrupted and unverified", async () => {
    const t = setup(); await t.verify(); const { fingerprint, generation } = t.ids();
    t.rotation.transport.mockImplementation(() => new Promise<Response>(() => {}));
    rotateAfter(t); const pending = t.vault.lease(fingerprint, generation).catch(() => undefined);
    await Promise.resolve(); await Promise.resolve();
    expect(persisted(t.root)).toMatchObject({ refreshing: true });
    t.vault.close(); resources.pop(); await pending;
    const restarted = open(t.root, t.rotation.transport, t.time.now);
    expect(restarted.status().state).toBe("interrupted"); expect(persisted(t.root)).toMatchObject({ verified: false, refreshing: false });
    await expect(restarted.lease(fingerprint, generation)).rejects.toThrow("interrupted");
  });
});

describe("vault: afterClose currency follows the same fencing rules", () => {
  const rotateAfter = (t: ReturnType<typeof setup>) => t.time.advance(66_000);

  // supports long-session AC#4
  it.each([
    ["revoke", (t: ReturnType<typeof setup>) => t.vault.disconnect()],
    ["enroll", (t: ReturnType<typeof setup>) => t.vault.enroll({ accessToken: "synthetic-other-access-1234", refreshToken: "synthetic-other-refresh-1234", expiresAt: startedAt + 3_600_000 })],
    ["a fencing re-verification of the same identity", (t: ReturnType<typeof setup>) => t.vault.verify(identity)],
  ] as const)("%s revokes a pre-fence lease for afterClose, even after release", async (_name, act) => {
    const t = setup(); await t.verify(); const { fingerprint, generation } = t.ids();
    const lease = await t.vault.lease(fingerprint, generation); expect(() => assertVaultLeaseAfterClose(lease)).not.toThrow();
    await act(t); lease.release();
    expect(() => assertVaultLeaseAfterClose(lease)).toThrow("revoked");
  });

  // supports long-session AC#4
  it("a failed rotation revokes a pre-rotation lease for afterClose", async () => {
    const t = setup(); await t.verify(); const { fingerprint, generation } = t.ids();
    const lease = await t.vault.lease(fingerprint, generation);
    t.rotation.transport.mockImplementation(async () => new Response("{}", { status: 500 })); rotateAfter(t);
    await expect(t.vault.lease(fingerprint, generation)).rejects.toThrow("refresh");
    expect(() => assertVaultLeaseAfterClose(lease)).toThrow("revoked");
  });

  // supports long-session AC#4
  it("after a successful rotation afterClose still passes for a pre-rotation lease until its own expiry", async () => {
    const t = setup(); await t.verify(); const { fingerprint, generation } = t.ids();
    const old = await t.vault.lease(fingerprint, generation);
    rotateAfter(t); await t.vault.lease(fingerprint, generation);
    expect(() => assertVaultLeaseAfterClose(old)).not.toThrow(); old.release(); expect(() => assertVaultLeaseAfterClose(old)).not.toThrow();
    t.time.advance(lifetimeSeconds * 1000 - 66_000); expect(() => assertVaultLeaseAfterClose(old)).toThrow("revoked");
  });
});
