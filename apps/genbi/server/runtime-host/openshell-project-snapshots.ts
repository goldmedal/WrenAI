import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, lstatSync } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { Store } from "../db.js";
import { resolveEnrichmentBinding } from "../enrichment.js";
import { OpenShellLifecycle, type OpenShellPermit, type OpenShellEffectLease, type OpenShellLease, type OpenShellOwnedResources } from "./openshell-lifecycle.js";
import { OpenShellError, type OpenShellIdentity, type OpenShellIntent } from "./openshell-types.js";
import { snapshotCanonical, snapshotHash, safeSnapshotPath, type SnapshotCaptureRequest, type SnapshotVolumeDriver } from "./openshell-snapshot-driver.js";
import type { SnapshotJournal, SnapshotManifest, SnapshotMount, SnapshotPublication } from "./openshell-snapshot-types.js";

export interface PublicationPermit { readonly expiresAt: number; release(): void }
export interface PublishedSnapshot { readonly id: string; readonly digest: string }
export interface DeliveryPermit { readonly expiresAt: number; release(): void }
export interface DataSnapshotLease { readonly id: string; readonly reference: string; assertActive(): void; openGoverned(): Promise<import("./openshell-types.js").OpenShellDuplex>; verify(): Promise<SnapshotManifest>; read(relative: string): Promise<Buffer>; close(): Promise<void> }
type LifecycleScope = Extract<OpenShellIdentity, { purpose: "lifecycle" }>;
interface PublicationGrant { permit: OpenShellPermit; request: SnapshotCaptureRequest; scope: LifecycleScope; consumed: boolean }
interface DeliveryGrant { permit: OpenShellPermit; publication: SnapshotPublication; request: SnapshotCaptureRequest; identity: OpenShellIdentity; consumed: boolean }

/** Accepted Store binding is authoritative; the exact file list and context are host callbacks. */
export function snapshotSourceAuthority(options: { store: Store; currentProject: () => string | undefined; approvedFiles: readonly string[]; currentContext: (scope: OpenShellIdentity) => string | undefined; preserveProjectConfig?: boolean }): (scope: OpenShellIdentity) => SnapshotCaptureRequest | undefined {
  const paths = Object.freeze([...options.approvedFiles].sort());
  if (paths.length < 2 || paths.length > 4094 || paths.some((file) => !safeSnapshotPath(file)) || !paths.includes("wren_project.yml") || !paths.includes("target/mdl.json")
    || new Set(paths.map((file) => file.toLowerCase())).size !== paths.length) throw new OpenShellError("openshell_configuration_invalid");
  return (scope) => {
    const project = options.currentProject(), stored = options.store.getEnrichmentBinding(), context = options.currentContext(scope);
    if (!project || !stored || !context) return undefined;
    try {
      const binding = resolveEnrichmentBinding(project);
      if (binding.path !== project || stored.path !== project || stored.identity !== binding.identity) return undefined;
      return { root: project, identity: binding.identity, paths, project: snapshotHash(binding.identity), bindingGeneration: String(stored.generation), bindingRevision: binding.revision, context,
        projection: { ...(options.preserveProjectConfig ? {} : { "project/wren_project.yml": 'version: 1\ndata_source: duckdb\nprofile: snapshot\n' }),
          ...(options.preserveProjectConfig ? { "wren-home/config.json": '{"strict_mode":true}\n' } : {}),
          "wren-home/profiles.yml": 'active: snapshot\nprofiles:\n  snapshot:\n    datasource: duckdb\n    url: /opt/genbi-project/project/data\n    format: duckdb\n' } };
    } catch { return undefined; }
  };
}

