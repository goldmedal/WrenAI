import { createHash, randomBytes } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { runOpenShellCommand, type OpenShellConfiguration } from "./openshell-driver.js";
import { piEndpointAddress, type OpenShellPiBootDescriptor } from "./openshell-pi-boot.js";
import { renderPiEndpointAssets } from "./openshell-pi-assets.js";
import { evaluatePiCertification, installedComponents, shippedPiTemplateDigests, type InstalledComponents, type PiCertificationVerdict } from "./openshell-vendor-certification.js";
import { OpenShellError } from "./openshell-types.js";
import type { PiGatewayVerifier } from "./openshell-pi-gateway.js";

/** Where the image build writes the content digests of everything it ships; see `runtime-assets/pi-worker/pi-pins.mjs`. */
export const PI_IMAGE_PINS_PATH = "/opt/genbi/pins.json";
const COMMAND_DEADLINE_MS = 10_000;
/** The whole identity read, every command together, is bounded; exported so the deadline test names it. */
export const PI_IDENTITY_TOTAL_DEADLINE_MS = 25_000;
const MAX_PINS_BYTES = 8192;

type Runner = typeof runOpenShellCommand;
type Configuration = Pick<OpenShellConfiguration, "dockerExecutable" | "dockerRealpath" | "dockerDigest" | "dockerSocket" | "dockerNamespace" | "executableDigest" | "version" | "home" | "configHome" | "stateHome" | "pi">;

/** `unavailable` is an infrastructure failure to observe, never a verdict about the image. */
export type PiGateVerdict = PiCertificationVerdict | { readonly ready: false; readonly code: "runtime_probe_failed" };
export type PiCertificationGate = (signal?: AbortSignal) => Promise<PiGateVerdict>;

/** One entry of a ustar archive as `docker cp <container>:<file> -` writes it; the first block is the header, the content follows it. */
function singleFileFromTar(archive: Buffer, name: string): string {
  if (archive.length < 512) throw new OpenShellError("openshell_protocol_invalid");
  const entryName = archive.subarray(0, 100).toString("latin1").replace(/\0.*$/s, "");
  const size = Number.parseInt(archive.subarray(124, 136).toString("latin1").replace(/\0.*$/s, "").trim(), 8);
  const type = String.fromCharCode(archive[156] ?? 0);
  if (entryName !== name || !Number.isSafeInteger(size) || size < 1 || size > MAX_PINS_BYTES || (type !== "0" && type !== "\0") || archive.length < 512 + size) throw new OpenShellError("openshell_protocol_invalid");
  return archive.subarray(512, 512 + size).toString("utf8");
}

/**
 * Resolve-only reader of the pins record a pi image carries. The image is only created, never started: `docker create`,
 * `docker cp` of one file, `docker rm`. Nothing from the image runs, so the host never executes pi and never discovers it
 * from PATH. Commands use the driver's attested docker executable and socket with an explicit minimal environment; every
 * failure, timeout and surprise is a closed error. A pins record is cached by image id because an id names immutable content.
 */
export function createPiImagePinsReader(options: { readonly configuration: Configuration; readonly run?: Runner; readonly timeoutMs?: number }): (signal?: AbortSignal) => Promise<unknown> {
  const { configuration } = options;
  const pi = configuration.pi;
  if (!pi) throw new OpenShellError("openshell_configuration_invalid");
  const run = options.run ?? runOpenShellCommand;
  const environment = Object.freeze({ PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: configuration.home, XDG_CONFIG_HOME: configuration.configHome, XDG_STATE_HOME: configuration.stateHome, LANG: "en_US.UTF-8", DOCKER_HOST: `unix://${configuration.dockerSocket}` });
  const label = `genbi-pi-identity=${configuration.dockerNamespace}`;
  const cache = new Map<string, unknown>();
  let inflight: Promise<unknown> | undefined;
  const attest = () => {
    try {
      if (realpathSync(configuration.dockerExecutable) !== configuration.dockerRealpath
        || `sha256:${createHash("sha256").update(readFileSync(configuration.dockerExecutable)).digest("hex")}` !== configuration.dockerDigest) throw new Error();
    } catch { throw new OpenShellError("openshell_identity_mismatch"); }
  };
  const docker = async (argv: readonly string[], signal: AbortSignal | undefined): Promise<string> => {
    attest(); signal?.throwIfAborted();
    try { return await run(configuration.dockerExecutable, argv, environment, signal, options.timeoutMs ?? COMMAND_DEADLINE_MS); }
    catch (error) { throw error instanceof OpenShellError && error.code === "openshell_cancelled" ? error : new OpenShellError("openshell_gateway_unavailable"); }
  };
  const read = async (signal: AbortSignal): Promise<unknown> => {
    // A crash between create and remove leaves one labelled, never-started container; the owner of this namespace sweeps it first.
    const stale = (await docker(["ps", "-a", "-q", "--filter", `label=${label}`], signal)).split("\n").map(line => line.trim()).filter(Boolean);
    if (stale.length) await docker(["rm", "-f", ...stale], signal);
    const name = `genbi-pi-identity-${randomBytes(8).toString("hex")}`;
    let created = false;
    try {
      created = true;
      // `--pull never`: the configured id must already exist locally; the host never fetches anything to read an identity.
      await docker(["create", "--pull", "never", "--name", name, "--label", label, "--network", "none", pi.image], signal);
      const archive = await copyOut(name, signal);
      return JSON.parse(singleFileFromTar(archive, "pins.json"));
    } finally {
      // Removal is never skipped because the caller cancelled: it has its own short deadline.
      if (created) await docker(["rm", "-f", name], undefined).catch(() => {});
    }
  };
  const copyOut = async (name: string, signal: AbortSignal): Promise<Buffer> => Buffer.from(await docker(["cp", `${name}:${PI_IMAGE_PINS_PATH}`, "-"], signal), "latin1");
  return async (outer) => {
    const cached = cache.get(pi.image);
    if (cached !== undefined) return cached;
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), PI_IDENTITY_TOTAL_DEADLINE_MS);
    const signal = AbortSignal.any([deadline.signal, ...(outer ? [outer] : [])]);
    try {
      inflight ??= read(signal).finally(() => { inflight = undefined; });
      const pins = await inflight;
      cache.set(pi.image, pins);
      return pins;
    } catch (error) {
      if (deadline.signal.aborted && !outer?.aborted) throw new OpenShellError("openshell_gateway_unavailable");
      throw error;
    } finally { clearTimeout(timer); }
  };
}

