import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { OpenShellError, OPEN_SHELL_OWNER_LABEL, type OpenShellDriver, type OpenShellIntent, type OpenShellResource, type OpenShellDuplex } from "./openshell-types.js";
import type { SnapshotMount } from "./openshell-snapshot-types.js";

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const token = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/);
const absolute = z.string().refine(path.isAbsolute);
const configurationSchema = z.object({
  executable: absolute, executableDigest: digest, version: z.string().regex(/^0\.0\.[0-9]+(?:[-+][A-Za-z0-9.+-]+)?$/),
  gateway: token, workspace: token, image: digest, supervisorImage: digest, policy: absolute, policyDigest: digest,
  home: absolute, configHome: absolute, stateHome: absolute,
  dockerExecutable: absolute, dockerRealpath: absolute, dockerDigest: digest, dockerSocket: absolute, dockerNamespace: token, exclusive: z.literal(true),
  model: z.object({ image: digest, policy: absolute, policyDigest: digest }).strict().optional(),
  dataPolicy: absolute.optional(), dataPolicyDigest: digest.optional(),
  snapshotCapture: z.object({ executable: absolute, realpath: absolute, digest, helperDigest: digest, approvedFiles: z.array(z.string()).min(2).max(4094) }).strict().optional(),
}).strict().refine((value) => [value.dataPolicy, value.dataPolicyDigest, value.snapshotCapture].every((item) => item === undefined)
  || [value.dataPolicy, value.dataPolicyDigest, value.snapshotCapture].every((item) => item !== undefined), "Snapshot configuration must be complete");
export type OpenShellConfiguration = z.infer<typeof configurationSchema>;
const hash = (bytes: string | Buffer) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const resourceSchema = z.object({ id: token, name: token, workspace: token, labels: z.record(z.string(), z.string()) }).passthrough();

