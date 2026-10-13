import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { OpenShellError } from "./openshell-types.js";
const root = fileURLToPath(new URL("../../runtime-assets/openshell-sdk/", import.meta.url));
const manifestDigest = "599df6d7616b5ae0deb4987d72772932ddf34d5536245a899e8026c5c1ddfb6e";
const digest = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
/** Complete import closure, pinned manifest and real installed dependencies, before any connection. */
export function attestOpenShellSdk(): string {
  try {
    if (digest(path.join(root, "provenance.json")) !== manifestDigest) throw new Error();
    const manifest = JSON.parse(readFileSync(path.join(root, "provenance.json"), "utf8")) as { outputs: Record<string, string> };
    for (const [name, expected] of Object.entries(manifest.outputs)) if (digest(path.join(root, name)) !== expected) throw new Error();
    const inventory = (directory: string): string[] => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? inventory(path.join(directory, entry.name)) : [path.relative(root, path.join(directory, entry.name))]);
    if (inventory(root).some((name) => name !== "provenance.json" && !Object.hasOwn(manifest.outputs, name))) throw new Error();
    const require = createRequire(path.join(root, "package.json"));
    for (const [name, version] of Object.entries({ "@bufbuild/protobuf": "2.12.1", "@connectrpc/connect": "2.1.2", "@connectrpc/connect-node": "2.1.2" })) {
      let directory = path.dirname(require.resolve(name));
      while (directory !== path.dirname(directory)) {
        try { const json = JSON.parse(readFileSync(path.join(directory, "package.json"), "utf8")); if (json.name === name) { if (json.version !== version) throw new Error(); break; } } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        directory = path.dirname(directory);
      }
      if (directory === path.dirname(directory)) throw new Error();
    }
    return root;
  } catch { throw new OpenShellError("openshell_identity_mismatch"); }
}
export async function connectOpenShellSdk(configuration: { gateway: string; caCert: Buffer; clientCert: Buffer; clientKey: Buffer }) {
  const root = attestOpenShellSdk();
  const sdk = await import(pathToFileURL(path.join(root, "dist/index.js")).href) as typeof import("../../runtime-assets/openshell-sdk/dist/index.js");
  return sdk.OpenShellClient.connect(configuration);
}
