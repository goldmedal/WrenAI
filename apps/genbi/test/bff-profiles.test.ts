import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../server/app.js";
import { Store } from "../server/db.js";
import { ProfileRegistry } from "../server/profile-registry.js";
import type { TurnDeps } from "../server/turn.js";
import type { RouteOptions } from "../harness/index.js";
import type { WarbleProfileDto, WarbleProfileListDto } from "../server/wire-types.js";

const PROFILES_DIR = fileURLToPath(new URL("../profiles/", import.meta.url));

const BASE_ROUTE_OPTIONS: Omit<RouteOptions, "question" | "onEvent"> = {
  authChoice: { mode: "api-key", adapter: "mock" },
  profileSource: "/fixture/profile",
  userProject: "/fixture/project",
};

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function buildApp() {
  const root = mkdtempSync(path.join(tmpdir(), "genbi-bff-profiles-"));
  scratch.push(root);
  const store = new Store(":memory:");
  const profileRegistry = new ProfileRegistry({
    store,
    builtinProfilesDir: PROFILES_DIR,
    userProfilesDir: path.join(root, "workspace", "profiles"),
    compileRaw: async (source) => {
      const irPath = path.join(root, `ir-${randomUUID()}.json`);
      copyFileSync(path.join(source, "ir.golden.json"), irPath);
      return { irPath };
    },
    warbleIdentity: async () => "warble:test",
  });
  const deps: TurnDeps = {
    store,
    route: async () => { throw new Error("route() must never be invoked by /api/profiles"); },
    baseRouteOptions: BASE_ROUTE_OPTIONS,
    profileRegistry,
  };
  return { app: createApp(deps), store, root };
}

function authoredProfile(root: string, id: string): string {
  const dir = path.join(root, "authored", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "profile.yml"), `profile: ${id}\n`);
  const ir = JSON.parse(require("node:fs").readFileSync(path.join(PROFILES_DIR, "genbi-default", "ir.golden.json"), "utf-8")) as Record<string, unknown>;
  ir["profile"] = id;
  writeFileSync(path.join(dir, "ir.golden.json"), JSON.stringify(ir));
  return dir;
}

describe("/api/profiles", () => {
  it("lists the shipped profiles with role, admission and selectability, hiding paths for built-ins", async () => {
    const { app } = buildApp();
    const res = await app.request("/api/profiles");
    expect(res.status).toBe(200);
    const body = (await res.json()) as WarbleProfileListDto;
    const byId = Object.fromEntries(body.profiles.map((p) => [p.id, p]));
    expect(Object.keys(byId).sort()).toEqual(["genbi-default", "genbi-enrich-context", "genbi-monitor", "genbi-report", "genbi-setup"]);
    expect(byId["genbi-default"]).toMatchObject({ kind: "builtin", role: "conversation", selectable: true, admission: { status: "admitted" }, entry: { kind: "scope" } });
    expect(byId["genbi-default"]!.components.map((c) => c.id)).toEqual(["explore_model", "answer_query", "generate_dashboard", "explain_change"]);
    expect(byId["genbi-report"]).toMatchObject({ selectable: false, admission: { status: "unavailable", reason: expect.stringMatching(/composition is not dispatchable/) } });
    expect(byId["genbi-monitor"]).toMatchObject({ selectable: false, admission: { status: "unavailable", reason: expect.stringMatching(/assertive/) } });
    expect(byId["genbi-setup"]).toMatchObject({ role: "system", selectable: false, admission: { status: "admitted", reason: expect.stringMatching(/system purpose/) } });
    for (const profile of body.profiles) expect(profile).not.toHaveProperty("sourceDir");
  });

  it("registers a user profile from an absolute directory path and reports where its copy lives", async () => {
    const { app, root } = buildApp();
    const source = authoredProfile(root, "team-kpis");
    const res = await app.request("/api/profiles", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sourcePath: source }) });
    expect(res.status).toBe(201);
    const { profile } = (await res.json()) as { profile: WarbleProfileDto };
    expect(profile).toMatchObject({ id: "team-kpis", kind: "user", role: "conversation", selectable: true, entry: { kind: "scope" } });
    expect(profile.sourceDir).toBe(path.join(root, "workspace", "profiles", "team-kpis"));
    expect(existsSync(path.join(profile.sourceDir!, "profile.yml"))).toBe(true);

    const list = (await (await app.request("/api/profiles")).json()) as WarbleProfileListDto;
    expect(list.profiles.map((p) => p.id)).toContain("team-kpis");
  });

  it("rejects a malformed registration body and an invalid path with 400, and a reserved id with 409", async () => {
    const { app, root } = buildApp();
    const post = (body: string) => app.request("/api/profiles", { method: "POST", headers: { "content-type": "application/json" }, body });
    expect((await post("not json")).status).toBe(400);
    expect((await post(JSON.stringify({ sourcePath: "/x", extra: 1 }))).status).toBe(400);
    expect((await post(JSON.stringify({}))).status).toBe(400);
    const relative = await post(JSON.stringify({ sourcePath: "profiles/genbi-default" }));
    expect(relative.status).toBe(400);
    expect(await relative.json()).toEqual({ error: expect.stringMatching(/absolute path/) });
    const missing = await post(JSON.stringify({ sourcePath: path.join(root, "nowhere") }));
    expect(missing.status).toBe(400);
    expect(await missing.json()).toEqual({ error: expect.stringMatching(/no such directory/) });
    const reserved = await post(JSON.stringify({ sourcePath: authoredProfile(root, "genbi-report") }));
    expect(reserved.status).toBe(409);
    expect(await reserved.json()).toEqual({ error: expect.stringMatching(/reserved/) });
  });

  it("deletes a user profile with 204, refuses a built-in with 409 and an unknown id with 404", async () => {
    const { app, root, store } = buildApp();
    const source = authoredProfile(root, "temporary");
    const created = await app.request("/api/profiles", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sourcePath: source }) });
    const { profile } = (await created.json()) as { profile: WarbleProfileDto };

    expect((await app.request("/api/profiles/genbi-default", { method: "DELETE" })).status).toBe(409);
    expect((await app.request("/api/profiles/never-registered", { method: "DELETE" })).status).toBe(404);

    const deleted = await app.request("/api/profiles/temporary", { method: "DELETE" });
    expect(deleted.status).toBe(204);
    expect(existsSync(profile.sourceDir!)).toBe(false);
    expect(store.getWarbleProfile("temporary")).toBeUndefined();
  });

  it("refuses to delete a profile a native session ran inside", async () => {
    const { app, root, store } = buildApp();
    await app.request("/api/profiles", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sourcePath: authoredProfile(root, "historic") }) });
    store.createNativeSession({ id: "native-session-00000000-0000-4000-8000-000000000002", purpose: "analysis", vendor: "claude", agent: "historic", scopeKind: "bound_project", scopeId: "scope-2", dispatchProfile: "historic" });
    const res = await app.request("/api/profiles/historic", { method: "DELETE" });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: expect.stringMatching(/referenced by 1 native session/) });
  });

  it("answers 503 on every verb when no registry is configured", async () => {
    const app = createApp({ store: new Store(":memory:"), route: async () => { throw new Error("unreachable"); }, baseRouteOptions: BASE_ROUTE_OPTIONS });
    expect((await app.request("/api/profiles")).status).toBe(503);
    expect((await app.request("/api/profiles", { method: "POST", body: "{}" })).status).toBe(503);
    expect((await app.request("/api/profiles/x", { method: "DELETE" })).status).toBe(503);
  });
});
