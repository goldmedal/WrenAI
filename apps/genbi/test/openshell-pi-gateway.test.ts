import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalGatewayProfile, canonicalGatewayProfileDigest, createPiGatewayVerifier, PI_GATEWAY_TOTAL_DEADLINE_MS, PI_PROFILE_BINARIES } from "../server/runtime-host/openshell-pi-gateway.js";
import { OpenShellError } from "../server/runtime-host/openshell-types.js";
import type { OpenShellPiBootDescriptor } from "../server/runtime-host/openshell-pi-boot.js";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const executable = new URL(import.meta.url).pathname;
const executableDigest = `sha256:${createHash("sha256").update(readFileSync(executable)).digest("hex")}`;
const configuration = { executable, executableDigest, gateway: "gw", workspace: "default", home: "/h", configHome: "/c", stateHome: "/s" };
const baseProfile = () => ({ id: "vendor-profile", resource_version: 3, display_name: "synthetic vendor", description: "API-key model endpoint", category: "inference",
  credentials: [{ name: "api_key", description: "Model API key", env_vars: ["VENDOR_KEY"], required: true, auth_style: "bearer", header_name: "authorization", query_param: "" }],
  endpoints: [{ host: "api.vendor.example.test", port: 443, protocol: "rest", access: "read-write", enforcement: "enforce" }],
  binaries: ["/usr/local/bin/node"], inference_capable: true, discovery: { credentials: ["api_key"] }, source: "user", scope: "workspace" });
const baseProvider = () => ({ credential_keys: ["VENDOR_KEY"], id: "p-1", name: "vendor-provider", resource_version: 1, type: "vendor-profile", workspace: "default" });
const descriptor = (profile = baseProfile()): OpenShellPiBootDescriptor => ({ version: 1, gatewayUrl: "https://localhost:9443/", caCert: "/a", clientCert: "/b", clientKey: "/c", auth: "api-key", provider: "vendor-provider", profileId: "vendor-profile",
  displayLabel: "synthetic vendor", profileDigest: canonicalGatewayProfileDigest(profile), generation: "gen-1",
  endpoint: { providerId: "vendor", api: "openai-completions", baseUrl: "https://api.vendor.example.test/v1", credentialEnv: "VENDOR_KEY" }, models: { cheap: "model-cheap" } });

/** A scripted gateway CLI; each call is recorded so a test can prove nothing but reads ran. */
function gateway(state: { providers?: unknown[][]; profile?: unknown; fail?: "provider" | "profile"; raw?: string; delay?: boolean } = {}) {
  const calls: string[][] = [];
  const run = vi.fn(async (_executable: string, argv: readonly string[], _environment: NodeJS.ProcessEnv, signal?: AbortSignal) => {
    calls.push([...argv]);
    const command = argv.slice(4);
    if (state.delay) await new Promise((_, reject) => signal?.addEventListener("abort", () => reject(new OpenShellError("openshell_cancelled")), { once: true }));
    if (state.raw !== undefined) return state.raw;
    if (command[0] === "provider" && command[1] === "list") {
      if (state.fail === "provider") throw new OpenShellError("openshell_remote_unknown");
      const token = command.includes("--page-token") ? command[command.indexOf("--page-token") + 1]! : "";
      const pages = state.providers ?? [[baseProvider()]];
      const index = token ? Number(token) : 0;
      return JSON.stringify({ providers: pages[index], next_page_token: index + 1 < pages.length ? String(index + 1) : "" });
    }
    if (command[0] === "provider" && command[1] === "profile" && command[2] === "export") {
      if (state.fail === "profile") throw new OpenShellError("openshell_remote_unknown");
      return JSON.stringify(state.profile ?? baseProfile());
    }
    throw new Error(`unexpected gateway call ${command.join(" ")}`);
  });
  return { run, calls };
}
const verifier = (g: ReturnType<typeof gateway>, profile = baseProfile()) => createPiGatewayVerifier({ configuration, descriptor: descriptor(profile), run: g.run as never });
const code = async (promise: Promise<unknown>) => { try { await promise; } catch (error) { return error instanceof OpenShellError ? error.code : `other:${String(error)}`; } return "ok"; };

