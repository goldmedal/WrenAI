/**
 * Server-owned registry of the Warble profiles a conversation can start inside.
 *
 * Two axes stay separate. The *system* purposes (`setup`, `context_enrichment`) keep their fixed
 * profiles and their host orchestration — see `native-dispatch-registry.ts`. The *conversation*
 * profile is the user-selectable axis: an analysis session starts inside one of the profiles this
 * registry has admitted. A browser only ever names a registry id; the directory, the compiled IR
 * and the launch tuple are resolved here.
 *
 * Admission is the host's own check. Warble validates a profile's structure at dispatch but no
 * longer knows which profiles this product trusts, so a profile the operator adds has to satisfy
 * the same floor the shipped analysis profile does before it can be offered:
 *
 *   1. it compiles with the pinned `warble`, and its `profile:` id is unique and not reserved;
 *   2. every mounted component is analytical, one-shot and side-effect free — the scope
 *      `AgentScopeError` (harness/loop/errors.ts) already enforces for the in-process runner;
 *   3. every `required_capabilities` entry is one the shipped analysis profile already requires
 *      (the host ceiling is *derived* from that profile's compiled IR, never hand-listed);
 *   4. every step tier is one the persisted runtime configuration can bind (`cheap`, `strong`);
 *   5. the entry form follows from eligibility: two or more native-eligible components, each with
 *      an authored `description`, enter at the profile scope; exactly one is pinned; none refuses;
 *   6. the verdict is recomputed whenever the profile's bytes, the warble binary or this host's
 *      rule set change, and a profile that stops passing becomes unavailable rather than
 *      disappearing.
 *
 * Composition is recorded, not judged. A component whose steps authorize a component-call alias
 * needs a trusted native component host at dispatch; the native CLI targets refuse ANY profile
 * that composes when no host is provided — the shipped analysis profile included, whose dashboard
 * composer is what makes native analysis unavailable until that host is provisioned. Whether the
 * host exists is a runtime fact that native readiness reports per profile; admission only says
 * what the profile is. Each component summary therefore carries its `composes` edges.
 *
 * Tool names (Read, Bash, Write) are a dispatcher materialization and are not in the IR, which is
 * why rule 3 is expressed over capabilities: that is the layer the compiler can vouch for.
 */
