import { z } from "zod";
import type { ClaudeIdentity } from "./claude-account-vault.js";
import type { ClaudeComponentRuntime } from "./claude-component-step.js";
/** No prompt/model call: pinned direct SDK initialization observes actual accountInfo.
 * Operator must explicitly authorize the credential and expected identity before calling.
 * The factory owns one fresh isolated worker; it must never synthesize identity metadata.
 */
export async function verifyClaudeIdentityNoModel(runtime: ClaudeComponentRuntime, signal: AbortSignal): Promise<ClaudeIdentity> {
  const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 15000);
  const combined = AbortSignal.any([controller.signal, signal]);
  let session: ReturnType<ClaudeComponentRuntime["query"]> | undefined;
  try {
    runtime.assertCurrent(); combined.throwIfAborted();
    session = runtime.query({ prompt: (async function* () { await new Promise<void>(resolve => combined.addEventListener("abort", () => resolve(), { once: true })); })(), options: {
      abortController: controller, cwd: runtime.cwd, model: runtime.model, pathToClaudeCodeExecutable: runtime.executable, spawnClaudeCodeProcess: runtime.spawn,
      env: { ...runtime.environment }, tools: [], allowedTools: [], mcpServers: {}, permissionMode: "default", settingSources: [], plugins: [], agents: {},
      additionalDirectories: [], persistSession: false, enableFileCheckpointing: false, maxTurns: 12, extraArgs: { "strict-mcp-config": null, "disable-slash-commands": null },
    } });
    const account = await Promise.race([session.accountInfo(), new Promise<never>((_, reject) => combined.addEventListener("abort", () => reject(Error("identity timeout")), { once: true }))]);
    runtime.assertCurrent(); combined.throwIfAborted();
    return z.object({ email: z.literal(runtime.account.email), tokenSource: z.literal(runtime.account.tokenSource), subscriptionType: z.literal(runtime.account.subscriptionType), apiKeySource: z.literal("none"), apiProvider: z.literal("firstParty") }).parse(account);
  } catch { throw Error("Claude identity verification failed"); }
  finally { clearTimeout(timeout); controller.abort(); try { await runtime.close(); } catch { throw Error("Claude identity cleanup failed"); } }
}

/** Host proof observation only; accountInfo never establishes host identity or grants. */
export async function observeClaudeHostNoModel(runtime: ClaudeComponentRuntime, tier: string, signal: AbortSignal): Promise<void> {
  const { claimClaudeHostRuntime } = await import("./openshell-claude-provider.js");
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 30000);
  const combined = AbortSignal.any([signal, controller.signal, ...(runtime.signal ? [runtime.signal] : [])]);
  const run = { tier, request: "", input: {}, consumes: {}, children: [], prompt: "", signal, tools: {}, toolDescriptions: {}, toolSchemas: {} };
  const proof = claimClaudeHostRuntime(runtime, run); let complete = false;
  try {
    if (!proof) throw Error(); proof.check(); runtime.admitStep?.(run); combined.throwIfAborted();
    const session = runtime.query({ prompt: (async function* () { await new Promise<void>(resolve => combined.addEventListener("abort", () => resolve(), { once: true })); })(), options: {
      abortController: controller, cwd: runtime.cwd, model: runtime.model, pathToClaudeCodeExecutable: runtime.executable, spawnClaudeCodeProcess: runtime.spawn, env: { ...runtime.environment },
      tools: [], allowedTools: [], mcpServers: {}, permissionMode: "default", settingSources: [], plugins: [], agents: {}, additionalDirectories: [], persistSession: false, enableFileCheckpointing: false, maxTurns: 12,
      extraArgs: { "strict-mcp-config": null, "disable-slash-commands": null },
    } });
    const pending = new Promise<never>((_, reject) => combined.addEventListener("abort", () => reject(Error()), { once: true })); void pending.catch(() => {});
    proof.observe(await Promise.race([session.accountInfo(), pending])); combined.throwIfAborted(); complete = true;
  } catch { throw Error("Claude host observation failed"); }
  finally { clearTimeout(timer); controller.abort(); try { await runtime.close(); if (complete) proof?.afterClose(); } catch { throw Error("Claude host observation cleanup failed"); } }
}
