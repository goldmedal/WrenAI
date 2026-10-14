import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync, symlinkSync, linkSync, renameSync, chmodSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../server/db.js";
import { resolveEnrichmentBinding } from "../server/enrichment.js";
import { OpenShellLifecycle } from "../server/runtime-host/openshell-lifecycle.js";
import { OPEN_SHELL_OWNER_LABEL, OpenShellError, type OpenShellDriver, type OpenShellIdentity, type OpenShellResource } from "../server/runtime-host/openshell-types.js";
import { DockerSnapshotDriver, SNAPSHOT_HELPER_PATH, parseSnapshotManifest, snapshotCanonical, snapshotHash, type SnapshotCaptureRequest, type SnapshotVolumeDriver } from "../server/runtime-host/openshell-snapshot-driver.js";
import { OpenShellProjectSnapshots, snapshotSourceAuthority } from "../server/runtime-host/openshell-project-snapshots.js";
import type { OpenShellConfiguration } from "../server/runtime-host/openshell-driver.js";
import type { SnapshotManifest, SnapshotPublication } from "../server/runtime-host/openshell-snapshot-types.js";

const digest = `sha256:${"a".repeat(64)}`;
const paths = ["wren_project.yml", "target/mdl.json", "data/input.txt"];
const roots: string[] = [], managers: OpenShellLifecycle[] = [], stores: Store[] = [];
afterEach(async () => { for (const manager of managers.splice(0)) await manager.shutdown().catch(() => {}); for (const store of stores.splice(0)) store.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function source() {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "genbi-snapshot-"))); roots.push(root);
  const project = path.join(root, "project"); mkdirSync(path.join(project, "target"), { recursive: true }); mkdirSync(path.join(project, "data"));
  writeFileSync(path.join(project, "wren_project.yml"), "version: 1\ndata_source: duckdb\nprofile: local\n"); writeFileSync(path.join(project, "target/mdl.json"), '{"models":[]}'); writeFileSync(path.join(project, "data/input.txt"), "synthetic one");
  const store = new Store(":memory:"); stores.push(store); store.activateEnrichmentBinding(resolveEnrichmentBinding(project));
  let currentProject: string | undefined = project, context: string | undefined = digest;
  const authority = snapshotSourceAuthority({ store, currentProject: () => currentProject, approvedFiles: paths, currentContext: () => context });
  return { root, project, store, authority, request: authority()!, unbind: () => { currentProject = undefined; }, changeContext: () => { context = `sha256:${"b".repeat(64)}`; } };
}
async function fixture() {
  const f = source(); const resources = new Map<string, OpenShellResource>();
  const driver: OpenShellDriver = { version: "0.0.1", identity: { image: digest, policy: digest, configuration: digest, gateway: "gateway", workspace: "default" },
    dataIdentity: { image: digest, policy: `sha256:${"b".repeat(64)}`, configuration: digest, gateway: "gateway", workspace: "default" }, probe: vi.fn(async () => {}),
    create: vi.fn(async (intent) => { const row = { id: intent.id, name: intent.name, workspace: "default", labels: { [OPEN_SHELL_OWNER_LABEL]: intent.owner } }; resources.set(intent.name, row); return row; }),
    list: vi.fn(async (intent) => [...resources.values()].filter((row) => row.name === intent.name)), inspect: vi.fn(async (intent) => resources.get(intent.name)!),
    remove: vi.fn(async (intent) => { resources.delete(intent.name); }), assertAbsent: vi.fn(async (intent) => { if (resources.has(intent.name)) throw new OpenShellError("openshell_cleanup_pending"); }),
    exec: vi.fn(async () => snapshotCanonical(manifest)),
  };
  const body = { version: 1 as const, project: f.request.project, bindingGeneration: f.request.bindingGeneration, bindingRevision: f.request.bindingRevision, context: digest,
    source: digest, files: [{ path: "project/data/input.txt", size: 13, sha256: snapshotHash("synthetic one").slice(7) }] };
  const manifest: SnapshotManifest = { ...body, digest: snapshotHash(snapshotCanonical(body)) };
  let sourceDrift = false;
  const volumes = new Map<string, string>();
  const volume: SnapshotVolumeDriver = { attest: vi.fn(), capture: vi.fn(async (_request, archive) => { writeFileSync(archive, "fixture"); return manifest; }),
    checkSource: vi.fn(async () => { if (sourceDrift) throw new OpenShellError("openshell_scope_invalid"); }),
    publish: vi.fn(async (row, _archive, _signal, check, created) => { check(); volumes.set(row.volume, row.owner); created(); }),
    verify: vi.fn(async (row) => { if (volumes.get(row.volume) !== row.owner) throw new OpenShellError("openshell_ownership_mismatch"); return manifest; }),
    remove: vi.fn(async (row) => { if (volumes.has(row.volume) && volumes.get(row.volume) !== row.owner) throw new OpenShellError("openshell_ownership_mismatch"); volumes.delete(row.volume); }),
    readArguments: () => ["/bin/fixture"],
  };
  let clock = 100;
  const lifecycle = new OpenShellLifecycle({ driver, journal: f.store, stateRoot: path.join(f.root, "state"), exclusive: true, now: () => clock }); managers.push(lifecycle);
  const snapshots = new OpenShellProjectSnapshots({ lifecycle, journal: f.store, driver: volume, stateRoot: path.join(f.root, "state"), currentSource: f.authority }); lifecycle.attachOwnedResources(snapshots);
  await lifecycle.initialize();
  const scope = (session = "session"): Extract<OpenShellIdentity, { purpose: "lifecycle" }> => ({ backend: "openshell", account: digest, generation: "1", session, turn: `turn-${session}`,
    binding: f.request.project, bindingGeneration: f.request.bindingGeneration, bindingRevision: f.request.bindingRevision, context: digest, plan: digest, ...driver.identity, purpose: "lifecycle", operation: "worker", snapshot: "none" });
  let current: OpenShellIdentity | undefined = scope();
  return { ...f, lifecycle, snapshots, driver, volume, volumes, resources, manifest, scope, current: () => current, setCurrent: (value: OpenShellIdentity | undefined) => { current = value; }, setClock: (value: number) => { clock = value; }, drift: () => { sourceDrift = true; } };
}

