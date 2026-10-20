import { describe, expect, it, vi } from "vitest";
import {
  authOffer, BACKENDS, inProcessAuthOffer, isBackendOffered, localSubscriptionVendorOffered, localTerminalAvailable, NOT_LISTED_REASON, PLANNED_REASON, resolveRuntimeSelection,
  RuntimeSelectionError, UNSUPPORTED_REASON, type BackendName,
} from "../server/runtime-selection.js";
import { StructuredRuntime, type StructuredAdapter, type StructuredScope } from "../server/structured-runtime.js";
import { readCodexBootConfiguration } from "../server/codex-runtime-composition.js";
import { selectNativeRuntimeBackend } from "../server/openshell-runtime-composition.js";
import { RuntimeHost, runtimeReady } from "../server/runtime-host/index.js";
import type { RouteOptions } from "../harness/index.js";

const refusal = (env: NodeJS.ProcessEnv) => { try { resolveRuntimeSelection(env); } catch (error) { expect(error).toBeInstanceOf(RuntimeSelectionError); return (error as Error).message; } throw new Error("boot was not refused"); };
const subsets = (items: readonly BackendName[]): BackendName[][] => items.reduce<BackendName[][]>((all, item) => [...all, ...all.map((set) => [...set, item])], [[]]).filter((set) => set.length > 0);

/** Independent oracle for the support matrix, written out by hand rather than read from the table under test. */
const expectedOffer = (runtime: "local" | "openshell", listed: readonly BackendName[], backend: BackendName): boolean =>
  listed.includes(backend) && (runtime === "local" ? true : backend === "claude" || backend === "pi");

