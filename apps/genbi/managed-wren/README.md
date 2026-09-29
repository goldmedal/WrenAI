# Managed Wren release binding

This package pins the darwin-arm64 runtime published in
[managed-wren-v0.0.5](https://github.com/goldmedal/WrenAI/releases/tag/managed-wren-v0.0.5):
CPython 3.11.16 and fork Wren 0.13.0+genbi.1 with its complete 41-wheel closure.

`manifest.json` remains staged and contains an `approvedManifest` reference.
Provisioning must retrieve the exact approved release manifest with SHA-256
`d1ad640f3569d9cec3102110c18627180e22793ad644418ed9a93b475f06e33a`
and verify its release identity before installing any runtime asset. The release
contains the license inventories and `THIRD_PARTY_NOTICES.txt` reviewed for these
selected archives and wheels, including the fork source provenance.

Readiness never downloads or installs the runtime. Explicit provisioning uses a
private runtime directory, verifies every artifact, installs wheels offline, and
checks the resulting interpreter, entrypoints and complete package tree before
promotion. Later resolution rejects tampering instead of repairing it silently.

This binding does not certify or activate the Codex session backend. Runtime
installation and vendor-session readiness remain separate checks.

## Fork source-wheel releases

The runtime input selects Wren `0.13.0+genbi.1`, built from the public fork
commit pinned in `source-inputs.json`. This is a distinct fork distribution; it
does not replace the PyPI `wrenai` package. It supplies the governed query
transport required by native component execution.

Run the source builder with Python 3.11 and a new output directory:

```sh
python3.11 apps/genbi/scripts/managed-wren-source.py \
  apps/genbi/managed-wren/source-inputs.json source-wheel-output
```

The helper verifies the source archive and every build-tool wheel by SHA-256,
builds with an isolated environment and fixed timestamps, and emits the wheel
and `source-provenance.json`. It changes only the package version and includes
the repository distribution license. Before publication, rebuild into another
directory and require identical wheel and receipt hashes. Publish those exact
files as a separate immutable source-wheel release in `goldmedal/WrenAI`, with
the source commit as the tag target. Source-wheel publication requires review
and release authorization; the builder itself never publishes.

`release-inputs.json` binds that wheel and its source receipt by hash. The
runtime staging job verifies the receipt against `source-inputs.json`, then
uses the exact existing dependency closure in `dependency-wheels.json`.
Dependency wheels still require matching PyPI source metadata. It verifies
the installed closure and the governed CLI entrypoint before producing a
candidate. A source-wheel release alone cannot activate a runtime.

The unchanged CPython redistribution review and notices are reused only by
their pinned hashes and exact Python archive identity. Notices from the selected
Wren wheel are appended. Approval covers the concatenated bytes of the candidate
manifest, Python license inventory, wheel license inventory, and
`THIRD_PARTY_NOTICES.txt`, in that order. The protected publication job requires
that digest, re-fetches the exact selected assets, and creates a new runtime
release. It never overwrites an existing tag or asset. GenBI's installed binding
pins the approved manifest above; changing the runtime requires a separately
verified new manifest anchor.
