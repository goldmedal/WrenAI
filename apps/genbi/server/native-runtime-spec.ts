import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readSync, realpathSync, statSync, type BigIntStats } from "node:fs";
import path from "node:path";
import { userInfo } from "node:os";
import type { EnrichmentBinding } from "./enrichment.js";
import { InteractiveLaunchError } from "./native-session-workspace.js";
import type { RuntimeBackendId } from "./runtime-host/types.js";
import type { NativeVendor } from "./native-dispatch-registry.js";

export type NativeExecutableName = "node" | "producer" | "vendor" | "wren" | "python";
export type NativeSha256 = `sha256:${string}`;

/** Server-attested executable identity. Paths and digests never cross the API boundary. */
export interface NativeExecutableIdentity {
  readonly name: NativeExecutableName;
  readonly executable: string;
  readonly identity: NativeSha256;
  readonly digest: NativeSha256;
}

/**
 * The complete environment admitted at a native-session child boundary.
 * An index signature is intentionally absent: callers cannot append an
 * operator or browser-provided variable without first widening this contract.
 */
export interface NativeChildEnvironment {
  readonly PATH: string;
  readonly HOME: string;
  readonly USER?: string;
  readonly LOGNAME?: string;
  readonly TERM: "xterm-256color";
  readonly COLORTERM: "truecolor";
  readonly WREN_PROJECT_HOME?: string;
  readonly WREN_HOME?: string;
  readonly CODEX_HOME?: string;
  readonly WARBLE_MCP_CONNECTION_CREDENTIAL?: string;
  readonly WARBLE_SETUP_BOOTSTRAP_ROOT?: string;
  readonly PYTHONNOUSERSITE?: "1";
  readonly PYTHONUTF8?: "1";
}

/** Adapt the exact allowlist to Node's index-signature API at the spawn seam. */
export function nativeProcessEnvironment(environment: NativeChildEnvironment): NodeJS.ProcessEnv {
  return { ...environment };
}

export interface NativeRuntimeSpec {
  readonly version: "1";
  readonly backend: RuntimeBackendId;
  readonly vendor: NativeVendor;
  readonly executables: Readonly<Partial<Record<NativeExecutableName, NativeExecutableIdentity>>>;
  readonly toolDirectories: readonly string[];
  readonly workspace: string;
  readonly project?: {
    readonly identity: string;
    readonly path: string;
    readonly generation: number;
    readonly revision: string;
  };
  readonly sessionWrenHome?: string;
  readonly mcp?: {
    readonly credentialEnvironmentVariable: "WARBLE_MCP_CONNECTION_CREDENTIAL";
    readonly credential: string;
  };
  readonly terminal: {
    readonly TERM: "xterm-256color";
    readonly COLORTERM: "truecolor";
  };
  readonly childEnvironment: NativeChildEnvironment;
}

function unavailable(): never {
  throw new InteractiveLaunchError("native child environment is invalid");
}

function canonicalDirectory(directory: string): string {
  if (!path.isAbsolute(directory)) return unavailable();
  try {
    // Parent aliases such as macOS /var -> /private/var are acceptable, but
    // the admitted directory itself must not be replaceable through a final
    // symlink component.
    if (lstatSync(path.resolve(directory)).isSymbolicLink()) return unavailable();
    const canonical = realpathSync(directory);
    if (!statSync(canonical).isDirectory()) return unavailable();
    return canonical;
  } catch {
    return unavailable();
  }
}

function canonicalExecutable(executable: string): string {
  if (!path.isAbsolute(executable)) return unavailable();
  try {
    const canonical = realpathSync(executable);
    const metadata = statSync(canonical);
    if (!metadata.isFile() || (metadata.mode & 0o111) === 0) return unavailable();
    return canonical;
  } catch {
    return unavailable();
  }
}

function sameExecutableMetadata(before: BigIntStats, after: BigIntStats): boolean {
  return (["dev", "ino", "mode", "size", "mtimeNs", "ctimeNs"] as const).every(key => before[key] === after[key]);
}