describe("runtime selection: environment matrix", () => {
  it("defaults to the local runtime offering claude and codex with the exec Codex mode", () => {
    const selection = resolveRuntimeSelection({});
    expect(selection).toMatchObject({ runtime: "local", listed: ["claude", "codex"], codexMode: "exec", warnings: [] });
    expect(selection.offers).toEqual({ claude: { offered: true }, codex: { offered: true }, pi: { offered: false, reason: NOT_LISTED_REASON } });
    expect(Object.isFrozen(selection)).toBe(true);
  });

  describe.each(["local", "openshell"] as const)("GENBI_RUNTIME=%s", (runtime) => {
    for (const listed of subsets(BACKENDS)) {
      const both = runtime === "openshell" && listed.includes("claude") && listed.includes("pi");
      for (const mode of [undefined, "exec", "app-server"] as const) {
        const modeApplies = runtime === "local" && listed.includes("codex");
        it(`BACKEND=${listed.join(",")} CODEX_MODE=${mode ?? "unset"}`, () => {
          const env = { GENBI_RUNTIME: runtime, GENBI_BACKEND: listed.join(","), ...(mode ? { GENBI_CODEX_MODE: mode } : {}) };
          if (both) return expect(refusal(env)).toContain("only one model backend");
          if (mode && !modeApplies) return expect(refusal(env)).toContain("GENBI_CODEX_MODE");
          const selection = resolveRuntimeSelection(env);
          expect(selection.runtime).toBe(runtime);
          expect(selection.listed).toEqual(listed);
          expect(selection.codexMode).toBe(mode ?? "exec");
          for (const backend of BACKENDS) {
            expect(isBackendOffered(selection, backend)).toBe(expectedOffer(runtime, listed, backend));
            expect(selection.offers[backend].reason === undefined).toBe(selection.offers[backend].offered);
          }
          expect(selection.warnings).toHaveLength(listed.filter((backend) => !expectedOffer(runtime, listed, backend)).length);
        });
      }
    }
  });

  it("trims whitespace and keeps the listed order", () => {
    expect(resolveRuntimeSelection({ GENBI_BACKEND: " codex , claude " }).listed).toEqual(["codex", "claude"]);
  });
  it.each(["", ",", "claude,", ",claude", "claude,,codex", " "])("refuses the empty entry in %j", (value) => {
    expect(refusal({ GENBI_BACKEND: value })).toContain("empty entry");
  });
  it("refuses an unknown or duplicate entry and names it", () => {
    expect(refusal({ GENBI_BACKEND: "claude,gemini" })).toContain('"gemini"');
    expect(refusal({ GENBI_BACKEND: "claude, claude" })).toContain('"claude"');
    expect(refusal({ GENBI_BACKEND: "Claude" })).toContain('"Claude"');
  });
  it("refuses any other GENBI_RUNTIME value naming the variable", () => {
    for (const value of ["", "auto", "Local", "app-server"]) expect(refusal({ GENBI_RUNTIME: value })).toContain("GENBI_RUNTIME");
  });
  it("requires the list under openshell", () => {
    expect(refusal({ GENBI_RUNTIME: "openshell" })).toContain("GENBI_BACKEND is required");
  });
  it("refuses claude together with pi under openshell and allows each alone", () => {
    expect(refusal({ GENBI_RUNTIME: "openshell", GENBI_BACKEND: "pi,claude" })).toContain("only one model backend");
    expect(resolveRuntimeSelection({ GENBI_RUNTIME: "openshell", GENBI_BACKEND: "claude" }).offers.claude.offered).toBe(true);
    expect(resolveRuntimeSelection({ GENBI_RUNTIME: "openshell", GENBI_BACKEND: "pi" }).offers.pi).toEqual({ offered: true });
  });
  it("refuses an invalid GENBI_CODEX_MODE value and an inapplicable one", () => {
    expect(refusal({ GENBI_CODEX_MODE: "auto" })).toContain("GENBI_CODEX_MODE");
    expect(refusal({ GENBI_BACKEND: "claude", GENBI_CODEX_MODE: "exec" })).toContain("GENBI_CODEX_MODE");
    expect(refusal({ GENBI_RUNTIME: "openshell", GENBI_BACKEND: "claude", GENBI_CODEX_MODE: "app-server" })).toContain("GENBI_CODEX_MODE");
    expect(resolveRuntimeSelection({ GENBI_CODEX_MODE: "app-server" }).codexMode).toBe("app-server");
  });
  it.each([["GENBI_CLAUDE_RUNTIME", "GENBI_RUNTIME"], ["GENBI_CODEX_RUNTIME", "GENBI_CODEX_MODE"], ["GENBI_ALLOW_LOCAL_RUNTIME", "GENBI_BACKEND"]])("refuses the removed %s with any value, naming it and %s", (name, replacement) => {
    for (const value of ["", "0", "1", "local", "openshell", "app-server"]) {
      const message = refusal({ [name]: value });
      expect(message).toContain(name); expect(message).toContain(replacement);
    }
    expect(refusal({ [name]: "x", GENBI_RUNTIME: "openshell", GENBI_BACKEND: "claude" })).toContain(name);
  });
  it("accepts GENBI_OPENSHELL_* only under openshell", () => {
    for (const name of ["GENBI_OPENSHELL_CONFIG", "GENBI_OPENSHELL_CLAUDE_BOOT", "GENBI_OPENSHELL_FUTURE"]) {
      expect(refusal({ [name]: "/synthetic" })).toContain(name);
      expect(refusal({ [name]: "/synthetic", GENBI_RUNTIME: "local", GENBI_BACKEND: "claude" })).toContain(name);
      expect(resolveRuntimeSelection({ [name]: "/synthetic", GENBI_RUNTIME: "openshell", GENBI_BACKEND: "claude" }).runtime).toBe("openshell");
    }
  });
  it("does not treat backend configuration variables as selectors", () => {
    expect(resolveRuntimeSelection({ GENBI_CODEX_EXECUTABLE: "/synthetic/codex", GENBI_CODEX_SOURCE: "https://example.invalid", WREN_HARNESS_CODEX_HOME: "/synthetic", GENBI_CODEX_ACCOUNT_EMAIL: "a@example.invalid" }).listed).toEqual(["claude", "codex"]);
  });
  it("warns once per listed backend the runtime does not offer, with a browser-safe reason", () => {
    const selection = resolveRuntimeSelection({ GENBI_RUNTIME: "openshell", GENBI_BACKEND: "claude,codex" });
    expect(selection.warnings).toHaveLength(1); expect(selection.warnings[0]).toContain('"codex"'); expect(selection.warnings[0]).toContain(UNSUPPORTED_REASON);
    expect(resolveRuntimeSelection({ GENBI_BACKEND: "claude,pi" }).warnings).toEqual([]);
    expect(resolveRuntimeSelection({ GENBI_RUNTIME: "openshell", GENBI_BACKEND: "codex" }).offers.codex).toEqual({ offered: false, reason: UNSUPPORTED_REASON });
  });
  it("routes in-process, gateway and local-mode auth by the runtime, never by the list", () => {
    for (const backend of ["claude", "codex", "claude,codex", "pi"]) {
      const local = resolveRuntimeSelection({ GENBI_BACKEND: backend });
      expect(inProcessAuthOffer(local).offered).toBe(true);
      for (const mode of ["api-key", "gateway", "local"]) expect(authOffer(local, { mode }).offered).toBe(true);
    }
    const openshell = resolveRuntimeSelection({ GENBI_RUNTIME: "openshell", GENBI_BACKEND: "claude" });
    for (const mode of ["api-key", "gateway", "local"]) expect(authOffer(openshell, { mode })).toEqual({ offered: false, reason: UNSUPPORTED_REASON });
    expect(authOffer(openshell, { mode: "subscription", provider: "claude" }).offered).toBe(true);
    expect(authOffer(openshell, { mode: "subscription", provider: "codex" }).offered).toBe(false);
  });
  it("lets the native terminal host run a subscription vendor only on the local runtime when it is listed", () => {
    expect(localSubscriptionVendorOffered(resolveRuntimeSelection({}))).toBe(true);
    expect(localSubscriptionVendorOffered(resolveRuntimeSelection({ GENBI_BACKEND: "pi" }))).toBe(false);
    expect(localSubscriptionVendorOffered(resolveRuntimeSelection({ GENBI_RUNTIME: "openshell", GENBI_BACKEND: "claude" }))).toBe(false);
  });
});

