import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { RouteOptions } from "../harness/index.js";
import { newId, type NativeSessionRow, type Store } from "./db.js";
import type { EnrichmentBinding } from "./enrichment.js";
import { LiveWorkLog, toAnswerOrRefusalEvent } from "./fold.js";
import { structuredDataRefusal, structuredFailureFeedback } from "./structured-error-feedback.js";
import { StructuredRuntimeError, type StructuredRuntime, type StructuredScope } from "./structured-runtime.js";
import type { OpenShellStructuredProvisioner } from "./openshell-structured-ask.js";
import type { OpenShellModelSession } from "./runtime-host/openshell-model-session.js";

export type ScopedSessionState = "ready" | "running" | "cancelling" | "stopping" | "stopped" | "interrupted";
export type ScopedFrame = { type: "event" } & ReturnType<Store["appendNativeScopedEvent"]>;
export interface ScopedReplay { type: "replay"; through: number; floor: number; truncated: boolean; state: ScopedSessionState; events: readonly ScopedFrame[] }
export interface ScopedAttachment { submit(requestId: string, text: string): Promise<void>; cancel(): Promise<void>; detach(): void }
type Listener = (frame: ScopedFrame | ScopedReplay) => void;
interface Record {
  id: string; capability: string; lease: OpenShellModelSession; state: ScopedSessionState; controller: AbortController;
  assertCurrent(): void; listeners: Set<Listener>; active?: { id: string; controller: AbortController; promise: Promise<void>; settled: Promise<void> } | undefined;
  closing?: Promise<void>; interruption?: Promise<void>; idle?: ReturnType<typeof setTimeout> | undefined;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const hash = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const terminal = (state: ScopedSessionState) => state === "stopped" || state === "interrupted";

/** Same governed analytical route, with a process-local owned sandbox and durable replay. */
export class OpenShellNativeSessions {
  private readonly records = new Map<string, Record>();
  private readonly creations = new Map<string, Promise<{ row: NativeSessionRow; capability: string }>>();
  private readonly launches = new Map<string, { scope: string; result: Promise<{ row: NativeSessionRow; capability: string }> }>();
  private readonly lifetime = new AbortController();
  private cleanupFailed = false;
  constructor(private readonly options: { store: Store; provisioner: OpenShellStructuredProvisioner; runtime(): StructuredRuntime;
    getBinding(): EnrichmentBinding | undefined; routeOptions(): Omit<RouteOptions, "question" | "onEvent"> }) {}

  async readiness() { return this.options.provisioner.probe(); }
  reconcile(id: string): NativeSessionRow | undefined { const record = this.records.get(id); if (record && !terminal(record.state)) { try { record.assertCurrent(); } catch { void this.interrupt(record).catch(() => { this.cleanupFailed = true; }); } } return this.options.store.getNativeSession(id); }
  capability(id: string): string | undefined { const record = this.records.get(id); return record && !terminal(record.state) ? record.capability : undefined; }
  private validate(input: { purpose: string; profile?: string | undefined; entryVerb?: string | undefined }) {
    if (input.purpose !== "analysis" || input.profile !== undefined && input.profile !== "genbi-default" || input.entryVerb !== undefined) throw new StructuredRuntimeError("unsupported");
    if (!this.options.provisioner.assertSessionCleaned) throw new StructuredRuntimeError("unavailable");
    this.options.runtime().assertOperationSupported(this.options.routeOptions().authChoice, "native");
    if (this.lifetime.signal.aborted) throw new StructuredRuntimeError("unavailable");
  }
  private scopeKey() { return JSON.stringify([this.options.store.getNativeRuntimeBinding(), this.options.getBinding(), this.options.store.getRuntimeSettings()]); }
  async open(input: { purpose: string; profile?: string | undefined; entryVerb?: string | undefined; id?: string; capability?: string | undefined; requestId?: string }) {
    this.validate(input);
    if (input.id) {
      const record = this.records.get(input.id); if (!record || terminal(record.state) || input.capability !== record.capability) throw new StructuredRuntimeError("unavailable");
      record.assertCurrent(); return { row: this.options.store.getNativeSession(record.id)!, capability: record.capability };
    }
    const scope = this.scopeKey();
    if (input.requestId !== undefined && !uuid.test(input.requestId)) throw new StructuredRuntimeError("unsupported");
    // A new implicit create owns a new opaque action; it cannot reveal another browser's cap.
    const key = input.requestId ?? randomUUID();
    const existing = this.launches.get(key);
    if (existing) { if (existing.scope !== scope) throw new StructuredRuntimeError("stale"); const result = await existing.result; const record = this.records.get(result.row.id); if (!record || terminal(record.state)) throw new StructuredRuntimeError("stale"); record.assertCurrent(); return { ...result, row: this.options.store.getNativeSession(result.row.id)! }; }
    if ([...this.records.values()].filter(record => !terminal(record.state)).length >= 8 || this.creations.size >= 8 || this.launches.size >= 128) throw new StructuredRuntimeError("unavailable");
    const result = this.create(); this.launches.set(key, { scope, result }); this.creations.set(key, result);
    try { return await result; } catch (error) { this.launches.delete(key); throw error; } finally { this.creations.delete(key); }
  }

