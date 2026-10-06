import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { hashDirectory } from "../harness/compile/fingerprint.js";
import { openWrenComponentAccess } from "../harness/components/wren-access.js";
import { openCodexHostQueryService, type CodexHostQueryService } from "../harness/route/codex-host-query.js";

const FIXTURES = path.join(import.meta.dirname, "fixtures");
export const PROXY_SOURCE = path.join(import.meta.dirname, "..", "harness", "route", "codex-wren-proxy.ts");

/** A scratch directory with a `wren` stand-in (`fixtures/fake-wren.cjs`) and an empty project. */
export function fakeWrenWorkspace(): { root: string; wren: string; project: string; cleanup(): void } {
  const root = mkdtempSync(path.join(os.tmpdir(), "genbi-hq-test-"));
  const wren = path.join(root, "wren");
  writeFileSync(wren, `#!${process.execPath}\n${readFileSync(path.join(FIXTURES, "fake-wren.cjs"), "utf8")}`, { mode: 0o700 });
  const project = path.join(root, "project");
  mkdirSync(project);
  writeFileSync(path.join(project, "wren_project.yml"), "name: test\n");
  return { root, wren, project, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** A host query service backed by governed access through the `wren` stand-in. */
export function openTestHostService(wren: string, project: string): Promise<CodexHostQueryService> {
  return openCodexHostQueryService({
    openAccess: async (signal) => openWrenComponentAccess({ executable: wren, project, fingerprint: await hashDirectory(project), signal }),
  });
}

/** A minimal MCP client over a spawned proxy's stdio. */
export function startProxy(credentialArgs: readonly string[], wren: string, project: string): {
  call(method: string, params: Record<string, unknown>): Promise<{ result?: Record<string, unknown>; error?: unknown }>;
  stop(): Promise<void>;
  child: ChildProcessWithoutNullStreams;
} {
  const child = spawn(process.execPath, [PROXY_SOURCE, ...credentialArgs, "--", wren, "serve", "mcp", "--project", project, "--quiet"], { stdio: ["pipe", "pipe", "pipe"] });
  child.stderr.resume();
  const waiting = new Map<number, (value: { result?: Record<string, unknown>; error?: unknown }) => void>();
  createInterface({ input: child.stdout }).on("line", (line) => {
    const message = JSON.parse(line) as { id: number; result?: Record<string, unknown>; error?: unknown };
    waiting.get(message.id)?.(message);
    waiting.delete(message.id);
  });
  let nextId = 1;
  return {
    child,
    call: (method, params) => new Promise((resolve) => {
      const id = nextId++;
      waiting.set(id, resolve);
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    }),
    stop: () => new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) { resolve(); return; }
      child.once("exit", () => resolve());
      child.stdin.end();
      setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
    }),
  };
}
