import { request } from "node:https";
import { z } from "zod";

export const hostIdentitySchema = z.object({ accountUuid: z.uuid(), organizationUuid: z.uuid(), email: z.email().max(320), subscription: z.enum(["pro", "max", "team", "enterprise"]) }).strict();
export type ClaudeHostIdentity = z.infer<typeof hostIdentitySchema>;
export const credentialSchema = z.object({ accessToken: z.string().min(16).max(8192).regex(/^[A-Za-z0-9._~-]+$/), refreshToken: z.string().min(16).max(8192).regex(/^[A-Za-z0-9._~-]+$/), expiresAt: z.number().int().positive() }).strict();
export type HostCredential = z.infer<typeof credentialSchema>;
export const HOST_ENDPOINTS = Object.freeze({ refresh: "https://platform.claude.com/v1/oauth/token", profile: "https://api.anthropic.com/api/oauth/profile", client: "9d1c250a-e61b-44d9-88ed-5944d1962f5e" });
export class HostVerificationFault extends Error { constructor(readonly code: "refresh" | "profile" | "timeout") { super(`Claude host ${code}`); } }
type Transport = (url: string, init: RequestInit) => Promise<Response>;
/** Dedicated HTTPS sockets ignore ambient fetch dispatchers, proxies and endpoint overrides. */
const direct: Transport = (url, init) => new Promise((resolve, reject) => {
  const req = request(url, { method: init.method, headers: init.headers as Record<string, string>, agent: false, signal: init.signal ?? undefined }, res => {
    // Reject before constructing a Web Response: 204/205/304 cannot carry a body.
    if (res.statusCode !== 200) { res.destroy(); req.destroy(); reject(new Error()); return; }
    let bytes = 0;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        res.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes > 32768) { controller.error(new Error()); res.destroy(); } else controller.enqueue(chunk); });
        res.once("end", () => controller.close()); res.once("error", () => { try { controller.error(new Error()); } catch { /* already closed */ } });
      }, cancel() { res.destroy(); req.destroy(); },
    });
    resolve(new Response(stream, { status: res.statusCode ?? 500, headers: res.headers as Record<string, string> }));
  });
  req.once("error", () => reject(new Error())); req.end(init.body as string | undefined);
});

async function stage(transport: Transport, url: string, init: RequestInit, outer: AbortSignal, deadline: number, code: "refresh" | "profile"): Promise<unknown> {
  const controller = new AbortController(); const signal = AbortSignal.any([outer, controller.signal]);
  const timer = setTimeout(() => controller.abort(), deadline);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let rejectAbort!: () => void;
  const abort = new Promise<never>((_, reject) => { rejectAbort = () => reject(new HostVerificationFault("timeout")); signal.addEventListener("abort", rejectAbort, { once: true }); if (signal.aborted) rejectAbort(); });
  void abort.catch(() => {});
  const wait = <T>(value: Promise<T>) => Promise.race([value, abort]);
  try {
    signal.throwIfAborted();
    const pending = transport(url, { ...init, redirect: "error", signal });
    // A broken injected transport may return after cancellation; cancel its late body too.
    void pending.then(res => { if (signal.aborted) void res.body?.cancel().catch(() => {}); }, () => {});
    const response = await wait(pending);
    if (response.status !== 200 || !response.body || (response.headers.get("content-encoding") ?? "identity") !== "identity") throw new Error();
    reader = response.body.getReader(); let bytes = 0; const chunks: Uint8Array[] = [];
    while (true) { const chunk = await wait(reader.read()); if (chunk.done) break; bytes += chunk.value.byteLength; if (bytes > 32768) throw new Error(); chunks.push(chunk.value); }
    signal.throwIfAborted(); return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
  } catch (error) { throw new HostVerificationFault(error instanceof HostVerificationFault ? error.code : code); }
  finally { clearTimeout(timer); signal.removeEventListener("abort", rejectAbort); controller.abort(); void reader?.cancel().catch(() => {}); }
}

const receipts = new WeakMap<object, Readonly<{ bundle: HostCredential; identity: ClaudeHostIdentity; organizationName?: string; scopes: readonly string[] }>>();
export interface HostVerificationReceipt { readonly opaque: true }
export function readHostVerificationReceipt(receipt: HostVerificationReceipt) {
  const value = receipts.get(receipt); if (!value) throw new HostVerificationFault("profile"); return value;
}
function verifier(transport: Transport, now: () => number, deadline: number) {
  return async (refresh: string, signal: AbortSignal, assertCurrent: () => void = () => {}): Promise<HostVerificationReceipt> => {
    let refreshCredential: string; try { refreshCredential = credentialSchema.shape.refreshToken.parse(refresh); } catch { throw new HostVerificationFault("refresh"); }
    const raw = await stage(transport, HOST_ENDPOINTS.refresh, { method: "POST", headers: { "content-type": "application/json", "accept": "application/json", "accept-encoding": "identity" }, body: JSON.stringify({ grant_type: "refresh_token", refresh_token: refreshCredential, client_id: HOST_ENDPOINTS.client, scope: "user:profile user:inference" }) }, signal, deadline, "refresh");
    assertCurrent();
    let bundle: HostCredential;
    try {
      const parsed = z.object({ access_token: credentialSchema.shape.accessToken, refresh_token: credentialSchema.shape.refreshToken.optional(), expires_in: z.number().int().min(136).max(86400), scope: z.string().max(2048), token_type: z.literal("Bearer") }).parse(raw);
      if (parsed.scope !== "user:profile user:inference" && parsed.scope !== "user:inference user:profile") throw new Error();
      bundle = Object.freeze({ accessToken: parsed.access_token, refreshToken: parsed.refresh_token ?? refresh, expiresAt: now() + parsed.expires_in * 1000 });
    } catch { throw new HostVerificationFault("refresh"); }
    if (signal.aborted) throw new HostVerificationFault("timeout");
    const profile = await stage(transport, HOST_ENDPOINTS.profile, { method: "GET", headers: { authorization: `Bearer ${bundle.accessToken}`, accept: "application/json", "accept-encoding": "identity", "cache-control": "no-cache", pragma: "no-cache" } }, signal, deadline, "profile");
    assertCurrent();
    try {
      const parsed = z.object({ account: z.object({ uuid: z.uuid(), email: z.email().max(320) }), organization: z.object({ uuid: z.uuid(), organization_type: z.enum(["claude_pro", "claude_max", "claude_team", "claude_enterprise"]), name: z.string().min(1).max(256).optional() }) }).parse(profile);
      const subscription = { claude_pro: "pro", claude_max: "max", claude_team: "team", claude_enterprise: "enterprise" } as const;
      const identity = Object.freeze(hostIdentitySchema.parse({ accountUuid: parsed.account.uuid, organizationUuid: parsed.organization.uuid, email: parsed.account.email, subscription: subscription[parsed.organization.organization_type] }));
      const receipt = Object.freeze({ opaque: true as const }); receipts.set(receipt, Object.freeze({ bundle, identity, ...(parsed.organization.name ? { organizationName: parsed.organization.name } : {}), scopes: Object.freeze(["user:inference", "user:profile"]) })); return receipt;
    } catch { throw new HostVerificationFault("profile"); }
  };
}
export const createClaudeHostVerifier = () => verifier(direct, Date.now, 10000);
/** Trusted host test code only. Never selected by production config, HTTP input or environment. */
export const createClaudeHostVerifierForTesting = (transport: Transport, options: { now?: () => number; stageDeadlineMs?: number } = {}) => verifier(transport, options.now ?? Date.now, Math.min(options.stageDeadlineMs ?? 10000, 10000));
