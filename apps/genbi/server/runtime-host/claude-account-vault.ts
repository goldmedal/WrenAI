import { constants, closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";

import { RUNTIME_BUDGETS_MS } from "../../harness/runtime-budgets.js";
import { createClaudeHostVerifier, createClaudeHostVerifierForTesting, credentialSchema, hostIdentitySchema, readHostVerificationReceipt, type ClaudeHostIdentity } from "./claude-host-verification.js";
export class ClaudeAccountFault extends Error {
  constructor(readonly code: "storage" | "unverified" | "revoked" | "identity" | "refresh" | "interrupted" | "busy") { super(`Claude account ${code}`); }
}
// Local SDK observation is deliberately a separate contract.
export type ClaudeIdentity = { email: string; tokenSource: string; subscriptionType: string; apiKeySource: "none"; apiProvider: "firstParty" };
export type ClaudeCredentialBundle = z.infer<typeof credentialSchema>;
const stateSchema = z.object({ version: z.literal(2), generation: z.uuid(), credentialGeneration: z.uuid(), bundle: credentialSchema, identity: hostIdentitySchema.optional(), organizationName: z.string().min(1).max(256).optional(), scopes: z.tuple([z.literal("user:inference"), z.literal("user:profile")]).optional(), verified: z.boolean(), refreshing: z.boolean() }).strict();
const legacySchema = z.object({ version: z.literal(1), generation: z.uuid(), bundle: credentialSchema, identity: z.unknown().optional(), verified: z.boolean(), refreshing: z.boolean() }).strict();
type State = z.infer<typeof stateSchema>;
export interface ClaudeAccountLease {
  readonly identity: Readonly<ClaudeHostIdentity>;
  readonly organizationName?: string;
  readonly fingerprint: string;
  readonly generation: string;
  readonly credentialGeneration: string;
  readonly expiresAt: number;
  readonly signal: AbortSignal;
  accessCredential(): string;
  assertCurrent(): void;
  release(): void;
}
export type ClaudeIdentityVerifier = (access: string, signal: AbortSignal) => Promise<ClaudeIdentity>;
const registeredVaults = new WeakSet<object>();
const registeredLeases = new WeakMap<object, { vault: ClaudeAccountVault; afterClose(): void }>();
export function assertActualVault(vault: ClaudeAccountVault): void { if (!registeredVaults.has(vault)) throw new ClaudeAccountFault("identity"); }
export function assertVaultLeaseAfterClose(lease: ClaudeAccountLease): void { const record = registeredLeases.get(lease); if (!record) throw new ClaudeAccountFault("identity"); record.afterClose(); }
export function assertVaultLease(lease: ClaudeAccountLease, vault?: ClaudeAccountVault): void { const record = registeredLeases.get(lease); if (!record || (vault && record.vault !== vault)) throw new ClaudeAccountFault("identity"); lease.assertCurrent(); }
const roots = new Set<string>();
/** Internal operator API only. Never reads ambient HOME/keychain/Claude configuration. */
export class ClaudeAccountVault {
  private state: State | undefined;
  private diskDigest: string | undefined;
  private epoch = 0;
  private readonly leases = new Set<AbortController>();
  private verifier = createClaudeHostVerifier();
  private flight: { epoch: number; rotation: boolean; expected: ClaudeHostIdentity; promise: Promise<void>; controller: AbortController } | undefined;
  private lock: DatabaseSync | undefined;
  private stopped = false;
  private reason: "unverified" | "revoked" | "refresh" | "interrupted" = "unverified";
  private readonly file: string;
  private readonly now: () => number;
  constructor(private readonly options: { root: string; now?: () => number }) {
    this.now = options.now ?? Date.now;
    try {
      if (!path.isAbsolute(options.root)) throw new Error();
      mkdirSync(options.root, { recursive: true, mode: 0o700 }); this.secureRoot();
      if (roots.has(options.root)) throw new ClaudeAccountFault("busy");
      this.file = path.join(options.root, "account.json");
      const lockFile = path.join(options.root, "account-lock.sqlite");
      const fd = openSync(lockFile, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600); closeSync(fd); this.secureFile(lockFile);
      this.lock = new DatabaseSync(lockFile); this.lock.exec("PRAGMA busy_timeout=0; BEGIN EXCLUSIVE;"); roots.add(options.root);
      try { const fd = openSync(this.file, constants.O_RDONLY | constants.O_NOFOLLOW); try { this.secureFile(this.file); const raw = JSON.parse(readFileSync(fd, "utf8"));
        if (raw.version === 1) { const legacy = legacySchema.parse(raw); this.state = { version: 2, generation: legacy.generation, credentialGeneration: randomUUID(), bundle: legacy.bundle, verified: false, refreshing: legacy.refreshing }; }
        else this.state = stateSchema.parse(raw); } finally { closeSync(fd); } }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      // Restart never trusts an interrupted verifier/refresh; retained bundle must be reverified.
      if (this.state) { this.reason = this.state.refreshing ? "interrupted" : "unverified"; this.state.verified = false; this.state.refreshing = false; this.persist(this.state); }
      registeredVaults.add(this);
    } catch (error) { if (this.lock) { this.lock.close(); roots.delete(options.root); } throw error instanceof ClaudeAccountFault ? error : new ClaudeAccountFault("storage"); }
  }
  private secureRoot(): void {
    if (realpathSync(this.options.root) !== this.options.root) throw new ClaudeAccountFault("storage");
    for (let cursor = this.options.root; ; cursor = path.dirname(cursor)) {
      const stat = lstatSync(cursor);
      if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.uid !== process.getuid?.() && stat.uid !== 0) || ((stat.mode & 0o022) !== 0 && !(stat.mode & 0o1000))) throw new ClaudeAccountFault("storage");
      if (path.dirname(cursor) === cursor) break;
    }
    const stat = lstatSync(this.options.root); if (stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o700) throw new ClaudeAccountFault("storage");
  }
  private secureFile(file: string): void {
    const stat = lstatSync(file); if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600 || stat.size > 32768) throw new ClaudeAccountFault("storage");
  }
  private persist(state: State): void {
    this.secureRoot(); const temp = path.join(this.options.root, `account-${randomUUID()}.tmp`);
    try {
      try { this.secureFile(this.file); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { writeFileSync(fd, JSON.stringify(stateSchema.parse(state))); fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(temp, this.file); this.diskDigest = createHash("sha256").update(readFileSync(this.file)).digest("hex"); const directory = openSync(this.options.root, constants.O_RDONLY); try { fsyncSync(directory); } finally { closeSync(directory); }
    } catch { throw new ClaudeAccountFault("storage"); } finally { try { unlinkSync(temp); } catch { /* unique interrupted files never reused */ } }
  }
  private fence(): void { this.epoch++; for (const lease of this.leases) lease.abort(); this.leases.clear(); this.flight?.controller.abort(); this.flight = undefined; }
  /** Explicit synthetic HTTP seam; ordinary construction always uses fixed direct HTTPS. */
  static forTesting(options: { root: string; transport: Parameters<typeof createClaudeHostVerifierForTesting>[0]; now?: () => number; stageDeadlineMs?: number }): ClaudeAccountVault {
    const vault = new ClaudeAccountVault({ root: options.root, ...(options.now ? { now: options.now } : {}) });
    vault.verifier = createClaudeHostVerifierForTesting(options.transport, options); return vault;
  }
  private diskCurrent(): void {
    try { this.secureRoot(); this.secureFile(this.file); if (createHash("sha256").update(readFileSync(this.file)).digest("hex") !== this.diskDigest) throw new Error(); }
    catch { this.fence(); if (this.state) this.state.verified = false; this.reason = "interrupted"; throw new ClaudeAccountFault("storage"); }
  }
  retainedCredential(): boolean { return this.state !== undefined; }
  status(): { state: string; fingerprint?: string; generation?: string } {
    if (this.state?.verified) this.diskCurrent();
    return this.state?.verified ? { state: "verified", fingerprint: this.fingerprint(this.state.identity!), generation: this.state.generation } : { state: this.flight ? "busy" : this.reason };
  }
  verifiedIdentity(): Readonly<ClaudeHostIdentity> { this.diskCurrent(); if (!this.state?.verified) throw new ClaudeAccountFault(this.reason); return Object.freeze({ ...this.state.identity! }); }
  private fingerprint(identity: ClaudeHostIdentity): string { return `sha256:${createHash("sha256").update(JSON.stringify(hostIdentitySchema.parse(identity))).digest("hex")}`; }
  enroll(bundle: ClaudeCredentialBundle): void {
    if (this.stopped) throw new ClaudeAccountFault("revoked");
    let parsed: ClaudeCredentialBundle; try { parsed = credentialSchema.parse(bundle); } catch { throw new ClaudeAccountFault("identity"); }
    this.fence(); this.state = undefined; this.reason = "unverified";
    const state: State = { version: 2, generation: randomUUID(), credentialGeneration: randomUUID(), bundle: parsed, verified: false, refreshing: false };
    this.persist(state); this.state = state;
  }
  /** Fencing (re)verification: boot and identity checks. Every live lease is aborted before the refresh starts. */
  verify(expected: ClaudeHostIdentity): Promise<void> { return this.refresh(expected, false); }
  /** Lease-time rotation of a verified credential. A same-identity success leaves live leases running; any failure fences. */
  private rotate(): Promise<void> {
    if (this.flight?.epoch === this.epoch) return this.flight.promise;
    return this.refresh(this.state!.identity!, true);
  }
  private refresh(expected: ClaudeHostIdentity, rotation: boolean): Promise<void> {
    let identity: ClaudeHostIdentity; try { identity = Object.freeze(hostIdentitySchema.parse(expected)); } catch { return Promise.reject(new ClaudeAccountFault("identity")); }
    const state = this.state;
    if (!state || this.stopped) return Promise.reject(new ClaudeAccountFault("unverified"));
    if (state.identity && !isDeepStrictEqual(state.identity, identity)) return Promise.reject(new ClaudeAccountFault("identity"));
    if (this.flight?.epoch === this.epoch) return isDeepStrictEqual(this.flight.expected, identity) ? this.flight.promise : Promise.reject(new ClaudeAccountFault("identity"));
    // Synchronous fencing (verification only) and flight publication happen before the first asynchronous operation.
    if (!rotation) { this.fence(); this.reason = "unverified"; state.verified = false; }
    const epoch = this.epoch; const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 25000);
    let abort!: () => void;
    const cancelled = new Promise<never>((_, reject) => { abort = () => reject(new ClaudeAccountFault("refresh")); controller.signal.addEventListener("abort", abort, { once: true }); });
    void cancelled.catch(() => {});
    const current = () => { if (epoch !== this.epoch || this.stopped || this.state !== state || controller.signal.aborted) throw new ClaudeAccountFault("refresh"); this.diskCurrent(); };
    const promise = Promise.resolve().then(async () => {
      try {
        current(); this.persist({ ...state, refreshing: true, verified: false });
        const receipt = await Promise.race([this.verifier(state.bundle.refreshToken, controller.signal, current), cancelled]); current();
        const candidate = readHostVerificationReceipt(receipt);
        if (!isDeepStrictEqual(candidate.identity, identity) || candidate.bundle.expiresAt < this.now() + RUNTIME_BUDGETS_MS.claudeTokenRefreshMargin) throw new ClaudeAccountFault("identity");
        const next: State = { version: 2, generation: state.generation, credentialGeneration: randomUUID(), bundle: { ...candidate.bundle }, identity: { ...candidate.identity }, ...(candidate.organizationName ? { organizationName: candidate.organizationName } : {}), scopes: ["user:inference", "user:profile"], refreshing: false, verified: true };
        current(); this.persist(next); this.state = next;
      } catch (error) {
        if (epoch === this.epoch && this.state === state) {
          if (rotation) this.fence();
          this.reason = error instanceof ClaudeAccountFault && error.code === "identity" ? "unverified" : "refresh";
          this.state = { ...state, verified: false, refreshing: true };
          try { this.persist(this.state); } catch { this.reason = "interrupted"; }
        }
        throw new ClaudeAccountFault(error instanceof ClaudeAccountFault && error.code === "identity" ? "identity" : "refresh");
      } finally { clearTimeout(timer); controller.signal.removeEventListener("abort", abort); controller.abort(); if (this.flight?.epoch === epoch) this.flight = undefined; }
    });
    this.flight = { epoch, rotation, expected: identity, controller, promise }; return promise;
  }
  async lease(expectedFingerprint: string, expectedGeneration: string): Promise<ClaudeAccountLease> {
    if (this.stopped || !this.state?.verified) throw new ClaudeAccountFault(this.flight ? "busy" : this.reason);
    this.diskCurrent();
    if (this.state.generation !== expectedGeneration || this.fingerprint(this.state.identity!) !== expectedFingerprint) throw new ClaudeAccountFault("identity");
    if (this.state.bundle.expiresAt < this.now() + RUNTIME_BUDGETS_MS.claudeTokenRefreshMargin) await this.rotate();
    const state = this.state; const epoch = this.epoch;
    if (!state?.verified || state.generation !== expectedGeneration || this.fingerprint(state.identity!) !== expectedFingerprint) throw new ClaudeAccountFault("identity");
    const controller = new AbortController(); this.leases.add(controller);
    // A same-identity rotation replaces the state object but not the vault generation, identity or epoch; anything else fences.
    const live = (released: boolean) => (released || !controller.signal.aborted) && !this.stopped && epoch === this.epoch && !!this.state?.verified && this.state.generation === state.generation && this.fingerprint(this.state.identity!) === expectedFingerprint && this.now() < state.bundle.expiresAt;
    const assertCurrent = () => {
      if (!live(false)) throw new ClaudeAccountFault("revoked");
      this.diskCurrent();
    };
    const lease: ClaudeAccountLease = Object.freeze({ identity: Object.freeze({ ...state.identity! }), ...(state.organizationName ? { organizationName: state.organizationName } : {}), fingerprint: expectedFingerprint, generation: state.generation, credentialGeneration: state.credentialGeneration, expiresAt: state.bundle.expiresAt,
      signal: controller.signal, assertCurrent, accessCredential: () => { assertCurrent(); return state.bundle.accessToken; }, release: () => { controller.abort(); this.leases.delete(controller); } });
    registeredLeases.set(lease, { vault: this, afterClose: () => { if (!live(true)) throw new ClaudeAccountFault("revoked"); this.diskCurrent(); } }); return lease;
  }
  disconnect(): void {
    this.fence(); this.state = undefined; this.reason = "revoked";
    try { this.secureRoot(); try { this.secureFile(this.file); unlinkSync(this.file); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } }
    catch { throw new ClaudeAccountFault("storage"); }
  }
  close(): void { this.fence(); this.stopped = true; this.lock?.close(); this.lock = undefined; roots.delete(this.options.root); }
}
