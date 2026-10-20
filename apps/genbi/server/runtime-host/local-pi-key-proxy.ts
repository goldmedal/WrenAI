import { createHash, randomBytes } from "node:crypto";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import type { LocalPiApi, LocalPiRoute } from "./local-pi-endpoint.js";
import { canonicalUpstream } from "./local-pi-endpoint.js";

/**
 * Loopback key proxy for the local pi runtime. pi is given a per-step token as its "API key" and the proxy URL as its endpoint; the real vendor
 * key exists only in this module, read from the environment at forward time, and is attached to forwarded requests only.
 *
 * It forwards to exactly one upstream origin and path prefix per grant, to one endpoint of the grant's wire api, never follows a redirect (a redirect
 * would carry the key to another origin), strips every client credential and hop-by-hop header, caps the request body, applies deadlines and
 * streams the response through. It never logs and never relays an error text: failures are fixed codes.
 */
const MAX_REQUEST_BYTES = 8 * 1024 * 1024;
const DEFAULT_DEADLINE_MS = 120_000;
const FORWARD_HEADERS = ["content-type", "accept", "accept-language", "anthropic-version", "anthropic-beta", "openai-beta", "user-agent", "x-stainless-lang", "x-stainless-package-version", "x-stainless-os", "x-stainless-arch", "x-stainless-runtime", "x-stainless-runtime-version", "x-stainless-retry-count", "x-stainless-timeout"] as const;
const STRIP_RESPONSE = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade", "content-length", "content-encoding", "set-cookie"]);
const KEY_SHAPE = /^[\x21-\x7e]{1,4096}$/;
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

export interface ProxyGrant {
  /** What pi is told as its endpoint: the loopback origin plus the upstream's own path prefix. */
  readonly baseUrl: string;
  /** What pi is told as its API key. */
  readonly token: string;
  revoke(): void;
  readonly active: boolean;
}
export interface LocalPiKeyProxyOptions {
  /** Read at forward time only; the proxy never keeps a copy of a key. */
  readonly env?: () => NodeJS.ProcessEnv;
  readonly fetch?: typeof fetch;
  readonly maxRequestBytes?: number;
  readonly deadlineMs?: number;
}
interface Grant {
  readonly route: LocalPiRoute;
  readonly origin: string;
  readonly allowed: ReadonlySet<string>;
  readonly controller: AbortController;
  readonly sockets: Set<Socket>;
  revoked: boolean;
}

const allowedPaths = (api: LocalPiApi, prefix: string): ReadonlySet<string> =>
  new Set([api === "anthropic-messages" ? `${prefix}/v1/messages` : api === "openai-completions" ? `${prefix}/chat/completions` : `${prefix}/responses`]);

export class LocalPiKeyProxy {
  private server: http.Server | undefined;
  private starting: Promise<number> | undefined;
  private port = 0;
  private closed = false;
  private readonly grants = new Map<string, Grant>();
  private readonly options: Required<Pick<LocalPiKeyProxyOptions, "maxRequestBytes" | "deadlineMs">> & LocalPiKeyProxyOptions;

  constructor(options: LocalPiKeyProxyOptions = {}) {
    this.options = { maxRequestBytes: MAX_REQUEST_BYTES, deadlineMs: DEFAULT_DEADLINE_MS, ...options };
  }

  /** Number of live grants; tests and shutdown use it. */
  get liveGrants(): number { return this.grants.size; }
  /** True when the key variable currently holds a usable value. The value itself never leaves this module. */
  hasKey(name: string): boolean {
    const value = (this.options.env?.() ?? process.env)[name];
    return typeof value === "string" && KEY_SHAPE.test(value.trim());
  }
  /** A stable fingerprint of the current key, for change detection only. Never log it. */
  keyFingerprint(name: string): string {
    const value = (this.options.env?.() ?? process.env)[name];
    return value === undefined ? "absent" : sha256(`key:${value}`);
  }

