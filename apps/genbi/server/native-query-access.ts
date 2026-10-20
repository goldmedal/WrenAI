import { hashDirectory } from "../harness/compile/fingerprint.js";
import type { ComponentAccess } from "../harness/components/broker.js";
import { declaredDefaultsOptionOfProject } from "../harness/components/declared-defaults.js";
import { openWrenComponentAccess } from "../harness/components/wren-access.js";

/** The governed access behind a native session's `query` tool: the same `wren` the session is given, announcing the bound project's declared default rules. */
export async function openNativeQueryAccess(executable: string, binding: { readonly path: string }, signal: AbortSignal): Promise<ComponentAccess> {
  return openWrenComponentAccess({
    executable, project: binding.path, fingerprint: await hashDirectory(binding.path), signal,
    ...await declaredDefaultsOptionOfProject(binding.path, { signal }),
  });
}
