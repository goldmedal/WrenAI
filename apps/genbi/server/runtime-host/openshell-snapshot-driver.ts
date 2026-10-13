import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, openSync, closeSync, statSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { runOpenShellCommand, type OpenShellConfiguration } from "./openshell-driver.js";
import { OpenShellError } from "./openshell-types.js";
import { snapshotManifestSchema, type SnapshotManifest, type SnapshotPublication } from "./openshell-snapshot-types.js";

export const SNAPSHOT_HELPER_PATH = fileURLToPath(new URL("./openshell-snapshot-helper.py", import.meta.url));
export const snapshotHash = (bytes: string | Buffer): string => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
export function snapshotCanonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(snapshotCanonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${snapshotCanonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
export function parseSnapshotManifest(raw: string): SnapshotManifest {
  try {
    const manifest = snapshotManifestSchema.parse(JSON.parse(raw)); const { digest, ...body } = manifest;
    if (snapshotHash(snapshotCanonical(body)) !== digest || manifest.files.some((file, index) => !safeSnapshotPath(file.path)
      || (index > 0 && manifest.files[index - 1]!.path >= file.path)) || new Set(manifest.files.map((file) => file.path.toLowerCase())).size !== manifest.files.length
      || manifest.files.reduce((sum, file) => sum + file.size, 0) > 268_435_456) throw new Error();
    return manifest;
  } catch { throw new OpenShellError("openshell_identity_mismatch"); }
}
export function safeSnapshotPath(value: string): boolean {
  return Buffer.byteLength(value) <= 240 && value.split("/").length <= 16 && value.split("/").every((part) => /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(part));
}
export interface SnapshotCaptureRequest {
  readonly root: string; readonly identity: string; readonly paths: readonly string[]; readonly project: string; readonly bindingGeneration: string;
  readonly bindingRevision: string; readonly context: string;
  readonly projection: Readonly<Record<string, string>>;
}
export interface SnapshotVolumeDriver {
  capture(request: SnapshotCaptureRequest, archive: string, signal: AbortSignal): Promise<SnapshotManifest>;
  checkSource(request: SnapshotCaptureRequest, expected: SnapshotManifest, archive: string, signal: AbortSignal): Promise<void>;
  publish(row: SnapshotPublication, archive: string, signal: AbortSignal, check: () => void, created: () => void): Promise<void>;
  verify(row: SnapshotPublication, signal?: AbortSignal): Promise<SnapshotManifest>;
  remove(row: SnapshotPublication): Promise<void>;
  readArguments(row: SnapshotPublication): readonly string[];
  attest(): void;
}

/** All subprocess stderr is private and discarded. All command/environment selection is host-owned. */
export class DockerSnapshotDriver implements SnapshotVolumeDriver {
  private readonly env: NodeJS.ProcessEnv;
  constructor(private readonly config: OpenShellConfiguration, private readonly recordHelper: (publication: string, name: string, id?: string) => void = () => {}) {
    this.env = Object.freeze({ PATH: "/usr/bin:/bin", HOME: config.home, LANG: "C.UTF-8", DOCKER_HOST: `unix://${config.dockerSocket}` });
  }
  attest(): void {
    try {
      const capture = this.config.snapshotCapture;
      if (!capture || realpathSync(capture.executable) !== capture.realpath || snapshotHash(readFileSync(capture.realpath)) !== capture.digest
        || snapshotHash(readFileSync(SNAPSHOT_HELPER_PATH)) !== capture.helperDigest
        || realpathSync(this.config.dockerExecutable) !== this.config.dockerRealpath || snapshotHash(readFileSync(this.config.dockerRealpath)) !== this.config.dockerDigest) throw new Error();
    } catch { throw new OpenShellError("openshell_identity_mismatch"); }
  }
  private helper(request: SnapshotCaptureRequest, archive: string, signal: AbortSignal): Promise<SnapshotManifest> {
    this.attest();
    const fd = openSync(archive, "wx", 0o600);
    return new Promise((resolve, reject) => {
      const child = spawn(this.config.snapshotCapture!.realpath, ["-I", SNAPSHOT_HELPER_PATH, "capture"], {
        env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" }, stdio: ["pipe", "pipe", "pipe", fd], detached: true,
      });
      closeSync(fd); let output = "", bytes = 0, failure = false, killTimer: ReturnType<typeof setTimeout> | undefined;
      const abort = () => { failure = true; try { if (child.pid) process.kill(-child.pid, "SIGKILL"); } catch { /* bounded settlement */ }
        killTimer ??= setTimeout(() => { finish(); reject(new OpenShellError("openshell_remote_unknown")); }, 1000); };
      const timer = setTimeout(abort, 30_000);
      signal.addEventListener("abort", abort, { once: true }); if (signal.aborted) abort();
      child.stderr!.resume(); child.stdin!.on("error", abort);
      child.stdout!.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes > 1_048_576) abort(); else output += chunk.toString("utf8"); });
      const finish = () => { clearTimeout(timer); clearTimeout(killTimer); signal.removeEventListener("abort", abort); };
      child.once("error", () => { finish(); reject(new OpenShellError("openshell_unavailable")); });
      child.once("close", (code) => { finish(); try {
        if (failure || code !== 0 || statSync(archive).size > 285_212_672) throw new Error();
        resolve(parseSnapshotManifest(output.trim()));
      } catch { reject(new OpenShellError("openshell_scope_invalid")); } });
      const payload = JSON.stringify(request); if (Buffer.byteLength(payload) > 1_048_576) abort(); else child.stdin!.end(payload);
    });
  }
  async capture(request: SnapshotCaptureRequest, archive: string, signal: AbortSignal): Promise<SnapshotManifest> {
    this.attest();
    const probe = await runOpenShellCommand(this.config.snapshotCapture!.realpath, ["-I", SNAPSHOT_HELPER_PATH, "probe"], { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" }, signal);
    if (probe.trim() !== '{"protocol":"genbi-snapshot/1","anchored":true}') throw new OpenShellError("openshell_unavailable");
    return this.helper(request, archive, signal);
  }
  async checkSource(request: SnapshotCaptureRequest, expected: SnapshotManifest, archive: string, signal: AbortSignal): Promise<void> {
    const actual = await this.capture(request, archive, signal);
    if (snapshotCanonical(actual) !== snapshotCanonical(expected)) throw new OpenShellError("openshell_scope_invalid");
  }
  private docker(argv: readonly string[], signal?: AbortSignal): Promise<string> {
    this.attest(); return runOpenShellCommand(this.config.dockerExecutable, argv, this.env, signal, 180_000);
  }
  private labels(row: SnapshotPublication): readonly string[] {
    return ["--label", `genbi-snapshot-owner=${row.owner}`, "--label", `genbi-snapshot-publication=${row.id}`, "--label", `genbi-snapshot-configuration=${row.configuration}`,
      "--label", `genbi-snapshot-digest=${row.manifest!.digest}`];
  }
  private async volume(row: SnapshotPublication): Promise<void> {
    let values;
    try { values = z.array(z.object({ Name: z.string(), Driver: z.literal("local"), Options: z.record(z.string(), z.string()).nullable(), Labels: z.record(z.string(), z.string()) }).passthrough()).parse(JSON.parse(await this.docker(["volume", "inspect", row.volume]))); }
    catch (error) { throw error instanceof OpenShellError ? error : new OpenShellError("openshell_ownership_mismatch"); }
    const value = values[0];
    if (values.length !== 1 || !value || value.Name !== row.volume || Object.keys(value.Options ?? {}).length
      || value.Labels["genbi-snapshot-owner"] !== row.owner || value.Labels["genbi-snapshot-publication"] !== row.id
      || value.Labels["genbi-snapshot-configuration"] !== row.configuration || value.Labels["genbi-snapshot-digest"] !== row.manifest?.digest) throw new OpenShellError("openshell_ownership_mismatch");
  }
  private helperName(row: SnapshotPublication, kind: string): string { return `${row.volume}-${kind}-${randomUUID().replaceAll("-", "")}`; }
  private common(row: SnapshotPublication, name: string, readonly: boolean): string[] {
    return ["--name", name, ...this.labels(row), "--network", "none", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--read-only", "--pids-limit", "32", "--memory", "512m", "--cpus", "1", "--user", readonly ? "1500:1500" : "0:0",
      "--mount", `type=volume,source=${row.volume},target=/opt/genbi-project${readonly ? ",readonly" : ""}`];
  }
  async publish(row: SnapshotPublication, archive: string, signal: AbortSignal, check: () => void, created: () => void): Promise<void> {
    check();
    const names = (await this.docker(["volume", "ls", "--format", "{{.Name}}"], signal)).trim().split("\n");
    check(); if (names.includes(row.volume)) throw new OpenShellError("openshell_ownership_mismatch");
    await this.docker(["volume", "create", ...this.labels(row), row.volume], signal); created(); check(); await this.volume(row); check();
    const helper = this.helperName(row, "publish"); this.recordHelper(row.id, helper); check();
    const id = (await this.docker(["create", "-i", ...this.common(row, helper, false), "--entrypoint", "/bin/tar", this.config.image, "--no-same-owner", "-xf", "-", "-C", "/opt/genbi-project"], signal)).trim();
    if (!/^[a-f0-9]{64}$/.test(id)) throw new OpenShellError("openshell_protocol_invalid");
    this.recordHelper(row.id, helper, id); check();
    await new Promise<void>((resolve, reject) => {
      this.attest(); check();
      const child = spawn(this.config.dockerExecutable, ["start", "-a", "-i", id], { env: this.env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
      let failed = false, bytes = 0, killTimer: ReturnType<typeof setTimeout> | undefined;
      const input = createReadStream(archive);
      const abort = () => { failed = true; input.destroy(); try { if (child.pid) process.kill(-child.pid, "SIGKILL"); } catch { /* remote reconciliation required */ }
        killTimer ??= setTimeout(() => { finish(); reject(new OpenShellError("openshell_remote_unknown")); }, 1000); };
      const timer = setTimeout(abort, 180_000); signal.addEventListener("abort", abort, { once: true }); if (signal.aborted) abort();
      input.on("error", abort); child.stdin.on("error", abort); input.pipe(child.stdin);
      for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes > 1_048_576) abort(); });
      const finish = () => { clearTimeout(timer); clearTimeout(killTimer); signal.removeEventListener("abort", abort); input.destroy(); };
      child.once("error", () => { finish(); reject(new OpenShellError("openshell_unavailable")); });
      child.once("close", (code) => { finish(); if (failed || code !== 0) reject(new OpenShellError("openshell_remote_unknown")); else resolve(); });
    }); check();
    const exit = JSON.parse(await this.docker(["inspect", "--format", "{{json .State.ExitCode}}", id], signal));
    if (exit !== 0) throw new OpenShellError("openshell_remote_unknown");
    await this.docker(["rm", id], signal); check();
  }
  readArguments(row: SnapshotPublication): readonly string[] { this.attest(); return ["/usr/local/bin/python", "-I", "-c", readFileSync(SNAPSHOT_HELPER_PATH, "utf8"), "verify", "/opt/genbi-project", row.manifest!.digest]; }
  async verify(row: SnapshotPublication, signal?: AbortSignal): Promise<SnapshotManifest> {
    await this.volume(row); signal?.throwIfAborted();
    const [executable, ...args] = this.readArguments(row);
    const helper = this.helperName(row, "verify"); this.recordHelper(row.id, helper); signal?.throwIfAborted();
    const id = (await this.docker(["create", ...this.common(row, helper, true), "--entrypoint", executable!, this.config.image, ...args], signal)).trim();
    if (!/^[a-f0-9]{64}$/.test(id)) throw new OpenShellError("openshell_protocol_invalid");
    this.recordHelper(row.id, helper, id); signal?.throwIfAborted();
    const result = await this.docker(["start", "-a", id], signal);
    if (JSON.parse(await this.docker(["inspect", "--format", "{{json .State.ExitCode}}", id], signal)) !== 0) throw new OpenShellError("openshell_identity_mismatch");
    await this.docker(["rm", id], signal);
    const actual = parseSnapshotManifest(result.trim());
    if (snapshotCanonical(actual) !== snapshotCanonical(row.manifest)) throw new OpenShellError("openshell_identity_mismatch");
    return actual;
  }
  async remove(row: SnapshotPublication): Promise<void> {
    const names = (await this.docker(["volume", "ls", "--format", "{{.Name}}"])) .trim().split("\n");
    const containers = z.array(z.object({ Id: z.string(), Name: z.string(), Image: z.string(), Config: z.object({ Labels: z.record(z.string(), z.string()).nullable() }), Mounts: z.array(z.object({ Name: z.string().optional() }).passthrough()) }).passthrough());
    const ids = (await this.docker(["ps", "-aq", "--no-trunc"])) .trim().split("\n").filter(Boolean);
    // Complete inventory is bounded by the runner's byte limit; overflow refuses cleanup.
    const format = '{"Id":{{json .Id}},"Name":{{json .Name}},"Image":{{json .Image}},"Config":{"Labels":{{json .Config.Labels}}},"Mounts":{{json .Mounts}}}';
    let inventory;
    try { inventory = ids.length ? containers.parse((await this.docker(["inspect", "--format", format, ...ids])).trim().split("\n").map((line) => JSON.parse(line))) : []; }
    catch (error) { throw error instanceof OpenShellError ? error : new OpenShellError("openshell_protocol_invalid"); }
    if (inventory.length !== ids.length) throw new OpenShellError("openshell_protocol_invalid");
    const helpers = inventory.filter((container) => row.helperNames.some((name) => container.Name === `/${name}`) || row.helperIds.includes(container.Id));
    for (const helper of helpers) {
      if (helper.Image !== this.config.image || helper.Config.Labels?.["genbi-snapshot-owner"] !== row.owner || helper.Config.Labels["genbi-snapshot-publication"] !== row.id
        || helper.Mounts.some((mount) => mount.Name !== row.volume)) throw new OpenShellError("openshell_ownership_mismatch");
    }
    if (inventory.some((container) => container.Mounts.some((mount) => mount.Name === row.volume) && !helpers.includes(container))) throw new OpenShellError("openshell_cleanup_pending");
    for (const helper of helpers) await this.docker(["rm", "-f", helper.Id]);
    if (names.includes(row.volume)) { await this.volume(row); await this.docker(["volume", "rm", row.volume]); }
    else if (row.manifest && row.phase !== "intent" && !row.acknowledged) throw new OpenShellError("openshell_remote_unknown");
    if ((await this.docker(["volume", "ls", "--format", "{{.Name}}"])).trim().split("\n").includes(row.volume)) throw new OpenShellError("openshell_cleanup_pending");
    if ((await this.docker(["ps", "-aq", "--no-trunc", "--filter", `label=genbi-snapshot-publication=${row.id}`])).trim()) throw new OpenShellError("openshell_cleanup_pending");
  }
}
