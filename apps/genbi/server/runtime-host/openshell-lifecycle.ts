import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { mkdirSync, openSync, closeSync, lstatSync, realpathSync, constants } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { openShellIdentitySchema, OpenShellError, OPEN_SHELL_OWNER_LABEL, type OpenShellIdentity, type OpenShellIntent, type OpenShellJournal, type OpenShellDriver, type OpenShellResource } from "./openshell-types.js";
import { runtimeNotReady, runtimeReady } from "./policy.js";
import { RUNTIME_BUDGETS_MS } from "../../harness/runtime-budgets.js";
import type { RuntimeBackendProbeResult } from "./types.js";

export interface OpenShellPermit { readonly expiresAt: number; release(): void }
export interface OpenShellEffectLease { readonly signal: AbortSignal; assertActive(): void; release(): void }
export interface OpenShellOwnedResources {
  unsettled(): boolean;
  /** True only when every unsettled item is an in-flight publication that is still progressing: no failure, no cleanup owed. */
  launching(): boolean;
  reconcile(): Promise<void>;
  workerCleaned(intent: OpenShellIntent): Promise<void>;
  revoke(): void;
  shutdown(): Promise<void>;
}
export interface OpenShellLease {
  readonly id: string;
  readonly signal: AbortSignal;
  assertActive(): void;
  /** Check immediately before invoking any host effect and after its async settlement. */
  effect<T>(effect: (signal: AbortSignal, assertActive: () => void) => Promise<T>): Promise<T>;
  exec(argv: readonly string[]): Promise<string>;
  /** Bounded read-only check that the owned sandbox and its containers still exist; rejects with the inspect failure. */
  probe(): Promise<void>;
  duplex(argv: readonly string[]): Promise<import("./openshell-types.js").OpenShellDuplex>;
  close(): Promise<void>;
}
interface Grant { identity: OpenShellIdentity; current: () => OpenShellIdentity | undefined; signal?: AbortSignal; expiresAt: number; consumed: boolean; reserved?: boolean; released: boolean; epoch: number; sessionEpoch: number }
interface Owned { controller: AbortController; signal: AbortSignal; check(): void; intent: OpenShellIntent; create?: Promise<OpenShellResource>; close?: Promise<void> | undefined; abort?: () => void }
const stateOwners = new Set<string>();

