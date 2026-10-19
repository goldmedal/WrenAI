import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";

/**
 * Certification rows for a model vendor that runs inside an OpenShell image. A row is data: a strict
 * schema and an exact match, with no minimum-version logic and no fallback. Only `certified_row`
 * parses, so a `tested_baseline` record, a partial row or an unknown field can never admit a boot.
 * The union is keyed by vendor so a further vendor adds its own variant without touching this one.
 */
const sha256Hex = z.string().regex(/^[a-f0-9]{64}$/);
const exactVersion = z.string().regex(/^[0-9]+\.[0-9]+\.[0-9]+$/);

/** The record `/opt/genbi/pins.json` carries in the pi image. Closed: an unknown field is a mismatch. */
export const piImagePinsSchema = z.object({
  nodeVersion: z.string().regex(/^v[0-9]+\.[0-9]+\.[0-9]+$/),
  piVersion: exactVersion,
  /** Tree digest of pi's `dist/bundle`. */
  piBundle: sha256Hex,
  node: sha256Hex, worker: sha256Hex, workerCore: sha256Hex, shim: sha256Hex, procCheck: sha256Hex,
  sessionStep: sha256Hex, stepControl: sha256Hex, trust: sha256Hex, pins: sha256Hex, lockfile: sha256Hex,
}).strict();
export type PiImagePins = z.infer<typeof piImagePinsSchema>;

const baseRow = {
  state: z.literal("certified_row"),
  host: z.object({ platform: z.enum(["darwin", "linux"]), arch: z.enum(["arm64", "x64"]) }).strict(),
  imageArch: z.literal("linux-arm64"),
  /** The OpenShell build the evidence was produced on: its reported version and the CLI executable's content digest. */
  gateway: z.object({ version: z.string().regex(/^0\.0\.[0-9]+(?:[-+][A-Za-z0-9.+-]+)?$/), executableSha256: sha256Hex }).strict(),
  evidence: z.object({ deterministicProbesSha256: sha256Hex, packedAcceptanceSha256: sha256Hex, releaseApprovalSha256: sha256Hex }).strict(),
  /** The component versions the acceptance records were produced with; drift denies the row. */
  dependencies: z.object({ warble: exactVersion, ir: exactVersion, "context-loader": exactVersion }).strict(),
};
export const piCertificationSchema = z.object({
  ...baseRow,
  vendor: z.literal("pi"),
  image: z.object({
    /** The Dockerfile `FROM` reference: Node version and base image digest. */
    nodeBase: z.string().regex(/^node:[0-9]+\.[0-9]+\.[0-9]+-slim@sha256:[a-f0-9]{64}$/),
    pins: piImagePinsSchema,
    /** The shipped templates the operator's rendered policy and profile must be instances of. */
    templates: z.object({ policy: sha256Hex, profile: sha256Hex }).strict(),
  }).strict(),
}).strict();
export const openShellVendorCertificationSchema = z.discriminatedUnion("vendor", [piCertificationSchema]);
export type PiCertification = z.infer<typeof piCertificationSchema>;
export type OpenShellVendorCertification = z.infer<typeof openShellVendorCertificationSchema>;

/**
 * A tested baseline is not an execution grant. Release engineering adds an exact reviewed row; there is no
 * range. Re-certify on every pi, Node, worker, lockfile, template, OpenShell or component-version change.
 */
