# Codex 0.156.1 local certification

This record approves one native executable from the official npm darwin-arm64
archive for local GenBI app-server acceptance. It does not publish a package,
change default runtime selection, or authorize deployment.

- Platform: macOS arm64.
- Codex CLI/app-server: 0.156.1; exact source and binary SHA256 in `local-approval.json`.
- Managed Wren: 0.13.0+genbi.1, approved manifest recorded in `candidate-acceptance.json`.
- Authenticated acceptance: gpt-5.5, independent login, Jaffle sample,
  Structured Ask and Native Analysis `answer_query`; expected 99 orders and
  revenue 1672. Native reconnect/replay, explicit stop and owned cleanup passed.
- The execution gate admits only gpt-5.5 for all three model roles and
  `answer_query`; uncertified settings deny application readiness and other roots
  are rejected before scoped preparation.
- No live acceptance claim for other models, dashboard, Setup, Claude or other
  platforms. gpt-6-luna did not support the required disabled-Code-Mode tool path.
- Project ancestry containing `.codex` remains rejected. Use a project outside
  such ancestry and a separate private login; no credentials are copied.

`deterministic.json`, `candidate-acceptance.json` and `local-approval.json` are
hashed verbatim by the registry. The candidate run used a private admission
harness while retaining exact vendor and managed runtime checks. That harness
is not shipped. Approval is followed by unmodified installed acceptance with
the packaged row. [The final installed report](installed-acceptance.json) records
successful Ask, Native query, reconnect, stop, unchanged data and negative scope
checks, without creating self-referential evidence hashes.

Reproduce offline checks with the exact dependency versions in the evidence:

1. Generate the schema with the recorded vendor arguments; SHA256 the bytes of
   `codex_app_server_protocol.schemas.json`.
2. Build GenBI, then run `scripts/run-vendor-contract-probes.mjs` with an isolated
   `GENBI_VENDOR_TOOL_ROOT` containing the pinned vendor tools. This makes no
   model calls. Run the unit suite with released compiler/context-loader paths.
3. Run `scripts/installed-package-acceptance.mjs` with model connection variables
   absent. It installs a fresh tarball and denies source-checkout fallbacks.
4. For separately authorized live acceptance, install the tarball, configure
   the exact executable/source, independent login, gpt-5.5 and approved managed
   runtime. Explicitly select app-server and disable local fallback. Adopt Jaffle
   through the API, query the recorded aggregate in Ask and Native Analysis,
   reconnect, stop, and compare the database hash. Keep credentials, capability
   tokens and raw vendor logs private.

The integrity optimization does not cache hashes by file metadata or time:
passive component notifications check live authority; protected operations and
terminal results perform full validation. Unknown executable identities and
changed runtime bytes remain denied.
