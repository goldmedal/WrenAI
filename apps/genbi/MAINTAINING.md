# Maintaining GenBI's Warble dependency

This covers `@wrenai/genbi`'s own versioning policy and the procedure for
bumping its pinned Warble version. For building and testing day to day, see
[README.md](./README.md). For the live dev loop these commands feed into, see
[RUNNING.md](./RUNNING.md).

Most commands below run from `apps/genbi`, same as the rest of the app. Two
sections say otherwise inline and those declarations govern: `pnpm install` in
step 2 of the bump procedure runs at the workspace root, and the regeneration
commands run from the repository root.

## Versioning

`@wrenai/genbi`'s own version (currently `0.0.8`, pre-release) is **independent
of Warble's** — it does not track or mirror Warble's version number. Bump
`@wrenai/genbi`'s version only for genbi's own release events (this doc does
not define genbi's release cadence; that is a separate, not-yet-settled
decision). Recommendation: keep it independent, because Warble releases on its
own weekly cadence driven by its own scope, and coupling the two version
numbers would either force genbi releases it doesn't need or stall Warble pins
waiting on an unrelated genbi release. What genbi commits to instead is
compatibility: the exact `@warble/*` versions this package requires and has
been verified against, expressed as pinned dependency versions plus the contract
check, not as a shared version number.

### Bumping the pinned Warble version

`@warble/cli`, `@warble/claude-agent-sdk`, and `@warble/codex-local` are pinned
to an **exact** version (no `^`/`~`) in `apps/genbi/package.json`, and Warble
publishes roughly weekly. When a new Warble version ships, follow this
procedure (worked examples: commit `73418ad4`, then `da44c60a` for the next
bump after it):

1. Bump the pin for all three `@warble/*` packages to the new exact version in
   `apps/genbi/package.json` in the same change — they come from the same
   Warble release and must move together.