const scope = (): StructuredScope => ({ sessionId: "session", turnId: "turn", assertCurrent: vi.fn() });
const request = (authChoice: RouteOptions["authChoice"]): RouteOptions => ({ authChoice, profileSource: "fixture", userProject: "/fixture/project", question: "count" });
const claude = { mode: "subscription", provider: "claude" } as const;
const codex = { mode: "subscription", provider: "codex" } as const;
const gateway = { mode: "gateway", config: { provider: "synthetic" } } as const;
const apiKey = { mode: "api-key", adapter: "anthropic" } as const;
function runtimeFor(env: NodeJS.ProcessEnv, adapters: Record<string, StructuredAdapter> = {}) {
  const localRoute = vi.fn(async () => ({ backend: "codex-local" as const, warnings: [], finalText: "local" }));
  const localSetup = { run: vi.fn(async () => ({ finalText: "local setup" })) };
  const runtime = new StructuredRuntime({ selection: resolveRuntimeSelection(env), localRoute, localSetupFor: () => localSetup, adapters });
  return { runtime, localRoute, localSetup };
}
const openshellAdapter = (ask = vi.fn(async () => ({ backend: "openshell", warnings: [], finalText: "isolated" }))): StructuredAdapter =>
  ({ vendor: "claude", backend: "openshell", probe: async () => runtimeReady("1.0.0", []), ask: ask as never });

