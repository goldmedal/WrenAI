// A scripted stand-in for `pi --mode json`, used only by tests. It reads exactly what real pi reads (argv, its agent directory, stdin, one credential
// variable), talks to the proxy URL named in models.json, runs the MCP handshake through the shim named in mcp.json, and emits pi-shaped events.
// Behaviour comes from a JSON file whose path is baked in when the fixture installs this script; the file is outside the certified bundle.
import { spawn } from 'node:child_process';
import { appendFileSync, readFileSync, readdirSync } from 'node:fs';

const CONFIG_PATH = '__CONFIG_PATH__';
const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
const record = (value) => { if (config.record) appendFileSync(config.record, JSON.stringify(value) + '\n'); };
const emit = (event) => process.stdout.write(JSON.stringify(event) + '\n');
const argv = process.argv.slice(2);
const flag = (name) => { const at = argv.indexOf(name); return at < 0 ? undefined : argv[at + 1]; };
const agentDir = process.env.PI_CODING_AGENT_DIR;
const models = JSON.parse(readFileSync(`${agentDir}/models.json`, 'utf8'));
const mcp = JSON.parse(readFileSync(`${agentDir}/mcp.json`, 'utf8'));
const provider = Object.values(models.providers)[0];
const keyVariable = String(provider.apiKey).replace(/^\$/, '');
const toolList = (flag('--tools') ?? '').split(',').filter(Boolean);
const systemPrompt = readFileSync(flag('--system-prompt'), 'utf8');

record({ kind: 'start', argv, env: process.env, cwd: process.cwd(), agentFiles: Object.fromEntries(readdirSync(agentDir).map((name) => [name, readFileSync(`${agentDir}/${name}`, 'utf8')])), systemPrompt });

if (config.orphan) {
  const marker = flag('--system-prompt').replace(/\/system-prompt\.txt$/, '');
  const child = spawn(process.execPath, ['-e', `setTimeout(() => {}, 60000) /* ${marker} */`], { detached: true, stdio: 'ignore' });
  child.unref();
}
if (config.hang) { setInterval(() => {}, 1000); }

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
if (config.hang) await new Promise(() => {});
const input = Buffer.concat(chunks).toString('utf8');
record({ kind: 'input', input });

emit({ type: 'message_end', message: { role: 'system', content: '', sections: { preamble: systemPrompt, cwd: `<cwd>\n${process.cwd()}\n</cwd>` },
  ...(toolList.length ? { toolsAdded: toolList.map((name) => ({ name, description: 'd', parameters: {} })) } : {}) } });

if (config.http !== false) {
  const response = await fetch(`${provider.baseUrl}${config.httpPath ?? '/chat/completions'}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env[keyVariable]}`, 'x-api-key': String(process.env[keyVariable]) }, body: JSON.stringify({ model: flag('--model'), stream: true, messages: [] }) });
  const text = await response.text();
  record({ kind: 'http', status: response.status, text });
}

if (toolList.length && config.call) {
  const server = Object.values(mcp.mcpServers)[0];
  const shim = spawn(server.command, server.args, { stdio: ['pipe', 'pipe', 'inherit'] });
  const pending = new Map(); let buffer = '';
  shim.stdout.on('data', (chunk) => {
    buffer += chunk.toString('utf8'); let at;
    while ((at = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, at); buffer = buffer.slice(at + 1); const message = JSON.parse(line); pending.get(message.id)?.(message); }
  });
  const request = (id, method, params) => new Promise((resolve) => { pending.set(id, resolve); shim.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
  const initialized = await request(1, 'initialize', { protocolVersion: '2025-11-25', capabilities: { roots: {} }, clientInfo: { name: 'pi', version: '1.0.4' } });
  shim.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  const listed = await request(2, 'tools/list', undefined);
  const name = listed.result.tools.find((tool) => tool.name.endsWith(config.call.suffix ?? 'query_read_only'))?.name ?? listed.result.tools[0].name;
  emit({ type: 'tool_execution_start', toolName: `mcp__component__${name}` });
  const called = await request(3, 'tools/call', { name, arguments: config.call.args });
  record({ kind: 'mcp', initialized: Boolean(initialized.result), called });
  shim.stdin.end();
}

emit({ type: 'message_end', message: { role: 'assistant', stopReason: config.stop ?? 'stop', content: [{ type: 'text', text: config.text ?? 'answer text' }], usage: { input: 5, output: 2 } } });
emit({ type: 'agent_settled' });
