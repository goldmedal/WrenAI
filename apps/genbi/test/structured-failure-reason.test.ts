import { expect, it } from "vitest";
import { observeStructured, structuredDiagnosticReason, type StructuredDiagnosticRecord, type StructuredDiagnosticReason } from "../server/structured-diagnostics.js";
import { InteractiveLaunchError } from "../server/native-session-workspace.js";
it("fixed native direct prototype classification never reads exception payload", () => {
 let traps = 0; const error = new InteractiveLaunchError("synthetic"); Object.defineProperty(error, "message", { get() { traps++; throw Error(); } });
 expect(structuredDiagnosticReason(error)).toBe("native_launch_invalid"); expect(traps).toBe(0);
});
it("failure resolver receives zero arguments only on catch and keeps exact thrown identity/records", () => {
 const error = Error("synthetic"), records: StructuredDiagnosticRecord[] = []; let called = 0; let caught;
 try { observeStructured(r => records.push(r), "currentness", () => { throw error; }, function() { expect(arguments.length).toBe(0); called++; return "scope_signal_aborted"; }); } catch (e) { caught = e; }
 expect(caught).toBe(error); expect(called).toBe(1); expect(records.map(r => [r.state, r.reason])).toEqual([["entered", "none"], ["failed", "scope_signal_aborted"]]);
 const value = Object.freeze({ result: true }), promise = Promise.resolve(value); expect(observeStructured(r => records.push(r), "currentness", () => value, () => { throw Error(); })).toBe(value); expect(observeStructured(undefined, "currentness", () => promise, () => { throw Error(); })).toBe(promise);
 expect(called).toBe(1); expect(records.length).toBe(4);
});
it("invalid, throwing, Promise and proxy resolver values use original fallback with zero payload traps", async () => {
 let traps = 0; const proxy = new Proxy({}, { get() { traps++; throw Error(); }, getPrototypeOf() { traps++; throw Error(); }, ownKeys() { traps++; throw Error(); } });
 const getter = Object.defineProperty({}, "reason", { get() { traps++; throw Error(); } }); const error = new InteractiveLaunchError("synthetic");
 for (const resolve of [() => { throw Error(); }, () => "none", () => "private-sentinel", () => proxy, () => getter, () => Promise.reject(Error("synthetic"))]) {
  const records: StructuredDiagnosticRecord[] = []; let caught; try { observeStructured(r => records.push(r), "currentness", () => { throw error; }, resolve as () => StructuredDiagnosticReason); } catch (e) { caught = e; }
  expect(caught).toBe(error); expect(records).toHaveLength(2); expect(records[1]!.reason).toBe("native_launch_invalid");
 }
 await Promise.resolve(); expect(traps).toBe(0);
});
it("resolver reentry and observer throw preserve the outer reason/error and return", () => {
 const outer = Error("outer"), inner = new InteractiveLaunchError("inner"), records: StructuredDiagnosticRecord[] = []; let caught;
 try { observeStructured(r => records.push(r), "currentness", () => { throw outer; }, () => { let innerCaught; try { observeStructured(r => records.push(r), "currentness", () => { throw inner; }); } catch (e) { innerCaught = e; } expect(innerCaught).toBe(inner); return "scope_signal_aborted"; }); } catch (e) { caught = e; }
 expect(caught).toBe(outer); expect(records.map(r => r.reason)).toEqual(["none", "none", "native_launch_invalid", "scope_signal_aborted"]);
 let afterThrow; try { observeStructured(() => { throw Error(); }, "currentness", () => { throw outer; }, () => "scope_signal_aborted"); } catch (e) { afterThrow = e; } expect(afterThrow).toBe(outer);
 const value = {}; expect(observeStructured(() => { throw Error(); }, "currentness", () => value)).toBe(value);
});
it("untrusted original errors retain zero-trap fallback under invalid failure resolver", () => {
 let traps = 0; const handler = { get() { traps++; throw Error(); }, getPrototypeOf() { traps++; throw Error(); }, ownKeys() { traps++; throw Error(); } }; const proxy = new Proxy({}, handler), revoked = Proxy.revocable({}, handler); revoked.revoke();
 for (const error of [proxy, revoked.proxy, Object.create(proxy), Object.defineProperty({}, "code", { get() { traps++; throw Error(); } })]) {
  let caught; const records: StructuredDiagnosticRecord[] = []; try { observeStructured(r => records.push(r), "currentness", () => { throw error; }, () => undefined); } catch (e) { caught = e; }
  expect(caught).toBe(error); expect(records[1]!.reason).toBe("unknown");
 }
 expect(traps).toBe(0);
});
