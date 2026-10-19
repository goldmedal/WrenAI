import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  PI_CERTIFIED_ROWS, componentDrift, evaluatePiCertification, installedComponents, openShellVendorCertificationSchema, piCertificationSchema, piImagePinsSchema,
  shippedPiTemplateDigests, type InstalledComponents, type PiCertification, type PiObservedIdentity,
} from "../server/runtime-host/openshell-vendor-certification.js";

const assets = new URL("../runtime-assets/pi-worker/", import.meta.url);
const certificationRoot = new URL("../certification/pi-1.0.4-darwin-arm64/", import.meta.url);
const sha = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const file = (name: string, root = assets) => readFileSync(new URL(name, root));
const row = (): PiCertification => structuredClone(piCertificationSchema.parse(PI_CERTIFIED_ROWS[0]));
const installedFor = (certified: PiCertification): InstalledComponents => ({
  "@warble/cli": certified.dependencies.warble, "@warble/codex-local": certified.dependencies.warble, "@warble/claude-agent-sdk": certified.dependencies.warble,
  "@warble/ir-spec": certified.dependencies.ir, "@wrenai/context-loader": certified.dependencies["context-loader"],
});
const observedFor = (certified: PiCertification): PiObservedIdentity => ({
  host: { ...certified.host }, gateway: { ...certified.gateway }, pins: structuredClone(certified.image.pins), templates: { ...certified.image.templates }, conformance: { policy: true, profile: true },
});
const evaluate = (observed: PiObservedIdentity, rows: readonly unknown[], certified = row()) => evaluatePiCertification(observed, rows, installedFor(certified));

