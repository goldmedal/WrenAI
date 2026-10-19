import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Store } from "../server/db.js";
import { canonicalizeProposal, resolveEnrichmentBinding } from "../server/enrichment.js";
import { createOpenShellEnrichmentValidator } from "../server/openshell-enrichment-validation.js";
import { StructuredRuntimeError, type EnrichmentValidationRequest, type StructuredScope } from "../server/structured-runtime.js";
import { createOpenShellRuntimeCompositionForTesting } from "../server/openshell-runtime-composition.js";
import { ClaudeAccountVault } from "../server/runtime-host/claude-account-vault.js";
import { DATA_WORKER_ARGV, OpenShellCliDriver, readOpenShellConfiguration, VALIDATOR_ARGV, VALIDATOR_SCRIPT_PATH, type OpenShellConfiguration } from "../server/runtime-host/openshell-driver.js";
import { OpenShellLifecycle } from "../server/runtime-host/openshell-lifecycle.js";
import { DockerSnapshotDriver, snapshotCanonical, snapshotHash } from "../server/runtime-host/openshell-snapshot-driver.js";
import type { ValidatorSnapshotLease } from "../server/runtime-host/openshell-project-snapshots.js";
import { exchangeWithValidator, type ValidatorWorkerIdentity } from "../server/runtime-host/openshell-validator-client.js";
import { OpenShellError, OPEN_SHELL_OWNER_LABEL, openShellIdentitySchema, type OpenShellDriver, type OpenShellDuplex, type OpenShellIdentity, type OpenShellIntent, type OpenShellResource } from "../server/runtime-host/openshell-types.js";
import type { SnapshotManifest } from "../server/runtime-host/openshell-snapshot-types.js";
import { resolveRuntimeSelection } from "../server/runtime-selection.js";
const openshellClaude = resolveRuntimeSelection({ GENBI_RUNTIME: "openshell", GENBI_BACKEND: "claude" });

const digest = `sha256:${"a".repeat(64)}`;
const sha = (char: string) => `sha256:${char.repeat(64)}`;
const packagedValidatorDigest = `sha256:${createHash("sha256").update(readFileSync(VALIDATOR_SCRIPT_PATH)).digest("hex")}`;
const MODEL = readFileSync(path.join(import.meta.dirname, "fixtures", "card-project", "models/orders/metadata.yml"), "utf8");
const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.useRealTimers(); });

const baseIdentity = { backend: "openshell" as const, account: sha("1"), generation: "g1", session: "session", turn: "turn", binding: "binding", bindingGeneration: "1", bindingRevision: sha("2"),
  context: sha("3"), plan: sha("4"), image: digest, policy: digest, gateway: "fixture", workspace: "default", configuration: sha("5") };
const dataIdentity = (): OpenShellIdentity => ({ ...baseIdentity, purpose: "data", operation: "read", snapshot: sha("6"), publication: randomUUID(), reference: randomUUID() });
const validateIdentity = (): OpenShellIdentity => ({ ...baseIdentity, purpose: "validate", operation: "check", snapshot: sha("6"), publication: randomUUID(), reference: randomUUID() });

function driverConfiguration(validator: OpenShellConfiguration["dataWorker"] extends infer W ? W extends { validator?: infer V } ? V | undefined : never : never): OpenShellConfiguration {
  const worker = { image: digest, script: digest, wheel: digest, toolchain: digest, architecture: "linux-arm64" as const, protocol: "wren-governed/2" as const, ...(validator ? { validator } : {}) };
  return { executable: "/fixture/cli", executableDigest: digest, version: "0.0.1", gateway: "fixture", workspace: "default", image: digest, supervisorImage: digest, policy: "/fixture/policy", policyDigest: digest,
    home: "/fixture", configHome: "/fixture", stateHome: "/fixture", dockerExecutable: "/fixture/docker", dockerRealpath: "/fixture/docker", dockerDigest: digest, dockerSocket: "/fixture/s.sock", dockerNamespace: "fixture", exclusive: true,
    dataPolicy: "/fixture/data-policy", dataPolicyDigest: digest, dataWorker: worker, snapshotCapture: { executable: "/fixture/cap", realpath: "/fixture/cap", digest, helperDigest: digest, approvedFiles: ["wren_project.yml", "target/mdl.json"] } };
}
function realDriver(validator: Parameters<typeof driverConfiguration>[0]) {
  const opened: string[][] = [];
  const openDuplex = vi.fn(async (_intent: OpenShellIntent, argv: readonly string[]): Promise<OpenShellDuplex> => { opened.push([...argv]); return { output: (async function* () {})(), write() {}, close() {}, done: Promise.resolve(0) }; });
  const driver = new OpenShellCliDriver(driverConfiguration(validator), () => ({ volume: "genbi-snapshot-fixture", owner: randomUUID(), digest: sha("6") }), openDuplex);
  vi.spyOn(driver as unknown as { attest(): void }, "attest").mockImplementation(() => {});
  vi.spyOn(driver, "inspect").mockResolvedValue({ id: "r", name: "n", workspace: "default", labels: {} });
  const command = vi.spyOn(driver as unknown as { command(): Promise<string> }, "command").mockResolvedValue("{}");
  const intent = (identity: OpenShellIdentity) => ({ id: randomUUID(), owner: randomUUID(), name: "gb-0000000000000000", identity, createdAt: 1, phase: "active", acknowledged: true, interrupted: false }) as OpenShellIntent;
  return { driver, opened, openDuplex, command, intent };
}

