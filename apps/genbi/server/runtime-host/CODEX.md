# Codex backend contracts

The server-side backend, RPC and process contracts require exact executable
certification independently of backend selection. The registry includes a locally
approved Codex 0.156.1 macOS arm64 identity. Local runners remain the default;
app-server selection is explicit. See the [certification record](../../certification/codex-0.156.1-darwin-arm64/README.md).

## RPC and cleanup

`CodexRpcClient` consumes newline-delimited JSON, registers pending requests
before writing, and correlates replies by connection-local numeric IDs.
Malformed frames, unregistered server requests, duplicate/unknown response IDs,
transport loss, cancellation, and timeouts invalidate the whole connection.
Pending requests reject with fixed errors; remote error messages and stderr are
never retained in diagnostics. Incoming and outgoing frames are bounded to
1 MiB, and at most 128 requests can be outstanding.

The consuming adapter must validate notification methods and payloads in its
callback; throwing rejects the connection. Known notifications still require
operation-specific handling. In particular, an isolated Codex baseline process
emits `remoteControl/status/changed` during startup, even without a thread.

Every owner must await `close()`, including after failed requests, to distinguish
an operation failure from incomplete process cleanup. The stdio transport owns a
POSIX process group. It closes stdin, sends TERM, then escalates to KILL with
bounded liveness checks. EPERM means exit is unproven; only ESRCH establishes that
the group is gone. Cleanup failures are reported, never silently accepted.
Process groups cover inherited descendants, not processes that independently
create another session; vendor sandbox/connection cleanup evidence is still
required before certification.

## Certification

`evaluateCodexIdentity` compares the exact baseline version, executable digest,
source, protocol digest, required contracts, and evidence records. The optional
row argument is a pure release-validation/test seam. A matching row is still
denied with `codex_dependencies_drifted` when the installed Warble, IR or
context-loader packages differ from the versions recorded with its evidence. A successful fixture
comparison cannot mutate the packaged registry or certify an unknown executable.
The backend hashes the selected native executable before running its bounded
version query. The reviewed row binds that executable to its generated schema
and behavior evidence. npm shell/Node wrappers are not executable identities:
composition must resolve the package's native platform binary and capture its
source identity. No ambient PATH discovery happens at session launch.

Initialization validates platform, home and version-bearing user agent, checks
the effective configuration with `config/read`, and requires the selected
`permissionProfile/list` entry to be allowed. Null optional configuration fields
mean absence; additional non-null filesystem, network or environment grants are
rejected. An initialize acknowledgement alone is never certification.

## Server-owned permission mapping

The generated Codex 0.156.1 schema documents mutually exclusive forms:

| Operation | Inline policy | Named permission profile |
| --- | --- | --- |
| `thread/start` | `sandbox` | `permissions` |
| `turn/start` | `sandboxPolicy` | `permissions` |
| `command/exec` | `sandboxPolicy` | `permissionProfile` |

The backend always uses the right-hand column. Inline SandboxPolicy has no
protected-read rules and cannot be combined with a named profile. Each launch
builds its sole `genbi-scoped` profile from the host-owned `NativeRuntimeSpec`.
The command-only path retains these restrictions:

- Workspace write, managed generation/tool directories/project/data roots read.
- Shared scratch roots `/private/tmp` and `/private/var/tmp` denied, with only
  narrower host-owned workspace grants. Codex 0.156.1 respects these exclusions
  in implicit scratch permissions; the retired 0.146.0 baseline did not.
- Selected session Wren home read-only; original project `.env` and vendor login
  home denied. Selected database-secret material remains owned by the existing
  Wren-home materializer, not copied by this adapter.
- Command network disabled, shell environment inherited from nothing, and only
  explicitly selected variables set. `CODEX_HOME` belongs only to app-server;
  it is unset for commands. No provider key is inherited from the BFF.
- Unscoped MCP, hooks, plugins, browser/computer tools, apps, multi-agent and
  dependency-installation features are disabled. Their future scoped support is
  not implied by command sandbox evidence.

The externally authenticated Codex home must be private and separate from the
workspace, tools and default user home. This adapter does not copy/login/logout
credentials. Custom configuration, user skills and project `.codex` directories
in workspace ancestry fail closed; only the vendor-seeded `.system` skill
namespace is admitted. No arbitrary caller config/env/policy/cwd override exists
on the command interface. Symlinks, glob-bearing policy paths and credential-root
read grants are rejected. The vendor, not GenBI, enforces the sandbox.

## Host-owned direct analytical tools

