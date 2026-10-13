import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
const hooks = vi.hoisted(() => ({ readCalls: 0, closeCalls: 0, opened: [] as number[], afterRead: undefined as undefined | ((fd: number, count: number) => void), afterOpen: undefined as undefined | ((fd: number) => void), partial: false, readError: undefined as unknown, closeError: undefined as unknown }));
vi.mock("node:fs", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, openSync(...args: Parameters<typeof actual.openSync>) { const fd = actual.openSync(...args); hooks.opened.push(fd); hooks.afterOpen?.(fd); return fd; },
    readSync(fd: number, buffer: NodeJS.ArrayBufferView, offset: number, length: number, position: number | null) {
      if (hooks.readError) throw hooks.readError;
      const count = actual.readSync(fd, buffer, offset, hooks.partial ? Math.min(length, 7) : length, position);
      hooks.readCalls++; hooks.afterRead?.(fd, count); return count;
    }, closeSync(fd: number) { actual.closeSync(fd); hooks.closeCalls++; if (hooks.closeError) throw hooks.closeError; } };
});
import { attestNativeExecutable, assertNativeExecutableIdentity } from "../server/native-runtime-spec.js";
import { InteractiveLaunchError } from "../server/native-session-workspace.js";
const roots: string[] = [];
function file(bytes = Buffer.alloc(2_097_169, 65)) { const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "native-hash-stream-"))); roots.push(root); const p = path.join(root, "executable"); fs.writeFileSync(p, bytes, { mode: 0o700 }); return p; }
function reset() { hooks.readCalls = 0; hooks.closeCalls = 0; hooks.opened = []; hooks.afterRead = undefined; hooks.afterOpen = undefined; hooks.partial = false; hooks.readError = undefined; hooks.closeError = undefined; }
afterEach(() => { reset(); for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true }); });
it.each([0, 83, 2_097_169])("fresh bounded hash equals full-byte SHA at size %i and closes FD", size => {
 const p = file(Buffer.alloc(size, 65)), expected = "sha256:" + createHash("sha256").update(fs.readFileSync(p)).digest("hex");
 reset(); const identity = attestNativeExecutable("producer", p); expect(identity.digest).toBe(expected); expect(hooks.closeCalls).toBe(1); expect(hooks.readCalls).toBe(Math.ceil(size / 1_048_576) + 1); assertNativeExecutableIdentity(identity); expect(hooks.closeCalls).toBe(2);
});
it("short reads retain every byte and initial executable symlink resolution", () => {
 const p = file(Buffer.alloc(83, 65)), alias = p + "-link"; fs.symlinkSync(p, alias); hooks.partial = true;
 const identity = attestNativeExecutable("node", alias); expect(identity.executable).toBe(p); expect(identity.digest).toBe("sha256:" + createHash("sha256").update(fs.readFileSync(p)).digest("hex")); expect(hooks.readCalls).toBe(13); expect(hooks.closeCalls).toBe(1);
});
it.each(["same_size_restored_mtime", "truncate", "grow", "replacement", "symlink", "mode", "descriptor_replacement"] as const)("completed midread %s is rejected by identity checker and FD closes", action => {
 const p = file(); fs.utimesSync(p, 1_700_000_000, 1_700_000_000); const identity = attestNativeExecutable("producer", p), before = fs.statSync(p), beforeNs = fs.statSync(p, { bigint: true }).mtimeNs; reset(); let completed = false;
 hooks.afterRead = fd => { if (completed) return;
   if (action === "same_size_restored_mtime") { const m = fs.openSync(p, "r+"); const b = Buffer.from([66]); fs.writeSync(m, b, 0, 1, 0); fs.closeSync(m); fs.utimesSync(p, 1_700_000_000, 1_700_000_000); expect(fs.statSync(p, { bigint: true }).mtimeNs).toBe(beforeNs); expect(fs.readFileSync(p)[0]).toBe(66); expect(fs.statSync(p).size).toBe(before.size); expect(Math.abs(fs.statSync(p).mtimeMs - before.mtimeMs)).toBeLessThan(1); }
   else if (action === "truncate") { fs.truncateSync(p, 0); expect(fs.statSync(p).size).toBe(0); }
   else if (action === "grow") { fs.appendFileSync(p, Buffer.from([66])); expect(fs.statSync(p).size).toBe(before.size + 1); }
   else if (action === "replacement") { fs.renameSync(p, p + "-old"); fs.copyFileSync(p + "-old", p); fs.chmodSync(p, 0o700); expect(fs.statSync(p).ino).not.toBe(before.ino); }
   else if (action === "symlink") { fs.renameSync(p, p + "-old"); fs.symlinkSync(p + "-old", p); expect(fs.lstatSync(p).isSymbolicLink()).toBe(true); }
   else if (action === "mode") { fs.chmodSync(p, 0o600); expect(fs.statSync(p).mode & 0o777).toBe(0o600); }
   else { const q = p + "-descriptor"; fs.writeFileSync(q, Buffer.alloc(before.size, 65), { mode: 0o700 }); fs.closeSync(fd); const next = fs.openSync(q, "r"); expect(next).toBe(fd); expect(fs.fstatSync(fd).ino).not.toBe(before.ino); }
   completed = true;
 };
 let error: unknown; try { assertNativeExecutableIdentity(identity); } catch (value) { error = value; }
 expect(completed).toBe(true); expect(error).toBeInstanceOf(InteractiveLaunchError); expect(hooks.closeCalls).toBe(1);
});
it("path replacement between canonical lstat and FD capture fails before reads", () => {
 const p = file(); reset(); let completed = false; hooks.afterOpen = () => { fs.renameSync(p, p + "-old"); fs.copyFileSync(p + "-old", p); fs.chmodSync(p, 0o700); completed = true; };
 expect(() => attestNativeExecutable("producer", p)).toThrow(InteractiveLaunchError); expect(completed).toBe(true); expect(hooks.readCalls).toBe(0); expect(hooks.closeCalls).toBe(1);
});
it("same-size byte mutation between calls is not cached", () => {
 const p = file(Buffer.from("original")); fs.utimesSync(p, 1_700_000_000, 1_700_000_000); const identity = attestNativeExecutable("producer", p), before = fs.statSync(p), beforeNs = fs.statSync(p, { bigint: true }).mtimeNs; fs.writeFileSync(p, "changed!", { mode: 0o700 }); fs.utimesSync(p, 1_700_000_000, 1_700_000_000); expect(fs.statSync(p, { bigint: true }).mtimeNs).toBe(beforeNs); expect(fs.readFileSync(p).toString()).toBe("changed!"); expect(fs.statSync(p).size).toBe(before.size); expect(() => assertNativeExecutableIdentity(identity)).toThrow(InteractiveLaunchError);
});
it("original read error identity survives finally-close and no descriptor leaks", () => {
 const p = file(); reset(); const error = Error("synthetic-read"); hooks.readError = error; hooks.closeError = Error("synthetic-close");
 let caught; try { attestNativeExecutable("producer", p); } catch (e) { caught = e; } expect(caught).toBe(error); expect(hooks.closeCalls).toBe(1); expect(() => fs.fstatSync(hooks.opened[0]!)).toThrow();
});
it("close failure refuses an otherwise complete hash", () => { const p = file(); const error = Error("synthetic-close"); hooks.closeError = error; expect(() => attestNativeExecutable("producer", p)).toThrow(error); expect(hooks.closeCalls).toBe(1); });
it("oversized file preserves pinned readFileSync RangeError and closes FD", () => {
 const p = file(Buffer.alloc(0)); const fd = fs.openSync(p, "r+"); fs.ftruncateSync(fd, 2_147_483_648); fs.closeSync(fd); reset(); let error: unknown; try { attestNativeExecutable("producer", p); } catch (e) { error = e; }
 expect(error).toBeInstanceOf(RangeError); expect((error as NodeJS.ErrnoException).code).toBe("ERR_FS_FILE_TOO_LARGE"); expect(hooks.closeCalls).toBe(1);
});
