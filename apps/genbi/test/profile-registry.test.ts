import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../server/db.js";
import {
  ADMISSION_RULES_VERSION,
  BUILTIN_PROFILE_ROLES,
  ProfileRegistry,
  ProfileRegistryError,
  admitCompiledProfile,
  deriveHostCeiling,
  readProfileId,
  validateUserProfileSourcePath,
} from "../server/profile-registry.js";

/**
 * The shipped profiles' committed goldens stand in for a compiler here: every rule in
 * `admitCompiledProfile` is exercised against real IR shapes, and the registry is driven by a fake
 * `compileRaw` that hands back a profile directory's own `ir.golden.json`. The live counterpart,
 * `profile-registry-live.test.ts`, runs the same registry over the real `warble`.
 */
const PROFILES_DIR = fileURLToPath(new URL("../profiles/", import.meta.url));

type Json = Record<string, unknown>;

function golden(profileId: string): Json {
  return JSON.parse(readFileSync(path.join(PROFILES_DIR, profileId, "ir.golden.json"), "utf-8")) as Json;
}

const ceiling = deriveHostCeiling(golden("genbi-default"));

function components(ir: Json): Json[] {
  return ir["components"] as Json[];
}

/** A deep copy of the analysis golden with its id renamed, ready for per-rule mutation. */
function syntheticIr(id: string, mutate?: (ir: Json) => void): Json {
  const ir = structuredClone(golden("genbi-default"));
  ir["profile"] = id;
  mutate?.(ir);
  return ir;
}

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratchDir(label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `genbi-profile-registry-${label}-`));
  scratch.push(dir);
  return dir;
}

/** Writes a user profile directory: `profile.yml` plus the IR the fake compiler will "produce". */
function writeUserProfile(root: string, id: string, ir: Json, yamlOverride?: string): string {
  const dir = path.join(root, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "profile.yml"), yamlOverride ?? `profile: ${id}\n\ncontext:\n  project: ./context/binding.yml\n`);
  writeFileSync(path.join(dir, "ir.golden.json"), JSON.stringify(ir));
  return dir;
}

function fakeCompiler(root: string, calls: string[] = []) {
  return async (source: string): Promise<{ irPath: string }> => {
    calls.push(source);
    const planted = path.join(source, "ir.golden.json");
    if (!existsSync(planted)) throw new Error(`fake warble: ${source} has no ir.golden.json to hand back`);
    const irPath = path.join(root, `ir-${randomUUID()}.json`);
    copyFileSync(planted, irPath);
    return { irPath };
  };
}

function registryFor(root: string, store: Store, options: { identity?: string; calls?: string[] } = {}) {
  return new ProfileRegistry({
    store,
    builtinProfilesDir: PROFILES_DIR,
    userProfilesDir: path.join(root, "workspace", "profiles"),
    compileRaw: fakeCompiler(root, options.calls),
    warbleIdentity: async () => options.identity ?? "warble:test",
  });
}

describe("deriveHostCeiling", () => {
  it("is the capability union of the shipped analysis profile, not a hand-written list", () => {
    const expected = new Set<string>();
    for (const c of components(golden("genbi-default"))) for (const cap of c["required_capabilities"] as string[]) expected.add(cap);
    expect([...ceiling.capabilities].sort()).toEqual([...expected].sort());
    expect(ceiling.capabilities.has("sql_execution:read_only")).toBe(true);
    expect(ceiling.capabilities.has("artifact_write")).toBe(true);
    expect(ceiling.capabilities.has("context_write_authz")).toBe(false);
    expect([...ceiling.tiers].sort()).toEqual(["cheap", "strong"]);
  });

  it("refuses an IR with no components rather than yielding an empty ceiling", () => {
    expect(() => deriveHostCeiling({ profile: "genbi-default", components: [] })).toThrow(/no components/);
  });
});

