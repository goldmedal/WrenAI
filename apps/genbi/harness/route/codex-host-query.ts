import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import type { ComponentAccess } from "../components/broker.js";
import { COMPONENT_LIMITS } from "../components/runner.js";
import { GovernedWrenError, type GovernedErrorClass } from "../components/wren-access.js";

/**
 * One query the host executed for a codex:local turn, in the component runner's observation
 * shape (`input.sql`, `output` carrying a host `query_id`), so the shared grounding predicate
 * reads it unchanged.
 */
export interface HostQueryObservation {
  readonly tool: "run_sql";
  readonly input: { readonly sql: string; readonly limit: number };
  readonly output: unknown;
}

/**
 * Per-turn bounds. Count, request and per-result bytes reuse the component runner's limits;
 * the total caps what the host keeps in memory for one turn until its answer is grounded.
 * Rows default to 1000 like `run_sql`. Like `run_sql`, the host probes one row past the limit to
 * report truncation; the cap is 9999 so the probe stays within governed-stdio's 10000-row bound.
 */
export const CODEX_HOST_QUERY_LIMITS = Object.freeze({
  queries: COMPONENT_LIMITS.calls,
  requestBytes: COMPONENT_LIMITS.requestBytes,
  resultBytes: COMPONENT_LIMITS.resultBytes,
  totalResultBytes: 8 * COMPONENT_LIMITS.resultBytes,
  defaultRows: 1000,
  maxRows: 9_999,
  timeoutMs: COMPONENT_LIMITS.timeoutMs,
});

/** Error classes the socket may return; the proxy owns the sentence the model sees for each. */
export type HostQueryErrorClass = GovernedErrorClass | "unauthorized" | "budget_exhausted";

export interface CodexHostQueryService {
  /** A 0600 file holding this turn's socket path and token. Its own path carries no secret. */
  readonly credentialFile: string;
  /** This turn's recorded observations, in execution order. Empty after `close()`. */
  observations(): readonly HostQueryObservation[];
  /** Stops accepting queries, discards observations, closes governed access, removes the credential. */
  close(): Promise<void>;
}

export interface CodexHostQueryServiceOptions {
  /** Opens governed access for this turn; called at most once, on the first query. */
  readonly openAccess: (signal: AbortSignal) => Promise<ComponentAccess>;
  readonly signal?: AbortSignal;
}

interface RequestFrame { readonly token: unknown; readonly id: number; readonly sql: unknown; readonly limit: unknown }

function requestFrame(value: unknown): RequestFrame | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "number" || !Number.isSafeInteger(record.id)) return undefined;
  return { token: record.token, id: record.id, sql: record.sql, limit: record.limit };
}

/**
 * The host side of codex:local's `run_sql`: a per-turn unix socket in a fresh 0700 directory
 * that answers only requests carrying this turn's random token. Every query runs through
 * governed access (`wren governed-stdio`), gets a turn-unique host `query_id`, and is recorded
 * as an observation of this turn only.
 */
export async function openCodexHostQueryService(options: CodexHostQueryServiceOptions): Promise<CodexHostQueryService> {
  if (process.platform === "win32") throw new Error("codex:local host query service requires unix sockets");
  const directory = await mkdtemp(path.join(os.tmpdir(), "genbi-hq-"));
  const token = Buffer.from(randomBytes(32).toString("base64url"), "utf8");
  const turnTag = randomBytes(4).toString("hex");
  const socketPath = path.join(directory, "s");
  const credentialFile = path.join(directory, "credential.json");
  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  const recorded: HostQueryObservation[] = [];
  const sockets = new Set<Socket>();
  let attempts = 0;
  let recordedBytes = 0;
  let closed = false;
  let access: Promise<ComponentAccess> | undefined;

  const authorized = (candidate: unknown): boolean => {
    if (typeof candidate !== "string") return false;
    const presented = Buffer.from(candidate, "utf8");
    return presented.length === token.length && timingSafeEqual(presented, token);
  };

  const execute = async (sql: unknown, limit: unknown): Promise<{ result: unknown } | { error: HostQueryErrorClass }> => {
    if (closed || signal.aborted) return { error: "transport" };
    if (typeof sql !== "string" || !sql.trim() || Buffer.byteLength(sql) > CODEX_HOST_QUERY_LIMITS.requestBytes) return { error: "invalid_request" };
    if (limit !== undefined && limit !== null && (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1)) return { error: "invalid_request" };
    if (attempts >= CODEX_HOST_QUERY_LIMITS.queries) return { error: "budget_exhausted" };
    attempts += 1;
    const rows = Math.min(CODEX_HOST_QUERY_LIMITS.maxRows, typeof limit === "number" ? limit : CODEX_HOST_QUERY_LIMITS.defaultRows);
    let result: unknown;
    try {
      access ??= options.openAccess(signal);
      const governed = await access;
      result = await governed.query({ sql, limit: rows + 1 }, AbortSignal.any([signal, AbortSignal.timeout(CODEX_HOST_QUERY_LIMITS.timeoutMs)]));
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
    // tag makes ids unique per turn: an id copied from an earlier turn never names this turn's query.
    const output = { ...(result as Record<string, unknown>), rows: shown, row_count: shown.length, truncated, query_id: `q${attempts}-${turnTag}` };
    const bytes = Buffer.byteLength(JSON.stringify(output));
    if (bytes > CODEX_HOST_QUERY_LIMITS.resultBytes) return { error: "result_too_large" };
    if (recordedBytes + bytes > CODEX_HOST_QUERY_LIMITS.totalResultBytes) return { error: "budget_exhausted" };
    recordedBytes += bytes;
    recorded.push(Object.freeze({ tool: "run_sql", input: Object.freeze({ sql, limit: rows }), output: structuredClone(output) }));
    return { result: output };
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
      if (buffer.length > 2 * CODEX_HOST_QUERY_LIMITS.requestBytes) { socket.destroy(); return; }
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
          const outcome = await execute(sql, limit);
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
    await rm(directory, { recursive: true, force: true });
    throw error;
  }

  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closing ??= (async () => {
      closed = true;
      recorded.length = 0;
      controller.abort();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      try {
        if (access) await (await access).close();
      } catch {
        // Access that never opened, or already closed, has nothing left to release.
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    })();
    return closing;
  };
  options.signal?.addEventListener("abort", () => { void close(); }, { once: true });

  return {
    credentialFile,
    observations: () => Object.freeze([...recorded]),
    close,
  };
}