function digestExecutable(executable: string): NativeSha256 {
  const pathBefore = lstatSync(executable, { bigint: true });
  if (!pathBefore.isFile() || (pathBefore.mode & 0o111n) === 0n) return unavailable();
  const fd = openSync(executable, constants.O_RDONLY | constants.O_NOFOLLOW);
  let failed = false;
  try {
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile() || !sameExecutableMetadata(pathBefore, before)) return unavailable();
    // Keep readFileSync's existing oversized-file error contract. Ordinary
    // executable checks use a fresh bounded buffer, never a retained digest.
    const hash = createHash("sha256");
    if (before.size > 2_147_483_647n) hash.update(readFileSync(fd));
    else {
      const size = Number(before.size);
      const buffer = Buffer.allocUnsafe(Math.min(size, 1_048_576) || 1);
      let position = 0;
      while (position < size) {
        const count = readSync(fd, buffer, 0, Math.min(buffer.length, size - position), position);
        if (count === 0) return unavailable();
        hash.update(buffer.subarray(0, count)); position += count;
      }
      if (readSync(fd, buffer, 0, 1, position) !== 0) return unavailable();
    }
    const after = fstatSync(fd, { bigint: true });
    const pathAfter = lstatSync(executable, { bigint: true });
    if (!sameExecutableMetadata(before, after) || !pathAfter.isFile()
      || !sameExecutableMetadata(after, pathAfter) || realpathSync(executable) !== executable) return unavailable();
    return `sha256:${hash.digest("hex")}`;
  } catch (error) { failed = true; throw error; }
  finally { try { closeSync(fd); } catch (error) { if (!failed) throw error; } }
}

export function attestNativeExecutable(name: NativeExecutableName, executable: string): NativeExecutableIdentity {
  const canonical = canonicalExecutable(executable);
  const digest = digestExecutable(canonical);
  return Object.freeze({ name, executable: canonical, identity: digest, digest });
}

export function assertNativeExecutableIdentity(identity: NativeExecutableIdentity): void {
  const current = attestNativeExecutable(identity.name, identity.executable);
  if (current.executable !== identity.executable || current.identity !== identity.identity || current.digest !== identity.digest) unavailable();
}

export function resolveNativeExecutable(
  name: NativeExecutableName,
  executable: string,
  pathValue: string | undefined,
): NativeExecutableIdentity | undefined {
  const candidates = path.isAbsolute(executable) || executable.includes(path.sep)
    ? [path.resolve(executable)]
    : (pathValue ?? "").split(path.delimiter).filter(Boolean).map((directory) => path.join(directory, executable));
  for (const candidate of candidates) {
    try {
      return attestNativeExecutable(name, candidate);
    } catch {
      // Discovery happens once at server composition. Launches consume only
      // the returned canonical identity and never repeat an ambient PATH lookup.
    }
  }
  return undefined;
}

export interface NativeChildEnvironmentInput {
  readonly toolDirectories: readonly string[];
  readonly home: string;
  readonly projectPath?: string;
  readonly wrenHome?: string;
  readonly codexHome?: string;
  readonly mcpCredential?: string;
  readonly setupBootstrapRoot?: string;
  readonly python?: boolean;
}

export function buildNativeChildEnvironment(input: NativeChildEnvironmentInput): NativeChildEnvironment {
  const toolDirectories = [...new Set(input.toolDirectories.map(canonicalDirectory))];
  if (toolDirectories.length === 0) return unavailable();
  const environment: NativeChildEnvironment = {
    PATH: toolDirectories.join(path.delimiter),
    HOME: canonicalDirectory(input.home),
    // Claude locates the macOS login keychain account by username. Derive it
    // from the OS, never from mutable shell or browser-provided environment.
    ...(process.platform === "darwin" ? { USER: userInfo().username, LOGNAME: userInfo().username } : {}),
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    ...(input.projectPath ? { WREN_PROJECT_HOME: canonicalDirectory(input.projectPath) } : {}),
    ...(input.wrenHome ? { WREN_HOME: canonicalDirectory(input.wrenHome) } : {}),
    ...(input.codexHome ? { CODEX_HOME: canonicalDirectory(input.codexHome) } : {}),
    ...(input.mcpCredential ? { WARBLE_MCP_CONNECTION_CREDENTIAL: input.mcpCredential } : {}),
    ...(input.setupBootstrapRoot ? { WARBLE_SETUP_BOOTSTRAP_ROOT: canonicalDirectory(input.setupBootstrapRoot) } : {}),
    ...(input.python ? { PYTHONNOUSERSITE: "1", PYTHONUTF8: "1" } : {}),
  };
  return Object.freeze(environment);
}

