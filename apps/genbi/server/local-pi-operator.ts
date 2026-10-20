import { isDeepStrictEqual } from "node:util";
import { installedComponents } from "./runtime-host/openshell-vendor-certification.js";
import { LOCAL_PI_CERTIFIED_ROWS, localPiCertificationSchema, nodeMajorOf } from "./runtime-host/local-pi-certification.js";
import { installLocalPi, packagedPiAssets, resolveGenbiStateDir, verifyLocalPi, computeLocalPiPins, localPiInstallDir, type LocalPiInstallReport, type NpmRunner } from "./runtime-host/local-pi-install.js";

/**
 * Operator provisioning of the managed pi for the local runtime. A host CLI (`genbi-local-pi`), never part of the server: it installs, verifies
 * and describes. Its output carries names and digests only: no absolute path, no key. It reads certification rows only from the package.
 */
export interface LocalPiOperatorOptions {
  readonly env?: NodeJS.ProcessEnv;
  /** Overrides `GENBI_STATE_DIR`. */
  readonly stateDir?: string;
  readonly replace?: boolean;
  readonly run?: NpmRunner;
}
const stateDirFor = (options: LocalPiOperatorOptions) => options.stateDir ?? resolveGenbiStateDir(options.env ?? process.env);

export function installManagedPi(options: LocalPiOperatorOptions = {}): Promise<LocalPiInstallReport> {
  return installLocalPi({ stateDir: stateDirFor(options), ...(options.replace ? { replace: true } : {}), ...(options.run ? { run: options.run } : {}) });
}

export interface LocalPiVerifyReport { readonly ok: boolean; readonly checks: readonly { readonly name: string; readonly ok: boolean; readonly code?: string }[] }
/** The identity check a boot runs before pi can be ready, with the same function and the same codes. */
export function verifyManagedPi(options: LocalPiOperatorOptions = {}): LocalPiVerifyReport {
  const { verdict } = verifyLocalPi({ stateDir: stateDirFor(options) });
  return verdict.ready
    ? { ok: true, checks: [{ name: "managed install", ok: true }, { name: "certified identity", ok: true }] }
    : { ok: false, checks: [{ name: verdict.code === "pi_not_installed" ? "managed install" : "certified identity", ok: false, code: verdict.code }] };
}

export const APPROVAL_PLACEHOLDER = "<sha256 of the approval record the project owner approved>";
/**
 * The packaged rows, the installed identity and (when installed) the candidate row. The candidate is for a maintainer to review and, once the project
 * owner approves it, paste into `LOCAL_PI_CERTIFIED_ROWS`; nothing at runtime reads a row from anywhere else.
 */
export function describeManagedPi(options: LocalPiOperatorOptions = {}): Record<string, unknown> {
  const stateDir = stateDirFor(options);
  let pins: ReturnType<typeof computeLocalPiPins> | undefined;
  try { const assets = packagedPiAssets(); pins = computeLocalPiPins(localPiInstallDir(stateDir, assets), assets); } catch { pins = undefined; }
  const nodeMajor = nodeMajorOf(process.version);
  const assets = packagedPiAssets();
  const packagedRows = LOCAL_PI_CERTIFIED_ROWS.flatMap((value) => {
    const parsed = localPiCertificationSchema.safeParse(value);
    return parsed.success ? [{ host: parsed.data.host, nodeMajor: parsed.data.nodeMajor, piVersion: parsed.data.install.pins.piVersion, dependencies: parsed.data.dependencies,
      /** The row's lockfile, package.json and relay digests are the ones this package ships. */
      packagedAssetsMatch: parsed.data.install.pins.piVersion === assets.piVersion && parsed.data.install.pins.lockfile === assets.lockfileSha256
        && parsed.data.install.pins.packageJson === assets.packageJsonSha256 && parsed.data.install.pins.shim === assets.shimSha256,
      matchesInstalled: pins !== undefined && isDeepStrictEqual(parsed.data.install.pins, pins) && parsed.data.host.platform === process.platform && parsed.data.host.arch === process.arch && parsed.data.nodeMajor === nodeMajor }] : [];
  });
  const components = installedComponents();
  return {
    packagedRows,
    installed: pins ? { present: true, pins } : { present: false },
    ...(pins ? { candidate: { state: "certified_row", vendor: "pi-local", host: { platform: process.platform, arch: process.arch }, nodeMajor, install: { pins },
      dependencies: { warble: components["@warble/cli"], ir: components["@warble/ir-spec"], "context-loader": components["@wrenai/context-loader"] }, evidence: { approvalSha256: APPROVAL_PLACEHOLDER } } } : {}),
  };
}
