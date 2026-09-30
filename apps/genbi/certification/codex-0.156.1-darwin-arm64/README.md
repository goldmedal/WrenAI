# Codex 0.156.1 local certification

This record approves one native executable from the official npm darwin-arm64
archive for local GenBI app-server acceptance. It does not publish a package,
change default runtime selection, or authorize deployment.

- Platform: macOS arm64.
- Codex CLI/app-server: 0.156.1; exact source and binary SHA256 in `local-approval.json`.
- Managed Wren: 0.13.0+genbi.1, approved manifest recorded in `candidate-acceptance.json`.
- Component dependencies: Warble 0.15.2, IR 0.8.0 and context-loader 0.1.1.
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
hashed verbatim by the registry. The refreshed candidate used the unmodified
installed package with its existing exact vendor and managed runtime checks.
The evidence-only registry refresh does not change execution code; its packaged
startup is checked separately to avoid circular tarball/evidence hashes.
[The installed report](installed-acceptance.json) records
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

## Official remote terminal

The `remote-tui-v1` transport has separate deterministic, installed candidate and
local approval records (`terminal-*.json`). Driver certification alone cannot
admit this renderer. The scope remains macOS arm64, Codex 0.156.1, gpt-5.5 and
`answer_query`; dashboard and other providers remain outside this record.

`node scripts/probe-codex-terminal.mjs /absolute/path/to/codex` runs the official
CLI against an in-memory peer with no login or model calls. Set
`GENBI_TERMINAL_PACKAGE_ROOT` to an installed package to test its compiled files.
The deterministic vendor-contract CI runner also runs this probe. It covers
input, follow-up, in-flight text steering, resize, reconnect, cancellation, protected-path and network
denials, and cleanup. The authenticated candidate evidence additionally covers
cancellation while a governed tool is active, real Jaffle results and follow-up.

`terminal-installed-acceptance.json` records the final unmodified package's
authenticated query, in-flight steering, follow-up, resize, reconnect and stop,
plus exact installed-file/tarball verification. It is intentionally outside the
registry hash chain to avoid circular package/evidence hashes.