import { cp, lstat, mkdir, readdir, readFile, realpath, rm } from "node:fs/promises";
import { existsSync, lstatSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { hashDirectory } from "../harness/compile/fingerprint.js";
import type {
  Store,
  WarbleProfileAdmissionStatus,
  WarbleProfileEntryKind,
  WarbleProfileKind,
  WarbleProfileRole,
  WarbleProfileRow,
} from "./db.js";
import type { WarbleProfileDto } from "./wire-types.js";

export type { WarbleProfileAdmissionStatus, WarbleProfileEntryKind, WarbleProfileKind, WarbleProfileRole, WarbleProfileRow };

/** The shipped profiles and the role each plays. Anything else under `profiles/` is ignored. */
export const BUILTIN_PROFILE_ROLES: Readonly<Record<string, WarbleProfileRole>> = Object.freeze({
  "genbi-setup": "system",
  "genbi-enrich-context": "system",
  "genbi-default": "conversation",
  "genbi-report": "conversation",
  "genbi-monitor": "conversation",
});

/** The profile whose compiled IR defines the host ceiling. */
export const CEILING_PROFILE_ID = "genbi-default";

/** The persisted runtime tier rows come from the analysis profile and name exactly these two tiers. */
export const HOST_TIERS: ReadonlySet<string> = new Set(["cheap", "strong"]);

const PROFILE_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/**
 * Bump when an admission rule is added, tightened or withdrawn. A stored verdict computed under an
 * older rule set is stale even when the profile bytes and the warble binary are unchanged — the
 * rules are the third input to the verdict. 1: rules 1–6. 2: a pinned entry must not compose.
 * 3: that rule withdrawn (the dispatcher refuses every composing profile without a host, so it
 * never separated anything); composition is recorded on the component summary instead.
 */
export const ADMISSION_RULES_VERSION = 3;
const MAX_REASON_LENGTH = 1200;
const COMPILE_RETRY_DELAY_MS = 250;

export class ProfileRegistryError extends Error {
  constructor(readonly status: 400 | 404 | 409 | 503, message: string) {
    super(message);
    this.name = "ProfileRegistryError";
  }
}

export interface HostCeiling {
  readonly capabilities: ReadonlySet<string>;
  readonly tiers: ReadonlySet<string>;
}

export interface AdmissionComponentSummary {
  readonly id: string;
  readonly type: string;
  readonly trigger: string;
  readonly outcome: string;
  readonly realizationKind: string;
  readonly entrypoint: boolean;
  readonly tiers: readonly string[];
  readonly capabilities: readonly string[];
  readonly hasDescription: boolean;
  readonly nativeEligible: boolean;
  /** `alias → component` edges this component's steps authorize; non-empty means it composes. */
  readonly composes: readonly string[];
}

export interface AdmissionVerdict {
  readonly status: WarbleProfileAdmissionStatus;
  /** Every failed rule, in rule order; empty when admitted. */
  readonly reasons: readonly string[];
  readonly entry?: { readonly kind: WarbleProfileEntryKind; readonly verb?: string };
  readonly irVersion?: string;
  readonly components: readonly AdmissionComponentSummary[];
}

// ---------------------------------------------------------------------------
// IR reading — tolerant of shape, strict about meaning
// ---------------------------------------------------------------------------

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringAt(record: Json, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function nestedKind(record: Json, ...keys: readonly string[]): string {
  let cursor: unknown = record;
  for (const key of keys) {
    if (!isRecord(cursor)) return "";
    cursor = cursor[key];
  }
  return typeof cursor === "string" ? cursor : "";
}

function capabilityNames(component: Json): string[] {
  const raw = component["required_capabilities"];
  if (!Array.isArray(raw)) return [];
  const names: string[] = [];
  for (const entry of raw) {
    if (typeof entry === "string") names.push(entry);
    else if (isRecord(entry)) {
      const kind = stringAt(entry, "kind") ?? stringAt(entry, "name");
      if (kind !== undefined) names.push(kind);
    }
  }
  return names;
}

/** `alias → component` edges a component's steps authorize; non-empty means the profile composes. */
function composedAliases(component: Json): string[] {
  const calls = component["llm_calls"];
  if (!Array.isArray(calls)) return [];
  const edges: string[] = [];
  for (const call of calls) {
    if (!isRecord(call) || !Array.isArray(call["component_calls"])) continue;
    for (const edge of call["component_calls"]) {
      if (!isRecord(edge)) continue;
      const alias = stringAt(edge, "alias") ?? "?";
      const target = stringAt(edge, "component") ?? "?";
      edges.push(`${alias} → ${target}`);
    }
  }
  return edges;
}

function stepTiers(component: Json): string[] {
  const calls = component["llm_calls"];
  if (!Array.isArray(calls)) return [];
  const tiers = new Set<string>();
  for (const call of calls) {
    if (isRecord(call)) {
      const tier = stringAt(call, "tier");
      if (tier !== undefined) tiers.add(tier);
    }
  }
  return [...tiers].sort();
}

function summarizeComponent(component: Json): AdmissionComponentSummary {
  const type = stringAt(component, "type") ?? "";
  const trigger = nestedKind(component, "trigger", "kind");
  const outcome = nestedKind(component, "effect", "outcome", "kind");
  const realizationKind = stringAt(component, "realization_kind") ?? "";
  const entrypoint = component["entrypoint"] !== false;
  const description = stringAt(component, "description");
  const hostScoped = type === "analytical" && trigger === "one_shot" && outcome === "none";
  return {
    id: stringAt(component, "id") ?? "<unnamed>",
    type,
    trigger,
    outcome,
    realizationKind,
    entrypoint,
    tiers: stepTiers(component),
    capabilities: capabilityNames(component),
    hasDescription: description !== undefined && description.trim().length > 0,
    // Mirrors what the dispatcher accepts as a native entry: a one-shot skill with no outcome that
    // a session may start directly. `entrypoint: false` marks a callee-only component.
    nativeEligible: hostScoped && realizationKind === "skill" && entrypoint,
    composes: composedAliases(component),
  };
}

function componentsOf(ir: unknown): Json[] | undefined {
  if (!isRecord(ir) || !Array.isArray(ir["components"])) return undefined;
  return ir["components"].filter(isRecord);
}

/**
 * The capability ceiling is whatever the shipped analysis profile already requires, read from its
 * compiled IR. Listing the names by hand would let the ceiling drift from the profile it describes.
 */
export function deriveHostCeiling(ceilingIr: unknown): HostCeiling {
  const components = componentsOf(ceilingIr);
  if (components === undefined || components.length === 0) {
    throw new Error(`host ceiling profile "${CEILING_PROFILE_ID}" compiled to an IR with no components`);
  }
  const capabilities = new Set<string>();
  for (const component of components) for (const name of capabilityNames(component)) capabilities.add(name);
  return { capabilities, tiers: HOST_TIERS };
}

/** Rules 2–5 over a compiled IR. Pure: rule 1 (compiling) and rule 6 (staleness) live in the registry. */
export function admitCompiledProfile(ir: unknown, options: { readonly expectedId: string; readonly ceiling: HostCeiling }): AdmissionVerdict {
  const reasons: string[] = [];
  const components = componentsOf(ir);
  if (!isRecord(ir) || components === undefined) {
    return { status: "unavailable", reasons: ["compiled IR is not an object with a components array"], components: [] };
  }
  const irVersion = stringAt(ir, "warble_ir_version");
  const compiledId = stringAt(ir, "profile");
  if (compiledId !== options.expectedId) {
    reasons.push(`compiled profile id "${compiledId ?? ""}" does not match the registered id "${options.expectedId}"`);
  }
  if (components.length === 0) reasons.push("profile mounts no components");

  const summaries = components.map(summarizeComponent);

  const outOfScope = summaries.filter((c) => !(c.type === "analytical" && c.trigger === "one_shot" && c.outcome === "none"));
  for (const c of outOfScope) {
    reasons.push(
      `component "${c.id}" is outside the host's execution scope: type="${c.type}", trigger="${c.trigger}", outcome="${c.outcome}" ` +
        `(a conversation profile may only mount type="analytical", trigger="one_shot", outcome="none")`,
    );
  }

  for (const c of summaries) {
    const excess = c.capabilities.filter((name) => !options.ceiling.capabilities.has(name));
    if (excess.length > 0) {
      reasons.push(`component "${c.id}" requires capabilities outside the host ceiling: ${excess.join(", ")}`);
    }
  }

  for (const c of summaries) {
    const foreignTiers = c.tiers.filter((tier) => !options.ceiling.tiers.has(tier));
    if (foreignTiers.length > 0) {
      reasons.push(`component "${c.id}" uses step tiers the runtime configuration cannot bind: ${foreignTiers.join(", ")} (allowed: ${[...options.ceiling.tiers].join(", ")})`);
    }
  }

  const eligible = summaries.filter((c) => c.nativeEligible);
  let entry: AdmissionVerdict["entry"];
  if (eligible.length === 0) {
    reasons.push("profile has no native-eligible component (a one-shot skill with no outcome that a session may start)");
  } else if (eligible.length === 1) {
    entry = { kind: "agent", verb: eligible[0]!.id };
  } else {
    const undescribed = eligible.filter((c) => !c.hasDescription).map((c) => c.id);
    if (undescribed.length > 0) {
      reasons.push(`scope entry requires an authored description on every native-eligible component; missing on: ${undescribed.join(", ")}`);
    } else {
      entry = { kind: "scope" };
    }
  }

  return {
    status: reasons.length === 0 ? "admitted" : "unavailable",
    reasons,
    ...(reasons.length === 0 && entry !== undefined ? { entry } : {}),
    ...(irVersion !== undefined ? { irVersion } : {}),
    components: summaries,
  };
}

// ---------------------------------------------------------------------------
// Source directories
// ---------------------------------------------------------------------------

/** The `profile:` scalar of a profile.yml. Flat YAML, read the same way `composeUserProfile` does. */
export function readProfileId(profileYamlText: string): string | undefined {
  const matches = [...profileYamlText.matchAll(/^profile:[ \t]*["']?([^"'\s#]+)["']?[ \t]*(?:#.*)?$/gm)];
  if (matches.length !== 1) return undefined;
  return matches[0]![1];
}

export type SourcePathCheck =
  | { readonly ok: true; readonly resolved: string; readonly real: string }
  | { readonly ok: false; readonly message: string };

function isInside(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * A user profile is handed to the server as a directory path on this machine, the same way the
 * adopt flow receives a project path. The path is checked, not trusted: it must be absolute, be a
 * real directory rather than a link, hold a `profile.yml`, and sit outside the roots the registry
 * itself owns, so a request can never register the package tree or the user-data tree as "new".
 */
export function validateUserProfileSourcePath(sourcePath: unknown, options: { readonly forbiddenRoots: readonly string[] }): SourcePathCheck {
  if (typeof sourcePath !== "string" || sourcePath.trim().length === 0) return { ok: false, message: "sourcePath is required" };
  const trimmed = sourcePath.trim();
  if (!path.isAbsolute(trimmed)) return { ok: false, message: `sourcePath must be an absolute path: "${trimmed}"` };
  const resolved = path.resolve(trimmed);
  if (!existsSync(resolved)) return { ok: false, message: `no such directory: "${resolved}"` };
  if (lstatSync(resolved).isSymbolicLink()) return { ok: false, message: `sourcePath must not be a symbolic link: "${resolved}"` };
  if (!statSync(resolved).isDirectory()) return { ok: false, message: `not a directory: "${resolved}"` };
  const profileYaml = path.join(resolved, "profile.yml");
  if (!existsSync(profileYaml) || !statSync(profileYaml).isFile()) {
    return { ok: false, message: `"${resolved}" is not a Warble profile (no profile.yml)` };
  }
  const real = realpathSync(resolved);
  for (const root of options.forbiddenRoots) {
    let realRoot: string;
    try { realRoot = realpathSync(root); } catch { realRoot = path.resolve(root); }
    if (isInside(real, realRoot)) {
      return { ok: false, message: `sourcePath must be outside the registry's own directories: "${resolved}" is under "${root}"` };
    }
  }
  return { ok: true, resolved, real };
}

/** Rejects a tree with any symbolic link in it: the copy would otherwise follow it out of the directory. */
async function assertNoSymlinks(root: string): Promise<void> {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    const info = await lstat(full);
    if (info.isSymbolicLink()) throw new ProfileRegistryError(400, `profile directory must not contain symbolic links: "${full}"`);
    if (info.isDirectory()) await assertNoSymlinks(full);
  }
}

function truncateReason(message: string): string {
  const oneLine = message.replace(/\s+/g, " ").trim();
  return oneLine.length > MAX_REASON_LENGTH ? `${oneLine.slice(0, MAX_REASON_LENGTH - 1)}…` : oneLine;
}

// ---------------------------------------------------------------------------
// Wire projection
// ---------------------------------------------------------------------------

export function toWarbleProfileDto(row: WarbleProfileRow): WarbleProfileDto {
  let components: AdmissionComponentSummary[] = [];
  try {
    const parsed: unknown = JSON.parse(row.componentsJson);
    if (Array.isArray(parsed)) components = parsed.filter(isRecord) as unknown as AdmissionComponentSummary[];
  } catch { components = []; }
  return {
    id: row.id,
    kind: row.kind,
    role: row.role,
    selectable: row.role === "conversation" && row.admissionStatus === "admitted",
    admission: {
      status: row.admissionStatus,
      ...(row.admissionReason !== null ? { reason: row.admissionReason } : {}),
      checkedAt: row.updatedAt,
    },
    ...(row.entryKind !== null ? { entry: { kind: row.entryKind, ...(row.entryVerb !== null ? { verb: row.entryVerb } : {}) } } : {}),
    ...(row.irVersion !== null ? { irVersion: row.irVersion } : {}),
    components: components.map((c) => ({
      id: c.id,
      type: c.type,
      nativeEligible: c.nativeEligible,
      hasDescription: c.hasDescription,
      tiers: c.tiers,
      capabilities: c.capabilities,
    })),
    ...(row.kind === "user" ? { sourceDir: row.sourceDir } : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export interface ProfileRegistryOptions {
  readonly store: Store;
  /** The package's own `profiles/` tree (the directory the analysis profile source lives in). */
  readonly builtinProfilesDir: string;
  /** Where user-added profiles are copied: `<workspaceRoot>/profiles`. Created on first add. */
  readonly userProfilesDir: string;
  /** Rule 1: compile a raw profile directory with the pinned warble. Throws on failure. */
  readonly compileRaw: (profileSource: string) => Promise<{ readonly irPath: string }>;
  /** Identity of the warble binary admission ran against; part of the staleness key (rule 6). */
  readonly warbleIdentity: () => Promise<string>;
  readonly now?: () => Date;
}

export class ProfileRegistry {
  private ready: Promise<void> | undefined;
  private ceiling: HostCeiling | undefined;
  private ceilingFailure: string | undefined;
  private readonly now: () => Date;

  constructor(private readonly options: ProfileRegistryOptions) {
    this.now = options.now ?? (() => new Date());
  }

  /** Registers the shipped profiles once and re-checks stored rows whose inputs changed. Idempotent. */
  ensureReady(): Promise<void> {
    this.ready ??= this.initialize().catch((error: unknown) => {
      // Let a later call retry rather than pinning the failure for the process lifetime.
      this.ready = undefined;
      throw error;
    });
    return this.ready;
  }

  private async initialize(): Promise<void> {
    await this.registerBuiltins();
    for (const row of this.options.store.listWarbleProfiles()) {
      if (row.kind !== "user") continue;
      try {
        await this.readmitIfStale(row);
      } catch (error) {
        // One unreadable user directory must not take the whole registry down with it.
        this.options.store.upsertWarbleProfile({
          ...row,
          admissionStatus: "unavailable",
          admissionReason: truncateReason(`re-admission failed: ${error instanceof Error ? error.message : String(error)}`),
          entryKind: null,
          entryVerb: null,
          admittedAt: null,
          rulesVersion: ADMISSION_RULES_VERSION,
          updatedAt: this.now().toISOString(),
        });
      }
    }
  }

  private async registerBuiltins(): Promise<void> {
    // The ceiling profile is admitted first: every other conversation profile is judged against it.
    const ceilingDir = path.join(this.options.builtinProfilesDir, CEILING_PROFILE_ID);
    if (!existsSync(ceilingDir)) {
      throw new Error(`built-in profile "${CEILING_PROFILE_ID}" is missing from ${this.options.builtinProfilesDir}`);
    }
    await this.registerBuiltin(CEILING_PROFILE_ID, "conversation", ceilingDir);
    for (const [id, role] of Object.entries(BUILTIN_PROFILE_ROLES)) {
      if (id === CEILING_PROFILE_ID) continue;
      const dir = path.join(this.options.builtinProfilesDir, id);
      if (existsSync(dir)) await this.registerBuiltin(id, role, dir);
    }
  }

  private async registerBuiltin(id: string, role: WarbleProfileRole, dir: string): Promise<void> {
    const existing = this.options.store.getWarbleProfile(id);
    if (existing !== undefined && existing.kind !== "builtin") {
      // A user row cannot shadow a shipped id; the shipped one wins and the row is corrected.
      this.options.store.deleteWarbleProfile(id);
    }
    await this.admitAndStore({ id, kind: "builtin", role, sourceDir: dir, ...(existing !== undefined ? { createdAt: existing.createdAt } : {}) });
  }

  private async readmitIfStale(row: WarbleProfileRow): Promise<void> {
    if (!existsSync(row.sourceDir)) {
      this.options.store.upsertWarbleProfile({
        ...row,
        admissionStatus: "unavailable",
        admissionReason: `profile directory is missing: "${row.sourceDir}"`,
        entryKind: null,
        entryVerb: null,
        admittedAt: null,
        rulesVersion: ADMISSION_RULES_VERSION,
        updatedAt: this.now().toISOString(),
      });
      return;
    }
    const [profileHash, warbleIdentity] = await Promise.all([hashDirectory(row.sourceDir), this.options.warbleIdentity()]);
    // A stored verdict is reused only when it was a pass and nothing it depended on has moved: the
    // profile bytes, the warble binary, and this host's rule set. An `unavailable` row is always
    // re-checked: its reason may have been the environment (a compile that collided, a ceiling that
    // was down at that boot), and the only way to find out is to run admission again. A genuinely
    // refused profile costs one compile per boot and stays refused.
    if (row.admissionStatus === "admitted" && row.rulesVersion === ADMISSION_RULES_VERSION && profileHash === row.profileHash && warbleIdentity === row.warbleIdentity && this.ceilingFailure === undefined) return;
    await this.admitAndStore({ id: row.id, kind: row.kind, role: row.role, sourceDir: row.sourceDir, createdAt: row.createdAt });
  }

  /**
   * Runs rules 1–5 for one directory and persists the verdict. The ceiling profile's own verdict
   * also fixes the ceiling; while it fails to compile no conversation profile can be admitted,
   * and each row says so rather than silently inheriting an empty ceiling.
   */
  private async admitAndStore(input: {
    readonly id: string;
    readonly kind: WarbleProfileKind;
    readonly role: WarbleProfileRole;
    readonly sourceDir: string;
    readonly createdAt?: string;
  }): Promise<WarbleProfileRow> {
    const now = this.now().toISOString();
    const [profileHash, warbleIdentity] = await Promise.all([hashDirectory(input.sourceDir), this.options.warbleIdentity()]);
    const base = {
      id: input.id,
      kind: input.kind,
      role: input.role,
      sourceDir: input.sourceDir,
      profileHash,
      warbleIdentity,
      rulesVersion: ADMISSION_RULES_VERSION,
      createdAt: input.createdAt ?? now,
      updatedAt: now,
    };
    const unavailable = (reason: string): WarbleProfileRow => this.options.store.upsertWarbleProfile({
      ...base,
      admissionStatus: "unavailable",
      admissionReason: reason,
      entryKind: null,
      entryVerb: null,
      irVersion: null,
      componentsJson: "[]",
      admittedAt: null,
    });

    if (input.role === "system") {
      // System purposes are dispatched by their host purpose and never offered to a browser, so the
      // conversation floor does not apply. The row exists so the registry lists every shipped profile.
      return this.options.store.upsertWarbleProfile({
        ...base,
        admissionStatus: "admitted",
        admissionReason: "system purpose profile: dispatched by its host purpose, never selectable for a conversation",
        entryKind: null,
        entryVerb: null,
        irVersion: null,
        componentsJson: "[]",
        admittedAt: now,
      });
    }

    let ir: unknown;
    try {
      const compiled = await this.compileOnceWithRetry(input.sourceDir);
      ir = JSON.parse(await readFile(compiled.irPath, "utf-8"));
    } catch (error) {
      const reason = truncateReason(`warble compile failed: ${error instanceof Error ? error.message : String(error)}`);
      if (input.id === CEILING_PROFILE_ID) {
        this.ceiling = undefined;
        this.ceilingFailure = reason;
      }
      return unavailable(reason);
    }

    if (input.id === CEILING_PROFILE_ID) {
      try {
        this.ceiling = deriveHostCeiling(ir);
        this.ceilingFailure = undefined;
      } catch (error) {
        this.ceiling = undefined;
        this.ceilingFailure = truncateReason(error instanceof Error ? error.message : String(error));
      }
    }
    if (this.ceiling === undefined) {
      return unavailable(`host ceiling is unavailable: ${this.ceilingFailure ?? `"${CEILING_PROFILE_ID}" has not been admitted`}`);
    }

    const verdict = admitCompiledProfile(ir, { expectedId: input.id, ceiling: this.ceiling });
    return this.options.store.upsertWarbleProfile({
      ...base,
      admissionStatus: verdict.status,
      admissionReason: verdict.reasons.length === 0 ? null : truncateReason(verdict.reasons.join("; ")),
      entryKind: verdict.entry?.kind ?? null,
      entryVerb: verdict.entry?.verb ?? null,
      irVersion: verdict.irVersion ?? null,
      componentsJson: JSON.stringify(verdict.components),
      admittedAt: verdict.status === "admitted" ? now : null,
    });
  }

  /**
   * `warble compile` re-derives its fetched Hub cache on every run and documents that two
   * concurrent runs can collide on the rename, failing one of them loudly and transiently. A BFF
   * compiles for readiness and sessions while this registry is admitting, so one bounded retry
   * keeps a shipped profile from being recorded as unavailable over that collision. A profile that
   * fails twice is recorded with the second failure.
   */
  private async compileOnceWithRetry(sourceDir: string): Promise<{ readonly irPath: string }> {
    try {
      return await this.options.compileRaw(sourceDir);
    } catch {
      await new Promise((resolve) => setTimeout(resolve, COMPILE_RETRY_DELAY_MS));
      return this.options.compileRaw(sourceDir);
    }
  }

  async list(): Promise<readonly WarbleProfileRow[]> {
    await this.ensureReady();
    return this.options.store.listWarbleProfiles();
  }

  async get(id: string): Promise<WarbleProfileRow | undefined> {
    await this.ensureReady();
    return this.options.store.getWarbleProfile(id);
  }

  /**
   * Copies a profile directory from `sourcePath` into the user-data tree and admits it. The copy is
   * what the registry owns from then on; the original is never read again.
   */
  async add(sourcePath: unknown): Promise<WarbleProfileRow> {
    await this.ensureReady();
    const check = validateUserProfileSourcePath(sourcePath, {
      forbiddenRoots: [this.options.builtinProfilesDir, this.options.userProfilesDir],
    });
    if (!check.ok) throw new ProfileRegistryError(400, check.message);
    await assertNoSymlinks(check.real);

    const profileYaml = await readFile(path.join(check.real, "profile.yml"), "utf-8");
    const id = readProfileId(profileYaml);
    if (id === undefined) throw new ProfileRegistryError(400, `profile.yml at "${check.resolved}" must declare exactly one top-level "profile:" id`);
    if (!PROFILE_ID_PATTERN.test(id)) {
      throw new ProfileRegistryError(400, `profile id "${id}" is invalid: use lowercase letters, digits, "-" or "_" (max 64 characters)`);
    }
    if (Object.hasOwn(BUILTIN_PROFILE_ROLES, id)) throw new ProfileRegistryError(409, `profile id "${id}" is reserved for a built-in profile`);
    if (this.options.store.getWarbleProfile(id) !== undefined) throw new ProfileRegistryError(409, `a profile with id "${id}" is already registered`);

    const destination = path.join(this.options.userProfilesDir, id);
    await mkdir(this.options.userProfilesDir, { recursive: true });
    // Claim the destination atomically: a non-recursive mkdir fails with EEXIST for a second
    // concurrent add of the same id, or for a directory left behind by an earlier failure, so two
    // sources can never be merged into one copy.
    try {
      await mkdir(destination);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new ProfileRegistryError(409, `"${destination}" already exists; remove it before registering "${id}" again`);
      }
      throw error;
    }
    try {
      await cp(check.real, destination, { recursive: true, dereference: false, force: false });
      return await this.admitAndStore({ id, kind: "user", role: "conversation", sourceDir: destination });
    } catch (error) {
      // Nothing half-copied survives a failure: the next add of this id starts from a clean claim.
      await rm(destination, { recursive: true, force: true });
      throw error;
    }
  }

  /** Removes a user profile and its copy. A profile any native session has run inside stays. */
  async remove(id: string): Promise<void> {
    await this.ensureReady();
    const row = this.options.store.getWarbleProfile(id);
    if (row === undefined) throw new ProfileRegistryError(404, `no profile with id "${id}"`);
    if (row.kind !== "user") throw new ProfileRegistryError(409, `profile "${id}" is built in and cannot be removed`);
    const referenced = this.options.store.countNativeSessionsByDispatchProfile(id);
    if (referenced > 0) {
      throw new ProfileRegistryError(409, `profile "${id}" is referenced by ${referenced} native session${referenced === 1 ? "" : "s"} and cannot be removed while that history exists`);
    }
    this.options.store.deleteWarbleProfile(id);
    const userRoot = await realpath(this.options.userProfilesDir).catch(() => path.resolve(this.options.userProfilesDir));
    const target = await realpath(row.sourceDir).catch(() => undefined);
    if (target !== undefined && isInside(target, userRoot) && target !== userRoot) {
      await rm(target, { recursive: true, force: true });
    }
  }

  /**
   * The directory a conversation session compiles from, for an id the browser selected. Refuses
   * anything that is not an admitted conversation profile, with the stored reason.
   */
  async resolveConversationProfileSource(id: string): Promise<{ readonly sourceDir: string; readonly row: WarbleProfileRow }> {
    await this.ensureReady();
    const row = this.options.store.getWarbleProfile(id);
    if (row === undefined) throw new ProfileRegistryError(404, `no profile with id "${id}"`);
    if (row.role !== "conversation") throw new ProfileRegistryError(409, `profile "${id}" is a system purpose profile and cannot start a conversation`);
    if (row.admissionStatus !== "admitted") {
      throw new ProfileRegistryError(409, `profile "${id}" is unavailable: ${row.admissionReason ?? "admission failed"}`);
    }
    return { sourceDir: row.sourceDir, row };
  }
}
