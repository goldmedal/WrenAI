import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import path from "node:path";
import { Store } from "../server/db.js";
import { OpenShellLifecycle, type OpenShellPermit } from "../server/runtime-host/openshell-lifecycle.js";
import { OpenShellError, OPEN_SHELL_OWNER_LABEL, type OpenShellDriver, type OpenShellIdentity, type OpenShellIntent, type OpenShellResource } from "../server/runtime-host/openshell-types.js";
import { StructuredRuntime } from "../server/structured-runtime.js";
import { RuntimeHost } from "../server/runtime-host/index.js";
import { runtimeNotReady, runtimeReady } from "../server/runtime-host/policy.js";
import { createApp } from "../server/app.js";
import { postTurn } from "../server/turn.js";
import type { TurnDeps } from "../server/turn.js";
import { NativeSessionService } from "../server/native-sessions.js";
import { resolveRuntimeSelection } from "../server/runtime-selection.js";
const openshellClaude = resolveRuntimeSelection({ GENBI_RUNTIME: "openshell", GENBI_BACKEND: "claude" });

const digest = `sha256:${"a".repeat(64)}`;
const otherDigest = `sha256:${"b".repeat(64)}`;
const identity: OpenShellIdentity = { backend: "openshell", account: digest, generation: "1", session: "session", turn: "turn", binding: "binding",
  bindingGeneration: "1", bindingRevision: digest, context: digest, plan: digest, image: digest, policy: digest, gateway: "gateway", workspace: "default",
  configuration: digest, purpose: "lifecycle", operation: "worker", snapshot: "none" };
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
const roots: string[] = [], stores: Store[] = [], managers: OpenShellLifecycle[] = [];
afterEach(async () => { for (const manager of managers.splice(0)) await manager.shutdown().catch(() => {}); for (const store of stores.splice(0)) store.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
async function fixture(root?: string, store?: Store) {
  root ??= mkdtempSync(path.join(tmpdir(), "genbi-lifecycle-")); roots.push(root);
  store ??= new Store(":memory:"); stores.push(store);
  const resources = new Map<string, OpenShellResource>();
  const driver: OpenShellDriver = {
    version: "0.0.1",
    identity: { image: digest, policy: digest, gateway: "gateway", workspace: "default", configuration: digest },
    probe: vi.fn(async () => {}),
    create: vi.fn(async (intent) => { expect(store!.listOpenShellIntents().find((row) => row.id === intent.id)?.phase).toBe("intent"); const resource = resourceFor(intent); resources.set(intent.name, resource); return resource; }),
    list: vi.fn(async (intent) => [...resources.values()].filter((row) => row.labels[OPEN_SHELL_OWNER_LABEL] === intent.owner)),
    inspect: vi.fn(async (intent) => resources.get(intent.name)!),
    remove: vi.fn(async (intent) => { resources.delete(intent.name); }),
    assertAbsent: vi.fn(async (intent) => { if (resources.has(intent.name)) throw new OpenShellError("openshell_cleanup_pending"); }),
    exec: vi.fn(async () => "fixture output"),
  };
  const manager = new OpenShellLifecycle({ driver, journal: store, stateRoot: root, exclusive: true, now: () => clock }); managers.push(manager);
  let clock = 100;
  await manager.initialize();
  let current: OpenShellIdentity | undefined = structuredClone(identity);
  return { root, store, driver, resources, manager, permit: (signal?: AbortSignal) => manager.prepareLaunch(identity, () => current, signal),
    setCurrent(value: OpenShellIdentity | undefined) { current = value; }, setClock(value: number) { clock = value; } };
}
function resourceFor(intent: OpenShellIntent): OpenShellResource { return { id: intent.id, name: intent.name, workspace: intent.identity.workspace, labels: { [OPEN_SHELL_OWNER_LABEL]: intent.owner } }; }

describe("OpenShell owned admission", () => {
  for (const key of Object.keys(identity) as (keyof OpenShellIdentity)[]) it(`rejects changed ${key} before durable intent or create`, async () => {
    const f = await fixture(); const permit = await f.permit();
    const changed = { ...identity, [key]: String(identity[key]).startsWith("sha256:") ? otherDigest : "changed" } as OpenShellIdentity;
    f.setCurrent(changed);
    await expect(f.manager.launch(permit)).rejects.toMatchObject({ code: "openshell_scope_invalid" });
    expect(f.store.listOpenShellIntents()).toEqual([]); expect(f.driver.create).not.toHaveBeenCalled();
  });
  it("rejects copied, forged, foreign, released, expired and revoked permits without effects", async () => {
    const f = await fixture(), g = await fixture(); const permit = await f.permit();
    for (const candidate of [{ ...permit }, Object.freeze({ expiresAt: 1, release() {} })]) await expect(f.manager.launch(candidate)).rejects.toMatchObject({ code: "openshell_scope_invalid" });
    await expect(g.manager.launch(permit)).rejects.toMatchObject({ code: "openshell_scope_invalid" });
    permit.release(); await expect(f.manager.launch(permit)).rejects.toMatchObject({ code: "openshell_scope_invalid" });
    const expired = await f.permit(); f.setClock(expired.expiresAt); await expect(f.manager.launch(expired)).rejects.toMatchObject({ code: "openshell_scope_invalid" });
    f.setClock(100); const revoked = await f.permit(); f.manager.revoke(); await expect(f.manager.launch(revoked)).rejects.toMatchObject({ code: "openshell_scope_invalid" });
    expect(f.store.listOpenShellIntents()).toEqual([]);
  });
  it("atomically claims once under concurrent consumption and retains the guarded lease", async () => {
    const f = await fixture(); const permit = await f.permit();
    const results = await Promise.allSettled([f.manager.launch(permit), f.manager.launch(permit)]);
    expect(results.filter((row) => row.status === "fulfilled")).toHaveLength(1); expect(f.driver.create).toHaveBeenCalledTimes(1);
    await expect(f.manager.launch(permit)).rejects.toMatchObject({ code: "openshell_scope_invalid" });
    const lease = results.find((row) => row.status === "fulfilled")! as PromiseFulfilledResult<Awaited<ReturnType<OpenShellLifecycle["launch"]>>>;
    f.setClock(1_000_000); lease.value.assertActive(); await lease.value.close();
  });
  it("rejects abort before intent and missing readiness before a permit", async () => {
    const f = await fixture(); const controller = new AbortController(); const permit = await f.permit(controller.signal); controller.abort();
    await expect(f.manager.launch(permit)).rejects.toMatchObject({ code: "openshell_scope_invalid" });
    vi.mocked(f.driver.probe).mockRejectedValue(new OpenShellError("openshell_gateway_unavailable"));
    await expect(f.permit()).rejects.toMatchObject({ code: "openshell_gateway_unavailable" });
    expect(f.store.listOpenShellIntents()).toEqual([]);
  });
  it("journal failure never sends create", async () => {
    const f = await fixture(); const permit = await f.permit(); vi.spyOn(f.store, "saveOpenShellIntent").mockImplementation(() => { throw Error("private diagnostic"); });
    await expect(f.manager.launch(permit)).rejects.toMatchObject({ code: "openshell_journal_failed" }); expect(f.driver.create).not.toHaveBeenCalled();
  });
  it("cancellation after intent but before send commits a clean no-create record", async () => {
    const f = await fixture(); const controller = new AbortController(); const permit = await f.permit(controller.signal);
    const save = f.store.saveOpenShellIntent.bind(f.store);
    vi.spyOn(f.store, "saveOpenShellIntent").mockImplementation((intent) => { save(intent); if (intent.phase === "intent") controller.abort(); });
    await expect(f.manager.launch(permit)).rejects.toBeDefined(); expect(f.driver.create).not.toHaveBeenCalled(); expect(f.store.listOpenShellIntents()[0]?.phase).toBe("cleaned");
  });
  it("a write failure after create receipt still retains ownership until verified cleanup", async () => {
    const f = await fixture(); const save = f.store.saveOpenShellIntent.bind(f.store); let failed = false;
    vi.spyOn(f.store, "saveOpenShellIntent").mockImplementation((intent) => { if (intent.phase === "active" && !failed) { failed = true; throw Error("receipt write failure"); } save(intent); });
    await expect(f.manager.launch(await f.permit())).rejects.toBeDefined(); expect(f.resources.size).toBe(0); expect(f.store.listOpenShellIntents()[0]).toMatchObject({ phase: "cleaned", acknowledged: true });
  });
  it("a malformed persisted journal fails startup closed without deleting anything", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "genbi-journal-corruption-")); roots.push(root); const file = path.join(root, "store.sqlite");
    const f = await fixture(undefined, new Store(file)); const lease = await f.manager.launch(await f.permit()); await lease.close(); await f.manager.shutdown();
    const db = new DatabaseSync(file); db.prepare("UPDATE openshell_intents SET payload = ?").run('{"id":"malformed"}'); db.close();
    const restarted = new OpenShellLifecycle({ driver: f.driver, journal: f.store, stateRoot: f.root, exclusive: true }); managers.push(restarted);
    await expect(restarted.initialize()).rejects.toMatchObject({ code: "openshell_journal_failed" }); expect((await restarted.probe()).readiness).toMatchObject({ code: "openshell_cleanup_pending" });
    expect(f.driver.remove).toHaveBeenCalledTimes(1);
  });
  it("cancels pending create before its late reply and prevents late effects", async () => {
    const f = await fixture(); const pending = deferred<OpenShellResource>(); let intent!: OpenShellIntent;
    vi.mocked(f.driver.create).mockImplementation((value) => { intent = value; return pending.promise; });
    const controller = new AbortController(); const permit = await f.permit(controller.signal); const launch = f.manager.launch(permit); const rejected = expect(launch).rejects.toMatchObject({ code: "openshell_cancelled" });
    controller.abort(); const cleanup = f.manager.cancelSession(identity.session);
    const resource = resourceFor(intent); f.resources.set(intent.name, resource); pending.resolve(resource);
    await rejected; await cleanup; expect(f.resources.size).toBe(0); expect(f.store.listOpenShellIntents()[0]?.phase).toBe("cleaned");
  });
  it("revoke denies actual resumed host effect and returned success while draining cleanup", async () => {
    const f = await fixture(); const lease = await f.manager.launch(await f.permit()); const gate = deferred<void>(); let effects = 0;
    const result = lease.effect(async (_signal, check) => { await gate.promise; check(); effects++; return "success"; });
    const rejected = expect(result).rejects.toBeDefined(); f.manager.revoke(); gate.resolve(); await rejected;
    expect(effects).toBe(0); await f.manager.shutdown(); await expect(lease.exec(["/bin/true"])).rejects.toBeDefined();
  });
  it("scope changes during exec cannot become a successful result", async () => {
    const f = await fixture(); const lease = await f.manager.launch(await f.permit()); const gate = deferred<string>(); vi.mocked(f.driver.exec).mockReturnValue(gate.promise);
    const output = lease.exec(["/bin/true"]); const rejected = expect(output).rejects.toMatchObject({ code: "openshell_scope_invalid" });
    f.setCurrent({ ...identity, account: otherDigest }); gate.resolve("late success"); await rejected; await lease.close();
  });
  it("partial create response loss is reconciled with exact ownership", async () => {
    const f = await fixture(); vi.mocked(f.driver.create).mockImplementation(async (intent) => { f.resources.set(intent.name, resourceFor(intent)); throw Error("lost reply"); });
    await expect(f.manager.launch(await f.permit())).rejects.toBeDefined(); expect(f.resources.size).toBe(0); expect(f.store.listOpenShellIntents()[0]?.phase).toBe("cleaned");
  });
  it("empty list after lost create remains unknown, blocks admission, and reclaims late allocation", async () => {
    const f = await fixture(); vi.mocked(f.driver.create).mockRejectedValue(new OpenShellError("openshell_remote_unknown"));
    await expect(f.manager.launch(await f.permit())).rejects.toMatchObject({ code: "openshell_cleanup_pending" });
    const row = f.store.listOpenShellIntents()[0]!; expect(row.phase).toBe("cleanup_pending"); await expect(f.permit()).rejects.toMatchObject({ code: "openshell_cleanup_pending" });
    f.resources.set(row.name, resourceFor(row)); await f.manager.cancel(row.id); expect(f.resources.size).toBe(0);
  });
  for (const mismatch of ["id", "owner", "workspace"]) it(`retains uncertain cleanup on wrong ${mismatch} without deletion`, async () => {
    const f = await fixture(); const lease = await f.manager.launch(await f.permit()); const row = f.store.listOpenShellIntents()[0]!; const actual = f.resources.get(row.name)!;
    vi.mocked(f.driver.inspect).mockResolvedValue({ ...actual, ...(mismatch === "id" ? { id: "wrong" } : mismatch === "workspace" ? { workspace: "wrong" } : { labels: { [OPEN_SHELL_OWNER_LABEL]: "wrong" } }) });
    await expect(lease.close()).rejects.toMatchObject({ code: "openshell_cleanup_pending" }); expect(f.driver.remove).not.toHaveBeenCalled(); expect(f.store.listOpenShellIntents()[0]?.phase).toBe("cleanup_pending");
  });
  it("delete failure retains retry and double stop shares one cleanup without touching sibling", async () => {
    const f = await fixture(); const a = await f.manager.launch(await f.permit()); const bIdentity = { ...identity, session: "session-b", turn: "turn-b" };
    const b = await f.manager.launch(await f.manager.prepareLaunch(bIdentity, () => bIdentity));
    vi.mocked(f.driver.remove).mockRejectedValueOnce(Error("delete failure"));
    const one = a.close(), two = a.close(); expect(one).toBe(two); await expect(one).rejects.toMatchObject({ code: "openshell_cleanup_pending" });
    expect(f.resources.size).toBe(2); b.assertActive(); await a.close(); expect(f.resources.size).toBe(1); b.assertActive(); await b.close(); expect(f.resources.size).toBe(0);
  });
  it("lost delete reply stays non-success until independent retry proves absence", async () => {
    const f = await fixture(); const lease = await f.manager.launch(await f.permit());
    vi.mocked(f.driver.remove).mockImplementationOnce(async (intent) => { f.resources.delete(intent.name); throw Error("lost delete reply"); });
    await expect(lease.close()).rejects.toMatchObject({ code: "openshell_cleanup_pending" }); expect(f.store.listOpenShellIntents()[0]?.phase).toBe("cleanup_pending");
    await f.manager.retryCleanup(); expect(f.store.listOpenShellIntents()[0]?.phase).toBe("cleaned");
  });
  it("incomplete listing or resource absence failure cannot promote cleanup", async () => {
    const f = await fixture(); const lease = await f.manager.launch(await f.permit()); vi.mocked(f.driver.list).mockRejectedValueOnce(new OpenShellError("openshell_protocol_invalid"));
    await expect(lease.close()).rejects.toMatchObject({ code: "openshell_cleanup_pending" }); expect(f.driver.remove).not.toHaveBeenCalled();
    vi.mocked(f.driver.assertAbsent).mockRejectedValueOnce(Error("container still present")); await expect(lease.close()).rejects.toMatchObject({ code: "openshell_cleanup_pending" });
    await lease.close(); expect(f.store.listOpenShellIntents()[0]?.phase).toBe("cleaned");
  });
  it("shutdown owns a pending create and waits for bounded driver settlement", async () => {
    const f = await fixture(); const pending = deferred<OpenShellResource>(); let intent!: OpenShellIntent;
    vi.mocked(f.driver.create).mockImplementation((value) => { intent = value; return pending.promise; });
    const launch = f.manager.launch(await f.permit()); const rejected = expect(launch).rejects.toBeDefined(); const shutdown = f.manager.shutdown();
    const resource = resourceFor(intent); f.resources.set(intent.name, resource); pending.resolve(resource); await rejected; await shutdown; expect(f.resources.size).toBe(0);
  });
  it("fences a failed cleanup journal write in memory and retries the owner after recovery", async () => {
    const f = await fixture(); const lease = await f.manager.launch(await f.permit());
    const save = f.store.saveOpenShellIntent.bind(f.store);
    const writes = vi.spyOn(f.store, "saveOpenShellIntent").mockImplementation(() => { throw Error("offline"); });
    const first = lease.close(); await expect(first).rejects.toMatchObject({ code: "openshell_journal_failed" });
    expect(f.store.listOpenShellIntents()[0]?.phase).toBe("active");
    expect((await f.manager.probe()).readiness).toMatchObject({ code: "openshell_cleanup_pending" });
    await expect(f.permit()).rejects.toMatchObject({ code: "openshell_cleanup_pending" });
    const second = lease.close(); expect(second).not.toBe(first); await expect(second).rejects.toBeDefined();
    writes.mockImplementation(save); await f.manager.retryCleanup();
    expect(f.resources.size).toBe(0); expect(f.driver.remove).toHaveBeenCalledTimes(1);
    expect(f.store.listOpenShellIntents()[0]?.phase).toBe("cleaned"); expect((await f.manager.probe()).readiness.state).toBe("ready");
  });
  it("retains discovered ID and resource inventory across lost-create and failed-delete retries", async () => {
    const f = await fixture();
    vi.mocked(f.driver.create).mockImplementation(async (intent) => { f.resources.set(intent.name, resourceFor(intent)); throw Error("lost reply"); });
    const container = "c".repeat(64), volume = "openshell-channel-" + "d".repeat(32);
    vi.mocked(f.driver.inspect).mockImplementation(async (intent) => ({ ...f.resources.get(intent.name)!, containers: [container], volumes: [volume] }));
    vi.mocked(f.driver.remove).mockRejectedValueOnce(Error("delete failure"));
    await expect(f.manager.launch(await f.permit())).rejects.toMatchObject({ code: "openshell_cleanup_pending" });
    const pinned = f.store.listOpenShellIntents()[0]!; expect(pinned.remoteId).toBeDefined();
    vi.mocked(f.driver.inspect).mockImplementation(async (intent) => ({ ...f.resources.get(intent.name)!, containers: [], volumes: [] }));
    await f.manager.retryCleanup();
    expect(f.resources.size).toBe(0); expect(f.driver.remove).toHaveBeenCalledTimes(2);
    expect(f.store.listOpenShellIntents()[0]).toMatchObject({ phase: "cleaned", remoteId: pinned.remoteId, containers: [container], volumes: [volume] });
    expect(() => f.store.saveOpenShellIntent({ ...pinned, remoteId: undefined })).toThrow();
  });
  it("session cancellation revokes prepared and probe-paused grants before journal or create", async () => {
    const f = await fixture(); const prepared = await f.permit();
    const entered = deferred<void>(), gate = deferred<void>();
    vi.mocked(f.driver.probe).mockImplementationOnce(async () => { entered.resolve(); await gate.promise; });
    const preparing = f.permit(); await entered.promise;
    const rejected = expect(preparing).rejects.toMatchObject({ code: "openshell_scope_invalid" });
    await f.manager.cancelSession(identity.session); gate.resolve(); await rejected;
    await expect(f.manager.launch(prepared)).rejects.toMatchObject({ code: "openshell_scope_invalid" });
    expect(f.store.listOpenShellIntents()).toEqual([]); expect(f.driver.create).not.toHaveBeenCalled();
    const fresh = await f.manager.launch(await f.permit()); await fresh.close();
  });
  it("single owner rejects concurrent controller and cleans journal-owned work on restart", async () => {
    const f = await fixture(); const other = new OpenShellLifecycle({ driver: f.driver, journal: f.store, stateRoot: f.root, exclusive: true }); managers.push(other);
    await expect(other.initialize()).rejects.toMatchObject({ code: "openshell_exclusivity_required" }); await other.shutdown(); expect(f.driver.remove).not.toHaveBeenCalled();
    const session = f.store.createSession("fixture"); f.store.createTurn({ id: "turn", sessionId: session.id, question: "fixture", composedInput: null });
    const captured = { ...identity, session: session.id }; const lease = await f.manager.launch(await f.manager.prepareLaunch(captured, () => captured));
    vi.mocked(f.driver.remove).mockRejectedValue(Error("offline")); await expect(f.manager.shutdown()).rejects.toMatchObject({ code: "openshell_cleanup_pending" });
    vi.mocked(f.driver.remove).mockImplementation(async (intent) => { f.resources.delete(intent.name); });
    const restarted = new OpenShellLifecycle({ driver: f.driver, journal: f.store, stateRoot: f.root, exclusive: true }); managers.push(restarted); await restarted.initialize();
    expect(f.store.getTurn("turn")?.resultKind).toBe("error"); expect(f.store.listOpenShellIntents()[0]).toMatchObject({ interrupted: true, phase: "cleaned" }); expect(f.resources.size).toBe(0); await expect(lease.exec(["/bin/true"])).rejects.toBeDefined();
  });
});

