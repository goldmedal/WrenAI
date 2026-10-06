import { readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Backend global setup: fails the run when it leaves a host query service directory
 * (`genbi-hq-*`, which holds a socket and a credential file) behind in the temp directory.
 * Directories present before the run belong to someone else and are ignored.
 */
const prefix = "genbi-hq-";
const list = (): string[] => {
  try { return readdirSync(os.tmpdir()).filter((name) => name.startsWith(prefix)); } catch { return []; }
};

export default function setup(): () => void {
  const before = new Set(list());
  return () => {
    const leaked = list().filter((name) => !before.has(name));
    if (leaked.length > 0) {
      // vitest reports a teardown error without failing the run; the exit code does.
      process.exitCode = 1;
      throw new Error(`host query service directories leaked into ${os.tmpdir()}: ${leaked.map((name) => path.join(os.tmpdir(), name)).join(", ")}`);
    }
  };
}
