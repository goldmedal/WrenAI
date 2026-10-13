import { performance } from "node:perf_hooks";
import { types } from "node:util";
import { z } from "zod";
import { structuredDiagnosticStages, type StructuredDiagnosticObserver, type StructuredDiagnosticStage } from "./structured-diagnostics.js";

const milestones = ["wrapper_start", "pin_validation", "cache_setup", "custody_setup", "gateway_setup", "utility_spawn", "utility_initialized", "profile_verification", "worker_observation", "fixture_setup", "http_ask", "adapter_enter", "adapter_prepare", "adapter_run", "sdk_dispatch", "sdk_result", "component_cleanup", "adapter_cleanup", "utility_cleanup", "wrapper_cleanup", "final"] as const;
type Milestone = typeof milestones[number];
export type TimingAbortSource = "adapter_timeout" | "component_timeout" | "scope" | "runtime" | "run" | "cleanup" | "unknown";
export const timingResultCategories = ["success", "error_during_execution", "error_max_turns", "error_max_budget_usd", "error_max_structured_output_retries", "unknown"] as const;
type ResultCategory = typeof timingResultCategories[number];
type Metric = "currentness" | "exact_bytes" | "phase_persistence";
const metricNames: Metric[] = ["currentness", "exact_bytes", "phase_persistence"];
const finite = z.number().finite().nonnegative();
const count = z.number().int().nonnegative().max(1_000_000);
const eventSchema = z.object({ enteredMs: finite.nullable(), completedMs: finite.nullable(), failedMs: finite.nullable(), count }).strict();
const timerSchema = z.object({ registrationStartedMs: finite.nullable(), registeredMs: finite.nullable(), dueEarliestMs: finite.nullable(), dueMs: finite.nullable(), deadlineMs: finite.nullable(), callbackMs: finite.nullable(), clearedMs: finite.nullable() }).strict();
const abortSchema = z.object({ source: z.enum(["adapter_timeout", "component_timeout", "scope", "runtime", "run", "cleanup", "unknown"]), offsetMs: finite }).strict();
const resultSchema = z.object({ category: z.enum(timingResultCategories), isError: z.boolean().nullable(), offsetMs: finite }).strict();
const metricSchema = z.object({ count, inclusiveMs: finite, exclusiveMs: finite, maximumMs: finite }).strict();
const phaseSchema = z.object({ count, failedCount: count, firstEnteredMs: finite.nullable(), lastCompletedMs: finite.nullable(), wallMs: finite, maximumMs: finite }).strict();
const stepSchema = z.object({ ordinal: z.union([z.literal(1), z.literal(2), z.literal(3)]), opened: z.boolean(), timer: timerSchema, firstAbort: abortSchema.nullable(), firstResult: resultSchema.nullable(), cleanup: eventSchema }).strict();
const milestoneShape = () => Object.fromEntries(milestones.map(name => [name, eventSchema])) as Record<Milestone, typeof eventSchema>;
const phaseShape = () => Object.fromEntries(structuredDiagnosticStages.map(name => [name, phaseSchema])) as Record<StructuredDiagnosticStage, typeof phaseSchema>;
export const structuredTimingReceiptSchema = z.object({ version: z.literal(1), role: z.enum(["wrapper", "utility"]), parentLink: z.object({ role: z.literal("wrapper"), boundary: z.literal("utility_spawn"), offsetMs: finite }).strict().nullable(), elapsedMs: finite, invalid: z.boolean(), overflow: z.boolean(), bookkeepingMs: finite, coveredSyncMs: finite, milestones: z.object(milestoneShape()).strict(), metrics: z.object({ currentness: metricSchema, exact_bytes: metricSchema, phase_persistence: metricSchema }).strict(), sessions: z.array(z.object({ session: z.union([z.literal(1), z.literal(2)]), opened: z.boolean(), completed: z.boolean(), milestones: z.object(milestoneShape()).strict(), phases: z.lazy(() => z.object(phaseShape()).strict()), adapterTimer: timerSchema, firstAbort: abortSchema.nullable(), steps: z.array(stepSchema).length(3) }).strict()).length(2) }).strict().refine(value => value.sessions[0]!.session === 1 && value.sessions[1]!.session === 2 && value.sessions.every(s => s.steps.every((step, index) => step.ordinal === index + 1)));
export type StructuredTimingReceipt = z.infer<typeof structuredTimingReceiptSchema>;
const event = () => ({ enteredMs: null, completedMs: null, failedMs: null, count: 0 });
const timer = () => ({ registrationStartedMs: null, registeredMs: null, dueEarliestMs: null, dueMs: null, deadlineMs: null, callbackMs: null, clearedMs: null });
const phase = () => ({ count: 0, failedCount: 0, firstEnteredMs: null, lastCompletedMs: null, wallMs: 0, maximumMs: 0 });
const metric = () => ({ count: 0, inclusiveMs: 0, exclusiveMs: 0, maximumMs: 0 });
const events = () => Object.fromEntries(milestones.map(name => [name, event()])) as StructuredTimingReceipt["milestones"];

