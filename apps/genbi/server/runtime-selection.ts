/**
 * The single place boot decides where agents run and which agent backends a boot offers.
 *
 * Two independent settings: `GENBI_RUNTIME` (where) and `GENBI_BACKEND` (which). A runtime never
 * offers a backend it does not support and never falls back to another runtime. This module reads
 * every selection variable once, validates it and returns a frozen selection; nothing else reads
 * the selection variables or the removed per-vendor variables.
 */

export const RUNTIMES = ["local", "openshell"] as const;
export type RuntimeKind = (typeof RUNTIMES)[number];

export const BACKENDS = ["claude", "codex", "pi"] as const;
export type BackendName = (typeof BACKENDS)[number];

export const CODEX_MODES = ["exec", "app-server"] as const;
export type CodexMode = (typeof CODEX_MODES)[number];

/** `planned` is a declared future capability: recognised, never offered yet. */
export type BackendSupport = "supported" | "planned" | "unsupported";

export interface RuntimeSupport {
  readonly backends: Readonly<Record<BackendName, BackendSupport>>;
  /** In-process api-key and gateway execution. Not an agent backend, so the list never gates it. */
  readonly inProcessAuth: boolean;
  readonly localModeAuth: boolean;
}

/** The support matrix. Every offer decision reads this table; there are no scattered conditionals. */
export const RUNTIME_SUPPORT: Readonly<Record<RuntimeKind, RuntimeSupport>> = Object.freeze({
  local: Object.freeze({ backends: Object.freeze({ claude: "supported", codex: "supported", pi: "unsupported" } as const), inProcessAuth: true, localModeAuth: true }),
  openshell: Object.freeze({ backends: Object.freeze({ claude: "supported", codex: "unsupported", pi: "planned" } as const), inProcessAuth: false, localModeAuth: false }),
});

const DEFAULT_LOCAL_BACKENDS: readonly BackendName[] = Object.freeze(["claude", "codex"] as const);

/** Fixed, browser-safe reasons. */
export const NOT_LISTED_REASON = "Not enabled for this boot.";
export const UNSUPPORTED_REASON = "Not supported on this runtime.";
export const PLANNED_REASON = "Not yet available on this runtime.";

export interface BackendOffer {
  readonly offered: boolean;
  /** Present exactly when `offered` is false. */
  readonly reason?: string;
}

export interface RuntimeSelection {
  readonly runtime: RuntimeKind;
  /** Exactly what `GENBI_BACKEND` named (or the local default). */
  readonly listed: readonly BackendName[];
  readonly codexMode: CodexMode;
  readonly offers: Readonly<Record<BackendName, BackendOffer>>;
  /** Boot warnings; one entry per listed-but-not-offered backend. */
  readonly warnings: readonly string[];
}

export class RuntimeSelectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeSelectionError";
  }
}

const REMOVED_VARIABLES: Readonly<Record<string, string>> = Object.freeze({
  GENBI_CLAUDE_RUNTIME: "set GENBI_RUNTIME=openshell with GENBI_BACKEND=claude to run Claude on OpenShell; local is the default",
  GENBI_CODEX_RUNTIME: "set GENBI_BACKEND to include codex, and GENBI_CODEX_MODE=app-server for the app-server route (exec is the default)",
  GENBI_ALLOW_LOCAL_RUNTIME: "name the backends a boot offers in GENBI_BACKEND, or set GENBI_RUNTIME=openshell to avoid host execution",
});

const offerFor = (runtime: RuntimeKind, listed: readonly BackendName[], backend: BackendName): BackendOffer => {
  if (!listed.includes(backend)) return Object.freeze({ offered: false, reason: NOT_LISTED_REASON });
  const support = RUNTIME_SUPPORT[runtime].backends[backend];
  if (support === "supported") return Object.freeze({ offered: true });
  return Object.freeze({ offered: false, reason: support === "planned" ? PLANNED_REASON : UNSUPPORTED_REASON });
};

function parseBackendList(raw: string): BackendName[] {
  const entries = raw.split(",").map((entry) => entry.trim());
  const seen = new Set<string>();
  for (const entry of entries) {
    if (entry === "") throw new RuntimeSelectionError("GENBI_BACKEND contains an empty entry; name backends from claude, codex, pi separated by commas.");
    if (!(BACKENDS as readonly string[]).includes(entry)) throw new RuntimeSelectionError(`GENBI_BACKEND entry "${entry}" is not a known backend; use claude, codex or pi.`);
    if (seen.has(entry)) throw new RuntimeSelectionError(`GENBI_BACKEND lists "${entry}" more than once.`);
    seen.add(entry);
  }
  return entries as BackendName[];
}

