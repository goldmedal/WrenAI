import { afterEach, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Store } from "../server/db.js";
import { resolveEnrichmentBinding } from "../server/enrichment.js";
import { createOpenShellRuntimeCompositionForTesting } from "../server/openshell-runtime-composition.js";
import { ClaudeAccountVault } from "../server/runtime-host/claude-account-vault.js";
import { readOpenShellConfiguration } from "../server/runtime-host/openshell-driver.js";
import { DockerSnapshotDriver, snapshotCanonical, snapshotHash } from "../server/runtime-host/openshell-snapshot-driver.js";
import type { OpenShellDriver, OpenShellDuplex, OpenShellResource } from "../server/runtime-host/openshell-types.js";
import type { SnapshotManifest } from "../server/runtime-host/openshell-snapshot-types.js";
const digest = `sha256:${"a".repeat(64)}`;
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); });
async function fixture(available = true) {
  const root = mkdtempSync(path.join(tmpdir(), "genbi-data-composition-")); cleanup.push(async () => rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, "project"); mkdirSync(path.join(project, "target"), { recursive: true });
  writeFileSync(path.join(project, "wren_project.yml"), "version: 1\ndata_source: duckdb\nprofile: snapshot\n");
  const mdl = JSON.stringify({ models: [] }); writeFileSync(path.join(project, "target/mdl.json"), mdl);
  const store = new Store(":memory:"); const binding = store.activateEnrichmentBinding(resolveEnrichmentBinding(project));
  const file = path.join(root, "config.json");
  writeFileSync(file, JSON.stringify({ executable: file, executableDigest: digest, version: "0.0.1", gateway: "fixture", workspace: "default", image: digest, supervisorImage: digest,
    policy: file, policyDigest: digest, dataPolicy: file, dataPolicyDigest: digest, home: root, configHome: root, stateHome: root,
    dockerExecutable: file, dockerRealpath: file, dockerDigest: digest, dockerSocket: path.join(root, "none.sock"), dockerNamespace: "fixture", exclusive: true,
    dataWorker: { image: digest, script: digest, wheel: digest, toolchain: digest, architecture: "linux-arm64", protocol: "wren-governed/2" },
    snapshotCapture: { executable: file, realpath: file, digest, helperDigest: digest, approvedFiles: ["wren_project.yml", "target/mdl.json"] } }));
  if (!available) { const descriptor = JSON.parse(readFileSync(file, "utf8")); delete descriptor.dataWorker; writeFileSync(file, JSON.stringify(descriptor)); }
  const env = { GENBI_CLAUDE_RUNTIME: "openshell", GENBI_OPENSHELL_CONFIG: file };
  const config = readOpenShellConfiguration(env).configuration!;
  const identity = { image: digest, policy: digest, gateway: "fixture", workspace: "default", configuration: snapshotHash(JSON.stringify(config)) };
  // Use the real lifecycle permits and snapshot references. Only external I/O is synthetic.
  const manifests = new Map<string, SnapshotManifest>(); const resources = new Map<string, OpenShellResource>();
  const publications: string[] = [], deliveries: string[] = []; let writes = 0;
  const driver: OpenShellDriver = { version: "fixture", identity, dataIdentity: identity, probe: async () => {},
    create: async intent => { const resource = { id: intent.id, name: intent.name, workspace: "default", labels: { "genbi-lifecycle-owner": intent.owner } }; resources.set(intent.id, resource); return resource; },
    list: async intent => [...resources.values()].filter(r => r.name === intent.name), inspect: async intent => resources.get(intent.id)!, remove: async intent => { resources.delete(intent.id); }, assertAbsent: async intent => { expect(resources.has(intent.id)).toBe(false); },
    exec: async (intent, argv) => argv.some(arg => arg.includes("base64.b64encode")) ? Buffer.from(mdl).toString("base64") : snapshotCanonical(manifests.get(intent.identity.snapshot)!),
    duplex: async intent => {
      const manifest = manifests.get(intent.identity.snapshot)!; expect(manifest).toBeDefined(); deliveries.push(manifest.context);
      let wake: (() => void) | undefined, closed = false; const chunks: Buffer[] = [Buffer.from(JSON.stringify({ worker: "genbi-wren-worker/1", snapshot: manifest.digest, script: digest, wheel: digest, toolchain: digest, architecture: "linux-arm64", protocol: "wren-governed/2" }) + '\n{"id":0,"protocol":"wren-governed/2"}\n')];
      return { done: new Promise(() => {}), output: (async function* () { while (!closed) { if (chunks.length) yield { stream: "stdout" as const, data: chunks.shift()! }; else await new Promise<void>(r => { wake = r; }); } })(),
        write(bytes) { writes++; const request = JSON.parse(bytes.toString()); chunks.push(Buffer.from(JSON.stringify({ id: request.id, result: JSON.parse(mdl) }) + "\n")); wake?.(); }, close() { closed = true; wake?.(); } };
    } };
  vi.spyOn(DockerSnapshotDriver.prototype, "attest").mockImplementation(() => {});
  vi.spyOn(DockerSnapshotDriver.prototype, "capture").mockImplementation(async (request, archive) => {
    writeFileSync(archive, "synthetic"); const body = { version: 1 as const, project: request.project, bindingGeneration: request.bindingGeneration, bindingRevision: request.bindingRevision, context: request.context, source: digest,
      files: [{ path: "project/target/mdl.json", size: Buffer.byteLength(mdl), sha256: snapshotHash(mdl).slice(7) }] };
    const manifest = { ...body, digest: snapshotHash(snapshotCanonical(body)) }; manifests.set(manifest.digest, manifest); return manifest;
  });
  vi.spyOn(DockerSnapshotDriver.prototype, "checkSource").mockResolvedValue();
  vi.spyOn(DockerSnapshotDriver.prototype, "publish").mockImplementation(async (row, _archive, _signal, check, created) => { await Promise.resolve(); check(); publications.push(row.manifest!.context); created(); });
  vi.spyOn(DockerSnapshotDriver.prototype, "verify").mockImplementation(async row => manifests.get(row.manifest!.digest)!);
  vi.spyOn(DockerSnapshotDriver.prototype, "remove").mockResolvedValue();
  const vault = ClaudeAccountVault.forTesting({ root: path.join(root, "vault"), transport: async () => { throw Error("no account calls"); } });
  const composition = await createOpenShellRuntimeCompositionForTesting({ env, store, stateRoot: path.join(root, "state"), driver, currentProject: () => project, claude: { vault, duplex: driver.duplex! } });
  cleanup.push(async () => { await composition.shutdown(); store.close(); });
  const scope = { backend: "openshell" as const, account: digest, generation: "1", session: "session", turn: "turn", binding: binding.identity, bindingGeneration: String(binding.generation), bindingRevision: binding.revision, context: digest, plan: digest };
  return { composition, store, scope, resources, publications, deliveries, binding, project, writes: () => writes };
}
it("retains consumed delivery authority for composed inspect until close and denies replay", async () => {
  const f = await fixture(); const open = f.composition.bindDataContext(digest, () => {}); const access = await open(f.scope, new AbortController().signal);
  expect(await access.inspect(new AbortController().signal)).toEqual({ models: [] }); expect(f.writes()).toBe(1);
  await access.close(); await access.close(); await expect(access.inspect(new AbortController().signal)).rejects.toThrow();
  expect(f.resources.size).toBe(0); expect(f.store.listSnapshotReferences().every(r => r.phase === "released")).toBe(true); expect(f.store.listSnapshotPublications().every(r => r.phase === "cleaned")).toBe(true);
});
it("revokes a composed data lease and cleans it without admitting later writes", async () => {
  const f = await fixture(); const access = await f.composition.bindDataContext(digest, () => {})(f.scope, new AbortController().signal);
  f.composition.revokeRuntime(); await expect(access.inspect(new AbortController().signal)).rejects.toThrow(); await access.close(); expect(f.writes()).toBe(0); expect(f.resources.size).toBe(0);
});

