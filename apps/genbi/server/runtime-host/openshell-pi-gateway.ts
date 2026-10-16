import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { z } from "zod";
import { runOpenShellCommand, type OpenShellConfiguration } from "./openshell-driver.js";
import { piEndpointAddress, type OpenShellPiBootDescriptor } from "./openshell-pi-boot.js";
import { OpenShellError } from "./openshell-types.js";

/** The one binary the sandbox may use to reach the model endpoint. */
export const PI_PROFILE_BINARIES = Object.freeze(["/usr/local/bin/node"]);
/** Fields the gateway adds or changes without the profile's behaviour changing. */
const VOLATILE_PROFILE_FIELDS = new Set(["resource_version", "source", "scope"]);
const COMMAND_DEADLINE_MS = 10_000;
/** The whole proof, every page and both calls together, is bounded; exported so the deadline test names it rather than a copy. */
export const PI_GATEWAY_TOTAL_DEADLINE_MS = 25_000;
const MAX_PROVIDER_PAGES = 20;

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)).map(([key, child]) => [key, sorted(child)]));
  return value;
}
/** Canonical text of an exported profile: sorted keys, the gateway-assigned fields removed. */
export function canonicalGatewayProfile(profile: unknown): string {
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) throw new OpenShellError("openshell_protocol_invalid");
  return JSON.stringify(sorted(Object.fromEntries(Object.entries(profile).filter(([key]) => !VOLATILE_PROFILE_FIELDS.has(key)))));
}
/** The value an operator records as `profileDigest` right after importing the profile. */
export function canonicalGatewayProfileDigest(profile: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalGatewayProfile(profile)).digest("hex")}`;
}

const providerPage = z.object({ next_page_token: z.string().optional(), providers: z.array(z.object({
  name: z.string(), type: z.string(), credential_keys: z.array(z.string()).optional(), workspace: z.string().optional(),
}).passthrough()) }).passthrough();
const exportedProfile = z.object({
  id: z.string(),
  credentials: z.array(z.object({ env_vars: z.array(z.string()).optional() }).passthrough()),
  endpoints: z.array(z.object({ host: z.string(), port: z.number(), protocol: z.string().optional(), access: z.string().optional(), enforcement: z.string().optional() }).passthrough()),
  binaries: z.array(z.string()),
}).passthrough();

type Runner = typeof runOpenShellCommand;
export type PiGatewayVerifier = (signal?: AbortSignal) => Promise<void>;
type Configuration = Pick<OpenShellConfiguration, "executable" | "executableDigest" | "gateway" | "workspace" | "home" | "configHome" | "stateHome">;

/**
 * Read-only proof that the gateway objects an operator provisioned are the ones the descriptor names:
 * the provider exists with the profile as its type and the declared credential key, and the exported
 * profile has the declared digest, exactly one endpoint, exactly the node binary and the declared credential env.
 * Every failure, timeout and surprise is a closed error; nothing here writes to the gateway.
 */
export function createPiGatewayVerifier(options: { readonly configuration: Configuration; readonly descriptor: OpenShellPiBootDescriptor; readonly run?: Runner }): PiGatewayVerifier {
  const { configuration, descriptor } = options;
  const run = options.run ?? runOpenShellCommand;
  const environment = Object.freeze({ PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: configuration.home, XDG_CONFIG_HOME: configuration.configHome, XDG_STATE_HOME: configuration.stateHome, LANG: "en_US.UTF-8" });
  const address = piEndpointAddress(descriptor.endpoint);
  const attest = () => {
    try {
      if (realpathSync(configuration.executable) !== configuration.executable
        || `sha256:${createHash("sha256").update(readFileSync(configuration.executable)).digest("hex")}` !== configuration.executableDigest) throw new Error();
    } catch { throw new OpenShellError("openshell_identity_mismatch"); }
  };
  const command = async (argv: readonly string[], signal: AbortSignal): Promise<unknown> => {
    attest(); signal.throwIfAborted();
    let raw: string;
    try { raw = await run(configuration.executable, ["--gateway", configuration.gateway, "--workspace", configuration.workspace, ...argv], environment, signal, COMMAND_DEADLINE_MS); }
    catch (error) { throw error instanceof OpenShellError && error.code === "openshell_cancelled" ? error : new OpenShellError("openshell_gateway_unavailable"); }
    try { return JSON.parse(raw); } catch { throw new OpenShellError("openshell_protocol_invalid"); }
  };
  const mismatch = (): never => { throw new OpenShellError("openshell_identity_mismatch"); };
  const sameList = (left: readonly string[], right: readonly string[]) => left.length === right.length && left.every((value, index) => value === right[index]);
  return async (outer) => {
    // A plain timer rather than `AbortSignal.timeout`, so the deadline is the same clock a test controls.
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), PI_GATEWAY_TOTAL_DEADLINE_MS);
    const signal = AbortSignal.any([deadline.signal, ...(outer ? [outer] : [])]);
    try { await proof(signal); }
    catch (error) { if (deadline.signal.aborted && !outer?.aborted) throw new OpenShellError("openshell_gateway_unavailable"); throw error; }
    finally { clearTimeout(timer); }
  };
  async function proof(signal: AbortSignal): Promise<void> {
    const matches: z.infer<typeof providerPage>["providers"] = [];
    let token = "";
    for (let page = 0; page < MAX_PROVIDER_PAGES; page++) {
      const parsed = providerPage.safeParse(await command(["provider", "list", "--output", "json", "--page-size", "100", ...(token ? ["--page-token", token] : [])], signal));
      if (!parsed.success) throw new OpenShellError("openshell_protocol_invalid");
      matches.push(...parsed.data.providers.filter(entry => entry.name === descriptor.provider));
      token = parsed.data.next_page_token ?? "";
      if (!token) break;
      if (page === MAX_PROVIDER_PAGES - 1) throw new OpenShellError("openshell_protocol_invalid");
    }
    const provider = matches.length === 1 ? matches[0]! : mismatch();
    if (provider.type !== descriptor.profileId || (provider.workspace !== undefined && provider.workspace !== configuration.workspace)
      || !sameList(provider.credential_keys ?? [], [descriptor.endpoint.credentialEnv])) mismatch();
    const raw = await command(["provider", "profile", "export", descriptor.profileId, "--output", "json"], signal);
    const profile = exportedProfile.safeParse(raw);
    if (!profile.success) throw new OpenShellError("openshell_protocol_invalid");
    const { id, credentials, endpoints, binaries } = profile.data;
    const endpoint = endpoints.length === 1 ? endpoints[0]! : mismatch();
    if (id !== descriptor.profileId || endpoint.host.toLowerCase() !== address.host.toLowerCase() || endpoint.port !== address.port
      || endpoint.protocol !== "rest" || endpoint.access !== "read-write" || endpoint.enforcement !== "enforce"
      || !sameList(binaries, PI_PROFILE_BINARIES)
      || credentials.length !== 1 || !sameList(credentials[0]!.env_vars ?? [], [descriptor.endpoint.credentialEnv])
      || canonicalGatewayProfileDigest(raw) !== descriptor.profileDigest) mismatch();
  }
}
