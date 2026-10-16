// Deterministic stand-in for `pi --mode json`: reads the same files and env the real one would, speaks to the relay shim over MCP,
// and prints pi-shaped events. It exposes what it could see so tests can assert the sandbox view.
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const flag = name => argv[argv.indexOf(name) + 1];
const stepDir = path.dirname(process.env.PI_CODING_AGENT_DIR);
appendFileSync(path.join(stepDir, 'notes.jsonl'), JSON.stringify({ event: 'started', argv, cwd: process.cwd() }) + '\n');
let input = '';
process.stdin.setEncoding('utf8'); for await (const chunk of process.stdin) input += chunk;
const out = value => process.stdout.write(JSON.stringify(value) + '\n');
const agentDir = process.env.PI_CODING_AGENT_DIR;
const mcp = JSON.parse(readFileSync(path.join(agentDir, 'mcp.json'), 'utf8'));
const prompt = readFileSync(flag('--system-prompt'), 'utf8');
out({ type: 'session', version: 3, id: 'fake', cwd: process.cwd() });
out({ type: 'agent_start' }); out({ type: 'turn_start' });
let shim, nextId = 1; const pending = new Map(); let buffer = '';
const request = (method, params) => new Promise(resolve => { const id = nextId++; pending.set(id, resolve); shim.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
const toolsAdded = [];
if (mcp.mcpServers.component) {
  const server = mcp.mcpServers.component;
  shim = spawn(server.command, server.args, { stdio: ['pipe', 'pipe', 'inherit'] });
  shim.stdout.on('data', chunk => { buffer += chunk; let at; while ((at = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, at); buffer = buffer.slice(at + 1); const message = JSON.parse(line); pending.get(message.id)?.(message); pending.delete(message.id); } });
  await request('initialize', { protocolVersion: '2025-11-25', capabilities: { roots: {} }, clientInfo: { name: 'pi', version: '1.0.4' } });
  shim.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  const listed = await request('tools/list');
  for (const tool of listed.result.tools) toolsAdded.push({ name: `mcp__component__${tool.name}`, description: tool.description, parameters: tool.inputSchema });
}
const observation = { agentFiles: readdirSync(agentDir).sort(), cwdEntries: readdirSync(process.cwd()), envKeys: Object.keys(process.env).sort(), home: process.env.HOME,
  modes: { step: (statSync(path.dirname(agentDir)).mode & 0o777).toString(8), agentFile: (statSync(path.join(agentDir, 'models.json')).mode & 0o777).toString(8) },
  cred: process.env[JSON.parse(readFileSync(path.join(agentDir, 'models.json'), 'utf8')).providers[flag('--provider')].apiKey.slice(1)] };
const system = { role: 'system', content: '', sections: { preamble: prompt, cwd: `<cwd>\n${process.cwd()}\n</cwd>` }, timestamp: 1, ...(toolsAdded.length ? { toolsAdded } : {}) };
out({ type: 'message_start', message: system }); out({ type: 'message_end', message: system });
out({ type: 'message_end', message: { role: 'user', content: [{ type: 'text', text: input }], timestamp: 2 } });
const usage = { input: 7, output: 3, cacheRead: 0, cacheWrite: 0 };
const marker = /\[(call|stall|escape|noterm|observe)(?::([A-Za-z0-9_]+))?(\{.*?\})?\]/.exec(input.replace(/\\"/g, '"'));
if (marker?.[1] === 'stall') {
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
  writeFileSync(path.join(stepDir, 'pids.json'), JSON.stringify({ pi: process.pid, child: child.pid, shim: shim?.pid }));
  setInterval(() => {}, 1000); await new Promise(() => {});
}
if (marker?.[1] === 'escape') {
  const escapee = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)', 'ESCAPED-STEP-PROCESS'], { detached: true, stdio: 'ignore' }); escapee.unref();
  writeFileSync(path.join(stepDir, 'pids.json'), JSON.stringify({ escapee: escapee.pid }));
}
let text = marker?.[1] === 'observe' ? JSON.stringify(observation) : 'fake answer';
if (marker?.[1] === 'call') {
  const name = marker[2]; const args = marker[3] ? JSON.parse(marker[3]) : {};
  const call = { type: 'toolCall', id: 'call_1', name: `mcp__component__${name}`, arguments: args };
  out({ type: 'message_end', message: { role: 'assistant', content: [call], usage, stopReason: 'toolUse', timestamp: 3 } });
  out({ type: 'tool_execution_start', toolCallId: 'call_1', toolName: call.name, args });
  const result = await request('tools/call', { name, arguments: args, _meta: { progressToken: 1 } });
  out({ type: 'tool_execution_end', toolCallId: 'call_1', toolName: call.name, result: result.result, isError: false });
  text = `fake answer after ${JSON.stringify(result.result?.content?.[0]?.text ?? result.error)}`;
}
out({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text }], usage, stopReason: 'stop', timestamp: 4 } });
out({ type: 'agent_end', messages: [system] });
out({ type: 'agent_settled' });
if (shim) shim.stdin.end();
if (marker?.[1] === 'noterm') { process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); await new Promise(() => {}); }
process.exit(0);
