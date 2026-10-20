/**
 * The one table of time budgets for long-running sessions. Every value here was previously a
 * hardcode at the site named in its comment; nothing was loosened. It lives in `harness/` so the
 * server and the component broker can both import it (server -> harness is the allowed direction).
 */

const SECOND = 1000;
const MINUTE = 60 * SECOND;

/** Package-enforced budgets, in milliseconds. */
export const RUNTIME_BUDGETS_MS = Object.freeze({
  /** One Claude component step (BFF-side abort timer, `component_timeout`). */
  claudeComponentStep: 120 * SECOND,
  /** Hard wall-clock deadline on the BFF <-> sandbox Claude duplex stream, from open. */
  claudeDuplexDeadline: 120 * SECOND,
  /**
   * A Claude account token is refreshed when a lease is requested inside this margin of its expiry.
   * It exceeds one component step, so a lease issued just before a rotation outlives any single step.
   */
  claudeTokenRefreshMargin: 135 * SECOND,
  /** Built-in component run budget when no operator or deployer value is set. */
  defaultComponentTimeout: 120 * SECOND,
  /** Idle time before a native or scoped session with no attached listener is stopped. */
  sessionIdleTtl: 30 * MINUTE,
  /** How often an idle scoped session's sandbox is checked for liveness (no upstream event exists to push it). */
  sandboxProbeInterval: 60 * SECOND,
  /** One sandbox liveness probe (sandbox get plus container inventory); the inspect behind it is up to three 15 s CLI commands, which is never waited for beyond this. */
  sandboxProbeTimeout: 45 * SECOND,
  /** SQL statement budget when the component declares no `statement_timeout` guard. */
  sqlStatementDefault: 30 * SECOND,
  /** Upper bound on any SQL statement budget, whatever the component declares. */
  sqlStatementCap: 120 * SECOND,
});

/**
 * OpenShell supervisor credential renewal: upstream defaults, documented here as inputs. GenBI
 * neither enforces nor changes them.
 */
export const OPENSHELL_SUPERVISOR_DEFAULTS = Object.freeze({
  /** Sandbox Protocol (boundary) token lifetime when the gateway sets no `ttl_secs`. */
  boundaryTokenLifetimeMs: 15 * MINUTE,
  /** The supervisor renews once this fraction of the remaining token life has elapsed. */
  renewalFraction: 0.8,
  /** Up to this fraction of extra delay is added to each renewal. */
  renewalJitterFraction: 0.1,
});

/**
 * The gateway sandbox JWT TTL (`ttl_secs`) is set in the operator's gateway config, not by this
 * package. It must be set explicitly; the package never extends it.
 */
export const GATEWAY_JWT_TTL = Object.freeze({
  owner: "operator",
  setBy: "gateway config ttl_secs",
  rule: "must be set explicitly; the package never extends it",
});
