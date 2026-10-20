import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { OpenShellCliDriver, type OpenShellConfiguration } from "../server/runtime-host/openshell-driver.js";
import { OPEN_SHELL_OWNER_LABEL, type OpenShellDuplex, type OpenShellIdentity, type OpenShellIntent } from "../server/runtime-host/openshell-types.js";

const directories: string[] = [];
afterEach(() => { for (const root of directories.splice(0)) rmSync(root, { recursive: true, force: true }); });
const sha = (char: string) => `sha256:${char.repeat(64)}`;
const claudeImage = sha("a"), piImage = sha("c"), supervisor = sha("b");
const fileDigest = (file: string) => `sha256:${createHash("sha256").update(readFileSync(file)).digest("hex")}`;

/** Fake CLI and Docker: record every call, answer inspection from a scenario file. */
function fixture(options: { claude?: boolean; pi?: boolean } = { claude: true, pi: true }) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "genbi-pi-driver-"))); directories.push(root);
  const executable = path.join(root, "cli.cjs"), docker = path.join(root, "docker.cjs");
  const files = { policy: path.join(root, "base.yaml"), claudePolicy: path.join(root, "claude.yaml"), piPolicy: path.join(root, "pi.yaml"), profile: path.join(root, "profile.yaml") };
  writeFileSync(files.policy, "base policy"); writeFileSync(files.claudePolicy, "claude policy"); writeFileSync(files.piPolicy, "pi policy"); writeFileSync(files.profile, "id: pi-profile\n");
  writeFileSync(path.join(root, "scenario.json"), "{}");
  writeFileSync(executable, `#!${process.execPath}
const fs=require('node:fs');const dir=process.env.XDG_CONFIG_HOME;const s=JSON.parse(fs.readFileSync(dir+'/scenario.json'));const a=process.argv.slice(2);
fs.appendFileSync(dir+'/cli-calls.jsonl',JSON.stringify(a)+'\\n');
if(a.includes('--version'))console.log('openshell 0.0.1');
else if(a.includes('info'))console.log(JSON.stringify({version:'0.0.1',status:'healthy',compute_drivers:[{name:'docker'}]}));
else if(a.includes('create'))console.log('created');
else if(a.includes('list'))console.log(JSON.stringify({sandboxes:s.resources||[],next_page_token:''}));
else if(a.includes('get'))console.log(JSON.stringify(s.resource));
else if(a.includes('exec'))console.log('exec ok');
else if(a.includes('delete'))console.log('deleted');
else{console.log('private diagnostic');process.exit(1);}
`);
  writeFileSync(docker, `#!${process.execPath}
const fs=require('node:fs');const dir=process.env.XDG_CONFIG_HOME;const s=JSON.parse(fs.readFileSync(dir+'/scenario.json'));const a=process.argv.slice(2);
fs.appendFileSync(dir+'/docker-calls.jsonl',JSON.stringify(a)+'\\n');
if(a[0]==='image')console.log(JSON.stringify([{Id:a[2]}]));
else if(a.includes('volume'))console.log('');
else if(a[0]==='inspect')console.log(JSON.stringify(s.records||[]));
else console.log(s.container||'');
`);
  chmodSync(executable, 0o700); chmodSync(docker, 0o700);
  const configuration: OpenShellConfiguration = { executable, executableDigest: fileDigest(executable), version: "0.0.1", gateway: "fixture", workspace: "default", image: claudeImage, supervisorImage: supervisor,
    policy: files.policy, policyDigest: fileDigest(files.policy), home: root, configHome: root, stateHome: root, dockerExecutable: docker, dockerRealpath: docker, dockerDigest: fileDigest(docker), dockerSocket: path.join(root, "fixture.sock"), dockerNamespace: "fixture", exclusive: true,
    ...(options.claude === false ? {} : { model: { image: claudeImage, policy: files.claudePolicy, policyDigest: fileDigest(files.claudePolicy) } }),
    ...(options.pi === false ? {} : { pi: { image: piImage, policy: files.piPolicy, policyDigest: fileDigest(files.piPolicy), provider: "pi-vendor", profile: files.profile, profileDigest: fileDigest(files.profile) } }) };
  const opened: { intent: OpenShellIntent; argv: readonly string[] }[] = [];
  const openDuplex = async (intent: OpenShellIntent, argv: readonly string[]): Promise<OpenShellDuplex> => { opened.push({ intent, argv }); return { output: (async function* () {})(), write() {}, close() {}, done: Promise.resolve(0) }; };
  const driver = new OpenShellCliDriver(configuration, undefined, openDuplex);
  const calls = (file: string) => { try { return readFileSync(path.join(root, file), "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as string[]); } catch { return []; } };
  const scenario = (value: object) => writeFileSync(path.join(root, "scenario.json"), JSON.stringify(value));
  return { root, configuration, files, driver, opened, scenario, cli: () => calls("cli-calls.jsonl"), dockerCalls: () => calls("docker-calls.jsonl"), rewrite: (file: string, text: string) => writeFileSync(file, text) };
}
const identity = (image: string, purpose: "model" | "model_session" = "model"): OpenShellIdentity => ({ backend: "openshell", account: sha("1"), generation: "1", session: "s", turn: "t", binding: "b", bindingGeneration: "1", bindingRevision: sha("2"), context: sha("3"), plan: sha("4"),
  image, policy: sha("5"), gateway: "fixture", workspace: "default", configuration: sha("6"),
  ...(purpose === "model" ? { purpose, operation: "step", snapshot: "none", invocation: "11111111-2222-4333-8444-555555555555", step: "11111111-2222-4333-8444-555555555556", attempt: 1, model: "m", tier: "fast" } : { purpose, operation: "session", snapshot: "none" }) } as OpenShellIdentity);
const intent = (image: string, purpose: "model" | "model_session" = "model"): OpenShellIntent => ({ id: "11111111-2222-4333-8444-555555555557", owner: "owner", name: "gb-0123456789abcdef", identity: identity(image, purpose), createdAt: 0, phase: "intent", acknowledged: false, interrupted: false, remoteId: "remote" });
const resourceFor = (value: OpenShellIntent) => ({ id: "remote", name: value.name, workspace: "default", labels: { [OPEN_SHELL_OWNER_LABEL]: "owner" } });
const containers = (image: string, name = "gb-0123456789abcdef") => [false, true].map(supervisorContainer => ({ Id: (supervisorContainer ? "e" : "d").repeat(64), Name: `/openshell-default--${name}-remote${supervisorContainer ? "-supervisor" : ""}`, Image: supervisorContainer ? supervisor : image,
  Config: { Labels: { "openshell.ai/sandbox-id": "remote", "openshell.ai/sandbox-namespace": "fixture" } }, Mounts: [], State: { Running: true } }));
const runnable = (f: ReturnType<typeof fixture>, value: OpenShellIntent, image: string) => { const rows = containers(image); f.scenario({ resource: resourceFor(value), container: rows.map(row => `${row.Id} ${row.Name.slice(1)}`).join("\n"), records: rows }); };
const dataWorker = (image: string) => ({ image, script: sha("7"), wheel: sha("8"), toolchain: sha("9"), architecture: "linux-arm64" as const, protocol: "wren-governed/2" as const });
const dataPolicyFields = (f: ReturnType<typeof fixture>) => ({ dataPolicy: f.files.policy, dataPolicyDigest: fileDigest(f.files.policy),
  snapshotCapture: { executable: f.configuration.executable, realpath: f.configuration.executable, digest: sha("6"), helperDigest: sha("5"), approvedFiles: ["a", "b"] } });
const createArgs = (f: ReturnType<typeof fixture>) => f.cli().find(argv => argv.includes("create"))!;

describe("pi block in the OpenShell driver is additive and keyed to the pi image", () => {
  it("parses the optional pi block strictly and keeps Claude-only configurations valid", () => {
    expect(fixture({ claude: true, pi: false }).driver.piIdentity).toBeUndefined();
    const f = fixture(); const bad = { ...f.configuration, pi: { ...f.configuration.pi!, extra: 1 } } as unknown as OpenShellConfiguration;
    expect(() => new OpenShellCliDriver(bad)).toThrow();
    for (const patch of [{ image: "latest" }, { provider: "bad name" }, { profile: "relative.yaml" }, { profileDigest: "sha256:zz" }]) expect(() => new OpenShellCliDriver({ ...f.configuration, pi: { ...f.configuration.pi!, ...patch } })).toThrow();
  });
  it("rejects a pi image that equals the base, Claude or data worker image at construction, and leaves other configurations alone", () => {
    const f = fixture(); const pi = f.configuration.pi!;
    for (const patch of [{ image: pi.image }, { model: { image: pi.image, policy: f.files.claudePolicy, policyDigest: fileDigest(f.files.claudePolicy) } },
      { dataWorker: dataWorker(pi.image), ...dataPolicyFields(f) }])
      expect(() => new OpenShellCliDriver({ ...f.configuration, ...patch } as OpenShellConfiguration)).toThrow();
    expect(() => new OpenShellCliDriver({ ...f.configuration, dataWorker: dataWorker(sha("3")), ...dataPolicyFields(f) } as OpenShellConfiguration)).not.toThrow();
    expect(() => new OpenShellCliDriver(fixture({ claude: true, pi: false }).configuration)).not.toThrow(); expect(() => new OpenShellCliDriver(fixture({ claude: false, pi: true }).configuration)).not.toThrow();
    expect(() => new OpenShellCliDriver({ ...f.configuration, model: { image: sha("4"), policy: f.files.claudePolicy, policyDigest: fileDigest(f.files.claudePolicy) } })).not.toThrow();
  });
  it("keeps the Claude model identity when both vendors are configured, and serves pi from a pi-only configuration", () => {
    const both = fixture(); expect(both.driver.modelIdentity).toMatchObject({ image: claudeImage }); expect(both.driver.piIdentity).toMatchObject({ image: piImage, policy: both.configuration.pi!.policyDigest });
    const only = fixture({ claude: false, pi: true }); expect(only.driver.modelIdentity).toEqual(only.driver.piIdentity); expect(only.driver.modelIdentity).toMatchObject({ image: piImage });
    expect(fixture({ claude: true, pi: false }).driver.modelIdentity).toMatchObject({ image: claudeImage });
  });
  it("creates a pi sandbox from the pi image and policy with the vendor provider, and never passes a provider for Claude", async () => {
    const f = fixture(); const pi = intent(piImage); runnable(f, pi, piImage);
    await f.driver.create(pi, new AbortController().signal);
    const argv = createArgs(f); expect(argv).toContain("--no-auto-providers");
    expect(argv[argv.indexOf("--from") + 1]).toBe(piImage); expect(argv[argv.indexOf("--policy") + 1]).toBe(f.files.piPolicy);
    expect(argv.filter(value => value === "--provider")).toHaveLength(1); expect(argv[argv.indexOf("--provider") + 1]).toBe("pi-vendor");
    const claude = intent(claudeImage); runnable(f, claude, claudeImage); const before = f.cli().length; await f.driver.create(claude, new AbortController().signal);
    const next = f.cli().slice(before).find(call => call.includes("create"))!; expect(next).not.toContain("--provider"); expect(next[next.indexOf("--from") + 1]).toBe(claudeImage); expect(next[next.indexOf("--policy") + 1]).toBe(f.files.claudePolicy);
  });
  it("creates exactly as before for a Claude-only configuration", async () => {
    const f = fixture({ claude: true, pi: false }); const claude = intent(claudeImage); runnable(f, claude, claudeImage); await f.driver.create(claude, new AbortController().signal);
    const argv = createArgs(f); expect(argv).not.toContain("--provider"); expect(argv.slice(argv.indexOf("--from"), argv.indexOf("--from") + 4)).toEqual(["--from", claudeImage, "--policy", f.files.claudePolicy]);
  });
  it("refuses a model intent whose image is neither configured model image", async () => {
    const f = fixture(); const stranger = intent(sha("9")); await expect(f.driver.create(stranger, new AbortController().signal)).rejects.toMatchObject({ code: "openshell_scope_invalid" });
    expect(f.cli().filter(call => call.includes("create"))).toHaveLength(0);
    const only = fixture({ claude: false, pi: true }); await expect(only.driver.create(intent(claudeImage), new AbortController().signal)).rejects.toMatchObject({ code: "openshell_scope_invalid" });
  });
  it("verifies the pi and supervisor containers against the pi image, not the Claude image", async () => {
    const f = fixture(); const pi = intent(piImage); runnable(f, pi, piImage); await expect(f.driver.inspect(pi)).resolves.toMatchObject({ containers: expect.any(Array) });
    runnable(f, pi, claudeImage); await expect(f.driver.inspect(pi)).rejects.toMatchObject({ code: "openshell_identity_mismatch" });
    const claude = intent(claudeImage); runnable(f, claude, claudeImage); await expect(f.driver.inspect(claude)).resolves.toBeDefined(); runnable(f, claude, piImage); await expect(f.driver.inspect(claude)).rejects.toMatchObject({ code: "openshell_identity_mismatch" });
  });
  it("admits the pi worker argv only for a pi-image model intent, and Claude argvs only for Claude intents", async () => {
    const f = fixture(); const pi = intent(piImage), claude = intent(claudeImage);
    const piWorker = ["/usr/local/bin/node", "/opt/genbi/pi-worker.mjs"], claudeWorker = ["/usr/local/bin/node", "/opt/genbi/claude-worker.mjs"];
    runnable(f, pi, piImage); await expect(f.driver.duplex(pi, piWorker, new AbortController().signal)).resolves.toBeDefined(); expect(f.opened.at(-1)!.argv).toEqual(piWorker);
    for (const argv of [claudeWorker, ["/usr/local/bin/node", "/opt/genbi/claude-session-step.mjs"], ["/usr/local/bin/node", "/opt/genbi/pi-worker.mjs", "--extra"], ["/bin/sh", "-c", "id"], ["/usr/local/bin/node", "/opt/genbi/pi-mcp-shim.mjs"], ["/usr/local/bin/node", "-e", "1"]])
      await expect(f.driver.duplex(pi, argv, new AbortController().signal), argv.join(" ")).rejects.toMatchObject({ code: "openshell_scope_invalid" });
    runnable(f, claude, claudeImage); await expect(f.driver.duplex(claude, claudeWorker, new AbortController().signal)).resolves.toBeDefined();
    await expect(f.driver.duplex(claude, piWorker, new AbortController().signal)).rejects.toMatchObject({ code: "openshell_scope_invalid" });
    const session = intent(piImage, "model_session"); await expect(f.driver.duplex(session, piWorker, new AbortController().signal)).rejects.toMatchObject({ code: "openshell_scope_invalid" });
    expect(f.opened).toHaveLength(2);
  });
  it("probes the pi image and rehashes the pi policy and the provider profile like every other pinned input", async () => {
    const f = fixture(); await f.driver.probe(); expect(f.dockerCalls().filter(call => call[0] === "image").map(call => call[2])).toContain(piImage);
    f.rewrite(f.files.profile, "id: tampered\n"); await expect(f.driver.probe()).rejects.toMatchObject({ code: "openshell_identity_mismatch" }); f.rewrite(f.files.profile, "id: pi-profile\n"); await f.driver.probe();
    f.rewrite(f.files.piPolicy, "tampered"); await expect(f.driver.probe()).rejects.toMatchObject({ code: "openshell_identity_mismatch" });
    const pi = intent(piImage); runnable(f, pi, piImage); await expect(f.driver.create(pi, new AbortController().signal)).rejects.toMatchObject({ code: "openshell_identity_mismatch" });
    expect(f.cli().filter(call => call.includes("create"))).toHaveLength(0);
  });
  it("does not change how a Claude intent is handled when the pi block is present", async () => {
    const f = fixture(); const claude = intent(claudeImage); runnable(f, claude, claudeImage);
    await f.driver.duplex(claude, ["/usr/local/bin/node", "/opt/genbi/claude-worker.mjs"], new AbortController().signal);
    expect((await f.driver.exec(claude, ["/bin/echo", "x"], new AbortController().signal)).trim()).toBe("exec ok");
  });
});

describe("an owned pi model session in the OpenShell driver", () => {
  const piSessionStep = ["/usr/local/bin/node", "/opt/genbi/pi-session-step.mjs"], piControl = ["/usr/local/bin/node", "/opt/genbi/pi-step-control.mjs"];
  const claudeSessionStep = ["/usr/local/bin/node", "/opt/genbi/claude-session-step.mjs"], claudeControl = ["/usr/local/bin/node", "/opt/genbi/claude-step-control.mjs"];
  const piWorker = ["/usr/local/bin/node", "/opt/genbi/pi-worker.mjs"], procCheck = ["/usr/local/bin/node", "/opt/genbi/pi-proc-check.mjs"];
  it("creates a pi-image model_session sandbox from the pi image and policy with the vendor provider and no Claude block", async () => {
    const f = fixture(); const session = intent(piImage, "model_session"); runnable(f, session, piImage);
    await f.driver.create(session, new AbortController().signal);
    const argv = createArgs(f); expect(argv[argv.indexOf("--from") + 1]).toBe(piImage); expect(argv[argv.indexOf("--policy") + 1]).toBe(f.files.piPolicy);
    expect(argv.filter(value => value === "--provider")).toHaveLength(1); expect(argv[argv.indexOf("--provider") + 1]).toBe("pi-vendor"); expect(argv).toContain("--no-auto-providers");
    const only = fixture({ claude: false, pi: true }); const alone = intent(piImage, "model_session"); runnable(only, alone, piImage); await only.driver.create(alone, new AbortController().signal);
    expect(createArgs(only)[createArgs(only).indexOf("--from") + 1]).toBe(piImage);
  });
  it("still creates a Claude-image model_session exactly as before, with no provider", async () => {
    const f = fixture(); const session = intent(claudeImage, "model_session"); runnable(f, session, claudeImage); await f.driver.create(session, new AbortController().signal);
    const argv = createArgs(f); expect(argv).not.toContain("--provider"); expect(argv.slice(argv.indexOf("--from"), argv.indexOf("--from") + 4)).toEqual(["--from", claudeImage, "--policy", f.files.claudePolicy]);
  });
  it("verifies the session's containers against the pi image, not the Claude image", async () => {
    const f = fixture(); const session = intent(piImage, "model_session"); runnable(f, session, piImage); await expect(f.driver.inspect(session)).resolves.toBeDefined();
    runnable(f, session, claudeImage); await expect(f.driver.inspect(session)).rejects.toMatchObject({ code: "openshell_identity_mismatch" });
  });
  it("admits only the pi session-step argv for a pi-image session, and nothing else for it", async () => {
    const f = fixture(); const session = intent(piImage, "model_session"); runnable(f, session, piImage);
    await expect(f.driver.duplex(session, piSessionStep, new AbortController().signal)).resolves.toBeDefined(); expect(f.opened.at(-1)!.argv).toEqual(piSessionStep);
    for (const argv of [piWorker, claudeSessionStep, ["/usr/local/bin/node", "/opt/genbi/claude-worker.mjs"], piControl, [...piSessionStep, "--extra"], ["/bin/sh", "-c", "id"], ["/usr/local/bin/node", "-e", "1"], ["/usr/local/bin/node", "/opt/genbi/pi-mcp-shim.mjs"]])
      await expect(f.driver.duplex(session, argv, new AbortController().signal), argv.join(" ")).rejects.toMatchObject({ code: "openshell_scope_invalid" });
    expect(f.opened).toHaveLength(1);
  });
  it("never lets a pi step intent run the session-step argv, or a Claude-image intent run any pi argv, and the reverse", async () => {
    const f = fixture(); const pi = intent(piImage), claudeStep = intent(claudeImage), claudeSession = intent(claudeImage, "model_session");
    runnable(f, pi, piImage); await expect(f.driver.duplex(pi, piSessionStep, new AbortController().signal)).rejects.toMatchObject({ code: "openshell_scope_invalid" });
    for (const claude of [claudeStep, claudeSession]) { runnable(f, claude, claudeImage); for (const argv of [piWorker, piSessionStep]) await expect(f.driver.duplex(claude, argv, new AbortController().signal), argv.join(" ")).rejects.toMatchObject({ code: "openshell_scope_invalid" }); }
    runnable(f, claudeSession, claudeImage); await expect(f.driver.duplex(claudeSession, claudeSessionStep, new AbortController().signal)).resolves.toBeDefined();
    expect(f.opened).toHaveLength(1);
  });
  it("runs only the fixed pi step control in a pi-image session, with its three documented shapes", async () => {
    const f = fixture(); const session = intent(piImage, "model_session"); runnable(f, session, piImage);
    for (const argv of [[...piControl, "--baseline"], [...piControl, "--check", "{}"], [...piControl, "{}"]]) expect((await f.driver.exec(session, argv, new AbortController().signal)).trim(), argv.join(" ")).toBe("exec ok");
    const before = f.cli().filter(call => call.includes("exec")).length;
    for (const argv of [claudeControl, [...claudeControl, "--baseline"], ["/bin/echo", "x"], procCheck, piWorker, piSessionStep, piControl, [...piControl, "a", "b", "c"], ["/usr/local/bin/node", "/opt/genbi/other.mjs", "--baseline"]])
      await expect(f.driver.exec(session, argv, new AbortController().signal), argv.join(" ")).rejects.toMatchObject({ code: "openshell_scope_invalid" });
    expect(f.cli().filter(call => call.includes("exec"))).toHaveLength(before);
  });
  it("refuses an exec that names a pi script on any intent that is not a pi-image model intent, and leaves per-step pi and Claude exec alone", async () => {
    const f = fixture(); const claudeStep = intent(claudeImage), claudeSession = intent(claudeImage, "model_session"), pi = intent(piImage);
    for (const claude of [claudeStep, claudeSession]) { runnable(f, claude, claudeImage); for (const argv of [piControl, [...piControl, "--baseline"], procCheck, piWorker, piSessionStep]) await expect(f.driver.exec(claude, argv, new AbortController().signal), argv.join(" ")).rejects.toMatchObject({ code: "openshell_scope_invalid" }); }
    runnable(f, claudeSession, claudeImage);
    expect((await f.driver.exec(claudeSession, [...claudeControl, "--baseline"], new AbortController().signal)).trim()).toBe("exec ok"); expect((await f.driver.exec(claudeStep, ["/bin/echo", "x"], new AbortController().signal)).trim()).toBe("exec ok");
    runnable(f, pi, piImage); expect((await f.driver.exec(pi, procCheck, new AbortController().signal)).trim()).toBe("exec ok");
  });
});