/** Reject hostile containers before reflecting on descriptors; no getter or proxy traversal. */
function ownData(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || types.isProxy(value)) return;
  const prototype = Object.getPrototypeOf(value);
  if (types.isProxy(prototype) || (prototype !== null && prototype !== Object.prototype)) return;
  const out: Record<string, unknown> = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") return;
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (!d || !("value" in d) || !d.enumerable || (d.value && typeof d.value === "object" && types.isProxy(d.value))) return;
    Object.defineProperty(out, key, { value: d.value, enumerable: true });
  }
  return out;
}
export function classifyTimingResult(value: unknown): { category: ResultCategory; isError: boolean | null } {
  try {
    const own = ownData(value);
    if (!own || own.type !== "result") return { category: "unknown", isError: null };
    return { category: timingResultCategories.includes(own.subtype as ResultCategory) ? own.subtype as ResultCategory : "unknown", isError: typeof own.is_error === "boolean" ? own.is_error : null };
  } catch { return { category: "unknown", isError: null }; }
}

export interface StructuredTimingRecorder {
  beginSession(session: 1 | 2): void;
  completeSession(): void;
  mark(name: Milestone, state?: "entered" | "completed" | "failed"): void;
  measure<T>(name: Metric, operation: () => T): T;
  snapshot(): Readonly<StructuredTimingReceipt>;
}
export interface StructuredComponentTiming { readonly ordinal: number }
type State = { receipt: StructuredTimingReceipt; now(): number; clock(): number; active: number; depth: number; stack: { child: number }[] };
const recorders = new WeakMap<StructuredTimingRecorder, State>();
const observers = new WeakMap<StructuredDiagnosticObserver, StructuredTimingRecorder>();
const components = new WeakMap<StructuredComponentTiming, { recorder: StructuredTimingRecorder; session: number; ordinal: number }>();
const cap = (state: State, value: number) => { if (value >= 1_000_000) { state.receipt.overflow = true; return value; } return value + 1; };
function inert(recorder: StructuredTimingRecorder | undefined, operation: (state: State) => void, bookkeeping = true): void {
  try { const state = recorder && recorders.get(recorder); if (state) { const start = bookkeeping ? state.now() : 0; try { operation(state); } finally { if (bookkeeping) { const cost = Math.max(0, state.now() - start); state.receipt.bookkeepingMs += cost; const parent = state.stack.at(-1); if (parent) parent.child += cost; } } } } catch { /* Observation cannot change the governed operation. */ }
}
function markState(state: State, name: Milestone, status: "entered" | "completed" | "failed"): void {
  if (typeof name !== "string" || !milestones.includes(name) || !["entered", "completed", "failed"].includes(status)) { state.receipt.invalid = true; return; }
  const rows = [state.receipt.milestones, ...(state.active ? [state.receipt.sessions[state.active - 1]!.milestones] : [])];
  for (const row of rows) { const value = row[name]; if (!value) { state.receipt.invalid = true; return; } const key = `${status}Ms` as "enteredMs" | "completedMs" | "failedMs"; value[key] ??= state.now(); value.count = cap(state, value.count); }
}
export function createStructuredTimingRecorder(options: { role: "wrapper" | "utility"; parentLink?: StructuredTimingReceipt["parentLink"]; clock?: () => number; originMs?: number }): StructuredTimingRecorder {
  const fields = ownData(options);
  if (!fields || Object.keys(fields).some(key => !["role", "parentLink", "clock", "originMs"].includes(key)) || !["wrapper", "utility"].includes(fields.role as string)) throw new TypeError("Invalid timing options");
  let parentLink: StructuredTimingReceipt["parentLink"] = null;
  if (fields.parentLink !== undefined && fields.parentLink !== null) {
    const link = ownData(fields.parentLink);
    if (!link || Object.keys(link).length !== 3 || link.role !== "wrapper" || link.boundary !== "utility_spawn" || typeof link.offsetMs !== "number" || !Number.isFinite(link.offsetMs) || link.offsetMs < 0) throw new TypeError("Invalid timing options");
    parentLink = { role: "wrapper", boundary: "utility_spawn", offsetMs: link.offsetMs };
  }
  if (fields.clock !== undefined && (typeof fields.clock !== "function" || types.isProxy(fields.clock))) throw new TypeError("Invalid timing options");
  const clock = fields.clock as (() => number) | undefined ?? (() => performance.now()); let origin = 0, last = 0, invalidClock = false;
  try { origin = clock(); if (fields.originMs !== undefined) { if (typeof fields.originMs !== "number" || !Number.isFinite(fields.originMs) || fields.originMs < 0 || fields.originMs > origin) throw new TypeError("Invalid timing origin"); origin = fields.originMs; } if (!Number.isFinite(origin) || origin < 0) { invalidClock = true; origin = 0; } } catch { invalidClock = true; }
  const receipt: StructuredTimingReceipt = { version: 1, role: fields.role as "wrapper" | "utility", parentLink, elapsedMs: 0, invalid: invalidClock, overflow: false, bookkeepingMs: 0, coveredSyncMs: 0, milestones: events(), metrics: { currentness: metric(), exact_bytes: metric(), phase_persistence: metric() }, sessions: [1, 2].map(session => ({ session: session as 1 | 2, opened: false, completed: false, milestones: events(), phases: Object.fromEntries(structuredDiagnosticStages.map(stage => [stage, phase()])) as StructuredTimingReceipt["sessions"][number]["phases"], adapterTimer: timer(), firstAbort: null, steps: [1, 2, 3].map(ordinal => ({ ordinal: ordinal as 1 | 2 | 3, opened: false, timer: timer(), firstAbort: null, firstResult: null, cleanup: event() })) })) };
  const state: State = { receipt, clock, active: 0, depth: 0, stack: [], now() { try { const value = clock() - origin; if (!Number.isFinite(value) || value < last) receipt.invalid = true; else last = value; } catch { receipt.invalid = true; } return last; } };
  const recorder: StructuredTimingRecorder = Object.freeze({
    beginSession(session: 1 | 2) { inert(recorder, s => { if (![1, 2].includes(session) || s.receipt.sessions[session - 1]!.opened) { s.receipt.invalid = true; return; } s.active = session; s.receipt.sessions[session - 1]!.opened = true; }); },
    completeSession() { inert(recorder, s => { if (!s.active) { s.receipt.invalid = true; return; } s.receipt.sessions[s.active - 1]!.completed = true; }); },
    mark(name: Milestone, status: "entered" | "completed" | "failed" = "entered") { inert(recorder, s => markState(s, name, status)); },
    measure<T>(name: Metric, operation: () => T): T { return measureStructuredTiming(recorder, name, operation); },
    snapshot() { receipt.elapsedMs = state.now(); return freezeTimingSnapshot(structuredClone(receipt)); },
  });
  recorders.set(recorder, state); return recorder;
}
/** Only a host-created observer owns timing; ordinary observers have no association. */
export function createStructuredTimingObserver(recorder: StructuredTimingRecorder, original?: StructuredDiagnosticObserver): StructuredDiagnosticObserver {
  if (!recorders.has(recorder)) throw new TypeError("Invalid timing recorder");
  const observer: StructuredDiagnosticObserver = function(this: unknown, record) { return original && Reflect.apply(original, this, [record]); };
  observers.set(observer, recorder); return observer;
}
export function structuredTimingForObserver(observer: StructuredDiagnosticObserver | undefined): StructuredTimingRecorder | undefined { return observer && observers.get(observer); }
export function markStructuredTiming(recorder: StructuredTimingRecorder | undefined, name: Milestone, status: "entered" | "completed" | "failed" = "entered"): void { inert(recorder, s => markState(s, name, status)); }
export function measureStructuredTiming<T>(recorder: StructuredTimingRecorder | undefined, name: Metric, operation: () => T): T {
  const state = recorder && recorders.get(recorder); if (!state) return operation();
  let start = 0, entryCost = 0, frame: { child: number } | undefined;
  inert(recorder, s => { const bookkeeping = s.now(); if (!metricNames.includes(name) || s.stack.length >= 64) { s.receipt.overflow = true; return; } frame = { child: 0 }; s.stack.push(frame); s.receipt.metrics[name].count = cap(s, s.receipt.metrics[name].count); start = s.now(); entryCost = Math.max(0, start - bookkeeping); s.receipt.bookkeepingMs += entryCost; }, false);
  try { return operation(); } finally { inert(recorder, s => { if (!frame) return; const end = s.now(), duration = Math.max(0, end - start), m = s.receipt.metrics[name]; if (s.stack.pop() !== frame) s.receipt.invalid = true; m.inclusiveMs += duration; m.exclusiveMs += Math.max(0, duration - frame.child); m.maximumMs = Math.max(m.maximumMs, duration); const parent = s.stack.at(-1); const exitCost = Math.max(0, s.now() - end); if (parent) parent.child += duration + entryCost + exitCost; else s.receipt.coveredSyncMs += duration + entryCost + exitCost; s.receipt.bookkeepingMs += exitCost; }, false); }
}
export function beginStructuredTimingPhase(observer: StructuredDiagnosticObserver | undefined, stage: StructuredDiagnosticStage): ((failed?: boolean) => void) | undefined {
  const recorder = structuredTimingForObserver(observer), state = recorder && recorders.get(recorder); if (!state || !state.active) return;
  const session = state.active, start = state.now(); let ended = false;
  inert(recorder, s => { const p = s.receipt.sessions[session - 1]!.phases[stage]; p.count = cap(s, p.count); p.firstEnteredMs ??= start; if (stage === "adapter_cleanup") markState(s, "adapter_cleanup", "entered"); });
  return (failed = false) => { inert(recorder, s => { if (ended) return; ended = true; const p = s.receipt.sessions[session - 1]!.phases[stage], end = s.now(), duration = Math.max(0, end - start); p.lastCompletedMs = end; if (failed) p.failedCount = cap(s, p.failedCount); p.wallMs += duration; p.maximumMs = Math.max(p.maximumMs, duration); if (stage === "adapter_cleanup") markState(s, "adapter_cleanup", failed ? "failed" : "completed"); }); };
}
export function recordStructuredTimingTimer(recorder: StructuredTimingRecorder | undefined, state: "registering" | "registered" | "callback" | "cleared", deadline?: number): void { inert(recorder, s => { if (!s.active) return; updateTimer(s, s.receipt.sessions[s.active - 1]!.adapterTimer, state, deadline); }); }
function updateTimer(state: State, value: StructuredTimingReceipt["sessions"][number]["adapterTimer"], event: "registering" | "registered" | "callback" | "cleared", deadline?: number): void {
  if (!["registering", "registered", "callback", "cleared"].includes(event)) { state.receipt.invalid = true; return; }
  const time = state.now(); if (event === "registering") { if (value.registrationStartedMs !== null || !Number.isFinite(deadline) || deadline! < 0) { state.receipt.invalid = true; return; } value.registrationStartedMs = time; value.dueEarliestMs = time + deadline!; return; } if (event === "registered") { if (value.registeredMs !== null || !Number.isFinite(deadline) || deadline! < 0) { state.receipt.invalid = true; return; } value.registeredMs = time; value.deadlineMs = deadline!; value.dueMs = time + deadline!; } else if (event === "callback") value.callbackMs ??= time; else value.clearedMs ??= time;
}
function safeAbortSource(state: State, source: TimingAbortSource): TimingAbortSource { if (!["adapter_timeout", "component_timeout", "scope", "runtime", "run", "cleanup", "unknown"].includes(source)) { state.receipt.invalid = true; return "unknown"; } return source; }
export function recordStructuredTimingAbort(recorder: StructuredTimingRecorder | undefined, source: TimingAbortSource): void { inert(recorder, s => { if (s.active) s.receipt.sessions[s.active - 1]!.firstAbort ??= { source: safeAbortSource(s, source), offsetMs: s.now() }; }); }
export function createStructuredComponentTiming(recorder: StructuredTimingRecorder | undefined): StructuredComponentTiming | undefined {
  const state = recorder && recorders.get(recorder); if (!state || !state.active) return;
  const steps = state.receipt.sessions[state.active - 1]!.steps, step = steps.find(s => !s.opened); if (!step) { state.receipt.overflow = true; return; }
  step.opened = true; const context = Object.freeze({ ordinal: step.ordinal }); components.set(context, { recorder: recorder!, session: state.active, ordinal: step.ordinal }); return context;
}
function component(context: StructuredComponentTiming | undefined, operation: (state: State, step: StructuredTimingReceipt["sessions"][number]["steps"][number]) => void): void { const data = context && components.get(context); if (data) inert(data.recorder, s => operation(s, s.receipt.sessions[data.session - 1]!.steps[data.ordinal - 1]!)); }
export function recordComponentTimingTimer(context: StructuredComponentTiming | undefined, event: "registering" | "registered" | "callback" | "cleared", deadline?: number): void { component(context, (s, step) => updateTimer(s, step.timer, event, deadline)); }
export function recordComponentTimingAbort(context: StructuredComponentTiming | undefined, source: TimingAbortSource): void { component(context, (s, step) => { step.firstAbort ??= { source: safeAbortSource(s, source), offsetMs: s.now() }; if (s.active) s.receipt.sessions[s.active - 1]!.firstAbort ??= step.firstAbort; }); }
export function markComponentTiming(context: StructuredComponentTiming | undefined, name: "sdk_dispatch" | "sdk_result" | "component_cleanup", status: "entered" | "completed" | "failed" = "entered"): void { component(context, (s, step) => { markState(s, name, status); if (!["entered", "completed", "failed"].includes(status)) return; if (name === "component_cleanup") { step.cleanup[`${status}Ms` as "enteredMs" | "completedMs" | "failedMs"] ??= s.now(); step.cleanup.count = cap(s, step.cleanup.count); } }); }
export function recordAdmittedTimingResult(context: StructuredComponentTiming | undefined, value: unknown): void {
  if (!context || !components.has(context)) return;
  let own: Record<string, unknown> | undefined; try { own = ownData(value); } catch { return; }
  if (!own || own.type !== "result") return;
  component(context, (s, step) => { step.firstResult ??= { ...classifyTimingResult(value), offsetMs: s.now() }; markState(s, "sdk_result", "entered"); }); }

