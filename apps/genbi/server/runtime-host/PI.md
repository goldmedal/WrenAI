# pi backend identity and certification

pi runs in two places, and the identity rule differs with the place.

- **On OpenShell** (`GENBI_RUNTIME=openshell`, `GENBI_BACKEND=pi`) pi runs only inside the OpenShell pi image (`runtime-assets/pi-worker`). The BFF never executes it: it opens a duplex to a worker that an
  owned sandbox runs. So the identity of "pi" is the **image**, and the host has nothing to discover. **On OpenShell the host never runs pi, never looks for it on `PATH`, and never treats an npm wrapper or a version
  string as an identity** (the same rule as "npm wrappers are not executable identities" in [CODEX.md](./CODEX.md)). There is no managed host download. Everything from "The certified row" down to "Concurrency notes" is
  about this runtime.
- **On the local runtime** (`GENBI_RUNTIME=local`, `GENBI_BACKEND` listing `pi`) pi runs on the host. Its identity is a **GenBI-managed install** with host pins and a local certification row; it is still never found
  on `PATH`. See "pi on the local runtime" at the end of this file.

## The certified row

`openshell-vendor-certification.ts` defines one schema for a model vendor that runs in an OpenShell image, keyed by vendor, host platform and architecture, image architecture and the
OpenShell build (version and CLI executable digest). pi has the first row; Claude on OpenShell joins the same schema when it is certified. It is an exact match with no range and no fallback.
Only `state: "certified_row"` parses, so a `tested_baseline` record, a partial row or an unknown field is never ready.

A pi row carries:

| Field | What it pins |
| --- | --- |
| `image.pins` | The `/opt/genbi/pins.json` the image build writes: pi version, `dist/bundle` tree digest, Node version and binary, and the digests of the worker, worker core, supervisor (`pi-session-step`), MCP shim, step control, proc check, CA trust, pins module and lockfile |
| `image.nodeBase` | Informational: the Dockerfile `FROM` line, tied to the Dockerfile by a static test only. It is **not** evaluated at runtime and nothing compares the image's base layers to it |
| `image.templates` | The shipped `policy.template.yaml` and `profile.template.yaml` |
| `gateway`, `host`, `imageArch` | The OpenShell build the evidence ran on, the host tuple and `linux-arm64` |
| `dependencies` | The Warble, IR and context-loader versions the evidence used |
| `evidence` | sha256 of `deterministic.json`, `candidate-acceptance.json` and `local-approval.json` in `certification/pi-<version>-<host>/` |

A docker image id is not in the row: independent builds of one Dockerfile produce different ids, so an id could only ever match the machine that certified. The pins are content digests, and
they are read from the configured image, which the driver already requires to exist with its exact id.

## Reading the identity (resolve-only)

`openshell-pi-identity.ts` creates the configured image (`docker create`, never started), copies out `/opt/genbi/pins.json` (`docker cp`), and removes the container, through the driver's attested docker
executable and socket with a minimal explicit environment and bounded deadlines. Nothing from the image runs, no model is involved, and every failure is closed. The pins are cached by image id.
Digests and paths stay in host diagnostics; the browser only ever sees a code.

Readiness (`probe`) and the gateway proof (before every Ask, session and step, and the 2 s watch while a run is active) both require the gate, so an image, policy or template that changes
mid-run revokes the run. The worker and supervisor also check the live files against `pins.json` at start, inside the sandbox. That is self-consistency only (see below), not a second identity check.

| Code | Meaning |
| --- | --- |
| `pi_uncertified` | No `certified_row` for this host and OpenShell build |
| `pi_identity_mismatch` | A row exists for this build but the image pins, the shipped templates, or the configured policy or profile differ |
| `pi_dependencies_drifted` | The identity matches but the installed Warble, IR or context-loader versions differ from the evidence |
| `runtime_probe_failed` | The image could not be observed (docker unavailable); this says nothing about the image |

The configured policy and profile must be the shipped templates rendered with the descriptor's own endpoint host and port, profile id and credential name (only the display label is the operator's). The driver's existing
`policyDigest` and `profileDigest` attestation still pins the exact rendered bytes.

## What is and is not gated

Only the pi composition (`composePi`) is gated. Claude on OpenShell has no row yet and its readiness is unchanged (a later change adds a Claude row with the same schema), so this asymmetry is deliberate and temporary.
The trusted host test seam of `createOpenShellRuntimeComposition` supplies its own gateway verifier and bypasses the gate; no environment variable, request or browser field can reach it.

## What the gate does not prove

The identity is the image's *declared* `pins.json` plus the operator-built content id that the driver attests (the configured `pi.image` must exist locally with exactly that id). The gate compares the
declared record with the row. It does **not** compare:

