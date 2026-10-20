import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { RUNTIME_BUDGETS_MS } from "../harness/runtime-budgets.js";
import { Store } from "../server/db.js";
import { resolveEnrichmentBinding } from "../server/enrichment.js";
import { OpenShellNativeSessions, SANDBOX_PROBE_FAILURE_LIMIT, type ScopedFrame, type ScopedReplay } from "../server/openshell-native-sessions.js";
import type { OpenShellStructuredProvisioner } from "../server/openshell-structured-ask.js";
import { scopedSessionSocket } from "../server/scoped-session-socket.js";
import type { NativeSessionService } from "../server/native-sessions.js";
import { observeStructuredQueryAccess } from "../server/structured-error-feedback.js";
import { StructuredRuntimeError, type StructuredRuntime, type StructuredScope } from "../server/structured-runtime.js";
import { ClaudeDuplexProcess } from "../server/runtime-host/claude-duplex-process.js";
import { CLAUDE_TRANSPORT_LIMITS as LIMITS, type ClaudeRawProtocol } from "../server/runtime-host/claude-protocol.js";
import { OpenShellLifecycle } from "../server/runtime-host/openshell-lifecycle.js";
import { claimOpenShellSessionStep, launchOpenShellModelSession } from "../server/runtime-host/openshell-model-session.js";
import { OpenShellProjectSnapshots, snapshotSourceAuthority } from "../server/runtime-host/openshell-project-snapshots.js";
import { snapshotCanonical, snapshotHash, type SnapshotVolumeDriver } from "../server/runtime-host/openshell-snapshot-driver.js";
import type { SnapshotManifest } from "../server/runtime-host/openshell-snapshot-types.js";
import { openShellIdentitySchema, OPEN_SHELL_OWNER_LABEL, OpenShellError, type OpenShellDriver, type OpenShellDuplex, type OpenShellIdentity, type OpenShellIntent, type OpenShellResource } from "../server/runtime-host/openshell-types.js";
import { openOpenShellWrenAccess, type WrenWorkerIdentity } from "../server/runtime-host/openshell-wren-access.js";

// Deterministic fault injection for long-lived scoped sessions. Everything below the BFF is a fake
// (driver, volume, duplex peers); the session manager, lifecycle, snapshot owner, model-session
// capability, duplex facade and governed wren access are the production code. Nothing here
// changes behaviour: it pins today's failure and cleanup contract as a baseline.

