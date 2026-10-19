import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { OpenShellCliDriver, readOpenShellConfiguration, runOpenShellCommand, type OpenShellConfiguration } from "./runtime-host/openshell-driver.js";
import { readOpenShellPiBoot } from "./runtime-host/openshell-pi-boot.js";
import { renderPiEndpointAssets } from "./runtime-host/openshell-pi-assets.js";
import { PI_PROFILE_BINARIES, canonicalGatewayProfileDigest, createPiGatewayVerifier, type PiGatewayVerifier } from "./runtime-host/openshell-pi-gateway.js";
import { createPiCertificationGate, type PiCertificationGate } from "./runtime-host/openshell-pi-identity.js";
import { PI_CERTIFIED_ROWS, piCertificationSchema, shippedPiTemplateDigests } from "./runtime-host/openshell-vendor-certification.js";
import { piEndpointSchema } from "./runtime-host/pi-protocol.js";
import { resolveRuntimeSelection } from "./runtime-selection.js";

/**
 * Operator provisioning of one pi OpenShell boot. A host CLI, never part of the server: it builds the image, renders and imports the
 * policy and profile, **prints** the provider-create command, and writes the protected descriptor and driver configuration.
 *
 * It never reads, accepts, echoes or stores a model key. It never consults the ambient environment: every subprocess gets an explicit
 * minimal environment built from the spec, and the credential is only ever the NAME of a variable the operator exports in their own shell.
 */

const absolute = z.string().max(4096).refine(value => path.isAbsolute(value) && !value.includes("\0"), "must be an absolute path");
const token = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/);
const tier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);
/** An exact model id. A Claude alias or `inherit` can never name a pi model, exactly as in the descriptor. */
const model = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/).refine(value => !["sonnet", "opus", "haiku", "inherit"].includes(value));
/** The provision input. Closed, and no field can hold a secret: an unknown field such as `apiKey` is rejected. */
export const piOperatorSpecSchema = z.object({
  version: z.literal(1),
  /** An existing driver configuration to extend: it names the OpenShell build, gateway, workspace, docker and the other images. */
  baseDriverConfig: absolute,
  /** Output directory, created 0700. It receives the rendered policy and profile, the descriptor and the driver configuration. */
  outDir: absolute,
  /** Optional docker CLI configuration directory (its `cli-plugins` hold the buildx component the build needs). Without it the build runs with the base configuration's home. */
  dockerConfig: absolute.optional(),
  imageTag: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,62}(?::[A-Za-z0-9][A-Za-z0-9._-]{0,127})?$/),
  gatewayUrl: z.string().max(2048),
  caCert: absolute, clientCert: absolute, clientKey: absolute,
  auth: z.enum(["api-key", "gateway"]),
  provider: token,
  profileId: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/),
  displayLabel: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/),
  generation: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/),
  endpoint: piEndpointSchema,
  thinking: z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]).optional(),
  models: z.record(tier, model).refine(value => Object.keys(value).length > 0 && Object.keys(value).length <= 16),
}).strict();
export type PiOperatorSpec = z.infer<typeof piOperatorSpecSchema>;

export class PiOperatorError extends Error {
  constructor(readonly code: "spec_invalid" | "base_configuration_invalid" | "build_failed" | "profile_refused" | "refused_to_overwrite" | "verification_failed" | "gateway_failed", message: string) { super(message); this.name = "PiOperatorError"; }
}

export type OperatorRunner = (executable: string, argv: readonly string[], environment: NodeJS.ProcessEnv, timeoutMs: number) => Promise<string>;
const defaultRunner: OperatorRunner = (executable, argv, environment, timeoutMs) => runOpenShellCommand(executable, argv, environment, undefined, timeoutMs);
const PACKAGED_ASSETS = fileURLToPath(new URL("../runtime-assets/pi-worker/", import.meta.url));
const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const COMMAND_TIMEOUT_MS = 60_000;
const BUILD_TIMEOUT_MS = 20 * 60_000;

export interface PiOperatorStep { readonly name: string; readonly status: "planned" | "done" | "unchanged" | "reused" | "operator_action"; readonly detail?: string }
export interface PiOperatorReport {
  readonly ok: boolean;
  readonly dryRun: boolean;
  readonly steps: readonly PiOperatorStep[];
  /** The command the operator runs in their own shell. It contains the variable NAME and the literal placeholder `<your key>`, never a value. */
  readonly providerCommand: string;
  readonly providerExists?: boolean;
  /** sha256 of each file this run writes (or would write). */
  readonly files: Readonly<Record<string, string>>;
  readonly certifiedRowAvailable: boolean;
}