describe("validator identity and driver argv separation", () => {
  it("the validate identity is a distinct, strict variant and data/read is unchanged", () => {
    expect(openShellIdentitySchema.parse(validateIdentity())).toMatchObject({ purpose: "validate", operation: "check" });
    expect(openShellIdentitySchema.parse(dataIdentity())).toMatchObject({ purpose: "data", operation: "read" });
    expect(() => openShellIdentitySchema.parse({ ...validateIdentity(), operation: "read" })).toThrow();
    expect(() => openShellIdentitySchema.parse({ ...dataIdentity(), operation: "check" })).toThrow();
    expect(() => openShellIdentitySchema.parse({ ...validateIdentity(), extra: "x" })).toThrow();
  });
  it("a validate sandbox may run only the validator argv; a data sandbox only the data worker argv", async () => {
    const f = realDriver({ script: packagedValidatorDigest, protocol: "genbi-validate/1" });
    const signal = new AbortController().signal;
    await f.driver.duplex(f.intent(validateIdentity()), VALIDATOR_ARGV, signal);
    await f.driver.duplex(f.intent(dataIdentity()), DATA_WORKER_ARGV, signal);
    expect(f.opened).toEqual([[...VALIDATOR_ARGV], [...DATA_WORKER_ARGV]]);
    for (const [identity, argv] of [[dataIdentity(), VALIDATOR_ARGV], [validateIdentity(), DATA_WORKER_ARGV], [validateIdentity(), [...VALIDATOR_ARGV, "extra"]], [validateIdentity(), ["/usr/local/bin/python", "-I", "-c", "print(1)"]],
      [dataIdentity(), [...DATA_WORKER_ARGV, "extra"]], [{ ...baseIdentity, purpose: "lifecycle", operation: "worker", snapshot: "none" } as OpenShellIdentity, VALIDATOR_ARGV]] as const) {
      f.openDuplex.mockClear();
      await expect(f.driver.duplex(f.intent(identity), argv, signal)).rejects.toMatchObject({ code: "openshell_scope_invalid" });
      expect(f.openDuplex).not.toHaveBeenCalled();
    }
  });
  it.each([["no validator descriptor", undefined], ["a descriptor digest that is not the packaged script", { script: sha("9"), protocol: "genbi-validate/1" as const }]])("fails closed with %s: no validator launch, no sandbox creation, data access unchanged", async (_label, descriptor) => {
    const f = realDriver(descriptor);
    expect(f.driver.validatorReady()).toBe(false);
    await expect(f.driver.duplex(f.intent(validateIdentity()), VALIDATOR_ARGV, new AbortController().signal)).rejects.toMatchObject({ code: "openshell_scope_invalid" });
    await expect(f.driver.create(f.intent(validateIdentity()), new AbortController().signal)).rejects.toMatchObject({ code: "openshell_scope_invalid" });
    expect(f.command).not.toHaveBeenCalled(); expect(f.openDuplex).not.toHaveBeenCalled();
    await f.driver.duplex(f.intent(dataIdentity()), DATA_WORKER_ARGV, new AbortController().signal);
    expect(f.opened).toEqual([[...DATA_WORKER_ARGV]]);
  });
  it("creates a validate sandbox from the data worker image and the data policy (no network policy of its own), only when ready", async () => {
    const f = realDriver({ script: packagedValidatorDigest, protocol: "genbi-validate/1" });
    expect(f.driver.validatorReady()).toBe(true);
    expect(f.driver.dataIdentity).toMatchObject({ image: digest, policy: digest });
    await f.driver.create(f.intent(validateIdentity()), new AbortController().signal);
    const args = f.command.mock.calls[0] as unknown as [string[]];
    expect(args[0]).toEqual(expect.arrayContaining(["--from", digest, "--policy", "/fixture/data-policy", "--no-auto-providers"]));
    expect(JSON.stringify(args[0])).not.toMatch(/env|credential|token|vault/i);
  });
});

async function lifecycleFixture(validatorReady: boolean) {
  const root = mkdtempSync(path.join(tmpdir(), "genbi-validator-lifecycle-")); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const store = new Store(":memory:"); cleanup.push(() => store.close());
  const resources = new Map<string, OpenShellResource>();
  const driverIdentity = { image: digest, policy: digest, gateway: "fixture", workspace: "default", configuration: sha("5") };
  const driver: OpenShellDriver = { version: "0.0.1", identity: driverIdentity, dataIdentity: driverIdentity, validatorReady: () => validatorReady, probe: vi.fn(async () => {}),
    create: vi.fn(async (intent) => { const resource = { id: intent.id, name: intent.name, workspace: "default", labels: { [OPEN_SHELL_OWNER_LABEL]: intent.owner } }; resources.set(intent.name, resource); return resource; }),
    list: vi.fn(async (intent) => [...resources.values()].filter((row) => row.labels[OPEN_SHELL_OWNER_LABEL] === intent.owner)), inspect: vi.fn(async (intent) => resources.get(intent.name)!),
    remove: vi.fn(async (intent) => { resources.delete(intent.name); }), assertAbsent: vi.fn(async () => {}), exec: vi.fn(async () => "") };
  const lifecycle = new OpenShellLifecycle({ driver, journal: store, stateRoot: root, exclusive: true }); cleanup.push(() => lifecycle.shutdown().catch(() => {}));
  await lifecycle.initialize();
  return { root, store, driver, lifecycle, resources };
}

describe("validator permit separation at the lifecycle", () => {
  it("a data permit cannot be reserved as a validator launch, and a validator permit cannot be reserved as a data launch", async () => {
    const f = await lifecycleFixture(true);
    const data = dataIdentity(), validate = validateIdentity();
    const dataPermit = await f.lifecycle.prepareLaunch(data, () => data), validatePermit = await f.lifecycle.prepareLaunch(validate, () => validate);
    expect(() => f.lifecycle.reserveValidatorLaunch(dataPermit)).toThrow(expect.objectContaining({ code: "openshell_scope_invalid" }));
    expect(() => f.lifecycle.reserveDataLaunch(validatePermit)).toThrow(expect.objectContaining({ code: "openshell_scope_invalid" }));
    expect(() => f.lifecycle.reserveDataLaunch(dataPermit)).not.toThrow();
    expect(() => f.lifecycle.reserveValidatorLaunch(validatePermit)).not.toThrow();
  });
  it("a validate permit is not reservable at all when the validator is not ready", async () => {
    const f = await lifecycleFixture(false);
    expect(f.lifecycle.validatorReady).toBe(false);
    const validate = validateIdentity(); const permit = await f.lifecycle.prepareLaunch(validate, () => validate);
    expect(() => f.lifecycle.reserveValidatorLaunch(permit)).toThrow(expect.objectContaining({ code: "openshell_scope_invalid" }));
  });
});