describe("the pi certification row", () => {
  it("is exactly one frozen, schema-valid certified_row for darwin-arm64", () => {
    expect(PI_CERTIFIED_ROWS).toHaveLength(1); expect(Object.isFrozen(PI_CERTIFIED_ROWS)).toBe(true);
    const parsed = openShellVendorCertificationSchema.parse(PI_CERTIFIED_ROWS[0]);
    expect(parsed).toMatchObject({ state: "certified_row", vendor: "pi", host: { platform: "darwin", arch: "arm64" }, imageArch: "linux-arm64" });
  });
  it("is ready only on an exact match of host, OpenShell build, image pins, templates and conformance", () => {
    const certified = row();
    expect(evaluate(observedFor(certified), [certified])).toEqual({ ready: true, version: certified.image.pins.piVersion });
  });
  it.each([
    ["tested_baseline", (value: Record<string, unknown>) => { value["state"] = "tested_baseline"; }],
    ["a missing state", (value: Record<string, unknown>) => { delete value["state"]; }],
    ["an unknown field", (value: Record<string, unknown>) => { value["minimumVersion"] = "1.0.0"; }],
    ["a missing evidence block", (value: Record<string, unknown>) => { delete value["evidence"]; }],
    ["a placeholder evidence digest", (value: Record<string, unknown>) => { (value["evidence"] as Record<string, unknown>)["releaseApprovalSha256"] = "pending"; }],
    ["a partial pins record", (value: Record<string, unknown>) => { delete ((value["image"] as Record<string, Record<string, unknown>>)["pins"] as Record<string, unknown>)["piBundle"]; }],
    ["another vendor", (value: Record<string, unknown>) => { value["vendor"] = "claude"; }],
  ])("never admits %s, however exactly the observation matches", (_name, mutate) => {
    const certified = row(); const invalid = structuredClone(certified) as unknown as Record<string, unknown>; mutate(invalid);
    expect(evaluate(observedFor(certified), [invalid], certified)).toEqual({ ready: false, code: "pi_uncertified" });
  });
  it("is uncertified with no rows at all and with an empty or garbage list", () => {
    const certified = row();
    for (const rows of [[], [null], ["row"], [{}]]) expect(evaluate(observedFor(certified), rows, certified)).toEqual({ ready: false, code: "pi_uncertified" });
  });
  it.each([
    ["another platform", (o: PiObservedIdentity) => ({ ...o, host: { ...o.host, platform: "linux" } })],
    ["another architecture", (o: PiObservedIdentity) => ({ ...o, host: { ...o.host, arch: "x64" } })],
    ["another OpenShell version", (o: PiObservedIdentity) => ({ ...o, gateway: { ...o.gateway, version: "0.0.1" } })],
    ["another OpenShell executable", (o: PiObservedIdentity) => ({ ...o, gateway: { ...o.gateway, executableSha256: "0".repeat(64) } })],
  ])("has no row for %s", (_name, change) => {
    const certified = row();
    expect(evaluate(change(observedFor(certified)), [certified], certified)).toEqual({ ready: false, code: "pi_uncertified" });
  });
  it.each(Object.keys(piImagePinsSchema.shape))("is an identity mismatch when the image's %s pin differs", (key) => {
    const certified = row(); const observed = observedFor(certified); (observed.pins as Record<string, string>)[key] = key === "nodeVersion" ? "v1.2.3" : key === "piVersion" ? "9.9.9" : "f".repeat(64);
    expect(evaluate(observed, [certified], certified)).toEqual({ ready: false, code: "pi_identity_mismatch" });
  });
  it.each([
    ["an extra pin", (pins: Record<string, unknown>) => { pins["extra"] = "f".repeat(64); }],
    ["a missing pin", (pins: Record<string, unknown>) => { delete pins["shim"]; }],
    ["a malformed pin", (pins: Record<string, unknown>) => { pins["worker"] = "NOT-A-DIGEST"; }],
  ])("is an identity mismatch for %s", (_name, mutate) => {
    const certified = row(); const observed = observedFor(certified); mutate(observed.pins as Record<string, unknown>);
    expect(evaluate(observed, [certified], certified)).toEqual({ ready: false, code: "pi_identity_mismatch" });
  });
  it.each([null, undefined, "pins", [], 7])("is an identity mismatch when the pins record is %j", (pins) => {
    const certified = row(); expect(evaluate({ ...observedFor(certified), pins }, [certified], certified)).toEqual({ ready: false, code: "pi_identity_mismatch" });
  });
  it.each([
    ["policy templates", (o: PiObservedIdentity) => ({ ...o, templates: { ...o.templates, policy: "0".repeat(64) } })],
    ["profile templates", (o: PiObservedIdentity) => ({ ...o, templates: { ...o.templates, profile: "0".repeat(64) } })],
    ["a policy that is not an instance of the template", (o: PiObservedIdentity) => ({ ...o, conformance: { ...o.conformance, policy: false } })],
    ["a profile that is not an instance of the template", (o: PiObservedIdentity) => ({ ...o, conformance: { ...o.conformance, profile: false } })],
  ])("is an identity mismatch for %s", (_name, change) => {
    const certified = row(); expect(evaluate(change(observedFor(certified)), [certified], certified)).toEqual({ ready: false, code: "pi_identity_mismatch" });
  });
  it("accepts any one of several rows for the same build, and denies when none matches the image", () => {
    const first = row(); const second = row(); second.image.pins.piVersion = "1.0.5"; second.image.pins.worker = "e".repeat(64);
    expect(evaluate(observedFor(second), [first, second], second)).toMatchObject({ ready: true, version: "1.0.5" });
    const third = observedFor(first); (third.pins as Record<string, string>)["workerCore"] = "d".repeat(64);
    expect(evaluate(third, [first, second], first)).toEqual({ ready: false, code: "pi_identity_mismatch" });
  });
  it.each([
    ["@warble/cli", "0.0.1"], ["@warble/codex-local", "0.0.1"], ["@warble/claude-agent-sdk", "0.0.1"], ["@warble/ir-spec", "0.0.1"], ["@wrenai/context-loader", "0.0.1"],
  ] as const)("denies a matching image when %s drifted to %s, naming only the package versions", (name, version) => {
    const certified = row(); const installed = { ...installedFor(certified), [name]: version };
    const verdict = evaluatePiCertification(observedFor(certified), [certified], installed);
    expect(verdict).toMatchObject({ ready: false, code: "pi_dependencies_drifted" });
    expect((verdict as unknown as { drift: string[] }).drift).toEqual([expect.stringContaining(name)]);
  });
  it("checks identity before drift, so a mismatched image never reports drift", () => {
    const certified = row(); const observed = observedFor(certified); (observed.pins as Record<string, string>)["shim"] = "a".repeat(64);
    expect(evaluatePiCertification(observed, [certified], { ...installedFor(certified), "@warble/cli": "0.0.1" })).toEqual({ ready: false, code: "pi_identity_mismatch" });
  });
  it("treats an unresolved or unreadable component manifest as drift and falls back to the declared pin only when it cannot resolve at all", () => {
    const certified = row();
    expect(componentDrift(certified.dependencies, { ...installedFor(certified), "@warble/cli": "unreadable" })).toHaveLength(1);
    expect(componentDrift(certified.dependencies, { ...installedFor(certified), "@wrenai/context-loader": undefined })[0]).toContain("unresolved");
    const resolved = installedComponents({ resolve: () => "/manifest", read: () => JSON.stringify({ version: "9.9.9" }), declared: () => "1.0.0" });
    expect(Object.values(resolved)).toEqual(Array(5).fill("9.9.9"));
    expect(Object.values(installedComponents({ resolve: () => undefined, declared: () => "1.0.0" }))).toEqual(Array(5).fill("1.0.0"));
    expect(Object.values(installedComponents({ resolve: () => "/manifest", read: () => "{ not json", declared: () => "1.0.0" }))).toEqual(Array(5).fill("unreadable"));
  });
});

