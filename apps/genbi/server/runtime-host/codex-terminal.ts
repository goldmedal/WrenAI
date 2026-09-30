import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { WebSocketServer } from "ws";
import { NO_INTERACTIVE_TERMINAL_LEASES, type InteractiveTerminalManager, type InteractiveTerminalSession } from "../interactive-terminal.js";
import { assertNativeExecutableIdentity, type NativeExecutableIdentity } from "../native-runtime-spec.js";
import type { CodexConversation } from "./codex-conversation.js";
import { CodexTerminalProtocol } from "./codex-terminal-protocol.js";

/** Official CLI renderer with a credential-free home and a private Unix socket. */
export async function startCodexTerminal(input: {
  id: string; conversation: CodexConversation; manager: InteractiveTerminalManager;
  vendor: NativeExecutableIdentity; cwd: string; model: string; assertActive(): void;
}): Promise<{ terminal: InteractiveTerminalSession; close(): Promise<void> }> {
  input.assertActive(); assertNativeExecutableIdentity(input.vendor);
  // Short path for macOS sockaddr_un; mkdtemp creates an owner-only directory.
  const root = realpathSync(mkdtempSync("/private/tmp/genbi-terminal-"));
  const home = path.join(root, "home"); mkdirSync(home, { mode: 0o700 });
  const socket = path.join(root, "rpc.sock");
  const server = createServer((_req, res) => { res.writeHead(404); res.end(); });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1_048_576, perMessageDeflate: false });
  let claimed = false;
  let protocol: CodexTerminalProtocol | undefined;
  let terminal: InteractiveTerminalSession | undefined;
  let closing: Promise<void> | undefined;
  let exited = false;
  let resolveExit!: () => void;
  const exit = new Promise<void>((resolve) => { resolveExit = resolve; });
  let ready!: () => void;
  let failed!: (error: Error) => void;
  const handshake = new Promise<void>((resolve, reject) => { ready = resolve; failed = reject; });
  void handshake.catch(() => {});
  server.on("upgrade", (req, connection, head) => {
    if (claimed || closing || req.headers.origin || req.url !== "/rpc") { connection.destroy(); return; }
    claimed = true;
    wss.handleUpgrade(req, connection, head, (ws) => {
      protocol = new CodexTerminalProtocol(input.conversation, { cwd: input.cwd, clientHome: home, model: input.model },
        (message) => {
          if (ws.readyState !== ws.OPEN || ws.bufferedAmount > 1_048_576) throw new Error("Terminal connection unavailable");
          ws.send(JSON.stringify(message));
        }, input.assertActive, ready);
      ws.on("message", (bytes, binary) => {
        if (binary) { ws.terminate(); return; }
        try { void protocol!.receive(JSON.parse(bytes.toString())).catch(() => ws.terminate()); }
        catch { ws.terminate(); }
      });
      ws.on("error", () => ws.terminate());
      ws.on("close", () => { protocol?.close(); failed(new Error("Terminal connection closed")); terminal?.close(); });
    });
  });
  const close = () => closing ??= (async () => {
    protocol?.close();
    terminal?.close();
    for (const ws of wss.clients) ws.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    if (server.listening) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    if (terminal && !exited) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([exit, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Terminal cleanup failed")), 2_000); })]); }
      finally { clearTimeout(timer); }
    }
    rmSync(root, { recursive: true });
  })();
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socket, () => { server.removeListener("error", reject); resolve(); }); });
    chmodSync(socket, 0o600);
    input.assertActive(); assertNativeExecutableIdentity(input.vendor);
    const filesystem = { ":minimal": "read", "/private/tmp": "deny", "/private/var/tmp": "deny",
      [path.dirname(input.vendor.executable)]: "read", [input.cwd]: "read", [root]: "write" };
    const filesystemToml = `{${Object.entries(filesystem).map(([key, value]) => `${JSON.stringify(key)}=${JSON.stringify(value)}`).join(",")}}`;
    terminal = input.manager.start({ version: "5", target: "codex:interactive", executable: "codex", hostExecutable: input.vendor.executable,
      argv: ["sandbox", "-C", root, "-P", "genbi-terminal", "-c", `permissions.genbi-terminal.filesystem=${filesystemToml}`,
        "-c", "permissions.genbi-terminal.network.enabled=false", "--allow-unix-socket", socket, "--", input.vendor.executable,
        "--remote", `unix://${socket}`, "--no-alt-screen", "-C", input.cwd, "-c", "check_for_update_on_startup=false"],
      cwd: root, artifact_root: root, handoff_path: "" }, { id: input.id, capability: input.conversation.capability },
      { HOME: home, CODEX_HOME: home, PATH: "/usr/bin:/bin" }, NO_INTERACTIVE_TERMINAL_LEASES);
    // This credential-free renderer starts before the browser attaches. Answer
    // its initial terminal capability probes; xterm owns replies after startup.
    let probeTail = "";
    const stopProbe = terminal.onData((data) => {
      probeTail = (probeTail + data).slice(-1024);
      if (probeTail.includes("\x1b[6n")) { terminal!.write("\x1b[1;1R"); probeTail = probeTail.replaceAll("\x1b[6n", ""); }
      if (probeTail.includes("\x1b]11;?")) { terminal!.write("\x1b]11;rgb:0000/0000/0000\x1b\\"); probeTail = probeTail.replaceAll("\x1b]11;?", ""); }
    });
    terminal.onExit(() => { exited = true; resolveExit(); failed(new Error("Terminal exited before startup")); });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([handshake, new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error("Terminal startup timed out")), 15_000); })]); }
    finally { clearTimeout(timeout); stopProbe(); }
    input.assertActive();
    return { terminal, close };
  } catch (error) { await close(); throw error; }
}