describe("host-authorized snapshot publication and delivery", () => {
  it("denies forged/copied/expired/revoked publication before durable/staging effects", async () => {
    const f = await fixture(); const permit = await f.snapshots.preparePublication(f.scope(), f.current);
    await expect(f.snapshots.publish({ ...permit })).rejects.toMatchObject({ code: "openshell_scope_invalid" });
    f.setClock(permit.expiresAt); await expect(f.snapshots.publish(permit)).rejects.toMatchObject({ code: "openshell_scope_invalid" });
    expect(f.store.listSnapshotPublications()).toEqual([]); expect(f.volume.capture).not.toHaveBeenCalled();
    f.setClock(100); const revoked = await f.snapshots.preparePublication(f.scope(), f.current); f.lifecycle.revoke(); await expect(f.snapshots.publish(revoked)).rejects.toBeDefined();
    expect(f.store.listSnapshotPublications()).toEqual([]);
  });
  for (const key of ["account", "generation", "session", "turn", "binding", "bindingGeneration", "bindingRevision", "context", "plan", "image", "policy", "configuration", "gateway", "workspace"] as const) it(`denies changed ${key} publication before effects`, async () => {
    const f = await fixture(); const permit = await f.snapshots.preparePublication(f.scope(), f.current); f.setCurrent({ ...f.scope(), [key]: "changed" });
    await expect(f.snapshots.publish(permit)).rejects.toBeDefined(); expect(f.store.listSnapshotPublications()).toEqual([]); expect(f.volume.capture).not.toHaveBeenCalled();
  });
  it("uses accepted binding and fresh context, not caller root/profile authority", async () => {
    const f = await fixture(); f.unbind(); await expect(f.snapshots.preparePublication(f.scope(), f.current)).rejects.toBeDefined();
    expect(f.store.listSnapshotPublications()).toEqual([]);
  });
  it("atomically publishes once; replay/copy handle cannot deliver", async () => {
    const f = await fixture(); const permit = await f.snapshots.preparePublication(f.scope(), f.current);
    const results = await Promise.allSettled([f.snapshots.publish(permit), f.snapshots.publish(permit)]); expect(results.filter((row) => row.status === "fulfilled")).toHaveLength(1);
    const handle = (results.find((row) => row.status === "fulfilled") as PromiseFulfilledResult<Awaited<ReturnType<typeof f.snapshots.publish>>>).value;
    await expect(f.snapshots.prepareDelivery({ ...handle }, f.scope(), f.current)).rejects.toBeDefined();
    expect(f.store.listSnapshotPublications()[0]?.phase).toBe("ready"); expect(f.volume.publish).toHaveBeenCalledTimes(1);
  });
  it("shares immutable publication with fresh session refs and refuses active deletion", async () => {
    const f = await fixture(); const handle = await f.snapshots.publish(await f.snapshots.preparePublication(f.scope(), f.current));
    const a = await f.snapshots.deliver(await f.snapshots.prepareDelivery(handle, f.scope(), f.current));
    const bScope = f.scope("other"); const b = await f.snapshots.deliver(await f.snapshots.prepareDelivery(handle, bScope, () => bScope));
    expect(a.reference).not.toBe(b.reference); expect(f.store.listSnapshotReferences().every((ref) => ref.workerId)).toBe(true);
    await expect(f.snapshots.remove(handle.id)).rejects.toMatchObject({ code: "openshell_cleanup_pending" }); await a.close();
    expect(await b.verify()).toEqual(f.manifest); await expect(f.snapshots.remove(handle.id)).rejects.toBeDefined();
    await b.close(); await f.snapshots.remove(handle.id); expect(f.volumes.size).toBe(0); expect(f.store.listSnapshotReferences().every((ref) => ref.phase === "released")).toBe(true);
  });
  it("rejects copied/replayed/cross-session delivery and drift after permit before create", async () => {
    const f = await fixture(); const handle = await f.snapshots.publish(await f.snapshots.preparePublication(f.scope(), f.current));
    const permit = await f.snapshots.prepareDelivery(handle, f.scope(), f.current);
    await expect(f.snapshots.deliver({ ...permit })).rejects.toBeDefined(); f.drift(); await expect(f.snapshots.deliver(permit)).rejects.toBeDefined();
    expect(f.driver.create).not.toHaveBeenCalled(); expect(f.store.listSnapshotReferences()).toEqual([]);
  });
  it("pins uncertain worker cleanup ref, then retries release after absence", async () => {
    const f = await fixture(); const handle = await f.snapshots.publish(await f.snapshots.preparePublication(f.scope(), f.current));
    const lease = await f.snapshots.deliver(await f.snapshots.prepareDelivery(handle, f.scope(), f.current));
    vi.mocked(f.driver.remove).mockRejectedValue(new OpenShellError("openshell_remote_unknown"));
    await expect(lease.close()).rejects.toBeDefined(); await expect(f.snapshots.remove(handle.id)).rejects.toBeDefined(); expect(f.store.listSnapshotReferences()[0]?.phase).not.toBe("released");
    vi.mocked(f.driver.remove).mockImplementation(async (intent) => { f.resources.delete(intent.name); });
    await f.lifecycle.retryCleanup(); expect(f.store.listSnapshotReferences()[0]?.phase).toBe("released"); await f.snapshots.remove(handle.id);
  });
  it("journal outage prevents volume mutation and remains unavailable until reconciliation", async () => {
    const f = await fixture(); const permit = await f.snapshots.preparePublication(f.scope(), f.current);
    const save = vi.spyOn(f.store, "saveSnapshotPublication").mockImplementation(() => { throw Error("private details"); });
    await expect(f.snapshots.publish(permit)).rejects.toMatchObject({ code: "openshell_journal_failed" }); expect(f.volume.publish).not.toHaveBeenCalled();
    expect((await f.lifecycle.probe()).readiness.state).toBe("unavailable"); save.mockRestore(); await f.lifecycle.retryCleanup(); expect((await f.lifecycle.probe()).readiness.state).toBe("ready");
  });
  it("failed verifier prevents ready and cleanup removes only owned publication", async () => {
    const f = await fixture(); vi.mocked(f.volume.verify).mockRejectedValue(new OpenShellError("openshell_identity_mismatch"));
    await expect(f.snapshots.publish(await f.snapshots.preparePublication(f.scope(), f.current))).rejects.toBeDefined();
    expect(f.store.listSnapshotPublications()[0]?.phase).toBe("cleaned"); expect(f.driver.create).not.toHaveBeenCalled(); expect(f.volumes.size).toBe(0);
  });
  it("session cancellation fences an in-flight publication before subsequent effects", async () => {
    const f = await fixture(); let entered!: () => void, finish!: () => void;
    const gate = new Promise<void>((resolve) => { finish = resolve; }); const start = new Promise<void>((resolve) => { entered = resolve; });
    vi.mocked(f.volume.capture).mockImplementation(async () => { entered(); await gate; return f.manifest; });
    const running = f.snapshots.publish(await f.snapshots.preparePublication(f.scope(), f.current)); const outcome = running.catch((error: unknown) => error);
    await start; await f.lifecycle.cancelSession("session"); finish(); await outcome;
    expect(f.volume.publish).not.toHaveBeenCalled(); expect(f.store.listSnapshotPublications()[0]?.phase).toBe("cleaned");
  });
  it("rejects delivery identity change, expiry and replay before ref acquisition", async () => {
    const f = await fixture(); const handle = await f.snapshots.publish(await f.snapshots.preparePublication(f.scope(), f.current));
    const stale = await f.snapshots.prepareDelivery(handle, f.scope(), f.current); f.setCurrent(f.scope("foreign")); await expect(f.snapshots.deliver(stale)).rejects.toBeDefined();
    f.setCurrent(f.scope()); const expired = await f.snapshots.prepareDelivery(handle, f.scope(), f.current); f.setClock(expired.expiresAt); await expect(f.snapshots.deliver(expired)).rejects.toBeDefined();
    expect(f.store.listSnapshotReferences()).toEqual([]); expect(f.driver.create).not.toHaveBeenCalled();
    f.setClock(100); const permit = await f.snapshots.prepareDelivery(handle, f.scope(), f.current); const lease = await f.snapshots.deliver(permit); await expect(f.snapshots.deliver(permit)).rejects.toBeDefined(); await lease.close();
  });
  it("fences a prepared delivery while publication deletion is in progress", async () => {
    const f = await fixture(); const handle = await f.snapshots.publish(await f.snapshots.preparePublication(f.scope(), f.current));
    const permit = await f.snapshots.prepareDelivery(handle, f.scope(), f.current);
    let finish!: () => void; const gate = new Promise<void>((resolve) => { finish = resolve; });
    vi.mocked(f.volume.remove).mockImplementation(async (row) => { await gate; f.volumes.delete(row.volume); });
    const removing = f.snapshots.remove(handle.id);
    await expect(f.snapshots.deliver(permit)).rejects.toMatchObject({ code: "openshell_scope_invalid" });
    expect(f.store.listSnapshotReferences()).toEqual([]); expect(f.driver.create).not.toHaveBeenCalled(); finish(); await removing;
  });
  it("denies ref acquisition if deletion races the async delivery proof", async () => {
    const f = await fixture(); const handle = await f.snapshots.publish(await f.snapshots.preparePublication(f.scope(), f.current));
    const permit = await f.snapshots.prepareDelivery(handle, f.scope(), f.current);
    let entered!: () => void, finish!: () => void;
    const gate = new Promise<void>((resolve) => { finish = resolve; }); const start = new Promise<void>((resolve) => { entered = resolve; });
    vi.mocked(f.volume.checkSource).mockImplementation(async () => { entered(); await gate; });
    const delivery = f.snapshots.deliver(permit); const outcome = delivery.catch((error: unknown) => error); await start;
    await f.snapshots.remove(handle.id); finish(); expect(await outcome).toBeInstanceOf(OpenShellError);
    expect(f.store.listSnapshotReferences()).toEqual([]); expect(f.driver.create).not.toHaveBeenCalled();
  });
  it("shutdown waits for cancelled delivery proof before releasing the controller", async () => {
    const f = await fixture(); const handle = await f.snapshots.publish(await f.snapshots.preparePublication(f.scope(), f.current));
    const permit = await f.snapshots.prepareDelivery(handle, f.scope(), f.current);
    let entered!: () => void, finish!: () => void;
    const gate = new Promise<void>((resolve) => { finish = resolve; }); const start = new Promise<void>((resolve) => { entered = resolve; });
    vi.mocked(f.volume.checkSource).mockImplementation(async () => { entered(); await gate; });
    const outcome = f.snapshots.deliver(permit).catch((error: unknown) => error); await start;
    let stopped = false; const shutdown = f.lifecycle.shutdown().then(() => { stopped = true; });
    await new Promise((resolve) => setTimeout(resolve, 10)); expect(stopped).toBe(false); finish(); await outcome; await shutdown;
    expect(f.store.listSnapshotPublications().every((row) => row.phase === "cleaned")).toBe(true);
    expect(f.store.listSnapshotReferences()).toEqual([]); expect(f.driver.create).not.toHaveBeenCalled();
  });
});

