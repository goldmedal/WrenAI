import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { generatePreparedContextAndCatalog, resolveContextLoader } from "../compile/context-loader.js";
import { declaredDefaultsOfCatalog } from "./knowledge-rules.js";

/** The `declaredDefaults` option of `openWrenComponentAccess`, present only when the project declares rules, so a project that declares none makes the same governed call as before declarations existed. */
export type DeclaredDefaultsOption = { readonly declaredDefaults: readonly string[] } | Record<never, never>;

export function declaredDefaultsOption(ids: readonly string[]): DeclaredDefaultsOption {
  return ids.length > 0 ? { declaredDefaults: ids } : {};
}

/**
 * The declared-defaults option of one project, read from the capability catalog the context generator writes for it:
 * the one source every route takes the set from. A catalog that cannot be produced or read is "declares nothing", so a
 * governed process that announces declarations is refused (`governed_declarations_mismatch`) rather than trusted.
 */
export async function declaredDefaultsOptionOfProject(project: string, options: { readonly signal?: AbortSignal; readonly contextLoaderBin?: string } = {}): Promise<DeclaredDefaultsOption> {
  options.signal?.throwIfAborted();
  const scratch = await mkdtemp(path.join(os.tmpdir(), "genbi-declared-defaults-"));
  try {
    const catalogPath = path.join(scratch, "catalog.json");
    await generatePreparedContextAndCatalog(resolveContextLoader(options.contextLoaderBin).bin, project, path.join(scratch, "context.json"), catalogPath, options.signal);
    return declaredDefaultsOption(declaredDefaultsOfCatalog(JSON.parse(await readFile(catalogPath, "utf8"))));
  } catch {
    options.signal?.throwIfAborted();
    console.error(`[component-failure] ${JSON.stringify({ site: "declared_defaults_catalog", code: "catalog_unavailable" })}`);
    return {};
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
