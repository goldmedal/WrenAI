import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const probe = new URL("../scripts/pi-backend-probe.mjs", import.meta.url).pathname;
const run = (args: string[]) => spawnSync(process.execPath, [probe, ...args], { env: { PATH: "/usr/bin:/bin" }, encoding: "utf8" });

describe("scripts/pi-backend-probe.mjs", () => {
  it("passes offline with no gateway, no docker and no model call, and reports only what it checked", () => {
    const result = run(["--offline"]); expect(result.status, result.stderr).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report).toMatchObject({ kind: "deterministic_pi_evidence", vendor: "pi", mode: "offline", modelCalls: 0, ok: true });
    expect(report.checks.map((check: { name: string }) => check.name)).toEqual(expect.arrayContaining([
      "certification row is a strict certified_row", "shipped pi assets hash to the certified pins and templates", "the certified row is ready for exactly its own observation",
      "operator helper dry run plans, runs nothing and prints the provider command with a placeholder",
    ]));
    expect(report.checks.every((check: { ok: boolean }) => check.ok)).toBe(true);
    expect(result.stdout).not.toMatch(/\/Users\/|\/private\/|\/var\/folders|\/tmp\//);
  });
  it("refuses to run against a gateway without a descriptor directory, and never as a half-offline run", () => {
    expect(run([]).status).not.toBe(0); expect(run(["--dir", "relative"]).status).not.toBe(0);
    const missing = run(["--dir", "/nonexistent-probe-directory"]); expect(missing.status).toBe(1);
    expect(JSON.parse(missing.stdout)).toMatchObject({ ok: false, mode: "gateway", failure: expect.stringContaining("descriptor") });
  });
});