  private ensureStarted(): Promise<number> {
    if (this.closed) return Promise.reject(new Error("closed"));
    this.starting ??= new Promise<number>((resolve, reject) => {
      const server = http.createServer({ maxHeaderSize: 16 * 1024 }, (req, res) => { void this.handle(req, res); });
      server.requestTimeout = 30_000; server.headersTimeout = 10_000; server.keepAliveTimeout = 2_000;
      server.on("clientError", (_error, socket) => { socket.destroy(); });
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => { this.server = server; this.port = (server.address() as { port: number }).port; resolve(this.port); });
    });
    return this.starting;
  }

  /** One fresh token and one upstream route. Expires on its own at `ttlMs` and is revoked by `revoke()`. */
  async grant(route: LocalPiRoute, ttlMs: number): Promise<ProxyGrant> {
    const upstream = canonicalUpstream(route.upstream);
    const url = new URL(upstream);
    const prefix = url.pathname === "/" ? "" : url.pathname;
    const port = await this.ensureStarted();
    const token = randomBytes(32).toString("hex");
    const key = sha256(token);
    const grant: Grant = { route: { ...route, upstream }, origin: url.origin, allowed: allowedPaths(route.api, prefix), controller: new AbortController(), sockets: new Set(), revoked: false };
    this.grants.set(key, grant);
    const revoke = () => {
      if (grant.revoked) return;
      grant.revoked = true; this.grants.delete(key); grant.controller.abort();
      for (const socket of grant.sockets) socket.destroy();
      grant.sockets.clear(); clearTimeout(timer);
    };
    const timer = setTimeout(revoke, ttlMs); timer.unref();
    return Object.freeze({ baseUrl: `http://127.0.0.1:${port}${prefix}`, token, revoke, get active() { return !grant.revoked; } });
  }

  /** Revokes every grant (settings, binding or key change); the listener stays for later grants. */
  revokeAll(): void {
    for (const grant of [...this.grants.values()]) { grant.revoked = true; grant.controller.abort(); for (const socket of grant.sockets) socket.destroy(); grant.sockets.clear(); }
    this.grants.clear();
  }

  async close(): Promise<void> {
    this.closed = true; this.revokeAll();
    const server = this.server; this.server = undefined;
    if (!server) return;
    await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
  }

  private reply(res: ServerResponse, status: number, code: string): void {
    if (res.headersSent) { res.destroy(); return; }
    const body = JSON.stringify({ error: code });
    res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body), connection: "close" });
    res.end(body);
  }

  private authenticate(req: IncomingMessage): Grant | undefined {
    const bearer = /^Bearer ([A-Za-z0-9]{64})$/.exec(String(req.headers.authorization ?? ""))?.[1];
    const header = req.headers["x-api-key"];
    const token = typeof header === "string" ? header : bearer;
    if (typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token)) return undefined;
    const grant = this.grants.get(sha256(token));
    return grant && !grant.revoked ? grant : undefined;
  }

  private async readBody(req: IncomingMessage): Promise<Buffer | undefined> {
    const limit = this.options.maxRequestBytes;
    const declared = Number(req.headers["content-length"] ?? 0);
    if (Number.isFinite(declared) && declared > limit) return undefined;
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > limit) return undefined;
      chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks);
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const grant = this.authenticate(req);
    if (!grant) { this.reply(res, 401, "unauthorized"); return; }
    if (req.headers.host !== `127.0.0.1:${this.port}`) { this.reply(res, 400, "bad_host"); return; }
    if (req.method !== "POST") { this.reply(res, 405, "method_not_allowed"); return; }
    const raw = req.url ?? "";
    if (!raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\") || raw.length > 4096) { this.reply(res, 404, "not_found"); return; }
    let target: URL;
    try { target = new URL(raw, grant.origin); } catch { this.reply(res, 404, "not_found"); return; }
    if (target.origin !== grant.origin || !grant.allowed.has(target.pathname)) { this.reply(res, 404, "not_found"); return; }
    grant.sockets.add(req.socket);
    res.on("close", () => grant.sockets.delete(req.socket));
    const body = await this.readBody(req).catch(() => undefined);
    if (body === undefined) { this.reply(res, 413, "request_too_large"); return; }
    if (grant.revoked) { this.reply(res, 401, "unauthorized"); return; }
    // The key is read here, at forward time, and lives only in this local variable.
    const keyValue = (this.options.env?.() ?? process.env)[grant.route.credentialEnv]?.trim();
    if (keyValue === undefined || !KEY_SHAPE.test(keyValue)) { this.reply(res, 502, "key_unavailable"); return; }
    const headers = new Headers();
    for (const name of FORWARD_HEADERS) { const value = req.headers[name]; if (typeof value === "string") headers.set(name, value); }
    if (grant.route.api === "anthropic-messages") headers.set("x-api-key", keyValue); else headers.set("authorization", `Bearer ${keyValue}`);
    const clientGone = new AbortController();
    res.on("close", () => { if (!res.writableFinished) clientGone.abort(); });
    const signal = AbortSignal.any([grant.controller.signal, clientGone.signal, AbortSignal.timeout(this.options.deadlineMs)]);
    let upstream: Response;
    try {
      upstream = await (this.options.fetch ?? fetch)(target, { method: "POST", headers, body: new Uint8Array(body), redirect: "manual", signal });
    } catch { this.reply(res, signal.aborted ? 504 : 502, signal.aborted ? "upstream_timeout" : "upstream_unavailable"); return; }
    if (upstream.status >= 300 && upstream.status < 400) { await upstream.body?.cancel().catch(() => {}); this.reply(res, 502, "upstream_redirect"); return; }
    const out: Record<string, string> = {};
    upstream.headers.forEach((value, name) => { if (!STRIP_RESPONSE.has(name.toLowerCase())) out[name] = value; });
    res.writeHead(upstream.status, out);
    try {
      const reader = upstream.body?.getReader();
      if (reader) for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (signal.aborted) { await reader.cancel().catch(() => {}); break; }
        if (!res.write(value)) await new Promise<void>((resolve) => { res.once("drain", resolve); res.once("close", resolve); });
      }
      res.end();
    } catch { res.destroy(); }
  }
}
