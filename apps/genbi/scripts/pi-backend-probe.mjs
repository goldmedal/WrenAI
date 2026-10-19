#!/usr/bin/env node
// Deterministic, no-model verification of a pi OpenShell boot. It makes no model call: the vendor is a scripted stub that runs on loopback inside an
// owned sandbox, and the credential is whatever dummy the operator gave the provider.
//
//   node scripts/pi-backend-probe.mjs --offline
//   node scripts/pi-backend-probe.mjs --dir <directory written by genbi-openshell-pi provision> [--prefix <owned name prefix>] [--out <file>]
//
// Offline (no gateway, no docker, no network; also run by run-vendor-contract-probes.mjs): the certification row is schema-valid and matches the assets this
// package ships, the rendered policy is deny-all plus one endpoint, and the operator helper's dry run plans without side effects.
// Gateway mode adds, against the boot in --dir: the certified identity of the configured image, the read-only gateway proof, the placeholder-only credential
// environment, egress denial with a positive control, a per-step pi worker round trip through the product provider, a two-turn pi session in one owned sandbox, and
// cleanup. The boot's endpoint must be the stub on loopback, so provision it with `"baseUrl": "http://127.0.0.1:<port>/v1"`. Every resource the probe creates is
// owned by the descriptor's gateway, and the probe refuses a boot whose provider, profile or gateway name does not start with --prefix.
// Output is JSON with no path, host name or sandbox id; with --out it is also written there (mode 0600).
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dist = (relative) => import(new URL(`../dist-server/${relative}`, import.meta.url).href);
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
const offline = flag("--offline");
const prefix = option("--prefix") ?? "genbi-pi-probe-";
const directory = option("--dir");
const outFile = option("--out");
if (!offline && (!directory || !path.isAbsolute(directory))) throw new Error("usage: pi-backend-probe.mjs --offline | --dir <absolute directory> [--prefix <name prefix>] [--out <file>]");

const sha = (value) => createHash("sha256").update(value).digest("hex");
const checks = [];
const check = (name, ok, detail) => { checks.push({ name, ok: !!ok, ...(detail !== undefined ? { detail } : {}) }); assert.ok(ok, `${name}${detail !== undefined ? ` ${JSON.stringify(detail)}` : ""}`); };
const root = mkdtempSync(path.join(os.tmpdir(), `${prefix}`));
chmodSync(root, 0o700);
const certification = await dist("server/runtime-host/openshell-vendor-certification.js");
const { describePackagedCertification, provisionPiBoot } = await dist("server/openshell-pi-operator.js");
const { renderPiEndpointAssets } = await dist("server/runtime-host/openshell-pi-assets.js");