- the base layers or the apt packages (`nodeBase` is informational),
- `/opt/pi/node_modules` outside `dist/bundle`,
- the image configuration (`USER`, `CMD`, `ENV`, labels),
- any extra file the image carries beyond those `pins.json` names.

The in-image start-time check (worker and supervisor against `pins.json`) is self-consistency only: `pins.json` is inside the image, so an image built with a different `pins.json` passes it. The gate therefore guards
against drift and mistakes (a stale image, a rebuilt lockfile, an edited worker, a changed template, a different OpenShell build or component set), not against an image built on purpose to look like the certified one.
Treat the operator who builds and configures the image as trusted.

## Concurrency notes

- Every read container carries the label `genbi-pi-identity=<dockerNamespace>`, and `genbi-openshell-pi verify` and the BFF that owns the same `dockerNamespace` share it. Before each read the reader lists the labelled
  containers with their creation time (`docker ps -a --no-trunc --format '{{.ID}} {{.CreatedAt}}'`) and removes only those older than `PI_IDENTITY_SWEEP_AGE_MS`: the 25 s total deadline plus a 60 s margin for the removal's
  own deadline, the second-granularity creation time and host/daemon clock skew. No read can still be using a container that old, so `verify` and the BFF never remove each other's in-flight read and can run together.
  A younger container, including one dated in the future by a skewed clock, is always kept.
