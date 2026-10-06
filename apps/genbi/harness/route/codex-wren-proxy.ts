#!/usr/bin/env node
/**
 * codex:local's Wren MCP server: a stdio proxy in front of `wren serve mcp`.
 *
 *   node codex-wren-proxy.js --credential-file <abs path> -- <wren> serve mcp --project <p> --quiet
 *
 * Every JSON-RPC line passes through to the child `wren serve mcp` unchanged, so the model sees
 * the same tool names and schemas, except a `tools/call` of `run_sql`: that goes to this turn's
 * host query service (see `codex-host-query.ts`), which executes it through governed access and
 * records it as host evidence. The credential file (0600, owned by this user) names the turn's
 * unix socket and token; without a valid one, `run_sql` is refused rather than run elsewhere.
 *
 * Node builtins only, and erasable TypeScript only, so it also runs from source.
 */
import { spawn } from "node:child_process";
import { closeSync, constants as fsConstants, fstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import { connect, type Socket } from "node:net";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const RUN_SQL = "run_sql";
const MAX_SQL_BYTES = 65_536;

/** The sentence the model sees per host error class; nothing from the host's wire is forwarded. */
const ERROR_TEXT: Readonly<Record<string, string>> = {
  invalid_request: "The request did not match the governed run_sql contract: pass a non-empty sql string and an optional positive integer limit.",
  model_not_found: "The query references a table that is not a model in the bound semantic context; query only the models it defines.",
  policy_rejected: "The read-only analytical policy rejected the query: use one SELECT that reads at least one bound model.",
  invalid_sql: "The SQL could not be parsed or planned against the semantic context.",
  execution_failed: "The data source rejected the query at execution time, for example an unknown column or a type mismatch.",
  timeout: "The query exceeded the statement time limit.",
  datasource_unavailable: "The bound data source could not be reached.",
  result_too_large: "The result exceeded the governed byte limit; narrow the query.",
  budget_exhausted: "This turn's query budget is exhausted; answer from the results you already have.",
  unauthorized: "run_sql is unavailable: the host query service rejected this session.",
  internal: "The governed query failed for an unclassified reason.",
  transport: "The host query service is unavailable.",
};
const NO_CREDENTIAL = "run_sql is unavailable: no valid host query credential was provided for this turn.";

export interface Credential { readonly socket: string; readonly token: string }
export interface HostOutcome { readonly result?: unknown; readonly error?: string }

/**
 * Accepts only an absolute, regular, user-owned file no one else can read or write. The file is
 * opened without following a symlink and checked and read through that one descriptor, so what
 * is checked is what is read.
 */
export function readCredential(file: string | undefined): Credential | undefined {
  if (!file || !path.isAbsolute(file)) return undefined;
  let fd: number | undefined;
  try {
    fd = openSync(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0) return undefined;
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) return undefined;
    const value = JSON.parse(readFileSync(fd, "utf8")) as Record<string, unknown>;
    if (typeof value.socket !== "string" || !path.isAbsolute(value.socket)) return undefined;
    if (typeof value.token !== "string" || value.token.length < 32) return undefined;
    return { socket: value.socket, token: value.token };
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * One connection at a time to the turn's host query service, reconnecting after a drop. Only
 * the current socket's failure fails the pending requests (all of which were sent on it): a
 * stale socket closing late never fails a request pending on its replacement. Each socket has
 * its own read buffer.
 */
export class HostConnection {
  private readonly credential: Credential;
  private readonly open: (socketPath: string) => Socket;
  private readonly pending = new Map<number, (outcome: HostOutcome) => void>();
  private socket: Socket | undefined;
  private nextId = 1;

  constructor(credential: Credential, open: (socketPath: string) => Socket = connect) {
    this.credential = credential;
    this.open = open;
  }

  request(sql: string, limit: number | undefined): Promise<HostOutcome> {
    return new Promise((resolve) => {
      const id = this.nextId++;
      try {
        const socket = this.current();
        this.pending.set(id, resolve);
        socket.write(`${JSON.stringify({ token: this.credential.token, id, sql, ...(limit !== undefined ? { limit } : {}) })}\n`);
      } catch {
        this.pending.delete(id);
        resolve({ error: "transport" });
      }
    });
  }

  close(): void {
    this.socket?.end();
  }

  private current(): Socket {
    if (this.socket && !this.socket.destroyed) return this.socket;
    const socket = this.open(this.credential.socket);
    let buffer = "";
    const fail = (): void => {
      if (this.socket !== socket) return;
      this.socket = undefined;
      for (const waiter of this.pending.values()) waiter({ error: "transport" });
      this.pending.clear();
    };
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        try {
          const frame = JSON.parse(line) as { id?: unknown; result?: unknown; error?: { class?: unknown } };
          const waiter = typeof frame.id === "number" ? this.pending.get(frame.id) : undefined;
          if (!waiter || typeof frame.id !== "number") continue;
          this.pending.delete(frame.id);
          if (frame.error !== undefined) waiter({ error: typeof frame.error?.class === "string" ? frame.error.class : "internal" });
          else waiter({ result: frame.result });
        } catch {
          socket.destroy();
        }
      }
    });
    socket.on("error", fail);
    socket.on("close", fail);
    this.socket = socket;
    return socket;
  }
}

