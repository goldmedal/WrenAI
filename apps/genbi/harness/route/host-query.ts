import { randomBytes, timingSafeEqual } from "node:crypto";
import { accessSync, existsSync, constants as fsConstants } from "node:fs";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ComponentAccess } from "../components/broker.js";
import { COMPONENT_LIMITS } from "../components/runner.js";
import { GovernedWrenError, type GovernedErrorClass } from "../components/wren-access.js";
import type { ResolvedCli } from "./agent-sdk-cli.js";

/**
 * One query the host executed for a subscription turn or a native session, in the component
 * runner's observation shape (`input.sql`, `output` carrying a host `query_id`), so the shared
 * grounding predicate reads it unchanged.
 */
export interface HostQueryObservation {
  readonly tool: "run_sql";
  readonly input: { readonly sql: string; readonly limit: number };
  readonly output: unknown;
}

/**
 * Per-scope bounds (one Ask turn, or one native session). Count, request and per-result bytes
 * reuse the component runner's limits; the total caps what the host keeps in memory for one scope
 * until its answer is grounded. Rows default to 1000 like `run_sql`. Like `run_sql`, the host
 * probes one row past the limit to report truncation; the cap is 9999 so the probe stays within
 * governed-stdio's 10000-row bound.
 */
export const HOST_QUERY_LIMITS = Object.freeze({
  queries: COMPONENT_LIMITS.calls,
  requestBytes: COMPONENT_LIMITS.requestBytes,
  resultBytes: COMPONENT_LIMITS.resultBytes,
  totalResultBytes: 8 * COMPONENT_LIMITS.resultBytes,
  defaultRows: 1000,
  maxRows: 9_999,
  timeoutMs: COMPONENT_LIMITS.timeoutMs,
});

/** Error classes a host query may return; each transport owns the sentence the model sees. */
export type HostQueryErrorClass = GovernedErrorClass | "unauthorized" | "budget_exhausted";

export type HostQueryOutcome = { readonly result: unknown } | { readonly error: HostQueryErrorClass };

export interface HostQueryRecorderOptions {
  /** Opens governed access for this scope; called at most once, on the first query. */
  readonly openAccess: (signal: AbortSignal) => Promise<ComponentAccess>;
  readonly signal?: AbortSignal;
}

/**
 * Executes and records one scope's queries in process. The scope is the recorder: its
 * observations are never shared, and its `query_id`s carry a tag no other recorder has.
 */
export interface HostQueryRecorder {
  execute(sql: unknown, limit: unknown): Promise<HostQueryOutcome>;
  /** This scope's recorded observations, in execution order. Empty after `close()`. */
  observations(): readonly HostQueryObservation[];
  /** Stops accepting queries, discards observations, closes governed access. Idempotent. */
  close(): Promise<void>;
}

/**
 * Every query runs through governed access (`wren governed-stdio`), gets a scope-unique host
 * `query_id` (`q<N>-<tag>`), and is recorded as an observation of this scope only.
 */
export function createHostQueryRecorder(options: HostQueryRecorderOptions): HostQueryRecorder {
  const tag = randomBytes(4).toString("hex");
  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  const recorded: HostQueryObservation[] = [];
  let attempts = 0;
  let recordedBytes = 0;
  let closed = false;
  let access: Promise<ComponentAccess> | undefined;

  const execute = async (sql: unknown, limit: unknown): Promise<HostQueryOutcome> => {
    if (closed || signal.aborted) return { error: "transport" };
    if (typeof sql !== "string" || !sql.trim() || Buffer.byteLength(sql) > HOST_QUERY_LIMITS.requestBytes) return { error: "invalid_request" };
    if (limit !== undefined && limit !== null && (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1)) return { error: "invalid_request" };
    if (attempts >= HOST_QUERY_LIMITS.queries) return { error: "budget_exhausted" };
    attempts += 1;
    const rows = Math.min(HOST_QUERY_LIMITS.maxRows, typeof limit === "number" ? limit : HOST_QUERY_LIMITS.defaultRows);
    let result: unknown;
    try {
      access ??= options.openAccess(signal);
      const governed = await access;
      result = await governed.query({ sql, limit: rows + 1 }, AbortSignal.any([signal, AbortSignal.timeout(HOST_QUERY_LIMITS.timeoutMs)]));
    } catch (error) {
      return { error: error instanceof GovernedWrenError ? error.errorClass : "transport" };
    }
    if (closed) return { error: "transport" };
    if (typeof result !== "object" || result === null || Array.isArray(result)) return { error: "internal" };
    const probed = (result as Record<string, unknown>).rows;
    if (!Array.isArray(probed)) return { error: "internal" };
    // The N+1 probe, as plain `run_sql` reports it: more rows than asked means the shown rows
    // are not the whole result. Only `rows` rows are returned and recorded.
    const truncated = probed.length > rows;
    const shown = truncated ? probed.slice(0, rows) : probed;
    // The id is assigned here, once, so the observation and the model's copy carry the same id. The
    // tag makes ids unique per scope: an id copied from another turn or session never names this one's query.
    const output = { ...(result as Record<string, unknown>), rows: shown, row_count: shown.length, truncated, query_id: `q${attempts}-${tag}` };
    const bytes = Buffer.byteLength(JSON.stringify(output));
    if (bytes > HOST_QUERY_LIMITS.resultBytes) return { error: "result_too_large" };
    if (recordedBytes + bytes > HOST_QUERY_LIMITS.totalResultBytes) return { error: "budget_exhausted" };
    recordedBytes += bytes;
    recorded.push(Object.freeze({ tool: "run_sql", input: Object.freeze({ sql, limit: rows }), output: structuredClone(output) }));
    return { result: output };
  };

  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closing ??= (async () => {
      closed = true;
      recorded.length = 0;
      controller.abort();
      try {
        if (access) await (await access).close();
      } catch {
        // Access that never opened, or already closed, has nothing left to release.
      }
    })();
    return closing;
  };
  options.signal?.addEventListener("abort", () => { void close(); }, { once: true });

  return { execute, observations: () => Object.freeze([...recorded]), close };
}

