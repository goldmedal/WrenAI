import { describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import path from "node:path";

const assets = path.join(process.cwd(), "runtime-assets/pi-worker");
const scope = "11111111-1111-4111-8111-111111111111";
const exitFrame = { t: "exit", scope, code: 0, signal: null, forced: false, remaining: 0 };
const line = (value: unknown) => JSON.stringify(value) + "\n";
interface Options { platform?: string; uid?: number; body?: Buffer; pins?: Record<string, string>; existing?: boolean; identity?: { group: number; parent: number; start: string }; mismatch?: string }

/** The actual supervisor body runs against synthetic OS bindings: nothing here is a mock of its decisions. */
async function fixture(options: Options = {}) {
  const source = readFileSync(path.join(assets, "pi-session-step.mjs"), "utf8");
  const body = source.replace(/^import .*;$/gm, "");
  const boot = options.body ?? Buffer.from(JSON.stringify({ protocol: 1, scope, token: "ab".repeat(16), credentialEnv: "VENDOR_KEY", argv: ["--mode", "json"], files: {} }));
  const prefix = Buffer.alloc(4); prefix.writeUInt32BE(boot.length); const input = Buffer.concat([prefix, boot]); let offset = 0;
  const stdout: string[] = [], writes: { to: "worker" | "host"; data: string }[] = [], files = new Map<string, string>(), directories: { path: string; mode: number }[] = [], exists: string[] = [];
  const pins = options.pins ?? { nodeVersion: "v24.20.0", node: "pin", sessionStep: "pin", stepControl: "pin", worker: "pin", pins: "pin" };
  const child = Object.assign(new EventEmitter(), { pid: 501, stdout: new EventEmitter(), stderr: { pipe() {} },
    stdin: Object.assign(new EventEmitter(), { write(value: Buffer) { writes.push({ to: "worker", data: value.toString() }); return true; } }), kill() { writes.push({ to: "host", data: "kill" }); } });
  const spawned: { command: string; args: string[]; env: unknown; cwd: unknown; detached: unknown }[] = [];
  const fs = {
    readSync(_fd: number, target: Buffer, to: number, length: number) { const n = Math.min(length, input.length - offset); input.copy(target, to, offset, offset + n); offset += n; return n; },
    readFileSync(file: string) { if (file.endsWith("pins.json")) return JSON.stringify(pins); return Buffer.from(options.mismatch && file.endsWith(options.mismatch) ? "other" : file); },
    mkdirSync(file: string, mode: { mode: number }) { directories.push({ path: file, mode: mode.mode }); },
    existsSync(file: string) { exists.push(file); return options.existing === true; },
    writeFileSync(file: string, value: string, flags: { flag: string; mode: number }) { files.set(file, value); expect(flags).toEqual({ flag: "wx", mode: 0o600 }); },
  };
  const crypto = { createHash: () => ({ update: (value: Buffer) => ({ digest: () => (value.toString() === "other" ? "different" : "pin") }) }) };
  const fakeProcess = { platform: options.platform ?? "linux", arch: "arm64", version: "v24.20.0", pid: 100, getuid: () => options.uid ?? 1500, env: { VENDOR_KEY: "openshell:resolve:env:VENDOR_KEY" },
    stdin: { pipe() { writes.push({ to: "worker", data: "<stdin pipe>" }); } }, stdout: { write(value: Buffer | string) { stdout.push(value.toString()); writes.push({ to: "host", data: value.toString() }); } }, stderr: { write() {} },
    exit(code: number) { throw Error(`exit:${code}`); } };
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const owned: string[] = [];
  await new AsyncFunction("fs", "crypto", "spawn", "procIdentity", "ownedDirectory", "process", body)(fs, crypto, (command: string, args: string[], opts: Record<string, unknown>) => { spawned.push({ command, args, env: opts.env, cwd: opts.cwd, detached: opts.detached }); return child; },
    () => options.identity ?? { group: 501, parent: 100, start: "1000" }, (directory: string) => { owned.push(directory); }, fakeProcess);
  return { child, stdout, writes, files, directories, exists, spawned, owned, fakeProcess,
    spawn: () => child.emit("spawn"), data: (value: string | Buffer) => child.stdout.emit("data", Buffer.from(value)), close: (code: number) => child.emit("close", code), error: () => child.emit("error", Error("synthetic")) };
}
const marker = (f: Awaited<ReturnType<typeof fixture>>) => [...f.files.entries()].find(([key]) => key.endsWith("settled.json"));

describe("actual pi session-step supervisor body with synthetic OS bindings", () => {
  it("spawns the unchanged per-step worker detached, writes the receipt before the worker sees any byte, and settles only after a clean exit frame and exit 0", async () => {
    const f = await fixture();
    expect(f.spawned).toEqual([{ command: "/usr/local/bin/node", args: ["/opt/genbi/pi-worker.mjs"], env: f.fakeProcess.env, cwd: "/sandbox", detached: true }]);
    expect(f.writes).toEqual([]); // nothing reaches the worker or the host before the process exists
    expect(f.owned).toEqual(["/sandbox/steps"]); expect(f.directories[0]).toEqual({ path: "/sandbox/steps", mode: 0o700 });
    f.spawn();
    expect(f.writes[0]).toEqual({ to: "host", data: line({ type: "genbi.step", version: 1, step: scope, pid: 501, group: 501, start: "1000" }) });
    expect(f.writes[1]!.to).toBe("worker"); expect(f.writes[1]!.data.length).toBeGreaterThan(4); expect(f.writes[2]).toEqual({ to: "worker", data: "<stdin pipe>" });
    f.writes.length = 0;
    const frames = line({ t: "staged", scope }) + line({ t: "pi", e: { type: "agent_settled" } }); f.data(frames.slice(0, 11)); expect(f.stdout.slice(1)).toEqual([]); f.data(frames.slice(11));
    f.data(line(exitFrame));
    expect(f.stdout.slice(1).join("")).toBe(frames + line(exitFrame));
    expect(marker(f)).toBeUndefined();
    expect(() => f.close(0)).toThrow("exit:0");
    expect(JSON.parse(marker(f)![1])).toEqual({ type: "genbi.step", version: 1, step: scope, pid: 501, group: 501, start: "1000", outcome: "normal" });
    expect(marker(f)![0]).toBe(`/sandbox/steps/${scope}/settled.json`); expect(f.owned.at(-1)).toBe(`/sandbox/steps/${scope}`);
  });
  it.each([
    ["a non-linux platform", { platform: "darwin" }], ["another uid", { uid: 0 }],
    ["an unpinned supervisor", { mismatch: "pi-session-step.mjs" }], ["an unpinned step control", { mismatch: "pi-step-control.mjs" }], ["an unpinned worker", { mismatch: "pi-worker.mjs" }],
    ["another node version", { pins: { nodeVersion: "v1", node: "pin", sessionStep: "pin", stepControl: "pin", worker: "pin", pins: "pin" } }],
    ["an existing step directory", { existing: true }],
    ["a zero-length bootstrap", { body: Buffer.alloc(0) }], ["a bootstrap without a scope", { body: Buffer.from("{}") }], ["a scope that is not a step id", { body: Buffer.from(JSON.stringify({ scope: "../escape" })) }],
    ["a bootstrap that is not JSON", { body: Buffer.from("not json") }],
  ] as const)("refuses %s before spawning anything", async (_name, options) => {
    await expect(fixture(options as Options)).rejects.toThrow("exit:70");
  });
  it("refuses a worker that is not its own process-group leader or not its child, with no receipt and no bootstrap delivery", async () => {
    for (const identity of [{ group: 77, parent: 100, start: "1" }, { group: 501, parent: 1, start: "1" }]) {
      const f = await fixture({ identity }); expect(() => f.spawn()).toThrow("exit:70"); expect(f.writes.filter(row => row.to === "worker")).toEqual([]); expect(f.stdout).toEqual([]); expect(f.writes.some(row => row.data === "kill")).toBe(true);
    }
  });
  it("fails closed on a spawn error", async () => { const f = await fixture(); expect(() => f.error()).toThrow("exit:70"); });
  it.each(["malformed", "not-a-record", "frame-after-exit", "oversize"])("rejects %s from the worker without a normal settlement", async mode => {
    const f = await fixture(); f.spawn();
    expect(() => {
      if (mode === "frame-after-exit") { f.data(line(exitFrame)); f.data(line({ t: "pi" })); }
      else if (mode === "not-a-record") f.data("[1]\n");
      else if (mode === "oversize") f.data(Buffer.alloc(2097152, 65));
      else f.data("not-json\n");
    }).toThrow("exit:70");
    expect(marker(f)).toBeUndefined();
  });
  it.each([
    ["a nonzero worker exit", (f: Awaited<ReturnType<typeof fixture>>) => { f.data(line(exitFrame)); return 1; }],
    ["no exit frame", () => 0],
    ["a forced exit frame", (f: Awaited<ReturnType<typeof fixture>>) => { f.data(line({ ...exitFrame, forced: true })); return 0; }],
    ["remaining processes", (f: Awaited<ReturnType<typeof fixture>>) => { f.data(line({ ...exitFrame, remaining: 1 })); return 0; }],
    ["another step's exit frame", (f: Awaited<ReturnType<typeof fixture>>) => { f.data(line({ ...exitFrame, scope: "22222222-2222-4222-8222-222222222222" })); return 0; }],
    ["a partial tail", (f: Awaited<ReturnType<typeof fixture>>) => { f.data(line(exitFrame)); f.data('{"t"'); return 0; }],
  ])("withholds the settled marker after %s", async (_name, act) => {
    const f = await fixture(); f.spawn(); const code = act(f);
    expect(() => f.close(code)).toThrow("exit:71"); expect(marker(f)).toBeUndefined();
  });
});

describe("pi step control", () => {
  it("is the Claude step control byte for byte, so the two session paths cannot drift", () => {
    expect(readFileSync(path.join(assets, "pi-step-control.mjs"))).toEqual(readFileSync(path.join(process.cwd(), "runtime-assets/claude-worker/claude-step-control.mjs")));
  });
  it("is pinned with the supervisor in the image's pins", () => {
    const pins = readFileSync(path.join(assets, "pi-pins.mjs"), "utf8");
    expect(pins).toContain("sessionStep: '/opt/genbi/pi-session-step.mjs'"); expect(pins).toContain("stepControl: '/opt/genbi/pi-step-control.mjs'");
  });
});