2. Run `pnpm install` at the workspace root to update the lockfile.
3. Check `pnpm-workspace.yaml`'s `minimumReleaseAgeExclude` list. `pnpm
   install` **appends** a new entry for the newly-resolved version rather than
   replacing the old one; repo convention (see both example commits) is to
   **replace** the superseded `@warble/*` entries with the new version, not
   accumulate them. Skipping this step leaves stale version entries behind —
   they do nothing useful, and each one is a permanent hole in
   `minimumReleaseAgeExclude`'s protection (the whole point of that setting is
   to delay trusting a freshly-published version; a stale entry for a version
   already in use provides no protection and just accumulates as dead weight
   that quietly widens the exclusion list over time). Edit the file by hand
   after `pnpm install` to enforce the replacement.
4. Re-run `pnpm run check:warble-peers` to confirm the new versions still satisfy the peer range the
   three packages declare on `@warble/ir-spec` (`0.9.x` as of Warble 0.19.0). This catches a version
   mismatch that plain `pnpm install` accepts silently; it does not check
   `file:`/`link:`-satisfied peers, so it is only meaningful against the
   registry-pinned dependency graph described here.
5. Run the contract probe (`pnpm run check:contracts`, see
   [Verify the tuple](./RUNNING.md#verify-the-tuple)) against the newly-pinned
   `@warble/cli` and `@warble/claude-agent-sdk` binaries. This is the step that
   catches a new Warble whose dispatch contracts or IR compatibility window no
   longer match this package's committed profiles — a mismatch the version bump
   itself will not surface.
6. Run `pnpm typecheck`, `pnpm test`, and `pnpm build` to confirm nothing in
   genbi's own code assumed the old Warble contract.
7. Commit the `package.json` pin bump, the lockfile, and the corrected
   `pnpm-workspace.yaml` together as one change, following the pattern of the
   two example commits above.
8. Know what the bump does to certified rows: the pi (and Codex) rows record the Warble, IR and context-loader versions their evidence was produced with, and
   a bump makes readiness deny them (`pi_dependencies_drifted`, `codex_dependencies_drifted`) until they are re-certified. See
   [Upgrading or re-certifying pi](#upgrading-or-re-certifying-pi).

If a step is skipped: skipping step 1 (bumping the packages together) risks a
`@warble/*` trio that didn't ship together and was never tested as a set.
Skipping step 3's replacement (leaving the append in place) silently weakens
`minimumReleaseAgeExclude` release over release, with no error message to
notice it by. Skipping step 4 can let a peer-range mismatch land undetected,
since ordinary `pnpm install` exits `0` even when peers conflict. Skipping
step 5 leaves the pinned Warble unproven against this package's committed
profiles, so the mismatch surfaces later, as a
misleading "verified" tuple. Skipping steps 6–7 is the ordinary risk of
skipping tests before a commit.

### Upgrading or re-certifying pi

pi readiness is an exact certified row (`server/runtime-host/openshell-vendor-certification.ts`, evidence in `certification/pi-<version>-<host>/`), so **any** of these changes needs a new row, never an edit of the old one's digests:
a new pi version, a new `package-lock.json`, a new Node base image, a change to any `runtime-assets/pi-worker` file (worker, core, supervisor, shim, step control, proc check, CA trust, pins) or to the policy or profile template, a new
OpenShell build, a new host platform, and a bump of the pinned `@warble/*`, `@warble/ir-spec` or `@wrenai/context-loader` versions (the last one denies pi with `pi_dependencies_drifted` until the row is renewed).

1. pi releases often. Pin the exact version in `runtime-assets/pi-worker/package.json`, regenerate `package-lock.json` (`npm install --package-lock-only --ignore-scripts`), and update the version check in the Dockerfile.
2. **Re-run the tools matrix of the first pi probe.** pi's `--tools` behaviour has changed in practice between versions: with no tool, a named tool and the `--no-tools` form, the step must expose exactly the host's tools and nothing else
   (the deterministic checks live in `test/pi-worker.test.ts` and `test/openshell-pi-provider.test.ts`; confirm them against the real pi in the image, not only the simulator).
3. Build the image with `genbi-openshell-pi provision` on a private test gateway and read the new `pins.json` (`docker create` the image and `docker cp` `/opt/genbi/pins.json -`).
4. Run the deterministic probe against that boot (it uses an in-sandbox stub, no model): `node scripts/pi-backend-probe.mjs --dir <out dir> --prefix <your owned prefix> --out <file>` and keep its JSON as `deterministic.json`.
5. Run `pnpm run check:installed-package` and keep the report as the packed-install acceptance, record the local approval, and add the new row (pins, templates, gateway build, host, component versions and the three evidence digests of the committed files) next to the previous one.
   The static tests bind the row to the repository: file digests, lockfile, Dockerfile base, templates and the evidence bytes.
6. A real-model smoke is an acceptance record cited by the approval, not a certification input.

## Regenerating a profile's prepared-context document and IR golden

Each profile under `profiles/` ships two generated artifacts alongside its hand-written
`profile.yml` and `context/binding.yml`:

| Artifact | What it is |
| --- | --- |
| `context/context.json` | The **prepared-context document** — the JSON projection of a wren project that a `kind: prepared` binding reads. Warble does not introspect MDL itself; WrenAI's `wren-context-loader` generator produces this, and Warble consumes it. |
| `ir.golden.json` | The compiled IR for the profile exactly as authored. Not only a test fixture: `RUNNING.md` passes these to the BFF as `WREN_HARNESS_SETUP_IR` / `WREN_HARNESS_ENRICH_IR` / `WREN_HARNESS_ANALYSIS_IR`, and several test suites read them. |

Both are committed so a profile compiles standalone for CI and dev, pinned to this repo's own
`examples/v5-jaffle`. At run time the host regenerates the document against the user's real project
and rewrites `project:` (see `composeUserProfile`); nothing at run time reads the committed copies.

The generator's content hash is memoized per resolved path for the lifetime of the process, so a
**running** BFF does not notice a generator rebuilt at the same path: the cache key does not move
and a bundle compiled from the previous projection keeps being served. Restart the BFF after
rebuilding the generator. This inherits from `warbleIdentity`, but bites harder here — Warble
arrives pinned from npm, whereas this generator is an in-repo Rust build that is expected to be
rebuilt during development.

Regenerate them, from the repository root, in this order — the golden is compiled *from* the
document, so a stale document silently produces a stale golden:

```sh
# 1. Build the generator (once; it is a Rust binary, not an npm dependency).
cargo build --release --manifest-path core/wren-context-loader/Cargo.toml

# 2. Regenerate the document for each profile that binds `kind: prepared`.
#    (genbi-setup is excluded: it binds `kind: raw_source` and has no document.)
for p in genbi-default genbi-report genbi-monitor genbi-enrich-context; do
  ./core/wren-context-loader/target/release/wren-context-loader \
    examples/v5-jaffle -o "apps/genbi/profiles/$p/context/context.json"
done

# 3. Recompile each golden with the *pinned* `@warble/cli`, so the committed IR matches the
#    compiler this package actually depends on rather than whatever `warble` is on PATH.
cd apps/genbi
for p in genbi-default genbi-report genbi-monitor genbi-enrich-context genbi-setup; do
  pnpm exec warble compile "profiles/$p" -o "profiles/$p/ir.golden.json"
done
```

Pass **no** `--hub-dir`: the pinned `@warble/cli` binary carries its own Hub component library baked
in at build time, and that compiled-in default is what makes a golden reproducible for anyone with
the same pin. Pointing it at a local Warble checkout's `hub/components` instead compiles against a
component library nobody else has, which is how a golden silently stops being reproducible.

Verify a regeneration rather than trusting it: recompiling an unchanged profile must be a no-op
(`git diff --stat -- 'apps/genbi/profiles/*/ir.golden.json'` empty). A golden that changes when you
did not intend it to means something else moved — the pin, the Hub, or the generator — and the diff
should be understood before it is committed.