describe("canonical manifest", () => {
  it("rejects tamper, unordered/duplicate/escaping/case-alias paths, size overflow and unknown fields", async () => {
    const f = await fixture(); expect(parseSnapshotManifest(snapshotCanonical(f.manifest))).toEqual(f.manifest);
    for (const files of [[{ ...f.manifest.files[0]!, path: "../escape" }], [{ ...f.manifest.files[0]!, path: "/absolute" }], [f.manifest.files[0]!, f.manifest.files[0]!], [{ ...f.manifest.files[0]!, size: 134_217_729 }]]) {
      const { digest: _old, ...body } = { ...f.manifest, files }; const changed = { ...body, digest: snapshotHash(snapshotCanonical(body)) }; expect(() => parseSnapshotManifest(JSON.stringify(changed))).toThrow();
    }
    expect(() => parseSnapshotManifest(JSON.stringify({ ...f.manifest, source: `sha256:${"b".repeat(64)}` }))).toThrow(); expect(() => parseSnapshotManifest(JSON.stringify({ ...f.manifest, extra: true }))).toThrow();
  });
});

describe("snapshot Docker ownership contracts", () => {
  function remote(row: SnapshotPublication, scenario: object) {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "genbi-snapshot-remote-"))); roots.push(root);
    const executable = path.join(root, "docker.cjs"); writeFileSync(path.join(root, "scenario.json"), JSON.stringify(scenario));
    writeFileSync(executable, `#!${process.execPath}\nconst fs=require('node:fs');const root=process.env.HOME;const s=JSON.parse(fs.readFileSync(root+'/scenario.json'));const a=process.argv.slice(2);fs.appendFileSync(root+'/calls.jsonl',JSON.stringify(a)+'\\n');if(a[0]==='volume'&&a[1]==='inspect')console.log(JSON.stringify(s.volumes));else if(a[0]==='volume'&&a[1]==='ls')console.log(s.names||'');else if(a[0]==='ps')console.log((s.containers||[]).map(c=>c.Id).join('\\n'));else if(a[0]==='inspect')console.log((s.containers||[]).map(c=>JSON.stringify(c)).join('\\n'));else process.exit(3);\n`); chmodSync(executable, 0o700);
    const binary = realpathSync(process.execPath);
    const config: OpenShellConfiguration = { executable, executableDigest: snapshotHash(readFileSync(executable)), version: "0.0.1", gateway: "gateway", workspace: "default", image: digest, supervisorImage: digest,
      policy: executable, policyDigest: snapshotHash(readFileSync(executable)), home: root, configHome: root, stateHome: root, dockerExecutable: executable, dockerRealpath: executable,
      dockerDigest: snapshotHash(readFileSync(executable)), dockerSocket: path.join(root, "socket"), dockerNamespace: "fixture", exclusive: true,
      snapshotCapture: { executable: binary, realpath: binary, digest: snapshotHash(readFileSync(binary)), helperDigest: snapshotHash(readFileSync(SNAPSHOT_HELPER_PATH)), approvedFiles: paths } };
    return { driver: new DockerSnapshotDriver(config), calls: () => readFileSync(path.join(root, "calls.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as string[]),
      volume: { Name: row.volume, Driver: "local", Options: null, Labels: { "genbi-snapshot-owner": row.owner, "genbi-snapshot-publication": row.id, "genbi-snapshot-configuration": row.configuration, "genbi-snapshot-digest": row.manifest!.digest } } };
  }
  it("refuses a wrong owner, publication, digest, driver, options or name before helper creation", async () => {
    const f = await fixture(); await f.snapshots.publish(await f.snapshots.preparePublication(f.scope(), f.current)); const row = f.store.listSnapshotPublications()[0]!;
    const base = remote(row, {}).volume;
    for (const volume of [{ ...base, Name: "other" }, { ...base, Driver: "nfs" }, { ...base, Options: { device: "/outside", type: "none", o: "bind" } },
      ...["owner", "publication", "configuration", "digest"].map((key) => ({ ...base, Labels: { ...base.Labels, [`genbi-snapshot-${key}`]: "wrong" } }))]) {
      const actual = remote(row, { volumes: [volume] }); await expect(actual.driver.verify(row)).rejects.toMatchObject({ code: "openshell_ownership_mismatch" });
      expect(actual.calls().some((args) => args[0] === "create")).toBe(false);
    }
  });
  it("refuses deletion while a stopped foreign container still mounts the snapshot", async () => {
    const f = await fixture(); await f.snapshots.publish(await f.snapshots.preparePublication(f.scope(), f.current)); const row = f.store.listSnapshotPublications()[0]!;
    const actual = remote(row, { names: row.volume, containers: [{ Id: "a".repeat(64), Name: "/stopped-foreign", Image: digest, Config: { Labels: null }, Mounts: [{ Name: row.volume }] }] });
    await expect(actual.driver.remove(row)).rejects.toMatchObject({ code: "openshell_cleanup_pending" });
    expect(actual.calls().some((args) => args[0] === "rm" || args[1] === "rm")).toBe(false);
  });
  it("retains lost publication acknowledgement as unknown when the named volume is absent", async () => {
    const f = await fixture(); await f.snapshots.publish(await f.snapshots.preparePublication(f.scope(), f.current)); const row = f.store.listSnapshotPublications()[0]!;
    const actual = remote(row, { names: "", containers: [] });
    await expect(actual.driver.remove({ ...row, acknowledged: false, phase: "cleanup_pending" })).rejects.toMatchObject({ code: "openshell_remote_unknown" });
  });
});