`prepareCapturedCodexDirectTools` captures the project fingerprint, prepared
context and Wren credential identity using the existing component runtime. It
calls the released `produce-session` contract for exactly one pinned analytical
entry, including entries without child calls. It validates the emitted IR,
component declarations, host contract and plan digests before creating admission.
The temporary host files are removed; no `.codex` or MCP configuration is emitted.

The result is a host-only `CodexSessionTools` object passed as `tools` to backend
`open`. The caller must close it if launch is abandoned; once connected, the
session owns its cleanup. It binds the account, session, runtime generation and
project binding and requires an explicit expiration time and lifetime signal.
A single generated root tool accepts only `{ request }`; paths, credentials,
component/step selection and connection parameters are not model inputs. All
step execution remains in the component broker, including dashboard-to-answer
calls, context checks, query guards, cancellation and root-only persistence.

Direct-tool policy disables shell/file tools and command RPC, uses the same named
profile with filesystem and network denied, and supplies no runtime workspace
roots. The vendor environment has neither `WREN_HOME` nor `WREN_PROJECT_HOME`.
MCP stays empty and project `.codex` rejection remains in force. The dedicated
vendor login remains separate; initialization verifies `account/read` against
the captured approved account before any thread starts.

Tool calls must match the active connection, thread, turn, advertised name and
started tool item. Only one call is admitted at a time, with at most 32 per turn,
64 KiB arguments and bounded results. Replayed IDs, extra authority fields,
expired/revoked identities and late results fail closed. Interrupt/disconnect
aborts pending host work; close awaits admission cleanup. Typed tool events carry
only their projected status, not raw request parameters or vendor result payloads.

This composition seam does not register a production backend, add a certification
row or provide a browser route. The durable Sessions/API/UI owner remains
responsible for launch fences and attachment authorization.

## Launch and generation ownership

Phase 5 composition must call `prepareLaunch()` **before** writing durable session
rows or materializing a workspace. It resolves the approved managed runtime and
certified vendor identity without fetching, installing or creating directories.
The opaque, single-use permit pins that exact managed record. Call
`permit.assertActive()` immediately before each materialization or persistence
step, so a delayed permit cannot authorize a changed generation. Call `release()` if
materialization is abandoned; never accept a serialized permit from a client.

`open(permit, { spec, wrenHome, assertScopeActive, onEvent })` revalidates the
managed closure, vendor identity, active binding/generation guard, Wren-home
identity and derived policy before spawning. Subsequent operations repeat those
checks; they cannot switch generations. `retainedManifestDigests()` is the retain
set the cleanup owner must union with current/rollback generations. Cleanup
failures retain the lease; do not garbage-collect it on a failed close.

`probe()` can supply RuntimeHost's Codex-only vendor probe seam; it never changes
the other backends' results. No existing API, Ask/Setup/native Sessions routing,
or default backend selection is changed by these modules. Connecting the scoped
tool seam to the Sessions owner and browser event UI remains later composition work.

## Direct events versus command/PTY

`CodexConversation` is the process-local Sessions bridge above this driver.
The host passes the existing backend, a previously obtained single-use permit,
and its materialized scope/Wren-home inputs. Await `ready` before presenting an
interactive conversation; construction begins an asynchronous open and one
ephemeral thread, never a turn. The host must guard durable writes and scope
materialization with the permit before constructing the bridge.

An attachment requires the host-generated capability and grants only prompt,
interrupt and detach operations. One attachment controls a conversation at a
time; detached handles lose authority even when another attachment reconnects.
Detach does not cancel an already accepted turn. The existing Sessions owner
must enforce its initial-attachment/detach lease and invoke/await `close()`.
Do not persist or log capabilities, backend inputs, or driver objects.

Replay starts with explicit cursor/truncation/state metadata, followed by
strictly sequenced event/state frames. Retention is process-local, limited to
256 frames and 1 MiB of serialized UTF-8; it is not durable history or a complete
snapshot. Consumers must show truncation and must not assume retained deltas
contain the start of an item. Listener payloads are isolated copies. Listener
failure closes the owned backend; browser transport backpressure must be
bounded separately by the API/WebSocket owner. Vendor transcript content remains
untrusted user-facing data, never diagnostic text.

Only one turn may run at once. Interrupt waits for turn completion, not merely
the interrupt acknowledgement. Before a turn ID exists, cancellation closes the
connection instead of guessing an ID. Close also settles the bridge's pending
turn if the underlying driver has not yet settled it; cleanup failure is still
reported and generation retention remains the backend's responsibility.
Idle transport failure is observed through `CodexSession.onFailure()`.
Command/PTY events are rejected by this bridge, not rendered as conversation
text. After close, a capability can read the retained tail only if the enclosing
Sessions authorization still permits it; revocation and durable lifecycle state
belong to that owner.

