import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const root = fileURLToPath(new URL("../../runtime-assets/pi-worker/", import.meta.url));
const params = z.object({
  host: z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/),
  port: z.number().int().min(1).max(65535),
  profileId: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/),
  displayName: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/),
  credentialEnv: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/),
}).strict();
export type PiEndpointAssetParams = z.infer<typeof params>;

function render(file: string, values: Record<string, string>): string {
  let text = readFileSync(`${root}${file}`, "utf8");
  for (const [name, value] of Object.entries(values)) text = text.replaceAll(`{{${name}}}`, value);
  if (text.includes("{{")) throw new Error("Unrendered pi asset parameter");
  return text;
}
/** Concrete deny-all policy and provider profile for exactly one model endpoint. Parameters are closed-form tokens, never free text. */
export function renderPiEndpointAssets(input: PiEndpointAssetParams): { policy: string; profile: string } {
  const value = params.parse(input);
  const values = { ENDPOINT_HOST: value.host, ENDPOINT_PORT: String(value.port), PROFILE_ID: value.profileId, DISPLAY_NAME: value.displayName, CREDENTIAL_ENV: value.credentialEnv };
  return { policy: render("policy.template.yaml", values), profile: render("profile.template.yaml", values) };
}
