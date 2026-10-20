import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import type { OpenShellDuplex } from "./openshell-types.js";
import type { LocalPiLauncher } from "./local-pi-install.js";

/**
 * The host-side step worker for the local pi runtime. The OpenShell worker is image-bound, so the host gets its own: it speaks the same worker
 * frames over an `OpenShellDuplex`-shaped object, which keeps `PiStepChannel`, `PiStepProtocol` and `runPiComponentStep` (staging digests, system
 * prompt and tool admission, events-only success) in force unchanged. The bootstrap is admitted with the packaged `admitArgv` / `admitFiles`.
 *
 * Isolation is by construction only, and says so: pi runs as the BFF's OS user with an explicit minimal environment, a private 0700 step directory,
 * no built-in tools and a loopback endpoint that holds a per-step token. There is no filesystem or network confinement beyond that.
 */
interface WorkerCore {
  stepPaths(root: string, scope: string): { base: string; agent: string; cwd: string; home: string; tmp: string; prompt: string; socket: string };
  admitArgv(argv: unknown, paths: unknown, providerId: string, model: string): string[];
  admitFiles(files: unknown, ctx: Record<string, unknown>): void;
}
let core: Promise<WorkerCore> | undefined;
/** The packaged worker's pure admission functions; imported as a module, never copied. */
const workerCore = (): Promise<WorkerCore> => core ??= import(new URL("../../runtime-assets/pi-worker/pi-worker-core.mjs", import.meta.url).href) as Promise<WorkerCore>;

const LIMITS = Object.freeze({ line: 2_097_152, frames: 1024, bootstrap: 1_048_576, total: 16_777_216, exitWaitMs: 10_000, killWaitMs: 2000, proofMs: 6000, bootstrapMs: 15_000 });
const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

export interface ProcessRow { readonly pid: number; readonly ppid: number; readonly pgid: number; readonly stat: string; readonly command: string }
/** `ps` on macOS and Linux; any failure is a closed error, because cleanup that cannot be proven is not cleanup. */
export const listProcesses = (): Promise<ProcessRow[]> => new Promise((resolve, reject) => {
  execFile("/bin/ps", ["-axww", "-o", "pid=,ppid=,pgid=,stat=,command="], { env: { PATH: "/usr/bin:/bin", LANG: "C" }, maxBuffer: 32 << 20, timeout: 5000 }, (error, stdout) => {
    if (error) { reject(error); return; }
    const rows: ProcessRow[] = [];
    for (const line of stdout.split("\n")) {
      const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
      if (match) rows.push({ pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), stat: match[4]!, command: match[5]! });
    }
    resolve(rows);
  });
});

/** Descendants of `leader` in a snapshot. */
export function descendantsOf(rows: readonly ProcessRow[], leader: number): Set<number> {
  const children = new Map<number, number[]>();
  for (const row of rows) { const list = children.get(row.ppid) ?? []; list.push(row.pid); children.set(row.ppid, list); }
  const found = new Set<number>(); const stack = [leader];
  while (stack.length) for (const pid of children.get(stack.pop()!) ?? []) if (!found.has(pid)) { found.add(pid); stack.push(pid); }
  return found;
}
/**
 * Residue of one step: live processes, other than the BFF, that are in the step's process group, were descendants of pi in the snapshot taken
 * before the kill, or still carry the step's private directory in their command line. A process that leaves the group AND rewrites its argv is
 * not detectable without an OS sandbox.
 */
export function stepResidue(rows: readonly ProcessRow[], step: { readonly self: number; readonly leader: number | undefined; readonly base: string | undefined; readonly known?: ReadonlySet<number> }): ProcessRow[] {
  return rows.filter((row) => row.pid !== step.self && !row.stat.startsWith("Z")
    && ((step.leader !== undefined && (row.pgid === step.leader || row.pid === step.leader)) || step.known?.has(row.pid) === true
      || (step.base !== undefined && row.command.includes(step.base))));
}