function freezeTimingSnapshot<T>(value: T): T {
  if (value && typeof value === "object") { for (const child of Object.values(value)) freezeTimingSnapshot(child); Object.freeze(value); } return value;
}
/** The evidence parser clones descriptors before schema validation, never untrusted getters. */
export function readStructuredTimingReceipt(value: unknown): Readonly<StructuredTimingReceipt> {
  let visited = 0;
  const clone = (input: unknown, depth: number): unknown => {
    if (++visited > 8192 || depth > 16) throw new TypeError("Invalid timing receipt");
    if (!input || typeof input !== "object") { if (!["string", "number", "boolean"].includes(typeof input) && input !== null) throw new TypeError("Invalid timing receipt"); return input; }
    if (types.isProxy(input)) throw new TypeError("Invalid timing receipt");
    const prototype = Object.getPrototypeOf(input); if (types.isProxy(prototype)) throw new TypeError("Invalid timing receipt");
    const array = Array.isArray(input); if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) throw new TypeError("Invalid timing receipt");
    const out: Record<string, unknown> | unknown[] = array ? [] : Object.create(null);
    for (const key of Reflect.ownKeys(input)) {
      if (array && key === "length") continue;
      if (typeof key !== "string") throw new TypeError("Invalid timing receipt");
      const d = Object.getOwnPropertyDescriptor(input, key); if (!d || !("value" in d) || !d.enumerable) throw new TypeError("Invalid timing receipt");
      Object.defineProperty(out, key, { value: clone(d.value, depth + 1), enumerable: true, configurable: true });
    }
    return out;
  };
  const parsed = structuredTimingReceiptSchema.parse(clone(value, 0));
  if (parsed.invalid || parsed.overflow) throw new TypeError("Incomplete timing receipt");
  return freezeTimingSnapshot(parsed);
}
