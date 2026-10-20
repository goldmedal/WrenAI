import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { LOCAL_PI_CERTIFIED_ROWS, localPiCertificationSchema } from "../server/runtime-host/local-pi-certification.js";
import { packagedPiAssets } from "../server/runtime-host/local-pi-install.js";
import { PI_CERTIFIED_ROWS } from "../server/runtime-host/openshell-vendor-certification.js";

const root = path.resolve(process.cwd());
const directory = path.join(root, "certification", "pi-local-1.0.4-darwin-arm64-node24");
const bytes = (name: string) => readFileSync(path.join(directory, name));
const sha = (name: string) => createHash("sha256").update(bytes(name)).digest("hex");
const json = (name: string) => JSON.parse(bytes(name).toString("utf8")) as Record<string, any>;
const row = localPiCertificationSchema.parse(LOCAL_PI_CERTIFIED_ROWS[0]);

describe("the packaged local pi row is bound to the repository and to its committed evidence", () => {
  it("is the only packaged local row: darwin arm64, Node major 24, pi 1.0.4, a strict certified_row", () => {
    expect(LOCAL_PI_CERTIFIED_ROWS).toHaveLength(1);
    expect(row).toMatchObject({ state: "certified_row", vendor: "pi-local", host: { platform: "darwin", arch: "arm64" }, nodeMajor: 24, install: { pins: { piVersion: "1.0.4" } } });
  });
  it("pins the lockfile, package.json, relay and pi version this package ships", () => {
    const assets = packagedPiAssets();
    expect(row.install.pins).toMatchObject({ piVersion: assets.piVersion, lockfile: assets.lockfileSha256, packageJson: assets.packageJsonSha256, shim: assets.shimSha256 });
  });
  it("records the Warble, IR and context-loader versions this package declares", () => {
    const declared = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).dependencies as Record<string, string>;
    expect(row.dependencies).toEqual({ warble: declared["@warble/cli"], ir: declared["@warble/ir-spec"], "context-loader": declared["@wrenai/context-loader"] });
  });
  it("hashes the approval record, which hashes the evidence it cites", () => {
    expect(row.evidence.approvalSha256).toBe(sha("local-approval.json"));
    const approval = json("local-approval.json");
    expect(approval).toMatchObject({ kind: "local_exact_identity_approval", date: "2026-10-20", vendor: "pi-local", nodeMajor: 24, host: { platform: "darwin", arch: "arm64" } });
    expect(approval.deterministicProbeSha256).toBe(sha("deterministic.json"));
    expect(approval.liveRunSha256).toBe(sha("live-run.json"));
    expect(approval.packedAcceptanceSha256).toBe(sha("candidate-acceptance.json"));
    expect(approval.install.pins).toEqual(row.install.pins); expect(approval.dependencies).toEqual(row.dependencies);
    expect(approval.authority).toContain("project owner approved packaging this certification row on 2026-10-20");
  });
  it("claims no real model and no real key anywhere", () => {
    expect(json("local-approval.json").realModelAcceptance).toMatch(/^None\./);
    for (const name of ["deterministic.json", "live-run.json", "candidate-acceptance.json", "installed-acceptance.json"]) expect(json(name).modelCalls, name).toBe(0);
  });
  it("the evidence records succeeded under Node 24 on darwin arm64", () => {
    const deterministic = json("deterministic.json");
    expect(deterministic).toMatchObject({ ok: true, vendor: "pi-local", node: { major: 24 }, host: { platform: "darwin", arch: "arm64" }, piVersion: "1.0.4" });
    expect(deterministic.checks.length).toBeGreaterThanOrEqual(9); expect(deterministic.checks.every((check: { ok: boolean }) => check.ok)).toBe(true);
    const live = json("live-run.json");
    expect(live.node.major).toBe(24);
    expect(live.phases.readinessCertified).toMatchObject({ state: "ready", ask: true });
    expect(live.phases.ask).toMatchObject({ persistedAnswerEvents: 1, answer: { verified: true, forgedValueInAnswer: false } });
    expect(live.phases.piSideEvidence).toMatchObject({ sampledFilesContainingDummyKey: 0, psLinesContainingDummyKey: 0, psShowsStepTokenVariable: true });
    expect(live.phases.stub).toMatchObject({ allCarriedDummyKey: true, anyCarriedStepToken: false });
    expect(live.phases.tampered.code).toBe("pi_identity_mismatch"); expect(live.phases.sameMajorOtherBoot_node23.pi.code).toBe("pi_uncertified");
    for (const name of ["candidate-acceptance.json", "installed-acceptance.json"]) { const acceptance = json(name); expect(acceptance.ok, name).toBe(true); expect(acceptance.checks.every((check: { ok: boolean }) => check.ok), name).toBe(true); }
  });
  it("the committed records carry no local path or key", () => {
    for (const name of readdirSync(directory)) expect(bytes(name).toString("utf8"), name).not.toMatch(/\/Users\/|\/private\/|\/home\/|\/var\/folders|sk-[A-Za-z0-9]{8,}|probe-[a-f0-9]{48}/);
  });
  it("the OpenShell rows and their certification directory are a different record", () => {
    expect(PI_CERTIFIED_ROWS).toHaveLength(1); expect((PI_CERTIFIED_ROWS[0] as { vendor: string }).vendor).toBe("pi");
  });
});
