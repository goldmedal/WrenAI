# pi 1.0.4 certification (local runtime, macOS arm64, Node 24)

This record certifies one identity of the GenBI-managed pi install, as the packaged row in
`server/runtime-host/local-pi-certification.ts` (`LOCAL_PI_CERTIFIED_ROWS`), for pi on the local runtime
(`GENBI_RUNTIME=local`, `GENBI_BACKEND` listing `pi`). It does not publish a package, change default runtime selection,
certify any other host or Node major version, or certify pi on OpenShell (that is
`certification/pi-1.0.4-darwin-arm64/`, a different record with a different row).

- Host: macOS arm64. Node: **major 24**; the row pins the major version only, so a Node 24 patch update needs no new row.
  pi's own minimum, Node 22.19.0, is enforced separately (`pi_node_unsupported`). Another major is `pi_uncertified`.
- The evidence was produced under the official Node.js v24.22.0 darwin-arm64 release archive
  (`https://nodejs.org/dist/latest-v24.x/node-v24.22.0-darwin-arm64.tar.gz`, sha256
  `6a9724d9b50a5f22b4816cded441b5a8d9ddae546191a5e5b7efa5a5e2ee26d5`, verified against that release's `SHASUMS256.txt`),
  extracted into a scratch directory with nothing installed system-wide.
- pi 1.0.4 from the GenBI-owned lockfile, installed by `genbi-local-pi install` (`npm ci --ignore-scripts`). The identity
  is the host `pins.json`: pi version, `dist/bundle` tree digest, the packaged MCP relay, the lockfile and `package.json`.
  Tests bind every one of them to the files in `runtime-assets/pi-worker`.
- Component dependencies: Warble 0.19.0, IR 0.9.0 and context-loader 0.1.4. Another install denies the row
  (`pi_dependencies_drifted`) until it is re-certified.
- Rows are read only from the package. No environment variable or file can supply one.

## Evidence (hashed verbatim by the approval record, which the row hashes)

- `deterministic.json`: output of `scripts/pi-local-probe.mjs` against the packed install under Node 24. No model call:
  the vendor is a scripted stub on loopback holding a generated dummy key. It covers the packaged row matching the
  installed identity, the Node-major and minimum-Node rules, a package-only row source, a real pi step through the
  key proxy with a host-answered tool call, a cancelled step, the stub seeing only proxied requests with the dummy
  key, and nothing pi could read holding the key, with processes, directory and grant proven clean.
- `live-run.json`: a live no-model run of the real BFF (`GENBI_BACKEND=pi`) and real pi from the packed install under
  Node 24: readiness before install, install, certified readiness, one stub Ask that persists one verified answer, a
  tampered install (`pi_identity_mismatch`, Ask refused), the restored install, a boot under another Node major
  (`pi_uncertified`) and a boot that does not list pi.
- `candidate-acceptance.json`: the packed-install acceptance of the candidate package, under Node 24.
- `local-approval.json`: the exact-identity approval. It claims no real-model acceptance.
- `installed-acceptance.json` (not hashed, to avoid a self-referential hash): the same acceptance on the final package,
  which differs from the candidate only in the row's approval digest.

## Reproduce

1. Build GenBI, `pnpm pack`, and `npm install` the tarball into a scratch project under an official Node 24.
2. `npx --no-install genbi-local-pi install --state-dir <dir>`, then
   `node scripts/pi-local-probe.mjs --root <installed package root> --state-dir <dir>` (needs a free port, default 4791).
3. `pnpm run check:installed-package` under Node 24 with model connection variables absent.

Re-certify on any change listed in `MAINTAINING.md` ("Upgrading or re-certifying pi on the local runtime").