// A scripted validator sandbox: prelude, then (after the request line) a result, then exit.
interface Script { prelude?: unknown; result?: string | Buffer; extra?: string; exit?: number | "none"; stderr?: number; noResult?: boolean; immediateExit?: number; respond?(request: Buffer): string }
function scriptedDuplex(identity: ValidatorWorkerIdentity, script: Script = {}): { stream: OpenShellDuplex; written: Buffer[]; closed: () => boolean } {
  const queue: ({ stream: "stdout" | "stderr"; data: Buffer } | { type: "exit"; exitCode: number })[] = [];
  let wake: (() => void) | undefined, closed = false; const written: Buffer[] = [];
  const push = (value: (typeof queue)[number]) => { queue.push(value); wake?.(); };
  const prelude = script.prelude === undefined ? identity : script.prelude;
  if (prelude !== null) queue.push({ stream: "stdout", data: Buffer.from(JSON.stringify(prelude) + "\n") });
  if (script.immediateExit !== undefined) queue.push({ type: "exit", exitCode: script.immediateExit });
  return { written, closed: () => closed, stream: {
    output: (async function* () { while (!closed) { if (queue.length) yield queue.shift()!; else await new Promise<void>((resolve) => { wake = resolve; }); } })(),
    write(data) {
      written.push(Buffer.from(data));
      if (script.noResult) return;
      if (script.stderr) push({ stream: "stderr", data: Buffer.alloc(script.stderr) });
      push({ stream: "stdout", data: Buffer.concat([Buffer.from(script.respond ? script.respond(data) : script.result ?? '{"status":"failed","checks":[]}'), Buffer.from("\n"), Buffer.from(script.extra ?? "")]) });
      if (script.exit !== "none") push({ type: "exit", exitCode: script.exit ?? 0 });
    },
    close() { closed = true; wake?.(); }, done: new Promise(() => {}) } };
}
const tuple: ValidatorWorkerIdentity = { worker: "genbi-wren-validator/1", snapshot: sha("6"), script: packagedValidatorDigest, wheel: digest, toolchain: digest, architecture: "linux-arm64", protocol: "genbi-validate/1" };
function fakeLease(stream: OpenShellDuplex, onVerify?: () => Promise<SnapshotManifest>): ValidatorSnapshotLease {
  return { id: "lease", reference: "ref", signal: new AbortController().signal, assertActive() {}, verify: onVerify ?? (async () => ({}) as SnapshotManifest), openValidator: async () => stream, close: async () => {} };
}
const exchange = (script: Script, extra: Partial<Parameters<typeof exchangeWithValidator>[0]> = {}) => {
  const duplex = scriptedDuplex(tuple, script);
  return { duplex, run: () => exchangeWithValidator({ lease: fakeLease(duplex.stream), expected: tuple, request: Buffer.from('{"version":1,"files":[]}'), signal: new AbortController().signal, assertCurrent() {}, timeoutMs: 5000, ...extra }) };
};

describe("validator transport", () => {
  it("accepts one prelude, one request line and one result line followed by a clean exit", async () => {
    const f = exchange({ result: '{"status":"failed","checks":[]}' });
    expect(JSON.parse((await f.run()).toString())).toEqual({ status: "failed", checks: [] });
    expect(f.duplex.written).toHaveLength(1); expect(f.duplex.written[0]!.toString()).toBe('{"version":1,"files":[]}\n'); expect(f.duplex.closed()).toBe(true);
  });
  it.each([
    ["a prelude with a different script digest", { prelude: { ...tuple, script: sha("9") } }, "openshell_identity_mismatch"],
    ["a prelude for a different snapshot", { prelude: { ...tuple, snapshot: sha("8") } }, "openshell_identity_mismatch"],
    ["an extra prelude field", { prelude: { ...tuple, extra: true } }, "openshell_identity_mismatch"],
    ["output with no prelude at all (an image without the validator exits at once)", { prelude: null, immediateExit: 1 }, "openshell_protocol_invalid"],
    ["extra output after the result line", { extra: '{"status":"ok"}\n' }, "openshell_protocol_invalid"],
    ["a non-zero exit", { exit: 1 }, "openshell_protocol_invalid"],
    ["an oversized result", { result: "x".repeat(600_000) }, "openshell_protocol_invalid"],
    ["a stderr flood", { stderr: 70_000 }, "openshell_protocol_invalid"],
  ] as [string, Script, string][])("refuses %s", async (_label, script, code) => {
    const f = exchange(script);
    await expect(f.run()).rejects.toMatchObject({ code }); expect(f.duplex.closed()).toBe(true);
  });
  it("refuses an oversized request before opening anything, and a request with a newline", async () => {
    const f = exchange({});
    await expect(exchange({}, { request: Buffer.alloc(200_000) }).run()).rejects.toMatchObject({ code: "openshell_scope_invalid" });
    await expect(exchange({}, { request: Buffer.from("a\nb") }).run()).rejects.toMatchObject({ code: "openshell_scope_invalid" });
    expect(f.duplex.written).toEqual([]);
  });
  it("is cancelled by the signal and by the deadline, and always closes the stream", async () => {
    const controller = new AbortController(); const f = exchange({ noResult: true }, { signal: controller.signal });
    const pending = f.run(); await vi.waitFor(() => expect(f.duplex.written).toHaveLength(1)); controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "openshell_cancelled" }); expect(f.duplex.closed()).toBe(true);
    const slow = exchange({ noResult: true }, { timeoutMs: 20 });
    await expect(slow.run()).rejects.toMatchObject({ code: "openshell_cancelled" }); expect(slow.duplex.closed()).toBe(true);
  });
  it("re-verifies the snapshot before opening the validator and stops when it is no longer current", async () => {
    const duplex = scriptedDuplex(tuple); let verified = 0;
    const lease = fakeLease(duplex.stream, async () => { verified++; throw new OpenShellError("openshell_identity_mismatch"); });
    await expect(exchangeWithValidator({ lease, expected: tuple, request: Buffer.from("{}"), signal: new AbortController().signal, assertCurrent() {}, timeoutMs: 1000 })).rejects.toMatchObject({ code: "openshell_identity_mismatch" });
    expect(verified).toBe(1); expect(duplex.written).toEqual([]);
  });
});

