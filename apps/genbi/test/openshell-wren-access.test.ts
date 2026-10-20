import { describe, expect, it } from "vitest";
import { GovernedWrenError } from "../harness/components/wren-access.js";
import { openOpenShellWrenAccess, type WrenWorkerIdentity } from "../server/runtime-host/openshell-wren-access.js";
import type { DataSnapshotLease } from "../server/runtime-host/openshell-project-snapshots.js";
import type { OpenShellDuplex } from "../server/runtime-host/openshell-types.js";
const digest = `sha256:${"a".repeat(64)}`;
const expected: WrenWorkerIdentity = { worker: "genbi-wren-worker/1", snapshot: digest, script: digest, wheel: digest, toolchain: digest, architecture: "linux-arm64", protocol: "wren-governed/2" };
function fixture(handshake: unknown[] = [expected, { id: 0, protocol: expected.protocol }]) {
  let wake: (() => void) | undefined, stopped = false, closed = 0, writes = 0, valid = true;
  const packets: Buffer[] = [Buffer.from(handshake.map(x => JSON.stringify(x)).join("\n") + "\n")];
  const push = (b: Buffer) => { packets.push(b); wake?.(); };
  const stream: OpenShellDuplex = {
    output: (async function* () { while (!stopped) { if (packets.length) yield { stream: "stdout" as const, data: packets.shift()! }; else await new Promise<void>(r => { wake = r; }); } })(),
    write(data) { writes++; const req = JSON.parse(data.toString()); push(Buffer.from(JSON.stringify({ id: req.id, result: req.operation === "inspect" ? { models: ["orders"] } : { rows: [{ id: 1 }], columns: ["id"], definition: { sql: req.sql, source_tables: ["orders"], filters: [] } } }) + "\n")); },
    close() { stopped = true; wake?.(); }, done: new Promise(() => {}),
  };
  const lease: DataSnapshotLease = { id: "worker", reference: "ref", assertActive() { if (!valid) throw new Error("stale"); },
    async verify() { if (!valid) throw new Error("stale"); return { digest } as never; }, async read() { return Buffer.from(JSON.stringify({ models: ["orders"] })); },
    async openGoverned() { return stream; }, async close() { closed++; valid = false; stream.close(); } };
  const controller = new AbortController();
  return { lease, controller, stream, push, get closed() { return closed; }, get writes() { return writes; }, stale() { valid = false; },
    open: (declaredDefaults?: readonly string[]) => openOpenShellWrenAccess({ lease, expected, signal: controller.signal, assertCurrent() { if (!valid) throw new Error("stale"); },
      ...(declaredDefaults ? { declaredDefaults } : {}) }) };
}
describe("admitted OpenShell governed data transport", () => {
  it("compares the independent tuple before inspect/query and closes owned worker", async () => {
    const f = fixture(), access = await f.open();
    expect(await access.inspect(f.controller.signal)).toEqual({ models: ["orders"] });
    expect(await access.query({ sql: "select * from orders", limit: 1 }, f.controller.signal)).toMatchObject({ rows: [{ id: 1 }] });
    await access.close(); await access.close(); expect(f.closed).toBe(1); expect(f.writes).toBe(2);
  });
  it.each(["snapshot", "script", "wheel", "toolchain", "architecture", "protocol"])("rejects substituted %s before any query", async key => {
    const f = fixture([{ ...expected, [key]: "wrong" }, { id: 0, protocol: expected.protocol }]);
    await expect(f.open()).rejects.toThrow(); expect(f.writes).toBe(0); expect(f.closed).toBe(1);
  });
  it.each([{ frames: [expected, expected] }, { frames: [expected, { id: 0, protocol: expected.protocol }, expected] }])("rejects duplicate or late prelude", async ({ frames }) => {
    const f = fixture(frames); await expect(f.open()).rejects.toThrow(); expect(f.closed).toBe(1);
  });
  it("fences scope abort synchronously and awaits cleanup", async () => {
    const f = fixture(), a = await f.open(); f.controller.abort();
    await expect(a.inspect(new AbortController().signal)).rejects.toThrow(); await a.close(); expect(f.closed).toBe(1); expect(f.writes).toBe(0);
  });
  it("rejects unsolicited partial bytes", async () => {
    const f = fixture(), a = await f.open(); f.push(Buffer.from("{"));
    await new Promise(r => setTimeout(r, 10)); await expect(a.inspect(f.controller.signal)).rejects.toThrow(); await a.close(); expect(f.closed).toBe(1);
  });
  it("rejects framing flood and invalid UTF8", async () => {
    for (const bytes of [Buffer.alloc(1_048_578, 65), Buffer.from([255, 10])]) {
      const f = fixture(), a = await f.open(); f.push(bytes); await new Promise(r => setTimeout(r, 10));
      await expect(a.inspect(f.controller.signal)).rejects.toThrow(); await a.close(); expect(f.closed).toBe(1);
    }
  });
  it.each(["oversized rows", "substituted SQL", "substituted manifest"])("rejects a hostile peer's %s and cleans its worker", async kind => {
    const f = fixture(), access = await f.open();
    f.stream.write = bytes => {
      const req = JSON.parse(bytes.toString());
      const result = kind === "substituted manifest" ? { models: ["other-project"] }
        : { columns: ["id"], rows: kind === "oversized rows" ? [{ id: 1 }, { id: 2 }] : [{ id: 1 }],
          definition: { sql: kind === "substituted SQL" ? "SELECT * FROM other_project" : req.sql, source_tables: ["orders"], filters: [] } };
      f.push(Buffer.from(JSON.stringify({ id: req.id, result }) + "\n"));
    };
    const call = kind === "substituted manifest" ? access.inspect(f.controller.signal) : access.query({ sql: "select id from orders", limit: 1 }, f.controller.signal);
    await expect(call).rejects.toThrow("Governed Wren"); await access.close(); expect(f.closed).toBe(1);
  });
  const sentence = "The query does not apply a default rule that the bound project declares for the models it reads, so it was not executed. Apply the rule named below (its wording is in the project's knowledge rules), then run the query again.";
  const missing = (f: ReturnType<typeof fixture>, error: Record<string, unknown>) => { f.stream.write = bytes => f.push(Buffer.from(JSON.stringify({ id: JSON.parse(bytes.toString()).id, error }) + "\n")); };
  const refusal = (access: Awaited<ReturnType<ReturnType<typeof fixture>["open"]>>, f: ReturnType<typeof fixture>) =>
    access.query({ sql: "select id from orders", limit: 1 }, f.controller.signal).then(() => undefined as never, (reason: unknown) => reason as GovernedWrenError);
  const v3 = (ids: unknown) => ({ id: 0, protocol: "wren-governed/3", declared_defaults: ids });
  it("renders a declared-default refusal for a project that declares nothing as the fixed sentence alone, dropping any rule ids", async () => {
    const f = fixture(), access = await f.open();
    missing(f, { class: "declared_default_missing", message: "x" });
    const error = await refusal(access, f);
    expect(error).toBeInstanceOf(GovernedWrenError); expect(error.errorClass).toBe("declared_default_missing");
    expect(error.message).toContain("does not apply a default rule that the bound project declares"); expect(error.message).not.toContain("Rule:");
    missing(f, { class: "declared_default_missing", message: "x", rule_ids: ["a"] });
    const named = await refusal(access, f);
    expect(named.errorClass).toBe("declared_default_missing"); expect(named.message).not.toContain("Rule:"); expect(named.ruleIds).toEqual([]);
    await access.close();
  });
  it("keeps today's protocol 2 hello for a project that declares nothing, with or without an empty set", async () => {
    await (await fixture().open()).close(); await (await fixture().open([])).close();
  });
  it("accepts a protocol 3 hello announcing exactly the declared set, in any order, and renders the sentence with the declared rule ids only", async () => {
    const f = fixture([expected, v3(["b", "a"])]), access = await f.open(["a", "b"]);
    missing(f, { class: "declared_default_missing", message: "wire text with /private/path", rule_ids: ["b", "zz", "b", "a"] });
    const error = await refusal(access, f);
    expect(error.errorClass).toBe("declared_default_missing"); expect(error.ruleIds).toEqual(["b", "a"]);
    expect(error.message).toBe(`Governed Wren query failed [declared_default_missing]: ${sentence} Rule: b, a`); expect(error.message).not.toMatch(/zz|private/);
    missing(f, { class: "declared_default_missing", message: "x", rule_ids: ["zz"] });
    expect((await refusal(access, f)).message).toBe(`Governed Wren query failed [declared_default_missing]: ${sentence}`);
    await access.close(); expect(f.closed).toBe(1);
  });
  it("still answers queries on a declaring project", async () => {
    const f = fixture([expected, v3(["a"])]), access = await f.open(["a"]);
    expect(await access.query({ sql: "select * from orders", limit: 1 }, f.controller.signal)).toMatchObject({ rows: [{ id: 1 }] });
    await access.close();
  });
  it.each([
    ["a different set", v3(["a", "c"]), ["a", "b"]],
    ["one id of two", v3(["a"]), ["a", "b"]],
    ["an extra id", v3(["a", "b"]), ["a"]],
    ["a repeated id", v3(["a", "a"]), ["a", "b"]],
    ["an empty list", v3([]), ["a"]],
    ["protocol 3 without the field", { id: 0, protocol: "wren-governed/3" }, ["a"]],
    ["a protocol 2 hello on a declaring project", { id: 0, protocol: "wren-governed/2" }, ["a"]],
    ["declarations the host does not know of", v3(["a"]), []],
    ["an empty list for a project that declares nothing", v3([]), []],
    ["the field on a protocol 2 hello", { id: 0, protocol: "wren-governed/2", declared_defaults: ["a"] }, []],
  ])("is unavailable with the fixed declarations reason for %s, before any query", async (_name, hello, declared) => {
    const f = fixture([expected, hello]);
    const error = await f.open(declared).catch((reason: unknown) => reason) as GovernedWrenError;
    expect(error).toBeInstanceOf(GovernedWrenError); expect(error.errorClass).toBe("transport"); expect(error.reason).toBe("governed_declarations_mismatch");
    expect(error.message).toBe("Governed Wren query failed [transport]: Governed Wren operation is unavailable."); expect(f.writes).toBe(0); expect(f.closed).toBe(1);
  });
  it("gives a hello that is no declarations matter no declarations reason", async () => {
    const f = fixture([expected, { id: 0, protocol: "wren-governed/2", result: 1 }]);
    const error = await f.open().catch((reason: unknown) => reason) as GovernedWrenError;
    expect(error).toBeInstanceOf(GovernedWrenError); expect(error.reason).toBeUndefined();
  });
  it("fails closed on rule ids carried by any other class, and on malformed or over-long ids", async () => {
    for (const frame of [{ class: "invalid_sql", message: "x", rule_ids: ["a"] }, { class: "declared_default_missing", message: "x", rule_ids: ["Bad Id"] },
      { class: "declared_default_missing", message: "x", rule_ids: ["a", "b", "c", "d", "e", "f", "g", "h", "i"] }]) {
      const f = fixture([expected, v3(["a"])]), access = await f.open(["a"]); missing(f, frame);
      await expect(access.query({ sql: "select id from orders", limit: 1 }, f.controller.signal)).rejects.toThrow("Governed Wren"); await access.close(); expect(f.closed).toBe(1);
    }
  });
  it("a statement deadline during snapshot verification fences and cleans before any query write", async () => {
    const f = fixture(), access = await f.open(), parent = new AbortController();
    let rejectVerification!: (error: Error) => void;
    f.lease.verify = () => new Promise((_resolve, reject) => { rejectVerification = reject; });
    const originalClose = f.lease.close;
    f.lease.close = async () => { await originalClose(); rejectVerification(new Error("verification cancelled")); };
    const query = access.query({ sql: "select id from orders", limit: 1 }, parent.signal);
    await new Promise(resolve => setTimeout(resolve, 0)); parent.abort(new DOMException("deadline", "TimeoutError"));
    await expect(query).rejects.toThrow(); await access.close(); expect(f.closed).toBe(1); expect(f.writes).toBe(0);
  });
  it("propagates an early readiness abort after a pending lease verification and cleans once", async () => {
    const f = fixture(); let entered!: () => void, finish!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    f.lease.verify = async () => { entered(); await new Promise<void>(resolve => { finish = resolve; }); return { digest } as never; };
    const opening = f.open(); const rejected = expect(opening).rejects.toThrow();
    await started; f.controller.abort(); await new Promise(resolve => setTimeout(resolve, 10)); finish();
    await rejected; expect(f.closed).toBe(1); expect(f.writes).toBe(0);
  });
  it("does not turn cleanup failure into success", async () => {
    const f = fixture(); f.lease.close = async () => { throw new Error("cleanup pending"); };
    const a = await f.open(); await expect(a.close()).rejects.toThrow("cleanup pending");
  });
});
