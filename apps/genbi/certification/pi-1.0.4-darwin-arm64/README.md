# pi 1.0.4 certification (OpenShell, macOS arm64)

This record certifies one pi step-worker image, as a certified row in
`server/runtime-host/openshell-vendor-certification.ts`, for the pi backend on
OpenShell (`GENBI_RUNTIME=openshell`, `GENBI_BACKEND=pi`). It does not publish a
package, change default runtime selection, or certify Claude on OpenShell.

- Host: macOS arm64, Docker driver; image architecture `linux/arm64`.
- OpenShell build: 0.0.117-dev.167+g7e7a8d561 (executable digest in the row).
- pi 1.0.4 from the GenBI-owned lockfile, Node 24.20.0 (base image pinned by digest).
  The identity is the image's `pins.json`: pi version and `dist/bundle` tree digest,
  Node binary, lockfile, and the worker, supervisor, shim, step-control, proc-check,
  CA-trust and pins-module files. Tests bind every one of them to the files in
  `runtime-assets/pi-worker`.
- Component dependencies: Warble 0.19.0, IR 0.9.0 and context-loader 0.1.4. Another
  install denies the row (`pi_dependencies_drifted`) until it is re-certified.
- Policy and profile: the shipped templates, rendered with the descriptor's endpoint.

## Evidence (hashed verbatim by the row)

- `deterministic.json`: output of `scripts/pi-backend-probe.mjs` against a boot
  provisioned by `genbi-openshell-pi` on a private split-supervisor gateway. No model
  call: the vendor is a scripted stub on loopback inside the sandbox. It covers the
  certified identity of the configured image, the read-only gateway proof, the
  placeholder-only credential environment, egress denial with a positive control, a
  per-step pi worker round trip, a two-turn session in one owned sandbox, and cleanup.
- `candidate-acceptance.json`: the packed-install acceptance of the candidate package.
- `local-approval.json`: the exact-identity approval. It also cites an earlier
  real-model smoke as an acceptance record; that smoke is not a certification input.
- `installed-acceptance.json` (not hashed, to avoid a self-referential hash): the same
  acceptance on the final package, which differs from the candidate only in the row's
  evidence digests.

## Reproduce

1. Build GenBI, then `node scripts/pi-backend-probe.mjs --offline` (no gateway, runs in
   `run-vendor-contract-probes.mjs`).
2. On a private OpenShell gateway of the certified build, provision a boot with
   `genbi-openshell-pi provision` whose endpoint is a plain-http loopback URL (`http://localhost:<port>/v1`), create the
   provider with a dummy key in your own shell, then
   `node scripts/pi-backend-probe.mjs --dir <out dir> --prefix <your owned prefix>`.
3. `pnpm run check:installed-package` with model connection variables absent.

Re-certify on any change listed in `MAINTAINING.md` ("Upgrading or re-certifying pi").