describe("admitCompiledProfile over the shipped goldens", () => {
  it("admits genbi-default at scope entry: four described, native-eligible components", () => {
    const verdict = admitCompiledProfile(golden("genbi-default"), { expectedId: "genbi-default", ceiling });
    expect(verdict.status).toBe("admitted");
    expect(verdict.reasons).toEqual([]);
    expect(verdict.entry).toEqual({ kind: "scope" });
    expect(verdict.components.filter((c) => c.nativeEligible).map((c) => c.id)).toEqual(["explore_model", "answer_query", "generate_dashboard", "explain_change"]);
    expect(verdict.irVersion).toBeDefined();
  });

  it("admits genbi-report pinned to plan_report, recording that the entry composes: answer_batch is callee-only, so exactly one component is eligible", () => {
    const verdict = admitCompiledProfile(golden("genbi-report"), { expectedId: "genbi-report", ceiling });
    expect(verdict.status).toBe("admitted");
    expect(verdict.entry).toEqual({ kind: "agent", verb: "plan_report" });
    expect(verdict.components.find((c) => c.id === "plan_report")).toMatchObject({ composes: ["ask → answer_batch"] });
    expect(verdict.components.find((c) => c.id === "answer_batch")).toMatchObject({ entrypoint: false, nativeEligible: false, composes: [] });
  });

  it("records composition on the shipped analysis profile too, without judging it: the dispatcher's host requirement is a runtime fact, not a profile fact", () => {
    const verdict = admitCompiledProfile(golden("genbi-default"), { expectedId: "genbi-default", ceiling });
    expect(verdict.status).toBe("admitted");
    expect(verdict.components.find((c) => c.id === "generate_dashboard")).toMatchObject({ composes: ["answer → answer_query"] });
    expect(verdict.components.filter((c) => c.id !== "generate_dashboard").every((c) => c.composes.length === 0)).toBe(true);
  });

  it("refuses genbi-monitor: an assertive scheduled assertion is outside the host's execution scope", () => {
    const verdict = admitCompiledProfile(golden("genbi-monitor"), { expectedId: "genbi-monitor", ceiling });
    expect(verdict.status).toBe("unavailable");
    expect(verdict.reasons.join("\n")).toMatch(/monitor_freshness.*type="assertive", trigger="scheduled", outcome="assertion"/);
    expect(verdict.entry).toBeUndefined();
  });

  it("would refuse genbi-enrich-context as a conversation: a mutation component, foreign capabilities and no descriptions", () => {
    const verdict = admitCompiledProfile(golden("genbi-enrich-context"), { expectedId: "genbi-enrich-context", ceiling });
    expect(verdict.status).toBe("unavailable");
    const reasons = verdict.reasons.join("\n");
    expect(reasons).toMatch(/apply_enrichment.*outcome="mutation"/);
    expect(reasons).toMatch(/outside the host ceiling: .*context_write_authz/);
    expect(reasons).toMatch(/missing on: inspect_context, draft_enrichment/);
  });
});

describe("admitCompiledProfile rules, one mutation each", () => {
  it("rule: the compiled id must match the registered id", () => {
    const verdict = admitCompiledProfile(syntheticIr("someone-else"), { expectedId: "mine", ceiling });
    expect(verdict.status).toBe("unavailable");
    expect(verdict.reasons).toEqual([expect.stringMatching(/compiled profile id "someone-else" does not match the registered id "mine"/)]);
  });

  it("rule 2: a mutating component is refused even when everything else passes", () => {
    const ir = syntheticIr("mine", (ir) => {
      (components(ir)[0]!["effect"] as Json)["outcome"] = { kind: "mutation" };
    });
    const verdict = admitCompiledProfile(ir, { expectedId: "mine", ceiling });
    expect(verdict.status).toBe("unavailable");
    expect(verdict.reasons).toEqual([expect.stringMatching(/explore_model.*outcome="mutation"/)]);
  });

  it("rule 3: a capability the analysis profile never requires is outside the ceiling", () => {
    const ir = syntheticIr("mine", (ir) => {
      (components(ir)[1]!["required_capabilities"] as string[]).push("context_write_authz");
    });
    const verdict = admitCompiledProfile(ir, { expectedId: "mine", ceiling });
    expect(verdict.status).toBe("unavailable");
    expect(verdict.reasons).toEqual([expect.stringMatching(/answer_query.*outside the host ceiling: context_write_authz/)]);
  });

  it("rule 4: a step tier the runtime configuration cannot bind is refused", () => {
    const ir = syntheticIr("mine", (ir) => {
      ((components(ir)[1]!["llm_calls"] as Json[])[0]!)["tier"] = "orchestrator";
    });
    const verdict = admitCompiledProfile(ir, { expectedId: "mine", ceiling });
    expect(verdict.status).toBe("unavailable");
    expect(verdict.reasons).toEqual([expect.stringMatching(/answer_query.*cannot bind: orchestrator \(allowed: cheap, strong\)/)]);
  });

  it("rule 5: scope entry needs a description on every eligible component", () => {
    const ir = syntheticIr("mine", (ir) => {
      delete components(ir)[2]!["description"];
    });
    const verdict = admitCompiledProfile(ir, { expectedId: "mine", ceiling });
    expect(verdict.status).toBe("unavailable");
    expect(verdict.reasons).toEqual([expect.stringMatching(/missing on: generate_dashboard$/)]);
  });

  it("rule 5: exactly one eligible component pins the entry to it, description or not", () => {
    const ir = syntheticIr("mine", (ir) => {
      for (const c of components(ir).slice(1)) c["entrypoint"] = false;
      delete components(ir)[0]!["description"];
    });
    const verdict = admitCompiledProfile(ir, { expectedId: "mine", ceiling });
    expect(verdict.status).toBe("admitted");
    expect(verdict.entry).toEqual({ kind: "agent", verb: "explore_model" });
  });

  it("rule 5: no eligible component at all is refused", () => {
    const ir = syntheticIr("mine", (ir) => {
      for (const c of components(ir)) c["realization_kind"] = "tool";
    });
    const verdict = admitCompiledProfile(ir, { expectedId: "mine", ceiling });
    expect(verdict.status).toBe("unavailable");
    expect(verdict.reasons).toEqual([expect.stringMatching(/no native-eligible component/)]);
  });

  it("an IR that is not an object with components is refused with one reason", () => {
    expect(admitCompiledProfile("nope", { expectedId: "mine", ceiling })).toMatchObject({ status: "unavailable", reasons: [expect.stringMatching(/not an object/)] });
  });
});

