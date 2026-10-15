import { describe, expect, it, vi, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import path from "node:path";

afterEach(() => vi.useRealTimers());
const result = { type: "result", subtype: "success", is_error: false, uuid: "result", session_id: "synthetic", result: "{}", permission_denials: [], modelUsage: { synthetic: { webSearchRequests: 0, inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } }, usage: { input_tokens: 1, output_tokens: 1 } };
async function fixture(endError = false) {
  vi.useFakeTimers();
  const source = readFileSync(path.join(process.cwd(), "runtime-assets/claude-worker/claude-session-step.mjs"), "utf8");
  const body = source.replace(/^import .*;$/gm, "").replace("await import('./claude-worker-ca.mjs')", "trustModule");
  const boot = Buffer.from(JSON.stringify({ protocol: 1, scope: "11111111-1111-4111-8111-111111111111", generation: "22222222-2222-4222-8222-222222222222", access: "synthetic-private-credential", expiresAt: Date.now() + 600000, argv: ["--model", "synthetic"] }));
  const prefix = Buffer.alloc(4); prefix.writeUInt32BE(boot.length); const input = Buffer.concat([prefix, boot]); let offset = 0;
  const calls: string[] = [], files = new Map<string, string>(), directories: { path: string; mode: number }[] = [];
  const child = Object.assign(new EventEmitter(), { pid: 501, stdout: new EventEmitter(), stderr: { pipe: vi.fn() }, stdin: Object.assign(new EventEmitter(), { end(callback: (error?: Error) => void) { calls.push("EOF"); callback(endError ? Error("synthetic") : undefined); } }), kill: vi.fn() });
  const fs = { readSync(_fd: number, target: Buffer, to: number, length: number) { const n = Math.min(length, input.length - offset); input.copy(target, to, offset, offset + n); offset += n; return n; }, readFileSync(file: string) { if (file.endsWith("pins.json")) return JSON.stringify({ nodeVersion: "v24.20.0", node: "pin", claude: "pin", sessionStep: "pin", stepControl: "pin", caTrust: "pin" }); return Buffer.from(file); }, mkdirSync(file: string, options: { mode: number }) { directories.push({ path: file, mode: options.mode }); }, writeFileSync(file: string, value: string) { files.set(file, value); } };
  const crypto = { createHash: () => ({ update: () => ({ digest: () => "pin" }) }) };
  const fakeProcess = { platform: "linux", arch: "arm64", version: "v24.20.0", pid: 100, getuid: () => 1500, env: {}, stdin: { pipe: vi.fn() }, stdout: { write(value: Buffer | string) { calls.push(value.toString()); } }, stderr: { write() {} }, exit(code: number) { throw Error(`exit:${code}`); } };
  const trustModule = { supervisorCaTrust: () => ({ environment: {}, assertCurrent() {}, close() {} }) };
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  await new AsyncFunction("fs", "crypto", "spawn", "procIdentity", "ownedDirectory", "process", "trustModule", body)(fs, crypto, () => child, () => ({ group: 501, parent: 100, start: "1000" }), () => {}, fakeProcess, trustModule);
  child.emit("spawn"); calls.length = 0;
  return { child, calls, files, directories, data: (value: string | Buffer) => child.stdout.emit("data", Buffer.from(value)), close: (code: number) => child.emit("close", code) };
}
describe("actual session-step wrapper body with synthetic OS bindings", () => {
  it("forwards the complete unchanged result before local EOF and settles only after exit0", async () => {
    const f = await fixture(); const raw = JSON.stringify(result) + "\n"; f.data(raw.slice(0, 13)); expect(f.calls).toHaveLength(0); f.data(raw.slice(13)); expect(f.calls).toEqual([raw, "EOF"]);
    expect([...f.files.keys()].some(key => key.endsWith("settled.json"))).toBe(false); expect(() => f.close(0)).toThrow("exit:0");
    const marker = [...f.files.entries()].find(([key]) => key.endsWith("settled.json")); expect(marker).toBeDefined(); expect(JSON.parse(marker![1])).toMatchObject({ outcome: "normal", pid: 501, group: 501, start: "1000" });
    expect(f.directories.filter(row => /\/(home|config|tmp|work)$/.test(row.path))).toHaveLength(4); expect(f.directories.every(row => row.mode === 0o700)).toBe(true);
  });
  it.each(["malformed", "wrong-result", "later-frame", "oversize"])("rejects %s without normal settlement", async mode => {
    const f = await fixture();
    expect(() => { if (mode === "later-frame") { f.data(JSON.stringify(result) + "\n"); f.data('{}\n'); } else if (mode === "wrong-result") f.data(JSON.stringify({ ...result, is_error: true }) + "\n"); else if (mode === "oversize") f.data(Buffer.alloc(2097152, 65)); else f.data('not-json\n'); }).toThrow("exit:70");
    expect([...f.files.keys()].some(key => key.endsWith("settled.json"))).toBe(false);
  });
  it.each(["partial-tail", "nonzero"])("withholds settlement after a result with %s", async mode => { const f = await fixture(); f.data(JSON.stringify(result) + "\n"); if (mode === "partial-tail") f.data('{'); expect(() => f.close(mode === "nonzero" ? 1 : 0)).toThrow("exit:71"); expect([...f.files.keys()].some(key => key.endsWith("settled.json"))).toBe(false); });
  it("fails closed on local EOF error and a child exit deadline", async () => { const f = await fixture(true); expect(() => f.data(JSON.stringify(result) + "\n")).toThrow("exit:70"); const g = await fixture(); g.data(JSON.stringify(result) + "\n"); expect(() => vi.advanceTimersByTime(4000)).toThrow("exit:70"); });
});
