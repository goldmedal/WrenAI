import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { componentDrift, installedComponents, type InstalledComponents } from "./openshell-vendor-certification.js";

/**
 * Certification rows for the pi that GenBI installs and runs on the host (the local runtime). The shape follows the OpenShell row: a strict
 * schema, an exact match, no range and no fallback. Only `certified_row` parses, so a `tested_baseline`, a partial row or an unknown field
 * can never admit a boot. The OpenShell union and its rows are not touched.
 */
const sha256Hex = z.string().regex(/^[a-f0-9]{64}$/);
const exactVersion = z.string().regex(/^[0-9]+\.[0-9]+\.[0-9]+$/);

/** The host `pins.json` of a managed install. Closed: an unknown field is a mismatch. */
export const localPiPinsSchema = z.object({
  piVersion: exactVersion,
  /** Tree digest of pi's `dist/bundle`. */
  piBundle: sha256Hex,
  /** The packaged MCP relay pi runs. */
  shim: sha256Hex,
  lockfile: sha256Hex,
  packageJson: sha256Hex,
}).strict();
export type LocalPiPins = z.infer<typeof localPiPinsSchema>;

export const localPiCertificationSchema = z.object({
  state: z.literal("certified_row"),
  vendor: z.literal("pi-local"),
  host: z.object({ platform: z.enum(["darwin", "linux"]), arch: z.enum(["arm64", "x64"]) }).strict(),
  /** pi runs under the BFF's own Node. The row pins its major version only; the patch level is free and pi's minimum is enforced separately. */
  nodeMajor: z.number().int().min(22).max(1000),
  install: z.object({ pins: localPiPinsSchema }).strict(),
  /** The component versions the acceptance records were produced with; drift denies the row. */
  dependencies: z.object({ warble: exactVersion, ir: exactVersion, "context-loader": exactVersion }).strict(),
  evidence: z.object({ approvalSha256: sha256Hex }).strict(),
}).strict();
export type LocalPiCertification = z.infer<typeof localPiCertificationSchema>;

/** pi's minimum Node. Below it pi is refused before any row is consulted. */
export const LOCAL_PI_MIN_NODE = "22.19.0";
const parseNode = (version: string): [number, number, number] | undefined => {
  const match = /^v?([0-9]+)\.([0-9]+)\.([0-9]+)/.exec(version);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
};
export const nodeMajorOf = (version: string): number | undefined => parseNode(version)?.[0];
export function nodeMeetsPiMinimum(version: string): boolean {
  const have = parseNode(version), need = parseNode(LOCAL_PI_MIN_NODE)!;
  if (!have) return false;
  for (let index = 0; index < 3; index++) { if (have[index]! !== need[index]!) return have[index]! > need[index]!; }
  return true;
}

/**
 * The packaged rows, and the only rows readiness ever consults: nothing reads a row from the environment or a file. Release engineering adds an
 * exact reviewed row; there is no range. The evidence is in `certification/pi-local-<version>-<host>-node<major>/`.
 */
export const LOCAL_PI_CERTIFIED_ROWS: readonly unknown[] = Object.freeze([
  {
    "state": "certified_row",
    "vendor": "pi-local",
    "host": { "platform": "darwin", "arch": "arm64" },
    "nodeMajor": 24,
    "install": {
      "pins": {
        "piVersion": "1.0.4",
        "piBundle": "99a5efa3dca87774c0332423d0f65a60b14c023fc9bba6fe4bf2aa3069dfb937",
        "shim": "8dff4346866cc0b12483146960a396928e34edc5d37cd03f01fd364a1b458897",
        "lockfile": "a714e93d80449d851cf5c51d0cd6122f0696c4a2e20f7bf848e9b6588490e98b",
        "packageJson": "8dbf9d9af435d8f53423ec0d9ca32c25c72bd72850d31343af49369d18e01c0f"
      }
    },
    "dependencies": { "warble": "0.19.0", "ir": "0.9.0", "context-loader": "0.1.4" },
    "evidence": { "approvalSha256": "09193df53f5fbc750a9dd4406b7b417a050b829023c82f9920df7548d03ad3e3" }
  }
]);

export type LocalPiCertificationCode = "pi_not_installed" | "pi_uncertified" | "pi_identity_mismatch" | "pi_dependencies_drifted" | "pi_node_unsupported";
export type LocalPiVerdict =
  | { readonly ready: true; readonly version: string }
  | { readonly ready: false; readonly code: LocalPiCertificationCode; readonly drift?: readonly string[] };

export interface LocalPiObserved {
  readonly host: { readonly platform: string; readonly arch: string };
  /** The running Node, e.g. `v24.1.0`. */
  readonly nodeVersion: string;
  /** `undefined` when the install directory or its `pins.json` is absent. */
  readonly recorded: unknown | undefined;
  /** Pins recomputed from the bytes on disk now; any shape is judged here. */
  readonly live: unknown;
}

/** Pure comparison; only the rows passed in grant anything. */
export function evaluateLocalPiIdentity(observed: LocalPiObserved, rows: readonly unknown[] = LOCAL_PI_CERTIFIED_ROWS,
  installed: InstalledComponents = installedComponents()): LocalPiVerdict {
  if (!nodeMeetsPiMinimum(observed.nodeVersion)) return { ready: false, code: "pi_node_unsupported" };
  if (observed.recorded === undefined) return { ready: false, code: "pi_not_installed" };
  const recorded = localPiPinsSchema.safeParse(observed.recorded);
  const live = localPiPinsSchema.safeParse(observed.live);
  if (!recorded.success || !live.success || !isDeepStrictEqual(recorded.data, live.data)) return { ready: false, code: "pi_identity_mismatch" };
  const major = nodeMajorOf(observed.nodeVersion);
  const valid = rows.map((row) => localPiCertificationSchema.safeParse(row)).flatMap((row) => (row.success ? [row.data] : []));
  const sameBuild = valid.filter((row) => row.host.platform === observed.host.platform && row.host.arch === observed.host.arch && row.nodeMajor === major);
  if (sameBuild.length === 0) return { ready: false, code: "pi_uncertified" };
  const row = sameBuild.find((candidate) => isDeepStrictEqual(candidate.install.pins, live.data));
  if (!row) return { ready: false, code: "pi_identity_mismatch" };
  const drift = componentDrift(row.dependencies, installed);
  if (drift.length > 0) return { ready: false, code: "pi_dependencies_drifted", drift };
  return { ready: true, version: row.install.pins.piVersion };
}