- A crash between `create` and `rm` leaves one never-started orphan. The label is shared on purpose (a per-process label would never match a successor's sweep), so the first read after the orphan ages past the sweep
  age removes it, whichever process runs it. Two readers sweeping the same orphan is harmless on current docker, whose `docker rm -f` exits 0 for an already removed container (checked on 29.8); a CLI that
  exits non-zero there turns that one read into a transient `runtime_probe_failed`.
- A listing line that is not exactly a full id and a `CreatedAt` with a numeric zone offset (an unexpected docker format, a humanized age, an impossible date) fails the whole read closed before anything is removed; the gate reports it
  as `runtime_probe_failed`. A cancelled or timed-out read still removes its own container, on a fresh deadline rather than the cancelled signal.
- Concurrent calls in one process share one in-flight read (`inflight`), so a later caller's abort signal does not cancel it and it is bounded by the first caller's signal and the total deadline.

## pi on the local runtime

The local runtime serves **Structured Ask** (`answer_query`) for the api-key and gateway authentication modes through pi when `GENBI_BACKEND` lists `pi`. pi is opt-in: the default local list stays `claude,codex`.
Every other purpose (dashboards, setup, enrichment, native sessions), the `local` authentication mode and the subscription modes keep running exactly as before. Later purposes move to pi only when their own pi path lands.
A listed pi never falls back: if its install, identity, provider, key or cleanup is not good, the Ask is refused and nothing runs in-process for it.

### Identity: a managed install, host pins and a local row

- The install is `genbi-local-pi install`, an explicit operator step that is **never run at boot** and never downloads at boot. It runs `npm ci --ignore-scripts` from the packaged `runtime-assets/pi-worker/package-lock.json`
  into `<GenBI state dir>/runtimes/pi/<piVersion>-<lockDigest>/` and writes a host `pins.json`. The state directory is `GENBI_STATE_DIR` (absolute) or the per-user application state location; `GENBI_STATE_DIR` sets **only** the managed pi install's state root, and other GenBI state (for example the managed Wren runtime) ignores it. Because the directory name
  comes from the packaged lockfile, a different lockfile points at a directory that does not exist (`pi_not_installed`).
- The host pins (`local-pi-install.ts`, closed schema) are `piVersion`, the `dist/bundle` tree digest (same tree-hash semantics as `pi-pins.mjs`, proved by a test), the packaged MCP relay (`pi-mcp-shim.mjs`), the
  install's lockfile and its `package.json`, all exact. pi runs under the BFF's own Node, which the BFF already trusts, so the row pins its **major version** (`nodeMajor`) and not a patch level or a digest (both differ per
  machine and per release). pi's own minimum, Node 22.19.0, is enforced separately: below it readiness reports `pi_node_unsupported` before any row is consulted.
- A local row (`local-pi-certification.ts`, vendor `pi-local`) is a separate strict schema on the same rules as the OpenShell row: `state: "certified_row"` only, exact match, no range, no fallback; a `tested_baseline`, a
  partial row or an unknown field never parses. It carries the host tuple, `nodeMajor`, the exact pins, the Warble/IR/context-loader versions and the sha256 of the approval record. The OpenShell row and its schema are untouched.
  **Rows come only from the packaged list, `LOCAL_PI_CERTIFIED_ROWS`.** No environment variable or file can supply one, so adding a row is a reviewed source change; `genbi-local-pi row` prints a candidate for a maintainer to
  paste. The packaged row is darwin-arm64, Node 24; its evidence is in `certification/pi-local-1.0.4-darwin-arm64-node24/` (see its README).
- The check runs at readiness, at every Ask admission and again before every step is spawned, and `genbi-local-pi verify` runs the same function.

| Code | Meaning |
| --- | --- |
| `pi_not_installed` | No install directory or no `pins.json` for this release's lockfile; run `genbi-local-pi install` |
| `pi_uncertified` | The install is intact but no packaged row covers this host and Node major version |
| `pi_identity_mismatch` | The bytes on disk differ from `pins.json` or from the row (tampered bundle, other pins, a loose directory) |
| `pi_dependencies_drifted` | The identity matches but the installed Warble, IR or context-loader versions differ from the row's |
| `pi_node_unsupported` | The running Node is older than pi's minimum (22.19.0) |
| `pi_provider_unsupported` | The saved Runtime names a provider the key proxy cannot serve (see below) |
| `runtime_probe_failed` | The probe could not complete |

### The governed Wren worker

Queries from the pi Ask run through the governed Wren worker (`wren governed-stdio`) of the **boot-attested `wren` that was resolved from `PATH` at boot**: the same `nativeWrenExecutable` that native sessions use, re-attested before every Ask and
step. It is **not** Codex's managed Wren runtime, which is a different, release-provisioned runtime. This is a rule about the `wren` data worker only; it is separate from the identity rule for pi above, and pi itself is never found on `PATH`.
When no `wren` resolves at boot, readiness reports pi as not ready (`runtime_probe_failed`) and the Ask is refused.

### Key custody: the loopback key proxy

pi is never given the vendor key. `local-pi-key-proxy.ts` listens on `127.0.0.1` (an ephemeral port, started by the first Ask), and each step gets a fresh random 32-byte token that pi receives as its "API key", with the
proxy URL as its endpoint. The proxy accepts only a live token, forwards only to the one configured upstream origin and path prefix and only to the one endpoint of that provider's wire API, drops the client's
credential, cookie and hop-by-hop headers, sets the real credential header, caps the body, applies deadlines, never follows a redirect (the key could otherwise reach another origin), streams server-sent events through, and never
logs. The real key is read from the BFF environment **only inside the proxy, at forward time** (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY` or `GENBI_GATEWAY_API_KEY`, as for the in-process path). The token is revoked at the end of the
step, on cancel, on timeout and on any settings, binding or key change. A rotated key cancels a running Ask as stale.

Providers: `anthropic` (Anthropic Messages wire), `openai-compatible` with its base URL and a gateway base URL (OpenAI chat-completions wire), and a gateway pi-ai built-in provider whose catalogued wire is one of the three
supported APIs. Anything that is not a static header credential over one of those wires (for example SigV4-signed Bedrock) is refused as `pi_provider_unsupported`. Model and provider stay in the local Runtime settings.

### The step process, and what it does not confine

Each step is a fresh `pi --mode json` on the host (`local-pi-step.ts`, a host-side port of the worker that reuses the packaged admission and the unchanged `PiStepChannel`, `PiStepProtocol` and `runPiComponentStep`):

- a private `0700` step directory holds HOME, TMPDIR, the agent directory (exactly `settings.json`, `models.json`, `mcp.json`), the system prompt and an empty working directory;
- the environment is built from nothing (PATH, HOME, TMPDIR, LANG, the pi variables, `PI_OFFLINE=1`, `PI_SKIP_VERSION_CHECK=1`, `PI_TELEMETRY=0` and the one token variable), never inherited, because the BFF environment holds keys;
- pi runs under `process.execPath` from the managed install, never from `PATH`; its built-in tools are off and the only tool server is the GenBI MCP relay;
- cleanup is proven before an Ask returns: the process group is killed, a `ps` snapshot must show no step process (group, descendants, or anything carrying the step directory in its command line), the directory must be seen gone and the
  grant revoked. A step whose cleanup cannot be proven is a `cleanup` failure, never an answer.

**Residual risk, stated plainly.** There is no OS sandbox on the local runtime. pi runs as the BFF's OS user with no filesystem or network confinement beyond its disabled tools, its private directories and the proxy. A pi that is
compromised or misbehaving could read what that user can read and reach what that user can reach, though it never holds the vendor key. A process that leaves pi's process group and rewrites its command line is not detectable by the
cleanup proof. If those risks are not acceptable, use the OpenShell runtime. An OS-level sandbox remains a possible later hardening.
