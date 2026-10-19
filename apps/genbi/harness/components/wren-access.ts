import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { hashDirectory } from "../compile/fingerprint.js";
import type { ComponentAccess } from "./broker.js";
import { declaredDefaultIds } from "./knowledge-rules.js";
import { redactForLog } from "./runner.js";
import { dialectGuidance, readProjectSqlDialect } from "./sql-dialect.js";

/**
 * The closed vocabulary of governed query failures a model may see. The wire carries the
 * class; the sentence shown to the model is owned here, so nothing a `wren` process writes
 * (exception text, SQL, paths, credentials) can reach a model even if that process is stale
 * or compromised. `transport` is host-only: the channel itself failed or closed.
 */
export const GOVERNED_ERROR_CLASSES = ["invalid_request", "model_not_found", "cube_not_queryable", "ungrounded_literal", "declared_default_missing", "policy_rejected", "invalid_sql", "execution_failed",
  "timeout", "datasource_unavailable", "result_too_large", "internal", "transport"] as const;
export type GovernedErrorClass = (typeof GOVERNED_ERROR_CLASSES)[number];
const GOVERNED_ERROR_TEXT: Readonly<Record<GovernedErrorClass, string>> = Object.freeze({
  invalid_request: "The request did not match the governed operation contract.",
  model_not_found: "The query references a table that is not a model in the bound semantic context; query only the models it defines.",
  cube_not_queryable: "The query reads a cube as if it were a table. A cube is a semantic definition (a base model plus measure and dimension expressions), not a SQL table; query the cube's base model instead and compute the measure from the cube definition's expression over the base model's columns.",
  ungrounded_literal: "The query reads no bound model, so the values it returns are literals typed into the query, not data. A value must come from an executed query over the bound models: cite the earlier query that already produced it by its query_id, or compute it in one SELECT over the models.",
  declared_default_missing: "The query does not apply a default rule that the bound project declares for the models it reads, so it was not executed. Apply the rule named below (its wording is in the project's knowledge rules), then run the query again.",
  policy_rejected: "The read-only analytical policy rejected the query: use one SELECT over the bound models with standard analytical functions only.",
  invalid_sql: "The SQL could not be parsed or planned against the semantic context.",
  execution_failed: "The data source rejected the query at execution time, for example an unknown column or a type mismatch.",
  timeout: "The query exceeded the statement time limit.",
  datasource_unavailable: "The bound data source could not be reached.",
  result_too_large: "The result exceeded the governed byte limit; narrow the query.",
  internal: "The governed operation failed for an unclassified reason.",
  transport: "Governed Wren operation is unavailable.",
});
const LOGGED_SQL_LIMIT = 2000;
/** Why a governed channel is unavailable, when the host knows: a fixed code, never wire text or a rule id. */
export type GovernedUnavailableReason = "governed_declarations_mismatch";
/** The suffix naming the declared rules a refused query missed; empty without ids. */
export function declaredDefaultRuleSuffix(ruleIds: readonly string[]): string {
  return ruleIds.length > 0 ? ` Rule: ${ruleIds.join(", ")}` : "";
}
export class GovernedWrenError extends Error {
  /** The wire's own message, for the server log only: it never reaches `message`, a frame or a model. */
  wireMessage?: string;
  /** The declared rules a `declared_default_missing` refusal names: only ids the host's own catalog declares. */
  readonly ruleIds: readonly string[];
  /** Set only on a channel the host refused to trust (`transport`). */
  readonly reason?: GovernedUnavailableReason;
  constructor(readonly errorClass: GovernedErrorClass, dialect?: string, detail: { readonly ruleIds?: readonly string[]; readonly reason?: GovernedUnavailableReason } = {}) {
    const ruleIds = errorClass === "declared_default_missing" ? Object.freeze([...(detail.ruleIds ?? [])]) : Object.freeze([]);
    super(`Governed Wren query failed [${errorClass}]: ${GOVERNED_ERROR_TEXT[errorClass]}${errorClass === "policy_rejected" && dialect ? ` ${dialectGuidance(dialect)}` : ""}${declaredDefaultRuleSuffix(ruleIds)}`);
    this.name = "GovernedWrenError";
    this.ruleIds = ruleIds;
    if (detail.reason !== undefined) this.reason = detail.reason;
  }
}
/**
 * Only the class crosses; a message from the wire is never forwarded, and an unknown class is `internal`.
 * The ids of a `declared_default_missing` refusal are kept only if the host's own catalog declares them.
 */
