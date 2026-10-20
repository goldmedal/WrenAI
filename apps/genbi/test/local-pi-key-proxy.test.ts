import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { LocalPiKeyProxy } from "../server/runtime-host/local-pi-key-proxy.js";
import { DUMMY_KEY, stubUpstream } from "./local-pi-fixture.js";

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function setup(options: { env?: NodeJS.ProcessEnv; maxRequestBytes?: number; deadlineMs?: number; reply?: Parameters<typeof stubUpstream>[0]; api?: "anthropic-messages" | "openai-completions" | "openai-responses"; prefix?: string } = {}) {
  const upstream = await stubUpstream(options.reply); cleanup.push(upstream.close);
  const proxy = new LocalPiKeyProxy({ env: () => options.env ?? { VENDOR_KEY: DUMMY_KEY }, ...(options.maxRequestBytes ? { maxRequestBytes: options.maxRequestBytes } : {}), ...(options.deadlineMs ? { deadlineMs: options.deadlineMs } : {}) });
  cleanup.push(() => proxy.close());
  const api = options.api ?? "openai-completions";
  const grant = await proxy.grant({ api, upstream: `${upstream.origin}${options.prefix ?? "/v1"}`, credentialEnv: "VENDOR_KEY" }, 60_000);
  const endpoint = api === "anthropic-messages" ? "/v1/messages" : api === "openai-responses" ? "/responses" : "/chat/completions";
  const send = (init: { path?: string; token?: string | null; method?: string; body?: string; headers?: Record<string, string>; host?: string } = {}) => new Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
    const url = new URL(grant.baseUrl);
    const headers: Record<string, string> = { "content-type": "application/json", ...(init.token === null ? {} : api === "anthropic-messages" ? { "x-api-key": init.token ?? grant.token } : { authorization: `Bearer ${init.token ?? grant.token}` }), ...init.headers };
    if (init.host) headers.host = init.host;
    const req = http.request({ host: url.hostname, port: url.port, method: init.method ?? "POST", path: init.path ?? `${url.pathname === "/" ? "" : url.pathname}${endpoint}`, headers }, (res) => {
      const chunks: Buffer[] = []; res.on("data", (c: Buffer) => chunks.push(c)); res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8"), headers: res.headers }));
    });
    req.on("error", reject); req.end(init.body ?? JSON.stringify({ hello: "world" }));
  });
  return { upstream, proxy, grant, send, endpoint };
}