The same binary also emits the **capability catalog** (`--catalog-out <file>`), the authored,
descriptive, SQL-free slice of a project that the harness renders into the capability card for
public-zone steps (`RUNNING.md`, "Zone-aware tier binding"). It is generated at run time next to the
prepared document and is not committed; `test/fixtures/card-project` is the fixture its tests use.

The catalog also carries the project's business rules (`knowledge_rules`: each `knowledge/rules/*.md`,
sorted by path, then a legacy root `instructions.md`, as `{path, content}`; omitted when there are none).
They live in the catalog and not in the prepared document because the prepared-context format is owned
by Warble and rejects unknown fields. The harness reads the catalog on every in-process run, appends the
rules to the private-zone snapshot text, renders them in full on the capability card, and includes them
in the context the identity digest covers. `knowledge/sql/` (confirmed queries) is never carried.
Rule files may open with a `---` fenced YAML `defaults:` block declaring rules the `wren` CLI enforces;
the catalog's `declared_defaults` lists those rule ids (declaration order: files sorted by path, then the
legacy file, then in-file order; omitted when there are none; `catalog_version` stays 1). The loader reads
ids only, and the block stays verbatim in `knowledge_rules` content. Validating the declarations is the
CLI's job, so anything malformed in any rule file (bad or repeated id, unknown kind, invalid YAML, an
unclosed fence) empties the whole list and warns on stderr, as the CLI voids the whole set, rather than
failing the loader. The loader and the CLI agree on every realistic file; the rare divergences (duplicate
YAML keys, a lone `\r` or Unicode line separator) make the loader emit fewer or no ids, so the host
refuses the governed tool: it fails closed, never a silent skip.
`check-context` (`verifyComponentContext`) verifies only the prepared document, so the integrity of the
rules rests on `planDigest(contexts)` plus the project fingerprint re-check (`checkProject()` before every
step), not on `check-context`.

### Declared default rules (governed protocol 3)

A project may declare default rules in the front-matter of a `knowledge/rules/*.md` file; the Wren CLI
(`wren governed-stdio`) then refuses, before execution, a query that skips one. The catalog lists the
declared rule ids as `declared_defaults` (declaration order; omitted when there are none, and a catalog without
the field means "declares nothing"). The host side lives in `harness/components/wren-access.ts`:

- **Protocol.** `wren-governed/3` exists only for a declaring project, and its hello carries a third key,
  `declared_defaults`. The host accepts the third key only together with protocol 3 and requires protocol 3 to
  carry it. The announced ids must equal the catalog's set (order-insensitive, no repeats, at most 8, each
  `^[a-z0-9][a-z0-9_-]{0,63}$`); any other hello is unavailable, with the fixed reason
  `governed_declarations_mismatch` in the `governed_hello` server log line (ids are never logged or shown).
  So a Wren CLI that predates declarations (a two-key hello) cannot silently run a declaring project, and a
  project without declarations still gets exactly the two-key protocol 2 hello.
- **Every governed route passes the catalog's set.** The in-process route reads the catalog it already generates;
  the Ask host-proxy turns (dispatched and codex-ask) and the native session `query` tool read it through
  `declaredDefaultsOptionOfProject` (`harness/components/declared-defaults.ts`, one generator run per access
  open); the native component runtime takes it from the catalog its context capture generates, and hands it to
  its `openDataAccess` override. A catalog that cannot be produced reads as "declares nothing", so a governed
  process that announces rules is refused, never trusted. The option is passed only when the set is non-empty
  (`declaredDefaultsOption`), so a project that declares nothing makes the same governed call as before.