export interface HostQueryService {
  /** This service's private 0700 directory; it is removed on `close()`. */
  readonly directory: string;
  /** A 0600 file holding this turn's socket path and token. Its own path carries no secret. */
  readonly credentialFile: string;
  /** This turn's recorded observations, in execution order. Empty after `close()`. */
  observations(): readonly HostQueryObservation[];
  /** Stops accepting queries, discards observations, closes governed access, removes the directory. */
  close(): Promise<void>;
}

export type HostQueryServiceOptions = HostQueryRecorderOptions;

interface RequestFrame { readonly token: unknown; readonly id: number; readonly sql: unknown; readonly limit: unknown }

function requestFrame(value: unknown): RequestFrame | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "number" || !Number.isSafeInteger(record.id)) return undefined;
  return { token: record.token, id: record.id, sql: record.sql, limit: record.limit };
}

/**
 * The host side of a subscription turn's `run_sql` (codex:local and the Claude agent-sdk Ask):
 * a per-turn unix socket in a fresh 0700 directory that answers only requests carrying this
 * turn's random token, in front of one {@link createHostQueryRecorder} for the turn.
 */
export async function openHostQueryService(options: HostQueryServiceOptions): Promise<HostQueryService> {
  if (process.platform === "win32") throw new Error("the host query service requires unix sockets");
  const directory = await mkdtemp(path.join(os.tmpdir(), "genbi-hq-"));
  const token = Buffer.from(randomBytes(32).toString("base64url"), "utf8");
  const socketPath = path.join(directory, "s");
  const credentialFile = path.join(directory, "credential.json");
  const recorder = createHostQueryRecorder(options);
  const sockets = new Set<Socket>();
  let closed = false;

  const authorized = (candidate: unknown): boolean => {
    if (typeof candidate !== "string") return false;
    const presented = Buffer.from(candidate, "utf8");
    return presented.length === token.length && timingSafeEqual(presented, token);
  };

  const serve = (socket: Socket): void => {
    if (closed) { socket.destroy(); return; }
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => socket.destroy());
    let buffer = "";
    let tail = Promise.resolve();
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (buffer.length > 2 * HOST_QUERY_LIMITS.requestBytes) { socket.destroy(); return; }
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        let frame: RequestFrame | undefined;
        try { frame = requestFrame(JSON.parse(line)); } catch { frame = undefined; }
        if (!frame) { socket.destroy(); return; }
        const { id, sql, limit } = frame;
        if (!authorized(frame.token)) {
          socket.end(`${JSON.stringify({ id, error: { class: "unauthorized" } })}\n`);
          return;
        }
        tail = tail.then(async () => {
          const outcome = await recorder.execute(sql, limit);
          if (socket.destroyed) return;
          socket.write(`${JSON.stringify("result" in outcome ? { id, result: outcome.result } : { id, error: { class: outcome.error } })}\n`);
        }).catch(() => { socket.destroy(); });
      }
    });
  };

  const server: Server = createServer(serve);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => { server.off("error", reject); resolve(); });
    });
    await chmod(socketPath, 0o600);
    await writeFile(credentialFile, JSON.stringify({ socket: socketPath, token: token.toString("utf8") }), { encoding: "utf8", mode: 0o600, flag: "wx" });
  } catch (error) {
    server.close();
    await recorder.close();
    await rm(directory, { recursive: true, force: true });
    throw error;
  }

  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closing ??= (async () => {
      closed = true;
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      try {
        await recorder.close();
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    })();
    return closing;
  };
  options.signal?.addEventListener("abort", () => { void close(); }, { once: true });

  return { directory, credentialFile, observations: recorder.observations, close };
}

/**
 * The argv after the proxy command: the proxy script, this turn's credential file, then the
 * `wren serve mcp` command it fronts. Shared by codex:local's `--server-arg`s and the agent-sdk
 * host MCP config so the two cannot drift.
 */
export function wrenHostProxyArgs(options: {
  readonly proxy: ResolvedCli;
  readonly credentialFile: string;
  readonly mcpServer: ResolvedCli;
  readonly userProject: string;
}): string[] {
  return [
    ...options.proxy.prefixArgs,
    "--credential-file",
    options.credentialFile,
    "--",
    options.mcpServer.command,
    ...options.mcpServer.prefixArgs,
    "serve",
    "mcp",
    "--project",
    options.userProject,
    "--quiet",
  ];
}

/** The built proxy next to this module, else its source (Node strips its erasable types). */
export function defaultWrenHostProxy(): ResolvedCli {
  const built = fileURLToPath(new URL("./wren-host-proxy.js", import.meta.url));
  const script = existsSync(built) ? built : fileURLToPath(new URL("./wren-host-proxy.ts", import.meta.url));
  return { command: process.execPath, prefixArgs: [script] };
}

/** Governed access spawns one executable with fixed arguments; a prefixed command cannot be bound. */
export function singleWrenExecutable(cli: ResolvedCli): string {
  if (cli.prefixArgs.length > 0) throw new Error("host queries need a standalone wren executable");
  return cli.command;
}

export function resolveExecutableOnPath(name: string): string {
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, name);
    try {
      accessSync(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // Keep searching.
    }
  }
  throw new Error(`could not find the "${name}" executable on PATH`);
}