/** Read and validate every selection variable. Throws `RuntimeSelectionError` naming the cause. */
export function resolveRuntimeSelection(env: NodeJS.ProcessEnv): RuntimeSelection {
  for (const [name, replacement] of Object.entries(REMOVED_VARIABLES)) {
    if (env[name] !== undefined) throw new RuntimeSelectionError(`${name} is no longer supported and boot refuses while it is set; ${replacement}.`);
  }
  const runtimeValue = env.GENBI_RUNTIME ?? "local";
  if (!(RUNTIMES as readonly string[]).includes(runtimeValue)) throw new RuntimeSelectionError('GENBI_RUNTIME must be "local" or "openshell".');
  const runtime = runtimeValue as RuntimeKind;

  let listed: readonly BackendName[];
  if (env.GENBI_BACKEND !== undefined) listed = parseBackendList(env.GENBI_BACKEND);
  else if (runtime === "local") listed = DEFAULT_LOCAL_BACKENDS;
  else throw new RuntimeSelectionError("GENBI_BACKEND is required when GENBI_RUNTIME=openshell; name the single model backend (claude or pi).");
  if (runtime === "openshell" && listed.includes("claude") && listed.includes("pi")) {
    throw new RuntimeSelectionError("GENBI_BACKEND may name only one model backend (claude or pi) when GENBI_RUNTIME=openshell.");
  }

  let codexMode: CodexMode = "exec";
  if (env.GENBI_CODEX_MODE !== undefined) {
    if (!(CODEX_MODES as readonly string[]).includes(env.GENBI_CODEX_MODE)) throw new RuntimeSelectionError('GENBI_CODEX_MODE must be "exec" or "app-server".');
    if (runtime !== "local" || !listed.includes("codex")) throw new RuntimeSelectionError("GENBI_CODEX_MODE applies only when GENBI_RUNTIME=local and GENBI_BACKEND includes codex.");
    codexMode = env.GENBI_CODEX_MODE as CodexMode;
  }

  if (runtime !== "openshell") {
    const stray = Object.keys(env).find((name) => name.startsWith("GENBI_OPENSHELL_") && env[name] !== undefined);
    if (stray) throw new RuntimeSelectionError(`${stray} applies only when GENBI_RUNTIME=openshell.`);
  }

  const offers = Object.freeze(Object.fromEntries(BACKENDS.map((backend) => [backend, offerFor(runtime, listed, backend)])) as Record<BackendName, BackendOffer>);
  const warnings = listed.filter((backend) => !offers[backend].offered)
    .map((backend) => `GENBI_BACKEND lists "${backend}", which is not offered on the ${runtime} runtime: ${offers[backend].reason}`);
  return Object.freeze({ runtime, listed: Object.freeze([...listed]), codexMode, offers, warnings: Object.freeze(warnings) });
}

export const isBackendOffered = (selection: RuntimeSelection, backend: BackendName): boolean => selection.offers[backend].offered;

/**
 * In-process api-key and gateway execution is not an agent backend, so the list does not gate it.
 * This is the single seam where a later pi-on-OpenShell route would make it available.
 */
export function inProcessAuthOffer(selection: RuntimeSelection): BackendOffer {
  return RUNTIME_SUPPORT[selection.runtime].inProcessAuth ? Object.freeze({ offered: true }) : Object.freeze({ offered: false, reason: UNSUPPORTED_REASON });
}

export function localModeAuthOffer(selection: RuntimeSelection): BackendOffer {
  return RUNTIME_SUPPORT[selection.runtime].localModeAuth ? Object.freeze({ offered: true }) : Object.freeze({ offered: false, reason: UNSUPPORTED_REASON });
}

/** The offer that governs one auth choice: a subscription follows its vendor, the rest follow the runtime row. */
export function authOffer(selection: RuntimeSelection, auth: { readonly mode: string; readonly provider?: string }): BackendOffer {
  if (auth.mode === "subscription") return selection.offers[auth.provider === "codex" ? "codex" : "claude"];
  return auth.mode === "local" ? localModeAuthOffer(selection) : inProcessAuthOffer(selection);
}

/**
 * A subscription vendor runs on the host only when the runtime is local and the vendor is offered.
 * Codex in app-server mode runs through its own certified backend, never on the host terminal.
 */
export const localSubscriptionVendorHosted = (selection: RuntimeSelection, vendor: "claude" | "codex"): boolean =>
  selection.runtime === "local" && isBackendOffered(selection, vendor) && (vendor === "claude" || selection.codexMode === "exec");

export const localSubscriptionVendorOffered = (selection: RuntimeSelection): boolean =>
  localSubscriptionVendorHosted(selection, "claude") || localSubscriptionVendorHosted(selection, "codex");

/** The native terminal host's local availability: per vendor when one is under probe, else any hosted vendor. */
export const localTerminalAvailable = (selection: RuntimeSelection, hostAvailable: () => boolean | Promise<boolean>) =>
  (vendor?: "claude" | "codex"): boolean | Promise<boolean> =>
    (vendor ? localSubscriptionVendorHosted(selection, vendor) : localSubscriptionVendorOffered(selection)) ? hostAvailable() : false;