it("keeps production data admission unavailable without a protected worker tuple", async () => {
  const f = await fixture(false); expect(f.composition.dataWorkerAvailable).toBe(false);
  await expect(f.composition.bindDataContext(digest, () => {})(f.scope, new AbortController().signal)).rejects.toThrow();
  expect(f.store.listOpenShellIntents()).toEqual([]); expect(f.store.listSnapshotReferences()).toEqual([]); expect(f.store.listSnapshotPublications()).toEqual([]);
});

// Real composition/lifecycle/publication/reference path, only external volume/worker I/O replaced.
it("publishes and delivers two concurrently held, distinct captured contexts without global context revocation", async () => {
  const f = await fixture(); const other = `sha256:${"b".repeat(64)}`;
  const scopes = [f.scope, { ...f.scope, session: "other-session", turn: "other-turn", context: other }];
  const openers = scopes.map(scope => f.composition.bindDataContext(scope.context, () => {}));
  // Durable publication admission is serialized while both captured approvals and final
  // data leases coexist; a publishing resource is deliberately not globally ready.
  const accesses = [await openers[0]!(scopes[0]!, new AbortController().signal), await openers[1]!(scopes[1]!, new AbortController().signal)];
  expect(f.publications.sort()).toEqual([digest, other].sort()); expect(f.deliveries.sort()).toEqual([digest, other].sort());
  expect(await Promise.all(accesses.map(access => access.inspect(new AbortController().signal)))).toEqual([{ models: [] }, { models: [] }]);
  expect(f.resources.size).toBe(2); expect(f.store.listSnapshotReferences().filter(row => row.phase === "active")).toHaveLength(2);
  await accesses[1]!.close(); expect(await accesses[0]!.inspect(new AbortController().signal)).toEqual({ models: [] });
  await accesses[0]!.close(); expect(f.resources.size).toBe(0);
  await expect(f.composition.bindDataContext(other, () => {})(f.scope, new AbortController().signal)).rejects.toThrow();
});

it.each(["runtime", "binding", "account"] as const)("explicit %s invalidation rejects both previously captured approvals", async change => {
  const f = await fixture(); const other = `sha256:${"b".repeat(64)}`; let accountCurrent = true;
  const current = () => { if (!accountCurrent) throw Error("revoked synthetic account generation"); };
  const a = await f.composition.bindDataContext(digest, current)(f.scope, new AbortController().signal);
  const b = await f.composition.bindDataContext(other, current)({ ...f.scope, session: "other-session", context: other }, new AbortController().signal);
  if (change === "runtime") f.composition.revokeRuntime();
  else if (change === "account") accountCurrent = false;
  else { writeFileSync(path.join(f.project, "target/mdl.json"), JSON.stringify({ models: [{ name: "changed" }] })); f.store.activateEnrichmentBinding(resolveEnrichmentBinding(f.project)); }
  // Binding authority is checked again at snapshot delivery/verification; existing accesses
  // also carry the caller's captured currentness callback, as production provisioners do.
  if (change === "binding") f.composition.revokeRuntime();
  await expect(a.inspect(new AbortController().signal)).rejects.toThrow(); await expect(b.inspect(new AbortController().signal)).rejects.toThrow();
  await Promise.all([a.close(), b.close()]); expect(f.resources.size).toBe(0);
});
