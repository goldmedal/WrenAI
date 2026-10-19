# Governed data worker build contract

This fixed entrypoint accepts no arguments. The host admits one immutable snapshot and opens
only bounded `wren-governed/2` query/inspect frames. No account, profile, environment or connector
credential is supplied through tool input. The host owns statement deadlines and deletes the
whole owned sandbox on cancellation, transport failure or malformed output.

The current locked candidate is native Linux arm64, Python 3.11, Wren source wheel 0.13.0,
wren-core-py 0.7.1, DuckDB 1.5.0 and sqlglot 29.0.1. Linux arm64 has no published wheel in this source lock: build the same 0.7.1 package from the hash-verified source distribution. Emulated amd64 under the arm64 supervisor is unavailable: an identical-policy lifecycle control fails before query execution. A successful package import does not certify governed execution.

Build the Wren SDK wheel from `core/wren` with `uv build --wheel`.
First build the native core wheel using core-builder.Dockerfile and core-build-inputs.json: fetch the exact source archive and maturin wheel, verify their hashes, and build with Docker `--platform linux/arm64`. The builder uses the source archive Cargo.lock unchanged and two Cargo jobs. Export the resulting wheel plus Cargo.lock-before/after hashes, Rust/compiler/Python versions, builder image ID and complete build log. No compiler enters the final worker. Add only the derived wheel hash to the existing core-py 0.7.1 requirement; preserve every other exported dependency/version/hash. Place the derived wheel in build-context `wheels/`. This is a platform build of the pinned source, not a core version upgrade. Export dependencies with
`uv export --locked --no-dev --no-emit-project --format requirements-txt`; preserve hashes and
record the lock/export/source-wheel digests. Copy that wheel, requirements.txt, worker.py,
metadata.py and the application's `openshell-snapshot-helper.py` into an isolated build context.
Supply metadata-input.json with the SDK wheel basename, wheelDigest, native-core source/build/wheel receipt, lockDigest,
requirementsDigest, source revision and exact Python base manifest. The Dockerfile installs
only hash-verified binary dependencies, installs the source wheel without resolving more
packages, runs pip check and emits the actual installed closure in toolchain.json. Record its
SHA-256 and the resulting immutable image ID in the protected host dataWorker descriptor.
The runtime requires uid/gid 1500 and its home directory; these are part of the image contract.

Supported data layout is a quiescent, approved `data/*.duckdb` snapshot with ordinary table
models using explicit attached database aliases. The generated manifest must match the
approved target manifest. Calculated expressions, custom source functions, views, cubes,
external/cloud/database connectors and credentials are unavailable. Unsupported input fails
closed. The worker never follows the source project's profile pin. The agent receives only
broker-approved query results and has no snapshot, data, Wren executable or DB route.

Use an empty network policy, mandatory Landlock and only the fixed read/write scratch paths;
no Docker or host manager socket may be mounted. The data-worker prelude is untrusted: compare
it with independently protected script/source-wheel/toolchain/protocol/architecture values,
the admitted snapshot digest and the host-observed data image/policy before writing a query.
Cleanup uncertainty blocks a successful answer.

The fixed worker sets a 512 MB memory discovery hint and one CPU discovery hint using DuckDB's documented source-supported SLURM resource overrides. These values are owned by the entrypoint and ignore caller/project/environment input; they are not OS hard limits. They leave memory headroom within the sandbox's 1 GiB limit and avoid reading inaccessible cgroup resource metadata; the filesystem and network policy remains unchanged.

## Enrichment validator (separate entrypoint, same image and policy)

`validator.py` is a second fixed entrypoint (`/usr/local/bin/python -I /opt/genbi/validator.py`, no arguments) used only by the host's
enrichment validation. It runs in a fresh sandbox with the same digest-pinned image, the same empty-network data policy (unchanged) and the
published project snapshot mounted read-only, with no model credential, Claude login or environment. Protocol `genbi-validate/1`: it prints one
identity line, reads one bounded JSON candidate line, applies exactly that candidate to a scratch copy, re-checks the sink allowlist and
additivity, runs the library equivalents of `context validate`, `context build`, `dry-plan` and (for cubes) cube SQL generation plus `dry-run`
against the snapshot DuckDB, and prints one bounded JSON result with the change set it applied and the regenerated MDL with its sha256. The
host never trusts it: it requires the change set to be byte-equal to its own candidate.

**Rebuild requirement.** An image built before this entrypoint existed has no `/opt/genbi/validator.py`. Copy `validator.py` into the build
context next to `worker.py` (the Dockerfile now does), rebuild, and record `dataWorker.validator = { script: <sha256 of validator.py>,
protocol: "genbi-validate/1" }` in the protected host descriptor next to the image/script/wheel/toolchain digests. The host accepts the
validator only when that digest equals the digest of the `validator.py` packaged with the application; otherwise enrichment validation is
unavailable (drafting is refused before any model call, a run that loses validation ends `validation_failed`). Governed data access and
analysis keep working with an image that has no validator. This slice does not rebuild or re-pin the production image.
