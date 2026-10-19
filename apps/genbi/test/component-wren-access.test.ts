import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { hashDirectory } from "../harness/compile/fingerprint.js";
import { captureWrenAccessIdentity, GovernedWrenError, openWrenComponentAccess } from "../harness/components/wren-access.js";

async function fixture(script: string, run: (project: string, executable: string) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "genbi-wren-access-test-"));
  const executable = path.join(root, "fake-wren");
  await writeFile(executable, `#!${process.execPath}\n${script}`, { mode: 0o700 });
  try { await run(root, executable); } finally { await rm(root, { recursive: true, force: true }); }
}
const ready = 'console.log(JSON.stringify({id:0,protocol:"wren-governed/1"}));';

describe("owned Wren access", () => {
  it.each(["profiles.yml", "config.json", ".env"])("rejects changed global %s across component preparations", async (name) => fixture(ready + 'process.stdin.resume();', async (project, executable) => {
    const home = await mkdtemp(path.join(os.tmpdir(), "genbi-wren-config-"));
    try {
      const environment = { PATH: process.env.PATH, HOME: home, WREN_HOME: home };
      const identity = await captureWrenAccessIdentity(project, environment);
      const options = { executable, project, fingerprint: await hashDirectory(project), signal: new AbortController().signal, identity };
      const access = await openWrenComponentAccess(options);
      try {
        await writeFile(path.join(home, name), "changed");
        await expect(access.inspect(options.signal)).rejects.toThrow("configuration changed");
        await expect(openWrenComponentAccess(options)).rejects.toThrow("configuration changed");
      } finally { await access.close(); }
    } finally { await rm(home, { recursive: true, force: true }); }
  }));
  it("uses fixed process arguments and serializes typed calls", async () => fixture(`${ready}
    const readline = require('node:readline');
    if (process.argv[2] !== 'governed-stdio' || process.argv[3] !== '--project') process.exit(1);
    readline.createInterface({input:process.stdin}).on('line',line => {
      const request=JSON.parse(line);
      console.log(JSON.stringify({id:request.id,result:request}));
    });`, async (project, executable) => {
    const signal = new AbortController().signal;
    const access = await openWrenComponentAccess({ executable, project, fingerprint: await hashDirectory(project), signal });
    try {
      const results = await Promise.all([access.query({ sql: "SELECT 1", limit: 2 }, signal), access.inspect(signal)]);
      expect(results).toEqual([{ id: 1, operation: "query", sql: "SELECT 1", limit: 2 }, { id: 2, operation: "inspect" }]);
    } finally { await access.close(); }
  }));
  it("rejects a changed source before sending another query", async () => fixture(ready + 'process.stdin.resume();', async (project, executable) => {
    const signal = new AbortController().signal;
    const access = await openWrenComponentAccess({ executable, project, fingerprint: await hashDirectory(project), signal });
    try {
      await writeFile(path.join(project, "changed.yml"), "changed");
      await expect(access.query({ sql: "SELECT 1", limit: 1 }, signal)).rejects.toThrow("changed");
    } finally { await access.close(); }
  }));
  it("rehashes after async project validation and before spawning Wren", async () => fixture(ready, async (project) => {
    await expect(openWrenComponentAccess({ executable: "/nonexistent/wren", project, fingerprint: await hashDirectory(project), signal: new AbortController().signal,
      assertExecutableCurrent() { throw Error("executable changed after project validation"); },
    })).rejects.toThrow("executable changed after project validation");
  }));
  it("cancels a hung query and closes the owned process", async () => fixture(ready + 'process.stdin.resume();', async (project, executable) => {
    const controller = new AbortController();
    const access = await openWrenComponentAccess({ executable, project, fingerprint: await hashDirectory(project), signal: controller.signal });
    const query = access.query({ sql: "SELECT 1", limit: 1 }, controller.signal);
    setTimeout(() => controller.abort(), 25);
    await expect(query).rejects.toThrow();
    await access.close();
    await expect(access.inspect(new AbortController().signal)).rejects.toThrow();
  }));
  it("refuses a protocol mismatch", async () => fixture('console.log(JSON.stringify({id:0,protocol:"old"}));process.stdin.resume();', async (project, executable) => {
    await expect(openWrenComponentAccess({ executable, project, fingerprint: await hashDirectory(project), signal: new AbortController().signal })).rejects.toThrow();
  }));
  it("surfaces a bounded error class from a structured error frame and never the wire message", async () => fixture(`
    console.log(JSON.stringify({id:0,protocol:"wren-governed/2"}));
    const readline = require('node:readline');
    readline.createInterface({input:process.stdin}).on('line',line => {
      const request=JSON.parse(line);
      const cls = request.sql.includes('revenue') ? 'model_not_found' : request.sql.includes('cube_total') ? 'cube_not_queryable' : request.sql.includes('typed_literal') ? 'ungrounded_literal' : request.sql.includes('spoof') ? 'transport' : 'policy_rejected';
      console.log(JSON.stringify({id:request.id,error:{class:cls,message:"Table revenue missing in /private/manifest for user secret-token"}}));
    });`, async (project, executable) => {
    const signal = new AbortController().signal;
    const access = await openWrenComponentAccess({ executable, project, fingerprint: await hashDirectory(project), signal });
    try {
      const first = await access.query({ sql: "SELECT total_revenue FROM revenue", limit: 1 }, signal).catch((error: unknown) => error);
      expect(first).toBeInstanceOf(GovernedWrenError);
      expect((first as GovernedWrenError).errorClass).toBe("model_not_found");
      expect((first as Error).message).toContain("model_not_found");
      expect((first as Error).message).not.toMatch(/private|secret|manifest/);
      const cube = await access.query({ sql: "SELECT cube_total FROM sales_cube", limit: 1 }, signal).catch((error: unknown) => error);
      expect(cube).toBeInstanceOf(GovernedWrenError);
      expect((cube as GovernedWrenError).errorClass).toBe("cube_not_queryable");
      expect((cube as Error).message).toContain("A cube is a semantic definition");
      expect((cube as Error).message).toContain("query the cube's base model");
      expect((cube as Error).message).not.toMatch(/private|secret|manifest|sales_cube|cube_total/);
      const literal = await access.query({ sql: "SELECT 9900 AS typed_literal", limit: 1 }, signal).catch((error: unknown) => error);
      expect(literal).toBeInstanceOf(GovernedWrenError);
      expect((literal as GovernedWrenError).errorClass).toBe("ungrounded_literal");
      expect((literal as Error).message).toContain("cite the earlier query that already produced it by its query_id");
      expect((literal as Error).message).toContain("compute it in one SELECT over the models");
      expect((literal as Error).message).not.toMatch(/private|secret|manifest|9900|typed_literal/);
      const second = await access.query({ sql: "SELECT 1 AND 2", limit: 1 }, signal).catch((error: unknown) => error);
      expect((second as GovernedWrenError).errorClass).toBe("policy_rejected");
      // A wire frame cannot claim the host-only channel class; unknown classes collapse to internal.
      const spoofed = await access.query({ sql: "SELECT spoof", limit: 1 }, signal).catch((error: unknown) => error);
      expect((spoofed as GovernedWrenError).errorClass).toBe("internal");
      // The channel stays usable after classified errors.
      await expect(access.inspect(signal)).rejects.toBeInstanceOf(GovernedWrenError);
    } finally { await access.close(); }
  }));
  it("keeps a protocol/1 process usable and classifies its string errors as internal", async () => fixture(`${ready}
    const readline = require('node:readline');
    readline.createInterface({input:process.stdin}).on('line',line => {
      const request=JSON.parse(line);
      console.log(JSON.stringify({id:request.id,error:"Governed operation failed"}));
    });`, async (project, executable) => {
    const signal = new AbortController().signal;
    const access = await openWrenComponentAccess({ executable, project, fingerprint: await hashDirectory(project), signal });
    try {
      const error = await access.query({ sql: "SELECT 1", limit: 1 }, signal).catch((error: unknown) => error);
      expect((error as GovernedWrenError).errorClass).toBe("internal");
    } finally { await access.close(); }
  }));
  describe("declared default rules (protocol 3)", () => {
    const hello = (value: unknown) => `console.log(JSON.stringify(${JSON.stringify(value)}));`;
    const serve = (answer: string) => `
      const readline = require('node:readline');
      readline.createInterface({input:process.stdin}).on('line',line => {
        const request=JSON.parse(line);
        ${answer}
      });`;
    const open = async (project: string, executable: string, declaredDefaults?: readonly string[]) => openWrenComponentAccess({ executable, project,
      fingerprint: await hashDirectory(project), signal: new AbortController().signal, ...(declaredDefaults ? { declaredDefaults } : {}) });
    const v3 = (ids: unknown) => ({ id: 0, protocol: "wren-governed/3", declared_defaults: ids });

    it("keeps today's two-key hello for a project that declares nothing", async () => fixture(hello({ id: 0, protocol: "wren-governed/2" }) + "process.stdin.resume();", async (project, executable) => {
      await (await open(project, executable)).close();
      await (await open(project, executable, [])).close();
    }));
    it("accepts a protocol 3 hello that announces exactly the catalog's declared set, in any order", async () => fixture(hello(v3(["b", "a"])) + "process.stdin.resume();", async (project, executable) => {
      await (await open(project, executable, ["a", "b"])).close();
    }));
    it.each([
      ["protocol 3 without the field", { id: 0, protocol: "wren-governed/3" }, ["a"]],
      ["protocol 2 carrying the field", { id: 0, protocol: "wren-governed/2", declared_defaults: ["a"] }, ["a"]],
      ["protocol 1 carrying the field", { id: 0, protocol: "wren-governed/1", declared_defaults: [] }, []],
      ["a different set", v3(["a", "c"]), ["a", "b"]],
      ["a subset", v3(["a"]), ["a", "b"]],
      ["a superset", v3(["a", "b"]), ["a"]],
      ["a repeated id", v3(["a", "a"]), ["a", "b"]],
      ["more than eight ids", v3(["a", "b", "c", "d", "e", "f", "g", "h", "i"]), ["a", "b", "c", "d", "e", "f", "g", "h"]],
      ["an id outside the id shape", v3(["Bad Id"]), ["a"]],
      ["a non-list", v3("a"), ["a"]],
      ["protocol 3 with an empty list and an empty catalog", v3([]), []],
      ["declarations the host does not know of", v3(["a"]), []],
      ["a client that announces none for a declaring catalog", { id: 0, protocol: "wren-governed/2" }, ["a"]],
    ])("is unavailable, with a fixed reason and no id, for %s", async (_name, frame, declared) => fixture(hello(frame) + "process.stdin.resume();", async (project, executable) => {
      const error = await open(project, executable, declared).catch((reason: unknown) => reason);
      expect(error).toBeInstanceOf(GovernedWrenError);
      expect((error as GovernedWrenError).errorClass).toBe("transport");
      expect((error as GovernedWrenError).reason).toBe("governed_declarations_mismatch");
      expect((error as Error).message).toBe("Governed Wren query failed [transport]: Governed Wren operation is unavailable.");
    }));
    it("does not give a hello's key-shape violation the declarations reason when it is not a declarations matter", async () => fixture(hello({ id: 0, protocol: "wren-governed/2", result: 1 }) + "process.stdin.resume();", async (project, executable) => {
      const error = await open(project, executable).catch((reason: unknown) => reason);
      expect((error as GovernedWrenError).reason).toBeUndefined();
    }));
    it("refuses a declared_defaults key on a later frame", async () => fixture(hello({ id: 0, protocol: "wren-governed/2" }) + serve(`console.log(JSON.stringify({id:request.id,result:{},declared_defaults:[]}));`), async (project, executable) => {
      const access = await open(project, executable);
      try { await expect(access.inspect(new AbortController().signal)).rejects.toMatchObject({ errorClass: "transport" }); } finally { await access.close(); }
    }));

    const missing = (frame: string) => `
      const ids = request.sql.includes('two') ? ["a","b"] : request.sql.includes('outside') ? ["a","zz"] : request.sql.includes('allout') ? ["zz"] : request.sql.includes('dup') ? ["b","b","a"] : undefined;
      console.log(JSON.stringify({id:request.id,error:{class:${frame},message:"wire text with /private/path and secret-token",...(ids ? {rule_ids:ids} : {})}}));`;
    it("renders the fixed sentence followed by the declared rule ids, and only those the catalog declares", async () => fixture(hello(v3(["a", "b"])) + serve(missing('"declared_default_missing"')), async (project, executable) => {
      const signal = new AbortController().signal;
      const access = await open(project, executable, ["a", "b"]);
      const sentence = "The query does not apply a default rule that the bound project declares for the models it reads, so it was not executed. Apply the rule named below (its wording is in the project's knowledge rules), then run the query again.";
      try {
        const run = async (sql: string) => access.query({ sql, limit: 1 }, signal).then(() => undefined as never, (error: unknown) => error as GovernedWrenError);
        const two = await run("two");
        expect(two).toBeInstanceOf(GovernedWrenError);
        expect(two.errorClass).toBe("declared_default_missing");
        expect(two.message).toBe(`Governed Wren query failed [declared_default_missing]: ${sentence} Rule: a, b`);
        expect(two.ruleIds).toEqual(["a", "b"]);
        const outside = await run("outside");
        expect(outside.message).toBe(`Governed Wren query failed [declared_default_missing]: ${sentence} Rule: a`);
        expect(outside.message).not.toMatch(/zz|private|secret/);
        expect(outside.ruleIds).toEqual(["a"]);
        const allOut = await run("allout");
        expect(allOut.message).toBe(`Governed Wren query failed [declared_default_missing]: ${sentence}`);
        expect(allOut.ruleIds).toEqual([]);
        expect((await run("dup")).message).toMatch(/ Rule: b, a$/);
        const bare = await run("plain");
        expect(bare.message).toBe(`Governed Wren query failed [declared_default_missing]: ${sentence}`);
        // The channel stays usable after these refusals.
        expect(await run("two")).toBeInstanceOf(GovernedWrenError);
      } finally { await access.close(); }
    }));
    it("logs, with counts only, a refusal whose rule ids the catalog declares none of, and renders the sentence alone", async () => fixture(hello(v3(["a", "b"])) + serve(missing('"declared_default_missing"')), async (project, executable) => {
      const logged: string[] = [];
      const spy = vi.spyOn(console, "error").mockImplementation((line: unknown) => { logged.push(String(line)); });
      const access = await open(project, executable, ["a", "b"]);
      try {
        const run = (sql: string) => access.query({ sql, limit: 1 }, new AbortController().signal).then(() => undefined as never, (error: unknown) => error as GovernedWrenError);
        const none = await run("allout");
        expect(none.message).not.toContain("Rule:");
        const dropLines = () => logged.filter((line) => line.includes("governed_frame"));
        expect(dropLines()).toHaveLength(1);
        expect(JSON.parse(dropLines()[0]!.replace("[component-failure] ", ""))).toEqual({ site: "governed_frame", code: "declared_rules_not_in_catalog", dropped: 1 });
        expect(dropLines()[0]).not.toContain("zz");
        // A partly kept list and a frame without ids stay silent.
        await run("outside"); await run("plain");
        expect(dropLines()).toHaveLength(1);
      } finally { spy.mockRestore(); await access.close(); }
    }));
    it("renders the sentence alone when a process without declarations names the class", async () => fixture(hello({ id: 0, protocol: "wren-governed/2" }) + serve(missing('"declared_default_missing"')), async (project, executable) => {
      const signal = new AbortController().signal;
      const access = await open(project, executable);
      try {
        const error = await access.query({ sql: "two", limit: 1 }, signal).then(() => undefined as never, (reason: unknown) => reason as GovernedWrenError);
        expect(error.errorClass).toBe("declared_default_missing");
        expect(error.message).not.toContain("Rule:");
      } finally { await access.close(); }
    }));
    it.each([
      ["another class", `"policy_rejected"`, "two"],
      ["an unknown class", `"made_up_class"`, "two"],
      ["a malformed id", `"declared_default_missing"`, "bad"],
    ])("treats rule_ids on %s as a contract violation that closes the channel", async (_name, cls, sql) => fixture(hello(v3(["a", "b"])) + serve(
      `const ids = request.sql.includes('bad') ? ["Not An Id"] : ["a"];
       console.log(JSON.stringify({id:request.id,error:{class:${cls},message:"x",rule_ids:ids}}));`), async (project, executable) => {
      const signal = new AbortController().signal;
      const access = await open(project, executable, ["a", "b"]);
      try {
        const error = await access.query({ sql, limit: 1 }, signal).then(() => undefined as never, (reason: unknown) => reason as GovernedWrenError);
        expect(error.errorClass).toBe("transport");
        await expect(access.inspect(signal)).rejects.toMatchObject({ errorClass: "transport" });
      } finally { await access.close(); }
    }));
    it("refuses more than eight rule ids on a frame", async () => fixture(hello(v3(["a"])) + serve(
      `console.log(JSON.stringify({id:request.id,error:{class:"declared_default_missing",message:"x",rule_ids:["a","a","a","a","a","a","a","a","a"]}}));`), async (project, executable) => {
      const access = await open(project, executable, ["a"]);
      try { await expect(access.query({ sql: "SELECT 1", limit: 1 }, new AbortController().signal)).rejects.toMatchObject({ errorClass: "transport" }); } finally { await access.close(); }
    }));
  });
});
