import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../server/db.js";
import { InteractiveTerminalManager, type PtyFactory } from "../server/interactive-terminal.js";
import { NativeSessionService, type NativeProfileSelection, type NativeSessionServiceOptions } from "../server/native-sessions.js";
import { initializeNativeSessionStateBase } from "../server/native-session-workspace.js";
import { createApp } from "../server/app.js";
import type { TurnDeps } from "../server/turn.js";
import type { RouteOptions } from "../harness/index.js";
import { buildNativeLaunchSpec } from "./native-launch-spec.js";

/**
 * An analysis session may start inside a conversation profile the registry admitted. These tests
 * drive the service with a fake producer that echoes the declared entry into the launch spec, the
 * way the real dispatcher does, so the host's own launch-spec validation is what passes or fails.
 */
const WELCOME = "Help me analyze this data. Ask me what question I want to answer about the server-bound project.";
const dirs: string[] = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

function scratch(label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `genbi-native-profile-${label}-`));
  dirs.push(dir);
  return dir;
}

function projectFixture() {
  const dir = scratch("project");
  mkdirSync(path.join(dir, ".warble"));
  writeFileSync(path.join(dir, "RUN.md"), "handoff");
  const binding = { identity: "fixture-project", generation: 7, revision: "sha256:fixture", path: dir };
  const irPath = path.join(dir, "analysis.json");
  writeFileSync(irPath, JSON.stringify({ profile: "genbi-default", components: [] }));
  return { dir, binding, irPath };
}

/** The dispatcher's half of the contract: argv and agent follow the declared entry, scope is echoed. */
function echoingDispatch(record: { entries: unknown[]; profileSources: (string | undefined)[] }): NonNullable<NativeSessionServiceOptions["dispatch"]> {
  return async ({ cwd, scope, purpose, target }) => {
    const entry = scope.entry as { kind?: string; verb?: string; prompt: string };
    record.entries.push(entry);
    const scopeEntry = entry.kind === "scope";
    const launchScope = { kind: scope.kind, scope_id: scope.scope_id, bootstrap_root: null, binding: scope.binding ?? null };
    mkdirSync(path.join(cwd, ".warble"), { recursive: true });
    writeFileSync(path.join(cwd, "RUN.md"), "handoff");
    writeFileSync(path.join(cwd, ".warble", "interactive-launch.json"), JSON.stringify(buildNativeLaunchSpec({
      version: "2", target, purpose, out: cwd, entryVerb: entry.verb ?? "answer_query", welcome: entry.prompt,
      scopeEntry, profile: (scope as { profile_for_test?: string }).profile_for_test ?? "genbi-default", scope: launchScope,
    })));
  };
}

const PROFILES: Record<string, NativeProfileSelection> = {
  "team-kpis": { id: "team-kpis", sourceDir: "/registry/team-kpis", entry: { kind: "scope" } },
  "genbi-report": { id: "genbi-report", sourceDir: "/registry/genbi-report", entry: { kind: "agent", verb: "plan_report" } },
};