export const PI_CERTIFIED_ROWS: readonly unknown[] = Object.freeze([
  {
    "state": "certified_row",
    "vendor": "pi",
    "host": { "platform": "darwin", "arch": "arm64" },
    "imageArch": "linux-arm64",
    "gateway": { "version": "0.0.117-dev.167+g7e7a8d561", "executableSha256": "f93bd7a5198527604cd507fcfdd02895e2ee50dc48128d38bec72ad853d42654" },
    "image": {
      "nodeBase": "node:24.20.0-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e",
      "pins": {
        "nodeVersion": "v24.20.0",
        "piVersion": "1.0.4",
        "piBundle": "99a5efa3dca87774c0332423d0f65a60b14c023fc9bba6fe4bf2aa3069dfb937",
        "node": "23a5637c2470fde09fcc1acc77c1b92e04e3d7e3e6e80ff7df6f5831958d1477",
        "worker": "509bd40fcfa595f662b2f8d9a5da13f464d7ffd167e63d98acaa8f92d34dc18b",
        "workerCore": "0b8f58623b2e291f8931ec470c6e025f08aa20dfb189802a03c4f6c2962a83ae",
        "shim": "8dff4346866cc0b12483146960a396928e34edc5d37cd03f01fd364a1b458897",
        "procCheck": "9ec6f0f9945e8cbdc58986be2837de623279015a347595b4b03b90942ba48fd9",
        "sessionStep": "2c387f0952026451bec22e12cd315212b6eba9f5f775b0e1cc912315f45037c9",
        "stepControl": "87b33c39b5bd9e77fecec1d3756e9e43aee64ef81d0869e4d1edecd603bb6756",
        "trust": "9b5376ad8876013407d7b614daec62a77bb813f94ffb06c53818ff1eb7809d87",
        "pins": "2e6ad19f0a4d35c257b2aa7bf2d54d7a133e22606800ec7dbc8fd936e54944d1",
        "lockfile": "a714e93d80449d851cf5c51d0cd6122f0696c4a2e20f7bf848e9b6588490e98b"
      },
      "templates": {
        "policy": "30832a2ee6ca301ab20fbef2c87599240d78101f17877e29f68299b5a68be3f6",
        "profile": "efb0b63560491e1f9d1427f6cb510880786c5b6bc1192295fbcbfa20c7d6566e"
      }
    },
    "evidence": {
      "deterministicProbesSha256": "09eaf76c861039ace0d477eca102cfee115ace60d835b7697199ab085733b629",
      "packedAcceptanceSha256": "e76737271332f39548f7353aa6fc6c77198eb3de55f729cd026626b9473c23cb",
      "releaseApprovalSha256": "c524bc26cf18b6b029f276b33e8c5bca16813b7789dca79f037977ff66b914c7"
    },
    "dependencies": { "warble": "0.19.0", "ir": "0.9.0", "context-loader": "0.1.4" }
  }
]);

const COMPONENT_PACKAGES = {
  "@warble/cli": "warble",
  "@warble/codex-local": "warble",
  "@warble/claude-agent-sdk": "warble",
  "@warble/ir-spec": "ir",
  "@wrenai/context-loader": "context-loader",
} as const satisfies Record<string, keyof PiCertification["dependencies"]>;
export type ComponentPackage = keyof typeof COMPONENT_PACKAGES;
export type InstalledComponents = Readonly<Partial<Record<ComponentPackage, string | undefined>>>;

function packageRoot(): string {
  const server = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const parent = path.resolve(server, "..");
  return path.basename(parent) === "dist-server" ? path.resolve(parent, "..") : parent;
}
function declaredPin(name: ComponentPackage): string | undefined {
  try {
    const value = (JSON.parse(readFileSync(path.join(packageRoot(), "package.json"), "utf8")) as { dependencies?: Record<string, unknown> }).dependencies?.[name];
    return typeof value === "string" ? value : undefined;
  } catch { return undefined; }
}
export interface ComponentReaders {
  /** Manifest path, or undefined only when Node cannot resolve the package at all. */
  readonly resolve?: (name: ComponentPackage) => string | undefined;
  readonly read?: (file: string) => string;
  readonly declared?: (name: ComponentPackage) => string | undefined;
}
/**
 * The installed manifests are authoritative: what Node resolves is what runs. This package's declared exact pin is the fallback
 * only when a package cannot be resolved at all; a resolved manifest that cannot be read or has no version is "unreadable" and drifts.
 */
