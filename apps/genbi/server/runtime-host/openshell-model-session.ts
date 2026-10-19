import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { OpenShellError, type OpenShellIdentity } from "./openshell-types.js";
import type { OpenShellLifecycle, OpenShellPermit, OpenShellLease } from "./openshell-lifecycle.js";

type Identity = Extract<OpenShellIdentity, { purpose: "model_session" }>;
type Step = Extract<OpenShellIdentity, { purpose: "model" }>;
const receiptSchema = z.object({ type: z.literal("genbi.step"), version: z.literal(1), step: z.uuid(), pid: z.number().int().min(2), group: z.number().int().min(2), start: z.string().regex(/^\d+$/) }).strict().refine(value => value.pid === value.group);
const baselineSchema = z.object({ type: z.literal("genbi.session.baseline"), version: z.literal(1), processes: z.array(z.object({ pid: z.number().int().min(1), start: z.string().regex(/^\d+$/) }).strict()).max(256) }).strict().refine(value => new Set(value.processes.map(row => row.pid)).size === value.processes.length);
type Baseline = z.infer<typeof baselineSchema>;
type Receipt = z.infer<typeof receiptSchema>;
/** Opaque host-owned capability. Structural copies do not inherit sandbox authority. */
export interface OpenShellModelSession { readonly id: string; readonly signal: AbortSignal; assertActive(): void; close(): Promise<void> }
const NODE = "/usr/local/bin/node";
/** Host constants only: which fixed in-sandbox entrypoints serve a session of each vendor. Never derived from a request, a descriptor or a sandbox reply. */
export const OPENSHELL_SESSION_ARGV = Object.freeze({
  claude: Object.freeze({ step: Object.freeze([NODE, "/opt/genbi/claude-session-step.mjs"] as const), control: Object.freeze([NODE, "/opt/genbi/claude-step-control.mjs"] as const) }),
  pi: Object.freeze({ step: Object.freeze([NODE, "/opt/genbi/pi-session-step.mjs"] as const), control: Object.freeze([NODE, "/opt/genbi/pi-step-control.mjs"] as const) }),
});
export type OpenShellSessionVendor = keyof typeof OPENSHELL_SESSION_ARGV;
const sessions = new WeakMap<OpenShellModelSession, { identity: Identity; lease: OpenShellLease; baseline: Baseline; failed: boolean; active: Set<string>; vendor: OpenShellSessionVendor }>();
const sessionFields = ["backend", "account", "generation", "session", "binding", "bindingGeneration", "bindingRevision", "context", "plan", "image", "policy", "gateway", "workspace", "configuration"] as const;

/** A one-shot launch permit becomes an actual owned lease, never a renewable admission grant. */
export async function launchOpenShellModelSession(lifecycle: OpenShellLifecycle, permit: OpenShellPermit, identity: Identity, vendor: OpenShellSessionVendor = "claude"): Promise<OpenShellModelSession> {
  if (!Object.hasOwn(OPENSHELL_SESSION_ARGV, vendor)) throw new OpenShellError("openshell_scope_invalid");
  const argv = OPENSHELL_SESSION_ARGV[vendor];
  lifecycle.assertLaunchPermit(permit);
  let lease: OpenShellLease;
  try { lease = await lifecycle.launch(permit, identity); } catch (error) { permit.release(); throw error; }
  let baseline: Baseline;
  try { baseline = baselineSchema.parse(JSON.parse(await lease.exec([...argv.control, "--baseline"]))); lease.assertActive(); }
  catch (error) { await lease.close(); throw error; }
  const state = { baseline, identity: Object.freeze(structuredClone(identity)), lease, failed: false, active: new Set<string>(), vendor };
  let closing: Promise<void> | undefined;
  const capability: OpenShellModelSession = Object.freeze({ id: lease.id, signal: lease.signal,
    assertActive() { if (state.failed || closing) throw new OpenShellError("openshell_scope_invalid"); lease.assertActive(); },
    close() { return closing ??= lease.close(); },
  });
  sessions.set(capability, state); return capability;
}

/** Fresh step identity within the captured session sandbox; not a provider conversation resume. */
export function claimOpenShellSessionStep(capability: OpenShellModelSession, identity: Step) {
  const state = sessions.get(capability);
  if (!state || !sessionFields.every(key => isDeepStrictEqual(identity[key], state.identity[key])) || state.active.size) throw new OpenShellError("openshell_scope_invalid");
  capability.assertActive(); state.active.add(identity.step);
  const argv = OPENSHELL_SESSION_ARGV[state.vendor];
  let receipt: Receipt | undefined; let closing: Promise<void> | undefined; let started = false;
  const check = () => { capability.assertActive(); if (closing) throw new OpenShellError("openshell_scope_invalid"); };
  return Object.freeze({
    signal: state.lease.signal, assertActive: check,
    duplex() { check(); if (started) throw new OpenShellError("openshell_scope_invalid"); started = true; return (async () => {
      try {
        const checked = JSON.parse(await state.lease.exec([...argv.control, "--check", JSON.stringify(state.baseline)]));
        z.object({ type: z.literal("genbi.session.checked"), version: z.literal(1), remaining: z.literal(0) }).strict().parse(checked);
        check(); return await state.lease.duplex([...argv.step]);
      } catch (error) { state.failed = true; await state.lease.close(); throw error; }
    })(); },
    admitPrelude(value: unknown) { check(); if (receipt) throw new OpenShellError("openshell_scope_invalid"); const parsed = receiptSchema.parse(value); if (parsed.step !== identity.step) throw new OpenShellError("openshell_scope_invalid"); receipt = Object.freeze(parsed); },
    close() { return closing ??= (async () => {
      try {
        capability.assertActive(); if (!receipt) throw new OpenShellError("openshell_cleanup_pending");
        const result = await state.lease.exec([...argv.control, JSON.stringify({ receipt, baseline: state.baseline })]);
        const parsed = z.object({ ...receiptSchema.shape, type: z.literal("genbi.step.cleaned"), remaining: z.literal(0) }).strict().parse(JSON.parse(result));
        if (!isDeepStrictEqual({ ...parsed, type: "genbi.step", remaining: undefined }, { ...receipt, remaining: undefined })) throw new OpenShellError("openshell_cleanup_pending");
        capability.assertActive();
      } catch {
        state.failed = true;
        await state.lease.close();
        throw new OpenShellError("openshell_cleanup_pending");
      } finally { state.active.delete(identity.step); }
    })(); },
  });
}
