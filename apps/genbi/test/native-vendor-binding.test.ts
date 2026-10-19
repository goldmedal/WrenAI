import { describe, expect, it } from "vitest";
import { resolveNativeRuntimeBinding, dispatchForPurpose, interactiveTargetOf, PI_SCOPED_TARGET } from "../server/native-dispatch-registry.js";
import { StructuredRuntime, StructuredRuntimeError, type StructuredAdapter } from "../server/structured-runtime.js";
import { resolveRuntimeSelection } from "../server/runtime-selection.js";
import type { AuthChoice } from "../harness/index.js";
import type { RuntimeSettings } from "../server/wire-types.js";

const settings = (patch: Partial<RuntimeSettings>): RuntimeSettings => ({ authMode: "byo", apiKeyAdapter: "openai-compatible", tierModels: [], hybrid: false, deployment: "personal", ...patch } as RuntimeSettings);

describe("native binding derivation", () => {
  it("is exactly the subscription-derived binding without the pi boot fact", () => {
    expect(resolveNativeRuntimeBinding(settings({ authMode: "byo" }), true, 1)).toEqual({ configured: false, generation: 1 });
    expect(resolveNativeRuntimeBinding(settings({ authMode: "gateway" }), true, 1)).toEqual({ configured: false, generation: 1 });
    expect(resolveNativeRuntimeBinding(settings({ authMode: "subscription", subscriptionProvider: "claude" }), true, 2)).toEqual({ configured: true, generation: 2, provider: "claude", target: "claude-code:interactive", targetLabel: "Claude CLI" });
    expect(resolveNativeRuntimeBinding(settings({ authMode: "subscription", subscriptionProvider: "codex" }), true, 2)).toMatchObject({ provider: "codex", target: "codex:interactive" });
    expect(resolveNativeRuntimeBinding(settings({ authMode: "subscription", subscriptionProvider: "claude" }), false, 2)).toEqual({ configured: false, generation: 2 });
  });
  it.each(["byo", "gateway"] as const)("binds an explicit %s setting to pi on a pi boot, and only then", authMode => {
    expect(resolveNativeRuntimeBinding(settings({ authMode }), true, 5, "pi")).toEqual({ configured: true, generation: 5, provider: "pi", target: PI_SCOPED_TARGET, targetLabel: "pi" });
    expect(resolveNativeRuntimeBinding(settings({ authMode }), false, 5, "pi")).toEqual({ configured: false, generation: 5 });
    expect(resolveNativeRuntimeBinding(settings({ authMode, hybrid: true }), true, 5, "pi")).toEqual({ configured: false, generation: 5 });
  });
  it.each([["subscription", "claude"], ["subscription", "codex"], ["local", undefined]] as const)("never derives pi from a %s %s setting", (authMode, subscriptionProvider) => {
    const binding = resolveNativeRuntimeBinding(settings({ authMode, ...(subscriptionProvider ? { subscriptionProvider } : {}) } as Partial<RuntimeSettings>), true, 1, "pi");
    expect(binding).toEqual({ configured: false, generation: 1 }); expect(dispatchForPurpose("analysis", binding)).toBeUndefined();
  });
  it("keeps the scoped target out of the terminal world", () => {
    expect(interactiveTargetOf({ configured: true, generation: 1, provider: "pi", target: PI_SCOPED_TARGET, targetLabel: "pi" })).toBeUndefined();
    expect(interactiveTargetOf({ configured: true, generation: 1, provider: "claude", target: "claude-code:interactive", targetLabel: "Claude CLI" })).toBe("claude-code:interactive");
    expect(dispatchForPurpose("analysis", { configured: true, generation: 1, provider: "claude", target: "claude-code:interactive", targetLabel: "Claude CLI" })).toMatchObject({ provider: "claude", target: "claude-code:interactive" });
  });
});

describe("the native operation gate", () => {
  const adapter = (vendor: "claude" | "pi", nativeSessions: boolean): StructuredAdapter => ({ vendor, backend: "openshell", nativeSessions, probe: async () => ({ state: "ready", version: "0", capabilities: [] }) as never, ask: async () => { throw Error("unused"); } });
  const runtime = (env: Record<string, string>, vendor: "claude" | "pi", nativeSessions = true) => new StructuredRuntime({ selection: resolveRuntimeSelection({ GENBI_RUNTIME: "openshell", ...env }), localRoute: async () => { throw Error("local fallback forbidden"); }, localSetupFor: () => undefined, adapters: { [vendor]: adapter(vendor, nativeSessions) } });
  const apiKey: AuthChoice = { mode: "api-key", adapter: "openai-compatible" }, gateway: AuthChoice = { mode: "gateway", config: { provider: "vendor" } } as AuthChoice;
  const claude: AuthChoice = { mode: "subscription", provider: "claude" }, codex: AuthChoice = { mode: "subscription", provider: "codex" }, local = { mode: "local" } as AuthChoice;
  const code = (run: () => void) => { try { run(); return "ok"; } catch (error) { return error instanceof StructuredRuntimeError ? error.code : "other"; } };
  it("passes native for pi only under openshell + pi with api-key or gateway", () => {
    const pi = runtime({ GENBI_BACKEND: "pi" }, "pi");
    expect([apiKey, gateway].map(auth => code(() => pi.assertOperationSupported(auth, "native")))).toEqual(["ok", "ok"]);
    expect([claude, codex, local].map(auth => code(() => pi.assertOperationSupported(auth, "native")))).toEqual(["unavailable", "unavailable", "unavailable"]);
  });
  it("refuses native for pi when the adapter holds no session capability", () => {
    const pi = runtime({ GENBI_BACKEND: "pi" }, "pi", false); expect(code(() => pi.assertOperationSupported(apiKey, "native"))).toBe("unsupported");
  });
  it("is unchanged for a Claude boot: subscription Claude passes, api-key and gateway stay refused", () => {
    const boot = runtime({ GENBI_BACKEND: "claude" }, "claude");
    expect(code(() => boot.assertOperationSupported(claude, "native"))).toBe("ok"); expect([apiKey, gateway, codex, local].map(auth => code(() => boot.assertOperationSupported(auth, "native")))).toEqual(["unavailable", "unavailable", "unavailable", "unavailable"]);
  });
  it("never offers setup or enrichment for pi, and never a terminal operation", () => {
    const pi = runtime({ GENBI_BACKEND: "pi" }, "pi");
    expect(["setup", "enrich", "local_enrichment"].map(operation => code(() => pi.assertOperationSupported(apiKey, operation as never)))).toEqual(["unsupported", "unsupported", "unsupported"]);
  });
});
