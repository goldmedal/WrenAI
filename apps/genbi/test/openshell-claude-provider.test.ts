import { it } from "vitest";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
// Exercised against actual compiled composition and direct SDK, as in packed acceptance.
// @ts-expect-error plain JS acceptance fixture
import { installedClaudeTransportFixture } from "../scripts/claude-transport-fixture.mjs";
// @ts-expect-error plain JS acceptance fixture
import { installedSnapshotHelperFixture } from "../scripts/snapshot-helper-fixture.mjs";
it("compiled composition supplies fresh synthetic Claude sessions and rejects raw hostile calls", async()=>{
 await installedClaudeTransportFixture(fileURLToPath(new URL("../",import.meta.url)));
},30000);

it("accepts installed fixtures through a directory alias while attesting exact packaged assets", async()=>{
 const root=mkdtempSync(path.join(tmpdir(),"claude-package-alias-"));
 try {
  const alias=path.join(root,"package");
  symlinkSync(fileURLToPath(new URL("../",import.meta.url)),alias,"dir");
  await installedClaudeTransportFixture(alias);
  await installedSnapshotHelperFixture(alias,process.env.GENBI_SNAPSHOT_CAPTURE_PYTHON);
 } finally { rmSync(root,{recursive:true,force:true}); }
},30000);
