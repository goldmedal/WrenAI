#!/usr/bin/env node
// A stand-in warble-codex-local `dispatch` that, like Codex, starts the MCP server it was given
// (`--server-command` + `--server-arg`s) and calls its tools. The request names a JSON script as
// `script:<path>` (the last one wins: a follow-up turn's request carries earlier turns as history):
// { calls: [{ name, arguments }], answer, capture? }. In `answer`, the string "$QID<n>" is
// replaced by the `query_id` the n-th call returned.
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
const scriptPath = [...args[2].matchAll(/script:(\S+?\.json)/g)].at(-1)?.[1];
const script = JSON.parse(readFileSync(scriptPath, "utf8"));
let command;
const serverArgs = [];
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === "--server-command") command = args[++index];
  else if (arg === "--server-arg") serverArgs.push(args[++index]);
  else if (arg.startsWith("--server-arg=")) serverArgs.push(arg.slice("--server-arg=".length));
}

const server = spawn(command, serverArgs, { stdio: ["pipe", "pipe", "ignore"] });
const waiting = new Map();
createInterface({ input: server.stdout }).on("line", (line) => {
  const message = JSON.parse(line);
  waiting.get(message.id)?.(message);
  waiting.delete(message.id);
});
let nextId = 1;
const request = (method, params) => new Promise((resolve) => {
  const id = nextId++;
  waiting.set(id, resolve);
  server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
});

await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fake-codex", version: "0" } });
server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
const listed = await request("tools/list", {});
const results = [];
for (const call of script.calls ?? []) results.push(await request("tools/call", { name: call.name, arguments: call.arguments ?? {} }));
server.stdin.end();

const substitute = (value) => {
  if (typeof value === "string") {
    const match = /^\$QID(\d+)$/.exec(value);
    return match ? results[Number(match[1])]?.result?.structuredContent?.query_id : value;
  }
  if (Array.isArray(value)) return value.map(substitute);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, substitute(item)]));
  return value;
};
const answer = substitute(script.answer);
if (script.capture) writeFileSync(script.capture, JSON.stringify({ tools: listed.result?.tools?.map((tool) => tool.name), results, answer }));

const reference = (itemId, ok) => ({ parentThreadId: "parent", parentTurnId: "turn", step: "generate_sql", agentRole: "warble_generate_sql", agentThreadId: "generate", itemId, server: "wren", tool: "run_sql", ok });
const events = [
  { t: "session_started", session: { target: "codex:local", threadId: "parent" } },
  { t: "turn_started", turn: { threadId: "parent", turnId: "turn", status: "in_progress" } },
  { t: "agent_started", parentThreadId: "parent", parentTurnId: "turn", step: "resolve_intent", agentRole: "warble_resolve_intent", agentThreadId: "resolve", model: "cheap-model" },
  { t: "step_finished", parentThreadId: "parent", parentTurnId: "turn", step: "resolve_intent", agentRole: "warble_resolve_intent", agentThreadId: "resolve", ok: true },
  { t: "agent_started", parentThreadId: "parent", parentTurnId: "turn", step: "generate_sql", agentRole: "warble_generate_sql", agentThreadId: "generate", model: "strong-model" },
  ...results.map((result, index) => ({ t: "artifact", reference: reference(`sql-${index}`, result.result?.isError !== true) })),
  { t: "step_finished", parentThreadId: "parent", parentTurnId: "turn", step: "generate_sql", agentRole: "warble_generate_sql", agentThreadId: "generate", ok: true },
  { t: "turn_completed", turn: { threadId: "parent", turnId: "turn", status: "completed" } },
  { t: "answer", text: typeof answer === "string" ? answer : JSON.stringify(answer) },
];
for (const event of events) process.stdout.write(`${JSON.stringify(event)}\n`);
await new Promise((resolve) => { server.once("exit", resolve); setTimeout(() => { server.kill("SIGKILL"); resolve(); }, 2_000); });