describe("runtime selection: admission and readiness", () => {
  it("OpenShell never offers Codex, in-process, gateway or local-mode auth: refused at admission, no fallback", async () => {
    const f = runtimeFor({ GENBI_RUNTIME: "openshell", GENBI_BACKEND: "claude,codex" }, { claude: openshellAdapter() });
    for (const auth of [codex, apiKey, gateway, { mode: "local" } as const]) {
      expect(() => f.runtime.assertOperationSupported(auth, "ask")).toThrow();
      await expect(f.runtime.route(request(auth), scope())).rejects.toMatchObject({ code: "unavailable" });
      await expect(f.runtime.setup({ prompt: "p", workspaceRoot: "/fixture", authChoice: auth }, scope())).rejects.toMatchObject({ code: "unavailable" });
    }
    expect(f.localRoute).not.toHaveBeenCalled(); expect(f.localSetup.run).not.toHaveBeenCalled();
    await expect(f.runtime.route(request(claude), scope())).resolves.toMatchObject({ finalText: "isolated" });
    expect(f.localRoute).not.toHaveBeenCalled();
  });
  it("reports readiness for the runtime and every backend independently, and not offered is not not ready", async () => {
    const f = runtimeFor({ GENBI_RUNTIME: "openshell", GENBI_BACKEND: "claude,codex" }, { claude: openshellAdapter() });
    const readiness = await f.runtime.readiness(codex);
    expect(readiness.runtime).toBe("openshell");
    expect(readiness.backends.claude).toMatchObject({ offered: true, state: "ready", ask: true, backend: "openshell" });
    expect(readiness.backends.codex).toEqual({ offered: false, state: "not_offered", ask: false, setup: false, reason: UNSUPPORTED_REASON });
    expect(readiness.backends.pi).toMatchObject({ offered: false, state: "not_offered", reason: NOT_LISTED_REASON });
    expect(readiness.codex).toBe(readiness.backends.codex); expect(readiness.claude).toBe(readiness.backends.claude);
    expect(readiness.active).toBe(readiness.backends.codex);
    expect((await f.runtime.readiness(gateway)).active).toMatchObject({ offered: false, state: "not_offered", ask: false, backend: "in-process" });
    const down = runtimeFor({ GENBI_RUNTIME: "openshell", GENBI_BACKEND: "claude" }, { claude: { ...openshellAdapter(), probe: async () => ({ state: "unavailable", code: "openshell_unavailable", message: "x" }) as never } });
    expect((await down.runtime.readiness()).backends.claude).toMatchObject({ offered: true, state: "unavailable", ask: false });
  });
  it("pi under openshell is offered, and without its adapter nothing runs: not ready, no fallback", async () => {
    const f = runtimeFor({ GENBI_RUNTIME: "openshell", GENBI_BACKEND: "pi" });
    const readiness = await f.runtime.readiness(gateway);
    expect(readiness.backends.pi).toMatchObject({ offered: true, state: "unavailable", ask: false });
    expect(readiness.backends.claude).toMatchObject({ offered: false, state: "not_offered" });
    await expect(f.runtime.route(request(gateway), scope())).rejects.toMatchObject({ code: "unavailable" });
    await expect(f.runtime.route(request(claude), scope())).rejects.toMatchObject({ code: "unavailable" });
    expect(f.localRoute).not.toHaveBeenCalled();
  });
  it("the local runtime offers pi when listed: api-key and gateway Ask then needs it (no fallback), local-mode auth stays in-process", async () => {
    const f = runtimeFor({ GENBI_BACKEND: "pi" });
    for (const auth of [apiKey, gateway]) await expect(f.runtime.route(request(auth), scope())).rejects.toMatchObject({ code: "unavailable" });
    await expect(f.runtime.route(request({ mode: "local" } as const), scope())).resolves.toMatchObject({ finalText: "local" });
    const readiness = await f.runtime.readiness(gateway);
    expect(readiness.backends.pi).toMatchObject({ offered: true, backend: "pi-local", state: "unavailable", ask: false });
    expect(f.localRoute).toHaveBeenCalledTimes(1);
    await expect(f.runtime.route(request(claude), scope())).rejects.toMatchObject({ code: "unavailable" });
  });

  describe("equivalence with today's three real configurations", () => {
    it("default boot: both subscription vendors run locally and the local route serves them", async () => {
      const f = runtimeFor({});
      const readiness = await f.runtime.readiness(claude);
      expect(readiness.claude).toMatchObject({ offered: true, backend: "local", state: "ready", ask: true, setup: true, reason: "Explicit local execution; vendor isolation is not claimed." });
      expect(readiness.codex).toMatchObject({ offered: true, backend: "local", state: "ready", ask: true, setup: true });
      await expect(f.runtime.route(request(claude), scope())).resolves.toMatchObject({ finalText: "local" });
      await expect(f.runtime.route(request(codex), scope())).resolves.toMatchObject({ finalText: "local" });
      expect(selectNativeRuntimeBackend({ selection: resolveRuntimeSelection({}), codexBackend: readCodexBootConfiguration({}, resolveRuntimeSelection({})).selected })).toBe("local");
    });
    it.each(["pi", "codex", "claude"])("an openshell boot with BACKEND=%s selects openshell natively and never the host backend", (backend) => {
      const selection = resolveRuntimeSelection({ GENBI_RUNTIME: "openshell", GENBI_BACKEND: backend });
      for (const codexBackend of ["local", "codex-app-server"] as const) expect(selectNativeRuntimeBackend({ selection, codexBackend })).toBe("openshell");
    });
    it("the former Claude-on-OpenShell setting is RUNTIME=openshell, BACKEND=claude", async () => {
      const selection = resolveRuntimeSelection({ GENBI_RUNTIME: "openshell", GENBI_BACKEND: "claude" });
      expect(selectNativeRuntimeBackend({ selection, codexBackend: "local" })).toBe("openshell");
      const ask = vi.fn(async () => ({ backend: "openshell", warnings: [], finalText: "isolated" }));
      const f = runtimeFor({ GENBI_RUNTIME: "openshell", GENBI_BACKEND: "claude" }, { claude: openshellAdapter(ask) });
      await expect(f.runtime.route(request(claude), scope())).resolves.toMatchObject({ finalText: "isolated" });
      expect(ask).toHaveBeenCalledOnce(); expect(f.localRoute).not.toHaveBeenCalled();
      expect(() => f.runtime.assertOperationSupported(claude, "setup")).toThrow();
    });
    it("the native terminal host reports local exactly as the former allowLocal wiring did (RuntimeHost level)", async () => {
      // Expected values come from the removed wiring, `localAvailable: () => allowLocal ? hostAvailable() : false`, not from the new gate.
      const oldHost = (allowLocal: boolean) => new RuntimeHost({ selected: "codex-app-server", deployment: "development", localAvailable: () => allowLocal ? true : false });
      const newHost = (env: NodeJS.ProcessEnv) => new RuntimeHost({ selected: "codex-app-server", deployment: "development", localAvailable: localTerminalAvailable(resolveRuntimeSelection(env), async () => true) });
      const appServerOnly = { GENBI_RUNTIME: "local", GENBI_BACKEND: "codex", GENBI_CODEX_MODE: "app-server" };
      const unavailable = (await oldHost(false).probe()).backends.local;
      expect(unavailable).toMatchObject({ state: "unavailable", code: "local_runtime_host_unavailable" });
      expect((await newHost(appServerOnly).probe()).backends.local).toEqual(unavailable);
      expect((await newHost(appServerOnly).probe("codex")).backends.local).toEqual(unavailable);
      // ALLOW_LOCAL=1 with app-server stays available through claude when the list names it.
      const available = (await oldHost(true).probe()).backends.local;
      expect(available.state).toBe("ready");
      expect((await newHost({ ...appServerOnly, GENBI_BACKEND: "claude,codex" }).probe()).backends.local).toEqual(available);
      expect((await newHost({ ...appServerOnly, GENBI_BACKEND: "claude,codex" }).probe("claude")).backends.local).toEqual(available);
      expect((await newHost({ ...appServerOnly, GENBI_BACKEND: "claude,codex" }).probe("codex")).backends.local).toEqual(unavailable);
      expect((await newHost({ GENBI_BACKEND: "codex" }).probe("codex")).backends.local).toEqual(available);
      expect((await newHost({ GENBI_BACKEND: "codex" }).probe()).backends.local).toEqual(available);
    });
    it("the former ALLOW_LOCAL=0 with app-server is RUNTIME=local, BACKEND=codex, CODEX_MODE=app-server", async () => {
      const env = { GENBI_RUNTIME: "local", GENBI_BACKEND: "codex", GENBI_CODEX_MODE: "app-server" };
      const selection = resolveRuntimeSelection(env);
      expect(readCodexBootConfiguration({}, selection).selected).toBe("codex-app-server");
      expect(selectNativeRuntimeBackend({ selection, codexBackend: "codex-app-server" })).toBe("codex-app-server");
      expect(localSubscriptionVendorOffered(selection)).toBe(false);
      const adapter: StructuredAdapter = { vendor: "codex", backend: "codex-app-server", probe: async () => runtimeReady("0.156.1", []), ask: async () => ({ backend: "codex-app-server", warnings: [], finalText: "app-server" }) as never };
      const f = runtimeFor(env, { codex: adapter });
      const readiness = await f.runtime.readiness(codex);
      expect(readiness.codex).toMatchObject({ offered: true, backend: "codex-app-server", state: "ready", ask: true });
      expect(readiness.claude).toMatchObject({ offered: false, state: "not_offered", ask: false, setup: false });
      await expect(f.runtime.route(request(codex), scope())).resolves.toMatchObject({ finalText: "app-server" });
      await expect(f.runtime.route(request(claude), scope())).rejects.toMatchObject({ code: "unavailable" });
      expect(f.localRoute).not.toHaveBeenCalled(); expect(f.localSetup.run).not.toHaveBeenCalled();
    });
  });
});