// The real composition, lifecycle, snapshot publication and reference journal; only external I/O is synthetic.
interface Fixture { composition: Awaited<ReturnType<typeof createOpenShellRuntimeCompositionForTesting>>; store: Store; scope: Parameters<ReturnType<Awaited<ReturnType<typeof createOpenShellRuntimeCompositionForTesting>>["bindValidatorContext"]>>[0];
  resources: Map<string, OpenShellResource>; project: string; env: Record<string, string>; driver: OpenShellDriver; vault: ClaudeAccountVault; root: string; launched: { purpose: string; argv: string[] }[]; removeFails: { value: boolean }; vaultCalls: { value: number }; script: Script; binding: ReturnType<Store["activateEnrichmentBinding"]> }
async function compositionFixture(options: { validator?: boolean; script?: Script } = {}): Promise<Fixture> {
  const root = mkdtempSync(path.join(tmpdir(), "genbi-validator-composition-")); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, "project"); mkdirSync(path.join(project, "target"), { recursive: true }); mkdirSync(path.join(project, "knowledge", "rules"), { recursive: true });
  writeFileSync(path.join(project, "wren_project.yml"), "schema_version: 5\nname: demo\ndata_source: duckdb\n");
  const mdl = JSON.stringify({ models: [] }); writeFileSync(path.join(project, "target/mdl.json"), mdl);
  writeFileSync(path.join(project, "knowledge/rules/revenue.md"), "Revenue is net of refunds.\n"); writeFileSync(path.join(project, "knowledge/rules/margin.md"), "Margin is revenue minus cost.\n");
  mkdirSync(path.join(project, "models", "orders"), { recursive: true }); writeFileSync(path.join(project, "models/orders/metadata.yml"), MODEL);
  const store = new Store(":memory:"); const binding = store.activateEnrichmentBinding(resolveEnrichmentBinding(project));
  const file = path.join(root, "config.json");
  writeFileSync(file, JSON.stringify({ executable: file, executableDigest: digest, version: "0.0.1", gateway: "fixture", workspace: "default", image: digest, supervisorImage: digest,
    policy: file, policyDigest: digest, dataPolicy: file, dataPolicyDigest: digest, home: root, configHome: root, stateHome: root,
    dockerExecutable: file, dockerRealpath: file, dockerDigest: digest, dockerSocket: path.join(root, "none.sock"), dockerNamespace: "fixture", exclusive: true,
    dataWorker: { image: digest, script: digest, wheel: digest, toolchain: digest, architecture: "linux-arm64", protocol: "wren-governed/2", ...(options.validator === false ? {} : { validator: { script: packagedValidatorDigest, protocol: "genbi-validate/1" } }) },
    snapshotCapture: { executable: file, realpath: file, digest, helperDigest: digest, approvedFiles: ["knowledge/rules/margin.md", "knowledge/rules/revenue.md", "models/orders/metadata.yml", "target/mdl.json", "wren_project.yml"] } }));
  const env = { GENBI_OPENSHELL_CONFIG: file };
  const config = readOpenShellConfiguration(env, openshellClaude).configuration!;
  const identity = { image: digest, policy: digest, gateway: "fixture", workspace: "default", configuration: snapshotHash(JSON.stringify(config)) };
  const manifests = new Map<string, SnapshotManifest>(); const resources = new Map<string, OpenShellResource>();
  const launched: Fixture["launched"] = []; const removeFails = { value: false }; const vaultCalls = { value: 0 }; const script = options.script ?? {};
  const driver: OpenShellDriver = { version: "fixture", identity, dataIdentity: identity, validatorReady: () => options.validator !== false, probe: async () => {},
    create: async (intent) => { const resource = { id: intent.id, name: intent.name, workspace: "default", labels: { [OPEN_SHELL_OWNER_LABEL]: intent.owner } }; resources.set(intent.id, resource); return resource; },
    list: async (intent) => [...resources.values()].filter((row) => row.name === intent.name), inspect: async (intent) => resources.get(intent.id)!,
    remove: async (intent) => { if (removeFails.value) throw new OpenShellError("openshell_cleanup_pending"); resources.delete(intent.id); }, assertAbsent: async (intent) => { if (resources.has(intent.id) && !removeFails.value) throw new Error("present"); },
    exec: async (intent) => snapshotCanonical(manifests.get((intent.identity as { snapshot: string }).snapshot)!),
    duplex: async (intent, argv) => {
      launched.push({ purpose: intent.identity.purpose, argv: [...argv] });
      const manifest = manifests.get((intent.identity as { snapshot: string }).snapshot)!;
      return scriptedDuplex({ ...tuple, snapshot: manifest.digest, script: packagedValidatorDigest, wheel: digest, toolchain: digest }, script).stream;
    } };
  vi.spyOn(DockerSnapshotDriver.prototype, "attest").mockImplementation(() => {});
  vi.spyOn(DockerSnapshotDriver.prototype, "capture").mockImplementation(async (request, archive) => {
    writeFileSync(archive, "synthetic");
    const files = request.paths.map((relative) => { const bytes = readFileSync(path.join(request.root, relative)); return { path: `project/${relative}`, size: bytes.length, sha256: snapshotHash(bytes).slice(7) }; }).sort((a, b) => (a.path < b.path ? -1 : 1));
    const body = { version: 1 as const, project: request.project, bindingGeneration: request.bindingGeneration, bindingRevision: request.bindingRevision, context: request.context, source: digest, files };
    const manifest = { ...body, digest: snapshotHash(snapshotCanonical(body)) }; manifests.set(manifest.digest, manifest); return manifest;
  });
  vi.spyOn(DockerSnapshotDriver.prototype, "checkSource").mockResolvedValue();
  vi.spyOn(DockerSnapshotDriver.prototype, "publish").mockImplementation(async (_row, _archive, _signal, check, created) => { await Promise.resolve(); check(); created(); });
  vi.spyOn(DockerSnapshotDriver.prototype, "verify").mockImplementation(async (row) => manifests.get(row.manifest!.digest)!);
  vi.spyOn(DockerSnapshotDriver.prototype, "remove").mockResolvedValue();
  const vault = ClaudeAccountVault.forTesting({ root: path.join(root, "vault"), transport: async () => { vaultCalls.value++; throw Error("no account calls"); } });
  const composition = await createOpenShellRuntimeCompositionForTesting({ env, selection: openshellClaude, store, stateRoot: path.join(root, "state"), driver, currentProject: () => project, claude: { vault, duplex: driver.duplex! } });
  cleanup.push(async () => { removeFails.value = false; await composition.shutdown().catch(() => {}); store.close(); });
  const scope = { backend: "openshell" as const, account: sha("1"), generation: "g1", session: "run-1", turn: "turn-1", binding: binding.identity, bindingGeneration: String(binding.generation), bindingRevision: binding.revision, context: sha("3"), plan: sha("4") };
  return { composition, store, scope, resources, project, env, driver, vault, root, launched, removeFails, vaultCalls, script, binding };
}
const request = Buffer.from('{"version":1,"files":[]}');