export interface LocalPiCleanupReport { readonly reason: "settled" | "cancelled"; readonly processes: "clear" | "residue" | "unavailable" | "not_started"; readonly directory: "removed" | "failed" | "absent"; readonly grant: "revoked" }

export interface LocalPiStepOptions {
  readonly stepsRoot: string;
  readonly launcher: LocalPiLauncher;
  /** Absolute node and shim paths the MCP configuration names; must equal the spec's `runtime`. */
  readonly node: string;
  readonly shim: string;
  /** The per-step proxy token: the only secret pi's environment holds. */
  readonly token: string;
  revokeGrant(): void;
  readonly list?: () => Promise<ProcessRow[]>;
  readonly spawn?: typeof spawn;
  readonly now?: () => number;
}

type Output = { stream: "stdout" | "stderr"; data: Buffer } | { type: "exit"; exitCode: number };

/** Verifies (or creates) the 0700 steps root owned by this user. */
export function ensureStepsRoot(root: string): void {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const stat = lstatSync(root);
  // pi reports its working directory as a real path, and the host compares it with the one it derived: the root must already be canonical.
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0 || realpathSync(root) !== root) throw new Error("steps root");
}
const SAFE_PATH = /^\/[A-Za-z0-9/_.-]{1,200}$/;
/**
 * The MCP configuration may only name paths of the form the protocol admits (no `@`, `+` or spaces), but an installed package lives under
 * `node_modules/@scope/...` and a Node can live under `Cellar/node@24/...`. So the node executable is reached through a symlink, and the relay through a
 * byte-identical copy, both inside the 0700 steps root. The copy is compared with the packaged file every time and replaced atomically when it differs.
 */
export function ensureStepSupport(root: string, nodeExecutable: string, shimSource: string): { readonly node: string; readonly shim: string } {
  ensureStepsRoot(root);
  const node = path.join(root, "node"), shim = path.join(root, "pi-mcp-shim.mjs");
  let linked = false;
  try { linked = lstatSync(node).isSymbolicLink() && readlinkSync(node) === nodeExecutable; } catch { linked = false; }
  if (!linked) { try { unlinkSync(node); } catch { /* absent */ } symlinkSync(nodeExecutable, node); }
  const wanted = readFileSync(shimSource);
  let same = false;
  try { const stat = lstatSync(shim); same = stat.isFile() && !stat.isSymbolicLink() && readFileSync(shim).equals(wanted); } catch { same = false; }
  if (!same) {
    const temp = `${shim}.${process.pid}.${Date.now()}`;
    writeFileSync(temp, wanted, { mode: 0o400, flag: "wx" }); renameSync(temp, shim);
  }
  if (!SAFE_PATH.test(node) || !SAFE_PATH.test(shim)) throw new Error("steps root path");
  return Object.freeze({ node, shim });
}
/** `<tmp>/gbpi-<uid>`, or the real path of `/tmp/gbpi-<uid>` when the shim's fixed `<root>/<uuid>/mcp.sock` layout would not fit a unix socket path. */
export function defaultStepsRoot(tmp: string): string {
  const uid = process.getuid?.() ?? 0;
  const socketLength = (root: string) => Buffer.byteLength(`${root}/${"0".repeat(36)}/mcp.sock`);
  const primary = path.join(tmp, `gbpi-${uid}`);
  return socketLength(primary) <= 100 ? primary : path.join(realpathSync("/tmp"), `gbpi-${uid}`);
}

