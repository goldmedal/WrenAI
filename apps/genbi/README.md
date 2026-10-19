# GenBI app (`@wrenai/genbi`)

WrenAI's web UI. Point it at your data through the setup wizard, then ask
questions in the browser and get answers back as tables, charts, KPIs and
narrative.

The app does not write SQL itself. A question goes to the Wren agent harness,
which answers with a structured envelope — the blocks to render, and whether the
answer was verified — and the UI renders that.

To just run it, `npx @wrenai/genbi` is the whole story — see
[Getting started](#getting-started) below, or [INSTALL.md](./INSTALL.md) for
what it needs and how to configure it.

The rest of this README is for working on the app **from source**: getting it
running, and the daily build/test/typecheck loop. Three companion docs cover
the rest:

- [RUNNING.md](./RUNNING.md) — a live, BFF-backed dev loop against your own
  Warble build, and checking that the pieces still fit together.
- [MAINTAINING.md](./MAINTAINING.md) — versioning policy and the procedure for
  bumping the pinned Warble version.
- [INSTALL.md](./INSTALL.md) — running the app without developing it: what it
  needs, what it does on first start, and how to configure it.

## Developer preview

`@wrenai/genbi` is published at `0.0.8`. Nothing here is under a compatibility
commitment yet — commands, environment variables and interfaces move without
notice. Runtime support is limited to the exact versions and execution scopes in the
packaged certification records; a supported protocol alone does not enable a runtime. See
[MAINTAINING.md](./MAINTAINING.md#versioning) for what the version number does
and does not promise.

## Prerequisites

- Node 20+ and `pnpm` (the repo pins its version via `corepack`).
- Python 3.11+ for the separately installed `wren` CLI.
- The separately installed `wren` CLI on `PATH`. Live questions and context
  inspection shell out to it; the app does not install it for you.

A live, BFF-backed dev loop also needs a provider CLI you are logged in to. The
pinned `@warble/*` packages are already pulled in by `pnpm install` — see
[RUNNING.md § Prerequisites](./RUNNING.md#prerequisites).

## Getting started

### Just run it

```bash
WREN_HARNESS_WORKSPACE_ROOT=/absolute/path/to/an/empty/directory npx @wrenai/genbi
```

That fetches the published package, downloads the Warble binary for your
platform on install, and serves the built UI and the BFF from one process on
`http://127.0.0.1:4787`. You still need a provider CLI you are logged in to
(`claude` or `codex`) and the `wren` CLI on `PATH`.
[INSTALL.md](./INSTALL.md) covers the prerequisites, what happens on first
start, and every other environment variable.

### From source

Everything below is the development loop, and is only worth setting up if you
are changing the app. It lives in a pnpm workspace, so install JavaScript
dependencies from the repo root:

```bash
corepack enable
pnpm install
```

**Every command below runs from `apps/genbi`**, not the repo root — the root
only forwards `genbi:dev`, `genbi:build` and `genbi:test`, so `pnpm build` or
`pnpm test` from there will tell you the script doesn't exist.

Then build once and start two processes: the BFF, and Vite pointed at it.

```bash
cd apps/genbi
pnpm build
```

```bash
# terminal 1
WREN_HARNESS_WORKSPACE_ROOT=/absolute/path/to/an/empty/directory pnpm run start:bff
```

```bash
# terminal 2
VITE_BFF_URL=http://localhost:4787 pnpm dev
```

Open the URL Vite prints — `http://localhost:5273` unless something already holds
that port, in which case it takes the next free one and says which.

You need a provider CLI on `PATH` (`claude` or `codex`); the harness probes for one at boot
and says so plainly if it finds none. `WREN_HARNESS_WORKSPACE_ROOT` is the
directory Setup scaffolds new projects into — the one thing with no sensible
default. Everything else the BFF needs it resolves itself.

[RUNNING.md](./RUNNING.md) covers the rest: pointing at a Warble build of your
own, verifying the tuple, and the Codex situation.

## Build

Like everything else below the [Getting started](#getting-started) section,
these run **from `apps/genbi`**. The repo root has no bare `build` script; it
exposes only the passthroughs `pnpm genbi:build`, `pnpm genbi:test` and
`pnpm genbi:dev`.

```bash
cd apps/genbi
pnpm build      # tsc -b (frontend typecheck) && vite build (→ dist/) && tsc -p tsconfig.server.json (server + harness → dist-server/)
pnpm start:bff  # requires the BFF runtime env — see RUNNING.md
pnpm preview    # serve the built SPA on its own — no BFF, no proxy, fixture data only
```

## Test & typecheck

Also from `apps/genbi` (`pnpm genbi:test` from the root runs the same suite).

```bash
pnpm test       # vitest run — frontend (jsdom, src/**) and backend (node, test/**) as separate projects
pnpm typecheck  # tsc -b --noEmit (frontend) && tsc -p tsconfig.server.json --noEmit (backend)
```

Tests mock the BFF client and its SSE stream, so `pnpm test` never needs a
running BFF process.

A handful of end-to-end tests are the exception, and it's worth knowing before
it bites you: they opt themselves in when they find a real `wren` binary, or a
`warble` checkout, on the machine. On a clean machine they skip and the suite is
green. **On a machine that has those tools the suite can exit non-zero for
reasons that have nothing to do with your changes** — they run real queries
against real projects and depend on how well the configured model behaves. If a
test you didn't touch fails and mentions a real query, check whether it's one of
these before going looking for your own bug.

## Component execution contracts

Composed execution uses the versioned Vercel bundle or native host plan. The host owns
component selection, reachable children, semantic context, model tiers and tool grants.
The default dashboard calls `answer_query` for each panel; only the answer component has
query authority. Child calls receive independent inputs, products and evidence. Successful
root results are persisted only after all component resources have closed.

The shared host limits an execution to depth 8, 32 child-component invocations per root
execution, 40 executed steps globally, 12 executed steps per child invocation and 120 seconds. These are host call, step and time limits;
they do not promise a hard cap on internal model requests made by a vendor runtime.

Result verification uses observed tool/child data. Locked additivity and drill guards
require query provenance derived by the governed Wren process and matching prepared context.
The conservative SQL subset includes canonical cube measures, dimensions and simple literal
filters. Unsupported expressions receive no semantic proof, so guarded execution refuses
rather than inferring validity from model prose. Filter and order dimensions count toward
the drill limit. Guarded parents currently refuse child evidence without semantic provenance.

Native composition requires a separately certified, server-provided runtime for the same
approved account, with fresh per-step resources and revocation checks. Native host interfaces and passing deterministic
probes do not activate this capability. Claude retains its scope entry; Codex Analysis selects
one answer or dashboard entry before session creation and keeps that pin for the session.
A compatible CLI/package tuple and runtime certification are required before enabling the
native path; the pinned 0.13.0 CLI alone does not provide the new host contracts.

Codex Native sessions use the official CLI's remote terminal interface. A credential-free
renderer runs in the vendor sandbox and connects to one host-owned session over a private
Unix socket. The browser terminal supports text input, resize, reconnect and cancellation;
model, account, project scope and tools remain pinned by the server. General shell access,
configuration changes, login changes and cross-session commands are unavailable. Ending a
session closes its processes; restart creates a fresh session rather than resuming a provider
thread. Remote terminal admission requires its own `remote-tui-v1` certification evidence in
addition to the driver certification.

pi runs only inside an OpenShell image, so its identity is that image and never an executable on the host: the host does not run pi and does not discover it from `PATH`.
Under `GENBI_RUNTIME=openshell` with `GENBI_BACKEND=pi`, readiness requires an exact certified row (`server/runtime-host/openshell-vendor-certification.ts`) for the host,
the OpenShell build, the image's `pins.json` (pi version and bundle digest, lockfile, Node, worker, supervisor, shim, step-control and CA-trust file digests), the shipped policy and profile
templates, and the Warble, IR and context-loader versions. A `tested_baseline` record, a missing or partial row, an image whose declared `pins.json` differs from the row, or a changed template is never ready (the gate guards against drift and mistakes, not against a deliberately built image; its limits are in [`PI.md`](./server/runtime-host/PI.md#what-the-gate-does-not-prove)): the browser sees
the fixed codes `pi_uncertified`, `pi_identity_mismatch` and `pi_dependencies_drifted`. Claude on OpenShell keeps its existing readiness (it has no row yet). See
[`server/runtime-host/PI.md`](./server/runtime-host/PI.md) and the [certification record](./certification/pi-1.0.4-darwin-arm64/README.md).

`test/component-default-parity.test.ts` compares the real default profile across Vercel and
both native producer formats using deterministic model/database responses. It exercises the
host broker, context verifier, result normalizer and native admission, including repeated
child calls, caller tool isolation, root persistence and correlated events. It does not
perform account-backed runtime certification.

## Architecture

```
src/      the frontend SPA — React + Ant Design, one Zustand store per feature
server/   the BFF — Hono REST + SSE routes over a SQLite-backed session/artifact store
harness/  the agent runtime the BFF wraps — compiles a per-user profile and dispatches it
profiles/ the GenBI Warble profiles (genbi-default/-setup/-enrich-context/-monitor) + IRs
```

End to end: a question goes to the harness, which compiles the user's profile and
dispatches it to the configured backend; a verified answer envelope comes back,
and the UI renders it.

| Concern | Choice |
| --- | --- |
| Build / dev | Vite — client-rendered SPA, no SSR |
| UI | React + Ant Design (Wren AI Design System theme) |
| Routing | React Router |
| State | Zustand |
| Charts | ECharts |

It is a plain SPA rather than an SSR framework on purpose: it only talks to the
BFF over HTTP/SSE and builds to static assets, so a future desktop shell or PWA
stays a thin increment.


### Structured Ask query evidence

The direct Codex runtime carries host-normalized query results to the answer independently
of the model's final text. Tables preserve the executed rows and SQL. A model-written
`verified` flag cannot promote a text answer. If any root call fails or its evidence cannot
be represented, the answer falls back to unverified text. Multiple successful query roots
retain their table/SQL pairs in call order.

The query verification badge covers rows and SQL, not the model's explanation of business
meaning. Time-range and metric interpretation appears separately. Missing tool-supplied
lineage or filters is shown as unknown. Questions without a period use the available data
range and disclose that assumption; relative periods distinguish the current calendar from
the latest data date. Explanations should identify date bounds, date field, week start,
timezone (or unknown), partial periods and metric meanings. These are model instructions,
not proof of business semantics; ambiguous definitions still require clarification.

Structured Ask allows up to five minutes for the outer conversation (including the bounded
component call and explanation). Individual component/step deadlines remain unchanged. An
explicit caller timeout is preserved, and outer timeout failures are reported distinctly.

### Runtime and backend selection

Two independent settings choose where agents run and which agent backends a boot offers.
Boot reads them once and refuses to start, naming the cause, when they are invalid.

| Variable | Values | Default |
| --- | --- | --- |
| `GENBI_RUNTIME` | `local` or `openshell` | `local` |
| `GENBI_BACKEND` | comma-separated list of `claude`, `codex`, `pi` (whitespace trimmed; unknown, duplicate or empty entries refuse boot) | `claude,codex` under `local`; **required** under `openshell` |
| `GENBI_CODEX_MODE` | `exec` or `app-server` | `exec` |

`GENBI_CODEX_MODE` applies only with `GENBI_RUNTIME=local` and `codex` in the list; setting it
anywhere else refuses boot. `GENBI_OPENSHELL_*` variables apply only with `GENBI_RUNTIME=openshell`;
setting one under `local` refuses boot. They, and the Codex executable, source and login-home
variables, remain backend configuration, not selectors.

What each runtime supports:

| | `claude` | `codex` | `pi` | In-process api-key and gateway | Local-mode auth |
| --- | --- | --- | --- | --- | --- |
| `local` | yes | yes (`exec` or `app-server`) | no | yes | yes |
| `openshell` | yes | no | yes (api-key and gateway Ask only) | only through `pi` | no |

A runtime never offers a backend it does not support and never falls back to another runtime.
A listed backend the runtime cannot offer does not stop boot: boot prints one warning, readiness
reports it with `offered: false` and the state `not_offered`, and the operation is refused at
admission. Under `openshell` a boot names one model backend, so a list with both `claude` and `pi`
refuses boot. `GET /api/structured-runtime/readiness` reports `runtime` and, for `claude`, `codex`
and `pi`, `offered`, `state` (`ready`, `unavailable` or `not_offered`), `ask`, `setup` and a
`reason`; native readiness reports the same block as `runtimeSelection`.

The old per-vendor variables are removed, and setting any of them refuses boot:

| Removed | Replacement |
| --- | --- |
| `GENBI_CLAUDE_RUNTIME=openshell` | `GENBI_RUNTIME=openshell` and `GENBI_BACKEND=claude`; that boot no longer offers Codex or in-process api-key, gateway and local-mode auth |
| `GENBI_CLAUDE_RUNTIME=local` | unset (`local` is the default) |
| `GENBI_CODEX_RUNTIME=app-server` | `GENBI_BACKEND` including `codex`, and `GENBI_CODEX_MODE=app-server` |
| `GENBI_CODEX_RUNTIME=local` | unset (`GENBI_CODEX_MODE` defaults to `exec`) |
| `GENBI_ALLOW_LOCAL_RUNTIME=0` | omit the vendor from `GENBI_BACKEND`, or use `GENBI_RUNTIME=openshell`; with `GENBI_CODEX_RUNTIME=app-server` it becomes `GENBI_RUNTIME=local`, `GENBI_BACKEND=codex`, `GENBI_CODEX_MODE=app-server` |

### OpenShell lifecycle backend

OpenShell is opt-in. Structured Ask supports only `answer_query`: the model runs in a fresh
OpenShell model worker, while read-only Wren query/inspect operations use a separate admitted data worker with its own immutable image and read-only snapshot. The host component broker owns SQL, row and statement-time limits, scope revocation and final persistence. Only a verified host root produces a successful answer; model prose or artifact files
cannot declare verification. Query rows and SQL are grounded; interpretation is not certified.
Scoped Native Sessions also use `answer_query` and the same admission, broker, revocation and verified root persistence. Setup, dashboards, enrichment, official Claude TUI and hybrid/disclosure modes remain unsupported. Container readiness alone does not certify account or query readiness.


Scoped Native Sessions provide an ordered, bounded event view with follow-up questions,
query traces and verified answer envelopes. Browser reload/reconnect on the same BFF replays
saved events and reattaches to the same server-owned sandbox; detaching the browser does
not cancel execution. Repeated request IDs do not repeat tools or create another answer.
Follow-up context comes from validated host-persisted answers, not a vendor conversation
resume. Stop/cancel aborts the root and query leases. Normal step completion requires an
exact receipt, clean CLI exit, zero owned descendants and removal of that step's private
state before another step can start. Cancellation, failed cleanup or uncertain identity
interrupts the session and tears down its exact sandbox. A BFF restart marks prior work
interrupted and reconciles owned resources; it cannot resume the session. Successful
synthetic tests do not certify live model/account behavior.

An administrator can select `GENBI_RUNTIME=openshell` with `GENBI_BACKEND=claude` and point
`GENBI_OPENSHELL_CONFIG` at an absolute, private JSON configuration file. The host configuration
contains `executable`, `executableDigest`, `version`, `gateway`, `workspace`, `image`,
`supervisorImage`, `policy`, `policyDigest`, `home`, `configHome`, `stateHome`,
`dockerExecutable`, `dockerRealpath`, `dockerDigest`, `dockerSocket`, `dockerNamespace`, and
`exclusive: true`. Digests use `sha256:<64 hex digits>`; images are immutable local IDs.
Executable, policy, private environment directories and Docker paths are absolute host paths.
The Docker launcher may be a multicall symlink; its resolved target and bytes are checked.
The browser cannot supply these values or launch arbitrary commands. The default remains off.

Model Ask additionally requires `GENBI_OPENSHELL_CLAUDE_BOOT` to name a canonical absolute JSON
file owned by the BFF user, mode `0600`, under a canonical owner-only `0700` parent. Its strict
version-1 shape contains `verifyRetainedAccount: true`, absolute `vaultRoot`, `caCert`, `clientCert`
and `clientKey` paths, `gatewayUrl` (the HTTPS OpenShell gateway), an `expected` tuple
(`accountUuid`, `organizationUuid`, `email`, `subscription`), and a closed `models` map with only
optional `sonnet`, `opus`, `haiku` keys holding explicit concrete model IDs. The PKI files have the
same owner-only file/parent rules. No credential bundle, vendor endpoint override or arbitrary
model-map key is accepted. Missing or unsafe configuration leaves Ask unavailable.

This explicit boot opt-in refreshes and verifies an **existing** retained account through fixed
host endpoints in the same BFF process. It does not enroll an account or discover ambient login.
Without this opt-in, restart retains no verified identity authority. Runtime tier selection comes
from validated explicit server settings; `inherit` resolves their explicit driver model, and any
alias must have a host pin. Missing/recursive mappings fail closed. Configuration, models, account,
project/binding and runtime generations are rechecked through tools, results and persistence.
Ordinary runtime/binding revocation aborts work and retains the login; explicit account disconnect
still removes its retained credentials. Readiness/UI expose availability and execution location,
without account identity, paths or credentials. Synthetic validation does not imply a real-model
acceptance run.

With `GENBI_RUNTIME=openshell` and `GENBI_BACKEND=pi`, the boot serves the pi step worker for
api-key and gateway Ask instead of Claude (one model backend per boot), with
`GENBI_OPENSHELL_PI_BOOT` naming a protected descriptor with the same file rules; that variable,
like every `GENBI_OPENSHELL_*` variable, refuses boot under `local`. `pi` is always offered on the
OpenShell row when listed; it is ready only when its descriptor, driver probe and gateway verification succeed **and** a certified identity row matches the configured image, policy,
profile and OpenShell build (`pi_uncertified`, `pi_identity_mismatch`, `pi_dependencies_drifted` otherwise), and otherwise readiness reports it unavailable. The Setup Runtime step shows the pi backend,
its readiness and reason code, the provider label and the pinned model per tier read-only; saving applies the pins. It never shows the endpoint, credential name, profile or any path. The Claude descriptor and vault are not read in
that mode, the driver configuration carries the `pi` block and no `model` block, and a
subscription Ask is not offered. The descriptor
names an operator-provisioned OpenShell provider and provider profile, one pinned model id per
tier, and the one model endpoint; the BFF never holds the vendor key, never reads
`OPENAI_API_KEY` or `GENBI_GATEWAY_API_KEY` for such an Ask, and never creates or changes a gateway
object. It only verifies, read-only and fail-closed at boot, before every Ask and every step
sandbox, that the provider exists with the profile as its type, that the exported profile has the
recorded digest with exactly one endpoint and only the node binary, and that the credential name
matches. Provision a boot with the shipped operator helper, which builds the image, renders and imports the policy and profile, writes the protected descriptor and driver block and
**prints** the provider-create command for you to run with your own key (it never reads, accepts or stores a key); see [INSTALL.md](./INSTALL.md#openshell-pi-boot-operators). The descriptor
shape is in `runtime-assets/pi-worker/README.md`.
The `answer_query` Ask and the scoped Native Session are available; setup, dashboards, enrichment and hybrid
stay unavailable, exactly as for Claude, and nothing falls back to in-process execution.

A pi Native Session is the Claude scoped session with pi as the step worker. An explicit api-key or gateway
Runtime binding on this boot is the pi native binding (`provider: "pi"`, `target: "pi:scoped-events"`; a
subscription binding is not one). Creating the session reserves one owned pi-image sandbox, after the same
read-only gateway proof as every Ask. Each turn runs the governed `answer_query` route, and each component step
is a fresh `pi --mode json` process inside that sandbox, in its own `/sandbox/steps/<step>` directory behind a
private receipt: the sandbox is baselined before the first step, checked before every step, and every step's
process group and directory are proven gone before the next one starts. Anything uncertain interrupts the
session and tears down its sandbox. Conversation memory is host-owned (validated answers and refusals prepended
as context); pi holds no state between steps. The gateway objects are re-verified while a session lives, and a
change destroys its sandbox at once. pi is never a host-terminal target: it is not an interactive target, and
both `/api/context/terminal/*` launch routes refuse it.

This backend requires a **GenBI-exclusive gateway/workspace with no other resource writer**,
and one lifecycle controller per private state root. Shared gateways are unsupported.
OpenShell's name-based deletion has no atomic expected-ID precondition. GenBI uses unique
never-reused names and exact remote ID/owner checks; a privileged administrator violating
gateway exclusivity is outside that guarantee.

SQLite records intent before remote create. Cancellation revokes the host lease before
cleanup. Uncertain create/delete responses retain `cleanup_pending` ownership and block new
admission. A lost create response followed by an empty list cannot prove absence; the intent
is retained until an owned resource can be reconciled. Startup marks unfinished owned work
interrupted and reclaims resources, without resuming execution. Cleanup requires a complete
remote listing and container/owned-volume absence; local process termination alone is not
proof of remote cancellation. Readiness reasons are fixed public messages; configuration,
subprocess output and credentials are not included.

#### Immutable project snapshots

The host composition exposes publication and delivery permits for synthetic static files
and quiescent local DuckDB projects. The host must supply the currently accepted Store
binding, fresh project/context callbacks and an exact relative file allowlist. Without
these callbacks the snapshot capability remains unavailable. There is no browser path
selector or model command API, and governed Wren execution is not enabled.

Snapshot configuration requires all of `dataPolicy`, `dataPolicyDigest` and
`snapshotCapture`. The latter declares `executable`, `realpath`, `digest`, `helperDigest`
and `approvedFiles`. The packaged helper requires an explicitly configured Python 3.11+
interpreter with descriptor-relative directory operations and `O_NOFOLLOW`; both the
resolved interpreter bytes and helper bytes are attested. No ambient Python fallback is
used. Helper tests and packed-install verification require the explicit
`GENBI_SNAPSHOT_CAPTURE_PYTHON` test interpreter path.

The version 1 manifest is UTF-8 JSON with recursively sorted object keys, compact
separators and no trailing newline. Its `sha256:` digest hashes the canonical object
without the `digest` field. It includes `version`, `project`, `bindingGeneration`,
`bindingRevision`, `context`, `source` (the canonical approved source inventory hash)
and sorted `files` entries containing `path`, byte `size` and lowercase hex `sha256`.
Payload files include approved project content and a closed worker-safe configuration
projection. Runtime, account and session identities live in separate durable references.

Capture accepts at most 4094 approved files; the final payload has at most 4096 files,
256 MiB total and 128 MiB per file. Paths are relative POSIX ASCII paths with at most
16 components and 240 bytes; components start with an alphanumeric character and contain
only alphanumerics, underscores, dots or hyphens. The manifest is limited to 1 MiB.
The whole source root must match the approved files and their parent directories exactly.
Symlinks, hardlinks, nonregular files, case aliases, undeclared content, database sidecars
and changed source inventories are rejected. This deliberately excludes ordinary project
roots containing extra files until the host approves a suitable closed source root.

Publication uses a separate owned local Docker volume and bounded network-disabled
helpers, followed by an independent full-content verification and source recheck.
Only a designated data worker receives one snapshot at `/opt/genbi-project`, read-only;
agent and supervisor roles receive none. Each delivery acquires a new session reference.
Active or uncertain references and any remaining remote mounts prevent deletion.
Startup reconciles workers before references and orphan publications, without resuming
interrupted work. These guarantees require the same exclusive gateway/controller contract
as the lifecycle backend.

#### OpenShell enrichment: scope, Apply-all and recovery

Under the OpenShell backend a context-enrichment draft is validated in a credential-less sandbox and then reviewed as **one change set**. The only actions are Apply-all and
Discard; per-operation decisions, approvals, edits, retries and re-applies are refused.

Scope (existing files only). The governed snapshot must keep equalling the operator's `approvedFiles` list exactly, so enrichment may only **modify files that are already in
that snapshot**: append to an existing `knowledge/{rules,glossary,metrics,caveats,sql}/*.md`, add or extend `description` values in an existing `models/*/metadata.yml`, or
extend an existing `relationships.yml`. Anything that creates a file, and every cube, view and calculated column, ends `validation_failed(unsupported_by_runtime)`; the host
decides this before the sandbox runs, the validator refuses it independently, and Apply re-checks it. A `knowledge_append` draft is only the text to add: the host appends it to
the current bytes (one separating newline when the file does not already end with one). Local-backend enrichment is unchanged.

Apply-all. `POST /api/context/enrichment/:id/apply/authorize` mints a server-generated, single-use capability (256 bits, stored only as a hash, valid 10 minutes, returned once,
bound to the run, review hash, change-set hash, binding and model account; minting again invalidates the previous one). `POST .../apply {capability, reviewSha256}` spends it,
re-checks the account, binding generation and revision, the **full per-file source manifest** against the reviewed one, each target's before-bytes and the absence of links, then
journals (`enrichment_apply_journal`, with the before bytes) **before** writing exactly the reviewed files plus the validator-regenerated `target/mdl.json` (temp file, fsync,
rename, directory fsync). On success one transaction advances the binding generation, revokes the project's native sessions and marks the run `applied` with a receipt; new sessions
publish a fresh snapshot, nothing is remounted and no image is rebuilt. Applying an applied run again returns its receipt and writes nothing. `POST .../discard` ends a validated or
validation-failed run without writing anything.

Recovery. On BFF start an `applying` journal row is rolled back if every file is exactly its old or its new bytes (run `apply_failed`), otherwise it becomes `reconcile_required`.
Nothing is ever resumed forward. While a `reconcile_required` row exists for the project, no OpenShell apply can be minted or run. Operator resolution, with the BFF stopped:
inspect the row (`sqlite3 <db> "select run_id, state, evidence, files_json from enrichment_apply_journal where state = 'reconcile_required'"`), restore each listed file from its
base64 `before` bytes (or accept the current bytes), then `update enrichment_apply_journal set state = 'resolved' where run_id = '<id>'`.

### Host-only Claude component transport

An internal OpenShell provider can run one governed Claude component step per fresh
Linux arm64 model worker. Structured Ask owns an ephemeral worker; scoped Native Sessions hold one admitted sandbox for the lifetime of the session, with a fresh process and private HOME/config/tmp/work directory for each component step. There is no
local fallback. The host retains the OAuth refresh material in a private locked vault,
verifies the host-approved account UUID, organization UUID, email and subscription
with authenticated minimal refresh grants and a same-access profile observation,
then binds account fingerprint and enrollment generation to
server-owned session, turn, binding, plan, context and step identities. Imported or
restart-interrupted bundles remain unavailable until verified again.

Only a short-lived access credential travels in a private one-shot stdin bootstrap.
It never enters SDK options, RPC command/environment metadata or argv. The worker
creates transient isolated HOME/configuration and executes pinned Claude Code 2.1.259.
The direct host SDK is 0.3.259; Warble's transitive SDK 0.1.77 remains separate. The
model image contains no Wren/project data or host/admin mounts. Its policy permits
only the declared Anthropic model API; refresh runs on the host against the exact
public CLI OAuth endpoint/client contract. No startup provisioning, account import,
login, refresh or model call happens automatically.

The packaged public OpenShell SDK closure is pinned to
`7e7a8d5610f336f5f7f9f60da0951adbf295475d`, with complete asset hashes, Apache-2.0
license and exact runtime dependencies. Normal install/build/pack needs no Git, Buf
or Rust for this transport. An explicit maintainer regeneration check is available:
`node scripts/regenerate-openshell-sdk.mjs /absolute/public/OpenShell-checkout`.
The minimal worker recipe and policy are in `runtime-assets/claude-worker`.

Transport refusal ceilings include encoded envelope bytes: 64 KiB per write chunk,
2 MiB per newline frame, 16 MiB total admitted input (including the separately
16 KiB bootstrap), 16 MiB combined stdout/stderr, 4 MiB unread stdout, 1024 combined protocol frames, 32 tools, 120 seconds per step and 15 seconds for owned cleanup.
Lower component payload limits still apply. These are bounded local admission limits;
OpenShell has no upstream drain. A producer ignoring `write(false)` remains bounded.
Stdin half-close is unsupported. Cancellation revokes admission before cleanup;
success requires settled tools and independently proven remote resource absence.
Uncertain cleanup remains `cleanup_pending` and blocks reuse.

Real identity verification and two-session retained-login smoke require separate
human authorization. The operator utility reads only explicitly supplied private
files, never ambient accounts:

```sh
# After separate profile and refresh authorization; no prompt/model call:
node scripts/openshell-claude-live-probe.mjs \
  --authorize-profile --authorize-refresh --operator-file=/absolute/private/operator.json
# After separate model authorization; two fresh scopes, one declared echo each:
node scripts/openshell-claude-live-probe.mjs \
  --authorize-profile --authorize-refresh --authorize-two-session-models \
  --operator-file=/absolute/private/operator.json
```

The mode-0600 operator file must provide `openshellConfig` (absolute private runtime
configuration path), `pki` (`gateway`, `caCert`, `clientCert`, `clientKey` paths),
`credentialBundle` (absolute mode-0600 file containing `accessToken`, `refreshToken`,
`expiresAt`), private `vaultRoot` and `stateRoot`, exact approved `expected` tuple (`accountUuid`, `organizationUuid`, `email`, canonical `subscription`: pro/max/team/enterprise)
and server-selected `models.cheap`. The configured
model image/policy must match the built pinned worker tuple, with exclusive gateway
ownership. Imported or restarted credentials are unverified until refresh grants and same-access profile match. Worker SDK metadata may omit email/subscription; its source/provider must be exact and optional fields must not contradict host identity. Refresh/profile/persistence failure leaves execution unavailable; vendor refresh rotation may require explicit credential re-enrollment. Never restore cached authority or weaken the
checks. Synthetic peers and anonymous initialization do not certify retained login.

The host identity phase requires independent profile and refresh permission. Add
`--authorize-worker-observation` only with separate approval for an isolated no-model
CLI observation. Two-session model permission is separate again. There is no ambient
credential import. Identity observations establish the token generation; vendor-side
entitlement changes between observations are not continuously monitored.