const shellQuote = (value: string) => /^[A-Za-z0-9_./:=@%+,-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;

interface Context {
  readonly spec: PiOperatorSpec;
  readonly configuration: OpenShellConfiguration;
  readonly rawBase: Record<string, unknown>;
  readonly run: OperatorRunner;
  readonly dockerEnvironment: NodeJS.ProcessEnv;
  readonly osEnvironment: NodeJS.ProcessEnv;
}
function load(rawSpec: unknown, run: OperatorRunner): Context {
  const parsed = piOperatorSpecSchema.safeParse(rawSpec);
  if (!parsed.success) throw new PiOperatorError("spec_invalid", `The spec is invalid: ${parsed.error.issues.map(issue => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; ")}`);
  const spec = parsed.data;
  try { const url = new URL(spec.gatewayUrl); if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error(); }
  catch { throw new PiOperatorError("spec_invalid", "The spec is invalid: gatewayUrl must be an https origin with a trailing slash and no credentials."); }
  const selection = resolveRuntimeSelection({ GENBI_RUNTIME: "openshell", GENBI_BACKEND: "pi" });
  const read = readOpenShellConfiguration({ GENBI_OPENSHELL_CONFIG: spec.baseDriverConfig }, selection);
  if (!read.configuration) throw new PiOperatorError("base_configuration_invalid", "The base driver configuration is missing or invalid.");
  const rawBase = JSON.parse(readFileSync(spec.baseDriverConfig, "utf8")) as Record<string, unknown>;
  const configuration = read.configuration;
  return { spec, configuration, rawBase, run,
    dockerEnvironment: Object.freeze({ PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: configuration.home, XDG_CONFIG_HOME: configuration.configHome, XDG_STATE_HOME: configuration.stateHome, LANG: "en_US.UTF-8", DOCKER_HOST: `unix://${configuration.dockerSocket}`, ...(spec.dockerConfig ? { DOCKER_CONFIG: spec.dockerConfig } : {}) }),
    osEnvironment: Object.freeze({ PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: configuration.home, XDG_CONFIG_HOME: configuration.configHome, XDG_STATE_HOME: configuration.stateHome, LANG: "en_US.UTF-8" }) };
}
const osArgv = (context: Context, argv: readonly string[]) => ["--gateway", context.configuration.gateway, "--workspace", context.configuration.workspace, ...argv];
const openshell = (context: Context, argv: readonly string[]) => context.run(context.configuration.executable, osArgv(context, argv), context.osEnvironment, COMMAND_TIMEOUT_MS);
const docker = (context: Context, argv: readonly string[], timeoutMs = COMMAND_TIMEOUT_MS) => context.run(context.configuration.dockerExecutable, argv, context.dockerEnvironment, timeoutMs);

function providerCommand(context: Context): string {
  const { spec, configuration } = context;
  return `${spec.endpoint.credentialEnv}=<your key> ${shellQuote(configuration.executable)} --gateway ${shellQuote(configuration.gateway)} --workspace ${shellQuote(configuration.workspace)} provider create --name ${shellQuote(spec.provider)} --type ${shellQuote(spec.profileId)} --credential ${spec.endpoint.credentialEnv}`;
}
function rendered(spec: PiOperatorSpec) {
  const url = new URL(spec.endpoint.baseUrl);
  return renderPiEndpointAssets({ host: url.hostname, port: url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80, profileId: spec.profileId, displayName: spec.displayLabel, credentialEnv: spec.endpoint.credentialEnv });
}
const hasCertifiedRow = () => PI_CERTIFIED_ROWS.some(row => piCertificationSchema.safeParse(row).success);

/** Owner-only directory and 0600 files. Refuses a symlink, a foreign owner and a looser mode. */
function ensureProtectedDirectory(directory: string): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory() || stat.uid !== process.getuid?.()) throw new PiOperatorError("refused_to_overwrite", "The output directory is not an owner-only directory owned by you.");
  chmodSync(directory, 0o700);
}
type WriteResult = "done" | "unchanged";
function writeProtected(file: string, content: string, replace: boolean): WriteResult {
  if (existsSync(file)) {
    if (lstatSync(file).isSymbolicLink()) throw new PiOperatorError("refused_to_overwrite", `${path.basename(file)} is a symbolic link.`);
    if (readFileSync(file, "utf8") === content) { chmodSync(file, 0o600); return "unchanged"; }
    if (!replace) throw new PiOperatorError("refused_to_overwrite", `${path.basename(file)} already exists with different content; review it, then pass --replace to overwrite it.`);
  }
  writeFileSync(file, content, { mode: 0o600 }); chmodSync(file, 0o600); return "done";
}
const pretty = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

