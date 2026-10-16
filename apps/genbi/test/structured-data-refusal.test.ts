import { afterEach, describe, expect, it, vi } from "vitest";
import { GovernedWrenError, type GovernedErrorClass } from "../harness/components/wren-access.js";
import { Store } from "../server/db.js";
import { observeStructuredQueryAccess, structuredDataRefusal } from "../server/structured-error-feedback.js";
import { StructuredRuntime, StructuredRuntimeError } from "../server/structured-runtime.js";
import { runtimeReady } from "../server/runtime-host/policy.js";
import { getAskSessionData, streamTurn, type TurnDeps } from "../server/turn.js";
import { resolveRuntimeSelection } from "../server/runtime-selection.js";
const openshellClaude = resolveRuntimeSelection({ GENBI_RUNTIME: "openshell", GENBI_BACKEND: "claude" });

const stores: Store[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });
const baseRouteOptions: TurnDeps["baseRouteOptions"] = { authChoice: { mode: "subscription", provider: "claude" }, profileSource: "fixture", userProject: "/fixture" };
async function queryFailure(errorClass: GovernedErrorClass) {
  let captured: Error | undefined;
  const access = observeStructuredQueryAccess({ async query() { throw new GovernedWrenError(errorClass); }, async inspect() {}, async close() {} }, failure => { captured = failure; });
  await access.query({ sql: "SELECT unavailable", limit: 1 }, new AbortController().signal).catch(() => {});
  return captured;
}
function fixture(error: unknown, change?: (store: Store) => void) {
  const store = new Store(":memory:"); stores.push(store);
  const session = store.createSession("Orders");
  const turn = store.createTurn({ id: "test-turn", sessionId: session.id, question: "synthetic question", composedInput: null });
  const ask = vi.fn(async () => { change?.(store); throw error; });
  const local = vi.fn(async () => { throw Error("local forbidden"); });
  const runtime = new StructuredRuntime({ selection: openshellClaude, localRoute: local, localSetupFor: () => undefined,
    adapters: { claude: { vendor: "claude", backend: "openshell", probe: async () => runtimeReady("synthetic", []), ask } } });
  const deps: TurnDeps = { store, route: local, structuredRuntime: runtime, baseRouteOptions };
  return { store, session, turn, ask, deps };
}

describe("normal host data-query refusal", () => {
  it.each(["execution_failed", "invalid_sql", "model_not_found", "cube_not_queryable"] as const)("persists %s as an explanatory refusal and replays it without another route", async code => {
    const f = fixture(await queryFailure(code)); const frames: any[] = [];
    await streamTurn(f.deps, f.session.id, f.turn.id, async frame => { frames.push(frame); });
    expect(f.store.getTurn(f.turn.id)).toMatchObject({ resultKind: "refusal", errorCode: `query.${code}`, backend: null });
    const explanation = structuredDataRefusal(`query.${code}`)!;
    expect(frames).toContainEqual({ event: "event", data: expect.objectContaining({ kind: "refusal", ...explanation }) });
    expect(frames.at(-1)).toEqual({ event: "done", data: {} });
    expect(frames.some(frame => frame.event === "error")).toBe(false);
    expect(JSON.stringify(frames)).not.toMatch(/"verified"|"table"|"price"/);
    const saved = f.store.listEventsForTurn(f.turn.id); expect(saved.filter(event => event.kind === "refusal")).toHaveLength(1);
    const replay: unknown[] = []; await streamTurn(f.deps, f.session.id, f.turn.id, async frame => { replay.push(frame); });
    expect(replay).toEqual(frames); expect(f.ask).toHaveBeenCalledOnce(); expect(f.store.listEventsForTurn(f.turn.id)).toEqual(saved);
    const hydrated = getAskSessionData(f.store, f.session.id); expect(hydrated).not.toHaveProperty("error");
    expect(hydrated.events).toEqual(saved.map(event => event.payload));
  });
  it.each(["transport", "timeout", "datasource_unavailable", "internal"] as const)("keeps query %s as an error", async code => {
    const f = fixture(await queryFailure(code)); const frames: any[] = [];
    await streamTurn(f.deps, f.session.id, f.turn.id, async frame => { frames.push(frame); });
    expect(f.store.getTurn(f.turn.id)?.resultKind).toBe("error"); expect(frames.at(-1).event).toBe("error");
    expect(f.store.listEventsForTurn(f.turn.id)).toEqual([]); expect(getAskSessionData(f.store, f.session.id)).toHaveProperty("error");
  });
  it.each(["cancelled", "stale", "cleanup", "timeout"] as const)("preserves runtime %s instead of a normal refusal", async code => {
    const f = fixture(new StructuredRuntimeError(code)); await streamTurn(f.deps, f.session.id, f.turn.id, async () => {});
    expect(f.store.getTurn(f.turn.id)).toMatchObject({ resultKind: "error", errorCode: `runtime.${code}` }); expect(f.store.listEventsForTurn(f.turn.id)).toEqual([]);
  });
  it("keeps a sensitive unknown error generic, and currentness overrides a previously known query cause", async () => {
    const unknown = fixture(Error("private-token /private/path missing price")); await streamTurn(unknown.deps, unknown.session.id, unknown.turn.id, async () => {});
    expect(unknown.store.getTurn(unknown.turn.id)).toMatchObject({ resultKind: "error", errorCode: "runtime.failed", errorMessage: "Structured runtime failed." });
    const stale = fixture(await queryFailure("execution_failed"), store => store.setRuntimeSettings({ ...store.getRuntimeSettings(), subscriptionDriverModel: "changed" }));
    await streamTurn(stale.deps, stale.session.id, stale.turn.id, async () => {});
    expect(stale.store.getTurn(stale.turn.id)).toMatchObject({ resultKind: "error", errorCode: "runtime.stale" });
  });
  it.each([false, true])("projects a historical known error without rewriting rows or duplicating a stored refusal (stored=%s)", async withStored => {
    const f = fixture(Error("must not execute"));
    f.store.resolveTurn(f.turn.id, { backend: null, resultKind: "error", answerSummary: null, errorMessage: "original safe error", errorCode: "query.execution_failed", traceJson: JSON.stringify([{ id: "failed-tool", label: "query_read_only", state: "error", kind: "tool" }]) });
    if (withStored) f.store.insertEvent({ sessionId: f.session.id, turnId: f.turn.id, kind: "refusal", payload: { id: "existing", kind: "refusal", ...structuredDataRefusal("query.execution_failed")! } });
    const row = f.store.getTurn(f.turn.id); const events = f.store.listEventsForSession(f.session.id);
    const first = getAskSessionData(f.store, f.session.id); const second = getAskSessionData(f.store, f.session.id);
    expect(first).toEqual(second); expect(first).not.toHaveProperty("error"); expect(first.events.filter(event => event.kind === "refusal")).toHaveLength(1);
    expect(first.workLog).toContainEqual(expect.objectContaining({ state: "error" }));
    const replay: any[] = []; await streamTurn(f.deps, f.session.id, f.turn.id, async frame => { replay.push(frame); });
    expect(replay.filter(frame => frame.event === "event").map(frame => frame.data)).toEqual(first.events);
    expect(f.store.getTurn(f.turn.id)).toEqual(row); expect(f.store.listEventsForSession(f.session.id)).toEqual(events); expect(f.ask).not.toHaveBeenCalled();
  });
});