NativeSessionService can own this bridge through a server-only `directCodex`
provisioner when the explicitly selected backend is `codex-app-server`. The
provisioner must acquire a backend permit before the durable row or preparation,
provide captured scoped tools, and dispose allocations only after connection and
tool cleanup succeeds. It must clean partial preparation on error and honor the
lifetime signal. Missing preparation or an unsupported purpose fails closed;
there is no terminal fallback. Direct sessions currently accept bound analysis
entries only. The default application composition supplies no direct provisioner,
and certification remains a separate activation gate.

Durable rows mark `transport: "conversation"`; existing terminal rows retain
their original shape. `/api/native-sessions/:id/conversation` accepts the browser
capability and a replay cursor, then strict prompt/interrupt commands only after
WebSocket open. Each socket owns its attachment; detach preserves the bounded
in-memory tail for explicit reconnect. The UI renders plain text/tool status,
not PTY bytes. Initial and detached leases, runtime/project revocation, and
awaited stop/shutdown own cleanup. A backend failure updates the durable row even
without a browser. Process restart retains metadata but ends the conversation;
there is no provider resume for ephemeral threads. Structured Ask/Setup injection
is not part of this composition, and no MCP or project `.codex` policy is relaxed.

`startThread()` creates one ephemeral thread. `runTurn(text, { timeoutMs, signal })`
resolves on `turn/completed`, **not** the start acknowledgement. Turn statuses are
`completed`, `interrupted`, or `failed`; raw vendor error details are omitted.
Start/completion and item events that arrive before the start reply are buffered
within 128 events / 1 MiB, then correlated by thread/turn/item identity.

`onEvent` receives the explicit typed projection in `codex-events.ts`, not an
opaque notification. Unknown methods, unsupported tool/item types, wrong IDs,
duplicate completions, malformed payloads or callback failure close the entire
connection. Valid disabled remote-control status is consumed without exposing
its host identity. Event content is user-facing transcript data, not diagnostics;
the UI must render it as untrusted content. Replay/storage belongs to Phase 5.

`startCommand({ command, tty?, size?, timeoutMs? }, signal?)` returns an owned
handle with `completed`, `write`, `resize` and `terminate`. Output is streamed as
base64 bytes; final command results contain an exit code, with no duplicated
buffered output. Limits: 16 commands, 256 KiB per output stream, 64 KiB per stdin
write, 500x500 terminal size, and five minutes per command/turn. Resize requires
a PTY; writes after stdin close or completion are rejected. There is no command
ready acknowledgement: consumers that need readiness must use command-owned
output; control request errors are terminal, never retried on the host.

`interruptTurn()` sends the scoped interrupt and still waits for completion under
a two-second watchdog. Abort, timeout, malformed protocol, disconnect and shutdown
invalidate the connection and settle outstanding work. `terminate()` awaits both
the command control acknowledgement and the final command result. Always await
`session.close()`; `backend.shutdown()` also owns connections still initializing.
The transport gives EOF cleanup a short grace period, then TERM/KILL escalation;
process cleanup is bounded to approximately 2.7 seconds. A cleanup error is not a
successful cancellation.

Backend launch failures use `CodexBackendError.code` and fixed browser-safe
messages. Low-level `CodexRpcError.reason` values are fixed tokens (`protocol`,
`permission`, `remote`, `transport`, `closed`, `cancelled`, `timeout`, `cleanup`).
Consumers must distinguish cleanup failure from operation failure, never forward
arbitrary exceptions, and never fall back to local execution.
Initialization/shutdown cleanup failure uses `codex_app_server_cleanup_failed`
and explicitly retains the affected generation.

## Verification and remaining activation gates

Deterministic tests cover RPC, negotiation/config mismatch, permits/generation,
scope/environment, direct events, command/PTTY controls and cleanup failures.
`scripts/codex-backend-probe.mjs` exercises the compiled driver on the exact macOS
baseline with synthetic login/Wren fixtures, positive file/network/liveness
controls, PTY resize, timeout and disconnect descendant cleanup. It never starts
a thread/model turn. The runner repeats it with both shared scratch roots as
`TMPDIR`, in addition to the normal user temp directory, in macOS CI.
Packed-install acceptance loads these modules through `npx` with checkout access
blocked and proves that fixture protocol success cannot make production ready.