export class LocalPiStep {
  private readonly queue: Output[] = [];
  private waiter: ((value: IteratorResult<Output>) => void) | undefined;
  private ended = false;
  private pending = Buffer.alloc(0);
  private bootBytes = Buffer.alloc(0);
  private stage: "bootstrap" | "staged" | "running" | "done" = "bootstrap";
  private boot: { scope: string; token: string; credentialEnv: string; argv: string[]; files: { settings: string; models: string; mcp: string; systemPrompt: string } } | undefined;
  private paths: ReturnType<WorkerCore["stepPaths"]> | undefined;
  private staged: Record<string, string> | undefined;
  private child: ChildProcess | undefined;
  private server: net.Server | undefined;
  private conn: net.Socket | undefined;
  private helloDone = false;
  private outputBytes = 0;
  private frameCount = 0;
  private endReceived = false;
  private settledForwarded = false;
  private piExit: { code: number | null; signal: string | null; forced: boolean } | undefined;
  private known = new Set<number>();
  private timers: ReturnType<typeof setTimeout>[] = [];
  private cleaned: Promise<LocalPiCleanupReport> | undefined;
  private resolveDone!: (code: number) => void;
  readonly done = new Promise<number>((resolve) => { this.resolveDone = resolve; });
  private readonly list: () => Promise<ProcessRow[]>;
  private readonly doSpawn: typeof spawn;

  constructor(private readonly options: LocalPiStepOptions) {
    this.list = options.list ?? listProcesses; this.doSpawn = options.spawn ?? spawn;
    this.timers.push(setTimeout(() => { if (this.stage === "bootstrap") this.fatal(); }, LIMITS.bootstrapMs));
  }

  /** The transport the channel talks to. */
  readonly duplex: OpenShellDuplex = {
    output: { [Symbol.asyncIterator]: () => ({ next: () => new Promise<IteratorResult<Output>>((resolve) => {
      const item = this.queue.shift(); if (item) { resolve({ value: item, done: false }); return; }
      if (this.ended) { resolve({ value: undefined, done: true }); return; }
      this.waiter = resolve;
    }) }) },
    write: (data: Buffer) => { void this.onWrite(data); },
    close: () => { this.cancel(); },
    done: this.done,
  };

  private push(item: Output): void { if (this.waiter) { const waiter = this.waiter; this.waiter = undefined; waiter({ value: item, done: false }); } else this.queue.push(item); }
  private finishStream(): void { this.ended = true; if (this.waiter) { const waiter = this.waiter; this.waiter = undefined; waiter({ value: undefined, done: true }); } }
  private send(frame: Record<string, unknown>): void {
    const line = JSON.stringify(frame);
    this.outputBytes += Buffer.byteLength(line) + 1;
    if (this.outputBytes > LIMITS.total || ++this.frameCount > LIMITS.frames) { this.fatal(); return; }
    this.push({ stream: "stdout", data: Buffer.from(`${line}\n`) });
  }
  private killGroup(signal: NodeJS.Signals): void {
    const pid = this.child?.pid;
    if (pid) { try { process.kill(-pid, signal); } catch { /* group already gone */ } }
  }
  /** Stops everything this step started; the proof and the directory removal are `cleanup`'s job. */
  private cancel(): void {
    if (this.stage === "done") return;
    this.stage = "done";
    for (const timer of this.timers) clearTimeout(timer);
    this.killGroup("SIGKILL");
    try { this.conn?.destroy(); this.server?.close(); } catch { /* closing */ }
    this.resolveDone(1); this.finishStream();
  }
  private fatal(): void { this.cancel(); }

  private lines(onLine: (line: Buffer) => void): (chunk: Buffer) => void {
    let buffer = Buffer.alloc(0);
    return (chunk) => {
      buffer = Buffer.concat([buffer, chunk]); let at: number;
      while ((at = buffer.indexOf(10)) >= 0) { const line = buffer.subarray(0, at); buffer = buffer.subarray(at + 1); if (line.length > LIMITS.line) { this.fatal(); return; } onLine(line); }
      if (buffer.length > LIMITS.line) this.fatal();
    };
  }
  private readonly frames = this.lines((line) => this.onHostFrame(line));

  private async onWrite(chunk: Buffer): Promise<void> {
    if (this.stage === "done") return;
    if (this.stage === "bootstrap") { await this.onBootstrap(chunk); return; }
    this.frames(chunk);
  }