function parseArgs(argv: readonly string[]): { credentialFile?: string; command: string; args: string[] } {
  const separator = argv.indexOf("--");
  if (separator < 0 || separator === argv.length - 1) {
    process.stderr.write("codex wren proxy: usage: --credential-file <path> -- <command> [args...]\n");
    process.exit(2);
  }
  const own = argv.slice(0, separator);
  const index = own.indexOf("--credential-file");
  const credentialFile = index >= 0 ? own[index + 1] : undefined;
  return { ...(credentialFile !== undefined ? { credentialFile } : {}), command: argv[separator + 1]!, args: argv.slice(separator + 2) };
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  const credential = readCredential(options.credentialFile);
  const host = credential ? new HostConnection(credential) : undefined;

  const child = spawn(options.command, options.args, { stdio: ["pipe", "pipe", "inherit"] });
  child.on("error", (error) => {
    process.stderr.write(`codex wren proxy: could not start the Wren MCP server: ${error.message}\n`);
    process.exit(1);
  });
  child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));

  const send = (line: string): void => { process.stdout.write(`${line}\n`); };
  createInterface({ input: child.stdout, crlfDelay: Infinity }).on("line", send);

  const toolResult = (id: unknown, text: string, isError: boolean, structured?: unknown): void => {
    send(JSON.stringify({ jsonrpc: "2.0", id, result: {
      content: [{ type: "text", text }],
      ...(structured !== undefined ? { structuredContent: structured } : {}),
      isError,
    } }));
  };

  const runSql = async (id: unknown, input: unknown): Promise<void> => {
    if (!host) { toolResult(id, NO_CREDENTIAL, true); return; }
    const args = typeof input === "object" && input !== null && !Array.isArray(input) ? input as Record<string, unknown> : {};
    const { sql, limit } = args;
    if (typeof sql !== "string" || !sql.trim() || Buffer.byteLength(sql) > MAX_SQL_BYTES
      || (limit !== undefined && limit !== null && (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1))) {
      toolResult(id, ERROR_TEXT.invalid_request!, true);
      return;
    }
    const outcome = await host.request(sql, typeof limit === "number" ? limit : undefined);
    if (outcome.error !== undefined) {
      const known = outcome.error in ERROR_TEXT ? outcome.error : "internal";
      toolResult(id, `Governed Wren query failed [${known}]: ${ERROR_TEXT[known]}`, true);
      return;
    }
    toolResult(id, JSON.stringify(outcome.result), false, outcome.result);
  };

  createInterface({ input: process.stdin, crlfDelay: Infinity })
    .on("line", (line) => {
      let message: { id?: unknown; method?: unknown; params?: { name?: unknown; arguments?: unknown } } | undefined;
      try { message = JSON.parse(line) as typeof message; } catch { message = undefined; }
      if (message && message.method === "tools/call" && message.id !== undefined && message.params?.name === RUN_SQL) {
        void runSql(message.id, message.params.arguments);
        return;
      }
      child.stdin.write(`${line}\n`);
    })
    .on("close", () => {
      child.stdin.end();
      host?.close();
    });
}

function invokedDirectly(): boolean {
  if (process.argv[1] === undefined) return false;
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
}

if (invokedDirectly()) main();