function buildService(options: { provider: "claude" | "codex"; resolver?: boolean; unavailable?: Record<string, string>; analysisUnavailable?: boolean }) {
  const { dir, binding, irPath } = projectFixture();
  const stateParent = scratch("state");
  const state = initializeNativeSessionStateBase(path.join(stateParent, "bff.sqlite"));
  const store = new Store(":memory:");
  // Claude per-step tiers must name a Claude model family; Codex accepts free-form model ids.
  const tierModels = options.provider === "claude"
    ? [{ tier: "cheap", model: "haiku" }, { tier: "strong", model: "sonnet" }]
    : [{ tier: "cheap", model: "cheap" }, { tier: "strong", model: "strong" }];
  store.setRuntimeSettings({ ...store.getRuntimeSettings(), subscriptionProvider: options.provider, subscriptionDriverModel: options.provider === "claude" ? "sonnet" : "driver", tierModels });
  const record = { entries: [] as unknown[], profileSources: [] as (string | undefined)[] };
  const dispatch = echoingDispatch(record);
  const unavailableNow: Record<string, string> = { ...options.unavailable };
  const spawned: string[][] = [];
  const exits: ((event: { exitCode: number }) => void)[] = [];
  const pty: PtyFactory = { spawn: (_file, args) => {
    spawned.push([...args]);
    return { onData: () => ({ dispose() {} }), onExit: (listener) => { exits.push(listener); return { dispose() {} }; }, write() {}, resize() {}, kill() {} };
  } };
  const service = new NativeSessionService({
    store,
    terminalManager: async () => new InteractiveTerminalManager(pty),
    getBinding: () => binding,
    workspaceRoot: undefined,
    materializationState: state,
    irPaths: { analysis: irPath, setup: undefined, context_enrichment: undefined },
    warbleBin: "unused",
    resolveDispatchIr: async (_purpose, _binding, profileSource) => { record.profileSources.push(profileSource); return irPath; },
    // The fake producer cannot read the selected profile's IR, so the scope carries the id for the
    // echoed launch spec. Production never adds this key; `scope_id` and friends are what warble reads.
    dispatch: async (input) => dispatch({ ...input, scope: { ...input.scope, profile_for_test: (input.scope.entry as { kind?: string }).kind === "scope" ? currentProfile : undefined } }),
    ...(options.resolver === false ? {} : {
      resolveConversationProfile: async (id) => {
        const unavailable = unavailableNow[id];
        if (unavailable !== undefined) throw new Error(unavailable);
        const selection = PROFILES[id];
        if (!selection) throw new Error(`no profile with id "${id}"`);
        return selection;
      },
      listConversationProfiles: async () => [
        { id: "genbi-default", selectable: true, entryKind: "scope" as const },
        { id: "team-kpis", selectable: true, entryKind: "scope" as const },
        { id: "genbi-report", selectable: true, entryKind: "agent" as const, entryVerb: "plan_report" },
        { id: "genbi-monitor", selectable: false, reason: "component \"monitor_freshness\" is outside the host's execution scope" },
      ],
    }),
    ...(options.analysisUnavailable ? { producerAvailable: () => false } : {}),
  });
  let currentProfile = "genbi-default";
  const launch = async (profile?: string, idempotencyKey = `key-${Math.random()}`) => {
    currentProfile = profile ?? "genbi-default";
    return service.startSeparate({ purpose: "analysis", idempotencyKey, ...(profile !== undefined ? { profile } : {}) });
  };
  return {
    service, store, record, launch, dir, spawned, exits,
    setCurrent: (id: string) => { currentProfile = id; },
    markUnavailable: (id: string, reason: string) => { unavailableNow[id] = reason; },
  };
}