const digest = `sha256:${"a".repeat(64)}`;
const tuple = { image: digest, policy: digest, configuration: digest, gateway: "gateway", workspace: "default" };
const dataTuple = { ...tuple, policy: `sha256:${"b".repeat(64)}` };
const worker: WrenWorkerIdentity = { worker: "genbi-wren-worker/1", snapshot: digest, script: digest, wheel: digest, toolchain: digest, architecture: "linux-arm64", protocol: "wren-governed/2" };
const mdlBytes = '{"models":["orders"]}';
const sourcePaths = ["wren_project.yml", "target/mdl.json", "data/input.txt"];
const IDLE_TTL_MS = 30 * 60_000;
const REQUEST = (n: number) => `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;

type QueryMode = "hold" | "error" | "ok";
type ModelMode = "hold" | "skip";
interface Plan { snapshot: "publish" | "hold" | "skip"; query: QueryMode | "skip"; model: ModelMode }
interface ModelPeer { step: string; closed: boolean; drop(): void; written: Promise<void> }

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { vi.useRealTimers(); for (const close of cleanups.splice(0).reverse()) await close().catch(() => {}); });

function deferred<T = void>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }

async function rig() {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "long-session-faults-")));
  const project = path.join(root, "project");
  for (const dir of ["target", "data"]) mkdirSync(path.join(project, dir), { recursive: true });
  writeFileSync(path.join(project, "wren_project.yml"), "version: 1\ndata_source: duckdb\nprofile: local\n"); writeFileSync(path.join(project, "target/mdl.json"), mdlBytes); writeFileSync(path.join(project, "data/input.txt"), "synthetic one");
  const store = new Store(":memory:");
  store.setRuntimeSettings({ authMode: "subscription", subscriptionProvider: "claude", subscriptionDriverModel: "synthetic-model", tierModels: [{ tier: "cheap", model: "haiku" }, { tier: "strong", model: "sonnet" }], hybrid: false, deployment: "personal", apiKeyAdapter: "anthropic" });
  store.activateEnrichmentBinding(resolveEnrichmentBinding(project));
  const authority = snapshotSourceAuthority({ store, currentProject: () => project, approvedFiles: sourcePaths, currentContext: () => digest });

  const resources = new Map<string, OpenShellResource>();
  const counts = { workerOpened: 0, workerClosed: 0, modelOpened: 0, modelClosed: 0, steps: 0 };
  const plan: Plan = { snapshot: "publish", query: "hold", model: "hold" };
  const workers: { closed: boolean }[] = []; const queryStarted = deferred(); let queryWrites = 0;
  const peers: ModelPeer[] = []; let nextStep = "";
  const stepCleanupHang = { value: false };
  // Silent sandbox death (host sleep): the workload exits and the supervisor disappears; no duplex close ever reaches the BFF.
  const sandbox = { dead: false, transient: 0, probes: 0, removed: 0 };
  const modelSandboxDown = (intent: OpenShellIntent) => intent.identity.purpose === "model_session" && sandbox.dead;
  const snapshotGate = { entered: deferred(), release: deferred(), hold: false };
  const stepControl = (argument: string) => {
    if (argument === "--baseline") return JSON.stringify({ type: "genbi.session.baseline", version: 1, processes: [] });
    if (argument === "--check") return JSON.stringify({ type: "genbi.session.checked", version: 1, remaining: 0 });
    const { receipt } = JSON.parse(argument) as { receipt: object }; return JSON.stringify({ ...receipt, type: "genbi.step.cleaned", remaining: 0 });
  };
  const governedPeer = (): OpenShellDuplex => {
    counts.workerOpened++; const state = { closed: false }; workers.push(state);
    let wake: (() => void) | undefined; const chunks = [Buffer.from(JSON.stringify(worker) + "\n" + JSON.stringify({ id: 0, protocol: worker.protocol }) + "\n")];
    return { done: new Promise(() => {}), output: (async function* () { while (!state.closed) { if (chunks.length) yield { stream: "stdout" as const, data: chunks.shift()! }; else await new Promise<void>(resolve => { wake = resolve; }); } })(),
      write(data) { const request = JSON.parse(data.toString()) as { id: number; sql: string }; queryWrites++; queryStarted.resolve(); if (plan.query === "hold") return;
        chunks.push(Buffer.from(JSON.stringify(plan.query === "error" ? { id: request.id, error: { class: "execution_failed", message: "synthetic" } } : { id: request.id, result: { columns: ["n"], rows: [{ n: 1 }], definition: { sql: request.sql, source_tables: ["orders"], filters: [] } } }) + "\n")); wake?.(); },
      close() { if (!state.closed) { state.closed = true; counts.workerClosed++; } wake?.(); } };
  };
  const modelPeer = (): OpenShellDuplex => {
    counts.modelOpened++; const wrote = deferred(), ended = deferred(); const step = nextStep;
    const peer: ModelPeer = { step, closed: false, drop: () => ended.resolve(), written: wrote.promise }; peers.push(peer);
    return { done: ended.promise.then(() => 0),
      output: (async function* () {
        await wrote.promise;
        yield { stream: "stdout" as const, data: Buffer.from(JSON.stringify({ type: "genbi.step", version: 1, step, pid: 200, group: 200, start: "1000" }) + "\n") };
        await ended.promise;
      })(),
      write() { wrote.resolve(); }, close() { if (!peer.closed) { peer.closed = true; counts.modelClosed++; } ended.resolve(); } };
  };
  const driver: OpenShellDriver = { version: "synthetic", identity: tuple, modelIdentity: tuple, dataIdentity: dataTuple, probe: async () => {},
    create: async (intent: OpenShellIntent) => { const row = { id: intent.id, name: intent.name, workspace: "default", labels: { [OPEN_SHELL_OWNER_LABEL]: intent.owner } }; resources.set(intent.name, row); return row; },
    list: async intent => [...resources.values()].filter(row => row.name === intent.name), inspect: async (intent, purpose) => { if (intent.identity.purpose === "model_session" && purpose !== "cleanup") { sandbox.probes++; if (sandbox.dead) throw new OpenShellError("openshell_identity_mismatch"); if (sandbox.transient > 0) { sandbox.transient--; throw new OpenShellError("openshell_remote_unknown"); } } return resources.get(intent.name)!; },
    remove: async intent => { if (intent.identity.purpose === "model_session") sandbox.removed++; resources.delete(intent.name); }, assertAbsent: async intent => { if (resources.has(intent.name)) throw new OpenShellError("openshell_cleanup_pending"); },
    duplex: async (intent, argv) => { if (modelSandboxDown(intent)) throw new OpenShellError("openshell_identity_mismatch"); return argv.includes("/opt/genbi/worker.py") ? governedPeer() : modelPeer(); },
    exec: async (intent, argv) => {
      if (modelSandboxDown(intent)) throw new OpenShellError("openshell_remote_unknown");
      if (argv[1] === "/opt/genbi/claude-step-control.mjs") { if (stepCleanupHang.value && argv[2]!.startsWith("{")) return new Promise<string>(() => {}); return stepControl(argv[2]!); }
      if (argv[1] === "-I") return Buffer.from(mdlBytes).toString("base64");
      return snapshotCanonical(manifest);
    } };
  const request = authority({ ...lifecycleIdentity("probe"), purpose: "lifecycle" } as OpenShellIdentity)!;
  const body = { version: 1 as const, project: request.project, bindingGeneration: request.bindingGeneration, bindingRevision: request.bindingRevision, context: digest, source: digest,
    files: [{ path: "project/target/mdl.json", size: mdlBytes.length, sha256: createHash("sha256").update(mdlBytes).digest("hex") }] };
  const manifest: SnapshotManifest = { ...body, digest: snapshotHash(snapshotCanonical(body)) };
  const volumes = new Map<string, string>();
  const volume: SnapshotVolumeDriver = { attest: vi.fn(),
    capture: vi.fn(async (_request, archive, signal) => { writeFileSync(archive, "fixture"); if (snapshotGate.hold) { snapshotGate.entered.resolve(); await Promise.race([snapshotGate.release.promise, new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(new OpenShellError("openshell_scope_invalid")), { once: true }))]); } return manifest; }),
    checkSource: vi.fn(async () => {}), publish: vi.fn(async (row, _archive, _signal, check, created) => { check(); volumes.set(row.volume, row.owner); created(); }),
    verify: vi.fn(async row => { if (volumes.get(row.volume) !== row.owner) throw new OpenShellError("openshell_ownership_mismatch"); return manifest; }),
    remove: vi.fn(async row => { volumes.delete(row.volume); }), readArguments: () => ["/bin/fixture"] };
  function lifecycleIdentity(session: string) {
    return { backend: "openshell", account: digest, generation: "1", session, turn: `turn-${session}`, binding: snapshotHash(resolveEnrichmentBinding(project).identity), bindingGeneration: String(store.getEnrichmentBinding()!.generation), bindingRevision: resolveEnrichmentBinding(project).revision,
      context: digest, plan: digest, ...tuple, purpose: "lifecycle", operation: "worker", snapshot: "none" } as Extract<OpenShellIdentity, { purpose: "lifecycle" }>;
  }
  const lifecycle = new OpenShellLifecycle({ driver, journal: store, stateRoot: path.join(root, "state"), exclusive: true });
  const snapshots = new OpenShellProjectSnapshots({ lifecycle, journal: store, driver: volume, stateRoot: path.join(root, "state"), currentSource: authority }); lifecycle.attachOwnedResources(snapshots);
  await lifecycle.initialize();
  const sessionIdentities = new Map<string, Extract<OpenShellIdentity, { purpose: "model_session" }>>();
  const modelIdentity = (session: string) => { const { turn: _turn, ...rest } = lifecycleIdentity(session); return openShellIdentitySchema.parse({ ...rest, purpose: "model_session", operation: "session", snapshot: "none" }) as Extract<OpenShellIdentity, { purpose: "model_session" }>; };

  const protocol = () => ({ host: vi.fn(), worker: vi.fn(), secretSafe: vi.fn() }) as unknown as ClaudeRawProtocol;
  const outcomes: { stage: string; detail?: string }[] = [];
  const routed = vi.fn();
  async function route(scope: StructuredScope): Promise<never> {
    routed();
    const signal = scope.signal!, id = scope.sessionId, scopeIdentity = lifecycleIdentity(id), current = () => scopeIdentity;
    let access: Awaited<ReturnType<typeof openOpenShellWrenAccess>> | undefined, process: ClaudeDuplexProcess | undefined, failure: Error | undefined, handle: { id: string; digest: string } | undefined, lease: { close(): Promise<void> } | undefined;
    try {
      if (plan.snapshot !== "skip") {
        handle = await snapshots.publish(await snapshots.preparePublication(scopeIdentity, current, signal)); scope.assertCurrent();
        if (plan.query !== "skip") {
          const delivered = await snapshots.deliver(await snapshots.prepareDelivery(handle, scopeIdentity, current, signal)); lease = delivered; scope.assertCurrent();
          access = observeStructuredQueryAccess(await openOpenShellWrenAccess({ lease: delivered, expected: worker, signal, assertCurrent: scope.assertCurrent }), recorded => { failure = recorded; });
          try { await access.query({ sql: "select count(*) as n from orders", limit: 10 }, signal); } catch (error) { throw failure ?? error; }
          scope.assertCurrent();
        }
      }
      if (plan.model === "hold") {
        const step = randomUUID(); nextStep = step; counts.steps++;
        const claim = claimOpenShellSessionStep(scope.modelSession!, openShellIdentitySchema.parse({ ...sessionIdentities.get(id)!, purpose: "model", operation: "step", turn: randomUUID(), invocation: randomUUID(), step, attempt: 1, model: "synthetic", tier: "cheap" }) as never);
        const bootstrap = Buffer.concat([Buffer.alloc(4), Buffer.from(JSON.stringify({ scope: step }))]); bootstrap.writeUInt32BE(bootstrap.length - 4, 0);
        process = new ClaudeDuplexProcess({ signal: AbortSignal.any([signal, claim.signal]), protocol: protocol(), bootstrap, connect: () => claim.duplex(), check: scope.assertCurrent, cleanup: () => claim.close(), admitPrelude: value => claim.admitPrelude(value) });
        const live = process; await new Promise<never>((_, reject) => { live.once("error", reject); });
      }
      throw new StructuredRuntimeError("failed");
    } finally {
      outcomes.push({ stage: "finally" });
      // Same release order as the production data-context binding: worker lease first, then the publication.
      const data = (async () => { if (access) await access.close(); else await lease?.close(); if (handle) await snapshots.remove(handle.id); })();
      const closed = await Promise.allSettled([data, process?.close()]);
      outcomes.push({ stage: "closed", detail: closed.map(result => result.status === "rejected" ? String((result.reason as { code?: string }).code ?? "error") : "ok").join(",") });
    }
  }
  const provisioner = { probe: async () => ({}),
    reserveSession: async (input: { scope: StructuredScope }) => { const id = modelIdentity(input.scope.sessionId); sessionIdentities.set(input.scope.sessionId, id); const permit = await lifecycle.prepareLaunch(id, () => id, input.scope.signal); return launchOpenShellModelSession(lifecycle, permit, id); },
    assertSessionCleaned(sessionId: string) {
      const intents = store.listOpenShellIntents().filter(row => row.identity.session === sessionId), publications = store.listSnapshotPublications().filter(row => row.identity.session === sessionId), references = store.listSnapshotReferences().filter(row => row.identity.session === sessionId);
      if (intents.some(row => row.phase !== "cleaned") || publications.some(row => row.phase !== "cleaned") || references.some(row => row.phase !== "released")) throw new StructuredRuntimeError("cleanup");
    } } as unknown as OpenShellStructuredProvisioner;
  const runtime = { assertOperationSupported() {}, route: (_options: unknown, scope: StructuredScope) => route(scope) } as unknown as StructuredRuntime;
  const native = new OpenShellNativeSessions({ store, provisioner, runtime: () => runtime, getBinding: () => store.getEnrichmentBinding(),
    routeOptions: () => ({ authChoice: { mode: "subscription", provider: "claude" }, profileSource: "/unused", userProject: project }) as never });
  cleanups.push(async () => { for (const peer of peers) peer.drop(); snapshotGate.release.resolve(); await native.shutdown().catch(() => {}); await lifecycle.shutdown(); store.close(); rmSync(root, { recursive: true, force: true }); });
  const ownership = (session: string) => ({ intents: store.listOpenShellIntents().filter(row => row.identity.session === session).map(row => row.phase), publications: store.listSnapshotPublications().filter(row => row.identity.session === session).map(row => row.phase),
    references: store.listSnapshotReferences().filter(row => row.identity.session === session).map(row => row.phase) });
  const leaked = () => ({ resources: resources.size, openWorkers: workers.filter(row => !row.closed).length, openModelPeers: peers.filter(row => !row.closed).length, volumes: volumes.size });
  const frames: (ScopedFrame | ScopedReplay)[] = [];
  const open = async () => { const launched = await native.open({ purpose: "analysis" }); return { id: launched.row.id, capability: launched.capability }; };
  const attach = (session: { id: string; capability: string }, after = 0) => native.attach(session.id, session.capability, frame => frames.push(frame), after)!;
  return { root, project, store, native, plan, counts, outcomes, routed, ownership, leaked, frames, open, attach, queryStarted: queryStarted.promise, queryWrites: () => queryWrites, peers, snapshotGate, stepCleanupHang, sandbox, volume, lifecycle, resources, workers };
}
const states = (frames: readonly (ScopedFrame | ScopedReplay)[]) => frames.flatMap(frame => frame.type === "event" && frame.kind === "state" ? [(frame.payload as { state: string; cleanup?: string })] : frame.type === "replay" ? frame.events.flatMap(event => event.kind === "state" ? [event.payload as { state: string; cleanup?: string }] : []) : []);
const kinds = (session: string, store: Store) => store.listNativeScopedEvents(session).map(event => event.kind);
const noLateSuccess = (store: Store, session: string, request: string) => {
  expect(kinds(session, store)).not.toContain("answer"); expect(store.getNativeScopedRequest(session, request)?.status).not.toBe("complete"); expect(store.getLatestNativeStructuredAnswer(session)).toBeUndefined();
};
const confirmedClean = (f: Awaited<ReturnType<typeof rig>>, session: string) => {
  expect(f.leaked()).toEqual({ resources: 0, openWorkers: 0, openModelPeers: 0, volumes: 0 });
  const owned = f.ownership(session); expect(owned.intents.length).toBeGreaterThan(0);
  expect(owned.intents.every(phase => phase === "cleaned")).toBe(true); expect(owned.publications.every(phase => phase === "cleaned")).toBe(true); expect(owned.references.every(phase => phase === "released")).toBe(true);
};

describe("duplex drop mid-step", () => {
  // supports long-session AC#2
  it("closing the model duplex interrupts the scoped session, releases query process, snapshot lease and ownership, and never saves a late answer", async () => {
    const f = await rig(); f.plan.query = "ok"; const session = await f.open(); const attachment = f.attach(session);
    const pending = attachment.submit(REQUEST(1), "count orders"); await vi.waitFor(() => expect(f.peers.length).toBe(1)); await f.peers[0]!.written;
    expect(f.leaked().openWorkers).toBe(1); expect(f.counts.steps).toBe(1);
    f.peers[0]!.drop(); await pending;
    expect(f.store.getNativeSession(session.id)?.status).toBe("interrupted");
    expect(states(f.frames)).toContainEqual({ state: "interrupted", cleanup: "confirmed" });
    expect(f.store.getNativeScopedRequest(session.id, REQUEST(1))?.status).toBe("interrupted");
    confirmedClean(f, session.id); noLateSuccess(f.store, session.id, REQUEST(1));
    expect(f.outcomes.at(-1)).toEqual({ stage: "closed", detail: "ok,ok" });
    await expect(attachment.submit(REQUEST(2), "follow up")).rejects.toThrow(); expect(f.routed).toHaveBeenCalledTimes(1);
  });

  // supports long-session AC#2
  it("cleanup stays bounded when the sandbox never confirms the step process is gone, and the session still ends interrupted with its ownership released", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const f = await rig(); f.plan.query = "ok"; f.stepCleanupHang.value = true; const session = await f.open(); const attachment = f.attach(session);
    const pending = attachment.submit(REQUEST(1), "count orders"); await vi.waitFor(() => expect(f.peers.length).toBe(1)); await f.peers[0]!.written;
    f.peers[0]!.drop(); await vi.advanceTimersByTimeAsync(LIMITS.cleanupMs - 1);
    expect(f.outcomes.some(outcome => outcome.stage === "closed")).toBe(false);
    await vi.advanceTimersByTimeAsync(1); await pending;
    expect(f.outcomes.at(-1)).toEqual({ stage: "closed", detail: "ok,cleanup" });
    expect(f.store.getNativeSession(session.id)?.status).toBe("interrupted"); expect(states(f.frames)).toContainEqual({ state: "interrupted", cleanup: "confirmed" });
    confirmedClean(f, session.id); noLateSuccess(f.store, session.id, REQUEST(1));
  });
});

describe("idle stop", () => {
  // supports long-session AC#2
  it("stops a listener-free scoped session only after the idle TTL; an attached listener holds it; detach re-arms", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const f = await rig(); const session = await f.open(); const state = () => f.native.history(session.id)!.state;
    await vi.advanceTimersByTimeAsync(IDLE_TTL_MS - 1); expect(state()).toBe("ready");
    const attachment = f.attach(session); await vi.advanceTimersByTimeAsync(IDLE_TTL_MS * 2); expect(state()).toBe("ready"); expect(f.store.getNativeSession(session.id)?.status).toBe("running");
    attachment.detach(); expect(f.store.getNativeSession(session.id)?.status).toBe("detached");
    await vi.advanceTimersByTimeAsync(IDLE_TTL_MS - 1); expect(state()).toBe("ready");
    await vi.advanceTimersByTimeAsync(1); await vi.waitFor(() => expect(f.store.getNativeSession(session.id)?.status).toBe("stopped"));
    expect(state()).toBe("stopped");
    expect(f.store.listNativeScopedEvents(session.id).map(event => event.payload)).toContainEqual({ state: "stopped", cleanup: "confirmed" }); confirmedClean(f, session.id);
    expect(f.routed).not.toHaveBeenCalled();
  });
});

describe("cancel at each stage", () => {
  // Today a cancelled root ends the scoped session as interrupted (cleanup confirmed); the roundtrip suite pins the same.
  const cancelled = async (f: Awaited<ReturnType<typeof rig>>, session: { id: string }, attachment: ReturnType<typeof f.attach>, pending: Promise<void>) => {
    await attachment.cancel(); await pending;
    expect(f.store.getNativeScopedRequest(session.id, REQUEST(1))?.status).toBe("cancelled"); expect(f.store.getNativeSession(session.id)?.status).toBe("interrupted");
    expect(states(f.frames)).toContainEqual({ state: "interrupted", cleanup: "confirmed" }); confirmedClean(f, session.id); noLateSuccess(f.store, session.id, REQUEST(1));
    await expect(attachment.submit(REQUEST(2), "follow up")).rejects.toThrow(); expect(f.routed).toHaveBeenCalledTimes(1);
  };

  // supports long-session AC#2
  it("mid-query (data worker) ends cancelled, closes the worker stream and releases the snapshot lease", async () => {
    const f = await rig(); f.plan.query = "hold"; f.plan.model = "skip"; const session = await f.open(); const attachment = f.attach(session);
    const pending = attachment.submit(REQUEST(1), "count orders"); await f.queryStarted;
    expect(f.leaked().openWorkers).toBe(1); expect(f.workers.every(row => !row.closed)).toBe(true); expect(f.leaked().resources).toBeGreaterThan(1);
    await cancelled(f, session, attachment, pending); expect(f.counts.workerClosed).toBe(1); expect(f.counts.modelOpened).toBe(0);
  });

  // supports long-session AC#2
  it("mid-snapshot publication ends cancelled, publishes nothing and leaves no volume, lease or ownership", async () => {
    const f = await rig(); f.snapshotGate.hold = true; f.plan.model = "skip"; const session = await f.open(); const attachment = f.attach(session);
    const pending = attachment.submit(REQUEST(1), "count orders"); await f.snapshotGate.entered.promise;
    expect(f.store.listSnapshotPublications().map(row => row.phase)).toEqual(["intent"]);
    await cancelled(f, session, attachment, pending);
    expect(f.volume.publish).not.toHaveBeenCalled(); expect(f.store.listSnapshotPublications().map(row => row.phase)).toEqual(["cleaned"]); expect(f.counts.workerOpened).toBe(0);
  });

  // supports long-session AC#2
  it("mid-model-step ends cancelled, closes the step process and releases everything", async () => {
    const f = await rig(); f.plan.query = "ok"; const session = await f.open(); const attachment = f.attach(session);
    const pending = attachment.submit(REQUEST(1), "count orders"); await vi.waitFor(() => expect(f.peers.length).toBe(1)); await f.peers[0]!.written;
    expect(f.counts.workerOpened).toBe(1); expect(f.counts.workerClosed).toBe(0); expect(f.peers[0]!.closed).toBe(false);
    await cancelled(f, session, attachment, pending); expect(f.counts.workerClosed).toBe(1); expect(f.peers[0]!.closed).toBe(true); expect(f.outcomes.at(-1)).toEqual({ stage: "closed", detail: "ok,ok" });
  });
});

describe("binding change during a session", () => {
  // supports long-session AC#2
  it("revokes the session and the server refuses new submissions before any model or tool start", async () => {
    const f = await rig(); const session = await f.open(); const attachment = f.attach(session);
    writeFileSync(path.join(f.project, "wren_project.yml"), "version: 1\ndata_source: duckdb\nprofile: changed\n");
    const advanced = f.store.activateEnrichmentBindingAndRevokeBoundNativeSessions(resolveEnrichmentBinding(f.project));
    expect(advanced.revokedNativeSessionIds).toEqual([session.id]);
    await expect(attachment.submit(REQUEST(1), "count orders")).rejects.toThrow(); expect(f.routed).not.toHaveBeenCalled(); expect(f.counts).toMatchObject({ modelOpened: 0, workerOpened: 0, steps: 0 });
    expect(f.native.attach(session.id, session.capability, () => {})).toBeUndefined();
    f.native.revoke(advanced.revokedNativeSessionIds);
    await vi.waitFor(() => expect(states(f.frames)).toContainEqual({ state: "interrupted", cleanup: "confirmed" }));
    await expect(attachment.submit(REQUEST(2), "again")).rejects.toThrow(); expect(f.routed).not.toHaveBeenCalled();
    expect(f.store.getNativeScopedRequest(session.id, REQUEST(1))).toBeUndefined(); expect(f.native.capability(session.id)).toBeUndefined();
    confirmedClean(f, session.id);
  });

  // supports long-session AC#2
  it("revoking a session with a query in flight aborts it, closes the worker and fences the later answer", async () => {
    const f = await rig(); f.plan.query = "hold"; f.plan.model = "skip"; const session = await f.open(); const attachment = f.attach(session);
    const pending = attachment.submit(REQUEST(1), "count orders"); await f.queryStarted;
    f.native.revoke([session.id]); await pending; await vi.waitFor(() => expect(states(f.frames)).toContainEqual({ state: "interrupted", cleanup: "confirmed" }));
    expect(f.counts.workerClosed).toBe(1); confirmedClean(f, session.id); noLateSuccess(f.store, session.id, REQUEST(1));
  });
});

describe("browser WebSocket detach and reattach", () => {
  // supports long-session AC#2
  it("survives a detach inside the idle TTL and a reattach replays only events after the cursor", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const f = await rig(); f.plan.query = "error"; f.plan.model = "skip"; const session = await f.open();
    const service = { attachScoped: (id: string, capability: string, listener: Parameters<NativeSessionService["attachScoped"]>[2], after?: number) => f.native.attach(id, capability, listener, after) } as unknown as NativeSessionService;
    const sent: Record<string, unknown>[][] = [[], []]; const socket = (index: number, cursor: string) => ({ ws: { send: (data: string) => { sent[index]!.push(JSON.parse(data)); }, close: vi.fn() }, handlers: scopedSessionSocket(service, session.id, session.capability, cursor) });
    const first = socket(0, "0"); first.handlers.onOpen(null, first.ws); expect(first.ws.close).not.toHaveBeenCalled();
    const seen = () => Math.max(0, ...sent[0]!.flatMap(frame => frame.type === "event" ? [frame.sequence as number] : []));
    expect(sent[0]![0]).toMatchObject({ type: "replay", state: "ready" });
    first.handlers.onMessage({ data: JSON.stringify({ type: "prompt", requestId: REQUEST(1), text: "count orders" }) }, first.ws);
    await vi.waitFor(() => expect(sent[0]!.some(frame => frame.kind === "refusal"), JSON.stringify([sent[0], f.outcomes])).toBe(true));
    const cursor = seen(); first.handlers.onClose(); expect(f.store.getNativeSession(session.id)?.status).toBe("detached");
    await vi.advanceTimersByTimeAsync(IDLE_TTL_MS / 2);
    const second = socket(1, String(cursor)); second.handlers.onOpen(null, second.ws); expect(second.ws.close).not.toHaveBeenCalled();
    expect(sent[1]![0]).toMatchObject({ type: "replay", state: "ready", events: [] }); expect(f.store.getNativeSession(session.id)?.status).toBe("running");
    await vi.advanceTimersByTimeAsync(IDLE_TTL_MS * 2); expect(f.native.history(session.id)!.state).toBe("ready");
    const behind = socket(0, "0"); behind.handlers.onOpen(null, behind.ws);
    const replay = sent[0]!.at(-1) as unknown as ScopedReplay; expect(replay.type).toBe("replay"); expect(replay.events.map(event => event.kind)).toEqual(expect.arrayContaining(["user", "refusal"])); expect(replay.events.every(event => event.sequence > 0)).toBe(true);
    second.handlers.onMessage({ data: JSON.stringify({ type: "prompt", requestId: REQUEST(2), text: "follow up question" }) }, second.ws);
    await vi.waitFor(() => expect(sent[1]!.filter(frame => frame.kind === "refusal").length).toBe(1)); expect(f.routed).toHaveBeenCalledTimes(2);
    expect(f.native.history(session.id, cursor)!.events.map(event => event.sequence).every(sequence => sequence > cursor)).toBe(true);
  });

  // supports long-session AC#2
  it("a detach during a running root does not cancel it; the reattach cursor replays the settled events", async () => {
    const f = await rig(); f.plan.query = "hold"; f.plan.model = "skip"; const session = await f.open(); const attachment = f.attach(session);
    const pending = attachment.submit(REQUEST(1), "count orders"); await f.queryStarted;
    const cursor = Math.max(...f.frames.flatMap(frame => frame.type === "event" ? [frame.sequence] : []));
    attachment.detach(); expect(f.store.getNativeSession(session.id)?.status).toBe("detached"); expect(f.workers.every(row => !row.closed)).toBe(true); expect(f.native.history(session.id)!.state).toBe("running");
    await f.native.stop(session.id, session.capability); await pending;
    const received: (ScopedFrame | ScopedReplay)[] = []; expect(f.native.attach(session.id, session.capability, frame => received.push(frame), cursor)).toBeDefined();
    const replay = received[0] as ScopedReplay; expect(replay.type).toBe("replay"); expect(replay.events.map(event => event.kind)).toContain("error"); expect(replay.state).toBe("stopped"); expect(replay.events.every(event => event.sequence > cursor)).toBe(true);
    confirmedClean(f, session.id);
  });
});

describe("sandbox dies silently (host sleep): no duplex close is ever delivered", () => {
  const FAILURE = "Scoped execution was interrupted; its sandbox cannot be resumed.";
  const BOUND_MS = RUNTIME_BUDGETS_MS.sandboxProbeInterval + RUNTIME_BUDGETS_MS.sandboxProbeTimeout;
  const timers = () => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const interrupted = (f: Awaited<ReturnType<typeof rig>>, session: string) => expect(f.store.getNativeSession(session)?.status).toBe("interrupted");

  it("a submit on the dead session is refused, interrupts it, releases ownership once and starts no tool or model", async () => {
    const f = await rig(); f.plan.query = "ok"; const session = await f.open(); const attachment = f.attach(session);
    expect(f.store.getNativeSession(session.id)?.status).toBe("running");
    f.sandbox.dead = true;
    await expect(attachment.submit(REQUEST(1), "count orders")).rejects.toThrow();
    interrupted(f, session.id); expect(f.store.getNativeSession(session.id)?.failure).toBe(FAILURE); expect(f.store.getNativeSession(session.id)?.endedAt).toBeTruthy();
    expect(f.routed).not.toHaveBeenCalled(); expect(f.counts).toMatchObject({ modelOpened: 0, workerOpened: 0, steps: 0 });
    expect(f.store.getNativeScopedRequest(session.id, REQUEST(1))).toBeUndefined(); expect(states(f.frames)).toContainEqual({ state: "interrupted", cleanup: "confirmed" });
    confirmedClean(f, session.id); expect(f.sandbox.removed).toBe(1); expect(f.native.capability(session.id)).toBeUndefined();
    await expect(attachment.submit(REQUEST(2), "again")).rejects.toThrow(); expect(f.routed).not.toHaveBeenCalled(); expect(f.sandbox.removed).toBe(1);
  });

  it("an idle attached session is interrupted within the bound, with no submit and no model call", async () => {
    timers(); const f = await rig(); const session = await f.open(); f.attach(session);
    await vi.advanceTimersByTimeAsync(RUNTIME_BUDGETS_MS.sandboxProbeInterval); expect(f.store.getNativeSession(session.id)?.status).toBe("running");
    f.sandbox.dead = true; await vi.advanceTimersByTimeAsync(BOUND_MS);
    await vi.waitFor(() => interrupted(f, session.id)); expect(f.store.getNativeSession(session.id)?.failure).toBe(FAILURE);
    await vi.waitFor(() => expect(states(f.frames)).toContainEqual({ state: "interrupted", cleanup: "confirmed" }));
    expect(f.routed).not.toHaveBeenCalled(); expect(f.counts).toMatchObject({ modelOpened: 0, workerOpened: 0, steps: 0 }); confirmedClean(f, session.id); expect(f.sandbox.removed).toBe(1);
    await vi.advanceTimersByTimeAsync(BOUND_MS * 5); expect(f.sandbox.removed).toBe(1);
  });

  it("a detached idle session is detected too", async () => {
    timers(); const f = await rig(); const session = await f.open(); f.attach(session).detach(); f.sandbox.dead = true;
    await vi.advanceTimersByTimeAsync(BOUND_MS); await vi.waitFor(() => interrupted(f, session.id)); confirmedClean(f, session.id);
  });

  it("a definitive-death submit racing the background probe cleans up exactly once", async () => {
    timers(); const f = await rig(); const session = await f.open(); const attachment = f.attach(session); f.sandbox.dead = true;
    const submitted = attachment.submit(REQUEST(1), "count orders").catch(() => {}); await vi.advanceTimersByTimeAsync(BOUND_MS); await submitted;
    interrupted(f, session.id); confirmedClean(f, session.id); expect(f.sandbox.removed).toBe(1); expect(f.routed).not.toHaveBeenCalled();
  });

  it("fewer than the failure limit of consecutive transient probe failures leave a healthy session alone; a success resets the count", async () => {
    timers(); const f = await rig(); const session = await f.open(); f.attach(session);
    for (let round = 0; round < 3; round++) {
      f.sandbox.transient = SANDBOX_PROBE_FAILURE_LIMIT - 1;
      await vi.advanceTimersByTimeAsync(RUNTIME_BUDGETS_MS.sandboxProbeInterval * SANDBOX_PROBE_FAILURE_LIMIT);
      expect(f.sandbox.transient).toBe(0); expect(f.store.getNativeSession(session.id)?.status).toBe("running"); expect(f.native.history(session.id)!.state).toBe("ready");
    }
    expect(f.sandbox.removed).toBe(0);
  });

  it("the failure limit of consecutive transient probe failures interrupts the session", async () => {
    timers(); const f = await rig(); const session = await f.open(); f.attach(session); f.sandbox.transient = SANDBOX_PROBE_FAILURE_LIMIT;
    await vi.advanceTimersByTimeAsync(RUNTIME_BUDGETS_MS.sandboxProbeInterval * SANDBOX_PROBE_FAILURE_LIMIT);
    await vi.waitFor(() => interrupted(f, session.id)); confirmedClean(f, session.id); expect(f.sandbox.removed).toBe(1);
  });

  it("a transient probe failure at submit refuses that submit without interrupting; the next submit runs", async () => {
    const f = await rig(); f.plan.query = "error"; f.plan.model = "skip"; const session = await f.open(); const attachment = f.attach(session);
    f.sandbox.transient = 1;
    await expect(attachment.submit(REQUEST(1), "count orders")).rejects.toThrow();
    expect(f.store.getNativeSession(session.id)?.status).toBe("running"); expect(f.routed).not.toHaveBeenCalled(); expect(f.sandbox.removed).toBe(0);
    await attachment.submit(REQUEST(2), "count orders again"); expect(f.routed).toHaveBeenCalledTimes(1); expect(f.store.getNativeSession(session.id)?.status).toBe("running");
  });

  it("a healthy session left idle past the idle TTL while attached is unaffected and keeps being probed", async () => {
    timers(); const f = await rig(); const session = await f.open(); f.attach(session);
    await vi.advanceTimersByTimeAsync(IDLE_TTL_MS * 2);
    expect(f.native.history(session.id)!.state).toBe("ready"); expect(f.store.getNativeSession(session.id)?.status).toBe("running");
    expect(f.sandbox.probes).toBeGreaterThanOrEqual(Math.floor(IDLE_TTL_MS * 2 / (RUNTIME_BUDGETS_MS.sandboxProbeInterval + 1))); expect(f.sandbox.removed).toBe(0); expect(f.routed).not.toHaveBeenCalled();
  });
});