const exportedProfile = z.object({
  id: z.string(),
  credentials: z.array(z.object({ env_vars: z.array(z.string()).optional() }).passthrough()),
  endpoints: z.array(z.object({ host: z.string(), port: z.number(), protocol: z.string().optional(), access: z.string().optional(), enforcement: z.string().optional() }).passthrough()),
  binaries: z.array(z.string()),
}).passthrough();
/** An existing profile is reused only when it is exactly the profile this spec renders: one endpoint, the node binary alone, the one credential name. */
function exportConforms(spec: PiOperatorSpec, raw: unknown): boolean {
  const parsed = exportedProfile.safeParse(raw); if (!parsed.success) return false;
  const url = new URL(spec.endpoint.baseUrl); const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  const { id, credentials, endpoints, binaries } = parsed.data; const endpoint = endpoints[0];
  return id === spec.profileId && endpoints.length === 1 && !!endpoint && endpoint.host.toLowerCase() === url.hostname.toLowerCase() && endpoint.port === port && endpoint.protocol === "rest" && endpoint.access === "read-write" && endpoint.enforcement === "enforce"
    && binaries.length === PI_PROFILE_BINARIES.length && binaries.every((value, index) => value === PI_PROFILE_BINARIES[index])
    && credentials.length === 1 && JSON.stringify(credentials[0]!.env_vars ?? []) === JSON.stringify([spec.endpoint.credentialEnv]);
}
const providerPage = z.object({ next_page_token: z.string().optional(), providers: z.array(z.object({ name: z.string(), type: z.string(), credential_keys: z.array(z.string()).optional() }).passthrough()) }).passthrough();

/**
 * `--dry-run` runs no docker and no gateway command and writes nothing; it reports the plan, the rendered asset digests and the provider command.
 * Otherwise it provisions, idempotently: a re-run that yields byte-identical files changes nothing, a differing file is refused without `replace`.
 */
