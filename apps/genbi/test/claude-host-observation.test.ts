import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../server/db.js";
import { ClaudeAccountVault } from "../server/runtime-host/claude-account-vault.js";
import { OpenShellLifecycle } from "../server/runtime-host/openshell-lifecycle.js";
import type { OpenShellDriver, OpenShellResource } from "../server/runtime-host/openshell-types.js";
import type { ClaudeComponentRuntime } from "../server/runtime-host/claude-component-step.js";
import { createOpenShellClaudeProviderForTesting } from "../server/runtime-host/openshell-claude-provider.js";
import { observeClaudeHostNoModel } from "../server/runtime-host/claude-identity-verifier.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { vi.useRealTimers(); for (const close of cleanup.splice(0)) await close(); });
async function setup(delay: number) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "claude-observation-")));
  const expected = { accountUuid: "11111111-1111-4111-8111-111111111111", organizationUuid: "22222222-2222-4222-8222-222222222222", email: "approved@example.test", subscription: "pro" as const };
  const vault = ClaudeAccountVault.forTesting({ root: path.join(root, "vault"), transport: async url => new Response(JSON.stringify(url.endsWith("/token")
    ? { access_token: "synthetic-observation-access-1234", refresh_token: "synthetic-observation-refresh-1234", expires_in: 3600, scope: "user:profile user:inference", token_type: "Bearer" }
    : { account: { uuid: expected.accountUuid, email: expected.email }, organization: { uuid: expected.organizationUuid, organization_type: "claude_pro" } })) });
  vault.enroll({ accessToken: "synthetic-import-access-1234", refreshToken: "synthetic-import-refresh-1234", expiresAt: Date.now() + 3600000 }); await vault.verify(expected);
  const digest = "sha256:" + "a".repeat(64), identity = { image: digest, policy: digest, gateway: "synthetic", workspace: "default", configuration: digest };
  const resources = new Map<string, OpenShellResource>(); const remove = vi.fn(async (intent: { name: string }) => { resources.delete(intent.name); });
  const driver: OpenShellDriver = { version: "synthetic", identity, modelIdentity: identity, probe: async () => {},
    create: async intent => { const resource = { id: intent.id, name: intent.name, workspace: "default", labels: { "genbi-lifecycle-owner": intent.owner } }; resources.set(intent.name, resource); return resource; },
    list: async intent => [...resources.values()].filter(resource => resource.name === intent.name), inspect: async intent => { const resource = resources.get(intent.name); if (!resource) throw Error(); return resource; }, remove,
    assertAbsent: async intent => { expect(resources.has(intent.name)).toBe(false); }, exec: async () => { throw Error("no process or model request"); } };
  const store = new Store(":memory:"), lifecycle = new OpenShellLifecycle({ driver, journal: store, stateRoot: path.join(root, "lifecycle"), exclusive: true });
  cleanup.push(async () => { await lifecycle.shutdown(); vault.close(); store.close(); rmSync(root, { recursive: true, force: true }); }); await lifecycle.initialize();
  const status = vault.status(), scope = { backend: "openshell" as const, account: status.fingerprint!, generation: status.generation!, session: "observation", turn: "turn", binding: "binding", bindingGeneration: "1", bindingRevision: digest, context: digest, plan: digest, ...identity };
  const query = vi.fn(() => ({ accountInfo: () => new Promise(resolve => setTimeout(() => resolve({ tokenSource: "CLAUDE_CODE_OAUTH_TOKEN", apiProvider: "firstParty" }), delay)) }));
  const provider = createOpenShellClaudeProviderForTesting({ lifecycle, vault, models: { cheap: "synthetic-model" }, scope, currentScope: () => scope, assertCurrent() {} }, query as unknown as ClaudeComponentRuntime["query"]);
  const runtime = await provider.open("synthetic-model", new AbortController().signal, "cheap");
  return { runtime, query, resources, remove, store };
}

it("admits valid host initialization after 15 seconds and cleans its fresh worker without a prompt", async () => {
  const test = await setup(17000); vi.useFakeTimers(); let settled = false;
  const pending = observeClaudeHostNoModel(test.runtime, "cheap", new AbortController().signal); void pending.then(() => { settled = true; }, () => { settled = true; });
  const admitted = expect(pending).resolves.toBeUndefined();
  await vi.advanceTimersByTimeAsync(15000); expect(settled).toBe(false); expect(test.remove).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(2000); await admitted;
  expect(test.query).toHaveBeenCalledTimes(1); expect(test.resources.size).toBe(0); expect(test.remove).toHaveBeenCalledTimes(1);
  expect(test.store.listOpenShellIntents().every(intent => intent.phase === "cleaned")).toBe(true);
});

it("rejects initialization beyond 30 seconds, cleans the worker, and cannot revive on a late response", async () => {
  const test = await setup(45000); vi.useFakeTimers(); let settled = false;
  const pending = observeClaudeHostNoModel(test.runtime, "cheap", new AbortController().signal); void pending.then(() => { settled = true; }, () => { settled = true; });
  const rejected = expect(pending).rejects.toThrow("Claude host observation failed");
  await vi.advanceTimersByTimeAsync(29999); expect(settled).toBe(false); expect(test.remove).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1); await rejected; expect(test.resources.size).toBe(0); expect(test.remove).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(15000); expect(test.resources.size).toBe(0); expect(test.remove).toHaveBeenCalledTimes(1);
  expect(test.store.listOpenShellIntents().every(intent => intent.phase === "cleaned")).toBe(true);
});