/** One BFF exclusively owns its configured gateway/workspace. No model operations. */
export class OpenShellLifecycle {
  private readonly grants = new WeakMap<OpenShellPermit, Grant>();
  private readonly pendingGrants = new Set<Grant>();
  private readonly owned = new Map<string, Owned>();
  private readonly lifetime = new AbortController();
  private initialized = false;
  private reconciled = false;
  private stopped = false;
  private epoch = 0;
  private lock: DatabaseSync | undefined;
  private lockRoot: string | undefined;
  private readonly sessionEpochs = new Map<string, number>();
  private readonly effects = new Map<AbortController, string>();
  private resources: OpenShellOwnedResources | undefined;
  private shutdownPromise?: Promise<void>;
  private retryPromise: Promise<void> | undefined;
  private readonly now: () => number;
  constructor(private readonly options: { driver: OpenShellDriver; journal: OpenShellJournal; stateRoot: string; exclusive: boolean; now?: () => number }) {
    this.now = options.now ?? Date.now;
  }
  get identity(): OpenShellDriver["identity"] { return Object.freeze({ ...this.options.driver.identity }); }
  get modelIdentity(): OpenShellDriver["identity"] | undefined { return this.options.driver.modelIdentity; }
  get dataIdentity(): OpenShellDriver["identity"] | undefined { return this.options.driver.dataIdentity; }
  /** Fail closed: the validator exists only when the driver verified a protected validator descriptor. */
  get validatorReady(): boolean { return this.options.driver.validatorReady?.() === true && !!this.options.driver.dataIdentity; }
  attachOwnedResources(resources: OpenShellOwnedResources): void {
    if (this.initialized || this.resources) throw new OpenShellError("openshell_scope_invalid");
    this.resources = resources;
  }
  private acquire(): void {
    const root = path.resolve(this.options.stateRoot);
    if (!this.options.exclusive || stateOwners.has(root)) throw new OpenShellError("openshell_exclusivity_required");
    mkdirSync(root, { recursive: true, mode: 0o700 });
    if (lstatSync(root).isSymbolicLink() || (lstatSync(root).mode & 0o777) !== 0o700) throw new OpenShellError("openshell_journal_failed");
    const canonicalRoot = realpathSync(root);
    if (stateOwners.has(canonicalRoot)) throw new OpenShellError("openshell_exclusivity_required");
    const file = path.join(canonicalRoot, "openshell-owner.sqlite");
    // Never unlink lock files: the OS releases this separate connection's lock
    // on process exit, so stale recovery cannot remove a successor's lock.
    const fd = openSync(file, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
    closeSync(fd);
    if (!lstatSync(file).isFile() || (lstatSync(file).mode & 0o777) !== 0o600) throw new OpenShellError("openshell_journal_failed");
    const lock = new DatabaseSync(file);
    try { lock.exec("PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE;"); }
    catch { lock.close(); throw new OpenShellError("openshell_exclusivity_required"); }
    stateOwners.add(canonicalRoot); this.lockRoot = canonicalRoot; this.lock = lock;
  }
  async initialize(): Promise<void> {
    if (this.initialized || this.stopped) throw new OpenShellError("openshell_unavailable");
    this.acquire(); this.initialized = true;
    for (const intent of this.options.journal.listOpenShellIntents()) {
      if (intent.phase === "cleaned") continue;
      this.options.journal.interruptOpenShellWork(intent);
      this.save({ ...intent, phase: "cleanup_pending", interrupted: true });
    }
    await this.retryCleanup();
    this.reconciled = true;
  }
  /** Cleanup that is owed (or aborted work) always outranks a launch that is merely still provisioning. */
  private admissionBlock(): "cleanup" | "launching" | undefined {
    const intents = this.options.journal.listOpenShellIntents();
    const cleanup = (this.resources?.unsettled() === true && !this.resources.launching())
      || [...this.owned.values()].some((owned) => owned.signal.aborted || owned.intent.phase === "cleanup_pending")
      || intents.some((row) => row.phase === "cleanup_pending" || (row.phase === "intent" && !this.owned.has(row.id)));
    if (cleanup) return "cleanup";
    return this.resources?.launching() === true || intents.some((row) => row.phase === "intent") ? "launching" : undefined;
  }
  private unsettled(): boolean { return this.admissionBlock() !== undefined; }
  private blockedCode(): "openshell_cleanup_pending" | "openshell_launch_in_progress" | undefined {
    const block = this.admissionBlock();
    return block === undefined ? undefined : block === "launching" ? "openshell_launch_in_progress" : "openshell_cleanup_pending";
  }
  async probe(): Promise<RuntimeBackendProbeResult<"openshell">> {
    try {
      if (!this.options.exclusive) throw new OpenShellError("openshell_exclusivity_required");
      if (!this.initialized || !this.lock || this.stopped) throw new OpenShellError("openshell_unavailable");
      if (!this.reconciled) throw new OpenShellError("openshell_cleanup_pending");
      const before = this.blockedCode(); if (before) throw new OpenShellError(before);
      await this.options.driver.probe();
      if (this.stopped) throw new OpenShellError("openshell_cleanup_pending");
      const after = this.blockedCode(); if (after) throw new OpenShellError(after);
      return { readiness: runtimeReady(this.options.driver.version, []), diagnostic: { phase: "probe" } };
    } catch (error) { return { readiness: runtimeNotReady("openshell", "unavailable", error instanceof OpenShellError ? error.code : "openshell_unavailable"), diagnostic: { phase: "probe" } }; }
  }
  async prepareLaunch(identity: OpenShellIdentity, current: () => OpenShellIdentity | undefined, signal?: AbortSignal, ttlMs = 30_000): Promise<OpenShellPermit> {
    for (const grant of this.pendingGrants) if (this.now() >= grant.expiresAt) { grant.released = true; this.pendingGrants.delete(grant); }
    const captured = Object.freeze(openShellIdentitySchema.parse(structuredClone(identity)));
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > 30_000) throw new OpenShellError("openshell_scope_invalid");
    const epoch = this.epoch, sessionEpoch = this.sessionEpochs.get(captured.session) ?? 0;
    if (signal?.aborted || !isDeepStrictEqual(captured, current())) throw new OpenShellError("openshell_scope_invalid");
    const result = await this.probe();
    if (result.readiness.state !== "ready") throw new OpenShellError(result.readiness.code);
    const grant: Grant = { identity: captured, current, ...(signal ? { signal } : {}), expiresAt: this.now() + ttlMs, consumed: false, released: false, epoch, sessionEpoch };
    this.checkGrant(grant); this.pendingGrants.add(grant);
    const permit = Object.freeze({ expiresAt: grant.expiresAt, release: () => { grant.released = true; this.pendingGrants.delete(grant); } });
    this.grants.set(permit, grant); return permit;
  }
  private driverIdentity(identity: OpenShellIdentity): OpenShellDriver["identity"] | undefined { return ["model", "model_session"].includes(identity.purpose) ? this.options.driver.modelIdentity : identity.purpose === "data" || identity.purpose === "validate" ? this.options.driver.dataIdentity : this.options.driver.identity; }
  private checkGrant(grant: Grant): void {
    if (this.stopped || grant.released || grant.epoch !== this.epoch || grant.sessionEpoch !== (this.sessionEpochs.get(grant.identity.session) ?? 0) || grant.signal?.aborted || this.now() >= grant.expiresAt
      || !isDeepStrictEqual(grant.identity, grant.current())) throw new OpenShellError("openshell_scope_invalid");
    const { image, policy, gateway, workspace, configuration } = grant.identity;
    if (!isDeepStrictEqual({ image, policy, gateway, workspace, configuration }, this.driverIdentity(grant.identity))) throw new OpenShellError("openshell_identity_mismatch");
  }
  assertLaunchPermit(permit: OpenShellPermit): void {
    const grant = this.grants.get(permit);
    if (!grant || grant.consumed || this.unsettled()) throw new OpenShellError("openshell_scope_invalid");
    this.checkGrant(grant);
  }
  /** One-shot host effect admission. Snapshot publication owns its durable resources separately. */
  claimEffect(permit: OpenShellPermit): OpenShellEffectLease {
    const grant = this.grants.get(permit);
    if (!grant || grant.consumed || grant.identity.purpose !== "lifecycle" || this.unsettled()) throw new OpenShellError("openshell_scope_invalid");
    this.checkGrant(grant); grant.consumed = true; this.pendingGrants.delete(grant);
    const controller = new AbortController(); this.effects.set(controller, grant.identity.session);
    const signal = AbortSignal.any([controller.signal, this.lifetime.signal, ...(grant.signal ? [grant.signal] : [])]);
    return Object.freeze({ signal, assertActive: () => { signal.throwIfAborted(); this.checkGrant({ ...grant, expiresAt: Number.MAX_SAFE_INTEGER }); },
      release: () => { controller.abort(); this.effects.delete(controller); } });
  }
  /** Reserve a data launch once before authorized delivery verification/ref effects. */
  reserveDataLaunch(permit: OpenShellPermit): OpenShellEffectLease { return this.reserveSnapshotLaunch(permit, "data"); }
  /** The validator has its own reservation: a data permit can never be reserved here, nor a validate permit above. */
  reserveValidatorLaunch(permit: OpenShellPermit): OpenShellEffectLease {
    if (!this.validatorReady) throw new OpenShellError("openshell_scope_invalid");
    return this.reserveSnapshotLaunch(permit, "validate");
  }
  private reserveSnapshotLaunch(permit: OpenShellPermit, purpose: "data" | "validate"): OpenShellEffectLease {
    const grant = this.grants.get(permit);
    if (!grant || grant.reserved || grant.consumed || grant.identity.purpose !== purpose || this.unsettled()) throw new OpenShellError("openshell_scope_invalid");
    this.checkGrant(grant); grant.reserved = true; grant.expiresAt = Number.MAX_SAFE_INTEGER; this.pendingGrants.delete(grant);
    const controller = new AbortController(); this.effects.set(controller, grant.identity.session);
    const signal = AbortSignal.any([controller.signal, this.lifetime.signal, ...(grant.signal ? [grant.signal] : [])]);
    return Object.freeze({ signal, assertActive: () => { signal.throwIfAborted(); this.checkGrant(grant); }, release: () => { controller.abort(); this.effects.delete(controller); } });
  }
  /** Atomically claim before journal/remote mutation. Host-only: no browser command API. */
  async launch(permit: OpenShellPermit, expectedIdentity?: OpenShellIdentity): Promise<OpenShellLease> {
    const grant = this.grants.get(permit);
    if (expectedIdentity && !isDeepStrictEqual(grant?.identity, expectedIdentity)) throw new OpenShellError("openshell_scope_invalid");
    if (!grant || grant.consumed || this.unsettled()) throw new OpenShellError("openshell_scope_invalid");
    this.checkGrant(grant); grant.consumed = true; this.pendingGrants.delete(grant);
    const owner = randomUUID();
    const intent: OpenShellIntent = { id: randomUUID(), owner, name: `gb-${owner.replaceAll("-", "").slice(0, 16)}`, identity: grant.identity,
      createdAt: this.now(), phase: "intent", acknowledged: false, interrupted: false };
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, this.lifetime.signal, ...(grant.signal ? [grant.signal] : [])]);
    const check = () => { signal.throwIfAborted(); this.checkGrant({ ...grant, expiresAt: Number.MAX_SAFE_INTEGER }); };
    const owned: Owned = { intent, controller, signal, check };
    this.owned.set(intent.id, owned); // pending ownership exists before first provisioning await
    try {
      check(); this.save(intent);
      check();
      const create = this.options.driver.create(intent, signal); owned.create = create;
      owned.abort = () => { void this.closeOwned(owned).catch(() => {}); };
      signal.addEventListener("abort", owned.abort, { once: true });
      if (signal.aborted) owned.abort();
      const resource = await create;
      this.verify(intent, resource);
      owned.intent = { ...intent, remoteId: resource.id, ...(resource.containers ? { containers: resource.containers } : {}), ...(resource.volumes ? { volumes: resource.volumes } : {}), acknowledged: true, phase: "active" };
      this.save(owned.intent); check();
      const lease: OpenShellLease = Object.freeze({ id: intent.id, signal, assertActive: check,
        effect: async <T>(effect: (signal: AbortSignal, assertActive: () => void) => Promise<T>) => { check(); const result = await effect(signal, check); check(); return result; },
        exec: async (argv: readonly string[]) => { check(); const result = await this.options.driver.exec(owned.intent, argv, signal); check(); return result; },
        probe: async () => {
          check(); let timer: ReturnType<typeof setTimeout> | undefined;
          try { await Promise.race([this.options.driver.inspect(owned.intent), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new OpenShellError("openshell_remote_unknown")), RUNTIME_BUDGETS_MS.sandboxProbeTimeout); })]); }
          finally { clearTimeout(timer); }
          check();
        },
        duplex: async (argv: readonly string[]) => {
          check(); if (!["model", "model_session", "data", "validate"].includes(grant.identity.purpose) || !this.options.driver.duplex) throw new OpenShellError("openshell_scope_invalid");
          const stream = await this.options.driver.duplex(owned.intent, argv, signal); check();
          return { ...stream, write: (data: Buffer) => { check(); stream.write(data); }, close: () => stream.close() };
        },
        close: () => this.closeOwned(owned),
      });
      return lease;
    } catch (error) {
      const cancelled = signal.aborted;
      controller.abort();
      // If intent write failed, never send create. If a later write failed, retained intent still owns cleanup.
      if (this.options.journal.listOpenShellIntents().some((row) => row.id === intent.id)) {
        try { await this.closeOwned(owned); } catch { throw new OpenShellError("openshell_cleanup_pending"); }
      } else this.owned.delete(intent.id);
      throw error instanceof OpenShellError ? error : new OpenShellError(cancelled ? "openshell_cancelled" : "openshell_unavailable");
    }
  }
  private save(intent: OpenShellIntent): void {
    try { this.options.journal.saveOpenShellIntent(intent); } catch { throw new OpenShellError("openshell_journal_failed"); }
  }
  private verify(intent: OpenShellIntent, resource: OpenShellResource): void {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/.test(resource.id) || resource.name !== intent.name || resource.workspace !== intent.identity.workspace
      || resource.labels[OPEN_SHELL_OWNER_LABEL] !== intent.owner || (intent.remoteId !== undefined && resource.id !== intent.remoteId)) throw new OpenShellError("openshell_ownership_mismatch");
  }
  private latest(intent: OpenShellIntent): OpenShellIntent {
    const durable = this.options.journal.listOpenShellIntents().find((row) => row.id === intent.id);
    if (durable?.remoteId && intent.remoteId && durable.remoteId !== intent.remoteId) throw new OpenShellError("openshell_ownership_mismatch");
    return { ...durable, ...intent, remoteId: durable?.remoteId ?? intent.remoteId,
      containers: [...new Set([...(durable?.containers ?? []), ...(intent.containers ?? [])])],
      volumes: [...new Set([...(durable?.volumes ?? []), ...(intent.volumes ?? [])])] };
  }
  private closeOwned(owned: Owned): Promise<void> {
    if (owned.abort) owned.signal.removeEventListener("abort", owned.abort);
    owned.controller.abort();
    // This fence precedes any await or journal write, and survives write failure.
    owned.intent = { ...owned.intent, phase: "cleanup_pending" };
    if (owned.close) return owned.close;
    const close = (async () => {
      await owned.create?.catch(() => {});
      owned.intent = this.latest(owned.intent);
      if (!owned.create) { await this.resources?.workerCleaned(owned.intent); this.save({ ...owned.intent, phase: "cleaned" }); this.owned.delete(owned.intent.id); return; }
      this.save(owned.intent);
      await this.cleanup(owned.intent);
      this.owned.delete(owned.intent.id);
    })();
    owned.close = close.catch((error: unknown) => { owned.close = undefined; throw error; });
    return owned.close;
  }
  private async cleanup(original: OpenShellIntent): Promise<void> {
    let intent = original;
    const persist = (next: OpenShellIntent) => {
      intent = next;
      const owned = this.owned.get(intent.id);
      if (owned) owned.intent = intent;
      this.save(intent);
    };
    try {
      intent = this.latest(intent);
      if (!isDeepStrictEqual({ image: intent.identity.image, policy: intent.identity.policy, gateway: intent.identity.gateway,
        workspace: intent.identity.workspace, configuration: intent.identity.configuration }, this.driverIdentity(intent.identity))) throw new OpenShellError("openshell_identity_mismatch");
      const resources = await this.options.driver.list(intent);
      if (resources.length > 1) throw new OpenShellError("openshell_ownership_mismatch");
      if (resources.length) {
        this.verify(intent, resources[0]!);
        persist({ ...intent, remoteId: resources[0]!.id });
        const inspected = await this.options.driver.inspect(intent, "cleanup");
        this.verify(intent, inspected);
        persist(this.latest({ ...intent, ...(inspected.containers ? { containers: inspected.containers } : {}), ...(inspected.volumes ? { volumes: inspected.volumes } : {}) }));
        await this.options.driver.remove(intent);
      } else if (!intent.acknowledged && !intent.remoteId) {
        // A lost create response plus empty list cannot exclude a later allocation.
        throw new OpenShellError("openshell_remote_unknown");
      }
      const remaining = await this.options.driver.list(intent);
      if (remaining.length) throw new OpenShellError("openshell_cleanup_pending");
      await this.options.driver.assertAbsent(intent);
      await this.resources?.workerCleaned(intent);
      persist({ ...intent, phase: "cleaned" });
    } catch (error) {
      persist({ ...intent, phase: "cleanup_pending", error: error instanceof OpenShellError ? error.code : "openshell_cleanup_pending" });
      throw new OpenShellError("openshell_cleanup_pending");
    }
  }
  cancel(id: string): Promise<void> {
    const owned = this.owned.get(id);
    if (owned) return this.closeOwned(owned);
    const intent = this.options.journal.listOpenShellIntents().find((row) => row.id === id);
    return !intent || intent.phase === "cleaned" ? Promise.resolve() : this.cleanup(intent);
  }
  cancelSession(session: string): Promise<void> {
    this.sessionEpochs.set(session, (this.sessionEpochs.get(session) ?? 0) + 1);
    for (const [controller, ownerSession] of this.effects) if (ownerSession === session) controller.abort();
    for (const grant of this.pendingGrants) if (grant.identity.session === session) { grant.released = true; this.pendingGrants.delete(grant); }
    const pending = [...this.owned.values()].filter((owned) => owned.intent.identity.session === session);
    for (const owned of pending) owned.controller.abort();
    return Promise.all(pending.map((owned) => this.closeOwned(owned))).then(() => {});
  }
  revoke(): void {
    this.epoch++;
    for (const controller of this.effects.keys()) controller.abort();
    this.resources?.revoke();
    for (const grant of this.pendingGrants) grant.released = true;
    this.pendingGrants.clear();
    for (const owned of this.owned.values()) { owned.controller.abort(); void this.closeOwned(owned).catch(() => {}); }
  }
  retryCleanup(): Promise<void> {
    if (!this.initialized || !this.lock) return Promise.reject(new OpenShellError("openshell_exclusivity_required"));
    return this.retryPromise ??= (async () => {
      const ownedRetries = [...this.owned.values()].filter((owned) => (owned.signal.aborted || owned.intent.phase === "cleanup_pending")).map((owned) => this.closeOwned(owned));
      const orphanRetries = this.options.journal.listOpenShellIntents().filter((row) => row.phase !== "cleaned" && !this.owned.has(row.id)).map((row) => this.cleanup(row));
      const results = await Promise.allSettled([...ownedRetries, ...orphanRetries]);
      if (results.some((result) => result.status === "rejected")) throw new OpenShellError("openshell_cleanup_pending");
      await this.resources?.reconcile();
      this.reconciled = true;
    })().finally(() => { this.retryPromise = undefined; });
  }
  shutdown(): Promise<void> {
    this.stopped = true; this.lifetime.abort(); this.revoke();
    return this.shutdownPromise ??= (async () => {
      if (!this.initialized || !this.lock) return;
      try {
        const results = await Promise.allSettled([...this.owned.values()].map((owned) => this.closeOwned(owned)));
        await this.retryCleanup();
        await this.resources?.shutdown();
        if (results.some((result) => result.status === "rejected") || this.unsettled()) throw new OpenShellError("openshell_cleanup_pending");
      } finally {
        if (this.lock) { this.lock.close(); stateOwners.delete(this.lockRoot!); this.lock = undefined; this.lockRoot = undefined; }
      }
    })();
  }
}
