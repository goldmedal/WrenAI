// A stand-in `warble-agent-sdk chat` that, like warble 0.16, loads `--host-mcp-config` with
// warble's own loader (mode, owner, O_NOFOLLOW and strict-key checks), starts that MCP server and
// calls its tools. The question (stdin) names a JSON script as `script:<path>` (the last one
// wins): { calls: [{ name, arguments }], answer, capture? }. In `answer`, the string "$QID<n>" is
// replaced by the `query_id` the n-th call returned. Without a host MCP config, no call is made.
import { spawn } from "node:child_process";
import { lstatSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { loadHostMcpConfig } from "@warble/claude-agent-sdk";

const args = process.argv.slice(2);
const configIndex = args.indexOf("--host-mcp-config");
const configPath = configIndex >= 0 ? args[configIndex + 1] : undefined;
const question = readFileSync(0, "utf8");
const scriptPath = [...question.matchAll(/script:(\S+?\.json)/g)].at(-1)?.[1];
const script = JSON.parse(readFileSync(scriptPath, "utf8"));

const configStat = configPath !== undefined ? (({ mode, uid }) => ({ mode: mode & 0o777, uid }))(lstatSync(configPath)) : undefined;
const configKeys = configPath !== undefined ? Object.keys(JSON.parse(readFileSync(configPath, "utf8"))) : undefined;
let config;
let configError;
try { config = configPath !== undefined ? loadHostMcpConfig(configPath) : undefined; } catch (error) { configError = error.message; }

const results = [];
let listed;
if (config) {
  const server = spawn(config.command, config.args, { stdio: ["pipe", "pipe", "ignore"] });
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
  await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fake-agent-sdk", version: "0" } });
  server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  listed = await request("tools/list", {});
  for (const call of script.calls ?? []) {
    // warble's guardrail allows exactly mcp__<name>__<tool> for the listed tools.
    if (!config.tools.includes(call.name)) { results.push({ denied: `mcp__${config.name}__${call.name}` }); continue; }
    results.push(await request("tools/call", { name: call.name, arguments: call.arguments ?? {} }));
  }
  server.stdin.end();
  await new Promise((resolve) => { server.once("exit", resolve); setTimeout(() => { server.kill("SIGKILL"); resolve(); }, 2_000); });
}

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
if (script.capture) {
  writeFileSync(script.capture, JSON.stringify({ args, configPath, configStat, configKeys, config, configError, tools: listed?.result?.tools?.map((tool) => tool.name), results, answer }));
}
process.stdout.write(`${JSON.stringify({ t: "session", id: "fake-session" })}\n`);
process.stdout.write(`${JSON.stringify({ t: "answer", text: typeof answer === "string" ? answer : JSON.stringify(answer) })}\n`);