describe("loopback key proxy", () => {
  it("listens on loopback only and not before the first grant", async () => {
    const proxy = new LocalPiKeyProxy(); cleanup.push(() => proxy.close());
    expect((proxy as unknown as { server: unknown }).server).toBeUndefined();
    const grant = await proxy.grant({ api: "openai-completions", upstream: "https://api.example.test/v1", credentialEnv: "K" }, 1000);
    expect(grant.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/);
    expect(grant.token).toMatch(/^[a-f0-9]{64}$/);
  });
  it("replaces the token with the real key, forwards to the pinned upstream and returns the answer", async () => {
    const { upstream, send } = await setup();
    const reply = await send({ headers: { "api-key": "client-supplied-key", "x-goog-api-key": "client-supplied-key", cookie: "a=b", "proxy-authorization": "x" } });
    expect(reply.status).toBe(200); expect(JSON.parse(reply.body)).toEqual({ ok: true });
    expect(upstream.seen).toHaveLength(1);
    const request = upstream.seen[0]!;
    expect(request.url).toBe("/v1/chat/completions");
    expect(request.headers.authorization).toBe(`Bearer ${DUMMY_KEY}`);
    expect(request.headers["x-api-key"]).toBeUndefined(); expect(request.headers["api-key"]).toBeUndefined(); expect(request.headers["x-goog-api-key"]).toBeUndefined(); expect(request.headers.cookie).toBeUndefined(); expect(request.headers["proxy-authorization"]).toBeUndefined();
    expect(request.body).toBe(JSON.stringify({ hello: "world" }));
  });
  it("uses x-api-key for the Anthropic wire", async () => {
    const { upstream, send } = await setup({ api: "anthropic-messages", prefix: "" });
    expect((await send({ headers: { "anthropic-version": "2023-06-01" } })).status).toBe(200);
    expect(upstream.seen[0]!.headers["x-api-key"]).toBe(DUMMY_KEY); expect(upstream.seen[0]!.headers.authorization).toBeUndefined();
    expect(upstream.seen[0]!.headers["anthropic-version"]).toBe("2023-06-01"); expect(upstream.seen[0]!.url).toBe("/v1/messages");
  });
  it("refuses an absent, malformed, unknown, revoked and expired token and never reaches the upstream", async () => {
    const { upstream, send, grant, proxy } = await setup();
    for (const token of [null, "short", "g".repeat(64), "0".repeat(64)]) expect((await send({ token })).status).toBe(401);
    grant.revoke(); expect(grant.active).toBe(false);
    expect((await send()).status).toBe(401);
    const short = await proxy.grant({ api: "openai-completions", upstream: `${upstream.origin}/v1`, credentialEnv: "VENDOR_KEY" }, 30);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(short.active).toBe(false);
    expect(upstream.seen).toHaveLength(0);
  });
  it("accepts the client credential only as a hashed lookup of a live token (the token is not the key)", async () => {
    const { send, grant } = await setup();
    expect((await send({ token: grant.token.toUpperCase() })).status).toBe(401);
    expect((await send({ token: DUMMY_KEY })).status).toBe(401);
  });
  it("pins the upstream: other paths, other methods, traversal, protocol-relative targets and foreign hosts are refused", async () => {
    const { upstream, send } = await setup();
    for (const target of ["/v1/models", "/v1/chat/completions/extra", "/v2/chat/completions", "//evil.example/v1/chat/completions", "/v1/../v2/chat/completions", "/v1\\chat/completions", "/chat/completions", "http://evil.example/v1/chat/completions"])
      expect((await send({ path: target })).status).toBe(404);
    expect((await send({ method: "GET" })).status).toBe(405);
    expect((await send({ host: "evil.example" })).status).toBe(400);
    expect(upstream.seen).toHaveLength(0);
  });
  it("never follows a redirect: the key cannot reach another origin", async () => {
    const other = await stubUpstream(); cleanup.push(other.close);
    const { send } = await setup({ reply: (_req, res) => { res.writeHead(307, { location: `${other.origin}/steal` }); res.end(); } });
    const reply = await send();
    expect(reply.status).toBe(502); expect(reply.body).toBe(JSON.stringify({ error: "upstream_redirect" }));
    expect(other.seen).toHaveLength(0);
  });
  it("delivers the first event before the stream ends", async () => {
    let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
    const f = await setup({ reply: (_req, res) => { res.writeHead(200, { "content-type": "text/event-stream" }); res.write("data: one\n\n"); void gate.then(() => { res.write("data: two\n\n"); res.end(); }); } });
    const url = new URL(f.grant.baseUrl);
    const first = await new Promise<string>((resolve, reject) => {
      const req = http.request({ host: url.hostname, port: url.port, method: "POST", path: `/v1/chat/completions`, headers: { authorization: `Bearer ${f.grant.token}` } }, (res) => {
        res.once("data", (chunk: Buffer) => { resolve(chunk.toString("utf8")); release(); res.resume(); });
      });
      req.on("error", reject); req.end("{}");
    });
    expect(first).toBe("data: one\n\n");
  });
  it("passes a complete event stream through with its content type", async () => {
    const { send } = await setup({ reply: (_req, res) => { res.writeHead(200, { "content-type": "text/event-stream" }); res.write("data: one\n\n"); setTimeout(() => { res.write("data: two\n\n"); res.end(); }, 20); } });
    const reply = await send();
    expect(reply.headers["content-type"]).toBe("text/event-stream"); expect(reply.body).toBe("data: one\n\ndata: two\n\n");
  });
  it("caps the request body", async () => {
    const { upstream, send } = await setup({ maxRequestBytes: 64 });
    expect((await send({ body: "x".repeat(65) })).status).toBe(413);
    expect((await send({ body: "x".repeat(64) })).status).toBe(200);
    expect(upstream.seen).toHaveLength(1);
  });
  it("caps a streamed body that declares no length", async () => {
    const f = await setup({ maxRequestBytes: 64 });
    const url = new URL(f.grant.baseUrl);
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request({ host: url.hostname, port: url.port, method: "POST", path: "/v1/chat/completions", headers: { authorization: `Bearer ${f.grant.token}`, "transfer-encoding": "chunked" } }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
      req.on("error", reject); req.write("x".repeat(40)); req.end("y".repeat(40));
    });
    expect(status).toBe(413); expect(f.upstream.seen).toHaveLength(0);
  });
  it("applies a deadline to a stalled upstream", async () => {
    const { send } = await setup({ deadlineMs: 150, reply: () => {} });
    expect((await send()).status).toBe(504);
  });
  it("revoking a grant aborts its in-flight request", async () => {
    let started!: () => void; const begun = new Promise<void>((resolve) => { started = resolve; });
    const f = await setup({ reply: (_req, res) => { res.writeHead(200); res.write("partial"); started(); } });
    const pending = f.send().then((r) => r.status, () => "reset");
    await begun; f.grant.revoke();
    expect(await Promise.race([pending, new Promise((resolve) => setTimeout(() => resolve("hung"), 2000))])).not.toBe("hung");
    expect(f.proxy.liveGrants).toBe(0);
  });
  it("reads the key at forward time only and refuses when it is missing or unsafe", async () => {
    const env: NodeJS.ProcessEnv = {};
    const f = await setup({ env });
    expect((await f.send()).status).toBe(502); expect(f.upstream.seen).toHaveLength(0);
    env.VENDOR_KEY = "bad key\r\nx-injected: 1"; expect((await f.send()).status).toBe(502);
    env.VENDOR_KEY = DUMMY_KEY; expect((await f.send()).status).toBe(200);
    expect(f.proxy.hasKey("VENDOR_KEY")).toBe(true); expect(f.proxy.hasKey("OTHER")).toBe(false);
    const before = f.proxy.keyFingerprint("VENDOR_KEY"); env.VENDOR_KEY = `${DUMMY_KEY}-2`; expect(f.proxy.keyFingerprint("VENDOR_KEY")).not.toBe(before);
    expect(before).not.toContain(DUMMY_KEY);
  });
  it("never logs, and its refusals carry fixed codes only", async () => {
    const logged: unknown[][] = [];
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((name) => { const original = console[name]; console[name] = (...args: unknown[]) => { logged.push(args); }; return () => { console[name] = original; }; });
    try { const f = await setup(); await f.send({ token: null }); await f.send({ path: "/nope" }); await f.send(); } finally { for (const restore of spies) restore(); }
    expect(logged).toEqual([]);
  });
  it("revokeAll and close end every grant", async () => {
    const f = await setup();
    f.proxy.revokeAll(); expect(f.grant.active).toBe(false); expect((await f.send()).status).toBe(401);
    await f.proxy.close(); await expect(f.proxy.grant({ api: "openai-completions", upstream: "https://x.test/v1", credentialEnv: "K" }, 1)).rejects.toThrow();
  });
});