describe("OpenShell product operation fences", () => {
  it("never advertises or creates native model sessions from lifecycle readiness", async () => {
    const store = new Store(":memory:"); stores.push(store); const terminal = vi.fn(async () => { throw Error("must not launch"); });
    const host = new RuntimeHost({ selected: "openshell", deployment: "development", localAvailable: () => true,
      vendorProbes: { openshell: async () => ({ readiness: runtimeReady("1.0", []), diagnostic: { phase: "probe" } }) } });
    const service = new NativeSessionService({ store, terminalManager: terminal, getBinding: () => undefined, workspaceRoot: undefined,
      irPaths: { analysis: undefined, setup: undefined, context_enrichment: undefined }, warbleBin: "missing", runtimeHost: host });
    const readiness = await service.readiness(); for (const value of Object.values(readiness.purposes)) expect(value.available).toBe(false);
    await expect(service.create({ purpose: "setup", vendor: "claude" })).rejects.toThrow("OpenShell native model sessions are not supported.");
    expect(store.listNativeSessions()).toEqual([]); expect(terminal).not.toHaveBeenCalled(); await service.shutdown();
  });
  it("uses independent safe readiness and refuses Ask/Setup/native before durable operation writes", async () => {
    const store = new Store(":memory:"); stores.push(store); const local = vi.fn();
    const runtime = new StructuredRuntime({ selection: openshellClaude, localRoute: local, localSetupFor: () => undefined,
      adapters: { claude: { vendor: "claude", backend: "openshell", probe: async () => runtimeReady("1.0", []) } } });
    const session = store.createSession("empty");
    const deps: TurnDeps = { store, route: local, structuredRuntime: runtime, baseRouteOptions: { authChoice: { mode: "subscription", provider: "claude" }, userProject: "fixture", profileSource: "fixture" } };
    const app = createApp(deps);
    const before = JSON.stringify(store.getSession(session.id));
    await expect(postTurn(deps, session.id, "fixture")).rejects.toMatchObject({ code: "unsupported" });
    for (const endpoint of [`/api/sessions/${session.id}/turns`, "/api/setup/connect", "/api/setup/context", "/api/native-sessions", "/api/native-sessions/existing/recovery-action", "/api/context/enrichment/start"]) {
      const response = await app.request(endpoint, { method: "POST", body: "{}", headers: { "content-type": "application/json" } }); expect(response.status).toBe(503); expect(await response.json()).toEqual({ error: "Structured runtime unsupported.", code: "unsupported" });
    }
    expect(JSON.stringify(store.getSession(session.id))).toBe(before); expect(local).not.toHaveBeenCalled();
    expect((await app.request("/api/sessions", { method: "POST", body: "{}" })).status).toBe(201);
    expect((await runtime.readiness()).claude).toMatchObject({ backend: "openshell", ask: false, setup: false });
    const host = new RuntimeHost({ selected: "openshell", deployment: "development", localAvailable: () => true, vendorProbes: {
      openshell: async () => ({ readiness: { ...runtimeNotReady("openshell", "unavailable", "openshell_gateway_unavailable"), message: "private path/secret" }, diagnostic: { phase: "probe" } }),
    } });
    const readiness = await host.probe(); expect(readiness.backends.local.state).toBe("ready"); expect(JSON.stringify(readiness)).not.toContain("private path"); expect(readiness.selectedReadiness.state).toBe("unavailable");
  });
});