export interface NativeRuntimeSpecInput {
  readonly backend: RuntimeBackendId;
  readonly vendor: NativeVendor;
  readonly executables: readonly NativeExecutableIdentity[];
  readonly toolDirectories: readonly string[];
  readonly workspace: string;
  readonly home: string;
  readonly binding?: EnrichmentBinding;
  readonly sessionWrenHome?: string;
  readonly codexHome?: string;
  readonly mcpCredential?: string;
  readonly setupBootstrapRoot?: string;
}

/** Build the sealed launch object exclusively from server-owned inputs. */
export function buildNativeRuntimeSpec(input: NativeRuntimeSpecInput): NativeRuntimeSpec {
  if (input.executables.length === 0) return unavailable();
  const executables: Partial<Record<NativeExecutableName, NativeExecutableIdentity>> = {};
  for (const executable of input.executables) {
    assertNativeExecutableIdentity(executable);
    if (executables[executable.name]) return unavailable();
    executables[executable.name] = executable;
  }
  if (!executables.vendor || !executables.producer) return unavailable();
  const toolDirectories = [...new Set(input.toolDirectories.map(canonicalDirectory))];
  const workspace = canonicalDirectory(input.workspace);
  const sessionWrenHome = input.sessionWrenHome ? canonicalDirectory(input.sessionWrenHome) : undefined;
  const childEnvironment = buildNativeChildEnvironment({
    toolDirectories,
    home: input.home,
    ...(input.binding ? { projectPath: input.binding.path } : {}),
    ...(sessionWrenHome ? { wrenHome: sessionWrenHome } : {}),
    ...(input.codexHome ? { codexHome: input.codexHome } : {}),
    ...(input.mcpCredential ? { mcpCredential: input.mcpCredential } : {}),
    ...(input.setupBootstrapRoot ? { setupBootstrapRoot: input.setupBootstrapRoot } : {}),
  });
  const spec: NativeRuntimeSpec = {
    version: "1",
    backend: input.backend,
    vendor: input.vendor,
    executables: Object.freeze(executables),
    toolDirectories: Object.freeze(toolDirectories),
    workspace,
    ...(input.binding ? {
      project: Object.freeze({
        identity: input.binding.identity,
        path: canonicalDirectory(input.binding.path),
        generation: input.binding.generation,
        revision: input.binding.revision,
      }),
    } : {}),
    ...(sessionWrenHome ? { sessionWrenHome } : {}),
    ...(input.mcpCredential ? {
      mcp: Object.freeze({
        credentialEnvironmentVariable: "WARBLE_MCP_CONNECTION_CREDENTIAL" as const,
        credential: input.mcpCredential,
      }),
    } : {}),
    terminal: Object.freeze({ TERM: "xterm-256color" as const, COLORTERM: "truecolor" as const }),
    childEnvironment,
  };
  return Object.freeze(spec);
}

/** Revalidate identities and the derived environment immediately before spawn. */
export function assertNativeRuntimeSpec(spec: NativeRuntimeSpec): void {
  for (const identity of Object.values(spec.executables)) {
    if (identity) assertNativeExecutableIdentity(identity);
  }
  const rebuilt = buildNativeRuntimeSpec({
    backend: spec.backend,
    vendor: spec.vendor,
    executables: Object.values(spec.executables).filter((value): value is NativeExecutableIdentity => value !== undefined),
    toolDirectories: spec.toolDirectories,
    workspace: spec.workspace,
    home: spec.childEnvironment.HOME,
    ...(spec.project ? { binding: { ...spec.project } } : {}),
    ...(spec.sessionWrenHome ? { sessionWrenHome: spec.sessionWrenHome } : {}),
    ...(spec.childEnvironment.CODEX_HOME ? { codexHome: spec.childEnvironment.CODEX_HOME } : {}),
    ...(spec.mcp ? { mcpCredential: spec.mcp.credential } : {}),
    ...(spec.childEnvironment.WARBLE_SETUP_BOOTSTRAP_ROOT ? { setupBootstrapRoot: spec.childEnvironment.WARBLE_SETUP_BOOTSTRAP_ROOT } : {}),
  });
  if (JSON.stringify(rebuilt) !== JSON.stringify(spec)) return unavailable();
  if (lstatSync(spec.workspace).isSymbolicLink()) return unavailable();
}