describe("canonical gateway profile digest", () => {
  it("ignores key order and the fields the gateway assigns, and nothing else", () => {
    const profile = baseProfile();
    const reordered = Object.fromEntries(Object.entries(profile).reverse());
    expect(canonicalGatewayProfileDigest(reordered)).toBe(canonicalGatewayProfileDigest(profile));
    expect(canonicalGatewayProfileDigest({ ...profile, resource_version: 99, source: "builtin", scope: "global" })).toBe(canonicalGatewayProfileDigest(profile));
    expect(canonicalGatewayProfile(profile)).not.toContain("resource_version");
    for (const changed of [{ ...profile, description: "other" }, { ...profile, binaries: ["/usr/local/bin/node", "/bin/sh"] }, { ...profile, inference_capable: false },
      { ...profile, endpoints: [{ ...profile.endpoints[0], port: 8443 }] }]) expect(canonicalGatewayProfileDigest(changed)).not.toBe(canonicalGatewayProfileDigest(profile));
    expect(() => canonicalGatewayProfile("text")).toThrow();
    expect(PI_PROFILE_BINARIES).toEqual(["/usr/local/bin/node"]);
  });
});

describe("pi gateway verification (read-only, fail closed)", () => {
  afterEach(() => { vi.useRealTimers(); });
  it("accepts the exact provider and profile, using only list and export", async () => {
    const g = gateway();
    await expect(verifier(g)()).resolves.toBeUndefined();
    expect(g.calls.map(argv => argv.slice(4).join(" "))).toEqual(["provider list --output json --page-size 100", "provider profile export vendor-profile --output json"]);
    expect(g.calls.every(argv => argv[0] === "--gateway" && argv[1] === "gw" && argv[2] === "--workspace" && argv[3] === "default")).toBe(true);
    for (const argv of g.calls) for (const verb of ["create", "update", "delete", "import", "refresh"]) expect(argv).not.toContain(verb);
  });
  it("follows provider pages and still requires exactly one match", async () => {
    const other = { ...baseProvider(), name: "other-provider" };
    await expect(verifier(gateway({ providers: [[other], [baseProvider()]] }))()).resolves.toBeUndefined();
    expect(await code(verifier(gateway({ providers: [[baseProvider()], [baseProvider()]] }))())).toBe("openshell_identity_mismatch");
  });
  const providerCases: [string, unknown[][]][] = [
    ["a missing provider", [[{ ...baseProvider(), name: "other" }]]],
    ["a provider of another type", [[{ ...baseProvider(), type: "someone-elses-profile" }]]],
    ["an extra credential key", [[{ ...baseProvider(), credential_keys: ["VENDOR_KEY", "EXTRA"] }]]],
    ["a different credential key", [[{ ...baseProvider(), credential_keys: ["OTHER_KEY"] }]]],
    ["no credential key", [[{ ...baseProvider(), credential_keys: [] }]]],
    ["another workspace", [[{ ...baseProvider(), workspace: "elsewhere" }]]],
    ["a duplicate provider", [[baseProvider(), baseProvider()]]],
  ];
  it.each(providerCases)("refuses %s", async (_name, providers) => { expect(await code(verifier(gateway({ providers }))())).toBe("openshell_identity_mismatch"); });
  const profileCases: [string, (profile: ReturnType<typeof baseProfile>) => unknown][] = [
    ["a changed profile body", profile => ({ ...profile, description: "tampered" })],
    ["an extra endpoint", profile => ({ ...profile, endpoints: [...profile.endpoints, { host: "evil.example.test", port: 443, protocol: "rest", access: "read-write", enforcement: "enforce" }] })],
    ["no endpoint", profile => ({ ...profile, endpoints: [] })],
    ["another host", profile => ({ ...profile, endpoints: [{ ...profile.endpoints[0], host: "evil.example.test" }] })],
    ["another port", profile => ({ ...profile, endpoints: [{ ...profile.endpoints[0], port: 8443 }] })],
    ["a weaker protocol", profile => ({ ...profile, endpoints: [{ ...profile.endpoints[0], protocol: "tcp" }] })],
    ["a weaker enforcement", profile => ({ ...profile, endpoints: [{ ...profile.endpoints[0], enforcement: "audit" }] })],
    ["an extra binary", profile => ({ ...profile, binaries: ["/usr/local/bin/node", "/bin/sh"] })],
    ["another binary", profile => ({ ...profile, binaries: ["/bin/sh"] })],
    ["no binary", profile => ({ ...profile, binaries: [] })],
    ["another credential env", profile => ({ ...profile, credentials: [{ ...profile.credentials[0], env_vars: ["OTHER_KEY"] }] })],
    ["an extra credential", profile => ({ ...profile, credentials: [...profile.credentials, { name: "second", env_vars: ["SECOND_KEY"] }] })],
    ["another profile id", profile => ({ ...profile, id: "other-profile" })],
  ];
  it.each(profileCases)("refuses %s", async (_name, tamper) => {
    // The descriptor is built from the original profile, so any change the gateway shows differs from what the operator recorded.
    const original = baseProfile();
    const g = gateway({ profile: tamper(baseProfile()) });
    expect(await code(createPiGatewayVerifier({ configuration, descriptor: descriptor(original), run: g.run as never })())).toBe("openshell_identity_mismatch");
  });
  // The recorded digest is that of the tampered profile itself, so the digest guard passes and each structural guard has to refuse on its own.
  const structural = profileCases.filter(([name]) => name !== "a changed profile body");
  it.each(structural)("refuses %s with the tampered profile's own digest recorded: the structural guards stand alone", async (_name, tamper) => {
    const tampered = tamper(baseProfile());
    const recorded = descriptor(tampered as ReturnType<typeof baseProfile>);
    expect(recorded.profileDigest).toBe(canonicalGatewayProfileDigest(tampered));
    const g = gateway({ profile: tampered });
    expect(await code(createPiGatewayVerifier({ configuration, descriptor: recorded, run: g.run as never })())).toBe("openshell_identity_mismatch");
  });
  it("accepts a profile whose own digest is recorded when it is structurally exact, so the cases above refuse for the structure alone", async () => {
    const same = { ...baseProfile(), description: "operator reworded the description" };
    const g = gateway({ profile: same });
    await expect(createPiGatewayVerifier({ configuration, descriptor: descriptor(same), run: g.run as never })()).resolves.toBeUndefined();
  });
  it("refuses a digest that does not match an otherwise identical profile", async () => {
    const g = gateway(); const wrong = { ...descriptor(), profileDigest: `sha256:${"0".repeat(64)}` };
    expect(await code(createPiGatewayVerifier({ configuration, descriptor: wrong, run: g.run as never })())).toBe("openshell_identity_mismatch");
  });
  it("treats a command failure, bad JSON and a surprising shape as closed errors", async () => {
    expect(await code(verifier(gateway({ fail: "provider" }))())).toBe("openshell_gateway_unavailable");
    expect(await code(verifier(gateway({ fail: "profile" }))())).toBe("openshell_gateway_unavailable");
    expect(await code(verifier(gateway({ raw: "not json" }))())).toBe("openshell_protocol_invalid");
    expect(await code(verifier(gateway({ raw: JSON.stringify({ providers: "nope" }) }))())).toBe("openshell_protocol_invalid");
    expect(await code(verifier(gateway({ raw: JSON.stringify({ providers: [baseProvider()] }) }))())).toBe("openshell_protocol_invalid");
  });
  it("bounds pagination", async () => {
    const pages = Array.from({ length: 30 }, () => [{ ...baseProvider(), name: "other" }]);
    expect(await code(verifier(gateway({ providers: pages }))())).toBe("openshell_protocol_invalid");
  });
  it("stops on cancellation instead of reporting a mismatch", async () => {
    const controller = new AbortController(); const pending = code(verifier(gateway({ delay: true }))(controller.signal)); controller.abort();
    expect(await pending).toBe("openshell_cancelled");
  });
  it("refuses to run a replaced gateway executable", async () => {
    const g = gateway();
    expect(await code(createPiGatewayVerifier({ configuration: { ...configuration, executableDigest: `sha256:${"0".repeat(64)}` }, descriptor: descriptor(), run: g.run as never })())).toBe("openshell_identity_mismatch");
    expect(g.run).not.toHaveBeenCalled();
  });
  describe("the total deadline", () => {
    /** A gateway that answers every call after `delayMs` of (fake) time, and honours abort the way the command runner does. */
    const slow = (delayMs: number, pages = 40) => {
      const seen: { aborted: boolean; timeoutMs: unknown }[] = [];
      const run = vi.fn(async (_exe: string, argv: readonly string[], _env: NodeJS.ProcessEnv, signal?: AbortSignal, timeoutMs?: number) => {
        const entry = { aborted: false, timeoutMs }; seen.push(entry);
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, delayMs);
          signal?.addEventListener("abort", () => { clearTimeout(timer); entry.aborted = true; reject(new OpenShellError("openshell_remote_unknown")); }, { once: true });
        });
        const command = argv.slice(4);
        if (command[1] === "list") { const token = command.includes("--page-token") ? Number(command[command.indexOf("--page-token") + 1]) : 0; return JSON.stringify({ providers: [{ ...baseProvider(), name: "other" }], next_page_token: token + 1 < pages ? String(token + 1) : "" }); }
        return JSON.stringify(baseProfile());
      });
      return { run, seen };
    };
    it("bounds the whole proof, not each call: many calls that each finish in time are still cut off at the deadline, without a real wait", async () => {
      vi.useFakeTimers();
      const g = slow(9_000); let outcome: string | undefined;
      const pending = code(createPiGatewayVerifier({ configuration, descriptor: descriptor(), run: g.run as never })()).then(value => { outcome = value; });
      await vi.advanceTimersByTimeAsync(PI_GATEWAY_TOTAL_DEADLINE_MS - 1);
      expect(outcome).toBeUndefined(); expect(g.run.mock.calls.length).toBe(3);
      await vi.advanceTimersByTimeAsync(2); await pending;
      expect(outcome).toBe("openshell_gateway_unavailable");
      expect(g.seen.at(-1)).toMatchObject({ aborted: true });
      // Nothing runs after the deadline: no fourth call, no timer left behind.
      await vi.advanceTimersByTimeAsync(60_000); expect(g.run.mock.calls.length).toBe(3); expect(vi.getTimerCount()).toBe(0);
      expect(PI_GATEWAY_TOTAL_DEADLINE_MS).toBe(25_000);
    });
    it("gives each command its own bounded deadline and clears the timer when the proof finishes in time", async () => {
      vi.useFakeTimers();
      const g = slow(10, 1);
      const pending = createPiGatewayVerifier({ configuration, descriptor: descriptor(), run: g.run as never })();
      // the single provider page has no match for the descriptor: it must fail on the mismatch, not on a deadline
      const refused = expect(pending).rejects.toMatchObject({ code: "openshell_identity_mismatch" });
      await vi.advanceTimersByTimeAsync(20); await refused;
      expect(g.seen.every(entry => entry.timeoutMs === 10_000)).toBe(true); expect(vi.getTimerCount()).toBe(0);
    });
    it("fails closed and leaves no timer when the caller cancels in the middle of a call", async () => {
      vi.useFakeTimers();
      const g = slow(9_000); const controller = new AbortController();
      const pending = code(createPiGatewayVerifier({ configuration, descriptor: descriptor(), run: g.run as never })(controller.signal));
      await vi.advanceTimersByTimeAsync(1_000); controller.abort(); await vi.advanceTimersByTimeAsync(1);
      expect(await pending).toBe("openshell_gateway_unavailable");
      expect(vi.getTimerCount()).toBe(0);
    });
  });
});
