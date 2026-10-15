import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "../server/db.js";
import { OpenShellLifecycle } from "../server/runtime-host/openshell-lifecycle.js";
import { launchOpenShellModelSession, claimOpenShellSessionStep } from "../server/runtime-host/openshell-model-session.js";
import { openShellIdentitySchema, type OpenShellDriver, type OpenShellIdentity, type OpenShellResource } from "../server/runtime-host/openshell-types.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
const digest = "sha256:" + "a".repeat(64);
async function fixture(failed = false) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "model-session-"));
  const store = new Store(":memory:"); const resources = new Map<string, OpenShellResource>(); let launches = 0, processes = 0, closes = 0;
  const tuple = { image: digest, policy: digest, gateway: "synthetic", workspace: "default", configuration: digest };
  const identity = openShellIdentitySchema.parse({ ...tuple, backend: "openshell", account: digest, generation: "1", session: "session", binding: "project", bindingGeneration: "1", bindingRevision: digest, context: digest, plan: digest, purpose: "model_session", operation: "session", snapshot: "none" }) as Extract<OpenShellIdentity, { purpose: "model_session" }>;
  const driver: OpenShellDriver = { version: "synthetic", identity: tuple, modelIdentity: tuple, probe: async () => {},
    create: async intent => { launches++; const row = { id: intent.id, name: intent.name, workspace: "default", labels: { "genbi-lifecycle-owner": intent.owner } }; resources.set(intent.name, row); return row; },
    list: async intent => [...resources.values()].filter(row => row.name === intent.name), inspect: async intent => resources.get(intent.name)!,
    remove: async intent => { closes++; resources.delete(intent.name); }, assertAbsent: async intent => { expect(resources.has(intent.name)).toBe(false); },
    duplex: async () => { processes++; return { output: (async function* () {})(), done: Promise.resolve(0), write() {}, close() {} }; },
    exec: async (_intent, argv) => { if (argv[2] === "--baseline") return JSON.stringify({ type: "genbi.session.baseline", version: 1, processes: [] }); if (argv[2] === "--check") return JSON.stringify({ type: "genbi.session.checked", version: 1, remaining: 0 }); if (failed) throw Error("synthetic uncertain cleanup"); const { receipt } = JSON.parse(argv[2]!); return JSON.stringify({ ...receipt, type: "genbi.step.cleaned", remaining: 0 }); },
  };
  const lifecycle = new OpenShellLifecycle({ driver, journal: store, stateRoot: directory, exclusive: true }); await lifecycle.initialize();
  cleanup.push(async () => { await lifecycle.shutdown(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  const permit = await lifecycle.prepareLaunch(identity, () => identity);
  const session = await launchOpenShellModelSession(lifecycle, permit, identity);
  const step = (patch: object = {}) => openShellIdentitySchema.parse({ ...identity, purpose: "model", operation: "step", turn: randomUUID(), invocation: randomUUID(), step: randomUUID(), attempt: 1, model: "synthetic", tier: "cheap", ...patch }) as Extract<OpenShellIdentity, { purpose: "model" }>;
  const receipt = (step: string) => ({ type: "genbi.step", version: 1, step, pid: 200, group: 200, start: "1000" });
  return { identity, step, session, receipt, lifecycle, permit, store, resources, count: () => ({ launches, processes, closes }) };
}
describe("owned model session", () => {
  it("has session authority without an invented turn and consumes the permit", async () => {
    const f = await fixture(); expect(f.identity).not.toHaveProperty("turn"); expect(() => openShellIdentitySchema.parse({ ...f.identity, turn: "invented" })).toThrow();
    await expect(f.lifecycle.launch(f.permit)).rejects.toThrow(); expect(f.count().launches).toBe(1);
  });
  it("allows a second fresh process only after exact first cleanup in the same lease", async () => {
    const f = await fixture(); const original = f.session.id;
    for (let i = 0; i < 2; i++) { const id = f.step(), claim = claimOpenShellSessionStep(f.session, id); await claim.duplex(); expect(() => claim.duplex()).toThrow(); expect(() => claimOpenShellSessionStep(f.session, f.step())).toThrow(); claim.admitPrelude(f.receipt(id.step)); await claim.close(); await claim.close(); f.session.assertActive(); }
    expect(f.session.id).toBe(original); expect(f.count()).toEqual({ launches: 1, processes: 2, closes: 0 });
  });
  it.each(["session", "account", "generation", "binding", "bindingGeneration", "bindingRevision", "context", "plan", "image", "policy", "configuration"])("rejects %s substitution before a process", async key => {
    const f = await fixture(); const value = ["account", "bindingRevision", "context", "plan", "image", "policy", "configuration"].includes(key) ? "sha256:" + "b".repeat(64) : "other";
    expect(() => claimOpenShellSessionStep(f.session, f.step({ [key]: value }))).toThrow(); expect(f.count().processes).toBe(0);
  });
  it("does not grant authority to a structural capability copy", async () => { const f = await fixture(); expect(() => claimOpenShellSessionStep({ ...f.session }, f.step())).toThrow(); });
  it.each(["missing", "uncertain"])("whole-sandbox teardown fences future steps on %s cleanup", async mode => {
    const f = await fixture(mode === "uncertain"), id = f.step(), claim = claimOpenShellSessionStep(f.session, id); await claim.duplex(); if (mode === "uncertain") claim.admitPrelude(f.receipt(id.step));
    await expect(claim.close()).rejects.toThrow(); expect(() => f.session.assertActive()).toThrow(); expect(() => claimOpenShellSessionStep(f.session, f.step())).toThrow(); expect(f.resources.size).toBe(0); expect(f.store.listOpenShellIntents()[0]?.phase).toBe("cleaned");
  });
});
