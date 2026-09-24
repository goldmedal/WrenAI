# Managed Wren release binding

This package pins the darwin-arm64 runtime published in
[managed-wren-v0.0.4](https://github.com/goldmedal/WrenAI/releases/tag/managed-wren-v0.0.4):
CPython 3.11.16 and Wren 0.13.0 with its complete 41-wheel closure.

`manifest.json` remains staged and contains an `approvedManifest` reference.
Provisioning must retrieve the exact approved release manifest with SHA-256
`64fd2e42332c59e938e74123223d901b0d709fad23514b0399f647d36e6da611`
and verify its release identity before installing any runtime asset. The release
contains the license inventories and `THIRD_PARTY_NOTICES.txt` reviewed for these
unchanged archives and wheels.

Readiness never downloads or installs the runtime. Explicit provisioning uses a
private runtime directory, verifies every artifact, installs wheels offline, and
checks the resulting interpreter, entrypoints and complete package tree before
promotion. Later resolution rejects tampering instead of repairing it silently.

This binding does not certify or activate the Codex session backend. Runtime
installation and vendor-session readiness remain separate checks.