describe("readProfileId", () => {
  it("reads a plain, quoted or commented scalar and refuses a duplicate", () => {
    expect(readProfileId("profile: my-conv\ncontext:\n  project: ./x.yml\n")).toBe("my-conv");
    expect(readProfileId('profile: "my-conv"  # the id\n')).toBe("my-conv");
    expect(readProfileId("# profile: commented\nprofile: real\n")).toBe("real");
    expect(readProfileId("profile: a\nprofile: b\n")).toBeUndefined();
    expect(readProfileId("components: []\n")).toBeUndefined();
  });
});

describe("validateUserProfileSourcePath", () => {
  it("rejects every shape that is not an absolute, real directory holding profile.yml outside the registry roots", () => {
    const root = scratchDir("paths");
    const good = writeUserProfile(root, "good", syntheticIr("good"));
    const file = path.join(root, "file.txt");
    writeFileSync(file, "x");
    const noYaml = path.join(root, "no-yaml");
    mkdirSync(noYaml);
    const link = path.join(root, "link");
    symlinkSync(good, link);
    const forbidden = path.join(root, "owned");
    const inside = writeUserProfile(forbidden, "inside", syntheticIr("inside"));

    const check = (value: unknown) => validateUserProfileSourcePath(value, { forbiddenRoots: [forbidden] });
    expect(check(undefined)).toEqual({ ok: false, message: "sourcePath is required" });
    expect(check("   ")).toEqual({ ok: false, message: "sourcePath is required" });
    expect(check("relative/profile")).toMatchObject({ ok: false, message: expect.stringMatching(/absolute/) });
    expect(check(path.join(root, "missing"))).toMatchObject({ ok: false, message: expect.stringMatching(/no such directory/) });
    expect(check(file)).toMatchObject({ ok: false, message: expect.stringMatching(/not a directory/) });
    expect(check(noYaml)).toMatchObject({ ok: false, message: expect.stringMatching(/no profile\.yml/) });
    expect(check(link)).toMatchObject({ ok: false, message: expect.stringMatching(/symbolic link/) });
    expect(check(inside)).toMatchObject({ ok: false, message: expect.stringMatching(/outside the registry's own directories/) });
    expect(check(forbidden + "/")).toMatchObject({ ok: false });
    expect(check(good)).toMatchObject({ ok: true, resolved: good });
  });
});

describe("ProfileRegistry", () => {
  it("registers every shipped profile with its role and verdict, the ceiling profile first", async () => {
    const root = scratchDir("builtins");
    const calls: string[] = [];
    const store = new Store(":memory:");
    const registry = registryFor(root, store, { calls });
    const rows = await registry.list();

    expect(rows.map((r) => r.id)).toEqual(Object.keys(BUILTIN_PROFILE_ROLES).sort((a, b) => (a === "genbi-default" ? -1 : b === "genbi-default" ? 1 : 0)));
    expect(calls[0]).toBe(path.join(PROFILES_DIR, "genbi-default"));
    // System profiles are listed but never compiled through admission.
    expect(calls.some((c) => c.endsWith("genbi-setup") || c.endsWith("genbi-enrich-context"))).toBe(false);

    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(byId["genbi-default"]).toMatchObject({ kind: "builtin", role: "conversation", admissionStatus: "admitted", entryKind: "scope", entryVerb: null });
    expect(byId["genbi-report"]).toMatchObject({ role: "conversation", admissionStatus: "admitted", entryKind: "agent", entryVerb: "plan_report" });
    expect(byId["genbi-monitor"]).toMatchObject({ role: "conversation", admissionStatus: "unavailable", entryKind: null });
    expect(byId["genbi-monitor"]!.admissionReason).toMatch(/assertive/);
    expect(byId["genbi-setup"]).toMatchObject({ role: "system", admissionStatus: "admitted", admissionReason: expect.stringMatching(/system purpose/) });
    expect(byId["genbi-enrich-context"]).toMatchObject({ role: "system" });
    expect(JSON.parse(byId["genbi-default"]!.componentsJson)).toHaveLength(4);

    // Idempotent: a second registry over the same store changes nothing and recompiles nothing.
    const again = registryFor(root, store, { calls });
    const before = calls.length;
    const stable = (list: readonly { updatedAt: string; admittedAt: string | null }[]) => list.map(({ updatedAt: _u, admittedAt: _a, ...rest }) => rest);
    expect(stable(await again.list())).toEqual(stable(rows));
    expect(calls.length).toBe(before + 3); // built-ins are always re-checked; three conversation profiles compile
  });

  it("marks every conversation profile unavailable while the ceiling profile fails to compile, including genbi-default itself", async () => {
    const root = scratchDir("ceiling");
    const store = new Store(":memory:");
    const registry = new ProfileRegistry({
      store,
      builtinProfilesDir: PROFILES_DIR,
      userProfilesDir: path.join(root, "workspace", "profiles"),
      compileRaw: async (source) => {
        if (source.endsWith("genbi-default")) throw new Error("boom: warble exited 1");
        return fakeCompiler(root)(source);
      },
      warbleIdentity: async () => "warble:test",
    });
    const rows = await registry.list();
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(byId["genbi-default"]).toMatchObject({ admissionStatus: "unavailable", admissionReason: expect.stringMatching(/warble compile failed: boom/) });
    expect(byId["genbi-report"]).toMatchObject({ admissionStatus: "unavailable", admissionReason: expect.stringMatching(/host ceiling is unavailable/) });
    expect(byId["genbi-setup"]).toMatchObject({ admissionStatus: "admitted" });
  });

  it("retries a failed compile once, so a transient producer collision does not record a profile as unavailable", async () => {
    const root = scratchDir("retry");
    const store = new Store(":memory:");
    let reportCompiles = 0;
    const flaky = fakeCompiler(root);
    const registry = new ProfileRegistry({
      store,
      builtinProfilesDir: PROFILES_DIR,
      userProfilesDir: path.join(root, "workspace", "profiles"),
      compileRaw: async (source) => {
        if (source.endsWith("genbi-report") && ++reportCompiles === 1) throw new Error("could not finalize the extracted Hub directory (Directory not empty)");
        return flaky(source);
      },
      warbleIdentity: async () => "warble:test",
    });
    const rows = await registry.list();
    expect(rows.find((r) => r.id === "genbi-report")).toMatchObject({ admissionStatus: "admitted", entryVerb: "plan_report" });
    expect(reportCompiles).toBe(2);
  });

  it("records the second failure when a compile fails twice", async () => {
    const root = scratchDir("retry-twice");
    let calls = 0;
    const registry = new ProfileRegistry({
      store: new Store(":memory:"),
      builtinProfilesDir: PROFILES_DIR,
      userProfilesDir: path.join(root, "workspace", "profiles"),
      compileRaw: async (source) => {
        if (source.endsWith("genbi-report")) throw new Error(`attempt ${++calls} failed`);
        return fakeCompiler(root)(source);
      },
      warbleIdentity: async () => "warble:test",
    });
    const report = (await registry.list()).find((r) => r.id === "genbi-report")!;
    expect(calls).toBe(2);
    expect(report).toMatchObject({ admissionStatus: "unavailable", admissionReason: "warble compile failed: attempt 2 failed" });
  });

  it("adds a user profile by directory path: copies it under the workspace, admits it, and serves it as a conversation source", async () => {
    const root = scratchDir("add");
    const store = new Store(":memory:");
    const registry = registryFor(root, store);
    const source = writeUserProfile(path.join(root, "authored"), "my-conv", syntheticIr("my-conv"));

    const row = await registry.add(source);
    expect(row).toMatchObject({ id: "my-conv", kind: "user", role: "conversation", admissionStatus: "admitted", entryKind: "scope" });
    expect(row.sourceDir).toBe(path.join(root, "workspace", "profiles", "my-conv"));
    expect(existsSync(path.join(row.sourceDir, "profile.yml"))).toBe(true);
    expect(row.profileHash).toHaveLength(64);

    const resolved = await registry.resolveConversationProfileSource("my-conv");
    expect(resolved.sourceDir).toBe(row.sourceDir);
    expect((await registry.list()).map((r) => r.id)).toContain("my-conv");
  });

  it("stores an unavailable verdict for a user profile that fails admission, and keeps its copy so the reason stays inspectable", async () => {
    const root = scratchDir("add-refused");
    const registry = registryFor(root, new Store(":memory:"));
    const source = writeUserProfile(path.join(root, "authored"), "wide", syntheticIr("wide", (ir) => {
      (components(ir)[0]!["required_capabilities"] as string[]).push("filesystem_write");
    }));
    const row = await registry.add(source);
    expect(row).toMatchObject({ admissionStatus: "unavailable", admissionReason: expect.stringMatching(/outside the host ceiling: filesystem_write/), entryKind: null });
    await expect(registry.resolveConversationProfileSource("wide")).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/unavailable: .*filesystem_write/) });
    expect(existsSync(row.sourceDir)).toBe(true);
  });

  it("refuses a reserved id, a duplicate id, a malformed id, a path inside its own roots, and a tree with a symlink — leaving no copy behind", async () => {
    const root = scratchDir("add-refusals");
    const registry = registryFor(root, new Store(":memory:"));
    const userDir = path.join(root, "workspace", "profiles");

    const reserved = writeUserProfile(path.join(root, "a"), "genbi-default", syntheticIr("genbi-default"));
    await expect(registry.add(reserved)).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/reserved/) });

    const first = writeUserProfile(path.join(root, "b"), "dup", syntheticIr("dup"));
    await registry.add(first);
    const second = writeUserProfile(path.join(root, "c"), "dup", syntheticIr("dup"));
    await expect(registry.add(second)).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/already registered/) });

    const malformed = writeUserProfile(path.join(root, "d"), "BadId", syntheticIr("BadId"));
    await expect(registry.add(malformed)).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/invalid/) });

    const twoIds = writeUserProfile(path.join(root, "e"), "two", syntheticIr("two"), "profile: two\nprofile: three\n");
    await expect(registry.add(twoIds)).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/exactly one/) });

    await expect(registry.add(path.join(userDir, "dup"))).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/outside the registry's own directories/) });
    await expect(registry.add(path.join(PROFILES_DIR, "genbi-report"))).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/outside the registry's own directories/) });

    const linked = writeUserProfile(path.join(root, "f"), "linked", syntheticIr("linked"));
    symlinkSync(path.join(root, "b", "dup", "profile.yml"), path.join(linked, "escape.yml"));
    await expect(registry.add(linked)).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/symbolic links/) });
    expect(existsSync(path.join(userDir, "linked"))).toBe(false);

    expect((await registry.list()).filter((r) => r.kind === "user").map((r) => r.id)).toEqual(["dup"]);
  });

  it("re-admits a user profile when its bytes change, and when the warble identity changes", async () => {
    const root = scratchDir("readmit");
    const store = new Store(":memory:");
    const calls: string[] = [];
    const registry = registryFor(root, store, { calls, identity: "warble:v1" });
    const row = await registry.add(writeUserProfile(path.join(root, "authored"), "evolving", syntheticIr("evolving")));
    expect(row.admissionStatus).toBe("admitted");

    // Same bytes, same binary: a fresh registry over the same store does not recompile the user profile.
    const unchanged = registryFor(root, store, { calls, identity: "warble:v1" });
    await unchanged.list();
    expect(calls.filter((c) => c.endsWith("evolving"))).toHaveLength(1);

    // The copy the registry owns changes underneath it: the next registry sees the hash move and re-runs admission.
    writeFileSync(path.join(row.sourceDir, "ir.golden.json"), JSON.stringify(syntheticIr("evolving", (ir) => {
      (components(ir)[0]!["trigger"] as Json)["kind"] = "scheduled";
    })));
    const changed = registryFor(root, store, { calls, identity: "warble:v1" });
    const after = (await changed.list()).find((r) => r.id === "evolving")!;
    expect(after).toMatchObject({ admissionStatus: "unavailable", admissionReason: expect.stringMatching(/trigger="scheduled"/), entryKind: null, admittedAt: null });
    expect(after.createdAt).toBe(row.createdAt);
    expect(calls.filter((c) => c.endsWith("evolving"))).toHaveLength(2);

    // A new warble binary re-checks even unchanged bytes.
    const rebuilt = registryFor(root, store, { calls, identity: "warble:v2" });
    await rebuilt.list();
    expect(calls.filter((c) => c.endsWith("evolving"))).toHaveLength(3);
    expect(store.getWarbleProfile("evolving")!.warbleIdentity).toBe("warble:v2");
  });

  it("re-checks an unavailable user profile on the next boot, so a transient failure does not stick", async () => {
    const root = scratchDir("recover");
    const store = new Store(":memory:");
    const authored = writeUserProfile(path.join(root, "authored"), "mine", syntheticIr("mine"));
    const bootWith = (compile: (source: string) => Promise<{ irPath: string }>) => new ProfileRegistry({
      store, builtinProfilesDir: PROFILES_DIR, userProfilesDir: path.join(root, "workspace", "profiles"),
      compileRaw: compile, warbleIdentity: async () => "warble:same",
    });

    // Boot 1: healthy, the profile is admitted.
    const healthy = fakeCompiler(root);
    expect((await bootWith(healthy).add(authored)).admissionStatus).toBe("admitted");

    // Boot 2: the ceiling profile fails to compile twice; the user row is stored unavailable for an environmental reason.
    const broken = async (source: string) => {
      if (source.endsWith("genbi-default")) throw new Error("boom: collided on the Hub cache");
      return healthy(source);
    };
    const afterBoot2 = (await bootWith(broken).list()).find((r) => r.id === "mine")!;
    expect(afterBoot2).toMatchObject({ admissionStatus: "unavailable", admissionReason: expect.stringMatching(/host ceiling is unavailable/) });

    // Boot 3: healthy again, same bytes, same binary. The row must be re-admitted rather than skipped as unchanged.
    const afterBoot3 = (await bootWith(healthy).list()).find((r) => r.id === "mine")!;
    expect(afterBoot3).toMatchObject({ admissionStatus: "admitted", entryKind: "scope", admissionReason: null });
    expect(afterBoot3.createdAt).toBe(afterBoot2.createdAt);
  });

  it("keeps serving the registry when one user directory cannot be hashed, marking only that row", async () => {
    const root = scratchDir("unreadable");
    const store = new Store(":memory:");
    const registry = registryFor(root, store);
    const row = await registry.add(writeUserProfile(path.join(root, "authored"), "odd", syntheticIr("odd")));
    // Replace the owned directory with a regular file: it still exists, but it is not a directory any more.
    rmSync(row.sourceDir, { recursive: true, force: true });
    writeFileSync(row.sourceDir, "not a directory");
    const rows = await registryFor(root, store).list();
    expect(rows.find((r) => r.id === "odd")).toMatchObject({ admissionStatus: "unavailable", admissionReason: expect.stringMatching(/re-admission failed/) });
    expect(rows.find((r) => r.id === "genbi-default")).toMatchObject({ admissionStatus: "admitted" });
  });

  it("claims the destination before copying, so a leftover directory or a concurrent add of the same id is refused and leaves no merge", async () => {
    const root = scratchDir("claim");
    const store = new Store(":memory:");
    const registry = registryFor(root, store);
    const first = writeUserProfile(path.join(root, "a"), "same", syntheticIr("same"));
    writeFileSync(path.join(first, "from-a.txt"), "a");
    const second = writeUserProfile(path.join(root, "b"), "same", syntheticIr("same"));
    writeFileSync(path.join(second, "from-b.txt"), "b");
    const results = await Promise.allSettled([registry.add(first), registry.add(second)]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toMatchObject({ status: 409 });
    const copy = path.join(root, "workspace", "profiles", "same");
    expect(existsSync(path.join(copy, "profile.yml"))).toBe(true);
    // Whichever source won, the copy is exactly one source — never a merge of both.
    const fromA = existsSync(path.join(copy, "from-a.txt"));
    const fromB = existsSync(path.join(copy, "from-b.txt"));
    expect(fromA !== fromB).toBe(true);

    // A directory left behind (no store row) is refused with 409 rather than silently merged into.
    mkdirSync(path.join(root, "workspace", "profiles", "leftover"));
    const leftover = writeUserProfile(path.join(root, "c"), "leftover", syntheticIr("leftover"));
    await expect(registry.add(leftover)).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/already exists/) });
  });

  it("re-admits an admitted user profile whose verdict was computed under an older rule set, even with unchanged bytes and binary", async () => {
    const root = scratchDir("rules-version");
    const store = new Store(":memory:");
    const calls: string[] = [];
    const row = await registryFor(root, store, { calls }).add(writeUserProfile(path.join(root, "authored"), "aged", syntheticIr("aged")));
    expect(row.rulesVersion).toBe(ADMISSION_RULES_VERSION);
    // Simulate a database written by a host whose rule set predates the current one.
    store.upsertWarbleProfile({ ...row, rulesVersion: ADMISSION_RULES_VERSION - 1 });
    const before = calls.filter((c) => c.endsWith("aged")).length;
    const after = (await registryFor(root, store, { calls }).list()).find((r) => r.id === "aged")!;
    expect(calls.filter((c) => c.endsWith("aged")).length).toBe(before + 1);
    expect(after.rulesVersion).toBe(ADMISSION_RULES_VERSION);
    expect(after.admissionStatus).toBe("admitted");
  });

  it("marks a user profile whose directory disappeared as unavailable instead of dropping it", async () => {
    const root = scratchDir("vanished");
    const store = new Store(":memory:");
    const row = await registryFor(root, store).add(writeUserProfile(path.join(root, "authored"), "gone", syntheticIr("gone")));
    rmSync(row.sourceDir, { recursive: true, force: true });
    const after = (await registryFor(root, store).list()).find((r) => r.id === "gone")!;
    expect(after).toMatchObject({ admissionStatus: "unavailable", admissionReason: expect.stringMatching(/directory is missing/) });
  });

  it("removes a user profile and its copy, but never a built-in or a profile a native session ran inside", async () => {
    const root = scratchDir("remove");
    const store = new Store(":memory:");
    const registry = registryFor(root, store);
    const a = await registry.add(writeUserProfile(path.join(root, "x"), "removable", syntheticIr("removable")));
    const b = await registry.add(writeUserProfile(path.join(root, "y"), "in-use", syntheticIr("in-use")));
    store.createNativeSession({ id: "native-session-00000000-0000-4000-8000-000000000001", purpose: "analysis", vendor: "claude", agent: "in-use", scopeKind: "bound_project", scopeId: "scope-1", dispatchProfile: "in-use" });

    await expect(registry.remove("genbi-default")).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/built in/) });
    await expect(registry.remove("missing")).rejects.toMatchObject({ status: 404 });
    await expect(registry.remove("in-use")).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/referenced by 1 native session /) });
    expect(existsSync(b.sourceDir)).toBe(true);

    await registry.remove("removable");
    expect(store.getWarbleProfile("removable")).toBeUndefined();
    expect(existsSync(a.sourceDir)).toBe(false);
    expect(existsSync(path.dirname(a.sourceDir))).toBe(true);
  });

  it("resolves only admitted conversation profiles as a session source", async () => {
    const root = scratchDir("resolve");
    const registry = registryFor(root, new Store(":memory:"));
    expect((await registry.resolveConversationProfileSource("genbi-default")).sourceDir).toBe(path.join(PROFILES_DIR, "genbi-default"));
    await expect(registry.resolveConversationProfileSource("genbi-setup")).rejects.toBeInstanceOf(ProfileRegistryError);
    await expect(registry.resolveConversationProfileSource("genbi-setup")).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/system purpose/) });
    await expect(registry.resolveConversationProfileSource("genbi-monitor")).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/unavailable: .*assertive/) });
    await expect(registry.resolveConversationProfileSource("nope")).rejects.toMatchObject({ status: 404 });
  });
});
