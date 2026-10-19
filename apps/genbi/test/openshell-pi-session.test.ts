import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "../server/db.js";
import { OpenShellLifecycle } from "../server/runtime-host/openshell-lifecycle.js";
import { OPENSHELL_SESSION_ARGV, claimOpenShellSessionStep, launchOpenShellModelSession } from "../server/runtime-host/openshell-model-session.js";
import { openShellIdentitySchema, type OpenShellDriver, type OpenShellIdentity, type OpenShellResource } from "../server/runtime-host/openshell-types.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
const digest = "sha256:" + "a".repeat(64);
type Control = "baseline" | "check" | "cleanup";
interface Faults { baseline?: boolean; check?: boolean; cleanup?: "throw" | "foreign-step" | "remaining" | "other-pid" }
/** The driver fake records the exact argv every control and step call used, so the vendor table is observed rather than assumed. */
async function fixture(vendor: "claude" | "pi" | undefined, faults: Faults = {}) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "pi-session-"));
  const store = new Store(":memory:"); const resources = new Map<string, OpenShellResource>();
  const execs: string[][] = [], duplexes: string[][] = [], controls: Control[] = [];
  const tuple = { image: digest, policy: digest, gateway: "synthetic", workspace: "default", configuration: digest };
  const identity = openShellIdentitySchema.parse({ ...tuple, backend: "openshell", account: digest, generation: "1", session: "session", binding: "project", bindingGeneration: "1", bindingRevision: digest, context: digest, plan: digest, purpose: "model_session", operation: "session", snapshot: "none" }) as Extract<OpenShellIdentity, { purpose: "model_session" }>;
  const driver: OpenShellDriver = { version: "synthetic", identity: tuple, modelIdentity: tuple, probe: async () => {},
    create: async intent => { const row = { id: intent.id, name: intent.name, workspace: "default", labels: { "genbi-lifecycle-owner": intent.owner } }; resources.set(intent.name, row); return row; },
    list: async intent => [...resources.values()].filter(row => row.name === intent.name), inspect: async intent => resources.get(intent.name)!,
    remove: async intent => { resources.delete(intent.name); }, assertAbsent: async intent => { expect(resources.has(intent.name)).toBe(false); },
    duplex: async (_intent, argv) => { duplexes.push([...argv]); return { output: (async function* () {})(), done: Promise.resolve(0), write() {}, close() {} }; },
    exec: async (_intent, argv) => {
      execs.push([...argv]);
      if (argv[2] === "--baseline") { controls.push("baseline"); if (faults.baseline) throw Error("synthetic baseline failure"); return JSON.stringify({ type: "genbi.session.baseline", version: 1, processes: [] }); }
      if (argv[2] === "--check") { controls.push("check"); if (faults.check) throw Error("synthetic residue"); return JSON.stringify({ type: "genbi.session.checked", version: 1, remaining: 0 }); }
      controls.push("cleanup"); if (faults.cleanup === "throw") throw Error("synthetic uncertain cleanup");
      const { receipt } = JSON.parse(argv[2]!);
      return JSON.stringify({ ...receipt, type: "genbi.step.cleaned", remaining: faults.cleanup === "remaining" ? 1 : 0, ...(faults.cleanup === "foreign-step" ? { step: randomUUID() } : {}), ...(faults.cleanup === "other-pid" ? { pid: receipt.pid + 1, group: receipt.group + 1 } : {}) });
    },
  };
  const lifecycle = new OpenShellLifecycle({ driver, journal: store, stateRoot: directory, exclusive: true }); await lifecycle.initialize();
  cleanup.push(async () => { await lifecycle.shutdown(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  const permit = await lifecycle.prepareLaunch(identity, () => identity);
  const launched = vendor ? launchOpenShellModelSession(lifecycle, permit, identity, vendor) : launchOpenShellModelSession(lifecycle, permit, identity);
  const session = await launched.catch((error: unknown) => error as Error);
  const step = () => openShellIdentitySchema.parse({ ...identity, purpose: "model", operation: "step", turn: randomUUID(), invocation: randomUUID(), step: randomUUID(), attempt: 1, model: "synthetic", tier: "cheap" }) as Extract<OpenShellIdentity, { purpose: "model" }>;
  const receipt = (id: string, extra: object = {}) => ({ type: "genbi.step", version: 1, step: id, pid: 200, group: 200, start: "1000", ...extra });
  return { session: session as Exclude<typeof session, Error>, failure: session instanceof Error ? session : undefined, step, receipt, execs, duplexes, controls, resources, store, lifecycle };
}
const piControl = ["/usr/local/bin/node", "/opt/genbi/pi-step-control.mjs"], claudeControl = ["/usr/local/bin/node", "/opt/genbi/claude-step-control.mjs"];
const piStep = ["/usr/local/bin/node", "/opt/genbi/pi-session-step.mjs"], claudeStep = ["/usr/local/bin/node", "/opt/genbi/claude-session-step.mjs"];

describe("the model-session vendor table", () => {
  it("holds exactly two frozen vendors with fixed host constants", () => {
    expect(Object.keys(OPENSHELL_SESSION_ARGV)).toEqual(["claude", "pi"]);
    expect(OPENSHELL_SESSION_ARGV.claude).toEqual({ step: claudeStep, control: claudeControl }); expect(OPENSHELL_SESSION_ARGV.pi).toEqual({ step: piStep, control: piControl });
    expect(Object.isFrozen(OPENSHELL_SESSION_ARGV)).toBe(true); expect(Object.isFrozen(OPENSHELL_SESSION_ARGV.pi)).toBe(true); expect(Object.isFrozen(OPENSHELL_SESSION_ARGV.pi.step)).toBe(true);
  });
  it("defaults to Claude's entrypoints, so the existing launch call is unchanged", async () => {
    const f = await fixture(undefined); const id = f.step(), claim = claimOpenShellSessionStep(f.session, id); await claim.duplex(); claim.admitPrelude(f.receipt(id.step)); await claim.close();
    expect(f.execs.map(argv => argv.slice(0, 2))).toEqual([claudeControl, claudeControl, claudeControl]); expect(f.duplexes).toEqual([claudeStep]);
  });
  it("runs baseline, check, the step and cleanup through the pi pair for a pi session, and never through Claude's", async () => {
    const f = await fixture("pi"); expect(f.controls).toEqual(["baseline"]);
    for (let i = 0; i < 2; i++) { const id = f.step(), claim = claimOpenShellSessionStep(f.session, id); await claim.duplex(); claim.admitPrelude(f.receipt(id.step)); await claim.close(); f.session.assertActive(); }
    expect(f.controls).toEqual(["baseline", "check", "cleanup", "check", "cleanup"]);
    for (const argv of f.execs) expect(argv.slice(0, 2)).toEqual(piControl); expect(f.duplexes).toEqual([piStep, piStep]);
    expect(JSON.stringify([...f.execs, ...f.duplexes])).not.toContain("claude");
    expect(f.resources.size).toBe(1);
  });
  it("refuses an unknown vendor before any sandbox exists", async () => {
    const f = await fixture("codex" as never); expect(f.failure).toBeDefined(); expect(f.resources.size).toBe(0); expect(f.store.listOpenShellIntents()).toHaveLength(0);
  });
});

describe("a pi session step: receipt, baseline, check and cleanup are required before the sandbox is reused", () => {
  it("destroys the sandbox when the baseline cannot be taken, and the session never exists", async () => {
    const f = await fixture("pi", { baseline: true }); expect(f.failure).toBeDefined(); expect(f.resources.size).toBe(0); expect(f.store.listOpenShellIntents().every(row => row.phase === "cleaned")).toBe(true);
  });
  it("destroys the sandbox when the check before a step finds a process, fences the session and blocks the next claim", async () => {
    const f = await fixture("pi", { check: true }); const claim = claimOpenShellSessionStep(f.session, f.step());
    await expect(claim.duplex()).rejects.toThrow(); expect(f.duplexes).toHaveLength(0); expect(() => f.session.assertActive()).toThrow(); expect(() => claimOpenShellSessionStep(f.session, f.step())).toThrow();
    expect(f.resources.size).toBe(0); expect(f.store.listOpenShellIntents()[0]?.phase).toBe("cleaned");
  });
  it.each(["throw", "foreign-step", "remaining", "other-pid"] as const)("treats %s cleanup as unknown: pending, session fenced, whole sandbox torn down, no reuse", async mode => {
    const f = await fixture("pi", { cleanup: mode }); const id = f.step(), claim = claimOpenShellSessionStep(f.session, id); await claim.duplex(); claim.admitPrelude(f.receipt(id.step));
    await expect(claim.close()).rejects.toMatchObject({ code: "openshell_cleanup_pending" });
    expect(() => f.session.assertActive()).toThrow(); expect(() => claimOpenShellSessionStep(f.session, f.step())).toThrow(); expect(f.resources.size).toBe(0);
  });
  it("treats a step with no receipt as unknown and destroys the sandbox instead of reusing it", async () => {
    const f = await fixture("pi"); const claim = claimOpenShellSessionStep(f.session, f.step()); await claim.duplex();
    await expect(claim.close()).rejects.toMatchObject({ code: "openshell_cleanup_pending" }); expect(f.controls.includes("cleanup")).toBe(false); expect(() => f.session.assertActive()).toThrow(); expect(f.resources.size).toBe(0);
  });
  it.each([
    ["another step's id", () => ({ step: randomUUID() })],
    ["a pid that is not its own group", () => ({ pid: 200, group: 201 })], ["a non-numeric start", () => ({ start: "soon" })], ["an extra key", () => ({ extra: 1 })],
  ])("refuses a receipt naming %s", async (_name, patch) => {
    const f = await fixture("pi"); const id = f.step(), claim = claimOpenShellSessionStep(f.session, id); await claim.duplex();
    expect(() => claim.admitPrelude(f.receipt(id.step, patch()))).toThrow();
  });
  it("accepts one receipt per step and refuses a second", async () => {
    const f = await fixture("pi"); const id = f.step(), claim = claimOpenShellSessionStep(f.session, id); await claim.duplex(); claim.admitPrelude(f.receipt(id.step)); expect(() => claim.admitPrelude(f.receipt(id.step))).toThrow();
  });
  it("allows one step at a time and refuses a claim from another session's identity", async () => {
    const f = await fixture("pi"); const first = claimOpenShellSessionStep(f.session, f.step()); expect(() => claimOpenShellSessionStep(f.session, f.step())).toThrow();
    const other = f.step(); expect(() => claimOpenShellSessionStep(f.session, { ...other, session: "another-session" })).toThrow(); await first.duplex().catch(() => {});
  });
});