let summary;
let failure;
try {
  // ---- Offline: row, shipped assets, rendered policy, helper dry run.
  const rows = certification.PI_CERTIFIED_ROWS.map((row) => certification.piCertificationSchema.parse(row));
  check("certification row is a strict certified_row", rows.length >= 1 && rows.every((row) => row.state === "certified_row"));
  const description = describePackagedCertification();
  check("shipped pi assets hash to the certified pins and templates", description.rows.every((row) => row.packagedAssetsMatch === true));
  check("the certified row is ready for exactly its own observation", rows.every((row) => certification.evaluatePiCertification({ host: row.host, gateway: row.gateway, pins: row.image.pins, templates: row.image.templates, conformance: { policy: true, profile: true } }, [row],
    { "@warble/cli": row.dependencies.warble, "@warble/codex-local": row.dependencies.warble, "@warble/claude-agent-sdk": row.dependencies.warble, "@warble/ir-spec": row.dependencies.ir, "@wrenai/context-loader": row.dependencies["context-loader"] }).ready === true));
  const assets = renderPiEndpointAssets({ host: "model.example.test", port: 443, profileId: "probe-profile", displayName: "Probe", credentialEnv: "PROBE_KEY" });
  check("rendered policy is deny-all plus one endpoint and the node binary", /hard_requirement/.test(assets.policy) && (assets.policy.match(/- host: /g) ?? []).length === 1 && /- path: \/usr\/local\/bin\/node/.test(assets.policy) && /run_as_user: "1500"/.test(assets.policy));
  check("rendered profile holds one credential name, one endpoint and the node binary only", (assets.profile.match(/- PROBE_KEY/g) ?? []).length === 1 && (assets.profile.match(/^- host: /gm) ?? []).length === 1 && /^- \/usr\/local\/bin\/node$/m.test(assets.profile));
  {
    const base = path.join(root, "dry-run"); mkdirSync(base, { mode: 0o700 });
    const executable = path.join(base, "openshell"); writeFileSync(executable, "#!/bin/sh\n", { mode: 0o700 });
    const digest = `sha256:${"a".repeat(64)}`;
    const baseConfig = path.join(base, "base.json");
    writeFileSync(baseConfig, JSON.stringify({ executable, executableDigest: digest, version: "0.0.1", gateway: "probe-gateway", workspace: "default", image: `sha256:${"b".repeat(64)}`, supervisorImage: digest, policy: executable, policyDigest: digest,
      home: base, configHome: base, stateHome: base, dockerExecutable: executable, dockerRealpath: executable, dockerDigest: digest, dockerSocket: path.join(base, "docker.sock"), dockerNamespace: "probe-gateway", exclusive: true }));
    const calls = [];
    const plan = await provisionPiBoot({ version: 1, baseDriverConfig: baseConfig, outDir: path.join(base, "out"), imageTag: "probe-pi-worker:1", gatewayUrl: "https://gateway.example.test/", caCert: executable, clientCert: executable, clientKey: executable,
      auth: "api-key", provider: "probe-provider", profileId: "probe-profile", displayLabel: "Probe", generation: "gen-1",
      endpoint: { providerId: "probe", api: "openai-completions", baseUrl: "https://model.example.test/v1", credentialEnv: "PROBE_KEY" }, models: { cheap: "probe-model" } }, { dryRun: true, run: async (...call) => { calls.push(call); return ""; } });
    check("operator helper dry run plans, runs nothing and prints the provider command with a placeholder", calls.length === 0 && plan.dryRun === true && plan.providerCommand.startsWith("PROBE_KEY=<your key> "));
  }
  summary = { mode: "offline" };

  if (!offline) {
    summary = { mode: "gateway" };
    const { resolveRuntimeSelection } = await dist("server/runtime-selection.js");
    const { readOpenShellConfiguration, OpenShellCliDriver } = await dist("server/runtime-host/openshell-driver.js");
    const { readOpenShellPiBoot, piProviderConfig, piEndpointAddress } = await dist("server/runtime-host/openshell-pi-boot.js");
    const { createPiGatewayVerifier } = await dist("server/runtime-host/openshell-pi-gateway.js");
    const { createPiCertificationGate } = await dist("server/runtime-host/openshell-pi-identity.js");
    const { OpenShellLifecycle } = await dist("server/runtime-host/openshell-lifecycle.js");
    const { launchOpenShellModelSession } = await dist("server/runtime-host/openshell-model-session.js");
    const { createOpenShellPiProvider, piAccountDigest } = await dist("server/runtime-host/openshell-pi-provider.js");
    const { runPiComponentStep } = await dist("server/runtime-host/pi-component-step.js");
    const { Store } = await dist("server/db.js");

    const env = { GENBI_RUNTIME: "openshell", GENBI_BACKEND: "pi", GENBI_OPENSHELL_CONFIG: path.join(directory, "driver-config.json"), GENBI_OPENSHELL_PI_BOOT: path.join(directory, "pi-boot.json") };
    const selection = resolveRuntimeSelection(env);
    const configuration = readOpenShellConfiguration(env, selection).configuration;
    const boot = readOpenShellPiBoot(env, selection);
    assert.ok(configuration?.pi && !configuration.model && boot, "the directory must hold a pi driver configuration and a protected descriptor written by the operator helper");
    const descriptor = boot.descriptor;
    for (const [what, value] of [["provider", descriptor.provider], ["profile", descriptor.profileId], ["gateway", configuration.gateway]]) assert.ok(String(value).startsWith(prefix), `the ${what} name does not start with ${prefix}: the probe only touches resources it owns`);
    const address = piEndpointAddress(descriptor.endpoint);
    assert.ok(["127.0.0.1", "localhost"].includes(address.host) && descriptor.endpoint.baseUrl.startsWith("http://"), "the boot's endpoint must be the stub on loopback");

    const cliEnv = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: configuration.home, XDG_CONFIG_HOME: configuration.configHome, XDG_STATE_HOME: configuration.stateHome, LANG: "en_US.UTF-8" };
    const cli = (argv, timeout = 60_000) => execFileSync(configuration.executable, ["--gateway", configuration.gateway, "--workspace", configuration.workspace, ...argv], { env: cliEnv, encoding: "utf8", timeout, stdio: ["ignore", "pipe", "pipe"] });
    const sandboxNames = () => cli(["sandbox", "list", "--names"]).split("\n").map((line) => line.trim()).filter(Boolean);
    const sandboxExec = (name, argv) => cli(["sandbox", "exec", "--name", name, "--workdir", "/sandbox", "--timeout", "30", "--no-login-shell", "--no-tty", "--env", "HOME=/sandbox", "--env", "PATH=/usr/bin:/bin", "--", ...argv]);
    const before = new Set(sandboxNames());

    const NODE = "/usr/local/bin/node";
    const stubDir = `/tmp/${prefix}stub`;
    const stubSource = readFileSync(fileURLToPath(new URL("./pi-probe-stub-vendor.mjs", import.meta.url))).toString("base64");
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    async function installStub(name) {
      let last;
      for (let attempt = 0; attempt < 60; attempt++) {
        try { sandboxExec(name, [NODE, "-e", `const fs=require('fs');fs.mkdirSync('${stubDir}',{recursive:true});fs.writeFileSync('${stubDir}/stub.mjs',Buffer.from('${stubSource}','base64'));`]); last = undefined; break; }
        catch (error) { last = error; await sleep(1000); }
      }
      if (last) throw last;
      sandboxExec(name, [NODE, "-e", `require('child_process').spawn(process.execPath,['${stubDir}/stub.mjs','${address.port}','${stubDir}/stub.jsonl'],{detached:true,stdio:'ignore'}).unref();`]);
      for (let attempt = 0; attempt < 40; attempt++) {
        if (sandboxExec(name, [NODE, "-e", `fetch('http://127.0.0.1:${address.port}/v1/models').then(r=>console.log('up',r.status)).catch(()=>console.log('down'))`]).includes("up")) return;
        await sleep(250);
      }
      throw new Error("the sandbox stub did not start");
    }

    // The probe observes the product driver instance it hands to the lifecycle. Product code is not modified: the wrapper installs the stub after a sandbox exists (before the
    // lifecycle takes its process baseline), records every control reply and every frame shape, and reads the stub's own log just before a sandbox is removed.
    const driver = new OpenShellCliDriver(configuration, undefined, boot.duplex);
    const created = [], controls = [], stubLogs = [];
    const frames = { total: 0, skShaped: 0, placeholder: 0 };
    const origCreate = driver.create.bind(driver), origExec = driver.exec.bind(driver), origDuplex = driver.duplex.bind(driver), origRemove = driver.remove.bind(driver);
    driver.create = async (intent, signal) => { created.push(intent.name); const resource = await origCreate(intent, signal); await installStub(intent.name); return resource; };
    driver.exec = async (intent, argv, signal) => {
      const out = await origExec(intent, argv, signal);
      if (intent.identity.purpose === "model_session") { let reply; try { reply = JSON.parse(out); } catch { reply = {}; } controls.push({ kind: argv[2] === "--baseline" ? "baseline" : argv[2] === "--check" ? "check" : "cleanup", remaining: reply.remaining }); }
      return out;
    };
    driver.duplex = async (intent, argv, signal) => {
      const stream = await origDuplex(intent, argv, signal); const write = stream.write.bind(stream); const output = stream.output;
      const scan = (data) => { const text = Buffer.from(data).toString("utf8"); frames.total++; if (/sk-[A-Za-z0-9_-]{8,}/.test(text)) frames.skShaped++; if (text.includes("openshell:resolve:env:")) frames.placeholder++; };
      stream.write = (data) => { scan(data); return write(data); };
      stream.output = (async function* () { for await (const event of output) { if (event && event.data) scan(event.data); yield event; } })();
      return stream;
    };
    driver.remove = async (intent, ...rest) => {
      try { stubLogs.push(sandboxExec(intent.name, [NODE, "-e", `process.stdout.write(require('fs').readFileSync('${stubDir}/stub.jsonl','utf8'))`]).split("\n").filter(Boolean).map((line) => JSON.parse(line))); } catch { stubLogs.push(undefined); }
      return origRemove(intent, ...rest);
    };

    const stateRoot = path.join(root, "lifecycle"); mkdirSync(stateRoot, { mode: 0o700 });
    const store = new Store(":memory:");
    const lifecycle = new OpenShellLifecycle({ driver, journal: store, stateRoot, exclusive: true });
    await lifecycle.initialize();
    try {
      // 1. Identity: the lifecycle probe, the read-only gateway proof and the certified identity of the configured image, exactly as boot readiness composes them.
      check("lifecycle probe is ready", (await lifecycle.probe()).readiness.state === "ready");
      await createPiGatewayVerifier({ configuration, descriptor })();
      check("gateway proof passes: provider, profile, one endpoint, node binary, credential name", true);
      const verdict = await createPiCertificationGate({ configuration, descriptor })();
      check("the configured image, policy, profile, OpenShell build and components are certified", verdict.ready === true, verdict.ready ? { piVersion: verdict.version } : { code: verdict.code });

      const digest = `sha256:${"a".repeat(64)}`;
      const models = descriptor.models; const [tier, model] = Object.entries(models)[0];
      const providerConfig = piProviderConfig(descriptor);
      const base = { backend: "openshell", account: piAccountDigest(providerConfig), generation: descriptor.generation, binding: `${prefix}binding`, bindingGeneration: "1", bindingRevision: digest, context: digest, plan: digest, ...lifecycle.modelIdentity };
      const stepIdentity = (session, turn) => ({ ...base, session, turn, purpose: "model", operation: "step", snapshot: "none", invocation: randomUUID(), step: randomUUID(), attempt: 1, model, tier });

      // 2. One owned per-step sandbox: placeholder-only credential environment, egress denial with a positive control.
      {
        const identity = stepIdentity(`${prefix}raw`, "turn-raw");
        const lease = await lifecycle.launch(await lifecycle.prepareLaunch(identity, () => identity));
        let result;
        try {
          const script = `(async()=>{const out={};const v=process.env[${JSON.stringify(descriptor.endpoint.credentialEnv)}];
out.credential={present:v!==undefined,placeholder:/^openshell:resolve:env:[A-Za-z0-9_]+$/.test(v||''),startsWithSk:(v||'').startsWith('sk-')};
out.keyShapedVariables=Object.values(process.env).filter(x=>/sk-[A-Za-z0-9_-]{8,}/.test(x||'')).length;
const attempt=async(url)=>{try{const r=await fetch(url,{signal:AbortSignal.timeout(5000)});return{reached:true,status:r.status}}catch(e){return{reached:false}}};
out.endpoint=await attempt('http://${address.host}:${address.port}/v1/models');
out.publicInternet=await attempt('https://example.com/');
out.otherPortOnEndpointHost=await attempt('http://${address.host}:${address.port === 65535 ? 65534 : address.port + 1}/');
console.log(JSON.stringify(out));})();`;
          result = JSON.parse((await lease.exec([NODE, "-e", script])).trim().split("\n").pop());
        } finally { await lease.close(); }
        const blocked = (attempt) => attempt.reached === false || attempt.status >= 400;
        check("credential variable holds only the OpenShell placeholder, never a key-shaped value", result.credential.present && result.credential.placeholder && !result.credential.startsWithSk && result.keyShapedVariables === 0, result.credential);
        check("positive control: the one allowed endpoint is reachable from the sandbox", result.endpoint.reached && result.endpoint.status < 500, result.endpoint);
        check("egress denial: the public internet is blocked", blocked(result.publicInternet), result.publicInternet);
        check("egress denial: another port on the allowed host is blocked", blocked(result.otherPortOnEndpointHost), result.otherPortOnEndpointHost);
      }

      // 3. The real pi worker, per step: one fresh sandbox, the real pi in the image against the stub, the host answering the one tool call.
      const SQL = "SELECT COUNT(*) AS n FROM orders";
      const toolCalls = [];
      const schema = { type: "object", properties: { sql: { type: "string" } }, required: ["sql"], additionalProperties: false };
      const stepRun = () => ({ tier, request: "probe", input: { question: "how many orders" }, brief: "You answer with the result of the one tool.", prompt: "Call the tool once, then answer.", consumes: {}, children: [],
        tools: { query: async (input) => { toolCalls.push(input); return { columns: ["n"], rows: [{ n: 7 }] }; } }, toolSchemas: { query: schema }, toolDescriptions: { query: "Run one read-only query." }, signal: new AbortController().signal });
      const cleanups = [];
      const provider = (scope, modelSession) => createOpenShellPiProvider({ lifecycle, config: providerConfig, models, scope, ...(modelSession ? { modelSession } : {}), currentScope: () => scope, assertCurrent() {}, onCleanup: (report) => cleanups.push(report) });
      const { purpose: _p, operation: _o, snapshot: _s, invocation: _i, step: _t, attempt: _a, model: _m, tier: _r, ...stepScope } = stepIdentity(`${prefix}step`, "turn-step");
      {
        const response = await runPiComponentStep(await provider(stepScope).open(model, new AbortController().signal, tier), stepRun());
        check("per-step round trip: the real pi called the one host tool and relayed the stub's answer", toolCalls.length === 1 && toolCalls[0].sql === SQL && typeof response.value === "string" && response.value.includes('"rows":[{"n":999999}]'));
        check("per-step cleanup proven by sandbox teardown", cleanups.at(-1)?.teardown === "proven", cleanups.at(-1));
      }

      // 4. A two-turn pi session: one owned sandbox, two fresh worker processes, each cleaned by the session control before the next.
      {
        const sessionIdentity = { ...base, session: `${prefix}session`, purpose: "model_session", operation: "session", snapshot: "none" };
        const session = await launchOpenShellModelSession(lifecycle, await lifecycle.prepareLaunch(sessionIdentity, () => sessionIdentity), sessionIdentity, "pi");
        const sessionScope = { ...base, session: `${prefix}session`, turn: "turn-1" };
        const sandboxesBefore = created.length;
        try {
          for (const turn of ["turn-1", "turn-2"]) {
            toolCalls.length = 0;
            const response = await runPiComponentStep(await provider({ ...sessionScope, turn }, session).open(model, new AbortController().signal, tier), stepRun());
            check(`session ${turn}: the real pi called the one host tool and answered`, toolCalls.length === 1 && response.value.includes("999999"));
          }
        } finally { await session.close(); }
        check("session: exactly one sandbox served both turns", created.length === sandboxesBefore, { sandboxesForTwoTurns: 1 });
        const kinds = controls.map((entry) => entry.kind).join(",");
        check("session: baseline once, then check and cleanup around each turn, nothing left running", kinds === "baseline,check,cleanup,check,cleanup" && controls.filter((entry) => entry.kind === "cleanup").every((entry) => entry.remaining === 0), { controls: kinds });
      }
      check("the stub only ever saw the placeholder, never a key-shaped Authorization value", stubLogs.flat().filter(Boolean).every((entry) => entry.authLooksLikeKey !== true) && stubLogs.flat().filter(Boolean).some((entry) => entry.authLooksLikePlaceholder === true));
      check("no frame crossing the host-sandbox channel held a key-shaped value", frames.total > 0 && frames.skShaped === 0, { frames: frames.total, keyShaped: frames.skShaped });
    } finally {
      await lifecycle.shutdown();
    }
    const remaining = sandboxNames().filter((name) => !before.has(name));
    check("cleanup: every ownership intent is cleaned and no sandbox this run created remains", store.listOpenShellIntents().every((intent) => intent.phase === "cleaned") && remaining.length === 0, { sandboxesCreated: created.length, remaining: remaining.length });
    store.close();
    const row = certification.PI_CERTIFIED_ROWS.map((value) => certification.piCertificationSchema.parse(value))[0];
    summary = { mode: "gateway", piVersion: row.image.pins.piVersion, host: row.host, gateway: row.gateway, dependencies: row.dependencies, sandboxesCreated: created.length };
  }
} catch (error) {
  failure = String(error?.message ?? error).split("\n")[0].slice(0, 300);
} finally {
  rmSync(root, { recursive: true, force: true });
}
const output = { kind: "deterministic_pi_evidence", date: new Date().toISOString().slice(0, 10), vendor: "pi", runner: "scripts/pi-backend-probe.mjs", modelCalls: 0, ...(summary ?? {}), ok: failure === undefined && checks.every((entry) => entry.ok), ...(failure !== undefined ? { failure } : {}), checks };
const text = `${JSON.stringify(output, null, 2)}\n`;
if (outFile) { writeFileSync(outFile, text, { mode: 0o600 }); chmodSync(outFile, 0o600); }
process.stdout.write(text);
process.exitCode = output.ok ? 0 : 1;