function governedError(wire: string | { class: string; rule_ids?: readonly string[] | undefined }, dialect?: string, declared: ReadonlySet<string> = new Set()): GovernedWrenError {
  const named = typeof wire === "string" ? undefined : wire.class;
  const known = GOVERNED_ERROR_CLASSES.find((candidate) => candidate === named && candidate !== "transport");
  const ruleIds = known === "declared_default_missing" && typeof wire !== "string" ? [...new Set((wire.rule_ids ?? []).filter((id) => declared.has(id)))] : [];
  const error = new GovernedWrenError(known ?? "internal", dialect, { ruleIds });
  if (typeof wire !== "string" && "message" in wire && typeof wire.message === "string") error.wireMessage = wire.message;
  return error;
}
/** One server-log line per rejected governed query: the SQL the model submitted (never sent to a client) and the wire's class and message. */
function logRejectedQuery(sql: unknown, error: GovernedWrenError): void {
  const fields = { site: "governed_query", code: error.errorClass,
    ...(typeof sql === "string" ? { sql: redactForLog(sql, LOGGED_SQL_LIMIT) } : {}),
    ...(error.wireMessage ? { wire: redactForLog(error.wireMessage) } : {}) };
  console.error(`[component-failure] ${JSON.stringify(fields)}`);
}
const PROTOCOLS = ["wren-governed/1", "wren-governed/2", "wren-governed/3"] as const;
// `declared_defaults` is checked apart from the frame shape so that every way a hello can disagree with the host's
// catalog (absent, malformed, over the cap, a different set) is one named refusal.
const reply = z.object({ id: z.number().int().nonnegative(), protocol: z.enum(PROTOCOLS).optional(), declared_defaults: z.unknown().optional(), result: z.unknown().optional(),
  error: z.union([z.string(), z.object({ class: z.string().min(1).max(64), message: z.string().max(1024), rule_ids: declaredDefaultIds.optional() }).strict()]).optional() }).strict();

/**
 * Protocol 3 announces the project's declared default rules and exists only for a project that declares some; every
 * earlier protocol announces none. Either way the announcement must equal the host catalog's set: a client that
 * enforces rules the host does not know of, or one that enforces fewer, is not trusted to run the project.
 */
function helloMatchesDeclarations(value: z.infer<typeof reply>, declared: readonly string[]): boolean {
  if (value.protocol !== "wren-governed/3") return Object.keys(value).length === 2 && declared.length === 0;
  if (Object.keys(value).length !== 3) return false;
  const announced = declaredDefaultIds.safeParse(value.declared_defaults);
  if (!announced.success || new Set(announced.data).size !== announced.data.length || announced.data.length !== declared.length) return false;
  const expected = new Set(declared);
  return announced.data.every((id) => expected.has(id));
}

export interface WrenAccessIdentity {
  readonly environment: Readonly<NodeJS.ProcessEnv>;
  readonly digest: string;
  assertCurrent(): Promise<void>;
}