  private async create() {
    const id = newId("native-session"), capability = randomUUID(), controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, this.lifetime.signal]);
    const binding = structuredClone(this.options.getBinding()), runtime = structuredClone(this.options.store.getNativeRuntimeBinding()), settings = structuredClone(this.options.store.getRuntimeSettings());
    if (!binding || !runtime.configured || !runtime.target || runtime.provider !== "claude" || !this.options.provisioner.reserveSession) throw new StructuredRuntimeError("unavailable");
    const check = () => { signal.throwIfAborted(); if (!isDeepStrictEqual(binding, this.options.getBinding()) || !isDeepStrictEqual(runtime, this.options.store.getNativeRuntimeBinding()) || !isDeepStrictEqual(settings, this.options.store.getRuntimeSettings())) throw new StructuredRuntimeError("stale"); };
    const scope: StructuredScope = { sessionId: id, turnId: newId("native-preparation"), signal, assertCurrent: check };
    let lease: OpenShellModelSession | undefined;
    try {
      // The opaque launch permission and actual lease precede the first durable native row.
      lease = await this.options.provisioner.reserveSession({ options: { ...this.options.routeOptions(), question: "Analyze the bound project.", agentId: "answer_query" }, scope }); check(); lease.assertActive();
      const row = this.options.store.createNativeSession({ id, transport: "scoped-events", purpose: "analysis", vendor: "claude", agent: "answer_query", scopeKind: "bound_project", scopeId: newId("native-scope"), projectIdentity: binding.identity, bindingGeneration: binding.generation, projectRevision: binding.revision, dispatchProfile: "genbi-default", dispatchTarget: runtime.target!, runtimeGeneration: runtime.generation });
      const record: Record = { id, capability, lease, state: "ready", controller, listeners: new Set(), assertCurrent: () => { check(); lease!.assertActive(); const current = this.options.store.getNativeSession(id); if (!current || !["creating", "running", "detached"].includes(current.status)) throw new StructuredRuntimeError("stale"); } };
      this.records.set(id, record); this.options.store.transitionNativeSession(id, "running", { started: true });
      lease.signal.addEventListener("abort", () => { if (!terminal(record.state) && record.state !== "stopping") { record.active?.controller.abort(); void this.interrupt(record).catch(() => { this.cleanupFailed = true; }); } }, { once: true });
      lease.assertActive(); this.publish(record, null, "state", { state: "ready" }); this.armIdle(record); return { row: this.options.store.getNativeSession(row.id)!, capability };
    } catch (error) { controller.abort(); await lease?.close(); if (this.options.store.getNativeSession(id)) this.options.store.transitionNativeSession(id, "interrupted", { ended: true, failure: "Scoped session launch could not complete." }); throw error; }
  }
  private deliver(record: Record, event: ReturnType<Store["appendNativeScopedEvent"]>) { const frame: ScopedFrame = { type: "event", ...event }; for (const listener of record.listeners) try { listener(frame); } catch { /* Browser detach never owns execution cancellation. */ } }
  private publish(record: Record, requestId: string | null, kind: string, payload: unknown) { const event = this.options.store.appendNativeScopedEvent(record.id, requestId, kind, payload); this.deliver(record, event); }
  history(id: string, after = 0): ScopedReplay | undefined {
    const row = this.options.store.getNativeSession(id); if (row?.transport !== "scoped-events" || !Number.isSafeInteger(after) || after < 0) return undefined;
    const all = this.options.store.listNativeScopedEvents(id), through = all.at(-1)?.sequence ?? 0, floor = all[0]?.sequence ?? 0;
    if (after > through) return undefined;
    const record = this.records.get(id), state = record?.state ?? (row.status === "stopped" ? "stopped" : "interrupted");
    return { type: "replay", through, floor, truncated: after < this.options.store.nativeScopedPrunedThrough(id), state, events: all.filter(event => event.sequence > after).map(event => ({ type: "event", ...event })) };
  }
  attach(id: string, capability: string, listener: Listener, after = 0): ScopedAttachment | undefined {
    const record = this.records.get(id); if (!record || record.capability !== capability) return undefined;
    try { if (!terminal(record.state)) record.assertCurrent(); const replay = this.history(id, after); if (!replay) return undefined;
      // No await: commit/replay/subscribe share this synchronous BFF event loop boundary.
      listener(replay); record.listeners.add(listener); clearTimeout(record.idle); record.idle = undefined;
      if (!terminal(record.state)) this.options.store.transitionNativeSession(id, "running");
    } catch { return undefined; }
    let attached = true;
    const check = () => { if (!attached || record.capability !== capability) throw new StructuredRuntimeError("unavailable"); };
    return { submit: (requestId, text) => { check(); return this.submit(record, requestId, text); }, cancel: () => { check(); return this.cancel(record); }, detach: () => { if (!attached) return; attached = false; record.listeners.delete(listener); if (!record.listeners.size && !terminal(record.state)) { this.options.store.transitionNativeSession(id, "detached"); this.armIdle(record); } } };
  }
  private armIdle(record: Record) { clearTimeout(record.idle); if (record.listeners.size || terminal(record.state)) return; record.idle = setTimeout(() => { void this.stop(record.id, record.capability).catch(() => {}); }, 30 * 60_000); record.idle.unref(); }

  private async submit(record: Record, requestId: string, text: string) {
    record.assertCurrent(); if (terminal(record.state) || record.closing || !uuid.test(requestId) || !text.trim() || text.includes("\0") || Buffer.byteLength(text) > 262_144) throw new StructuredRuntimeError("unsupported");
    const questionHash = hash(text), previous = this.options.store.getNativeScopedRequest(record.id, requestId);
    if (previous) { if (previous.questionHash !== questionHash) throw new StructuredRuntimeError("stale"); if (record.active?.id === requestId) await record.active.promise; return; }
    if (record.active) throw new StructuredRuntimeError("unavailable");
    const turnId = newId("native-turn"), controller = new AbortController();
    this.options.store.reserveNativeScopedRequest(record.id, requestId, questionHash, turnId);
    this.publish(record, requestId, "user", { text }); record.state = "running"; this.publish(record, requestId, "state", { state: "running" });
    let rootSettled!: () => void;
    const settled = new Promise<void>(resolve => { rootSettled = resolve; });
    const active = { id: requestId, controller, promise: Promise.resolve(), settled }; record.active = active;
    const signal = AbortSignal.any([controller.signal, record.controller.signal, this.lifetime.signal]);
    const check = () => { signal.throwIfAborted(); record.assertCurrent(); };
    active.promise = (async () => {
      const log = new LiveWorkLog(); let interruptAfter = false;
      try {
        const history = this.options.store.listNativeScopedEvents(record.id).filter(event => event.kind === "answer" || event.kind === "refusal").slice(-4).map(event => event.payload);
        const question = history.length ? `Previous validated conversation (context only):\n${JSON.stringify(history).slice(0, 16384)}\n\nCurrent question:\n${text}` : text;
        const result = await this.options.runtime().route({ ...this.options.routeOptions(), question, agentId: "answer_query", onEvent: event => { check(); const worklog = log.ingest(event); if (worklog) this.publish(record, requestId, "worklog", { steps: worklog }); } }, { sessionId: record.id, turnId, signal, assertCurrent: check, modelSession: record.lease });
        check(); if (result.backend !== "openshell") throw new StructuredRuntimeError("unsupported");
        const event = toAnswerOrRefusalEvent(newId("native-event"), result, log.snapshot()); check();
        const envelopeJson = event.kind === "answer" && event.answer.form === "rich" ? JSON.stringify(event.answer.envelope) : undefined;
        const saved = this.options.store.finishNativeScopedRequest(record.id, requestId, "complete", event.kind, event, envelopeJson ? { envelopeJson, digest: hash(envelopeJson) } : undefined);
        if (saved) this.deliver(record, saved);
        record.state = "ready"; this.publish(record, requestId, "state", { state: "ready" });
      } catch (error) {
        let feedback = structuredFailureFeedback(error); let current = true;
        try { record.assertCurrent(); } catch { current = false; }
        const refusal = current && !signal.aborted ? structuredDataRefusal(feedback.code) : undefined;
        if (refusal) { const saved = this.options.store.finishNativeScopedRequest(record.id, requestId, "refusal", "refusal", { id: newId("native-event"), kind: "refusal", ...refusal }); if (saved) this.deliver(record, saved); record.state = "ready"; this.publish(record, requestId, "state", { state: "ready" }); }
        else {
          const saved = this.options.store.finishNativeScopedRequest(record.id, requestId, signal.aborted ? "cancelled" : "interrupted", "error", { code: signal.aborted ? "runtime.cancelled" : feedback.code, message: signal.aborted ? "The response was cancelled. Cleanup is being confirmed." : feedback.message }); if (saved) this.deliver(record, saved);
          if (record.state !== "stopping") interruptAfter = true;
        }
      } finally {
        // route() settles its governed query/provider cleanup before returning or rejecting.
        // Resolve a separate latch before joining interruption; waiting on active.promise
        // here would form a self-deadlock with an external lease-abort settlement.
        rootSettled(); if (record.active === active) record.active = undefined;
        if (interruptAfter) await this.interrupt(record);
        this.armIdle(record);
      }
    })();
    await active.promise;
  }
  private async cancel(record: Record) { if (!record.active || terminal(record.state)) return; record.state = "cancelling"; this.publish(record, record.active.id, "state", { state: "cancelling" }); record.active.controller.abort(); await record.active.promise; }
  private interrupt(record: Record): Promise<void> {
    if (record.interruption) return record.interruption;
    const root = record.active?.settled;
    record.state = "interrupted"; record.active?.controller.abort(); record.controller.abort(); clearTimeout(record.idle);
    this.options.store.transitionNativeSession(record.id, "interrupted", { ended: true, failure: "Scoped execution was interrupted; its sandbox cannot be resumed." });
    return record.interruption = (async () => {
      try {
        await root; await record.lease.close();
        // Only this server-owned session's durable worker/snapshot receipts participate.
        this.options.provisioner.assertSessionCleaned!(record.id);
        this.publish(record, null, "state", { state: "interrupted", cleanup: "confirmed" });
      }
      catch { this.cleanupFailed = true; this.publish(record, null, "state", { state: "interrupted", cleanup: "pending" }); throw new StructuredRuntimeError("cleanup"); }
    })();
  }
  async stop(id: string, capability: string): Promise<boolean> {
    const record = this.records.get(id); if (!record || record.capability !== capability) return false;
    if (terminal(record.state)) { await record.interruption; return true; }
    await (record.closing ??= (async () => { clearTimeout(record.idle); record.state = "stopping"; this.publish(record, null, "state", { state: "stopping" }); record.active?.controller.abort(); await record.active?.promise;
      try { await record.lease.close(); this.options.provisioner.assertSessionCleaned!(record.id); record.controller.abort(); record.state = "stopped"; this.options.store.transitionNativeSession(id, "stopped", { ended: true }); this.publish(record, null, "state", { state: "stopped", cleanup: "confirmed" }); }
      catch { await this.interrupt(record); throw new StructuredRuntimeError("cleanup"); }
    })()); return true;
  }
  revoke(ids: readonly string[]) { for (const id of ids) { const record = this.records.get(id); if (record && !terminal(record.state)) { record.active?.controller.abort(); void this.interrupt(record).catch(() => { this.cleanupFailed = true; }); } } }
  async shutdown() { this.lifetime.abort(); await Promise.allSettled([...this.creations.values()]); await Promise.all([...this.records.values()].map(record => this.stop(record.id, record.capability))); if (this.cleanupFailed) throw new StructuredRuntimeError("cleanup"); }
}