export async function provisionPiBoot(rawSpec: unknown, options: { readonly dryRun?: boolean; readonly replace?: boolean; readonly run?: OperatorRunner } = {}): Promise<PiOperatorReport> {
  const context = load(rawSpec, options.run ?? defaultRunner);
  const { spec } = context; const replace = options.replace === true;
  const assets = rendered(spec);
  const files: Record<string, string> = { "policy.yaml": sha256(assets.policy), "profile.yaml": sha256(assets.profile) };
  const steps: PiOperatorStep[] = [];
  if (options.dryRun) {
    return { ok: true, dryRun: true, providerCommand: providerCommand(context), files, certifiedRowAvailable: hasCertifiedRow(), steps: [
      { name: "build image", status: "planned", detail: `docker build the packaged pi-worker assets as ${spec.imageTag}` },
      { name: "render policy and profile", status: "planned" },
      { name: "lint and import the profile", status: "planned" },
      { name: "print the provider-create command", status: "operator_action", detail: "run it yourself, with the key in your own environment" },
      { name: "write the descriptor and the driver configuration", status: "planned", detail: "pi-boot.json and driver-config.json, 0600 in a 0700 directory" },
    ] };
  }
  ensureProtectedDirectory(spec.outDir);
  const policyFile = path.join(spec.outDir, "policy.yaml"), profileFile = path.join(spec.outDir, "profile.yaml");
  // Refuse a changed asset before any docker or gateway effect.
  for (const [file, content] of [[policyFile, assets.policy], [profileFile, assets.profile]] as const)
    if (existsSync(file) && readFileSync(file, "utf8") !== content && !replace) throw new PiOperatorError("refused_to_overwrite", `${path.basename(file)} already exists with different content; review it, then pass --replace to overwrite it.`);

  let imageId: string;
  try {
    await docker(context, ["build", "-q", "--platform", "linux/arm64", "-t", spec.imageTag, PACKAGED_ASSETS], BUILD_TIMEOUT_MS);
    imageId = (await docker(context, ["image", "inspect", spec.imageTag, "--format", "{{.Id}}"])).trim();
  } catch { throw new PiOperatorError("build_failed", `The image build failed. Run \`docker build --platform linux/arm64 -t ${spec.imageTag} <packaged runtime-assets/pi-worker>\` yourself to see why.`); }
  if (!/^sha256:[a-f0-9]{64}$/.test(imageId)) throw new PiOperatorError("build_failed", "The built image has no content id.");
  steps.push({ name: "build image", status: "done" });

  const assetWrites = [writeProtected(policyFile, assets.policy, replace), writeProtected(profileFile, assets.profile, replace)];
  steps.push({ name: "render policy and profile", status: assetWrites.every(value => value === "unchanged") ? "unchanged" : "done" });
  const policyDigest = `sha256:${files["policy.yaml"]}`, profileFileDigest = `sha256:${files["profile.yaml"]}`;

  let gatewayExport: unknown;
  try {
    let existing: unknown;
    try { existing = JSON.parse(await openshell(context, ["provider", "profile", "export", spec.profileId, "--output", "json"])); } catch { existing = undefined; }
    if (existing !== undefined) {
      // Lint refuses a profile whose id is already registered, so an existing profile is judged by its export alone.
      if (!exportConforms(spec, existing)) throw new PiOperatorError("profile_refused", `A provider profile named ${spec.profileId} already exists on the gateway and is not the profile this spec renders; remove it yourself or choose another profileId.`);
      steps.push({ name: "lint and import the profile", status: "reused" });
    } else {
      await openshell(context, ["provider", "profile", "lint", "--file", profileFile]);
      await openshell(context, ["provider", "profile", "import", "--file", profileFile]);
      steps.push({ name: "lint and import the profile", status: "done" });
    }
    gatewayExport = JSON.parse(await openshell(context, ["provider", "profile", "export", spec.profileId, "--output", "json"]));
  } catch (error) { if (error instanceof PiOperatorError) throw error; throw new PiOperatorError("gateway_failed", "A gateway command failed while linting, importing or exporting the profile."); }
  if (!exportConforms(spec, gatewayExport)) throw new PiOperatorError("profile_refused", "The gateway's exported profile does not match the rendered profile.");
  const profileDigest = canonicalGatewayProfileDigest(gatewayExport);

  let providerExists = false;
  try {
    const page = providerPage.safeParse(JSON.parse(await openshell(context, ["provider", "list", "--output", "json", "--page-size", "100"])));
    providerExists = page.success && page.data.providers.some(entry => entry.name === spec.provider && entry.type === spec.profileId && JSON.stringify(entry.credential_keys ?? []) === JSON.stringify([spec.endpoint.credentialEnv]));
  } catch { providerExists = false; }
  steps.push({ name: "print the provider-create command", status: "operator_action", detail: providerExists ? "the provider already exists with this profile and credential name" : "run it yourself, with the key in your own environment" });

  const { model: _model, ...base } = context.rawBase;
  const descriptor = { version: 1, gatewayUrl: spec.gatewayUrl, caCert: spec.caCert, clientCert: spec.clientCert, clientKey: spec.clientKey, auth: spec.auth, provider: spec.provider, profileId: spec.profileId,
    displayLabel: spec.displayLabel, profileDigest, generation: spec.generation, endpoint: spec.endpoint, ...(spec.thinking ? { thinking: spec.thinking } : {}), models: spec.models };
  const driverConfig = { ...base, pi: { image: imageId, policy: policyFile, policyDigest, provider: spec.provider, profile: profileFile, profileDigest: profileFileDigest } };
  const bootFile = path.join(spec.outDir, "pi-boot.json"), configFile = path.join(spec.outDir, "driver-config.json");
  const bootContent = pretty(descriptor), configContent = pretty(driverConfig);
  for (const [file, content] of [[bootFile, bootContent], [configFile, configContent]] as const)
    if (existsSync(file) && readFileSync(file, "utf8") !== content && !replace) throw new PiOperatorError("refused_to_overwrite", `${path.basename(file)} already exists with different content (a new image, endpoint, model or profile); review it, then pass --replace to overwrite it.`);
  const wrote = [writeProtected(bootFile, bootContent, replace), writeProtected(configFile, configContent, replace)];
  files["pi-boot.json"] = sha256(bootContent); files["driver-config.json"] = sha256(configContent);
  steps.push({ name: "write the descriptor and the driver configuration", status: wrote.every(value => value === "unchanged") ? "unchanged" : "done" });
  return { ok: true, dryRun: false, steps, providerCommand: providerCommand(context), providerExists, files, certifiedRowAvailable: hasCertifiedRow() };
}

type PiBootDescriptor = NonNullable<ReturnType<typeof readOpenShellPiBoot>>["descriptor"];
/** The three effectful checks of `verify`, injectable so each can be tested closed. Production passes nothing and the real driver, verifier and gate run. */
export interface PiVerifyChecks {
  readonly probeDriver?: (configuration: OpenShellConfiguration) => Promise<void>;
  readonly gatewayProof?: (configuration: OpenShellConfiguration, descriptor: PiBootDescriptor) => PiGatewayVerifier;
  readonly certification?: (configuration: OpenShellConfiguration, descriptor: PiBootDescriptor) => PiCertificationGate;
}
export interface PiVerifyCheck { readonly name: string; readonly ok: boolean; readonly code?: string }
export interface PiVerifyReport { readonly ok: boolean; readonly checks: readonly PiVerifyCheck[] }
/**
 * The checks a boot runs before pi can be ready, in the same order and with the same code: the protected descriptor, the driver
 * configuration, the driver probe (executable, docker, images), the gateway proof and the certified identity.
 */
