import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type ExecFileCallback = (error: (Error & { code?: string }) | null, stdout: string, stderr: string) => void;
const execFileMock = vi.fn<(file: string, args: readonly string[], options: unknown, callback: ExecFileCallback) => void>();
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFile: (...args: unknown[]) => (execFileMock as (...a: unknown[]) => void)(...args) };
});

const { verifyAdoptProject } = await import("../server/adopt.js");
const { loadProjectManifest } = await import("../server/conn-config.js");

const SUPPORTED = new Set(["duckdb", "postgres"]);

// The scaffold `wren context init --data-source duckdb` writes (core/wren/src/wren/context_cli.py):
//   "data_source: {data_source}\n"  (a project later edited by hand keeps trailing comments)
// and, when no data source is given:
//   "data_source:  # not set yet — `wren profile add`/`set-profile` will fill this in\n"
const COMMENTED_DATA_SOURCE = "data_source: duckdb  # change to your datasource type";
const UNSET_DATA_SOURCE = "data_source:  # not set yet — `wren profile add`/`set-profile` will fill this in";

let projectDir: string;
let wrenHomeDir: string;
let originalWrenHome: string | undefined;

beforeEach(() => {
  projectDir = mkdtempSync(path.join(tmpdir(), "manifest-scalar-"));
  wrenHomeDir = mkdtempSync(path.join(tmpdir(), "manifest-scalar-home-"));
  originalWrenHome = process.env.WREN_HOME;
  process.env.WREN_HOME = wrenHomeDir;
  execFileMock.mockReset();
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
  rmSync(wrenHomeDir, { recursive: true, force: true });
  if (originalWrenHome === undefined) delete process.env.WREN_HOME;
  else process.env.WREN_HOME = originalWrenHome;
});

function writeManifest(...lines: string[]): void {
  writeFileSync(path.join(projectDir, "wren_project.yml"), ["schema_version: 5", "name: my_project", ...lines].join("\n") + "\n");
}

describe("wren_project.yml scalars are read as YAML values, not raw lines", () => {
  it("accepts a data_source followed by an inline comment (the scaffolded shape)", async () => {
    writeManifest(COMMENTED_DATA_SOURCE);
    writeFileSync(path.join(wrenHomeDir, "profiles.yml"), "profiles:\n  p1:\n    datasource: duckdb\n");
    const result = await verifyAdoptProject(projectDir, { supportedSourceTypes: SUPPORTED });
    expect(result).toMatchObject({ status: "needs_profile", sourceType: "duckdb" });
  });

  it("treats a comment-only data_source as unset, never as the comment text", async () => {
    writeManifest(UNSET_DATA_SOURCE);
    const result = await verifyAdoptProject(projectDir, { supportedSourceTypes: SUPPORTED });
    expect(result.status === "error" && result.message).toContain("has no data_source: field");
  });

  it("reads a profile pin that carries an inline comment", async () => {
    writeManifest("data_source: duckdb", "profile: p1  # pinned by set-profile");
    execFileMock.mockImplementation((_f, _a, _o, cb) => cb(null, "Valid", ""));
    const result = await verifyAdoptProject(projectDir, { supportedSourceTypes: SUPPORTED });
    expect(result).toMatchObject({ status: "ok", sourceType: "duckdb" });
  });

  it("loadProjectManifest drops the comment and treats a comment-only value as absent", () => {
    writeManifest(COMMENTED_DATA_SOURCE, "profile:  # none yet");
    expect(loadProjectManifest(projectDir)).toEqual({ dataSource: "duckdb" });
  });
});