describe("validator composition", () => {
  it("publishes the snapshot, serves manifest-verified source reads, then runs the validator under its own identity with no credential", async () => {
    const f = await compositionFixture({ script: { result: '{"status":"failed","checks":[{"check":"additivity","status":"fail","code":"x","message":"m"}]}' } });
    expect(f.composition.validatorAvailable()).toBe(true);
    const session = await f.composition.bindValidatorContext(sha("3"), () => {})(f.scope, new AbortController().signal);
    expect(session.manifest.files.map((file) => file.path)).toEqual(["project/knowledge/rules/margin.md", "project/knowledge/rules/revenue.md", "project/models/orders/metadata.yml", "project/target/mdl.json", "project/wren_project.yml"]);
    expect(session.readSource("knowledge/rules/revenue.md", 65_536)!.toString()).toBe("Revenue is net of refunds.\n");
    expect(session.readSource("knowledge/rules/new.md", 65_536)).toBeUndefined();
    expect(f.launched).toEqual([]);
    expect(JSON.parse((await session.validate(request, 5000)).toString())).toMatchObject({ status: "failed" });
    expect(f.launched).toEqual([{ purpose: "validate", argv: [...VALIDATOR_ARGV] }]);
    const intent = f.store.listOpenShellIntents().find((row) => row.identity.purpose === "validate")!;
    expect(intent.identity).toMatchObject({ purpose: "validate", operation: "check", image: digest, policy: digest, snapshot: session.digest });
    expect(session.validator).toMatchObject({ script: packagedValidatorDigest, protocol: "genbi-validate/1", image: digest, policy: digest });
    await session.close();
    expect(f.vaultCalls.value).toBe(0); expect(f.resources.size).toBe(0);
    expect(f.store.listOpenShellIntents().every((row) => row.phase === "cleaned")).toBe(true);
    expect(f.store.listSnapshotReferences().every((row) => row.phase === "released")).toBe(true); expect(f.store.listSnapshotPublications().every((row) => row.phase === "cleaned")).toBe(true);
  });
  it("a validator lease is not a data lease: no governed access, no file read, and the data argv is never used", async () => {
    const f = await compositionFixture();
    const session = await f.composition.bindValidatorContext(sha("3"), () => {})(f.scope, new AbortController().signal);
    expect((session as unknown as Record<string, unknown>)["openGoverned"]).toBeUndefined(); expect((session as unknown as Record<string, unknown>)["read"]).toBeUndefined();
    await session.validate(request, 5000).catch(() => {});
    expect(f.launched.every((row) => row.purpose === "validate" && JSON.stringify(row.argv) === JSON.stringify(VALIDATOR_ARGV))).toBe(true);
    expect(f.launched.some((row) => row.argv.includes("/opt/genbi/worker.py"))).toBe(false);
    await session.close();
  });
  it("a symlinked sink in the captured project is refused by the manifest-verified read and the validator is never launched for it", async () => {
    const f = await compositionFixture(); const outside = path.join(f.project, "..", "outside.md"); writeFileSync(outside, "outside\n");
    const session = await f.composition.bindValidatorContext(sha("3"), () => {})(f.scope, new AbortController().signal);
    rmSync(path.join(f.project, "knowledge/rules/revenue.md")); symlinkSync(outside, path.join(f.project, "knowledge/rules/revenue.md"));
    expect(() => session.readSource("knowledge/rules/revenue.md", 65_536)).toThrow();
    expect(f.launched).toEqual([]); await session.close();
  });
  it("a changed source file is refused by the manifest hash", async () => {
    const f = await compositionFixture();
    const session = await f.composition.bindValidatorContext(sha("3"), () => {})(f.scope, new AbortController().signal);
    writeFileSync(path.join(f.project, "knowledge/rules/revenue.md"), "Revenue is gross.\n");
    expect(() => session.readSource("knowledge/rules/revenue.md", 65_536)).toThrow(); await session.close();
  });
  it("is unavailable without a verified validator descriptor, leaves no durable state, and keeps the data worker available", async () => {
    const f = await compositionFixture({ validator: false });
    expect(f.composition.validatorAvailable()).toBe(false); expect(f.composition.dataWorkerAvailable).toBe(true);
    await expect(f.composition.bindValidatorContext(sha("3"), () => {})(f.scope, new AbortController().signal)).rejects.toThrow();
    expect(f.store.listOpenShellIntents()).toEqual([]); expect(f.store.listSnapshotReferences()).toEqual([]); expect(f.store.listSnapshotPublications()).toEqual([]); expect(f.launched).toEqual([]);
  });
  it.each(["cancel", "revoke"] as const)("%s while the validator is running ends without a result and cleans every owned resource", async (how) => {
    const f = await compositionFixture({ script: { noResult: true } }); const controller = new AbortController();
    const session = await f.composition.bindValidatorContext(sha("3"), () => {})(f.scope, controller.signal);
    const pending = session.validate(request, 5000); const rejected = expect(pending).rejects.toThrow();
    void rejected;
    await vi.waitFor(() => expect(f.launched).toHaveLength(1));
    if (how === "cancel") controller.abort(); else f.composition.revokeRuntime();
    await rejected; await session.close();
    expect(f.resources.size).toBe(0); expect(f.store.listOpenShellIntents().every((row) => row.phase === "cleaned")).toBe(true);
    expect(f.store.listSnapshotReferences().every((row) => row.phase === "released")).toBe(true);
  });
  it("stale currentness at launch fails before any sandbox effect", async () => {
    const f = await compositionFixture(); let current = true;
    const session = await f.composition.bindValidatorContext(sha("3"), () => { if (!current) throw Error("stale"); })(f.scope, new AbortController().signal);
    current = false;
    await expect(session.validate(request, 5000)).rejects.toThrow();
    expect(f.launched).toEqual([]); expect(f.store.listOpenShellIntents()).toEqual([]); await session.close().catch(() => {});
  });
  it("cleanup uncertainty is reported by close (never swallowed) and a retry after recovery completes it", async () => {
    const f = await compositionFixture({ script: { result: '{"status":"failed","checks":[]}' } });
    const session = await f.composition.bindValidatorContext(sha("3"), () => {})(f.scope, new AbortController().signal);
    await session.validate(request, 5000);
    f.removeFails.value = true; await expect(session.close()).rejects.toThrow();
    f.removeFails.value = false; await f.composition.lifecycle!.retryCleanup(); expect(f.resources.size).toBe(0);
  });
  it("a restart cleans an interrupted validator sandbox through the existing recovery path and never resumes it", async () => {
    const f = await compositionFixture({ script: { noResult: true } });
    const session = await f.composition.bindValidatorContext(sha("3"), () => {})(f.scope, new AbortController().signal);
    void session.validate(request, 60_000).catch(() => {});
    await vi.waitFor(() => expect(f.launched).toHaveLength(1));
    expect(f.store.listOpenShellIntents().some((row) => row.identity.purpose === "validate" && row.phase === "active")).toBe(true);
    // A successor process owns a different state root but the same durable journal and gateway: its recovery must clean the orphan.
    const successor = await createOpenShellRuntimeCompositionForTesting({ env: f.env, selection: openshellClaude, store: f.store, stateRoot: path.join(f.root, "successor-state"), driver: f.driver, currentProject: () => f.project,
      claude: { vault: f.vault, duplex: f.driver.duplex! } });
    cleanup.push(() => successor.shutdown().catch(() => {}));
    expect(f.store.listOpenShellIntents().filter((row) => row.identity.purpose === "validate").every((row) => row.phase === "cleaned")).toBe(true);
    expect(f.resources.size).toBe(0); expect(f.launched).toHaveLength(1);
  });
});