export async function verifyPiBoot(directory: string, options: { readonly signal?: AbortSignal; readonly checks?: PiVerifyChecks } = {}): Promise<PiVerifyReport> {
  const probeDriver = options.checks?.probeDriver ?? (async (configuration: OpenShellConfiguration) => { await new OpenShellCliDriver(configuration).probe(); });
  const gatewayProof = options.checks?.gatewayProof ?? ((configuration: OpenShellConfiguration, descriptor: PiBootDescriptor) => createPiGatewayVerifier({ configuration, descriptor }));
  const certification = options.checks?.certification ?? ((configuration: OpenShellConfiguration, descriptor: PiBootDescriptor) => createPiCertificationGate({ configuration, descriptor }));
  const checks: PiVerifyCheck[] = [];
  const stop = (name: string, code?: string): PiVerifyReport => { checks.push({ name, ok: false, ...(code ? { code } : {}) }); return { ok: false, checks }; };
  const env = { GENBI_RUNTIME: "openshell", GENBI_BACKEND: "pi", GENBI_OPENSHELL_CONFIG: path.join(directory, "driver-config.json"), GENBI_OPENSHELL_PI_BOOT: path.join(directory, "pi-boot.json") };
  const selection = resolveRuntimeSelection(env);
  const boot = readOpenShellPiBoot(env, selection);
  if (!boot) return stop("protected descriptor", "openshell_configuration_invalid");
  checks.push({ name: "protected descriptor", ok: true });
  const configuration = readOpenShellConfiguration(env, selection).configuration;
  if (!configuration?.pi || configuration.model || configuration.pi.provider !== boot.descriptor.provider) return stop("driver configuration", "openshell_configuration_invalid");
  checks.push({ name: "driver configuration", ok: true });
  const codeOf = (error: unknown) => (error && typeof error === "object" && "code" in error && typeof (error as { code: unknown }).code === "string" ? (error as { code: string }).code : "openshell_unavailable");
  try { await probeDriver(configuration); } catch (error) { return stop("driver probe", codeOf(error)); }
  checks.push({ name: "driver probe", ok: true });
  try { await gatewayProof(configuration, boot.descriptor)(options.signal); } catch (error) { return stop("gateway proof", codeOf(error)); }
  checks.push({ name: "gateway proof", ok: true });
  const verdict = await certification(configuration, boot.descriptor)(options.signal).catch(() => ({ ready: false, code: "runtime_probe_failed" }) as const);
  if (!verdict.ready) return stop("certified identity", verdict.code);
  checks.push({ name: "certified identity", ok: true });
  return { ok: true, checks };
}

/** The packaged certification rows and whether the packaged assets still hash to them, for acceptance and for operators. No path appears in it. */
export function describePackagedCertification(assetsRoot = PACKAGED_ASSETS): Record<string, unknown> {
  const fileDigest = (name: string) => sha256(readFileSync(path.join(assetsRoot, name)));
  const files = { worker: "pi-worker.mjs", workerCore: "pi-worker-core.mjs", shim: "pi-mcp-shim.mjs", procCheck: "pi-proc-check.mjs", sessionStep: "pi-session-step.mjs", stepControl: "pi-step-control.mjs",
    trust: "claude-worker-ca.mjs", pins: "pi-pins.mjs", lockfile: "package-lock.json" } as const;
  const rows = PI_CERTIFIED_ROWS.flatMap(value => { const parsed = piCertificationSchema.safeParse(value); return parsed.success ? [parsed.data] : []; });
  const templates = shippedPiTemplateDigests(assetsRoot);
  return { rows: rows.map(row => ({
    vendor: row.vendor, state: row.state, host: row.host, imageArch: row.imageArch, gateway: row.gateway, piVersion: row.image.pins.piVersion, nodeVersion: row.image.pins.nodeVersion, nodeBase: row.image.nodeBase,
    evidence: row.evidence, dependencies: row.dependencies,
    packagedAssetsMatch: Object.entries(files).every(([key, name]) => row.image.pins[key as keyof typeof files] === fileDigest(name)) && row.image.templates.policy === templates.policy && row.image.templates.profile === templates.profile,
  })) };
}

