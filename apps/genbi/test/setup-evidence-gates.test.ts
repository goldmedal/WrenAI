import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
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

const BARE_DISCOVERY = `WREN_PYTHON="$(sed -n '1s/^#!//p' "$(command -v wren)")"; "$WREN_PYTHON" -c "from wren.profile import resolve_profile_for_project; from wren.connector import x; print('select table_name from information_schema.columns')"`;

function lifecycle(prefix: string, extra: Record<string, unknown> = {}): SetupWorklogEntry[] {
  return [exec(BARE_DISCOVERY, extra), exec(`${prefix}wren context validate`, extra), exec(`${prefix}wren context build`, extra)];
}

describe("cd target variants", () => {
  it.each(["./jaffle", "jaffle/", '"jaffle"', "'jaffle'"])("accepts cd %s", (dir) => {
    expect(parseSetupTerminal("SETUP_STATUS: ok", { ...project(), worklog: lifecycle(`cd ${dir} && `) })).toMatchObject({ status: "ok" });
  });

  it.each(["jaffle/../other", "other", "$(echo jaffle)", "`echo jaffle`", '"$(echo jaffle)"', "~"])("rejects cd %s", (dir) => {
    expect(parseSetupTerminal("SETUP_STATUS: ok", { ...project(), worklog: lifecycle(`cd ${dir} && `) })).toMatchObject({ status: "error" });
  });

  it("accepts a symlink to the project and rejects a symlink to another directory", () => {
    const context = project();
    mkdirSync(path.join(context.root, "other"));
    symlinkSync(path.join(context.root, "jaffle"), path.join(context.root, "to-project"));
    symlinkSync(path.join(context.root, "other"), path.join(context.root, "to-other"));
    expect(parseSetupTerminal("SETUP_STATUS: ok", { ...context, worklog: lifecycle("cd to-project && ") })).toMatchObject({ status: "ok" });
    expect(parseSetupTerminal("SETUP_STATUS: ok", { ...context, worklog: lifecycle("cd to-other && ") })).toMatchObject({ status: "error" });
  });

  it("does not count a write action carrying a lifecycle command string", () => {
    const write: SetupWorklogEntry = {
      label: "setup_execution",
      input: { action: "write", command: "wren context build", path: "x", content: "y" },
      detail: '{"written":true,"path":"x","bytes":1}',
    };
    const worklog = [exec(BARE_DISCOVERY), exec("wren context validate"), write];
    expect(parseSetupTerminal("SETUP_STATUS: ok", { ...project(), worklog })).toMatchObject({ diagnostic: { code: "context_build_missing" } });
  });

  it("does not count a command that merely echoes the lifecycle text", () => {
    const worklog = [exec(BARE_DISCOVERY), exec("cd jaffle && echo wren context validate"), exec("wren context build")];
    expect(parseSetupTerminal("SETUP_STATUS: ok", { ...project(), worklog })).toMatchObject({ status: "error" });
  });
});

describe("explicit cwd binds the evidence to the project", () => {
  it("rejects bare commands recorded with a cwd outside the project and quotes them", () => {
    const worklog = [exec(BARE_DISCOVERY), exec("wren context validate", { cwd: "other" })];
    const result = parseSetupTerminal("SETUP_STATUS: ok", { ...project(), worklog });
    expect(result).toMatchObject({ status: "error", diagnostic: { code: "context_validate_missing" } });
    expect(result.message).toContain("`wren context validate`");
    expect(result.message).toContain("`cwd` field");
  });

  it("rejects discovery recorded with a cwd outside the project", () => {
    const worklog = [exec(BARE_DISCOVERY, { cwd: "other" }), exec("wren context validate"), exec("wren context build")];
    expect(parseSetupTerminal("SETUP_STATUS: ok", { ...project(), worklog })).toMatchObject({ status: "error" });
  });

  it("accepts a cwd naming the project, relative or absolute, and keeps unrecorded cwd as before", () => {
    const context = project();
    const abs = path.join(context.root, "jaffle");
    expect(parseSetupTerminal("SETUP_STATUS: ok", { ...context, worklog: lifecycle("", { cwd: "jaffle" }) })).toMatchObject({ status: "ok" });
    expect(parseSetupTerminal("SETUP_STATUS: ok", { ...context, worklog: lifecycle("", { cwd: abs }) })).toMatchObject({ status: "ok" });
    expect(parseSetupTerminal("SETUP_STATUS: ok", { ...context, worklog: lifecycle("") })).toMatchObject({ status: "ok" });
  });

  it("rejects a cwd of the workspace root for a bare command", () => {
    const context = project();
    expect(parseSetupTerminal("SETUP_STATUS: ok", { ...context, worklog: lifecycle("", { cwd: "." }) })).toMatchObject({ status: "error" });
  });
});

describe("secret redaction in gate messages", () => {
  it("masks env values in a quoted unrecognised command", () => {
    const worklog = [exec(BARE_DISCOVERY), exec("PGPASSWORD=s3cret wren context validate && echo done")];
    const result = parseSetupTerminal("SETUP_STATUS: ok", { ...project(), worklog });
    expect(result.message).toContain("`PGPASSWORD=*** wren context validate && echo done`");
    expect(JSON.stringify(result)).not.toContain("s3cret");
  });

  it.each([
    ["env TOKEN=abc wren context validate; echo", "env TOKEN=*** wren context validate; echo"],
    ["cd other && A=\"x y\" B='z w' wren context validate", "cd other && A=*** B=*** wren context validate"],
    ["echo hi && DB_URL=postgres://u:p@h/db wren context validate ; x", "echo hi && DB_URL=*** wren context validate ; x"],
  ])("redacts %s", (command, expected) => {
    const worklog = [exec(BARE_DISCOVERY), exec(command)];
    const result = parseSetupTerminal("SETUP_STATUS: ok", { ...project(), worklog });
    expect(result.message).toContain(expected);
    expect(JSON.stringify(result)).not.toMatch(/abc|x y|z w|u:p/);
  });

  it("redacts and caps the failed-discovery message", () => {
    const secret = `PGPASSWORD=hunter2 ${BARE_DISCOVERY} # ${"x".repeat(400)}`;
    const worklog = [exec(secret, {}, 1)];
    const result = parseSetupTerminal("SETUP_STATUS: ok", {
      ...project(),
      worklog,
      priorContextLifecycle: "discovery",
    });
    expect(result.diagnostic?.code).toBe("context_schema_discovery_failed");
    expect(result.message).not.toContain("hunter2");
    expect(result.message).toContain("PGPASSWORD=***");
    expect(result.message).toContain("...");
    expect(result.message.length).toBeLessThan(600);
  });

  it("redacts the failed-exec reframing for an agent-reported error", () => {
    const worklog = [exec("SECRET=top wren generate-mdl", {}, 2)];
    const result = parseSetupTerminal("SETUP_STATUS: error - no tables", { ...project(), worklog });
    expect(result.message).toContain("SECRET=***");
    expect(result.message).not.toContain("top ");
  });
});

describe("SETUP_STATUS stays mandatory for other steps", () => {
  it.each(["connect", "connect_resume"])("does not relax a missing status for %s", (stepKey) => {
    const context = project();
    writeFileSync(path.join(context.root, "jaffle", ".wren-validated"), "");
    expect(parseSetupTerminal("done", { ...context, stepKey, worklog: OBSERVED })).toMatchObject({
      status: "error",
      failureKind: "missing_terminal_status",
    });
  });
});