// ------------------------------------------------------------------------------------------------
// The independent validation flow over the real composition: host review first, then the sandbox, cleanup before any verdict.
const hashTree = (directory: string): string => {
  const hash = createHash("sha256");
  const walk = (current: string) => { for (const name of readdirSync(current).sort()) { const full = path.join(current, name); if (statSync(full).isDirectory()) walk(full); else hash.update(full.slice(directory.length)).update(readFileSync(full)); } };
  walk(directory); return hash.digest("hex");
};
const mdlText = JSON.stringify({ models: [{ name: "orders" }] }, null, 2);
const checkOf = (check: string, status = "pass") => ({ check, status, code: status === "pass" ? "ok" : "not_applicable", message: "" });
/** A faithful validator stand-in: echoes exactly the files it was sent as the applied change set. */
const echoOk = (request: Buffer, overrides: Record<string, unknown> = {}) => {
  const { files } = JSON.parse(request.toString()) as { files: { path: string }[] };
  const relation = files.some((file) => /^(?:models|views)\//.test(file.path));
  return JSON.stringify({ status: "ok", applied: files, checks: [checkOf("additivity"), checkOf("context_validate"), checkOf("context_build"), checkOf("dry_plan", relation ? "pass" : "skipped"), checkOf("cube_sql", "skipped"), checkOf("dry_run", "skipped")],
    mdl: { sha256: createHash("sha256").update(mdlText).digest("hex"), size: Buffer.byteLength(mdlText), content: mdlText }, ...overrides });
};
const operation = (sink: string, draft: string, changeKind: "knowledge_append" | "mdl_metric" | "new_relationship" | "new_cube" | "new_view" | "calculated_column" = "knowledge_append") => ({ sink, changeKind, summary: "s", draft });

async function validationFixture(script: Script, options: { validator?: boolean; timeoutMs?: number; exchangeTimeoutMs?: number } = {}) {
  const f = await compositionFixture({ script, ...(options.validator === false ? { validator: false } : {}) });
  const scratchRoot = path.join(f.root, "drafts");
  const composition = { ...f.composition, claudeVault: { status: () => ({ state: "verified", fingerprint: sha("1"), generation: "g1" }) } } as never;
  const validator = createOpenShellEnrichmentValidator({ composition, getBinding: () => f.binding, scratchRoot, ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}), ...(options.exchangeTimeoutMs ? { exchangeTimeoutMs: options.exchangeTimeoutMs } : {}) });
  const request = (operations: ReturnType<typeof operation>[]): EnrichmentValidationRequest => ({ authChoice: { mode: "subscription", provider: "claude" }, proposal: canonicalizeProposal({ operations }, f.binding.revision), binding: f.binding });
  const scope = (overrides: Partial<StructuredScope> = {}): StructuredScope => ({ sessionId: "run-1", turnId: "turn-1", assertCurrent() {}, ...overrides });
  const settled = () => { expect(f.resources.size).toBe(0); expect(existsSync(scratchRoot) ? readdirSync(scratchRoot).length : 0).toBe(0); expect(f.store.listOpenShellIntents().every((row) => row.phase === "cleaned")).toBe(true);
    expect(f.store.listSnapshotReferences().every((row) => row.phase === "released")).toBe(true); expect(f.store.listSnapshotPublications().every((row) => row.phase === "cleaned")).toBe(true); };
  return { f, validator, request, scope, settled, scratchRoot };
}
const GOOD = [operation("knowledge/rules/revenue.md", "Refunds are excluded."), operation("knowledge/rules/margin.md", "Margin excludes shipping.")];

