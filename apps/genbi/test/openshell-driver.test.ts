import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { OpenShellCliDriver, readOpenShellConfiguration, runOpenShellCommand, type OpenShellConfiguration } from "../server/runtime-host/openshell-driver.js";
import type { OpenShellIntent } from "../server/runtime-host/openshell-types.js";
import { createOpenShellRuntimeComposition } from "../server/openshell-runtime-composition.js";
import { Store } from "../server/db.js";

const directories: string[] = [];
afterEach(() => { for (const root of directories.splice(0)) rmSync(root, { recursive: true, force: true }); });
const supervisorDigest = `sha256:${"b".repeat(64)}`;
const digest = `sha256:${"a".repeat(64)}`;
const sha = (file: string) => `sha256:${createHash("sha256").update(readFileSync(file)).digest("hex")}`;
function fixture() {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "genbi-cli-contract-"))); directories.push(root);
  const executable = path.join(root, "cli.cjs"), docker = path.join(root, "docker.cjs"), policy = path.join(root, "policy.yaml");
  writeFileSync(policy, "synthetic policy");
  writeFileSync(path.join(root, "scenario.json"), "{}");
  writeFileSync(executable, `#!${process.execPath}\nconst fs=require('node:fs');const s=JSON.parse(fs.readFileSync(process.env.XDG_CONFIG_HOME+'/scenario.json'));const a=process.argv.slice(2);if(a.includes('--version'))console.log(s.version||'openshell 0.0.1');else if(a.includes('info')){if(s.gatewayMissing)process.exit(1);console.log(JSON.stringify({version:'0.0.1',status:'healthy',compute_drivers:[{name:'docker'}]}));}else if(a.includes('list')){if(s.malformed)console.log('not-json');else console.log(JSON.stringify({sandboxes:s.resources||[],next_page_token:s.page||''}));}else if(a.includes('get'))console.log(JSON.stringify(s.resource));else{console.log('private diagnostic');process.exit(1);}\n`);
  writeFileSync(docker, `#!${process.execPath}\nconst fs=require('node:fs');const s=JSON.parse(fs.readFileSync(process.env.XDG_CONFIG_HOME+'/scenario.json'));fs.appendFileSync(process.env.XDG_CONFIG_HOME+'/docker-calls.jsonl',JSON.stringify(process.argv.slice(2))+'\\n');if(process.argv.includes('image'))console.log(JSON.stringify([{Id:process.argv.includes('${supervisorDigest}')?(s.supervisor||'${supervisorDigest}'):(s.image||'${digest}')}]));else if(process.argv.includes('volume'))console.log(s.volume||'');else if(process.argv.includes('inspect'))console.log(JSON.stringify(s.records||[]));else console.log(s.container||'');\n`);
  chmodSync(executable, 0o700); chmodSync(docker, 0o700);
  const configuration: OpenShellConfiguration = { executable, executableDigest: sha(executable), version: "0.0.1", gateway: "fixture", workspace: "default", image: digest, supervisorImage: supervisorDigest,
    policy, policyDigest: sha(policy), home: root, configHome: root, stateHome: root, dockerExecutable: docker, dockerRealpath: docker, dockerDigest: sha(docker), dockerSocket: path.join(root, "fixture.sock"), dockerNamespace: "fixture", exclusive: true };
  const driver = new OpenShellCliDriver(configuration);
  return { root, driver, configuration, scenario(value: object) { writeFileSync(path.join(root, "scenario.json"), JSON.stringify(value)); } };
}