// Local absolute paths, tracker ids and address literals have no place in a published evidence record; the pattern is assembled so this file does not itself spell them.
const LEAKS = new RegExp([...["Users", "private", "home", "var/folders", "tmp"].map(dir => `/${dir}/`), ...["TASK", "NIM"].map(prefix => `${prefix}-`), "\\.local\\b", "\\b\\d{1,3}(?:\\.\\d{1,3}){3}\\b"].join("|"));

describe("the pi certification row is bound to what this package ships", () => {
  const pins = row().image.pins;
  it.each([
    ["worker", "pi-worker.mjs"], ["workerCore", "pi-worker-core.mjs"], ["shim", "pi-mcp-shim.mjs"], ["procCheck", "pi-proc-check.mjs"], ["sessionStep", "pi-session-step.mjs"],
    ["stepControl", "pi-step-control.mjs"], ["trust", "claude-worker-ca.mjs"], ["pins", "pi-pins.mjs"], ["lockfile", "package-lock.json"],
  ] as const)("pins %s to the digest of %s", (key, name) => { expect(pins[key]).toBe(sha(file(name))); });
  it("pins the pi version to the lockfile root and the package manifest, and the Node base to the Dockerfile", () => {
    expect(JSON.parse(file("package.json").toString()).dependencies["@earendil-works/pi-coding-agent"]).toBe(pins.piVersion);
    expect(JSON.parse(file("package-lock.json").toString()).packages["node_modules/@earendil-works/pi-coding-agent"].version).toBe(pins.piVersion);
    const from = /^FROM (\S+)$/m.exec(file("Dockerfile").toString())![1]!;
    expect(from).toBe(row().image.nodeBase); expect(from.startsWith(`node:${pins.nodeVersion.slice(1)}-slim@`)).toBe(true);
    expect(file("Dockerfile").toString()).toContain(`= "${pins.piVersion}"`);
  });
  it("pins the shipped policy and profile templates", () => { expect(shippedPiTemplateDigests()).toEqual(row().image.templates); });
  it("binds the three evidence digests to the exact bytes of the reviewed evidence files", () => {
    const evidence = row().evidence;
    for (const [name, digest] of [["deterministic.json", evidence.deterministicProbesSha256], ["candidate-acceptance.json", evidence.packedAcceptanceSha256], ["local-approval.json", evidence.releaseApprovalSha256]] as const)
      expect(sha(file(name, certificationRoot))).toBe(digest);
  });
  it("records evidence for exactly this row, with no model call and no local path, host name or address", () => {
    const certified = row(); const read = (name: string) => file(name, certificationRoot).toString();
    const deterministic = JSON.parse(read("deterministic.json")); const approval = JSON.parse(read("local-approval.json")); const candidate = JSON.parse(read("candidate-acceptance.json"));
    expect(deterministic).toMatchObject({ kind: "deterministic_pi_evidence", modelCalls: 0, vendor: "pi", piVersion: certified.image.pins.piVersion, gateway: certified.gateway, dependencies: certified.dependencies });
    expect(approval).toMatchObject({ kind: "local_exact_identity_approval", vendor: "pi", gateway: certified.gateway, image: certified.image, dependencies: certified.dependencies,
      deterministicProbesSha256: certified.evidence.deterministicProbesSha256, packedAcceptanceSha256: certified.evidence.packedAcceptanceSha256 });
    expect(candidate).toMatchObject({ vendor: "pi", dependencies: certified.dependencies });
    for (const name of ["deterministic.json", "candidate-acceptance.json", "local-approval.json", "installed-acceptance.json", "README.md"])
      expect(read(name), name).not.toMatch(LEAKS);
  });
});