export function installedComponents({
  resolve = (name) => { try { return createRequire(import.meta.url).resolve(`${name}/package.json`); } catch { return undefined; } },
  read = (file) => readFileSync(file, "utf8"),
  declared = declaredPin,
}: ComponentReaders = {}): InstalledComponents {
  const installedVersion = (name: ComponentPackage): string | undefined => {
    const manifest = resolve(name);
    if (manifest === undefined) return declared(name);
    try {
      const version = (JSON.parse(read(manifest)) as { version?: unknown }).version;
      return typeof version === "string" ? version : "unreadable";
    } catch { return "unreadable"; }
  };
  return Object.fromEntries((Object.keys(COMPONENT_PACKAGES) as ComponentPackage[]).map((name) => [name, installedVersion(name)]));
}
/** Each entry names one drifted package as `name: certified X, installed Y`. Host diagnostics only. */
export function componentDrift(certified: PiCertification["dependencies"], installed: InstalledComponents): readonly string[] {
  return (Object.entries(COMPONENT_PACKAGES) as [ComponentPackage, keyof PiCertification["dependencies"]][])
    .filter(([name, key]) => installed[name] !== certified[key])
    .map(([name, key]) => `${name}: certified ${certified[key]}, installed ${installed[name] ?? "unresolved"}`);
}

const TEMPLATE_ROOT = fileURLToPath(new URL("../../runtime-assets/pi-worker/", import.meta.url));
const digestOf = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
/** sha256 of the shipped policy and profile templates, read from the installed package. */
export function shippedPiTemplateDigests(root = TEMPLATE_ROOT): PiCertification["image"]["templates"] {
  return { policy: digestOf(path.join(root, "policy.template.yaml")), profile: digestOf(path.join(root, "profile.template.yaml")) };
}

/** Everything the host observes about one pi boot, as plain data. No path, no secret. */
export interface PiObservedIdentity {
  readonly host: { readonly platform: string; readonly arch: string };
  readonly gateway: { readonly version: string; readonly executableSha256: string };
  /** The parsed `pins.json` read from the configured image; any shape is accepted here and judged below. */
  readonly pins: unknown;
  readonly templates: PiCertification["image"]["templates"];
  /** The configured policy and profile are instances of the shipped templates rendered with the descriptor's own parameters. */
  readonly conformance: { readonly policy: boolean; readonly profile: boolean };
}
export type PiCertificationCode = "pi_uncertified" | "pi_identity_mismatch" | "pi_dependencies_drifted";
export type PiCertificationVerdict =
  | { readonly ready: true; readonly version: string }
  | { readonly ready: false; readonly code: PiCertificationCode; readonly drift?: readonly string[] };

/** Pure comparison; only the rows passed in (the packaged ones by default) grant anything. */
export function evaluatePiCertification(observed: PiObservedIdentity, rows: readonly unknown[] = PI_CERTIFIED_ROWS,
  installed: InstalledComponents = installedComponents()): PiCertificationVerdict {
  const valid = rows.map((row) => piCertificationSchema.safeParse(row)).flatMap((row) => (row.success ? [row.data] : []));
  const sameBuild = valid.filter((row) => row.host.platform === observed.host.platform && row.host.arch === observed.host.arch
    && row.gateway.version === observed.gateway.version && row.gateway.executableSha256 === observed.gateway.executableSha256);
  if (sameBuild.length === 0) return { ready: false, code: "pi_uncertified" };
  const pins = piImagePinsSchema.safeParse(observed.pins);
  const row = pins.success && observed.conformance.policy && observed.conformance.profile
    ? sameBuild.find((candidate) => isDeepStrictEqual(candidate.image.pins, pins.data) && isDeepStrictEqual(candidate.image.templates, observed.templates))
    : undefined;
  if (!row) return { ready: false, code: "pi_identity_mismatch" };
  // The evidence was accepted with exact component versions; a matching image running other components is not what was certified.
  const drift = componentDrift(row.dependencies, installed);
  if (drift.length > 0) return { ready: false, code: "pi_dependencies_drifted", drift };
  return { ready: true, version: row.image.pins.piVersion };
}