describe("independent enrichment validation", () => {
  it("S2-1: validates a proposal end to end; the review holds the exact diff, a receipt whose change set equals the candidate, and the source project is byte-identical", async () => {
    const t = await validationFixture({ respond: (request) => echoOk(request) });
    const before = hashTree(t.f.project);
    const result = await t.validator.validate(t.request(GOOD), t.scope());
    expect(result.status).toBe("validated"); if (result.status !== "validated") return;
    const { review } = result;
    expect(review.diff).toEqual([
      expect.objectContaining({ path: "knowledge/rules/margin.md", change: "modified", before: "Margin is revenue minus cost.\n", after: "Margin is revenue minus cost.\nMargin excludes shipping.\n", appended: "Margin excludes shipping.\n" }),
      expect.objectContaining({ path: "knowledge/rules/revenue.md", change: "modified", before: "Revenue is net of refunds.\n", after: "Revenue is net of refunds.\nRefunds are excluded.\n", appended: "Refunds are excluded.\n" }),
    ]);
    expect(review.receipt).toMatchObject({ image: digest, policy: digest, script: packagedValidatorDigest, protocol: "genbi-validate/1", mdl: { sha256: createHash("sha256").update(mdlText).digest("hex") } });
    expect(review.receipt.changeSetSha256).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(review.snapshot.files.map((file) => file.path)).toContain("project/knowledge/rules/revenue.md");
    expect(review.binding).toMatchObject({ generation: t.f.binding.generation, revision: t.f.binding.revision });
    expect(hashTree(t.f.project)).toBe(before);
    expect(t.f.launched).toEqual([{ purpose: "validate", argv: [...VALIDATOR_ARGV] }]);
    expect(t.f.vaultCalls.value).toBe(0);
    t.settled();
  });
  it.each([
    ["an existing YAML value changed", [operation("models/orders/metadata.yml", MODEL.replace("primary_key: id", "primary_key: customer_id"), "mdl_metric")], "not_additive"],
    ["a YAML list shrunk", [operation("models/orders/metadata.yml", MODEL.replace(/  - name: internal_note[\s\S]*$/, ""), "mdl_metric")], "not_additive"],
    ["a non-description YAML edit", [operation("models/orders/metadata.yml", MODEL.replace("name: orders", "name: renamed"), "mdl_metric")], "not_additive"],
    ["a deleted YAML key", [operation("models/orders/metadata.yml", MODEL.replace("primary_key: id\n", ""), "mdl_metric")], "not_additive"],
    ["duplicate targets", [operation("knowledge/rules/revenue.md", "x"), operation("knowledge/rules/revenue.md", "y")], "duplicate_path"],
    ["a new knowledge file (existing files only)", [operation("knowledge/rules/new.md", "A new rule.")], "unsupported_by_runtime"],
    ["a first relationships.yml", [{ sink: "relationships.yml", changeKind: "new_relationship", summary: "s", draft: "relationships: []\n" }], "unsupported_by_runtime"],
    ["a new model description file", [operation("models/fresh/metadata.yml", "name: fresh\n", "mdl_metric")], "unsupported_by_runtime"],
    ["a new column smuggled through mdl_metric", [operation("models/orders/metadata.yml", `${MODEL}  - name: plain\n    type: DATE\n`, "mdl_metric")], "unsupported_by_runtime"],
  ] as const)("S2-2 host check: %s ends validation_failed evidence and never launches a sandbox", async (_label, operations, code) => {
    const t = await validationFixture({ respond: (request) => echoOk(request) });
    const before = hashTree(t.f.project);
    // Path attacks, >20 operations and single oversize drafts are refused earlier by the contract (and by `buildCandidate` directly, see enrichment-candidate.test.ts).
    const result = await t.validator.validate(t.request([...operations]), t.scope());
    expect(result).toMatchObject({ status: "failed", failure: { stage: "host", code } });
    expect(t.f.launched).toEqual([]); expect(t.f.store.listOpenShellIntents()).toEqual([]);
    expect(hashTree(t.f.project)).toBe(before); t.settled();
  });
  it("S2-2 host check: a symlinked sink in the snapshot source is refused before any sandbox", async () => {
    const t = await validationFixture({ respond: (request) => echoOk(request) });
    const outside = path.join(t.f.root, "outside.md"); writeFileSync(outside, "Revenue is net of refunds.\n");
    const request = t.request([operation("knowledge/rules/revenue.md", "Revenue is net of refunds.\nMore.")]);
    // The swap happens after the snapshot was captured; the manifest-verified read must notice.
    rmSync(path.join(t.f.project, "knowledge/rules/revenue.md")); symlinkSync(outside, path.join(t.f.project, "knowledge/rules/revenue.md"));
    const result = await t.validator.validate(request, t.scope());
    expect(result).toMatchObject({ status: "failed", failure: { stage: "host", code: "source_unreadable" } });
    expect(t.f.launched).toEqual([]); t.settled();
  });
  it("S2-2 validator semantics: a failing check is a validation_failed verdict with sanitized evidence", async () => {
    const message = "Binder Error: column missing_col not found at /sandbox/validate-x/project LINE 1: SELECT SUM(missing_col)";
    const t = await validationFixture({ respond: () => JSON.stringify({ status: "failed", checks: [checkOf("additivity"), checkOf("context_validate"), checkOf("context_build"), { check: "dry_run", status: "fail", code: "dry_run_error", message }] }) });
    const result = await t.validator.validate(t.request(GOOD), t.scope());
    expect(result).toMatchObject({ status: "failed", failure: { stage: "validator", code: "validator_failed" } });
    expect(JSON.stringify(result)).not.toMatch(/\/sandbox|SELECT SUM/); t.settled();
  });
  it("S2-2: a validator change set that differs from the candidate is refused", async () => {
    const t = await validationFixture({ respond: (request) => echoOk(request, { applied: [{ path: "knowledge/rules/new.md", content: "Something the host never sent.\n" }] }) });
    expect(await t.validator.validate(t.request(GOOD), t.scope())).toMatchObject({ status: "failed", failure: { code: "change_set_mismatch" } }); t.settled();
  });
  it.each([
    ["malformed JSON", { respond: () => "not json" }], ["an unknown shape", { respond: () => '{"status":"ok"}' }], ["an oversized line", { respond: () => "x".repeat(600_000) }],
    ["extra output after the result", { respond: (request: Buffer) => echoOk(request), extra: '{"extra":true}\n' }], ["a wrong script digest in the identity line", { respond: (request: Buffer) => echoOk(request), prelude: { ...tuple, script: sha("9") } }],
    ["a non-zero exit", { respond: (request: Buffer) => echoOk(request), exit: 3 }],
  ] as [string, Script][])("S2-2: validator output that is %s is a validation_failed verdict, never validated", async (_label, script) => {
    const t = await validationFixture(script);
    const result = await t.validator.validate(t.request(GOOD), t.scope());
    expect(result).toMatchObject({ status: "failed", failure: { stage: "validator", code: expect.stringMatching(/validator_protocol|validator_identity/) } }); t.settled();
  });
  it.each([
    ["a cube", operation("cubes/metrics/metadata.yml", "name: metrics\n", "new_cube")], ["a view", operation("views/recent/metadata.yml", "name: recent\n", "new_view")],
    ["a calculated column", operation("models/orders/metadata.yml", `${MODEL}  - name: gross\n    type: DOUBLE\n    is_calculated: true\n    expression: amount * 2\n`, "calculated_column")],
  ])("S3-4: %s ends validation_failed(unsupported_by_runtime) on the host before any snapshot is published or sandbox launched", async (_label, op) => {
    const t = await validationFixture({ respond: (request) => echoOk(request) });
    const result = await t.validator.validate(t.request([op]), t.scope());
    expect(result).toMatchObject({ status: "failed", failure: { stage: "host", code: "unsupported_by_runtime" } });
    expect(t.f.launched).toEqual([]); expect(t.f.store.listSnapshotPublications()).toEqual([]); expect(t.f.store.listOpenShellIntents()).toEqual([]); t.settled();
  });
  it("S2-4: with no verified validator the run is unavailable: nothing is launched and no state is written", async () => {
    const t = await validationFixture({ respond: (request) => echoOk(request) }, { validator: false });
    expect(t.validator.available()).toBe(false);
    await expect(t.validator.validate(t.request(GOOD), t.scope())).rejects.toMatchObject({ code: "unavailable" });
    expect(t.f.launched).toEqual([]); expect(t.f.store.listOpenShellIntents()).toEqual([]); expect(t.f.store.listSnapshotPublications()).toEqual([]);
  });
  it("S2-5: cancellation while the sandbox runs throws cancelled and cleans everything; nothing is validated", async () => {
    const t = await validationFixture({ noResult: true }); const controller = new AbortController();
    const pending = t.validator.validate(t.request(GOOD), t.scope({ signal: controller.signal }));
    const rejected = expect(pending).rejects.toMatchObject({ code: "cancelled" });
    await vi.waitFor(() => expect(t.f.launched).toHaveLength(1)); controller.abort(); await rejected; t.settled();
  });
  it("S2-5: a stale scope (binding, generation or settings changed) throws stale and cleans everything", async () => {
    const t = await validationFixture({ noResult: true }); let current = true;
    const pending = t.validator.validate(t.request(GOOD), t.scope({ assertCurrent() { if (!current) throw Error("stale"); } }));
    const rejected = expect(pending).rejects.toMatchObject({ code: "stale" });
    await vi.waitFor(() => expect(t.f.launched).toHaveLength(1)); current = false; t.f.composition.revokeRuntime(); await rejected; t.settled();
  });
  it("S2-5: a timeout throws timeout and cleans everything", async () => {
    const t = await validationFixture({ noResult: true }, { timeoutMs: 300, exchangeTimeoutMs: 5000 });
    await expect(t.validator.validate(t.request(GOOD), t.scope())).rejects.toMatchObject({ code: "timeout" }); t.settled();
  });
  it("S2-5: cleanup uncertainty throws cleanup, never a verdict, even for a result that would have validated", async () => {
    const t = await validationFixture({ respond: (request) => echoOk(request) });
    t.f.removeFails.value = true;
    await expect(t.validator.validate(t.request(GOOD), t.scope())).rejects.toMatchObject({ code: "cleanup" });
    t.f.removeFails.value = false; await t.f.composition.lifecycle!.retryCleanup(); expect(t.f.resources.size).toBe(0);
  });
  it("S2-5: a restart mid-validation leaves the orphan to lifecycle recovery, which cleans it", async () => {
    const t = await validationFixture({ noResult: true }, { timeoutMs: 60_000, exchangeTimeoutMs: 60_000 });
    void t.validator.validate(t.request(GOOD), t.scope()).catch((error: unknown) => error instanceof StructuredRuntimeError);
    await vi.waitFor(() => expect(t.f.launched).toHaveLength(1));
    const successor = await createOpenShellRuntimeCompositionForTesting({ env: t.f.env, selection: openshellClaude, store: t.f.store, stateRoot: path.join(t.f.root, "successor-state"), driver: t.f.driver, currentProject: () => t.f.project, claude: { vault: t.f.vault, duplex: t.f.driver.duplex! } });
    cleanup.push(() => successor.shutdown().catch(() => {}));
    expect(t.f.store.listOpenShellIntents().filter((row) => row.identity.purpose === "validate").every((row) => row.phase === "cleaned")).toBe(true); expect(t.f.resources.size).toBe(0);
  });
});
