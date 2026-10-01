import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { CODEX_BASELINE_VERSION, CODEX_CERTIFIED_ROWS, CODEX_REQUIRED_CONTRACTS, evaluateCodexIdentity, installedCodexDependencies, isCodexExecutionCertified, isCodexTerminalCertified, type CodexCertification, type CodexInstalledDependencies, type CodexObservedIdentity } from "../server/runtime-host/codex-compatibility.js";
import { runtimeNotReady, sanitizeRuntimeReadiness } from "../server/runtime-host/policy.js";

const row: CodexCertification = {
  state: "certified_row", platform: "darwin-arm64", version: CODEX_BASELINE_VERSION,
  executableSha256: "a".repeat(64), source: "https://example.invalid/codex-exact-fixture",
  executionScope: { models: ["gpt-5.5"], entries: ["answer_query"] },
  protocolSha256: "b".repeat(64), contracts: [...CODEX_REQUIRED_CONTRACTS],
  evidence: { deterministicProbesSha256: "c".repeat(64), packedAcceptanceSha256: "d".repeat(64), releaseApprovalSha256: "e".repeat(64) },
  dependencies: { warble: "1.2.3", ir: "4.5.6", "context-loader": "7.8.9" },
};
const installed: CodexInstalledDependencies = {
  "@warble/cli": "1.2.3", "@warble/codex-local": "1.2.3", "@warble/claude-agent-sdk": "1.2.3",
  "@warble/ir-spec": "4.5.6", "@wrenai/context-loader": "7.8.9",
};
const evidenceRoot = new URL("../certification/codex-0.156.1-darwin-arm64/", import.meta.url);
const acceptedDependencies = (name: string) => JSON.parse(readFileSync(new URL(name, evidenceRoot), "utf8")).dependencies;
const observed: CodexObservedIdentity = {
  platform: "darwin-arm64", versionOutput: `codex-cli ${CODEX_BASELINE_VERSION}\n`,
  executableSha256: row.executableSha256, source: row.source,
  protocolSha256: row.protocolSha256, contracts: row.contracts,
};
describe("Codex exact certification", () => {
  it("records exactly the dependencies both hashed acceptance records were produced with", () => {
    for (const name of ["candidate-acceptance.json", "terminal-candidate-acceptance.json"]) {
      expect(acceptedDependencies(name)).toEqual(CODEX_CERTIFIED_ROWS[0]!.dependencies);
    }
  });
  it("admits a certified row only while every installed component matches its record", () => {
    expect(evaluateCodexIdentity(observed, [row], installed)).toMatchObject({ readiness: { state: "ready" } });
    expect(evaluateCodexIdentity(observed, [row], installed)).not.toHaveProperty("drift");
  });
  it.each([
    [{ "@warble/cli": "1.2.4" }, ["@warble/cli: certified 1.2.3, installed 1.2.4"]],
    [{ "@warble/codex-local": "1.2.4" }, ["@warble/codex-local: certified 1.2.3, installed 1.2.4"]],
    [{ "@warble/claude-agent-sdk": undefined }, ["@warble/claude-agent-sdk: certified 1.2.3, installed unresolved"]],
    [{ "@warble/ir-spec": "4.6.0" }, ["@warble/ir-spec: certified 4.5.6, installed 4.6.0"]],
    [{ "@wrenai/context-loader": "7.9.0" }, ["@wrenai/context-loader: certified 7.8.9, installed 7.9.0"]],
    [{ "@warble/cli": "2.0.0", "@warble/codex-local": "2.0.0", "@warble/claude-agent-sdk": "2.0.0", "@wrenai/context-loader": "8.0.0" }, [
      "@warble/cli: certified 1.2.3, installed 2.0.0", "@warble/codex-local: certified 1.2.3, installed 2.0.0",
      "@warble/claude-agent-sdk: certified 1.2.3, installed 2.0.0", "@wrenai/context-loader: certified 7.8.9, installed 8.0.0"]],
  ])("denies a drifted install %o even though identity, protocol and evidence verify", (change, drift) => {
    const result = evaluateCodexIdentity(observed, [row], { ...installed, ...change });
    expect(result.readiness).toMatchObject({ state: "incompatible", code: "codex_dependencies_drifted" });
    expect(result.drift).toEqual(drift);
    expect(result.readiness).toEqual(runtimeNotReady("codex-app-server", "incompatible", "codex_dependencies_drifted"));
  });
  it("keeps the drift reason and its fixed text through the browser-safe readiness projection", () => {
    const denied = evaluateCodexIdentity(observed, [row], { ...installed, "@warble/ir-spec": "4.6.0" });
    expect(sanitizeRuntimeReadiness("codex-app-server", denied.readiness)).toEqual(denied.readiness);
    expect(denied.readiness).toMatchObject({ message: expect.stringContaining("re-certify") });
  });
  it("prefers installed manifests and falls back to the declared pin only when a manifest is unresolvable", () => {
    const declared = (name: string) => `declared-${name}`;
    expect(installedCodexDependencies((name) => name === "@warble/ir-spec" ? undefined : "9.9.9", declared)).toEqual({
      "@warble/cli": "9.9.9", "@warble/codex-local": "9.9.9", "@warble/claude-agent-sdk": "9.9.9",
      "@warble/ir-spec": "declared-@warble/ir-spec", "@wrenai/context-loader": "9.9.9",
    });
    expect(installedCodexDependencies(() => undefined, () => undefined)).toEqual({});
  });
  it("gives the live install the verdict its declared pins and the certified record imply", () => {
    // Pins the gate's behaviour across a dependency bump instead of failing CI on one:
    // equal pins admit the production row, any drift denies it naming each drifted pin.
    const declared = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).dependencies;
    const record = acceptedDependencies("candidate-acceptance.json");
    expect(acceptedDependencies("terminal-candidate-acceptance.json")).toEqual(record);
    const certifiedFor = { "@warble/cli": record.warble, "@warble/codex-local": record.warble, "@warble/claude-agent-sdk": record.warble,
      "@warble/ir-spec": record.ir, "@wrenai/context-loader": record["context-loader"] } as Record<string, string>;
    const live = installedCodexDependencies();
    for (const name of Object.keys(certifiedFor)) expect(live[name as keyof typeof live]).toBe(declared[name]);
    const expected = Object.entries(certifiedFor).filter(([name, version]) => declared[name] !== version)
      .map(([name, version]) => `${name}: certified ${version}, installed ${declared[name]}`);
    const certified = CODEX_CERTIFIED_ROWS[0]!;
    const result = evaluateCodexIdentity({ platform: certified.platform, versionOutput: `codex-cli ${certified.version}`,
      executableSha256: certified.executableSha256, source: certified.source, protocolSha256: certified.protocolSha256,
      contracts: certified.contracts });
    if (expected.length === 0) expect(result).toMatchObject({ readiness: { state: "ready" } });
    else expect(result).toMatchObject({ readiness: { code: "codex_dependencies_drifted" }, drift: expected });
  });
  it("requires separate terminal evidence in addition to driver certification", () => {
    const check = (value: unknown, model = "gpt-5.5", entry = "answer_query") => isCodexTerminalCertified(row.source, row.executableSha256, [model], entry, [value]);
    expect(check(row)).toBe(false);
    const terminal = { transport: "remote-tui-v1", deterministicProbesSha256: "f".repeat(64), packedAcceptanceSha256: "a".repeat(64), releaseApprovalSha256: "b".repeat(64) };
    expect(check({ ...row, terminal })).toBe(true);
    expect(check({ ...row, terminal }, "other")).toBe(false);
    expect(check({ ...row, terminal }, "gpt-5.5", "generate_dashboard")).toBe(false);
    expect(check({ ...row, terminal: { ...terminal, releaseApprovalSha256: "pending" } })).toBe(false);
  });
  it("denies unknown source identities even when the certified version matches", () => {
    expect(CODEX_CERTIFIED_ROWS).toHaveLength(1);
    expect(evaluateCodexIdentity(observed).readiness).toMatchObject({ code: "codex_identity_uncertified" });
  });
  it("binds the exact packaged identity to reviewed evidence and local approval", () => {
    const certified = CODEX_CERTIFIED_ROWS[0]!;
    for (const [file, digest] of [
      ["deterministic.json", certified.evidence.deterministicProbesSha256],
      ["candidate-acceptance.json", certified.evidence.packedAcceptanceSha256],
      ["local-approval.json", certified.evidence.releaseApprovalSha256],
    ]) expect(createHash("sha256").update(readFileSync(new URL(file!, evidenceRoot))).digest("hex")).toBe(digest);
    const approval = JSON.parse(readFileSync(new URL("local-approval.json", evidenceRoot), "utf8"));
    expect(approval).toMatchObject({ executableSha256: certified.executableSha256, source: certified.source,
      protocolSha256: certified.protocolSha256, deterministicProbesSha256: certified.evidence.deterministicProbesSha256,
      packedAcceptanceSha256: certified.evidence.packedAcceptanceSha256 });
    const exact = { platform: certified.platform, versionOutput: `codex-cli ${certified.version}`,
      executableSha256: certified.executableSha256, source: certified.source, protocolSha256: certified.protocolSha256,
      contracts: certified.contracts };
    const { warble, ir, "context-loader": loader } = certified.dependencies;
    const asCertified = { "@warble/cli": warble, "@warble/codex-local": warble, "@warble/claude-agent-sdk": warble, "@warble/ir-spec": ir, "@wrenai/context-loader": loader };
    expect(evaluateCodexIdentity(exact, CODEX_CERTIFIED_ROWS, asCertified).readiness.state).toBe("ready");
    expect(evaluateCodexIdentity({ ...exact, executableSha256: "f".repeat(64) }, CODEX_CERTIFIED_ROWS, asCertified).readiness.state).not.toBe("ready");
  });
  it("binds terminal admission to its separate reviewed evidence", () => {
    const row = CODEX_CERTIFIED_ROWS[0]!;
    const evidence = new URL("../certification/codex-0.156.1-darwin-arm64/", import.meta.url);
    expect(row.terminal?.transport).toBe("remote-tui-v1");
    for (const [file, digest] of [
      ["terminal-deterministic.json", row.terminal!.deterministicProbesSha256],
      ["terminal-candidate-acceptance.json", row.terminal!.packedAcceptanceSha256],
      ["terminal-local-approval.json", row.terminal!.releaseApprovalSha256],
    ]) expect(createHash("sha256").update(readFileSync(new URL(file!, evidence))).digest("hex")).toBe(digest);
    expect(isCodexTerminalCertified(row.source, row.executableSha256, ["gpt-5.5"], "answer_query")).toBe(true);
    expect(isCodexTerminalCertified(row.source, row.executableSha256, ["gpt-5.5"], "generate_dashboard")).toBe(false);
    const { terminal: _, ...driverOnly } = row;
    expect(isCodexTerminalCertified(row.source, row.executableSha256, ["gpt-5.5"], "answer_query", [driverOnly])).toBe(false);
  });
  it("accepts only complete matching fixture evidence without mutating the production matrix", () => {
    expect(evaluateCodexIdentity(observed, [row], installed).readiness.state).toBe("ready");
    expect(evaluateCodexIdentity(observed, undefined, installed).readiness.state).not.toBe("ready");
  });
  it("admits only the approved models and root entry for the exact identity", () => {
    const certified = CODEX_CERTIFIED_ROWS[0]!;
    const scope = (models: string[], entry = "answer_query") => isCodexExecutionCertified(certified.source, certified.executableSha256, models, entry);
    expect(scope(["gpt-5.5", "gpt-5.5", "gpt-5.5"])).toBe(true);
    expect(scope(["gpt-5.5", "gpt-6-luna"])).toBe(false);
    expect(scope(["gpt-5.5"], "generate_dashboard")).toBe(false);
    expect(scope([])).toBe(false);
    expect(isCodexExecutionCertified("https://example.invalid/other", certified.executableSha256, ["gpt-5.5"], "answer_query")).toBe(false);
  });
  it.each([
    [{ platform: "linux-arm64" }, "runtime_platform_unsupported"],
    [{ versionOutput: "codex-cli 0.147.0" }, "codex_cli_version_unsupported"],
    [{ versionOutput: "secret /private/path 0.156.1" }, "codex_cli_version_malformed"],
    [{ executableSha256: "f".repeat(64) }, "codex_identity_uncertified"],
    [{ source: "https://example.invalid/other-source" }, "codex_identity_uncertified"],
    [{ protocolSha256: "f".repeat(64) }, "codex_app_server_protocol_incompatible"],
    [{ contracts: CODEX_REQUIRED_CONTRACTS.filter((name) => name !== "protected_read") }, "codex_sandbox_policy_unavailable"],
  ])("rejects mismatch with browser-safe diagnostics", (mutation, code) => {
    const result = evaluateCodexIdentity({ ...observed, ...mutation }, [row], installed);
    expect(result.readiness).toMatchObject({ code });
    expect(JSON.stringify(result)).not.toContain("/private");
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(JSON.stringify(result)).not.toContain(row.source);
  });
  it.each([
    { ...row, state: "tested_baseline" },
    { ...row, evidence: undefined },
    { ...row, executionScope: undefined },
    { ...row, contracts: ["initialize"] },
    { ...row, executableSha256: "staged" },
    { ...row, source: "http://example.invalid/insecure" },
    { ...row, evidence: { ...row.evidence, releaseApprovalSha256: "pending" } },
    { ...row, dependencies: undefined },
    { ...row, dependencies: { warble: "^1.2.3", ir: "4.5.6", "context-loader": "7.8.9" } },
  ])("rejects partial or unapproved certification", (invalid) => {
    expect(evaluateCodexIdentity(observed, [invalid], installed).readiness).toMatchObject({ code: "codex_identity_uncertified" });
  });
});