/** Explicit environment and shell-free bounded subprocesses. Never forwards ambient credentials. */
export function runOpenShellCommand(executable: string, argv: readonly string[], environment: NodeJS.ProcessEnv, signal?: AbortSignal, timeoutMs = 15_000): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new OpenShellError("openshell_cancelled")); return; }
    const child = spawn(executable, [...argv], { env: environment, shell: false, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
    let bytes = 0, stdout = "", failure: OpenShellError | undefined, killTimer: ReturnType<typeof setTimeout> | undefined;
    const kill = () => { try { if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL"); else child.kill("SIGKILL"); } catch { /* close/error determines settlement */ } };
    const abort = () => { failure ??= new OpenShellError("openshell_remote_unknown"); kill(); killTimer ??= setTimeout(() => { finish(); reject(new OpenShellError("openshell_remote_unknown")); }, 1000); };
    const timer = setTimeout(abort, timeoutMs);
    const finish = () => { clearTimeout(timer); clearTimeout(killTimer); signal?.removeEventListener("abort", abort); };
    signal?.addEventListener("abort", abort, { once: true });
    const chunk = (data: Buffer, output: boolean) => { bytes += data.length; if (bytes > 1_048_576) { failure ??= new OpenShellError("openshell_remote_unknown"); kill(); } else if (output) stdout += data.toString("utf8"); };
    child.stdout.on("data", (data: Buffer) => chunk(data, true)); child.stderr.on("data", (data: Buffer) => chunk(data, false));
    child.once("error", () => { finish(); reject(new OpenShellError("openshell_unavailable")); });
    child.once("close", (code) => { finish(); if (failure || code !== 0) reject(failure ?? new OpenShellError("openshell_remote_unknown")); else resolve(stdout); });
    if (signal?.aborted) abort();
  });
}

export class OpenShellCliDriver implements OpenShellDriver {
  readonly version: string;
  readonly identity: OpenShellDriver["identity"];
  readonly modelIdentity: OpenShellDriver["identity"] | undefined;
  readonly dataIdentity: OpenShellDriver["identity"] | undefined;
  private readonly configuration: OpenShellConfiguration;
  private readonly environment: NodeJS.ProcessEnv;
  constructor(configuration: OpenShellConfiguration, private readonly snapshotMount?: (intent: OpenShellIntent) => SnapshotMount, private readonly openDuplex?: (intent: OpenShellIntent, argv: readonly string[], signal: AbortSignal) => Promise<OpenShellDuplex>) {
    this.configuration = Object.freeze(configurationSchema.parse(configuration));
    this.version = configuration.version;
    this.identity = Object.freeze({ image: configuration.image, policy: configuration.policyDigest, gateway: configuration.gateway,
      workspace: configuration.workspace, configuration: hash(JSON.stringify(this.configuration)) });
    this.modelIdentity = configuration.model ? Object.freeze({ ...this.identity, image: configuration.model.image, policy: configuration.model.policyDigest }) : undefined;
    this.dataIdentity = configuration.dataPolicy && configuration.dataPolicyDigest ? Object.freeze({ ...this.identity, policy: configuration.dataPolicyDigest }) : undefined;
    this.environment = Object.freeze({ PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: configuration.home,
      XDG_CONFIG_HOME: configuration.configHome, XDG_STATE_HOME: configuration.stateHome, LANG: "en_US.UTF-8" });
  }
  private attest(): void {
    try {
      if (realpathSync(this.configuration.executable) !== this.configuration.executable || hash(readFileSync(this.configuration.executable)) !== this.configuration.executableDigest
        || realpathSync(this.configuration.dockerExecutable) !== this.configuration.dockerRealpath || hash(readFileSync(this.configuration.dockerExecutable)) !== this.configuration.dockerDigest
        || hash(readFileSync(this.configuration.policy)) !== this.configuration.policyDigest
        || (this.configuration.model && hash(readFileSync(this.configuration.model.policy)) !== this.configuration.model.policyDigest)
        || (this.configuration.dataPolicy && hash(readFileSync(this.configuration.dataPolicy)) !== this.configuration.dataPolicyDigest)) throw new Error();
    } catch { throw new OpenShellError("openshell_identity_mismatch"); }
  }
  private command(argv: readonly string[], signal?: AbortSignal, timeout = 15_000): Promise<string> {
    this.attest();
    return runOpenShellCommand(this.configuration.executable, ["--gateway", this.configuration.gateway, "--workspace", this.configuration.workspace, ...argv], this.environment, signal, timeout);
  }
  private json(raw: string): unknown { try { return JSON.parse(raw); } catch { throw new OpenShellError("openshell_protocol_invalid"); } }
  async probe(): Promise<void> {
    this.attest();
    const version = await runOpenShellCommand(this.configuration.executable, ["--version"], this.environment);
    if (version.trim() !== `openshell ${this.configuration.version}`) throw new OpenShellError("openshell_version_mismatch");
    const info = z.object({ version: z.string(), status: z.string(), compute_drivers: z.array(z.object({ name: z.string() }).passthrough()) }).passthrough().safeParse(this.json(await this.command(["gateway", "info", "--output", "json"])));
    if (!info.success || info.data.version !== this.configuration.version || info.data.status !== "healthy" || info.data.compute_drivers.length !== 1 || info.data.compute_drivers[0]?.name !== "docker") throw new OpenShellError("openshell_gateway_unavailable");
    for (const expected of [this.configuration.image, this.configuration.supervisorImage, ...(this.configuration.model ? [this.configuration.model.image] : [])]) {
      const image = z.array(z.object({ Id: z.string() }).passthrough()).safeParse(this.json(await this.docker(["image", "inspect", expected])));
      if (!image.success || image.data.length !== 1 || image.data[0]?.Id !== expected) throw new OpenShellError("openshell_identity_mismatch");
    }
    this.attest();
  }
  private parseResource(raw: unknown): OpenShellResource {
    const result = resourceSchema.safeParse(raw);
    if (!result.success) throw new OpenShellError("openshell_protocol_invalid");
    return result.data;
  }
  async create(intent: OpenShellIntent, signal: AbortSignal): Promise<OpenShellResource> {
    const mount = intent.identity.purpose === "data" ? this.snapshotMount?.(intent) : undefined;
    if (intent.identity.purpose === "data" && (!mount || !this.dataIdentity)) throw new OpenShellError("openshell_scope_invalid");
    if (intent.identity.purpose === "model" && !this.configuration.model) throw new OpenShellError("openshell_scope_invalid");
    await this.command(["sandbox", "create", "--name", intent.name, "--from", intent.identity.purpose === "model" ? this.configuration.model!.image : this.configuration.image, "--policy", intent.identity.purpose === "model" ? this.configuration.model!.policy : mount ? this.configuration.dataPolicy! : this.configuration.policy,
      ...(mount ? ["--driver-config-json", JSON.stringify({ docker: { mounts: [{ type: "volume", source: mount.volume, target: "/opt/genbi-project", read_only: true }] } })] : []),
      "--no-auto-providers", "--approval-mode", "manual", "--detach", "--tty", "--cpu", "1", "--memory", "1Gi",
      "--label", `${OPEN_SHELL_OWNER_LABEL}=${intent.owner}`, "--", "/bin/sleep", "1800"], signal, 180_000);
    return this.inspect(intent);
  }
  async list(intent: OpenShellIntent): Promise<readonly OpenShellResource[]> {
    const parsed = z.object({ sandboxes: z.array(z.unknown()), next_page_token: z.string() }).passthrough().safeParse(this.json(await this.command(["sandbox", "list", "--selector", `${OPEN_SHELL_OWNER_LABEL}=${intent.owner}`, "--output", "json"])));
    // Explicit fail-closed pagination: never prove absence with an incomplete page.
    if (!parsed.success || parsed.data.next_page_token !== "") throw new OpenShellError("openshell_protocol_invalid");
    return parsed.data.sandboxes.map((value) => this.parseResource(value));
  }
  async inspect(intent: OpenShellIntent, purpose: "runnable" | "cleanup" = "runnable"): Promise<OpenShellResource> {
    const resource = this.parseResource(this.json(await this.command(["sandbox", "get", intent.name, "--output", "json"])));
    if (resource.name !== intent.name || resource.workspace !== intent.identity.workspace || resource.labels[OPEN_SHELL_OWNER_LABEL] !== intent.owner
      || (intent.remoteId && resource.id !== intent.remoteId)) throw new OpenShellError("openshell_ownership_mismatch");
    const prefix = `openshell-${resource.workspace}--${resource.name}-${resource.id}`;
    const inventory = await this.docker(["ps", "-a", "--no-trunc", "--format", "{{.ID}} {{.Names}}"]);
    const ids: string[] = [];
    for (const line of inventory.trim().split("\n").filter(Boolean)) {
      const [id, names, extra] = line.split(" ");
      if (!id || !/^[a-f0-9]{64}$/.test(id) || !names || extra) throw new OpenShellError("openshell_protocol_invalid");
      if (names.split(",").some((name) => name === prefix || name === `${prefix}-supervisor`)) ids.push(id);
    }
    if (!ids.length) {
      if (purpose === "runnable") throw new OpenShellError("openshell_identity_mismatch");
      return { ...resource, containers: [], volumes: this.volumeNames(resource.id) };
    }
    const records = z.array(z.object({ Id: z.string(), Name: z.string(), Image: z.string(), Config: z.object({ Labels: z.record(z.string(), z.string()).nullable() }), Mounts: z.array(z.object({ Type: z.string(), Name: z.string().optional(), Destination: z.string().optional(), RW: z.boolean().optional() }).passthrough()) }).passthrough())
      .safeParse(this.json(await this.docker(["inspect", ...ids])));
    if (!records.success) throw new OpenShellError("openshell_protocol_invalid");
    const owned = records.data.filter((row) => row.Name === `/${prefix}` || row.Name === `/${prefix}-supervisor`);
    const snapshot = intent.identity.purpose === "data" ? this.snapshotMount?.(intent) : undefined;
    if (intent.identity.purpose === "data" && !snapshot) throw new OpenShellError("openshell_scope_invalid");
    if ((purpose === "runnable" && owned.length !== 2) || owned.length > 2 || owned.some((row) => row.Config.Labels?.["openshell.ai/sandbox-id"] !== resource.id
      || row.Config.Labels?.["openshell.ai/sandbox-namespace"] !== this.configuration.dockerNamespace || row.Image !== (row.Name.endsWith("-supervisor") ? this.configuration.supervisorImage : intent.identity.purpose === "model" ? this.configuration.model!.image : this.configuration.image)
      || row.Mounts.some((mount) => mount.Type !== "volume" || !mount.Name || (!this.volumeNames(resource.id).includes(mount.Name)
        && !(snapshot && !row.Name.endsWith("-supervisor") && mount.Name === snapshot.volume && mount.Destination === "/opt/genbi-project" && mount.RW === false)))
      || (snapshot && !row.Name.endsWith("-supervisor") && row.Mounts.filter((mount) => mount.Name === snapshot.volume).length !== 1))) throw new OpenShellError("openshell_identity_mismatch");
    return { ...resource, containers: owned.map((row) => row.Id), volumes: this.volumeNames(resource.id) };
  }
  async remove(intent: OpenShellIntent): Promise<void> {
    await this.command(["sandbox", "delete", intent.name]);
    const deadline = Date.now() + 5000;
    do {
      if ((await this.list(intent)).length === 0) {
        try { await this.assertAbsent(intent); return; } catch (error) { if (!(error instanceof OpenShellError && error.code === "openshell_cleanup_pending")) throw error; }
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    } while (Date.now() < deadline);
    throw new OpenShellError("openshell_cleanup_pending");
  }
  private docker(argv: readonly string[]): Promise<string> { return runOpenShellCommand(this.configuration.dockerExecutable, argv, { ...this.environment, DOCKER_HOST: `unix://${this.configuration.dockerSocket}` }); }
  private volumeNames(remoteId: string): string[] {
    const suffix = createHash("sha256").update(this.configuration.dockerNamespace).update("\0").update(remoteId).digest("hex").slice(0, 32);
    return [`openshell-channel-${suffix}`, `openshell-supervisor-${suffix}`];
  }
  async assertAbsent(intent: OpenShellIntent): Promise<void> {
    if (!intent.remoteId) throw new OpenShellError("openshell_remote_unknown");
    const prefix = `openshell-${intent.identity.workspace}--${intent.name}-${intent.remoteId}`;
    const inventory = await this.docker(["ps", "-a", "--no-trunc", "--format", "{{.ID}} {{.Names}}"]);
    if (inventory.split("\n").some((line) => line.split(" ").slice(1).some((name) => name === prefix || name === `${prefix}-supervisor`))) throw new OpenShellError("openshell_cleanup_pending");
    // Also inspect sandbox-id labels independently: some driver releases carry them.
    if ((await this.docker(["ps", "-aq", "--no-trunc", "--filter", `label=openshell.ai/sandbox-id=${intent.remoteId}`])).trim()) throw new OpenShellError("openshell_cleanup_pending");
    if (intent.containers?.some((id) => inventory.split("\n").some((line) => line.startsWith(`${id} `)))) throw new OpenShellError("openshell_cleanup_pending");
    const volumes = (await this.docker(["volume", "ls", "--format", "{{.Name}}"])).trim().split("\n");
    if ([...this.volumeNames(intent.remoteId), ...(intent.volumes ?? [])].some((volume) => volumes.includes(volume))) throw new OpenShellError("openshell_cleanup_pending");
  }
  async duplex(intent: OpenShellIntent, argv: readonly string[], signal: AbortSignal): Promise<OpenShellDuplex> {
    if (intent.identity.purpose !== "model" || !this.openDuplex || !this.modelIdentity || argv.length !== 2 || argv[0] !== "/usr/local/bin/node" || argv[1] !== "/opt/genbi/claude-worker.mjs") throw new OpenShellError("openshell_scope_invalid");
    this.attest(); await this.inspect(intent); signal.throwIfAborted();
    const stream = await this.openDuplex(intent, argv, signal);
    try { await this.inspect(intent); signal.throwIfAborted(); this.attest(); return stream; }
    catch { stream.close(); throw new OpenShellError("openshell_identity_mismatch"); }
  }
  async exec(intent: OpenShellIntent, argv: readonly string[], signal: AbortSignal): Promise<string> {
    if (!argv.length || !path.posix.isAbsolute(argv[0]!) || argv.some((value) => value.includes("\0")) || Buffer.byteLength(JSON.stringify(argv)) > 65_536) throw new OpenShellError("openshell_scope_invalid");
    return this.command(["sandbox", "exec", "--name", intent.name, "--workdir", "/sandbox", "--timeout", "30", "--no-login-shell", "--no-tty",
      "--env", "HOME=/sandbox", "--env", "PATH=/usr/bin:/bin", "--", ...argv], signal, 35_000);
  }
}

/** Disabled by default. Only the host administrator supplies this private configuration. */
export function readOpenShellConfiguration(env: NodeJS.ProcessEnv): { selected: boolean; configuration?: OpenShellConfiguration } {
  if (env.GENBI_CLAUDE_RUNTIME !== undefined && !["local", "openshell"].includes(env.GENBI_CLAUDE_RUNTIME)) throw new OpenShellError("openshell_configuration_invalid");
  if (env.GENBI_CLAUDE_RUNTIME !== "openshell") return { selected: false };
  try {
    const file = env.GENBI_OPENSHELL_CONFIG;
    if (!file || !path.isAbsolute(file)) return { selected: true };
    return { selected: true, configuration: configurationSchema.parse(JSON.parse(readFileSync(file, "utf8"))) };
  } catch { return { selected: true }; }
}
