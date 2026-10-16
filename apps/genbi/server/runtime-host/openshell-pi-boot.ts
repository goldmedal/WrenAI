import path from "node:path";
import { z } from "zod";
import { hash, secureRead } from "./openshell-claude-boot.js";
import { connectOpenShellSdk } from "./openshell-sdk-assets.js";
import type { OpenShellDuplex, OpenShellIntent } from "./openshell-types.js";
import { piAccountDigest, type PiProviderConfig } from "./openshell-pi-provider.js";
import { piEndpointSchema } from "./pi-protocol.js";
import { isBackendOffered, type RuntimeSelection } from "../runtime-selection.js";

/** The one model backend an OpenShell boot serves, chosen by the runtime selection and never by this module. */
export type OpenShellModelVendor = "claude" | "pi";

const absolute = z.string().max(4096).refine(value => path.isAbsolute(value) && !value.includes("\0"));
const token = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/);
const tier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);
/** An exact model id. A Claude alias or `inherit` can never name a pi model. */
const model = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/).refine(value => !["sonnet", "opus", "haiku", "inherit"].includes(value));
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const descriptorSchema = z.object({ version: z.literal(1),
  gatewayUrl: z.string().max(2048).refine(value => {
    try { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash && url.pathname === "/"; } catch { return false; }
  }),
  caCert: absolute, clientCert: absolute, clientKey: absolute,
  /** The only Ask auth mode this boot serves. */
  auth: z.enum(["api-key", "gateway"]),
  /** OpenShell provider name, as attached to the sandbox. */
  provider: token,
  /** OpenShell provider profile id; the provider's type. */
  profileId: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/),
  displayLabel: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/),
  /** Canonical digest of the gateway's exported profile; see `canonicalGatewayProfileDigest`. */
  profileDigest: digest,
  generation: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/),
  endpoint: piEndpointSchema,
  thinking: z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]).optional(),
  models: z.record(tier, model).refine(value => Object.keys(value).length > 0 && Object.keys(value).length <= 16),
}).strict();
export type OpenShellPiBootDescriptor = z.infer<typeof descriptorSchema>;
function freeze<T>(value: T): T {
  if (value && typeof value === "object") { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}

/** Host and port the descriptor's endpoint declares; the gateway profile must contain exactly this one endpoint. */
export function piEndpointAddress(endpoint: OpenShellPiBootDescriptor["endpoint"]): { readonly host: string; readonly port: number } {
  const url = new URL(endpoint.baseUrl);
  return { host: url.hostname, port: url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80 };
}
export function piProviderConfig(descriptor: OpenShellPiBootDescriptor): PiProviderConfig {
  return { provider: descriptor.provider, displayLabel: descriptor.displayLabel, profileDigest: descriptor.profileDigest, generation: descriptor.generation,
    endpoint: descriptor.endpoint, ...(descriptor.thinking ? { thinking: descriptor.thinking } : {}) };
}

export interface OpenShellPiBoot {
  readonly descriptor: OpenShellPiBootDescriptor;
  readonly identity: string;
  readonly account: string;
  assertCurrent(): void;
  duplex(intent: OpenShellIntent, argv: readonly string[], signal: AbortSignal): Promise<OpenShellDuplex>;
}

/** Host-only descriptor read. It names a provider and a profile, never a key; invalid input selects nothing. */
export function readOpenShellPiBoot(env: NodeJS.ProcessEnv, selection: RuntimeSelection): OpenShellPiBoot | undefined {
  if (selection.runtime !== "openshell" || !isBackendOffered(selection, "pi")) return undefined;
  try {
    const file = absolute.parse(env.GENBI_OPENSHELL_PI_BOOT);
    const bytes = secureRead(file);
    const descriptor = freeze(descriptorSchema.parse(JSON.parse(bytes.toString("utf8"))));
    const pki = { caCert: secureRead(descriptor.caCert), clientCert: secureRead(descriptor.clientCert), clientKey: secureRead(descriptor.clientKey) };
    const identity = hash(bytes);
    const digests = { caCert: hash(pki.caCert), clientCert: hash(pki.clientCert), clientKey: hash(pki.clientKey) };
    const assertCurrent = () => {
      if (hash(secureRead(file)) !== identity) throw new Error("Protected OpenShell configuration changed");
      for (const key of ["caCert", "clientCert", "clientKey"] as const) if (hash(secureRead(descriptor[key])) !== digests[key]) throw new Error("Protected OpenShell configuration changed");
    };
    let client: ReturnType<typeof connectOpenShellSdk> | undefined;
    const duplex = async (intent: OpenShellIntent, argv: readonly string[], signal: AbortSignal): Promise<OpenShellDuplex> => {
      assertCurrent(); signal.throwIfAborted();
      client ??= connectOpenShellSdk({ gateway: descriptor.gatewayUrl, ...pki });
      const sdk = await client;
      assertCurrent(); signal.throwIfAborted();
      const stream = await sdk.sandbox.execInteractive(intent.name, [...argv], { workspace: intent.identity.workspace, workdir: "/sandbox",
        tty: false, noLoginShell: true, timeoutSecs: 120, signal, environment: { HOME: "/sandbox", PATH: "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8" } });
      try { assertCurrent(); signal.throwIfAborted(); return stream; } catch (error) { stream.close(); throw error; }
    };
    return { descriptor, identity, account: piAccountDigest(piProviderConfig(descriptor)), assertCurrent, duplex };
  } catch { return undefined; }
}
