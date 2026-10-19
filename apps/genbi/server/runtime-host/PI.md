# pi backend identity and certification

pi runs only inside the OpenShell pi image (`runtime-assets/pi-worker`). The BFF never executes it: it opens a duplex to a worker that an owned sandbox runs. So the identity of "pi"
is the **image**, and the host has nothing to discover. **The host never runs pi, never looks for it on `PATH`, and never treats an npm wrapper or a version string as an identity**
(the same rule as "npm wrappers are not executable identities" in [CODEX.md](./CODEX.md)). There is no managed host download.

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

- The orphan sweep label is `genbi-pi-identity=<dockerNamespace>`. `genbi-openshell-pi verify` and the BFF that owns the same `dockerNamespace` share it, so one sweep can remove the other's in-flight container. The reader then
  fails closed with `runtime_probe_failed` (`unavailable`) for that one call and succeeds on the next; it is transient and never reports a certified identity. Run `verify` while the BFF is stopped, or accept one retry.
- Concurrent calls in one process share one in-flight read (`inflight`), so a later caller's abort signal does not cancel it and it is bounded by the first caller's signal and the total deadline.

