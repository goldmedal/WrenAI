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
| `pi-proc-check.mjs` | Reads `/proc` and reports how many step processes are alive; the host runs it after a cancellation. |
| `policy.template.yaml`, `profile.template.yaml` | Deny-all policy plus one model endpoint, and the provider profile for it. Render with `renderPiEndpointAssets` (endpoint host and port are parameters). |

Operator steps: build the image, render and import the profile, create the provider with the credential (`openshell provider create --credential NAME`, the value comes from the
operator's environment and never from a file), render the policy, then configure the driver's `pi` block with the image id, the policy and profile paths and their digests.
The sandbox only ever holds the OpenShell placeholder for the credential.

The driver and lifecycle compare model grants with one `modelIdentity`, so a driver instance serves one model vendor at a time.

CA trust follows the Claude worker exactly: `claude-worker-ca.mjs` is a byte-identical copy of that worker's `supervisorCaTrust()` (a test keeps them identical). Either `NODE_EXTRA_CA_CERTS` and `SSL_CERT_FILE`
are both unset, or they are exactly the supervisor material (`ca.crt`, `ca-bundle.crt`) and pass its layout, ownership, mode, no-symlink, descriptor-identity, PEM and read-only checks, which
are re-run just before pi starts. `NODE_TLS_REJECT_UNAUTHORIZED` and `BUN_TLS_REJECT_UNAUTHORIZED` may only be `1`. Anything else fails closed: the worker exits before pi starts. Paths such as
`/etc/openshell-tls` are therefore not accepted.