/** Capture once per root, before preparing any component. Secrets never leave the host. */
export async function captureWrenAccessIdentity(project: string, source: NodeJS.ProcessEnv = process.env): Promise<WrenAccessIdentity> {
  const environment = Object.freeze({ ...source });
  const home = path.resolve(environment.WREN_HOME ?? path.join(environment.HOME ?? os.homedir(), ".wren"));
  const files = [path.join(project, ".env"), ...[".env", "profiles.yml", "config.json"].map((name) => path.join(home, name))];
  const fingerprint = async () => {
    const hash = createHash("sha256").update(JSON.stringify(environment));
    for (const file of files) {
      hash.update(file).update("\0");
      try { hash.update(await realpath(file)).update("\0").update(await readFile(file)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Wren configuration is unavailable"); hash.update("absent"); }
    }
    return hash.digest("hex");
  };
  const digest = await fingerprint();
  return Object.freeze({ environment, digest, async assertCurrent() {
    if (await fingerprint() !== digest) throw new Error("Wren configuration changed");
  } });
}

/** One owned process captures the project model, policy and credentials once. */
export async function openWrenComponentAccess(options: {
  readonly executable: string;
  readonly project: string;
  readonly fingerprint: string;
  readonly signal: AbortSignal;
  readonly environment?: NodeJS.ProcessEnv;
  readonly identity?: WrenAccessIdentity;
  /** The ids of the default rules the project's catalog declares; the governed process must announce exactly this set. Empty when omitted. */
  readonly declaredDefaults?: readonly string[];
  /** Server-only native executable checkpoint, immediately before spawn. */
  assertExecutableCurrent?(): void;
}): Promise<ComponentAccess> {
  options.signal.throwIfAborted();
  const identity = options.identity ?? await captureWrenAccessIdentity(options.project, options.environment);
  const dialect = await readProjectSqlDialect(options.project);
  const declaredDefaults = [...(options.declaredDefaults ?? [])];
  const declared: ReadonlySet<string> = new Set(declaredDefaults);
  const assertProject = async () => {
    await identity.assertCurrent();
    if (await hashDirectory(options.project) !== options.fingerprint) throw new Error("Component project changed");
    options.signal.throwIfAborted();
  };
  await assertProject();
  options.assertExecutableCurrent?.();
  if (process.platform === "win32") throw new Error("Governed process cleanup is unavailable on this platform");
  const child = spawn(options.executable, ["governed-stdio", "--project", options.project], {
    cwd: options.project, env: { ...identity.environment }, detached: true, stdio: ["pipe", "pipe", "pipe"],
  });
  child.stderr.resume();
  let closed = false;
  let closing: Promise<void> | undefined;
  let buffer = Buffer.alloc(0);
  let nextId = 1;
  let pending: { id: number; resolve(value: unknown): void; reject(error: Error): void } | undefined;
  let unavailableReason: GovernedUnavailableReason | undefined;
  const unavailable = () => new GovernedWrenError("transport", undefined, unavailableReason ? { reason: unavailableReason } : {});
  const ready = new Promise<void>((resolve, reject) => { pending = { id: 0, resolve: () => resolve(), reject }; });
  const signalGroup = (value: NodeJS.Signals) => {
    if (!child.pid) return;
    try { process.kill(-child.pid, value); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw unavailable();
    }
  };
  const alive = () => {
    if (!child.pid) return false;
    try { process.kill(-child.pid, 0); return true; } catch (error) {
      return (error as NodeJS.ErrnoException).code !== "ESRCH";
    }
  };
  const waitGone = async (ms: number) => {
    const deadline = performance.now() + ms;
    while (alive() && performance.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    return !alive();
  };
  const close = (): Promise<void> => {
    if (closing) return closing;
    closed = true;
    pending?.reject(unavailable()); pending = undefined;
    closing = (async () => {
      try {
        child.stdin.end();
        if (await waitGone(100)) return;
        signalGroup("SIGTERM");
        if (await waitGone(300)) return;
        signalGroup("SIGKILL");
        if (!(await waitGone(2000))) throw new Error("Governed Wren cleanup failed");
      } finally {
        options.signal.removeEventListener("abort", abort);
        child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
      }
    })();
    return closing;
  };
  const abort = () => { void close().catch(() => {}); };
  options.signal.addEventListener("abort", abort, { once: true });
  child.on("error", abort); child.on("exit", abort);
  child.stdin.on("error", abort); child.stdout.on("error", abort);
  child.stdout.on("data", (chunk: Buffer) => {
    if (closed) return;
    buffer = Buffer.concat([buffer, chunk]);
    if (buffer.length > 1_048_577) { abort(); return; }
    const newline = buffer.indexOf(10);
    if (newline < 0) return;
    try {
      const value = reply.parse(JSON.parse(buffer.subarray(0, newline).toString("utf8")));
      buffer = buffer.subarray(newline + 1);
      if (buffer.length || !pending || value.id !== pending.id) throw unavailable();
      if (value.id === 0) {
        if (value.protocol === undefined || value.result !== undefined || value.error !== undefined) throw unavailable();
        if (!helloMatchesDeclarations(value, declaredDefaults)) {
          unavailableReason = "governed_declarations_mismatch";
          console.error(`[component-failure] ${JSON.stringify({ site: "governed_hello", code: unavailableReason, declared: declaredDefaults.length })}`);
          throw unavailable();
        }
      } else if (value.protocol !== undefined || value.declared_defaults !== undefined || (Object.hasOwn(value, "result") === Object.hasOwn(value, "error"))) throw unavailable();
      // `rule_ids` names declared rules, so it belongs to that one class; on any other it is a contract violation.
      if (typeof value.error === "object" && value.error.rule_ids !== undefined && value.error.class !== "declared_default_missing") throw unavailable();
      const waiter = pending; pending = undefined;
      if (value.error !== undefined) waiter.reject(governedError(value.error, dialect, declared)); else waiter.resolve(value.result);
    } catch { abort(); }
  });
  if (options.signal.aborted) abort();
  const timer = setTimeout(abort, 10_000);
  try { await ready; await assertProject(); } catch (error) { await close(); throw error; }
  finally { clearTimeout(timer); }
  let tail = Promise.resolve();
  const execute = (payload: Record<string, unknown>, signal: AbortSignal): Promise<unknown> => {
    const operation = tail.then(async () => {
      signal.throwIfAborted();
      if (closed) throw unavailable();
      await assertProject();
      const input = JSON.stringify({ id: nextId, ...payload }) + "\n";
      if (Buffer.byteLength(input) > 65_536) throw unavailable();
      const result = new Promise<unknown>((resolve, reject) => { pending = { id: nextId++, resolve, reject }; });
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort(); else child.stdin.write(input);
      try {
        const value = await result;
        signal.throwIfAborted();
        await assertProject();
        return value;
      } catch (error) {
        if (error instanceof GovernedWrenError && payload["operation"] === "query") logRejectedQuery(payload["sql"], error);
        throw error;
      } finally { signal.removeEventListener("abort", abort); }
    });
    tail = operation.then(() => {}, () => {});
    return operation;
  };
  return {
    ...(dialect ? { sqlDialect: dialect } : {}),
    query: (input, signal) => execute({ operation: "query", ...input }, signal),
    inspect: (signal) => execute({ operation: "inspect" }, signal), close,
  };
}