- **OpenShell data worker.** The worker image's identity line and the descriptor's `dataWorker.protocol` keep
  naming `wren-governed/2`: that is the pinned `wren` module's own `PROTOCOL` constant, not the hello. The hello
  that follows is what changes with the project, and `openOpenShellWrenAccess` takes the same `declaredDefaults`
  set: the two-key protocol 2 hello for a project that declares nothing, protocol 3 announcing exactly the set
  for one that declares rules, anything else unavailable with the same fixed reason. No descriptor field,
  literal or digest changes. Two things make a declaring project work on the sandbox: the pinned worker
  wheel must be one built from `core/wren` at or after the declared-rules support (re-pin its digest as for any
  wheel change, per `runtime-assets/wren-worker/README.md`), and `snapshotCapture.approvedFiles` must list the
  project's `knowledge/rules/*.md` files, because the worker reads the declarations from the snapshot. A worker that
  does not announce them (an older wheel, or rule files missing from the snapshot) announces protocol 2 for a
  declaring catalog and is refused.
- **Error class.** `declared_default_missing` is one more member of `GOVERNED_ERROR_CLASSES`, with one fixed
  sentence that every model-facing surface owns (the governed error, the host proxy, native session
  artifacts) and a structured-data refusal. Its frame may carry `rule_ids`, and no other class may: `rule_ids`
  on any other class, a malformed id or more than 8 ids is a contract violation that closes the channel.
- **Id filter.** Only ids the catalog declares survive, in the order sent and without repeats; the rest are
  dropped. The model sees the fixed sentence followed by ` Rule: <id>[, <id>]` (the sentence alone when no id
  survives). Nothing else from the frame, the SQL or the declaration reaches a model.

### Distributing the context-loader generator

`@wrenai/genbi` pins `@wrenai/context-loader` to one exact version. The package postinstall
downloads only the immutable manifest row for the current target, verifies both archive and binary
SHA-256 values, writes the canonical package-local executable atomically, and records the verified
package/version/target/digest tuple. Runtime re-verifies that record before execution; it never
downloads a binary on first bind or uses PATH.

The first certified row is `darwin-arm64`. Treat every other target as unsupported until it has a
reviewed artifact row and release evidence. The context-loader version is independent of both the
GenBI application and managed Wren runtime: release it only from an explicit `context-loader-v*`
tag using `.github/workflows/publish-context-loader.yml`, then separately bump GenBI's exact pin.

Development order remains explicit `WREN_HARNESS_CONTEXT_LOADER_BIN`, then an in-repo Rust build,
then the verified package. Neither a missing/altered package record nor a failed development
override may fall through to a legacy binding. The compile cache identity includes that resolver
kind and the package tuple or development binary digest, so changing the shipped generator moves
the key.

### Why `@warble/ir-spec` stays behind

`@warble/ir-spec` is pinned at `0.9.0` and does not move in lockstep with the
other three `@warble/*` packages' own version numbers. The other three packages
declare `@warble/ir-spec` as a peer dependency with a `0.9.x` range (Warble
0.19.0), not an exact version — which is what makes this safe: as long as
ir-spec stays inside `0.9.x`, the pinned trio can advance release by release
without an ir-spec bump. `@warble/ir-spec` versions follow the IR *shape*, not
Warble's release cadence (the package version *is* the IR version), so it only
needs to change when the IR line changes.

Bump `@warble/ir-spec` only when Warble ships a new IR line (a `0.9` → `0.10`
class change, not a patch inside `0.9.x`). An IR line is a versioned shape
change, not a widening: in the `0.8` → `0.9` move (a profile with no context now
emits `context_binding: null` at the root and on every component) a `0.9` reader
accepts only `0.9` and a `0.8` reader rejects `0.9`. So when the IR line moves,
move every IR-version literal in this package with it in the same change —
`HARNESS_SUPPORT.irVersion` in `harness/bundle/version.ts`, the
`warble_ir_version` schema literals in `harness/components/` and `server/`, the
compat windows in `harness/` and `scripts/`, and the test helpers that default
to the current line (`git grep` for the old literal) — recompile every
`ir.golden.json` with the newly-pinned CLI (see above; the expected golden diff
is the `warble_ir_version` literal and nothing else unless the IR change itself
says otherwise), and re-run step 4, since the trio's peer range must name the
new line.
