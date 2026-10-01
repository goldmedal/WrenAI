import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { createInMemoryCompileCache } from "../harness/compile/cache.js";
import { compileRawProfile } from "../harness/compile/pipeline.js";
import { resolveWarbleBinary } from "../harness/compile/resolve-binary.js";
import { getWarbleIdentity } from "../harness/compile/warble-identity.js";
import { Store } from "../server/db.js";
import { ProfileRegistry } from "../server/profile-registry.js";

/**
 * The registry over the real pinned `warble`: every shipped profile is compiled and admitted the
 * way a booting BFF does it. This is the one place the admission verdicts for `genbi-report` and
 * `genbi-monitor` are observed rather than predicted from their committed goldens.
 */
const PROFILES_DIR = fileURLToPath(new URL("../profiles/", import.meta.url));
const root = mkdtempSync(path.join(tmpdir(), "genbi-profile-registry-live-"));

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("ProfileRegistry over the real warble", () => {
  it("admits genbi-default (scope) and genbi-report (pinned to plan_report), refuses genbi-monitor, lists the two system profiles", async () => {
    const warbleBin = await resolveWarbleBinary();
    const registry = new ProfileRegistry({
      store: new Store(":memory:"),
      builtinProfilesDir: PROFILES_DIR,
      userProfilesDir: path.join(root, "profiles"),
      compileRaw: (source) => compileRawProfile({ profileSource: source, mode: "native", warbleBin, cache: createInMemoryCompileCache() }),
      warbleIdentity: () => getWarbleIdentity(warbleBin),
    });
    const rows = await registry.list();
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));

    expect(byId["genbi-default"]).toMatchObject({ role: "conversation", admissionStatus: "admitted", entryKind: "scope", admissionReason: null });
    expect(byId["genbi-default"]!.irVersion).toMatch(/^\d+\.\d+/);
    expect(byId["genbi-report"]).toMatchObject({ role: "conversation", admissionStatus: "admitted", entryKind: "agent", entryVerb: "plan_report" });
    expect(byId["genbi-monitor"]).toMatchObject({ role: "conversation", admissionStatus: "unavailable", entryKind: null });
    expect(byId["genbi-monitor"]!.admissionReason).toMatch(/monitor_freshness.*assertive/);
    expect(byId["genbi-setup"]).toMatchObject({ role: "system", admissionStatus: "admitted" });
    expect(byId["genbi-enrich-context"]).toMatchObject({ role: "system", admissionStatus: "admitted" });
    expect(byId["genbi-default"]!.warbleIdentity).toBe(await getWarbleIdentity(warbleBin));
  }, 180_000);
});