/** Separate durable snapshot owner, sharing the lifecycle controller's exclusive lock. */
export class OpenShellProjectSnapshots implements OpenShellOwnedResources {
  private readonly publications = new WeakMap<PublicationPermit, PublicationGrant>();
  private readonly deliveries = new WeakMap<DeliveryPermit, DeliveryGrant>();
  private readonly handles = new WeakMap<PublishedSnapshot, { request: SnapshotCaptureRequest; row: SnapshotPublication }>();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly activeEffects = new Set<OpenShellEffectLease>();
  private readonly activeRefs = new Map<string, OpenShellLease>();
  private readonly removals = new Map<string, Promise<void>>();
  private firstReconcile = true;
  private failure = false;
  constructor(private readonly options: { lifecycle: OpenShellLifecycle; journal: SnapshotJournal & Pick<Store, "listOpenShellIntents">; driver: SnapshotVolumeDriver; stateRoot: string; currentSource: (scope: OpenShellIdentity) => SnapshotCaptureRequest | undefined }) {}
  private save(row: SnapshotPublication): void {
    try {
      const previous = this.options.journal.listSnapshotPublications().find((value) => value.id === row.id);
      this.options.journal.saveSnapshotPublication({ ...row, helperIds: [...new Set([...(previous?.helperIds ?? []), ...row.helperIds])], helperNames: [...new Set([...(previous?.helperNames ?? []), ...row.helperNames])] });
    } catch { this.failure = true; throw new OpenShellError("openshell_journal_failed"); }
  }
  recordHelper(publication: string, name: string, id?: string): void {
    const row = this.row(publication);
    this.save({ ...row, helperNames: [...row.helperNames, name], helperIds: id ? [...row.helperIds, id] : row.helperIds });
  }
  private row(id: string): SnapshotPublication {
    const row = this.options.journal.listSnapshotPublications().find((value) => value.id === id);
    if (!row) throw new OpenShellError("openshell_scope_invalid"); return row;
  }
  private stage(row: SnapshotPublication): string { return path.join(this.options.stateRoot, `snapshot-${row.owner}`); }
  private checkSource(request: SnapshotCaptureRequest, scope: OpenShellIdentity): void {
    if (!isDeepStrictEqual(request, this.options.currentSource(scope))) throw new OpenShellError("openshell_scope_invalid");
  }
  private checkScope(scope: OpenShellIdentity, request: SnapshotCaptureRequest): void {
    if (scope.binding !== request.project || scope.bindingGeneration !== request.bindingGeneration || scope.bindingRevision !== request.bindingRevision || scope.context !== request.context) throw new OpenShellError("openshell_scope_invalid");
  }
  private checkReady(row: SnapshotPublication): void {
    const current = this.row(row.id);
    if (current.phase !== "ready" || current.manifest?.digest !== row.manifest?.digest || this.removals.has(row.id)) throw new OpenShellError("openshell_scope_invalid");
  }
  private track<T>(operation: Promise<T>): Promise<T> {
    this.pending.add(operation); return operation.finally(() => { this.pending.delete(operation); });
  }
  async preparePublication(scope: LifecycleScope, current: () => OpenShellIdentity | undefined, signal?: AbortSignal): Promise<PublicationPermit> {
    const request = this.options.currentSource(scope);
    if (!request || scope.purpose !== "lifecycle") throw new OpenShellError("openshell_scope_invalid");
    this.checkScope(scope, request); this.options.driver.attest();
    const captured = structuredClone(request);
    const permit = await this.options.lifecycle.prepareLaunch(scope, () => { try { this.checkSource(captured, scope); return current(); } catch { return undefined; } }, signal);
    const result = Object.freeze({ expiresAt: permit.expiresAt, release: () => permit.release() });
    this.publications.set(result, { permit, request: captured, scope: structuredClone(scope), consumed: false }); return result;
  }
  async publish(permit: PublicationPermit): Promise<PublishedSnapshot> {
    const grant = this.publications.get(permit);
    if (!grant || grant.consumed) throw new OpenShellError("openshell_scope_invalid");
    const effect = this.options.lifecycle.claimEffect(grant.permit); grant.consumed = true; this.activeEffects.add(effect);
    const owner = randomUUID();
    let row: SnapshotPublication = { id: randomUUID(), owner, volume: `genbi-snapshot-${owner.replaceAll("-", "")}`, configuration: grant.scope.configuration,
      identity: grant.scope, createdAt: Date.now(), phase: "intent", helperIds: [], helperNames: [], interrupted: false, acknowledged: false };
    const check = () => { effect.assertActive(); this.checkSource(grant.request, grant.scope); };
    const operation = (async () => {
      try {
        check(); this.save(row); check();
        mkdirSync(this.stage(row), { mode: 0o700 }); check();
        const manifest = await this.options.driver.capture(grant.request, path.join(this.stage(row), "capture.tar"), effect.signal); check();
        this.checkScope(grant.scope, grant.request);
        row = { ...row, manifest, phase: "publishing" }; this.save(row); check();
        await this.options.driver.publish(row, path.join(this.stage(row), "capture.tar"), effect.signal, check, () => { row = { ...row, acknowledged: true }; this.save(row); }); check();
        await this.options.driver.verify(row, effect.signal); check();
        await this.options.driver.checkSource(grant.request, manifest, path.join(this.stage(row), "recheck.tar"), effect.signal); check();
        row = { ...row, phase: "ready" }; this.save(row); check();
        rmSync(this.stage(row), { recursive: true });
        const handle = Object.freeze({ id: row.id, digest: manifest.digest });
        this.handles.set(handle, { request: grant.request, row }); return handle;
      } catch (error) {
        this.failure = true;
        try { row = { ...row, phase: "cleanup_pending" }; this.save(row); await this.remove(row.id); } catch { /* durable retry owns uncertainty */ }
        throw error instanceof OpenShellError ? error : new OpenShellError("openshell_scope_invalid");
      } finally { effect.release(); this.activeEffects.delete(effect); }
    })();
    this.pending.add(operation); try { return await operation; } finally { this.pending.delete(operation); }
  }
  prepareDelivery(handle: PublishedSnapshot, scope: LifecycleScope, current: () => OpenShellIdentity | undefined, signal?: AbortSignal): Promise<DeliveryPermit> {
    return this.track(this.prepareDeliveryOwned(handle, scope, current, signal));
  }
  private async prepareDeliveryOwned(handle: PublishedSnapshot, scope: LifecycleScope, current: () => OpenShellIdentity | undefined, signal?: AbortSignal): Promise<DeliveryPermit> {
    const captured = this.handles.get(handle), backend = this.options.lifecycle.dataIdentity;
    if (!captured || !backend) throw new OpenShellError("openshell_scope_invalid");
    this.checkSource(captured.request, scope); this.checkScope(scope, captured.request);
    const row = this.row(handle.id);
    if (row.phase !== "ready" || row.manifest?.digest !== handle.digest) throw new OpenShellError("openshell_scope_invalid");
    const reference = randomUUID();
    const asData = (value: OpenShellIdentity | undefined): OpenShellIdentity | undefined => value?.purpose === "lifecycle" ? { ...value, ...backend,
      purpose: "data", operation: "read", snapshot: handle.digest, publication: handle.id, reference } : undefined;
    const identity = asData(scope)!;
    // Verification and whole-source recheck are authorized by a consumed effect permit,
    // and delivery admission is issued only afterwards with the final immutable digest.
    const proof = await this.options.lifecycle.prepareLaunch(scope, current, signal);
    const effect = this.options.lifecycle.claimEffect(proof); this.activeEffects.add(effect);
    const scratch = path.join(this.stage(row), `proof-${reference}`);
    try {
      effect.assertActive(); this.checkReady(row); this.checkSource(captured.request, scope); mkdirSync(scratch, { mode: 0o700, recursive: true });
      await this.options.driver.verify(row, effect.signal); effect.assertActive(); this.checkSource(captured.request, scope);
      await this.options.driver.checkSource(captured.request, row.manifest!, path.join(scratch, "source.tar"), effect.signal); effect.assertActive(); this.checkSource(captured.request, scope);
      const permit = await this.options.lifecycle.prepareLaunch(identity, () => { try { this.checkSource(captured.request, scope); this.checkScope(current()!, captured.request); return asData(current()); } catch { return undefined; } }, signal);
      try { effect.assertActive(); this.checkReady(row); } catch (error) { permit.release(); throw error; }
      const result = Object.freeze({ expiresAt: permit.expiresAt, release: () => permit.release() });
      this.deliveries.set(result, { permit, publication: row, request: captured.request, identity, consumed: false }); return result;
    } finally { effect.release(); this.activeEffects.delete(effect); if (lstatExists(scratch)) rmSync(scratch, { recursive: true, force: true }); }
  }
  deliver(permit: DeliveryPermit): Promise<DataSnapshotLease> { return this.track(this.deliverOwned(permit)); }
  private async deliverOwned(permit: DeliveryPermit): Promise<DataSnapshotLease> {
    const grant = this.deliveries.get(permit);
    if (!grant || grant.consumed || grant.identity.purpose !== "data") throw new OpenShellError("openshell_scope_invalid");
    // Opaque delivery is claimed synchronously before ref mutation. Validate its
    // retained lifecycle permit immediately before the durable acquire/create.
    const effect = this.options.lifecycle.reserveDataLaunch(grant.permit); this.activeEffects.add(effect);
    grant.consumed = true;
    const identity = grant.identity;
    const reference = { id: identity.reference, publication: identity.publication, identity, phase: "pending" as const, interrupted: false };
    let worker: OpenShellLease | undefined;
    try {
      effect.assertActive(); this.checkReady(grant.publication); this.checkSource(grant.request, grant.identity);
      const scratch = path.join(this.stage(grant.publication), `delivery-${reference.id}`);
      mkdirSync(scratch, { recursive: true, mode: 0o700 });
      try {
        await this.options.driver.checkSource(grant.request, grant.publication.manifest!, path.join(scratch, "source.tar"), effect.signal);
        effect.assertActive(); this.checkSource(grant.request, grant.identity);
        await this.options.driver.verify(grant.publication, effect.signal); effect.assertActive(); this.checkSource(grant.request, grant.identity);
      } finally { if (lstatExists(scratch)) rmSync(scratch, { recursive: true, force: true }); }
      effect.assertActive(); this.checkReady(grant.publication); this.checkSource(grant.request, grant.identity);
      try { this.options.journal.saveSnapshotReference(reference); } catch { this.failure = true; throw new OpenShellError("openshell_journal_failed"); }
      effect.assertActive();
      worker = await this.options.lifecycle.launch(grant.permit);
      this.activeRefs.set(reference.id, worker);
      const stored = this.options.journal.listSnapshotReferences().find((row) => row.id === reference.id)!;
      this.options.journal.saveSnapshotReference({ ...stored, phase: "active" }); worker.assertActive();
      const verify = async () => {
        const raw = await worker!.exec(this.options.driver.readArguments(grant.publication));
        let manifest: SnapshotManifest;
        try { manifest = JSON.parse(raw) as SnapshotManifest; } catch { throw new OpenShellError("openshell_identity_mismatch"); }
        if (snapshotCanonical(manifest) !== snapshotCanonical(grant.publication.manifest)) throw new OpenShellError("openshell_identity_mismatch"); return manifest;
      };
      await verify(); worker.assertActive();
      return Object.freeze({ id: worker.id, reference: reference.id, verify, assertActive: () => worker!.assertActive(),
        openGoverned: () => worker!.duplex(["/usr/local/bin/python", "-I", "/opt/genbi/worker.py"]),
        read: async (relative: string) => {
          const entry = grant.publication.manifest!.files.find((file) => file.path === relative);
          if (!entry || entry.size > 262_144 || !safeSnapshotPath(relative)) throw new OpenShellError("openshell_scope_invalid");
          await verify();
          const raw = await worker!.exec(["/usr/local/bin/python", "-I", "-c", "import pathlib,base64;print(base64.b64encode(pathlib.Path('/opt/genbi-project').joinpath(__import__('sys').argv[1]).read_bytes()).decode())", relative]);
          const bytes = Buffer.from(raw.trim(), "base64");
          if (bytes.length !== entry.size || snapshotHash(bytes).slice(7) !== entry.sha256) throw new OpenShellError("openshell_identity_mismatch"); return bytes;
        }, close: async () => { await worker!.close(); this.activeRefs.delete(reference.id); },
      });
    } catch (error) {
      this.failure = true;
      if (worker) await worker.close().catch(() => {});
      const latest = this.options.journal.listSnapshotReferences().find((row) => row.id === reference.id);
      if (latest && !latest.workerId) this.options.journal.saveSnapshotReference({ ...latest, phase: "released" });
      throw error instanceof OpenShellError ? error : new OpenShellError("openshell_scope_invalid");
    } finally { effect.release(); this.activeEffects.delete(effect); }
  }
  mount(intent: OpenShellIntent): SnapshotMount {
    if (intent.identity.purpose !== "data") throw new OpenShellError("openshell_scope_invalid");
    const identity = intent.identity;
    const ref = this.options.journal.listSnapshotReferences().find((row) => row.id === identity.reference);
    const publication = this.row(identity.publication);
    if (!ref || ref.workerId !== intent.id || ref.phase === "released" || !isDeepStrictEqual(ref.identity, identity) || publication.phase !== "ready" || publication.manifest?.digest !== identity.snapshot) throw new OpenShellError("openshell_scope_invalid");
    return { volume: publication.volume, owner: publication.owner, digest: identity.snapshot };
  }
  async workerCleaned(intent: OpenShellIntent): Promise<void> {
    if (intent.identity.purpose !== "data") return;
    const identity = intent.identity;
    const ref = this.options.journal.listSnapshotReferences().find((row) => row.id === identity.reference);
    if (!ref || ref.workerId !== intent.id) throw new OpenShellError("openshell_journal_failed");
    this.options.journal.saveSnapshotReference({ ...ref, phase: "released" }); this.activeRefs.delete(ref.id);
  }
  remove(id: string): Promise<void> {
    const pending = this.removals.get(id); if (pending) return pending;
    const operation = this.removeOwned(id).finally(() => { this.removals.delete(id); }); this.removals.set(id, operation); return operation;
  }
  private async removeOwned(id: string): Promise<void> {
    const row = this.row(id);
    if (row.phase === "cleaned") return;
    if (this.options.journal.listSnapshotReferences().some((ref) => ref.publication === id && ref.phase !== "released")) throw new OpenShellError("openshell_cleanup_pending");
    this.save({ ...row, phase: "cleanup_pending" });
    await this.options.driver.remove(row);
    if (lstatExists(this.stage(row))) rmSync(this.stage(row), { recursive: true });
    this.save({ ...row, phase: "cleaned" }); this.failure = false;
  }
  unsettled(): boolean { return this.failure || this.options.journal.listSnapshotPublications().some((row) => ["intent", "publishing", "cleanup_pending"].includes(row.phase)); }
  revoke(): void { for (const effect of this.activeEffects) effect.release(); }
  async reconcile(): Promise<void> {
    await Promise.allSettled([...this.pending]);
    for (const ref of this.options.journal.listSnapshotReferences()) {
      if (ref.phase === "released") continue;
      const worker = this.options.journal.listOpenShellIntents().find((row) => row.id === ref.workerId);
      if (worker?.phase === "cleaned" || (!ref.workerId && this.firstReconcile)) this.options.journal.saveSnapshotReference({ ...ref, phase: "released", interrupted: this.firstReconcile || ref.interrupted });
      else if (this.firstReconcile) throw new OpenShellError("openshell_cleanup_pending");
    }
    for (const row of this.options.journal.listSnapshotPublications()) if (row.phase !== "cleaned" && (this.firstReconcile || row.phase !== "ready")) await this.remove(row.id);
    this.firstReconcile = false; this.failure = false;
  }
  async shutdown(): Promise<void> { this.revoke(); await Promise.allSettled([...this.pending]); for (const row of this.options.journal.listSnapshotPublications()) if (row.phase !== "cleaned") await this.remove(row.id); }
}
function lstatExists(value: string): boolean { try { if (lstatSync(value).isSymbolicLink()) throw new OpenShellError("openshell_ownership_mismatch"); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; } }