/** The configured policy and profile are instances of the shipped templates, rendered with the descriptor's own parameters. */
export function piAssetsConform(descriptor: OpenShellPiBootDescriptor, policyText: string, profileText: string): { readonly policy: boolean; readonly profile: boolean } {
  try {
    const address = piEndpointAddress(descriptor.endpoint);
    // The display name is the operator's label; every other parameter is fixed by the descriptor.
    const displayName = /^display_name: (.+)$/m.exec(profileText)?.[1];
    const rendered = renderPiEndpointAssets({ host: address.host, port: address.port, profileId: descriptor.profileId, displayName: displayName ?? "unnamed", credentialEnv: descriptor.endpoint.credentialEnv });
    return { policy: rendered.policy === policyText, profile: displayName !== undefined && rendered.profile === profileText };
  } catch { return { policy: false, profile: false }; }
}

export interface PiGateOptions {
  readonly configuration: Configuration;
  readonly descriptor: OpenShellPiBootDescriptor;
  readonly rows?: readonly unknown[];
  readonly installed?: () => InstalledComponents;
  readonly host?: { readonly platform: string; readonly arch: string };
  readonly readPins?: (signal?: AbortSignal) => Promise<unknown>;
  readonly readFile?: (file: string) => string;
  readonly run?: Runner;
}

/**
 * The pi certification gate: reads the configured image's pins (resolve-only), the configured policy and profile and the gateway build, and
 * returns the verdict of an exact match against the certified rows. It never runs a model, never throws a digest or a path, and fails closed.
 */
export function createPiCertificationGate(options: PiGateOptions): PiCertificationGate {
  const { configuration, descriptor } = options;
  const pi = configuration.pi;
  const readPins = options.readPins ?? createPiImagePinsReader({ configuration, ...(options.run ? { run: options.run } : {}) });
  const readFile = options.readFile ?? ((file: string) => readFileSync(file, "utf8"));
  return async (signal) => {
    let observed;
    try {
      if (!pi) throw new OpenShellError("openshell_configuration_invalid");
      const pins = await readPins(signal);
      observed = {
        host: options.host ?? { platform: process.platform, arch: process.arch },
        gateway: { version: configuration.version, executableSha256: configuration.executableDigest.replace(/^sha256:/, "") },
        pins, templates: shippedPiTemplateDigests(),
        conformance: piAssetsConform(descriptor, readFile(pi.policy), readFile(pi.profile)),
      };
    } catch (error) {
      if (signal?.aborted) throw error;
      return { ready: false, code: "runtime_probe_failed" };
    }
    return evaluatePiCertification(observed, options.rows, options.installed?.());
  };
}

/** A verdict that is not ready becomes the closed error every host path already handles. */
export function assertPiCertified(verdict: PiGateVerdict): void {
  if (!verdict.ready) throw new OpenShellError(verdict.code);
}

/** The gateway proof plus the certified identity: both must hold at every Ask, session reservation, step and gateway watch tick. */
export const requirePiCertification = (verify: PiGatewayVerifier, certify: PiCertificationGate): PiGatewayVerifier =>
  async (signal) => { await verify(signal); assertPiCertified(await certify(signal)); };
