import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Store } from "../server/db.js";
import { OpenShellLifecycle } from "../server/runtime-host/openshell-lifecycle.js";
import { OPEN_SHELL_OWNER_LABEL, type OpenShellDriver, type OpenShellIntent, type OpenShellResource } from "../server/runtime-host/openshell-types.js";
import { createOpenShellPiProvider, piAccountDigest, type PiProviderConfig } from "../server/runtime-host/openshell-pi-provider.js";
import { isPiQueryAbort, PiComponentError, runPiComponentStep } from "../server/runtime-host/pi-component-step.js";
import { GovernedWrenError } from "../harness/components/wren-access.js";
import { isClaudeQueryAbort } from "../server/runtime-host/claude-component-step.js";
import type { StepRun } from "../harness/components/runner.js";
import { PiSim, happyBehavior } from "./pi-sim.js";

const sha = (char: string) => `sha256:${char.repeat(64)}`;
const identity = { image: sha("a"), policy: sha("b"), gateway: "gateway", workspace: "default", configuration: sha("c") };
const config: PiProviderConfig = { provider: "stub-provider", displayLabel: "stub vendor", profileDigest: sha("d"), generation: "gen-1",
  endpoint: { providerId: "stubvendor", api: "openai-completions", baseUrl: "http://host.example.test:18694/v1", credentialEnv: "STUB_KEY" } };
const schema = { type: "object", properties: { code: { type: "string" } }, required: ["code"], additionalProperties: false };
const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); });

async function fixture(behavior: () => ConstructorParameters<typeof PiSim>[0]) {
  const root = mkdtempSync(path.join(tmpdir(), "genbi-pi-abort-")); const store = new Store(":memory:");
  const resources = new Map<string, OpenShellResource>(); let count = 0;
  const driver: OpenShellDriver = { version: "0.0.1", identity, modelIdentity: identity, probe: async () => {},
    create: async (intent: OpenShellIntent) => { const resource = { id: `r-${++count}`, name: intent.name, workspace: "default", labels: { [OPEN_SHELL_OWNER_LABEL]: intent.owner } }; resources.set(intent.name, resource); return resource; },
    list: async (intent: OpenShellIntent) => [...resources.values()].filter(row => row.labels[OPEN_SHELL_OWNER_LABEL] === intent.owner),
    inspect: async (intent: OpenShellIntent) => resources.get(intent.name)!, remove: async (intent: OpenShellIntent) => { resources.delete(intent.name); }, assertAbsent: async () => {},
    exec: async () => JSON.stringify({ type: "genbi.pi.procs", version: 1, remaining: 0 }), duplex: async () => new PiSim(behavior()).stream } as unknown as OpenShellDriver;
  const lifecycle = new OpenShellLifecycle({ driver, journal: store, stateRoot: root, exclusive: true }); await lifecycle.initialize();
  cleanup.push(async () => { await lifecycle.shutdown().catch(() => {}); store.close(); rmSync(root, { recursive: true, force: true }); });
  const scope = { backend: "openshell" as const, account: piAccountDigest(config), generation: config.generation, session: "s", turn: "t", binding: "b", bindingGeneration: "1", bindingRevision: sha("e"), context: sha("f"), plan: sha("1"), ...identity };
  const provider = createOpenShellPiProvider({ lifecycle, config, models: { fast: "stub-model" }, scope, currentScope: () => scope, assertCurrent() {} });
  return { open: () => provider.open("stub-model", new AbortController().signal, "fast") };
}
const run = (tool: (input: unknown) => Promise<unknown>, signal = new AbortController().signal): StepRun => ({ tier: "fast", request: "ask", input: {}, brief: "B", prompt: "P", consumes: {}, children: [], tools: { lookup: tool },
  toolSchemas: { lookup: schema }, toolDescriptions: { lookup: "lookup" }, signal });
const withCall = () => happyBehavior({ call: { name: "lookup", args: { code: "K7" } } });
const caught = async (promise: Promise<unknown>) => { try { await promise; } catch (error) { return error; } throw new Error("expected a failure"); };

describe("pi query abort classification", () => {
  it("marks only an actual governed query rejection from a host tool, with the step still failing as a protocol fault", async () => {
    const f = await fixture(withCall);
    const error = await caught(runPiComponentStep(await f.open(), run(async () => { throw new GovernedWrenError("execution_failed"); })));
    expect(error).toBeInstanceOf(PiComponentError); expect((error as PiComponentError).reason).toBe("protocol");
    expect(isPiQueryAbort(error)).toBe(true); expect(isClaudeQueryAbort(error)).toBe(false);
  });
  it.each([
    ["an ordinary tool error", () => new Error("boom")],
    ["a serialized lookalike", () => ({ name: "GovernedWrenError", errorClass: "execution_failed" })],
    ["a proxy around a governed error", () => new Proxy(new GovernedWrenError("execution_failed"), {})],
    ["a subclass", () => new (class extends GovernedWrenError {})("execution_failed")],
  ])("does not mark %s", async (_name, make) => {
    const f = await fixture(withCall);
    const error = await caught(runPiComponentStep(await f.open(), run(async () => { throw make(); })));
    expect(isPiQueryAbort(error)).toBe(false);
  });
  it("does not mark a governed rejection that lost the race with a cancel", async () => {
    const controller = new AbortController(); const f = await fixture(withCall);
    const error = await caught(runPiComponentStep(await f.open(), run(async () => { controller.abort(); throw new GovernedWrenError("execution_failed"); }, controller.signal)));
    expect(isPiQueryAbort(error)).toBe(false);
  });
  it("does not mark a model failure, an unrelated error object or a successful step", async () => {
    const f = await fixture(() => happyBehavior({ stop: "length" }));
    const error = await caught(runPiComponentStep(await f.open(), run(async () => ({ ok: true }))));
    expect(isPiQueryAbort(error)).toBe(false);
    for (const value of [undefined, null, "text", 1, {}, new Error("x"), new PiComponentError("protocol")]) expect(isPiQueryAbort(value)).toBe(false);
    const ok = await fixture(() => happyBehavior({ call: { name: "lookup", args: { code: "K7" } } }));
    await expect(runPiComponentStep(await ok.open(), run(async () => ({ word: "marmalade" })))).resolves.toMatchObject({ value: "answer text" });
  });
});