Only the exact reviewed 0.156.1 macOS arm64 source and executable are admitted.
The local approval binds deterministic, protocol and installed candidate evidence.
Authenticated acceptance covers gpt-5.5 with Jaffle answer_query through Structured
Ask and Native Analysis, including reconnect and stop. Other models, dashboard,
Setup, Claude and other platforms do not inherit that live acceptance. The row
records its model/entry scope; application readiness checks all selected models,
and preparation rejects entries outside that scope. An approved
managed runtime alone never certifies a different vendor executable.

Protocol reference: [Codex App Server](https://developers.openai.com/codex/app-server).
The installed baseline's generated schema remains the version-specific reference.

## Structured Ask and Setup composition

`StructuredRuntime` is the server-owned injection boundary for Ask and Setup.
Its per-vendor selection is explicit: local, Codex app-server, or Claude sandbox.
A missing, mismatched or unready adapter is rejected before execution; neither
local execution nor another vendor is a fallback. The default BFF explicitly
retains its existing local runners. The new readiness endpoint reports each
vendor and its Ask/Setup support independently; local readiness is not evidence
of sandbox certification.

`createCodexStructuredAdapter` accepts the existing backend permit and a
server-owned provisioner of scoped tools. It currently supports answer_query
and generate_dashboard only. Preparation must honor the captured session/turn,
Runtime/project generation guard and abort signal, and clean partial allocations
on error. Process/tool cleanup must complete before disposal or delivery of a
successful result. Direct Setup has no accepted producer contract and remains
unsupported. Claude sandbox likewise requires its separate backend. Injected
Setup contracts are tested synthetically; they cannot create legacy resume
anchors. The application provisioner and exact certification registry remain separate gates.

Structured results retain the existing answer/artifact folding, with the direct
Codex backend recorded separately. Runtime/binding changes revoke active runs;
caller cancellation and host shutdown share the owned lifetime. Host state and
credentials stay out of readiness/errors and are not accepted from browser
runtime-selection fields. Harness types expose no server imports.

## Explicit application composition

The application composes the same certified Codex backend into Native Analysis
and Structured Ask. `GENBI_CODEX_RUNTIME=app-server` selects it explicitly;
`local` remains the default. `GENBI_ALLOW_LOCAL_RUNTIME=0` disables the legacy
local paths. Unknown values reject startup. Native Sessions currently use one
selected backend, so selecting app-server limits that surface to Codex Analysis;
Setup and Claude do not fall back. Structured Ask retains independent vendor
selection.

The direct provisioner requires server-owned configuration:

- `GENBI_CODEX_EXECUTABLE`: absolute path to the exact native executable.
- `GENBI_CODEX_SOURCE`: HTTPS release source matching its packaged certification.
- `WREN_HARNESS_CODEX_HOME`: separate, private, externally authenticated login
  directory; credentials are never copied from the user's usual home.
- `GENBI_CODEX_ACCOUNT_EMAIL`: expected ChatGPT account, checked by the protocol.
- Saved Codex Runtime settings: explicit driver and cheap/strong tier models.

These values do not grant certification. The real backend rejects identities
absent from the exact reviewed registry. Evidence includes account verification,
dynamic tools, and component-step isolation contracts. Readiness is resolve-only; it neither provisions nor logs in.

After a launch permit, each operation gets a fresh private workspace and HOME.
The vendor receives only the pinned component tool, with host filesystem,
shell, network tools and ambient MCP disabled. Host-owned Wren access uses an
explicit environment and captured project/profile identity; each component step
opens its own certified transport with the same account and captured tier model.
Native verified root results use the existing answer/artifact validator. Cleanup
must finish before workspace disposal; unconfirmed cleanup retains materialization.
The installed-package test checks explicit selection and refusal without checkout
access or model calls. The exact local authenticated acceptance scope is recorded
in the certification evidence; it is not a general model compatibility claim.


### Passive component event checks

Component notifications check the captured account, model, runtime generation,
project binding and cancellation state without re-hashing the runtime closure
for every streamed token. The production provisioner supplies this separate,
server-owned `assertLive` callback; callers without one retain the full check.
No browser input or environment variable can replace either callback.

Full executable, runtime and policy verification still runs before opening a
process, starting a thread or turn, invoking a governed host tool, returning its
result, and accepting the final component response. Direct sessions also run
full backend and tool checks before emitting or settling a terminal turn;
Structured Ask checks its scoped tools again before extracting final text. Context/credential checks
remain in the host preparation, normalization and persistence paths. A changed
binary cannot authorize the next protected operation. Stream revocation stays
immediate; this is not a time-based or filesystem-metadata digest cache.
