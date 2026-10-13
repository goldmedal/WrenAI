import { it } from "vitest";
import { fileURLToPath } from "node:url";
// Exercised against actual compiled composition and direct SDK, as in packed acceptance.
// @ts-expect-error plain JS acceptance fixture
import { installedClaudeTransportFixture } from "../scripts/claude-transport-fixture.mjs";
it("compiled composition supplies fresh synthetic Claude sessions and rejects raw hostile calls", async()=>{
 await installedClaudeTransportFixture(fileURLToPath(new URL("../",import.meta.url)));
},30000);
