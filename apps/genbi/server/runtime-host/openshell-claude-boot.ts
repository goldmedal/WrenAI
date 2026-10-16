import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { hostIdentitySchema } from "./claude-host-verification.js";
import { connectOpenShellSdk } from "./openshell-sdk-assets.js";
import type { OpenShellDuplex, OpenShellIntent } from "./openshell-types.js";
import { assertActualVault, type ClaudeAccountVault } from "./claude-account-vault.js";
import { isBackendOffered, type RuntimeSelection } from "../runtime-selection.js";

const absolute = z.string().max(4096).refine(value => path.isAbsolute(value) && !value.includes("\0"));
const model = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/)
  .refine(value => !["sonnet", "opus", "haiku", "inherit"].includes(value));
const descriptorSchema = z.object({ version: z.literal(1), verifyRetainedAccount: z.literal(true),
  vaultRoot: absolute, gatewayUrl: z.string().max(2048).refine(value => {
    try { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash && url.pathname === "/"; } catch { return false; }
  }),
  caCert: absolute, clientCert: absolute, clientKey: absolute, expected: hostIdentitySchema,
  models: z.object({ sonnet: model.optional(), opus: model.optional(), haiku: model.optional() }).strict(),
}).strict();
export type OpenShellClaudeBootDescriptor = z.infer<typeof descriptorSchema>;
function freeze<T>(value: T): T {
  if (value && typeof value === "object") { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}

function secureDirectory(directory: string): void {
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o700
    || realpathSync(directory) !== directory) throw new Error("Protected OpenShell configuration unavailable");
}
function secureFile(file: string): void {
  secureDirectory(path.dirname(file));
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== process.getuid?.()
    || (stat.mode & 0o777) !== 0o600 || realpathSync(file) !== file) throw new Error("Protected OpenShell configuration unavailable");
}
export function secureRead(file: string, maximum = 32_768): Buffer {
  secureFile(file);
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > maximum || stat.nlink !== 1 || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600) throw new Error();
    const bytes = readFileSync(fd); const current = lstatSync(file);
    if (bytes.length > maximum || stat.ino !== current.ino || stat.dev !== current.dev || stat.size !== current.size) throw new Error();
    secureFile(file); return bytes;
  } finally { closeSync(fd); }
}
export const hash = (bytes: Buffer) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

/** Host-only opt-in. Invalid input never selects credentials, endpoints or a verifier. */
export function readOpenShellClaudeBoot(env: NodeJS.ProcessEnv, selection: RuntimeSelection) {
  if (selection.runtime !== "openshell" || !isBackendOffered(selection, "claude")) return undefined;
  try {
    const file = absolute.parse(env.GENBI_OPENSHELL_CLAUDE_BOOT);
    const bytes = secureRead(file);
    const descriptor = freeze(descriptorSchema.parse(JSON.parse(bytes.toString("utf8"))));
    secureDirectory(descriptor.vaultRoot);
    // Only existing retained accounts can be verified; no enrollment in this boot flow.
    secureFile(path.join(descriptor.vaultRoot, "account.json"));
    const pki = { caCert: secureRead(descriptor.caCert), clientCert: secureRead(descriptor.clientCert), clientKey: secureRead(descriptor.clientKey) };
    const identity = hash(bytes);
    const digests = { caCert: hash(pki.caCert), clientCert: hash(pki.clientCert), clientKey: hash(pki.clientKey) };
    const assertCurrent = () => {
      if (hash(secureRead(file)) !== identity) throw new Error("Protected OpenShell configuration changed");
      secureDirectory(descriptor.vaultRoot);
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
    return { descriptor, identity, assertCurrent, duplex };
  } catch { return undefined; }
}

/** Resolve only explicit host model pins; an alias never weakens worker model identity. */
export function resolveOpenShellClaudeModel(value: string, driverModel: string, descriptor: OpenShellClaudeBootDescriptor): string {
  let selected = value.trim();
  if (selected === "inherit") selected = driverModel.trim();
  if (selected === "inherit" || !selected) throw new Error("OpenShell model binding unavailable");
  if (selected === "sonnet" || selected === "opus" || selected === "haiku") {
    const pinned = descriptor.models[selected];
    if (!pinned) throw new Error("OpenShell model binding unavailable");
    return model.parse(pinned);
  }
  return model.parse(selected);
}

/** Same-process protected verification. A retained bundle, never a config credential, is required. */
export async function verifyRetainedOpenShellClaudeBoot(vault: ClaudeAccountVault, boot: NonNullable<ReturnType<typeof readOpenShellClaudeBoot>>): Promise<void> {
  assertActualVault(vault); boot.assertCurrent();
  if (!vault.retainedCredential()) throw new Error("OpenShell retained account unavailable");
  await vault.verify(boot.descriptor.expected); boot.assertCurrent();
  if (vault.status().state !== "verified") throw new Error("OpenShell retained account unavailable");
}