const python = process.env.GENBI_SNAPSHOT_CAPTURE_PYTHON;
describe("packaged descriptor-anchored capture helper", () => {
  function captureDriver() {
    const executable = realpathSync(python!); const docker = realpathSync("/bin/echo");
    const config: OpenShellConfiguration = { executable: docker, executableDigest: snapshotHash(readFileSync(docker)), version: "0.0.1", gateway: "gateway", workspace: "default", image: digest, supervisorImage: digest, policy: SNAPSHOT_HELPER_PATH, policyDigest: snapshotHash(readFileSync(SNAPSHOT_HELPER_PATH)), home: "/private/tmp", configHome: "/private/tmp", stateHome: "/private/tmp", dockerExecutable: docker, dockerRealpath: docker, dockerDigest: snapshotHash(readFileSync(docker)), dockerSocket: "/private/tmp/socket", dockerNamespace: "fixture", exclusive: true,
      snapshotCapture: { executable, realpath: executable, digest: snapshotHash(readFileSync(executable)), helperDigest: snapshotHash(readFileSync(SNAPSHOT_HELPER_PATH)), approvedFiles: paths } };
    return new DockerSnapshotDriver(config);
  }
  it("captures canonical complete content without changing source; same bytes are runtime independent", async () => {
    const f = source(), driver = captureDriver(); const before = paths.map((name) => snapshotHash(readFileSync(path.join(f.project, name))));
    const a = await driver.capture(f.request, path.join(f.root, "a.tar"), new AbortController().signal);
    const b = await driver.capture(f.request, path.join(f.root, "b.tar"), new AbortController().signal); expect(a).toEqual(b); expect(a.files.some((file) => file.path === "project/data/input.txt")).toBe(true);
    expect(paths.map((name) => snapshotHash(readFileSync(path.join(f.project, name))))).toEqual(before);
  });
  it("preserves approved project metadata for governed execution with a closed strict-config projection", async () => {
    const f = source(), driver = captureDriver();
    const request = { ...f.request, projection: { "wren-home/profiles.yml": f.request.projection["wren-home/profiles.yml"]!, "wren-home/config.json": '{"strict_mode":true}\n' } };
    const manifest = await driver.capture(request, path.join(f.root, "governed.tar"), new AbortController().signal);
    expect(manifest.files.find(file => file.path === "project/wren_project.yml")?.sha256).toBe(snapshotHash(readFileSync(path.join(f.project, "wren_project.yml"))).slice(7));
    expect(manifest.files.find(file => file.path === "wren-home/config.json")?.sha256).toBe(snapshotHash('{"strict_mode":true}\n').slice(7));
  });
  it("independently verifies all files and refuses extra files, empty directories and changed bytes", async () => {
    const f = source(), driver = captureDriver(); const archive = path.join(f.root, "verify.tar");
    const manifest = await driver.capture(f.request, archive, new AbortController().signal);
    const extracted = path.join(f.root, "extracted"); mkdirSync(extracted); execFileSync("/usr/bin/tar", ["-xf", archive, "-C", extracted]);
    const verify = () => execFileSync(python!, ["-I", SNAPSHOT_HELPER_PATH, "verify", extracted, manifest.digest], { stdio: ["ignore", "pipe", "pipe"] });
    expect(parseSnapshotManifest(verify().toString().trim())).toEqual(manifest);
    mkdirSync(path.join(extracted, "extra-empty")); expect(verify).toThrow(); rmSync(path.join(extracted, "extra-empty"), { recursive: true });
    writeFileSync(path.join(extracted, "extra.txt"), "extra"); expect(verify).toThrow(); rmSync(path.join(extracted, "extra.txt"));
    const file = path.join(extracted, "project/data/input.txt"); chmodSync(file, 0o600); writeFileSync(file, "synthetic two"); expect(verify).toThrow();
    expect(readFileSync(path.join(f.project, "data/input.txt"), "utf8")).toBe("synthetic one");
  });
  for (const kind of ["leaf", "ancestor", "hardlink", "wal", "undeclared", "oversize", "fifo"] as const) it(`refuses ${kind} before publish without changing source`, async () => {
    const f = source(), driver = captureDriver();
    if (kind === "leaf") { rmSync(path.join(f.project, "data/input.txt")); symlinkSync(path.join(f.project, "target/mdl.json"), path.join(f.project, "data/input.txt")); }
    if (kind === "ancestor") { renameSync(path.join(f.project, "data"), path.join(f.root, "outside")); symlinkSync(path.join(f.root, "outside"), path.join(f.project, "data")); }
    if (kind === "hardlink") linkSync(path.join(f.project, "data/input.txt"), path.join(f.root, "hardlink"));
    if (kind === "wal") writeFileSync(path.join(f.project, "data/active.wal"), "writer");
    if (kind === "undeclared") writeFileSync(path.join(f.project, "credentials.txt"), "private");
    if (kind === "oversize") { const fd = await import("node:fs"); const file = path.join(f.project, "data/input.txt"); const handle = fd.openSync(file, "w"); fd.ftruncateSync(handle, 134_217_729); fd.closeSync(handle); }
    if (kind === "fifo") { rmSync(path.join(f.project, "data/input.txt")); execFileSync("/usr/bin/mkfifo", [path.join(f.project, "data/input.txt")]); }
    const configBefore = snapshotHash(readFileSync(path.join(f.project, "wren_project.yml")));
    await expect(driver.capture(f.request, path.join(f.root, "bad.tar"), new AbortController().signal)).rejects.toBeDefined(); expect(snapshotHash(readFileSync(path.join(f.project, "wren_project.yml")))).toBe(configBefore);
  });
  it("refuses stale root inode and same-size semantic drift", async () => {
    const f = source(), driver = captureDriver(); writeFileSync(path.join(f.project, "target/mdl.json"), '{"models":{}}');
    await expect(driver.capture(f.request, path.join(f.root, "drift.tar"), new AbortController().signal)).rejects.toBeDefined();
    await expect(driver.capture({ ...f.request, identity: "dev:0:ino:0" }, path.join(f.root, "identity.tar"), new AbortController().signal)).rejects.toBeDefined();
  });
  it("cannot capture an outside file during ancestor symlink swaps", async () => {
    const f = source(), driver = captureDriver(); const outside = path.join(f.root, "outside"); mkdirSync(outside); writeFileSync(path.join(outside, "input.txt"), "unapproved secret");
    const active = path.join(f.project, "data"), parked = path.join(f.root, "parked");
    let swapped = false;
    const timer = setInterval(() => {
      if (!swapped) { renameSync(active, parked); symlinkSync(outside, active); swapped = true; }
      else { rmSync(active); renameSync(parked, active); swapped = false; }
    }, 1);
    try {
      const results = await Promise.allSettled(Array.from({ length: 8 }, (_, index) => driver.capture(f.request, path.join(f.root, `race-${index}.tar`), new AbortController().signal)));
      for (const result of results) if (result.status === "fulfilled") expect(result.value.files.find((file) => file.path === "project/data/input.txt")?.sha256).toBe(snapshotHash("synthetic one").slice(7));
    } finally { clearInterval(timer); if (swapped) { rmSync(active); renameSync(parked, active); } }
    expect(readFileSync(path.join(active, "input.txt"), "utf8")).toBe("synthetic one");
  });
});