describe("OpenShell launch-in-progress admission state", () => {
  async function launching() {
    const f = await fixture(); const first = await f.permit(), second = await f.permit(); const pending = deferred<OpenShellResource>(); let intent!: OpenShellIntent;
    vi.mocked(f.driver.create).mockImplementation((value) => { intent = value; return pending.promise; });
    const launch = f.manager.launch(first); await vi.waitFor(() => expect(intent).toBeDefined());
    return { f, second, pending, launch, intent: () => intent };
  }
  it("reports a launch in its provisioning window as launch in progress, not cleanup pending, with admission still closed", async () => {
    const { f, second, pending, launch, intent } = await launching();
    const settle = () => { const resource = resourceFor(intent()); f.resources.set(intent().name, resource); pending.resolve(resource); };
    try {
      expect((await f.manager.probe()).readiness).toMatchObject({ state: "unavailable", code: "openshell_launch_in_progress" });
      await expect(f.permit()).rejects.toMatchObject({ code: "openshell_launch_in_progress" });
      await expect(f.manager.launch(second)).rejects.toMatchObject({ code: "openshell_scope_invalid" });
      expect(f.driver.create).toHaveBeenCalledTimes(1);
    } finally { settle(); }
    const lease = await launch;
    expect((await f.manager.probe()).readiness.state).toBe("ready"); await lease.close();
  });
  it("lets real cleanup pending win over a launch in flight", async () => {
    const { f, pending, launch, intent } = await launching();
    const stuck = f.store.listOpenShellIntents()[0]!;
    const owner = randomUUID();
    f.store.saveOpenShellIntent({ ...stuck, id: randomUUID(), name: `gb-${owner.replaceAll("-", "").slice(0, 16)}`, owner, phase: "cleanup_pending" });
    expect((await f.manager.probe()).readiness).toMatchObject({ code: "openshell_cleanup_pending" });
    await expect(f.permit()).rejects.toMatchObject({ code: "openshell_cleanup_pending" });
    const resource = resourceFor(intent()); f.resources.set(intent().name, resource); pending.resolve(resource); await launch.catch(() => {});
  });
  it("reports aborted owned work as cleanup pending even while its intent phase is unsettled", async () => {
    const f = await fixture(); const controller = new AbortController(); const pending = deferred<OpenShellResource>(); let intent!: OpenShellIntent;
    vi.mocked(f.driver.create).mockImplementation((value) => { intent = value; return pending.promise; });
    const launch = f.manager.launch(await f.permit(controller.signal)); const rejected = expect(launch).rejects.toBeDefined(); await vi.waitFor(() => expect(intent).toBeDefined());
    controller.abort();
    expect((await f.manager.probe()).readiness).toMatchObject({ code: "openshell_cleanup_pending" });
    const resource = resourceFor(intent); f.resources.set(intent.name, resource); pending.resolve(resource); await rejected;
  });
  it("treats a journal intent row with no live owner as cleanup pending, not a launch in progress", async () => {
    const f = await fixture(); const owner = randomUUID();
    f.store.saveOpenShellIntent({ id: randomUUID(), owner, name: `gb-${owner.replaceAll("-", "").slice(0, 16)}`, identity, createdAt: 100, phase: "intent", acknowledged: false, interrupted: false });
    expect((await f.manager.probe()).readiness).toMatchObject({ state: "unavailable", code: "openshell_cleanup_pending" });
    await expect(f.permit()).rejects.toMatchObject({ code: "openshell_cleanup_pending" });
  });
  it("keeps a failed launch as cleanup pending", async () => {
    const f = await fixture(); vi.mocked(f.driver.create).mockRejectedValue(new OpenShellError("openshell_remote_unknown"));
    await expect(f.manager.launch(await f.permit())).rejects.toMatchObject({ code: "openshell_cleanup_pending" });
    expect((await f.manager.probe()).readiness).toMatchObject({ code: "openshell_cleanup_pending" });
  });
});
