# pi step worker image

One `pi --mode json` per component step, run inside a fresh OpenShell sandbox created from this image. pi has no built-in tools: its only tools are the
host broker's step tools, reached over the single duplex the host opens with the SDK (`execInteractive`, no TTY).

| File | Role |
| --- | --- |
| `Dockerfile` | linux/arm64 only. Pinned Node base, `ca-certificates`, `iproute2`, `nftables`, pi 1.0.4 from `package-lock.json` via `npm ci`, npm and npx removed, uid/gid 1500. No Wren, no project data, no host HOME. |
| `package.json`, `package-lock.json` | GenBI-owned lockfile that freezes every transitive pi dependency; the root dependency is the exact version. |
| `pi-worker.mjs` | Entry. Verifies `pins.json` (Node, the worker files, pi's `dist/bundle` tree), then starts the core. |
| `pi-worker-core.mjs` | Materialises exactly what the host computed (agent dir with three files, system prompt, empty cwd and HOME), re-checks it before pi starts, runs pi, relays events and tool frames, ends in-band. |
| `pi-mcp-shim.mjs` | The stdio MCP server pi launches. Forwards JSON lines to the worker's per-step unix socket; no network, no environment access. |
| `pi-session-step.mjs` | Host-only entrypoint for a step inside an owned session sandbox. A thin supervisor around the unchanged per-step worker: writes the private step receipt before the worker sees a byte, relays its frames, and writes the settled marker only after a clean in-band exit. |
| `pi-step-control.mjs` | Host-only control for a session sandbox: `--baseline`, `--check`, and exact cleanup of one step's process group and directory. A byte-for-byte copy of the Claude worker's control (a test keeps them identical). |
| `pi-proc-check.mjs` | Reads `/proc` and reports how many step processes are alive; the host runs it after a cancellation. |
| `policy.template.yaml`, `profile.template.yaml` | Deny-all policy plus one model endpoint, and the provider profile for it. Render with `renderPiEndpointAssets` (endpoint host and port are parameters). |

## Operator steps (the operator provisions, the server only verifies)

The BFF process never holds the model vendor key and never creates or changes a gateway object. Everything below is done by the operator; at boot and again before every Ask and every step sandbox the server
re-checks, read-only, that the gateway still holds exactly what the descriptor names.

1. Build the image and render the assets with `renderPiEndpointAssets` (endpoint host and port, profile id, display name and the credential variable name are the parameters).
2. Import the rendered profile: `openshell provider profile import --file <profile.yaml>`.
3. Create the provider with the credential taken from your own environment, never from a file: `NAME=<value> openshell provider create --name <provider> --type <profile-id> --credential NAME`.
4. Compute the profile digest from the gateway's own export, right after the import:
   `openshell provider profile export <profile-id> --output json | node --input-type=module -e "import { canonicalGatewayProfileDigest } from '<app>/dist-server/server/runtime-host/openshell-pi-gateway.js'; let text = ''; for await (const chunk of process.stdin) text += chunk; console.log(canonicalGatewayProfileDigest(JSON.parse(text)));"`
   The digest is of the export with the gateway-assigned fields (`resource_version`, `source`, `scope`) removed and the keys sorted.
5. Configure the driver's `pi` block (image id, policy and profile paths and their digests, `provider`) and no `model` block: one boot serves one model vendor.
6. Write the pi boot descriptor as a 0600 file inside a 0700 directory you own, then start the server with `GENBI_RUNTIME=openshell`, `GENBI_BACKEND=pi` and `GENBI_OPENSHELL_PI_BOOT=<absolute path>`.
   The Claude descriptor is not read in this mode. `GENBI_OPENSHELL_PI_BOOT` under `GENBI_RUNTIME=local` refuses boot, and `GENBI_BACKEND` may not name both `claude` and `pi` under OpenShell.

```json
{ "version": 1,
  "gatewayUrl": "https://127.0.0.1:<port>/", "caCert": "<abs path>", "clientCert": "<abs path>", "clientKey": "<abs path>",
  "auth": "api-key",
  "provider": "<openshell provider name>", "profileId": "<profile id>", "displayLabel": "<non-secret label>",
  "profileDigest": "sha256:<step 4>", "generation": "<opaque, bump on key rotation>",
  "endpoint": { "providerId": "<name pi uses>", "api": "openai-completions", "baseUrl": "https://<host>/v1", "credentialEnv": "<credential variable>" },
  "thinking": "off",
  "models": { "<tier>": "<exact model id>" } }
```

`auth` is the only Ask authentication mode the boot serves (`api-key` is the `byo` setting, `gateway` the gateway setting). `models` pins the one allowed model id per tier: the saved runtime must name exactly those ids,
with no alias, no `inherit` and no base URL. Key rotation: update the provider, then bump `generation`; the descriptor hash changes, the current scope is stale and in-flight steps are revoked.

The driver and lifecycle compare model grants with one `modelIdentity`, so a driver instance serves one model vendor at a time.

CA trust follows the Claude worker exactly: `claude-worker-ca.mjs` is a byte-identical copy of that worker's `supervisorCaTrust()` (a test keeps them identical). Either `NODE_EXTRA_CA_CERTS` and `SSL_CERT_FILE`
are both unset, or they are exactly the supervisor material (`ca.crt`, `ca-bundle.crt`) and pass its layout, ownership, mode, no-symlink, descriptor-identity, PEM and read-only checks, which
are re-run just before pi starts. `NODE_TLS_REJECT_UNAUTHORIZED` and `BUN_TLS_REJECT_UNAUTHORIZED` may only be `1`. Anything else fails closed: the worker exits before pi starts. Paths such as
`/etc/openshell-tls` are therefore not accepted.