  private async onBootstrap(chunk: Buffer): Promise<void> {
    this.bootBytes = Buffer.concat([this.bootBytes, chunk]);
    if (this.bootBytes.length < 4) return;
    const length = this.bootBytes.readUInt32BE(0);
    if (length < 1 || length > LIMITS.bootstrap) { this.fatal(); return; }
    if (this.bootBytes.length < 4 + length) return;
    const rest = this.bootBytes.subarray(4 + length);
    const raw = this.bootBytes.subarray(4, 4 + length);
    this.bootBytes = Buffer.alloc(0);
    this.stage = "staged";
    try {
      const worker = await workerCore();
      const boot = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)) as unknown;
      if (!isRecord(boot) || Object.keys(boot).sort().join(",") !== "argv,credentialEnv,files,protocol,scope,token" || boot.protocol !== 1
        || typeof boot.scope !== "string" || !/^[a-f0-9-]{36}$/.test(boot.scope) || typeof boot.token !== "string" || !/^[a-f0-9]{32}$/.test(boot.token)
        || typeof boot.credentialEnv !== "string" || !/^[A-Z][A-Z0-9_]{0,63}$/.test(boot.credentialEnv) || !Array.isArray(boot.argv)) throw new Error("bootstrap");
      this.boot = boot as unknown as NonNullable<LocalPiStep["boot"]>;
      const paths = worker.stepPaths(this.options.stepsRoot, this.boot.scope);
      this.paths = paths;
      const argv = this.boot.argv;
      const providerId = String(argv[argv.indexOf("--provider") + 1]), model = String(argv[argv.indexOf("--model") + 1]);
      const tools = worker.admitArgv(argv, paths, providerId, model);
      worker.admitFiles(this.boot.files, { paths, credentialEnv: this.boot.credentialEnv, token: this.boot.token, tools, providerId, model, shim: this.options.shim, node: this.options.node });
      if (!/^[a-f0-9]{64}$/.test(this.options.token)) throw new Error("credential");
      ensureStepsRoot(this.options.stepsRoot);
      mkdirSync(paths.base, { mode: 0o700 });
      for (const directory of [paths.agent, paths.cwd, paths.home, paths.tmp]) mkdirSync(directory, { mode: 0o700 });
      for (const [name, content] of [[`${paths.agent}/settings.json`, this.boot.files.settings], [`${paths.agent}/models.json`, this.boot.files.models], [`${paths.agent}/mcp.json`, this.boot.files.mcp], [paths.prompt, this.boot.files.systemPrompt]] as const)
        writeFileSync(name, content, { mode: 0o600, flag: "wx" });
      if (readdirSync(paths.agent).sort().join(",") !== "mcp.json,models.json,settings.json" || readdirSync(paths.cwd).length || readdirSync(paths.home).length || readdirSync(paths.tmp).length) throw new Error("layout");
      if (tools.length) await this.listen(paths.socket);
      this.staged = this.digestsOnDisk();
      this.send({ t: "staged", protocol: 1, scope: this.boot.scope, digests: this.staged });
    } catch { this.fatal(); return; }
    if (rest.length) this.frames(rest);
  }
  private digestsOnDisk(): Record<string, string> {
    const paths = this.paths!; const boot = this.boot!;
    return { argv: sha256(JSON.stringify(boot.argv)), settings: sha256(readFileSync(`${paths.agent}/settings.json`)), models: sha256(readFileSync(`${paths.agent}/models.json`)), mcp: sha256(readFileSync(`${paths.agent}/mcp.json`)), prompt: sha256(readFileSync(paths.prompt)) };
  }
  private layoutUnchanged(): boolean {
    try {
      const paths = this.paths!;
      return readdirSync(paths.agent).sort().join(",") === "mcp.json,models.json,settings.json" && !readdirSync(paths.cwd).length && !readdirSync(paths.home).length
        && JSON.stringify(this.digestsOnDisk()) === JSON.stringify(this.staged);
    } catch { return false; }
  }

  private listen(socketPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = net.createServer((connection) => {
        if (this.conn) { connection.destroy(); return; }
        this.conn = connection; server.close();
        let seen = 0;
        connection.on("error", () => {});
        connection.on("data", this.lines((line) => {
          if (this.stage === "done") return;
          if (!this.helloDone) {
            try {
              const value = JSON.parse(line.toString("utf8")) as unknown;
              const given = Buffer.from(String(isRecord(value) ? value.hello : ""), "utf8"), want = Buffer.from(this.boot!.token, "utf8");
              if (!isRecord(value) || Object.keys(value).join(",") !== "hello" || given.length !== want.length || !timingSafeEqual(given, want)) throw new Error();
              this.helloDone = true;
            } catch { this.fatal(); }
            return;
          }
          let message: unknown;
          try { message = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(line)); } catch { this.fatal(); return; }
          if (!isRecord(message) || ++seen > LIMITS.frames) { this.fatal(); return; }
          this.send({ t: "mcp", m: message });
        }));
      });
      this.server = server;
      server.once("error", reject);
      server.listen(socketPath, () => {
        try { chmodSync(socketPath, 0o600); const stat = lstatSync(socketPath); if (!stat.isSocket() || (stat.mode & 0o777) !== 0o600) throw new Error("socket"); resolve(); } catch (error) { reject(error); }
      });
    });
  }

  private onHostFrame(line: Buffer): void {
    let frame: unknown;
    try { frame = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(line)); } catch { this.fatal(); return; }
    if (!isRecord(frame)) { this.fatal(); return; }
    if (this.stage === "staged") {
      if (frame.t !== "input" || typeof frame.text !== "string" || Object.keys(frame).length !== 2) { this.fatal(); return; }
      this.stage = "running"; this.startPi(frame.text); return;
    }
    if (this.stage !== "running") { this.fatal(); return; }
    if (frame.t === "mcp" && isRecord(frame.m) && Object.keys(frame).length === 2) {
      if (!this.conn || !this.helloDone || this.conn.destroyed) { this.fatal(); return; }
      this.conn.write(`${JSON.stringify(frame.m)}\n`); return;
    }
    if (frame.t === "end" && Object.keys(frame).length === 1 && !this.endReceived) {
      this.endReceived = true;
      this.timers.push(setTimeout(() => {
        if (this.piExit === undefined) { this.forced = true; this.killGroup("SIGTERM"); this.timers.push(setTimeout(() => this.killGroup("SIGKILL"), LIMITS.killWaitMs)); }
      }, LIMITS.exitWaitMs));
      void this.maybeFinalize(); return;
    }
    this.fatal();
  }
  private forced = false;

  private startPi(text: string): void {
    if (!this.layoutUnchanged()) { this.fatal(); return; }
    const paths = this.paths!; const boot = this.boot!;
    const input = Buffer.from(text, "utf8");
    // Built from nothing: the BFF environment holds vendor keys and is never inherited. The one credential variable carries the per-step token.
    const env: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin", HOME: paths.home, TMPDIR: paths.tmp, LANG: "C.UTF-8", PI_CODING_AGENT_DIR: paths.agent, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0", [boot.credentialEnv]: this.options.token };
    let child: ChildProcess;
    try { child = this.doSpawn(this.options.launcher.command, [...this.options.launcher.prefix, ...boot.argv], { cwd: paths.cwd, env, stdio: ["pipe", "pipe", "pipe"], detached: true }); } catch { this.fatal(); return; }
    this.child = child;
    child.on("error", () => this.fatal());
    child.stdin?.on("error", () => {});
    child.stdin?.end(input);
    this.send({ t: "started", scope: boot.scope, inputSha256: sha256(input) });
    child.stdout?.on("data", this.lines((line) => {
      if (this.stage === "done") return;
      let event: unknown;
      try { event = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(line)); } catch { this.fatal(); return; }
      if (!isRecord(event) || typeof event.type !== "string") { this.fatal(); return; }
      const role = isRecord(event.message) ? event.message.role : undefined;
      const forward = (event.type === "message_end" && (role === "system" || role === "assistant")) || event.type === "tool_execution_start" || event.type === "agent_settled";
      if (!forward) return;
      if (event.type === "agent_settled") this.settledForwarded = true;
      this.send({ t: "pi", e: event });
    }));
    child.stderr?.on("data", () => {});
    child.on("close", (code, signal) => {
      this.piExit = { code, signal: signal ?? null, forced: this.forced };
      void this.maybeFinalize();
    });
  }

  private async maybeFinalize(): Promise<void> {
    if (this.stage !== "running" || this.piExit === undefined) return;
    if (!this.endReceived && this.settledForwarded) return;
    if (!this.endReceived) { this.fatal(); return; }
    let remaining = 0;
    try {
      for (let attempt = 0; attempt < 20; attempt++) {
        const rows = await this.list();
        const live = stepResidue(rows, { self: process.pid, leader: this.child?.pid, base: this.paths?.base, known: this.known });
        remaining = live.length;
        if (!remaining) break;
        this.killGroup("SIGKILL");
        for (const row of live) { try { process.kill(row.pid, "SIGKILL"); } catch { /* gone */ } }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    } catch { remaining = 1; }
    if (this.stage !== "running") return;
    this.send({ t: "exit", scope: this.boot!.scope, code: this.piExit.code, signal: this.piExit.signal, forced: this.piExit.forced, remaining });
    this.stage = "done";
    for (const timer of this.timers) clearTimeout(timer);
    try { this.conn?.destroy(); this.server?.close(); } catch { /* closing */ }
    this.push({ type: "exit", exitCode: 0 }); this.resolveDone(0); this.finishStream();
  }

  /**
   * Bounded cleanup with proof: the group is killed, no step process may remain, the private directory is removed and seen gone, and the proxy
   * grant is revoked. Anything unproven throws, which the channel reports as a cleanup fault.
   */
  cleanup(reason: "settled" | "cancelled"): Promise<LocalPiCleanupReport> {
    return this.cleaned ??= (async () => {
      let processes: LocalPiCleanupReport["processes"] = this.child ? "clear" : "not_started";
      let directory: LocalPiCleanupReport["directory"] = "absent";
      let failure: unknown;
      try {
        this.cancel();
        // Snapshot descendants before the kill: orphans are re-parented and would otherwise be invisible.
        try { const rows = await this.list(); if (this.child?.pid) for (const pid of descendantsOf(rows, this.child.pid)) this.known.add(pid); } catch { /* proven below */ }
        this.killGroup("SIGKILL");
        const deadline = Date.now() + LIMITS.proofMs; let clear = false;
        while (!clear) {
          let rows: ProcessRow[];
          try { rows = await this.list(); } catch { processes = "unavailable"; throw new Error("process proof unavailable"); }
          const live = stepResidue(rows, { self: process.pid, leader: this.child?.pid, base: this.paths?.base, known: this.known });
          if (!live.length) { clear = true; break; }
          processes = "residue";
          if (Date.now() > deadline) throw new Error("process residue");
          this.killGroup("SIGKILL");
          for (const row of live) { try { process.kill(row.pid, "SIGKILL"); } catch { /* gone */ } }
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        if (processes === "residue") processes = "clear";
      } catch (error) { failure = error; }
      try { this.conn?.destroy(); this.server?.close(); } catch { /* closing */ }
      if (this.paths) {
        try { rmSync(this.paths.base, { recursive: true, force: true }); directory = existsSync(this.paths.base) ? "failed" : "removed"; } catch { directory = "failed"; }
        if (directory === "failed") failure ??= new Error("directory");
      }
      this.options.revokeGrant();
      if (failure) throw failure;
      return Object.freeze({ reason, processes, directory, grant: "revoked" as const });
    })();
  }
}
