# Installing `@wrenai/genbi`

How to install and run `@wrenai/genbi` without developing it. If you are working
on the app itself, see [README.md](./README.md) instead.

> **Not on npm yet.** Everything below describes the published package. Until it
> ships, substitute the tarball step in [Install](#install); nothing else changes.

## What it is

`@wrenai/genbi` is a GenBI web app: a small HTTP server (the "BFF") plus a
built single-page UI. It talks to the [Wren](https://github.com/Canner/WrenAI)
semantic layer through the `wren` CLI and to an AI agent backend (Warble)
that it installs as a dependency. Once running, it serves a web UI for
asking questions over your data and getting back verified, structured
answers (tables, charts, KPIs, narrative text).

## Supported platforms

`@wrenai/genbi` has one additional native dependency for user-project binding:
`@wrenai/context-loader`. Its initial certified target is macOS Apple Silicon,
so the GenBI package is currently supported only on that platform. This limit is
intentional; the Warble package supports more platforms, but GenBI must not
claim a target until its context-loader artifact has been built and verified.

| OS | Architecture |
| --- | --- |
| macOS | Apple Silicon (`darwin-arm64`) |

**Intel macOS, Linux, and Windows are not supported.** Installation fails
before GenBI starts; see [Troubleshooting](#troubleshooting).

## Prerequisites

- **Node.js 20 or later.** The package declares it in `engines`, so npm will
  warn you.
- **npm** (or another package manager that runs npm lifecycle scripts — the
  Warble binary arrives through a postinstall hook).
- **The `wren` CLI on `PATH`**, already configured against a Wren project.
  `@wrenai/genbi` shells out to it for live questions and context
  inspection; it does not install or configure `wren` for you. See the
  [Wren project](https://github.com/Canner/WrenAI).
- **Network access to `github.com`** during install (to fetch the Warble and
  exact context-loader binaries) and on first use (see [Network](#network)
  below). Fully offline /
  air-gapped installs are not supported and are out of scope for this guide.

## Install

Nothing to install ahead of time — `npx` fetches it on demand:

```bash
npx @wrenai/genbi
```

Or install it once, if you would rather not re-fetch:

```bash
npm install -g @wrenai/genbi
```

Either way, `npm` runs the binary-package postinstall scripts. The context
loader downloads its exact manifest row, verifies archive and binary SHA-256,
then writes the package-local executable atomically. Unsupported targets,
offline first installs, altered downloads, and incomplete extraction fail
before any app code runs.

## Run

`@wrenai/genbi` requires one environment variable to start:

```bash
WREN_HARNESS_WORKSPACE_ROOT=/path/to/a/writable/directory npx @wrenai/genbi
```

## What to expect on first start

On a successful start you'll see, in order:

1. Possibly a Node.js `ExperimentalWarning` on stderr about SQLite (Node's
   built-in `node:sqlite` module, which this package uses for its state
   file). This comes from Node itself, not from `@wrenai/genbi`; whether it
   appears depends on your Node version, and it's not an error.
2. A warning on stderr about using a personal provider subscription (e.g. a
   Claude subscription) to authenticate — that it may be against that
   provider's Terms of Service, that it's for personal single-operator use
   only, and that you're responsible for checking the current ToS. This
   warning is expected on every start where a personal subscription is the
   auth mode; it is not a sign of misconfiguration.
3. A final line on stdout: `wren-harness BFF listening on
   http://127.0.0.1:<port> (db: <path>)`.

At that point the BFF is up but **unbound** — no Wren project has been
selected yet. Opening the printed URL in a browser starts the setup wizard,
which is where you point the app at a project (either scaffolding a new one
under `WREN_HARNESS_WORKSPACE_ROOT`, or adopting an existing one from any
path on disk).

## Configuration

All configuration is via environment variables. The two most commonly
needed ones:

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `WREN_HARNESS_WORKSPACE_ROOT` | Yes | none — the process exits with an error if unset | Directory the setup wizard scaffolds **new** Wren projects into. An **existing** project is brought in separately via the setup wizard's "adopt" flow, which accepts any path on disk and is not affected by this variable. |
| `PORT` | No | `4787` | HTTP port the BFF listens on. |
| `GENBI_HOST` | No | `127.0.0.1` | Address the BFF binds. Set it to `0.0.0.0` only when a reverse proxy on another interface must reach it (for example the Brev Secure Link); the BFF has no login of its own, so keep the port behind that proxy or a firewall. |
| `WREN_BFF_DB_PATH` | No | `./wren-harness-bff.sqlite` (created in the current working directory) | Path to the BFF's SQLite state file. |

There are additional environment variables for authentication mode,
provider selection, and other advanced configuration; they are not covered
here because they aren't needed for a first install and run.

## Network

`@wrenai/genbi` reaches `github.com` at two points:

1. **At install time** — `@warble/cli`'s postinstall script downloads the
   Warble executable for your platform (~12 MB) from a GitHub Release and
   checksum-verifies it.
2. **At install time** — `@wrenai/context-loader` downloads the exact
   darwin-arm64 generator artifact and verifies its archive and binary
   digests. Runtime never downloads it.
3. **At runtime, on first use** — the first time the app compiles a
   profile, it downloads a Hub component archive from GitHub. After that
   first download it's cached locally and no further network access to
   GitHub is needed for subsequent compiles.

Offline or air-gapped environments are not supported by this guide.

## OpenShell pi boot (operators)

This is for an administrator who runs GenBI with `GENBI_RUNTIME=openshell` and `GENBI_BACKEND=pi` (the pi step worker inside an OpenShell sandbox). The server never holds the model
vendor key and never creates a gateway object; you do that once with the shipped helper. It needs Docker (with the buildx component), an OpenShell gateway and a base driver
configuration (the OpenShell build, gateway, workspace, docker identity and the other images).

1. Write a spec (strict JSON, closed field set; a key field is rejected): the base driver configuration path, an output directory, an image tag, the gateway URL and its three PKI files, `auth`
   (`api-key` or `gateway`), provider name, profile id, display label, `generation`, the endpoint (`providerId`, `api`, `baseUrl`, and `credentialEnv`, the **name** of the variable your key lives in), and one exact model id per tier.
   Add `dockerConfig` (a docker configuration directory holding the `cli-plugins` buildx) if the build cannot find buildx under the base configuration's home.
2. Plan it: `npx --no-install genbi-openshell-pi provision --spec <absolute spec path> --dry-run`. It runs nothing and writes nothing.
3. Provision: the same command without `--dry-run`. It builds the pi image from the shipped assets, renders the policy and profile, lints and imports the profile, and writes `policy.yaml`, `profile.yaml`, `pi-boot.json` and
   `driver-config.json` (0600 files in a 0700 directory). Re-running is a no-op; a changed image, model, endpoint or file is refused unless you pass `--replace`.
4. Run the printed `provider create` command yourself, in your own shell, with your key in the named variable. The helper never runs it and never sees the key.
5. Check it: `npx --no-install genbi-openshell-pi verify --dir <output directory>` runs the checks boot readiness runs: descriptor, driver configuration, driver probe, gateway proof and the certified identity.
6. Start the server with `GENBI_RUNTIME=openshell`, `GENBI_BACKEND=pi`, `GENBI_OPENSHELL_CONFIG=<dir>/driver-config.json` and `GENBI_OPENSHELL_PI_BOOT=<dir>/pi-boot.json`.

pi is ready only when the identity matches a certified row. If `verify` reports `pi_uncertified` the host or OpenShell build has no row; `pi_identity_mismatch` means the image, policy or profile differs from the certified one (rebuild with the helper,
do not edit the files); `pi_dependencies_drifted` means this install runs other Warble, IR or context-loader versions than the evidence used. `genbi-openshell-pi row` prints the packaged row.

## pi on the local runtime (opt-in)

For a developer or operator who runs `GENBI_RUNTIME=local` and wants api-key and gateway Structured Ask to run through pi. pi is **not** in the default list; list it yourself, for example `GENBI_BACKEND=claude,codex,pi`.
There is no OS sandbox on this runtime: pi runs as your OS user with no filesystem or network confinement beyond its disabled tools, a private step directory and a loopback key proxy (it never holds your key).

1. Install pi (explicit, once per release; it downloads pi from the public npm registry and never runs at boot): `npx --no-install genbi-local-pi install`. It runs `npm ci --ignore-scripts` from the shipped lockfile into
   `<state dir>/runtimes/pi/<version>-<lockdigest>/` and writes that install's pins. The state directory is `GENBI_STATE_DIR` (absolute) or the per-user application state location; `GENBI_STATE_DIR` sets only the managed pi install's state root, and other GenBI state (for example managed Wren) ignores it. Re-running is a no-op; a different
   install is refused unless you pass `--replace`.
2. Certification: pi is ready only when a **packaged** certification row matches this host, this Node major version and the install's pins. This release packages one row, for macOS arm64 and Node 24 (evidence in
   `certification/pi-local-1.0.4-darwin-arm64-node24/` in the repository). Any other host or Node major version is `pi_uncertified`, and Node older than 22.19.0 is `pi_node_unsupported`. There is no way to supply a row
   yourself: no environment variable or file is read. `npx --no-install genbi-local-pi row` shows the packaged rows and whether they match your install.
3. Check it: `npx --no-install genbi-local-pi verify` runs the same check boot readiness runs. `pi_not_installed` means step 1; `pi_uncertified` that no packaged row covers this host or Node major; `pi_identity_mismatch` means the
   install differs from its pins or from the row (re-run `install --replace`); `pi_dependencies_drifted` means this install runs other Warble, IR or context-loader versions than the row's; `pi_node_unsupported` means Node is too old.
4. Queries from the pi Ask run through the governed Wren worker of the `wren` that boot resolved from `PATH` and attested (the one native sessions use), not Codex's managed Wren runtime. That is separate from pi, which is never taken from `PATH`; without a resolvable `wren` pi reports not ready.
5. Save the Runtime step with the api-key or gateway settings you use today; the key stays in the variable the in-process path already uses and only the proxy reads it. A provider the proxy cannot serve (for example SigV4-signed Bedrock)
   shows `pi_provider_unsupported`.

**Upgrading.** A release with a new pi version or lockfile points at a new install directory: run `install` again; the release ships the matching row. A different Node major version, a Warble/IR/context-loader bump or
a change to `runtime-assets/pi-worker/pi-mcp-shim.mjs` also denies the packaged row until a new row is released. Node patch and minor updates within the certified major need nothing.

## Troubleshooting

**"@wrenai/context-loader unsupported-platform"** (during `npm install`) —
your OS/architecture is not the certified macOS Apple Silicon target. There is
no fallback to a nearby architecture or an ambient binary.

**Node version errors, or unexpected syntax/runtime errors on startup** —
confirm your Node version is 20 or later (`node --version`). Older
versions are not supported by this package (`engines.node` in
`package.json` declares `>=20`) and are not tested.

**`error: WREN_HARNESS_WORKSPACE_ROOT is required`** — this environment
variable must be set before starting the app; see [Run](#run) above. There
is no default.

**`error: port 4787 is already in use`** — something else is bound to
`4787` (or to whatever `PORT` you set). Either stop it, or start on a free
port:

```bash
PORT=4790 WREN_HARNESS_WORKSPACE_ROOT="$HOME/wren-workspace" npx @wrenai/genbi
```
