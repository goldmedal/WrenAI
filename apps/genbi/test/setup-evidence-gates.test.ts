import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseSetupTerminal } from "../harness/setup/runner.js";
import type { SetupTerminalContext, SetupWorklogEntry } from "../harness/setup/runner.js";

const DISCOVERY =
  `cd jaffle && WREN_PYTHON="$(sed -n '1s/^#!//p' "$(command -v wren)")"; "$WREN_PYTHON" -c "from pathlib import Path; from wren.profile import resolve_profile_for_project; from wren.connector import x; print('select table_name from information_schema.columns')"`;

function exec(command: string, extra: Record<string, unknown> = {}, exitCode = 0): SetupWorklogEntry {
  return { label: "setup_execution", input: { command, ...extra }, detail: `{"exitCode":${exitCode},"stdout":"","stderr":""}` };
}

function project(): SetupTerminalContext {
  const root = mkdtempSync(path.join(tmpdir(), "genbi-evidence-"));
  mkdirSync(path.join(root, "jaffle", "target"), { recursive: true });
  writeFileSync(path.join(root, "jaffle", "wren_project.yml"), "name: jaffle\n");
  writeFileSync(path.join(root, "jaffle", "target", "mdl.json"), JSON.stringify({ models: [{ name: "customers" }] }));
  return { root, name: "jaffle", stepKey: "context" };
}

const OBSERVED = [exec(DISCOVERY), exec("cd jaffle && wren context validate"), exec("cd jaffle && wren context build")];

describe("context gate judges success from execution evidence", () => {
  it("accepts the observed cd-prefixed worklog with SETUP_STATUS", () => {
    expect(parseSetupTerminal("SETUP_STATUS: ok - built", { ...project(), worklog: OBSERVED })).toEqual({ status: "ok", message: "built" });
  });

  it("accepts the same worklog without any SETUP_STATUS line", () => {
    expect(parseSetupTerminal("All done, built the project.", { ...project(), worklog: OBSERVED })).toMatchObject({ status: "ok" });
  });

  it("still fails a missing SETUP_STATUS when the evidence is incomplete", () => {
    expect(parseSetupTerminal("done", { ...project(), worklog: OBSERVED.slice(0, 2) })).toMatchObject({
      status: "error",
      failureKind: "missing_terminal_status",
    });
  });

  it("still fails a missing SETUP_STATUS when the project is not built", () => {
    const context = project();
    const empty = { ...context, root: mkdtempSync(path.join(tmpdir(), "genbi-evidence-empty-")) };
    expect(parseSetupTerminal("done", { ...empty, worklog: OBSERVED })).toMatchObject({ status: "error", failureKind: "missing_terminal_status" });
  });

  it("fails SETUP_STATUS: ok when the worklog lacks build", () => {
    expect(parseSetupTerminal("SETUP_STATUS: ok - built", { ...project(), worklog: OBSERVED.slice(0, 2) })).toMatchObject({
      status: "error",
      diagnostic: { code: "context_build_missing" },
    });
  });

  it("keeps an explicit SETUP_STATUS: error even when the evidence says success", () => {
    expect(parseSetupTerminal("SETUP_STATUS: error - gave up", { ...project(), worklog: OBSERVED })).toEqual({
      status: "error",
      message: "gave up",
    });
  });

  it("quotes an unrecognised cd to another directory and points at the cwd field", () => {
    const worklog = [exec(DISCOVERY), exec("cd other && wren context validate")];
    const result = parseSetupTerminal("SETUP_STATUS: ok", { ...project(), worklog });
    expect(result).toMatchObject({ status: "error", diagnostic: { code: "context_validate_missing" } });
    expect(result.message).toContain("`cd other && wren context validate`");
    expect(result.message).toContain("`cwd` field");
    expect(result.message).not.toMatch(/did not successfully run/);
    expect(result.diagnostic?.expectedArtifactContract.join(" ")).toContain("`cwd` field");
  });

  it("does not recognise shell sequencing after the lifecycle command", () => {
    const worklog = [exec(DISCOVERY), exec("cd jaffle && wren context validate; rm x")];
    const result = parseSetupTerminal("SETUP_STATUS: ok", { ...project(), worklog });
    expect(result).toMatchObject({ status: "error", diagnostic: { code: "context_validate_missing" } });
    expect(result.message).toContain("rm x");
  });

  it("does not recognise multiple && chains or a discovery in another directory", () => {
    const chained = [exec(DISCOVERY), exec("cd jaffle && cd jaffle && wren context validate")];
    expect(parseSetupTerminal("SETUP_STATUS: ok", { ...project(), worklog: chained })).toMatchObject({
      diagnostic: { code: "context_validate_missing" },
    });
    const otherDiscovery = [exec(DISCOVERY.replace("cd jaffle", "cd other")), exec("wren context validate"), exec("wren context build")];
    expect(parseSetupTerminal("SETUP_STATUS: ok", { ...project(), worklog: otherDiscovery })).toMatchObject({
      diagnostic: { code: "context_lifecycle_out_of_order" },
    });
  });

  it("resolves cd against an explicit cwd", () => {
    const context = project();
    const worklog = [
      exec(DISCOVERY),
      exec("cd .. && wren context validate", { cwd: "jaffle" }),
      exec("cd jaffle && wren context build", { cwd: "." }),
    ];
    expect(parseSetupTerminal("SETUP_STATUS: ok", { ...context, worklog })).toMatchObject({ status: "error" });
    const good = [exec(DISCOVERY), exec("cd jaffle && wren context validate", { cwd: "." }), exec("cd . && wren context build", { cwd: "jaffle" })];
    expect(parseSetupTerminal("SETUP_STATUS: ok", { ...context, worklog: good })).toMatchObject({ status: "ok" });
  });
});
