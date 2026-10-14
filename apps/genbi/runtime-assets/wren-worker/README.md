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
