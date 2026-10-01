import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { createInMemoryCompileCache } from "../harness/compile/cache.js";
import { compileRawProfile } from "../harness/compile/pipeline.js";
import { resolveWarbleBinary } from "../harness/compile/resolve-binary.js";
import { getWarbleIdentity } from "../harness/compile/warble-identity.js";
import { Store } from "../server/db.js";
import { admitCompiledProfile, deriveHostCeiling, ProfileRegistry } from "../server/profile-registry.js";
import { dispatchNativeArtifacts, readNativeLaunchSpec, type NativeProfileSelection } from "../server/native-sessions.js";
import { attestNativeExecutable, buildNativeChildEnvironment } from "../server/native-runtime-spec.js";

/**
 * The producer's half of a selected-profile launch, against the real pinned `warble`: a user
 * profile authored from the shipped analysis profile is compiled, admitted by the registry, and
 * dispatched to `claude-code:interactive` with the entry form admission decided. The host then
 * validates the emitted launch spec exactly as a launch would. This is the one place the
 * cross-repository contract for a NON-default profile is observed rather than mirrored.
 */
const PROFILES_DIR = fileURLToPath(new URL("../profiles/", import.meta.url));
const WELCOME = "Help me analyze this data. Ask me what question I want to answer about the server-bound project.";
const root = mkdtempSync(path.join(tmpdir(), "genbi-native-profile-live-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** A profile mounting a subset of the shipped analysis components, under its own id. */
function authorProfile(id: string, keep: readonly string[]): string {
  const dir = path.join(root, "authored", id);
  cpSync(path.join(PROFILES_DIR, "genbi-default"), dir, { recursive: true });
  rmSync(path.join(dir, "ir.golden.json"), { force: true });
  const yaml = readFileSync(path.join(dir, "profile.yml"), "utf-8").replace("profile: genbi-default", `profile: ${id}`);
  const lines = yaml.split("\n"); const out: string[] = []; let skip = false;
  for (const line of lines) {
    const mount = /^\s*- use: (\S+)/.exec(line);
    if (mount) skip = !keep.includes(mount[1]!);
    if (!skip) out.push(line);
  }
  writeFileSync(path.join(dir, "profile.yml"), out.join("\n"));
  return dir;
}

describe("a selected profile through the real warble producer", () => {
  it("compiles, is admitted, dispatches at the admitted entry, and the host accepts the emitted launch spec", async () => {
    const warbleBin = await resolveWarbleBinary();
    const compile = (source: string) => compileRawProfile({ profileSource: source, mode: "native", warbleBin, cache: createInMemoryCompileCache() });
    const registry = new ProfileRegistry({
      store: new Store(":memory:"), builtinProfilesDir: PROFILES_DIR, userProfilesDir: path.join(root, "workspace", "profiles"),
      compileRaw: compile, warbleIdentity: () => getWarbleIdentity(warbleBin),
    });
    const ceiling = deriveHostCeiling(JSON.parse(readFileSync((await compile(path.join(PROFILES_DIR, "genbi-default"))).irPath, "utf-8")));

    const cases: { id: string; keep: string[]; expectEntry: NativeProfileSelection["entry"] }[] = [
      { id: "genbi-explore", keep: ["explore_model", "answer_query"], expectEntry: { kind: "scope" } },
      { id: "genbi-survey", keep: ["explore_model"], expectEntry: { kind: "agent", verb: "explore_model" } },
    ];
    for (const testCase of cases) {
      const row = await registry.add(authorProfile(testCase.id, testCase.keep));
      expect(row, testCase.id).toMatchObject({ admissionStatus: "admitted", entryKind: testCase.expectEntry.kind, entryVerb: testCase.expectEntry.kind === "agent" ? testCase.expectEntry.verb : null });
      const compiled = await compile(row.sourceDir);
      expect(admitCompiledProfile(JSON.parse(readFileSync(compiled.irPath, "utf-8")), { expectedId: testCase.id, ceiling }).entry).toEqual(testCase.expectEntry);

      const cwd = realpathSync(mkdtempSync(path.join(root, `out-${testCase.id}-`)));
      const scopeId = `live-${testCase.id}`;
      const selection: NativeProfileSelection = { id: testCase.id, sourceDir: row.sourceDir, entry: testCase.expectEntry };
      const entry = testCase.expectEntry.kind === "scope" ? { kind: "scope", prompt: WELCOME } : { verb: testCase.expectEntry.verb, prompt: WELCOME };
      const scope = { version: "3", kind: "bound_project", scope_id: scopeId, cwd, entry, binding: { project_identity: "live-project", generation: "1", revision: "live-revision" } };
      const mcp = { version: "1" as const, url: "http://127.0.0.1:0/api/native-sessions/mcp", credential: "live-nonsecret" };
      const producer = attestNativeExecutable("producer", warbleBin);
      await dispatchNativeArtifacts({
        warbleBin, producer: { executable: producer.executable, identity: producer.digest }, irPath: compiled.irPath, target: "claude-code:interactive", cwd, purpose: "analysis", scope, mcp,
        env: buildNativeChildEnvironment({ toolDirectories: [path.dirname(process.execPath), path.dirname(warbleBin)], home: realpathSync(tmpdir()) }),
      });

      const launch = readNativeLaunchSpec(cwd, "analysis", "claude", scopeId, undefined, mcp, undefined, undefined, undefined, undefined, selection);
      expect(launch.version).toBe("4");
      expect(launch.argv).toEqual(testCase.expectEntry.kind === "scope" ? [WELCOME] : ["--agent", testCase.expectEntry.verb, WELCOME]);
      const emitted = JSON.parse(readFileSync(path.join(cwd, ".warble", "interactive-launch.json"), "utf-8")) as { agent: { kind: string; name: string } };
      expect(emitted.agent).toEqual(testCase.expectEntry.kind === "scope" ? { kind: "claude_scope", name: testCase.id } : { kind: "claude_agent", name: testCase.expectEntry.verb });

      // The same artifact read as the DEFAULT profile is refused: the host contract fails closed on the id.
      expect(() => readNativeLaunchSpec(cwd, "analysis", "claude", scopeId, undefined, mcp)).toThrow(/incompatible/);
    }
    mkdirSync(path.join(root, "done"));
  }, 240_000);
});