describe("OpenShell bounded CLI contract", () => {
  it("defaults off and does not create host state or advertise model operations", async () => {
    expect(readOpenShellConfiguration({})).toEqual({ selected: false });
    const store = new Store(":memory:"); const f = fixture();
    const composition = await createOpenShellRuntimeComposition({ env: { GENBI_CLAUDE_RUNTIME: "openshell" }, store, stateRoot: f.root });
    expect(composition.selected).toBe(true); expect(composition.lifecycle).toBeUndefined(); expect(composition.adapter.ask).toBeUndefined(); expect(composition.adapter.setup).toBeUndefined();
    expect((await composition.probe()).readiness).toMatchObject({ code: "openshell_configuration_invalid" }); expect(store.listOpenShellIntents()).toEqual([]); await composition.shutdown(); store.close();
  });
  it("rejects missing exclusivity and invalid host configuration safely", () => {
    const f = fixture(); const config = path.join(f.root, "config.json"); writeFileSync(config, JSON.stringify({ ...f.configuration, exclusive: false }));
    expect(readOpenShellConfiguration({ GENBI_CLAUDE_RUNTIME: "openshell", GENBI_OPENSHELL_CONFIG: config })).toEqual({ selected: true });
    expect(() => readOpenShellConfiguration({ GENBI_CLAUDE_RUNTIME: "unknown" })).toThrow("The OpenShell host configuration is unavailable or invalid.");
  });
  it("fails closed on partially configured snapshot capabilities", () => {
    const f = fixture(); const file = path.join(f.root, "snapshot-config.json");
    for (const extra of [{ dataPolicy: f.configuration.policy }, { dataPolicyDigest: digest }, { dataPolicy: f.configuration.policy, dataPolicyDigest: digest }]) {
      writeFileSync(file, JSON.stringify({ ...f.configuration, ...extra }));
      expect(readOpenShellConfiguration({ GENBI_CLAUDE_RUNTIME: "openshell", GENBI_OPENSHELL_CONFIG: file })).toEqual({ selected: true });
    }
  });
  it("probes pinned version, gateway, image and policy without provisioning", async () => {
    const f = fixture(); await f.driver.probe();
    f.scenario({ version: "openshell 9.9.9" }); await expect(f.driver.probe()).rejects.toMatchObject({ code: "openshell_version_mismatch" });
    f.scenario({ gatewayMissing: true }); await expect(f.driver.probe()).rejects.toThrow();
    f.scenario({ supervisor: digest }); await expect(f.driver.probe()).rejects.toMatchObject({ code: "openshell_identity_mismatch" });
    f.scenario({ image: `sha256:${"b".repeat(64)}` }); await expect(f.driver.probe()).rejects.toMatchObject({ code: "openshell_identity_mismatch" });
    writeFileSync(f.configuration.policy, "changed"); await expect(f.driver.probe()).rejects.toMatchObject({ code: "openshell_identity_mismatch" });
  });
  it("malformed or paginated list fails closed, successful absence is independent from list", async () => {
    const f = fixture(); const intent = { owner: "fixture", name: "fixture", remoteId: "remote", identity: { workspace: "default" } } as OpenShellIntent;
    f.scenario({ malformed: true }); await expect(f.driver.list(intent)).rejects.toMatchObject({ code: "openshell_protocol_invalid" });
    f.scenario({ page: "next-page" }); await expect(f.driver.list(intent)).rejects.toMatchObject({ code: "openshell_protocol_invalid" });
    f.scenario({}); expect(await f.driver.list(intent)).toEqual([]); await f.driver.assertAbsent(intent);
    f.scenario({ container: "id openshell-default--fixture-remote" }); await expect(f.driver.assertAbsent(intent)).rejects.toMatchObject({ code: "openshell_cleanup_pending" });
    f.scenario({ volume: "owned-volume" }); await expect(f.driver.assertAbsent({ ...intent, volumes: ["owned-volume"] })).rejects.toMatchObject({ code: "openshell_cleanup_pending" });
  });
  it("checks reconstructed volumes even after gateway/container disappearance without persisted inventory", async () => {
    const f = fixture();
    const suffix = createHash("sha256").update(f.configuration.dockerNamespace).update("\0").update("remote").digest("hex").slice(0, 32);
    const intent = { name: "fixture", remoteId: "remote", identity: { workspace: "default" } } as OpenShellIntent;
    for (const role of ["channel", "supervisor"]) {
      f.scenario({ volume: `openshell-${role}-${suffix}` });
      await expect(f.driver.assertAbsent(intent)).rejects.toMatchObject({ code: "openshell_cleanup_pending" });
    }
    f.scenario({ volume: "openshell-channel-unrelated" }); await f.driver.assertAbsent(intent);
  });
  it("allows exact partial cleanup while runnable inspection requires both containers", async () => {
    const f = fixture();
    const intent = { owner: "owner", name: "fixture", remoteId: "remote", identity: { workspace: "default" } } as OpenShellIntent;
    const resource = { id: "remote", name: "fixture", workspace: "default", labels: { "genbi-lifecycle-owner": "owner" } };
    const records = [false, true].map((supervisor) => ({ Id: (supervisor ? "b" : "a").repeat(64),
      Name: "/openshell-default--fixture-remote" + (supervisor ? "-supervisor" : ""), Image: supervisor ? supervisorDigest : digest,
      Config: { Labels: { "openshell.ai/sandbox-id": "remote", "openshell.ai/sandbox-namespace": "fixture" } }, Mounts: [] }));
    const unrelated = { ...records[0]!, Id: "c".repeat(64), Name: "/unrelated", Config: { Labels: null } };
    for (const present of [records, [records[0]!], [records[1]!], []]) {
      f.scenario({ resource, container: [...present, unrelated].map(row => `${row.Id} ${row.Name.slice(1)}`).join("\n"), records: [...present, unrelated] });
      expect((await f.driver.inspect(intent, "cleanup")).containers).toHaveLength(present.length);
      if (present.length === 2) await f.driver.inspect(intent);
      else await expect(f.driver.inspect(intent)).rejects.toMatchObject({ code: "openshell_identity_mismatch" });
    }
    const inspectCalls = readFileSync(path.join(f.root, "docker-calls.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line) as string[]).filter(argv => argv[0] === "inspect");
    expect(inspectCalls.length).toBeGreaterThan(0); expect(inspectCalls.every(argv => !argv.includes(unrelated.Id))).toBe(true);
    for (const bad of [ { ...records[0]!, Image: supervisorDigest }, { ...records[1]!, Image: digest },
      { ...records[0]!, Config: { Labels: { "openshell.ai/sandbox-id": "wrong" } } } ]) {
      f.scenario({ resource, container: `${bad.Id} ${bad.Name.slice(1)}`, records: [bad] });
      await expect(f.driver.inspect(intent, "cleanup")).rejects.toMatchObject({ code: "openshell_identity_mismatch" });
    }
    f.scenario({ resource: { ...resource, labels: { "genbi-lifecycle-owner": "wrong" } } });
    await expect(f.driver.inspect(intent, "cleanup")).rejects.toMatchObject({ code: "openshell_ownership_mismatch" });
  });
  it("fails malformed resource and inventory parsing closed", async () => {
    const f = fixture(); const intent = { owner: "owner", name: "fixture", identity: { workspace: "default" } } as OpenShellIntent;
    f.scenario({ resources: [{ id: 7 }] }); await expect(f.driver.list(intent)).rejects.toMatchObject({ code: "openshell_protocol_invalid" });
    f.scenario({ resource: { id: "remote", name: "fixture", workspace: "default", labels: { "genbi-lifecycle-owner": "owner" } }, container: "id", records: [{}] });
    await expect(f.driver.inspect(intent, "cleanup")).rejects.toMatchObject({ code: "openshell_protocol_invalid" });
  });
  it("bounds output, rejects pre-aborted commands, and rejects invalid exec before dispatch", async () => {
    const f = fixture(), controller = new AbortController(); controller.abort();
    await expect(runOpenShellCommand(f.configuration.executable, [], {}, controller.signal)).rejects.toMatchObject({ code: "openshell_cancelled" });
    const executable = path.join(f.root, "large.cjs"); writeFileSync(executable, `#!${process.execPath}\nprocess.stdout.write('x'.repeat(1100000));\n`); chmodSync(executable, 0o700);
    await expect(runOpenShellCommand(executable, [], {})).rejects.toMatchObject({ code: "openshell_remote_unknown" });
    for (const argv of [[], ["relative"], ["/bin/echo", "\0"], ["/bin/echo", "x".repeat(65536)]]) {
      await expect(f.driver.exec({} as OpenShellIntent, argv, new AbortController().signal)).rejects.toMatchObject({ code: "openshell_scope_invalid" });
    }
  });
  it("pins executable bytes and never exposes private subprocess diagnostics", async () => {
    const f = fixture();
    await expect(runOpenShellCommand(f.configuration.executable, ["fail"], { XDG_CONFIG_HOME: f.root })).rejects.toThrow("The OpenShell remote state is unknown; cleanup reconciliation is required.");
    writeFileSync(f.configuration.executable, "changed"); await expect(f.driver.probe()).rejects.toMatchObject({ code: "openshell_identity_mismatch" });
  });
  it("bounds a hanging local command and treats cancellation as remote uncertainty", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "genbi-bounded-cli-")); directories.push(root);
    const executable = path.join(root, "hang.cjs"); writeFileSync(executable, `#!${process.execPath}\nsetInterval(()=>{},1000);\n`); chmodSync(executable, 0o700);
    await expect(runOpenShellCommand(executable, [], {}, undefined, 20)).rejects.toMatchObject({ code: "openshell_remote_unknown" });
    const controller = new AbortController(); const pending = runOpenShellCommand(executable, [], {}, controller.signal); controller.abort(); await expect(pending).rejects.toMatchObject({ code: "openshell_remote_unknown" });
  });
});