describe("analysis sessions inside a selected conversation profile", () => {
  it("defaults to genbi-default with the existing scope entry when no profile is named", async () => {
    const { service, record, launch } = buildService({ provider: "claude" });
    const launched = await launch();
    expect(launched.row).toMatchObject({ purpose: "analysis", vendor: "claude", dispatchProfile: "genbi-default", agent: "answer_query" });
    expect(record.entries[0]).toEqual({ kind: "scope", prompt: WELCOME });
    expect(record.profileSources).toEqual([undefined]);
    await service.shutdown();
  });

  it("starts a scope-entry session inside a selected profile: compiled from the registry's copy, recorded under its id, entering at its scope document", async () => {
    const { service, store, record, launch } = buildService({ provider: "claude" });
    const launched = await launch("team-kpis");
    expect(launched.row).toMatchObject({ dispatchProfile: "team-kpis", agent: "team-kpis", entryVerb: null, dispatchTarget: "claude-code:interactive" });
    expect(store.getNativeSession(launched.row.id)?.dispatchProfile).toBe("team-kpis");
    expect(record.entries[0]).toEqual({ kind: "scope", prompt: WELCOME });
    expect(record.profileSources).toEqual(["/registry/team-kpis"]);
    await service.shutdown();
  });

  it("pins the entry to the admitted component for a profile the registry admitted as agent-entry", async () => {
    const { service, record, launch } = buildService({ provider: "claude" });
    const launched = await launch("genbi-report");
    expect(launched.row).toMatchObject({ dispatchProfile: "genbi-report", agent: "plan_report", entryVerb: null });
    expect(record.entries[0]).toEqual({ verb: "plan_report", prompt: WELCOME });
    await service.shutdown();
  });

  it("refuses a launch-spec whose agent does not name the selected profile, so the host contract still fails closed", async () => {
    const { service, launch, setCurrent } = buildService({ provider: "claude" });
    // The fake producer echoes a different profile than the one selected.
    setCurrent("someone-else");
    const launched = service.startSeparate({ purpose: "analysis", idempotencyKey: "mismatch", profile: "team-kpis" });
    await expect(launched).rejects.toThrow(/launch specification is incompatible/);
    await service.shutdown();
  });

  it("keeps a live default session and a live selected-profile session apart when opening", async () => {
    const { service, launch, setCurrent } = buildService({ provider: "claude" });
    const base = await launch();
    setCurrent("team-kpis");
    const custom = await service.openOrCreate({ purpose: "analysis", profile: "team-kpis" });
    expect(custom.row.id).not.toBe(base.row.id);
    expect(custom.row.dispatchProfile).toBe("team-kpis");
    expect((await service.openOrCreate({ purpose: "analysis", profile: "team-kpis" })).row.id).toBe(custom.row.id);
    expect((await service.openOrCreate({ purpose: "analysis" })).row.id).toBe(base.row.id);
    expect((await service.openOrCreate({ purpose: "analysis", profile: "genbi-default" })).row.id).toBe(base.row.id);
    await service.shutdown();
  });

  it("refuses a profile on a system purpose, a malformed id, an entry verb beside a selected profile, and an unknown id", async () => {
    const { service } = buildService({ provider: "claude" });
    await expect(service.startSeparate({ purpose: "setup", idempotencyKey: "a", profile: "team-kpis" })).rejects.toThrow("only selectable for analysis");
    await expect(service.startSeparate({ purpose: "analysis", idempotencyKey: "b", profile: "Team KPIs" })).rejects.toThrow("profile is invalid");
    await expect(service.startSeparate({ purpose: "analysis", idempotencyKey: "c", profile: "team-kpis", entryVerb: "answer_query" })).rejects.toThrow("entry is invalid");
    await expect(service.startSeparate({ purpose: "analysis", idempotencyKey: "d", profile: "nope" })).rejects.toThrow('no profile with id "nope"');
    await service.shutdown();
  });

  it("surfaces the registry's own reason for an unavailable profile and never launches it", async () => {
    const { service, record } = buildService({ provider: "claude", unavailable: { "team-kpis": 'profile "team-kpis" is unavailable: component "x" requires capabilities outside the host ceiling: filesystem_write' } });
    await expect(service.startSeparate({ purpose: "analysis", idempotencyKey: "u", profile: "team-kpis" })).rejects.toThrow(/outside the host ceiling: filesystem_write/);
    expect(record.entries).toEqual([]);
    expect(service.list()).toEqual([]);
    await service.shutdown();
  });

  it("fails closed on the Codex CLI for any profile but the default, with a stated reason", async () => {
    const { service, launch } = buildService({ provider: "codex" });
    await expect(service.startSeparate({ purpose: "analysis", idempotencyKey: "cx", profile: "team-kpis" })).rejects.toThrow("not available on the Codex CLI");
    const base = await launch();
    expect(base.row.dispatchProfile).toBe("genbi-default");
    await service.shutdown();
  });

  it("fails closed when no registry resolver is wired, instead of silently running the default", async () => {
    const { service } = buildService({ provider: "claude", resolver: false });
    await expect(service.startSeparate({ purpose: "analysis", idempotencyKey: "nr", profile: "team-kpis" })).rejects.toThrow("not configured");
    expect(service.list()).toEqual([]);
    await service.shutdown();
  });

  it("resumes an exited selected-profile session inside the same profile, and refuses once that profile is no longer admitted", async () => {
    const { service, store, record, launch, spawned, exits, markUnavailable } = buildService({ provider: "claude" });
    const first = await launch("team-kpis");
    expect(spawned[0]).toEqual(["--session-id", expect.stringMatching(/^[0-9a-f-]{36}$/)]);
    const sessionId = spawned[0]![1]!;
    exits[0]!({ exitCode: 0 });
    expect(service.resumeAvailability(store.getNativeSession(first.row.id)!)).toEqual({ available: true });

    const resumed = await service.resume({ id: first.row.id, idempotencyKey: "00000000-0000-4000-8000-000000000301" });
    expect(resumed.row.id).not.toBe(first.row.id);
    expect(resumed.row).toMatchObject({ dispatchProfile: "team-kpis", agent: "team-kpis", purpose: "analysis", vendor: "claude" });
    expect(record.entries[1]).toEqual({ kind: "scope", prompt: WELCOME });
    expect(record.profileSources[1]).toBe("/registry/team-kpis");
    expect(spawned[1]).toEqual(["--resume", sessionId]);

    // The resumed child exits; the registry has since turned the profile away. Resume is refused with its reason.
    exits[1]!({ exitCode: 0 });
    expect(service.resumeAvailability(store.getNativeSession(resumed.row.id)!)).toEqual({ available: true });
    markUnavailable("team-kpis", 'profile "team-kpis" is unavailable: component "x" requires capabilities outside the host ceiling: filesystem_write');
    await expect(service.resume({ id: resumed.row.id, idempotencyKey: "00000000-0000-4000-8000-000000000302" })).rejects.toThrow(/outside the host ceiling: filesystem_write/);
    expect(record.entries).toHaveLength(2);
    expect(store.listNativeSessions().filter((row) => row.status === "running")).toEqual([]);
    await service.shutdown();
  });

  it("keeps a refused profile's own reason ahead of a runtime reason, so a picker can tell permanent from transient", async () => {
    const { service } = buildService({ provider: "claude", analysisUnavailable: true });
    const readiness = await service.readiness();
    expect(readiness.purposes.analysis.available).toBe(false);
    const runtimeReason = readiness.purposes.analysis.reason!;
    expect(readiness.profiles!["genbi-default"]).toMatchObject({ available: false, reason: runtimeReason });
    expect(readiness.profiles!["team-kpis"]).toMatchObject({ available: false, reason: runtimeReason });
    expect(readiness.profiles!["genbi-monitor"]).toMatchObject({ available: false, reason: expect.stringMatching(/outside the host's execution scope/) });
    await service.shutdown();
  });

  it("reports readiness per conversation profile, narrowed by the registry verdict and the vendor", async () => {
    const claude = buildService({ provider: "claude" });
    const readiness = await claude.service.readiness();
    expect(readiness.purposes.analysis.available).toBe(true);
    expect(readiness.profiles).toBeDefined();
    expect(readiness.profiles!["genbi-default"]).toMatchObject({ available: true, entryKind: "scope", profile: "genbi-default", targetLabel: "Claude CLI" });
    expect(readiness.profiles!["team-kpis"]).toMatchObject({ available: true, entryKind: "scope" });
    expect(readiness.profiles!["genbi-report"]).toMatchObject({ available: true, entryKind: "agent", entryVerb: "plan_report" });
    expect(readiness.profiles!["genbi-monitor"]).toMatchObject({ available: false, reason: expect.stringMatching(/outside the host's execution scope/) });
    await claude.service.shutdown();

    const codex = buildService({ provider: "codex" });
    const codexReadiness = await codex.service.readiness();
    expect(codexReadiness.profiles!["genbi-default"]).toMatchObject({ available: true, entryKind: "agent" });
    expect(codexReadiness.profiles!["team-kpis"]).toMatchObject({ available: false, reason: expect.stringMatching(/not available on the Codex CLI/) });
    await codex.service.shutdown();
  });
});

describe("POST /api/native-sessions with a profile", () => {
  const BASE_ROUTE_OPTIONS: Omit<RouteOptions, "question" | "onEvent"> = {
    authChoice: { mode: "api-key", adapter: "mock" },
    profileSource: "/fixture/profile",
    userProject: "/fixture/project",
  };
  function app() {
    const calls: unknown[] = [];
    const nativeSessions = {
      startSeparate: async (input: unknown) => { calls.push(["startSeparate", input]); return { row: { id: "native-session-00000000-0000-4000-8000-000000000001", purpose: "analysis", vendor: "claude", status: "running", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", scopeKind: "bound_project", scopeId: "s", agent: "team-kpis", entryVerb: null, dispatchProfile: "team-kpis" } , capability: "cap" }; },
      openOrCreate: async (input: unknown) => { calls.push(["openOrCreate", input]); return { row: { id: "native-session-00000000-0000-4000-8000-000000000002", purpose: "analysis", vendor: "claude", status: "running", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", scopeKind: "bound_project", scopeId: "s", agent: "answer_query", entryVerb: null, dispatchProfile: "genbi-default" }, capability: "cap" }; },
      resumeAvailability: () => ({ available: false, cause: "not_terminal" }),
    };
    const deps: TurnDeps = { store: new Store(":memory:"), route: async () => { throw new Error("unreachable"); }, baseRouteOptions: BASE_ROUTE_OPTIONS, nativeSessions: nativeSessions as never };
    return { app: createApp(deps), calls };
  }
  const post = (a: ReturnType<typeof createApp>, body: unknown) => a.request("/api/native-sessions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const KEY = "11111111-1111-4111-8111-111111111111";

  it("passes a valid profile through to start-separate and open-or-create", async () => {
    const { app: a, calls } = app();
    expect((await post(a, { purpose: "analysis", intent: "start_separate", idempotencyKey: KEY, profile: "team-kpis" })).status).toBe(201);
    expect((await post(a, { purpose: "analysis", intent: "open_existing", profile: "team-kpis" })).status).toBe(201);
    expect(calls).toEqual([
      ["startSeparate", { purpose: "analysis", idempotencyKey: KEY, profile: "team-kpis" }],
      ["openOrCreate", { purpose: "analysis", profile: "team-kpis" }],
    ]);
  });

  it("rejects a profile on a system purpose, with an entry verb, on an existing session, on a resume, or malformed", async () => {
    const { app: a, calls } = app();
    const cases: [unknown, RegExp][] = [
      [{ purpose: "setup", intent: "start_separate", idempotencyKey: KEY, profile: "team-kpis" }, /only selectable for analysis/],
      [{ purpose: "context_enrichment", intent: "open_existing", profile: "team-kpis" }, /only selectable for analysis/],
      [{ purpose: "analysis", intent: "start_separate", idempotencyKey: KEY, profile: "team-kpis", entryVerb: "answer_query" }, /entry is invalid/],
      [{ purpose: "analysis", intent: "open_existing", sessionId: "native-session-00000000-0000-4000-8000-000000000001", profile: "team-kpis" }, /cannot be changed on an existing session/],
      [{ purpose: "analysis", intent: "resume", sessionId: "native-session-00000000-0000-4000-8000-000000000001", idempotencyKey: KEY, profile: "team-kpis" }, /launch request is invalid/],
      [{ purpose: "analysis", intent: "start_separate", idempotencyKey: KEY, profile: "Team KPIs" }, /profile is invalid/],
      [{ purpose: "analysis", intent: "start_separate", idempotencyKey: KEY, profile: 7 }, /profile is invalid/],
    ];
    for (const [body, message] of cases) {
      const response = await post(a, body);
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect(((await response.json()) as { error: string }).error, JSON.stringify(body)).toMatch(message);
    }
    expect(calls).toEqual([]);
  });

  it("still accepts an entry verb beside the default profile", async () => {
    const { app: a, calls } = app();
    expect((await post(a, { purpose: "analysis", intent: "start_separate", idempotencyKey: KEY, profile: "genbi-default", entryVerb: "generate_dashboard" })).status).toBe(201);
    expect(calls[0]).toEqual(["startSeparate", { purpose: "analysis", idempotencyKey: KEY, entryVerb: "generate_dashboard", profile: "genbi-default" }]);
  });

  it("maps a registry refusal from the service to 409 with its reason", async () => {
    const BASE = BASE_ROUTE_OPTIONS;
    const nativeSessions = { startSeparate: async () => { const { InteractiveLaunchError } = await import("../server/interactive-terminal.js"); throw new InteractiveLaunchError('profile "team-kpis" is unavailable: component "x" requires capabilities outside the host ceiling: filesystem_write'); } };
    const a = createApp({ store: new Store(":memory:"), route: async () => { throw new Error("unreachable"); }, baseRouteOptions: BASE, nativeSessions: nativeSessions as never });
    const response = await post(a, { purpose: "analysis", intent: "start_separate", idempotencyKey: KEY, profile: "team-kpis" });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: expect.stringMatching(/outside the host ceiling: filesystem_write/) });
  });
});
